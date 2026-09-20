/**
 * Shared implementation for the OpenAI-shaped free tiers.
 *
 * Groq and OpenRouter both expose `POST /chat/completions` with bearer auth and
 * a `choices[].message.content` reply, so they differ only in base URL, default
 * model, headers, and free-tier ceiling. One implementation, two thin wrappers
 * — the alternative is the same forty lines twice, drifting apart on the day
 * one of them changes its error shape.
 *
 * Neither is the default. See the header of `./gemini.ts` for why: these models
 * handle Cyrillic Mongolian less reliably, and this is the layer that decides
 * where a blind rider is told to travel.
 */

import {
  LlmAuthError,
  LlmModelNotFound,
  LlmQuotaError,
  LlmRateLimitError,
  parseJsonReply,
  type LlmProvider,
  type LlmRequest,
} from "../provider";

export interface OpenAiCompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  requestsPerMinute: number;
  /** Referer/title headers and the like. */
  extraHeaders?: Record<string, string>;
  /**
   * Whether the provider accepts a full JSON Schema in `response_format`.
   * When false it gets `{type:"json_object"}` and the schema goes in the
   * prompt, which is weaker but universally supported.
   */
  supportsJsonSchema: boolean;
}

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string; code?: string | number };
};

function classify(status: number, body: string, model: string, vendor: string): Error {
  if (status === 401 || status === 403) {
    return new LlmAuthError(`${vendor} rejected the key (${status}): ${body.slice(0, 200)}`);
  }
  if (status === 404 || /model_not_found|no endpoints found/i.test(body)) {
    return new LlmModelNotFound(model, []);
  }
  if (status === 402 || /insufficient|credits/i.test(body)) {
    return new LlmQuotaError(`${vendor} free allowance is spent: ${body.slice(0, 200)}`);
  }
  if (status === 429) {
    if (/per day|daily/i.test(body)) {
      return new LlmQuotaError(`${vendor} daily free quota is spent: ${body.slice(0, 200)}`);
    }
    const retry = /try again in ([\d.]+)s/i.exec(body);
    return new LlmRateLimitError(
      `${vendor} rate limit: ${body.slice(0, 160)}`,
      retry ? Math.ceil(Number(retry[1])) : undefined,
    );
  }
  return new Error(`${vendor} ${status}: ${body.slice(0, 200)}`);
}

export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): LlmProvider {
  const provider: LlmProvider = {
    name: config.name,
    model: config.model,
    requestsUsed: 0,
    requestsPerMinute: config.requestsPerMinute,

    async listModels(): Promise<string[]> {
      try {
        const res = await fetch(`${config.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${config.apiKey}`, ...config.extraHeaders },
        });
        if (!res.ok) return [];
        const data = (await res.json()) as { data?: Array<{ id?: string }> };
        return (data.data ?? []).map((m) => m.id ?? "").filter(Boolean).sort();
      } catch {
        return [];
      }
    },

    async complete(req: LlmRequest): Promise<unknown | null> {
      // Without native schema support the shape has to be stated in the prompt,
      // or the model answers in prose and every reply parses to null.
      const system = config.supportsJsonSchema
        ? req.system
        : `${req.system}\n\nReply with JSON only, matching this schema exactly:\n${JSON.stringify(req.schema)}`;

      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          ...config.extraHeaders,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: req.user },
          ],
          max_tokens: req.maxOutputTokens ?? 2048,
          response_format: config.supportsJsonSchema
            ? { type: "json_schema", json_schema: { name: "reply", strict: true, schema: req.schema } }
            : { type: "json_object" },
        }),
        signal: req.signal,
      });

      provider.requestsUsed = (provider.requestsUsed ?? 0) + 1;

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = classify(res.status, text, config.model, config.name);
        if (err instanceof LlmModelNotFound) {
          throw new LlmModelNotFound(config.model, (await provider.listModels?.()) ?? []);
        }
        throw err;
      }

      const data = (await res.json()) as ChatResponse;
      return parseJsonReply(data.choices?.[0]?.message?.content);
    },
  };

  return provider;
}
