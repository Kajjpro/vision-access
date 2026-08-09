/**
 * Spatial reasoning over tracked objects: what is overhead, and where the gap is.
 *
 * Both answer questions the detector does not: it reports boxes, not whether
 * something is above head height, and never where there ISN'T anything.
 */
import { horizonY } from "./distance";
import type { CameraPose } from "./distance";
import type { Track } from "./tracker";

/**
 * A box entirely above the horizon has no ground contact — it is not standing
 * on the surface being walked along, it is hanging over it.
 *
 * This is the hazard a white cane cannot find. The cane sweeps the ground and
 * passes straight under a branch, an open tailgate, scaffolding, a low sign;
 * the user's head finds it instead. It is the single strongest reason for a
 * camera to be involved at all, and it is exactly the case lib/distance.ts
 * refuses to measure — no ground intersection means no ground-plane distance.
 */
const OVERHEAD_MIN_HEIGHT_FRAC = 0.12;

/**
 * Whether a track is an overhead hazard worth warning about.
 *
 * Two conditions, both needed. Entirely above the horizon, so it cannot be
 * something standing on the ground further away. And visually large, which at
 * a fixed focal length is the only proxy for "close" available when there is no
 * ground contact to measure from — a distant overhead sign is a small box and
 * is correctly ignored.
 */
export function isOverhead(track: Track, pose: CameraPose): boolean {
  if (pose.frameHeight <= 0) return false;
  const base = track.y + track.h;
  const heightFraction = track.h / pose.frameHeight;
  return base < horizonY(pose) && heightFraction >= OVERHEAD_MIN_HEIGHT_FRAC;
}

export type Direction = "left" | "ahead" | "right";

/** Thirds of the frame. `ahead` is the walking corridor. */
const COLUMNS: { dir: Direction; min: number; max: number }[] = [
  { dir: "left", min: 0, max: 1 / 3 },
  { dir: "ahead", min: 1 / 3, max: 2 / 3 },
  { dir: "right", min: 2 / 3, max: 1 },
];

/**
 * How far away the nearest thing in a column is. Infinity when the column is
 * empty — nothing detected there is the best possible news.
 */
function nearestIn(tracks: Track[], pose: CameraPose, dir: Direction): number {
  const column = COLUMNS.find((c) => c.dir === dir)!;
  let nearest = Infinity;
  for (const t of tracks) {
    const centre = (t.x + t.w / 2) / pose.frameWidth;
    if (centre < column.min || centre >= column.max) continue;
    if (t.metres < nearest) nearest = t.metres;
  }
  return nearest;
}

/**
 * Anything closer than this makes a direction unusable. Roughly two paces —
 * below it there is not enough room to commit to a step.
 */
const BLOCKED_WITHIN_M = 2.5;

/**
 * The most open direction, or null when nothing is open.
 *
 * `ahead` wins ties deliberately. Turning has a cost the app cannot see — a
 * kerb, a road, a wall just outside the frame — so a straight line is preferred
 * unless a side is genuinely clearer. The app describes; the user decides.
 */
export function clearestDirection(tracks: Track[], pose: CameraPose): Direction | null {
  const scored = COLUMNS.map((c) => ({ dir: c.dir, metres: nearestIn(tracks, pose, c.dir) }));

  const open = scored.filter((s) => s.metres > BLOCKED_WITHIN_M);
  if (open.length === 0) return null;

  const ahead = open.find((s) => s.dir === "ahead");
  const best = open.reduce((a, b) => (b.metres > a.metres ? b : a));

  // Only report a side when it is meaningfully better than straight on.
  //
  // Written as `!(best > ahead + margin)` rather than `best - ahead < margin`
  // because an empty column is Infinity, and Infinity - Infinity is NaN — which
  // is false against every comparison and would silently send a user sideways
  // across a completely clear scene.
  const MARGIN_M = 1;
  if (ahead && !(best.metres > ahead.metres + MARGIN_M)) return "ahead";
  return best.dir;
}

/**
 * Closing faster than this counts as coming toward you, over and above the
 * user's own walking pace. Set above ordinary pace jitter so a stationary
 * object never gets described as approaching — that word has to stay scary.
 */
const APPROACHING_MPS = 2.2;

export function isApproaching(track: Track): boolean {
  return track.closingMps !== null && track.closingMps >= APPROACHING_MPS;
}
