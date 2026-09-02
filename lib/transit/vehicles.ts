/**
 * The live vehicle feed, and the freshness gate that decides whether anything
 * it says may be spoken without a hedge.
 *
 * THE FEED CARRIES NO TIMESTAMP. Nothing in a `/ubcard-api/vehicles` response
 * says when it was true. That single fact drives this whole module:
 *
 *   Absolute freshness is NOT recoverable. We can only ever measure change
 *   since OUR OWN previous poll. On a first poll, a feed frozen since last
 *   Tuesday is indistinguishable from a live feed of buses stopped at lights.
 *
 * So freshness here is a positive-only signal. `unknown` is the default and it
 * is NOT a synonym for fresh — it means we have not yet earned the right to
 * drop the hedge. A blind person stepping toward a road because we announced a
 * bus that is not coming is the worst thing this app can do, and it is worse
 * than saying nothing at all.
 *
 * Pure: no fetch, no clock of its own, no React. The caller supplies polls and
 * a `now`, which is what lets the stale / empty / erroring paths be driven
 * deterministically in tests rather than waited for.
 */
import { joinRouteName, type RouteIndex } from "./route-name";
import type { Route } from "./types";

/** Exactly the documented payload shape, renamed to our conventions. */
export type Vehicle = {
  id: number;
  plateNumber: string;
  /** Raw feed value, e.g. `Ч-1`. Never compared directly — always via the join. */
  routeName: string;
  /** km/h as reported. Unverified: may be absent, zero, or a constant. */
  speed: number;
  /** Degrees clockwise from north. Meaningless when stationary. */
  bearing: number;
  latitude: number;
  longitude: number;
};

/**
 * Ulaanbaatar's bounding box, generously drawn.
 *
 * A coordinate outside this is not a bus — it is a null island, a swapped
 * lat/lon, or a test record. Announcing a distance to one would be a confident
 * lie, so they are dropped at ingest and counted.
 */
export const UB_BOUNDS = { minLat: 47.7, maxLat: 48.15, minLon: 106.55, maxLon: 107.3 } as const;

export const isPlausibleUB = (v: { latitude: number; longitude: number }): boolean =>
  Number.isFinite(v.latitude) && Number.isFinite(v.longitude) &&
  v.latitude >= UB_BOUNDS.minLat && v.latitude <= UB_BOUNDS.maxLat &&
  v.longitude >= UB_BOUNDS.minLon && v.longitude <= UB_BOUNDS.maxLon;

/** Below this a bus may legitimately be stationary, so no contradiction exists. */
export const SPEED_MOVING_KMH = 5;

/**
 * How much of the distance implied by `speed` must actually appear.
 *
 * Deliberately lax at 0.25. The claim being tested is not "is this bus exactly
 * where kinematics says" — traffic, rounding and a coarse poll interval all
 * legitimately eat distance. It is the far weaker "did this record move AT ALL
 * in a way consistent with claiming to be in motion". A bus reporting 45 km/h
 * that has covered under 187 m in 60 s is not a slow bus, it is a stale row.
 */
export const DISPLACEMENT_TOLERANCE = 0.25;

/**
 * How long a positive freshness observation licenses an unhedged announcement.
 *
 * After this, the evidence has expired and we are back to `unknown`. Chosen
 * shorter than the time it takes a bus to cross a stop spacing, so a stale
 * "fresh" verdict cannot outlive its own relevance.
 */
export const FRESH_WINDOW_MS = 30_000;

/** Two polls closer together than this cannot resolve movement above GPS noise. */
export const MIN_DIFF_INTERVAL_MS = 8_000;

/** Under this, a position change is indistinguishable from jitter. */
export const JITTER_M = 15;

const EARTH_M = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(s));
}

// ------------------------------------------------------------- freshness

