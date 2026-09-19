/**
 * Descriptor matching and geometric verification.
 *
 * Given ORB features from a camera frame and from one reference note, decide
 * whether the frame contains that note — and, far more importantly, be
 * willing to say no.
 *
 * WHY GEOMETRY AND NOT A CLASSIFIER SCORE
 * ---------------------------------------
 * CLAUDE.md: "prefer returning null over guessing. A wrong bus number or
 * banknote value causes real harm." A softmax head cannot honour that. It is
 * normalised over the classes it was given, so shown a bus ticket, a napkin
 * or a 20000₮ note in bad light it still emits a distribution summing to one,
 * and the largest entry is as confident-looking on nonsense as on a real note.
 * Thresholding it only moves the point at which it lies.
 *
 * Inlier counting has no such floor. The question it asks is "do N local
 * patches agree on ONE projective transform", and for a wrong note, a
 * different object, or an empty table the honest answer is a handful of
 * random correspondences that fit no consistent homography. Rejection is the
 * default state, not a tuned threshold on top of a confident guess.
 *
 * The pipeline, each stage able to reject outright:
 *
 *   1. ratio test      — an ambiguous descriptor is discarded, not guessed
 *   2. cross-check     — the match must be mutual
 *   3. RANSAC          — the survivors must agree on one homography
 *   4. quad sanity     — that homography must map a rectangle to a plausible
 *                        quadrilateral, not to a bow tie or a sliver
 *   5. margin          — the winner must beat the runner-up by a real gap
 */
import { DESCRIPTOR_WORDS, hamming, type Features } from "./orb";

/**
 * Lowe's ratio. A descriptor whose best and second-best reference match are
 * within this factor is AMBIGUOUS and is thrown away — banknotes are covered
 * in repeated guilloche patterning that produces exactly this situation, and
 * keeping such a match is how one note's ornament votes for another's.
 */
const RATIO = 0.78;

/** Absolute Hamming ceiling, out of 256 bits. Beyond this the pair is noise. */
const MAX_DISTANCE = 96;

/** RANSAC iterations. Cheap enough at this scale to just run the ceiling. */
const RANSAC_ITERATIONS = 1500;

/** Reprojection tolerance as a fraction of the query image's larger side. */
const INLIER_FRACTION = 0.012;

/** Above any possible Hamming distance (max 256) and safely inside an Int32Array. */
const UNMATCHABLE = 1 << 20;

export type Match = { queryIndex: number; refIndex: number; distance: number };

export type Homography = Float64Array; // 9 entries, row-major, h[8] === 1.

export type MatchResult = {
  /** Correspondences consistent with one projective transform. The score. */
  inliers: number;
  /** Correspondences that survived ratio + cross-check, before geometry. */
  candidates: number;
  homography: Homography | null;
};

// ---------------------------------------------------------------------------
// Descriptor matching
// ---------------------------------------------------------------------------

/**
 * Mutual nearest neighbours passing the ratio test.
 *
 * Brute force. With ~500 features a side this is ~250k distance evaluations
 * of 8 XORs each, which is single-digit milliseconds — a k-d tree does not
 * help on binary descriptors anyway, and an approximate index would trade
 * exactly the certainty this file exists to protect.
 */
export function matchFeatures(query: Features, reference: Features): Match[] {
  if (query.count === 0 || reference.count === 0) return [];

  // Reference -> best query, for the cross-check.
  //
  // Seeded with UNMATCHABLE, not Number.MAX_SAFE_INTEGER: that constant is
  // 2^53-1, which truncates to -1 inside an Int32Array, and a distance floor
  // of -1 is one no real distance can beat. Every cross-check then fails and
  // the matcher returns nothing at all, for every input, including an image
  // compared against itself.
  const refBest = new Int32Array(reference.count).fill(-1);
  const refBestDist = new Int32Array(reference.count).fill(UNMATCHABLE);

  const provisional: Match[] = [];
  for (let q = 0; q < query.count; q++) {
    const qi = q * DESCRIPTOR_WORDS;
    let best = UNMATCHABLE;
    let second = UNMATCHABLE;
    let bestIndex = -1;
    for (let r = 0; r < reference.count; r++) {
      const d = hamming(query.descriptors, qi, reference.descriptors, r * DESCRIPTOR_WORDS);
      if (d < best) {
        second = best;
        best = d;
        bestIndex = r;
      } else if (d < second) {
        second = d;
      }
      if (d < refBestDist[r]) {
        refBestDist[r] = d;
        refBest[r] = q;
      }
    }
    if (bestIndex < 0 || best > MAX_DISTANCE) continue;
    // An ambiguous descriptor is dropped rather than resolved. On repeated
    // patterning the second-best is often the true match, and picking either
    // one is a coin flip dressed as a decision.
    if (second !== UNMATCHABLE && best > RATIO * second) continue;
    provisional.push({ queryIndex: q, refIndex: bestIndex, distance: best });
  }

  // Cross-check: the reference feature must also choose this query feature.
  return provisional.filter((m) => refBest[m.refIndex] === m.queryIndex);
}

// ---------------------------------------------------------------------------
// Homography
// ---------------------------------------------------------------------------

