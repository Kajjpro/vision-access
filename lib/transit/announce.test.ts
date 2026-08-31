/**
 * The hedge, asserted against real output rather than by reading the code.
 *
 * We ship schedule-only, so there is NO input for which an unhedged time is
 * correct. These tests exist so that re-introducing a confident branch fails
 * here rather than in someone's ear at a bus stop.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { announceArrival, isUnhedgedTime } from "./announce";
import type { Arrival } from "./types";

const has = () => true;

/** A fixed clock, because the countdown is now derived rather than stored. */
const NOW = Date.parse("2026-08-14T09:00:00Z");

/**
 * `minutes` here sets the ARRIVAL INSTANT, which is the only field the
 * announcement reads. The legacy `minutes` field is carried alongside it and
 * deliberately given a contradictory value in one test below, to prove nothing
 * still reaches for it.
 */
const arrival = (minutes = 5, over: Partial<Arrival> = {}): Arrival => ({
  routeId: "11100350", routeDisplayName: "Ч:35",
  arrivesAt: NOW + minutes * 60_000,
  minutes,
  headsign: null, isEstimate: true, source: "schedule", ...over,
});

test("every source keeps the hedge — including a forged 'realtime'", () => {
  for (const source of ["schedule", "headway", "realtime"] as const) {
    const a = announceArrival(arrival(5, { source }), has, NOW);
    assert.ok(a, `no announcement for ${source}`);
    assert.ok(a!.keys.includes("bus_approx_prefix"), `${source} produced an UNHEDGED time`);
    assert.equal(isUnhedgedTime(a!), false, `${source} produced an UNHEDGED time`);
  }
});

test("no minute value can produce an unhedged time", () => {
  for (let m = 1; m <= 40; m++) {
    const a = announceArrival(arrival(m), has, NOW);
    assert.equal(isUnhedgedTime(a!), false, `${m} minutes came out unhedged`);
  }
});

test("isEstimate false does not unlock the confident wording either", () => {
  const a = announceArrival(arrival(5, { isEstimate: false, source: "realtime" }), has, NOW);
  assert.equal(isUnhedgedTime(a!), false);
});

test("a time we cannot speak is refused rather than mangled", () => {
  assert.equal(announceArrival(arrival(41), has, NOW), null, "no cardinal clip past 40");
  assert.equal(announceArrival(arrival(5, { arrivesAt: null }), has, NOW), null, "no absolute time");
  assert.equal(announceArrival(arrival(5, { arrivesAt: NaN }), has, NOW), null);
});

/**
 * THE BUG THIS WHOLE CHANGE EXISTS FOR.
 *
 * The countdown used to be a number computed on the server, served through a
 * 45-second cache, and then held in the wait screen's state for as long as a
 * rider took to cycle the options by ear. It never ticked and it never expired,
 * so a bus that had already gone was still announced as arriving in five
 * minutes — to someone with no countdown board to check it against.
 */
test("REGRESSION: the countdown is derived from the clock, not from the stored number", () => {
  const a = arrival(5); // built when it was genuinely 5 minutes away

  const atBuildTime = announceArrival(a, has, NOW);
  assert.ok(atBuildTime!.keys.includes("num_5"));

  // Four minutes later, on the same object, with nothing re-fetched.
  const later = announceArrival(a, has, NOW + 4 * 60_000);
  assert.ok(later!.keys.includes("num_1"), "the stored 5 was replayed instead of the real 1");
});

test("REGRESSION: a bus that has gone is never announced as still coming", () => {
  const a = arrival(5);
  assert.equal(announceArrival(a, has, NOW + 10 * 60_000), null);
});

test("a bus due right now is announced, not refused", () => {
  // Refusing here would go silent at the exact moment the information matters
  // most. Inside the grace window it keeps the hedged one-minute wording — it
  // may never borrow the live "ирлээ", which means a vehicle we watched move.
  const a = announceArrival(arrival(0), has, NOW);
  assert.ok(a);
  assert.ok(a!.keys.includes("bus_approx_prefix"));
  assert.equal(isUnhedgedTime(a!), false);
});

test("the stale `minutes` field is not consulted, even when it disagrees", () => {
  // A response that sat in the proxy cache: `minutes` says 9, the instant says 2.
  const a = announceArrival(arrival(2, { minutes: 9 }), has, NOW);
  assert.ok(a!.keys.includes("num_2"));
  assert.ok(!a!.keys.includes("num_9"));
});

test("the announcement re-fires when the countdown changes", () => {
  // A dedupeKey of just the route id would collapse every later update into the
  // first one, and the rider would hear the opening number and nothing after.
  const a = arrival(5);
  const first = announceArrival(a, has, NOW);
  const second = announceArrival(a, has, NOW + 2 * 60_000);
  assert.notEqual(first!.dedupeKey, second!.dedupeKey);
});