export type Freshness =
  /** Watched it move. The ONLY state that may drop the hedge. */
  | { state: "fresh"; reason: "moved"; displacementM: number; observedAt: number }
  /** No evidence either way. Hedge. Not a failure — just not yet proven. */
  | { state: "unknown"; reason: "first-observation" | "interval-too-short" | "stationary-and-slow" | "evidence-expired" }
  /** Positively contradicted. Treat as no live data at all. */
  | { state: "stale"; reason: "speed-without-movement" | "frozen-coordinates" };

export const canDropHedge = (f: Freshness): boolean => f.state === "fresh";

export type VehicleSnapshot = {
  vehicle: Vehicle;
  /** Our own receive time. The feed supplies nothing comparable. */
  observedAt: number;
  freshness: Freshness;
};

/**
 * Compares one vehicle against its own previous observation.
 *
 * Returns `unknown` rather than `fresh` in every case where the evidence is
 * merely absent. The asymmetry is the point: proving liveness needs positive
 * movement, while proving staleness needs a contradiction, and neither is the
 * default.
 */
export function assessFreshness(
  current: Vehicle,
  previous: VehicleSnapshot | undefined,
  now: number,
): Freshness {
  if (!previous) return { state: "unknown", reason: "first-observation" };

  const elapsedMs = now - previous.observedAt;
  if (elapsedMs < MIN_DIFF_INTERVAL_MS) {
    // Too soon to distinguish movement from noise. Carry the previous verdict
    // forward if it is still inside its window, rather than downgrading a good
    // observation just because we polled quickly.
    if (previous.freshness.state === "fresh" && now - previous.freshness.observedAt < FRESH_WINDOW_MS) {
      return previous.freshness;
    }
    return { state: "unknown", reason: "interval-too-short" };
  }

  const displacementM = haversine(previous.vehicle, current);
  const claimsMotion = Number.isFinite(current.speed) && current.speed > SPEED_MOVING_KMH;
  const expectedM = (current.speed / 3.6) * (elapsedMs / 1000);

  // --- the contradiction ------------------------------------------------
  // Claims to be moving, has not moved. This is the one detector that works
  // without a timestamp, and it is per-vehicle rather than feed-wide.
  if (claimsMotion && displacementM < expectedM * DISPLACEMENT_TOLERANCE) {
    // Bit-identical coordinates are a stronger statement than "barely moved":
    // real GPS always jitters, so an exact repeat is a row that was not
    // recomputed rather than a vehicle that did not move.
    const identical =
      previous.vehicle.latitude === current.latitude &&
      previous.vehicle.longitude === current.longitude;
    return { state: "stale", reason: identical ? "frozen-coordinates" : "speed-without-movement" };
  }

  // --- positive liveness -------------------------------------------------
  if (displacementM > JITTER_M) {
    return { state: "fresh", reason: "moved", displacementM, observedAt: now };
  }

  // Stationary and saying so. Entirely legitimate — a bus at a light, or 03:00.
  // It proves nothing, so it earns nothing.
  if (previous.freshness.state === "fresh" && now - previous.freshness.observedAt < FRESH_WINDOW_MS) {
    return previous.freshness;
  }
  return {
    state: "unknown",
    reason: previous.freshness.state === "fresh" ? "evidence-expired" : "stationary-and-slow",
  };
}

// ------------------------------------------------------------ feed state

export type FeedHealth =
  | { state: "live"; vehicleCount: number; movedCount: number }
  /** Reachable, but nothing in it is moving. Cannot be distinguished from 03:00. */
  | { state: "suspect"; vehicleCount: number; reason: "nothing-moved" }
  | { state: "empty"; vehicleCount: 0 }
  | { state: "error"; reason: string };

export type FeedState = {
  /** Keyed by vehicle id. */
  snapshots: Map<number, VehicleSnapshot>;
  health: FeedHealth;
  lastPollAt: number | null;
  /** Coordinates outside UB, dropped at ingest. Surfaced, never silent. */
  droppedImplausible: number;
  /** Feed route names that matched none of our 84. */
  unjoinable: Set<string>;
};

