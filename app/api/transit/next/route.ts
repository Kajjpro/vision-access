/**
 * Arrival estimates for one stop. The only network-dependent endpoint in the app.
 *
 * HAMUGA_API_KEY is read here, server-side, and never reaches the browser —
 * which is the whole reason this route exists rather than the client calling
 * the gateway directly.
 *
 * Everything it returns is an ESTIMATE. `/api/bus/v1/realtime` carries no
 * vehicle feed (empty payload for a whole-country bbox, three sessions) and OTP
 * reports `realTime: false` on every leg, so `source` is "schedule" or
 * "headway" and never "realtime". The client's announcement layer hedges on
 * that basis; this route must never claim otherwise.
 */
import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CircuitBreaker, Coalescer, TtlCache } from "@/lib/transit/breaker";
import { classifyError, destinationsForStop, fetchArrivals, headwayFallback, legsToArrivals, RateLimitedError } from "@/lib/transit/otp";
import type { Arrival, NextArrivalsResponse, Route, RouteStops, Stop, StopRoutes } from "@/lib/transit/types";

export const dynamic = "force-dynamic";

/**
 * Short enough that a user refreshing sees movement, long enough that a busy
 * stop does not become a request per passenger. Buses do not re-plan faster
 * than this, and the data is schedule-derived anyway.
 */
const CACHE_TTL_MS = 45_000;

/** The observed lockout is ~14 minutes; wait longer than that before probing. */
const BREAKER_COOLDOWN_MS = 15 * 60_000;

const UPSTREAM_TIMEOUT_MS = 6_000;

/**
 * A stop with many routes means many upstream calls, so this is capped.
 *
 * Routes are queried in the order stop-routes.json lists them, which is stable,
 * so the same routes are covered on every call rather than a random subset. The
 * cap sits INSIDE the coalesced+cached path, and the breaker is re-checked
 * between calls so a lockout stops the batch immediately rather than after all
 * of them have failed.
 */
const MAX_ROUTE_QUERIES_PER_STOP = 6;

const cache = new TtlCache<NextArrivalsResponse>(CACHE_TTL_MS);
const coalescer = new Coalescer<NextArrivalsResponse>();
const breaker = new CircuitBreaker(BREAKER_COOLDOWN_MS);

// Baked data, read once per server instance.
let stopsById: Map<string, Stop> | null = null;
let stopRoutes: StopRoutes | null = null;
let routeStops: RouteStops | null = null;
let routesById: Map<string, Route> | null = null;

function loadData() {
  if (stopsById && stopRoutes && routesById && routeStops) return;
  const dir = join(process.cwd(), "public/transit");
  const stops: Stop[] = JSON.parse(readFileSync(join(dir, "stops.json"), "utf8"));
  const routes: Route[] = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8"));
  stopsById = new Map(stops.map((s) => [s.id, s]));
  routesById = new Map(routes.map((r) => [r.id, r]));
  stopRoutes = JSON.parse(readFileSync(join(dir, "stop-routes.json"), "utf8"));
  routeStops = JSON.parse(readFileSync(join(dir, "route-stops.json"), "utf8"));
}

/**
 * Headways observed from OTP legs, accumulated across successful calls.
 *
 * Populated from real `headway` values rather than a constant, so the offline
 * path degrades to the agency's own published frequency. Empty until the first
 * successful upstream call — before that, a route with no headway is omitted
 * rather than guessed at.
 */
const headwayByRoute = new Map<string, number>();

/**
 * Upstream calls actually made, exposed as `x-upstream-calls`.
 *
 * Without it, coalesced responses are indistinguishable from independent ones —
 * ten concurrent requests all report a cache miss whether they shared a call or
 * made ten. Since the whole point is to never burst the gateway, that number
 * has to be observable in production, not just in a unit test.
 */
let upstreamCalls = 0;

