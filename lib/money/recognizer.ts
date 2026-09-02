/**
 * Recognise one frame against the reference pack.
 *
 * Everything here is arranged so that the ANSWER IS NULL unless the evidence
 * is positive. CLAUDE.md is unambiguous that a wrong banknote value causes
 * real harm, and unlike a missed obstacle warning, a wrong denomination is
 * not a silence the user can compensate for — it is an assertion they will
 * act on at a till, and one they have no way to check.
 *
 * Two independent gates, both of which must pass:
 *
 *   ABSOLUTE — the winner needs MIN_INLIERS geometrically consistent
 *   correspondences. This is what rejects "not a banknote at all": a table, a
 *   receipt, a hand. Nothing in an unrelated scene produces twenty print
 *   features agreeing on one homography.
 *
 *   RELATIVE — the winner must beat the best OTHER denomination by
 *   MARGIN. This is what rejects the dangerous case, which is not "no note"
 *   but "the wrong note". Tögrög notes share a design language, so a genuine
 *   5000 will always score somewhat against the 1000 reference. A clear
 *   reading separates them by a wide gap; a fold, a glare or a bad angle
 *   compresses that gap, and a compressed gap is precisely when the app
 *   should decline to answer.
 *
 * Front and back of the SAME note reinforce rather than compete — they are
 * two views of one fact.
 */
import { detectAndCompute, toGray, type Features } from "./orb";
import { findHomography, matchFeatures, type Homography } from "./match";
import { decodePack, type DecodedReference, type ReferencePack } from "./refs";
import { DENOMINATIONS, type Denomination, type Side } from "./denominations";

/**
 * Minimum geometrically consistent correspondences to name a note at all.
 *
 * UNCALIBRATED. This is a defensible starting value, not a measured one: below
 * ~12 inliers RANSAC starts finding structure in genuinely unrelated images,
 * and 18 sits clear of that with margin. It MUST be re-derived against real
 * photographs of real worn notes before anyone relies on this in a shop —
 * see NOTES.md. Tune it with scripts/eval-money.ts, which reports the
 * false-naming rate that actually matters, not overall accuracy.
 */
export const MIN_INLIERS = 18;

/** How far ahead of the next denomination the winner must be. */
export const MARGIN = 1.6;

/** Long edge the frame is scaled to before detection. Enough for print detail. */
const WORKING_SIZE = 720;

export type Recognition = {
  denomination: Denomination;
  side: Side;
  inliers: number;
  /** Best inlier count among the OTHER denominations. The margin's denominator. */
  runnerUpInliers: number;
  runnerUp: Denomination | null;
  homography: Homography | null;
};

export type RecognizeDebug = {
  /** Per-denomination best inlier count, for the on-screen debug panel. */
  scores: { denomination: Denomination; inliers: number; side: Side }[];
  features: number;
  elapsedMs: number;
  /** Why null was returned, in words. There is no console on a phone. */
  reason: string;
};

export type RecognizeOutcome = {
  result: Recognition | null;
  debug: RecognizeDebug;
};

export class Recognizer {
  private references: DecodedReference[];

  private constructor(references: DecodedReference[]) {
    this.references = references;
  }

  /** Throws PackError on an incompatible or incomplete pack — never degrades quietly. */
  static fromPack(pack: ReferencePack): Recognizer {
    return new Recognizer(decodePack(pack));
  }

  /** Reference entries, for callers that want to report what is loaded. */
  get size(): number {
    return this.references.length;
  }

  recognize(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): RecognizeOutcome {
    const started = Date.now();
    const gray = toGray(rgba, width, height);
    const query = detectAndCompute(gray, { maxFeatures: 600 });

    const scores: { denomination: Denomination; inliers: number; side: Side }[] = [];
    let best: Recognition | null = null;

    for (const ref of this.references) {
      const matches = matchFeatures(query, ref.features);
      const { inliers, homography } = findHomography(
        matches,
        query,
        ref.features,
        ref.width,
        ref.height,
        width,
        height,
      );
      scores.push({ denomination: ref.denomination, inliers, side: ref.side });
      if (!best || inliers > best.inliers) {
        best = {
          denomination: ref.denomination,
          side: ref.side,
          inliers,
          runnerUpInliers: 0,
          runnerUp: null,
          homography,
        };
      }
    }

    const debug: RecognizeDebug = {
      scores: scores.sort((a, b) => b.inliers - a.inliers),
      features: query.count,
      elapsedMs: Date.now() - started,
      reason: "",
    };

    if (!best || best.inliers < MIN_INLIERS) {
      debug.reason = `best ${best?.inliers ?? 0} inliers < ${MIN_INLIERS} required`;
      return { result: null, debug };
    }

    // The runner-up is the best score among OTHER denominations. The same
    // note's other face is not a competitor.
    let runnerUp: Denomination | null = null;
    let runnerUpInliers = 0;
    for (const s of scores) {
      if (s.denomination === best.denomination) continue;
      if (s.inliers > runnerUpInliers) {
        runnerUpInliers = s.inliers;
        runnerUp = s.denomination;
      }
    }

    if (runnerUpInliers > 0 && best.inliers < runnerUpInliers * MARGIN) {
      debug.reason =
        `${best.denomination} (${best.inliers}) did not clear ${runnerUp} ` +
        `(${runnerUpInliers}) by ${MARGIN}x`;
      return { result: null, debug };
    }

    debug.reason = `${best.denomination} at ${best.inliers} inliers`;
    return {
      result: { ...best, runnerUp, runnerUpInliers },
      debug,
    };
  }
}

/** Scale so the long edge is WORKING_SIZE, preserving aspect. */
export function workingSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= WORKING_SIZE) return { width, height };
  const k = WORKING_SIZE / longest;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

/** Denominations in pack order, for a caller building a debug table. */
export const ALL_DENOMINATIONS = DENOMINATIONS;

export type { Features };
