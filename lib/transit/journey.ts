/**
 * The journey state machine.
 *
 *   IDLE → DESTINATION_SET → PLANNED → WAITING → APPROACHING → ARRIVED_AT_STOP
 *        → BOARDED → RIDING → NEARING_DESTINATION → ALIGHT
 *
 * EVERY TRANSITION ANNOUNCES ITSELF. To a user who cannot see the screen, a
 * transition that produces no sound did not happen — and the specific failure
 * that strands someone is a state change they were never told about. So the
 * reducer returns announcements alongside the new state, and there is no way to
 * change phase without producing some.
 *
 * Pure, in the manner of stop-matcher.ts: no storage, no clock, no React. The
 * caller supplies `now` and persists the result. That is what lets a whole
 * journey — including the feed dying halfway through — be replayed in a test.
 *
 * TWO RULES ENCODED STRUCTURALLY:
 *
 *   The hedge distinction. Live-derived announcements are built only from an
 *   `ArrivalClaim` of kind "live"; every other path produces the estimate
 *   phrasing. A caller cannot opt in to the confident wording.
 *
 *   Boarding is reversible. BOARDED is entered on detection but carries an undo
 *   until the user confirms or the bus has plainly departed, because detection
 *   is a guess and a wrong guess sends the countdown off early.
 */
import { JOURNEY, RIDE } from "@/lib/ui/announcements";
import { TTL, vibrationFor } from "./announce";
import type { Announcement } from "./audio-queue";
import { mayAnnounceArrival, type ArrivalClaim, type FeedHealth } from "./vehicles";

export type JourneyPhase =
  | "IDLE"
  | "DESTINATION_SET"
  | "PLANNED"
  | "WAITING"
  | "APPROACHING"
  | "ARRIVED_AT_STOP"
  | "BOARDED"
  | "RIDING"
  | "NEARING_DESTINATION"
  | "ALIGHT";

/** Legal transitions. Anything absent here is a bug, not a possibility. */
const TRANSITIONS: Record<JourneyPhase, JourneyPhase[]> = {
  IDLE: ["DESTINATION_SET"],
  DESTINATION_SET: ["PLANNED", "IDLE"],
  PLANNED: ["WAITING", "IDLE"],
  // A bus can be at the stop before we ever see it approach.
  WAITING: ["APPROACHING", "ARRIVED_AT_STOP", "BOARDED", "IDLE"],
  APPROACHING: ["ARRIVED_AT_STOP", "BOARDED", "WAITING", "IDLE"],
  // BOARDED can fall back to WAITING — detection is reversible.
  ARRIVED_AT_STOP: ["BOARDED", "WAITING", "IDLE"],
  BOARDED: ["RIDING", "WAITING", "IDLE"],
  RIDING: ["NEARING_DESTINATION", "ALIGHT", "IDLE"],
  NEARING_DESTINATION: ["ALIGHT", "RIDING", "IDLE"],
  ALIGHT: ["IDLE"],
};

export type JourneyPlan = {
  routeId: string;
  routeDisplayName: string;
  directionId: number;
  boardingStopId: string;
  boardingIndex: number;
  destinationStopId: string;
  destinationIndex: number;
  /** Present when the trip needs a change. Announced BEFORE boarding. */
  transfer: { atStopId: string; toRouteId: string; toRouteDisplayName: string } | null;
};

export type JourneyState = {
  phase: JourneyPhase;
  destinationStopId: string | null;
  plan: JourneyPlan | null;
  /** Index in the route sequence, mirrored from the GPS stop-matcher. */
  currentIndex: number | null;
  /** Set while BOARDED is still undoable. */
  boardingReversible: boolean;
  /** Plate of the vehicle we believe the user boarded, when live data named one. */
  boardedVehiclePlate: string | null;
  /** True once the live feed has been announced as lost, so we say it once. */
  liveLostAnnounced: boolean;
  /** Last phase entry time, for persistence staleness. */
  updatedAt: number;
};

export function createJourney(now: number): JourneyState {
  return {
    phase: "IDLE",
    destinationStopId: null,
    plan: null,
    currentIndex: null,
    boardingReversible: false,
    boardedVehiclePlate: null,
    liveLostAnnounced: false,
    updatedAt: now,
  };
}

