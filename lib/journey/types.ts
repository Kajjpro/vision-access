/**
 * ONE journey, as a single object.
 *
 * WHAT THIS REPLACES. The bus flow was three routes — `/bus/wait`,
 * `/bus/journey`, `/bus/ride` — each holding its own `phase` string, joined by a
 * sessionStorage handoff. Every screen knew its own middle and nothing knew the
 * whole, so the questions a rider actually asks ("what is happening", "did I get
 * on the right bus", "how much longer") had no single place to be answered from.
 * This is that place.
 *
 * WHAT IT DELIBERATELY CANNOT SAY. There is no live vehicle feed — the City
 * gateway is closed to us (docs/city-gateway.md), and every attempt to open it
 * is recorded there. So this model has no vehicle position, no "the bus is two
 * stops away", no delay detection and no seat count, because inventing any of
 * them would produce a confident sentence a blind rider would step into traffic
 * on. `busDueAt` is SCHEDULE-derived and is always spoken hedged.
 *
 * That absence is exactly why `confirming_boarding` exists. The one thing the
 * app cannot observe, it asks about — and the answer is worth more than the
 * detection would have been, because it is ground truth from the person there.
 */

import type { Stop } from "../transit/types";

/**
 * How much the guide says, per the accessibility settings.
 *
 * `standard` is the default and is NOT "standard amount of speech" — see
 * lib/journey/pacer.ts. It is silence plus a non-verbal heartbeat, because
 * CLAUDE.md's rule that audio is not a progress bar and the requirement that
 * the app never go unexplainably quiet are both true, and a tone satisfies both
 * where a sentence satisfies only the second.
 */
export type GuidanceLevel = "minimal" | "standard" | "detailed";

/**
 * WHERE A BUS TIME CAME FROM, and therefore what may be said about it.
 *
 * This is the distinction the whole waiting half of the app turns on. A rider
 * steps toward a road on the strength of these words, and "the bus is arriving"
 * and "the timetable says a bus is due" are different claims about the world:
 * the first asserts a vehicle was observed, the second asserts only that a
 * printed schedule exists.
 *
 * We have never observed a vehicle (docs/city-gateway.md). Everything the OTP
 * proxy returns is `schedule` or `headway`, so `live` is currently unreachable
 * — and it is modelled anyway, because the alternative is that opening the feed
 * later means auditing every call site to find which ones were quietly
 * assuming. `evidenceFor` is the single mapping, and nothing else may decide.
 */
export type ArrivalEvidence = "timetable" | "live";

/**
 * The only place `Arrival.source` becomes a claim about evidence.
 *
 * `headway` is timetable, not live: a headway estimate is "buses on this route
 * come about every N minutes", which is further from an observation than the
 * schedule is, not closer.
 */
export function evidenceFor(source: "schedule" | "headway" | "realtime"): ArrivalEvidence {
  return source === "realtime" ? "live" : "timetable";
}

/** Why the rider is being asked whether they boarded. Changes the wording. */
export type BoardingAskReason =
  /** The estimate says a bus should be here now. */
  | "due"
  /**
   * The estimate has been and gone with no answer.
   *
   * The app must NOT conclude from this that a bus came, or that it did not.
   * It knows only that a printed time has passed. So it asks.
   */
  | "expired";

/** What the rider said when asked whether they got on. */
export type BoardingAnswer = "boarded" | "not_boarded" | "unsure";

/**
 * The states, in the order a journey passes through them.
 *
 * Two of the brief's states are deliberately absent and their absence is the
 * honest part of this model:
 *
 *   BUS_APPROACHING / BUS_ARRIVED — collapsed into `bus_due`. Both require
 *   watching a physical vehicle close on a kerb. What we have is a timetable,
 *   and a timetable can only ever say "due". Splitting them would put two
 *   different confidence levels behind one word.
 *
 *   WALKING_TO_DESTINATION — a post-alight walking leg needs a compass heading
 *   and turn-by-turn data this repository does not have. `arrived` reports the
 *   remaining distance, which is computable and true, and stops there rather
 *   than fabricating "walk straight for eighty metres".
 */
export type JourneyState =
  | "idle"
  | "selecting_destination"
  | "analyzing_route"
  | "route_selected"
  | "walking_to_stop"
  | "waiting_for_bus"
  | "bus_due"
  | "confirming_boarding"
  | "on_bus"
  | "approaching_destination"
  | "confirming_exit"
  | "arrived"
  | "journey_error";

/** Every state in which a journey is actively being guided. */
export const ACTIVE_STATES: ReadonlySet<JourneyState> = new Set<JourneyState>([
  "walking_to_stop",
  "waiting_for_bus",
  "bus_due",
  "confirming_boarding",
  "on_bus",
  "approaching_destination",
  "confirming_exit",
]);

