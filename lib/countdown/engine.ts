/**
 * Where along a route something is, and how sure we are.
 *
 * ONE ENGINE, TWO CONSUMERS. The only difference is whose position is fed in:
 *
 *   alighting  the rider's own GPS, counting down to their destination
 *   boarding   a vehicle's position, counting down to the rider's stop
 *
 * They are the same problem — a scalar walking forward along a chain of stops,
 * with a count derived from it — so they are the same code. Splitting them was
 * the tempting design and would have meant two hysteresis implementations, of
 * which one would be the tested one.
 *
 * Pure: no clock, no geolocation, no React, no audio. `now` and every fix are
 * parameters, which is what lets a whole journey replay from a recorded trace in
 * milliseconds, including the dropouts.
 *
 * ── WHAT THE HYSTERESIS IS FOR ─────────────────────────────────────────────
 *
 * A GPS fix near a stop boundary flaps. Un-damped, the index oscillates and
 * every oscillation is an announcement — "гурван буудал", "дөрвөн буудал",
 * "гурван буудал" — which is both maddening and, worse, teaches the rider that
 * the count is noise to be ignored. It is the single most common bug in this
 * class of feature, so the damping is threefold and each part is separately
 * testable:
 *
 *   ADVANCE THRESHOLD   the projection must be 40 m PAST the stop, not merely
 *                       nearest to it. Below that is ordinary fix noise.
 *   CONFIRMATION        two consecutive fixes must agree. One fix is a rumour.
 *   MONOTONIC           the index never decreases inside a trip. A bus does not
 *                       reverse; a fix that says otherwise is drift. The single
 *                       exception is a long stationary period, which is a
 *                       terminus turnaround and a genuinely new trip.
 *
 * On a loop variant the same stop id appears twice. **The index is the
 * identity.** Nothing here is ever keyed on a stop id.
 */

import type { LatLon, RouteGeometry } from "./geometry";

/**
 * How the position was arrived at. Drives the phrasing register, per CLAUDE.md.
 *
 * Ordered by how much we may claim: a rider steps toward live traffic on the
 * strength of these words, so the register is bound to the source rather than
 * chosen at the call site.
 */
export type PositionSource =
  /** Matched to route geometry from a fresh fix. */
  | "gps_matched"
  /** No position at all; derived from an arrival estimate. */
  | "eta_inferred"
  /** No fix; extrapolated from the last known index and elapsed time. */
  | "dead_reckoned"
  | "none";

export type Confidence = "high" | "medium" | "low" | "none";

export type Fix = {
  lat: number;
  lon: number;
  /** Metres. Fixes worse than this engine's limit are discarded, not smoothed. */
  accuracyM: number;
  /** Epoch ms, from the fix itself — never from the device clock at receipt. */
  timestamp: number;
};

// --------------------------------------------------------------- constants

/**
 * Below this a fix is usable. A cheap Android inside a metal bus routinely
 * exceeds it, which is why exceeding it means "ignore", never "smooth".
 */
export const ACCURACY_LIMIT_M = 100;

/** Metres past a stop before it counts as reached. See the header. */
export const ADVANCE_THRESHOLD_M = 40;

/** Consecutive agreeing fixes required to commit an advance. */
export const CONFIRMATION_FIXES = 2;

/**
 * Along-route metres before a stop at which the rider is AT it.
 *
 * ── WHY THIS IS NOT ADVANCE_THRESHOLD_M ────────────────────────────────────
 *
 * The engine answers two questions with opposite error costs, and one threshold
 * cannot serve both.
 *
 *   WHICH STOP HAVE WE COMPLETED?  Advancing early is expensive: a miscount
 *   cascades through every stop after it. That is what ADVANCE_THRESHOLD_M at
 *   40 m PAST, times two confirming fixes, is defending, and it is unchanged.
 *
 *   ARE WE AT THE DESTINATION NOW?  Announcing late is expensive, and it was
 *   measured: on route 11100730 the alight instruction landed 66 s after the
 *   get-ready and 47 s before the overshoot — i.e. after the doors had closed.
 *
 * So arrival gets its own threshold, measured BEFORE the stop rather than after
 * it. 70 m is `ENTER_M` from lib/transit/stop-matcher.ts, the one arrival radius
 * in this repository with empirical backing — 168 route/direction pairs — behind
 * it. It is along-route here rather than straight-line, per the CLAUDE.md rule
 * that every threshold is measured along the route and never perpendicular.
 */
