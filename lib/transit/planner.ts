/**
 * Working out which bus to take. Offline, from the baked route graph.
 *
 * ROUTE SELECTION IS OUR PROBLEM, NOT THE USER'S. The first question this app
 * asks is "хаашаа явах вэ?" — where are you going — and everything here exists
 * so that nobody has to answer "which route" instead.
 *
 * Deliberately NOT an OTP call. OTP plans point-to-point and needs a network,
 * and the gateway answers a rate limit with an account-wide 401 lockout lasting
 * ~14 minutes (see lib/transit/breaker.ts). Planning is the one thing a user
 * cannot proceed without, so it runs against route-stops.json in memory and is
 * instant, offline, and impossible to rate-limit. The OTP proxy remains what it
 * always was — a source of arrival TIMES, which are an enrichment.
 *
 * Pure. No fetch, no storage, no clock.
 */
import type { Route, RouteStops, StopRoutes } from "./types";

export type PlanLeg = {
  routeId: string;
  routeDisplayName: string;
  directionId: number;
  boardStopId: string;
  boardIndex: number;
  alightStopId: string;
  alightIndex: number;
  /** Stops travelled on this leg — what the user actually experiences. */
  stops: number;
};

export type JourneyOption = {
  legs: PlanLeg[];
  totalStops: number;
  transfers: number;
};

/**
 * How far along a route we will look for a transfer point.
 *
 * Not a performance bound — a bound on plausibility. A transfer 30 stops into a
 * journey is not a transfer, it is two journeys, and offering it as an option
 * would bury the direct route the user actually wants.
 */
export const MAX_TRANSFER_SEARCH_STOPS = 25;

/** More than this and the list stops being something anyone can cycle by ear. */
export const MAX_OPTIONS = 4;

type Position = { routeId: string; directionId: number; index: number };

/** Every (route, direction, index) at which a stop appears. */
function positionsOf(stopId: string, routeIds: string[], routeStops: RouteStops): Position[] {
  const out: Position[] = [];
  for (const routeId of routeIds) {
    const directions = routeStops[routeId];
    if (!directions) continue;
    for (const [dir, sequence] of Object.entries(directions)) {
      // indexOf, not a scan for all occurrences: a route that visits a stop
      // twice (a loop) is boarded at its first visit, which is where the
      // passenger is standing.
      const index = sequence.indexOf(stopId);
      if (index >= 0) out.push({ routeId, directionId: Number(dir), index });
    }
  }
  return out;
}

/**
 * Direct journeys between two SETS of platforms.
 *
 * Both ends are sets because a place has several platforms — Буянт-Ухаа has
 * four — and which one to use is a routing decision, not something to make the
 * traveller choose. Any origin platform reaching any destination platform on
 * one bus is a direct journey.
 */
export function findDirect(
  originStopIds: string[],
  destinationStopIds: string[],
  routeStops: RouteStops,
  stopRoutes: StopRoutes,
  routesById: Map<string, Route>,
): JourneyOption[] {
  const destinations = new Set(destinationStopIds);
  const options: JourneyOption[] = [];
  const seen = new Set<string>();

  for (const originId of originStopIds) {
    const routeIds = stopRoutes[originId] ?? [];
    for (const from of positionsOf(originId, routeIds, routeStops)) {
      const sequence = routeStops[from.routeId]?.[String(from.directionId)];
      if (!sequence) continue;

      // Forward only. A destination behind us on this direction is not reachable
      // by boarding here, however close it looks on a map.
      for (let i = from.index + 1; i < sequence.length; i++) {
        if (!destinations.has(sequence[i])) continue;

        const key = `${from.routeId}:${from.directionId}:${originId}:${sequence[i]}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const route = routesById.get(from.routeId);
        options.push({
          legs: [{
            routeId: from.routeId,
            routeDisplayName: route?.displayName ?? from.routeId,
            directionId: from.directionId,
            boardStopId: originId,
            boardIndex: from.index,
            alightStopId: sequence[i],
            alightIndex: i,
            stops: i - from.index,
          }],
          totalStops: i - from.index,
          transfers: 0,
        });
        // The first hit is the earliest alighting platform of the destination
        // place; later ones are the same place further along.
        break;
      }
    }
  }

  return options;
}

/**
 * Journeys needing exactly one change.
 *
 * Two changes are not offered. Each transfer is a place where a blind passenger
 * must find an unfamiliar stop, in traffic, without being able to read a sign —
 * so a two-change itinerary is a worse outcome than being told plainly that we
 * could not find a route.
 */
export function findOneTransfer(
  originStopIds: string[],
  destinationStopIds: string[],
  routeStops: RouteStops,
  stopRoutes: StopRoutes,
  routesById: Map<string, Route>,
): JourneyOption[] {
  const destinations = new Set(destinationStopIds);

  // Routes that can deliver us to the destination at all — computed once, so
  // the inner loop is a set lookup rather than a search.
  const finishing = new Map<string, Position[]>();
  for (const destinationId of destinations) {
    for (const p of positionsOf(destinationId, stopRoutes[destinationId] ?? [], routeStops)) {
      const list = finishing.get(p.routeId) ?? [];
      list.push({ ...p, index: p.index });
      finishing.set(p.routeId, list);
    }
  }

  const options: JourneyOption[] = [];
  const seen = new Set<string>();

  for (const originId of originStopIds) {
    for (const first of positionsOf(originId, stopRoutes[originId] ?? [], routeStops)) {
      const firstSequence = routeStops[first.routeId]?.[String(first.directionId)];
      if (!firstSequence) continue;

      const limit = Math.min(firstSequence.length, first.index + 1 + MAX_TRANSFER_SEARCH_STOPS);
      for (let i = first.index + 1; i < limit; i++) {
        const transferStopId = firstSequence[i];
        // Already there — that is a direct journey, handled elsewhere.
        if (destinations.has(transferStopId)) break;

        for (const secondRouteId of stopRoutes[transferStopId] ?? []) {
          if (secondRouteId === first.routeId) continue;
          const ends = finishing.get(secondRouteId);
          if (!ends) continue;

          for (const end of ends) {
            const secondSequence = routeStops[secondRouteId]?.[String(end.directionId)];
            if (!secondSequence) continue;
            const boardIndex = secondSequence.indexOf(transferStopId);
            if (boardIndex < 0 || boardIndex >= end.index) continue;

            const key = `${first.routeId}:${transferStopId}:${secondRouteId}:${end.index}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const legOne = i - first.index;
            const legTwo = end.index - boardIndex;
            const routeA = routesById.get(first.routeId);
            const routeB = routesById.get(secondRouteId);

            options.push({
              legs: [
                {
                  routeId: first.routeId,
                  routeDisplayName: routeA?.displayName ?? first.routeId,
                  directionId: first.directionId,
                  boardStopId: originId, boardIndex: first.index,
                  alightStopId: transferStopId, alightIndex: i,
                  stops: legOne,
                },
                {
                  routeId: secondRouteId,
                  routeDisplayName: routeB?.displayName ?? secondRouteId,
                  directionId: end.directionId,
                  boardStopId: transferStopId, boardIndex,
                  alightStopId: secondSequence[end.index], alightIndex: end.index,
                  stops: legTwo,
                },
              ],
              totalStops: legOne + legTwo,
              transfers: 1,
            });
          }
        }
      }
    }
  }

  return options;
}

