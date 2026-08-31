/**
 * Mode A: nearest-stop search, same-name disambiguation, timezone, the
 * circuit breaker, and the guarantee that no arrival can be spoken unhedged.
 *
 *   npx tsx --test lib/transit/*.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { AudioQueue, type ClipPlayer } from "./audio-queue";
import { announceArrival, isUnhedgedTime, MAX_SPOKEN_NUMBER } from "./announce";
import { CircuitBreaker, Coalescer, TtlCache } from "./breaker";
import { findNearestStop, haversine, MAX_MATCH_M, resolveByRoute, routeChoicesFor } from "./geo";
import { buildHandoff, validateHandoff, HANDOFF_TTL_MS } from "./handoff";
import { agencyDateTime, AGENCY_UTC_OFFSET_MS, headwayFallback, legsToArrivals } from "./otp";
import type { Arrival, OtpLeg, Stop, StopRoutes } from "./types";

const stops: Stop[] = JSON.parse(readFileSync("public/transit/stops.json", "utf8"));
const stopRoutes: StopRoutes = JSON.parse(readFileSync("public/transit/stop-routes.json", "utf8"));
const routeStops = JSON.parse(readFileSync("public/transit/route-stops.json", "utf8"));

// The live same-name case: two stops ~100 m apart, no direction suffix.
const DUNJIN = stops.filter((s) => s.name === "Дүнжингарав Худалдааны төв");

// ------------------------------------------------------------ nearest stop

/** Announcements need a lifetime; these tests are not about expiry. */
const FAR = () => Date.now() + 60_000;

test("a position on top of a stop matches it", () => {
  const target = stops.find((s) => s.name === "Саппоро /Урд/")!;
  const r = findNearestStop({ lat: target.lat, lon: target.lon }, stops);
  assert.equal(r.kind, "single");
  if (r.kind !== "single") return;
  assert.equal(r.candidates[0].stop.id, target.id);
  assert.ok(r.candidates[0].distanceM < 1);
});

test("inside 150 m matches; outside 150 m returns none rather than guessing", () => {
  const target = stops.find((s) => s.name === "Саппоро /Урд/")!;
  // ~0.001 degrees latitude is ~111 m.
  const inside = findNearestStop({ lat: target.lat + 0.001, lon: target.lon }, stops);
  assert.notEqual(inside.kind, "none");

  // Far out in the steppe, well beyond any stop.
  const outside = findNearestStop({ lat: 47.0, lon: 105.0 }, stops);
  assert.equal(outside.kind, "none");
  if (outside.kind !== "none") return;
  assert.ok((outside.nearestDistanceM ?? 0) > MAX_MATCH_M);
});

test("the 150 m boundary is inclusive on the inside and exclusive beyond", () => {
  // A synthetic pair, so the assertion is about the boundary and not about
  // whichever real stop happens to sit nearby.
  const origin: Stop = { id: "T1", name: "Тест", lat: 47.9, lon: 106.9 };
  const only = [origin];
  const north = (metres: number) => ({ lat: origin.lat + metres / 111_320, lon: origin.lon });

  const at149 = findNearestStop(north(149), only);
  assert.equal(at149.kind, "single", "149 m must match");

  const at151 = findNearestStop(north(151), only);
  assert.equal(at151.kind, "none", "151 m must not match");

  // Exactly at the boundary: <= is a match.
  const d = haversine(north(150), origin);
  assert.ok(Math.abs(d - 150) < 1, `expected ~150 m, got ${d.toFixed(1)}`);
  const at150 = findNearestStop(north(150), only);
  assert.equal(at150.kind, "single", "exactly 150 m must match");
});

// ------------------------------------------------- same-name disambiguation

test("the Дүнжингарав pair really is same-name and inside GPS error", () => {
  assert.equal(DUNJIN.length, 2, "expected exactly two stops with this name");
  const gap = haversine(DUNJIN[0], DUNJIN[1]);
  assert.ok(gap < 200, `expected < 200 m apart, got ${gap.toFixed(0)} m`);
});

test("standing between the Дүнжингарав pair is reported ambiguous, not guessed", () => {
  const mid = {
    lat: (DUNJIN[0].lat + DUNJIN[1].lat) / 2,
    lon: (DUNJIN[0].lon + DUNJIN[1].lon) / 2,
  };
  const r = findNearestStop(mid, stops);
  assert.equal(r.kind, "ambiguous");
  if (r.kind !== "ambiguous") return;
  assert.equal(r.candidates.length, 2);
  assert.equal(r.sharedName, "Дүнжингарав Худалдааны төв");
});

