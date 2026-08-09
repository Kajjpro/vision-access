/**
 * Frame-to-frame object tracking, and the urgency ranking built on it.
 *
 * Two things the detector alone cannot give you:
 *
 *   1. Stable identity. CLAUDE.md asks for repeats to be debounced by track id,
 *      which is impossible while every frame is an unrelated list of boxes —
 *      the same lamp post announced twice is a different failure from two lamp
 *      posts announced once, and without ids they are indistinguishable.
 *
 *   2. Motion. Ranking by distance says a parked car two metres to the side
 *      matters more than a cyclist six metres away closing fast. It does not.
 *      What matters is how long until it reaches you.
 *
 * Deliberately simple: greedy IoU association, no Kalman filter, no re-id. At
 * 15fps with a 60ms budget on a phone, a tracker that is right most of the time
 * and costs nothing beats one that is right slightly more often and drops
 * frames — and a dropped frame is a warning that never happens.
 */

export type TrackedBox = {
  className: string;
  x: number;
  y: number;
  w: number;
  h: number;
  metres: number;
  reliable: boolean;
};

export type Track = TrackedBox & {
  /** Stable across frames. The debounce key CLAUDE.md asks for. */
  id: number;
  firstSeenMs: number;
  lastSeenMs: number;
  /**
   * Metres per second, positive when closing. Null until there is enough
   * history to measure — never guessed, because a fabricated closing speed
   * would reorder the whole warning queue.
   */
  closingMps: number | null;
  /** Seconds until contact, assuming the user keeps walking. Lower is more urgent. */
  ttcS: number;
};

/** Boxes below this overlap are treated as different objects. */
const IOU_MATCH = 0.3;

/** A track not seen for this long is gone, not occluded. */
const MAX_AGE_MS = 900;

/** Samples older than this are useless for a closing speed; the scene has moved on. */
const VELOCITY_WINDOW_MS = 1200;

/** Two samples at least this far apart, or the speed is mostly timing jitter. */
const MIN_VELOCITY_DT_MS = 250;

/**
 * Assumed walking pace, metres per second.
 *
 * This is what makes a static obstacle urgent at all: the user is moving even
 * when the object is not, so every distance converts to a time. A wall two
 * metres ahead is 1.4 seconds away, and that is the number worth comparing
 * against a cyclist's.
 */
export const WALK_MPS = 1.4;

type Sample = { t: number; metres: number };

type Internal = Track & { history: Sample[] };

function iou(a: TrackedBox, b: TrackedBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - overlap;
  return union <= 0 ? 0 : overlap / union;
}

/**
 * Closing speed from a distance history, by least squares over the recent
 * window.
 *
 * A slope over several samples rather than a difference between two: monocular
 * distance is noisy, and consecutive-frame differencing turns that noise into
 * phantom velocities several metres per second fast.
 */
function closingSpeed(history: Sample[], now: number): number | null {
  const recent = history.filter(
    (s) => now - s.t <= VELOCITY_WINDOW_MS && Number.isFinite(s.metres),
  );
  if (recent.length < 3) return null;

  const span = recent[recent.length - 1].t - recent[0].t;
  if (span < MIN_VELOCITY_DT_MS) return null;

  const meanT = recent.reduce((a, s) => a + s.t, 0) / recent.length;
  const meanD = recent.reduce((a, s) => a + s.metres, 0) / recent.length;

  let num = 0;
  let den = 0;
  for (const s of recent) {
    num += (s.t - meanT) * (s.metres - meanD);
    den += (s.t - meanT) ** 2;
  }
  if (den === 0) return null;

  // Slope is metres per millisecond and negative while approaching; closing
  // speed is the positive rate at which the gap shrinks.
  return -(num / den) * 1000;
}

/**
 * Seconds until contact.
 *
 * The closing rate is floored at walking pace: the user is walking into the
 * scene, so an object that is merely standing there is still being approached.
 * Objects moving away keep the walking-pace rate rather than reporting
 * Infinity, which would rank a receding bus as permanently safe when the user
 * is in fact still heading toward it.
 */
export function timeToContact(metres: number, closingMps: number | null): number {
  if (!Number.isFinite(metres)) return Infinity;
  const rate = Math.max(closingMps ?? 0, WALK_MPS);
  return metres / rate;
}

export class Tracker {
  private tracks: Internal[] = [];
  private nextId = 1;

  /**
   * Associates this frame's boxes with existing tracks and returns them ranked
   * by urgency — soonest contact first, which is the order a warning queue
   * should be served in.
   */
  update(boxes: TrackedBox[], nowMs: number): Track[] {
    const unmatched = new Set(this.tracks);
    const claimed = new Set<TrackedBox>();

    // Greedy, best overlap first, and never across classes — a person and a
    // pole in the same place are two tracks, not one that changed species.
    const pairs: { track: Internal; box: TrackedBox; score: number }[] = [];
    for (const track of this.tracks) {
      for (const box of boxes) {
        if (box.className !== track.className) continue;
        const score = iou(track, box);
        if (score >= IOU_MATCH) pairs.push({ track, box, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);

    for (const { track, box } of pairs) {
      if (!unmatched.has(track) || claimed.has(box)) continue;
      unmatched.delete(track);
      claimed.add(box);
      Object.assign(track, box);
      track.lastSeenMs = nowMs;
      track.history.push({ t: nowMs, metres: box.metres });
      track.history = track.history.filter((s) => nowMs - s.t <= VELOCITY_WINDOW_MS);
    }

    for (const box of boxes) {
      if (claimed.has(box)) continue;
      this.tracks.push({
        ...box,
        id: this.nextId++,
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        closingMps: null,
        ttcS: Infinity,
        history: [{ t: nowMs, metres: box.metres }],
      });
    }

    this.tracks = this.tracks.filter((t) => nowMs - t.lastSeenMs <= MAX_AGE_MS);

    for (const track of this.tracks) {
      track.closingMps = closingSpeed(track.history, nowMs);
      track.ttcS = timeToContact(track.metres, track.closingMps);
    }

    // Only what is on screen right now: a track coasting on its last known
    // position is a memory, and announcing a memory is announcing a guess.
    return this.tracks
      .filter((t) => t.lastSeenMs === nowMs)
      .sort((a, b) => a.ttcS - b.ttcS)
      // history is internal bookkeeping; callers get a plain Track.
      .map((t) => {
        const { history, ...track } = t;
        void history;
        return track;
      });
  }

  reset() {
    this.tracks = [];
  }
}
