/**
 * What "it" refers to, and for how long.
 *
 * Five fields, and deliberately not a transcript. A transcript is a liability
 * with no user benefit here: nothing in this feature needs to recall what was
 * asked four questions ago, and storing where somebody has been all afternoon is
 * the kind of data that is only ever a risk.
 *
 * ── WHY IT EXPIRES ─────────────────────────────────────────────────────────
 *
 * A pronoun that binds to something seen two minutes and half a corridor ago is
 * worse than no pronoun at all, because the user believes they are asking about
 * what is in front of them RIGHT NOW. So the target expires on a clock, and it
 * also expires when the camera has clearly moved on — the room changed even
 * though the clock did not.
 */

import type { AskAnswer, Target } from "./answer";
import type { Intent } from "./intent";

/** A pronoun bound to something a minute and a half old is a different room. */
export const TARGET_TTL_MS = 90_000;

/**
 * Frame-fraction the camera may pan before the target is considered lost.
 *
 * The detector's own tracker handles frame-to-frame continuity; this is the
 * coarser check for "the phone has been swept somewhere else entirely", which is
 * what happens between two questions rather than between two frames.
 */
export const PAN_RESET_FRACTION = 0.45;

export type AskContext = {
  target: Target | null;
  previousTarget: Target | null;
  previousIntent: Intent | null;
  /** The exact answer, so "repeat that" replays rather than regenerates. */
  previousAnswer: AskAnswer | null;
  /** When `target` was set. */
  at: number;
};

export function emptyContext(): AskContext {
  return { target: null, previousTarget: null, previousIntent: null, previousAnswer: null, at: 0 };
}

/** Records an answer. The previous target is kept for "what about the other one". */
export function remember(
  context: AskContext,
  intent: Intent,
  answer: AskAnswer,
  now: number,
): AskContext {
  return {
    // A decline does not become the referent. "I can't see a door" followed by
    // "how far?" must ask what to look for, not measure a door nobody found.
    target: answer.target ?? (answer.decline ? null : context.target),
    previousTarget: context.target,
    previousIntent: intent,
    previousAnswer: answer,
    at: answer.target ? now : context.at,
  };
}

/**
 * The live target, or null if it has aged out.
 *
 * Read through this rather than off the object, so no call site can accidentally
 * use a stale one.
 */
export function activeTarget(context: AskContext, now: number): Target | null {
  if (!context.target) return null;
  if (now - context.at > TARGET_TTL_MS) return null;
  return context.target;
}

/**
 * Expires the target when the camera has been swept elsewhere.
 *
 * Called with the current centre of whatever the detector still tracks for that
 * class. A target that is no longer anywhere near where it was is not the same
 * object, and binding a pronoun to it would answer about the wrong thing.
 */
export function onCameraMoved(context: AskContext, currentCentreX: number | null): AskContext {
  if (!context.target) return context;
  if (currentCentreX === null) return { ...context, target: null };
  if (Math.abs(currentCentreX - context.target.centreX) > PAN_RESET_FRACTION) {
    return { ...context, target: null };
  }
  return context;
}

/** Drops everything. A new session, or the user asking to forget. */
export function clearContext(): AskContext {
  return emptyContext();
}
