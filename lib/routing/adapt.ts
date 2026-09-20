/**
 * The seam between what this repo's data pipeline emits and what
 * `resolveJourney` expects.
 *
 * The two disagree in three places, and all three are load-bearing:
 *
 *  1. STOP ORDER LIVES IN A DIFFERENT FILE. `resolveJourney.Route` wants
 *     `directions: [{ rawUpDown, stopIds }]`. The pipeline splits that across
 *     `routes.json` (id, names, headsigns) and `route-stops.json`
 *     (`{routeId: {"0": [...], "1": [...]}}`), because stop order is the
 *     expensive part and is regenerated on a different cadence.
 *
 *  2. `lon`, NOT `lng`. Every file in this repo uses `lon`.
 *
 *  3. THERE IS NO `up_down` FIELD. The brief describes a feed where the value
 *     is 0/1 or 1/2 and must be inferred. The gateway ACCEPTS `up_down` as a
 *     query parameter and ignores it — see the header of
 *     scripts/build-transit-data.mjs. Source of truth is OTP GraphQL, whose
 *     `directionId` is already 0/1, and that is what the direction keys of
 *     `route-stops.json` are. So `rawUpDown` here is that key, and the
 *     convention is zero-based by construction.
 *
 * `inferDirectionMapper` is therefore correct-but-idle against today's data.
 * It is kept, and called, because it costs one pass at load and is the only
 * thing standing between a feed change and a rider sent the wrong way.
 */

import type { Route as PipelineRoute, RouteStops, Stop as PipelineStop } from "@/lib/transit/types";

import {
  collectRawDirections,
  inferDirectionMapper,
  type Direction,
  type Route,
  type Stop,
} from "./resolveJourney";

/**
 * These take data rather than importing it.
 *
 * The transit JSON is read once on the server in the `app/bus` page components
 * and handed to the client as props — see the note at the top of those. A
 * static import here would inline ~170 KB of stops and route order into the
 * client bundle instead, on a target described in CLAUDE.md as "cheap Android
 * over expensive mobile data".
 */

/** `stops.json` once `scripts/build-stop-keys.ts` has run over it. */
export type KeyedPipelineStop = PipelineStop & {
  key?: string;
  aliasKeys?: string[];
  placeKey?: string;
};

/**
 * Stops as shipped, keys included.
 *
 * `key`, `aliasKeys` and `placeKey` are written by
 * `scripts/build-stop-keys.ts`. If they are missing the data is stale — matching
 * would silently degrade to scoring against `undefined`, so this asserts rather
 * than limping.
 */
export function toSpeechStops(stops: KeyedPipelineStop[]): Stop[] {
  const unkeyed = stops.filter((s) => !s.key);
  if (unkeyed.length > 0) {
    throw new Error(
      `${unkeyed.length} of ${stops.length} stops have no speech key — ` +
        `run: npx tsx scripts/build-stop-keys.ts`,
    );
  }
  return stops.map((s) => ({
    id: s.id,
    name: s.name,
    key: s.key!,
    ...(s.aliasKeys?.length ? { aliasKeys: s.aliasKeys } : {}),
    placeKey: s.placeKey ?? s.key!,
    lat: s.lat,
    lon: s.lon,
  }));
}

/** Join `routes.json` to the ordered stop lists in `route-stops.json`. */
export function toSpeechRoutes(routes: PipelineRoute[], routeStops: RouteStops): Route[] {
  return routes.map((route) => {
    const byDirection = routeStops[route.id] ?? {};
    return {
      id: route.id,
      // `displayName` matches the signage a sighted person reads. `spokenName`
      // is the form a person says, and the two are never interchangeable —
      // "Ч:35" is spoken "чэ гучин тав".
      name: route.displayName,
      spokenName: route.spokenName ?? undefined,
      directions: Object.entries(byDirection)
        .map(([rawUpDown, stopIds]) => ({ rawUpDown: Number(rawUpDown), stopIds }))
        // Sorted so direction 0 is always first, which makes `legs[0]` stable
        // across rebuilds — object key order in JSON is not guaranteed.
        .sort((a, b) => a.rawUpDown - b.rawUpDown),
    };
  });
}

/**
 * The direction mapper for THIS data, derived once.
 *
 * Item 5 of the integration brief, and not optional: the default mapper's guard
 * is positional. It throws on an out-of-range value only when a leg is actually
 * found in that direction, so a feed that switched to 1/2 would crash on some
 * journeys and quietly mislabel the rest. Deriving the mapper from the whole
 * value set catches the change on the first load instead.
 */
export function toDirectionMapper(routes: Route[]): (raw: number) => Direction {
  return inferDirectionMapper(collectRawDirections(routes));
}

export type SpeechTransitData = {
  stops: Stop[];
  routes: Route[];
  mapDirection: (raw: number) => Direction;
};

/**
 * Everything the journey resolver needs, adapted and checked together.
 *
 * Call once per screen and memoize on the props — the key check walks 923
 * stops and the mapper walks every direction of every route.
 */
export function toSpeechTransitData(
  stops: KeyedPipelineStop[],
  routes: PipelineRoute[],
  routeStops: RouteStops,
): SpeechTransitData {
  const speechRoutes = toSpeechRoutes(routes, routeStops);
  return {
    stops: toSpeechStops(stops),
    routes: speechRoutes,
    mapDirection: toDirectionMapper(speechRoutes),
  };
}
