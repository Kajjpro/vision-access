/**
 * Builds spoken announcements as manifest key sequences.
 *
 * THE HEDGE IS STRUCTURAL. There is no code path that produces a time-to-arrival
 * without `bus_approx_prefix` ("Ойролцоогоор") in front of it, because the only
 * function that can emit a minute count puts it there itself. Call sites cannot
 * opt out, because they never assemble the sequence — they hand over an
 * `Arrival` and get keys back.
 *
 * That is deliberate. Every arrival we can produce is schedule-derived: the
 * gateway's `/api/bus/v1/realtime` returns an empty payload for a whole-country
 * bbox, and OTP reports `realTime: false` on every leg across three sessions.
 * A sighted passenger can see a countdown board is wrong; a blind passenger
 * trusting this voice cannot. So the hedge lives where it cannot be forgotten.
 *
 * If a live feed ever appears, `Arrival.source === "realtime"` is the ONLY input
 * that drops the hedge, and it is checked here, once.
 */
import type { Announcement, Priority } from "./audio-queue";
import { countdownFor, countdownKeys, type Countdown } from "./eta";
import type { Arrival, DegradedReason, Route, Stop } from "./types";

/**
 * Cardinals rendered as clips are 1..40; past that we speak no number.
 *
 * Owned by eta.ts and re-exported here, where callers have always found it. Two
 * separate constants for one fact about the rendered clip set is one edit away
 * from a `num_41` that resolves to silence in the middle of a sentence.
 */
export { MAX_SPOKEN_NUMBER } from "./eta";

export const stopKey = (stopId: string) => `stop_${stopId}`;
export const routeKey = (routeId: string) => `route_${routeId}`;
export const numberKey = (n: number) => `num_${n}`;

/**
 * HOW LONG EACH KIND OF SENTENCE STAYS TRUE.
 *
 * `Announcement.expiresAt` has no default, so every builder here has to answer
 * this — and gathering the answers into one table is what makes them reviewable
 * against each other rather than guessed at eleven times.
 *
 * The three lifetimes are a claim about the WORLD, not about audio latency:
 *
 *   IMMEDIATE  the whole value is timeliness. "Одоо буугаарай" arriving after
 *              the doors close is not merely late, it is a false instruction.
 *              Shorter than one inter-stop interval on any UB route.
 *   ROUTINE    a count or a position, true until the bus moves. Roughly the
 *              time it takes to cover a stop spacing in traffic.
 *   STATE      a condition rather than a moment — a degradation, the stop you
 *              are standing at. Still true a minute later.
 *
 * Every one of these is well clear of a normal queue depth (utterances run
 * 2–4 s), so an expiry means the world moved on, never that the queue was busy.
 */
export const TTL = {
  IMMEDIATE: 12_000,
  ROUTINE: 20_000,
  STATE: 60_000,
} as const;

/** "Та … буудал дээр байна" wrapped around the stop name clip. */
export function announceAtStop(
  stop: Stop,
  priority: Priority = "normal",
  now: number = Date.now(),
): Announcement {
  return {
    keys: ["bus_you_are_at", stopKey(stop.id), "bus_at_stop_suffix"],
    priority,
    dedupeKey: "at-stop",
    expiresAt: now + TTL.STATE,
    label: `at ${stop.name}`,
  };
}

export function announceNoStopNearby(now: number = Date.now()): Announcement {
  return {
    keys: ["bus_no_stop_nearby"],
    priority: "normal",
    dedupeKey: "no-stop",
    expiresAt: now + TTL.STATE,
    label: "no stop within 150 m",
  };
}

export function announceLocationUnavailable(now: number = Date.now()): Announcement {
  return {
    keys: ["bus_location_unavailable"],
    priority: "normal",
    dedupeKey: "no-location",
    expiresAt: now + TTL.STATE,
    label: "location unavailable",
  };
}

/**
 * A route, spoken.
 *
 * All 84 routes now have a rendered clip, and announce.test.ts fails the build
 * if any loses one. The fallback below is kept as a safety net, not as the
 * normal path — but note that it is a QUIET failure: it substitutes the generic
 * phrase and reports the gap, so an unrendered route sounds like "нэргүй
 * буудал" rather than crashing. That is deliberate (never silence), and it is
 * also exactly why the whole route set went unnamed for a long time without
 * anything appearing to be wrong. The test is what makes the gap loud.
 *
 * Falling back to the DISPLAY label is not an option: `Ч:39` sent to an engine
 * is read as a colon, or rejected outright — Chimege 400s on digits and Latin.
 */
