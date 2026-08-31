/**
 * The four earcons, synthesized.
 *
 * NOT TTS, and not clips. An oscillator is not a speech call — CLAUDE.md bans
 * runtime synthesis of WORDS, not runtime audio — and these have to survive the
 * case where every clip failed to decode, which is exactly the case where the
 * rider most needs to know something happened.
 *
 * ── WHAT THEY HAVE TO SURVIVE ──────────────────────────────────────────────
 *
 * One earbud, in the other ear a bus pulling in on Peace Avenue. That rules out
 * most of the design space: anything quiet, anything low, anything longer than
 * about 400 ms, and anything that relies on timbre rather than on pitch
 * direction. What survives is a short pitch CONTOUR, because contour is what
 * the ear recovers from a masked signal — the same reason lifts and card
 * readers use a rising pair for accept and a falling pair for reject.
 *
 *   soft    one mid tone            something changed, no action needed
 *   alert   two tones, rising       act soon — be at the kerb, press the button
 *   urgent  three pulses, rising    act now — the doors, the wrong bus
 *   error   two tones, falling      that did not work
 *
 * ── WHY NOT REUSE THE EXISTING TONES ───────────────────────────────────────
 *
 * `playTone` in lib/audio.ts is an 880 Hz square at 0.35 gain and means an
 * obstacle the walk mode could not measure. `playListenCue` is the microphone
 * pair. Both are already taught. Borrowing either for a bus event would make
 * the danger sound sometimes mean "your stop is coming", which is the one
 * confusion this app cannot afford — so these are a third family, sine-based
 * and pitched clear of the 880 Hz alarm.
 *
 * Pure scheduling on the audio clock, never setTimeout: `start(when)` is
 * sample-accurate and does not drift when the main thread is busy.
 */
import type { EarconId, EarconPlayer } from "./audio-queue";

type Note = { hz: number; startS: number; durS: number; gain: number };

/**
 * All four, under 400 ms, spaced so the contour survives compression.
 *
 * `urgent` is the loudest at 0.30 and still sits below the 0.35 obstacle alarm,
 * which has to remain the most alarming thing the app can emit.
 */
const SHAPES: Record<EarconId, Note[]> = {
  soft: [
    { hz: 660, startS: 0, durS: 0.11, gain: 0.13 },
  ],
  alert: [
    { hz: 660, startS: 0, durS: 0.09, gain: 0.2 },
    { hz: 990, startS: 0.1, durS: 0.13, gain: 0.2 },
  ],
  urgent: [
    { hz: 740, startS: 0, durS: 0.07, gain: 0.3 },
    { hz: 740, startS: 0.09, durS: 0.07, gain: 0.3 },
    { hz: 1110, startS: 0.18, durS: 0.14, gain: 0.3 },
  ],
  error: [
    { hz: 560, startS: 0, durS: 0.1, gain: 0.18 },
    { hz: 370, startS: 0.11, durS: 0.16, gain: 0.18 },
  ],
};

/** Longest note end, in seconds — how long the caller must wait. */
export function earconDurationS(id: EarconId): number {
  return SHAPES[id].reduce((max, n) => Math.max(max, n.startS + n.durS), 0);
}

/** Every earcon must stay inside the budget that keeps it usable in traffic. */
export const MAX_EARCON_MS = 400;

/**
 * A tone with ramped edges.
 *
 * Ramped rather than switched because a hard edge on any waveform clicks, and a
 * click through a phone speaker is indistinguishable from a fault — which is
 * the one thing a reassurance sound must never sound like.
 */
function scheduleNote(ctx: BaseAudioContext, out: AudioNode, note: Note, at: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = note.hz;

  const start = at + note.startS;
  const end = start + note.durS;
  const edge = Math.min(0.012, note.durS / 3);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(note.gain, start + edge);
  gain.gain.setValueAtTime(note.gain, end - edge);
  gain.gain.linearRampToValueAtTime(0, end);

  osc.connect(gain).connect(out);
  osc.start(start);
  osc.stop(end + 0.01);
}

/**
 * An `EarconPlayer` over a live AudioContext.
 *
 * Resolves when the tone has finished, so `AudioQueue` can hold the words back
 * for the lead-in. Rejects on abort, matching `ClipPlayer` — a preempted
 * utterance must not leave its earcon ringing under the one that replaced it.
 */
export function createEarconPlayer(getContext: () => BaseAudioContext): EarconPlayer {
  return {
    play(id: EarconId, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      const ctx = getContext();
      const at = ctx.currentTime;
      for (const note of SHAPES[id]) scheduleNote(ctx, ctx.destination, note, at);

      const ms = earconDurationS(id) * 1000;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        }, { once: true });
      });
    },
  };
}

/** The shapes, for tests and for a settings screen that previews them. */
export const EARCON_SHAPES = SHAPES;
