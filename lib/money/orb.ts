/**
 * ORB keypoints and binary descriptors, in plain TypeScript.
 *
 * This is the front half of banknote recognition: turn an image into a few
 * hundred rotation- and scale-invariant 256-bit fingerprints of local print
 * detail. lib/money/match.ts does the back half — compare two such sets and
 * decide whether they are the same piece of paper.
 *
 * WHY HAND-ROLLED RATHER THAN OpenCV.js
 * -------------------------------------
 * opencv.js is ~8 MB of wasm for the four functions used here, on top of the
 * 36 MB detector already fetched over Mongolian mobile data. This file is
 * ~12 KB and has no build step. The pipeline is also pure integer and
 * Float32Array work, so there is no numerical subtlety being given up.
 *
 * WHY ORB RATHER THAN SIFT
 * ------------------------
 * Binary descriptors compare with XOR + popcount instead of a Euclidean
 * distance over 128 floats. Matching a query against the whole reference pack
 * is ~24M u32 operations, which is a tap-to-capture cost rather than a
 * per-frame one. ORB is also unencumbered, which SIFT historically was not.
 *
 * THE BUDGET HERE IS NOT THE WALKMODE BUDGET. CLAUDE.md's 60 ms frame budget
 * governs the continuous obstacle loop, where a late frame is a missed car.
 * Money is tap-to-capture: the user has stopped, is holding a note, and
 * nothing is approaching them. Correctness wins over latency in this file,
 * and a few hundred milliseconds is the right trade.
 *
 * Reference: Rublee et al., "ORB: an efficient alternative to SIFT or SURF"
 * (ICCV 2011). Deviation from the paper is noted where it happens.
 */

/** 256-bit descriptors, held as 8 x u32. */
export const DESCRIPTOR_BITS = 256;
export const DESCRIPTOR_WORDS = DESCRIPTOR_BITS / 32;

/** Radius of the patch the descriptor and the orientation both read from. */
const PATCH_RADIUS = 15;

/**
 * Rotated copies of the sampling pattern, precomputed. The paper uses 30 bins
 * (12° each); the residual misalignment inside a bin is smaller than the
 * orientation estimate's own error, so finer bins buy nothing.
 */
const ANGLE_BINS = 30;

/** FAST intensity threshold, on 0-255. Below ~15 the detector fires on sensor noise. */
const FAST_THRESHOLD = 20;

/** Contiguous arc of the 16-pixel Bresenham circle required to call it a corner. */
const FAST_ARC = 9;

/** Harris k, from the original corner measure. */
const HARRIS_K = 0.04;

/**
 * Pyramid geometry. 1.2^5 = 2.49x, so a note filling the frame and one at
 * arm's length both land within a level of a reference shot at mid distance.
 */
const PYRAMID_LEVELS = 6;
const PYRAMID_SCALE = 1.2;

/** Below this the level is smaller than the descriptor patch and is dropped. */
const MIN_LEVEL_SIZE = 2 * PATCH_RADIUS + 8;

export type Gray = {
  data: Uint8Array;
  width: number;
  height: number;
};

export type Features = {
  count: number;
  /** All coordinates are in ORIGINAL image pixels, not level pixels. */
  x: Float32Array;
  y: Float32Array;
  angle: Float32Array;
  score: Float32Array;
  /** count * DESCRIPTOR_WORDS, row-major. */
  descriptors: Uint32Array;
};

// ---------------------------------------------------------------------------
// Greyscale and pyramid
// ---------------------------------------------------------------------------

/** ITU-R BT.601 luma. Colour is deliberately discarded — see denominations.ts. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return { data: out, width, height };
}

/** Bilinear downscale. Box-filtering first would blur out the fine print ORB lives on. */
export function resize(src: Gray, width: number, height: number): Gray {
  const out = new Uint8Array(width * height);
  const xRatio = src.width / width;
  const yRatio = src.height / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, (y + 0.5) * yRatio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, (x + 0.5) * xRatio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = sx - x0;
      const a = src.data[y0 * src.width + x0];
      const b = src.data[y0 * src.width + x1];
      const c = src.data[y1 * src.width + x0];
      const d = src.data[y1 * src.width + x1];
      const top = a + (b - a) * fx;
      const bot = c + (d - c) * fx;
      out[y * width + x] = (top + (bot - top) * fy + 0.5) | 0;
    }
  }
  return { data: out, width, height };
}

