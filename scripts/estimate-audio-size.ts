/**
 * Projects the transit audio payload from real Chimege renders.
 *
 * Written because the Chimege token was suspended (HTTP 403 "Suspended API
 * token") partway through the first full render, so the 923 stop clips could
 * not all be measured directly. Rather than guess, this calibrates against the
 * 85 clips already on disk from the existing pipeline — real Chimege output,
 * known source text — encodes them at each candidate bitrate, and fits bytes
 * against text length.
 *
 *   npx tsx scripts/estimate-audio-size.ts
 *
 * Replace with real measurements once the token works: this script exists to
 * answer the bundle-vs-lazy question, not to become part of the build.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";
import { PHRASES } from "../lib/phrases";
import { CARDINALS, FIXED_PHRASES, loadNumberWords, stopNameToSpeech } from "../lib/transit/speech";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const BITRATES = ["16k", "20k", "24k"];

async function encodedSize(wav: string, bitrate: string, tmp: string): Promise<number> {
  const out = join(tmp, `${bitrate}.opus`);
  await execFileAsync(ffmpegPath as unknown as string, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", wav,
    "-c:a", "libopus", "-b:a", bitrate, "-ac", "1", "-ar", "48000", "-application", "voip", out,
  ]);
  return statSync(out).size;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "va-audio-"));

  // --- calibration set: real Chimege WAVs with known text
  const samples: { chars: number; wavBytes: number; opus: Record<string, number> }[] = [];
  for (const p of PHRASES) {
    const wav = join(root, "public/audio", `${p.id}.wav`);
    if (!existsSync(wav)) continue;
    const opus: Record<string, number> = {};
    for (const b of BITRATES) opus[b] = await encodedSize(wav, b, tmp);
    samples.push({ chars: p.mn.length, wavBytes: statSync(wav).size, opus });
  }

  // Anything rendered before the token was suspended is a real transit clip.
  const transitDir = join(root, "public/audio/transit");
  let realTransit = 0;
  if (existsSync(transitDir)) {
    realTransit = (await import("node:fs")).readdirSync(transitDir).filter((f) => f.endsWith(".opus")).length;
  }

  console.log(`Calibration: ${samples.length} real Chimege clips, ${realTransit} transit clips rendered before suspension\n`);

  /**
   * Opus at a fixed bitrate is near-CBR, so bytes are dominated by DURATION,
   * and duration tracks character count closely for a single voice. Fitting
   * bytes = intercept + slope*chars captures both the per-clip container
   * overhead and the speech itself.
   */
  const fit = (b: string) => {
    const n = samples.length;
    const sx = samples.reduce((a, s) => a + s.chars, 0);
    const sy = samples.reduce((a, s) => a + s.opus[b], 0);
    const sxy = samples.reduce((a, s) => a + s.chars * s.opus[b], 0);
    const sxx = samples.reduce((a, s) => a + s.chars * s.chars, 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    // Residual spread, so the projection can carry an honest error bar.
    const resid = samples.map((s) => s.opus[b] - (intercept + slope * s.chars));
    const rmse = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / n);
    return { slope, intercept, rmse };
  };

  // --- the texts we would actually send
  const table = loadNumberWords(JSON.parse(readFileSync(join(root, "data/number-words.json"), "utf8")));
  const stops: { id: string; name: string }[] = JSON.parse(
    readFileSync(join(root, "public/transit/stops.json"), "utf8"),
  );
  const stopTexts = stops.map((s) => {
    const r = stopNameToSpeech(s.name, table);
    return { id: s.id, text: r.ok ? r.text : "" };
  });
  const numberTexts = Object.values(CARDINALS);
  const phraseTexts = FIXED_PHRASES.map((p) => p.mn);

  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

  console.log("bitrate   stops(923)      numbers+phrases    TOTAL        median   max     ±rmse/clip");
  console.log("-".repeat(92));

  const results: Record<string, { total: number; stops: number; mandatory: number }> = {};
  for (const b of BITRATES) {
    const { slope, intercept, rmse } = fit(b);
    const predict = (t: string) => Math.max(intercept + slope * t.length, 400);

    const stopBytes = stopTexts.reduce((a, s) => a + predict(s.text), 0);
    const numBytes = numberTexts.reduce((a, t) => a + predict(t), 0);
    const phraseBytes = phraseTexts.reduce((a, t) => a + predict(t), 0);
    const mandatory = numBytes + phraseBytes;

    const sizes = stopTexts.map((s) => predict(s.text)).sort((a, b2) => a - b2);
    results[b] = { total: stopBytes + mandatory, stops: stopBytes, mandatory };

    console.log(
      `${b.padEnd(9)} ${mb(stopBytes).padStart(9)}  ${kb(mandatory).padStart(16)}  ${mb(stopBytes + mandatory).padStart(9)}  ` +
        `${kb(sizes[sizes.length >> 1]).padStart(8)} ${kb(sizes[sizes.length - 1]).padStart(8)}  ±${(rmse / 1024).toFixed(2)} KB`,
    );
  }

  // --- largest single route, the unit a lazy strategy would fetch
  const routeStops: Record<string, Record<string, string[]>> = JSON.parse(
    readFileSync(join(root, "public/transit/route-stops.json"), "utf8"),
  );
  const textById = new Map(stopTexts.map((s) => [s.id, s.text]));
  console.log();
  for (const b of BITRATES) {
    const { slope, intercept } = fit(b);
    const predict = (t: string) => Math.max(intercept + slope * t.length, 400);
    let worst = { id: "", stops: 0, bytes: 0 };
    for (const [rid, dirs] of Object.entries(routeStops)) {
      const ids = [...new Set(Object.values(dirs).flat())];
      const bytes = ids.reduce((a, id) => a + predict(textById.get(id) ?? ""), 0);
      if (bytes > worst.bytes) worst = { id: rid, stops: ids.length, bytes };
    }
    console.log(`  at ${b}: largest single route ${worst.id} — ${worst.stops} stops, ${kb(worst.bytes)}`);
  }

  console.log(`\n  fit calibrated on ${samples.length} real clips; chars→bytes is near-linear at fixed bitrate.`);
  console.log(`  Median WAV in the calibration set: ${kb(samples.map((s) => s.wavBytes).sort((a, b2) => a - b2)[samples.length >> 1])}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