export const ARRIVAL_RADIUS_M = 70;

/**
 * §6.1 WRONG DIRECTION, as a DISPLACEMENT rather than a sample count.
 *
 * The previous test asked "did two consecutive fixes look backwards", which is
 * a different question from "has this bus travelled backwards" — and the wrong
 * one, because noise oscillates while a reversing bus decreases monotonically.
 * Measured over 146 correct-direction journeys it fired in 142 of them, a
 * median of 7 times each, on buses following their route exactly. CLAUDE.md is
 * explicit that an alert which makes a rider leave a CORRECT bus is a real harm.
 *
 * Net backward displacement from the furthest point reached, scaled to the
 * route's own mean stop spacing so it travels between dense downtown spacing
 * and sparse suburban runs without retuning.
 *
 * Displacement alone is not enough, and the corpus says so: the worst backward
 * excursion on a correct-direction journey reaches 1.49 spacings at p99, from
 * single-fix projection jumps on routes that double back near themselves. Those
 * are transient — the next fix returns forward — whereas a reversing bus keeps
 * going. So the threshold is paired with a persistence requirement, which is
 * doing a different job from the old fix count: displacement discriminates,
 * persistence only rejects transients.
 *
 * Swept against both corpora — 146 correct-direction journeys and 146 where the
 * rider boarded a bus running the corridor in reverse:
 *
 *     K     P     false-fire     true-fire     median before firing
 *   0.30    3       8/146         146/146           235 m
 *   0.50    5       4/146         146/146           372 m
 *   0.75   10       2/146         146/146           548 m
 *   1.00   10       0/146         146/146           673 m
 *
 * A slower fix rate makes this MORE conservative, not less: a transient
 * excursion spans fewer fixes and is less likely to reach P, while a genuine
 * reversal is sustained indefinitely and always accumulates P eventually.
 */
export const WRONG_DIRECTION_SPACINGS = 1.0;
export const WRONG_DIRECTION_SUSTAIN_FIXES = 10;

/** EMA weight for a new speed sample, applied once per window. */
export const SPEED_SMOOTHING = 0.4;

/** Baseline for one speed sample. Long enough that fix noise is a small share. */
export const SPEED_WINDOW_MS = 30_000;

/** A stationary spell this long is a terminus turnaround, not drift. */
export const LAYOVER_MS = 120_000;

/** Movement under this between fixes is "stationary" for the layover test. */
export const STATIONARY_M = 25;

/** Past this, extrapolation error exceeds one stop interval. */
export const DEAD_RECKONING_LIMIT_MS = 180_000;

/** A fix older than this cannot support the assertive register. */
export const FRESH_MS = 30_000;

/** Past this the fix supports nothing at all. */
export const STALE_MS = 90_000;

/**
 * How far either side of our last position a fix is looked for.
 *
 * Only matters on loop variants, where the same ground carries two scalars —
 * but it has to be wide enough to absorb a dropout. At 60 km/h a bus covers a
 * kilometre a minute, so this holds through roughly a minute of silence before
 * the projection falls back to a whole-route sweep.
 */
export const PROJECTION_WINDOW_M = 1_500;

// ------------------------------------------------------------------- state

