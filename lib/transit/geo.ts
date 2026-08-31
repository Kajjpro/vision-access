/**
 * Where am I, and which stop is that?
 *
 * Pure functions over the baked stops.json. No geolocation calls here — the
 * caller supplies a position, so every branch is testable without a browser.
 */
import type { Stop, StopRoutes } from "./types";

const EARTH_M = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(s));
}

/**
 * Beyond this we have no answer and must say so.
 *
 * 34 of the 576 dropped stops sit within 150 m of a kept neighbour, so a user
 * standing at one of those matches a real stop and is at worst one stop out.
 * Past 150 m there is no such guarantee: naming a stop that far away is a
 * confident wrong answer, and a wrong stop name is worse than no stop name to
 * someone who cannot check it against a sign.
 */
export const MAX_MATCH_M = 150;

/**
 * Two stops closer than this that share a name cannot be told apart by GPS.
 * Дүнжингарав is the live case — ~100 m apart, no direction suffix.
 */
export const SAME_NAME_RADIUS_M = 200;

/**
 * A fix worse than this cannot identify a stop at all.
 *
 * At ±500 m the correct stop is the top candidate only 30 % of the time even
 * with a widened search, and a desktop browser geolocating by IP reports
 * kilometres. Past this we say the SIGNAL is bad rather than that no stop is
 * nearby — those need opposite actions from the user (wait / move into the
 * open, versus walk somewhere else), and sending someone the wrong way is the
 * concrete harm.
 */
export const UNUSABLE_ACCURACY_M = 500;

/**
 * Accuracy below which the top candidate can be stated without a hedge.
 *
 * Measured against the real 923 stops with simulated GPS error: at ±50 m the
 * nearest candidate is the true stop 91 % of the time; by ±150 m that is 74 %,
 * which is not a claim to make confidently to someone who cannot check it.
 */
export const CONFIDENT_ACCURACY_M = 60;

export type StopCandidate = { stop: Stop; distanceM: number };

/**
 * How much to trust `candidates[0]`.
 *
 * `low` does not mean useless — the right stop is in the top three ~100 % of
 * the time up to ±300 m. It means the caller must OFFER the list rather than
 * assert the first entry, and must speak the hedge.
 */
export type MatchConfidence = "high" | "low";

export type NearestResult =
  | { kind: "none"; nearestDistanceM: number | null }
  /** The fix itself is too coarse to say anything about stops. */
  | { kind: "unusable-fix"; accuracyM: number }
  | { kind: "ambiguous"; sharedName: string; candidates: StopCandidate[]; confidence: MatchConfidence }
  | { kind: "single"; candidates: StopCandidate[]; confidence: MatchConfidence };

/** All stops within a radius, nearest first. */
export function stopsWithin(
  position: { lat: number; lon: number },
  stops: Stop[],
  radiusM: number,
): StopCandidate[] {
  const out: StopCandidate[] = [];
  for (const stop of stops) {
    const distanceM = haversine(position, stop);
    if (distanceM <= radiusM) out.push({ stop, distanceM });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * Names differing only in case or spacing are the same name for matching
 * purposes. The build normalizes the direction suffix, but this must not
 * depend on that having been perfect.
 */
export function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The stop the user is probably standing at.
 *
 * Three outcomes, and the caller must handle all three:
 *   - `none`      → say "Ойролцоо буудал олдсонгүй". Do not guess.
 *   - `ambiguous` → two or more stops share a name within SAME_NAME_RADIUS_M.
 *                   Resolve by ROUTE, not by position: GPS error is larger than
 *                   the gap between them, so the nearest one is not evidence.
 *   - `single`    → candidates[0] is the best match; the rest let the user cycle.
 */
export function findNearestStop(
  position: { lat: number; lon: number },
  stops: Stop[],
  {
    maxMatchM = MAX_MATCH_M,
    sameNameRadiusM = SAME_NAME_RADIUS_M,
    /**
     * Reported GPS accuracy in metres. Omit only where no fix is involved.
     *
     * THE SEARCH RADIUS MUST SCALE WITH THIS. A fixed 150 m is correct only for
     * a good fix: it assumes the reported position IS the position. At ±200 m
     * the true location can be 200 m from what the phone says, so a 150 m
     * search finds nothing 29 % of the time and the app reports "no stop
     * nearby" while the user stands at one. Widening by the accuracy takes that
     * to 0 %, and the true stop is in the top three ~100 % of the time up to
     * ±300 m — which is why the caller offers a list rather than one answer.
     */
    accuracyM,
  }: { maxMatchM?: number; sameNameRadiusM?: number; accuracyM?: number } = {},
): NearestResult {
  // A fix this coarse says nothing about which stop we are at, and pretending
  // otherwise produces a confident wrong name.
  if (accuracyM !== undefined && accuracyM > UNUSABLE_ACCURACY_M) {
    return { kind: "unusable-fix", accuracyM };
  }

  // Cap the widening so one absurd fix cannot pull in half the city.
  const slack = Math.min(accuracyM ?? 0, UNUSABLE_ACCURACY_M);
  const searchRadiusM = maxMatchM + slack;
  const confidence: MatchConfidence =
    accuracyM === undefined || accuracyM <= CONFIDENT_ACCURACY_M ? "high" : "low";

  const inRange = stopsWithin(position, stops, searchRadiusM);

  if (inRange.length === 0) {
    let nearest: number | null = null;
    for (const stop of stops) {
      const d = haversine(position, stop);
      if (nearest === null || d < nearest) nearest = d;
    }
    return { kind: "none", nearestDistanceM: nearest };
  }

  // Same-name ambiguity is keyed on the name, not on a pair of ids, so a feed
  // change that creates a new shared-name pair is handled without a code change.
  const best = inRange[0];
  const bestName = normalizeName(best.stop.name);
  const sameName = stopsWithin(position, stops, sameNameRadiusM + slack).filter(
    (c) => normalizeName(c.stop.name) === bestName,
  );

  if (sameName.length > 1) {
    return { kind: "ambiguous", sharedName: best.stop.name, candidates: sameName, confidence };
  }

  return { kind: "single", candidates: inRange, confidence };
}

/**
 * Picks between same-name candidates using the route the user asked for.
 *
 * If several serve it they are functionally interchangeable — the buses stop at
 * both and either answer gets the user on the right vehicle — so the nearest is
 * as good as any. Returns null when none serve it, which is a real answer the
 * caller must speak rather than paper over.
 */
export function resolveByRoute(
  candidates: StopCandidate[],
  routeId: string,
  stopRoutes: StopRoutes,
): StopCandidate | null {
  const serving = candidates.filter((c) => (stopRoutes[c.stop.id] ?? []).includes(routeId));
  if (serving.length === 0) return null;
  return serving[0];
}

/** Routes serving a stop, offline and instant. */
export function routesAtStop(stopId: string, stopRoutes: StopRoutes): string[] {
  return stopRoutes[stopId] ?? [];
}

/**
 * The union of routes across same-name candidates — what to offer the user when
 * asking which route they want. Sorted for a stable spoken order.
 */
export function routeChoicesFor(candidates: StopCandidate[], stopRoutes: StopRoutes): string[] {
  const set = new Set<string>();
  for (const c of candidates) for (const r of stopRoutes[c.stop.id] ?? []) set.add(r);
  return [...set].sort();
}
