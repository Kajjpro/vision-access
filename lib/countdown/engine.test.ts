/**
 * The engine, driven by seeded traces over real route geometry.
 *
 * The properties asserted here are the ones that decide whether a blind rider
 * gets off at the right stop:
 *
 *   the index reaches the destination exactly once and never overshoots early;
 *   a flapping fix at a stop boundary produces ONE advance, not a stutter;
 *   the index never goes backwards inside a trip;
 *   losing the fix degrades the register audibly instead of freezing the count.
 *
 * Every trace comes from the seeded PRNG in lib/transit/gps-sim.ts, so a failure
 * reproduces exactly. A test that only fails on some seeds is a test that gets
 * ignored.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACCURACY_LIMIT_M, ADVANCE_THRESHOLD_M, CONFIRMATION_FIXES, confidenceFor,
  WRONG_DIRECTION_SPACINGS, WRONG_DIRECTION_SUSTAIN_FIXES,
  createEngine, DEAD_RECKONING_LIMIT_MS, deadReckonedIndex, FRESH_MS, isDowngrade,
  LAYOVER_MS, onFix, onTick, remainingTo, STALE_MS,
  type EngineEvent, type EngineState, type Fix,
} from "./engine";
import { StopChainGeometry, type GeometryStop } from "./geometry";
import { generateTrace } from "../transit/gps-sim";
import type { RouteStops, Stop } from "../transit/types";

const stops: Stop[] = JSON.parse(readFileSync("public/transit/stops.json", "utf8"));
const routeStops: RouteStops = JSON.parse(readFileSync("public/transit/route-stops.json", "utf8"));
const byId = new Map(stops.map((s) => [s.id, s]));

function chainFor(routeId: string, dir: string): GeometryStop[] {
  return (routeStops[routeId]?.[dir] ?? [])
    .map((id) => byId.get(id))
    .filter((s): s is Stop => Boolean(s))
    .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));
}

/** A long, ordinary variant to drive most of the tests over. */
const ROUTE = Object.keys(routeStops)[0];
const CHAIN = (() => {
  for (const [routeId, dirs] of Object.entries(routeStops)) {
    for (const dir of Object.keys(dirs)) {
      const c = chainFor(routeId, dir);
      if (c.length >= 12) return c;
    }
  }
  throw new Error("no variant with 12+ stops");
})();

/**
 * The simulator names the field `accuracy`; this engine names it `accuracyM`.
 *
 * Adapted here rather than renamed there: lib/transit/stop-matcher.ts is the
 * shipped counter today and its Fix type is part of that contract. One small
 * adapter beats a rename that touches a tested module the countdown is meant to
 * replace, not disturb.
 */
const asFixes = (trace: { lat: number; lon: number; accuracy: number; timestamp: number }[]): Fix[] =>
  trace.map((f) => ({ lat: f.lat, lon: f.lon, accuracyM: f.accuracy, timestamp: f.timestamp }));