export type EngineState = {
  /** Committed index. Monotonic within a trip. */
  stopIndex: number;
  /** Scalar position along the variant, metres from the first stop. */
  alongM: number;
  source: PositionSource;
  confidence: Confidence;
  /** Timestamp of the last accepted fix; null before the first. */
  lastFixAt: number | null;
  /** Last accepted position, for the stationary test. */
  lastFixPos: LatLon | null;
  /** How long the position has been essentially unchanged. */
  stationarySinceMs: number | null;
  /** An advance is proposed but not yet confirmed. */
  pending: { index: number; fixes: number } | null;
  /**
   * Highest stop index the rider has been AT, entry-confirmed.
   *
   * DELIBERATELY NOT `stopIndex`. Committing the count on entry would make the
   * very next projection read as behind the committed index, which the
   * monotonic constraint below correctly interprets as travelling backwards —
   * so an early commit would manufacture `wrong-direction` events on a bus
   * tracking its route perfectly. CLAUDE.md is explicit that a spurious
   * wrong-bus alert, which makes a rider leave a CORRECT bus, is a real harm.
   *
   * So arrival is a second, monotonic signal that rides alongside the count and
   * never moves it. Only `remainingForAlighting` reads it.
   */
  reachedIndex: number | null;
  /** An arrival is proposed but not yet confirmed. Mirrors `pending`. */
  atPending: { index: number; fixes: number } | null;
  /**
   * Smoothed ground speed, m/s. Null until two fixes have been accepted.
   *
   * Exponentially smoothed because the instantaneous value is unusable: 25 m of
   * fix noise across a 1 s interval reads as 25 m/s, five times a bus's actual
   * speed. Only `secondsToDestination` consumes it, and only to decide whether
   * a preparation announcement has room to be useful — never to move the count,
   * which stays on confirmed fixes alone.
   */
  speedMps: number | null;
  /** Start of the current speed measurement window. */
  speedRef: { alongM: number; at: number } | null;
  /** Furthest point reached along the variant. Backward displacement is measured from here. */
  furthestAlongM: number;
  /** Consecutive fixes the backward-displacement threshold has held — §6.1. */
  backwardRun: number;
  /** Latched once wrong-direction has been reported. Reported once per trip. */
  wrongDirectionFired: boolean;
  /** Consecutive intervals the nearest stop was off this variant — §6.1 wrong-bus. */
  offRouteIntervals: number;
  /** Set once a confidence downgrade has been announced. Announced ONCE. */
  downgradeAnnounced: boolean;
};

export function createEngine(startIndex = 0, geometry?: RouteGeometry): EngineState {
  return {
    stopIndex: startIndex,
    alongM: geometry ? geometry.distanceToStop(startIndex) : 0,
    source: "none",
    confidence: "none",
    lastFixAt: null,
    lastFixPos: null,
    stationarySinceMs: null,
    pending: null,
    reachedIndex: null,
    atPending: null,
    speedMps: null,
    speedRef: null,
    furthestAlongM: geometry ? geometry.distanceToStop(startIndex) : 0,
    backwardRun: 0,
    wrongDirectionFired: false,
    offRouteIntervals: 0,
    downgradeAnnounced: false,
  };
}

export type EngineEvent =
  /** The committed index moved forward. The only event that changes a count. */
  | { type: "advanced"; from: number; to: number; alongM: number }
  /**
   * The rider is AT this stop, confirmed on entry. Does not move the count.
   *
   * Separate from `advanced` because the two answer different questions and
   * fire at different moments — see ARRIVAL_RADIUS_M.
   */
  | { type: "at-stop"; index: number }
  /** Confidence changed. Emitted on every change; the caller speaks only downgrades, once. */
  | { type: "confidence"; from: Confidence; to: Confidence; source: PositionSource }
  /** Index moved backwards for CONFIRMATION_FIXES intervals — §6.1. */
  | { type: "wrong-direction"; index: number }
  /** Nearest stop was off this variant for CONFIRMATION_FIXES intervals — §6.1. */
  | { type: "off-route"; index: number }
  /** A long stationary spell ended the trip's monotonic constraint. */
  | { type: "layover"; index: number }
  /** Fix rejected. Reported so the debug panel shows why the count is not moving. */
  | { type: "rejected"; reason: "accuracy" | "backwards" | "stale-timestamp" };

export type EngineResult = { state: EngineState; events: EngineEvent[] };

// --------------------------------------------------------------- confidence

