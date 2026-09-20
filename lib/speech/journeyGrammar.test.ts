/**
 * Splitting one utterance into origin and destination.
 *
 * Mongolian marks the roles on the noun itself, so this needs no word-order
 * assumption — but it does need the markers to survive whatever ASR did to the
 * string, which is why the homoglyph cases are here too.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseJourney } from "./journeyGrammar";

test("ablative and terminative fill both slots", () => {
  const { originText, destText, ambiguous } = parseJourney("Сансараас Драмын театр хүртэл");
  assert.equal(ambiguous, false);
  assert.match(originText ?? "", /Сансар/);
  assert.match(destText ?? "", /Драмын театр/);
});

test("a spoken sentence with filler fills both slots", () => {
  const { originText, destText, ambiguous } = parseJourney("Би Сансарт байна Зайсан руу явна");
  assert.equal(ambiguous, false);
  assert.match(originText ?? "", /Сансар/);
  assert.match(destText ?? "", /Зайсан/);
  // "Би" and "байна" carry no location and must not reach the matcher.
  assert.doesNotMatch(originText ?? "", /Би|байна/);
});

test("destination only is the NORMAL case, not an error", () => {
  const { originText, destText, ambiguous } = parseJourney("Драмын театр явна");
  assert.equal(ambiguous, false);
  assert.equal(originText, null);
  assert.match(destText ?? "", /Драмын театр/);
  // The verb is grammar, not part of the name.
  assert.doesNotMatch(destText ?? "", /явна/);
});

test("a bare name carries no role and is flagged ambiguous", () => {
  const { originText, destText, ambiguous } = parseJourney("Их дэлгүүр");
  assert.equal(ambiguous, true);
  assert.equal(originText, null);
  assert.match(destText ?? "", /Их дэлгүүр/);
});

test("an empty or filler-only utterance is ambiguous, never a destination", () => {
  assert.equal(parseJourney("").ambiguous, true);
  assert.equal(parseJourney("   ").destText, null);
  const filler = parseJourney("би байна");
  assert.equal(filler.destText, null);
});

test("Latin homoglyphs do not hide the role markers", () => {
  // ASR emits Latin C/O/P inside Cyrillic. If deHomoglyph did not run first,
  // the suffix regexes would miss and both slots would come back empty.
  const { originText, destText } = parseJourney("Cансараас Драмын театр хүртэл");
  assert.match(originText ?? "", /ансар/);
  assert.match(destText ?? "", /Драмын театр/);
});

test("locative alone reads as a destination, not an origin", () => {
  // "Зайсанд" on its own almost always means "to Zaisan". Treating it as an
  // origin would silently ask the rider the wrong follow-up question.
  const { originText, destText } = parseJourney("Зайсанд");
  assert.equal(originText, null);
  assert.match(destText ?? "", /Зайсан/);
});

test("punctuation from a detailed ASR result does not split a name", () => {
  const { destText } = parseJourney("Драмын театр, явна.");
  assert.match(destText ?? "", /Драмын театр/);
});
