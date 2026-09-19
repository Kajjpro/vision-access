/**
 * The journey state machine. Pure, total, and the only thing allowed to move a
 * journey from one state to another.
 *
 * WHY A TABLE RATHER THAN BOOLEANS. The flow it replaces was `phase` strings
 * set from inside event handlers across three screens, which meant the set of
 * reachable states was whatever the handlers happened to do. Two bugs live in
 * that shape and both are silent: a screen that advances on an event it should
 * have ignored, and a screen that answers a question the rider was never asked.
 * Here the legal moves are data, `nextStates()` can be read off it, and an
 * illegal event is REJECTED rather than applied — the caller is told, and the
 * journey is unchanged.
 *
 * THE BOARDING GATE IS THE POINT OF THE WHOLE FILE. There is no path from
 * `bus_due` to `on_bus` that does not pass through `confirming_boarding` and a
 * `boarding_answered` event carrying the rider's own yes. The app cannot see a
 * bus (docs/city-gateway.md), so it must not infer that one was boarded; every
 * stop count spoken afterwards rests on that single answer being real.
 */

import type {
  ArrivalEvidence, BoardingAnswer, BoardingAskReason, Fix, Journey, JourneyFault, JourneyRoute,
  JourneyState,
} from "./types";
import type { Stop } from "../transit/types";

export type JourneyEvent =
  /** The rider asked to go somewhere. */
  | { type: "destination_requested" }
  /** A destination survived the read-back. Never set without confirmation. */
  | { type: "destination_confirmed"; destination: Stop }
  | { type: "routes_analyzed" }
  /**
   * A specific boarding stop, route and direction were chosen.
   *
   * `busDueSource` travels with `busDueAt` and is not optional: a time with no
   * provenance is exactly what this journey must never carry, because the
   * register it may be spoken in depends entirely on where it came from.
   */
  | {
      type: "route_chosen";
      route: JourneyRoute;
      origin: Stop;
      busDueAt: number | null;
      busDueSource: ArrivalEvidence | null;
    }
  /** A refreshed estimate for the bus already chosen. */
  | { type: "estimate_updated"; busDueAt: number | null; busDueSource: ArrivalEvidence | null }
  /** Guidance started. Walking if the stop is far, waiting if we are at it. */
  | { type: "guidance_started"; distanceToStopM: number | null }
  | { type: "reached_stop" }
  /** The schedule countdown reached `due`. Not a sighting — see types.ts. */
  | { type: "bus_due" }
  /** The rider is being asked whether they got on, and why we are asking. */
  | { type: "boarding_question_raised"; reason: BoardingAskReason }
  | { type: "boarding_answered"; answer: BoardingAnswer }
  /** The rider chose to wait for the next bus after not boarding. */
  | { type: "wait_for_next"; busDueAt: number | null; busDueSource: ArrivalEvidence | null }
  /** Position along the route moved. The ride's only progress input. */
  | { type: "position_updated"; remainingStops: number; etaSeconds: number | null }
  /** Walking progress toward the boarding stop. */
  | { type: "walk_progress"; distanceToStopM: number }
  | { type: "exit_question_raised" }
  | { type: "exit_answered"; exited: boolean }
  | { type: "location_updated"; fix: Fix }
  | { type: "guidance_level_set"; level: Journey["guidanceLevel"] }
  /** Something the rider must be told about, and cannot be guided through. */
  | { type: "failed"; fault: JourneyFault }
  /** A fault cleared — GPS came back, the network returned. */
  | { type: "recovered"; to: JourneyState }
  | { type: "reset" };

export type TransitionResult = {
  journey: Journey;
  /** False when the event was not legal here. The journey is returned unchanged. */
  applied: boolean;
  /** Present when `applied` is false — for the debug panel, never spoken. */
  rejected?: string;
};

/**
 * When the alighting ladder takes over.
 *
 * Matches `alightingRung` in lib/countdown/ladder.ts, which is silent above 3
 * and speaks at 3, 2, 1 and arrival. The state changes at the same boundary so
 * that "approaching destination" means exactly "the ladder is now talking",
 * rather than being a second, differently-tuned idea of nearly-there.
 */
export const APPROACHING_STOPS = 3;

/**
 * How close counts as "at the stop", metres.
 *
 * Deliberately generous. GPS in the downtown canyon drifts further than this
 * (CLAUDE.md), so a tight radius would leave a rider standing at the kerb being
 * told to keep walking — and unlike a sighted user they cannot look up and see
 * that they have arrived. Being told "you are at the stop" thirty metres early
 * costs nothing; being told to walk on when you are already there costs the bus.
 */
