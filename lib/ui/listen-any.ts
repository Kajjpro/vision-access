"use client";

/**
 * Listening that actually works on the target device.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * There were two recognizers in this app and the wrong one was wired to the
 * screen people use. `/bus/journey` used the Azure path — verified `mn-MN`,
 * 95% on real stop names. `/bus/wait`, the screen with "Хаашаа явахаа хэлнэ
 * үү", used `lib/ui/voice.ts`, which is Web Speech ONLY. Chrome does not list
 * `mn-MN`, so that path answers "Дуу хоолойгоор оруулах боломжгүй байна" —
 * voice input is unavailable — every single time, on the one screen where a
 * rider is asked to speak.
 *
 * This module gives `listen()`'s exact contract back, driven by the engine that
 * works. `lib/ui/voice.ts` stays as-is: it is the Web Speech implementation,
 * still correct, still tested, and still used when a device has proven it.
 *
 * ── SUPPORT DETECTION ASKS THE RIGHT QUESTION ──────────────────────────────
 *
 * `detectVoiceSupport()` asks "does `window.SpeechRecognition` exist?", which
 * is the wrong question for an engine that records audio and uploads it. What
 * matters is whether the browser will hand over a microphone at all, and the
 * usual reason it will not has nothing to do with speech: an insecure origin.
 * `navigator.mediaDevices` is `undefined` on plain HTTP, so a phone opening
 * `http://192.168.x.x:3000` cannot capture audio by any means. `localhost` is
 * exempt from that rule, which is exactly why this survives every desktop test
 * and fails on the device that matters. Hence `npm run dev` serving HTTPS.
 *
 * Each reason gets its own code, because each has a different fix and
 * "unavailable" tells the person holding the phone none of them.
 */

import {
  createRecognizer,
  type SttError,
  type SttResult,
} from "@/lib/speech/recognizer";
import type { ListenEvent, RecognitionOutcome } from "@/lib/ui/voice";

export type CaptureBlocker =
  /** Page is not HTTPS. No engine can open a microphone. Serve over TLS. */
  | "insecure"
  /** Browser predates getUserMedia, or it is disabled by policy. */
  | "no-mediadevices"
  /** No MediaRecorder — cannot capture audio to upload. */
  | "no-recorder"
  /** Recognition needs the network; the device says it has none. */
  | "no-network";

export type CaptureSupport =
  | { available: true }
  | { available: false; reason: CaptureBlocker; hint: string };

/**
 * Can this browser capture speech at all?
 *
 * Deliberately does NOT test for `SpeechRecognition` — the working engine does
 * not use it. A device with no Web Speech at all still records and uploads
 * fine, and refusing to try was the bug.
 */
export function detectCaptureSupport(): CaptureSupport {
  if (typeof window === "undefined") {
    return { available: false, reason: "no-mediadevices", hint: "Not running in a browser." };
  }
  if (typeof window.isSecureContext === "boolean" && !window.isSecureContext) {
    return {
      available: false,
      reason: "insecure",
      hint: "Microphones need HTTPS. Open the app over https:// — `npm run dev` serves it.",
    };
  }
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return {
      available: false,
      reason: "no-mediadevices",
      hint: "This browser exposes no microphone API. On a phone this is almost always the insecure-origin rule.",
    };
  }
  if (typeof MediaRecorder === "undefined") {
    return { available: false, reason: "no-recorder", hint: "MediaRecorder is missing." };
  }
  if (navigator.onLine === false) {
    return {
      available: false,
      reason: "no-network",
      hint: "Recognition runs server-side and the device reports no network.",
    };
  }
  return { available: true };
}

/**
 * How long a tap-driven capture records before it uploads.
 *
 * The wait screen has no release event — the rider taps "say where you are
 * going" and speaks, so this timer is the only thing that ends the utterance.
 * Long enough for the longest stop name said unhurriedly, short enough that the
 * wait afterwards does not read as a hang.
 */
const TAP_CAPTURE_MS = 5000;

