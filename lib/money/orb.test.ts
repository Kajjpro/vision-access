/**
 * ORB + matching, end to end on synthetic imagery.
 *
 * The claim under test is the one the whole feature rests on: features taken
 * from a flat printed pattern still match after that pattern has been
 * rotated, scaled and viewed at an angle — and do NOT match a different
 * pattern. Everything in lib/money/recognizer.ts is a threshold on top of
 * this behaviour, so if it does not hold there is nothing to tune.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REQUIRED_BORDER,
  detectAndCompute,
  hamming,
  patternExtent,
  toGray,
  type Gray,
} from "./orb";
import { findHomography, homographyFrom4, isPlausibleQuad, matchFeatures, project } from "./match";

// ---------------------------------------------------------------------------
// Synthetic "banknote": deterministic, densely textured, no repeated motifs.
// ---------------------------------------------------------------------------

function makePattern(width: number, height: number, seed: number): Gray {
  const data = new Uint8Array(width * height).fill(210);
  let s = seed >>> 0;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };

  // Ink blobs of varying size and darkness, which is roughly what engraved
  // print looks like to a corner detector.
  for (let i = 0; i < 260; i++) {
    const cx = Math.floor(rand() * width);
    const cy = Math.floor(rand() * height);
    const r = 2 + Math.floor(rand() * 7);
    const v = Math.floor(rand() * 90);
    for (let y = Math.max(0, cy - r); y < Math.min(height, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(width, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) data[y * width + x] = v;
      }
    }
  }
  // Rectangles, for strong corners.
  for (let i = 0; i < 40; i++) {
    const x0 = Math.floor(rand() * width * 0.9);
    const y0 = Math.floor(rand() * height * 0.9);
    const w = 5 + Math.floor(rand() * 30);
    const h = 5 + Math.floor(rand() * 20);
    const v = Math.floor(rand() * 60);
    for (let y = y0; y < Math.min(height, y0 + h); y++) {
      for (let x = x0; x < Math.min(width, x0 + w); x++) data[y * width + x] = v;
    }
  }
  return { data, width, height };
}

/**
 * Warp `src` by the INVERSE of h, so the result is what h maps src onto.
 * Bilinear, with a light background outside the source.
 */
function warp(src: Gray, h: Float64Array, width: number, height: number): Gray {
  // Invert the 3x3.
  const [a, b, c, d, e, f, g, i, j] = h;
  const det =
    a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  assert.ok(Math.abs(det) > 1e-9, "homography must be invertible");
  const inv = [
    (e * j - f * i) / det,
    (c * i - b * j) / det,
    (b * f - c * e) / det,
    (f * g - d * j) / det,
    (a * j - c * g) / det,
    (c * d - a * f) / det,
    (d * i - e * g) / det,
    (b * g - a * i) / det,
    (a * e - b * d) / det,
  ];

  const out = new Uint8Array(width * height).fill(235);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = inv[6] * x + inv[7] * y + inv[8];
      if (Math.abs(w) < 1e-12) continue;
      const sx = (inv[0] * x + inv[1] * y + inv[2]) / w;
      const sy = (inv[3] * x + inv[4] * y + inv[5]) / w;
      if (sx < 0 || sy < 0 || sx >= src.width - 1 || sy >= src.height - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const p00 = src.data[y0 * src.width + x0];
      const p01 = src.data[y0 * src.width + x0 + 1];
      const p10 = src.data[(y0 + 1) * src.width + x0];
      const p11 = src.data[(y0 + 1) * src.width + x0 + 1];
      const top = p00 + (p01 - p00) * fx;
      const bot = p10 + (p11 - p10) * fx;
      out[y * width + x] = (top + (bot - top) * fy) | 0;
    }
  }
  return { data: out, width, height };
}

function similarity(cx: number, cy: number, angleDeg: number, scale: number, tx: number, ty: number) {
  const t = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(t) * scale;
  const sin = Math.sin(t) * scale;
  // Rotate+scale about (cx,cy), then translate.
  return new Float64Array([
    cos, -sin, cx - cos * cx + sin * cy + tx,
    sin, cos, cy - sin * cx - cos * cy + ty,
    0, 0, 1,
  ]);
}

