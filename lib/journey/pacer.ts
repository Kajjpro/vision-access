/**
 * The proactive communication manager: should the guide say something NOW,
 * when nothing has changed?
 *
 * ── THE CONFLICT THIS FILE RESOLVES ────────────────────────────────────────
 *
 * Two requirements, both real, and they look opposed:
 *
 *   CLAUDE.md   "Silence is the default. Audio is not a progress bar. Speak on
 *               state change only — never on a timer, never as a periodic
 *               update." Every unnecessary word masks traffic the rider needs.
 *
 *   The brief   "The system should never unexpectedly become completely silent
 *               during an active journey. A visually impaired user may assume
 *               the system has stopped working."
 *
 * Both are correct, and they only contradict each other if reassurance has to be
 * a SENTENCE. It does not. What the second requirement actually needs is proof
 * of life; what the first forbids is masking. An earcon and a haptic supply the
 * first without costing the second — 300 ms of tone against a spoken sentence's
 * four or five seconds, and the haptic costs no audio channel at all.
 *
 * So the heartbeat is non-verbal at the default level, and words are something
 * the rider opts into:
 *
 *   minimal    nothing. Critical events only — they still come from the ladders.
 *   standard   earcon + haptic. No words. THE DEFAULT.
 *   detailed   earcon + a spoken line.
 *
 * ── THE ONE PLACE WORDS ARE NOT OPTIONAL ───────────────────────────────────
 *
 * A question. `confirming_boarding` and `confirming_exit` block the journey
 * until the rider answers, so an unheard question is a stalled journey — and
 * the rider has no way to tell a stalled journey from a quiet one. Questions
 * therefore re-ask at EVERY level including `minimal`, on a much shorter
 * interval, and they escalate rather than reassure.
 *
 * Pure. No clock, no queue, no React: `now` is a parameter and the decision is
 * an `Announcement` for the existing queue to own.
 */

import type { Announcement } from "../transit/audio-queue";
import { CONFIRM, GUIDE } from "../ui/announcements";
import { ACTIVE_STATES, QUESTION_STATES, type Journey, type JourneyState } from "./types";

/**
 * How long silence may run before the guide proves it is still there, per state.
 *
 * Shaped by what the rider is doing, not by one global number. Walking toward a
 * road wants more contact than sitting on a bus, and a question wants an answer
 * rather than reassurance.
 *
 * The brief asks for roughly 2–4 minutes; these sit inside that band except at
 * the two ends, and both exceptions are deliberate — `bus_due` because
 * something is about to happen, question states because they are not
 * reassurance at all.
 */
export const HEARTBEAT_MS: Partial<Record<JourneyState, number>> = {
  walking_to_stop: 90_000,
  waiting_for_bus: 150_000,
  // Shorter: the rider is about to have to act, and the wait is nearly over.
  bus_due: 45_000,
  // NOT a heartbeat — a re-ask. See `questionRepeat`.
  confirming_boarding: 25_000,
  confirming_exit: 25_000,
  on_bus: 240_000,
  approaching_destination: 120_000,
};

/**
 * How long a fault is left unmentioned before it is repeated.
 *
 * Longer than any heartbeat. A rider who has been told the GPS is struggling
 * does not need to hear it every ninety seconds; they need to know it has not
 * silently become something else.
 */
export const FAULT_REPEAT_MS = 300_000;

/**
 * Words for the heartbeat at `detailed`, per state.
 *
 * Deliberately short and deliberately NOT a count. The counts belong to the
 * ladders in lib/countdown/ladder.ts, which fire on change and know how to stay
 * quiet; a heartbeat that also announced "five stops remaining" would be a
 * second, dumber ladder racing the real one and repeating what it just said.
 */
function heartbeatWords(state: JourneyState): string[] {
  switch (state) {
    case "walking_to_stop":
      return [GUIDE.walkingToStop.clip!];
    case "waiting_for_bus":
    case "bus_due":
    case "on_bus":
    case "approaching_destination":
      return [GUIDE.stillActive.clip!];
    default:
      return [];
  }
}

/**
 * The question to re-ask, and the answers that go with it.
 *
 * Exported because the UI renders exactly these as its options — the spoken
 * question and the on-screen actions come from one place, so they can never
 * describe different choices.
 */
export function questionClips(state: JourneyState): string[] {
  if (state === "confirming_boarding") return [CONFIRM.boardedQuestion.clip!];
  if (state === "confirming_exit") return [CONFIRM.exitedQuestion.clip!];
  return [];
}

/**
 * Re-asks an unanswered question.
 *
 * `normal`, not `critical`: it must never cut off "Одоо буугаарай". A rider who
 * has not answered "did you board" is standing still; a rider being told to get
 * off is next to a door. The queue's cooldown does the spacing, so a re-ask that
 * lands during a burst of ladder announcements is dropped rather than stacked.
 */