/**
 * Source plus staleness → what we may claim. The table in CLAUDE.md, as code.
 *
 * Exported so the phrasing contract is asserted against this function rather
 * than against a comment that drifted from it.
 */
export function confidenceFor(source: PositionSource, ageMs: number): Confidence {
  if (source === "none") return "none";
  if (source === "eta_inferred") return "medium";
  if (source === "dead_reckoned") return ageMs <= DEAD_RECKONING_LIMIT_MS ? "low" : "none";
  // gps_matched
  if (ageMs <= FRESH_MS) return "high";
  if (ageMs <= STALE_MS) return "medium";
  return "none";
}

const RANK: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 };

/** True when `to` is worse than `from` — the only direction that is announced. */
export function isDowngrade(from: Confidence, to: Confidence): boolean {
  return RANK[to] < RANK[from];
}

// ------------------------------------------------------------------ update

/**
 * Feed one GPS fix.
 *
 * Returns a NEW state plus everything that changed. Never mutates: the caller
 * keeps the previous state, which is what makes "what did this fix actually
 * do" answerable in a test and on the debug panel.
 */
export function onFix(
  state: EngineState,
  fix: Fix,
  geometry: RouteGeometry,
  now: number,
  /**
   * Whether the globally nearest stop belongs to THIS variant.
   *
   * Supplied by the caller because answering it needs all 923 stops, and this
   * module stays pure. Omit it and the wrong-bus detector simply never fires —
   * which is the correct degradation, since a detector with no evidence must
   * not guess.
   *
   * This is the §6.1 wrong-BUS test. It is topological for the same reason the
   * wrong-DIRECTION test is: chords put a correct bus up to 546 m off its own
   * route on an ordinary bend, so any perpendicular threshold fires constantly.
   */
  nearestStopIsOnVariant?: boolean,
): EngineResult {
  const events: EngineEvent[] = [];

  // A fix stamped in the future, or before the one we already have, is a device
  // clock problem. Relative deltas are trusted; absolute device time is not.
  if (state.lastFixAt !== null && fix.timestamp < state.lastFixAt) {
    return { state, events: [{ type: "rejected", reason: "stale-timestamp" }] };
  }

  // Discarded, never smoothed. A 300 m fix averaged with a 20 m one produces a
  // confident-looking number that is wrong, which is the worst of both.
  if (!Number.isFinite(fix.accuracyM) || fix.accuracyM > ACCURACY_LIMIT_M) {
    return { state, events: [{ type: "rejected", reason: "accuracy" }] };
  }

  /**
   * Always hinted, including on the first fix.
   *
   * There is no point in a journey where we do not know roughly where we are:
   * `createEngine` is seeded from the boarding index the wait screen already
   * chose. Hinting from the start is what keeps the two passes of a loop variant
   * apart from the very first fix rather than from the second.
   */
  const projection = geometry.project(fix, {
    nearAlongM: state.alongM,
    windowM: PROJECTION_WINDOW_M,
  });
  const next: EngineState = { ...state };

  // --- stationary / layover ------------------------------------------------
  const movedM = state.lastFixPos
    ? Math.hypot(
        (fix.lat - state.lastFixPos.lat) * 111_132,
        (fix.lon - state.lastFixPos.lon) * 111_320 * Math.cos((fix.lat * Math.PI) / 180),
      )
    : Infinity;
  const gapMs = state.lastFixAt === null ? 0 : fix.timestamp - state.lastFixAt;

  /**
   * `stoodStillForMs` is the spell BEFORE this fix, not after it.
   *
   * The layover test below asks "had it been parked long enough when it moved",
   * and the fix that proves the turnaround is by definition the one that moved.
   * Reading the post-move value asked whether it was parked while departing,
   * which is never true, so no turnaround was ever recognised.
   */
  const stoodStillForMs = state.stationarySinceMs ?? 0;

  if (movedM < STATIONARY_M) {
    next.stationarySinceMs = stoodStillForMs + gapMs;
  } else {
    next.stationarySinceMs = 0;
  }

  /**
   * Speed, measured over a WINDOW rather than between consecutive fixes.
   *
   * Two earlier attempts were both biased upward, and instructively so. Using
   * straight-line `movedM` averages a magnitude, and |7 m of travel + 25 m of
   * noise| averages far above 7 m. Using the signed along-route delta but
   * discarding reversals keeps only the upper half of a symmetric distribution,
   * which is the same bias wearing a different hat: it read 31 m/s against a
   * true 6.94 m/s and suppressed 127 of 292 preparation cues.
   *
   * A 30 s baseline fixes it by arithmetic rather than by filtering. The bus
   * covers ~200 m in that time against ~25 m of endpoint noise, so the estimate
   * is good to roughly a tenth without discarding any sample.
   */
  if (state.speedRef === null) {
    next.speedRef = { alongM: projection.alongM, at: fix.timestamp };
  } else {
    const dtMs = fix.timestamp - state.speedRef.at;
    if (dtMs >= SPEED_WINDOW_MS) {
      const sample = (projection.alongM - state.speedRef.alongM) / (dtMs / 1000);
      if (sample >= 0) {
        next.speedMps = state.speedMps === null
          ? sample
          : state.speedMps * (1 - SPEED_SMOOTHING) + sample * SPEED_SMOOTHING;
      }
      next.speedRef = { alongM: projection.alongM, at: fix.timestamp };
    }
  }

  next.lastFixAt = fix.timestamp;
  next.lastFixPos = { lat: fix.lat, lon: fix.lon };
  next.source = "gps_matched";
  /**
   * The scalar moves only where the fix is BELIEVED.
   *
   * Set per branch below rather than here. A fix rejected as drift must not drag
   * `alongM` with it, because `alongM` is what the next projection is hinted
   * with — and a hint chasing the drift walks the search window off the route
   * one rejected fix at a time.
   */

  // --- the monotonic constraint -------------------------------------------
  const proposed = projection.stopIndex;

  if (proposed < state.stopIndex) {
    /**
     * A LAYOVER IS THE ONE LEGITIMATE WAY BACK.
     *
     * A bus sitting at a terminus for two minutes and then reading as index 0
     * is starting a new trip, not reversing. Everything else that reads
     * backwards is drift, and accepting it would un-count a stop the rider has
     * already been told they passed.
     */
    if (stoodStillForMs >= LAYOVER_MS) {
      events.push({ type: "layover", index: proposed });
      next.stopIndex = proposed;
      next.alongM = projection.alongM;
      next.pending = null;
      next.stationarySinceMs = 0;
      // A turnaround is a NEW trip: whatever was reached belongs to the last
      // one, and carrying it over would hold a stale arrival across the reset.
      next.reachedIndex = null;
      next.atPending = null;
      next.furthestAlongM = projection.alongM;
      next.backwardRun = 0;
      next.wrongDirectionFired = false;
    } else {
      next.pending = null;
      // The fix is still rejected for COUNTING — the index is monotonic. Whether
      // it means the bus is reversing is a displacement question, answered below.
      events.push({ type: "rejected", reason: "backwards" });
    }
  } else {
    next.alongM = projection.alongM;

    if (proposed > state.stopIndex) {
      /**
       * The 40 m gate, measured ALONG the route.
       *
       * `project` returns the last stop reached, so `proposed > current` already
       * means we are past that stop — but "past" by a metre is fix noise. The
       * distance beyond the proposed stop has to clear the threshold before the
       * advance is even a candidate.
       */
      const pastM = projection.alongM - geometry.distanceToStop(proposed);

      /**
       * THE TERMINUS HAS NO "PAST".
       *
       * The gate asks for 40 m beyond the stop as proof we genuinely passed it
       * rather than being noisily near it. At the last stop of a variant there
       * is nowhere further to go, so that proof can never arrive — and a rider
       * travelling to the end of the line, which is most of a commute, was
       * never told they had got there. The count stopped one short and went
       * quiet, which reads as "not yet" to someone who cannot see it.
       *
       * At the terminus the equivalent proof is being AT it, within the same
       * threshold. The two-fix confirmation still applies, so a single drifted
       * fix cannot end the journey early.
       */
      const isTerminus = proposed >= geometry.stopCount - 1;
      const reached = isTerminus
        ? pastM >= -ADVANCE_THRESHOLD_M
        : pastM >= ADVANCE_THRESHOLD_M;

      if (reached) {
        const fixes = state.pending?.index === proposed ? state.pending.fixes + 1 : 1;
        if (fixes >= CONFIRMATION_FIXES) {
          events.push({ type: "advanced", from: state.stopIndex, to: proposed, alongM: projection.alongM });
          next.stopIndex = proposed;
          next.pending = null;
        } else {
          // One fix is a rumour. Held until a second agrees.
          next.pending = { index: proposed, fixes };
        }
      } else {
        next.pending = null;
      }
    } else {
      next.pending = null;
    }
  }

  // --- arrival: entry-confirmed, and it never moves the count ---------------
  /**
   * Which stop we are AT, if any — the nearer of the one just passed and the one
   * being approached, each tested against ARRIVAL_RADIUS_M along the route.
   *
   * Both are checked because the advance rule holds the committed index back for
   * 40 m after a stop: during that window the projection has passed stop k while
   * `stopIndex` still reads k-1, and looking only ahead would skip k entirely.
   */
  const passedIndex = projection.stopIndex;
  const nextIndex = passedIndex + 1;
  const passedM = projection.alongM - geometry.distanceToStop(passedIndex);

  const nearStops: { index: number; distanceM: number }[] = [];
  if (passedM >= 0 && passedM <= ARRIVAL_RADIUS_M) {
    nearStops.push({ index: passedIndex, distanceM: passedM });
  }
  if (nextIndex < geometry.stopCount && projection.toNextStopM <= ARRIVAL_RADIUS_M) {
    nearStops.push({ index: nextIndex, distanceM: projection.toNextStopM });
  }
  const atCandidate = nearStops.length
    ? nearStops.reduce((a, b) => (b.distanceM < a.distanceM ? b : a)).index
    : null;

  const alreadyReached = next.reachedIndex !== null && atCandidate !== null
    && atCandidate <= next.reachedIndex;

  /**
   * THE CANDIDATE MUST BE ADJACENT TO THE COUNT. This is `LOOKAHEAD` from
   * lib/transit/stop-matcher.ts, and it is not optional.
   *
   * The projection is hinted over a 1500 m window, and several UB routes double
   * back inside it: on 14100129 dir 1, stops 17 and 19 carry the same name on
   * opposite sides of a road, 130 m apart on the ground and 643 m apart along
   * the route. Two consecutive noisy fixes there project onto the far segment,
   * and without this guard the latch confirmed arrival at stop 19 while the bus
   * was at 16 — "Одоо буугаарай", 101 s early, at the wrong stop, and latched
   * permanently because a latch is never withdrawn.
   *
   * `stopIndex` is the last stop confirmed passed by 40 m, so the rider is
   * either still beside it or approaching the next one. There is no third
   * option, and a candidate further ahead is a projection excursion rather than
   * a bus. Measured across all 155 route/direction pairs, this guard removes
   * every early-arrival outlier without delaying a single correct one.
   */
  const beyondLookahead = atCandidate !== null && atCandidate > next.stopIndex + 1;

  if (atCandidate === null || atCandidate < next.stopIndex || alreadyReached || beyondLookahead) {
    // Nothing in range, behind the count, or already latched. A latch is never
    // withdrawn — see `remainingForAlighting`.
    next.atPending = null;
  } else {
    // The same two-fix confirmation the advance uses. One fix is a rumour, and
    // this one ends with "get off now".
    const fixes = state.atPending?.index === atCandidate ? state.atPending.fixes + 1 : 1;
    if (fixes >= CONFIRMATION_FIXES) {
      next.reachedIndex = atCandidate;
      next.atPending = null;
      events.push({ type: "at-stop", index: atCandidate });
    } else {
      next.atPending = { index: atCandidate, fixes };
    }
  }

  // --- §6.1 wrong direction, by displacement -------------------------------
  next.furthestAlongM = Math.max(state.furthestAlongM, projection.alongM);
  const backwardM = next.furthestAlongM - projection.alongM;
  const backwardThresholdM = WRONG_DIRECTION_SPACINGS * geometry.meanStopSpacingM;

  next.backwardRun = backwardM >= backwardThresholdM ? state.backwardRun + 1 : 0;

  if (next.backwardRun >= WRONG_DIRECTION_SUSTAIN_FIXES && !state.wrongDirectionFired) {
    next.wrongDirectionFired = true;
    events.push({ type: "wrong-direction", index: state.stopIndex });
  }

  // --- §6.1 wrong bus ------------------------------------------------------
  if (nearestStopIsOnVariant === false) {
    next.offRouteIntervals = state.offRouteIntervals + 1;
    if (next.offRouteIntervals >= CONFIRMATION_FIXES) {
      events.push({ type: "off-route", index: state.stopIndex });
    }
  } else if (nearestStopIsOnVariant === true) {
    next.offRouteIntervals = 0;
  }

  // --- confidence ----------------------------------------------------------
  const confidence = confidenceFor("gps_matched", now - fix.timestamp);
  if (confidence !== state.confidence) {
    events.push({ type: "confidence", from: state.confidence, to: confidence, source: "gps_matched" });
    if (!isDowngrade(state.confidence, confidence)) next.downgradeAnnounced = false;
  }
  next.confidence = confidence;

  return { state: next, events };
}