export const AT_STOP_M = 40;

/**
 * Legal moves, as data.
 *
 * `journey_error` is reachable from every active state and is therefore not
 * listed on each of them — see `isLegal`. Everything else is explicit, so
 * reading this table tells you the whole shape of the flow.
 */
const TRANSITIONS: Record<JourneyState, ReadonlySet<JourneyState>> = {
  idle: new Set(["selecting_destination"]),
  selecting_destination: new Set(["analyzing_route", "selecting_destination"]),
  analyzing_route: new Set(["route_selected", "selecting_destination"]),
  route_selected: new Set(["walking_to_stop", "waiting_for_bus", "selecting_destination"]),
  walking_to_stop: new Set(["walking_to_stop", "waiting_for_bus"]),
  // bus_due can return to waiting: a bus that was due and did not come is a
  // wait that continues, not a journey that ended.
  waiting_for_bus: new Set(["bus_due", "confirming_boarding", "waiting_for_bus"]),
  bus_due: new Set(["confirming_boarding", "waiting_for_bus", "bus_due"]),
  // The only way into on_bus, and the only way back out to waiting.
  confirming_boarding: new Set(["on_bus", "waiting_for_bus", "analyzing_route"]),
  on_bus: new Set(["approaching_destination", "on_bus", "confirming_exit"]),
  // Back to on_bus is legal: an overshoot re-opens the count, and a jittery fix
  // that briefly reads 4 stops should not strand the rider in the wrong state.
  approaching_destination: new Set(["confirming_exit", "on_bus", "approaching_destination"]),
  confirming_exit: new Set(["arrived", "on_bus", "approaching_destination"]),
  arrived: new Set(["idle", "selecting_destination"]),
  journey_error: new Set([
    "idle",
    "selecting_destination",
    "analyzing_route",
    "walking_to_stop",
    "waiting_for_bus",
    "bus_due",
    "on_bus",
    "approaching_destination",
  ]),
};

/** Every state a journey could legally reach next. Drives the debug panel. */
export function nextStates(from: JourneyState): JourneyState[] {
  const direct = [...(TRANSITIONS[from] ?? [])];
  return from === "journey_error" || from === "arrived" || from === "idle"
    ? direct
    : [...direct, "journey_error"];
}

function isLegal(from: JourneyState, to: JourneyState): boolean {
  if (to === "journey_error") return from !== "journey_error";
  return TRANSITIONS[from]?.has(to) ?? false;
}

function move(journey: Journey, to: JourneyState, now: number, patch: Partial<Journey> = {}): TransitionResult {
  if (!isLegal(journey.state, to)) {
    return {
      journey,
      applied: false,
      rejected: `${journey.state} -> ${to} is not a legal transition`,
    };
  }
  return {
    journey: {
      ...journey,
      ...patch,
      state: to,
      previousState: journey.state,
      updatedAt: now,
    },
    applied: true,
  };
}

/** Applies a patch without changing state. Always legal. */
function stay(journey: Journey, now: number, patch: Partial<Journey>): TransitionResult {
  return { journey: { ...journey, ...patch, updatedAt: now }, applied: true };
}

function ignored(journey: Journey, event: JourneyEvent): TransitionResult {
  return { journey, applied: false, rejected: `${event.type} is not meaningful in ${journey.state}` };
}

/**
 * The whole machine.
 *
 * Total: every (state, event) pair returns something. An event that does not
 * belong in the current state is ignored with a reason rather than throwing,
 * because the events come from GPS fixes and timers that do not stop arriving
 * just because the rider has moved on.
 */
