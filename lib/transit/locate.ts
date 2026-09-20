/**
 * Getting a GPS fix good enough to name a bus stop.
 *
 * THE OLD CODE ASKED ONCE AND BELIEVED THE ANSWER. A single
 * `getCurrentPosition({ maximumAge: 30000 })` returns whatever the phone has to
 * hand, which on a cold start is a cell-tower or Wi-Fi estimate accurate to
 * hundreds of metres — sometimes kilometres. GPS then converges to ±5–20 m over
 * the next 5–30 seconds, but nothing was watching, so the app matched stops
 * against the worst fix of the whole session and reported "no stop nearby"
 * while the user stood at one.
 *
 * So: watch, keep the best, stop as soon as it is good enough, and give up
 * loudly rather than silently.
 *
 * Pure except for the geolocation object, which is injected — that is what lets
 * a cold start, a converging fix, a permission denial and a phone that never
 * gets a lock all be replayed deterministically in tests.
 */

export type Fix = { lat: number; lon: number; accuracyM: number; at: number };

/**
 * Stop early at this accuracy. Below it, more waiting buys nothing that changes
 * which stop we name — the median gap between neighbouring stops is 91 m.
 */
export const GOOD_ENOUGH_M = 30;

/**
 * Keep waiting past the first usable fix until this deadline, hoping for
 * better. Chosen against GPS convergence: most of the improvement from a cold
 * start lands inside 10 s, and a blind user standing still at a stop will
 * tolerate that far better than a wrong stop name.
 */
export const IMPROVE_DEADLINE_MS = 12_000;

/** Absolute ceiling. Past this we answer with whatever we have, or nothing. */
export const HARD_DEADLINE_MS = 25_000;

/** Tell the user we are still working at this cadence, so silence never reads as failure. */
export const PROGRESS_INTERVAL_MS = 6_000;

export type LocateOutcome =
  | { kind: "fix"; fix: Fix; /** True when we stopped early because it was good. */ converged: boolean }
  /** Fixes arrived but none was usable for naming a stop. */
  | { kind: "poor"; best: Fix }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "timeout" };

export type LocateEvent =
  | { type: "progress"; bestAccuracyM: number | null; elapsedMs: number }
  | { type: "improved"; accuracyM: number };

export type GeolocationLike = Pick<Geolocation, "watchPosition" | "clearWatch">;

/**
 * Watches until the fix is good enough, then resolves.
 *
 * Never rejects and never hangs: every path resolves exactly once, because a
 * promise that never settles leaves the wait screen silent, which is the one
 * outcome the user cannot distinguish from "no bus is coming".
 */
export function locate({
  geolocation,
  onEvent,
  goodEnoughM = GOOD_ENOUGH_M,
  improveDeadlineMs = IMPROVE_DEADLINE_MS,
  hardDeadlineMs = HARD_DEADLINE_MS,
  progressIntervalMs = PROGRESS_INTERVAL_MS,
  usableM = 500,
  now = () => Date.now(),
}: {
  geolocation?: GeolocationLike | null;
  onEvent?: (e: LocateEvent) => void;
  goodEnoughM?: number;
  improveDeadlineMs?: number;
  hardDeadlineMs?: number;
  progressIntervalMs?: number;
  usableM?: number;
  now?: () => number;
}): Promise<LocateOutcome> {
  return new Promise<LocateOutcome>((resolve) => {
    if (!geolocation) return resolve({ kind: "unavailable" });

    const started = now();
    let best: Fix | null = null;
    let settled = false;
    let watchId: number | null = null;
    let improveTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let progressTimer: ReturnType<typeof setInterval> | null = null;

    const finish = (outcome: LocateOutcome) => {
      if (settled) return;
      settled = true;
      if (watchId !== null) {
        try { geolocation.clearWatch(watchId); } catch { /* already gone */ }
      }
      if (improveTimer) clearTimeout(improveTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (progressTimer) clearInterval(progressTimer);
      resolve(outcome);
    };

    /** Answer with the best fix seen, or say plainly that there wasn't one. */
    const finishWithBest = () => {
      if (!best) return finish({ kind: "timeout" });
      if (best.accuracyM > usableM) return finish({ kind: "poor", best });
      finish({ kind: "fix", fix: best, converged: false });
    };

    progressTimer = setInterval(() => {
      onEvent?.({ type: "progress", bestAccuracyM: best?.accuracyM ?? null, elapsedMs: now() - started });
    }, progressIntervalMs);

    // The improve window starts on arrival, not on the first fix: a phone that
    // takes 10 s to produce anything has already spent the user's patience.
    improveTimer = setTimeout(() => { if (best) finishWithBest(); }, improveDeadlineMs);
    hardTimer = setTimeout(finishWithBest, hardDeadlineMs);

    try {
      watchId = geolocation.watchPosition(
        (position) => {
          const fix: Fix = {
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : Infinity,
            at: now(),
          };

          // Keep the BEST, not the latest. Accuracy is not monotonic — a fix can
          // degrade when the phone falls back to Wi-Fi mid-acquisition, and
          // taking the newest would throw away a better answer already in hand.
          if (!best || fix.accuracyM < best.accuracyM) {
            best = fix;
            onEvent?.({ type: "improved", accuracyM: fix.accuracyM });
          }

          if (fix.accuracyM <= goodEnoughM) finish({ kind: "fix", fix, converged: true });
        },
        (error) => {
          // PERMISSION_DENIED is terminal — retrying cannot help, and the user
          // needs to be told something different from "no signal".
          if (error.code === 1) return finish({ kind: "denied" });
          // POSITION_UNAVAILABLE / TIMEOUT: keep watching until our own
          // deadline. The browser's per-call timeout is not the end of the
          // story; a later fix often still arrives.
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: hardDeadlineMs },
      );
    } catch {
      finish({ kind: "unavailable" });
    }
  });
}
