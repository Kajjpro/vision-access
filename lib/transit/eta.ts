/**
 * Turning an arrival time into something it is honest to say out loud, NOW.
 *
 * ── WHY A COUNTDOWN CANNOT BE A STORED NUMBER ──────────────────────────────
 *
 * `Arrival.minutes` was computed on the server and shipped as a number. Three
 * separate things then made it wrong, and all three were invisible:
 *
 *   1. The arrivals proxy caches for 45 s, so a cached response replays a
 *      countdown that was true up to 45 s ago.
 *   2. The wait screen fetched once and held the result in state. A rider
 *      cycling four route options by ear, each one spoken in full, is on that
 *      screen for minutes — and heard the same "5 минутын дараа" throughout.
 *   3. Nothing expired it. Once `startTime` had passed, the stored number was
 *      still positive, so the app went on promising a bus that had gone.
 *
 * A sighted passenger glances at a countdown board and sees it tick. Someone
 * relying on this voice has no such check: the number they are told IS the
 * world. So the stored value is now the ABSOLUTE arrival instant, and every
 * countdown is derived from it against the current clock, at the moment of
 * speaking. There is no way to hold a stale minute count, because there is no
 * minute count to hold.
 *
 * ── AND WHY THE WAIT SCREEN NOW TICKS ──────────────────────────────────────
 *
 * Deriving on demand fixes correctness. It also makes something new possible
 * that a frozen number could not: the wait itself can be narrated. See
 * `crossedAlert` and `waitVibration` below — the countdown re-announces at the
 * few moments that change what a person does, and vibrates the same ladder so
 * the phone can stay in a pocket in a Ulaanbaatar winter.
 *
 * Pure. No clock of its own, no clips, no React — `now` is always a parameter,
 * which is what lets every boundary below be tested rather than waited for.
 */
import type { Arrival } from "./types";

/**
 * How late an arrival may be and still be called "due now" rather than gone.
 *
 * Schedule-derived times are routinely a minute out in either direction, and a
 * bus 40 seconds past its slot is the one pulling in, not one that has left.
 * Declaring it gone would send a rider away from a bus they could have caught;
 * that is a worse error than a slightly generous "due".
 */
export const DUE_GRACE_MS = 90_000;

/**
 * How old the fetched payload may be before its times stop being repeated.
 *
 * About the AGE OF THE OBSERVATION, not the distance to the bus. The proxy
 * caches for 45 s and a backgrounded phone can sleep for far longer; a screen
 * resumed after twenty minutes must re-fetch rather than narrate a countdown
 * derived from a plan that has since been superseded. Saying nothing is the
 * correct output — see CLAUDE.md.
 */
export const STALE_AFTER_MS = 10 * 60_000;

/** True when a `generatedAt` timestamp is too old to speak times from. */
export function isStale(generatedAt: string | number | null | undefined, now: number): boolean {
  if (generatedAt === null || generatedAt === undefined) return true;
  const at = typeof generatedAt === "number" ? generatedAt : Date.parse(generatedAt);
  if (!Number.isFinite(at)) return true;
  return now - at > STALE_AFTER_MS;
}

/**
 * Cardinal clips exist for 1..40; past that there is no number to speak.
 *
 * The ceiling for ANY spoken count — minutes here, stops elsewhere — because it
 * is a fact about which `num_N` clips were rendered, not about what is being
 * counted. Re-exported from announce.ts, where callers historically found it.
 */
export const MAX_SPOKEN_NUMBER = 40;

export type Countdown =
  /** Speakable: `minutes` is 1..MAX_SPOKEN_NUMBER. */
  | { kind: "minutes"; minutes: number }
  /** Inside the grace window either side of the arrival instant. */
  | { kind: "due" }
  /** It has been and gone. Never spoken as a positive number. */
  | { kind: "gone" }
  /**
   * No usable absolute time, or one too far out to have a clip.
   *
   * Deliberately distinct from `gone`: this is "we cannot say", which the
   * caller renders as the route name alone rather than as a claim about time.
   */
  | { kind: "unknown" };

/**
 * The countdown for an arrival at a given instant.
 *
 * `arrivesAt` is the only input trusted. A legacy `minutes` field is ignored
 * outright rather than used as a fallback: a fallback is exactly how a stale
 * number survives a refactor that was meant to remove it.
 */
export function countdownFor(arrival: Arrival, now: number): Countdown {
  const at = arrival.arrivesAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return { kind: "unknown" };

  const deltaMs = at - now;
  if (deltaMs < -DUE_GRACE_MS) return { kind: "gone" };
  if (deltaMs < 30_000) return { kind: "due" };

  // Round to nearest, but never down to zero — a bus 40 s out is "1 minute",
  // not "0 minutes", and "due" is a separate state reached above.
  const minutes = Math.max(1, Math.round(deltaMs / 60_000));
  if (minutes > MAX_SPOKEN_NUMBER) return { kind: "unknown" };
  return { kind: "minutes", minutes };
}

/** Sortable rank: soonest first, unknowable last. Ties keep their input order. */
export function countdownRank(c: Countdown): number {
  switch (c.kind) {
    case "due": return 0;
    case "minutes": return c.minutes;
    // Ranked behind every real number rather than dropped, so an option with no
    // estimate is still offered — it may be the only bus that goes there.
    case "unknown": return Number.MAX_SAFE_INTEGER - 1;
    case "gone": return Number.MAX_SAFE_INTEGER;
  }
}

