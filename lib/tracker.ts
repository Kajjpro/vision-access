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
  /** The detector's confidence in `className`, 0..1. */
  score: number;
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
  /**
   * How much of the recent evidence actually backs `className`, 0..1.
   *
   * THE POINT OF THIS FIELD. `className` is now a vote across the last second
   * or so, not whatever the newest frame happened to say, so this reports how
   * decisive that vote was. A parked car that reads "car, car, truck, car" is
   * 0.75 and gets named; one that reads "car, truck, car, truck" is ~0.5 and
   * does NOT — the app says the distance and leaves the name out, because it
   * genuinely does not know which it is.
   *
   * That is the difference between an app that sounds certain and one that is.
   * A user who cannot look up and check has no way to discount a confident
   * wrong noun, so the honest failure is to say less, not to guess.
   */
  classConfidence: number;
  /**
   * How many frames this object has actually been seen in.
   *
   * The confirmation count. A zero-shot detector flickers: it will produce a
   * confident "person" on one frame of a lamp post and nothing on the next.
   * Those one-frame ghosts are indistinguishable from a real detection in a
   * single frame and obvious across three, so callers wait for this to reach a
   * threshold before speaking. It is the difference between a detector that is
   * right and one that merely sounds certain.
   */
  hits: number;
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

/**
 * Overlap required to associate boxes with DIFFERENT class names.
 *
 * Cross-class association is what stops a flickering label from destroying a
 * track. Before it, a real car reading "car, truck, car, truck" produced two
 * tracks that alternated, neither ever reaching CONFIRM_HITS, and the app said
 * NOTHING about a car three metres away. Refusing to associate looked like the
 * cautious choice and was the opposite: it converted an uncertain name into a
 * missing warning, which is the one direction this app must not fail in.
 *
 * The bar is high — twice IOU_MATCH — because the alternative failure is real
 * too: a pedestrian standing in front of a parked car must stay two tracks, not
 * become one that keeps changing species. At 0.6 the boxes have to be
 * substantially the same box, which is what a relabel looks like and what two
 * different objects at different depths never do.
 */
const IOU_MATCH_CROSS_CLASS = 0.6;

/**
 * How long a class vote counts for.
 *
 * Matched to the velocity window: the same span over which the object is
 * treated as "the thing that is there now" rather than a memory.
 */
const VOTE_WINDOW_MS = 1200;

/** A track not seen for this long is gone, not occluded. */
const MAX_AGE_MS = 900;

/** Samples older than this are useless for a closing speed; the scene has moved on. */
const VELOCITY_WINDOW_MS = 1200;

/** Two samples at least this far apart, or the speed is mostly timing jitter. */
const MIN_VELOCITY_DT_MS = 250;

/**
 * How many recent samples the reported distance is a median of.
 *
 * Monocular distance is NOISY. It is derived from one edge of a box that the
 * detector redraws every frame, through a pinhole model whose pitch term
 * amplifies a few pixels of box wobble into a swing of a metre or more. Spoken
 * aloud that becomes "three metres" then "two metres" then "four metres" for a
 * stationary wall, which sounds like the world is moving and is precisely the
 * "inaccurate distance" complaint.
 *
 * A MEDIAN, not a mean: the failure mode here is the occasional wild outlier
 * when the box bottom jumps to a shadow or a kerb line, and a mean drags the
 * answer toward the outlier while a median ignores it outright.
 *
 * THREE, and not more, because the lag runs the dangerous way. A median reports
 * a value from the middle of its window, so on an object that is closing it
 * always reads FURTHER AWAY than the object actually is — under-warning, which
 * is the one direction this app must not err in. Three samples reject any
 * isolated spike just as completely as five (one bad frame can never be the
 * middle of three) while costing a single frame of lag: about 14 cm at walking
 * pace, against the ~50 cm a five-wide window was measured to cost.
 */
const DISTANCE_MEDIAN_WINDOW = 3;

/** Median of the last few finite samples, or the raw value if none qualify. */
function steadyMetres(history: Sample[], fallback: number): number {
  const recent = history
    .slice(-DISTANCE_MEDIAN_WINDOW)
    .map((s) => s.metres)
    .filter((m) => Number.isFinite(m))
    .sort((a, b) => a - b);
  if (recent.length === 0) return fallback;
  return recent[Math.floor(recent.length / 2)];
}

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

/** One frame's opinion about what this object is. */
type Vote = { t: number; className: string; score: number };

type Internal = Track & { history: Sample[]; votes: Vote[] };

