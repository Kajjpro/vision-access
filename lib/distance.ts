/**
 * Ground-plane distance from a pinhole camera with a KNOWN pitch.
 *
 * The pitch is the whole game. Simulated against an exact projection model with
 * the phone's real tilt varying between 5 and 40 degrees:
 *
 *   assumed 20deg pitch, focal 1.2H, 1/u approximation   median error  42%
 *   + focal from a real 69deg field of view              median error  39%
 *   + exact inversion instead of the approximation       median error  39%
 *   + pitch measured from the device                     median error   0%
 *
 * Correcting the focal length or the algebra barely moves the needle; guessing
 * the tilt is what destroys the estimate. So `pitchDeg` should come from
 * DeviceOrientation, not from a constant.
 *
 * Residual error once pitch is measured, from the unknowns that remain:
 *   pitch sensor off by 5deg    ~21%
 *   camera height off by 0.2m   ~14%
 */

/** Horizontal field of view of a typical phone rear camera, in degrees. */
export const DEFAULT_HFOV_DEG = 69;

/** Fallback tilt when the device exposes no orientation sensor. */
export const DEFAULT_PITCH_DEG = 20;

/** Beyond this the horizon term dominates and the estimate is noise. */
const MAX_DISTANCE_M = 20;

export type CameraPose = {
  frameWidth: number;
  frameHeight: number;
  /** Downward tilt of the camera, degrees. 0 is level. */
  pitchDeg: number;
  cameraHeightM: number;
};

/**
 * Pixels, from the horizontal field of view. Square pixels, so this focal
 * applies to both axes. The old `frameHeight * 1.2` implied a 55deg field of
 * view — about 24% too long for a phone, and focal scales distance linearly.
 */
export function focalPx(frameWidth: number, hfovDeg = DEFAULT_HFOV_DEG): number {
  return frameWidth / 2 / Math.tan((hfovDeg * Math.PI) / 360);
}

/**
 * A distance and whether the geometry behind it can be trusted.
 *
 * The ground-plane model measures where an object MEETS THE GROUND. That single
 * assumption is what breaks at close range: hold the camera 10 cm from a wall
 * and the wall's base is below the bottom edge of the frame, so the lowest
 * visible pixel is not the contact point at all. The maths still returns a
 * number — around a metre — and it is pure fabrication. For a blind user walking
 * into that wall, a confident "about one metre" is worse than saying nothing.
 *
 * `reliable` is the model admitting it is out of its depth, so callers can warn
 * without quoting a number they have no right to.
 */
export type DistanceEstimate = {
  /** Metres. Only meaningful as a number when `reliable`. */
  metres: number;
  reliable: boolean;
};

/** A base this close to the frame bottom is probably clipped by it. */
const BOTTOM_CLIP_FRACTION = 0.05;

/** Taller than this fraction of the frame and the object is too close to model. */
const TOO_CLOSE_HEIGHT_FRACTION = 0.6;

/** Taller than this, an unreliable estimate means VERY CLOSE — never far. */
const VERY_CLOSE_HEIGHT_FRACTION = 0.5;

/**
 * Stand-in distance for "too close to measure". Not a measurement — it exists so
 * an unmeasurable hazard still sorts ahead of every measured one, because the
 * thing filling the frame is the thing about to be walked into.
 */
export const VERY_CLOSE_M = 0.3;

/**
 * Image row where the ground plane vanishes. Below it the ground is visible and
 * has a distance; at or above it a ray never meets the ground, so any "distance"
 * there is meaningless rather than merely inaccurate.
 */
export function horizonY(pose: CameraPose): number {
  const f = focalPx(pose.frameWidth);
  return pose.frameHeight / 2 - f * Math.tan((pose.pitchDeg * Math.PI) / 180);
}

/**
 * Exact inversion of the pinhole projection of a ground point, including pitch.
 *
 * Unreliable when the base sits at or above the horizon (no ground intersection
 * exists), or within BOTTOM_CLIP_FRACTION of the frame bottom (the base is
 * probably cut off, so the lowest visible pixel is not the contact point).
 */
