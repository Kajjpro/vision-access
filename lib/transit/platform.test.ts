/**
 * Platform sides, against the real shipped names.
 *
 * The measurements this module is built on are asserted here rather than left in
 * a commit message, because they are the reason the design is "derive and name"
 * instead of "sense": 88% of opposite-side pairs sit inside the GPS match
 * radius, and the platform-to-platform line is nearly parallel to the road, so
 * neither position nor geometry can choose between them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  SIDES, boardingRelation, needsPlatformCallout, oppositeSide, platformCalloutKeys,
  sameStation, splitPlatform,
} from "./platform";
import { haversine } from "./geo";
import type { Stop } from "./types";

const stops: Stop[] = JSON.parse(readFileSync("public/transit/stops.json", "utf8"));
const stop = (id: string, name: string): Stop => ({ id, name, lat: 47.918, lon: 106.917 });

test("the side is parsed out of the real name format", () => {
  assert.deepEqual(splitPlatform("Сансар /Хойд/"), { base: "Сансар", side: "Хойд" });
  assert.deepEqual(splitPlatform("Саппоро /Урд/"), { base: "Саппоро", side: "Урд" });
  assert.deepEqual(splitPlatform("1-р байр /Баруун/"), { base: "1-р байр", side: "Баруун" });
});

test("an interior slash is not a platform marker", () => {
  // `Монгол цах/утас компани` is one stop with a slash in its name. Reading that
  // as a side would invent a second platform for a stop that has one.
  const s = splitPlatform("Монгол цах/утас компани");
  assert.equal(s.side, null);
  assert.equal(s.base, "Монгол цах/утас компани");
});

test("a trailing bracket that is not a side word is left alone", () => {
  // Three real stops end in `/Чингэлтэйн эцэс/`, `/зуслан/`, `/Дунд/`.
  assert.equal(splitPlatform("Хайлааст /Чингэлтэйн эцэс/").side, null);
  assert.equal(splitPlatform("Ямар нэг /Дунд/").side, null);
});

test("the two axes never mix", () => {
  assert.equal(oppositeSide("Хойд"), "Урд");
  assert.equal(oppositeSide("Урд"), "Хойд");
  assert.equal(oppositeSide("Баруун"), "Зүүн");
  assert.equal(oppositeSide("Зүүн"), "Баруун");
  // North is not the opposite of west, and a bug that made it so would send a
  // rider to a platform on a different road.
  for (const s of SIDES) assert.equal(oppositeSide(oppositeSide(s)), s);
});

test("most of the shipped data actually carries a side", () => {
  // The whole design rests on this: if the names did not carry the side, there
  // would be nothing to tell the rider.
  const withSide = stops.filter((s) => splitPlatform(s.name).side !== null);
  assert.ok(
    withSide.length > stops.length * 0.9,
    `only ${withSide.length} of ${stops.length} stops carry a side word`,
  );
});

test("opposite platforms are too close for GPS to choose between", () => {
  // MEASURED, and the reason nothing in this app senses the side. Any position
  // -derived answer would be a coin flip presented as a measurement.
  const byBase = new Map<string, Stop[]>();
  for (const s of stops) {
    const { base, side } = splitPlatform(s.name);
    if (!side) continue;
    const k = base.toLowerCase().replace(/[\s\-.,]+/g, "");
    byBase.set(k, [...(byBase.get(k) ?? []), s]);
  }

  const separations: number[] = [];
  for (const group of byBase.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let k = i + 1; k < group.length; k++) {
        if (boardingRelation(group[i], group[k]) !== "opposite_side") continue;
        const d = haversine(group[i], group[k]);
        if (d <= 400) separations.push(d);
      }
    }
  }

  assert.ok(separations.length > 300, `expected the pair set to be large, got ${separations.length}`);
  const inside = separations.filter((d) => d < 150).length;
  assert.ok(
    inside / separations.length > 0.8,
    `${inside}/${separations.length} inside the match radius — if this ever drops, sensing the side becomes worth revisiting`,
  );
});

test("standing at the right platform says nothing about platforms", () => {
  const here = stop("000000001", "Сансар /Хойд/");
  assert.equal(boardingRelation(here, here), "same_platform");
  assert.equal(needsPlatformCallout("same_platform"), false);
  assert.deepEqual(platformCalloutKeys(here, "same_platform", () => true), []);
});

test("the facing platform is called out — the case a rider most often gets wrong", () => {
  const here = stop("000000001", "Сансар /Хойд/");
  const there = stop("000000002", "Сансар /Урд/");
  assert.equal(boardingRelation(here, there), "opposite_side");
  assert.ok(needsPlatformCallout("opposite_side"));
  assert.deepEqual(platformCalloutKeys(there, "opposite_side", () => true), ["stop_000000002"]);
});

test("a different station is not a platform question", () => {
  const here = stop("000000001", "Сансар /Хойд/");
  const there = stop("000000009", "Саппоро /Урд/");
  assert.equal(boardingRelation(here, there), "different_station");
});

test("a third side at one station is neither of the simple cases", () => {
  // Junctions exist. `same_station_other` keeps them out of the opposite-side
  // wording, which would be wrong, without pretending they are somewhere else.
  const here = stop("000000001", "Наран /Хойд/");
  const there = stop("000000003", "Наран /Баруун/");
  assert.equal(boardingRelation(here, there), "same_station_other");
  assert.ok(needsPlatformCallout("same_station_other"));
});

test("station identity ignores side, spacing and case", () => {
  assert.ok(sameStation("Сансар /Хойд/", "сансар /Урд/"));
  assert.ok(sameStation("1-р байр /Урд/", "1-р байр /Хойд/"));
  assert.equal(sameStation("Сансар /Хойд/", "Саппоро /Хойд/"), false);
});

test("an unrendered stop name is dropped rather than half-spoken", () => {
  // 770 of 923 names have no clip. A bare prefix with a hole where the name
  // should be sounds like a name that WAS said and was misheard.
  const there = stop("000000777", "Сансар /Урд/");
  assert.deepEqual(platformCalloutKeys(there, "opposite_side", () => false), []);
});

test("a missing stop is treated as a different station, never as the same one", () => {
  // Fails toward telling the rider more, not less.
  assert.equal(boardingRelation(null, stop("1", "Сансар /Хойд/")), "different_station");
  assert.equal(boardingRelation(stop("1", "Сансар /Хойд/"), null), "different_station");
});
