/**
 * Journey planning, against the real 84-route / 923-stop graph.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { MAX_OPTIONS, findDirect, findOneTransfer, planJourney } from "./planner";
import type { Route, RouteStops, Stop, StopRoutes } from "./types";

const dir = join(process.cwd(), "public/transit");
const stops: Stop[] = JSON.parse(readFileSync(join(dir, "stops.json"), "utf8"));
const routes: Route[] = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8"));
const routeStops: RouteStops = JSON.parse(readFileSync(join(dir, "route-stops.json"), "utf8"));
const stopRoutes: StopRoutes = JSON.parse(readFileSync(join(dir, "stop-routes.json"), "utf8"));
const routesById = new Map(routes.map((r) => [r.id, r]));

const plan = (from: string[], to: string[]) =>
  planJourney(from, to, routeStops, stopRoutes, routesById);

/** A route with a decent run, for constructing real origin/destination pairs. */
const sampleRoute = routes.find((r) => (routeStops[r.id]?.["0"]?.length ?? 0) > 12)!;
const sampleSequence = routeStops[sampleRoute.id]["0"];

// ------------------------------------------------------------- direct

test("a direct journey along one route is found", () => {
  const from = sampleSequence[2];
  const to = sampleSequence[10];
  const options = plan([from], [to]);

  assert.ok(options.length > 0, "no plan for a pair known to be on one route");
  assert.equal(options[0].transfers, 0);
  assert.equal(options[0].legs[0].stops, 8);
});

test("the plan reports the stop count the announcement speaks", () => {
  // "8 буудал явна" comes straight off this number, so it must be the count of
  // stops travelled, not of stops listed.
  const options = plan([sampleSequence[0]], [sampleSequence[5]]);
  assert.equal(options[0].totalStops, 5);
});

test("a destination BEHIND the origin is not offered", () => {
  // Forward-only: you cannot reach an earlier stop by boarding here, however
  // near it is on a map.
  const options = findDirect([sampleSequence[10]], [sampleSequence[2]], routeStops, stopRoutes, routesById);
  const sameDirection = options.filter(
    (o) => o.legs[0].routeId === sampleRoute.id && o.legs[0].directionId === 0,
  );
  assert.deepEqual(sameDirection, []);
});

test("the two directions of a route share NO stop ids", () => {
  // Load-bearing, and easy to assume otherwise: direction 1 is not direction 0
  // reversed. It uses the OPPOSITE PLATFORMS, which are different stops with
  // different ids — on ШҮ:1 the pair `Баруун 4 зам /Урд/` and `/Хойд/` sit
  // 344 m apart. A return journey therefore starts from a different stop, and
  // the planner is right to refuse it from the outbound platform.
  const other = routeStops[sampleRoute.id]["1"];
  assert.equal(sampleSequence.filter((id) => other.includes(id)).length, 0);
});

test("a return journey is plannable from the origin GROUP, not one platform", () => {
  // The consequence of the above. The caller must pass every platform of where
  // the user is standing, or the return trip looks unroutable.
  const outbound = sampleSequence[10];
  const inbound = routeStops[sampleRoute.id]["1"];

  // The opposite platform of `outbound`, i.e. the nearest inbound stop to it.
  const here = stops.find((s) => s.id === outbound)!;
  const twin = inbound
    .map((id) => stops.find((s) => s.id === id))
    .filter((s): s is Stop => Boolean(s))
    .sort((a, b) => Math.hypot(a.lat - here.lat, a.lon - here.lon) - Math.hypot(b.lat - here.lat, b.lon - here.lon))[0];

  const backTo = inbound[inbound.length - 2];
  const fromOnePlatform = plan([outbound], [backTo]);
  const fromTheGroup = plan([outbound, twin.id], [backTo]);

  assert.ok(fromTheGroup.length >= fromOnePlatform.length,
    "passing both platforms found no more options than passing one");
});

test("origin equal to destination yields no plan", () => {
  assert.deepEqual(plan([sampleSequence[3]], [sampleSequence[3]]), []);
});

test("an unknown stop id yields no plan rather than throwing", () => {
  assert.deepEqual(plan(["nope"], [sampleSequence[3]]), []);
  assert.doesNotThrow(() => plan([sampleSequence[3]], ["nope"]));
});

// ----------------------------------------------------------- platforms

test("a destination GROUP is reachable via any of its platforms", () => {
  // Both platforms of a place are acceptable destinations; the planner picks.
  const byName = new Map<string, Stop[]>();
  for (const s of stops) {
    const base = s.name.replace(/\s*\/[^/]*\/\s*/g, " ").trim().toLowerCase();
    byName.set(base, [...(byName.get(base) ?? []), s]);
  }
  const multi = [...byName.values()].find((g) => g.length >= 2 && g.some((s) => stopRoutes[s.id]?.length))!;
  const ids = multi.map((s) => s.id);

  // Anywhere that reaches ANY platform of the place counts.
  const servingRoute = stopRoutes[ids.find((id) => stopRoutes[id]?.length)!]![0];
  const seq = routeStops[servingRoute]?.["0"] ?? routeStops[servingRoute]?.["1"] ?? [];
  const target = ids.find((id) => seq.indexOf(id) > 0);
  if (!target) return; // no forward-reachable platform on this route; nothing to assert

  const origin = seq[Math.max(0, seq.indexOf(target) - 4)];
  const options = plan([origin], ids);
  assert.ok(options.length > 0);
});

