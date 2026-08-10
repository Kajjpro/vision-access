/**
 * Renders the gesture/tutorial phrases into public/audio/*.wav.
 *
 * These go through the ORIGINAL audio pipeline (lib/audio.ts → PHRASES → .wav),
 * not the transit Opus manifest, for one reason: iOS Safari decodes WAV
 * natively and its Ogg Opus support is unreliable. The tutorial is the first
 * thing a new user ever hears, so it must not be the thing that fails on half
 * the devices.
 *
 *   npx tsx scripts/render-ui-audio.ts [--dry-run]
 *
 * Writes WAV rather than a compressed format because these clips are short,
 * few, and decoded once at startup — the bytes are not worth a compatibility
 * risk here. The 923 stop names, where size genuinely matters, stay Opus.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";
import { selectProvider, withRetry, sleep } from "../lib/tts/provider";
import { ALL_PHRASES } from "../lib/ui/announcements";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const OUT = "public/audio";
const CACHE = ".cache/audio";
const DRY = process.argv.includes("--dry-run");

function loadEnvLocal() {
  const p = join(root, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

/**
 * Registry key → clip id. The clip id becomes the filename AND the `id` in
 * lib/phrases.ts, so it must be stable ASCII: changing one orphans a file.
 */
const TO_RENDER: { id: string; mn: string; en: string }[] = (() => {
  const out: { id: string; mn: string; en: string }[] = [];
  for (const [, phrase] of Object.entries(ALL_PHRASES)) {
    if (!phrase.clip || !phrase.mn.trim()) continue;
    // Only the WAV pipeline lives here; transit Opus clips are rendered by
    // scripts/generate-transit-audio.ts.
    if (!phrase.clip.startsWith("ui_")) continue;
    if (existsSync(join(root, OUT, `${phrase.clip}.wav`))) continue;
    out.push({ id: phrase.clip, mn: phrase.mn, en: phrase.en });
  }
  return out;
})();

async function main() {
  const provider = await selectProvider();
  const chars = TO_RENDER.reduce((a, p) => a + p.mn.length, 0);

  console.log(`UI/tutorial audio → ${OUT}/*.wav`);
  console.log(`  provider: ${provider.name} / ${provider.voice}`);
  console.log(`  phrases : ${TO_RENDER.length}`);
  console.log(`  chars   : ${chars.toLocaleString()}\n`);

  if (DRY) {
    for (const p of TO_RENDER) console.log(`  ${p.id.padEnd(30)} ${p.mn}`);
    console.log("\n--dry-run: nothing synthesized.");
    return;
  }

  await mkdir(join(root, OUT), { recursive: true });
  await mkdir(join(root, CACHE), { recursive: true });

  let rendered = 0;
  const failed: string[] = [];

  for (const phrase of TO_RENDER) {
    const dest = join(root, OUT, `${phrase.id}.wav`);
    try {
      const audio = await withRetry(() => provider.synthesize(phrase.mn), { label: phrase.id });
      const raw = join(root, CACHE, `${phrase.id}.${provider.outputFormat}`);
      await writeFile(raw, audio);
      // 22.05 kHz mono PCM matches what the existing clips already are, so the
      // whole set decodes to one consistent format at startup.
      await execFileAsync(ffmpegPath as unknown as string, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", raw,
        "-af", "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:start_silence=0.02",
        "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", dest,
      ]);
      rendered++;
      process.stdout.write(`\r  ${rendered}/${TO_RENDER.length}`);
      await sleep(150);
    } catch (e) {
      failed.push(`${phrase.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  process.stdout.write("\n");

  console.log(`\n${rendered} rendered, ${failed.length} failed`);
  for (const f of failed) console.error(`  FAIL ${f}`);

  let bytes = 0;
  for (const p of TO_RENDER) {
    try { bytes += (await stat(join(root, OUT, `${p.id}.wav`))).size; } catch { /* failed above */ }
  }
  console.log(`total ${(bytes / 1024).toFixed(1)} KB of WAV`);
  console.log(`characters spent: ${(provider.charsUsed ?? 0).toLocaleString()}`);

  console.log(`\nNow add these ids to lib/phrases.ts so loadAllClips() picks them up:`);
  for (const p of TO_RENDER.slice(0, 3)) {
    console.log(`  { id: "${p.id}", mn: "${p.mn}", en: "${p.en}", kind: "ui" },`);
  }
  console.log(`  … ${TO_RENDER.length} total (see scripts/render-ui-audio.ts output file)`);

  await writeFile(
    join(root, ".cache/ui-phrases.json"),
    JSON.stringify(TO_RENDER, null, 2),
    "utf8",
  );
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
