/**
 * OpenRouter — one key, many models.
 *
 * The easiest place to A/B two models against real Mongolian stop names
 * without signing up twice, which is its whole reason for being here.
 *
 * ITS FREE TIER IS THE TIGHTEST OF THE THREE: 20 requests/minute but only
 * ~50/day until $10 of credit is bought (then ~1,000/day). The 923-stop alias
 * build needs roughly 47 batched calls, so on an untopped account that is one
 * full run per day and no room to iterate. Fine for comparing models on a
 * sample; wrong for the build.
 *
 * `openrouter/free` is an auto-router that picks among whatever free models are
 * live, which is the right default precisely because the `:free` model ids
 * rotate — a pinned one goes 404 without warning. `OPENROUTER_MODEL` overrides
 * when a specific model is being evaluated.
 */

import { LlmUnavailable, type LlmProvider } from "../provider";
import { createOpenAiCompatibleProvider } from "./openai-compatible";

const DEFAULT_MODEL = "openrouter/free";

export function createOpenRouterProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmUnavailable(
      "OPENROUTER_API_KEY is not set. Get a free key at https://openrouter.ai/keys",
    );
  }

  return createOpenAiCompatibleProvider({
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    model: env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL,
    requestsPerMinute: 20,
    // Honoured by most routed models; the ones that ignore it still get the
    // schema in the prompt via the caller's own instructions.
    supportsJsonSchema: true,
    extraHeaders: {
      "HTTP-Referer": "https://github.com/vision-access",
      "X-Title": "Vision Access",
    },
  });
}
