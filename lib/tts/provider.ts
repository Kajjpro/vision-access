/**
 * TTS provider interface and selection.
 *
 * Build-time only. No provider module is ever imported by client code, and no
 * key any of them uses reaches the browser.
 *
 * The build script talks to this interface and never names a vendor. We have
 * already hit one provider wall — Chimege's free tier stopped at 100 requests
 * against a ~1,050 clip build — and the next one should cost an env var, not a
 * refactor.
 */

export type AudioFormat = "wav" | "mp3";

export interface TtsProvider {
  name: string;
  voice: string;
  synthesize(text: string): Promise<Buffer>;
  maxCharsPerRequest?: number;
  ratePerSecond?: number;

  /**
   * Container the returned buffer holds. Providers differ — Chimege returns
   * RIFF WAV, Azure returns mp3 — and the transcode step needs to know which
   * without sniffing bytes.
   */
  outputFormat: AudioFormat;

  /**
   * Characters this engine will accept. Chimege 400s on digits, slashes and
   * Latin, so its text has to be rewritten into words first; Azure expands
   * numerals itself and needs no such table. Callers use this to decide how
   * much preprocessing a string needs, rather than hardcoding a vendor quirk.
   */
  accepts?: RegExp;

  /** Cumulative characters sent this run, for quota reporting. */
  charsUsed?: number;
}

export type ProviderName = "azure" | "chimege" | "mms";

/**
 * `TTS_PROVIDER` selects; everything else is provider-specific env.
 *
 * Defaults to azure because that is the provider with quota. Note that
 * `TTS_PROVIDER` and `TTS_VOICE` were NOT present in .env.local when this was
 * written — only AZURE_SPEECH_KEY and AZURE_SPEECH_REGION — so the defaults
 * here are what actually run unless they get added.
 */
export async function selectProvider(env: NodeJS.ProcessEnv = process.env): Promise<TtsProvider> {
  const name = (env.TTS_PROVIDER ?? "azure").trim().toLowerCase() as ProviderName;

  switch (name) {
    case "azure": {
      const { createAzureProvider } = await import("./providers/azure");
      return createAzureProvider(env);
    }
    case "chimege": {
      const { createChimegeProvider } = await import("./providers/chimege");
      return createChimegeProvider(env);
    }
    case "mms": {
      const { createMmsProvider } = await import("./providers/mms");
      return createMmsProvider(env);
    }
    default:
      throw new Error(`Unknown TTS_PROVIDER "${name}". Expected one of: azure, chimege, mms.`);
  }
}

/** Raised for a bad credential — never retried, so a wrong key cannot become a rate limit. */
export class AuthError extends Error {}

/** Raised when the provider says "slow down". Retried with backoff. */
export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** Raised when the account has no quota left. Retrying cannot help. */
export class QuotaError extends Error {}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries a synthesize call on rate limits only.
 *
 * Auth and quota failures are terminal by design: hammering a suspended token
 * is how the Chimege key went from "rate limited" to "suspended".
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 5, baseMs = 1000, label = "" }: { attempts?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AuthError || e instanceof QuotaError) throw e;
      lastError = e;
      if (!(e instanceof RateLimitError) || i === attempts - 1) throw e;
      const wait = e.retryAfterMs ?? baseMs * 2 ** i;
      console.log(`    429${label ? ` on ${label}` : ""} — backing off ${(wait / 1000).toFixed(1)}s (attempt ${i + 1}/${attempts})`);
      await sleep(wait);
    }
  }
  throw lastError;
}
