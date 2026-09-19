/**
 * Which clips a journey actually needs in memory.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `ManifestClipPlayer.load()` with no argument loads the WHOLE manifest. That
 * was survivable while the manifest held 295 clips and most stop names were
 * unrendered. Rendering all 923 stop names made it fatal: 1,065 clips is 37
 * minutes of audio, and `decodeAudioData` resamples to the AudioContext rate —
 * so on a 48 kHz context that is
 *
 *     37 min × 48,000 × 4 bytes  ≈  407 MB of float32 PCM
 *
 * held resident, on a phone this project already had to fight to keep under
 * iOS's tab limit at model load. It would not have crashed in a way anyone
 * could diagnose: the tab would simply die and reload, exactly like the
 * detector bug in lib/vision-plan.ts.
 *
 * CLAUDE.md already specified the answer and it was never implemented:
 * "Route-scoped preload. Ship name-only clips for all 923 stops in the offline
 * bundle. Fetch and pin the full template set for the active route on journey
 * start. Do not ship the full cross-product — it does not fit."
 *
 * ── WHAT A JOURNEY ACTUALLY NEEDS ──────────────────────────────────────────
 *
 * The fixed vocabulary (18 phrases, 40 cardinals), the one route clip, and the
 * stop names on that route's own sequence. For a typical route that is about
 * ninety clips rather than a thousand — roughly a twelfth of the memory, and
 * every clip it can possibly need to speak.
 */

import type { RouteStops } from "./types";

/** Cardinals the announcements can reach. Matches MAX_SPOKEN_NUMBER. */
const MAX_NUMBER = 40;

/**
 * The fixed transit phrases.
 *
 * Listed from the manifest at call time rather than hard-coded: a phrase added
 * to `FIXED_PHRASES` and rendered would otherwise be missing here, and a
 * missing clip is silence to someone who cannot see the screen.
 */
function fixedPhraseKeys(manifestKeys: readonly string[]): string[] {
  return manifestKeys.filter((k) => k.startsWith("bus_"));
}

export type JourneyScope = {
  routeId: string;
  directionId: number;
};

/**
 * Every clip key an active journey on this route can need.
 *
 * Returns keys, not clips — the caller decides what to do with ones the
 * manifest does not have, and `ManifestClipPlayer.load` already reports those.
 */
export function journeyClipKeys(
  scope: JourneyScope,
  routeStops: RouteStops,
  manifestKeys: readonly string[],
): string[] {
  const keys = new Set<string>();

  for (const k of fixedPhraseKeys(manifestKeys)) keys.add(k);
  for (let n = 1; n <= MAX_NUMBER; n++) keys.add(`num_${n}`);

  keys.add(`route_${scope.routeId}`);

  /**
   * BOTH DIRECTIONS OF THE ROUTE, not just the one being ridden.
   *
   * A rider who boards the wrong way is the case the wrong-direction detector
   * exists for, and the announcement naming where they actually are must be
   * speakable. Loading the return sequence costs a few dozen clips and buys the
   * one announcement that is useless if silent.
   */
  const directions = routeStops[scope.routeId] ?? {};
  for (const sequence of Object.values(directions)) {
    for (const stopId of sequence) keys.add(`stop_${stopId}`);
  }

  return [...keys];
}

/**
 * The browsing window: names around the cursor in a long list.
 *
 * The destination list can run to hundreds of entries and cannot be preloaded
 * whole for the same reason as above. This loads a window ahead of and behind
 * the cursor, so scrolling stays voiced without pinning the city.
 *
 * `ahead` is larger than `behind` because a list is scrolled forward far more
 * often than back, and a name that arrives late reads as the app going quiet.
 */
export function browseWindowKeys(
  stopIds: readonly string[],
  cursor: number,
  { ahead = 25, behind = 10 }: { ahead?: number; behind?: number } = {},
): string[] {
  if (stopIds.length === 0) return [];
  const from = Math.max(0, cursor - behind);
  const to = Math.min(stopIds.length, cursor + ahead + 1);
  return stopIds.slice(from, to).map((id) => `stop_${id}`);
}
