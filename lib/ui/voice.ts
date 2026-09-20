/**
 * Speaking a destination instead of finding it in a list.
 *
 * A blind passenger cannot scroll 36 stops by ear to reach the one they want.
 * Saying "Сансар" is the natural act; the list is the fallback, not the other
 * way round.
 *
 * TWO RULES, both non-negotiable:
 *
 *   NEVER ACT ON AN UNCONFIRMED RECOGNITION. A misheard destination puts
 *   someone off the bus in the wrong place, possibly somewhere they cannot
 *   navigate home from. Every result is read back and needs an explicit
 *   double-tap before anything happens.
 *
 *   GESTURES ALWAYS REMAIN SUFFICIENT. Recognition needs a network and may not
 *   support Mongolian at all. When it is unavailable the list is still there,
 *   and the app says so rather than appearing broken.
 *
 * Both halves are testable without a microphone: the matcher is pure, and the
 * recogniser is injected. That was not true before — the recognition half ran
 * only on a real phone, so every timeout and retry decision in it was an
 * untested guess about the one path that actually strands a user.
 */

export type VoiceSupport =
  | { available: true }
  | { available: false; reason: "no-api" | "no-network" | "insecure" };

export function detectVoiceSupport(): VoiceSupport {
  if (typeof window === "undefined") return { available: false, reason: "no-api" };
  const SR =
    (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  if (!SR) return { available: false, reason: "no-api" };
  // Recognition is server-side in every browser that implements it.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { available: false, reason: "no-network" };
  }
  if (typeof window.isSecureContext === "boolean" && !window.isSecureContext) {
    return { available: false, reason: "insecure" };
  }
  return { available: true };
}

export type RecognitionOutcome =
  | {
      kind: "heard";
      /** The recogniser's own best guess. */
      transcript: string;
      confidence: number;
      /**
       * EVERY alternative, best first, including `transcript`.
       *
       * The recogniser has always been asked for several and only the first was
       * ever read. For Mongolian place names that throws away the answer
       * surprisingly often: the engine is transcribing a proper noun it does
       * not have in its language model, so the ranking between near-homophones
       * is close to arbitrary. Scoring all of them against the stop list and
       * taking the best MATCH — rather than the best transcript — is free
       * accuracy. See `searchStopsAny()`.
       */
      alternatives: string[];
    }
  | {
      kind: "error";
      error: string;
      languageUnsupported: boolean;
      /** Whether asking the user to say it again could plausibly succeed. */
      retryable: boolean;
    };

/**
 * Progress, for a user who cannot see a microphone indicator.
 *
 * Every voice UI ever built shows a waveform or a pulsing dot. None of that
 * exists here, so the same information has to arrive as sound, and it has to be
 * driven by what the recogniser is ACTUALLY doing rather than by a guess about
 * how long the prompt took to play.
 */
export type ListenEvent =
  /** The microphone is provably live. THE moment to signal "speak now". */
  | { type: "ready" }
  /** The engine heard speech begin — worth a cue, it means "you are getting through". */
  | { type: "speech-start" }
  /** The engine heard speech end; the transcript is in flight. */
  | { type: "speech-end" }
  | { type: "retry"; attempt: number; after: string };

export type SpeechAlternative = { transcript: string; confidence?: number };
export type SpeechResult = { [j: number]: SpeechAlternative; length?: number };

/**
 * The slice of `SpeechRecognition` used here.
 *
 * Injected rather than reached for, exactly as `lib/transit/locate.ts` injects
 * geolocation: it is what lets a denied microphone, an engine that never opens
 * one, a user who says nothing, and an engine that returns three spellings of a
 * stop name all be replayed deterministically. Until this was injectable the
 * recognition half of this file had NO tests at all — the header used to say so
 * — and it is the half that decides whether the feature works on the phone.
 */