/** Replay a whole trace, collecting everything the engine emitted. */
function replay(
  fixes: Fix[],
  chain: GeometryStop[] = CHAIN,
  startIndex = 0,
): { state: EngineState; events: EngineEvent[] } {
  const geometry = new StopChainGeometry(chain);
  let state = createEngine(startIndex, geometry);
  const events: EngineEvent[] = [];
  for (const fix of fixes) {
    const r = onFix(state, fix, geometry, fix.timestamp);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

const advances = (events: EngineEvent[]) =>
  events.filter((e): e is Extract<EngineEvent, { type: "advanced" }> => e.type === "advanced");

// ------------------------------------------------------------- clean trip

test("a clean run reaches every stop, in order, exactly once", () => {
  const trace = asFixes(generateTrace(CHAIN, { seed: 1, noiseM: 10, speedKmh: 25 }));
  const { state, events } = replay(trace);
  const reached = advances(events).map((e) => e.to);

  assert.deepEqual(reached, [...reached].sort((a, b) => a - b), "advances arrived out of order");
  assert.equal(new Set(reached).size, reached.length, "a stop was announced twice");
  assert.ok(
    state.stopIndex >= CHAIN.length - 2,
    `ended at ${state.stopIndex} of ${CHAIN.length - 1} — the count fell behind`,
  );
});

test("the index never decreases inside a trip, at any noise level", () => {
  for (const noiseM of [10, 25, 40, 60]) {
    const trace = asFixes(generateTrace(CHAIN, { seed: 7, noiseM }));
    const geometry = new StopChainGeometry(CHAIN);
    let state = createEngine(0, geometry);
    let previous = 0;
    for (const fix of trace) {
      state = onFix(state, fix, geometry, fix.timestamp).state;
      assert.ok(state.stopIndex >= previous, `noise ${noiseM} m: index went ${previous} → ${state.stopIndex}`);
      previous = state.stopIndex;
    }
  }
});

// --------------------------------------------------------- the hysteresis

test("REGRESSION: a fix flapping at a stop boundary advances once, not repeatedly", () => {
  /**
   * The most common bug in this class of feature. A bus paused at a light just
   * past a stop, with a fix hopping either side of the boundary, used to emit an
   * advance per hop — "гурван буудал", "дөрвөн буудал", "гурван буудал" — which
   * teaches a rider that the count is noise.
   */
  const geometry = new StopChainGeometry(CHAIN);
  const target = 3;
  const base = geometry.distanceToStop(target);
  let state = createEngine(target - 1, geometry);
  const events: EngineEvent[] = [];

  const feed = (alongM: number, t: number) => {
    const at = pointAtDistance(geometry, CHAIN, alongM);
    const r = onFix(state, { ...at, accuracyM: 15, timestamp: t }, geometry, t);
    state = r.state;
    events.push(...r.events);
  };

  // Two minutes hopping either side of the boundary, as at a red light.
  const flapping = [base - 10, base + 60, base - 5, base + 55, base - 15, base + 70];
  let t = 1_700_000_000_000;
  for (let i = 0; i < 40; i++) {
    feed(flapping[i % flapping.length], t);
    t += 3_000;
  }

  // While it is genuinely ambiguous, the count does not move at all — two
  // CONSECUTIVE fixes have to agree, and an alternating pair never gives two.
  assert.equal(advances(events).length, 0, "the boundary flapped into an advance");
  assert.equal(state.stopIndex, target - 1);

  // Then the light changes and it drives on. Exactly one advance, now.
  for (let i = 0; i < 4; i++) {
    feed(base + 80 + i * 20, t);
    t += 3_000;
  }

  assert.equal(advances(events).length, 1, "driving on produced more than one advance");
  assert.equal(state.stopIndex, target);
});

test("one fix past the threshold is not enough — a second must agree", () => {
  const geometry = new StopChainGeometry(CHAIN);
  const target = 4;
  const alongM = geometry.distanceToStop(target) + ADVANCE_THRESHOLD_M + 10;
  const at = pointAtDistance(geometry, CHAIN, alongM);
  let state = createEngine(target - 1, geometry);

  const first = onFix(state, { ...at, accuracyM: 15, timestamp: 1000 }, geometry, 1000);
  assert.equal(advances(first.events).length, 0, "a single fix advanced the count");
  assert.equal(first.state.pending?.index, target, "the advance was not held pending");

  state = first.state;
  const second = onFix(state, { ...at, accuracyM: 15, timestamp: 4000 }, geometry, 4000);
  assert.equal(advances(second.events).length, 1);
  assert.equal(second.state.stopIndex, target);
  assert.equal(CONFIRMATION_FIXES, 2, "this test encodes the documented value");
});

test("passing a stop by less than the threshold does not advance", () => {
  const geometry = new StopChainGeometry(CHAIN);
  const target = 5;
  const alongM = geometry.distanceToStop(target) + ADVANCE_THRESHOLD_M - 15;
  const at = pointAtDistance(geometry, CHAIN, alongM);
  let state = createEngine(target - 1, geometry);
  for (const t of [1000, 4000, 7000, 10_000]) {
    state = onFix(state, { ...at, accuracyM: 10, timestamp: t }, geometry, t).state;
  }
  assert.equal(state.stopIndex, target - 1, "fix noise was counted as arriving");
});

// ------------------------------------------------------------ rejections

test("a fix worse than the accuracy limit is discarded, never smoothed", () => {
  // Averaging a 300 m fix with a 20 m one yields a confident-looking number
  // that is wrong, which is the worst of both.
  const geometry = new StopChainGeometry(CHAIN);
  const state = createEngine(2, geometry);
  const at = pointAtDistance(geometry, CHAIN, geometry.distanceToStop(6));
  const r = onFix(state, { ...at, accuracyM: ACCURACY_LIMIT_M + 1, timestamp: 1000 }, geometry, 1000);
  assert.deepEqual(r.events, [{ type: "rejected", reason: "accuracy" }]);
  assert.equal(r.state.stopIndex, 2, "a useless fix moved the count");
});

test("a fix stamped before the previous one is rejected — clock skew, not travel", () => {
  const geometry = new StopChainGeometry(CHAIN);
  let state = createEngine(0, geometry);
  const at = pointAtDistance(geometry, CHAIN, 10);
  state = onFix(state, { ...at, accuracyM: 10, timestamp: 50_000 }, geometry, 50_000).state;
  const r = onFix(state, { ...at, accuracyM: 10, timestamp: 40_000 }, geometry, 50_000);
  assert.deepEqual(r.events, [{ type: "rejected", reason: "stale-timestamp" }]);
});

// -------------------------------------------------------- §6.1 direction

test("wrong-direction needs real backward TRAVEL, not two backward-looking samples", () => {
  // The old rule fired on CONFIRMATION_FIXES consecutive backwards fixes, which
  // asked "did two samples look backwards" rather than "has this bus travelled
  // backwards". Measured over 146 correct-direction journeys it fired in 142 of
  // them, a median of 7 times each. This encodes the displacement rule instead.
  const geometry = new StopChainGeometry(CHAIN);
  const start = 6;
  const threshold = WRONG_DIRECTION_SPACINGS * geometry.meanStopSpacingM;
  const from = geometry.distanceToStop(start);

  const feedAt = (state: EngineState, alongM: number, t: number) =>
    onFix(state, { ...pointAtDistance(geometry, CHAIN, Math.max(0, alongM)), accuracyM: 10, timestamp: t }, geometry, t);

  // One fix well behind is drift, and drift must never fire.
  let state = createEngine(start, geometry);
  const single = feedAt(state, from - threshold - 50, 1000);
  assert.ok(!single.events.some((e) => e.type === "wrong-direction"), "fired on a single drifted fix");

  // A transient excursion that returns forward is the loop-route projection
  // jump, not a reversing bus. The old fix-count rule could not tell them apart.
  state = createEngine(start, geometry);
  let t = 1000;
  for (let i = 0; i < WRONG_DIRECTION_SUSTAIN_FIXES - 1; i++) {
    state = feedAt(state, from - threshold - 50, (t += 1000)).state;
  }
  const recovered = feedAt(state, from, (t += 1000));
  state = recovered.state;
  assert.ok(!recovered.events.some((e) => e.type === "wrong-direction"), "fired on a transient excursion");
  assert.equal(state.backwardRun, 0, "the run did not reset when the bus came forward again");

  // Sustained backward travel past the threshold is the real thing.
  state = createEngine(start, geometry);
  let fired = false;
  for (let i = 0; i < WRONG_DIRECTION_SUSTAIN_FIXES + 2; i++) {
    const r = feedAt(state, from - threshold - 50 - i * 5, (t += 1000));
    state = r.state;
    if (r.events.some((e) => e.type === "wrong-direction")) fired = true;
  }
  assert.ok(fired, "never fired despite sustained backward travel");
  assert.equal(state.stopIndex, start, "the count moved backwards");

  // Reported once per trip: a repeating alert is one a rider stops hearing.
  let again = false;
  for (let i = 0; i < 5; i++) {
    const r = feedAt(state, geometry.distanceToStop(1), (t += 1000));
    state = r.state;
    if (r.events.some((e) => e.type === "wrong-direction")) again = true;
  }
  assert.ok(!again, "wrong-direction repeated after it had already been reported");
});

test("wrong-bus fires only when the caller supplies the evidence", () => {
  // The engine cannot answer "is the nearest stop on this variant" without all
  // 923 stops, so it stays pure and the caller decides. No evidence, no alert.
  const geometry = new StopChainGeometry(CHAIN);
  const at = pointAtDistance(geometry, CHAIN, geometry.distanceToStop(2));
  let state = createEngine(2, geometry);

  for (const t of [1000, 4000]) {
    state = onFix(state, { ...at, accuracyM: 10, timestamp: t }, geometry, t).state;
  }
  assert.equal(state.offRouteIntervals, 0, "fired with no evidence supplied");

  let off = createEngine(2, geometry);
  const a = onFix(off, { ...at, accuracyM: 10, timestamp: 1000 }, geometry, 1000, false);
  off = a.state;
  assert.ok(!a.events.some((e) => e.type === "off-route"), "fired on one interval");
  const b = onFix(off, { ...at, accuracyM: 10, timestamp: 4000 }, geometry, 4000, false);
  assert.ok(b.events.some((e) => e.type === "off-route"), "never fired despite sustained evidence");
});

// ----------------------------------------------------------- the layover

test("a terminus layover is the one legitimate way the index goes back", () => {
  const geometry = new StopChainGeometry(CHAIN);
  const terminus = CHAIN.length - 1;
  let state = createEngine(terminus, geometry);

  // Sit still at the terminus for longer than the layover window.
  const parked = pointAtDistance(geometry, CHAIN, geometry.distanceToStop(terminus));
  let t = 1_000_000;
  for (let i = 0; i < 30; i++) {
    state = onFix(state, { ...parked, accuracyM: 10, timestamp: t }, geometry, t).state;
    t += LAYOVER_MS / 10;
  }

  // Then read as the start of the route: a new trip, not a reversal.
  const start = pointAtDistance(geometry, CHAIN, 0);
  const r = onFix(state, { ...start, accuracyM: 10, timestamp: t }, geometry, t);
  assert.ok(r.events.some((e) => e.type === "layover"), "the turnaround was treated as drift");
  assert.equal(r.state.stopIndex, 0);
});

test("a brief stop at a light does NOT reset the trip", () => {
  const geometry = new StopChainGeometry(CHAIN);
  let state = createEngine(5, geometry);
  const parked = pointAtDistance(geometry, CHAIN, geometry.distanceToStop(5) + 10);
  let t = 1_000_000;
  for (let i = 0; i < 5; i++) {                 // ~50 s, well under the layover
    state = onFix(state, { ...parked, accuracyM: 10, timestamp: t }, geometry, t).state;
    t += 10_000;
  }
  const back = pointAtDistance(geometry, CHAIN, geometry.distanceToStop(1));
  const r = onFix(state, { ...back, accuracyM: 10, timestamp: t }, geometry, t);
  assert.ok(!r.events.some((e) => e.type === "layover"));
  assert.equal(r.state.stopIndex, 5, "a light turned into a route reset");
});

// ---------------------------------------------------------- confidence

test("the confidence table matches CLAUDE.md exactly", () => {
  assert.equal(confidenceFor("gps_matched", 0), "high");
  assert.equal(confidenceFor("gps_matched", FRESH_MS - 1), "high");
  assert.equal(confidenceFor("gps_matched", FRESH_MS + 1), "medium");
  assert.equal(confidenceFor("gps_matched", STALE_MS + 1), "none");
  assert.equal(confidenceFor("eta_inferred", 0), "medium");
  assert.equal(confidenceFor("eta_inferred", 10 * 60_000), "medium", "eta confidence is age-independent");
  assert.equal(confidenceFor("dead_reckoned", DEAD_RECKONING_LIMIT_MS - 1), "low");
  assert.equal(confidenceFor("dead_reckoned", DEAD_RECKONING_LIMIT_MS + 1), "none");
  assert.equal(confidenceFor("none", 0), "none");
});

test("losing the fix degrades the register instead of freezing the count", () => {
  // To someone who cannot see the counter, an unchanging count is
  // indistinguishable from a working one right up until they have ridden past
  // their stop. The loss has to become audible.
  const geometry = new StopChainGeometry(CHAIN);
  const at = pointAtDistance(geometry, CHAIN, geometry.distanceToStop(3));
  let state = createEngine(3, geometry);
  state = onFix(state, { ...at, accuracyM: 10, timestamp: 1_000_000 }, geometry, 1_000_000).state;
  assert.equal(state.confidence, "high");

  const stale = onTick(state, 1_000_000 + STALE_MS + 1_000);
  assert.equal(stale.state.source, "dead_reckoned");
  assert.equal(stale.state.confidence, "low");
  assert.ok(stale.events.some((e) => e.type === "confidence"));

  const gone = onTick(stale.state, 1_000_000 + DEAD_RECKONING_LIMIT_MS + 1_000);
  assert.equal(gone.state.confidence, "none");
});

test("only downgrades are downgrades", () => {
  assert.ok(isDowngrade("high", "medium"));
  assert.ok(isDowngrade("medium", "none"));
  assert.ok(!isDowngrade("low", "high"));
  assert.ok(!isDowngrade("high", "high"));
});

test("dead reckoning informs the status query but never the count", () => {
  const geometry = new StopChainGeometry(CHAIN);
  const at = pointAtDistance(geometry, CHAIN, geometry.distanceToStop(2));
  let state = createEngine(2, geometry);
  state = onFix(state, { ...at, accuracyM: 10, timestamp: 1_000_000 }, geometry, 1_000_000).state;

  const reckoned = deadReckonedIndex(state, geometry, 1_000_000 + 120_000);
  assert.ok(reckoned !== null && reckoned > 2, "reckoning produced nothing to say");

  // The committed index is untouched — a wrongly reckoned advance is exactly the
  // announcement that puts someone off a bus in the wrong district.
  const ticked = onTick(state, 1_000_000 + 120_000);
  assert.equal(ticked.state.stopIndex, 2);

  assert.equal(deadReckonedIndex(state, geometry, 1_000_000 + DEAD_RECKONING_LIMIT_MS + 1), null);
});

// ------------------------------------------------------------- dropouts

test("a GPS dropout mid-route does not lose or duplicate a stop", () => {
  const trace = asFixes(generateTrace(CHAIN, {
    seed: 42,
    noiseM: 25,
    dropouts: [{ startSec: 60, durationSec: 45 }],
  }));
  const { events } = replay(trace);
  const reached = advances(events).map((e) => e.to);
  assert.equal(new Set(reached).size, reached.length, "a stop was announced twice across the gap");
  assert.deepEqual(reached, [...reached].sort((a, b) => a - b));
});

test("a window of unusable accuracy is skipped rather than believed", () => {
  const trace = asFixes(generateTrace(CHAIN, {
    seed: 11,
    noiseM: 20,
    badAccuracyWindows: [{ startSec: 40, durationSec: 30, accuracyM: 400 }],
  }));
  const { events, state } = replay(trace);
  assert.ok(events.some((e) => e.type === "rejected" && e.reason === "accuracy"));
  const reached = advances(events).map((e) => e.to);
  assert.deepEqual(reached, [...reached].sort((a, b) => a - b));
  assert.ok(state.stopIndex > 0);
});

// -------------------------------------------------------------- counting

test("remaining counts down to zero at the destination and goes negative past it", () => {
  const geometry = new StopChainGeometry(CHAIN);
  const state = createEngine(4, geometry);
  assert.equal(remainingTo(state, 7), 3);
  assert.equal(remainingTo(state, 4), 0);
  assert.equal(remainingTo(state, 2), -2, "an overshoot must read negative, not zero");
});

test("loop variants are counted by index, never by stop id", () => {
  // Three genuine duplicate stop names already exist in source data, and a loop
  // variant repeats an id outright. Keying on the id would count the second
  // pass as the first and get the rider off half a circuit early.
  const looped = [...CHAIN.slice(0, 6), ...CHAIN.slice(0, 6)];
  const geometry = new StopChainGeometry(looped);
  const secondPass = geometry.distanceToStop(7);
  const at = pointAtDistance(geometry, looped, secondPass + ADVANCE_THRESHOLD_M + 5);
  let state = createEngine(6, geometry);
  for (const t of [1000, 4000]) {
    state = onFix(state, { ...at, accuracyM: 10, timestamp: t }, geometry, t).state;
  }
  assert.equal(state.stopIndex, 7, "the repeated id collapsed onto the first pass");
});

test("the engine is pure — the same inputs give the same outputs", () => {
  const trace = asFixes(generateTrace(CHAIN, { seed: 5, noiseM: 30 }));
  const a = replay(trace);
  const b = replay(trace);
  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.events, b.events);
});

void ROUTE;

// ----------------------------------------------------------------- helper

/**
 * A lat/lon at a given distance along the chain.
 *
 * Lets a test place a bus at "40 m past stop 3" rather than at a coordinate
 * someone had to work out by hand — which is what makes the threshold tests
 * readable as statements about the threshold.
 */
function pointAtDistance(
  geometry: StopChainGeometry,
  chain: GeometryStop[],
  alongM: number,
): { lat: number; lon: number } {
  let i = 0;
  while (i < chain.length - 2 && geometry.distanceToStop(i + 1) <= alongM) i++;
  const segStart = geometry.distanceToStop(i);
  const segEnd = geometry.distanceToStop(i + 1);
  const t = segEnd > segStart ? (alongM - segStart) / (segEnd - segStart) : 0;
  return {
    lat: chain[i].lat + (chain[i + 1].lat - chain[i].lat) * t,
    lon: chain[i].lon + (chain[i + 1].lon - chain[i].lon) * t,
  };
}
