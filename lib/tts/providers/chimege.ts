/**
 * Chimege TTS — the original provider, kept as an implementation rather than
 * deleted.
 *
 * Its free tier stops at 100 requests and the project token is currently
 * suspended (HTTP 403 "Suspended API token"), so it is not the default. The 84
 * UI clips in public/audio/ were rendered with it and its voice remains the
 * reference for how the app already sounds.
 *
 * Note the charset: Chimege accepts Cyrillic plus `? ! . - ' " : ,` and 400s on
 * everything else. Digits, slashes and Latin all fail, which is why stop names
 * need rewriting into words before they can be sent through this provider —
 * see lib/transit/speech.ts.
 */
import { AuthError, QuotaError, RateLimitError, type TtsProvider } from "../provider";

const ENDPOINT = "https://api.chimege.com/v1.2/synthesize";

/** Verified against the live API, not just the docs. */
export const CHIMEGE_ACCEPTS = /^[Ѐ-ӿ ?!.\-'":,]+$/;

export function createChimegeProvider(env: NodeJS.ProcessEnv): TtsProvider {
  const token = env.CHIMEGE_TOKEN;
  if (!token) throw new AuthError("CHIMEGE_TOKEN is not set.");
  const voice = env.TTS_VOICE?.trim() || env.CHIMEGE_VOICE?.trim() || "default";

  const provider: TtsProvider = {
    name: "chimege",
    voice,
    outputFormat: "wav",
    accepts: CHIMEGE_ACCEPTS,
    ratePerSecond: 4,
    charsUsed: 0,

    async synthesize(text: string): Promise<Buffer> {
      const headers: Record<string, string> = {
        token,
        // Plain text, NOT SSML — Chimege treats markup as illegal characters.
        "Content-Type": "text/plain; charset=utf-8",
      };
      if (voice && voice !== "default") headers["voice-id"] = voice;

      const res = await fetch(ENDPOINT, { method: "POST", headers, body: Buffer.from(text, "utf8") });
      const body = Buffer.from(await res.arrayBuffer());
      const asText = () => body.toString("utf8").trim().slice(0, 200);

      if (res.status === 401) throw new AuthError(`Chimege 401 — ${asText()}`);
      if (res.status === 403) {
        // What the project token returns now. Retrying cannot fix it.
        throw new QuotaError(`Chimege 403 — ${asText()} (free tier is 100 requests)`);
      }
      if (res.status === 429) throw new RateLimitError(`Chimege 429 — ${asText()}`);
      if (!res.ok) throw new Error(`Chimege ${res.status} — ${asText()}`);

      // Chimege returns its errors as HTTP 200 with a text body. Without this
      // the error prose is written to disk as a file that plays nothing.
      if (body.subarray(0, 4).toString("ascii") !== "RIFF") {
        throw new Error(`Chimege returned non-audio — ${asText()}`);
      }

      provider.charsUsed = (provider.charsUsed ?? 0) + text.length;
      return body;
    },
  };

  return provider;
}
