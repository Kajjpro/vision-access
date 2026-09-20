/**
 * What happens when a clip is not there.
 *
 * The journey UI is finished before the audio set is, so "this phrase has no
 * file yet" is the NORMAL case right now, not an edge one. It must not be
 * allowed to become silence, because silence reads to a rider as "nothing to
 * report" — indistinguishable from "your stop is not coming up yet", which is
 * the one confusion that strands someone.
 *
 * ── THE LADDER ─────────────────────────────────────────────────────────────
 *
 *   1. THE CLIP           pre-rendered Azure mn-MN, from the manifest.
 *   2. SPEECH SYNTHESIS   NOT WIRED. See below.
 *   3. EARCON + HAPTIC    the parallel channels, which already carry the state.
 *   4. THE SCREEN         text, for a sighted helper or partial vision.
 *
 * Rungs 1, 3 and 4 are live. `AudioQueue` already implements the fall from 1 to
 * 3: it emits `missing`, plays whatever keys DID resolve, and abandons an
 * utterance only when speech, earcon and haptic are all empty. This module adds
 * the part that was absent — making rung 2's absence a decision on the record,
 * and making the gap visible to a developer instead of only to a rider.
 *
 * ── WHY RUNG 2 IS NOT WIRED ────────────────────────────────────────────────
 *
 * The brief asks for "text-to-speech fallback IF SUPPORTED". On the target
 * hardware it is not supported, and CLAUDE.md is explicit about why: browser
 * `speechSynthesis` has absent or unusable `mn-MN` support on the phones this
 * ships to, and the correct degradation is a generic clip plus a log — never
 * synthesis.
 *
 * The failure mode is not "no voice". It is a voice that reads Mongolian
 * Cyrillic with an English or Russian phoneme set, confidently, at the moment a
 * rider is deciding whether to step off a kerb. Wrong words spoken clearly are
 * worse than no words, because no words are recognisably a gap.
 *
 * So the seam exists and the implementation does not. `NO_SPEECH_FALLBACK` is
 * what ships. If a device is ever shown to have a real mn-MN voice, implement
 * `SpeechFallback` and pass it — nothing else has to change, and the decision
 * stays visible in one place rather than spread through the screens.
 */

/**
 * A synthesised-speech fallback, if one is ever justified.
 *
 * `canSpeak` must be a genuine capability check for a REAL mn-MN voice — the
 * presence of `speechSynthesis` is not one, and neither is a voice list that
 * merely contains a Mongolian-looking locale tag without a matching voice.
 */
export interface SpeechFallback {
  canSpeak(): boolean;
  speak(text: string, signal: AbortSignal): Promise<void>;
}

/**
 * The shipped implementation: there is no fallback voice.
 *
 * A named constant rather than `null` at each call site, so the absence is
 * something you read rather than something you fail to notice.
 */
export const NO_SPEECH_FALLBACK: SpeechFallback = {
  canSpeak: () => false,
  speak: async () => {
    throw new Error("no speech fallback: mn-MN synthesis is unusable on target hardware");
  },
};

export type MissingClipReport = {
  /** Every key seen missing, in first-seen order. */
  keys: string[];
  /** How many times each was wanted — a key wanted often is worth rendering first. */
  counts: Record<string, number>;
  total: number;
};

export interface MissingClipReporter {
  /** Called with the keys an announcement could not resolve. */
  record(keys: string[]): void;
  report(): MissingClipReport;
}

/**
 * Collects missing clips and, in development, says so once per key.
 *
 * ONCE PER KEY, not once per occurrence. A stop name missing on every tick of a
 * countdown would otherwise bury the console in a hundred copies of one fact,
 * which is how a real warning stops being read. The counts are kept regardless
 * and surface in the debug panel, because "which clip is wanted most" is exactly
 * the question that orders the rendering backlog.
 *
 * `warn` is injectable so the behaviour is testable without a console.
 */
export function createMissingClipReporter(options?: {
  warn?: (message: string) => void;
  /** Defaults to true outside production. */
  verbose?: boolean;
}): MissingClipReporter {
  const counts: Record<string, number> = {};
  const order: string[] = [];
  const announced = new Set<string>();
  const warn = options?.warn ?? ((m: string) => console.warn(m));
  const verbose = options?.verbose ?? process.env.NODE_ENV !== "production";
  let total = 0;

  return {
    record(keys: string[]) {
      for (const key of keys) {
        if (!(key in counts)) {
          counts[key] = 0;
          order.push(key);
        }
        counts[key] += 1;
        total += 1;

        if (verbose && !announced.has(key)) {
          announced.add(key);
          warn(
            `[VisionAccess] no audio for "${key}" — the earcon and haptic still fire, ` +
              `but this phrase will not be spoken. Render it with: npx tsx scripts/render-ui-audio.ts`,
          );
        }
      }
    },
    report() {
      return { keys: [...order], counts: { ...counts }, total };
    },
  };
}