export function estimateDistance(boxBottomY: number, pose: CameraPose): DistanceEstimate {
  const f = focalPx(pose.frameWidth);
  const t = (pose.pitchDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);

  // Offset from the principal point, positive downward.
  const u = boxBottomY - pose.frameHeight / 2;

  const numerator = pose.cameraHeightM * (f * cos - u * sin);
  const denominator = u * cos + f * sin;

  // At or above the horizon: no ground intersection to measure from.
  if (denominator <= 0 || numerator <= 0 || boxBottomY <= horizonY(pose)) {
    return { metres: Infinity, reliable: false };
  }

  const clipped = boxBottomY >= pose.frameHeight * (1 - BOTTOM_CLIP_FRACTION);
  return {
    metres: Math.min(numerator / denominator, MAX_DISTANCE_M),
    reliable: !clipped,
  };
}

/**
 * Real-world heights, metres, with a fractional standard deviation.
 *
 * A size estimate (d = height * focal / boxHeightPx) is immune to both pitch
 * error and camera height, the two things that limit the ground-plane estimate.
 * Simulated against ground truth:
 *
 *   person (tight prior, whole box)   ground 18.5%   size  9.4%   fused  9.1%
 *   dog    (loose prior)              ground 18.5%   size 26.5%   fused 18.5%
 *   pole   (truncated 82% of frames)  ground 17.0%   size 70.3%
 *
 * So the size estimate only helps when the prior is tight AND the box is whole;
 * `relSd` carries that, and truncated boxes are rejected outright.
 *
 * Deliberately absent: pole, tree, wall, fence, bridge, stairs (routinely cut
 * off by the frame) and curb, hole, puddle, ice (flat on the ground, so their
 * pixel height means nothing). Those fall back to ground-plane alone.
 */
export const OBJECT_HEIGHTS: Record<string, { heightM: number; relSd: number }> = {
  person: { heightM: 1.7, relSd: 0.06 },
  child: { heightM: 1.1, relSd: 0.18 },
  dog: { heightM: 0.55, relSd: 0.3 },
  cat: { heightM: 0.3, relSd: 0.2 },
  horse: { heightM: 1.6, relSd: 0.1 },
  cow: { heightM: 1.45, relSd: 0.1 },
  car: { heightM: 1.5, relSd: 0.1 },
  bus: { heightM: 3.2, relSd: 0.12 },
  truck: { heightM: 3.0, relSd: 0.2 },
  motorcycle: { heightM: 1.3, relSd: 0.12 },
  bicycle: { heightM: 1.1, relSd: 0.1 },
  scooter: { heightM: 1.15, relSd: 0.15 },
  cart: { heightM: 1.0, relSd: 0.25 },
  door: { heightM: 2.05, relSd: 0.08 },
  window: { heightM: 1.2, relSd: 0.3 },
  bench: { heightM: 0.85, relSd: 0.15 },
  table: { heightM: 0.75, relSd: 0.12 },
  trash_can: { heightM: 1.0, relSd: 0.25 },
  traffic_light: { heightM: 3.5, relSd: 0.25 },
  sign: { heightM: 2.0, relSd: 0.3 },
  rock: { heightM: 0.3, relSd: 0.5 },
};

/** Measured relative error of the ground-plane estimate with a real pitch sensor. */
const GROUND_REL_SD = 0.185;

/** A box within this many pixels of an edge is treated as cut off. */
const TRUNCATION_MARGIN_PX = 3;

export type Box = { x: number; y: number; w: number; h: number };

/**
 * Best available distance for one detection: the ground-plane estimate, refined
 * by the object's apparent size when that can be trusted. Inverse-variance
 * weighted, so a loose prior barely moves the result and a tight one dominates.
 */
