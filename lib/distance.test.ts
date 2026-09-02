/**
 * What the distance model says, and — more importantly — when it refuses to say
 * a number at all.
 *
 *   npx tsx --test lib/distance.test.ts
 *
 * Objects are projected into boxes with the exact pinhole model the estimator
 * inverts, so "truth" here means truth about the geometry, not about a real
 * camera. That is the right scope for these: the residual errors from a real
 * lens, a real pitch sensor and a real detector's box edges are characterised
 * in the header of distance.ts and are not what this file is checking. What it
 * checks is that the ESTIMATOR does the right thing with the geometry it is
 * given, and that it stays quiet when it cannot.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PITCH_DEG,
  OBJECT_WIDTHS,
  VERY_CLOSE_M,
  announcementFor,
  estimateObjectDistance,
  focalPx,
  horizonY,
  type Box,
  type CameraPose,
} from "./distance";

const FRAME_W = 1280;
const FRAME_H = 720;
const CAMERA_H = 1.4;

function poseAt(pitchDeg = 20, pitchMeasured = true): CameraPose {
  return {
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    pitchDeg,
    cameraHeightM: CAMERA_H,
    pitchMeasured,
  };
}

/**
 * Project an object of a known real size, standing on the ground at a known
 * distance, into the box a detector would draw — including the clamping to the
 * frame that lib/vision.worker.ts applies. The clamping is the point: it is
 * what makes a close object's box truncated, which is what breaks the
 * estimators.
 */