function buildPyramid(base: Gray): { level: Gray; scale: number }[] {
  const levels: { level: Gray; scale: number }[] = [];
  let scale = 1;
  for (let i = 0; i < PYRAMID_LEVELS; i++) {
    const w = Math.round(base.width / scale);
    const h = Math.round(base.height / scale);
    if (w < MIN_LEVEL_SIZE || h < MIN_LEVEL_SIZE) break;
    levels.push({ level: i === 0 ? base : resize(base, w, h), scale });
    scale *= PYRAMID_SCALE;
  }
  return levels;
}

// ---------------------------------------------------------------------------
// FAST-9 corners
// ---------------------------------------------------------------------------

/** The 16-pixel Bresenham circle of radius 3, clockwise from straight up. */
const CIRCLE_X = [0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3, -3, -3, -2, -1];
const CIRCLE_Y = [-3, -3, -2, -1, 0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3];

/**
 * True when `mask` (16 bits, circular) contains FAST_ARC consecutive set bits.
 * Doubling the word lets one shift-and test cross the wrap point.
 */
function hasArc(mask: number): boolean {
  if (mask === 0) return false;
  let doubled = mask | (mask << 16);
  // AND the word with itself shifted, FAST_ARC-1 times: a bit survives only if
  // it starts a run that long.
  for (let i = 1; i < FAST_ARC; i++) doubled &= doubled >>> 1;
  return (doubled & 0xffffff) !== 0;
}

