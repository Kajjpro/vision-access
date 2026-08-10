/**
 * The freshness gate, driven against forced-stale, forced-empty and
 * forced-erroring feeds.
 *
 * These are the three states the real feed will be in when it matters, and none
 * of them can be produced on demand from a live gateway — which is exactly why
 * the module takes polls and a `now` instead of fetching.
 *
 * The load-bearing assertion in this file is the last one: NO code path
 * produces an arrival announcement without a freshness check.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { buildRouteIndex } from "./route-name";
import {
  ARRIVAL_RADIUS_M, FRESH_WINDOW_MS, MIN_DIFF_INTERVAL_MS,
  assessFreshness, canDropHedge, claimForRoute, createFeedState, feedError,
  ingestPoll, isPlausibleUB, mayAnnounceArrival, trackVehicles,
  type ArrivalClaim, type Vehicle,
} from "./vehicles";
import type { Route } from "./types";

const routes: Route[] = JSON.parse(
  readFileSync(join(process.cwd(), "public/transit/routes.json"), "utf8"),
);
const index = buildRouteIndex(routes);

const T0 = 1_700_000_000_000;
const SEC = 1000;

/** Сүхбаатарын талбай, roughly. */
const bus = (over: Partial<Vehicle> = {}): Vehicle => ({
  id: 1, plateNumber: "1234 УБА", routeName: "Ч-35",
  speed: 30, bearing: 90, latitude: 47.9186, longitude: 106.9177, ...over,
});

/** Moves a vehicle `metres` due east — enough to be unambiguous. */
const movedEast = (v: Vehicle, metres: number): Vehicle => ({
  ...v,
  longitude: v.longitude + metres / (111_320 * Math.cos((v.latitude * Math.PI) / 180)),
});

// ------------------------------------------------------------- plausibility

test("coordinates outside Ulaanbaatar are dropped, not announced", () => {
  assert.equal(isPlausibleUB(bus()), true);
  assert.equal(isPlausibleUB(bus({ latitude: 0, longitude: 0 })), false, "null island");
  assert.equal(isPlausibleUB(bus({ latitude: 106.9, longitude: 47.9 })), false, "lat/lon swapped");
  assert.equal(isPlausibleUB(bus({ latitude: NaN })), false);
});

test("implausible vehicles are counted, never silently discarded", () => {
  const s = ingestPoll(createFeedState(), [bus(), bus({ id: 2, latitude: 0, longitude: 0 })], T0);
  assert.equal(s.snapshots.size, 1);
  assert.equal(s.droppedImplausible, 1);
});

// --------------------------------------------------------------- freshness

test("a first observation is UNKNOWN, never fresh", () => {
  // The whole no-timestamp problem in one assertion: on poll one, a feed frozen
  // for a week looks exactly like a live one.
  const f = assessFreshness(bus(), undefined, T0);
  assert.equal(f.state, "unknown");
  assert.equal(f.reason, "first-observation");
  assert.equal(canDropHedge(f), false);
});

test("a vehicle we watched move is FRESH", () => {
  const first = { vehicle: bus(), observedAt: T0, freshness: assessFreshness(bus(), undefined, T0) };
  const f = assessFreshness(movedEast(bus(), 200), first, T0 + 20 * SEC);
  assert.equal(f.state, "fresh");
  assert.equal(canDropHedge(f), true);
});

test("STALE: claims 45 km/h, has not moved in 60 s", () => {
  // 45 km/h for 60 s is 750 m. Zero displacement is a contradiction, and it is
  // detectable with no timestamp anywhere in the payload.
  const v = bus({ speed: 45 });
  const first = { vehicle: v, observedAt: T0, freshness: assessFreshness(v, undefined, T0) };
  const f = assessFreshness(v, first, T0 + 60 * SEC);
  assert.equal(f.state, "stale");
  assert.equal(f.reason, "frozen-coordinates");
  assert.equal(canDropHedge(f), false);
});

test("STALE: moving but far short of what its own speed implies", () => {
  const v = bus({ speed: 45 });
  const first = { vehicle: v, observedAt: T0, freshness: assessFreshness(v, undefined, T0) };
  // 60 m against an implied 750 m — under the 25 % tolerance.
  const f = assessFreshness(movedEast(v, 60), first, T0 + 60 * SEC);
  assert.equal(f.state, "stale");
  assert.equal(f.reason, "speed-without-movement");
});

test("a genuinely stopped bus is UNKNOWN, not stale — no contradiction exists", () => {
  // Stopped at a light and honestly reporting speed 0. Proves nothing either
  // way, so it must not be punished as stale nor rewarded as fresh.
  const v = bus({ speed: 0 });
  const first = { vehicle: v, observedAt: T0, freshness: assessFreshness(v, undefined, T0) };
  const f = assessFreshness(v, first, T0 + 60 * SEC);
  assert.equal(f.state, "unknown");
  assert.equal(f.reason, "stationary-and-slow");
});

