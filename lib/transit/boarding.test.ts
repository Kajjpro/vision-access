/**
 * Boarding detection, driven by synthetic traces.
 *
 * The four the brief names — walking, waiting, boarding, and a car passing
 * while the user is stationary — plus the ones that actually break it: a poor
 * fix, a dropout, and the user rejecting the detection.
 *
 * Traces are built along a REAL route's stop chords, so the corridor test is
 * exercised against genuine city geometry rather than a straight line.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIRM_FIXES, CORRIDOR_M, SUPPRESS_AFTER_REJECT_MS,
  createBoardingState, declareBoarded, distanceToRoute, distanceToSegment,
  correlateVehicle, onWaitingPosition, rejectBoarding,
  type BoardingEvent, type ChordPoint, type Fix,
} from "./boarding";
import type { RouteStops, Stop } from "./types";

const dir = join(process.cwd(), "public/transit");
const stops: Stop[] = JSON.parse(readFileSync(join(dir, "stops.json"), "utf8"));
const routeStops: RouteStops = JSON.parse(readFileSync(join(dir, "route-stops.json"), "utf8"));
const byId = new Map(stops.map((s) => [s.id, s]));

/** A real route's stop chords — the polyline boarding is tested against. */
const chords: ChordPoint[] = (() => {
  const routeId = Object.keys(routeStops).find((id) => (routeStops[id]["0"]?.length ?? 0) > 10)!;
  return routeStops[routeId]["0"].map((id) => byId.get(id)).filter((s): s is Stop => Boolean(s))
    .map((s) => ({ lat: s.lat, lon: s.lon }));
})();

const T0 = 1_700_000_000_000;

/** Interpolates along the chord polyline, so the trace follows the real route. */
function alongRoute(fraction: number): ChordPoint {
  const span = (chords.length - 1) * Math.max(0, Math.min(1, fraction));
  const i = Math.min(chords.length - 2, Math.floor(span));
  const t = span - i;
  return {
    lat: chords[i].lat + (chords[i + 1].lat - chords[i].lat) * t,
    lon: chords[i].lon + (chords[i + 1].lon - chords[i].lon) * t,
  };
}

/** Offsets a point perpendicular-ish, to leave the corridor. */
const offset = (p: ChordPoint, metres: number): ChordPoint => ({
  lat: p.lat + metres / 111_320, lon: p.lon,
});

function replay(fixes: Fix[]) {
  let state = createBoardingState();
  const events: BoardingEvent[] = [];
  for (const fix of fixes) {
    const r = onWaitingPosition(state, fix, chords);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events, boarded: events.some((e) => e.type === "boarded") };
}

/** Builds a trace at a given speed, following or diverging from the route. */
function trace({
  count, speedKmh, intervalMs = 1000, startFraction = 0.2, accuracy = 15, divergeM = 0,
}: {
  count: number; speedKmh: number; intervalMs?: number;
  startFraction?: number; accuracy?: number; divergeM?: number;
}): Fix[] {
  const fixes: Fix[] = [];
  // Convert speed into a fraction step along the polyline.
  let totalM = 0;
  for (let i = 0; i < chords.length - 1; i++) {
    totalM += Math.hypot(
      (chords[i + 1].lat - chords[i].lat) * 111_320,
      (chords[i + 1].lon - chords[i].lon) * 111_320 * Math.cos((chords[i].lat * Math.PI) / 180),
    );
  }
  const metresPerFix = (speedKmh / 3.6) * (intervalMs / 1000);
  const fractionStep = metresPerFix / totalM;

  for (let i = 0; i < count; i++) {
    const base = alongRoute(startFraction + fractionStep * i);
    // A diverging trace walks further off-route with every fix, as a car
    // turning onto a different street would.
    const p = divergeM ? offset(base, divergeM * i) : base;
    fixes.push({ lat: p.lat, lon: p.lon, accuracy, timestamp: T0 + i * intervalMs });
  }
  return fixes;
}

// ------------------------------------------------------------- geometry

test("perpendicular distance to a segment is measured, not to its endpoints", () => {
  const a = { lat: 47.9, lon: 106.9 };
  const b = { lat: 47.9, lon: 106.91 };
  const midAbove = { lat: 47.9009, lon: 106.905 };
  const d = distanceToSegment(midAbove, a, b);
  // ~100 m north of the midpoint, and far from either endpoint.
  assert.ok(d > 80 && d < 120, `${d.toFixed(0)}m`);
});

test("a point beyond a segment's end clamps to the endpoint", () => {
  const a = { lat: 47.9, lon: 106.9 };
  const b = { lat: 47.9, lon: 106.91 };
  const beyond = { lat: 47.9, lon: 106.95 };
  assert.ok(Math.abs(distanceToSegment(beyond, a, b) - distanceToSegment(beyond, b, b)) < 1);
});

test("distance to the route finds the nearest chord", () => {
  const onIt = alongRoute(0.5);
  assert.ok(distanceToRoute(onIt, chords).distanceM < 1);
});

// ------------------------------------------------------- the four traces

test("WALKING along the route does NOT trigger boarding", () => {
  // 5 km/h, right on the route — a user walking to the next stop.
  const { boarded } = replay(trace({ count: 30, speedKmh: 5 }));
  assert.equal(boarded, false, "walking was mistaken for a bus");
});

test("WAITING — standing still at a stop — does NOT trigger boarding", () => {
  const at = alongRoute(0.2);
  const fixes: Fix[] = Array.from({ length: 40 }, (_, i) => ({
    // A metre or two of GPS jitter while stationary.
    lat: at.lat + (i % 3 - 1) * 0.00002,
    lon: at.lon + (i % 2 - 0.5) * 0.00002,
    accuracy: 12, timestamp: T0 + i * 1000,
  }));
  assert.equal(replay(fixes).boarded, false);
});

