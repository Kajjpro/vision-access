/**
 * Route and direction resolution.
 *
 * Direction is the dangerous output here: getting it wrong puts a blind rider
 * on a bus crossing the city away from where they asked to go. The feed's raw
 * value is never trusted directly — these tests pin the mapping in both
 * conventions and pin the refusal to guess in a third.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { stopKey } from "../speech/mnNormalize";
import {
  collectRawDirections,
  inferDirectionMapper,
  matchStops,
  matchStopsAny,
  needsDisambiguation,
  resolveDirectLegs,
  resolveJourney,
  toCanonicalDirection,
  type Route,
  type Stop,
} from "./resolveJourney";

/**
 * Four stops in a line, west to east.
 *
 * Keys go through the real `stopKey`, never a hand-written lowercase — Latin
 * fixture names are rewritten by the homoglyph table (`p` → Cyrillic `р`), so a
 * fixture keyed by `name.toLowerCase()` matches nothing and the test passes or
 * fails for reasons that have nothing to do with what it claims to check.
 */
const stop = (id: string, name: string, lat: number, lon: number): Stop => ({
  id, name, key: stopKey(name), placeKey: `${stopKey(name)}#${id}`, lat, lon,
});

const A = stop("a", "alpha", 47.90, 106.90);
const B = stop("b", "bravo", 47.91, 106.92);
const C = stop("c", "charlie", 47.92, 106.94);
const D = stop("d", "delta", 47.93, 106.96);
const STOPS = [A, B, C, D];

/** Same route in both feed conventions: zero-based, and one-based. */
const zeroBased: Route[] = [{
  id: "r1", name: "Ч:1",
  directions: [
    { rawUpDown: 0, stopIds: ["a", "b", "c", "d"] },
    { rawUpDown: 1, stopIds: ["d", "c", "b", "a"] },
  ],
}];

const oneBased: Route[] = [{
  id: "r1", name: "Ч:1",
  directions: [
    { rawUpDown: 1, stopIds: ["a", "b", "c", "d"] },
    { rawUpDown: 2, stopIds: ["d", "c", "b", "a"] },
  ],
}];

// ------------------------------------------------------------- direction

test("a journey and its reverse get OPPOSITE directions — zero-based feed", () => {
  const there = resolveJourney(A, D, zeroBased);
  const back = resolveJourney(D, A, zeroBased);
  assert.equal(there.kind, "ok");
  assert.equal(back.kind, "ok");
  const t = there.kind === "ok" ? there.legs[0].direction : null;
  const b = back.kind === "ok" ? back.legs[0].direction : null;
  assert.notEqual(t, b, "both directions of the same route resolved the same way");
  assert.equal(t, "outbound");
  assert.equal(b, "inbound");
});

test("a journey and its reverse get OPPOSITE directions — one-based feed", () => {
  const map = inferDirectionMapper(collectRawDirections(oneBased));
  const there = resolveJourney(A, D, oneBased, map);
  const back = resolveJourney(D, A, oneBased, map);
  const t = there.kind === "ok" ? there.legs[0].direction : null;
  const b = back.kind === "ok" ? back.legs[0].direction : null;
  assert.equal(t, "outbound");
  assert.equal(b, "inbound");
});

test("the default mapper THROWS on a 2 rather than guessing", () => {
  // 1 means opposite things in the two feeds. A loud crash in development
  // beats a silent direction flip in a rider's ear.
  assert.equal(toCanonicalDirection(0), "outbound");
  assert.equal(toCanonicalDirection(1), "inbound");
  assert.throws(() => toCanonicalDirection(2), /zero-based/);
});