function fastCorners(g: Gray, threshold: number): { x: number; y: number }[] {
  const { data, width, height } = g;
  const out: { x: number; y: number }[] = [];
  const border = PATCH_RADIUS + 1; // Descriptor needs the full patch in-bounds.
  for (let y = border; y < height - border; y++) {
    for (let x = border; x < width - border; x++) {
      const p = data[y * width + x];
      const hi = p + threshold;
      const lo = p - threshold;

      // Cheap reject on the four compass points: a corner needs 9 contiguous,
      // so at least three of N/E/S/W must agree in the same direction.
      const n = data[(y - 3) * width + x];
      const s = data[(y + 3) * width + x];
      const e = data[y * width + x + 3];
      const w = data[y * width + x - 3];
      const brightCount = (n > hi ? 1 : 0) + (s > hi ? 1 : 0) + (e > hi ? 1 : 0) + (w > hi ? 1 : 0);
      const darkCount = (n < lo ? 1 : 0) + (s < lo ? 1 : 0) + (e < lo ? 1 : 0) + (w < lo ? 1 : 0);
      if (brightCount < 3 && darkCount < 3) continue;

      let bright = 0;
      let dark = 0;
      for (let i = 0; i < 16; i++) {
        const v = data[(y + CIRCLE_Y[i]) * width + x + CIRCLE_X[i]];
        if (v > hi) bright |= 1 << i;
        else if (v < lo) dark |= 1 << i;
      }
      if (hasArc(bright) || hasArc(dark)) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Harris response, used to RANK corners rather than to find them.
 *
 * FAST alone over-fires on edges, and an edge point has no repeatable
 * position along the edge — matching it produces a correspondence that is
 * geometrically meaningless. Harris is what discards those.
 */
function harrisScore(g: Gray, cx: number, cy: number): number {
  const { data, width } = g;
  let ixx = 0;
  let iyy = 0;
  let ixy = 0;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const i = (cy + dy) * width + cx + dx;
      const gx = data[i + 1] - data[i - 1];
      const gy = data[i + width] - data[i - width];
      ixx += gx * gx;
      iyy += gy * gy;
      ixy += gx * gy;
    }
  }
  const det = ixx * iyy - ixy * ixy;
  const trace = ixx + iyy;
  return det - HARRIS_K * trace * trace;
}

/** Keep the local maximum in a 3x3 neighbourhood; ORB's corners cluster otherwise. */
function suppressNonMax(
  corners: { x: number; y: number; score: number }[],
  width: number,
): { x: number; y: number; score: number }[] {
  const best = new Map<number, { x: number; y: number; score: number }>();
  for (const c of corners) best.set(c.y * width + c.x, c);
  return corners.filter((c) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const other = best.get((c.y + dy) * width + c.x + dx);
        if (other && other.score > c.score) return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

/**
 * Intensity centroid (Rosin). The vector from the patch centre to its centre
 * of mass defines an angle that rotates with the patch, which is what makes
 * the descriptor below rotation invariant — and rotation invariance is not
 * optional here: nobody hands a blind user a banknote the right way up.
 */
function centroidAngle(g: Gray, cx: number, cy: number): number {
  const { data, width } = g;
  let m01 = 0;
  let m10 = 0;
  const r2 = PATCH_RADIUS * PATCH_RADIUS;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const v = data[(cy + dy) * width + cx + dx];
      m10 += dx * v;
      m01 += dy * v;
    }
  }
  return Math.atan2(m01, m10);
}

// ---------------------------------------------------------------------------
// rBRIEF descriptor
// ---------------------------------------------------------------------------

/**
 * Deterministic Gaussian sampling pattern, sigma = patch/5 as in the BRIEF
 * paper. ORB's published pattern is greedily learned to decorrelate the bits,
 * which buys a few points of matching accuracy; a seeded Gaussian pattern is
 * the original formulation and works. Seeded so that a reference pack built
 * today matches a query descriptor built by a later build — an unseeded
 * pattern would silently invalidate every pack ever shipped.
 */
function buildPattern(): Int8Array {
  const pattern = new Int8Array(DESCRIPTOR_BITS * 4);
  let seed = 0x2545f491; // Fixed. Changing this invalidates every reference pack.
  const rand = () => {
    // xorshift32, then Box-Muller for the Gaussian.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  };
  const gauss = () => {
    const u = Math.max(1e-9, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const sigma = PATCH_RADIUS / 2.5;

  /**
   * Constrain to the DISK of radius PATCH_RADIUS, not the enclosing square.
   *
   * This is a bounds-safety requirement, not an aesthetic one. Rotating a
   * point at the square's corner (15, 15) sweeps it out to radius 21.2, past
   * the border fastCorners() reserves — so the descriptor would read outside
   * the image. In a Uint8Array that is `undefined`, every comparison against
   * it is false, and the affected bits silently pin to zero. Descriptors near
   * any edge would quietly degrade with no error anywhere. A disk is closed
   * under rotation, so the radius the border is sized for is the radius that
   * is ever read.
   */
  const intoDisk = (x: number, y: number): [number, number] => {
    const r = Math.hypot(x, y);
    if (r <= PATCH_RADIUS) return [Math.round(x), Math.round(y)];
    const k = PATCH_RADIUS / r;
    return [Math.round(x * k), Math.round(y * k)];
  };

  for (let i = 0; i < DESCRIPTOR_BITS; i++) {
    const [ax, ay] = intoDisk(gauss() * sigma, gauss() * sigma);
    const [bx, by] = intoDisk(gauss() * sigma, gauss() * sigma);
    pattern[i * 4 + 0] = ax;
    pattern[i * 4 + 1] = ay;
    pattern[i * 4 + 2] = bx;
    pattern[i * 4 + 3] = by;
  }
  return pattern;
}

const PATTERN = buildPattern();

/** PATTERN rotated into each of ANGLE_BINS orientations, computed once. */
const ROTATED: Int8Array[] = (() => {
  const all: Int8Array[] = [];
  for (let b = 0; b < ANGLE_BINS; b++) {
    const theta = (2 * Math.PI * b) / ANGLE_BINS;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const p = new Int8Array(DESCRIPTOR_BITS * 4);
    for (let i = 0; i < DESCRIPTOR_BITS; i++) {
      const ax = PATTERN[i * 4 + 0];
      const ay = PATTERN[i * 4 + 1];
      const bx = PATTERN[i * 4 + 2];
      const by = PATTERN[i * 4 + 3];
      // clampRadius absorbs the half-pixel that rounding can push past the
      // radius; without it a point at exactly PATCH_RADIUS can round to 16.
      const clamp = (v: number) => Math.max(-PATCH_RADIUS, Math.min(PATCH_RADIUS, Math.round(v)));
      p[i * 4 + 0] = clamp(cos * ax - sin * ay);
      p[i * 4 + 1] = clamp(sin * ax + cos * ay);
      p[i * 4 + 2] = clamp(cos * bx - sin * by);
      p[i * 4 + 3] = clamp(sin * bx + cos * by);
    }
    all.push(p);
  }
  return all;
})();

/**
 * Largest |coordinate| over every rotated pattern, and the bound the border in
 * fastCorners() must cover.
 *
 * Exported only so a test can assert it. The failure it guards is silent: a
 * pattern point outside the border reads past the end of a Uint8Array, which
 * yields `undefined`, compares false, and pins the bit to zero. Descriptors
 * near an edge would quietly degrade with nothing thrown anywhere.
 */
export function patternExtent(): number {
  let max = 0;
  for (const p of ROTATED) {
    for (let i = 0; i < p.length; i++) max = Math.max(max, Math.abs(p[i]));
  }
  return max;
}

/** The border fastCorners() reserves, so a test can compare the two. */
export const REQUIRED_BORDER = PATCH_RADIUS + 1;

function describe(g: Gray, cx: number, cy: number, angle: number, out: Uint32Array, at: number) {
  const { data, width } = g;
  let bin = Math.round((angle / (2 * Math.PI)) * ANGLE_BINS) % ANGLE_BINS;
  if (bin < 0) bin += ANGLE_BINS;
  const p = ROTATED[bin];
  for (let w = 0; w < DESCRIPTOR_WORDS; w++) {
    let word = 0;
    for (let b = 0; b < 32; b++) {
      const i = (w * 32 + b) * 4;
      const a = data[(cy + p[i + 1]) * width + cx + p[i + 0]];
      const c = data[(cy + p[i + 3]) * width + cx + p[i + 2]];
      if (a < c) word |= 1 << b;
    }
    out[at + w] = word >>> 0;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type DetectOptions = {
  /** Total across the pyramid. 500 is ample for a banknote's print density. */
  maxFeatures?: number;
  fastThreshold?: number;
};

/**
 * Detect keypoints and compute descriptors over a scale pyramid.
 *
 * Features are budgeted per level in proportion to level AREA, so a note
 * photographed close up does not spend the entire budget on level 0 and lose
 * the coarse structure that survives blur.
 */
export function detectAndCompute(image: Gray, options: DetectOptions = {}): Features {
  const maxFeatures = options.maxFeatures ?? 500;
  const threshold = options.fastThreshold ?? FAST_THRESHOLD;
  const pyramid = buildPyramid(image);

  const totalArea = pyramid.reduce((s, p) => s + p.level.width * p.level.height, 0);
  const picked: { x: number; y: number; angle: number; score: number; level: Gray; scale: number }[] = [];

  for (const { level, scale } of pyramid) {
    const budget = Math.max(1, Math.round((maxFeatures * level.width * level.height) / totalArea));
    const scored = fastCorners(level, threshold).map((c) => ({
      ...c,
      score: harrisScore(level, c.x, c.y),
    }));
    const kept = suppressNonMax(scored, level.width)
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, budget);
    for (const c of kept) {
      picked.push({
        x: c.x,
        y: c.y,
        angle: centroidAngle(level, c.x, c.y),
        score: c.score,
        level,
        scale,
      });
    }
  }

  const count = picked.length;
  const features: Features = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    angle: new Float32Array(count),
    score: new Float32Array(count),
    descriptors: new Uint32Array(count * DESCRIPTOR_WORDS),
  };
  for (let i = 0; i < count; i++) {
    const k = picked[i];
    // Back to ORIGINAL image coordinates: the homography in match.ts is fitted
    // in one frame of reference, and mixing level coordinates into it produces
    // a transform that fits nothing and rejects everything.
    features.x[i] = k.x * k.scale;
    features.y[i] = k.y * k.scale;
    features.angle[i] = k.angle;
    features.score[i] = k.score;
    describe(k.level, k.x, k.y, k.angle, features.descriptors, i * DESCRIPTOR_WORDS);
  }
  return features;
}

/** Hamming distance between two 256-bit descriptors held in flat arrays. */
export function hamming(a: Uint32Array, ai: number, b: Uint32Array, bi: number): number {
  let d = 0;
  for (let w = 0; w < DESCRIPTOR_WORDS; w++) {
    let v = (a[ai + w] ^ b[bi + w]) >>> 0;
    // Standard SWAR popcount.
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    v = (v + (v >>> 4)) & 0x0f0f0f0f;
    d += (v * 0x01010101) >>> 24;
  }
  return d;
}