/** States that exist to hold a question open until the rider answers it. */
export const QUESTION_STATES: ReadonlySet<JourneyState> = new Set<JourneyState>([
  "confirming_boarding",
  "confirming_exit",
]);

export type JourneyRoute = {
  routeId: string;
  /** 0 or 1 — the OTP pattern directionId, matching route-stops.json. */
  directionId: number;
  /** Matches signage: `Ч:35`. */
  displayName: string;
  headsign: string;
  /** Index into route-stops.json[routeId][directionId]. NOT a stop id. */
  boardingIndex: number;
  destinationIndex: number;
};

export type Fix = { lat: number; lon: number; accuracyM: number; at: number };

/**
 * Why a journey stopped being guidable. One member per CAUSE, never one generic
 * "error": each of these sends the rider to a different action, and the wrong
 * phrase wastes the only move they might make.
 */
export type JourneyFault =
  | "location_unavailable"
  /**
   * A fix arrived, and no served stop is near it.
   *
   * NOT the same as `location_unavailable`, and they must never share a phrase.
   * "No stop nearby" sends someone walking to find one; a bad fix means standing
   * still under open sky is the right move. Telling a blind rider to walk when
   * the real problem is a roof wastes the one action they might take.
   */
  | "no_stop_nearby"
  | "network_unavailable"
  | "no_route"
  | "route_data_missing"
  | "tracking_lost"
  | "wrong_bus";

export type Journey = {
  id: string;
  state: JourneyState;
  /** For "what just changed", and for the progress readout's step labelling. */
  previousState: JourneyState | null;
  guidanceLevel: GuidanceLevel;
  /**
   * Whether the non-verbal heartbeat may fire at all.
   *
   * Separate from the level rather than folded into it: a rider can want
   * `detailed` spoken guidance and still not want a tone in their ear every two
   * minutes, and someone using a hearing aid or a single earbud in traffic may
   * want the opposite. Tying them together would force a choice neither of them
   * asked for.
   */
  heartbeatEnabled: boolean;

  /** Where the rider boards. Set once the stop is confirmed, never guessed. */
  origin: Stop | null;
  destination: Stop | null;
  route: JourneyRoute | null;

  userLocation: Fix | null;

  /**
   * When the chosen bus is expected, epoch ms, from the OTP proxy.
   *
   * SCHEDULE DATA. Never a sighting. `lib/transit/eta.ts` owns turning this into
   * words and puts "Ойролцоогоор" in front of every one of them; nothing may
   * read this field and speak an unhedged time from it.
   */
  busDueAt: number | null;

  /**
   * What kind of claim `busDueAt` is. Null when there is no estimate at all.
   *
   * Read by `guide.ts` to choose the register and by `present.ts` to label the
   * number on screen. A `busDueAt` with no evidence beside it is a number with
   * no provenance, which is the thing this field exists to make impossible.
   */
  busDueSource: ArrivalEvidence | null;

  /** Set when the boarding question is raised, so the wording can differ. */
  boardingAskReason: BoardingAskReason | null;

  /**
   * When the rider SAID they were on board — not when we decided they were.
   *
   * Null through the whole waiting phase, and the ride countdown does not start
   * until it is set. Assuming boarding is the failure that puts someone on the
   * wrong bus with a confident voice counting down the wrong stops.
   */
  boardingConfirmedAt: number | null;
  /** How many buses have come and gone unboarded. Drives the missed-bus path. */
  missedBuses: number;

  /** Stops until the destination. Negative means overshot. */
  remainingStops: number | null;
  etaSeconds: number | null;

  /** Metres to the boarding stop while walking; null once there. */
  distanceToStopM: number | null;

  fault: JourneyFault | null;

  /** Pacing state — read by lib/journey/pacer.ts, written by the caller. */
  lastAnnouncementAt: number | null;
  /** Dedupe handle for the last thing said, so the pacer never repeats it. */
  lastAnnouncementLabel: string | null;

  startedAt: number;
  updatedAt: number;
};

export function createJourney(now: number, id = `j-${now}`): Journey {
  return {
    id,
    state: "idle",
    previousState: null,
    guidanceLevel: "standard",
    heartbeatEnabled: true,
    origin: null,
    destination: null,
    route: null,
    userLocation: null,
    busDueAt: null,
    busDueSource: null,
    boardingAskReason: null,
    boardingConfirmedAt: null,
    missedBuses: 0,
    remainingStops: null,
    etaSeconds: null,
    distanceToStopM: null,
    fault: null,
    lastAnnouncementAt: null,
    lastAnnouncementLabel: null,
    startedAt: now,
    updatedAt: now,
  };
}