export function announceRoute(
  route: Route,
  hasClip: (key: string) => boolean,
  now: number = Date.now(),
): Announcement {
  const key = routeKey(route.id);
  if (hasClip(key)) {
    return { keys: [key], priority: "normal", expiresAt: now + TTL.ROUTINE, label: `route ${route.displayName}` };
  }
  return {
    keys: ["bus_unnamed_stop"],
    priority: "normal",
    expiresAt: now + TTL.ROUTINE,
    label: `route ${route.displayName} (NO CLIP — data/route-names.json unfilled)`,
  };
}

/**
 * "Ойролцоогоор N минутын дараа" — the only way a time reaches the speaker.
 *
 * `now` is a parameter, not a default read of the clock, because the countdown
 * is derived HERE rather than carried on the arrival. A stored minute count is
 * true only at the instant it was computed, and this app served one through a
 * 45-second cache into a screen that held it for as long as a rider browsed —
 * see lib/transit/eta.ts.
 *
 * Returns null when there is nothing honest to say: no absolute time, a bus
 * already gone, or a countdown past the last cardinal clip. A silently dropped
 * number would leave "Ойролцоогоор … минутын дараа" with a hole in the middle.
 *
 * THE HEDGE IS UNCONDITIONAL. This used to read `if (arrival.source !==
 * "realtime")`, leaving a branch that dropped it. That branch is deleted rather
 * than left dormant: we ship schedule-only, the City gateway is closed to us
 * (docs/city-gateway.md), and every number reaching this function is derived
 * from a timetable or a headway. There is no input for which an unhedged time
 * is correct — and left as a condition it would be one plausible-looking
 * assignment of `source: "realtime"` away from speaking a schedule guess as
 * fact, with nothing downstream able to tell the difference. If a live feed is
 * ever opened, the confident wording belongs on the live path in
 * lib/transit/journey.ts, which is gated on verified freshness.
 */
export function announceArrival(
  arrival: Arrival,
  hasClip: (key: string) => boolean,
  now: number = Date.now(),
): Announcement | null {
  const countdown = countdownFor(arrival, now);
  const time = countdownKeys(countdown, hasClip);
  if (time.length === 0) return null;

  const route = routeKey(arrival.routeId);
  const keys = hasClip(route) ? [route, ...time] : [...time];

  return {
    keys,
    priority: "normal",
    // Carries the value, so an unchanged countdown collapses and a changed one
    // is heard. A key of just the route id would suppress every later update.
    dedupeKey: `arrival-${arrival.routeId}-${countdown.kind === "minutes" ? countdown.minutes : countdown.kind}`,
    // A countdown is only true until the next minute turns over. Shorter than
    // ROUTINE for that reason: this is the one sentence in the app whose value
    // changes on a clock rather than on the bus moving.
    expiresAt: now + TTL.IMMEDIATE,
    label: `${arrival.routeDisplayName} ${describeCountdown(countdown)} (${arrival.source})`,
  };
}

/** For the on-screen debug panel. Never spoken. */
export function describeCountdown(c: Countdown): string {
  switch (c.kind) {
    case "minutes": return `~${c.minutes} мин`;
    case "due": return "одоо";
    case "gone": return "өнгөрсөн";
    case "unknown": return "?";
  }
}

/**
 * Degradation, spoken — one phrase per CAUSE.
 *
 * To a user who cannot see the screen, silence is indistinguishable from "no
 * bus is coming", which is the failure that leaves someone standing at a stop
 * indefinitely. But the wrong explanation is nearly as bad: "location
 * unavailable" for a rate limit sends someone looking for open sky, wasting the
 * one action they might take. So each cause maps to its own phrase.
 */
const DEGRADED_PHRASE: Record<DegradedReason, string> = {
  "rate-limited": "bus_service_unavailable",
  "upstream-error": "bus_service_unavailable",
  offline: "bus_network_unavailable",
  timeout: "bus_network_unavailable",
  "no-service": "bus_route_info_unavailable",
};

export function announceDegraded(reason: DegradedReason, now: number = Date.now()): Announcement {
  return {
    keys: [DEGRADED_PHRASE[reason]],
    priority: "normal",
    dedupeKey: "degraded",
    // A degradation notice is spoken ONCE per cause (CLAUDE.md), so the
    // cooldown is what enforces that rather than the caller remembering to.
    cooldownMs: 5 * 60_000,
    expiresAt: now + TTL.STATE,
    label: `degraded: ${reason}`,
  };
}