function fallbackFor(stopId: string, reason: NonNullable<NextArrivalsResponse["degraded"]>): NextArrivalsResponse {
  loadData();
  const routeIds = stopRoutes![stopId] ?? [];
  const names = new Map(routeIds.map((id) => [id, routesById!.get(id)?.displayName ?? id]));
  const arrivals = headwayFallback(routeIds, headwayByRoute, names, null);
  return {
    stopId,
    arrivals,
    degraded: reason,
    generatedAt: new Date().toISOString(),
  };
}

export async function GET(request: Request) {
  const stopId = new URL(request.url).searchParams.get("stopId");
  if (!stopId) {
    return NextResponse.json({ error: "stopId is required" }, { status: 400 });
  }

  loadData();
  const stop = stopsById!.get(stopId);
  if (!stop) {
    return NextResponse.json({ error: `unknown stop ${stopId}` }, { status: 404 });
  }

  const cached = cache.get(stopId);
  if (cached) {
    return NextResponse.json(cached, { headers: { "x-cache": "hit", "x-upstream-calls": String(upstreamCalls) } });
  }

  // Breaker open: do not call. Retrying into an account-wide lockout is how a
  // 14-minute outage becomes an hour, and it would take out every user at once.
  if (breaker.isOpen) {
    const body = fallbackFor(stopId, "rate-limited");
    return NextResponse.json(body, { headers: { "x-cache": "breaker-open", "x-upstream-calls": String(upstreamCalls), "x-breaker": JSON.stringify(breaker.stats()) } });
  }

  const apiKey = process.env.HAMUGA_API_KEY ?? process.env.HAMUGA_KEY;
  if (!apiKey) {
    const body = fallbackFor(stopId, "upstream-error");
    return NextResponse.json(body, { status: 200, headers: { "x-cache": "no-key" } });
  }

  try {
    // Concurrent requests for the same stop share one upstream call — a bus
    // pulling in and twenty phones refreshing is exactly the burst that trips
    // the limiter.
    const body = await coalescer.run(stopId, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        // One query per route, toward that route's own terminus.
        const targets = destinationsForStop(stopId, stopRoutes![stopId] ?? [], routeStops!, stopsById!)
          .slice(0, MAX_ROUTE_QUERIES_PER_STOP);

        const legs = [];
        for (const target of targets) {
          // Re-checked between calls: a lockout must stop the batch here, not
          // after every remaining route has also failed.
          if (breaker.isOpen) break;
          upstreamCalls++;
          legs.push(...await fetchArrivals(stop, target.destination, apiKey, { signal: controller.signal }));
        }

        for (const leg of legs) {
          const rid = leg.routeId?.split(":").pop();
          if (rid && leg.headway > 0) headwayByRoute.set(rid, leg.headway);
        }

        const arrivals: Arrival[] = legsToArrivals(legs, stopId);
        const result: NextArrivalsResponse = {
          stopId,
          arrivals,
          degraded: arrivals.length === 0 ? "no-service" : null,
          generatedAt: new Date().toISOString(),
        };
        cache.set(stopId, result);
        return result;
      } finally {
        clearTimeout(timer);
      }
    });

    return NextResponse.json(body, { headers: { "x-cache": "miss", "x-upstream-calls": String(upstreamCalls) } });
  } catch (e) {
    if (e instanceof RateLimitedError) {
      // One signal is enough. A 401 here means the account is already locked
      // out, so a second call is guaranteed to fail and only deepens it.
      breaker.trip();
      console.error("[transit/next] gateway 401 — breaker opened, failing over to headway estimates");
    } else {
      console.error("[transit/next] upstream failure:", e instanceof Error ? e.message : e);
    }

    const reason = classifyError(e);
    const body = fallbackFor(stopId, reason);
    // 200 on purpose: this is a usable, honest answer that the client speaks as
    // degraded. A 5xx would give the client nothing to say but silence.
    return NextResponse.json(body, { headers: { "x-cache": "fallback", "x-upstream-calls": String(upstreamCalls), "x-degraded": reason } });
  }
}