export function transition(journey: Journey, event: JourneyEvent, now: number): TransitionResult {
  switch (event.type) {
    // Location and guidance level are journey-wide facts, legal in any state.
    case "location_updated":
      return stay(journey, now, { userLocation: event.fix });

    case "guidance_level_set":
      return stay(journey, now, { guidanceLevel: event.level });

    case "reset":
      return move(journey, "idle", now, {
        destination: null,
        route: null,
        origin: null,
        busDueAt: null,
        boardingConfirmedAt: null,
        boardingAskReason: null,
        busDueSource: null,
        missedBuses: 0,
        remainingStops: null,
        etaSeconds: null,
        distanceToStopM: null,
        fault: null,
      });

    case "failed":
      return move(journey, "journey_error", now, { fault: event.fault });

    case "recovered":
      return move(journey, event.to, now, { fault: null });

    case "destination_requested":
      return move(journey, "selecting_destination", now);

    case "destination_confirmed":
      return move(journey, "analyzing_route", now, { destination: event.destination });

    case "routes_analyzed":
      return move(journey, "route_selected", now);

    case "route_chosen":
      return move(journey, "route_selected", now, {
        route: event.route,
        origin: event.origin,
        busDueAt: event.busDueAt,
        busDueSource: event.busDueSource,
      });

    case "estimate_updated":
      // Legal in any state — a refresh that lands after the rider has boarded is
      // harmless and dropping it would mean the guide answers "when is the bus"
      // from a number it already knows is older than the one it just received.
      return stay(journey, now, {
        busDueAt: event.busDueAt,
        busDueSource: event.busDueSource,
      });

    case "guidance_started": {
      // AT the stop or walking to it — one event, because the caller knows the
      // distance and the machine should not have to guess which screen is next.
      const walking = event.distanceToStopM !== null && event.distanceToStopM > AT_STOP_M;
      return move(journey, walking ? "walking_to_stop" : "waiting_for_bus", now, {
        distanceToStopM: event.distanceToStopM,
      });
    }

    case "walk_progress":
      if (journey.state !== "walking_to_stop") return ignored(journey, event);
      return event.distanceToStopM <= AT_STOP_M
        ? move(journey, "waiting_for_bus", now, { distanceToStopM: event.distanceToStopM })
        : stay(journey, now, { distanceToStopM: event.distanceToStopM });

    case "reached_stop":
      return move(journey, "waiting_for_bus", now, { distanceToStopM: 0 });

    case "bus_due":
      return move(journey, "bus_due", now);

    case "boarding_question_raised":
      return move(journey, "confirming_boarding", now, { boardingAskReason: event.reason });

    case "boarding_answered": {
      if (journey.state !== "confirming_boarding") return ignored(journey, event);

      if (event.answer === "boarded") {
        return move(journey, "on_bus", now, {
          boardingConfirmedAt: now,
          boardingAskReason: null,
        });
      }

      /**
       * NOT boarded, and NOT a failure. A missed bus is an ordinary event at a
       * bus stop; the rider is standing exactly where they should be, having
       * done nothing wrong. The count goes up so the guide can offer
       * alternatives, and the stale estimate is dropped rather than left to be
       * spoken about a bus that has gone.
       */
      if (event.answer === "not_boarded") {
        return move(journey, "waiting_for_bus", now, {
          missedBuses: journey.missedBuses + 1,
          busDueAt: null,
          busDueSource: null,
          boardingAskReason: null,
        });
      }

      /**
       * "I'M NOT SURE" IS RESOLVED TOWARD SAFETY, AND COUNTS NOTHING.
       *
       * It cannot become `on_bus`: every stop count afterwards would rest on a
       * confirmation the rider explicitly declined to give, and being guided off
       * a bus you are not on is the worst outcome this flow has.
       *
       * It also does not increment `missedBuses`, because that number drives
       * "shall I find you another route" and we have no evidence a bus was
       * missed — only that the rider cannot tell us. Inventing a missed bus from
       * an "I don't know" would be the app filling in its own facts.
       *
       * The estimate is kept, unlike the `not_boarded` case: if a bus really is
       * still coming, the rider is back to waiting for it with the number intact.
       */
      return move(journey, "waiting_for_bus", now, { boardingAskReason: null });
    }

    case "wait_for_next":
      if (journey.state !== "waiting_for_bus" && journey.state !== "bus_due") {
        return ignored(journey, event);
      }
      return stay(journey, now, {
        busDueAt: event.busDueAt,
        busDueSource: event.busDueSource,
      });

    case "position_updated": {
      if (journey.state !== "on_bus" && journey.state !== "approaching_destination") {
        return ignored(journey, event);
      }
      const patch = { remainingStops: event.remainingStops, etaSeconds: event.etaSeconds };
      // Arrival does not move the machine on its own — `confirming_exit` is
      // raised by the caller once the ladder has spoken, so the question and
      // the instruction cannot land in the wrong order.
      const target: JourneyState =
        event.remainingStops <= APPROACHING_STOPS ? "approaching_destination" : "on_bus";
      return target === journey.state
        ? stay(journey, now, patch)
        : move(journey, target, now, patch);
    }

    case "exit_question_raised":
      return move(journey, "confirming_exit", now);

    case "exit_answered":
      if (journey.state !== "confirming_exit") return ignored(journey, event);
      if (event.exited) return move(journey, "arrived", now);
      // Still on the bus. Back to whichever side of the boundary the count is
      // on, so the ladder resumes exactly where it left off.
      return move(
        journey,
        (journey.remainingStops ?? 0) <= APPROACHING_STOPS ? "approaching_destination" : "on_bus",
        now,
      );
  }
}