/**
 * Time passing with no fix.
 *
 * Called on a timer by the host. Degrades the register rather than freezing it:
 * to someone who cannot see the counter, an unchanging count is indistinguishable
 * from a working one right up until they have ridden past their stop, so the
 * loss of confidence has to become audible.
 *
 * Does NOT advance the index. Dead reckoning is reported as a state, not used to
 * invent stops — a wrongly reckoned advance is exactly the announcement that
 * puts someone off a bus in the wrong district.
 */
export function onTick(state: EngineState, now: number): EngineResult {
  if (state.lastFixAt === null) return { state, events: [] };

  const ageMs = now - state.lastFixAt;
  const source: PositionSource =
    ageMs <= STALE_MS ? "gps_matched"
    : ageMs <= DEAD_RECKONING_LIMIT_MS ? "dead_reckoned"
    : "none";

  const confidence = confidenceFor(source, ageMs);
  if (confidence === state.confidence && source === state.source) return { state, events: [] };

  return {
    state: { ...state, source, confidence },
    events: [{ type: "confidence", from: state.confidence, to: confidence, source }],
  };
}

/**
 * How many stops remain to `destinationIndex`. Negative means overshot.
 *
 * The only place a count is derived, so "remaining" means the same thing to
 * both ladders and to the status query.
 */