export function createFeedState(): FeedState {
  return {
    snapshots: new Map(),
    health: { state: "empty", vehicleCount: 0 },
    lastPollAt: null,
    droppedImplausible: 0,
    unjoinable: new Set(),
  };
}

/**
 * Folds one poll into the feed state.
 *
 * Never mutates the state it is given, so a test can replay the same poll
 * sequence and get identical results.
 */
export function ingestPoll(
  state: FeedState,
  vehicles: Vehicle[],
  now: number,
): FeedState {
  const snapshots = new Map<number, VehicleSnapshot>();
  let droppedImplausible = 0;
  let movedCount = 0;

  for (const vehicle of vehicles) {
    if (!isPlausibleUB(vehicle)) {
      droppedImplausible++;
      continue;
    }
    const freshness = assessFreshness(vehicle, state.snapshots.get(vehicle.id), now);
    if (freshness.state === "fresh" && freshness.observedAt === now) movedCount++;
    snapshots.set(vehicle.id, { vehicle, observedAt: now, freshness });
  }

  const vehicleCount = snapshots.size;
  let health: FeedHealth;
  if (vehicleCount === 0) {
    health = { state: "empty", vehicleCount: 0 };
  } else if (movedCount > 0) {
    health = { state: "live", vehicleCount, movedCount };
  } else if (state.lastPollAt !== null && now - state.lastPollAt >= MIN_DIFF_INTERVAL_MS) {
    // A whole city's worth of buses, none of which moved in the interval. This
    // is SUSPECT, not proven stale: at 03:00 it is the truth. Either way it
    // licenses nothing.
    health = { state: "suspect", vehicleCount, reason: "nothing-moved" };
  } else {
    health = { state: "live", vehicleCount, movedCount: 0 };
  }

  return {
    snapshots,
    health,
    lastPollAt: now,
    droppedImplausible: state.droppedImplausible + droppedImplausible,
    unjoinable: state.unjoinable,
  };
}

export function feedError(state: FeedState, reason: string): FeedState {
  // The snapshots are deliberately CLEARED. Serving the last good positions
  // after the feed dies is exactly how a user gets told a bus is arriving when
  // we have no idea where it is.
  return { ...state, snapshots: new Map(), health: { state: "error", reason } };
}

// ------------------------------------------------------- route + direction

export type TrackedVehicle = {
  snapshot: VehicleSnapshot;
  route: Route;
  /** Our direction id (0 or 1), or null when it could not be inferred. */
  directionId: number | null;
};

/**
 * Vehicles on one of our routes, with direction inferred where possible.
 *
 * Vehicles whose `route_name` matches none of our 84 are counted in
 * `unjoinable` and dropped. Hamuga's own route list carries 104 names to our
 * 84, so this is expected traffic, not an anomaly — but it must be visible,
 * because a route silently absent looks exactly like a route not running.
 */
export function trackVehicles(
  state: FeedState,
  index: RouteIndex,
  inferDirection: (v: Vehicle, route: Route) => number | null,
): { tracked: TrackedVehicle[]; unjoinable: Set<string> } {
  const tracked: TrackedVehicle[] = [];
  const unjoinable = new Set<string>();

  for (const snapshot of state.snapshots.values()) {
    const join = joinRouteName(snapshot.vehicle.routeName, index);
    if (!join.ok) {
      unjoinable.add(snapshot.vehicle.routeName);
      continue;
    }
    tracked.push({
      snapshot,
      route: join.route,
      directionId: inferDirection(snapshot.vehicle, join.route),
    });
  }

  return { tracked, unjoinable };
}

// ------------------------------------------------------------ the verdict

/**
 * What the wait screen is allowed to say about one route.
 *
 * This is the ONLY place that decides live-vs-hedged, so there is no second
 * code path where a caller could assemble an unhedged claim from a stale
 * vehicle. Callers receive a verdict, not the raw feed.
 */