const W = 420;
const H = 220;

function matchCount(reference: Gray, query: Gray) {
  const refF = detectAndCompute(reference, { maxFeatures: 600 });
  const qF = detectAndCompute(query, { maxFeatures: 600 });
  const matches = matchFeatures(qF, refF);
  const res = findHomography(
    matches, qF, refF, reference.width, reference.height, query.width, query.height,
  );
  return { refF, qF, matches, res };
}

// ---------------------------------------------------------------------------

test("detects a useful number of features on printed texture", () => {
  const img = makePattern(W, H, 12345);
  const f = detectAndCompute(img, { maxFeatures: 600 });
  assert.ok(f.count > 150, `expected >150 features, got ${f.count}`);
  assert.equal(f.x.length, f.count);
  assert.equal(f.descriptors.length, f.count * 8);
});

test("descriptors are stable: an identical image matches itself almost perfectly", () => {
  const img = makePattern(W, H, 999);
  const a = detectAndCompute(img, { maxFeatures: 400 });
  const b = detectAndCompute(img, { maxFeatures: 400 });
  assert.equal(a.count, b.count);
  for (let i = 0; i < a.count; i++) {
    assert.equal(hamming(a.descriptors, i * 8, b.descriptors, i * 8), 0);
  }
});

test("matches the same note rotated 30 degrees and scaled", () => {
  const ref = makePattern(W, H, 4242);
  const h = similarity(W / 2, H / 2, 30, 0.8, 10, -5);
  const query = warp(ref, h, W, H);

  const { res } = matchCount(ref, query);
  assert.ok(res.inliers >= 18, `rotated+scaled note gave only ${res.inliers} inliers`);
  assert.ok(res.homography, "expected a homography");
});

test("matches under perspective, and the recovered homography is accurate", () => {
  const ref = makePattern(W, H, 777);
  // A genuine projective warp: a note held at an angle.
  const h = new Float64Array([
    0.92, 0.10, 12,
    -0.06, 0.95, 8,
    0.00022, 0.00010, 1,
  ]);
  const query = warp(ref, h, W, H);

  const { res } = matchCount(ref, query);
  assert.ok(res.inliers >= 18, `perspective view gave only ${res.inliers} inliers`);

  // The recovered transform should agree with the true one at the note corners.
  const corners = [ [0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1] ];
  for (const [x, y] of corners) {
    const want = project(h as unknown as Float64Array, x, y);
    const got = project(res.homography!, x, y);
    const err = Math.hypot(want.x - got.x, want.y - got.y);
    assert.ok(err < 12, `corner (${x},${y}) off by ${err.toFixed(1)}px`);
  }
});

test("REJECTS a different pattern — the safety-critical case", () => {
  const ref = makePattern(W, H, 1111);
  const other = makePattern(W, H, 8888);
  const { res } = matchCount(ref, other);
  assert.ok(
    res.inliers < 18,
    `an unrelated pattern produced ${res.inliers} inliers, at or above the ` +
      `MIN_INLIERS gate — this is the false-naming failure mode`,
  );
});

test("REJECTS blank and noise imagery", () => {
  const ref = makePattern(W, H, 2222);

  const blank: Gray = { data: new Uint8Array(W * H).fill(200), width: W, height: H };
  assert.ok(matchCount(ref, blank).res.inliers < 18, "blank image should not match");

  let s = 5;
  const noiseData = new Uint8Array(W * H);
  for (let i = 0; i < noiseData.length; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    noiseData[i] = (s >>> 0) % 256;
  }
  const noise: Gray = { data: noiseData, width: W, height: H };
  assert.ok(matchCount(ref, noise).res.inliers < 18, "random noise should not match");
});

test("toGray applies luma weights, not a plain average", () => {
  // Pure green is much brighter than pure blue under BT.601.
  const rgba = new Uint8ClampedArray([0, 255, 0, 255, 0, 0, 255, 255]);
  const g = toGray(rgba, 2, 1);
  assert.ok(g.data[0] > 140, `green luma ${g.data[0]}`);
  assert.ok(g.data[1] < 40, `blue luma ${g.data[1]}`);
});

