/**
 * LLM provider interface and selection.
 *
 * THE SAME BARGAIN AS lib/tts/provider.ts, FOR THE SAME REASON. Callers state
 * what they want inferred and never name a vendor; switching is `LLM_PROVIDER=`
 * rather than a refactor. That file's header records why: Chimege's free tier
 * stopped at 100 requests against a ~1,050 clip build, mid-build. Every free
 * LLM tier below has a comparable wall — Gemini 2.5 Flash is 500 requests a
 * day, OpenRouter is 50 — so plan on hitting one.
 *
 * WHAT AN LLM IS AND IS NOT ALLOWED TO DO HERE.
 *
 * It may RANK and it may ASK. It may never NAME. Every destination the rider
 * can be sent to comes from `public/transit/stops.json` via the deterministic
 * matcher; the model only reorders candidates that matcher already produced,
 * and picks which pre-rendered question to play. A model that could name a
 * stop could invent one, and a blind rider cannot see that the stop they were
 * just sent to does not exist.
 *
 * That constraint is enforced in the caller, not here — see
 * `app/api/stop-resolve/route.ts`, which drops any id it did not itself supply.
 *
 * BUILD-TIME USE IS THE SAFE ONE. `scripts/generate-stop-aliases.ts` runs this
 * over 923 stop names once, a human reviews the output, and the result ships as
 * data. No latency, no availability risk, no per-rider cost. Runtime use is
 * strictly optional and every path degrades to the matcher alone.
 */

export interface LlmRequest {
  /** Stable across calls — put the volatile part in `user` so caching can work. */
  system: string;
  user: string;
  /**
   * JSON Schema the reply must satisfy. Providers that support native
   * constrained decoding use it; the rest get it appended to the prompt and
   * their output is validated on the way back.
   */
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  /** Runtime callers MUST pass one. A rider is standing at a stop. */
  signal?: AbortSignal;
}

export interface LlmProvider {
  name: string;
  model: string;
  /**
   * Returns parsed JSON, or null when the provider answered with something
   * unusable. Null is a normal outcome, not an exception: every caller has a
   * deterministic path and takes it.
   */
  complete(req: LlmRequest): Promise<unknown | null>;
  /** Names the models this key can actually reach. Used by the doctor script. */
  listModels?(): Promise<string[]>;
  /** Cumulative requests this run, for quota reporting. */
  requestsUsed?: number;
  /** Free-tier ceiling, so a build can pace itself instead of being cut off. */
  requestsPerMinute?: number;
}

export type LlmProviderName = "gemini" | "groq" | "openrouter";

/**
 * `LLM_PROVIDER` selects; everything else is provider-specific env.
 *
 * There is deliberately no default provider and no default key. An unset
 * `LLM_PROVIDER` throws here, and every runtime caller treats that throw as
 * "the model layer is unavailable" and uses the matcher alone — which is the
 * behaviour we want on a phone with no key, not a silent fallback to a vendor
 * nobody chose.
 */
export async function selectLlmProvider(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LlmProvider> {
  const name = (env.LLM_PROVIDER ?? "").trim().toLowerCase();

  switch (name) {
    case "gemini": {
      const { createGeminiProvider } = await import("./providers/gemini");
      return createGeminiProvider(env);
    }
    case "groq": {
      const { createGroqProvider } = await import("./providers/groq");
      return createGroqProvider(env);
    }
    case "openrouter": {
      const { createOpenRouterProvider } = await import("./providers/openrouter");
      return createOpenRouterProvider(env);
    }
    case "":
      throw new LlmUnavailable(
        "LLM_PROVIDER is not set. Set it to gemini, groq, or openrouter, " +
          "or leave it unset to run without any model layer.",
      );
    default:
      throw new LlmUnavailable(
        `Unknown LLM_PROVIDER "${name}". Expected one of: gemini, groq, openrouter.`,
      );
  }
}

/**
 * No usable model layer — unset provider, missing key, unreachable service.
 *
 * Distinct from the error classes below because it is not a failure: it is the
 * expected state of a deployment that has not opted in, and callers treat it as
 * "use the deterministic path" without logging an error.
 */
export class LlmUnavailable extends Error {}

/** Bad credential. Never retried, so a wrong key cannot masquerade as a rate limit. */
export class LlmAuthError extends Error {}

/** The provider said slow down. Retried with backoff. */
export class LlmRateLimitError extends Error {
  constructor(
    message: string,
    /** Seconds the provider asked us to wait, when it said. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** The free tier is spent. Not retryable within this run. */
export class LlmQuotaError extends Error {}

/**
 * The configured model does not exist for this key.
 *
 * Carries the list the provider actually offers, because the alternative is a
 * bare 404 against a model id copied out of a blog post — and free tiers rotate
 * their model lineups faster than any hardcoded default survives.
 */
export class LlmModelNotFound extends Error {
  constructor(
    readonly requested: string,
    readonly available: string[],
  ) {
    super(
      `Model "${requested}" is not available to this key.\n` +
        (available.length
          ? `Available:\n  ${available.join("\n  ")}`
          : "The provider returned no model list."),
    );
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry with backoff, honouring the provider's own retry-after when given.
 *
 * Auth, quota and unknown-model failures are terminal — retrying a spent free
 * tier just turns a clear error into a slow one.
 */
export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  { label, attempts = 4 }: { label: string; attempts?: number },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (
        e instanceof LlmAuthError ||
        e instanceof LlmQuotaError ||
        e instanceof LlmModelNotFound ||
        e instanceof LlmUnavailable
      ) {
        throw e;
      }
      if (attempt === attempts) break;

      const asked = e instanceof LlmRateLimitError ? e.retryAfterSeconds : undefined;
      const backoffMs = asked !== undefined ? asked * 1000 : Math.min(30_000, 2 ** attempt * 1000);
      console.warn(
        `  ${label}: ${e instanceof Error ? e.message : e} — retry ${attempt}/${attempts - 1} in ${Math.round(backoffMs / 1000)}s`,
      );
      await sleep(backoffMs);
    }
  }
  throw lastError;
}

/**
 * Parse a model's reply as JSON, tolerating the wrappers they add anyway.
 *
 * Even with a response schema attached, providers return fenced code blocks and
 * leading prose often enough that a strict `JSON.parse` throws away good
 * answers. Returns null rather than throwing — an unparseable reply is just an
 * absent one, and every caller already handles absent.
 */
export function parseJsonReply(text: string | null | undefined): unknown | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: the outermost {...} or [...] in the string.
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