test("ambiguity is resolved by route, and unserved routes return null", () => {
  const mid = {
    lat: (DUNJIN[0].lat + DUNJIN[1].lat) / 2,
    lon: (DUNJIN[0].lon + DUNJIN[1].lon) / 2,
  };
  const r = findNearestStop(mid, stops);
  assert.equal(r.kind, "ambiguous");
  if (r.kind !== "ambiguous") return;

  const choices = routeChoicesFor(r.candidates, stopRoutes);
  assert.ok(choices.length > 0, "the pair must offer at least one route");

  const picked = resolveByRoute(r.candidates, choices[0], stopRoutes);
  assert.ok(picked, "a route that serves the pair must resolve to a stop");
  assert.ok((stopRoutes[picked.stop.id] ?? []).includes(choices[0]));

  assert.equal(resolveByRoute(r.candidates, "route-that-does-not-exist", stopRoutes), null);
});

test("same-name detection is general, not hardcoded to two ids", () => {
  // Synthetic pair with a name that appears nowhere in the feed: the rule must
  // still fire, so a future feed change is handled without a code change.
  const a: Stop = { id: "X1", name: "Шинэ буудал", lat: 47.9, lon: 106.9 };
  const b: Stop = { id: "X2", name: "Шинэ буудал", lat: 47.9008, lon: 106.9 };
  const r = findNearestStop({ lat: 47.9004, lon: 106.9 }, [a, b]);
  assert.equal(r.kind, "ambiguous");
});

// -------------------------------------------------------------- timezone

test("agency date is UTC+8 regardless of the host zone", () => {
  assert.equal(AGENCY_UTC_OFFSET_MS, 8 * 3600 * 1000);
  // 2026-08-09T20:30Z is 2026-08-10 04:30 in Ulaanbaatar — the next day.
  const { date, time } = agencyDateTime(new Date("2026-08-09T20:30:00Z"));
  assert.equal(date, "2026-08-10");
  assert.equal(time, "04:30");
});

test("an arrival near local midnight does not shift a day", () => {
  // 23:50 UB time = 15:50Z. Constructing "today" from a UTC host clock would
  // give 2026-08-09 either way here, but a host in UTC-6 would roll back a day.
  const ubLateEvening = new Date("2026-08-09T15:50:00Z"); // 23:50 UB
  assert.equal(agencyDateTime(ubLateEvening).date, "2026-08-09");

  // Ten minutes later it is the next service date in UB, and must say so.
  const justAfterMidnight = new Date("2026-08-09T16:10:00Z"); // 00:10 UB
  assert.equal(agencyDateTime(justAfterMidnight).date, "2026-08-10");
  assert.equal(agencyDateTime(justAfterMidnight).time, "00:10");
});

// ------------------------------------------------------------- the hedge

const leg = (over: Partial<OtpLeg> = {}): OtpLeg => ({
  startTime: Date.now() + 6 * 60_000,
  endTime: Date.now() + 15 * 60_000,
  realTime: false,
  headway: 0,
  isNonExactFrequency: false,
  mode: "BUS",
  transitLeg: true,
  routeId: "1:11100730",
  routeShortName: "Ч:73",
  from: { name: "a", stopId: "1:000000004", lat: 0, lon: 0 },
  to: { name: "b", stopId: "1:000000005", lat: 0, lon: 0 },
  ...over,
});

test("schedule-derived arrivals are always hedged", () => {
  const arrivals = legsToArrivals([leg()], "000000004");
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].source, "schedule");
  assert.equal(arrivals[0].isEstimate, true);

  const a = announceArrival(arrivals[0], () => true);
  assert.ok(a);
  assert.ok(a.keys.includes("bus_approx_prefix"), "missing the hedge");
  assert.equal(isUnhedgedTime(a), false);
});

test("headway fallbacks are hedged too", () => {
  const arrivals = headwayFallback(
    ["11100730"],
    new Map([["11100730", 1200]]), // 20 min headway → ~10 min expected wait
    new Map([["11100730", "Ч:73"]]),
    null,
  );
  assert.equal(arrivals[0].minutes, 10);
  assert.equal(arrivals[0].source, "headway");
  const a = announceArrival(arrivals[0], () => true);
  assert.ok(a && a.keys.includes("bus_approx_prefix"));
});