export function remainingTo(state: EngineState, destinationIndex: number): number {
  return destinationIndex - state.stopIndex;
}

/**
 * Manual advance — the rider's escape hatch when tracking is wrong.
 *
 * CLAMPED AT THE DESTINATION, and that is the whole point. A count two stops
 * ahead of reality fires "Одоо буугаарай" 251 s early, measured, and two
 * spurious presses reproduce it exactly. Manual input must never be able to
 * send someone out of a door on its own evidence, so it may advance the count
 * TOWARD the destination but never to it or past it.
 *
 * Returns `clamped` so the caller can answer rather than swallow the press: a
 * rider pressing a button that does nothing has no way to tell a clamp from a
 * frozen app.
 */
export function advanceManually(
  state: EngineState,
  destinationIndex: number,
): { state: EngineState; clamped: boolean } {
  const proposed = state.stopIndex + 1;
  if (proposed >= destinationIndex) return { state, clamped: true };
  return {
    state: { ...state, stopIndex: proposed, pending: null, atPending: null },
    clamped: false,
  };
}

/**
 * Stops remaining, as the ALIGHTING ladder must see them.
 *
 * Identical to `remainingTo` everywhere except at the destination itself, where
 * the count alone answers too late: `stopIndex` reaches the destination only
 * once the bus is 40 m past it, so a rung-0 "Одоо буугаарай" derived from the
 * count arrives after the doors have shut. Once the destination has been
 * REACHED — entry-confirmed, see ARRIVAL_RADIUS_M — the answer is zero, and the
 * bus departing cannot take it back.
 *
 * `Math.min` rather than a plain 0 is what makes overshoot still work: after the
 * bus passes the stop the count keeps falling and this stops clamping, so -1
 * reaches the ladder exactly as before.
 *
 * The result is monotonically non-increasing, which the replay harness asserts:
 * `stopIndex` only rises, `reachedIndex` only rises, so `counted` only falls and
 * clamping a falling series leaves it falling.
 *
 * ── WHY RUNG 1 IS CLAMPED TOO ──────────────────────────────────────────────
 *
 * Moving rung 0 earlier pulls it toward rung 1, which still fired 40 m PAST the
 * preceding stop — so where the last two stops sit close together, "get ready"
 * and "get off now" collapsed into each other and the rider lost the warning
 * they stand up on. Measured over 310 simulated journeys: 5 had under 15 s
 * between them and 1 lost "get ready" entirely.
 *
 * Clamping rung 1 on entry to the preceding stop restores the interval, and it
 * is the more honest moment anyway: "дараагийн буудал" is worth most while the
 * bus is standing at the stop before, not 40 m after it pulled away. The same
 * 310 journeys then show 0 rungs skipped at any level, 0 duplicates, and a p05
 * interval of 37 s.
 *
 * Rungs 3 and 2 are deliberately NOT clamped. They are situational awareness
 * rather than instructions, nothing is lost by their arriving on the count, and
 * clamping every rung would shift the whole ladder a stop earlier — which is a
 * different change from the one this function exists to make.
 */
