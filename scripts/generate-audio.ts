/**
 * Pre-renders every phrase in lib/phrases.ts to public/audio/<id>.wav.
 *
 *   npx tsx scripts/generate-audio.ts              # provider from TTS_PROVIDER
 *   npx tsx scripts/generate-audio.ts --dry-run    # plan + char count, no calls
 *   npx tsx scripts/generate-audio.ts --force         # re-encode, no API calls
 *   npx tsx scripts/generate-audio.ts --resynthesize  # re-call the API (costs quota)
 *
 * This script never names a vendor — it asks lib/tts for a provider and uses
 * the interface, the same as scripts/generate-transit-audio.ts. Swapping
 * engines is an env change (TTS_PROVIDER=), not a refactor; Chimege's free
 * tier already forced one such switch mid-build.
 *
 * Clips are cached under .cache/audio/, keyed by a hash of PROVIDER + VOICE +
 * TEXT — the same cache directory and key shape the transit build uses, since
 * it is the same underlying fact: this exact text has already been paid for
 * with this exact voice. Without the provider and voice in the key, a switch
 * would silently mix two voices across public/audio/, which for someone who
 * cannot see the screen is far worse than a mispronounced word — it reads as
 * a different, unexplained voice interrupting the one they were following.
 *
 * public/audio/manifest.json remembers which hash produced each on-disk file,
 * so an unrelated phrase edit does not re-spend quota on 84 other clips, and a
 * provider/voice switch is detected even though the filename never changes.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";
import { AuthError, QuotaError, selectProvider, withRetry, type TtsProvider } from "../lib/tts/provider";
import { AZURE_F0_MONTHLY_CHARS } from "../lib/tts/providers/azure";
import { PHRASES } from "../lib/phrases";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const args = new Set(process.argv.slice(2));

const OUT_DIR = "public/audio";
// Shared with scripts/generate-transit-audio.ts on purpose: both scripts cache
// the same thing — provider's own audio for a given (provider, voice, text) —
// and a phrase that happens to match a transit clip's text should not be paid
// for twice.
const CACHE_DIR = ".cache/audio";
const MANIFEST = "public/audio/manifest.json";
const USAGE_FILE = ".cache/tts-usage.json";

/** `--force` re-ENCODES from cached provider audio; `--resynthesize` re-calls the API. */
const FORCE = args.has("--force") || args.has("--resynthesize");
const RESYNTH = args.has("--resynthesize");
const DRY_RUN = args.has("--dry-run");

if (!existsSync(join(root, "public"))) {
  console.error(`No public/ under ${root} — run this from the project root.`);
  process.exit(1);
}

function loadEnvLocal() {
  const path = join(root, ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, name, raw] = match;
    if (!process.env[name]) process.env[name] = raw.replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

/** PROVIDER + VOICE + text. All three, so a switch cannot mix voices silently. */
const clipHash = (provider: TtsProvider, text: string) =>
  createHash("sha256").update(`${provider.name}\n${provider.voice}\n${text}`, "utf8").digest("hex");

type ManifestEntry = { sha: string; provider: string; voice: string };

// ------------------------------------------------------------------ encode

/**
 * Trim the leading silence the Azure engine adds (~200ms measured on real
 * clips — see generate-transit-audio.ts) and land on plain 16-bit PCM WAV,
 * which is what every existing clip already is and what decodeAudioData wants
 * with the least work. 24kHz mono matches Azure's own source rate, so this is
 * a format change, not a resample.
 */
const TRIM_FILTER = "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:start_silence=0.02";
const WAV_ARGS = ["-af", TRIM_FILTER, "-c:a", "pcm_s16le", "-ac", "1", "-ar", "24000"];

async function toWav(srcPath: string, dest: string): Promise<void> {
  // From a file, not a pipe: promisify(execFile) has no `input` option, so a
  // pipe-based version leaves ffmpeg waiting on stdin that never arrives.
  await execFileAsync(ffmpegPath as unknown as string, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", srcPath, ...WAV_ARGS, dest,
  ]);
}

// ------------------------------------------------------------------- usage

type Usage = { month: string; chars: Record<string, number> };

function loadUsage(): Usage {
  const month = new Date().toISOString().slice(0, 7);
  const path = join(root, USAGE_FILE);
  if (!existsSync(path)) return { month, chars: {} };
  try {
    const u = JSON.parse(readFileSync(path, "utf8")) as Usage;
    return u.month === month ? u : { month, chars: {} };
  } catch {
    return { month, chars: {} };
  }
}

async function persistUsage(usage: Usage, provider: TtsProvider) {
  usage.chars[provider.name] = (usage.chars[provider.name] ?? 0) + (provider.charsUsed ?? 0);
  await mkdir(join(root, ".cache"), { recursive: true });
  await writeFile(join(root, USAGE_FILE), JSON.stringify(usage, null, 2), "utf8");
}

