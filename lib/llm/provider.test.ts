/**
 * The provider layer: selection, reply parsing, and what happens with no key.
 *
 * The last of those is the one that matters most in production. This whole
 * feature is optional, and the overwhelmingly common deployment — a phone with
 * no `LLM_PROVIDER` set — must reach "no model layer" cleanly and let the
 * deterministic matcher answer. An exception escaping here would take down the
 * destination flow to add a feature nobody enabled.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  LlmAuthError,
  LlmModelNotFound,
  LlmQuotaError,
  LlmRateLimitError,
  LlmUnavailable,
  parseJsonReply,
  selectLlmProvider,
  withLlmRetry,
} from "./provider";

/**
 * A fake environment.
 *
 * Cast through `unknown` because `ProcessEnv` carries an index signature these
 * object literals do not satisfy — and `next build` type-checks more strictly
 * than a bare `tsc --noEmit`, so the shorter cast compiles locally and then
 * fails the build.
 */
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

// ----------------------------------------------------------------- selection

test("no LLM_PROVIDER is a clean unavailable, not a crash", async () => {
  // The default deployment. Must be distinguishable from a real failure so the
  // caller can stay silent instead of logging an error every utterance.
  await assert.rejects(() => selectLlmProvider(env({})), LlmUnavailable);
});

test("an unknown provider name names the ones that exist", async () => {
  await assert.rejects(
    () => selectLlmProvider(env({ LLM_PROVIDER: "chatgpt" })),
    (e: Error) => e instanceof LlmUnavailable && /gemini, groq, openrouter/.test(e.message),
  );
});

test("a selected provider with no key is unavailable, not misconfigured-silent", async () => {
  for (const provider of ["gemini", "groq", "openrouter"]) {
    await assert.rejects(
      () => selectLlmProvider(env({ LLM_PROVIDER: provider })),
      LlmUnavailable,
      `${provider} with no key`,
    );
  }
});

test("each provider builds once its key is present, and names its own limits", async () => {
  const gemini = await selectLlmProvider(env({
    LLM_PROVIDER: "gemini",
    GEMINI_API_KEY: "test-key",
  }));
  assert.equal(gemini.name, "gemini");
  assert.ok(gemini.model.length > 0, "a default model is chosen");
  assert.ok((gemini.requestsPerMinute ?? 0) > 0, "the free-tier ceiling is known, for pacing");

  const groq = await selectLlmProvider(env({
    LLM_PROVIDER: "groq",
    GROQ_API_KEY: "k",
  }));
  assert.equal(groq.name, "groq");

  const or = await selectLlmProvider(env({
    LLM_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "k",
  }));
  assert.equal(or.name, "openrouter");
});

test("GEMINI_MODEL overrides the default, because free lineups rotate", async () => {
  const p = await selectLlmProvider(env({
    LLM_PROVIDER: "gemini",
    GEMINI_API_KEY: "k",
    GEMINI_MODEL: "gemini-3.6-flash",
  }));
  assert.equal(p.model, "gemini-3.6-flash");
});

// -------------------------------------------------------------- reply parsing

test("fenced and prose-wrapped JSON still parses", () => {
  // Providers do this even with a response schema attached, and a strict
  // JSON.parse would discard perfectly good answers.
  const want = { action: "resolved", stopId: "s1" };
  assert.deepEqual(parseJsonReply('{"action":"resolved","stopId":"s1"}'), want);
  assert.deepEqual(parseJsonReply('```json\n{"action":"resolved","stopId":"s1"}\n```'), want);
  assert.deepEqual(parseJsonReply('```\n{"action":"resolved","stopId":"s1"}\n```'), want);
  assert.deepEqual(
    parseJsonReply('Here is the answer:\n{"action":"resolved","stopId":"s1"}\nHope that helps!'),
    want,
  );
});

test("an unparseable reply is null, never a throw", () => {
  // Null is a normal outcome — the caller has a deterministic path and takes it.
  for (const input of ["", "   ", null, undefined, "not json at all", "{broken", "```json\n```"]) {
    assert.equal(parseJsonReply(input), null, `input: ${JSON.stringify(input)}`);
  }
});

test("arrays parse too — batch replies are arrays", () => {
  assert.deepEqual(parseJsonReply('[{"id":"1"}]'), [{ id: "1" }]);
});

// ------------------------------------------------------------------- retrying

test("terminal errors are not retried — a spent quota fails fast", async () => {
  // Retrying an exhausted free tier converts a clear error into a slow one, and
  // during a 47-batch build that is minutes of backoff for a known outcome.
  for (const err of [
    new LlmAuthError("bad key"),
    new LlmQuotaError("spent"),
    new LlmModelNotFound("m", []),
    new LlmUnavailable("off"),
  ]) {
    let calls = 0;
    await assert.rejects(
      () =>
        withLlmRetry(
          async () => {
            calls++;
            throw err;
          },
          { label: "t", attempts: 4 },
        ),
      (e: Error) => e === err,
    );
    assert.equal(calls, 1, `${err.constructor.name} must not be retried`);
  }
});

test("a rate limit is retried and can succeed", async () => {
  let calls = 0;
  const out = await withLlmRetry(
    async () => {
      calls++;
      if (calls === 1) throw new LlmRateLimitError("slow down", 0);
      return "ok";
    },
    { label: "t", attempts: 3 },
  );
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});

test("retries are bounded — a dead provider does not hang the build", async () => {
  let calls = 0;
  await assert.rejects(() =>
    withLlmRetry(
      async () => {
        calls++;
        throw new LlmRateLimitError("nope", 0);
      },
      { label: "t", attempts: 3 },
    ),
  );
  assert.equal(calls, 3);
});

test("LlmModelNotFound reports what the key can actually reach", () => {
  // A bare 404 against a model id copied out of a blog post is unactionable;
  // the available list is the whole point of the error type.
  const e = new LlmModelNotFound("gemini-9-ultra", ["gemini-2.5-flash", "gemini-2.5-flash-lite"]);
  assert.match(e.message, /gemini-9-ultra/);
  assert.match(e.message, /gemini-2\.5-flash-lite/);
});
