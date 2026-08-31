/**
 * The gate between a model's reply and a blind rider's destination.
 *
 * Split out of `app/api/stop-resolve/route.ts` so it can be tested without a
 * network, a key, or a Next request — because this is the function that decides
 * whether a model-authored string is allowed to become somewhere a person is
 * sent, and "we were fairly sure the route validated that" is not good enough
 * for that decision.
 *
 * The whole contract in one line: NOTHING LEAVES HERE THAT DID NOT ARRIVE IN
 * `allowed`.
 */

/** The four things the app can say. Each already has a rendered clip. */
export const QUESTIONS = ['which_one', 'did_you_say', 'say_again', 'use_list'] as const;
export type Question = (typeof QUESTIONS)[number];

export type StopResolveReply =
  | { kind: 'resolved'; stopId: string; confidence: number }
  | { kind: 'ask'; question: Question; stopIds: string[] }
  | { kind: 'unknown' };

export const UNKNOWN: StopResolveReply = { kind: 'unknown' };

/** Whatever the model actually sent. Every field is suspect. */
export type ModelReply = {
  action?: unknown;
  stopId?: unknown;
  confidence?: unknown;
  question?: unknown;
  stopIds?: unknown;
};

/**
 * Validate a model reply against the candidate ids we supplied.
 *
 * `onViolation` fires when the model names an id we did not offer — worth
 * logging rather than swallowing, because a model that starts inventing ids is
 * a prompt regression or a provider swap, and the symptom otherwise is a
 * feature that silently stops helping.
 */
export function applyModelReply(
  raw: ModelReply | null | undefined,
  allowed: ReadonlySet<string>,
  onViolation?: (reason: string) => void,
): StopResolveReply {
  if (!raw || typeof raw !== 'object') return UNKNOWN;

  if (raw.action === 'resolved') {
    if (typeof raw.stopId !== 'string' || !allowed.has(raw.stopId)) {
      onViolation?.(`resolved to an id outside the candidate set: ${String(raw.stopId)}`);
      return UNKNOWN;
    }
    // An out-of-range or non-numeric confidence is treated as "no opinion"
    // rather than rejected — the id is the load-bearing part, and this number
    // only ever orders candidates that already passed the gate.
    const c = raw.confidence;
    const confidence = typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1 ? c : 0.5;
    return { kind: 'resolved', stopId: raw.stopId, confidence };
  }

  if (raw.action === 'ask') {
    const question = QUESTIONS.find((q) => q === raw.question);
    if (!question) return UNKNOWN;

    // Same gate on ids named inside a question: the rider is about to hear
    // these read aloud from `stop_<id>` clips, and an id we never rendered is
    // silence — which reads as a frozen app to someone who cannot see it.
    const listed = Array.isArray(raw.stopIds) ? raw.stopIds : [];
    const stopIds: string[] = [];
    for (const id of listed) {
      if (typeof id !== 'string') continue;
      if (!allowed.has(id)) {
        onViolation?.(`asked about an id outside the candidate set: ${id}`);
        continue;
      }
      if (!stopIds.includes(id)) stopIds.push(id);
      if (stopIds.length === 3) break;
    }

    // "Which one?" with nothing to choose between, or "did you say?" with
    // nothing to name, is a question the rider cannot answer.
    if ((question === 'which_one' || question === 'did_you_say') && stopIds.length === 0) {
      return UNKNOWN;
    }
    return { kind: 'ask', question, stopIds };
  }

  return UNKNOWN;
}

/**
 * Narrow an untrusted request body to the only two things that may be sent
 * upstream: transcripts, and `{id, name}` per candidate.
 *
 * Re-derived rather than forwarded. A client that added coordinates, a device
 * id, or travel history to this payload would not get them sent — minimisation
 * enforced at the boundary, not by convention, because the recommended free
 * tier may train on what it receives.
 */
export function sanitizeRequest(
  body: unknown,
  { maxTranscripts = 8, maxCandidates = 8 } = {},
): { transcripts: string[]; candidates: { id: string; name: string }[] } {
  const b = (body ?? {}) as { transcripts?: unknown; candidates?: unknown };

  const transcripts = (Array.isArray(b.transcripts) ? b.transcripts : [])
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim())
    .slice(0, maxTranscripts);

  const candidates = (Array.isArray(b.candidates) ? b.candidates : [])
    .filter(
      (c): c is { id: string; name: string } =>
        Boolean(c) &&
        typeof (c as { id?: unknown }).id === 'string' &&
        typeof (c as { name?: unknown }).name === 'string',
    )
    .slice(0, maxCandidates)
    .map((c) => ({ id: c.id, name: c.name }));

  return { transcripts, candidates };
}
