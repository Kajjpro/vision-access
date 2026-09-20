/**
 * The guide: what to say when the rider asks.
 *
 * "Where am I", "how many stops", "what is happening", "help" — one answer per
 * journey state, built from the journey object rather than from whichever screen
 * happens to be mounted. That is the whole difference from what this replaces:
 * the long-press handler on each screen assembled its own answer from its own
 * local state, so the same question got a different quality of answer depending
 * on where the rider was, and two of the three screens could not answer it at
 * all once something had gone wrong.
 *
 * ── WHY THIS IS NOT AN LLM ─────────────────────────────────────────────────
 *
 * The brief calls for an "AI Guide layer" generating contextual responses. This
 * is that layer, and it is deterministic on purpose. CLAUDE.md's safety gate:
 * the model layer may rank candidates but may NEVER emit a stop or route name
 * that did not come from the deterministic matcher, and that applies to
 * announcement copy exactly as it applies to stop resolution.
 *
 * Every key returned here is either a fixed phrase or `stop_<id>` / `route_<id>`
 * built from an id already on the journey — which got there through the matcher.
 * A generated sentence could not offer that guarantee, and the failure it would
 * eventually produce is a confident, fluent, wrong stop name spoken to someone
 * who cannot check it. It would also need a network round trip at the moment
 * the rider is most likely to have no signal.
 *
 * Determinism costs nothing here: the answers are short, the states are few, and
 * a rider wants the same words for the same situation every time. Predictability
 * IS the feature when you are navigating by ear.
 */

import { TTL, announceStatus, numberKey, routeKey, stopKey } from "../transit/announce";
import type { Announcement } from "../transit/audio-queue";
import { MAX_SPOKEN_NUMBER } from "../transit/eta";
import { ASSIST, CONFIRM, DEGRADED, GUIDE, JOURNEY, RIDE, TIMETABLE, WAIT } from "../ui/announcements";
import { questionClips } from "./pacer";
import type { Journey, JourneyFault } from "./types";

/** What the rider asked. Mapped from gestures and, when it lands, voice. */
export type GuideQuestion =
  | "status"
  | "stops_left"
  | "time_left"
  | "next_stop"
  | "what_should_i_do"
  | "help";

const FAULT_CLIP: Record<JourneyFault, string> = {
  location_unavailable: DEGRADED.location.clip!,
  no_stop_nearby: WAIT.noStopNearby.clip!,
  network_unavailable: DEGRADED.network.clip!,
  no_route: JOURNEY.noRoute.clip!,
  route_data_missing: DEGRADED.routeInfo.clip!,
  tracking_lost: DEGRADED.tracking.clip!,
  // There is no rendered phrase for "you may be on the wrong bus" beyond the
  // tracking one, and inventing it by splicing fragments is what CLAUDE.md
  // forbids. The degraded-tracking phrase is honest here: it tells the rider
  // the app no longer knows where they are, which is the actionable half.
  wrong_bus: DEGRADED.tracking.clip!,
};

const keep = (keys: (string | null | undefined)[]): string[] =>
  keys.filter((k): k is string => Boolean(k));

/**
 * The stop and route names this journey is allowed to speak.
 *
 * Guarded by `hasClip` rather than assumed: 153 of 923 stops have a rendered
 * name. A missing one degrades to the rest of the sentence, which still carries
 * the count — losing a name should not cost the rider the number.
 */
function names(journey: Journey, hasClip: (key: string) => boolean) {
  const originKey = journey.origin ? stopKey(journey.origin.id) : null;
  const destinationKey = journey.destination ? stopKey(journey.destination.id) : null;
  const route = journey.route ? routeKey(journey.route.routeId) : null;
  return {
    origin: originKey && hasClip(originKey) ? originKey : null,
    destination: destinationKey && hasClip(destinationKey) ? destinationKey : null,
    route: route && hasClip(route) ? route : null,
  };
}

/**
 * The hedged minutes, or nothing.
 *
 * ALL THREE KEYS OR NONE. A suffix whose number failed to decode leaves
 * "Ойролцоогоор … минутын дараа" with a hole in the middle, which sounds like a
 * number that WAS said and misheard — see docs/arrival-times.md. And the prefix
 * is not decoration: every time this app produces is schedule-derived, so the
 * hedge is structural and there is no path here that omits it.
 */
function hedgedMinutes(
  dueAt: number | null,
  now: number,
  hasClip: (key: string) => boolean,
): string[] {
  if (dueAt === null) return [];
  const minutes = Math.round((dueAt - now) / 60_000);
  if (minutes < 1 || minutes > MAX_SPOKEN_NUMBER) return [];
  const keys = [WAIT.approxPrefix.clip!, numberKey(minutes), WAIT.minutesSuffix.clip!];
  return keys.every(hasClip) ? keys : [];
}

