/**
 * Golden transcripts — the whole sequence a rider would have heard.
 *
 * Asserted as a sequence rather than announcement by announcement, because the
 * failures that matter in this feature are sequence failures and none of them is
 * visible one call at a time:
 *
 *   a duplicate ("хоёр буудал үлдлээ" twice, four seconds apart)
 *   a skipped rung (the 1-stop warning lost to a dropout, so the rider sails past)
 *   a stale line (a count arriving after arrival, telling them to stay seated)
 *
 * Every trace is seeded, so a failure reproduces exactly.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { OVERSHOOT_REPEAT_STOPS } from "../transit/announce";
import { DEAD_RECKONING_LIMIT_MS, type Fix } from "./engine";
import { formatTranscript, simulateJourney } from "./simulate";
import type { GeometryStop } from "./geometry";
import { generateTrace } from "../transit/gps-sim";
import type { RouteStops, Stop } from "../transit/types";

const stops: Stop[] = JSON.parse(readFileSync("public/transit/stops.json", "utf8"));
const routeStops: RouteStops = JSON.parse(readFileSync("public/transit/route-stops.json", "utf8"));
const byId = new Map(stops.map((s) => [s.id, s]));

const CHAIN: GeometryStop[] = (() => {
  for (const [routeId, dirs] of Object.entries(routeStops)) {
    for (const dir of Object.keys(dirs)) {
      const c = (routeStops[routeId][dir] ?? [])
        .map((id) => byId.get(id))
        .filter((s): s is Stop => Boolean(s))
        .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));
      if (c.length >= 12) return c;
    }
  }
  throw new Error("no variant with 12+ stops");
})();

const asFixes = (t: { lat: number; lon: number; accuracy: number; timestamp: number }[]): Fix[] =>
  t.map((f) => ({ lat: f.lat, lon: f.lon, accuracyM: f.accuracy, timestamp: f.timestamp }));

const DEST = 9;

// ------------------------------------------------------------- clean trip

test("GOLDEN: a clean ride, from the first word to the overshoot", () => {
  /**
   * The trace drives the whole variant, so it carries on past the destination —
   * which makes this the overshoot golden too.
   *
   * A rider who missed the door gets the §6.2 priority-0 line, and it now
   * carries the guidance clip with it. Announcing once and then falling silent
   * left them with no orientation from the moment they most needed it, so the
   * position repeats for OVERSHOOT_REPEAT_STOPS stops and then stops: someone
   * who has chosen to ride on to the terminus does not need telling every 90 s,
   * and the long-press status query covers re-orientation on request.
   */
  const fixes = asFixes(generateTrace(CHAIN, { seed: 1, noiseM: 12, speedKmh: 25 }));
  const { transcript } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });

  assert.deepEqual(formatTranscript(transcript), [
    `remaining=3 earcon:soft num_3 bus_stops_remaining`,
    `remaining=2 earcon:soft num_2 bus_stops_remaining`,
    `remaining=1 earcon:alert bus_next_stop stop_${CHAIN[DEST].id} bus_get_ready`,
    `remaining=0 earcon:urgent stop_${CHAIN[DEST].id} bus_get_off_now`,
    `remaining=-1 earcon:urgent bus_passed_stop bus_get_off_next_stop`,
    `remaining=-2 earcon:alert num_2 bus_stops_past_suffix`,
    `remaining=-3 earcon:alert num_3 bus_stops_past_suffix`,
  ]);

  /**
   * The overshoot is BOUNDED, however far past the stop the bus goes. The trace
   * drives the whole variant, so without the bound this would speak at every
   * remaining stop — which is the failure the old announce-once rule was
   * avoiding, and this replaces it rather than removing it.
   */
  const overshoots = transcript.filter((l) => l.remaining < 0);
  assert.equal(overshoots.length, OVERSHOOT_REPEAT_STOPS, "the overshoot is not bounded");
  assert.ok(
    transcript.every((l) => l.remaining >= -OVERSHOOT_REPEAT_STOPS),
    "spoke past the repeat window instead of falling silent",
  );
  assert.equal(overshoots[0].priority, "critical", "the first overshoot lost its priority");
  assert.ok(
    overshoots.slice(1).every((l) => l.priority === "normal"),
    "a follow-up position update preempted like an alert",
  );
});