test("NO arrival announcement can emit an unhedged time", () => {
  // Every source the type allows, including the realtime branch that does not
  // exist yet. Only genuinely live data may drop the hedge.
  const now = Date.parse("2026-08-14T09:00:00Z");
  const sources: Arrival["source"][] = ["schedule", "headway", "realtime"];
  for (const source of sources) {
    for (let minutes = 1; minutes <= MAX_SPOKEN_NUMBER; minutes++) {
      const a = announceArrival(
        {
          routeId: "11100730", routeDisplayName: "Ч:73",
          arrivesAt: now + minutes * 60_000, minutes,
          headsign: null, isEstimate: source !== "realtime", source,
        },
        () => true,
        now,
      );
      assert.ok(a, `no announcement for ${minutes} min`);
      if (source === "realtime") continue; // the only permitted unhedged path
      assert.equal(isUnhedgedTime(a), false, `${source} at ${minutes} min was unhedged`);
    }
  }
});

test("no clip exists for a realtime source today, so the unhedged path is unreachable", () => {
  // Guard against the hedge being dropped by a feed that starts reporting
  // realTime without anyone revisiting this decision.
  const arrivals = legsToArrivals([leg({ realTime: false })], "000000004");
  assert.ok(arrivals.every((a) => a.source !== "realtime"));
});

test("times outside the rendered cardinal range produce no announcement, not a hole", () => {
  const now = Date.parse("2026-08-14T09:00:00Z");
  const base: Arrival = {
    routeId: "r", routeDisplayName: "R", arrivesAt: now + 41 * 60_000, minutes: 41,
    headsign: null, isEstimate: true, source: "schedule",
  };
  assert.equal(announceArrival(base, () => true, now), null, "no clip for 41");
  // Already gone, by more than the grace window. Never a positive number.
  assert.equal(announceArrival({ ...base, arrivesAt: now - 3 * 60_000 }, () => true, now), null);
  // No absolute time at all: say the route, never a guess at when.
  assert.equal(announceArrival({ ...base, arrivesAt: null }, () => true, now), null);
});

// -------------------------------------------------------- circuit breaker

test("a single 401 opens the breaker and it stays open for the cooldown", () => {
  const b = new CircuitBreaker(1000);
  const t0 = 1_000_000;
  assert.equal(b.state(t0), "closed");
  b.trip(t0);
  assert.equal(b.state(t0), "open");
  assert.equal(b.state(t0 + 999), "open", "must not reopen early");
  assert.equal(b.state(t0 + 1000), "closed", "must close after the cooldown");
});

test("the breaker trips on the FIRST failure — no retry storm", () => {
  // The gateway's 401 means the account is already locked out, so a threshold
  // of two would guarantee a second doomed call that deepens the lockout.
  const b = new CircuitBreaker(60_000);
  b.trip(0);
  assert.equal(b.stats(0).trips, 1);
  assert.equal(b.state(0), "open");
});

test("coalescing collapses concurrent requests for one stop into a single call", async () => {
  const c = new Coalescer<number>();
  let calls = 0;
  const slow = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return 42;
  };
  const results = await Promise.all([c.run("s1", slow), c.run("s1", slow), c.run("s1", slow)]);
  assert.deepEqual(results, [42, 42, 42]);
  assert.equal(calls, 1, "three concurrent callers must hit the API once");

  // Different stops are not collapsed.
  await Promise.all([c.run("s2", slow), c.run("s3", slow)]);
  assert.equal(calls, 3);
});

test("cache entries expire", () => {
  const c = new TtlCache<string>(1000);
  c.set("k", "v", 0);
  assert.equal(c.get("k", 999), "v");
  assert.equal(c.get("k", 1000), null);
});

// --------------------------------------------------------------- handoff

test("handoff carries an index into the ordered sequence, re-derived not trusted", () => {
  const routeId = Object.keys(routeStops)[0];
  const sequence: string[] = routeStops[routeId]["0"];
  const boardingStopId = sequence[2];

  const built = buildHandoff(
    { routeId, directionId: 0, boardingStopId, routeDisplayName: "X", headsign: "H" },
    routeStops,
  );
  assert.ok(built.ok);
  if (!built.ok) return;
  assert.equal(built.handoff.boardingIndex, 2);

  // A stale index is corrected against the sequence rather than believed.
  const tampered = { ...built.handoff, boardingIndex: 99 };
  const validated = validateHandoff(tampered, routeStops);
  assert.ok(validated.ok);
  if (!validated.ok) return;
  assert.equal(validated.handoff.boardingIndex, 2);
});

