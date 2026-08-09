/**
 * Counts stops along a route from a GPS position stream.
 *
 * THIS IS THE FEATURE THAT MUST NEVER BE WRONG. Everything else in the app
 * degrades to inconvenience; this degrades to a blind person stranded somewhere
 * they did not intend to be. So it is a pure state machine — no DOM, no
 * geolocation, no React, no clock of its own — which is what lets the whole
 * thing be driven by a synthetic trace with injected noise and dropouts.
 *
 * Two properties do the real work:
 *
 *   FORWARD-ONLY. Candidates are drawn from a window ahead of the current
 *   index. A bus does not reverse along its route, so a jittery fix that lands
 *   nearer a stop already passed must not un-count it.
 *
 *   HYSTERESIS. A stop is not counted on approach; it is counted on DEPARTURE,
 *   after the distance has opened back out past a wider threshold. Counting on
 *   entry would double-count every stop where the bus waits at a light and the
 *   noise crosses the boundary twice.
 */

export type OrderedStop = { id: string; name: string; lat: number; lon: number };

export type Fix = {
  lat: number;
  lon: number;
  /** Metres. Fixes worse than ACCURACY_LIMIT_M are discarded, not smoothed. */
  accuracy: number;
  /** Epoch ms. Supplied by the caller so the matcher owns no clock. */
  timestamp: number;
};

/** Below this a fix is usable. Cheap Android in a metal bus routinely exceeds it. */
export const ACCURACY_LIMIT_M = 100;

/** Consecutive unusable fixes before tracking is declared degraded. */
export const BAD_FIX_LIMIT = 5;

/** Enter radius — closer than this and we are at the stop. */
export const ENTER_M = 70;

/** Exit radius. Wider than ENTER_M on purpose: this gap IS the hysteresis. */
export const EXIT_M = 110;

/**
 * Consecutive fixes beyond EXIT_M before a departure is believed.
 *
 * A single noisy sample must not count a stop. With 40 m noise, a bus parked
 * 30 m from a stop produces occasional excursions past 110 m purely from
 * jitter — which counted a phantom stop while stationary in traffic. At 25 km/h
 * and 1 Hz this costs ~14 m of travel to confirm, which is nothing.
 */
export const EXIT_CONFIRM_FIXES = 2;

/**
 * How far ahead to look. Deliberately small.
 *
 * The window exists to recover from ONE missed match, not to search the route.
 * Several UB routes loop back near themselves — on Ч:76 the terminus passes
 * within 58 m while the bus is still travelling between stops 15 and 16 — so a
 * wide window lets a geographically-near but sequentially-distant stop win and
 * the count leaps forward. A 60 s dropout at 25 km/h covers ~417 m against a
 * median spacing of 568 m, so one stop of recovery is the right amount.
 *
 * The trade is deliberate: a narrow window can fail to recover a stop, which
 * costs one uncounted stop and is caught by the degraded-tracking path. A wide
 * one can silently skip several, which is the failure that strands someone.
 */
export const LOOKAHEAD = 2;

/** No usable fix for this long and the countdown is no longer trustworthy. */
export const GPS_LOSS_MS = 90_000;

export type MatcherEvent =
  | { type: "stop-passed"; index: number; stop: OrderedStop; remaining: number }
  | { type: "degraded"; reason: "bad-accuracy" | "gps-lost" }
  | { type: "recovered" }
  | { type: "arrived"; index: number; stop: OrderedStop }
  | { type: "overshoot"; index: number; stop: OrderedStop };

export type MatcherState = {
  currentIndex: number;
  destIndex: number;
  insideStop: boolean;
  pendingIndex: number | null;
  badFixes: number;
  degraded: boolean;
  lastGoodFixAt: number | null;
  /** Latched once the destination is passed: counting forward cannot recover it. */
  overshot: boolean;
  /** Consecutive fixes seen beyond EXIT_M while insideStop. */
  exitStreak: number;
  /**
   * Latched when the destination is REACHED.
   *
   * The get-off announcement fires on ENTRY, not on departure: the whole value
   * of "Одоо буугаарай" is that it arrives while the user is still at the door.
   * Departure-based counting would announce it after the bus has pulled away,
   * and at a terminus — where the bus never departs — it would never fire at
   * all. The latch stops a jittery fix re-announcing it.
   */
  arrivedAnnounced: boolean;
};

export function createState(startIndex: number, destIndex: number, now: number): MatcherState {
  return {
    currentIndex: startIndex,
    destIndex,
    insideStop: false,
    pendingIndex: null,
    badFixes: 0,
    degraded: false,
    lastGoodFixAt: now,
    overshot: false,
    exitStreak: 0,
    arrivedAnnounced: false,
  };
}

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
 * One position update. Returns the next state and everything to announce.
 *
 * Never mutates the state it is given — the caller holds the old one, so a
 * replay harness can step the same trace repeatedly and get identical results.
 */
