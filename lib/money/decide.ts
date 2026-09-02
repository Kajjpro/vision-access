/**
 * Turn several frames' recognitions into one thing the app is willing to say.
 *
 * Same shape NOTES.md specifies for BusMode: tap, take a few frames, decide,
 * speak. The reason it is worth doing here is that the failure modes of
 * feature matching are largely TRANSIENT — a glare crossing the note, a hand
 * over the numeral, motion blur from a phone held by someone who cannot see
 * to steady it. Frames a few hundred milliseconds apart sample different
 * versions of those, so agreement across them is real evidence.
 *
 * What it is NOT evidence against is a SYSTEMATIC error. If the reference
 * scan for 5000 is poor, every frame is wrong the same way and agrees
 * perfectly. NOTES.md makes the same point about OCR on route numbers, and
 * the mitigation is the same: agreement raises confidence, it does not
 * manufacture it, and the reference pack still has to be right.
 *
 * CONTRADICTION IS DISQUALIFYING, NOT OUTVOTED. Two frames saying 1000 and
 * one saying 5000 does not resolve to 1000. It is a demonstration that the
 * matcher is unreliable on this note under this light, and the honest output
 * is "Тодорхойгүй" — the user re-aims and taps again, which costs seconds.
 * The alternative costs them the difference between the two notes.
 */
import type { Recognition } from "./recognizer";
import type { Denomination } from "./denominations";

/** Frames captured per tap. */
export const FRAMES_PER_CAPTURE = 3;

/** Gap between captures. Long enough to resample hand shake and glare. */
export const FRAME_INTERVAL_MS = 350;

/** Frames that must positively agree. 2 of 3 tolerates one blurred frame. */
export const REQUIRED_AGREEMENT = 2;

export type Decision =
  | { kind: "identified"; denomination: Denomination; agreeing: number; inliers: number }
  | { kind: "unclear"; reason: string };

/**
 * `frames` holds one entry per captured frame, null where that frame produced
 * no confident recognition. Nulls are ABSTENTIONS — they neither support nor
 * contradict — so a single good frame out of three still fails the agreement
 * requirement rather than being promoted.
 */
export function decide(frames: (Recognition | null)[]): Decision {
  const named = frames.filter((f): f is Recognition => f !== null);
  if (named.length === 0) {
    return { kind: "unclear", reason: "no frame produced a confident match" };
  }

  const distinct = new Set(named.map((f) => f.denomination));
  if (distinct.size > 1) {
    const seen = [...distinct].sort((a, b) => a - b).join(", ");
    return { kind: "unclear", reason: `frames disagreed: ${seen}` };
  }

  if (named.length < REQUIRED_AGREEMENT) {
    return {
      kind: "unclear",
      reason: `only ${named.length} of ${frames.length} frames matched, need ${REQUIRED_AGREEMENT}`,
    };
  }

  const denomination = named[0].denomination;
  // Report the WEAKEST agreeing frame. It is the one that describes how close
  // this reading came to not happening, which is the number worth showing on
  // the debug panel when someone is working out why a note reads badly.
  const inliers = Math.min(...named.map((f) => f.inliers));
  return { kind: "identified", denomination, agreeing: named.length, inliers };
}
