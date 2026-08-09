/**
 * Azure Speech (Cognitive Services) REST TTS.
 *
 * F0 free tier: 500,000 characters per month, HARD CAPPED. The caller reports
 * cumulative usage per run; this module counts the characters it actually sends
 * so that figure reflects the billed unit rather than a guess.
 */
import { AuthError, QuotaError, RateLimitError, type TtsProvider } from "../provider";

const DEFAULT_VOICE = "mn-MN-YesuiNeural";

/**
 * 24 kHz 48 kbps mono mp3.
 *
 * The pipeline transcodes to Opus regardless, so this only needs to be a clean
 * intermediate — 48 kbps mp3 at 24 kHz is comfortably above the 20 kbps Opus it
 * becomes, and generational loss is inaudible at that gap.
 */
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/** Stop names contain `/` and could contain `&`; unescaped they make the SSML malformed. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildSsml(text: string, voice: string): string {
  return `<speak version="1.0" xml:lang="mn-MN"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
}

export function createAzureProvider(env: NodeJS.ProcessEnv): TtsProvider {
  const key = env.AZURE_SPEECH_KEY;
  const region = env.AZURE_SPEECH_REGION;
  const voice = env.TTS_VOICE?.trim() || DEFAULT_VOICE;

  if (!key) throw new AuthError("AZURE_SPEECH_KEY is not set.");
  if (!region) throw new AuthError("AZURE_SPEECH_REGION is not set (e.g. southeastasia).");

  const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const provider: TtsProvider = {
    name: "azure",
    voice,
    outputFormat: "mp3",
    // Azure expands numerals and reads Latin itself — verified against the
    // mn-MN voice, where "19-р байр" and "арван есдүгээр байр" render to
    // near-identical durations. So no character rewriting is needed here.
    accepts: undefined,
    maxCharsPerRequest: 8000,
    // F0 has low concurrency. This is deliberately below the documented limit;
    // 429s are handled, but not provoking them is cheaper than recovering.
    ratePerSecond: 4,
    charsUsed: 0,

    async synthesize(text: string): Promise<Buffer> {
      const ssml = buildSsml(text, voice);

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
          // Azure rejects requests without one.
          "User-Agent": "vision-access-build",
        },
        body: Buffer.from(ssml, "utf8"),
      });

      if (res.status === 401 || res.status === 403) {
        // Terminal on purpose: retrying a bad key is how a rejected credential
        // turns into a rate-limited one.
        throw new AuthError(
          `Azure ${res.status} — check AZURE_SPEECH_KEY and that AZURE_SPEECH_REGION (${region}) matches the resource.`,
        );
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        throw new RateLimitError("Azure 429 — too many requests", Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
      }
      if (res.status === 400) {
        const body = await res.text();
        throw new Error(`Azure 400 — ${body.slice(0, 300)} (SSML: ${ssml.slice(0, 160)})`);
      }
      if (!res.ok) {
        const body = await res.text();
        if (/quota|exceeded/i.test(body)) throw new QuotaError(`Azure quota exhausted — ${body.slice(0, 200)}`);
        throw new Error(`Azure ${res.status} — ${body.slice(0, 200)}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      // An empty 200 is a real failure mode and would land on disk as a file
      // that plays nothing — which at runtime is silence, the dangerous one.
      if (buf.length < 512) throw new Error(`Azure returned ${buf.length} bytes for ${JSON.stringify(text)} — not usable audio`);

      provider.charsUsed = (provider.charsUsed ?? 0) + text.length;
      return buf;
    },
  };

  return provider;
}

/** F0 allowance, for the quota line the build prints. */
export const AZURE_F0_MONTHLY_CHARS = 500_000;