export function onPosition(
  state: MatcherState,
  fix: Fix,
  orderedStops: OrderedStop[],
): { state: MatcherState; events: MatcherEvent[] } {
  const events: MatcherEvent[] = [];

  // --- unusable fix -----------------------------------------------------
  // Discarded rather than smoothed: a 300 m fix carries no information about
  // which of two adjacent stops we are at, and averaging it in would move a
  // good position toward a wrong one.
  if (fix.accuracy > ACCURACY_LIMIT_M) {
    const badFixes = state.badFixes + 1;
    const next = { ...state, badFixes };
    if (badFixes >= BAD_FIX_LIMIT && !state.degraded) {
      next.degraded = true;
      events.push({ type: "degraded", reason: "bad-accuracy" });
    }
    return { state: next, events };
  }

  let next: MatcherState = { ...state, badFixes: 0, lastGoodFixAt: fix.timestamp };

  // A usable fix after a degraded spell restores automatic counting, but the
  // manual button stays available — the user may have already used it.
  if (state.degraded) {
    next.degraded = false;
    events.push({ type: "recovered" });
  }

  // Once past the destination, counting forward cannot help. Freeze rather
  // than keep announcing stops the user does not care about.
  if (next.overshot) return { state: next, events };

  // --- forward-only candidate window ------------------------------------
  const from = next.currentIndex + 1;
  const candidates: { index: number; stop: OrderedStop; distance: number }[] = [];
  for (let i = from; i < Math.min(from + LOOKAHEAD, orderedStops.length); i++) {
    candidates.push({ index: i, stop: orderedStops[i], distance: haversine(fix, orderedStops[i]) });
  }
  if (candidates.length === 0) return { state: next, events };

  const nearest = candidates.reduce((a, b) => (b.distance < a.distance ? b : a));

  /**
   * On entry, commit to the EARLIEST candidate we are inside — not the nearest.
   *
   * A bus travels the sequence in order, so the first stop in the window whose
   * radius we are within is the one we are at. Picking the nearest instead
   * skips a stop whenever the following one happens to be marginally closer,
   * which is common where consecutive stops sit under ~250 m apart.
   */
  const entered = candidates.find((c) => c.distance < ENTER_M) ?? null;

  // --- enter ------------------------------------------------------------
  if (!next.insideStop && entered) {
    next = { ...next, insideStop: true, pendingIndex: entered.index, exitStreak: 0 };

    // ARRIVAL FIRES HERE, on entry. Not on departure — "get off now" is only
    // worth anything while the user is still at the door, and at a terminus the
    // bus never departs, so a departure-based rule would never announce it.
    if (entered.index === next.destIndex && !next.arrivedAnnounced) {
      next.arrivedAnnounced = true;
      events.push({ type: "arrived", index: entered.index, stop: entered.stop });
    }
  }

  // --- leave: where the INDEX advances ----------------------------------
  // Counting stays on departure, which is what makes the hysteresis work:
  // sitting at a light inside ENTER_M produces no event, and noise rattling
  // across ENTER_M cannot count the same stop twice. The exit must also be
  // sustained, so one stray sample cannot fake a departure.
  //
  // DISTANCE IS MEASURED TO THE PENDING STOP, not to whatever is nearest now.
  // 12 consecutive pairs in the city sit closer together than EXIT_M — as close
  // as 7 m. With those, `nearest` flips to the following stop while the bus is
  // still inside the current one, so an exit test against `nearest` never sees
  // the departure and silently skips a stop. Measuring against the stop we
  // actually committed to is what makes tight pairs count correctly.
  const pendingDistance =
    next.pendingIndex !== null ? haversine(fix, orderedStops[next.pendingIndex]) : nearest.distance;

  if (next.insideStop && pendingDistance > EXIT_M) {
    const streak = next.exitStreak + 1;
    next = { ...next, exitStreak: streak };

    if (streak >= EXIT_CONFIRM_FIXES) {
      const passedIndex = next.pendingIndex;
      next = { ...next, insideStop: false, pendingIndex: null, exitStreak: 0 };

      if (passedIndex !== null) {
        next.currentIndex = passedIndex;
        const stop = orderedStops[passedIndex];
        const remaining = next.destIndex - next.currentIndex;

        events.push({ type: "stop-passed", index: passedIndex, stop, remaining });

        if (remaining < 0) {
          next.overshot = true;
          events.push({ type: "overshoot", index: passedIndex, stop });
        }
      }
    }
  } else if (next.insideStop && pendingDistance <= EXIT_M) {
    // Back inside before the streak completed — it was jitter, not a departure.
    next = { ...next, exitStreak: 0 };
  }

  return { state: next, events };
}

/**
 * Whether the countdown has gone stale.
 *
 * Called on a timer, not on position updates — the whole failure mode is that
 * updates STOP ARRIVING. `watchPosition` goes quiet when the screen sleeps and
 * throws nothing, so nothing else would ever notice.
 */
export function checkGpsLoss(
  state: MatcherState,
  now: number,
): { state: MatcherState; events: MatcherEvent[] } {
  if (state.degraded || state.lastGoodFixAt === null) return { state, events: [] };
  if (now - state.lastGoodFixAt < GPS_LOSS_MS) return { state, events: [] };
  return {
    state: { ...state, degraded: true },
    events: [{ type: "degraded", reason: "gps-lost" }],
  };
}

/**
 * Manual advance, for when tracking is degraded.
 *
 * The same counting path as an automatic pass, so a manually advanced ride
 * announces exactly as an automatic one does.
 */
export function manualAdvance(
  state: MatcherState,
  orderedStops: OrderedStop[],
): { state: MatcherState; events: MatcherEvent[] } {
  if (state.overshot) return { state, events: [] };
  const index = state.currentIndex + 1;
  if (index >= orderedStops.length) return { state, events: [] };

  const next: MatcherState = { ...state, currentIndex: index, insideStop: false, pendingIndex: null, exitStreak: 0 };
  const stop = orderedStops[index];
  const remaining = next.destIndex - index;
  const events: MatcherEvent[] = [{ type: "stop-passed", index, stop, remaining }];

  if (remaining === 0 && !next.arrivedAnnounced) {
    next.arrivedAnnounced = true;
    events.push({ type: "arrived", index, stop });
  } else if (remaining < 0) {
    next.overshot = true;
    events.push({ type: "overshoot", index, stop });
  }
  return { state: next, events };
}