// -------------------------------------------------------------------- main

async function main() {
  const seen = new Set<string>();
  for (const phrase of PHRASES) {
    if (seen.has(phrase.id)) {
      console.error(`Duplicate id "${phrase.id}" — ids are filenames and must be unique.`);
      process.exit(1);
    }
    seen.add(phrase.id);
  }

  const provider = await selectProvider();
  console.log(`Vision Access — phrase audio pre-render`);
  console.log(`  provider : ${provider.name}`);
  console.log(`  voice    : ${provider.voice}\n`);

  const rejected = provider.accepts
    ? PHRASES.filter((p) => !provider.accepts!.test(p.mn))
    : [];
  if (rejected.length) {
    console.error(`${rejected.length} phrases contain characters ${provider.name} rejects:`);
    for (const p of rejected) console.error(`  ${p.id}  ${JSON.stringify(p.mn)}`);
    process.exit(1);
  }

  const chars = PHRASES.reduce((a, p) => a + p.mn.length, 0);
  console.log(`  phrases: ${PHRASES.length}   characters if all re-synthesized: ${chars.toLocaleString()}`);

  await mkdir(join(root, OUT_DIR), { recursive: true });
  await mkdir(join(root, CACHE_DIR), { recursive: true });

  const manifest: Record<string, ManifestEntry> = existsSync(join(root, MANIFEST))
    ? JSON.parse(readFileSync(join(root, MANIFEST), "utf8"))
    : {};

  const usage = loadUsage();
  const alreadyThisMonth = usage.chars[provider.name] ?? 0;

  const toRender = PHRASES.filter((p) => {
    const hash = clipHash(provider, p.mn);
    const dest = join(root, OUT_DIR, `${p.id}.wav`);
    const entry = manifest[p.id];
    if (!FORCE && entry?.sha === hash && existsSync(dest)) return false;
    const cached = join(root, CACHE_DIR, `${hash}.${provider.outputFormat}`);
    return RESYNTH || !existsSync(cached);
  });
  const newChars = toRender.reduce((a, p) => a + p.mn.length, 0);

  console.log(`  cached already: ${PHRASES.length - toRender.length}   to synthesize: ${toRender.length} (${newChars.toLocaleString()} chars)`);

  if (provider.name === "azure") {
    const after = alreadyThisMonth + newChars;
    const pct = ((after / AZURE_F0_MONTHLY_CHARS) * 100).toFixed(1);
    console.log(`  F0 quota: ${alreadyThisMonth.toLocaleString()} used this month → ${after.toLocaleString()} / ${AZURE_F0_MONTHLY_CHARS.toLocaleString()} (${pct}%)`);
    if (after > AZURE_F0_MONTHLY_CHARS) {
      console.error(`\n  This run would exceed the F0 monthly allowance. Aborting before spending it.`);
      process.exit(1);
    }
  }

  if (DRY_RUN) {
    console.log(`\nDry run — no files written.`);
    return;
  }

  let rendered = 0;
  let reencoded = 0;
  const skipped = PHRASES.length - toRender.length;
  const failed: string[] = [];

  // Sequential: a rate limit here should back off, not fan out into more of them.
  for (const phrase of PHRASES) {
    const hash = clipHash(provider, phrase.mn);
    const dest = join(root, OUT_DIR, `${phrase.id}.wav`);
    const entry = manifest[phrase.id];

    if (!FORCE && entry?.sha === hash && existsSync(dest)) {
      continue;
    }

    const cachedRaw = join(root, CACHE_DIR, `${hash}.${provider.outputFormat}`);

    try {
      if (RESYNTH || !existsSync(cachedRaw)) {
        const audio = await withRetry(() => provider.synthesize(phrase.mn), { label: phrase.id });
        await writeFile(cachedRaw, audio);
        rendered++;
      } else {
        reencoded++;
      }

      await toWav(cachedRaw, dest);
      manifest[phrase.id] = { sha: hash, provider: provider.name, voice: provider.voice };
      console.log(`write  ${phrase.id}.wav  "${phrase.mn}"`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`FAIL   ${phrase.id}.wav  ${message}`);
      failed.push(phrase.id);
      if (e instanceof AuthError || e instanceof QuotaError) break; // terminal; no point continuing
    }
  }

  await writeFile(join(root, MANIFEST), JSON.stringify(manifest, null, 2), "utf8");
  await persistUsage(usage, provider);

  console.log(`\n${rendered} synthesized, ${reencoded} re-encoded from cache, ${skipped} already current, ${failed.length} failed`);
  console.log(`characters spent this run: ${(provider.charsUsed ?? 0).toLocaleString()}`);
  if (failed.length > 0) {
    console.error(`Re-run to retry: ${failed.join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