/**
 * Exact homography through 4 correspondences.
 *
 * Fixes h33 = 1 and solves the resulting 8x8 system by Gaussian elimination
 * with partial pivoting. Returns null when the system is singular, which is
 * what three collinear sample points produce — a genuinely common draw, and
 * one that yields a transform mapping the whole plane onto a line.
 */
export function homographyFrom4(
  src: { x: number; y: number }[],
  dst: { x: number; y: number }[],
): Homography | null {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }

  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) return null; // Degenerate sample.
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const p = a[col][col];
    for (let c = col; c < 9; c++) a[col][c] /= p;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let c = col; c < 9; c++) a[r][c] -= f * a[col][c];
    }
  }

  const h = new Float64Array(9);
  for (let i = 0; i < 8; i++) h[i] = a[i][8];
  h[8] = 1;
  return h;
}

export function project(h: Homography, x: number, y: number): { x: number; y: number } {
  const w = h[6] * x + h[7] * y + h[8];
  if (Math.abs(w) < 1e-12) return { x: Infinity, y: Infinity };
  return {
    x: (h[0] * x + h[1] * y + h[2]) / w,
    y: (h[3] * x + h[4] * y + h[5]) / w,
  };
}

/**
 * Is this homography a physically plausible view of a flat rectangle?
 *
 * RANSAC will happily return a transform that four coincidentally-agreeing
 * outliers support, and such a transform is usually visibly absurd: it folds
 * the note into a bow tie, inverts it, or squashes it to a sliver. A note
 * genuinely in frame maps its corners to a convex quadrilateral of sensible
 * area. This check costs four projections and rejects a whole family of
 * confident nonsense.
 */
export function isPlausibleQuad(
  h: Homography,
  refWidth: number,
  refHeight: number,
  queryWidth: number,
  queryHeight: number,
): boolean {
  const corners = [
    project(h, 0, 0),
    project(h, refWidth, 0),
    project(h, refWidth, refHeight),
    project(h, 0, refHeight),
  ];
  if (corners.some((c) => !Number.isFinite(c.x) || !Number.isFinite(c.y))) return false;

  // Convex, and consistently wound. Mixed signs mean the quad self-intersects.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false; // Collinear corner.
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }

  // Shoelace area, as a fraction of the frame. A note occupying under 2% of
  // the frame is too small to have been read reliably; over 4x the frame means
  // the transform has run away.
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;
  const frame = queryWidth * queryHeight;
  if (area < frame * 0.02 || area > frame * 4) return false;

  // Reject extreme foreshortening: opposite sides differing by more than 5x
  // is a viewing angle at which the print is not legible anyway.
  const side = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(b.x - a.x, b.y - a.y);
  const top = side(corners[0], corners[1]);
  const bottom = side(corners[3], corners[2]);
  const left = side(corners[0], corners[3]);
  const right = side(corners[1], corners[2]);
  const ratio = (p: number, q: number) => Math.max(p, q) / Math.max(1e-6, Math.min(p, q));
  return ratio(top, bottom) <= 5 && ratio(left, right) <= 5;
}

/**
 * RANSAC over the matches, returning the best geometrically consistent set.
 *
 * Deterministic by construction: the PRNG is seeded from the match count, so
 * the same frame and the same pack always produce the same answer. A
 * recogniser that returns a different denomination on a retry of an identical
 * frame is not one anybody can build trust in, and trust is the whole product.
 */
export function findHomography(
  matches: Match[],
  query: Features,
  reference: Features,
  refWidth: number,
  refHeight: number,
  queryWidth: number,
  queryHeight: number,
): MatchResult {
  const result: MatchResult = { inliers: 0, candidates: matches.length, homography: null };
  if (matches.length < 4) return result;

  const tolerance = INLIER_FRACTION * Math.max(queryWidth, queryHeight);
  const tolSq = tolerance * tolerance;

  let seed = (matches.length * 2654435761) >>> 0;
  const nextIndex = (n: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % n;
  };

  let bestInliers = 0;
  let bestH: Homography | null = null;

  for (let iter = 0; iter < RANSAC_ITERATIONS; iter++) {
    // Four distinct correspondences.
    const pick: number[] = [];
    let guard = 0;
    while (pick.length < 4 && guard++ < 40) {
      const i = nextIndex(matches.length);
      if (!pick.includes(i)) pick.push(i);
    }
    if (pick.length < 4) break;

    const src = pick.map((i) => ({
      x: reference.x[matches[i].refIndex],
      y: reference.y[matches[i].refIndex],
    }));
    const dst = pick.map((i) => ({
      x: query.x[matches[i].queryIndex],
      y: query.y[matches[i].queryIndex],
    }));

    const h = homographyFrom4(src, dst);
    if (!h) continue;
    if (!isPlausibleQuad(h, refWidth, refHeight, queryWidth, queryHeight)) continue;

    let inliers = 0;
    for (const m of matches) {
      const p = project(h, reference.x[m.refIndex], reference.y[m.refIndex]);
      const dx = p.x - query.x[m.queryIndex];
      const dy = p.y - query.y[m.queryIndex];
      if (dx * dx + dy * dy <= tolSq) inliers++;
    }
    if (inliers > bestInliers) {
      bestInliers = inliers;
      bestH = h;
    }
  }

  result.inliers = bestInliers;
  result.homography = bestH;
  return result;
}
