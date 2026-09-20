/**
 * The projection, against real route geometry.
 *
 * The property under test is not "is the scalar exactly right" — with chords
 * instead of shapes it cannot be — but the two things the countdown rests on:
 * the scalar increases monotonically as a bus drives the route, and it re-syncs
 * exactly at every stop, where the chord and the road touch by construction.
 *
 * Also asserted: the thing the geometry may NOT be used for. `offRouteM` is
 * diagnostics only, and there is a test here proving why — a bus tracking its
 * lane perfectly around a real UB bend reads as far off-route, which is what
 * would make a perpendicular-distance wrong-bus alert fire at every turn.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { haversineM, StopChainGeometry, type GeometryStop } from "./geometry";
import type { RouteStops, Stop } from "../transit/types";

const stops: Stop[] = JSON.parse(readFileSync("public/transit/stops.json", "utf8"));
const routeStops: RouteStops = JSON.parse(readFileSync("public/transit/route-stops.json", "utf8"));
const byId = new Map(stops.map((s) => [s.id, s]));

/** Every variant in the feed, as ordered stop chains. */
function allVariants(): { key: string; chain: GeometryStop[] }[] {
  const out: { key: string; chain: GeometryStop[] }[] = [];
  for (const [routeId, dirs] of Object.entries(routeStops)) {
    for (const [dirId, ids] of Object.entries(dirs)) {
      const chain = ids
        .map((id) => byId.get(id))
        .filter((s): s is Stop => Boolean(s))
        .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));
      if (chain.length >= 2) out.push({ key: `${routeId}/${dirId}`, chain });
    }
  }
  return out;
}

const VARIANTS = allVariants();

test("the feed really does have variants to project onto", () => {
  assert.ok(VARIANTS.length > 100, `only ${VARIANTS.length} variants found`);
});

test("a fix exactly on a stop projects to that stop's own distance", () => {
  // The re-sync property: whatever the chords do between stops, they meet the
  // route at every stop, so error cannot accumulate across a journey.
  for (const { key, chain } of VARIANTS.slice(0, 40)) {
    const g = new StopChainGeometry(chain);
    for (let i = 0; i < chain.length; i++) {
      const p = g.project(chain[i]);
      assert.ok(
        Math.abs(p.alongM - g.distanceToStop(i)) < 1,
        `${key} stop ${i}: projected ${p.alongM.toFixed(1)} m, expected ${g.distanceToStop(i).toFixed(1)} m`,
      );
      assert.equal(p.stopIndex, i, `${key} stop ${i} derived index ${p.stopIndex}`);
      assert.ok(p.offRouteM < 1, `${key} stop ${i} is ${p.offRouteM.toFixed(1)} m off its own route`);
    }
  }
});

test("driving the route makes the scalar increase, never jump backwards", () => {
  // Sampled along every chord, which is the ideal case — noise is the engine's
  // problem, not the geometry's. If the scalar is not monotonic on a clean
  // trace, no amount of hysteresis above it will help.
  for (const { key, chain } of VARIANTS.slice(0, 60)) {
    const g = new StopChainGeometry(chain);
    let previous = -1;
    for (let i = 0; i < chain.length - 1; i++) {
      for (const t of [0, 0.25, 0.5, 0.75]) {
        const at = {
          lat: chain[i].lat + (chain[i + 1].lat - chain[i].lat) * t,
          lon: chain[i].lon + (chain[i + 1].lon - chain[i].lon) * t,
        };
        const { alongM } = g.project(at);
        assert.ok(alongM >= previous - 1, `${key}: scalar went backwards ${previous} → ${alongM}`);
        previous = alongM;
      }
    }
  }
});

test("stopIndex is the last stop REACHED, not the nearest one", () => {
  // The distinction the whole module exists for. Just past stop 3 the nearest
  // stop may well be stop 4; the index must still read 3, because the bus has
  // not arrived there yet and a countdown that says otherwise is a stop early.
  const { chain } = VARIANTS[0];
  const g = new StopChainGeometry(chain);
  const justPast = g.distanceToStop(3) + 5;
  const gap = g.distanceToStop(4) - g.distanceToStop(3);
  const t = 5 / gap;
  const at = {
    lat: chain[3].lat + (chain[4].lat - chain[3].lat) * t,
    lon: chain[3].lon + (chain[4].lon - chain[3].lon) * t,
  };
  const p = g.project(at);
  assert.equal(p.stopIndex, 3);
  assert.ok(Math.abs(p.alongM - justPast) < 2);
});