test("silence above three stops — audio is not a progress bar", () => {
  const fixes = asFixes(generateTrace(CHAIN, { seed: 1, noiseM: 12 }));
  const { transcript } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
  assert.ok(
    transcript.every((l) => l.remaining <= 3),
    `spoke at ${transcript.filter((l) => l.remaining > 3).map((l) => l.remaining)} stops out`,
  );
});

test("nothing is said twice", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const fixes = asFixes(generateTrace(CHAIN, { seed, noiseM: 30 }));
    const { transcript } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
    const lines = formatTranscript(transcript);
    assert.equal(new Set(lines).size, lines.length, `seed ${seed} repeated a line:\n${lines.join("\n")}`);
  }
});

test("the ladder descends and never climbs back", () => {
  for (const seed of [11, 12, 13]) {
    const fixes = asFixes(generateTrace(CHAIN, { seed, noiseM: 45 }));
    const { transcript } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
    const counts = transcript.map((l) => l.remaining);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a), `seed ${seed}: ${counts}`);
  }
});

test("REGRESSION: nothing is announced after the destination is reached", () => {
  // A count arriving after arrival tells a blind rider to stay in their seat as
  // the doors open. The queue's expiresAt is the second line of defence; this is
  // the first.
  const fixes = asFixes(generateTrace(CHAIN, { seed: 2, noiseM: 35 }));
  const { transcript } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
  const arrival = transcript.findIndex((l) => l.remaining === 0);
  assert.ok(arrival >= 0, "never announced the arrival");
  for (const line of transcript.slice(arrival + 1)) {
    assert.ok(line.remaining < 0, `spoke "${line.keys.join(" ")}" after arrival`);
  }
});

// ------------------------------------------------------------- flapping

test("GOLDEN: a flapping fix at a stop boundary does not stutter the count", () => {
  // 60 m of noise is well past what a good fix produces; the hysteresis is what
  // has to hold, not the GPS.
  const fixes = asFixes(generateTrace(CHAIN, { seed: 99, noiseM: 60, speedKmh: 12 }));
  const { transcript } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
  const lines = formatTranscript(transcript);

  assert.equal(new Set(lines).size, lines.length, `stuttered:\n${lines.join("\n")}`);
  const counts = transcript.map((l) => l.remaining);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

// -------------------------------------------------------------- dropout

test("GOLDEN: a dropout two stops out still delivers the arrival", () => {
  // The scenario that strands someone: the fix dies exactly when the countdown
  // matters. The rungs after it must still fire once the fix returns.
  const fixes = asFixes(generateTrace(CHAIN, {
    seed: 21, noiseM: 20,
    dropouts: [{ startSec: 150, durationSec: 40 }],
  }));
  const { transcript } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
  const reached = transcript.map((l) => l.remaining);

  assert.ok(reached.includes(0), `never announced arrival; said ${reached}`);
  assert.equal(new Set(reached).size, reached.length);
});

test("a rung skipped while the fix was gone is not re-announced late", () => {
  // The count jumps 3 → 1 across the gap. The 2 rung is GONE, not queued: saying
  // "two stops" once the answer is one is worse than never saying it.
  const fixes = asFixes(generateTrace(CHAIN, {
    seed: 33, noiseM: 20, speedKmh: 40,
    dropouts: [{ startSec: 120, durationSec: 90 }],
  }));
  const { transcript } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
  const counts = transcript.map((l) => l.remaining);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), `a stale rung was spoken: ${counts}`);
});

test("a long dropout announces the loss of tracking, exactly once", () => {
  const fixes = asFixes(generateTrace(CHAIN, {
    seed: 44, noiseM: 20,
    dropouts: [{ startSec: 60, durationSec: DEAD_RECKONING_LIMIT_MS / 1000 + 60 }],
  }));
  const { transcript } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
  const losses = transcript.filter((l) => l.keys.includes("bus_tracking_degraded"));
  assert.equal(losses.length, 1, `announced the loss ${losses.length} times`);
  assert.equal(losses[0].priority, "critical");
});

// ------------------------------------------------- the register contract

