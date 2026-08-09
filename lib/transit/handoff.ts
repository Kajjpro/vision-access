/**
 * The contract between Mode A (`/bus/wait`) and Mode B (`/bus/ride`).
 *
 * Defined now, before Mode B exists, because it is the seam where a mistake is
 * expensive: Mode B counts down from `boardingIndex` along
 * `route-stops.json[routeId][directionId]`, and if that index is wrong every
 * announcement after it is wrong in a way the user cannot detect.
 *
 * Passed through sessionStorage rather than a query string. The values are
 * meaningless to a user, a URL is easy to share or reload into a stale state,
 * and a wrong index recovered from a bookmark would be silently wrong.
 */
import type { RouteStops } from "./types";

export const HANDOFF_KEY = "vision-access:bus-handoff";

export type BusHandoff = {
  routeId: string;
  /** 0 or 1 — the OTP pattern directionId, matching route-stops.json. */
  directionId: number;
  /** Index into route-stops.json[routeId][directionId]. NOT a stop id. */
  boardingIndex: number;
  /** Carried for display and for re-validating the index against the sequence. */
  boardingStopId: string;
  routeDisplayName: string;
  headsign: string;
  createdAt: number;
};

/** Handoffs older than this are stale — a different trip, probably a different day. */
export const HANDOFF_TTL_MS = 4 * 60 * 60 * 1000;

export type HandoffValidation =
  | { ok: true; handoff: BusHandoff }
  | { ok: false; reason: string };

/**
 * Validates a handoff against the baked sequence.
 *
 * Mode B must call this before counting anything. The index is re-derived from
 * `boardingStopId` rather than trusted, because a data rebuild between the two
 * screens can shift a sequence, and an index that no longer points at the stop
 * the user boarded at would produce a confident, wrong countdown.
 */
export function validateHandoff(
  handoff: BusHandoff,
  routeStops: RouteStops,
  now = Date.now(),
): HandoffValidation {
  if (now - handoff.createdAt > HANDOFF_TTL_MS) {
    return { ok: false, reason: "handoff expired" };
  }

  const dirs = routeStops[handoff.routeId];
  if (!dirs) return { ok: false, reason: `unknown route ${handoff.routeId}` };

  const sequence = dirs[String(handoff.directionId)];
  if (!sequence) return { ok: false, reason: `unknown direction ${handoff.directionId}` };

  const actual = sequence.indexOf(handoff.boardingStopId);
  if (actual < 0) {
    // Mode A must refuse to hand off in this case: we know the route serves the
    // stop but not where it sits in the order, so there is nothing to count from.
    return { ok: false, reason: "boarding stop is not in this direction's sequence" };
  }

  return { ok: true, handoff: { ...handoff, boardingIndex: actual } };
}

export function writeHandoff(handoff: BusHandoff, storage: Storage): void {
  storage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
}

export function readHandoff(storage: Storage): BusHandoff | null {
  const raw = storage.getItem(HANDOFF_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BusHandoff;
  } catch {
    return null;
  }
}

export function clearHandoff(storage: Storage): void {
  storage.removeItem(HANDOFF_KEY);
}

/**
 * Builds a handoff, or explains why it cannot.
 *
 * Returning a reason rather than a best guess is the point: Mode A can only
 * hand off when the boarding stop has a known position in the ordered sequence.
 */
export function buildHandoff(
  params: {
    routeId: string;
    directionId: number;
    boardingStopId: string;
    routeDisplayName: string;
    headsign: string;
  },
  routeStops: RouteStops,
  now = Date.now(),
): HandoffValidation {
  const sequence = routeStops[params.routeId]?.[String(params.directionId)];
  if (!sequence) return { ok: false, reason: `no sequence for route ${params.routeId} direction ${params.directionId}` };

  const boardingIndex = sequence.indexOf(params.boardingStopId);
  if (boardingIndex < 0) {
    return { ok: false, reason: "boarding stop is not in this direction's sequence" };
  }
  if (boardingIndex === sequence.length - 1) {
    return { ok: false, reason: "boarding stop is the last stop in this direction" };
  }

  return {
    ok: true,
    handoff: { ...params, boardingIndex, createdAt: now },
  };
}