/**
 * The provenance of a bus time, spoken before the time itself.
 *
 * ── THE DISTINCTION THIS EXISTS FOR ────────────────────────────────────────
 *
 * "Ойролцоогоор таван минутын дараа" hedges the NUMBER. It does not hedge the
 * CLAIM: it still sounds like something is being watched and is running five
 * minutes out. Nothing is being watched. Every time this app can produce comes
 * from a printed schedule or a headway average, and a rider stepping toward a
 * road deserves to know which of those two things they are acting on.
 *
 * So a timetable estimate is led by "Цагийн хуваарийн мэдээллээр" — according
 * to the timetable — and the number follows it as a consequence rather than as
 * an observation.
 *
 * A `live` source would skip the prefix entirely, which is the only behavioural
 * difference the feed opening would make here. `evidenceFor` in types.ts is the
 * one place that decision is made.
 *
 * When the source is UNKNOWN the prefix is still spoken. An unattributed time is
 * treated as the weaker claim, never the stronger one — the failure mode of
 * guessing wrong in that direction is a rider believing a bus was seen.
 */
function evidencePrefix(journey: Journey, hasClip: (key: string) => boolean): string[] {
  if (journey.busDueAt === null) return [];
  if (journey.busDueSource === "live") return [];
  const clip = TIMETABLE.estimatePrefix.clip!;
  return hasClip(clip) ? [clip] : [];
}

/**
 * The answer to any of the four questions, for the state the journey is in.
 *
 * `critical` throughout: this is the rider asking, and an answer that queues
 * behind a routine count and then expires is the app ignoring a direct question
 * — which is precisely the "did it stop working?" fear the whole guide exists to
 * prevent. It is the one thing allowed to interrupt, because it was requested.
 */
export function answer(
  journey: Journey,
  question: GuideQuestion,
  hasClip: (key: string) => boolean,
  now: number,
): Announcement {
  const n = names(journey, hasClip);
  const base = {
    priority: "critical" as const,
    expiresAt: now + TTL.STATE,
    /**
     * No cooldown, deliberately. `AudioQueue.resetCooldowns` exists because a
     * question answered five seconds ago and asked again must be answered again
     * — a rider who did not catch it the first time gets silence otherwise,
     * which reads as being ignored.
     */
    label: `guide:${question}@${journey.state}`,
  };

  switch (journey.state) {
    case "idle":
    case "selecting_destination":
      return { ...base, keys: [JOURNEY.askDestination.clip!] };

    case "analyzing_route":
      return { ...base, keys: [JOURNEY.planning.clip!] };

    case "route_selected":
    case "walking_to_stop":
      // Which bus, and where to be. The distance is on screen and not spoken:
      // metres need a number clip per value and only 1–40 are rendered, so a
      // spoken distance would be silent above 40 m — which is most of them.
      return {
        ...base,
        keys: keep([
          GUIDE.walkingToStop.clip,
          n.route,
          n.origin,
          journey.distanceToStopM !== null && journey.distanceToStopM <= 60
            ? GUIDE.stopNear.clip
            : null,
        ]),
      };

    case "waiting_for_bus":
    case "bus_due": {
      /**
       * "You are at X. Route Y. According to the timetable, in approximately N
       * minutes. I cannot confirm its exact position."
       *
       * The order is deliberate: where the rider is, which bus, then the claim
       * qualified BEFORE the number it qualifies. A hedge that arrives after the
       * number is a correction, and a rider who has already started walking
       * toward a kerb has acted on the number.
       *
       * The "no live position" line is appended only when the rider asked about
       * the bus itself. On a routine status read it would be a sentence of
       * caveat every time, which is how a caveat stops being heard.
       */
      const askedAboutTheBus = question === "time_left" || question === "help";
      return {
        ...base,
        keys: keep([
          WAIT.youAreAtPrefix.clip,
          n.origin,
          n.origin ? WAIT.youAreAtSuffix.clip : null,
          n.route,
          ...evidencePrefix(journey, hasClip),
          ...hedgedMinutes(journey.busDueAt, now, hasClip),
          askedAboutTheBus && journey.busDueSource !== "live"
            ? TIMETABLE.noLivePosition.clip
            : null,
        ]),
      };
    }

    case "confirming_boarding":
      /**
       * The question IS the answer. A rider asking "what is happening" while a
       * question is open is telling us they did not hear it.
       *
       * An EXPIRED estimate leads with what actually happened — a printed time
       * passed — rather than with a claim about a bus. The app does not know
       * whether one came. Saying "the bus has arrived" here would be inventing
       * the single fact the whole gate exists because we do not have.
       */
      return {
        ...base,
        keys: keep([
          journey.boardingAskReason === "expired" ? CONFIRM.expectedNow.clip : null,
          n.route,
          ...questionClips(journey.state),
        ]),
      };

    case "confirming_exit":
      return { ...base, keys: keep([n.route, ...questionClips(journey.state)]) };

    case "on_bus":
    case "approaching_destination": {
      if (question === "next_stop") {
        // A different question from "how many stops", and it has its own answer:
        // the name, not the count. Falls through to the full status when the
        // stop has no rendered clip, so the rider gets something either way.
        const next = n.destination && journey.remainingStops === 1 ? n.destination : null;
        if (next) return { ...base, keys: keep([RIDE.nextStop.clip, next]) };
      }
      // Delegated: `announceStatus` already handles the overshoot case, which
      // is the one a rider most needs and the easiest to get wrong.
      const status = announceStatus(
        {
          at: journey.origin,
          destination: journey.destination,
          remaining: journey.remainingStops,
          statusPrefixKey: WAIT.youAreAtPrefix.clip!,
          stopsRemainingKey: RIDE.stopsRemaining.clip!,
        },
        hasClip,
        now,
      );
      return { ...status, label: base.label };
    }

    case "arrived":
      return { ...base, keys: keep([GUIDE.journeyComplete.clip, n.destination]) };

    case "journey_error":
      return {
        ...base,
        keys: keep([journey.fault ? FAULT_CLIP[journey.fault] : DEGRADED.service.clip]),
        earcon: "error",
      };
  }
}