test("the default mapper's guard is POSITIONAL, not total", () => {
  // Worth pinning because it is the sharp edge of the whole design. The guard
  // only fires when a leg is actually found in the direction carrying the
  // out-of-range value — `resolveDirectLegs` skips a direction that does not
  // contain the pair BEFORE it calls the mapper.
  //
  // So against a 1/2 feed with no mapper passed:
  assert.throws(() => resolveJourney(D, A, oneBased), /zero-based/);   // hits rawUpDown 2 — loud
  const quiet = resolveJourney(A, D, oneBased);                        // hits rawUpDown 1 — silent
  assert.equal(quiet.kind, "ok");
  assert.equal(quiet.kind === "ok" && quiet.legs[0].direction, "inbound");
  // ...and "inbound" is WRONG there: a→d is the outbound leg of that route.
  //
  // This is not a bug in the mapper, it is the reason the integration must call
  // inferDirectionMapper(collectRawDirections(routes)) ONCE at data load and
  // thread it everywhere. Skip that step and half the journeys crash loudly
  // while the other half are quietly mislabelled.
});

test("inferDirectionMapper reads the convention off the whole feed", () => {
  assert.equal(collectRawDirections(zeroBased).join(","), "0,1");
  const zero = inferDirectionMapper([0, 1, 0, 1]);
  assert.equal(zero(0), "outbound");
  assert.equal(zero(1), "inbound");
  const one = inferDirectionMapper([1, 2, 1, 2]);
  assert.equal(one(1), "outbound");
  assert.equal(one(2), "inbound");
});

test("inferDirectionMapper refuses a feed it cannot read", () => {
  assert.throws(() => inferDirectionMapper([0, 1, 2]), /Expected 2/);
  assert.throws(() => inferDirectionMapper([3, 4]), /Cannot infer/);
});

// --------------------------------------------------------------- journeys

test("wrong-direction is reported when only the reverse path exists", () => {
  const oneWay: Route[] = [{
    id: "r2", name: "Ч:2",
    directions: [{ rawUpDown: 0, stopIds: ["d", "c", "b", "a"] }],
  }];
  const result = resolveJourney(A, D, oneWay);
  assert.equal(result.kind, "wrong-direction");
  if (result.kind === "wrong-direction") {
    assert.equal(result.suggestion.boardAt.id, "d");
    assert.equal(result.suggestion.alightAt.id, "a");
  }
});

test("same stop is its own answer, not a routing failure", () => {
  assert.equal(resolveJourney(A, A, zeroBased).kind, "same-stop");
});

test("no connection at all is reported as such", () => {
  const isolated: Route[] = [{
    id: "r3", name: "Ч:3", directions: [{ rawUpDown: 0, stopIds: ["b", "c"] }],
  }];
  assert.equal(resolveJourney(A, D, isolated).kind, "no-direct-route");
});

test("hops counts stops travelled, and the path is in travel order", () => {
  const result = resolveJourney(A, C, zeroBased);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.legs[0].hops, 2);
    assert.deepEqual(result.legs[0].path, ["a", "b", "c"]);
  }
});

test("a loop route takes the SHORTEST valid board/alight pair", () => {
  // A stop appearing twice in one direction is normal on a loop. Taking the
  // first index would send the rider the long way round the city.
  const loop: Route[] = [{
    id: "r4", name: "Ч:4",
    directions: [{ rawUpDown: 0, stopIds: ["a", "b", "c", "a", "d"] }],
  }];
  const result = resolveJourney(A, D, loop);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") assert.equal(result.legs[0].hops, 1);
});

test("legs are ordered by fewest stops", () => {
  const two: Route[] = [
    { id: "slow", name: "S", directions: [{ rawUpDown: 0, stopIds: ["a", "b", "c", "d"] }] },
    { id: "fast", name: "F", directions: [{ rawUpDown: 0, stopIds: ["a", "d"] }] },
  ];
  const legs = resolveDirectLegs(A, D, two);
  assert.equal(legs[0].route.id, "fast");
});

// ---------------------------------------------------------------- matching

test("geo bias applies to the origin — the rider is standing there", () => {
  // REGRESSION: the Stop interface said `lng` while all data in this repo uses
  // `lon`, so the proximity branch was guarded on an always-undefined field and
  // never ran. It compiled, and silently did nothing.
  const far = stop("far", "alpha", 47.10, 106.10);
  const candidates = [far, A];
  const near = matchStops("alpha", candidates, { near: [47.90, 106.90], limit: 2 });
  assert.equal(near[0].stop.id, "a", "proximity did not break the tie — is the field name right?");
});

