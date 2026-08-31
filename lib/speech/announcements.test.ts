/**
 * Can every phrase the journey flow speaks actually be heard?
 *
 * THIS IS THE TEST THAT WAS MISSING. The spoken-journey feature was reported as
 * "not working" and the recognizer was the suspect; the recognizer was fine.
 * Thirteen of its twenty-one phrases had no playable clip — including
 * `askOrigin`, the very first question, and every fragment of the confirmation
 * read-back. A rider opened the screen, tapped, and heard nothing whatsoever,
 * forever, because a clip id resolves through THREE things that must all agree:
 *
 *   1. `lib/ui/announcements.ts` gives the phrase a clip id (not null)
 *   2. the audio exists — a wav in public/audio, or an entry in the transit
 *      Opus manifest
 *   3. something actually FETCHES it — `loadClips()` resolves an id by
 *      filtering `lib/phrases.ts`, and `createSpeaker` only auto-fetches ids
 *      matching `ON_DEMAND`
 *
 * Nothing enforced the third, so a rendered file nobody had registered played
 * as silence and looked completely fine on disk. And silence, to someone who
 * cannot see the screen, is indistinguishable from a frozen app.
 *
 * `speakClips` skipping a missing clip is right mid-sentence and wrong as a
 * shipping state, so this fails the build instead.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import manifest from "../../public/audio/transit/manifest.json";
import { PHRASES as REGISTRY } from "../phrases";
import { ON_DEMAND } from "../ui/speak";
import { PHRASES, boardingClips, confirmJourneyClips, disambiguationClips } from "./announcements";

const registered = new Set(REGISTRY.map((p) => p.id));
const opus = new Set(Object.keys(manifest as Record<string, unknown>));

/** Mirrors exactly what the running app can get a buffer for. */
function playable(id: string): true | string {
  if (!id) return "phrase has no clip id at all";
  if (ON_DEMAND.test(id)) {
    return opus.has(id) || registered.has(id)
      ? true
      : `fetched on demand but absent from the transit manifest`;
  }
  if (!registered.has(id)) {
    return `not in lib/phrases.ts, so loadClips() will never fetch it`;
  }
  if (!existsSync(`public/audio/${id}.wav`)) {
    return `registered but public/audio/${id}.wav does not exist`;
  }
  return true;
}

test("every phrase the journey flow speaks has a clip that can be heard", () => {
  const broken: string[] = [];
  for (const [name, id] of Object.entries(PHRASES)) {
    const verdict = playable(id);
    if (verdict !== true) broken.push(`PHRASES.${name} (${id || "null"}): ${verdict}`);
  }
  assert.deepEqual(
    broken,
    [],
    `${broken.length} phrase(s) would play as silence:\n  ${broken.join("\n  ")}`,
  );
});

test("the confirmation read-back is audible in full, first word included", () => {
  // Nothing commits without this sentence, so a rider who cannot hear it cannot
  // safely answer it. Its opening "Та" is `bus_you_are_at`, reused from the
  // countdown rather than rendered twice — and it lives in the Opus manifest,
  // not the wav registry, which is why ON_DEMAND has to cover `bus_` too.
  const clips = confirmJourneyClips("000000003", "000000004");
  assert.ok(clips.length > 0);
  for (const id of clips) {
    if (id.startsWith("stop_")) continue; // per-stop, loaded on demand
    assert.equal(playable(id), true, `read-back fragment ${id} is silent`);
  }
});

test("the boarding answer and the disambiguation question are audible", () => {
  const fixed = [
    ...boardingClips("r1", "000000003", 4),
    ...disambiguationClips(["000000003", "000000004"]),
  ].filter((id) => !id.startsWith("stop_") && !id.startsWith("route_"));

  for (const id of fixed) {
    assert.equal(playable(id), true, `${id} is silent`);
  }
});

test("numbers up to the longest route are rendered", () => {
  // boardingClips speaks num_<hops>. The longest route in the feed is 36 stops,
  // and an unrendered number means the rider is told to travel "… stops" with
  // the count missing — worse than not saying it.
  for (let n = 1; n <= 36; n++) {
    assert.ok(opus.has(`num_${n}`), `num_${n} is not rendered`);
  }
});