test("the hedge survives a missing route clip", () => {
  const a = announceArrival(arrival(), (k) => k !== "route_11100350", NOW);
  assert.ok(a!.keys.includes("bus_approx_prefix"));
  assert.equal(a!.keys[0], "bus_approx_prefix", "the hedge must lead when the route cannot be named");
});

test("a missing number clip drops the whole time, never leaves a hole", () => {
  // "Ойролцоогоор … минутын дараа" with nothing in the middle is worse than no
  // time at all: it sounds like a number was said and misheard.
  assert.equal(announceArrival(arrival(7), (k) => k !== "num_7", NOW), null);
  assert.equal(announceArrival(arrival(7), (k) => k !== "bus_minutes_suffix", NOW), null);
});

/**
 * Route naming — the gap that hid behind a graceful fallback.
 *
 * `announceRoute()` substitutes `bus_unnamed_stop` when a route has no clip and
 * reports the gap, so for a long time the app worked perfectly while never
 * naming a single bus. Nothing failed; every route was simply "нэргүй буудал".
 * These assertions make that state fail the build instead.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { announceRoute, MAX_SPOKEN_NUMBER, routeKey } from "./announce";
import { COUNTDOWN_CLIP_IDS } from "./eta";
import type { AudioManifest, Route } from "./types";

const dir = join(process.cwd(), "public/transit");
const allRoutes: Route[] = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8"));
const manifest: AudioManifest = JSON.parse(
  readFileSync(join(process.cwd(), "public/audio/transit/manifest.json"), "utf8"),
);
const inManifest = (key: string) => Boolean(manifest[key]);

/**
 * The countdown vocabulary, checked against what was actually rendered.
 *
 * These three key shapes are the ones that went missing in silence: they live in
 * the TRANSIT manifest rather than lib/phrases.ts, the wait screen never loaded
 * them, and `say()` drops undecoded keys without a word. The result was a screen
 * that announced a route name and no time at all, for as long as nobody thought
 * to check. A build that loses one of them should fail here instead.
 */
test("every clip a countdown can ask for exists", () => {
  const missing = COUNTDOWN_CLIP_IDS.filter((id) => !inManifest(id));
  assert.deepEqual(missing, [], `countdown clips absent from the manifest: ${missing.join(", ")}`);
});

test("every stop count a journey can announce has a cardinal clip", () => {
  // "{n} буудал явна" — the count and its suffix are all-or-none at the call
  // site, so a hole here silently removes the whole phrase rather than mangling it.
  const missing = Array.from({ length: MAX_SPOKEN_NUMBER }, (_, i) => `num_${i + 1}`)
    .filter((id) => !inManifest(id));
  assert.deepEqual(missing, []);
});

test("every route has a hand-reviewable spokenName", () => {
  const unnamed = allRoutes.filter((r) => !r.spokenName?.trim()).map((r) => r.displayName);
  assert.deepEqual(unnamed, [], `routes with no spokenName: ${unnamed.join(", ")}`);
});

test("every route has a rendered clip, so none is announced as 'unnamed'", () => {
  const silent = allRoutes.filter((r) => !inManifest(routeKey(r.id))).map((r) => r.displayName);
  assert.deepEqual(silent, [], `routes with no audio: ${silent.join(", ")}`);
});

test("no route falls back to the generic unnamed phrase", () => {
  for (const route of allRoutes) {
    const a = announceRoute(route, inManifest);
    assert.ok(
      !a.keys.includes("bus_unnamed_stop"),
      `${route.displayName} would be announced as "нэргүй буудал"`,
    );
    assert.deepEqual(a.keys, [routeKey(route.id)]);
  }
});

test("spoken names are distinct — two buses must not sound alike", () => {
  const bySpoken = new Map<string, string[]>();
  for (const r of allRoutes) {
    const k = r.spokenName!.trim();
    bySpoken.set(k, [...(bySpoken.get(k) ?? []), r.displayName]);
  }
  const clashes = [...bySpoken.entries()].filter(([, v]) => v.length > 1);
  assert.deepEqual(clashes, [], `routes that sound identical: ${JSON.stringify(clashes)}`);
});

test("spoken names carry nothing an engine rejects", () => {
  // Chimege 400s on digits and Latin; no engine reads the colon in "Ч:35".
  for (const r of allRoutes) {
    assert.ok(
      !/[0-9A-Za-z:/]/.test(r.spokenName!),
      `${r.displayName} spokenName "${r.spokenName}" contains a digit, Latin letter or punctuation`,
    );
  }
});

test("the prefix survives into speech — Ч:9 and Д:9 must differ", () => {
  // Ten route numbers are ambiguous without their prefix. If a future rewrite
  // drops it for brevity, these two collapse into one bus.
  const a = allRoutes.find((r) => r.displayName === "Ч:9")!;
  const b = allRoutes.find((r) => r.displayName === "Д:9")!;
  assert.notEqual(a.spokenName, b.spokenName);
});
