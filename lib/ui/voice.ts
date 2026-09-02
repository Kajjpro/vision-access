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
 * The matcher below is PURE and therefore testable without a microphone —
 * which matters, because the recognition half cannot be tested here at all.
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
  | { kind: "heard"; transcript: string; confidence: number }
  | { kind: "error"; error: string; languageUnsupported: boolean };

/**
 * One recognition attempt. Resolves once — never left hanging.
 *
 * `language-not-supported` is surfaced explicitly rather than folded into a
 * generic error, because it is the one failure that should permanently disable
 * the feature rather than invite a retry.
 */
export function listenOnce(lang = "mn-MN", timeoutMs = 8000): Promise<RecognitionOutcome> {
  return new Promise((resolve) => {
    const SR =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (!SR) return resolve({ kind: "error", error: "no-api", languageUnsupported: false });

    const recognition = new SR();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;

    let settled = false;
    const finish = (outcome: RecognitionOutcome) => {
      if (settled) return;
      settled = true;
      try { recognition.abort(); } catch { /* already stopped */ }
      resolve(outcome);
    };

    recognition.onresult = (event) => {
      const best = event.results[0]?.[0];
      if (!best) return finish({ kind: "error", error: "no-match", languageUnsupported: false });
      finish({ kind: "heard", transcript: best.transcript, confidence: best.confidence ?? 0 });
    };
    recognition.onerror = (event) => {
      finish({
        kind: "error",
        error: event.error,
        languageUnsupported: event.error === "language-not-supported",
      });
    };
    recognition.onend = () => finish({ kind: "error", error: "no-speech", languageUnsupported: false });

    // A recogniser that never fires would leave the user waiting in silence.
    setTimeout(() => finish({ kind: "error", error: "timeout", languageUnsupported: false }), timeoutMs);

    try {
      recognition.start();
    } catch (e) {
      finish({ kind: "error", error: String(e), languageUnsupported: false });
    }
  });
}

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  abort(): void;
  onresult: ((event: { results: { [i: number]: { [j: number]: { transcript: string; confidence?: number } } } }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

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