/**
 * The plan, best first.
 *
 * A direct journey always beats a transfer, even a much longer one. Sitting on
 * a bus for six extra stops costs time; changing costs the traveller a stop
 * they have to find without sight, in traffic, with luggage or in winter. Those
 * are not comparable on a stop count, so they are not compared — direct wins.
 */
export function planJourney(
  originStopIds: string[],
  destinationStopIds: string[],
  routeStops: RouteStops,
  stopRoutes: StopRoutes,
  routesById: Map<string, Route>,
  { maxOptions = MAX_OPTIONS }: { maxOptions?: number } = {},
): JourneyOption[] {
  const origins = originStopIds.filter((id) => !destinationStopIds.includes(id));
  if (origins.length === 0) return [];

  const direct = findDirect(origins, destinationStopIds, routeStops, stopRoutes, routesById)
    .sort((a, b) => a.totalStops - b.totalStops);

  // One good direct route is enough to not bother anyone with a transfer.
  if (direct.length > 0) return dedupeByRoute(direct).slice(0, maxOptions);

  const transfer = findOneTransfer(origins, destinationStopIds, routeStops, stopRoutes, routesById)
    .sort((a, b) => a.totalStops - b.totalStops);

  return dedupeByRoute(transfer).slice(0, maxOptions);
}

/**
 * Every stop reachable on one bus from where the user is standing.
 *
 * THIS IS WHAT MAKES GESTURES SUFFICIENT WITHOUT VOICE. Searching by name needs
 * a name to be typed or spoken; with speech unavailable — unverified for
 * Mongolian, and useless on a loud bus regardless — a user who has never
 * travelled before would otherwise have no way to name a destination at all.
 * Browsing what this stop can reach needs no input beyond swiping.
 *
 * Returned in route order per route, so the list reads the way the journey
 * runs: the next stop first, the terminus last. That is the order a passenger
 * thinks in, and it makes two-finger jump-by-five land somewhere predictable.
 */
export function reachableFrom(
  originStopIds: string[],
  routeStops: RouteStops,
  stopRoutes: StopRoutes,
): { stopId: string; routeId: string; directionId: number; stops: number }[] {
  const best = new Map<string, { stopId: string; routeId: string; directionId: number; stops: number }>();

  for (const originId of originStopIds) {
    for (const from of positionsOf(originId, stopRoutes[originId] ?? [], routeStops)) {
      const sequence = routeStops[from.routeId]?.[String(from.directionId)];
      if (!sequence) continue;
      for (let i = from.index + 1; i < sequence.length; i++) {
        const stopId = sequence[i];
        const stops = i - from.index;
        const existing = best.get(stopId);
        // Nearest way to reach it wins, so the spoken count is the shortest.
        if (!existing || stops < existing.stops) {
          best.set(stopId, { stopId, routeId: from.routeId, directionId: from.directionId, stops });
        }
      }
    }
  }

  return [...best.values()].sort((a, b) => a.stops - b.stops);
}

/**
 * One entry per route combination.
 *
 * The same bus reached from two adjacent platforms of the same place is one
 * choice to a traveller, not two. Hearing "Ч:35" twice in a four-item list
 * would make a user doubt they had moved through it at all.
 */
function dedupeByRoute(options: JourneyOption[]): JourneyOption[] {
  const seen = new Set<string>();
  const out: JourneyOption[] = [];
  for (const option of options) {
    const key = option.legs.map((l) => `${l.routeId}:${l.directionId}`).join(">");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(option);
  }
  return out;
}
