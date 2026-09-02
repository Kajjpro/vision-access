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
  /**
   * Whether `pitchDeg` was MEASURED or is the fallback constant.
   *
   * This is the difference between a ground-plane estimate with ~0% median
   * error and one with 42% (see the header). When it is false the ground
   * estimate is not merely noisier, it is unusable — so the size prior, which
   * does not depend on pitch at all, becomes the only honest source of a
   * number, and classes without a prior get no number at all.
   */
  pitchMeasured: boolean;
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
  dog: { heightM: 0.55, relSd: 0.3 },
  cat: { heightM: 0.3, relSd: 0.2 },
  horse: { heightM: 1.6, relSd: 0.1 },
  cow: { heightM: 1.45, relSd: 0.1 },
  car: { heightM: 1.5, relSd: 0.1 },
  bus: { heightM: 3.2, relSd: 0.12 },
  truck: { heightM: 3.0, relSd: 0.2 },
  motorcycle: { heightM: 1.3, relSd: 0.12 },
  bicycle: { heightM: 1.1, relSd: 0.1 },
  door: { heightM: 2.05, relSd: 0.08 },
  bench: { heightM: 0.85, relSd: 0.15 },
  table: { heightM: 0.75, relSd: 0.12 },
  trash_can: { heightM: 1.0, relSd: 0.25 },
  rock: { heightM: 0.3, relSd: 0.5 },
};

// Deliberately absent: pole, tree, wall, fence, stairs, curb, hole, ice and the
// two overhead classes. A prior is only useful when the real-world height is
// actually constrained, and none of theirs are — a "tree" is 2 m or 20 m. They
// fall back to the ground-plane estimate alone, which is the honest answer.
//
// Most of those classes are also gone from the detector entirely: see
// lib/coco.ts. The entries are kept because the priors are still correct if a
// vocabulary that contains them ever comes back.

/**
 * Real-world WIDTHS, metres, for the few classes whose width is actually
 * constrained. Same pinhole relation as the height prior, on the other axis.
 *
 * THE CASE THIS EXISTS FOR is close range, which is both the most dangerous
 * range and the one where the other two estimators fail together. Inside about
 * three metres a person's box runs off the top or bottom of the frame, so the
 * height prior is rejected as truncated; their feet are below the bottom edge,
 * so the ground plane has no contact point to measure from and returns
 * `reliable: false`. The app then falls back to "маш ойрхон" with no number at
 * all — correct, and less than it could say. A person's shoulders stay wholly
 * in frame long after their head and feet have left it, and 0.5 m across is a
 * real measurement.
 *
 * WHY THIS LIST IS SO SHORT, and why vehicles are not on it. Width is only
 * constrained for objects that look roughly the same from every angle. A car is
 * 1.8 m across and 4.5 m long, so its apparent width swings by a factor of two
 * with viewing angle and a "prior" would be a coin flip dressed as a
 * measurement — precisely the fabricated precision CLAUDE.md forbids. Same for
 * every animal. A person is not symmetric either (shoulders 0.5 m, front-to-
 * back 0.3 m), which is what the wide relSd is paying for: it makes this a
 * weak vote that the fusion below can override, not an authority.
 *
 * KNOWN BIAS, and why it is not corrected. `widthM * focal / box.w` recovers
 * the depth along the OPTICAL AXIS, not the distance along the ground, and with
 * the camera pitched down those differ by (cameraHeight - objectHeight) * sin
 * of the pitch. Measured against an exact projection: a person one metre away
 * reads 1.13 m at pitch 20, about 13% high — and high means under-warning.
 *
 * Correcting it needs the height at which the width was actually sampled, and
 * that is precisely what is unknown in the case this prior exists for: when the
 * box is vertically truncated, the visible band is whatever the frame caught.
 * Assuming mid-height would be wrong in the other direction (a phone held at
 * 1.4 m and tilted down frames a close person around the chest, where the
 * correction is near zero). So the error stays inside relSd rather than being
 * traded for a confident guess about which part of the body is in shot.
 */
export const OBJECT_WIDTHS: Record<string, { widthM: number; relSd: number }> = {
  person: { widthM: 0.5, relSd: 0.25 },
  // Seating: COCO `chair` and `bench` both arrive here as "bench". Chairs are
  // ~0.5 m across, benches 1.5 m and up, so the spread is deliberately huge —
  // this is barely more than a sanity check, and the fusion weights it that way.
  bench: { widthM: 0.8, relSd: 0.5 },
};

