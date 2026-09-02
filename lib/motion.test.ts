/**
 * The rule that lets the app decide NOT to look at the world.
 *
 *   npx tsx --test lib/motion.test.ts
 *
 * Motion gating is the largest battery saving available, and it is the only
 * optimisation in this codebase whose failure mode is silence. Every test here
 * is about a way it could wrongly stay quiet, not about how much power it
 * saves — a gate that skips too eagerly does not make the app efficient, it
 * makes it wrong.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_SKIP_MS,
  MOTION_THRESHOLD,
  SIG_GRID,
  createSignature,
  measureFrame,
  motionBetween,
  shouldSkipInference,
} from "./motion";

const SIZE = 640;

/** RGBA pixel buffer for a `size`x`size` frame at a uniform grey level. */
function blank(size: number, level = 120): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  data.fill(level);
  return data;
}

/** Paint a filled rectangle, so a "person" can be moved around a frame. */
function rect(
  data: Uint8ClampedArray,
  size: number,
  x: number,
  y: number,
  w: number,
  h: number,
  level: number,
) {
  for (let row = y; row < y + h && row < size; row++) {
    for (let col = x; col < x + w && col < size; col++) {
      const o = (row * size + col) * 4;
      data[o] = level;
      data[o + 1] = level;
      data[o + 2] = level;
      data[o + 3] = 255;
    }
  }
}

/** Simulate sensor noise: every sampled pixel jittered by +/- `amplitude`. */
function noisy(data: Uint8ClampedArray, amplitude: number, seed = 1): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data);
  let a = seed >>> 0;
  for (let i = 0; i < out.length; i += 4) {
    a = (a * 1664525 + 1013904223) >>> 0;
    const jitter = ((a / 0xffffffff) * 2 - 1) * amplitude;
    out[i] += jitter;
    out[i + 1] += jitter;
    out[i + 2] += jitter;
  }
  return out;
}

function signatureFor(data: Uint8ClampedArray) {
  const sig = createSignature();
  measureFrame(data, SIZE, sig);
  return sig;
}

const base = {
  enabled: true,
  hasPrevious: true,
  threshold: MOTION_THRESHOLD,
  msSinceRealInference: 0,
  maxSkipMs: MAX_SKIP_MS,
};

// ---------------------------------------------------------------------------
// The signal
// ---------------------------------------------------------------------------

test("an identical frame produces no motion", () => {
  const frame = blank(SIZE);
  assert.equal(motionBetween(signatureFor(frame), signatureFor(frame)), 0);
});

test("the signature has one cell per grid square and is normalised 0..1", () => {
  const sig = signatureFor(blank(SIZE, 255));
  assert.equal(sig.length, SIG_GRID * SIG_GRID);
  for (const v of sig) assert.ok(v > 0.99 && v <= 1.0, `expected ~1, got ${v}`);
});

test("mean brightness comes back alongside the signature", () => {
  const sig = createSignature();
  assert.ok(Math.abs(measureFrame(blank(SIZE, 0), SIZE, sig) - 0) < 0.01);
  assert.ok(Math.abs(measureFrame(blank(SIZE, 255), SIZE, sig) - 1) < 0.01);
});

/**
 * THE CENTRAL SAFETY PROPERTY. Sensor noise must fall below the threshold and a
 * real object must land above it, with clear daylight between them — otherwise
 * the gate is either useless or dangerous, and which one depends on the weather.
 */
test("sensor noise stays below the threshold", () => {
  const still = blank(SIZE);
  // Includes +/-20, which is a bad sensor in poor light — well past realistic.
  for (const amplitude of [2, 5, 10, 20]) {
    const motion = motionBetween(signatureFor(still), signatureFor(noisy(still, amplitude)));
    assert.ok(
      motion < MOTION_THRESHOLD,
      `noise +/-${amplitude} produced motion ${motion.toFixed(4)}, at or above the ${MOTION_THRESHOLD} threshold`,
    );
  }
});

test("a person-sized object moving trips the threshold with room to spare", () => {
  const before = blank(SIZE);
  rect(before, SIZE, 300, 250, 60, 160, 30);
  const after = blank(SIZE);
  // One step sideways, about 20cm at a few metres.
  rect(after, SIZE, 340, 250, 60, 160, 30);

  const motion = motionBetween(signatureFor(before), signatureFor(after));
  assert.ok(
    motion > MOTION_THRESHOLD * 3,
    `a moving person must be unmistakable, got ${motion.toFixed(4)} vs threshold ${MOTION_THRESHOLD}`,
  );
});

test("an object appearing where there was none trips the threshold", () => {
  const empty = blank(SIZE);
  const occupied = blank(SIZE);
  rect(occupied, SIZE, 500, 300, 50, 130, 40);

  const motion = motionBetween(signatureFor(empty), signatureFor(occupied));
  assert.ok(motion > MOTION_THRESHOLD * 3, `got ${motion.toFixed(4)}`);
});

test("a small distant object still registers against noise", () => {
  // ~20x50px: a person across the street, and the hardest real case.
  const empty = noisy(blank(SIZE), 5);
  const occupied = new Uint8ClampedArray(empty);
  rect(occupied, SIZE, 320, 300, 20, 50, 20);

  const motion = motionBetween(signatureFor(empty), signatureFor(occupied));
  assert.ok(
    motion > MOTION_THRESHOLD,
    `a distant pedestrian must not read as a still scene: ${motion.toFixed(4)}`,
  );
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("a genuinely still scene is skipped", () => {
  assert.equal(shouldSkipInference({ ...base, motion: 0.001 }), true);
});

test("motion at or above the threshold is never skipped", () => {
  assert.equal(shouldSkipInference({ ...base, motion: MOTION_THRESHOLD }), false);
  assert.equal(shouldSkipInference({ ...base, motion: 0.5 }), false);
});

test("the first frame is always inferred", () => {
  assert.equal(shouldSkipInference({ ...base, hasPrevious: false, motion: 0 }), false);
});

/**
 * The bound that makes gating acceptable at all: something approaching too
 * slowly to register cannot hide behind an unbroken run of skips.
 */
test("the safety ceiling forces a real inference however still the scene looks", () => {
  assert.equal(
    shouldSkipInference({ ...base, motion: 0, msSinceRealInference: MAX_SKIP_MS + 1 }),
    false,
  );
});

test("the ceiling is measured from the last REAL inference, not the last decision", () => {
  // Just inside the window: still skippable.
  assert.equal(
    shouldSkipInference({ ...base, motion: 0, msSinceRealInference: MAX_SKIP_MS - 1 }),
    true,
  );
  // A run of skips advances this clock, so it must eventually refuse.
  assert.equal(
    shouldSkipInference({ ...base, motion: 0, msSinceRealInference: MAX_SKIP_MS + 100 }),
    false,
  );
});

test("the worst-case added latency is under a metre of walking", () => {
  // 1.4 m/s is the pace lib/tracker.ts assumes.
  assert.ok((MAX_SKIP_MS / 1000) * 1.4 < 1.0, "a skip must never cost a metre of unseen ground");
});

test("gating can be switched off entirely", () => {
  assert.equal(shouldSkipInference({ ...base, enabled: false, motion: 0 }), false);
});