export interface ListenAnyOptions {
  onEvent?: (event: ListenEvent) => void;
  /** Overrides the capture window. Push-to-talk callers pass their own stop. */
  maxUtteranceMs?: number;
  signal?: AbortSignal;
}

/** Map the recognizer's error vocabulary onto the one the screens already speak. */
function toOutcome(error: SttError): RecognitionOutcome {
  const map: Record<string, { error: string; retryable: boolean; unsupported: boolean }> = {
    "permission-denied": { error: "not-allowed", retryable: false, unsupported: false },
    "no-microphone": { error: "no-mic", retryable: false, unsupported: false },
    "language-unsupported": { error: "language-not-supported", retryable: false, unsupported: true },
    "no-speech": { error: "no-speech", retryable: true, unsupported: false },
    network: { error: "network", retryable: false, unsupported: false },
    unknown: { error: "unknown", retryable: true, unsupported: false },
  };
  const m = map[error.code] ?? map.unknown;
  return {
    kind: "error",
    error: m.error,
    languageUnsupported: m.unsupported,
    retryable: m.retryable,
  };
}

/**
 * One capture, one answer — same shape `listen()` returns.
 *
 * Settles exactly once. The recognizer already guarantees one outcome per
 * `start()`, and the guard here is belt-and-braces: a screen that never gets an
 * answer leaves a blind rider holding a silent phone with no way to tell
 * whether it is thinking or dead.
 */
export function listenOnceAnyEngine(options: ListenAnyOptions = {}): Promise<RecognitionOutcome> {
  const support = detectCaptureSupport();
  if (!support.available) {
    return Promise.resolve({
      kind: "error",
      error: support.reason,
      // Not a language problem — saying so would switch voice off permanently
      // for a device whose only fault is the URL scheme.
      languageUnsupported: false,
      retryable: false,
    });
  }

  return new Promise<RecognitionOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: RecognitionOutcome) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const recognizer = createRecognizer(
      {
        onResult: (r: SttResult) =>
          settle({
            kind: "heard",
            transcript: r.transcript,
            confidence: r.confidence,
            alternatives: r.alternatives,
          }),
        onError: (e) => settle(toOutcome(e)),
        onStateChange: (state) => {
          // 'listening' is fired once the recorder is actually running, so this
          // is the real "speak now" moment rather than a guess at one.
          if (state === "listening") options.onEvent?.({ type: "ready" });
          if (state === "processing") options.onEvent?.({ type: "speech-end" });
        },
      },
      { maxUtteranceMs: options.maxUtteranceMs ?? TAP_CAPTURE_MS },
    );

    const onAbort = () => {
      recognizer.abort();
      settle({ kind: "error", error: "aborted", languageUnsupported: false, retryable: false });
    };
    options.signal?.addEventListener("abort", onAbort);

    void recognizer.start().catch(() =>
      settle({ kind: "error", error: "unknown", languageUnsupported: false, retryable: true }),
    );
  });
}

/**
 * `listenOnceAnyEngine` with one retry, matching `listen()`'s behaviour.
 *
 * Retries only what repeating could fix. A refused microphone and an insecure
 * origin fail identically forever, and asking someone to say a stop name twice
 * when the problem is the URL scheme is the specific cruelty this app keeps
 * trying to avoid.
 */
export async function listenAnyEngine({
  attempts = 2,
  beforeRetry,
  ...options
}: ListenAnyOptions & {
  attempts?: number;
  beforeRetry?: () => void | Promise<void>;
} = {}): Promise<RecognitionOutcome> {
  let outcome = await listenOnceAnyEngine(options);

  for (let attempt = 1; attempt < Math.max(1, attempts); attempt++) {
    if (outcome.kind === "heard" || !outcome.retryable) return outcome;
    options.onEvent?.({ type: "retry", attempt, after: outcome.error });
    await beforeRetry?.();
    outcome = await listenOnceAnyEngine(options);
  }
  return outcome;
}