/**
 * The winning class name, how decisive the win was, and its mean score.
 *
 * WEIGHTED BY SCORE, not a plain count. One detection at 0.92 is better
 * evidence than two at 0.33, and a plain majority throws that away — it would
 * let two weak frames of "truck" outvote a confident "car" and rename the
 * object the user is about to be told about.
 *
 * `score` is the mean over the WINNING class's own frames. That is the number
 * to test against nameMinScore(): the losing frames were a different class, so
 * averaging them in would report a confidence that belongs to nothing.
 */
function tally(votes: Vote[], now: number): {
  className: string;
  classConfidence: number;
  score: number;
} {
  const recent = votes.filter((v) => now - v.t <= VOTE_WINDOW_MS);
  if (recent.length === 0) return { className: "", classConfidence: 0, score: 0 };

  const weight = new Map<string, number>();
  const count = new Map<string, number>();
  let total = 0;
  for (const vote of recent) {
    // Floored above zero so a class detected only at very low scores still
    // registers as evidence rather than vanishing from the denominator.
    const w = Math.max(vote.score, 0.01);
    weight.set(vote.className, (weight.get(vote.className) ?? 0) + w);
    count.set(vote.className, (count.get(vote.className) ?? 0) + 1);
    total += w;
  }

  let best = "";
  let bestWeight = 0;
  for (const [name, w] of weight) {
    if (w > bestWeight) {
      best = name;
      bestWeight = w;
    }
  }

  return {
    className: best,
    classConfidence: total > 0 ? bestWeight / total : 0,
    score: bestWeight / (count.get(best) ?? 1),
  };
}

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

    // Greedy, best overlap first. A same-class box only has to overlap;
    // a differently-named one has to be substantially the SAME box before it
    // is accepted as a relabel rather than a second object — see
    // IOU_MATCH_CROSS_CLASS.
    const pairs: { track: Internal; box: TrackedBox; score: number }[] = [];
    for (const track of this.tracks) {
      for (const box of boxes) {
        const score = iou(track, box);
        const needed = box.className === track.className ? IOU_MATCH : IOU_MATCH_CROSS_CLASS;
        if (score >= needed) pairs.push({ track, box, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);

    for (const { track, box } of pairs) {
      if (!unmatched.has(track) || claimed.has(box)) continue;
      unmatched.delete(track);
      claimed.add(box);
      // Geometry only. className and score are NOT taken from the newest frame
      // any more — they are decided by tally() over the whole window below, so
      // assigning them here would be overwritten anyway and reads as if the
      // latest frame still won.
      track.x = box.x;
      track.y = box.y;
      track.w = box.w;
      track.h = box.h;
      track.metres = box.metres;
      track.reliable = box.reliable;
      track.hits++;
      track.lastSeenMs = nowMs;
      track.history.push({ t: nowMs, metres: box.metres });
      track.history = track.history.filter((s) => nowMs - s.t <= VELOCITY_WINDOW_MS);
      track.votes.push({ t: nowMs, className: box.className, score: box.score });
      track.votes = track.votes.filter((v) => nowMs - v.t <= VOTE_WINDOW_MS);
    }

    for (const box of boxes) {
      if (claimed.has(box)) continue;
      this.tracks.push({
        ...box,
        id: this.nextId++,
        hits: 1,
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        closingMps: null,
        ttcS: Infinity,
        // One frame of evidence, all of it agreeing with itself. Callers must
        // still wait for CONFIRM_HITS before believing the name — a single
        // frame is unanimous and means nothing.
        classConfidence: 1,
        history: [{ t: nowMs, metres: box.metres }],
        votes: [{ t: nowMs, className: box.className, score: box.score }],
      });
    }

    this.tracks = this.tracks.filter((t) => nowMs - t.lastSeenMs <= MAX_AGE_MS);

    for (const track of this.tracks) {
      // Velocity comes from the RAW history — smoothing first would flatten the
      // very trend the slope is trying to measure. The reported distance is
      // then the settled one, so what gets spoken does not jitter.
      track.closingMps = closingSpeed(track.history, nowMs);
      track.metres = steadyMetres(track.history, track.metres);
      track.ttcS = timeToContact(track.metres, track.closingMps);

      // What this object IS, decided over the window rather than by the newest
      // frame. A stray label on one frame no longer renames a settled track.
      const verdict = tally(track.votes, nowMs);
      if (verdict.className) {
        track.className = verdict.className;
        track.classConfidence = verdict.classConfidence;
        track.score = verdict.score;
      }
    }

    // Only what is on screen right now: a track coasting on its last known
    // position is a memory, and announcing a memory is announcing a guess.
    return this.tracks
      .filter((t) => t.lastSeenMs === nowMs)
      .sort((a, b) => a.ttcS - b.ttcS)
      // history and votes are internal bookkeeping; callers get a plain Track.
      .map((t) => {
        const { history, votes, ...track } = t;
        void history;
        void votes;
        return track;
      });
  }

  reset() {
    this.tracks = [];
  }
}
