/**
 * Groq — the fast one.
 *
 * Its LPU hardware is the lowest-latency free tier by a wide margin, and
 * latency is the thing that matters most at a bus stop, where the round trip
 * lands on top of Azure's ~700ms recognition. The free tier is also the most
 * generous surveyed: 30 requests/minute, ~14,400/day, no card.
 *
 * NOT THE DEFAULT ANYWAY. Its free lineup is Llama and Qwen/DeepSeek distills,
 * whose Cyrillic Mongolian is weaker than Gemini's — and this layer decides
 * where a blind rider is sent. Qwen3 is the pick of them for Mongolian, so it
 * is the default here; `GROQ_MODEL` overrides.
 *
 * Worth reaching for if Gemini's per-minute ceiling becomes the binding
 * constraint, or if the free-tier training term (see ./gemini.ts) is not
 * acceptable and Groq's terms are.
 */

import { LlmUnavailable, type LlmProvider } from "../provider";
import { createOpenAiCompatibleProvider } from "./openai-compatible";

const DEFAULT_MODEL = "qwen/qwen3-32b";

export function createGroqProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const apiKey = env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmUnavailable(
      "GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys",
    );
  }

  return createOpenAiCompatibleProvider({
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey,
    model: env.GROQ_MODEL?.trim() || DEFAULT_MODEL,
    requestsPerMinute: 30,
    supportsJsonSchema: false,
  });
}
