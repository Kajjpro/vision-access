/**
 * The pipeline-to-resolver seam, against the real shipped files.
 *
 * This is the join that the incoming design assumed away: it expects one
 * `Route` carrying its own ordered stop lists and a raw `up_down`, and this
 * repo ships names in one file, stop order in another, and no `up_down` at all.
 * A fixture here would test the assumption rather than the data.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Route as PipelineRoute, RouteStops } from "@/lib/transit/types";

import { toDirectionMapper, toSpeechRoutes, toSpeechStops, toSpeechTransitData,
  type KeyedPipelineStop } from "./adapt";
import { resolveJourney } from "./resolveJourney";

const read = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

const rawStops = read<KeyedPipelineStop[]>("public/transit/stops.json");
const rawRoutes = read<PipelineRoute[]>("public/transit/routes.json");
const rawRouteStops = read<RouteStops>("public/transit/route-stops.json");

test("every shipped stop survives adaptation with a key and a position", () => {
  const stops = toSpeechStops(rawStops);
  assert.equal(stops.length, 923);
  for (const s of stops) {
    assert.ok(s.key, `${s.id} lost its key`);
    assert.ok(s.placeKey, `${s.id} lost its placeKey`);
    // `lon`, not `lng` — the field the geo bias is guarded on.
    assert.equal(typeof s.lon, "number", `${s.id} has no lon`);
    assert.equal(typeof s.lat, "number", `${s.id} has no lat`);
  }
});

test("unkeyed data is refused loudly rather than matched against undefined", () => {
  assert.throws(
    () => toSpeechStops([{ id: "x", name: "Сансар", lat: 47.9, lon: 106.9 }]),
    /build-stop-keys/,
  );
});

test("routes are joined to their ordered stop lists", () => {
  const routes = toSpeechRoutes(rawRoutes, rawRouteStops);
  assert.equal(routes.length, 84);
  for (const r of routes) {
    assert.ok(r.directions.length >= 1, `${r.id} has no directions`);
    for (const d of r.directions) {
      assert.ok(d.stopIds.length > 1, `${r.id} direction ${d.rawUpDown} has no stop order`);
    }
  }
});

test("direction keys are zero-based, so the default mapper is safe on this data", () => {
  // The brief describes a feed that might be 1/2. This one is not: the gateway
  // ignores `up_down` entirely and the pipeline takes OTP's `directionId`.
  const routes = toSpeechRoutes(rawRoutes, rawRouteStops);
  const raw = new Set(routes.flatMap((r) => r.directions.map((d) => d.rawUpDown)));
  assert.deepEqual([...raw].sort(), [0, 1]);
  const map = toDirectionMapper(routes);
  assert.equal(map(0), "outbound");
  assert.equal(map(1), "inbound");
});

test("direction 0 comes first regardless of JSON key order", () => {
  const routes = toSpeechRoutes(rawRoutes, rawRouteStops);
  for (const r of routes) {
    const raws = r.directions.map((d) => d.rawUpDown);
    assert.deepEqual(raws, [...raws].sort((a, b) => a - b), `${r.id} directions out of order`);
  }
});

test("a real journey resolves in opposite directions each way", () => {
  const { stops, routes, mapDirection } = toSpeechTransitData(rawStops, rawRoutes, rawRouteStops);
  const byId = new Map(stops.map((s) => [s.id, s]));

  // Pick a route with both directions and take its endpoints, so the pair is
  // guaranteed connected without assuming any particular stop still exists.
  const route = routes.find((r) => r.directions.length === 2 && r.directions[0].stopIds.length > 3);
  assert.ok(route, "expected at least one two-direction route");
  const forward = route.directions[0].stopIds;
  const a = byId.get(forward[0]);
  const b = byId.get(forward[forward.length - 1]);
  assert.ok(a && b, "route endpoints missing from stops.json");

  const there = resolveJourney(a, b, routes, mapDirection);
  const back = resolveJourney(b, a, routes, mapDirection);
  assert.equal(there.kind, "ok");
  assert.equal(back.kind, "ok");
  if (there.kind === "ok" && back.kind === "ok") {
    assert.notEqual(there.legs[0].direction, back.legs[0].direction);
  }
});

test("spokenName is carried through — display text is never spoken", () => {
  const routes = toSpeechRoutes(rawRoutes, rawRouteStops);
  const missing = routes.filter((r) => !r.spokenName);
  assert.equal(missing.length, 0, `routes with no spokenName: ${missing.map((r) => r.id).join(", ")}`);
  const sample = routes.find((r) => r.id === "10000200");
  assert.equal(sample?.name, "Д:2");
  assert.equal(sample?.spokenName, "дэ хоёр");
});