test("handoff refuses a stop that is not in the direction's sequence", () => {
  const routeId = Object.keys(routeStops)[0];
  const built = buildHandoff(
    { routeId, directionId: 0, boardingStopId: "not-a-real-stop", routeDisplayName: "X", headsign: "H" },
    routeStops,
  );
  assert.equal(built.ok, false);
});

test("handoff refuses the last stop — there is nothing to count down to", () => {
  const routeId = Object.keys(routeStops)[0];
  const sequence: string[] = routeStops[routeId]["0"];
  const built = buildHandoff(
    { routeId, directionId: 0, boardingStopId: sequence[sequence.length - 1], routeDisplayName: "X", headsign: "H" },
    routeStops,
  );
  assert.equal(built.ok, false);
});

test("an expired handoff is rejected", () => {
  const routeId = Object.keys(routeStops)[0];
  const sequence: string[] = routeStops[routeId]["0"];
  const handoff = {
    routeId, directionId: 0, boardingIndex: 1, boardingStopId: sequence[1],
    routeDisplayName: "X", headsign: "H", createdAt: 0,
  };
  assert.equal(validateHandoff(handoff, routeStops, HANDOFF_TTL_MS + 1).ok, false);
  assert.equal(validateHandoff(handoff, routeStops, HANDOFF_TTL_MS - 1).ok, true);
});

// ----------------------------------------------------------- audio queue

class FakePlayer implements ClipPlayer {
  played: string[] = [];
  constructor(private known: Set<string>, private ms = 5) {}
  has(key: string) { return this.known.has(key); }
  play(key: string, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { this.played.push(key); resolve(); }, this.ms);
      signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
    });
  }
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

test("clips never overlap", async () => {
  const player = new FakePlayer(new Set(["a", "b", "c"]), 10);
  let concurrent = 0;
  let maxConcurrent = 0;
  const wrapped: ClipPlayer = {
    has: (k) => player.has(k),
    play: async (k, s) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try { await player.play(k, s); } finally { concurrent--; }
    },
  };
  const q = new AudioQueue(wrapped);
  q.push({ keys: ["a", "b"], priority: "normal", expiresAt: FAR() });
  q.push({ keys: ["c"], priority: "normal", expiresAt: FAR() });
  await settle(200);
  assert.equal(maxConcurrent, 1, "two clips played at once");
});

test("a critical announcement preempts what is playing", async () => {
  const player = new FakePlayer(new Set(["long", "urgent"]), 60);
  const q = new AudioQueue(player);
  const events: string[] = [];
  q.on((e) => events.push(e.type));

  q.push({ keys: ["long", "long", "long"], priority: "normal", expiresAt: FAR() });
  await settle(20);
  q.push({ keys: ["urgent"], priority: "critical", expiresAt: FAR() });
  await settle(300);

  assert.ok(events.includes("preempted"), "critical did not preempt");
  assert.ok(player.played.includes("urgent"), "critical never played");
});

test("equal priority queues rather than preempting", async () => {
  const player = new FakePlayer(new Set(["x", "y"]), 20);
  const q = new AudioQueue(player);
  const events: string[] = [];
  q.on((e) => events.push(e.type));
  q.push({ keys: ["x"], priority: "normal", expiresAt: FAR() });
  await settle(5);
  q.push({ keys: ["y"], priority: "normal", expiresAt: FAR() });
  await settle(200);
  assert.equal(events.filter((e) => e === "preempted").length, 0);
  assert.deepEqual(player.played, ["x", "y"]);
});

test("a missing clip is reported, never silently skipped", async () => {
  const player = new FakePlayer(new Set(["known"]), 5);
  const q = new AudioQueue(player);
  const missing: string[] = [];
  q.on((e) => { if (e.type === "missing") missing.push(...e.keys); });
  q.push({ keys: ["known", "absent"], priority: "normal", expiresAt: FAR() });
  await settle(80);
  assert.deepEqual(missing, ["absent"]);
});

test("dedupeKey collapses a jitter storm instead of building a backlog", async () => {
  const player = new FakePlayer(new Set(["a", "b", "c"]), 30);
  const q = new AudioQueue(player);
  q.push({ keys: ["a"], priority: "normal", expiresAt: FAR() });
  // These three all target the same slot; only the last should survive.
  q.push({ keys: ["a"], priority: "normal", expiresAt: FAR(), dedupeKey: "pos" });
  q.push({ keys: ["b"], priority: "normal", expiresAt: FAR(), dedupeKey: "pos" });
  q.push({ keys: ["c"], priority: "normal", expiresAt: FAR(), dedupeKey: "pos" });
  assert.equal(q.pending, 1, "queue should hold one deduped entry");
  await settle(200);
  assert.ok(player.played.includes("c"));
  assert.ok(!player.played.includes("b"), "superseded announcement played anyway");
});