test("a dead-reckoned count never tells anyone to step off the bus", () => {
  // "Одоо буугаарай" on extrapolated evidence is the app's most dangerous act:
  // it puts someone next to traffic on the strength of where the bus was three
  // minutes ago. The early rungs still speak; the two urgent ones do not.
  const fixes = asFixes(generateTrace(CHAIN, {
    seed: 55, noiseM: 20,
    dropouts: [{ startSec: 200, durationSec: 120 }],
  }));
  const { transcript } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
  for (const line of transcript) {
    if (line.confidence !== "low") continue;
    assert.ok(
      !line.keys.includes("bus_get_off_now") && !line.keys.includes("bus_passed_stop"),
      `spoke "${line.keys.join(" ")}" on low confidence`,
    );
  }
});

// ------------------------------------------------------ missing clips

test("an unrendered stop name costs the name, never the warning", () => {
  // A render gap must degrade to the generic phrase, not to silence — silence
  // reads to the rider as "we have not arrived yet".
  const fixes = asFixes(generateTrace(CHAIN, { seed: 1, noiseM: 12 }));
  const { transcript } = simulateJourney({
    chain: CHAIN, fixes, destinationIndex: DEST,
    hasClip: (key) => !key.startsWith("stop_"),
  });
  const arrival = transcript.find((l) => l.remaining === 0);
  assert.ok(arrival, "the arrival went silent when its stop name was missing");
  assert.ok(arrival!.keys.includes("bus_get_off_now"));
  assert.ok(arrival!.keys.includes("bus_unnamed_stop"));
});

// ------------------------------------------------------------ determinism

test("the same trace always produces the same transcript", () => {
  const fixes = asFixes(generateTrace(CHAIN, { seed: 8, noiseM: 40 }));
  const a = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
  const b = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
  assert.deepEqual(formatTranscript(a.transcript), formatTranscript(b.transcript));
});

test("every announcement carries a haptic and an earcon", () => {
  // Parallel channels (§5): any one of speech, earcon or haptic must be enough
  // to act on. UB buses are loud enough that audio alone fails regularly.
  const fixes = asFixes(generateTrace(CHAIN, { seed: 1, noiseM: 12 }));
  const { transcript } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: DEST });
  for (const line of transcript) {
    assert.ok(line.earcon, `"${line.keys.join(" ")}" has no earcon`);
    assert.ok(line.haptic?.length, `"${line.keys.join(" ")}" has no haptic`);
  }
});

// -------------------------------------------------------------- terminus

test("REGRESSION: riding to the END OF THE LINE announces the arrival", () => {
  /**
   * The 40 m advance gate asks for proof we passed the stop. At the last stop of
   * a variant that proof can never arrive — there is nowhere further to go — so
   * the count stopped one short and went quiet, which reads as "not yet" to
   * someone who cannot see it. Riding to the terminus is most of a commute.
   */
  const dest = CHAIN.length - 1;
  const fixes = asFixes(generateTrace(CHAIN, { seed: 3, noiseM: 15, speedKmh: 25 }));
  const { transcript, finalState } = simulateJourney({ chain: CHAIN, fixes, destinationIndex: dest });

  assert.equal(finalState.stopIndex, dest, `stopped at ${finalState.stopIndex} of ${dest}`);
  const arrival = transcript.find((l) => l.remaining === 0);
  assert.ok(arrival, `never announced arrival at the terminus:\n${formatTranscript(transcript).join("\n")}`);
  assert.ok(arrival!.keys.includes("bus_get_off_now"));
});

test("a single drifted fix cannot end the journey early at the terminus", () => {
  // The relaxed gate must not also relax the two-fix confirmation, or one bad
  // fix near the end of the line gets someone off a stop early.
  const dest = CHAIN.length - 1;
  const fixes = asFixes(generateTrace(CHAIN, { seed: 3, noiseM: 15 }));
  const cut = fixes.filter((f) => f.timestamp < fixes[Math.floor(fixes.length * 0.5)].timestamp);
  const { finalState } = simulateJourney({ chain: CHAIN, fixes: cut, destinationIndex: dest });
  assert.ok(finalState.stopIndex < dest, "reached the terminus on half a trace");
});
