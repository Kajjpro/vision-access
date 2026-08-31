/**
 * Google Gemini, via the Interactions API.
 *
 * Chosen as the default for one reason: of the free tiers surveyed it has the
 * strongest Mongolian. Groq is faster and far more generous, but its free
 * lineup (Llama / Qwen / DeepSeek distills) handles Cyrillic Mongolian
 * noticeably worse, and a wrong stop name costs a blind rider a trip across
 * Ulaanbaatar.
 *
 * TWO ENDPOINTS EXIST AND THIS USES THE NEWER ONE. `POST /v1beta/interactions`
 * (`{model, input, response_format}` → `steps[].content[].text`) is GA and is
 * what Google's own quickstart now shows; the older
 * `/v1beta/models/{model}:generateContent` (`{contents:[{parts:[…]}]}` →
 * `candidates[].content.parts[].text`) still works. `GEMINI_API_ENDPOINT=legacy`
 * switches back, because a shape this recently changed will change again and
 * the fallback should not require editing this file.
 *
 * THE MODEL ID IS NOT HARDCODED-AND-HOPED. Free tiers rotate their lineups, so
 * a 404 here resolves the real list from `GET /v1beta/models` and reports it
 * (`LlmModelNotFound`) instead of surfacing a bare status code against an id
 * copied out of a blog post.
 *
 * ⚠️ PRIVACY, AND IT IS NOT A DETAIL. Google's terms permit training on
 * FREE-TIER prompts (paid tier and Vertex do not). Anything sent here may be
 * retained and trained on. The runtime caller therefore sends the transcript
 * and candidate stop NAMES only — never coordinates, never a device or rider
 * identifier, never travel history. Read that restriction as load-bearing:
 * this app's whole privacy posture is "camera frames never leave the device",
 * and a spoken destination is the one thing that now does.
 */

import {
  LlmAuthError,
  LlmModelNotFound,
  LlmQuotaError,
  LlmRateLimitError,
  LlmUnavailable,
  parseJsonReply,
  type LlmProvider,
  type LlmRequest,
} from "../provider";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Flash-Lite by default: the free tier's highest request ceiling (15/min,
 * ~1000/day versus Flash's 10/min, ~500/day), and this asks for a ranking over
 * a short candidate list rather than open-ended generation. Override with
 * `GEMINI_MODEL` — `gemini-2.5-flash` and `gemini-3.6-flash` are the usual
 * upgrades when a name needs more judgement than Lite has.
 */
const DEFAULT_MODEL = "gemini-2.5-flash-lite";

type InteractionsResponse = {
  output_text?: string;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
};

type LegacyResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

/** Every text fragment the reply carries, in order. */
function textFrom(data: InteractionsResponse | LegacyResponse): string {
  const interactions = data as InteractionsResponse;
  if (typeof interactions.output_text === "string" && interactions.output_text.trim()) {
    return interactions.output_text;
  }
  if (Array.isArray(interactions.steps)) {
    const parts: string[] = [];
    for (const step of interactions.steps) {
      for (const block of step.content ?? []) {
        if (typeof block.text === "string") parts.push(block.text);
      }
    }
    if (parts.length) return parts.join("");
  }
  const legacy = data as LegacyResponse;
  const parts = legacy.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

/** Map a transport status onto the typed errors `withLlmRetry` knows to stop on. */
function classify(status: number, body: string, model: string): Error {
  if (status === 400 && /API key not valid/i.test(body)) {
    return new LlmAuthError("GEMINI_API_KEY is not valid.");
  }
  if (status === 401 || status === 403) {
    return new LlmAuthError(`Gemini rejected the key (${status}): ${body.slice(0, 200)}`);
  }
  if (status === 404) {
    // Caller upgrades this to LlmModelNotFound with the real list attached.
    return new LlmModelNotFound(model, []);
  }
  if (status === 429) {
    // Free tier is both rate-limited per minute and capped per day, and the
    // same status covers both. The daily cap says "quota"; treat the rest as
    // backoff-able so a per-minute limit does not abort a 47-call build.
    if (/per day|daily|quota exceeded/i.test(body)) {
      return new LlmQuotaError(`Gemini free-tier daily quota is spent: ${body.slice(0, 200)}`);
    }
    const retry = /"retryDelay"\s*:\s*"(\d+)s"/.exec(body);
    return new LlmRateLimitError(
      `Gemini rate limit: ${body.slice(0, 160)}`,
      retry ? Number(retry[1]) : undefined,
    );
  }
  return new Error(`Gemini ${status}: ${body.slice(0, 200)}`);
}

export function createGeminiProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const key = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
  if (!key) {
    throw new LlmUnavailable(
      "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey",
    );
  }

  const model = env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const legacy = env.GEMINI_API_ENDPOINT?.trim().toLowerCase() === "legacy";

  async function listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${BASE}/models`, { headers: { "x-goog-api-key": key! } });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
      };
      return (data.models ?? [])
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean)
        .sort();
    } catch {
      return [];
    }
  }

  const provider: LlmProvider = {
    name: "gemini",
    model,
    requestsUsed: 0,
    // The stricter of the two documented free ceilings, so pacing a build
    // against this is safe whichever model is selected.
    requestsPerMinute: 10,
    listModels,

    async complete(req: LlmRequest): Promise<unknown | null> {
      const url = legacy
        ? `${BASE}/models/${encodeURIComponent(model)}:generateContent`
        : `${BASE}/interactions`;

      const body = legacy
        ? {
            systemInstruction: { parts: [{ text: req.system }] },
            contents: [{ role: "user", parts: [{ text: req.user }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: req.schema,
              maxOutputTokens: req.maxOutputTokens ?? 2048,
            },
          }
        : {
            model,
            // The Interactions API takes one `input`; the system half is
            // prepended rather than sent separately, which keeps the stable
            // text first and so still cache-friendly.
            input: `${req.system}\n\n---\n\n${req.user}`,
            response_format: {
              type: "text",
              mime_type: "application/json",
              schema: req.schema,
            },
            max_output_tokens: req.maxOutputTokens ?? 2048,
          };

      const res = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": key!, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: req.signal,
      });

      provider.requestsUsed = (provider.requestsUsed ?? 0) + 1;

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = classify(res.status, text, model);
        // Turn a bare 404 into something actionable before it escapes.
        if (err instanceof LlmModelNotFound) throw new LlmModelNotFound(model, await listModels());
        throw err;
      }

      return parseJsonReply(textFrom((await res.json()) as InteractionsResponse));
    },
  };

  return provider;
}