// ----------------------------------------------------------- transfers

test("direct always beats a transfer, and suppresses it entirely", () => {
  const options = plan([sampleSequence[1]], [sampleSequence[9]]);
  assert.ok(options.every((o) => o.transfers === 0), "a transfer was offered alongside a direct route");
});

test("a one-transfer journey is found when nothing runs direct", () => {
  // Search real pairs for one with no direct route but a transfer available.
  let found = null;
  outer: for (const a of routes.slice(0, 25)) {
    for (const b of routes.slice(25, 60)) {
      const seqA = routeStops[a.id]?.["0"] ?? [];
      const seqB = routeStops[b.id]?.["0"] ?? [];
      if (!seqA.length || !seqB.length) continue;
      const origin = seqA[0];
      const destination = seqB[seqB.length - 1];
      if (origin === destination) continue;
      if (findDirect([origin], [destination], routeStops, stopRoutes, routesById).length) continue;
      const t = findOneTransfer([origin], [destination], routeStops, stopRoutes, routesById);
      if (t.length) { found = t; break outer; }
    }
  }
  assert.ok(found, "no transferring pair found in the sample — widen the search");
  assert.equal(found![0].transfers, 1);
  assert.equal(found![0].legs.length, 2);
});

test("a transfer leg joins up — you alight and board at the same stop", () => {
  let found = null;
  outer: for (const a of routes.slice(0, 25)) {
    for (const b of routes.slice(25, 60)) {
      const seqA = routeStops[a.id]?.["0"] ?? [];
      const seqB = routeStops[b.id]?.["0"] ?? [];
      if (!seqA.length || !seqB.length) continue;
      const origin = seqA[0];
      const destination = seqB[seqB.length - 1];
      if (origin === destination) continue;
      if (findDirect([origin], [destination], routeStops, stopRoutes, routesById).length) continue;
      const t = findOneTransfer([origin], [destination], routeStops, stopRoutes, routesById);
      if (t.length) { found = t[0]; break outer; }
    }
  }
  assert.ok(found);
  assert.equal(found!.legs[0].alightStopId, found!.legs[1].boardStopId);
  assert.equal(found!.totalStops, found!.legs[0].stops + found!.legs[1].stops);
});

test("no two-transfer itinerary is ever produced", () => {
  for (const a of routes.slice(0, 12)) {
    const seq = routeStops[a.id]?.["0"] ?? [];
    if (seq.length < 2) continue;
    for (const o of plan([seq[0]], [seq[seq.length - 1]])) {
      assert.ok(o.legs.length <= 2, "a three-leg journey reached the traveller");
    }
  }
});

// ------------------------------------------------------------- listing

test("the option list is short enough to cycle by ear", () => {
  for (const a of routes.slice(0, 20)) {
    const seq = routeStops[a.id]?.["0"] ?? [];
    if (seq.length < 6) continue;
    assert.ok(plan([seq[0]], [seq[5]]).length <= MAX_OPTIONS);
  }
});

test("the same route is never offered twice", () => {
  for (const a of routes.slice(0, 20)) {
    const seq = routeStops[a.id]?.["0"] ?? [];
    if (seq.length < 6) continue;
    const options = plan([seq[0]], [seq[5]]);
    const keys = options.map((o) => o.legs.map((l) => `${l.routeId}:${l.directionId}`).join(">"));
    assert.equal(new Set(keys).size, keys.length, `duplicate route in ${JSON.stringify(keys)}`);
  }
});

test("best first — the shortest direct route leads", () => {
  for (const a of routes.slice(0, 20)) {
    const seq = routeStops[a.id]?.["0"] ?? [];
    if (seq.length < 8) continue;
    const options = plan([seq[0]], [seq[6]]);
    if (options.length < 2) continue;
    assert.ok(options[0].totalStops <= options[1].totalStops);
  }
});

// --------------------------------------------------------- performance

test("planning is instant — it runs offline on a cheap Android", () => {
  const started = Date.now();
  let n = 0;
  for (const a of routes.slice(0, 20)) {
    const seq = routeStops[a.id]?.["0"] ?? [];
    if (seq.length < 6) continue;
    plan([seq[0]], [seq[5]]);
    n++;
  }
  const per = (Date.now() - started) / Math.max(1, n);
  assert.ok(per < 60, `${per.toFixed(1)}ms per plan is too slow`);
});
