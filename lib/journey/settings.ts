/**
 * Guidance settings, and where they live between sessions.
 *
 * Two knobs, deliberately independent:
 *
 *   LEVEL      how much the guide says — minimal / standard / detailed.
 *   HEARTBEAT  whether the non-verbal proof-of-life tone fires at all.
 *
 * Folding the second into the first would force a choice nobody asked for. A
 * rider can want `detailed` spoken guidance and still not want a tone in their
 * ear every two minutes; someone with one earbud in traffic may want exactly the
 * opposite — silence in words, a pulse to know the app is alive.
 *
 * localStorage, matching `va:lastMode` and `va:vision-plan`, which is what this
 * app already uses for per-device preferences. A setting that reset every launch
 * would be re-chosen by ear every launch, which is a minute of someone's life
 * each time.
 *
 * Every read is total: a corrupt or absent value returns the default rather than
 * throwing. Settings are not worth failing a journey over.
 */

import type { GuidanceLevel } from "./types";

export type GuidanceSettings = {
  level: GuidanceLevel;
  heartbeat: boolean;
};

/**
 * `standard` and heartbeat on.
 *
 * Not "the middle option" — it is the setting that satisfies both halves of the
 * announcement policy at once: no speech on a timer, and audible proof the app
 * is running. See lib/journey/pacer.ts.
 */
export const DEFAULT_SETTINGS: GuidanceSettings = { level: "standard", heartbeat: true };

const LEVEL_KEY = "va:guidance-level";
const HEARTBEAT_KEY = "va:guidance-heartbeat";

const LEVELS: readonly GuidanceLevel[] = ["minimal", "standard", "detailed"];

export function isGuidanceLevel(value: unknown): value is GuidanceLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

export function loadSettings(storage?: Storage): GuidanceSettings {
  try {
    const store = storage ?? localStorage;
    const level = store.getItem(LEVEL_KEY);
    const heartbeat = store.getItem(HEARTBEAT_KEY);
    return {
      level: isGuidanceLevel(level) ? level : DEFAULT_SETTINGS.level,
      // Only an explicit "0" turns it off. An absent key is a rider who has
      // never chosen, and they get the proof-of-life rather than the silence.
      heartbeat: heartbeat === "0" ? false : DEFAULT_SETTINGS.heartbeat,
    };
  } catch {
    // Private mode, or no storage at all. The journey still runs on defaults.
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: GuidanceSettings, storage?: Storage): void {
  try {
    const store = storage ?? localStorage;
    store.setItem(LEVEL_KEY, settings.level);
    store.setItem(HEARTBEAT_KEY, settings.heartbeat ? "1" : "0");
  } catch {
    // Unstorable. The setting still applies to the session in hand — it is on
    // the journey object either way — it just will not survive a reload.
  }
}

/** The levels in the order the settings screen reads them out. */
export const GUIDANCE_LEVELS: readonly GuidanceLevel[] = LEVELS;