test("BOARDING — bus speed along the route — DOES trigger", () => {
  const { boarded, events } = replay(trace({ count: 12, speedKmh: 25 }));
  assert.equal(boarded, true, "a real boarding was missed");
  const first = events.findIndex((e) => e.type === "boarded");
  // Must not fire before the confirmation streak is satisfied.
  assert.ok(first >= CONFIRM_FIXES - 1, "declared before the evidence was in");
});

test("A CAR PASSING while the user is stationary does NOT trigger", () => {
  // The specific false positive the brief calls out. The car is at bus speed
  // and starts on the route, but diverges — as a vehicle on another road does.
  const { boarded } = replay(trace({ count: 20, speedKmh: 40, divergeM: 45 }));
  assert.equal(boarded, false, "a passing car was mistaken for the user's bus");
});

// --------------------------------------------------- speed alone is not enough

test("bus speed OFF the route never boards, however long it lasts", () => {
  const far = trace({ count: 60, speedKmh: 30 }).map((f) => ({ ...f, lat: f.lat + 0.02 }));
  assert.equal(replay(far).boarded, false);
});

test("on the route but too slow never boards, however long it lasts", () => {
  assert.equal(replay(trace({ count: 60, speedKmh: 8 })).boarded, false);
});

test("an implausible speed is rejected as a bad fix, not treated as a bus", () => {
  assert.equal(replay(trace({ count: 20, speedKmh: 200 })).boarded, false);
});

// ----------------------------------------------------------- robustness

test("poor-accuracy fixes are discarded and break the streak", () => {
  const fixes = trace({ count: 12, speedKmh: 25, accuracy: 150 });
  assert.equal(replay(fixes).boarded, false);
});

test("a dropout breaks the streak rather than bridging it", () => {
  // Three good fixes, a two-minute gap, then three more. Neither run alone
  // reaches CONFIRM_FIXES, and the gap must not let them add up.
  const first = trace({ count: 3, speedKmh: 25 });
  const second = trace({ count: 3, speedKmh: 25, startFraction: 0.6 })
    .map((f, i) => ({ ...f, timestamp: T0 + 120_000 + i * 1000 }));
  assert.equal(replay([...first, ...second]).boarded, false);
});

test("a single qualifying fix is never enough", () => {
  const fixes = trace({ count: 2, speedKmh: 30 });
  assert.equal(replay(fixes).boarded, false);
});

// ------------------------------------------------------ manual and undo

test("the manual gesture boards immediately, without any GPS evidence", () => {
  const state = declareBoarded(createBoardingState());
  assert.equal(state.declared, true);
});

test("rejection un-boards AND suppresses immediate re-detection", () => {
  let { state } = { state: createBoardingState() };
  for (const fix of trace({ count: 12, speedKmh: 25 })) {
    state = onWaitingPosition(state, fix, chords).state;
  }
  assert.equal(state.declared, true);

  state = rejectBoarding(state, T0 + 12_000);
  assert.equal(state.declared, false);

  // The very next qualifying fixes must not immediately re-declare it —
  // otherwise the user is trapped in a loop they cannot escape.
  for (const fix of trace({ count: 12, speedKmh: 25, startFraction: 0.4 })
    .map((f, i) => ({ ...f, timestamp: T0 + 13_000 + i * 1000 }))) {
    state = onWaitingPosition(state, fix, chords).state;
  }
  assert.equal(state.declared, false, "re-declared inside the suppression window");
});

test("detection resumes once the suppression window passes", () => {
  let state = rejectBoarding(createBoardingState(), T0);
  const after = T0 + SUPPRESS_AFTER_REJECT_MS + 1000;
  for (const fix of trace({ count: 12, speedKmh: 25 }).map((f, i) => ({ ...f, timestamp: after + i * 1000 }))) {
    state = onWaitingPosition(state, fix, chords).state;
  }
  assert.equal(state.declared, true, "suppression never lifted");
});

test("once declared, a dip in speed does not un-board the user", () => {
  let state = declareBoarded(createBoardingState());
  for (const fix of trace({ count: 20, speedKmh: 0.5 })) {
    state = onWaitingPosition(state, fix, chords).state;
  }
  assert.equal(state.declared, true);
});

// ------------------------------------------------------------- corridor

test("the corridor tolerance is wide enough for chord-vs-road error", () => {
  // Chords are straight lines between stops while roads curve, so a genuine
  // bus can sit well off its own chord. Half the tolerance must still pass.
  const nudged = trace({ count: 12, speedKmh: 25 })
    .map((f) => ({ ...f, lat: f.lat + (CORRIDOR_M / 2) / 111_320 }));
  assert.equal(replay(nudged).boarded, true);
});

// ------------------------------------------------- live-feed correlation

test("vehicle correlation names the nearest bus, or nothing", () => {
  const here: Fix = { lat: 47.9186, lon: 106.9177, accuracy: 10, timestamp: T0 };
  const near = { id: 7, plateNumber: "1234 УБА", latitude: 47.9187, longitude: 106.9178 };
  const far = { id: 8, plateNumber: "9999 УБА", latitude: 47.99, longitude: 106.99 };

  assert.equal(correlateVehicle(here, [near, far])?.id, 7);
  assert.equal(correlateVehicle(here, [far]), null);
  assert.equal(correlateVehicle(here, []), null);
});
