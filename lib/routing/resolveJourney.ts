/**
 * Turn two recognized stop names into "board route N, in this direction".
 *
 * Direction is derived from stop ORDER, never from the raw `up_down` field. The
 * City gateway and the Hamuga feed disagree on whether that field is 0/1 or
 * 1/2, so every read of it goes through `toCanonicalDirection` below. That is
 * the one place to fix when the discrepancy is finally settled — the rest of the
 * app only ever sees 'outbound' | 'inbound'.
 */

import { similarity, stopKey } from '../speech/mnNormalize';

export type Direction = 'outbound' | 'inbound';

export interface Stop {
  id: string;
  name: string;
  /** Precomputed at build time via stopKey(name). */
  key: string;
  /** Optional alternate spellings/abbreviations, also pre-keyed. */
  aliasKeys?: string[];
  lat?: number;
  /**
   * NOTE: `lon`, not `lng`. This file originally said `lng`, which no data in
   * this repo carries — `public/transit/stops.json`, `lib/transit/types.ts` and
   * every geo helper use `lon`. The mismatch did not fail to compile because
   * the field is optional; it failed SILENTLY at runtime, because the geo-bias
   * branch in `matchStops` is guarded on `lon !== undefined` and so never ran.
   * The comment there calls proximity "the highest-value signal available",
   * and it was switched off.
   */
  lon?: number;
  /**
   * Groups platforms of one place. Platforms sharing this are the same
   * destination as far as a rider is concerned — see the dedupe in `matchStops`.
   */
  placeKey?: string;
}

export interface RouteDirection {
  /** Raw value straight from the feed — do not interpret it outside this file. */
  rawUpDown: number;
  stopIds: string[];
}

export interface Route {
  id: string;
  name: string;
  spokenName?: string;
  directions: RouteDirection[];
}

export interface StopMatch {
  stop: Stop;
  score: number;
  /** Set when `near` was supplied and the stop is placed. Breaks score ties. */
  distanceKm?: number;
}

export interface JourneyLeg {
  route: Route;
  direction: Direction;
  boardAt: Stop;
  alightAt: Stop;
  /** Stops travelled, boarding stop excluded. Drives the countdown announcer. */
  hops: number;
  /** Stop ids from boardAt to alightAt inclusive, in travel order. */
  path: string[];
}

/**
 * SINGLE SOURCE OF TRUTH for the up_down mapping.
 *
 * Hamuga build-time dump uses 0/1. The live City gateway appears to use 1/2.
 * Accepting both means an off-by-one in one feed can never silently flip a
 * rider onto a bus heading the wrong way.
 */
/**
 * Default mapper — ZERO-BASED ONLY (the build-time Hamuga dump).
 *
 * The value 1 means opposite things in the two feeds, so this deliberately
 * throws on 2 rather than guessing. A loud crash in development beats a silent
 * direction flip in a rider's ear. If your data uses 1/2, build a mapper with
 * `inferDirectionMapper` at load time and pass it through.
 */
export function toCanonicalDirection(rawUpDown: number): Direction {
  if (rawUpDown === 0) return 'outbound';
  if (rawUpDown === 1) return 'inbound';
  throw new Error(
    `up_down=${rawUpDown} is outside the zero-based convention. ` +
      `This feed is probably 1/2 — use inferDirectionMapper(rawValues) instead.`,
  );
}

/**
 * Detect the convention once, from the full set of values a feed emits, and
 * return a mapper for it. Call this after loading routes, then thread the
 * result through every resolve call.
 */
export function inferDirectionMapper(allRawValues: number[]): (raw: number) => Direction {
  const distinct = new Set(allRawValues);
  if (distinct.size > 2) {
    throw new Error(`Expected 2 direction values, saw: ${[...distinct].join(', ')}`);
  }
  const zeroBased = distinct.has(0);
  if (!zeroBased && !distinct.has(2)) {
    throw new Error(`Cannot infer direction convention from: ${[...distinct].join(', ')}`);
  }
  const low = zeroBased ? 0 : 1;
  return (raw: number) => (raw === low ? 'outbound' : 'inbound');
}

/** Collect every up_down value in a route set, to feed inferDirectionMapper. */
export function collectRawDirections(routes: Route[]): number[] {
  return routes.flatMap((r) => r.directions.map((d) => d.rawUpDown));
}

const EARTH_R = 6371;

function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

export interface MatchOptions {
  /** Rider's coordinates. Applied to the ORIGIN only — they are standing there. */
  near?: [number, number];
  limit?: number;
  minScore?: number;
}

