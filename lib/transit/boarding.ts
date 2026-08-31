/**
 * Detecting that the user has boarded, rather than asking them.
 *
 * Asking is the thing to avoid: a blind passenger stepping onto a crowded bus
 * has both hands busy and no attention for the phone. So we watch the GPS and
 * work it out.
 *
 * THE FALSE POSITIVE IS THE DANGEROUS DIRECTION. Declaring a boarding that did
 * not happen starts the countdown early, and the user is then told to get off
 * several stops before their actual destination — while still standing at the
 * stop. So the bar is deliberately high, and the result is always reversible.
 *
 * SPEED ALONE IS NOT ENOUGH. A car passing the stop at 40 km/h produces exactly
 * the speed signature of a bus pulling away, and a phone in a pocket cannot
 * tell which vehicle it is in. What distinguishes them is the PATH: a bus
 * follows the route's stop chords, a passing car diverges within a few hundred
 * metres. So corridor agreement is required, sustained, before anything is
 * declared.
 *
 * Pure: fixes in, verdict out, no clock and no geolocation of its own.
 */

export type Fix = {
  lat: number;
  lon: number;
  /** Metres. Poor fixes are discarded rather than smoothed. */
  accuracy: number;
  timestamp: number;
};

export type ChordPoint = { lat: number; lon: number };

/**
 * Bus speed floor.
 *
 * Brisk walking tops out near 6 km/h and a slow jog near 10. 12 km/h is clear
 * of both without demanding open road — city buses spend much of their time
 * well below their nominal speed.
 */
export const BUS_SPEED_MIN_KMH = 12;

/** Above this it is not a bus in Ulaanbaatar traffic; likely a bad fix. */
export const BUS_SPEED_MAX_KMH = 90;

/**
 * How far off the route's chords the user may be and still be "on the route".
 *
 * Generous, because the chords are straight lines between stops while the road
 * curves between them — the deviation is the geometry's error, not the
 * traveller's. The median stop spacing is 568 m, so a curved segment can sit
 * this far from its own chord legitimately.
 */
export const CORRIDOR_M = 120;

/**
 * Consecutive qualifying fixes before boarding is declared.
 *
 * This is the whole defence against the passing car. At roughly 1 Hz a car
 * doing 40 km/h covers ~55 m per fix, so four of them is over 200 m of travel
 * that stayed inside the route corridor AND kept bus speed — by which point a
 * vehicle on a different road has diverged.
 */
export const CONFIRM_FIXES = 4;

/** Fixes worse than this carry no information about which road we are on. */
export const ACCURACY_LIMIT_M = 60;

/** A gap this long breaks the streak — the fixes are no longer consecutive. */
export const MAX_FIX_GAP_MS = 20_000;

const EARTH_M = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: ChordPoint, b: ChordPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(s));
}

/**
 * Perpendicular distance from a point to a segment, in metres.
 *
 * Flat-earth projection: over a segment of a few hundred metres at UB's
 * latitude the error is centimetres, and it avoids a trigonometric solve on
 * every fix against every chord.
 */
export function distanceToSegment(p: ChordPoint, a: ChordPoint, b: ChordPoint): number {
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos(rad(p.lat));

  const px = (p.lon - a.lon) * mPerDegLon, py = (p.lat - a.lat) * mPerDegLat;
  const bx = (b.lon - a.lon) * mPerDegLon, by = (b.lat - a.lat) * mPerDegLat;

  const lengthSq = bx * bx + by * by;
  if (lengthSq === 0) return Math.hypot(px, py);

  const t = Math.max(0, Math.min(1, (px * bx + py * by) / lengthSq));
  return Math.hypot(px - t * bx, py - t * by);
}

/** Nearest approach to the route's chord polyline, and which segment won. */
export function distanceToRoute(
  p: ChordPoint,
  chords: ChordPoint[],
  { fromIndex = 0 }: { fromIndex?: number } = {},
): { distanceM: number; segmentIndex: number } {
  let best = { distanceM: Infinity, segmentIndex: -1 };
  for (let i = Math.max(0, fromIndex); i < chords.length - 1; i++) {
    const d = distanceToSegment(p, chords[i], chords[i + 1]);
    if (d < best.distanceM) best = { distanceM: d, segmentIndex: i };
  }
  return best;
}

export type BoardingState = {
  /** Consecutive fixes that looked like riding this route. */
  streak: number;
  lastFix: Fix | null;
  /** Latched once declared, so a dip in speed does not un-board the user. */
  declared: boolean;
  /** Set when the user rejects the detection — suppresses re-detection briefly. */
  suppressedUntil: number;
};

