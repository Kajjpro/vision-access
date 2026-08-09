/**
 * Synthetic GPS traces for driving the stop matcher in tests.
 *
 * A bus route is a sequence of stops, not a road geometry, so this interpolates
 * straight legs between consecutive stops at a configured speed and samples
 * along them. That understates the real distance slightly (roads bend) but it
 * is the pessimistic direction for the matcher: stops end up marginally closer
 * together than reality, so anything that passes here has margin on a real bus.
 *
 * Deterministic by default. A test that fails only on some seeds is a test that
 * will be quietly ignored, so noise comes from a seeded PRNG and any failure
 * reproduces exactly.
 */
import type { Fix, OrderedStop } from "./stop-matcher";

/** mulberry32 — small, fast, and good enough for jitter. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const M_PER_DEG_LAT = 111_320;
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

export type TraceOptions = {
  /** km/h along each leg. */
  speedKmh?: number;
  /** Metres of Gaussian noise (1σ) added to each sample. */
  noiseM?: number;
  /** Seconds between samples — watchPosition on a phone is roughly 1 Hz. */
  intervalSec?: number;
  /** Reported accuracy on good fixes. */
  accuracyM?: number;
  seed?: number;
  /** Windows where no usable fix is produced, in seconds from trace start. */
  dropouts?: { startSec: number; durationSec: number }[];
  /** Windows where fixes arrive but with unusable accuracy. */
  badAccuracyWindows?: { startSec: number; durationSec: number; accuracyM: number }[];
  /** Seconds spent stationary on arriving at each listed stop index. */
  dwellAtIndex?: Record<number, number>;
  startAtIndex?: number;
  startTime?: number;
};

/**
 * Samples along the stop sequence.
 *
 * Dropouts remove fixes entirely rather than marking them bad — that is what a
 * tunnel does, and it is the case `watchPosition` reports by simply going
 * silent, with no error and no callback.
 */
export function generateTrace(stops: OrderedStop[], options: TraceOptions = {}): Fix[] {
  const {
    speedKmh = 25,
    noiseM = 40,
    intervalSec = 1,
    accuracyM = 20,
    seed = 12345,
    dropouts = [],
    badAccuracyWindows = [],
    dwellAtIndex = {},
    startAtIndex = 0,
    startTime = 1_700_000_000_000,
  } = options;

  const rand = seededRandom(seed);
  // Box–Muller: real GPS error is roughly Gaussian, and uniform noise would
  // never produce the occasional large excursion that actually breaks matchers.
  const gauss = () => {
    const u = Math.max(rand(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  const speedMs = (speedKmh * 1000) / 3600;
  const fixes: Fix[] = [];
  let elapsed = 0;

  const emit = (lat: number, lon: number) => {
    const inDropout = dropouts.some((d) => elapsed >= d.startSec && elapsed < d.startSec + d.durationSec);
    if (inDropout) return;

    const bad = badAccuracyWindows.find((w) => elapsed >= w.startSec && elapsed < w.startSec + w.durationSec);
    fixes.push({
      lat: lat + (gauss() * noiseM) / M_PER_DEG_LAT,
      lon: lon + (gauss() * noiseM) / mPerDegLon(lat),
      accuracy: bad ? bad.accuracyM : accuracyM,
      timestamp: startTime + elapsed * 1000,
    });
  };

  for (let i = startAtIndex; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];

    // Dwell at the stop before setting off — traffic lights, boarding.
    const dwell = dwellAtIndex[i] ?? 0;
    for (let t = 0; t < dwell; t += intervalSec) {
      emit(a.lat, a.lon);
      elapsed += intervalSec;
    }

    const dLat = (b.lat - a.lat) * M_PER_DEG_LAT;
    const dLon = (b.lon - a.lon) * mPerDegLon(a.lat);
    const legM = Math.hypot(dLat, dLon);
    const legSec = Math.max(legM / speedMs, intervalSec);

    for (let t = 0; t < legSec; t += intervalSec) {
      const f = t / legSec;
      emit(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f);
      elapsed += intervalSec;
    }
  }

  // Settle at the terminus so the final stop gets its departure crossing.
  const last = stops[stops.length - 1];
  for (let t = 0; t < 30; t += intervalSec) {
    emit(last.lat, last.lon);
    elapsed += intervalSec;
  }

  return fixes;
}

/**
 * A trace that stops dead near a stop — congestion, or a long light.
 *
 * The phantom-advance case: the bus never leaves, so nothing may be counted,
 * however much the noise rattles across the enter radius.
 */
export function generateStationaryTrace(
  at: { lat: number; lon: number },
  seconds: number,
  options: TraceOptions = {},
): Fix[] {
  const { noiseM = 40, intervalSec = 1, accuracyM = 20, seed = 999, startTime = 1_700_000_000_000 } = options;
  const rand = seededRandom(seed);
  const gauss = () => {
    const u = Math.max(rand(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  const fixes: Fix[] = [];
  for (let t = 0; t < seconds; t += intervalSec) {
    fixes.push({
      lat: at.lat + (gauss() * noiseM) / M_PER_DEG_LAT,
      lon: at.lon + (gauss() * noiseM) / mPerDegLon(at.lat),
      accuracy: accuracyM,
      timestamp: startTime + t * 1000,
    });
  }
  return fixes;
}

/** Metres between consecutive stops — the spacing the thresholds have to live with. */
export function stopSpacing(stops: OrderedStop[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const dLat = (stops[i + 1].lat - stops[i].lat) * M_PER_DEG_LAT;
    const dLon = (stops[i + 1].lon - stops[i].lon) * mPerDegLon(stops[i].lat);
    out.push(Math.hypot(dLat, dLon));
  }
  return out;
}