export type JourneyEvent =
  | { type: "destination-chosen"; stopId: string }
  | { type: "plan-found"; plan: JourneyPlan }
  | { type: "plan-failed" }
  | { type: "wait-started" }
  /** From the live feed, already gated by vehicles.ts. */
  | { type: "vehicle-update"; claim: ArrivalClaim; next: ArrivalClaim | null; feed: FeedHealth }
  | { type: "boarding-detected"; plate: string | null }
  | { type: "boarding-confirmed" }
  /** The reversal. One gesture, always available while boardingReversible. */
  | { type: "boarding-rejected" }
  | { type: "stop-passed"; index: number; stopId: string; remaining: number }
  | { type: "arrived-at-destination" }
  | { type: "journey-cancelled" }
  | { type: "resumed" };

export type JourneyResult = { state: JourneyState; announcements: Announcement[] };

/** Names a stop or route by manifest key, falling back to the generic clip. */
export type Naming = {
  stopKey: (stopId: string) => string;
  routeKey: (routeId: string) => string;
  has: (key: string) => boolean;
};

const number = (n: number) => `num_${n}`;

/**
 * Builds an announcement, dropping keys with no rendered clip.
 *
 * `at` is the reducer's own `now`, so the lifetime is measured from the event
 * that caused the announcement rather than from whenever the queue got round to
 * stamping it. Callers that omit it get a routine lifetime; the ones that
 * matter — arrival, overshoot — pass their own.
 */
function say(
  naming: Naming,
  keys: (string | null)[],
  opts: {
    priority?: Announcement["priority"];
    dedupeKey?: string;
    label: string;
    earcon?: Announcement["earcon"];
    haptic?: number[];
    cooldownMs?: number;
    at?: number;
    ttlMs?: number;
  },
): Announcement {
  return {
    keys: keys.filter((k): k is string => Boolean(k)).filter(naming.has),
    priority: opts.priority ?? "normal",
    dedupeKey: opts.dedupeKey,
    earcon: opts.earcon,
    haptic: opts.haptic,
    cooldownMs: opts.cooldownMs,
    expiresAt: (opts.at ?? Date.now()) + (opts.ttlMs ?? TTL.ROUTINE),
    label: opts.label,
  };
}

function enter(state: JourneyState, phase: JourneyPhase, now: number): JourneyState {
  if (!TRANSITIONS[state.phase].includes(phase)) {
    // Not thrown: a bad transition mid-journey must not crash the screen a user
    // is depending on. It is refused and the caller keeps the old state.
    return state;
  }
  return { ...state, phase, updatedAt: now };
}

/**
 * One event. Returns the next state and everything to say about it.
 *
 * Never mutates its input.
 */
