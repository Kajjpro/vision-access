/**
 * Renders the comparison clips the /dev/audio listening harness plays.
 *
 *   npx tsx scripts/render-listening-set.ts
 *   npx tsx scripts/render-listening-set.ts --dry-run
 *
 * Dev-only output under .cache/listening/ — never referenced by the app and
 * never copied into a production build.
 *
 * Three questions, in the order they cost to reverse:
 *
 *   1. VOICE. Yesui vs Bataa on real stop names. Re-encoding is free, so the
 *      bitrate is reversible at zero cost; changing voice means re-synthesizing
 *      every clip and spending real characters. This is the expensive decision
 *      and the one the pilot exists to settle.
 *   2. NUMERALS. Every digit-bearing pilot stop name, rendered BOTH ways — as
 *      digits for the engine to expand, and through data/number-words.json.
 *      Matching durations only proved the engine spoke for the same length of
 *      time; they say nothing about whether the ordinal suffix was right, and
 *      Mongolian ordinals are exactly where a prose-trained voice slips.
 *   3. STRESS. The longest and most sibilant names at the shipping bitrate.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import ffmpegPath from "ffmpeg-static";
import { createAzureProvider } from "../lib/tts/providers/azure";
import { sleep, withRetry } from "../lib/tts/provider";
import { loadNumberWords, stopNameToSpeech, toSpeechText } from "../lib/transit/speech";
import { CHIMEGE_ACCEPTS } from "../lib/tts/providers/chimege";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");

// Deliberately NOT under public/. Anything in public/ ships to production even
// when the page that uses it 404s, and 876 KB of A/B clips have no business in
// a build aimed at a phone on mobile data. A dev-only route handler streams
// these from here instead.
const OUT = ".cache/listening";
const CACHE = ".cache/audio";
const MANIFEST = ".cache/listening/listening.json";
const BITRATE = "16k";
const TRIM = "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:start_silence=0.02";

const PILOT_ROUTES = ["11100730", "11100350", "11100612", "11101800"];
const VOICE_A = "mn-MN-YesuiNeural";
const VOICE_B = "mn-MN-BataaNeural";

function loadEnvLocal() {
  const p = join(root, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

const hash = (provider: string, voice: string, text: string) =>
  createHash("sha256").update(`${provider}\n${voice}\n${text}`, "utf8").digest("hex");

async function encode(src: string, dest: string) {
  await execFileAsync(ffmpegPath as unknown as string, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", src,
    "-af", TRIM, "-c:a", "libopus", "-b:a", BITRATE, "-ac", "1", "-ar", "48000", "-application", "voip", dest,
  ]);
}

async function main() {
  const stops: { id: string; name: string }[] = JSON.parse(
    readFileSync(join(root, "public/transit/stops.json"), "utf8"),
  );
  const routeStops: Record<string, Record<string, string[]>> = JSON.parse(
    readFileSync(join(root, "public/transit/route-stops.json"), "utf8"),
  );
  const table = loadNumberWords(JSON.parse(readFileSync(join(root, "data/number-words.json"), "utf8")));

  const pilotIds = new Set(PILOT_ROUTES.flatMap((r) => Object.values(routeStops[r]).flat()));
  const pilot = stops.filter((s) => pilotIds.has(s.id));

  // --- 1. voice: 10 names spanning short/long/sibilant/numeric
  const byLen = [...pilot].sort((a, b) => a.name.length - b.name.length);
  const sibilance = (n: string) => (n.match(/[сшщцжзч]/gi) ?? []).length;
  const voiceSet = [
    ...byLen.slice(0, 2),
    ...byLen.slice(-2),
    ...[...pilot].sort((a, b) => sibilance(b.name) - sibilance(a.name)).slice(0, 3),
    ...pilot.filter((s) => /\d/.test(s.name)).slice(0, 3),
  ]
    .filter((s, i, a) => a.findIndex((x) => x.id === s.id) === i)
    .slice(0, 10);

  // --- 2. numerals: every digit-bearing pilot name, both ways
  const numeralSet = pilot.filter((s) => /\d/.test(s.name));

  // --- 3. stress
  const stressSet = [
    ...byLen.slice(-4).map((s) => ({ s, note: "longest" })),
    ...[...pilot].sort((a, b) => sibilance(b.name) - sibilance(a.name)).slice(0, 4).map((s) => ({ s, note: "most sibilant" })),
  ].filter((x, i, a) => a.findIndex((y) => y.s.id === x.s.id) === i);

  // Everything that needs synthesizing, deduplicated by (voice, text).
  const jobs = new Map<string, { voice: string; text: string }>();
  const add = (voice: string, text: string) => {
    const h = hash("azure", voice, text);
    if (!jobs.has(h)) jobs.set(h, { voice, text });
    return h;
  };

  const voiceCompare = voiceSet.map((s) => ({
    id: s.id,
    display: s.name,
    text: toSpeechText(s.name),
    a: add(VOICE_A, toSpeechText(s.name)),
    b: add(VOICE_B, toSpeechText(s.name)),
  }));

  const numeralCompare: {
    id: string; display: string; engineText: string; wordsText: string | null;
    engine: string; words: string | null; reason?: string;
  }[] = [];
  for (const s of numeralSet) {
    const engineText = toSpeechText(s.name);
    const w = stopNameToSpeech(s.name, table, CHIMEGE_ACCEPTS);
    numeralCompare.push({
      id: s.id,
      display: s.name,
      engineText,
      wordsText: w.ok ? w.text : null,
      engine: add(VOICE_A, engineText),
      words: w.ok ? add(VOICE_A, w.text) : null,
      reason: w.ok ? undefined : w.reason,
    });
  }

  const stress = stressSet.map(({ s, note }) => ({
    id: s.id, display: s.name, note, text: toSpeechText(s.name), clip: add(VOICE_A, toSpeechText(s.name)),
  }));

  // What is already cached costs nothing.
  const pending = [...jobs.entries()].filter(([h, j]) => !existsSync(join(root, CACHE, `${h}.mp3`)));
  const chars = pending.reduce((a, [, j]) => a + j.text.length, 0);

  console.log(`Listening set:`);
  console.log(`  voice A/B      : ${voiceCompare.length} names × 2 voices`);
  console.log(`  numeral A/B    : ${numeralCompare.length} names × 2 forms`);
  console.log(`  stress         : ${stress.length} names`);
  console.log(`  distinct clips : ${jobs.size}  (cached ${jobs.size - pending.length}, to synthesize ${pending.length})`);
  console.log(`  characters     : ${chars.toLocaleString()}`);

  const unmapped = numeralCompare.filter((n) => !n.words);
  if (unmapped.length) {
    console.log(`\n  ${unmapped.length} names have no word-form (token missing from number-words.json):`);
    for (const u of unmapped.slice(0, 8)) console.log(`    ${u.display} — ${u.reason}`);
  }

  if (DRY) {
    console.log(`\n--dry-run: nothing synthesized.`);
    return;
  }

  await mkdir(join(root, OUT), { recursive: true });
  await mkdir(join(root, CACHE), { recursive: true });

  // One provider per voice; the interface carries the voice, so this is just
  // two instances rather than a special case.
  const providers = new Map(
    [VOICE_A, VOICE_B].map((v) => [v, createAzureProvider({ ...process.env, TTS_VOICE: v })]),
  );

  let n = 0;
  for (const [h, job] of jobs) {
    const cache = join(root, CACHE, `${h}.mp3`);
    const dest = join(root, OUT, `${h}.opus`);
    if (!existsSync(cache)) {
      const provider = providers.get(job.voice)!;
      const audio = await withRetry(() => provider.synthesize(job.text), { label: job.text.slice(0, 24) });
      await writeFile(cache, audio);
      await sleep(250);
    }
    await encode(cache, dest);
    if (++n % 20 === 0) process.stdout.write(`\r  ${n}/${jobs.size}`);
  }
  process.stdout.write(`\r  ${jobs.size}/${jobs.size}\n`);

  await writeFile(
    join(root, MANIFEST),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        bitrate: BITRATE,
        voiceA: VOICE_A,
        voiceB: VOICE_B,
        clipDir: "/dev/audio/clip",
        voiceCompare,
        numeralCompare,
        stress,
      },
      null,
      2,
    ),
    "utf8",
  );

  const spent = [...providers.values()].reduce((a, p) => a + (p.charsUsed ?? 0), 0);
  console.log(`\nWrote ${MANIFEST}`);
  console.log(`Characters spent: ${spent.toLocaleString()}`);
  console.log(`\nOpen http://localhost:3000/dev/audio`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