/** Measured relative error of the ground-plane estimate with a real pitch sensor. */
const GROUND_REL_SD = 0.185;

/** A box within this many pixels of an edge is treated as cut off. */
const TRUNCATION_MARGIN_PX = 3;

export type Box = { x: number; y: number; w: number; h: number };

/** A box touching the top or bottom edge has a meaningless pixel height. */
function isTruncatedY(box: Box, pose: CameraPose): boolean {
  return (
    box.y <= TRUNCATION_MARGIN_PX ||
    box.y + box.h >= pose.frameHeight - TRUNCATION_MARGIN_PX
  );
}

/**
 * A box touching the left or right edge has a meaningless pixel width.
 *
 * Separate from the vertical check rather than folded into one "is it cut off"
 * test, because the two axes fail independently and that independence is the
 * whole value of having both. The common close-range box is truncated
 * vertically and whole horizontally — one estimator dies, the other survives.
 * A single combined check would throw away the survivor too.
 */
function isTruncatedX(box: Box, pose: CameraPose): boolean {
  return (
    box.x <= TRUNCATION_MARGIN_PX ||
    box.x + box.w >= pose.frameWidth - TRUNCATION_MARGIN_PX
  );
}

/** One independent opinion about the distance, with its relative uncertainty. */
type Vote = { metres: number; relSd: number };

/**
 * Inverse-variance fusion. A tight prior dominates, a loose one barely moves
 * the answer, and any number of votes combine the same way.
 *
 * Weighting on (relSd * metres) rather than relSd alone is what makes mixing
 * axes legitimate: these are RELATIVE uncertainties, so a 25% error at eight
 * metres is two metres of doubt and the same 25% at one metre is 25 cm. Without
 * converting to absolute terms first, a distant loose estimate would be
 * weighted as if it were as sharp as a near one.
 */