function questionRepeat(journey: Journey, now: number): Announcement | null {
  const keys = questionClips(journey.state);
  if (keys.length === 0) return null;
  const interval = HEARTBEAT_MS[journey.state] ?? 25_000;
  return {
    keys,
    priority: "normal",
    earcon: "alert",
    haptic: [120, 80, 120],
    dedupeKey: `question:${journey.state}`,
    cooldownMs: interval,
    // Lives exactly as long as the question does. If the rider answers while
    // this is queued behind something, it is dropped rather than asked about a
    // decision already made.
    expiresAt: now + interval,
    label: `re-ask ${journey.state}`,
  };
}

/**
 * The heartbeat, or null.
 *
 * Null is the normal answer and is the function working — it returns something
 * only when the guide has genuinely been quiet for longer than this state
 * allows.
 *
 * `lastAnnouncementAt` is the last time ANYTHING was spoken, ladder included,
 * so a busy stretch of real announcements suppresses the heartbeat completely.
 * That is the intent: the heartbeat exists to fill silence, and there is no
 * silence to fill.
 */
export function heartbeat(journey: Journey, now: number): Announcement | null {
  // A question outranks reassurance and is asked at every level, minimal too.
  if (QUESTION_STATES.has(journey.state)) return questionRepeat(journey, now);

  if (!journey.heartbeatEnabled) return null;
  if (journey.guidanceLevel === "minimal") return null;
  if (!ACTIVE_STATES.has(journey.state)) return null;

  const interval = HEARTBEAT_MS[journey.state];
  if (!interval) return null;

  // Nothing has ever been said on this journey — the opening announcement is
  // the caller's job and firing here would double it.
  const since = journey.lastAnnouncementAt;
  if (since === null) return null;
  if (now - since < interval) return null;

  const words = journey.guidanceLevel === "detailed" ? heartbeatWords(journey.state) : [];

  return {
    keys: words,
    // `low` so anything with actual news outranks it, and the queue drops it
    // when a real announcement is waiting.
    priority: "low",
    earcon: "soft",
    haptic: [60],
    dedupeKey: `heartbeat:${journey.state}`,
    cooldownMs: interval,
    /**
     * Short-lived on purpose. A heartbeat is a claim about NOW — "I am still
     * here" — and one that plays ninety seconds late, after the state has moved
     * on, is a claim about a journey that no longer exists.
     */
    expiresAt: now + 15_000,
    label: `heartbeat ${journey.state} (${journey.guidanceLevel})`,
  };
}

/**
 * Whether a fault the rider was already told about should be mentioned again.
 *
 * Separate from the heartbeat because a degraded journey must not go quiet
 * EITHER, and CLAUDE.md's rule that a confidence downgrade is announced exactly
 * once governs the downgrade — not the state of being degraded five minutes
 * later, with the rider still waiting and no way to know anything is wrong.
 */
export function faultReminder(journey: Journey, now: number): Announcement | null {
  if (journey.state !== "journey_error" || !journey.fault) return null;
  if (journey.guidanceLevel === "minimal") return null;
  const since = journey.lastAnnouncementAt;
  if (since !== null && now - since < FAULT_REPEAT_MS) return null;

  return {
    keys: [],
    priority: "low",
    earcon: "error",
    haptic: [200, 100, 200],
    dedupeKey: `fault:${journey.fault}`,
    cooldownMs: FAULT_REPEAT_MS,
    expiresAt: now + 15_000,
    label: `fault reminder ${journey.fault}`,
  };
}

/** What the queue is doing when the pacer is offered its turn. */
export type QueueStatus = {
  /** Something is being spoken right now. */
  speaking: boolean;
  /** Announcements waiting behind it. */
  pending: number;
};

/**
 * Everything the pacer wants to say right now, most urgent first.
 *
 * One call site, so a screen cannot wire the heartbeat and forget the re-ask —
 * which is the failure that leaves a rider staring at an unanswered question
 * while the app waits politely forever.
 *
 * ── WHY THE QUEUE STATUS IS AN INPUT ───────────────────────────────────────
 *
 * `low` priority already stops the heartbeat from PREEMPTING anything. It does
 * not stop it from queueing behind a real announcement and playing the instant
 * that announcement ends — so a rider hears "three stops remaining", then, half
 * a second later, a tone whose entire meaning is "the app is still running".
 * They just heard that it was.
 *
 * So a busy queue is not a reason to defer the heartbeat, it is a reason to DROP
 * it: reassurance that arrives after the thing it was meant to substitute for is
 * noise. The next tick will offer it again if the silence really does continue.
 *
 * Questions are exempt. A question is not reassurance — the journey is blocked
 * on it — so it queues normally and waits its turn.
 */
export function pace(journey: Journey, now: number, queue?: QueueStatus): Announcement[] {
  const out: Announcement[] = [];
  const busy = Boolean(queue && (queue.speaking || queue.pending > 0));

  const beat = heartbeat(journey, now);
  if (beat) {
    const isQuestion = QUESTION_STATES.has(journey.state);
    if (isQuestion || !busy) out.push(beat);
  }

  // A fault reminder is reassurance too, and follows the same rule.
  if (!busy) {
    const f = faultReminder(journey, now);
    if (f) out.push(f);
  }
  return out;
}