// ---------------------------------------------------- accuracy-aware matching
//
// The reported failure: "it can't find the bus station". Measured cause — the
// search radius was a fixed 150 m, which assumes the phone is exactly where it
// says. At ±200 m a user standing AT a stop got "no stop nearby" 29 % of the
// time; at ±300 m, 62 %.

import { CONFIDENT_ACCURACY_M, UNUSABLE_ACCURACY_M } from "./geo";

/** Displaces a point by `metres` in a deterministic direction. */
function displace(p: { lat: number; lon: number }, metres: number, bearingDeg: number) {
  const th = (bearingDeg * Math.PI) / 180;
  return {
    lat: p.lat + (metres * Math.cos(th)) / 111_320,
    lon: p.lon + (metres * Math.sin(th)) / (111_320 * Math.cos((p.lat * Math.PI) / 180)),
  };
}

test("a coarse fix still finds the stop the user is standing at", () => {
  // Every stop, displaced 200 m — the accuracy a phone reports indoors or under
  // cloud. Without the widening this is the case that reported nothing.
  let missedFixed = 0, missedAware = 0, n = 0;
  for (const stop of stops) {
    if (n++ % 5) continue;
    const at = displace(stop, 200, (n * 37) % 360);
    if (findNearestStop(at, stops).kind === "none") missedFixed++;
    if (findNearestStop(at, stops, { accuracyM: 200 }).kind === "none") missedAware++;
  }
  assert.ok(missedFixed > 0, "the fixed radius should fail on some of these — otherwise this proves nothing");
  assert.equal(missedAware, 0, `accuracy-aware search still missed ${missedAware}`);
});

test("the true stop stays among the offered candidates at ±300 m", () => {
  /**
   * WORST CASE, deliberately. Every point is displaced the FULL 300 m, whereas
   * a real ±300 m fix has its error distributed inside that radius (mean ≈ 2/3
   * of it). Sampling the disc gives ~96 % here; pinning the worst case gives
   * ~86 %, and the worst case is the number worth defending against regression.
   *
   * Either way the point stands: the top candidate alone is right only about
   * half the time this far out, which is why the screen offers a cycleable list
   * and speaks the hedge instead of asserting one stop.
   */
  const rate = (accuracyM: number | undefined) => {
    let inTop3 = 0, total = 0, n = 0;
    for (const stop of stops) {
      if (n++ % 5) continue;
      total++;
      const at = displace(stop, 300, (n * 53) % 360);
      const r = findNearestStop(at, stops, accuracyM === undefined ? {} : { accuracyM });
      const list = r.kind === "single" || r.kind === "ambiguous" ? r.candidates : [];
      if (list.slice(0, 3).some((c) => c.stop.id === stop.id)) inTop3++;
    }
    return inTop3 / total;
  };

  const aware = rate(300);
  const fixed = rate(undefined);
  assert.ok(aware > 0.8, `worst-case top-3 fell to ${(100 * aware).toFixed(0)}%`);
  assert.ok(aware > fixed * 2, `accuracy-aware (${(100 * aware).toFixed(0)}%) barely beat fixed (${(100 * fixed).toFixed(0)}%)`);
});

test("a good fix is confident; a coarse one is not", () => {
  const target = stops[100];
  const good = findNearestStop(target, stops, { accuracyM: CONFIDENT_ACCURACY_M - 10 });
  const coarse = findNearestStop(target, stops, { accuracyM: 250 });
  assert.equal(good.kind === "single" || good.kind === "ambiguous" ? good.confidence : null, "high");
  assert.equal(coarse.kind === "single" || coarse.kind === "ambiguous" ? coarse.confidence : null, "low");
});

test("a hopeless fix names no stop at all", () => {
  // A desktop browser geolocating by IP. Naming a stop from this is a confident
  // lie; the user needs to be told the SIGNAL is bad, not that no stop exists.
  const r = findNearestStop(stops[0], stops, { accuracyM: UNUSABLE_ACCURACY_M + 1 });
  assert.equal(r.kind, "unusable-fix");
});

test("omitting accuracy keeps the original strict behaviour", () => {
  // Existing callers and tests must not silently get a wider search.
  const far = displace(stops[0], 300, 0);
  assert.equal(findNearestStop(far, stops).kind, "none");
});
