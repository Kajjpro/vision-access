/**
 * The exact request the Gemini provider puts on the wire, and what it does with
 * the replies.
 *
 * `fetch` is stubbed, so this proves the shape without a key or a network. It
 * is deliberately pedantic about URL, headers and body keys: Google moved this
 * API from `POST /v1beta/models/{model}:generateContent` (`contents`/`parts` →
 * `candidates[].content.parts[].text`) to `POST /v1beta/interactions`
 * (`model`/`input`/`response_format` → `steps[].content[].text`), and a wrong
 * field name fails at runtime against a live key rather than here.
 *
 * A shape that changed once will change again, which is why both are supported
 * and both are pinned.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { LlmAuthError, LlmModelNotFound, LlmQuotaError, LlmRateLimitError } from "../provider";
import { createGeminiProvider } from "./gemini";

type Captured = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch, capturing every call, replying with the queued responses. */
function stubFetch(replies: Array<{ status?: number; body: unknown }>): Captured[] {
  const calls: Captured[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies[Math.min(i++, replies.length - 1)];
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
const base = { LLM_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" };
const req = {
  system: "SYSTEM TEXT",
  user: "USER TEXT",
  schema: { type: "object", properties: { action: { type: "string" } } },
};

test("the Interactions request carries model, input, schema and the key header", async () => {
  const calls = stubFetch([{ body: { output_text: '{"action":"unknown"}' } }]);
  const p = createGeminiProvider(env({ ...base, GEMINI_MODEL: "gemini-2.5-flash-lite" }));

  assert.deepEqual(await p.complete(req), { action: "unknown" });
  assert.equal(calls.length, 1);

  const [{ url, init }] = calls;
  assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  // The key rides a header, never the query string — a URL is logged by every
  // proxy in the path.
  assert.equal(headers["x-goog-api-key"], "test-key");
  assert.ok(!url.includes("test-key"), "the key must not be in the URL");

  const body = JSON.parse(String(init.body));
  assert.equal(body.model, "gemini-2.5-flash-lite");
  assert.match(body.input, /SYSTEM TEXT/);
  assert.match(body.input, /USER TEXT/);
  assert.equal(body.response_format.mime_type, "application/json");
  assert.deepEqual(body.response_format.schema, req.schema);
});

test("the legacy endpoint is reachable by env, for when the shape moves again", async () => {
  const calls = stubFetch([
    { body: { candidates: [{ content: { parts: [{ text: '{"action":"resolved"}' }] } }] } },
  ]);
  const p = createGeminiProvider(
    env({ ...base, GEMINI_MODEL: "gemini-2.5-flash", GEMINI_API_ENDPOINT: "legacy" }),
  );

  assert.deepEqual(await p.complete(req), { action: "resolved" });

  const [{ url, init }] = calls;
  assert.equal(
    url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  );
  const body = JSON.parse(String(init.body));
  assert.equal(body.contents[0].parts[0].text, "USER TEXT");
  assert.equal(body.systemInstruction.parts[0].text, "SYSTEM TEXT");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
});

test("text is read out of steps[] when output_text is absent", async () => {
  stubFetch([
    {
      body: {
        steps: [
          { type: "thought", content: [] },
          { type: "model_output", content: [{ type: "text", text: '{"action":"ask",' }] },
          { type: "model_output", content: [{ type: "text", text: '"question":"say_again"}' }] },
        ],
      },
    },
  ]);
  const p = createGeminiProvider(env(base));
  assert.deepEqual(await p.complete(req), { action: "ask", question: "say_again" });
});

test("a 404 reports the models the key can actually reach", async () => {
  // The single most likely failure in production: free-tier lineups rotate and
  // a pinned model id quietly stops existing. A bare 404 is unactionable.
  stubFetch([
    { status: 404, body: { error: { message: "model not found" } } },
    { body: { models: [{ name: "models/gemini-2.5-flash" }, { name: "models/gemini-2.5-pro" }] } },
  ]);
  const p = createGeminiProvider(env({ ...base, GEMINI_MODEL: "gemini-does-not-exist" }));

  await assert.rejects(
    () => p.complete(req),
    (e: Error) =>
      e instanceof LlmModelNotFound &&
      /gemini-does-not-exist/.test(e.message) &&
      /gemini-2\.5-pro/.test(e.message),
  );
});

test("statuses map onto the error types that decide whether to retry", async () => {
  const cases: Array<[number, unknown, new (...a: never[]) => Error]> = [
    [400, { error: { message: "API key not valid" } }, LlmAuthError],
    [403, "forbidden", LlmAuthError],
    // Per-minute limit — retryable, and must not abort a 47-batch build.
    [429, { error: { message: "Resource exhausted", details: [] } }, LlmRateLimitError],
    // Daily cap — terminal for this run.
    [429, { error: { message: "Quota exceeded: requests per day" } }, LlmQuotaError],
  ];
  for (const [status, body, expected] of cases) {
    stubFetch([{ status, body }]);
    const p = createGeminiProvider(env(base));
    await assert.rejects(
      () => p.complete(req),
      (e: Error) => e instanceof expected,
      `${status} ${JSON.stringify(body).slice(0, 40)} should be ${expected.name}`,
    );
  }
});

test("a retry-after in the body is honoured rather than guessed at", async () => {
  stubFetch([{ status: 429, body: { error: { details: [{ retryDelay: "17s" }] } } }]);
  const p = createGeminiProvider(env(base));
  await assert.rejects(
    () => p.complete(req),
    (e: Error) => e instanceof LlmRateLimitError && e.retryAfterSeconds === 17,
  );
});

test("prose around the JSON does not lose the answer", async () => {
  stubFetch([{ body: { output_text: 'Sure!\n```json\n{"action":"unknown"}\n```' } }]);
  const p = createGeminiProvider(env(base));
  assert.deepEqual(await p.complete(req), { action: "unknown" });
});

test("requestsUsed counts, so a build can pace itself against the free tier", async () => {
  stubFetch([{ body: { output_text: "{}" } }]);
  const p = createGeminiProvider(env(base));
  assert.equal(p.requestsUsed, 0);
  await p.complete(req);
  await p.complete(req);
  assert.equal(p.requestsUsed, 2);
});
