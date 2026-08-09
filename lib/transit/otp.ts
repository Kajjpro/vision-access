/**
 * OTP plan client and the fallbacks around it. Server-side only.
 *
 * Imported exclusively by app/api/transit/next/route.ts. HAMUGA_API_KEY is read
 * here and never crosses to the browser.
 */
import type { Arrival, DegradedReason, OtpLeg, OtpPlanResponse, Stop } from "./types";
import { stripFeedPrefix } from "./types";

const OTP_BASE = "https://gateway.hamuga.mn/route/routers/default/plan";

/**
 * Ulaanbaatar is UTC+8 and has observed no DST since 2017, so the offset is a
 * constant rather than something to compute. Asserted, not derived: a server in
 * any other zone constructing "today" from its own clock would ask OTP for the
 * wrong service date near midnight, and the arrivals would silently belong to
 * yesterday or tomorrow.
 *
 * Confirmed against the feed: legs carry agencyTimeZoneOffset 28800000 ms.
 */
export const AGENCY_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
export const AGENCY_TZ = "Asia/Ulaanbaatar";

/** `YYYY-MM-DD` and `HH:mm` in AGENCY time, whatever zone the host is in. */
export function agencyDateTime(at: Date = new Date()): { date: string; time: string } {
  const shifted = new Date(at.getTime() + AGENCY_UTC_OFFSET_MS);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mi = String(shifted.getUTCMinutes()).padStart(2, "0");
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}` };
}

export class RateLimitedError extends Error {}

/**
 * OTP itineraries from this stop outward.
 *
 * OTP plans point-to-point, not "departures from here", so a destination is
 * needed. Using a far point across the city surfaces the routes actually
 * serving the stop; we only read the FIRST transit leg of each itinerary, which
 * is the bus the user would board.
 */
export async function fetchArrivals(
  stop: Stop,
  destination: { lat: number; lon: number },
  apiKey: string,
  { signal, now = new Date() }: { signal?: AbortSignal; now?: Date } = {},
): Promise<OtpLeg[]> {
  const { date, time } = agencyDateTime(now);
  const url = new URL(OTP_BASE);
  url.searchParams.set("fromPlace", `${stop.lat},${stop.lon}`);
  url.searchParams.set("toPlace", `${destination.lat},${destination.lon}`);
  url.searchParams.set("date", date);
  url.searchParams.set("time", time);
  url.searchParams.set("mode", "TRANSIT,WALK");
  url.searchParams.set("numItineraries", "5");
  // Absent by default; the brief's cross-check depends on it.
  url.searchParams.set("showIntermediateStops", "true");

  const res = await fetch(url, { headers: { "x-api-key": apiKey }, signal });

  // The gateway signals a rate limit with a bare 401, NOT a 429, and the
  // lockout is account-wide rather than endpoint-scoped. Indistinguishable from
  // a bad key at the wire level — which is exactly why the caller trips a
  // breaker instead of retrying.
  if (res.status === 401) {
    throw new RateLimitedError("gateway 401 — rate limited or bad key; treating as lockout");
  }
  if (!res.ok) throw new Error(`OTP ${res.status}`);

  const body = (await res.json()) as OtpPlanResponse;
  if (body.error) throw new Error(`OTP error: ${body.error.msg ?? body.error.id}`);

  const legs: OtpLeg[] = [];
  for (const itinerary of body.plan?.itineraries ?? []) {
    const first = (itinerary.legs ?? []).find((l) => l.transitLeg);
    if (first) legs.push(first);
  }
  return legs;
}

/**
 * Per-route destinations, so no route is structurally disadvantaged.
 *
 * OTP plans point-to-point, so asking for arrivals needs somewhere to go. A
 * single fixed city-centre destination biases the answer toward centre-bound
 * routes and systematically under-reports a stop on the far side of the city —
 * and because the bias is systematic rather than random, testing from a central
 * stop would never reveal it.
 *
 * Each route's own terminus is its fair destination: the last stop of whichever
 * direction contains this stop, which is where a bus boarded here is heading.
 */
export function destinationsForStop(
  stopId: string,
  routeIds: string[],
  routeStops: Record<string, Record<string, string[]>>,
  stopsById: Map<string, Stop>,
): { routeId: string; directionId: number; destination: Stop }[] {
  const out: { routeId: string; directionId: number; destination: Stop }[] = [];

  for (const routeId of routeIds) {
    const dirs = routeStops[routeId];
    if (!dirs) continue;
    for (const [directionId, sequence] of Object.entries(dirs)) {
      const index = sequence.indexOf(stopId);
      // Not on this direction, or already the terminus — either way there is
      // no onward journey to plan from here.
      if (index < 0 || index >= sequence.length - 1) continue;
      const terminus = stopsById.get(sequence[sequence.length - 1]);
      if (terminus) out.push({ routeId, directionId: Number(directionId), destination: terminus });
    }
  }
  return out;
}

/** Legs → arrivals, deduplicated per route, soonest first. */
export function legsToArrivals(legs: OtpLeg[], stopId: string, now = Date.now()): Arrival[] {
  const byRoute = new Map<string, Arrival>();

  for (const leg of legs) {
    const routeId = stripFeedPrefix(leg.routeId);
    if (!routeId) continue;

    // Only legs actually boarding at this stop are arrivals here.
    const from = stripFeedPrefix(leg.from?.stopId);
    if (from && from !== stopId) continue;

    const minutes = Math.round((leg.startTime - now) / 60000);
    if (minutes < 0) continue;

    const arrival: Arrival = {
      routeId,
      routeDisplayName: leg.routeShortName ?? routeId,
      minutes,
      headsign: leg.headsign ?? null,
      // realTime is false on every leg the feed has ever returned.
      isEstimate: leg.realTime !== true,
      source: leg.realTime === true ? "realtime" : "schedule",
    };

    const existing = byRoute.get(routeId);
    if (!existing || arrival.minutes < existing.minutes) byRoute.set(routeId, arrival);
  }

  return [...byRoute.values()].sort((a, b) => a.minutes - b.minutes);
}

/**
 * Offline / breaker-open fallback, built from the feed's own headway data.
 *
 * `headway` is seconds between departures on frequency-based trips. Using it
 * beats an invented constant: it is what the agency published for that route.
 * The expected wait for a passenger arriving at random is half the headway,
 * which is what this returns — and it is still spoken with the hedge, because
 * it is an even weaker claim than the schedule.
 */
export function headwayFallback(
  routeIds: string[],
  headwayByRoute: Map<string, number>,
  routeNames: Map<string, string>,
  defaultHeadwaySec: number | null,
): Arrival[] {
  const out: Arrival[] = [];
  for (const routeId of routeIds) {
    const headway = headwayByRoute.get(routeId) ?? defaultHeadwaySec;
    // No published headway and no observed one: say nothing about this route
    // rather than invent a number.
    if (!headway || headway <= 0) continue;
    out.push({
      routeId,
      routeDisplayName: routeNames.get(routeId) ?? routeId,
      minutes: Math.max(1, Math.round(headway / 2 / 60)),
      headsign: null,
      isEstimate: true,
      source: "headway",
    });
  }
  return out.sort((a, b) => a.minutes - b.minutes);
}

export function classifyError(e: unknown): DegradedReason {
  if (e instanceof RateLimitedError) return "rate-limited";
  if (e instanceof Error && e.name === "AbortError") return "timeout";
  if (e instanceof Error && /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(e.message)) return "offline";
  return "upstream-error";
}