function project(
  distanceM: number,
  heightM: number,
  widthM: number,
  pose: CameraPose = poseAt(),
): Box {
  const f = focalPx(pose.frameWidth);
  const t = (pose.pitchDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const h = pose.cameraHeightM;

  /** Image row of a point `y` metres above the ground at `distanceM`. */
  const rowAt = (y: number) => {
    const forward = distanceM * cos + (h - y) * sin;
    const down = (h - y) * cos - distanceM * sin;
    return pose.frameHeight / 2 + (f * down) / forward;
  };

  const bottom = rowAt(0);
  const top = rowAt(heightM);
  // Apparent width at the object's mid-height, then centred in frame.
  const forwardMid = distanceM * cos + (h - heightM / 2) * sin;
  const w = (f * widthM) / forwardMid;

  const y0 = Math.max(0, top);
  const y1 = Math.min(pose.frameHeight, bottom);
  return { x: pose.frameWidth / 2 - w / 2, y: y0, w, h: y1 - y0 };
}

test("a person at a comfortable range is measured accurately", () => {
  const pose = poseAt();
  const box = project(4, 1.7, 0.5, pose);
  const { metres, reliable } = estimateObjectDistance(box, "person", pose);
  assert.ok(reliable);
  assert.ok(Math.abs(metres - 4) < 0.2, `expected ~4 m, got ${metres.toFixed(2)}`);
});

/**
 * THE CLOSE-RANGE IMPROVEMENT, and the reason OBJECT_WIDTHS exists.
 *
 * At two metres a 1.7 m person's head is above the top of the frame, so the
 * height prior is rejected as truncated. Their shoulders are still wholly in
 * frame. Before the width prior this fell through to the frame-fraction guard
 * and returned VERY_CLOSE_M — a numberless "маш ойрхон" carrying a fabricated
 * 0.3 m, for someone standing at two metres.
 */
test("a person too close to measure by height is measured by width", () => {
  const pose = poseAt();
  const box = project(2, 1.7, 0.5, pose);

  // Precondition: this really is the truncated case, or the test proves nothing.
  assert.ok(box.y <= 3, "the head should be cut off by the top of the frame");
  assert.ok(box.h / pose.frameHeight > 0.5, "and the box should fill the frame");

  const { metres, reliable } = estimateObjectDistance(box, "person", pose);
  assert.ok(reliable, "a whole-width person is measurable and should be spoken as a figure");
  assert.notEqual(metres, VERY_CLOSE_M);
  assert.ok(Math.abs(metres - 2) < 0.35, `expected ~2 m, got ${metres.toFixed(2)}`);

  // And the warning that follows actually carries the number.
  const { clips } = announcementFor({ metres, reliable }, "person");
  assert.deepEqual(clips, ["person", "approx", "m_2"]);
});

/**
 * A clipped base reads systematically TOO FAR — measured: an object at one
 * metre reads as 1.60 m at pitch 20. That is under-warning, the one direction
 * this app must not err in, so the ground vote is dropped outright rather than
 * downweighted whenever something unbiased can carry the estimate.
 */
test("a clipped base is excluded from the fusion, not averaged into it", () => {
  const pose = poseAt();
  const box = project(1, 1.7, 0.5, pose);

  assert.ok(
    box.y + box.h >= pose.frameHeight - 3,
    "the feet should be below the bottom of the frame",
  );

  const { metres } = estimateObjectDistance(box, "person", pose);

  // The width prior alone answers 1.13 (see the slant-depth note in
  // OBJECT_WIDTHS); the clipped ground plane answers 1.60; fusing the two
  // would land near 1.35. Excluding it must leave the width prior's answer
  // essentially untouched.
  assert.ok(
    metres < 1.25,
    `the 1.60 m ground bias should not have been averaged in, got ${metres.toFixed(2)} m`,
  );
});

test("a class with no width prior still falls back to very close", () => {
  const pose = poseAt();
  // A car is deliberately absent from OBJECT_WIDTHS: 1.8 m across and 4.5 m
  // long, so apparent width is a coin flip on viewing angle.
  assert.equal(OBJECT_WIDTHS.car, undefined);

  const box = project(1, 1.5, 1.8, pose);
  const { metres, reliable } = estimateObjectDistance(box, "car", pose);
  assert.equal(reliable, false);
  assert.equal(metres, VERY_CLOSE_M);

  // Which is still a warning, and still an urgent one — just without a figure.
  const { tone, clips } = announcementFor({ metres, reliable }, "car");
  assert.equal(tone, true);
  assert.deepEqual(clips, ["very_close"]);
});

test("an object above the horizon gets no reliable distance", () => {
  const pose = poseAt();
  // The horizon sits at row 21 for this pose. A box whose BASE is above it
  // describes something that never meets the ground — an overhead sign, a
  // window, a bridge — so no ground-referenced distance exists for it.
  assert.ok(horizonY(pose) > 15 && horizonY(pose) < 30, "pose assumption for this test");
  const box: Box = { x: 600, y: 0, w: 80, h: 15 };

  const { reliable } = estimateObjectDistance(box, "person", pose);
  assert.equal(reliable, false, "no ground intersection means no ground-referenced figure");

  // announcementFor() must then stay silent rather than cry wolf.
  const { tone, clips } = announcementFor({ metres: 9, reliable: false }, "person");
  assert.equal(tone, false);
  assert.deepEqual(clips, []);
});

/**
 * With no orientation sensor the ground plane carries ~42% error and is not
 * used at all. The size priors do not touch pitch, so they still produce a
 * figure — which is the difference between an app that names distances on a
 * cheap phone and one that only names objects.
 */
test("without a measured pitch the size priors still give a figure", () => {
  const measured = poseAt(20, true);
  const box = project(3, 1.7, 0.5, measured);

  const unmeasured: CameraPose = { ...measured, pitchDeg: DEFAULT_PITCH_DEG, pitchMeasured: false };
  const { metres, reliable } = estimateObjectDistance(box, "person", unmeasured);
  assert.ok(reliable);
  assert.ok(Math.abs(metres - 3) < 0.4, `expected ~3 m, got ${metres.toFixed(2)}`);
});

test("without a measured pitch a class with no prior gets no figure", () => {
  const pose = poseAt(20, false);
  // `pole` has neither a height nor a width prior, by design — a pole's real
  // height is not constrained, so there is nothing honest to say.
  const box: Box = { x: 600, y: 200, w: 30, h: 300 };
  const { reliable } = estimateObjectDistance(box, "pole", pose);
  assert.equal(reliable, false);
});

test("a tight prior outweighs a loose one", () => {
  const pose = poseAt();
  // person carries relSd 0.06 on height against the ground plane's 0.185, so a
  // box whose height and base disagree should land nearer the height answer.
  const truthful = project(5, 1.7, 0.5, pose);
  // Move the base down 30px: the ground estimate now reads much closer while
  // the pixel height, and so the height prior, is barely touched.
  const skewed: Box = { ...truthful, h: truthful.h + 30 };

  const { metres } = estimateObjectDistance(skewed, "person", pose);
  const groundOnly = estimateObjectDistance(skewed, "pole", pose);
  assert.ok(
    Math.abs(metres - 5) < Math.abs(groundOnly.metres - 5),
    `the height prior should pull ${groundOnly.metres.toFixed(2)} back toward 5, got ${metres.toFixed(2)}`,
  );
});

test("distances are never reported beyond the model's usable range", () => {
  const pose = poseAt();
  for (const d of [25, 50, 200]) {
    const box = project(d, 1.7, 0.5, pose);
    const { metres } = estimateObjectDistance(box, "person", pose);
    assert.ok(metres <= 20 + 1e-6, `${d} m should clamp, got ${metres}`);
  }
});

test("a degenerate box never produces NaN", () => {
  const pose = poseAt();
  for (const box of [
    { x: 0, y: 0, w: 0, h: 0 },
    { x: 0, y: 0, w: FRAME_W, h: FRAME_H },
    { x: 640, y: 719, w: 1, h: 1 },
  ]) {
    for (const name of ["person", "car", "pole", ""]) {
      const { metres } = estimateObjectDistance(box, name, pose);
      assert.ok(!Number.isNaN(metres), `NaN for ${name} on ${JSON.stringify(box)}`);
    }
  }
});
