"use client";

/**
 * The `speak` the voice-journey hook is handed.
 *
 * INTERRUPTS, NEVER QUEUES. Every utterance in this flow supersedes the last:
 * the read-back replaces the question, the answer replaces the read-back. A
 * queued sequence would leave the rider listening to a question they have
 * already answered while the answer waits behind it, and — worse — would let a
 * stale confirmation play after they had moved on, which is how someone ends up
 * double-tapping a destination they never heard offered.
 *
 * MISSING CLIPS ARE LOUD. `playSequence` skips a clip it cannot find, which is
 * the right behaviour mid-sentence but means an unrendered phrase is silent —
 * and to someone who cannot see the screen, silence is indistinguishable from a
 * frozen app. Every gap is reported through `onMissing` so the screen can put
 * it on the debug overlay, and to the console for anyone with a cable.
 */

import { hasClip, loadTransitClips, playSequence, stopAll } from "@/lib/audio";

export type SpeakOptions = {
  /** Called with the clip ids that were asked for and did not exist. */
  onMissing?: (missing: string[]) => void;
};

/**
 * Clip ids that are not fixed phrases and so are loaded on demand.
 *
 * The 923 stop clips are far too much audio to decode at startup on a cheap
 * phone, so `lib/audio.ts` fetches them per stop. Anything matching this is
 * fetched before the sequence plays rather than reported missing.
 *
 * `bus_` belongs here too. The confirmation sentence opens with
 * `bus_you_are_at` — "Та" — deliberately reused from the countdown rather than
 * rendered a second time in a second voice. But it lives in the transit Opus
 * manifest, not the WAV registry, so `loadClips()` could never resolve it and
 * nothing else fetched it: the read-back lost its first word, and a read-back
 * is the one thing in this flow that must not be half-spoken.
 */
export const ON_DEMAND = /^(stop|route|num|bus)_/;

export function createSpeaker({ onMissing }: SpeakOptions = {}) {
  return function speak(clips: (string | null | undefined)[]): void {
    const wanted = clips.filter((c): c is string => Boolean(c));
    if (wanted.length === 0) return;

    const missing = wanted.filter((id) => !hasClip(id));
    const fetchable = missing.filter((id) => ON_DEMAND.test(id));

    const play = () => {
      const stillMissing = wanted.filter((id) => !hasClip(id));
      if (stillMissing.length > 0) {
        // Not console.warn: this is a user-facing failure, not a lint nit.
        console.error(`[speak] ${stillMissing.length} clip(s) missing, spoken as silence:`, stillMissing);
        onMissing?.(stillMissing);
      }
      const playable = wanted.filter((id) => hasClip(id));
      if (playable.length > 0) playSequence(playable, { interrupt: true });
      else stopAll();
    };

    if (fetchable.length > 0) {
      // Interrupt NOW rather than after the fetch: the rider has already caused
      // this utterance, and leaving the previous one running for the length of
      // a network round trip reads as the gesture having done nothing.
      stopAll();
      void loadTransitClips(fetchable).then(play, play);
      return;
    }
    play();
  };
}