// ------------------------------------------------------------ the ladder

/**
 * The minute marks worth interrupting someone for.
 *
 * Not a countdown every ten seconds. A person standing in the cold wants to
 * know when something CHANGES about what they should do, and there are only
 * four such moments: enough time to still be walking, time to be at the kerb,
 * time to have your card out, and now.
 *
 * Descending, and read as "the largest mark still ahead of us".
 */
export const ALERT_MINUTES = [10, 5, 3, 1] as const;

/**
 * Which mark, if any, this tick has just crossed.
 *
 * Returns the mark to announce, or null. Crossing is evaluated against the
 * PREVIOUS countdown rather than against wall-clock timers, so a screen that
 * was backgrounded, a fix that arrived late, or a poll that skipped a minute
 * all announce the mark once on the next tick instead of missing it entirely.
 *
 * Never fires on the first observation: arriving at the stop to be told "5
 * minutes" is the initial announcement's job, not the ladder's, and firing both
 * would say it twice.
 */
export function crossedAlert(previous: Countdown | null, current: Countdown): number | null {
  if (!previous) return null;
  if (current.kind !== "minutes") return null;
  if (previous.kind !== "minutes") return null;
  if (current.minutes >= previous.minutes) return null;

  for (const mark of ALERT_MINUTES) {
    if (previous.minutes > mark && current.minutes <= mark) return mark;
  }
  return null;
}

/** True when this tick is the moment the bus became due. Announced once. */
export function becameDue(previous: Countdown | null, current: Countdown): boolean {
  return current.kind === "due" && previous?.kind !== "due";
}

/**
 * Vibration for a countdown mark, in `navigator.vibrate` format.
 *
 * IN THE SAME MODULE AS THE SPEECH, deliberately — `vibrationFor` in
 * announce.ts exists for the same reason. A haptic ladder defined somewhere
 * else drifts out of step with the spoken one, and then the phone in a pocket
 * says something different from the phone at an ear.
 *
 * The patterns get shorter and more insistent as the bus closes, so the meaning
 * survives being felt through a coat sleeve rather than read. This is the one
 * channel that works with the phone away, in traffic noise, with gloves on —
 * which describes most of a Ulaanbaatar winter at a bus stop.
 */
export function waitVibration(mark: number): number[] | null {
  if (mark >= 10) return [40];                       // a nudge, no urgency
  if (mark >= 5) return [60, 80, 60];                // be at the kerb
  if (mark >= 3) return [80, 60, 80, 60, 80];        // card out
  if (mark >= 1) return [200, 80, 200];              // now
  return null;
}

/** The bus is due: the heaviest pattern in the app after the ride-side arrival. */
export const DUE_VIBRATION = [400, 120, 400] as number[];

// ------------------------------------------------------------ speech keys

/**
 * The clip sequence for a countdown. THE HEDGE IS BUILT IN.
 *
 * Same rule as `announceArrival` in announce.ts and for the same reason: every
 * number this app can produce about a bus is schedule-derived, and there is no
 * input for which an unhedged time is correct. The prefix is added here so no
 * caller assembles a time without it.
 *
 * Returns an empty array when there is nothing honest to say, which callers
 * splice in as silence rather than substituting a guess.
 */
export function countdownKeys(c: Countdown, hasClip: (key: string) => boolean): string[] {
  /**
   * "Due" borrows the one-minute wording rather than a word of its own.
   *
   * The natural phrases for it — "ирлээ", "ойртож байна" — are the LIVE arrival
   * vocabulary, gated in lib/transit/journey.ts on a vehicle we watched move.
   * Schedule data may never borrow them: those two strings are what make a
   * blind rider step toward a road, and they have to keep meaning "a bus is
   * verifiably there". "Ойролцоогоор нэг минутын дараа" is inside the hedge's
   * honesty for anything within the ±90 s grace, and it cannot be mistaken for
   * the live phrasing.
   */
  const minutes = c.kind === "due" ? 1 : c.kind === "minutes" ? c.minutes : null;
  if (minutes === null) return [];

  const keys = ["bus_approx_prefix", `num_${minutes}`, "bus_minutes_suffix"];
  // All three or none. A missing middle leaves "Ойролцоогоор … минутын дараа"
  // with a hole where the number was, which is worse than saying no time.
  return keys.every(hasClip) ? keys : [];
}

/**
 * Every clip id a countdown could ever need, for preloading.
 *
 * The wait screen used to assemble `bus_approx_prefix` / `num_N` /
 * `bus_minutes_suffix` inline and hand them to `say()`, which drops any key
 * that is not decoded. Those three live in the TRANSIT manifest, and nothing on
 * that screen ever loaded them — so the minute was silently deleted from every
 * announcement and the rider heard the route name alone. Exported so the screen
 * loads exactly what it is going to speak.
 */
export const COUNTDOWN_CLIP_IDS: string[] = [
  "bus_approx_prefix",
  "bus_minutes_suffix",
  ...Array.from({ length: MAX_SPOKEN_NUMBER }, (_, i) => `num_${i + 1}`),
];
