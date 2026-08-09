/**
 * Response cache, request coalescing, and a circuit breaker.
 *
 * These exist because of one specific production risk. The gateway answers a
 * rate limit with a bare `401 {"message":"Unauthorized"}` — not a 429 — and the
 * lockout is account-wide, not endpoint-scoped, lasting ~14 minutes. One proxy
 * tripping it takes the wait screen away from EVERY user at once, and nothing
 * in the response distinguishes it from a revoked key.
 *
 * So: don't make the call if a recent answer exists (cache), don't make it
 * twice concurrently (coalescing), and stop making it entirely once it has
 * failed that way (breaker). Retrying into an account-wide lockout is how a
 * 14-minute outage becomes an hour.
 *
 * Module-scope state, deliberately. This is per-server-instance, which is the
 * right granularity: the thing being protected is the shared upstream account.
 */

export type CacheEntry<T> = { value: T; expiresAt: number };

export class TtlCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  constructor(private ttlMs: number, private maxEntries = 500) {}

  get(key: string, now = Date.now()): T | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= now) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    // Cheap bound: the stop set is 923, so this never grows without limit in
    // practice, but an unbounded map in a long-lived server is a leak.
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Ensures concurrent callers for the same key share one upstream request.
 *
 * Without this, a bus pulling in and twenty phones refreshing at once becomes
 * twenty identical calls — which is precisely the burst that trips the limiter.
 */
export class Coalescer<T> {
  private inFlight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = fn().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  get pending(): number {
    return this.inFlight.size;
  }
}

export type BreakerState = "closed" | "open";

/**
 * Opens on the first rate-limit signal and stays open for a cooldown.
 *
 * One failure is enough — this is not a flaky-endpoint breaker with a failure
 * threshold. A 401 from this gateway means the account is already locked out,
 * so the second request is guaranteed to fail and only deepens it.
 */
export class CircuitBreaker {
  private openedAt: number | null = null;
  private trips = 0;

  constructor(private cooldownMs: number) {}

  state(now = Date.now()): BreakerState {
    if (this.openedAt === null) return "closed";
    if (now - this.openedAt >= this.cooldownMs) {
      this.openedAt = null;
      return "closed";
    }
    return "open";
  }

  get isOpen(): boolean {
    return this.state() === "open";
  }

  trip(now = Date.now()): void {
    this.openedAt = now;
    this.trips++;
  }

  reset(): void {
    this.openedAt = null;
  }

  stats(now = Date.now()) {
    return {
      state: this.state(now),
      trips: this.trips,
      msRemaining: this.openedAt === null ? 0 : Math.max(0, this.cooldownMs - (now - this.openedAt)),
    };
  }
}