/**
 * Tracking has stopped working mid-ride.
 *
 * Distinct from the arrival-side degradations: this one tells the user the
 * countdown itself is no longer reliable and that the manual button is now
 * their only accurate source. Critical priority, because continuing to trust a
 * frozen counter is how someone rides past their stop.
 */
export function announceTrackingDegraded(now: number = Date.now()): Announcement {
  return {
    keys: ["bus_tracking_degraded"],
    priority: "critical",
    dedupeKey: "tracking-degraded",
    cooldownMs: 5 * 60_000,
    expiresAt: now + TTL.STATE,
    label: "tracking degraded — manual advance surfaced",
  };
}

/**
 * Everything to say on arriving at the wait screen with a stop identified.
 *
 * Assembled as one list so the order is fixed in one place: where you are,
 * then what serves it. A user who cannot see the screen relies on that order
 * being the same every time.
 */
export function announceStopSummary(
  stop: Stop,
  routes: Route[],
  hasClip: (key: string) => boolean,
): Announcement[] {
  return [announceAtStop(stop), ...routes.map((r) => announceRoute(r, hasClip))];
}

/**
 * The countdown, spoken.
 *
 * `remaining` is destIndex - currentIndex. Only these five cases say anything:
 * announcing every stop would train the user to stop listening, and the whole
 * value of the last three is that they are rare enough to be heard.
 *
 * remaining 0 is CRITICAL — it preempts whatever is playing, because a stop
 * name finishing after the doors close is worth nothing. Every case carries a
 * dedupeKey so a burst of position updates cannot queue the same line twice.
 */
/**
 * HOW LONG EACH RUNG STAYS SAID.
 *
 * `dedupeKey` alone only collapses copies still waiting in the queue; once one
 * has been spoken, nothing suppresses the next without a cooldown. The ladder's
 * previous-to-current comparison normally prevents a repeat, but it is state
 * held by a screen — and a remount, a resumed session, or confidence flapping
 * across a rung boundary all re-invoke this with that state lost. Then the rider
 * hears "хоёр буудал" twice for one stop, which teaches them the count is
 * unreliable at exactly the moment it matters.
 *
 * The count is monotonic within a journey, so no rung legitimately fires twice
 * against one destination, and these can be generous. A genuine re-run — a new
 * journey, or a rider who changed where they are getting off — is handled by
 * `AudioQueue.resetCooldowns()`, which is the mechanism for "this is a different
 * question now"; a short cooldown is the wrong instrument for it.
 *
 * `arrived` is shorter than the rest on purpose. It is the one rung a rider may
 * genuinely need twice inside a single stop dwell, and its own `expiresAt` of
 * TTL.IMMEDIATE already stops a stale copy reaching the front of the queue.
 */
/**
 * How many stops past the destination are announced before falling silent.
 *
 * Overshoot used to fire once and then say nothing, which left the rider in
 * silence from the moment they most needed orientation. But a rider who has
 * decided to ride on to the terminus does not need telling every 90 s either,
 * so the repeat is bounded and the long-press status query covers the rest.
 */
export const OVERSHOOT_REPEAT_STOPS = 3;

const RUNG_COOLDOWN_MS = {
  overshoot: 5 * 60_000,
  arrived: 2 * 60_000,
  remaining: 5 * 60_000,
} as const;