test("polling faster than the noise floor cannot manufacture freshness", () => {
  const first = { vehicle: bus(), observedAt: T0, freshness: assessFreshness(bus(), undefined, T0) };
  const f = assessFreshness(movedEast(bus(), 200), first, T0 + MIN_DIFF_INTERVAL_MS - 1);
  assert.equal(f.state, "unknown");
  assert.equal(f.reason, "interval-too-short");
});

test("freshness EXPIRES — old evidence stops licensing an announcement", () => {
  let snapshot = { vehicle: bus(), observedAt: T0, freshness: assessFreshness(bus(), undefined, T0) };
  const moved = movedEast(bus(), 200);
  snapshot = { vehicle: moved, observedAt: T0 + 20 * SEC, freshness: assessFreshness(moved, snapshot, T0 + 20 * SEC) };
  assert.equal(snapshot.freshness.state, "fresh");

  // Now it sits still, well past the window.
  const later = T0 + 20 * SEC + FRESH_WINDOW_MS + SEC;
  const f = assessFreshness({ ...moved, speed: 0 }, snapshot, later);
  assert.equal(f.state, "unknown");
  assert.equal(f.reason, "evidence-expired");
});

// ------------------------------------------------------------ feed health

test("FORCED EMPTY: a feed with no vehicles is empty, not live", () => {
  const s = ingestPoll(createFeedState(), [], T0);
  assert.equal(s.health.state, "empty");
});

test("FORCED STALE: a whole city that did not move is SUSPECT, not live", () => {
  const fleet = [bus({ id: 1 }), bus({ id: 2, routeName: "Ч-39" }), bus({ id: 3, routeName: "М-4" })];
  let s = ingestPoll(createFeedState(), fleet, T0);
  s = ingestPoll(s, fleet, T0 + 60 * SEC);
  assert.equal(s.health.state, "suspect");
  assert.equal(s.health.state === "suspect" && s.health.reason, "nothing-moved");
});

test("one moving vehicle is enough to call the feed live", () => {
  const fleet = [bus({ id: 1 }), bus({ id: 2, routeName: "Ч-39" })];
  let s = ingestPoll(createFeedState(), fleet, T0);
  s = ingestPoll(s, [movedEast(fleet[0], 200), fleet[1]], T0 + 20 * SEC);
  assert.equal(s.health.state, "live");
  assert.equal(s.health.state === "live" && s.health.movedCount, 1);
});

test("FORCED ERROR: an errored feed DROPS its last known positions", () => {
  let s = ingestPoll(createFeedState(), [bus()], T0);
  assert.equal(s.snapshots.size, 1);
  s = feedError(s, "timeout");
  assert.equal(s.health.state, "error");
  assert.equal(s.snapshots.size, 0, "serving last-known positions after the feed dies invents a bus");
});

// ---------------------------------------------------------------- the join

test("vehicles on routes we do not have are counted, not silently dropped", () => {
  const s = ingestPoll(createFeedState(), [bus({ id: 1, routeName: "Ч-35" }), bus({ id: 2, routeName: "БЭ-1" })], T0);
  const { tracked, unjoinable } = trackVehicles(s, index, () => 0);
  assert.equal(tracked.length, 1);
  assert.deepEqual([...unjoinable], ["БЭ-1"]);
});

// --------------------------------------------------------------- the gate

const approach = (distanceM: number, stopsAway: number) => () => ({ distanceM, stopsAway });

function claimAt(distanceM: number, opts: { speed?: number; polls?: number } = {}): {
  claim: ArrivalClaim; feed: ReturnType<typeof ingestPoll>["health"]; now: number;
} {
  const v = bus({ speed: opts.speed ?? 30 });
  let s = ingestPoll(createFeedState(), [v], T0);
  const now = T0 + 20 * SEC;
  s = ingestPoll(s, [movedEast(v, 200)], now);
  const { tracked } = trackVehicles(s, index, () => 0);
  const route = routes.find((r) => r.displayName === "Ч:35")!;
  const { best } = claimForRoute(tracked, route.id, 0, approach(distanceM, 0), now);
  return { claim: best, feed: s.health, now };
}

test("a fresh vehicle within 50 m MAY be announced as arriving", () => {
  const { claim, feed, now } = claimAt(30);
  assert.equal(claim.kind, "live");
  assert.equal(mayAnnounceArrival(claim, now, feed), true);
});

test("a fresh vehicle beyond 50 m may NOT be announced as arriving", () => {
  const { claim, feed, now } = claimAt(ARRIVAL_RADIUS_M + 1);
  assert.equal(mayAnnounceArrival(claim, now, feed), false);
});