export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  abort(): void;
  onstart?: (() => void) | null;
  onaudiostart?: (() => void) | null;
  onspeechstart?: (() => void) | null;
  onspeechend?: (() => void) | null;
  onnomatch?: (() => void) | null;
  onresult: ((event: { results: { [i: number]: SpeechResult } }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

/**
 * How many spellings to ask for.
 *
 * Raised from 3 once the matcher learned to score them all. The engine has
 * already computed and ranked these server-side, so extra alternatives cost no
 * latency and no bandwidth worth naming — and for a proper noun outside the
 * language model, the real name is often the one the engine ranked third.
 */
export const MAX_ALTERNATIVES = 6;

/**
 * Budget for the microphone to actually open after `start()`.
 *
 * Not the same thing as the user being slow: on a cheap Android this window is
 * the permission prompt sitting unanswered, or an engine that never connects.
 * Distinguishing it matters because the remedy is different — the user must be
 * told about permission rather than asked to repeat themselves.
 */
export const READY_TIMEOUT_MS = 5_000;

/** Budget from mic-live until the user starts speaking. */
export const START_TIMEOUT_MS = 6_000;

/** Budget from speech start until the engine returns something. */
export const SPEECH_TIMEOUT_MS = 8_000;

/**
 * Budget from end-of-speech until the transcript lands.
 *
 * Shorter than SPEECH_TIMEOUT_MS on purpose. Once the engine reports the user
 * has stopped talking, all that remains is a server round trip; holding the
 * full speaking budget open would leave someone who has finished their sentence
 * listening to silence for several seconds with no idea whether it worked.
 */
export const RESULT_TIMEOUT_MS = 5_000;

/** Attempts in total, including the first. */
export const ATTEMPTS = 2;

/**
 * Failures where saying it again is a reasonable thing to ask.
 *
 * Deliberately short. A permission refusal, an unsupported language or a dead
 * microphone will fail identically forever, and re-prompting someone who cannot
 * see why it failed is worse than dropping cleanly to the stop list.
 */
const RETRYABLE = new Set(["no-speech", "no-match", "aborted"]);

const fail = (error: string): RecognitionOutcome => ({
  kind: "error",
  error,
  languageUnsupported: error === "language-not-supported",
  retryable: RETRYABLE.has(error),
});

function browserRecognizer(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const SR =
    (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
  return SR ? new SR() : null;
}

export type ListenOptions = {
  lang?: string;
  create?: () => SpeechRecognitionLike | null;
  onEvent?: (e: ListenEvent) => void;
  maxAlternatives?: number;
  readyTimeoutMs?: number;
  startTimeoutMs?: number;
  speechTimeoutMs?: number;
  resultTimeoutMs?: number;
};

/**
 * One recognition attempt. Resolves exactly once — never left hanging.
 *
 * THE TIMEOUT IS PHASED, NOT A SINGLE WALL CLOCK. The old version gave the
 * whole interaction 8 seconds from `start()`, which had to cover the permission
 * prompt, the microphone opening, the user deciding what to say, and then
 * saying it. Someone who hesitated three seconds had three left to speak, and
 * was cut off mid-name — while a phone whose microphone never opened at all
 * burned the same eight seconds looking identical to a user who said nothing.
 * Each phase now has its own budget and its own distinguishable outcome.
 */
export function listenOnce({
  lang = "mn-MN",
  create = browserRecognizer,
  onEvent,
  maxAlternatives = MAX_ALTERNATIVES,
  readyTimeoutMs = READY_TIMEOUT_MS,
  startTimeoutMs = START_TIMEOUT_MS,
  speechTimeoutMs = SPEECH_TIMEOUT_MS,
  resultTimeoutMs = RESULT_TIMEOUT_MS,
}: ListenOptions = {}): Promise<RecognitionOutcome> {
  return new Promise((resolve) => {
    let recognition: SpeechRecognitionLike | null = null;
    try {
      recognition = create();
    } catch {
      recognition = null;
    }
    if (!recognition) return resolve(fail("no-api"));
    const active = recognition;

    active.lang = lang;
    active.continuous = false;
    // Partial transcripts are of no use to someone who cannot read the screen,
    // and `onspeechstart` already gives us the one thing they would tell us.
    active.interimResults = false;
    active.maxAlternatives = maxAlternatives;

    let settled = false;
    let live = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** Only one phase is ever in flight, so one timer slot is enough. */
    const arm = (ms: number, error: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(fail(error)), ms);
    };

    const finish = (outcome: RecognitionOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { active.abort(); } catch { /* already stopped */ }
      resolve(outcome);
    };

    arm(readyTimeoutMs, "no-mic");

    // `audiostart` is the accurate signal; `start` is the fallback for engines
    // that never fire it, and it is the weaker claim — on a FIRST EVER run it
    // can precede the permission grant, so the cue may invite someone to speak
    // at a dialog they cannot see. Not worth a speculative second timer to
    // paper over: it happens once per install, and a refusal still arrives as
    // `not-allowed`. Confirm against TIMING on a real phone before tuning it.
    const ready = () => {
      if (settled || live) return;
      live = true;
      onEvent?.({ type: "ready" });
      arm(startTimeoutMs, "no-speech");
    };
    active.onstart = ready;
    active.onaudiostart = ready;

    active.onspeechstart = () => {
      if (settled) return;
      onEvent?.({ type: "speech-start" });
      arm(speechTimeoutMs, "timeout");
    };

    active.onspeechend = () => {
      if (settled) return;
      onEvent?.({ type: "speech-end" });
      arm(resultTimeoutMs, "timeout");
    };

    active.onresult = (event) => {
      const result = event.results[0];
      const best = result?.[0];
      if (!best) return finish(fail("no-match"));

      // Collect every alternative the engine offered. `length` is on the
      // SpeechRecognitionResult, which is array-like rather than an array.
      const alternatives: string[] = [];
      const count = typeof result.length === "number" ? result.length : 1;
      for (let i = 0; i < count; i++) {
        const text = result[i]?.transcript?.trim();
        if (text && !alternatives.includes(text)) alternatives.push(text);
      }

      const transcript = best.transcript?.trim() ?? "";
      if (!transcript && alternatives.length === 0) return finish(fail("no-match"));

      finish({
        kind: "heard",
        transcript,
        confidence: best.confidence ?? 0,
        alternatives: alternatives.length ? alternatives : [transcript],
      });
    };

    active.onnomatch = () => finish(fail("no-match"));
    active.onerror = (event) => finish(fail(event.error));
    // Fires after a result too, but `settled` has already won by then. Reaching
    // here unsettled means the engine gave up without saying why.
    active.onend = () => finish(fail("no-speech"));

    try {
      active.start();
    } catch (e) {
      finish(fail(String(e)));
    }
  });
}

/**
 * `listenOnce` with a second chance.
 *
 * One hesitation used to drop the user all the way back to a list of a hundred
 * destinations. People pause — especially when the thing they are talking to
 * has just finished talking at them — and a retry costs a few seconds against a
 * flow that otherwise fails outright.
 *
 * `beforeRetry` is awaited between attempts and is where the caller says
 * "Ойлгосонгүй, дахин оролдоно уу". It lives outside this function so the
 * retry policy stays testable without an AudioContext, and so the microphone is
 * provably closed while the phone is talking — an open mic during our own
 * prompt is how the engine ends up transcribing our voice instead of the user's.
 */
export async function listen({
  attempts = ATTEMPTS,
  beforeRetry,
  onEvent,
  ...options
}: ListenOptions & {
  attempts?: number;
  beforeRetry?: () => void | Promise<void>;
} = {}): Promise<RecognitionOutcome> {
  let outcome = await listenOnce({ ...options, onEvent });

  for (let attempt = 1; attempt < Math.max(1, attempts); attempt++) {
    if (outcome.kind === "heard" || !outcome.retryable) return outcome;
    onEvent?.({ type: "retry", attempt, after: outcome.error });
    await beforeRetry?.();
    outcome = await listenOnce({ ...options, onEvent });
  }

  return outcome;
}

// ------------------------------------------------------------- matching

/**
 * Normalises a stop name or a transcript for comparison.
 *
 * Strips the platform suffix, punctuation and case. A user says "Сансар", not
 * "Сансар /Хойд/" — nobody speaks the direction marker aloud, so leaving it in
 * would make every stop fail to match.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/\s*\/[^/]*\/\s*/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Levenshtein, bounded — speech recognition gets endings wrong constantly. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

export type StopMatch<T> = { stop: T; score: number; name: string };

/**
 * Ranks stops against what was heard.
 *
 * Scoring is deliberately forgiving at the front and strict overall:
 * recognition mangles Mongolian case endings, so `Сансарт` must still match
 * `Сансар`, but two unrelated names must not tie. An exact or prefix match
 * always beats a fuzzy one.
 */
export function matchStops<T extends { name: string }>(
  transcript: string,
  stops: T[],
  { limit = 5, minScore = 0.55 }: { limit?: number; minScore?: number } = {},
): StopMatch<T>[] {
  const said = normalizeForMatch(transcript);
  if (!said) return [];

  const scored: StopMatch<T>[] = [];
  for (const stop of stops) {
    const name = normalizeForMatch(stop.name);
    if (!name) continue;

    let score: number;
    if (name === said) score = 1;
    else if (name.startsWith(said) || said.startsWith(name)) {
      // Prefix match, scaled by how much of the name was actually said, so
      // "Сан" does not outrank a full "Сансар".
      score = 0.9 * (Math.min(name.length, said.length) / Math.max(name.length, said.length)) + 0.1;
    } else if (name.includes(said) || said.includes(name)) {
      score = 0.75 * (Math.min(name.length, said.length) / Math.max(name.length, said.length));
    } else {
      const distance = editDistance(name, said);
      score = 1 - distance / Math.max(name.length, said.length);
    }

    if (score >= minScore) scored.push({ stop, score, name: stop.name });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}