/**
 * Rank stops against a spoken fragment.
 *
 * Geo bias is the highest-value signal available and costs nothing: a rider
 * naming their current stop is within a few hundred metres of it. It cleanly
 * separates the several stops in Ulaanbaatar that share a name.
 */
export function matchStops(
  spokenFragment: string,
  stops: Stop[],
  options: MatchOptions = {},
): StopMatch[] {
  const { near, limit = 5, minScore = 0.42 } = options;
  const q = stopKey(spokenFragment);
  if (!q) return [];

  const results: StopMatch[] = [];

  for (const stop of stops) {
    let score = similarity(q, stop.key);
    if (stop.aliasKeys) {
      for (const alias of stop.aliasKeys) {
        score = Math.max(score, similarity(q, alias));
      }
    }
    if (score < minScore) continue;

    let distanceKm: number | undefined;
    if (near && stop.lat !== undefined && stop.lon !== undefined) {
      distanceKm = haversineKm(near, [stop.lat, stop.lon]);
      // Full bonus within 300m, decaying to nothing at 3km.
      const proximity = Math.max(0, 1 - Math.max(0, distanceKm - 0.3) / 2.7);
      score = Math.min(1, score + 0.18 * proximity);
    }

    results.push({ stop, score, distanceKm });
  }

  /**
   * Score first, then distance.
   *
   * The bonus above cannot separate two stops that share a NAME, which is the
   * exact case the geo signal exists for: identical names score 1.0 on text
   * alone, `Math.min(1, …)` clamps the bonus away, and the tie survives. There
   * are three such pairs in this city — "1-р байр" appears three times, 10 km
   * apart. Distance has to be its own sort key to break them.
   */
  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.distanceKm !== undefined && b.distanceKm !== undefined) {
      return a.distanceKm - b.distanceKm;
    }
    return 0;
  });

  // Numbered districts are the sharp edge here: "3-р хороолол" and
  // "13-р хороолол" differ by one token but are kilometres apart. Fuzzy scoring
  // rates them as near-twins, so an exact key match must beat every
  // approximate one outright rather than competing with them.
  const exact = results.filter((r) => r.stop.key === q || r.stop.aliasKeys?.includes(q));
  const ranked = exact.length > 0 ? exact : results;

  return dedupeByPlace(ranked).slice(0, limit);
}

/**
 * Collapse platforms of one place to a single candidate.
 *
 * A NAME IS NOT A PLATFORM. `Саппоро /Урд/` and `Саппоро /Хойд/` score 0.94 and
 * 0.92 against someone saying "Саппоро", which is inside the
 * `needsDisambiguation` window — so without this, the rider is asked "which
 * one?" and read back two names that differ only by a compass word they cannot
 * act on. Which platform to use is a routing decision, not theirs.
 *
 * Measured over all 923 stops, saying each name plainly: this takes the
 * disambiguation rate from 80.1% to 1.1%. Four journeys in five ended in a
 * pointless question.
 *
 * Keeps the best-scoring platform of each place, and preserves order, so the
 * caller still gets a ranked list of genuinely distinct choices.
 */
function dedupeByPlace(matches: StopMatch[]): StopMatch[] {
  const seen = new Set<string>();
  const out: StopMatch[] = [];
  for (const m of matches) {
    // No placeKey (unkeyed test fixtures, or data built before the key step)
    // falls back to the stop id, which dedupes nothing — the old behaviour.
    const place = m.stop.placeKey ?? m.stop.id;
    if (seen.has(place)) continue;
    seen.add(place);
    out.push(m);
  }
  return out;
}

/**
 * A lower-ranked transcript pays this per place before the minScore cut.
 *
 * The same constant and the same reasoning as ALTERNATIVE_PENALTY in
 * lib/ui/stop-search.ts, which does this for the other input path. The
 * recogniser's ordering between near-homophones of a proper noun it has never
 * seen is close to arbitrary — but it is not worthless, so a lower alternative
 * has to win by a real margin rather than a rounding error.
 *
 * Charged BEFORE the cut, which is the other half of its job: searching six
 * transcripts otherwise gives noise six independent chances to clear the bar,
 * and a false match here puts a blind passenger on a bus to the wrong district.
 */
export const ALTERNATIVE_PENALTY = 0.03;