// ---------------------------------------------------------------------------
// Homography maths
// ---------------------------------------------------------------------------

test("homographyFrom4 recovers an exact transform", () => {
  const src = [ { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 } ];
  const truth = new Float64Array([1.1, 0.2, 5, -0.1, 0.9, 7, 0.0005, 0.0002, 1]);
  const dst = src.map((p) => project(truth, p.x, p.y));

  const h = homographyFrom4(src, dst)!;
  assert.ok(h, "expected a solution");
  for (const p of src) {
    const want = project(truth, p.x, p.y);
    const got = project(h, p.x, p.y);
    assert.ok(Math.hypot(want.x - got.x, want.y - got.y) < 1e-6);
  }
});

test("homographyFrom4 returns null on collinear points rather than a garbage transform", () => {
  const src = [ { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 } ];
  const dst = [ { x: 0, y: 0 }, { x: 10, y: 1 }, { x: 20, y: 2 }, { x: 30, y: 3 } ];
  assert.equal(homographyFrom4(src, dst), null);
});

test("isPlausibleQuad rejects folded, inverted and degenerate transforms", () => {
  const identity = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(isPlausibleQuad(identity, 400, 200, 400, 200), true);

  // A bow tie: swapping two corners self-intersects the quad.
  const src = [ { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 }, { x: 0, y: 200 } ];
  const bowtie = homographyFrom4(src, [
    { x: 0, y: 0 }, { x: 400, y: 200 }, { x: 400, y: 0 }, { x: 0, y: 200 },
  ]);
  if (bowtie) assert.equal(isPlausibleQuad(bowtie, 400, 200, 400, 200), false);

  // Collapsed to a sliver: far below the 2%-of-frame floor.
  const sliver = new Float64Array([0.01, 0, 0, 0, 0.01, 0, 0, 0, 1]);
  assert.equal(isPlausibleQuad(sliver, 400, 200, 400, 200), false);

  // Run away far larger than the frame.
  const huge = new Float64Array([9, 0, 0, 0, 9, 0, 0, 0, 1]);
  assert.equal(isPlausibleQuad(huge, 400, 200, 400, 200), false);
});

test("no rotated sampling point can read outside the reserved border", () => {
  // Regression guard. The pattern was originally clamped to the SQUARE of
  // radius 15, and rotating its corner (15,15) sweeps out to 21.2 — past the
  // border, so the descriptor read off the end of the array. Out-of-bounds
  // reads on a Uint8Array are `undefined`, every comparison against them is
  // false, and the affected bits silently pinned to zero. Nothing threw, and
  // matching just quietly got worse near every edge. Constraining the pattern
  // to a DISK fixes it, because a disk is closed under rotation.
  const extent = patternExtent();
  assert.ok(
    extent < REQUIRED_BORDER,
    `pattern reaches ${extent}px but only ${REQUIRED_BORDER}px is reserved`,
  );
});

test("descriptors near the image edge are real, not silently zeroed", () => {
  const img = makePattern(W, H, 6060);
  const f = detectAndCompute(img, { maxFeatures: 600 });

  // The keypoint closest to an edge is the one an out-of-bounds read would
  // have corrupted first.
  let worst = -1;
  let worstMargin = Infinity;
  for (let i = 0; i < f.count; i++) {
    const margin = Math.min(f.x[i], f.y[i], W - f.x[i], H - f.y[i]);
    if (margin < worstMargin) { worstMargin = margin; worst = i; }
  }
  assert.ok(worst >= 0, "expected at least one keypoint");

  let bits = 0;
  for (let w = 0; w < 8; w++) {
    let v = f.descriptors[worst * 8 + w];
    while (v) { bits += v & 1; v >>>= 1; }
  }
  // A descriptor of a textured patch is roughly balanced. All-zero or
  // near-zero is the signature of reads falling off the array.
  assert.ok(bits > 40 && bits < 216, `edge keypoint descriptor has ${bits}/256 bits set`);
});
