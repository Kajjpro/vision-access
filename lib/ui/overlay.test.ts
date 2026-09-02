/**
 * The lock-on box has to land ON the object.
 *
 *   npx tsx --test lib/ui/overlay.test.ts
 *
 * Every case here is a real device shape. The one that matters most is a
 * landscape camera frame on a portrait phone, which is what every user has:
 * that is where the naive "box.x / frameWidth * screenWidth" mapping is wrong
 * by a third of the screen, and it is wrong in a way that looks plausible.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { coverTransform, isOnScreen, projectRect, projectX } from "./overlay";

/** A 1280x720 camera frame on a 390x844 phone — the common case. */
const FRAME = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };

/** Same aspect both sides: cover degenerates to a plain scale. */
test("matching aspect ratios scale with no crop", () => {
  const t = coverTransform({ width: 640, height: 480 }, { width: 320, height: 240 });
  assert.ok(t);
  assert.equal(t.scale, 0.5);
  assert.equal(t.offsetX, 0);
  assert.equal(t.offsetY, 0);

  const box = projectRect({ x: 100, y: 80, w: 40, h: 60 }, t);
  assert.deepEqual(box, { left: 50, top: 40, width: 20, height: 30 });
});

test("a landscape frame on a portrait screen is cropped horizontally", () => {
  const t = coverTransform(FRAME, PHONE);
  assert.ok(t);

  // Height is the binding axis: 844/720 covers, 390/1280 would not.
  assert.equal(t.scale, PHONE.height / FRAME.height);
  assert.equal(t.offsetY, 0);
  // Overflow is split evenly, so the left edge of the frame is off-screen.
  assert.ok(t.offsetX < 0);
  assert.equal(t.offsetX, (PHONE.width - FRAME.width * t.scale) / 2);
});

test("the centre of the frame is the centre of the screen", () => {
  for (const viewport of [PHONE, { width: 844, height: 390 }, { width: 1024, height: 1024 }]) {
    const t = coverTransform(FRAME, viewport);
    assert.ok(t);
    const centre = projectRect(
      { x: FRAME.width / 2 - 10, y: FRAME.height / 2 - 10, w: 20, h: 20 },
      t,
    );
    const cx = centre.left + centre.width / 2;
    const cy = centre.top + centre.height / 2;
    // Floating point on a division-heavy path; a tenth of a pixel is exact enough.
    assert.ok(Math.abs(cx - viewport.width / 2) < 0.1, `x ${cx}`);
    assert.ok(Math.abs(cy - viewport.height / 2) < 0.1, `y ${cy}`);
  }
});

/**
 * The regression this file exists for. A box in the middle-right of a
 * landscape frame is NOT at the same fraction across a portrait screen —
 * proportional mapping puts it ~48px from where the object actually is.
 */
test("proportional mapping would misplace the box", () => {
  const t = coverTransform(FRAME, PHONE);
  assert.ok(t);

  const rect = { x: 896, y: 300, w: 64, h: 120 }; // 70% across the frame
  const projected = projectRect(rect, t);
  const proportional = (rect.x / FRAME.width) * PHONE.width;

  assert.ok(
    Math.abs(projected.left - proportional) > 40,
    `expected a large disagreement, got ${projected.left} vs ${proportional}`,
  );
});

test("aspect ratio is preserved, so a square object stays square", () => {
  const t = coverTransform(FRAME, PHONE);
  assert.ok(t);
  const square = projectRect({ x: 200, y: 200, w: 100, h: 100 }, t);
  assert.ok(Math.abs(square.width - square.height) < 1e-9);
});

test("projectX agrees with the left edge of a projected rect", () => {
  const t = coverTransform(FRAME, PHONE);
  assert.ok(t);
  const corridorMin = FRAME.width * 0.25;
  assert.equal(projectX(corridorMin, t), projectRect({ x: corridorMin, y: 0, w: 1, h: 1 }, t).left);
});

test("unknown sizes yield no transform rather than NaN boxes", () => {
  assert.equal(coverTransform({ width: 0, height: 0 }, PHONE), null);
  assert.equal(coverTransform(FRAME, { width: 0, height: 0 }), null);
  assert.equal(coverTransform({ width: Number.NaN, height: 720 }, PHONE), null);
  assert.equal(coverTransform(FRAME, { width: 390, height: Number.NaN }), null);
});

test("boxes cropped away by cover are reported off-screen", () => {
  const t = coverTransform(FRAME, PHONE);
  assert.ok(t);

  // Far left of a landscape frame: inside the camera's view, outside the crop.
  const cropped = projectRect({ x: 0, y: 300, w: 60, h: 100 }, t);
  assert.equal(isOnScreen(cropped, PHONE), false);

  const centred = projectRect({ x: 600, y: 300, w: 60, h: 100 }, t);
  assert.equal(isOnScreen(centred, PHONE), true);
});

test("a box straddling the crop edge still counts as on-screen", () => {
  const t = coverTransform(FRAME, PHONE);
  assert.ok(t);
  // Positioned so its right edge is just inside the visible region.
  const visibleFromX = -t.offsetX / t.scale;
  const straddling = projectRect({ x: visibleFromX - 30, y: 300, w: 60, h: 100 }, t);
  assert.ok(straddling.left < 0);
  assert.equal(isOnScreen(straddling, PHONE), true);
});
