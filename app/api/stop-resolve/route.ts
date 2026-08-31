/**
 * Rerank the stops the matcher already found, and choose what to ask.
 *
 * NOT A CONTRADICTION OF "NEVER ADD A SERVER INFERENCE ROUTE". That rule in
 * CLAUDE.md governs obstacle detection: camera frames, a 60ms budget, a person
 * walking half a metre during a round trip. This is the open-vocabulary text
 * path the same file explicitly permits a server for, alongside `/api/stt` —
 * a rider standing still at a stop, choosing a destination, who can afford a
 * second and cannot afford a wrong answer.
 *
 * ── THE SAFETY PROPERTY ────────────────────────────────────────────────────
 *
 * THE MODEL CANNOT NAME A STOP. It receives a candidate list that the
 * deterministic matcher produced from `public/transit/stops.json`, and may only
 * return an id from that list. Any other id — invented, hallucinated,
 * misremembered from training — is dropped by `pickCandidate` below and the
 * request resolves to `unknown`, which sends the client back to its own
 * ranking. There is no code path by which a model-authored string becomes a
 * destination.
 *
 * IT ALSO CANNOT SAY ANYTHING NEW. Speech in this app is pre-rendered at build
 * time, so a model that could phrase its own question would be mute. It instead
 * picks one of four fixed questions, each already rendered, and may name stops
 * only by id so the existing `stop_<id>` clips speak them. That constraint is
 * what makes a conversational layer possible at all under a pre-rendered TTS
 * pipeline — and it is a feature, not a workaround: a blind rider hears the
 * same four questions in the same voice every time, instead of a model
 * improvising phrasing they have to parse afresh.
 *
 * IT IS OPTIONAL, ALWAYS. No key, no provider, a timeout, a rate limit, a
 * malformed reply, a 500 — every one of them returns `{kind:"unknown"}` with
 * HTTP 200. The client treats that as "use the matcher's own answer", which is
 * the 95%-accurate path it would have taken anyway. This route can only improve
 * a ranking; it can never block a journey.
 *
 * ⚠️ WHAT LEAVES THE DEVICE, AND WHY IT IS MINIMISED. The transcript and the
 * candidate stop names. NOT coordinates, NOT a device or rider id, NOT travel
 * history — see the redaction in `POST` below. This matters more than usual
 * because the recommended free tier (Gemini) permits training on free-tier
 * prompts. A spoken destination is now the one thing in this app that leaves
 * the phone, and that is worth disclosing to riders rather than burying here.
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  LlmUnavailable,
  selectLlmProvider,
  type LlmProvider,
} from '@/lib/llm/provider';
import {
  applyModelReply,
  QUESTIONS,
  sanitizeRequest,
  UNKNOWN,
  type ModelReply,
  type StopResolveReply,
} from '@/lib/llm/stop-resolve';

export type { StopResolveReply };

export const runtime = 'nodejs';
export const maxDuration = 15;

/**
 * How long a rider waits for the optional layer before we give up on it.
 *
 * This lands on top of ~700ms of recognition, and the deterministic answer is
 * already sitting on the client. Anything slower than this is worse than the
 * answer we already have.
 */
const LLM_TIMEOUT_MS = 2500;

/** Guards against a client (or a bug) shipping the whole 923-stop list upstream. */
const MAX_CANDIDATES = 8;
const MAX_TRANSCRIPTS = 8;

const SYSTEM = `You disambiguate Mongolian bus stop names for a blind rider in Ulaanbaatar.

You are given what a speech recognizer heard (several competing transcripts, best first)
and a list of candidate stops that a fuzzy matcher already found. Decide which candidate
the rider meant.

RULES — these are absolute:
- You may ONLY choose an id from the candidate list. Never invent a stop, a name, or an id.
- If no candidate is clearly right, do not guess. Ask instead.
- A wrong destination strands a blind person in the wrong district. Asking costs three
  seconds. When genuinely unsure, always ask.

How to judge: the recognizer mangles proper nouns it does not know, so compare by SOUND,
not spelling. Mongolian case endings (-аас, -руу, -д, -т) are grammar, not part of the name.
Riders shorten long names and use colloquial forms.

Choose one action:
- "resolved"  — one candidate is clearly what the rider said. Give its id and your confidence.
- "ask"       — say which question to ask:
                  "which_one"    two or more candidates are plausible; list their ids (max 3)
                  "did_you_say"  one candidate is likely but not certain; give its id
                  "say_again"    the transcripts are too garbled to work with
                  "use_list"     nothing here resembles a stop name
- "unknown"   — you cannot help; the app falls back to its own ranking.`;

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['resolved', 'ask', 'unknown'] },
    stopId: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    question: { type: 'string', enum: [...QUESTIONS] },
    stopIds: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['action'],
} as const;

/**
 * One provider per process, not one per request.
 *
 * Building it re-reads env and re-validates the key; doing that per utterance
 * adds latency to the one path that cannot afford it. A failed construction is
 * cached too — a deployment with no key should not retry the same throw on
 * every request.
 */
let cached: { provider: LlmProvider | null } | null = null;
function provider(): LlmProvider | null {
  return cached?.provider ?? null;
}
async function ensureProvider(): Promise<LlmProvider | null> {
  if (cached) return cached.provider;
  try {
    cached = { provider: await selectLlmProvider() };
  } catch (e) {
    // LlmUnavailable is the expected state of a deployment that never opted in.
    if (!(e instanceof LlmUnavailable)) {
      console.error('[stop-resolve] provider init failed', e);
    }
    cached = { provider: null };
  }
  return cached.provider;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(UNKNOWN);
  }

  // Re-derived rather than trusted: only transcripts and {id,name} survive.
  const { transcripts: texts, candidates: stops } = sanitizeRequest(body, {
    maxTranscripts: MAX_TRANSCRIPTS,
    maxCandidates: MAX_CANDIDATES,
  });

  // Nothing to rerank, or nothing to rerank it against.
  if (texts.length === 0 || stops.length === 0) return NextResponse.json(UNKNOWN);

  const llm = (await ensureProvider()) ?? provider();
  if (!llm) return NextResponse.json(UNKNOWN);

  const allowed = new Set(stops.map((s) => s.id));
  const user =
    `Recognizer heard (best first):\n${texts.map((t, i) => `  ${i + 1}. "${t}"`).join('\n')}\n\n` +
    `Candidate stops:\n${stops.map((s) => `  id=${s.id} name="${s.name}"`).join('\n')}`;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LLM_TIMEOUT_MS);

  try {
    const raw = (await llm.complete({
      system: SYSTEM,
      user,
      schema: SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 256,
      signal: abort.signal,
    })) as ModelReply | null;

    // THE GATE — see lib/llm/stop-resolve.ts. Nothing the model named survives
    // this unless we supplied it.
    return NextResponse.json(
      applyModelReply(raw, allowed, (reason) =>
        console.warn(`[stop-resolve] dropped: ${reason}`),
      ),
    );
  } catch (e) {
    // Timeout, rate limit, spent quota, network — all the same to the rider,
    // and all handled the same way: the matcher's answer stands.
    if (!(e instanceof Error && e.name === 'AbortError')) {
      console.error('[stop-resolve]', e instanceof Error ? e.message : e);
    }
    return NextResponse.json(UNKNOWN);
  } finally {
    clearTimeout(timer);
  }
}