export function createBoardingState(): BoardingState {
  return { streak: 0, lastFix: null, declared: false, suppressedUntil: 0 };
}

/**
 * After a rejection, stop trying for this long.
 *
 * Without it, the very next fix re-declares the boarding the user just denied,
 * and they are stuck in a loop they cannot escape — a uniquely horrible
 * experience for someone who has to listen to every announcement.
 */
export const SUPPRESS_AFTER_REJECT_MS = 90_000;

export type BoardingEvent =
  | { type: "boarded"; speedKmh: number; segmentIndex: number }
  | { type: "progress"; streak: number; needed: number };

/**
 * One position update while waiting.
 *
 * Requires ALL of: a usable fix, bus speed, and position inside the route
 * corridor — sustained over CONFIRM_FIXES consecutive updates. Any one of them
 * failing resets the streak, because the evidence has to be continuous to rule
 * out a vehicle that merely shares part of our road.
 */
export function onWaitingPosition(
  state: BoardingState,
  fix: Fix,
  chords: ChordPoint[],
  { fromIndex = 0 }: { fromIndex?: number } = {},
): { state: BoardingState; events: BoardingEvent[] } {
  if (state.declared) return { state, events: [] };
  if (fix.timestamp < state.suppressedUntil) {
    return { state: { ...state, lastFix: fix, streak: 0 }, events: [] };
  }
  if (fix.accuracy > ACCURACY_LIMIT_M) {
    // Discarded, not smoothed. A 200 m fix cannot say which road we are on, and
    // averaging it in drags a good position toward a wrong one.
    return { state: { ...state, streak: 0 }, events: [] };
  }

  const previous = state.lastFix;
  const next: BoardingState = { ...state, lastFix: fix };
  if (!previous) return { state: next, events: [] };

  const elapsedMs = fix.timestamp - previous.timestamp;
  if (elapsedMs <= 0 || elapsedMs > MAX_FIX_GAP_MS) {
    return { state: { ...next, streak: 0 }, events: [] };
  }

  const speedKmh = (haversine(previous, fix) / (elapsedMs / 1000)) * 3.6;
  const onRoute = distanceToRoute(fix, chords, { fromIndex });

  const qualifies =
    speedKmh >= BUS_SPEED_MIN_KMH &&
    speedKmh <= BUS_SPEED_MAX_KMH &&
    onRoute.distanceM <= CORRIDOR_M;

  if (!qualifies) return { state: { ...next, streak: 0 }, events: [] };

  const streak = state.streak + 1;
  if (streak < CONFIRM_FIXES) {
    return { state: { ...next, streak }, events: [{ type: "progress", streak, needed: CONFIRM_FIXES }] };
  }

  return {
    state: { ...next, streak, declared: true },
    events: [{ type: "boarded", speedKmh, segmentIndex: onRoute.segmentIndex }],
  };
}

/** The manual "I am on the bus" gesture. Always available, never detected away. */
export function declareBoarded(state: BoardingState): BoardingState {
  return { ...state, declared: true, streak: CONFIRM_FIXES };
}

/** The undo. Resets and suppresses, so the next fix cannot re-declare it. */
export function rejectBoarding(state: BoardingState, now: number): BoardingState {
  return { ...state, declared: false, streak: 0, suppressedUntil: now + SUPPRESS_AFTER_REJECT_MS };
}

/**
 * Correlating the user with a specific tracked vehicle.
 *
 * Kept for when the live feed opens up: if the user's position and a vehicle's
 * move together, that is the bus they are on and it can be named by plate.
 * Currently unreachable — the City gateway is closed to us and the schedule
 * path never calls this — but it costs nothing to keep correct, and deleting it
 * would mean rewriting it when the key-only path is opened.
 */
export function correlateVehicle(
  userFix: Fix,
  vehicles: { id: number; plateNumber: string; latitude: number; longitude: number }[],
  { radiusM = 80 }: { radiusM?: number } = {},
): { id: number; plateNumber: string } | null {
  let best: { id: number; plateNumber: string; d: number } | null = null;
  for (const v of vehicles) {
    const d = haversine(userFix, { lat: v.latitude, lon: v.longitude });
    if (d <= radiusM && (!best || d < best.d)) best = { id: v.id, plateNumber: v.plateNumber, d };
  }
  return best ? { id: best.id, plateNumber: best.plateNumber } : null;
}