export type ArrivalClaim =
  /**
   * Verified moving, recently. May be spoken without a hedge.
   *
   * `freshAt` is carried on the claim so the arrival gate can re-check the
   * freshness window itself rather than trusting that whoever built the claim
   * did. A safety rule that depends on an invariant established in another
   * function is one refactor away from being silently untrue.
   */
  | { kind: "live"; vehicle: Vehicle; distanceM: number; stopsAway: number; etaMinutes: number | null; freshAt: number }
  /** A vehicle exists but its freshness is unproven or contradicted. */
  | { kind: "unverified"; reason: string }
  /** No vehicle on this route at all — schedule is the only answer. */
  | { kind: "no-vehicle" };

/**
 * Picks the nearest approaching vehicle and decides whether it may be trusted.
 *
 * The freshness gate is applied HERE and cannot be bypassed: a `live` claim is
 * only ever constructed from a snapshot whose freshness is `fresh` and inside
 * FRESH_WINDOW_MS. Everything else returns `unverified`, which the announcement
 * layer speaks as a hedged schedule estimate.
 */
export function claimForRoute(
  tracked: TrackedVehicle[],
  routeId: string,
  directionId: number | null,
  approaching: (v: TrackedVehicle) => { distanceM: number; stopsAway: number } | null,
  now: number,
): { best: ArrivalClaim; next: ArrivalClaim | null } {
  const onRoute = tracked.filter((t) => t.route.id === routeId)
    .filter((t) => directionId === null || t.directionId === null || t.directionId === directionId);

  if (onRoute.length === 0) return { best: { kind: "no-vehicle" }, next: null };

  const withDistance = onRoute
    .map((t) => ({ t, approach: approaching(t) }))
    .filter((x): x is { t: TrackedVehicle; approach: { distanceM: number; stopsAway: number } } => x.approach !== null)
    .sort((a, b) => a.approach.distanceM - b.approach.distanceM);

  if (withDistance.length === 0) {
    return { best: { kind: "unverified", reason: "none-approaching" }, next: null };
  }

  const toClaim = (x: (typeof withDistance)[number]): ArrivalClaim => {
    const f = x.t.snapshot.freshness;
    if (f.state !== "fresh") return { kind: "unverified", reason: `freshness:${f.state}:${f.reason}` };
    if (now - f.observedAt > FRESH_WINDOW_MS) return { kind: "unverified", reason: "freshness:expired" };

    const speed = x.t.snapshot.vehicle.speed;
    // No speed, no ETA. The distance is still true and still worth saying; an
    // invented minute count is not.
    const etaMinutes = speed > SPEED_MOVING_KMH
      ? Math.max(1, Math.round(x.approach.distanceM / (speed / 3.6) / 60))
      : null;

    return {
      kind: "live",
      vehicle: x.t.snapshot.vehicle,
      distanceM: x.approach.distanceM,
      stopsAway: x.approach.stopsAway,
      etaMinutes,
      freshAt: f.observedAt,
    };
  };

  return {
    best: toClaim(withDistance[0]),
    // The one after, so a user who misses the first knows the wait rather than
    // having to ask again.
    next: withDistance[1] ? toClaim(withDistance[1]) : null,
  };
}

/**
 * The arrival gate, stated once, as a function.
 *
 * "Ч:35 ирлээ" is the single most dangerous string the app can speak: it is the
 * one that makes someone step toward a road. It requires a vehicle we watched
 * move, within ARRIVAL_RADIUS_M, on evidence no older than FRESH_WINDOW_MS.
 * Exported so the test suite can assert against this function rather than
 * against a comment.
 */
export const ARRIVAL_RADIUS_M = 50;

export function mayAnnounceArrival(claim: ArrivalClaim, now: number, feed: FeedHealth): boolean {
  // Every condition is re-checked here, independently, even where another
  // function already guarantees it.
  if (feed.state !== "live") return false;
  if (claim.kind !== "live") return false;
  if (!(claim.distanceM <= ARRIVAL_RADIUS_M)) return false;   // NaN-safe
  if (!Number.isFinite(claim.freshAt)) return false;
  if (now - claim.freshAt > FRESH_WINDOW_MS) return false;
  return true;
}