export function announceRemaining(
  remaining: number,
  stop: { id: string; name: string },
  hasClip: (key: string) => boolean,
  now: number = Date.now(),
): Announcement | null {
  const name = hasClip(stopKey(stop.id)) ? stopKey(stop.id) : "bus_unnamed_stop";
  const haptic = vibrationFor(remaining) ?? undefined;

  if (remaining < 0) {
    const past = -remaining;
    // Bounded: past the window the rider has chosen to stay on, and repeating
    // is noise rather than orientation.
    if (past > OVERSHOOT_REPEAT_STOPS) return null;

    if (past === 1) {
      /**
       * The first overshoot carries the guidance line, spoken once.
       *
       * Gated on the clip existing so that until it is rendered this degrades
       * to exactly today's announcement rather than to silence — an
       * unrendered key is dropped without a sound, so introducing one
       * ungated would delete the only thing this says.
       */
      const guidance = hasClip("bus_get_off_next_stop") ? ["bus_get_off_next_stop"] : [];
      return {
        keys: ["bus_passed_stop", ...guidance],
        priority: "critical",
        earcon: "urgent",
        haptic,
        dedupeKey: "overshoot-1",
        cooldownMs: RUNG_COOLDOWN_MS.overshoot,
        // Long: an overshoot stays true and stays actionable. Unlike a count, it
        // does not stop being the right thing to say a minute later.
        expiresAt: now + TTL.STATE,
        label: "PASSED the destination",
      };
    }

    /**
     * "You are now N stops past your stop."
     *
     * ALL KEYS OR NONE, following countdownKeys: a suffix whose number failed
     * to decode leaves a sentence with a hole in the middle, which sounds like
     * a number that was said and misheard rather than one that was never said.
     */
    if (!hasClip("bus_stops_past_suffix") || !hasClip(numberKey(past))) return null;
    /**
     * EVERY FOLLOW-UP RE-SPEAKS THE ANCHOR.
     *
     * `буудал өнгөрлөө` means "N stops have passed" — it does not itself say
     * which stop was missed. The only thing that supplies that is
     * `bus_passed_stop`, and by the third follow-up that anchor is two stops
     * and several minutes behind. A disoriented rider is exactly the wrong
     * person to ask to carry context across minutes of traffic noise, so each
     * utterance is made to stand alone instead.
     *
     * The repetition is the point, not an oversight. `bus_passed_stop` is
     * already rendered, so a self-contained sentence costs nothing to produce.
     */
    return {
      keys: ["bus_passed_stop", numberKey(past), "bus_stops_past_suffix"],
      priority: "normal",
      earcon: "alert",
      haptic,
      dedupeKey: `overshoot-${past}`,
      cooldownMs: RUNG_COOLDOWN_MS.overshoot,
      expiresAt: now + TTL.ROUTINE,
      label: `${past} stops past the destination`,
    };
  }

  if (remaining === 0) {
    return {
      keys: [name, "bus_get_off_now"],
      priority: "critical",
      earcon: "urgent",
      haptic,
      dedupeKey: "arrived",
      cooldownMs: RUNG_COOLDOWN_MS.arrived,
      // The shortest lifetime in the app. "Одоо буугаарай" that arrives after
      // the doors close is not a late message, it is a wrong one — it sends
      // someone toward a door that is shut, on a bus that is moving.
      expiresAt: now + TTL.IMMEDIATE,
      label: `ARRIVED at ${stop.name}`,
    };
  }

  if (remaining === 1) {
    return {
      keys: ["bus_next_stop", name, "bus_get_ready"],
      priority: "normal",
      earcon: "alert",
      haptic,
      dedupeKey: "remaining-1",
      cooldownMs: RUNG_COOLDOWN_MS.remaining,
      expiresAt: now + TTL.ROUTINE,
      label: `next stop ${stop.name} — get ready`,
    };
  }

  if (remaining === 2 || remaining === 3) {
    return {
      keys: [numberKey(remaining), "bus_stops_remaining"],
      priority: "normal",
      earcon: "soft",
      haptic,
      dedupeKey: `remaining-${remaining}`,
      cooldownMs: RUNG_COOLDOWN_MS.remaining,
      expiresAt: now + TTL.ROUTINE,
      label: `${remaining} stops remaining`,
    };
  }

  return null;
}

/**
 * Vibration pattern per countdown step, in the same place as the speech so the
 * two cannot drift apart. Milliseconds, navigator.vibrate format.
 *
 * The count is FELT as well as heard: three pulses at three stops, two at two.
 * A rider with the phone in a pocket and one earbud against Peace Avenue gets
 * the same number through either channel, which is the parallel-channel rule —
 * any one of speech, earcon or haptic must be enough to act on.
 */
export function vibrationFor(remaining: number): number[] | null {
  if (remaining < 0) return [200, 100, 200, 100, 200];
  if (remaining === 0) return [800];
  if (remaining === 1) return [150];
  // Countable pulses: short, evenly spaced, and as many as there are stops.
  if (remaining === 2) return [60, 90, 60];
  if (remaining === 3) return [60, 90, 60, 90, 60];
  return null;
}

/**
 * Guard used by the tests: no announcement may contain a number clip unless it
 * is hedged or genuinely live. Exported so the rule is asserted against real
 * output rather than by reading the code.
 */
export function isUnhedgedTime(announcement: Announcement): boolean {
  const hasNumber = announcement.keys.some((k) => k.startsWith("num_"));
  const hasMinutes = announcement.keys.includes("bus_minutes_suffix");
  if (!hasNumber || !hasMinutes) return false;
  return !announcement.keys.includes("bus_approx_prefix");
}
