/**
 * Regression tests for the two failures that already bit this pipeline once.
 *
 *   npx tsx --test lib/transit/*.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CHIMEGE_ALLOWED, loadNumberWords, stopNameToSpeech, toSpeechText } from "./speech";

const table = loadNumberWords(JSON.parse(readFileSync("data/number-words.json", "utf8")));
const stops: { id: string; name: string }[] = JSON.parse(
  readFileSync("public/transit/stops.json", "utf8"),
);

test("every shipped stop name converts to text Chimege would accept", () => {
  const failures = stops
    .map((s) => ({ s, r: stopNameToSpeech(s.name, table, CHIMEGE_ALLOWED) }))
    .filter(({ r }) => !r.ok);
  assert.equal(
    failures.length,
    0,
    `${failures.length} unspeakable: ${failures.slice(0, 3).map((f) => f.s.name).join(", ")}`,
  );
});

test("no converted stop name smuggles a digit, slash or Latin letter through", () => {
  // These are exactly what Chimege 400s on, and what 895 of the 923 raw names
  // contain. A miss here becomes a build-time API error at best and a silent
  // clip at worst.
  for (const s of stops) {
    const r = stopNameToSpeech(s.name, table, CHIMEGE_ALLOWED);
    assert.ok(r.ok, `${s.name} failed to convert`);
    assert.match(r.text, CHIMEGE_ALLOWED, `${s.name} → ${r.text}`);
    assert.doesNotMatch(r.text, /[0-9]/, `digit survived in ${s.name} → ${r.text}`);
    assert.doesNotMatch(r.text, /[/]/, `slash survived in ${s.name} → ${r.text}`);
    assert.doesNotMatch(r.text, /[A-Za-z]/, `Latin survived in ${s.name} → ${r.text}`);
  }
});

test("interior slashes are flattened, not just the trailing platform suffix", () => {
  // Both real names. The first has two bracketed groups, the second uses a
  // slash as an "and" separator inside a word; an earlier version handled only
  // the trailing suffix and left these two unspeakable.
  const two = stopNameToSpeech("Сансар /Тунель/ /Хойд/", table, CHIMEGE_ALLOWED);
  assert.ok(two.ok);
  assert.equal(two.text, "Сансар, Тунель, Хойд");

  const inner = stopNameToSpeech("Монгол цах/утас компани /Баруун/", table, CHIMEGE_ALLOWED);
  assert.ok(inner.ok);
  assert.equal(inner.text, "Монгол цах утас компани, Баруун");
});

test("compound number tokens beat the bare numeral", () => {
  // Longest-key-first matching. Without it "7 БУУДАЛ" becomes "долоо БУУДАЛ",
  // leaving an unspoken Cyrillic noun glued to a bare numeral.
  const r = stopNameToSpeech("7 БУУДАЛ /Баруун/", table, CHIMEGE_ALLOWED);
  assert.ok(r.ok);
  assert.equal(r.text, "долоон буудал, Баруун");
});

test("ordinals keep their ordinal reading on the Chimege path", () => {
  const r = stopNameToSpeech("19-р байр /Хойд/", table, CHIMEGE_ALLOWED);
  assert.ok(r.ok);
  assert.equal(r.text, "арван есдүгээр байр, Хойд");
});

test("an unmapped numeric token fails loudly instead of speaking a digit", () => {
  // The whole point of the gate: never fall back to the display string.
  const r = stopNameToSpeech("999-р шинэ буудал /Хойд/", {}, CHIMEGE_ALLOWED);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unmapped/);
});

// --- toSpeechText: the provider-agnostic form, for engines that read numerals ---

test("toSpeechText strips slashes and keeps the direction word", () => {
  assert.equal(toSpeechText("Сансар /Хойд/"), "Сансар Хойд");
  assert.equal(toSpeechText("Саппоро /Урд/"), "Саппоро Урд");
  assert.equal(toSpeechText("Зүүн салааны хуучин эцэс /Баруун/"), "Зүүн салааны хуучин эцэс Баруун");
});

test("toSpeechText handles the stray-space and missing-space variants in the feed", () => {
  // All three shapes occur in stops.json.
  assert.equal(toSpeechText("Тест / Баруун /"), "Тест Баруун");
  assert.equal(toSpeechText("Салхит завсар-1/Баруун/"), "Салхит завсар-1 Баруун");
  assert.equal(toSpeechText("Тест /  Зүүн  /"), "Тест Зүүн");
});

test("toSpeechText flattens double-bracketed and separator slashes", () => {
  assert.equal(toSpeechText("Сансар /Тунель/ /Хойд/"), "Сансар Тунель Хойд");
  assert.equal(toSpeechText("Монгол цах/утас компани /Баруун/"), "Монгол цах утас компани Баруун");
});

test("no shipped stop name keeps a slash after toSpeechText", () => {
  for (const s of stops) {
    const t = toSpeechText(s.name);
    assert.doesNotMatch(t, /\//, `slash survived: ${s.name} → ${t}`);
    assert.doesNotMatch(t, /\s{2,}/, `double space: ${s.name} → ${t}`);
    assert.ok(t.length > 0, `empty result for ${s.name}`);
    assert.equal(t, t.trim(), `untrimmed: ${JSON.stringify(t)}`);
  }
});

test("digits are preserved for engines that expand them, and dropped for those that cannot", () => {
  // Azure path: no `accepts` regex, numerals survive for the engine to read.
  const azure = stopNameToSpeech("19-р байр /Хойд/", table);
  assert.ok(azure.ok);
  assert.equal(azure.text, "19-р байр Хойд");

  // Chimege path: charset supplied, numerals must become words.
  const chimege = stopNameToSpeech("19-р байр /Хойд/", table, CHIMEGE_ALLOWED);
  assert.ok(chimege.ok);
  assert.equal(chimege.text, "арван есдүгээр байр, Хойд");
});
