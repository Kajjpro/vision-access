/**
 * Tier 3: one still frame and one question to a vision-language model.
 *
 * Keeps the key server-side, exactly as /api/stt does — the browser must never
 * see it, and this route is the only file that changes if the provider does.
 *
 * ── NOT CONFIGURED IN THIS PROJECT, AND THAT IS THE DEFAULT ────────────────
 *
 * No `VISION_API_KEY` is set. This route answers 503 and the router degrades to
 * an honest decline, which is the path the suite covers and the behaviour that
 * ships. The implementation below is written against the OpenAI-compatible
 * chat-completions shape that Gemini, OpenRouter and Groq all speak, so setting
 * a key and a base URL is the whole of enabling it — but it has never been run
 * against a live model and nothing here should be described as verified.
 *
 * ── WHY THE QUESTION GOES WITH THE IMAGE ───────────────────────────────────
 *
 * "Describe this image" returns a paragraph about the wallpaper. The user asked
 * something specific and waited several seconds for it; the model answers that
 * and stops. The system prompt is the one in lib/ask/providers.ts, kept there so
 * the constraints are reviewable beside the interface rather than buried in a
 * route.
 */

import { NextRequest, NextResponse } from "next/server";

import { VISION_SYSTEM_PROMPT } from "@/lib/ask/providers";

export const runtime = "nodejs";
export const maxDuration = 25;

/** One frame. Larger than this is a photograph nobody needs to send. */
const MAX_BYTES = 1_200_000;
/** Two short sentences. The cap is enforced here as well as asked for. */
const MAX_TOKENS = 120;

export async function POST(req: NextRequest) {
  const key = process.env.VISION_API_KEY;
  const base = process.env.VISION_API_BASE;
  const model = process.env.VISION_MODEL;

  if (!key || !base || !model) {
    // Distinct from a failure: the capability is absent, not broken. The client
    // turns this into "I cannot analyse this" rather than an error.
    return NextResponse.json({ error: "vision model not configured" }, { status: 503 });
  }

  let body: { image?: string; question?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const image = body.image ?? "";
  const question = (body.question ?? "").slice(0, 300);
  if (!image.startsWith("data:image/") || image.length > MAX_BYTES) {
    return NextResponse.json({ error: "bad image" }, { status: 400 });
  }
  if (!question.trim()) {
    return NextResponse.json({ error: "no question" }, { status: 400 });
  }

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: question },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
    }

    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return NextResponse.json({ error: "empty answer" }, { status: 502 });

    // NOTHING IS RETAINED. The frame existed for the duration of this request
    // and is not written anywhere.
    return NextResponse.json({ text });
  } catch (e) {
    const reason = e instanceof Error ? e.name : "unknown";
    return NextResponse.json({ error: `vision request failed: ${reason}` }, { status: 502 });
  }
}