export function reduce(
  state: JourneyState,
  event: JourneyEvent,
  naming: Naming,
  now: number,
): JourneyResult {
  switch (event.type) {
    case "destination-chosen": {
      const next = { ...enter(state, "DESTINATION_SET", now), destinationStopId: event.stopId };
      return {
        state: next,
        announcements: [say(naming, [naming.stopKey(event.stopId), JOURNEY.planning.clip],
          { label: `destination ${event.stopId}`, dedupeKey: "destination" })],
      };
    }

    case "plan-found": {
      const next = { ...enter(state, "PLANNED", now), plan: event.plan };
      const stops = event.plan.destinationIndex - event.plan.boardingIndex;

      // "Ч:35 хэрэгтэй. 8 буудал явна." — a plan, not a data dump.
      const lines: Announcement[] = [
        say(naming, [
          naming.routeKey(event.plan.routeId), JOURNEY.routeNeededSuffix.clip,
          stops > 0 && stops <= 40 ? number(stops) : null,
          stops > 0 && stops <= 40 ? JOURNEY.stopsToTravelSuffix.clip : null,
        ], { label: `plan: ${event.plan.routeDisplayName}, ${stops} stops`, dedupeKey: "plan" }),
      ];

      // The transfer is announced NOW, before boarding — not at the transfer
      // point, where it is a nasty surprise to someone already committed.
      if (event.plan.transfer) {
        lines.push(say(naming, [
          JOURNEY.transferWarning.clip, JOURNEY.transferAtPrefix.clip,
          naming.stopKey(event.plan.transfer.atStopId),
          naming.routeKey(event.plan.transfer.toRouteId),
        ], { label: `transfer at ${event.plan.transfer.atStopId}`, dedupeKey: "transfer" }));
      }

      return { state: next, announcements: lines };
    }

    case "plan-failed":
      return {
        state: enter(state, "IDLE", now),
        announcements: [say(naming, [JOURNEY.noRoute.clip], { label: "no route", dedupeKey: "no-route" })],
      };

    case "wait-started":
      return {
        state: enter(state, "WAITING", now),
        announcements: [say(naming, [JOURNEY.liveUnavailable.clip], { label: "waiting", dedupeKey: "wait-start" })]
          .filter((a) => a.keys.length > 0),
      };

    case "vehicle-update":
      return vehicleUpdate(state, event, naming, now);

    case "boarding-detected": {
      const moved = enter(state, "BOARDED", now);
      if (moved.phase !== "BOARDED") return { state, announcements: [] };
      const next = { ...moved, boardingReversible: true, boardedVehiclePlate: event.plate };
      return {
        state: next,
        announcements: [say(naming, [
          JOURNEY.boardedDetected.clip,
          // Live data can name the actual vehicle, which is a much stronger
          // confirmation than "something is moving".
          event.plate ? JOURNEY.plateNumberPrefix.clip : null,
          JOURNEY.boardedUndoHint.clip,
        ], { label: `boarded${event.plate ? ` (${event.plate})` : ""}`, dedupeKey: "boarded", priority: "critical" })],
      };
    }

    case "boarding-confirmed": {
      const next = { ...enter(state, "RIDING", now), boardingReversible: false };
      return { state: next, announcements: [] };
    }

    case "boarding-rejected": {
      // The undo. Back to waiting, and say so — silence here would leave the
      // user believing the countdown is still running.
      if (!state.boardingReversible) return { state, announcements: [] };
      const next = { ...enter(state, "WAITING", now), boardingReversible: false, boardedVehiclePlate: null };
      return {
        state: next,
        announcements: [say(naming, [JOURNEY.boardedUndone.clip],
          { label: "boarding undone", dedupeKey: "board-undo", priority: "critical" })],
      };
    }

    case "stop-passed": {
      // The first counted stop settles the boarding question: the bus is
      // demonstrably moving along the route, so the undo is withdrawn.
      const base: JourneyState = {
        ...state,
        currentIndex: event.index,
        boardingReversible: false,
      };
      const phase = event.remaining <= 3 && event.remaining > 0 ? "NEARING_DESTINATION" : "RIDING";
      const next = enter(base, phase, now);

      return {
        state: next,
        announcements: [ridingAnnouncement(event, naming, now)].filter((a): a is Announcement => a !== null),
      };
    }

    case "arrived-at-destination": {
      const next = enter(state, "ALIGHT", now);
      return {
        state: next,
        announcements: [say(naming, [RIDE.getOffNow.clip],
          { label: "ALIGHT", dedupeKey: "alight", priority: "critical" })],
      };
    }

    case "journey-cancelled":
      return {
        state: { ...createJourney(now) },
        announcements: [say(naming, [JOURNEY.finished.clip], { label: "cancelled", dedupeKey: "finished" })],
      };

    case "resumed":
      return {
        state: { ...state, updatedAt: now },
        announcements: [say(naming, [JOURNEY.resumed.clip], { label: "resumed", dedupeKey: "resumed" })],
      };
  }
}

/**
 * The live-vs-hedged fork, in one place.
 *
 * A confident announcement is reachable ONLY through `claim.kind === "live"`,
 * and the arrival wording additionally through `mayAnnounceArrival`. Everything
 * else lands on the estimate phrasing.
 */
function vehicleUpdate(
  state: JourneyState,
  event: Extract<JourneyEvent, { type: "vehicle-update" }>,
  naming: Naming,
  now: number,
): JourneyResult {
  const { claim, feed } = event;
  const routeId = state.plan?.routeId ?? null;
  const routeClip = routeId ? naming.routeKey(routeId) : null;

  // --- the feed died mid-journey ----------------------------------------
  // Degrade LOUDLY. Silence reads as "nothing has changed", which is the one
  // interpretation that leaves someone standing at a stop indefinitely.
  if (feed.state === "error" || feed.state === "empty" || feed.state === "suspect") {
    if (state.liveLostAnnounced) return { state, announcements: [] };
    const inJourney = state.phase !== "IDLE" && state.phase !== "DESTINATION_SET";
    return {
      state: { ...state, liveLostAnnounced: true, updatedAt: now },
      announcements: inJourney
        ? [say(naming, [JOURNEY.liveLost.clip], { label: `feed ${feed.state}`, dedupeKey: "live-lost" })]
        : [],
    };
  }

  // Feed is healthy again after having been lost — allow the next loss to speak.
  const cleared = state.liveLostAnnounced ? { ...state, liveLostAnnounced: false } : state;

  if (claim.kind === "no-vehicle" || claim.kind === "unverified") {
    // No confident claim available. The caller falls back to the schedule
    // estimate, which is spoken with its own explicit flag elsewhere; here we
    // only make sure the phase does not advance on unverified evidence.
    return { state: cleared, announcements: [] };
  }

  // --- ARRIVED ------------------------------------------------------------
  if (mayAnnounceArrival(claim, now, feed)) {
    const next = enter(cleared, "ARRIVED_AT_STOP", now);
    return {
      state: next,
      announcements: [say(naming, [routeClip, JOURNEY.arrived.clip],
        { label: `ARRIVED ${claim.vehicle.plateNumber}`, dedupeKey: "arrived", priority: "critical" })],
    };
  }

  // --- APPROACHING --------------------------------------------------------
  if (claim.stopsAway <= 1) {
    const next = enter(cleared, "APPROACHING", now);
    return {
      state: next,
      announcements: [say(naming, [routeClip, JOURNEY.approaching.clip],
        { label: `approaching (${Math.round(claim.distanceM)} m)`, dedupeKey: "approaching" })],
    };
  }

  // --- LIVE DISTANCE, no hedge -------------------------------------------
  // Re-announced on CHANGE of stop count, not on a timer. Someone standing in
  // the cold wants to know when something changes, not a countdown every ten
  // seconds — the dedupeKey carries the value so an unchanged one collapses.
  return {
    state: cleared,
    announcements: [say(naming, [
      routeClip,
      claim.stopsAway <= 40 ? number(claim.stopsAway) : null,
      JOURNEY.liveStopsAwaySuffix.clip,
      claim.etaMinutes !== null && claim.etaMinutes <= 40 ? number(claim.etaMinutes) : null,
      claim.etaMinutes !== null && claim.etaMinutes <= 40 ? "bus_minutes_suffix" : null,
    ], {
      label: `LIVE ${claim.stopsAway} stops, ${claim.etaMinutes ?? "?"} min`,
      dedupeKey: `live-${claim.stopsAway}-${claim.etaMinutes ?? "x"}`,
    })],
  };
}