/**
 * The one-line answer to "how many stops", when that is all the rider asked.
 *
 * Separate from `answer` because "four stops remaining" and the full status
 * sentence are different requests, and giving the long one to the short question
 * is how a guide becomes something you stop asking.
 */
export function answerStopsLeft(
  journey: Journey,
  hasClip: (key: string) => boolean,
  now: number,
): Announcement | null {
  const remaining = journey.remainingStops;
  if (remaining === null || remaining <= 0) return null;
  if (remaining > MAX_SPOKEN_NUMBER) return null;
  const keys = [numberKey(remaining), RIDE.stopsRemaining.clip!];
  if (!keys.every(hasClip)) return null;
  return {
    keys,
    priority: "critical",
    expiresAt: now + TTL.IMMEDIATE,
    label: `guide:stops_left ${remaining}`,
  };
}

/**
 * What the rider is offered right now, in the order they hear it.
 *
 * ── ONE PRIMARY ACTION, AND IT IS FIRST ────────────────────────────────────
 *
 * The list is scrolled by ear, so "primary" is not a colour or a size — it is
 * position one, the thing a rider hears without swiping at all. Everything after
 * it is a thing they have to go looking for, which is the correct cost for a
 * secondary action.
 *
 * Most states offer ONE entry. The questions live behind `Асуух` (the quick
 * assistant, lib/journey/assistant.ts) rather than being flattened into this
 * list, because a five-item menu read aloud at a kerb is a menu nobody reaches
 * the end of. The exception is the two confirmation states, which offer their
 * answers directly and offer nothing else at all — the journey is blocked on
 * one of them and anything beside them is in the way.
 */
export function options(journey: Journey): { keys: string[]; id: string }[] {
  const ask = { id: "ask", keys: [ASSIST.ask.clip!] };
  const findOther = { id: "find_other", keys: [CONFIRM.findAnotherRoute.clip!] };

  switch (journey.state) {
    case "confirming_boarding":
      /**
       * THREE ANSWERS, NOT TWO.
       *
       * Forcing a yes/no on a rider who genuinely cannot tell — a crowded kerb,
       * two buses, no way to read a number — produces a guess, and a guessed yes
       * starts a stop countdown for a bus nobody is on. The third option is what
       * lets the machine resolve toward safety instead of toward whichever
       * answer was easier to reach.
       */
      return [
        { id: "boarded", keys: [CONFIRM.boardedYes.clip!] },
        { id: "not_boarded", keys: [CONFIRM.boardedNo.clip!] },
        { id: "unsure", keys: [CONFIRM.notSure.clip!] },
      ];

    case "confirming_exit":
      return [
        { id: "exited", keys: [CONFIRM.exitedYes.clip!] },
        { id: "not_yet", keys: [CONFIRM.notYet.clip!] },
      ];

    case "walking_to_stop":
      /**
       * "I am at the stop" is first, and it is not a convenience.
       *
       * It is the manual override for a GPS fix that is wrong — which in the
       * canyon around Sükhbaatar Square is routine (CLAUDE.md). A rider standing
       * at the kerb being told to keep walking has no way to correct the app
       * without it, and unlike a sighted user they cannot look up and see that
       * they have arrived.
       */
      return [{ id: "at_stop", keys: [ASSIST.atTheStop.clip!] }, ask];

    case "waiting_for_bus":
      // The alternatives appear only once a bus has actually been missed. Before
      // that there is nothing to decide, and a choice offered with no decision
      // behind it is noise between the rider and the countdown.
      return journey.missedBuses > 0 ? [ask, findOther] : [ask];

    case "bus_due":
      // Nothing extra: the boarding question is about to be raised on its own,
      // and a menu competing with it is a menu in the way.
      return [ask];

    case "on_bus":
    case "approaching_destination":
      return [ask];

    case "journey_error":
      return [ask, findOther];

    case "arrived":
      return [{ id: "finish", keys: [RIDE.finish.clip!] }];

    default:
      return [];
  }
}
