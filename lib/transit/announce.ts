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
import type { Arrival, DegradedReason, Route, Stop } from "./types";

/** Cardinals rendered as clips are 1..40; past that we speak no number. */
export const MAX_SPOKEN_NUMBER = 40;

export const stopKey = (stopId: string) => `stop_${stopId}`;
export const routeKey = (routeId: string) => `route_${routeId}`;
export const numberKey = (n: number) => `num_${n}`;

/** "Та … буудал дээр байна" wrapped around the stop name clip. */
export function announceAtStop(stop: Stop, priority: Priority = "normal"): Announcement {
  return {
    keys: ["bus_you_are_at", stopKey(stop.id), "bus_at_stop_suffix"],
    priority,
    dedupeKey: "at-stop",
    label: `at ${stop.name}`,
  };
}

export function announceNoStopNearby(): Announcement {
  return {
    keys: ["bus_no_stop_nearby"],
    priority: "normal",
    dedupeKey: "no-stop",
    label: "no stop within 150 m",
  };
}

export function announceLocationUnavailable(): Announcement {
  return {
    keys: ["bus_location_unavailable"],
    priority: "normal",
    dedupeKey: "no-location",
    label: "location unavailable",
  };
}

/**
 * A route, spoken.
 *
 * `spokenName` is hand-authored and may not exist yet. Rather than fall back to
 * the display label — which would send `Ч:39` somewhere it could be read as a
 * colon, or silently say nothing — an unrendered route announces the generic
 * stop phrase and reports the gap. Never silence.
 */
export function announceRoute(route: Route, hasClip: (key: string) => boolean): Announcement {
  const key = routeKey(route.id);
  if (hasClip(key)) {
    return { keys: [key], priority: "normal", label: `route ${route.displayName}` };
  }
  return {
    keys: ["bus_unnamed_stop"],
    priority: "normal",
    label: `route ${route.displayName} (NO CLIP — data/route-names.json unfilled)`,
  };
}

/**
 * "Ойролцоогоор N минутын дараа" — the only way a time reaches the speaker.
 *
 * Returns null above MAX_SPOKEN_NUMBER rather than inventing a reading: there
 * is no clip for 41, and a silently dropped number would leave "Ойролцоогоор …
 * минутын дараа" with a hole in the middle.
 */
export function announceArrival(
  arrival: Arrival,
  hasClip: (key: string) => boolean,
): Announcement | null {
  if (!Number.isFinite(arrival.minutes) || arrival.minutes < 1) return null;
  if (arrival.minutes > MAX_SPOKEN_NUMBER) return null;

  const route = routeKey(arrival.routeId);
  const keys: string[] = [];

  if (hasClip(route)) keys.push(route);

  // The hedge. Present unless the datum is genuinely live — which nothing in
  // this feed currently is.
  if (arrival.source !== "realtime") keys.push("bus_approx_prefix");

  keys.push(numberKey(arrival.minutes), "bus_minutes_suffix");

  return {
    keys,
    priority: "normal",
    dedupeKey: `arrival-${arrival.routeId}`,
    label: `${arrival.routeDisplayName} ~${arrival.minutes} min (${arrival.source})`,
  };
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

export function announceDegraded(reason: DegradedReason): Announcement {
  return {
    keys: [DEGRADED_PHRASE[reason]],
    priority: "normal",
    dedupeKey: "degraded",
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
export function announceTrackingDegraded(): Announcement {
  return {
    keys: ["bus_tracking_degraded"],
    priority: "critical",
    dedupeKey: "tracking-degraded",
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
export function announceRemaining(
  remaining: number,
  stop: { id: string; name: string },
  hasClip: (key: string) => boolean,
): Announcement | null {
  const name = hasClip(stopKey(stop.id)) ? stopKey(stop.id) : "bus_unnamed_stop";

  if (remaining < 0) {
    return {
      keys: ["bus_passed_stop"],
      priority: "critical",
      dedupeKey: "overshoot",
      label: "PASSED the destination",
    };
  }

  if (remaining === 0) {
    return {
      keys: [name, "bus_get_off_now"],
      priority: "critical",
      dedupeKey: "arrived",
      label: `ARRIVED at ${stop.name}`,
    };
  }

  if (remaining === 1) {
    return {
      keys: ["bus_next_stop", name, "bus_get_ready"],
      priority: "normal",
      dedupeKey: "remaining-1",
      label: `next stop ${stop.name} — get ready`,
    };
  }

  if (remaining === 2 || remaining === 3) {
    return {
      keys: [numberKey(remaining), "bus_stops_remaining"],
      priority: "normal",
      dedupeKey: `remaining-${remaining}`,
      label: `${remaining} stops remaining`,
    };
  }

  return null;
}

/**
 * Vibration pattern per countdown step, in the same place as the speech so the
 * two cannot drift apart. Milliseconds, navigator.vibrate format.
 */
export function vibrationFor(remaining: number): number[] | null {
  if (remaining < 0) return [200, 100, 200, 100, 200];
  if (remaining === 0) return [800];
  if (remaining === 1) return [150];
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