test("an exact key match beats every approximate one outright", () => {
  const thirteen = stop("13", "13 р хороолол", 47.9, 106.9);
  const three = stop("3", "гуравдугаар хороолол", 47.9, 106.9);
  const matches = matchStops("гуравдугаар хороолол", [thirteen, three]);
  assert.equal(matches[0].stop.id, "3");
  assert.equal(matches.length, 1, "an exact match must not be offered alongside near-twins");
});

test("nothing recognizable returns nothing rather than a guess", () => {
  assert.deepEqual(matchStops("zzzzqqqq", STOPS), []);
  assert.deepEqual(matchStops("", STOPS), []);
});

test("needsDisambiguation needs two candidates to be ambiguous about", () => {
  assert.equal(needsDisambiguation([]), false);
  assert.equal(needsDisambiguation(matchStops("alpha", [A])), false);
});

// ------------------------------------------- searching every alternative

/**
 * Real Mongolian stop names, because the whole point of reading past the first
 * alternative is what the recogniser does to a proper noun it has never seen —
 * and that behaviour lives in `stopKey`/`similarity`, not in Latin fixtures.
 */
const SANSAR = stop("s1", "Сансар", 47.92, 106.94);
const ZAISAN = stop("s2", "Зайсан", 47.87, 106.91);
const DELGUUR = stop("s3", "Их дэлгүүр", 47.91, 106.90);
const MN_STOPS = [SANSAR, ZAISAN, DELGUUR];

test("REGRESSION: the real name is found when it is not the top transcript", () => {
  // Azure's actual failure mode on a stop name: the best-ranked transcript is a
  // homophone split across two words that matches nothing, while the name
  // itself sits at rank 2. Reading only the first ended the journey here.
  assert.deepEqual(matchStops("сан сар", MN_STOPS, { limit: 1 }), []);

  const found = matchStopsAny(["сан сар", "Сансар"], MN_STOPS, { limit: 1 });
  assert.equal(found[0]?.stop.id, "s1");
});

test("the recogniser's own order still wins a tie — it is weak evidence, not none", () => {
  const both = matchStopsAny(["Зайсан", "Сансар"], MN_STOPS, { limit: 2 });
  assert.equal(both[0].stop.id, "s2", "rank 0 pays no penalty, so it stays ahead");
});

test("a lower alternative must win by a real margin, not a rounding error", () => {
  // Both are exact, so the only thing separating them is ALTERNATIVE_PENALTY.
  const ranked = matchStopsAny(["Сансар", "Зайсан"], MN_STOPS, { limit: 2 });
  assert.equal(ranked[0].stop.id, "s1");
  assert.ok(
    ranked[0].score - ranked[1].score > 0,
    "the penalty has to actually apply, or rank is meaningless",
  );
});

test("searching six transcripts does not give noise six chances to clear the bar", () => {
  // The safety property. A false match puts a blind passenger on a bus to the
  // wrong district, so widening the search must never lower the threshold.
  const noise = ["ттт", "яяя", "жжж", "ххх", "ццц", "ббб"];
  assert.deepEqual(matchStopsAny(noise, MN_STOPS), []);
});

test("one alternative behaves exactly like the single-transcript matcher", () => {
  const one = matchStopsAny(["Их дэлгүүр"], MN_STOPS, { limit: 3 });
  const direct = matchStops("Их дэлгүүр", MN_STOPS, { limit: 3 });
  assert.deepEqual(one.map((m) => m.stop.id), direct.map((m) => m.stop.id));
});

test("no transcripts at all is empty, never a guess", () => {
  assert.deepEqual(matchStopsAny([], MN_STOPS), []);
  assert.deepEqual(matchStopsAny([""], MN_STOPS), []);
});

test("proximity still separates two stops that share a name", () => {
  // The geo bias has to survive the rewrite: it is the signal that tells apart
  // the three "1-р байр" that sit 10 km from each other.
  const near = stop("n1", "1-р байр", 47.90, 106.90);
  const far = stop("n2", "1-р байр", 47.99, 106.99);
  const found = matchStopsAny(["1-р байр"], [near, far], { near: [47.90, 106.90], limit: 2 });
  assert.equal(found[0].stop.id, "n1");
});
