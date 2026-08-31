/**
 * Normalization, tested against the real 923-stop file.
 *
 * Fixtures would be written from the same assumptions as the code, and the
 * assumptions are the thing under test. Every case below is either a shape ASR
 * actually emits (Latin homoglyphs inside Cyrillic, case endings) or a property
 * of the shipped data.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deHomoglyph, expandOrdinals, fold, similarity, stopKey } from "./mnNormalize";
import { ordinalWords, expandOrdinalsInName } from "./ordinals";
import { matchStops, needsDisambiguation, type Stop } from "../routing/resolveJourney";

const stops: Stop[] = JSON.parse(readFileSync("public/transit/stops.json", "utf8"));

const topName = (said: string) => matchStops(said, stops, { limit: 3 })[0]?.stop.name ?? null;

// --------------------------------------------------------------- homoglyphs

test("Latin letters hiding inside a Cyrillic name still match", () => {
  // The failure is invisible on screen: "Cансар" and "Сансар" render identically.
  assert.notEqual("Cансар", "Сансар", "fixture must actually use the Latin C");
  assert.equal(stopKey("Cансар"), stopKey("Сансар"));
  // Latin O (U+004F) → Cyrillic О (U+041E).
  assert.equal(deHomoglyph("O"), "О");
  assert.notEqual("O", "О");
  assert.equal(stopKey("Oфицеруудын ордон"), stopKey("Офицеруудын ордон"));
});

test("the four folding cases from the brief reach their stop", () => {
  assert.match(topName("Cансараас") ?? "", /Сансар/);
  assert.match(topName("их делгуур") ?? "", /Их Дэлгүүр/i);
  assert.match(topName("Oфицеруудын ордон") ?? "", /Офицеруудын ордон/);
});

test("зайсанд folds to Зайсан — the stop itself is missing from the data", () => {
  // Folding is correct; the dataset is not. ЗАЙСАН /Зүүн/ (id 000000554) is in
  // probe-output/dropped-stops.json, 1994 m from the nearest kept stop, so no
  // amount of normalization can match it. Asserted as a key equality rather
  // than a lookup so this test reports the normalizer, not the coverage hole.
  assert.equal(stopKey("зайсанд"), stopKey("Зайсан"));
  assert.equal(stops.some((s) => /зайсан/i.test(s.name)), false,
    "Зайсан is now in the data — point this test at the stop instead");
});

test("case endings the speaker adds are stripped", () => {
  for (const said of ["Сансараас", "Сансарт", "Сансарын"]) {
    assert.equal(stopKey(said), stopKey("Сансар"), `${said} did not fold to Сансар`);
  }
});

// ----------------------------------------------------------------- ordinals

test("digits and ordinal words are the same key", () => {
  assert.equal(stopKey("3-р хороолол"), stopKey("гуравдугаар хороолол"));
});

test("3-р and 13-р stay apart — they are kilometres apart in the city", () => {
  assert.notEqual(stopKey("3-р хороолол"), stopKey("13-р хороолол"));
  assert.notEqual(stopKey("гуравдугаар хороолол"), stopKey("13-р хороолол"));
});

test("REGRESSION: repeated digits are not collapsed", () => {
  // `fold` collapsed runs with `(.)\1+`, which also ate digits: "112-ын буудал"
  // became the key of "12-ын буудал", a stop 12.5 km away. Doubled vowels are
  // what ASR confuses; a repeated digit is information.
  assert.notEqual(stopKey("112-ын буудал"), stopKey("12-ын буудал"));
  assert.equal(fold("112"), "112");
  assert.equal(fold("100"), "100");
  // The vowel collapsing it exists for must still work.
  assert.equal(fold("буудал"), "будал");
  assert.equal(fold("доод"), "дод");
});

test("ordinals above the built-in table reach their stop through aliasKeys", () => {
  // mnNormalize's table stops at 16. 46 stops carry a higher number, and a
  // rider saying it in words had no way to reach any of them.
  assert.equal(ordinalWords(32), "гучин хоёрдугаар");
  assert.equal(ordinalWords(19), "арван есдүгээр");
  assert.match(topName("гучин хоёрдугаар байр") ?? "", /32-р байр/);
});

test("ordinalWords refuses to invent what it does not know", () => {
  assert.equal(ordinalWords(0), null);
  assert.equal(ordinalWords(1000), null);
  assert.equal(ordinalWords(2.5), null);
});

test("ordinal rewriting uses Unicode boundaries, not \\b", () => {
  // `\b` only knows [A-Za-z0-9_]; against Cyrillic it matches nothing at all.
  // A scan written with `\b` reported zero ordinals in a file containing 106.
  assert.equal(expandOrdinalsInName("32-р байр"), "гучин хоёрдугаар байр");
  assert.equal(expandOrdinalsInName("Сансар ШТС"), null);
  assert.match(expandOrdinals("3-р хороолол"), /гуравдугаар/);
});

// ------------------------------------------------------------ disambiguation

test("a bare generic word is ambiguous and says so", () => {
  const matches = matchStops("хороолол", stops, { limit: 3 });
  assert.ok(matches.length >= 2, "expected several districts to match");
  assert.equal(needsDisambiguation(matches), true);
});

test("an exact name does NOT ask which one", () => {
  const matches = matchStops("Цамбагарав", stops, { limit: 3 });
  assert.ok(matches.length > 0);
  assert.equal(needsDisambiguation(matches), false);
});

test("REGRESSION: platforms of one place are one candidate, not two", () => {
  // Саппоро /Урд/ and /Хойд/ scored 0.94 and 0.92 — inside the disambiguation
  // window — so the rider was asked to choose between two compass words they
  // cannot act on. Measured over all 923 names this fired on 80.1% of them.
  const matches = matchStops("Саппоро", stops, { limit: 3 });
  const places = matches.map((m) => m.stop.placeKey);
  assert.equal(new Set(places).size, places.length, "the same place was offered twice");
});

test("the whole-network disambiguation rate stays low", () => {
  const spoken = (n: string) => n.replace(/\s*\/[^/]*\/\s*$/, "").trim();
  let fired = 0;
  for (const s of stops) {
    if (needsDisambiguation(matchStops(spoken(s.name), stops, { limit: 3 }))) fired++;
  }
  const rate = fired / stops.length;
  assert.ok(rate < 0.05, `${(rate * 100).toFixed(1)}% of stops ask "which one?" — was 80% before grouping`);
});

// ------------------------------------------------------------------- keys

test("every shipped stop carries a precomputed key — never computed per utterance", () => {
  assert.equal(stops.length, 923);
  for (const s of stops) {
    assert.ok(s.key, `${s.id} ${s.name} has no key`);
    assert.ok(s.placeKey, `${s.id} ${s.name} has no placeKey`);
  }
});

test("no two DIFFERENT places share a key", () => {
  const byKey = new Map<string, Set<string>>();
  for (const s of stops) {
    const set = byKey.get(s.key) ?? new Set<string>();
    set.add(s.placeKey!);
    byKey.set(s.key, set);
  }
  // Three same-name pairs exist in the source data (1-р байр, 11-р байр,
  // 5 Толгой дэлгүүр). They are kept apart by placeKey, which is what the
  // matcher dedupes on, so they remain distinguishable choices.
  const shared = [...byKey.entries()].filter(([, places]) => places.size > 1);
  assert.ok(shared.length <= 3, `unexpected key collisions: ${shared.map(([k]) => k).join(", ")}`);
});

test("standing at one of three identically-named stops picks the near one", () => {
  // "1-р байр" exists three times, up to 10 km apart, and all three key
  // identically — text scoring cannot separate them even in principle. This is
  // the case the geo signal exists for, and it only works because distance is
  // its own sort key: the proximity BONUS is clamped away at score 1.0.
  const byName = stops.filter((s) => /^1-р [Бб]айр/.test(s.name));
  assert.ok(byName.length >= 2, "fixture expects several stops named 1-р байр");

  for (const target of byName) {
    const matches = matchStops("нэгдүгээр байр", stops, {
      near: [target.lat!, target.lon!],
      limit: 3,
    });
    assert.equal(matches[0].stop.id, target.id,
      `standing at ${target.name} (${target.id}) the top match was ${matches[0].stop.name}`);
  }
});

// -------------------------------------------------------------- similarity

test("a short fragment of a long official name still scores", () => {
  // The most common real utterance shape: nobody says the full registered name.
  assert.ok(similarity(stopKey("драм"), stopKey("Улсын драмын эрдмийн театр")) > 0.4);
});

test("unrelated names do not score", () => {
  assert.ok(similarity(stopKey("Сансар"), stopKey("Цамбагарав")) < 0.42);
});
