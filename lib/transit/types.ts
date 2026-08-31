/**
 * Types for the baked transit data and the OTP proxy.
 *
 * Derived from real samples in probe-output/, not from what a transit API
 * usually looks like. Where a field name is surprising it is because the feed
 * is surprising — see the comments.
 */

/** public/transit/stops.json — 923 served stops, names already normalized. */
export type Stop = {
  id: string;
  /** Display form, e.g. `Сансар /Хойд/`. Never sent to TTS — see toSpeechText. */
  name: string;
  lat: number;
  lon: number;
};

/** public/transit/routes.json */
export type Route = {
  id: string;
  /** On-screen, matches signage: `Ч:39`, `М:4`. Cyrillic М (U+041C), not Latin. */
  displayName: string;
  /**
   * The Mongolian a person actually says — `Ч:35` is spoken "чэ гучин тав".
   *
   * All 84 are filled from data/route-names.json and asserted non-null by
   * lib/transit/announce.test.ts. The type stays nullable because the build
   * can emit null under `--allow-missing-spoken`, which is explicitly NOT
   * shippable; nothing at runtime should ever see one.
   */
  spokenName: string | null;
  longName: string | null;
  directions: { id: number; headsign: string }[];
};

/** public/transit/route-stops.json — order is load-bearing. */
export type RouteStops = Record<string, Record<string, string[]>>;

/** public/transit/stop-routes.json */
export type StopRoutes = Record<string, string[]>;

export type TransitMeta = {
  generatedAt: string;
  stopCount: number;
  routeCount: number;
  droppedStopCount: number;
  sourceCommit: string | null;
};

/** public/audio/transit/manifest.json */
export type AudioManifestEntry = {
  path: string;
  /** iOS-safe AAC twin — Safari cannot be relied on to decode Ogg Opus. */
  pathAac?: string;
  durationMs: number;
  sha: string;
  provider?: string;
  voice?: string;
  bitrate?: string;
};
export type AudioManifest = Record<string, AudioManifestEntry>;

// --------------------------------------------------------------------- OTP

/**
 * A transit leg from OTP `plan`. Field names verified against
 * probe-output/04-otp-plan.full.json.
 *
 * `realTime` is false on every leg the feed has ever returned, so `startTime`
 * is a scheduled time, never a live prediction.
 */
export type OtpLeg = {
  startTime: number;
  endTime: number;
  realTime: boolean;
  /** Seconds between departures. 0 when the trip is not frequency-based. */
  headway: number;
  isNonExactFrequency: boolean;
  mode: string;
  transitLeg: boolean;
  /** `1:11100390` — the Hamuga routeId behind a feed prefix. */
  routeId?: string;
  routeShortName?: string;
  routeLongName?: string;
  headsign?: string;
  tripId?: string;
  /** `YYYY-MM-DD` in agency time. */
  serviceDate?: string;
  from: OtpPlace;
  to: OtpPlace;
  /** Absent unless showIntermediateStops=true is passed. */
  intermediateStops?: OtpPlace[];
};

export type OtpPlace = {
  name: string;
  /** `1:000000288` — strip the prefix to join to Stop.id. */
  stopId?: string;
  lat: number;
  lon: number;
  arrival?: number;
  departure?: number;
  stopIndex?: number;
  stopSequence?: number;
  vertexType?: string;
};

export type OtpPlanResponse = {
  requestParameters?: Record<string, string>;
  plan?: { date: number; itineraries: { legs: OtpLeg[] }[] };
  error?: { id?: number; msg?: string };
};

/** OTP prefixes every id with the feed id. Verified 10/10 stops, 6/6 routes. */
export const stripFeedPrefix = (id: string | undefined): string | null =>
  id ? id.split(":").pop() ?? null : null;

// ------------------------------------------------------------- our API

/**
 * One predicted arrival.
 *
 * `isEstimate` is always true today: `/api/bus/v1/realtime` carries no vehicle
 * feed and OTP reports realTime false on every leg. The field exists so the
 * announcement layer has something to branch on IF a live feed ever appears —
 * it is not a flag call sites may set to skip the hedge.
 */
export type Arrival = {
  routeId: string;
  routeDisplayName: string;
  /**
   * THE ARRIVAL INSTANT, epoch ms. The only field a countdown may be built from.
   *
   * `minutes` below is a countdown frozen at the moment this object was built,
   * and it was wrong three ways at once: the proxy caches responses for 45 s,
   * the wait screen held one fetch in state for as long as a rider browsed, and
   * nothing expired it once the bus had gone. An absolute time cannot go stale
   * in any of those ways — see `countdownFor` in lib/transit/eta.ts, which is
   * the only place a spoken minute is now derived.
   *
   * Null when the source could not supply one.
   */
  arrivesAt: number | null;
  /**
   * Minutes from now AT THE MOMENT THIS WAS BUILT. Debug and logging only.
   *
   * Never speak this and never render it. Read `countdownFor(arrival, now)`.
   */
  minutes: number;
  headsign: string | null;
  isEstimate: boolean;
  /** Where the number came from, for the debug panel and the spoken degradation notice. */
  source: "schedule" | "headway" | "realtime";
};

export type NextArrivalsResponse = {
  stopId: string;
  arrivals: Arrival[];
  /** Set when the proxy is serving fallbacks rather than live OTP data. */
  degraded: DegradedReason | null;
  generatedAt: string;
};

export type DegradedReason =
  | "rate-limited"
  | "upstream-error"
  | "offline"
  | "no-service"
  | "timeout";