function fuse(votes: Vote[]): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const vote of votes) {
    if (!Number.isFinite(vote.metres) || vote.metres <= 0) continue;
    const sd = vote.relSd * vote.metres;
    if (!(sd > 0)) continue;
    const weight = 1 / (sd * sd);
    numerator += weight * vote.metres;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Best available distance for one detection: up to three independent estimates
 * — the ground plane, the object's apparent height, and its apparent width —
 * combined by inverse variance.
 *
 * They fail in DIFFERENT circumstances, which is the entire point of running
 * more than one. The ground plane needs a measured pitch and a visible contact
 * point. The height prior needs a vertically whole box. The width prior needs a
 * horizontally whole one. Close range breaks the first two together and leaves
 * the third, which is why a person two metres away can now be given a distance
 * instead of an unqualified "very close".
 */
export function estimateObjectDistance(
  box: Box,
  className: string,
  pose: CameraPose,
): DistanceEstimate {
  const ground = estimateDistance(box.y + box.h, pose);

  const heightFraction = pose.frameHeight > 0 ? box.h / pose.frameHeight : 0;
  const focal = focalPx(pose.frameWidth);

  const prior = OBJECT_HEIGHTS[className];
  const widthPrior = OBJECT_WIDTHS[className];

  /**
   * Can the object be measured from its own apparent size right now?
   *
   * Requires a known real height and a WHOLE box: a box running off an edge
   * has a pixel height that means nothing, which is the failure that puts the
   * size estimate 70% out on truncated poles.
   */
  const measurableBySize = Boolean(prior) && box.h > 0 && !isTruncatedY(box, pose);

  /** The same test on the other axis, for the width prior. */
  const measurableByWidth = Boolean(widthPrior) && box.w > 0 && !isTruncatedX(box, pose);

  const widthMetres = measurableByWidth
    ? Math.min((widthPrior!.widthM * focal) / box.w, MAX_DISTANCE_M)
    : null;

  // THE CLOSE-RANGE BUG. An object filling the frame is centimetres away, but
  // its base is below the bottom edge, so the ground model reads the lowest
  // VISIBLE pixel as the contact point and returns a comfortable metre or so.
  //
  // Gated on `measurableBySize` — WITHOUT that gate this fires far too early
  // and eats the normal case. Frame fraction is not a proxy for closeness
  // unless the object's real height is unknown: a 1.7 m person at THREE
  // METRES already fills 55% of a 480px frame, so a flat >50% rule announced
  // every pedestrian inside 3.3 m as "very close" with no distance at all,
  // which is most of the pedestrians worth describing. When the whole object
  // is visible and its height is known, its size measures it perfectly well
  // however much of the frame it occupies.
  // Widened from `!measurableBySize` to "no size measurement on EITHER axis".
  // A horizontally-whole person whose head has left the frame is measurable by
  // width, and calling that "very close, no number" would be discarding a
  // perfectly good reading — which is the same mistake this guard's own
  // comment warns against making with frame fraction.
  const sizeVotes: Vote[] = [];
  if (measurableBySize) {
    sizeVotes.push({
      metres: Math.min((prior!.heightM * focal) / box.h, MAX_DISTANCE_M),
      relSd: prior!.relSd,
    });
  }
  if (widthMetres !== null) {
    sizeVotes.push({ metres: widthMetres, relSd: widthPrior!.relSd });
  }

  if (sizeVotes.length === 0) {
    if (heightFraction > VERY_CLOSE_HEIGHT_FRACTION) {
      return { metres: VERY_CLOSE_M, reliable: false };
    }
    // Between the two thresholds the ground estimate is still usable, but an
    // object this large is past what the model was characterised on.
    if (heightFraction > TOO_CLOSE_HEIGHT_FRACTION) {
      return { metres: ground.metres, reliable: false };
    }
  }

  // NO MEASURED PITCH. The ground estimate is a 42%-error guess, so it is not
  // fused, not reported, and not quietly used — but staying silent about
  // distance entirely would be throwing away a perfectly good measurement.
  //
  // The size estimates never touch pitch: they are the object's real height or
  // width over its pixel height or width. For a person that is ~9.4% error,
  // BETTER than the ground plane manages even with a working sensor. So on a
  // phone with no orientation sensor (or with the permission refused) the app
  // still says "person, approximately three metres" for anything it has a
  // prior for, and falls back to naming the object alone for anything it does
  // not.
  if (!pose.pitchMeasured) {
    const sized = fuse(sizeVotes);
    if (sized === null) return { metres: ground.metres, reliable: false };
    return { metres: sized, reliable: true };
  }

  // No ground intersection: the object is at or above the horizon, so it is not
  // standing on the surface being walked along — an overhead sign, a bridge, a
  // window. The size priors still yield a number and it is kept for ordering,
  // but it is NOT reliable: a ground-referenced warning about something that
  // never touches the ground is exactly the false confidence this change exists
  // to remove. announcementFor() leaves these silent.
  if (!Number.isFinite(ground.metres) || ground.metres <= 0) {
    const sized = fuse(sizeVotes);
    return sized === null ? ground : { metres: sized, reliable: false };
  }

  // A CLIPPED BASE IS EXCLUDED, not merely downweighted — but only when
  // something else can carry the estimate.
  //
  // Inverse-variance fusion assumes its inputs are unbiased and disagree only
  // by noise. A clipped base breaks that assumption in one direction, and it is
  // the dangerous one. The object's true contact point is BELOW the frame, so
  // the lowest visible pixel is always higher in the image than the real one —
  // and higher in the image means further away. Measured, at pitch 20 with the
  // camera at 1.4 m: something one metre away reads as 1.60 m. The error is
  // systematic under-warning, so averaging does not cancel it, it imports it.
  //
  // With no size vote to fall back on it is still the only thing there is, and
  // the `reliable: false` below is what keeps it from being spoken as a figure.
  // Captured BEFORE the push below, or the reliability test at the end reads
  // the ground vote it just added as evidence that a size prior existed.
  const hadSizeVote = sizeVotes.length > 0;
  if (ground.reliable || !hadSizeVote) {
    sizeVotes.push({ metres: ground.metres, relSd: GROUND_REL_SD });
  }

  const fused = fuse(sizeVotes);
  if (fused === null) return ground;

  // Reliability follows whether ANY unbiased estimator contributed. The size
  // priors do not depend on the base being visible, so a clipped base no longer
  // condemns a person whose shoulders are wholly in frame to a numberless "маш
  // ойрхон" — which was the specific close-range case that had the least to say
  // exactly where saying something mattered most.
  return { metres: fused, reliable: ground.reliable || hadSizeVote };
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