export function estimateObjectDistance(
  box: Box,
  className: string,
  pose: CameraPose,
): DistanceEstimate {
  const ground = estimateDistance(box.y + box.h, pose);

  const heightFraction = pose.frameHeight > 0 ? box.h / pose.frameHeight : 0;

  // THE CLOSE-RANGE BUG. An object filling the frame is centimetres away, but
  // its base is below the bottom edge, so the ground model reads the lowest
  // VISIBLE pixel as the contact point and returns a comfortable metre or so.
  // Size priors do not save it either: most things this close are truncated, and
  // the classes that fill a frame first — wall, fence, door — have no prior at
  // all. Nothing here can measure it, so nothing here pretends to; it is
  // reported as unmeasurably close and left for the caller to warn about.
  if (heightFraction > VERY_CLOSE_HEIGHT_FRACTION) {
    return { metres: VERY_CLOSE_M, reliable: false };
  }

  // Between the two thresholds the ground estimate is still usable, but an
  // object this large is past what the model was characterised on.
  if (heightFraction > TOO_CLOSE_HEIGHT_FRACTION) {
    return { metres: ground.metres, reliable: false };
  }

  const prior = OBJECT_HEIGHTS[className];
  if (!prior || box.h <= 0) return ground;

  // A cut-off box has a meaningless pixel height — this is the failure that
  // otherwise puts the size estimate 70% out.
  const truncated =
    box.y <= TRUNCATION_MARGIN_PX ||
    box.y + box.h >= pose.frameHeight - TRUNCATION_MARGIN_PX;
  if (truncated) return ground;

  const size = Math.min(
    (prior.heightM * focalPx(pose.frameWidth)) / box.h,
    MAX_DISTANCE_M,
  );

  // No ground intersection: the object is at or above the horizon, so it is not
  // standing on the surface being walked along — an overhead sign, a bridge, a
  // window. The size prior still yields a number and it is kept for ordering,
  // but it is NOT reliable: a ground-referenced warning about something that
  // never touches the ground is exactly the false confidence this change exists
  // to remove. announcementFor() leaves these silent.
  if (!Number.isFinite(ground.metres)) return { metres: size, reliable: false };

  const wSize = 1 / (prior.relSd * prior.relSd);
  const wGround = 1 / (GROUND_REL_SD * GROUND_REL_SD);
  const fused = (wSize * size + wGround * ground.metres) / (wSize + wGround);

  // Fusing does not launder a clipped base: it only reweights it.
  return { metres: fused, reliable: ground.reliable };
}

export type DistanceBucket = "urgent" | "near" | "mid" | "far";

/** Beyond this, nothing is announced. */
const SILENT_BEYOND_M = 5;

/** Below this, the distance is spoken as "very close" rather than a number. */
const VERY_CLOSE_BELOW_M = 1.5;

/**
 * Urgency, used only to pick a repeat window. An unmeasurable estimate is always
 * urgent: the only reason it is unmeasurable is that the object is too close to
 * model, and that is exactly when repeating matters.
 */
export function distanceBucket(estimate: DistanceEstimate): DistanceBucket {
  if (!estimate.reliable) {
    return estimate.metres <= VERY_CLOSE_M ? "urgent" : "far";
  }
  if (estimate.metres < VERY_CLOSE_BELOW_M) return "urgent";
  if (estimate.metres < 3) return "near";
  if (estimate.metres <= SILENT_BEYOND_M) return "mid";
  return "far";
}

/**
 * What to play for one detection, in order.
 *
 * `tone` is a synthesised urgent beep rather than a clip. It is not a TTS call —
 * CLAUDE.md forbids those at runtime, and this is an oscillator — and it leads
 * the sequence because at this range the user needs to stop before they need to
 * know what they are stopping for.
 *
 * A number is spoken ONLY when the estimate is reliable. When it is not, the
 * warning says "very close" and nothing else, because the alternative is quoting
 * a fabricated metre reading to someone who cannot check it.
 */
export type Announcement = { tone: boolean; clips: string[] };

const SILENT: Announcement = { tone: false, clips: [] };

export function announcementFor(
  estimate: DistanceEstimate,
  className: string,
): Announcement {
  if (!estimate.reliable) {
    // Unmeasurable AND filling the frame: the close-range case. Unmeasurable for
    // any other reason (above the horizon, far away) stays silent rather than
    // crying wolf.
    return estimate.metres <= VERY_CLOSE_M
      ? { tone: true, clips: ["very_close"] }
      : SILENT;
  }

  if (estimate.metres > SILENT_BEYOND_M) return SILENT;

  // The name is only spoken when it is known; an unnamed warning still beats a
  // wrong one, and beats silence by more.
  const name = className ? [className] : [];

  if (estimate.metres < VERY_CLOSE_BELOW_M) {
    return { tone: false, clips: [...name, "very_close"] };
  }

  // 1.5–5 m: "<name> approximately <n> metres". Rounded, and clamped to the
  // clips that exist, so a rounding edge can never ask for a missing file.
  const rounded = Math.min(5, Math.max(2, Math.round(estimate.metres)));
  return { tone: false, clips: [...name, "approx", `m_${rounded}`] };
}