/**
 * Which passing stops get spoken.
 *
 * Every stop within the last five, every third before that. Announcing all of
 * them on a 36-stop run trains the user to stop listening, and the value of the
 * last few is entirely that they are rare enough to be heard.
 */
export function shouldAnnounceStop(remaining: number): boolean {
  if (remaining <= 5) return true;
  return remaining % 3 === 0;
}

function ridingAnnouncement(
  event: Extract<JourneyEvent, { type: "stop-passed" }>,
  naming: Naming,
  now: number,
): Announcement | null {
  const { remaining, stopId } = event;
  if (remaining < 0) return null;
  if (!shouldAnnounceStop(remaining)) return null;

  const name = naming.has(naming.stopKey(stopId)) ? naming.stopKey(stopId) : "bus_unnamed_stop";

  // "{name} өнгөрлөө. {N} буудал үлдлээ."
  return {
    keys: [name, JOURNEY.passedSuffix.clip, remaining > 0 && remaining <= 40 ? number(remaining) : null,
      remaining > 0 ? RIDE.stopsRemaining.clip : null]
      .filter((k): k is string => Boolean(k)).filter(naming.has),
    priority: remaining <= 1 ? "critical" : "normal",
    earcon: remaining <= 1 ? "alert" : "soft",
    haptic: vibrationFor(remaining) ?? undefined,
    // Keyed on the INDEX, so GPS jitter re-reporting the same stop cannot
    // repeat the announcement.
    dedupeKey: `passed-${event.index}`,
    // The last stop before the destination is the one whose value is entirely
    // in arriving on time; the earlier ones can afford to wait their turn.
    expiresAt: now + (remaining <= 1 ? TTL.IMMEDIATE : TTL.ROUTINE),
    label: `passed ${stopId}, ${remaining} remaining`,
  };
}

// ------------------------------------------------------------ persistence

const STORAGE_KEY = "vision-access:journey";
const SCHEMA = 1;

/**
 * A journey older than this is not resumed.
 *
 * Coming back to a half-finished journey from yesterday and having the app
 * resume counting is worse than starting clean — the bus is long gone, and the
 * countdown would be confidently wrong from the first announcement.
 */
export const RESUME_WINDOW_MS = 3 * 60 * 60 * 1000;

export function persist(state: JourneyState, storage: Storage): void {
  try {
    if (state.phase === "IDLE") {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify({ schema: SCHEMA, state }));
  } catch {
    // Private mode. The journey still works; it just will not survive a reload.
  }
}

export function restore(storage: Storage, now: number): JourneyState | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { schema?: number; state?: JourneyState };
    if (parsed.schema !== SCHEMA || !parsed.state) return null;
    if (now - parsed.state.updatedAt > RESUME_WINDOW_MS) return null;
    if (!(parsed.state.phase in TRANSITIONS)) return null;
    return parsed.state;
  } catch {
    return null;
  }
}

export function clearPersisted(storage: Storage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch { /* private mode */ }
}
