/**
 * The earcons, as shapes rather than as sound.
 *
 * A tone cannot be asserted by listening in CI, but the three properties that
 * decide whether it works through one earbud on Peace Avenue can be: it is
 * short enough to land inside the message, its pitch CONTOUR distinguishes it
 * from the other three, and it never gets louder than the obstacle alarm that
 * has to stay the most alarming sound the app can make.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EARCON_SHAPES, earconDurationS, MAX_EARCON_MS } from "./earcons";
import type { EarconId } from "./audio-queue";

const IDS: EarconId[] = ["soft", "alert", "urgent", "error"];

/** lib/audio.ts plays the unmeasurable-obstacle alarm at this gain. */
const OBSTACLE_ALARM_GAIN = 0.35;

test("every earcon fits inside the budget that keeps it usable in traffic", () => {
  for (const id of IDS) {
    const ms = earconDurationS(id) * 1000;
    assert.ok(ms > 0, `${id} is silent`);
    assert.ok(ms <= MAX_EARCON_MS, `${id} runs ${ms.toFixed(0)} ms, over the ${MAX_EARCON_MS} ms budget`);
  }
});

test("no earcon is as loud as the obstacle alarm", () => {
  // Teaching a blind user that the danger sound sometimes means "your stop is
  // coming" is the one confusion this app cannot afford. Staying quieter is
  // half of keeping them separable; the waveform and pitch are the other half.
  for (const id of IDS) {
    for (const note of EARCON_SHAPES[id]) {
      assert.ok(note.gain < OBSTACLE_ALARM_GAIN, `${id} at ${note.gain} reaches the alarm's ${OBSTACLE_ALARM_GAIN}`);
    }
  }
});

test("urgency is carried by pitch direction, not by volume alone", () => {
  const contour = (id: EarconId) => {
    const notes = EARCON_SHAPES[id];
    if (notes.length < 2) return "flat";
    return notes[notes.length - 1].hz > notes[0].hz ? "rising" : "falling";
  };
  // Contour is what the ear recovers from a masked signal — the same reason
  // lifts use a rising pair for accept and a falling pair for reject.
  assert.equal(contour("alert"), "rising");
  assert.equal(contour("urgent"), "rising");
  assert.equal(contour("error"), "falling", "an error that rises reads as success");
});

test("the four are distinguishable from each other by shape", () => {
  const signature = (id: EarconId) =>
    `${EARCON_SHAPES[id].length}:${EARCON_SHAPES[id].map((n) => Math.round(n.hz / 50)).join(",")}`;
  const seen = new Map<string, EarconId>();
  for (const id of IDS) {
    const sig = signature(id);
    const clash = seen.get(sig);
    assert.equal(clash, undefined, `${id} sounds like ${clash}`);
    seen.set(sig, id);
  }
});

test("earcons avoid the 880 Hz the obstacle alarm owns", () => {
  // The alarm is a square wave at 880. A sine landing on the same pitch is a
  // near-miss the ear resolves badly through a phone speaker.
  for (const id of IDS) {
    for (const note of EARCON_SHAPES[id]) {
      assert.ok(Math.abs(note.hz - 880) > 40, `${id} has a note at ${note.hz} Hz, too near the alarm`);
    }
  }
});

test("notes never overlap inside one earcon", () => {
  // Overlapping sines beat against each other, which turns a clean contour into
  // a warble that is harder to place than either tone alone.
  for (const id of IDS) {
    const notes = [...EARCON_SHAPES[id]].sort((a, b) => a.startS - b.startS);
    for (let i = 1; i < notes.length; i++) {
      const previousEnd = notes[i - 1].startS + notes[i - 1].durS;
      assert.ok(notes[i].startS >= previousEnd, `${id} note ${i} starts before note ${i - 1} ends`);
    }
  }
});
