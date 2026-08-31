"use client";

/**
 * Ask the optional model layer for help, but only when the matcher is unsure.
 *
 * WHEN THIS RUNS AT ALL. Not on every utterance — only when the deterministic
 * matcher either found nothing or could not separate its top two candidates.
 * Three reasons, and each on its own would be sufficient:
 *
 *   Quota.    The recommended free tier allows a few hundred requests a day.
 *             Spending one on `"Сансар"` → `Сансар` (score 1.0, no runner-up)
 *             buys nothing and exhausts the allowance before the hard cases.
 *   Latency.  A round trip lands on top of ~700ms of recognition. Paying it
 *             when the answer is already certain makes the common path slower
 *             for no gain.
 *   Blast radius. A layer that only runs on the cases the app was about to ask
 *             a question about can only replace a question with an answer. It
 *             cannot turn a correct match into a wrong one, because it is never
 *             consulted about a correct match.
 *
 * WHAT COMES BACK IS ADVICE, NOT AN INSTRUCTION. The caller keeps its own
 * ranking and applies this on top; `null` means "nothing useful", which is the
 * normal result when there is no key, no network, or no time.
 */

import type { StopMatch } from "@/lib/routing/resolveJourney";

/** Mirrors the reply shape of app/api/stop-resolve/route.ts. */
export type LlmAssist =
  | { kind: "resolved"; stopId: string; confidence: number }
  | { kind: "ask"; question: "which_one" | "did_you_say" | "say_again" | "use_list"; stopIds: string[] }
  | { kind: "unknown" };

/**
 * Client-side deadline.
 *
 * Shorter than the route's own budget on purpose: if the server is going to
 * spend 2.5s, the rider should stop waiting before that and hear the
 * deterministic answer instead. Two timeouts, the tighter one owned by the side
 * that knows how long the person has been standing there.
 */
const CLIENT_TIMEOUT_MS = 2800;

/**
 * True when the matcher's own answer is not good enough to act on.
 *
 * Deliberately the same test the flow already uses to decide whether to ask the
 * rider "Аль нь вэ?" — so the model is consulted exactly when a question was
 * otherwise coming, and never in place of a confident match.
 */
export function needsAssist(matches: StopMatch[], ambiguous: boolean): boolean {
  return matches.length === 0 || ambiguous;
}

export async function askLlmAssist(
  transcripts: string[],
  candidates: StopMatch[],
  signal?: AbortSignal,
): Promise<LlmAssist | null> {
  if (transcripts.length === 0) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const res = await fetch("/api/stop-resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Ids and names only. No coordinates, no history, no device identifier —
      // see the privacy note in the route. Sending less is the whole point, so
      // do not widen this object without reading it.
      body: JSON.stringify({
        transcripts,
        candidates: candidates.map((m) => ({ id: m.stop.id, name: m.stop.name })),
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const data = (await res.json()) as LlmAssist;
    return data?.kind ? data : null;
  } catch {
    // Offline, aborted, slow, malformed — all mean the same thing here.
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