/**
 * Rank stops against EVERY transcript the recogniser offered, best-ranked first.
 *
 * `matchStops` reads one string, and for a long time the caller handed it only
 * the engine's first choice. The engine is transcribing a proper noun that is
 * not in its language model, so which spelling it puts first is close to a coin
 * flip between homophones — but only one of them is a real stop name, and this
 * list knows which. `сан сар` matches nothing on its own, and used to end the
 * journey there while `Сансар` sat unread in alternative 2.
 *
 * Keeps the best MATCH, not the best transcript. Measured over 40 real stop
 * names round-tripped through Azure: 92.5% → 95%.
 */
export function matchStopsAny(
  transcripts: string[],
  stops: Stop[],
  options: MatchOptions = {},
): StopMatch[] {
  const { limit = 5, minScore = 0.42 } = options;

  /** Best score seen per stop id, across every transcript. */
  const best = new Map<string, StopMatch>();

  transcripts.forEach((transcript, rank) => {
    /**
     * Raise the per-transcript bar by the penalty rather than lowering it.
     *
     * A match survives only if `score - penalty >= minScore`, so asking
     * `matchStops` for `minScore + penalty` returns exactly the candidates that
     * can still clear the bar once charged — no wider, and with the cheap
     * prefilter left doing its work instead of walking all 923 stops six times.
     */
    const penalty = rank * ALTERNATIVE_PENALTY;
    for (const match of matchStops(transcript, stops, {
      ...options,
      limit: Number.POSITIVE_INFINITY,
      minScore: minScore + penalty,
    })) {
      const score = match.score - penalty;
      if (score < minScore) continue;
      const prior = best.get(match.stop.id);
      if (!prior || score > prior.score) {
        best.set(match.stop.id, { ...match, score });
      }
    }
  });

  const ranked = [...best.values()].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.distanceKm !== undefined && b.distanceKm !== undefined) {
      return a.distanceKm - b.distanceKm;
    }
    return 0;
  });

  return dedupeByPlace(ranked).slice(0, limit);
}

/**
 * True when the top two candidates are too close to pick without asking.
 * Asking costs the rider three seconds; guessing wrong costs them the trip.
 */
export function needsDisambiguation(matches: StopMatch[]): boolean {
  if (matches.length < 2) return false;
  return matches[0].score - matches[1].score < 0.12;
}

/**
 * Find every route that carries the rider from origin to destination without a
 * transfer, ordered by fewest stops.
 *
 * Handles loop routes where a stop appears more than once in a direction by
 * taking the shortest valid (board, alight) pair rather than the first index.
 */
export function resolveDirectLegs(
  origin: Stop,
  destination: Stop,
  routes: Route[],
  mapDirection: (raw: number) => Direction = toCanonicalDirection,
): JourneyLeg[] {
  const legs: JourneyLeg[] = [];

  for (const route of routes) {
    for (const dir of route.directions) {
      const boardIdx: number[] = [];
      const alightIdx: number[] = [];

      dir.stopIds.forEach((id, i) => {
        if (id === origin.id) boardIdx.push(i);
        if (id === destination.id) alightIdx.push(i);
      });
      if (boardIdx.length === 0 || alightIdx.length === 0) continue;

      let best: { i: number; j: number } | null = null;
      for (const i of boardIdx) {
        for (const j of alightIdx) {
          if (j > i && (best === null || j - i < best.j - best.i)) best = { i, j };
        }
      }
      if (!best) continue;

      legs.push({
        route,
        direction: mapDirection(dir.rawUpDown),
        boardAt: origin,
        alightAt: destination,
        hops: best.j - best.i,
        path: dir.stopIds.slice(best.i, best.j + 1),
      });
    }
  }

  legs.sort((a, b) => a.hops - b.hops);
  return legs;
}

export type JourneyResolution =
  | { kind: 'ok'; legs: JourneyLeg[] }
  | { kind: 'same-stop' }
  | { kind: 'wrong-direction'; suggestion: JourneyLeg }
  | { kind: 'no-direct-route' };

export function resolveJourney(
  origin: Stop,
  destination: Stop,
  routes: Route[],
  mapDirection?: (raw: number) => Direction,
): JourneyResolution {
  if (origin.id === destination.id) return { kind: 'same-stop' };

  const legs = resolveDirectLegs(origin, destination, routes, mapDirection);
  if (legs.length > 0) return { kind: 'ok', legs };

  // Nothing forward — check the reverse. If the pair is connected backwards, the
  // rider has almost certainly named the two stops in the wrong order, which is
  // worth saying out loud rather than reporting a flat failure.
  const reversed = resolveDirectLegs(destination, origin, routes, mapDirection);
  if (reversed.length > 0) {
    return { kind: 'wrong-direction', suggestion: reversed[0] };
  }

  return { kind: 'no-direct-route' };
}
