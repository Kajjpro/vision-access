/**
 * Live vehicle positions, proxied. CURRENTLY DARK.
 *
 * Returns 503 with `x-feed: disabled` unless `CITY_FEED_ENABLED=true`, because
 * the City gateway rejects our credentials (docs/city-gateway.md). Every client
 * path already treats an unavailable feed as the normal case and falls back to
 * the hedged schedule estimate, so this being off is not an error state — it is
 * the shipping configuration.
 *
 * The protections are the same three the arrivals proxy needs, for the same
 * reason: one server instance serves every user, so an unguarded poll loop
 * multiplies by the number of phones at a stop.
 *
 *   CACHE       one upstream call per interval, not one per phone
 *   COALESCE    concurrent callers share a single in-flight request
 *   BREAKER     stop calling entirely once auth has failed
 *
 * The breaker matters more here than for arrivals: a failing login against a
 * shared account is exactly the thing that gets an account locked, and this
 * endpoint would otherwise retry it on every poll from every client.
 */
import { NextResponse } from "next/server";

import { CircuitBreaker, Coalescer, TtlCache } from "@/lib/transit/breaker";
import { CityAuthError, CityDisabledError, fetchVehicles, isCityFeedEnabled } from "@/lib/transit/city-client";
import type { Vehicle } from "@/lib/transit/vehicles";

export const dynamic = "force-dynamic";

/**
 * Buses move continuously, so a short TTL, but not shorter than the interval
 * over which movement is detectable — polling faster cannot manufacture
 * freshness (see MIN_DIFF_INTERVAL_MS in vehicles.ts) and only costs quota.
 */
const CACHE_TTL_MS = 10_000;

/** Auth failures are not transient. Wait well past any plausible retry window. */
const BREAKER_COOLDOWN_MS = 15 * 60_000;

const UPSTREAM_TIMEOUT_MS = 6_000;

const CACHE_KEY = "all";

const cache = new TtlCache<{ vehicles: Vehicle[]; fetchedAt: string }>(CACHE_TTL_MS);
const coalescer = new Coalescer<{ vehicles: Vehicle[]; fetchedAt: string }>();
const breaker = new CircuitBreaker(BREAKER_COOLDOWN_MS);

export async function GET() {
  if (!isCityFeedEnabled()) {
    // 503, not 200-with-empty. An empty vehicle list is a meaningful datum —
    // "no buses running" — and must never be confused with "we did not look".
    return NextResponse.json(
      { error: "live vehicle feed disabled", vehicles: [] },
      { status: 503, headers: { "x-feed": "disabled" } },
    );
  }

  if (breaker.isOpen) {
    return NextResponse.json(
      { error: "live vehicle feed unavailable", vehicles: [] },
      { status: 503, headers: { "x-feed": "breaker-open", "x-breaker": JSON.stringify(breaker.stats()) } },
    );
  }

  const cached = cache.get(CACHE_KEY);
  if (cached) {
    return NextResponse.json(cached, { headers: { "x-cache": "hit", "x-feed": "live" } });
  }

  try {
    const body = await coalescer.run(CACHE_KEY, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        const vehicles = await fetchVehicles({ signal: controller.signal });
        const result = { vehicles, fetchedAt: new Date().toISOString() };
        cache.set(CACHE_KEY, result);
        return result;
      } finally {
        clearTimeout(timer);
      }
    });

    return NextResponse.json(body, { headers: { "x-cache": "miss", "x-feed": "live" } });
  } catch (e) {
    if (e instanceof CityDisabledError) {
      return NextResponse.json({ error: "disabled", vehicles: [] }, { status: 503, headers: { "x-feed": "disabled" } });
    }
    if (e instanceof CityAuthError) {
      // One signal is enough. Bad credentials will not become good on a retry,
      // and hammering login against a shared account is how it gets locked.
      breaker.trip();
      console.error("[transit/vehicles] auth failed — breaker opened:", e.message);
      return NextResponse.json({ error: "auth", vehicles: [] }, { status: 503, headers: { "x-feed": "auth-failed" } });
    }

    console.error("[transit/vehicles] upstream failure:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "upstream", vehicles: [] }, { status: 503, headers: { "x-feed": "error" } });
  }
}