/**
 * Seconds until the destination's arrival point, or null if unknowable.
 *
 * Answers one question for the ladder: is there room for a preparation
 * announcement before the action announcement? It is deliberately NOT derived
 * from stop spacing. Measured across 310 journeys, spacing does not predict the
 * interval — a 180 m final pair produced a 1 s gap while a 41 m pair produced
 * 14 s, because what matters is where the approach was confirmed, not how far
 * apart the stops are.
 *
 * Never used to move the count or to phrase a position. A speed estimate is not
 * evidence of where the bus is.
 */
export function secondsToDestination(
  state: EngineState,
  geometry: RouteGeometry,
  destinationIndex: number,
): number | null {
  if (state.speedMps === null || state.speedMps <= 0.5) return null;
  const target = geometry.distanceToStop(destinationIndex) - ARRIVAL_RADIUS_M;
  const remainingM = target - state.alongM;
  if (remainingM <= 0) return 0;
  return remainingM / state.speedMps;
}

export function remainingForAlighting(state: EngineState, destinationIndex: number): number {
  const counted = destinationIndex - state.stopIndex;
  if (state.reachedIndex !== null && state.reachedIndex >= destinationIndex) {
    return Math.min(counted, 0);
  }
  if (state.reachedIndex !== null && state.reachedIndex >= destinationIndex - 1) {
    return Math.min(counted, 1);
  }
  return counted;
}

/**
 * Reckoned index if we had to guess — for DIAGNOSTICS and the status query.
 *
 * Never fed back into `stopIndex`. Exposed so the status query can say "probably
 * around here" in the low-confidence register instead of going silent, which is
 * the one thing it must not do.
 */
export function deadReckonedIndex(
  state: EngineState,
  geometry: RouteGeometry,
  now: number,
  meanSpeedMps = 5.5,
): number | null {
  if (state.lastFixAt === null) return null;
  const ageMs = now - state.lastFixAt;
  if (ageMs > DEAD_RECKONING_LIMIT_MS) return null;
  const spacing = geometry.meanStopSpacingM;
  if (spacing <= 0) return null;
  const advancedStops = Math.floor((meanSpeedMps * (ageMs / 1000)) / spacing);
  return Math.min(geometry.stopCount - 1, state.stopIndex + advancedStops);
}
