/**
 * The vocabulary seam, where a mistake is silent and spoken aloud.
 *
 *   npx tsx --test lib/coco.test.ts
 *
 * Every check here guards a failure with the same shape: the app keeps working,
 * keeps sounding confident, and says the wrong noun. A user who cannot look up
 * and check has no way to discount that, so the mapping is tested rather than
 * reviewed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COCO_CLASSES,
  COCO_TO_PHRASE,
  NAME_MIN_SCORE,
  nameMinScore,
  phraseIdFor,
} from "./coco";
import { DETECTION_CLASSES, PHRASES } from "./phrases";

test("COCO_CLASSES is the full 80, in order, with no duplicates", () => {
  assert.equal(COCO_CLASSES.length, 80);
  assert.equal(new Set(COCO_CLASSES).size, 80);
  // Spot-check the indices the ONNX head actually uses. These are positions,
  // not names — an insertion anywhere above them renames every later class.
  assert.equal(COCO_CLASSES[0], "person");
  assert.equal(COCO_CLASSES[2], "car");
  assert.equal(COCO_CLASSES[5], "bus");
  assert.equal(COCO_CLASSES[13], "bench");
  assert.equal(COCO_CLASSES[56], "chair");
  assert.equal(COCO_CLASSES[60], "dining table");
  assert.equal(COCO_CLASSES[79], "toothbrush");
});

test("every mapped key is a real COCO class", () => {
  const known = new Set(COCO_CLASSES);
  for (const name of Object.keys(COCO_TO_PHRASE)) {
    assert.ok(known.has(name), `${name} is not a COCO class — it can never fire`);
  }
});

test("every mapped value is a phrase id the app has audio for", () => {
  const speakable = new Set(DETECTION_CLASSES);
  const withAudio = new Set(PHRASES.map((p) => p.id));
  for (const [coco, id] of Object.entries(COCO_TO_PHRASE)) {
    assert.ok(speakable.has(id), `${coco} -> ${id} is not in DETECTION_CLASSES`);
    assert.ok(withAudio.has(id), `${coco} -> ${id} has no clip; that is silence with extra steps`);
  }
});

/**
 * CLAUDE.md forbids this app from speaking to traffic signals at all. COCO
 * detects both of these well, which is exactly why the rule needs a test and
 * not a comment — they are the two classes someone would map back in because
 * they obviously work.
 */
test("traffic signals are never announced", () => {
  assert.equal(phraseIdFor("traffic light"), null);
  assert.equal(phraseIdFor("stop sign"), null);
});

test("chatter classes are dropped", () => {
  for (const name of ["toothbrush", "teddy bear", "pizza", "kite", "giraffe", "tv"]) {
    assert.equal(phraseIdFor(name), null, `${name} should not reach the user`);
  }
});

test("COCO names translate to phrase ids", () => {
  assert.equal(phraseIdFor("person"), "person");
  assert.equal(phraseIdFor("dining table"), "table");
  // Both seats map to one word: "Сандал" is chair, and the warning is identical.
  assert.equal(phraseIdFor("chair"), "bench");
  assert.equal(phraseIdFor("bench"), "bench");
});

/**
 * The legacy YOLOE exports name their classes with phrase ids already. A model
 * still sitting in a phone's Cache Storage must not start announcing nothing
 * because the vocabulary moved on underneath it.
 */
test("phrase ids pass through unchanged, so older exports still work", () => {
  for (const id of DETECTION_CLASSES) {
    assert.equal(phraseIdFor(id), id);
  }
});

test("an unknown name is dropped rather than guessed", () => {
  assert.equal(phraseIdFor(""), null);
  assert.equal(phraseIdFor("kerb"), null);
  assert.equal(phraseIdFor("Person"), null);
});

/**
 * classNamesFor() in the worker identifies a model SOLELY by its class count.
 * Two vocabularies of equal length are indistinguishable there, and picking the
 * wrong one renames every detection to some other object.
 */
test("the vocabularies stay distinguishable by length", () => {
  const lengths = [COCO_CLASSES.length, DETECTION_CLASSES.length, 32, 5];
  assert.equal(new Set(lengths).size, lengths.length, `collision in ${lengths.join(", ")}`);
});

test("every confidence floor names a class that can actually be announced", () => {
  const announced = new Set(Object.values(COCO_TO_PHRASE));
  for (const id of Object.keys(NAME_MIN_SCORE)) {
    assert.ok(announced.has(id), `${id} has a score floor but is never announced`);
  }
});

test("every announced class has a usable confidence floor", () => {
  for (const id of new Set(Object.values(COCO_TO_PHRASE))) {
    const min = nameMinScore(id);
    // Above the worker's flat 0.30 gate — a floor at or below it would never
    // reject anything — and below 1, which nothing could ever clear.
    assert.ok(min > 0.3 && min < 1, `${id} floor ${min} is not a working threshold`);
  }
});

test("an unlisted class still gets a floor rather than a free pass", () => {
  assert.ok(nameMinScore("something-new") > 0.3);
});
