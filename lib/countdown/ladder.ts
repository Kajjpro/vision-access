/**
 * Engine state → what to say, if anything.
 *
 * SILENCE IS THE DEFAULT. Audio is not a progress bar. The rider is navigating
 * by ear next to live traffic, and every unnecessary word masks a car they need
 * to hear — so this speaks on STATE CHANGE and never on a timer. Most calls
 * return nothing, and that is the function working.
 *
 * Two ladders, one shape:
 *
 *   ALIGHTING   riding toward a destination. Silent above 3 stops, then 3, 2,
 *               1 (alert), arrival (urgent), overshoot (priority 0).
 *   BOARDING    waiting at a stop. Silent above 5, optional at 5, then 3, 2,
 *               1 (alert), vehicle at the kerb (urgent).
 *
 * Pure, and driven by a PREVIOUS-to-CURRENT comparison rather than by the
 * current value alone. That is what makes each rung fire exactly once: a count
 * that sits at 2 for four minutes is one announcement, not eighty, and a rung
 * skipped by a dropout still fires on the next fix rather than being lost.
 */

import { announceRemaining, TTL } from "../transit/announce";
import type { Announcement } from "../transit/audio-queue";
import type { Confidence } from "./engine";

export type LadderStop = { id: string; name: string };

/** Everything the ladder needs to know about one moment. */
export type LadderInput = {
  /** Stops until the destination. Negative means overshot. */
  remaining: number;
  confidence: Confidence;
  /** The stop being counted down TO. */
  destination: LadderStop;
  now: number;
  /**
   * Predicted seconds to the destination, from `secondsToDestination`.
   *
   * Optional: without it rung 1 always speaks, which is the old behaviour and a
   * safe default — the floor below only ever REMOVES a preparation cue that had
   * no room to be one.
   */
  secondsToDestination?: number | null;
};

/**
 * Minimum lead rung 1 needs to be worth saying, seconds.
 *
 * Picked from the interval distribution over 310 simulated journeys rather than
 * from intuition. Sorted, the intervals run 1, 14, 17, 21, 25, 26, 28, 30, 30,
 * 30, 31 … — an outlier, a sparse tail, then a dense body from 25 s up. 20 s
 * sits in the empty space between 17 and 21, at roughly the 1st percentile, so
 * it removes the tail without touching the body of the distribution.
 *
 * It is also about four times the length of the rung-1 utterance itself. That
 * matters concretely: rung 1 is three clips plus a 250 ms earcon lead, so it
 * occupies ~5 s — and rung 0 is `critical`, which preempts mid-clip. Below the
 * floor the rider does not get two signals, they get a truncated one followed
 * by the real one, which is worse than the real one alone.
 */
export const RUNG1_MIN_LEAD_S = 20;

/**
 * The rungs of the alighting ladder, per §5.2.
 *
 * `null` above 3: a countdown that starts eight stops out is a countdown the
 * rider stops listening to, and the value of the last three is entirely that
 * they are rare enough to be heard.
 */
export function alightingRung(remaining: number): 3 | 2 | 1 | 0 | -1 | null {
  if (remaining < 0) return -1;
  if (remaining === 0) return 0;
  if (remaining === 1) return 1;
  if (remaining === 2) return 2;
  if (remaining === 3) return 3;
  return null;
}

/**
 * What to say now, given what was said last.
 *
 * Returns null for "nothing changed that is worth a word" — which is most of
 * the time, by design.
 *
 * `previousRemaining` is the count at the last announcement, NOT at the last
 * fix. Comparing against the last fix would re-announce on every tick that
 * happened to hold the same value; comparing against the last ANNOUNCEMENT is
 * what makes a rung fire once and stay quiet until the next one.
 */
export function alightingAnnouncement(
  input: LadderInput,
  previousRemaining: number | null,
  hasClip: (key: string) => boolean,
): Announcement | null {
  const { remaining, confidence, destination, now } = input;

  /**
   * NOTHING IS SAID ON EVIDENCE WE DO NOT HAVE.
   *
   * `none` means the fix is older than the dead-reckoning window. Announcing a
   * count from it would be the app's most dangerous act: a confident-sounding
   * "next stop is yours" derived from where the bus was three minutes ago. The
   * loss itself is announced by the caller, once — see `confidenceLost`.
   */
  if (confidence === "none") return null;

  const rung = alightingRung(remaining);
  if (rung === null) return null;

  /**
   * THE PREPARATION CUE NEEDS ROOM TO BE ONE.
   *
   * Where the last two stops sit close together, "дараагийн буудал … бэлдээрэй"
   * and "Одоо буугаарай" collapse into the same moment. A blind rider then gets
   * a preparation signal and an action signal simultaneously, which carries less
   * information than the action signal alone — and, being lower priority, the
   * preparation one is cut off mid-word by the action one.
   *
   * Suppressed rather than moved: the time is absent from the geometry and no
   * threshold can manufacture it. Rung 0 is untouched, so the rider still gets
   * the instruction that matters.
   */
  if (
    rung === 1 &&
    input.secondsToDestination !== undefined &&
    input.secondsToDestination !== null &&
    input.secondsToDestination < RUNG1_MIN_LEAD_S
  ) {
    return null;
  }

  // Already said at this rung. A count that sits at 2 for four minutes is one
  // announcement, not eighty.
  if (previousRemaining !== null && alightingRung(previousRemaining) === rung) return null;

  const announcement = announceRemaining(remaining, destination, hasClip, now);
  if (!announcement) return null;

  /**
   * A LOW-CONFIDENCE COUNT MAY NOT DRIVE SOMEONE OUT OF A DOOR.
   *
   * The register contract in CLAUDE.md binds wording to data quality, and the
   * two urgent rungs — "get off now", "you have passed it" — are the two that
   * make a rider stand up and move next to traffic. Dead-reckoned evidence
   * cannot carry them, so they are held back entirely rather than hedged: there
   * is no rendered phrasing for "you have probably arrived", and inventing one
   * by concatenation is exactly the fragment-splicing CLAUDE.md forbids.
   *
   * The earlier rungs still speak. Being told "three stops" on weak evidence
   * costs nothing; being told to step off does.
   */
  if (confidence === "low" && rung <= 0) return null;

  return announcement;
}

/**
 * The one degradation notice, per §4.3.
 *
 * Announced exactly once per downgrade, never repeated — a phone that keeps
 * saying "tracking is unreliable" every thirty seconds is one the rider stops
 * listening to, and they need to hear the next thing it says.
 */
export function confidenceLost(now: number): Announcement {
  return {
    keys: ["bus_tracking_degraded"],
    priority: "critical",
    earcon: "error",
    haptic: [200, 100, 200],
    dedupeKey: "confidence-lost",
    // Long enough that a flapping fix cannot say it twice a minute.
    cooldownMs: 5 * 60_000,
    expiresAt: now + TTL.STATE,
    label: "confidence lost — manual advance surfaced",
  };
}

// --------------------------------------------------------------- boarding

/**
 * The boarding ladder's rungs, per §5.1.
 *
 * Five is offered but off by default: at five stops out there is nothing a
 * rider does differently, and the §1 rule is that audio is not a progress bar.
 */
export function boardingRung(stopsAway: number, announceAtFive: boolean): 5 | 3 | 2 | 1 | null {
  if (stopsAway === 1) return 1;
  if (stopsAway === 2) return 2;
  if (stopsAway === 3) return 3;
  if (stopsAway === 5 && announceAtFive) return 5;
  return null;
}
