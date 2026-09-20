/**
 * Boxes and confidences turned into words a person can act on.
 *
 * Every number this module consumes comes from something that already exists —
 * `DEFAULT_HFOV_DEG` and `focalPx` from lib/distance.ts, the `reliable` flag
 * from `estimateObjectDistance`, the detector's own score. Nothing new is
 * measured here and no second geometry is invented; this is the translation
 * layer between the two, and it is where the honesty rules live.
 */

import { DEFAULT_HFOV_DEG, VERY_CLOSE_M, type CameraPose, type DistanceEstimate } from "../distance";

/**
 * Direction bands, in degrees off the camera axis.
 *
 * DERIVED FROM THE REAL FIELD OF VIEW, not chosen. At `DEFAULT_HFOV_DEG` = 69
 * the frame spans ±34.5°, so these three bands tile exactly what the camera can
 * see and nothing beyond it. `far` exists because the outer sixth of a 69°
 * frame is a genuinely different instruction — a rider must turn, not lean.
 */
export const AHEAD_DEG = 7;
export const SLIGHT_DEG = 20;

export type Direction =
  | "ahead"
  | "slight_left"
  | "slight_right"
  | "left"
  | "right"
  /**
   * Outside the frame entirely.
   *
   * NEVER rendered as "behind you". The camera cannot see behind and must not
   * imply that it can — a rider turning to face a thing the app never saw is a
   * failure with no recovery.
   */
  | "not_in_view";

/**
 * Horizontal angle of a box centre, degrees. Negative is left.
 *
 * `centreX` is a fraction of frame width, which is what the detector's pixel
 * coordinates divide down to. Uses the same field of view the distance model
 * uses, so a bearing and a distance can never disagree about which camera they
 * describe.
 */
export function bearingDeg(centreX: number, hfovDeg = DEFAULT_HFOV_DEG): number {
  return (centreX - 0.5) * hfovDeg;
}

export function directionFor(centreX: number, hfovDeg = DEFAULT_HFOV_DEG): Direction {
  if (!Number.isFinite(centreX)) return "not_in_view";
  if (centreX < 0 || centreX > 1) return "not_in_view";
  const a = bearingDeg(centreX, hfovDeg);
  const mag = Math.abs(a);
  if (mag <= AHEAD_DEG) return "ahead";
  if (mag <= SLIGHT_DEG) return a < 0 ? "slight_left" : "slight_right";
  return a < 0 ? "left" : "right";
}

/**
 * How a distance may be spoken, or that it may not be.
 *
 * The vocabulary is the constraint. Rendered metre clips run `m_2` … `m_5`
 * only, so 2–5 m is the entire range this app can say a number for. Below that
 * there is `very_close`, which carries no number by design. Above it there is
 * nothing, and the correct output is a direction with no distance — NOT a
 * rounded five.
 */
export type DistancePhrase =
  | { kind: "metres"; metres: 2 | 3 | 4 | 5 }
  | { kind: "very_close" }
  | { kind: "none" };

/** Beyond this the existing walk pipeline says nothing; this follows it. */
export const SPEAKABLE_MAX_M = 5.49;
/** Below this the estimate is spoken as "very close" rather than as a number. */
export const VERY_CLOSE_BELOW_M = 1.5;

export function distancePhrase(estimate: DistanceEstimate | null): DistancePhrase {
  if (!estimate) return { kind: "none" };

  /**
   * AN UNRELIABLE ESTIMATE NEVER BECOMES A NUMBER.
   *
   * `reliable: false` means the ground-plane assumption broke — the object's
   * base is below the frame, or it fills too much of it. The maths still returns
   * a figure and it is fabrication. The one thing it does tell us is that the
   * object is very close, because that is the only way the assumption breaks.
   */
  if (!estimate.reliable) {
    return estimate.metres <= VERY_CLOSE_M ? { kind: "very_close" } : { kind: "none" };
  }

  if (estimate.metres < VERY_CLOSE_BELOW_M) return { kind: "very_close" };
  if (estimate.metres > SPEAKABLE_MAX_M) return { kind: "none" };

  const rounded = Math.round(estimate.metres);
  if (rounded < 2 || rounded > 5) return { kind: "none" };
  return { kind: "metres", metres: rounded as 2 | 3 | 4 | 5 };
}

/**
 * Detector score turned into a register.
 *
 * The numbers are never spoken. A confidence score is a fact about the model,
 * not about the room, and a blind user has no way to calibrate one.
 */
export type Confidence = "high" | "medium" | "low" | "reject";

/** Below this the detector's own pipeline already discards the box. */
export const REJECT_BELOW = 0.4;
export const MEDIUM_BELOW = 0.75;
export const HIGH_AT = 0.75;
export const LOW_BELOW = 0.55;

export function confidenceFor(score: number): Confidence {
  if (!Number.isFinite(score) || score < REJECT_BELOW) return "reject";
  if (score < LOW_BELOW) return "low";
  if (score < HIGH_AT) return "medium";
  return "high";
}

/** Fraction of frame width at the box centre. */
export function centreXOf(box: { x: number; w: number }, pose: CameraPose): number {
  if (!pose.frameWidth) return 0.5;
  return (box.x + box.w / 2) / pose.frameWidth;
}

/**
 * Ranking for "there are three benches, the closest is…".
 *
 * Closest first, but a reliable estimate always outranks an unreliable one at
 * the same nominal distance — an unreliable 2 m is not a measurement, and
 * letting it win would put a fabricated number at the top of the answer.
 * Centredness breaks remaining ties, because the object the camera is pointed at
 * is the one the user means.
 */
export function rankCandidates<T extends { distance: DistanceEstimate | null; centreX: number; score: number }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const ar = a.distance?.reliable ?? false;
    const br = b.distance?.reliable ?? false;
    if (ar !== br) return ar ? -1 : 1;

    const am = a.distance?.metres ?? Number.POSITIVE_INFINITY;
    const bm = b.distance?.metres ?? Number.POSITIVE_INFINITY;
    if (Math.abs(am - bm) > 0.25) return am - bm;

    const ac = Math.abs(a.centreX - 0.5);
    const bc = Math.abs(b.centreX - 0.5);
    if (Math.abs(ac - bc) > 0.02) return ac - bc;

    return b.score - a.score;
  });
}