test("toNextStopM counts down to the next stop and hits zero at the terminus", () => {
  const { chain } = VARIANTS[0];
  const g = new StopChainGeometry(chain);
  const atStop2 = g.project(chain[2]);
  const expected = g.distanceToStop(3) - g.distanceToStop(2);
  assert.ok(Math.abs(atStop2.toNextStopM - expected) < 1);

  const terminus = g.project(chain[chain.length - 1]);
  assert.equal(terminus.toNextStopM, 0);
});

test("mean stop spacing is per-variant, not a city-wide constant", () => {
  // Dead reckoning uses this rate. Suburban spacing is several times the
  // downtown figure, and using one number for both is how a bus in an underpass
  // gets reckoned three stops past where it actually is.
  const spacings = VARIANTS.slice(0, 80).map(({ chain }) => new StopChainGeometry(chain).meanStopSpacingM);
  const min = Math.min(...spacings);
  const max = Math.max(...spacings);
  assert.ok(min > 50, `implausible minimum spacing ${min.toFixed(0)} m`);
  assert.ok(max / min > 1.5, `spacing barely varies (${min.toFixed(0)}–${max.toFixed(0)} m) — check the data`);
});

/**
 * WHY §6.1 IS TOPOLOGICAL AND NOT A DISTANCE.
 *
 * The spec originally called for a >150 m perpendicular-divergence alert. On
 * chord geometry that fires on correct buses: a chord across a bend sits well
 * inside the road, so a bus following its lane is "off route" by the sagitta of
 * the curve. This measures the real worst case in the shipped data.
 */
test("REGRESSION: chord offset alone would fire a wrong-bus alert on a correct bus", () => {
  let worst = 0;
  let where = "";
  let bends = 0;

  /**
   * A bend, not a loop.
   *
   * The stand-in for "how far the real road departs from our chord" is the
   * perpendicular offset of stop i+1 from the chord i→i+2. On a LOOP variant
   * that triple can straddle the whole circuit — 74 km on 11100740 — which
   * measures the route's shape, not the approximation's error. Both legs are
   * therefore capped at ordinary urban stop spacing.
   */
  const MAX_LEG_M = 800;

  for (const { key, chain } of VARIANTS) {
    for (let i = 0; i + 2 < chain.length; i++) {
      const legA = haversineM(chain[i], chain[i + 1]);
      const legB = haversineM(chain[i + 1], chain[i + 2]);
      if (legA > MAX_LEG_M || legB > MAX_LEG_M) continue;
      bends++;
      const off = new StopChainGeometry([chain[i], chain[i + 2]]).project(chain[i + 1]).offRouteM;
      if (off > worst) { worst = off; where = `${key} @${i}`; }
    }
  }

  assert.ok(bends > 1_000, `only ${bends} ordinary bends sampled — check the filter`);
  assert.ok(
    worst > 150,
    `worst chord offset over ${bends} bends was only ${worst.toFixed(0)} m. If this is ever ` +
    `genuinely under 150 m the perpendicular test could be reconsidered — but verify against ` +
    `real shapes first, because chords understate the true arc.`,
  );
  // The number itself is the argument for the topological test in CLAUDE.md, so
  // it is printed rather than merely asserted.
  console.log(`      worst chord offset: ${worst.toFixed(0)} m at ${where} (${bends} bends sampled)`);
});

test("haversine agrees with the cumulative table it builds", () => {
  const { chain } = VARIANTS[0];
  const g = new StopChainGeometry(chain);
  let sum = 0;
  for (let i = 1; i < chain.length; i++) {
    sum += haversineM(chain[i - 1], chain[i]);
    assert.ok(Math.abs(g.distanceToStop(i) - sum) < 0.5);
  }
});

test("a single-stop variant does not throw", () => {
  // Degenerate but real: a variant can be truncated by a data rebuild, and the
  // countdown must degrade rather than crash on a screen with no console.
  const g = new StopChainGeometry([{ id: "a", name: "A", lat: 47.92, lon: 106.92 }]);
  const p = g.project({ lat: 47.93, lon: 106.93 });
  assert.equal(p.stopIndex, 0);
  assert.equal(p.alongM, 0);
  assert.equal(g.meanStopSpacingM, 0);
});

test("an empty variant is rejected loudly rather than projecting nonsense", () => {
  assert.throws(() => new StopChainGeometry([]), /no stops/);
});
