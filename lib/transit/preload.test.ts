/**
 * Route-scoped preload.
 *
 * The test that matters is the size one: loading the whole manifest decodes to
 * roughly 400 MB of PCM on a 48 kHz context, which kills the tab on exactly the
 * device this app is for — silently, exactly like the detector crash.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { browseWindowKeys, journeyClipKeys } from "./preload";
import type { RouteStops } from "./types";

const manifest = JSON.parse(readFileSync("public/audio/transit/manifest.json", "utf8")) as Record<string, { durationMs: number }>;
const routeStops = JSON.parse(readFileSync("public/transit/route-stops.json", "utf8")) as RouteStops;
const KEYS = Object.keys(manifest);

/** The longest real route, so the bound is measured against the worst case. */
function longestRoute(): { routeId: string; directionId: number } {
  let best = { routeId: "", directionId: 0, n: 0 };
  for (const [routeId, dirs] of Object.entries(routeStops)) {
    for (const [d, seq] of Object.entries(dirs)) {
      if (seq.length > best.n) best = { routeId, directionId: Number(d), n: seq.length };
    }
  }
  return best;
}

test("a journey loads a fraction of the manifest, not all of it", () => {
  const scope = longestRoute();
  const keys = journeyClipKeys(scope, routeStops, KEYS);
  assert.ok(keys.length > 0);
  assert.ok(
    keys.length < KEYS.length / 4,
    `${keys.length} of ${KEYS.length} keys — route scoping is not doing its job`,
  );
});

test("the decoded audio stays inside a phone's budget", () => {
  // THE REASON THIS MODULE EXISTS. Measured against the real manifest at the
  // 48 kHz an AudioContext actually resamples to.
  const scope = longestRoute();
  const ms = journeyClipKeys(scope, routeStops, KEYS)
    .reduce((sum, k) => sum + (manifest[k]?.durationMs ?? 0), 0);
  const mb = (ms / 1000) * 48_000 * 4 / 1_048_576;

  const wholeMs = KEYS.reduce((sum, k) => sum + (manifest[k]?.durationMs ?? 0), 0);
  const wholeMb = (wholeMs / 1000) * 48_000 * 4 / 1_048_576;

  assert.ok(wholeMb > 300, `the whole manifest should be the fatal option, got ${wholeMb.toFixed(0)} MB`);
  assert.ok(mb < 60, `journey scope decodes to ${mb.toFixed(0)} MB — too much for the device budget`);
});

test("every clip the journey can speak is included", () => {
  const scope = longestRoute();
  const keys = new Set(journeyClipKeys(scope, routeStops, KEYS));

  // The route, every stop on it, the cardinals the ladder counts with, and the
  // fixed phrases. A gap here is an announcement that plays as silence.
  assert.ok(keys.has(`route_${scope.routeId}`));
  for (const seq of Object.values(routeStops[scope.routeId] ?? {})) {
    for (const id of seq) assert.ok(keys.has(`stop_${id}`), `stop_${id} would be silent`);
  }
  for (const n of [1, 2, 3, 40]) assert.ok(keys.has(`num_${n}`));
  for (const k of ["bus_get_off_now", "bus_next_stop", "bus_stops_remaining"]) {
    assert.ok(keys.has(k), `${k} would be silent`);
  }
});

test("both directions are loaded, so a wrong-direction rider can be told where they are", () => {
  const twoWay = Object.entries(routeStops).find(([, d]) => Object.keys(d).length > 1);
  assert.ok(twoWay, "expected at least one two-direction route in the shipped data");
  const [routeId, dirs] = twoWay;
  const keys = new Set(journeyClipKeys({ routeId, directionId: 0 }, routeStops, KEYS));
  for (const seq of Object.values(dirs)) {
    for (const id of seq) assert.ok(keys.has(`stop_${id}`));
  }
});

test("an unknown route still loads the fixed vocabulary", () => {
  // Degrades to speaking counts and phrases rather than to silence.
  const keys = journeyClipKeys({ routeId: "nope", directionId: 0 }, routeStops, KEYS);
  assert.ok(keys.includes("num_3"));
  assert.ok(keys.some((k) => k.startsWith("bus_")));
});

test("the browse window follows the cursor", () => {
  const ids = Array.from({ length: 200 }, (_, i) => `s${i}`);
  const near = browseWindowKeys(ids, 100, { ahead: 5, behind: 2 });
  assert.deepEqual(near, ["s98", "s99", "s100", "s101", "s102", "s103", "s104", "s105"].map((s) => `stop_${s}`));

  // Clamped at both ends rather than throwing or wrapping.
  assert.deepEqual(browseWindowKeys(ids, 0, { ahead: 2, behind: 5 }), ["stop_s0", "stop_s1", "stop_s2"]);
  assert.equal(browseWindowKeys(ids, 199, { ahead: 5, behind: 1 }).length, 2);
  assert.deepEqual(browseWindowKeys([], 0), []);
});

test("the window reaches further forward than back", () => {
  // A list is scrolled forward far more than back, and a name that arrives late
  // reads as the app going quiet.
  const ids = Array.from({ length: 100 }, (_, i) => `s${i}`);
  const w = browseWindowKeys(ids, 50);
  assert.ok(w.indexOf("stop_s50") > 0, "nothing behind the cursor");
  assert.ok(w.length > 20, "window too small to cover a swipe run");
});
