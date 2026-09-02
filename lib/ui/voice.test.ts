/**
 * Destination matching from speech.
 *
 * The recognition half needs a microphone and a network and cannot be tested
 * here. The MATCHING half is pure, and it is the half that decides whether
 * someone gets off at the right stop — so it is tested against the real 923
 * stop names and against the ways recognition actually mangles Mongolian.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { matchStops, normalizeForMatch } from "./voice";

const stops: { id: string; name: string }[] = JSON.parse(
  readFileSync("public/transit/stops.json", "utf8"),
);

test("nobody says the platform suffix aloud, so it is stripped before matching", () => {
  assert.equal(normalizeForMatch("Сансар /Хойд/"), "сансар");
  assert.equal(normalizeForMatch("Монгол Улсын Их Сургууль /Хойд/"), "монгол улсын их сургууль");
  assert.equal(normalizeForMatch("Салхит завсар-1 /Зүүн/"), "салхит завсар 1");
});

test("saying a stop name plainly finds it", () => {
  const matches = matchStops("Сансар", stops);
  assert.ok(matches.length > 0, "Сансар must match something");
  assert.match(matches[0].name, /Сансар/);
});

test("case endings recognition gets wrong still match", () => {
  // Mongolian is agglutinative and ASR routinely returns an inflected form.
  for (const said of ["Сансарт", "Сансараас", "сансар"]) {
    const matches = matchStops(said, stops);
    assert.ok(matches.length > 0, `${said} found nothing`);
    assert.match(matches[0].name, /Сансар/, `${said} matched ${matches[0].name}`);
  }
});

test("a multi-word name matches without the direction marker", () => {
  const matches = matchStops("Монгол Улсын Их Сургууль", stops);
  assert.ok(matches.length > 0);
  assert.match(matches[0].name, /Монгол Улсын Их Сургууль/);
});

test("all platforms of a stop are offered, not silently collapsed", () => {
  // Сансар exists on more than one side of the road; the user picks which,
  // because we cannot know their direction from the name alone.
  const matches = matchStops("Сансар", stops, { limit: 10 });
  const distinct = new Set(matches.map((m) => m.name));
  assert.ok(distinct.size >= 2, `expected several platforms, got ${[...distinct].join(", ")}`);
});

test("nonsense matches nothing rather than guessing", () => {
  // The dangerous failure: confidently offering a stop the user never named.
  for (const said of ["зздкжцу", "qqqq", "xyzzy plugh"]) {
    assert.deepEqual(matchStops(said, stops), [], `${said} produced a false match`);
  }
});

test("an empty transcript matches nothing", () => {
  assert.deepEqual(matchStops("", stops), []);
  assert.deepEqual(matchStops("   ", stops), []);
});

test("a full name outranks a bare prefix of it", () => {
  const full = matchStops("Сансар", stops);
  const partial = matchStops("Сан", stops);
  const bestFull = full[0]?.score ?? 0;
  const bestPartial = partial[0]?.score ?? 0;
  assert.ok(bestFull > bestPartial, `full ${bestFull} should beat partial ${bestPartial}`);
});

test("results are ordered by score, best first", () => {
  const matches = matchStops("сургууль", stops, { limit: 8 });
  for (let i = 1; i < matches.length; i++) {
    assert.ok(matches[i - 1].score >= matches[i].score, "results out of order");
  }
});

test("matching never returns a stop the app cannot name", () => {
  const nameless = stops.filter((s) => !s.name.trim());
  assert.equal(nameless.length, 0, "stops.json should carry no empty names");
  const matches = matchStops("буудал", stops, { limit: 20 });
  for (const m of matches) assert.ok(m.name.trim().length > 0);
});