test("an unverified vehicle may NOT be announced as arriving, however close", () => {
  // Single poll: freshness is `first-observation`, so no claim can be live.
  const v = bus();
  const s = ingestPoll(createFeedState(), [v], T0);
  const { tracked } = trackVehicles(s, index, () => 0);
  const route = routes.find((r) => r.displayName === "Ч:35")!;
  const { best } = claimForRoute(tracked, route.id, 0, approach(5, 0), T0);
  assert.equal(best.kind, "unverified");
  assert.equal(mayAnnounceArrival(best, T0, s.health), false);
});

test("a live claim whose evidence has since expired may NOT be announced", () => {
  const { claim, feed } = claimAt(10);
  assert.equal(claim.kind, "live");
  const muchLater = T0 + 20 * SEC + FRESH_WINDOW_MS + SEC;
  assert.equal(mayAnnounceArrival(claim, muchLater, feed), false);
});

test("no ETA is invented when speed cannot support one", () => {
  const { claim } = claimAt(400, { speed: 0 });
  // Still live — we watched it move — but a stopped bus yields no minute count.
  assert.equal(claim.kind, "live");
  assert.equal(claim.kind === "live" && claim.etaMinutes, null);
});

test("a route with no vehicles reports no-vehicle, so the caller falls back", () => {
  const s = ingestPoll(createFeedState(), [bus({ routeName: "Ч-39" })], T0);
  const { tracked } = trackVehicles(s, index, () => 0);
  const route = routes.find((r) => r.displayName === "Ч:35")!;
  const { best } = claimForRoute(tracked, route.id, 0, approach(10, 0), T0);
  assert.equal(best.kind, "no-vehicle");
});

test("the vehicle after the nearest is offered, so a missed bus has a known wait", () => {
  const a = bus({ id: 1 });
  const b = bus({ id: 2 });
  let s = ingestPoll(createFeedState(), [a, b], T0);
  const now = T0 + 20 * SEC;
  s = ingestPoll(s, [movedEast(a, 200), movedEast(b, 200)], now);
  const { tracked } = trackVehicles(s, index, () => 0);
  const route = routes.find((r) => r.displayName === "Ч:35")!;
  const { best, next } = claimForRoute(
    tracked, route.id, 0,
    (t) => ({ distanceM: t.snapshot.vehicle.id === 1 ? 100 : 900, stopsAway: t.snapshot.vehicle.id === 1 ? 0 : 2 }),
    now,
  );
  assert.equal(best.kind === "live" && best.distanceM, 100);
  assert.equal(next?.kind === "live" && next.distanceM, 900);
});

// ------------------------------------------------- the load-bearing assertion

test("NO combination of inputs announces arrival without verified freshness", () => {
  // Exhaustive sweep over the states the feed can be in. If any path yields
  // true for a claim that is not live-and-fresh-and-close, the safety rule is
  // not actually enforced anywhere.
  const feeds = [
    { state: "live" as const, vehicleCount: 3, movedCount: 1 },
    { state: "suspect" as const, vehicleCount: 3, reason: "nothing-moved" as const },
    { state: "empty" as const, vehicleCount: 0 as const },
    { state: "error" as const, reason: "timeout" },
  ];
  const claims: ArrivalClaim[] = [
    { kind: "no-vehicle" },
    { kind: "unverified", reason: "freshness:stale:frozen-coordinates" },
    { kind: "unverified", reason: "freshness:unknown:first-observation" },
    { kind: "live", vehicle: bus(), distanceM: 10, stopsAway: 0, etaMinutes: 1, freshAt: T0 },
    { kind: "live", vehicle: bus(), distanceM: 10, stopsAway: 0, etaMinutes: 1, freshAt: T0 - FRESH_WINDOW_MS - 1 },
    { kind: "live", vehicle: bus(), distanceM: 5000, stopsAway: 9, etaMinutes: 20, freshAt: T0 },
    { kind: "live", vehicle: bus(), distanceM: NaN, stopsAway: 0, etaMinutes: null, freshAt: T0 },
  ];

  for (const feed of feeds) {
    for (const claim of claims) {
      const allowed = mayAnnounceArrival(claim, T0, feed);
      if (!allowed) continue;

      // Anything that got through must satisfy every condition, independently.
      assert.equal(feed.state, "live", `announced on a ${feed.state} feed`);
      assert.equal(claim.kind, "live", `announced on a ${claim.kind} claim`);
      assert.ok(claim.kind === "live" && claim.distanceM <= ARRIVAL_RADIUS_M, "announced beyond 50 m");
      assert.ok(claim.kind === "live" && T0 - claim.freshAt <= FRESH_WINDOW_MS, "announced on expired evidence");
    }
  }

  // And confirm the sweep is not vacuous — exactly one combination should pass.
  const passing = feeds.flatMap((f) => claims.map((c) => mayAnnounceArrival(c, T0, f))).filter(Boolean);
  assert.equal(passing.length, 1, "the sweep proved nothing if no combination passes");
});
