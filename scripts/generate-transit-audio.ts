/**
 * Pre-renders every phrase the bus modes speak: stop names, cardinals 1–40, the
 * fixed phrases, and the route clips. TTS is a BUILD-TIME call only — nothing
 * here runs at request time and no provider key reaches the browser.
 *
 *   npx tsx scripts/generate-transit-audio.ts              # provider from TTS_PROVIDER
 *   npx tsx scripts/generate-transit-audio.ts --stage=routes
 *   npx tsx scripts/generate-transit-audio.ts --dry-run    # plan + char count, no calls
 *   npx tsx scripts/generate-transit-audio.ts --force         # re-encode, no API calls
 *   npx tsx scripts/generate-transit-audio.ts --resynthesize  # re-call the API (costs quota)
 *   TTS_ROUTES=11100730,10000500 npx tsx scripts/generate-transit-audio.ts
 *
 * This script never names a vendor. It asks lib/tts for a provider and uses the
 * interface; swapping engines is an env change. We have already been forced off
 * one provider mid-build, so that property is load-bearing rather than tidy.
 *
 * Clips are keyed by a content hash of PROVIDER + VOICE + the exact text sent.
 * Including the provider and voice is what stops a switch from silently mixing
 * two voices inside one manifest — a stop name in one voice followed by
 * "Одоо буугаарай" in another would be disorienting to a listener who cannot
 * see the screen to work out why.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";
import { AuthError, QuotaError, selectProvider, sleep, withRetry, type TtsProvider } from "../lib/tts/provider";
import { AZURE_F0_MONTHLY_CHARS } from "../lib/tts/providers/azure";
import {
  CARDINALS,
  FIXED_PHRASES,
  loadNumberWords,
  routeSpokenNameToSpeech,
  stopNameToSpeech,
  type NumberWords,
} from "../lib/transit/speech";

const execFileAsync = promisify(execFile);

const OUT_DIR = "public/audio/transit";
const CACHE_DIR = ".cache/audio";
const MANIFEST = "public/audio/transit/manifest.json";
const USAGE_FILE = ".cache/tts-usage.json";
const TODO_FILE = "speech.todo.json";
const NUMBER_WORDS = "data/number-words.json";
const ROUTE_NAMES = "data/route-names.json";

const root = process.cwd();
const args = new Set(process.argv.slice(2));

/**
 * 16 kbps Opus VOIP, mono. Chosen from measurement, against expectation.
 *
 * The worry was sibilants: Mongolian stop names are dense with `-с`, `-ш`,
 * `-ц`, `-ж`, and a softened fricative on a phone speaker on a moving bus is
 * the difference between hearing "Саппоро" and guessing at it. Measured on the
 * pilot set, RMS retention in the 4–8 kHz sibilant band against the Azure
 * source is:
 *
 *     16k  -1.85 dB      20k  -1.83 dB      24k  -1.75 dB
 *
 * A 0.1 dB spread across the whole range — inaudible. Opus allocates bits by
 * perceptual importance, so on this 24 kHz neural source the loss lives in the
 * transform rather than in the bitrate, and paying for 24k buys nothing. That
 * settles the payload at 3.55 MB projected full-city, under the 4 MB line, and
 * the whole lazy-load + service-worker architecture stays unbuilt.
 *
 * This is a band-energy proxy, not a listening test. A native check on the
 * pilot clips is still the gate before a full-city render.
 *
 * The cache holds the PROVIDER'S OWN audio, so re-encoding at another bitrate
 * costs no API calls: --bitrate=20k re-encodes locally in seconds.
 */
const OPUS_BITRATE = [...args].find((a) => a.startsWith("--bitrate="))?.split("=")[1] ?? "16k";

/**
 * Trim the leading silence the engine adds.
 *
 * Measured at ~199 ms on every Azure clip — 9.7% of a mean 2.05 s clip. Cutting
 * it is worth more than the bytes: it is 200 ms shaved off the front of every
 * announcement, and "Одоо буугаарай" is a clip whose whole value is arriving
 * while the user is still at the door.
 *
 * `start_silence=0.02` keeps 20 ms of lead-in so the first phoneme is not
 * clipped — a truncated consonant is harder to recognise than a short pause.
 */
const TRIM_FILTER = "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:start_silence=0.02";

const OPUS_ARGS = [
  "-af", TRIM_FILTER,
  "-c:a", "libopus", "-b:a", OPUS_BITRATE, "-ac", "1", "-ar", "48000", "-application", "voip",
];

/**
 * An iOS-safe twin of every clip.
 *
 * Safari's Ogg Opus support is unreliable — `decodeAudioData` can simply reject
 * — and a bus rider whose stop names silently fail to decode is exactly the
 * user this app exists for. AAC in an MP4 container is decoded natively by
 * every iOS version we target.
 *
 * Both variants are shipped; the client picks at runtime. 32 kbps AAC is a
 * little larger than 16 kbps Opus, but it is only paid by devices that need it.
 */
const AAC_ARGS = [
  "-af", TRIM_FILTER,
  "-c:a", "aac", "-b:a", "32k", "-ac", "1", "-ar", "24000", "-movflags", "+faststart",
];

/**
 * `--force` re-ENCODES from cached provider audio; it does not re-synthesize.
 * Changing the bitrate or the trim filter must never cost API characters —
 * that is the entire reason the cache holds the provider's audio rather than
 * the Opus. `--resynthesize` is the explicit, expensive one.
 */
const FORCE = args.has("--force") || args.has("--resynthesize");
const RESYNTH = args.has("--resynthesize");
const DRY_RUN = args.has("--dry-run");
const STAGE = [...args].find((a) => a.startsWith("--stage="))?.split("=")[1] ?? "all";

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

type Clip = {
  /** Manifest key. Stable, ASCII — changing it orphans the file on disk. */
  key: string;
  /** The exact text handed to the provider. The hash is taken over this. */
  text: string;
  kind: "stop" | "number" | "phrase" | "route";
};

type ManifestEntry = {
  path: string;
  /** iOS-safe AAC twin. Safari's Ogg Opus decoding is unreliable. */
  pathAac?: string;
  durationMs: number;
  sha: string;
  provider?: string;
  voice?: string;
  bitrate?: string;
};

/** PROVIDER + VOICE + text. All three, so a switch cannot mix voices silently. */
const clipHash = (provider: TtsProvider, text: string) =>
  createHash("sha256").update(`${provider.name}\n${provider.voice}\n${text}`, "utf8").digest("hex");

// ------------------------------------------------------------------ encode

async function toAac(srcPath: string, dest: string): Promise<void> {
  await execFileAsync(ffmpegPath as unknown as string, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", srcPath, ...AAC_ARGS, dest,
  ]);
}

async function toOpus(srcPath: string, dest: string): Promise<void> {
  // Encodes from a FILE, not a pipe: promisify(execFile) has no `input` option
  // — that belongs to execFileSync — so a pipe-based version left ffmpeg
  // waiting on a pipe:0 that never received data, and hung with no error.
  await execFileAsync(ffmpegPath as unknown as string, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", srcPath, ...OPUS_ARGS, dest,
  ]);
}

/** ffprobe is not shipped with ffmpeg-static, so duration comes from the decode log. */
async function probeDurationMs(file: string): Promise<number> {
  const parse = (stderr: string) => {
    const d = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr);
    if (d) return Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000);
    const t = /time=(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
    if (t) return Math.round((Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])) * 1000);
    return 0;
  };
  try {
    const { stderr } = await execFileAsync(ffmpegPath as unknown as string, [
      "-hide_banner", "-i", file, "-f", "null", "-",
    ]);
    return parse(stderr);
  } catch (e) {
    return parse((e as { stderr?: string }).stderr ?? "");
  }
}

// ------------------------------------------------------------- clip list

function buildClipList(provider: TtsProvider): {
  clips: Clip[];
  failures: { key: string; display: string; reason: string }[];
  skippedRoutes: boolean;
  pilotRoutes: string[] | null;
} {
  const failures: { key: string; display: string; reason: string }[] = [];
  const clips: Clip[] = [];

  const table: NumberWords = loadNumberWords(JSON.parse(readFileSync(join(root, NUMBER_WORDS), "utf8")));

  for (const p of FIXED_PHRASES) clips.push({ key: p.id, text: p.mn, kind: "phrase" });

  for (let n = 1; n <= 40; n++) {
    const word = CARDINALS[n];
    if (!word) {
      failures.push({ key: `num_${n}`, display: String(n), reason: "no cardinal defined" });
      continue;
    }
    clips.push({ key: `num_${n}`, text: word, kind: "number" });
  }

  const stops: { id: string; name: string }[] = JSON.parse(
    readFileSync(join(root, "public/transit/stops.json"), "utf8"),
  );

  /**
   * Pilot scope. Numbers and fixed phrases are always rendered whole — they are
   * tiny and every route needs them — but stop clips can be limited to a few
   * routes, so the countdown gets proven on a real bus before a full-city
   * render is committed to a capped monthly allowance.
   */
  const pilotRoutes = (process.env.TTS_ROUTES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let wantedStops: { id: string; name: string }[] = stops;
  if (pilotRoutes.length) {
    const routeStops: Record<string, Record<string, string[]>> = JSON.parse(
      readFileSync(join(root, "public/transit/route-stops.json"), "utf8"),
    );
    const unknown = pilotRoutes.filter((r) => !routeStops[r]);
    if (unknown.length) {
      throw new Error(`TTS_ROUTES names routes that are not in route-stops.json: ${unknown.join(", ")}`);
    }
    const wanted = new Set(pilotRoutes.flatMap((r) => Object.values(routeStops[r]).flat()));
    wantedStops = stops.filter((s) => wanted.has(s.id));
  }

  for (const s of wantedStops) {
    const r = stopNameToSpeech(s.name, table, provider.accepts);
    if (!r.ok) {
      failures.push({ key: `stop_${s.id}`, display: s.name, reason: r.reason });
      continue;
    }
    clips.push({ key: `stop_${s.id}`, text: r.text, kind: "stop" });
  }

  let skippedRoutes = false;
  const routeNamesPath = join(root, ROUTE_NAMES);
  if (!existsSync(routeNamesPath)) {
    skippedRoutes = true;
  } else {
    const raw = JSON.parse(readFileSync(routeNamesPath, "utf8")) as Record<string, unknown>;
    const routes: { id: string; displayName: string }[] = JSON.parse(
      readFileSync(join(root, "public/transit/routes.json"), "utf8"),
    );
    const wanted = pilotRoutes.length ? routes.filter((r) => pilotRoutes.includes(r.id)) : routes;
    for (const route of wanted) {
      const entry = raw[route.displayName];
      const spoken = typeof entry === "string" ? entry : String((entry as { spokenName?: string })?.spokenName ?? "");
      const r = routeSpokenNameToSpeech(spoken);
      if (!r.ok) {
        failures.push({ key: `route_${route.id}`, display: route.displayName, reason: r.reason });
        continue;
      }
      clips.push({ key: `route_${route.id}`, text: r.text, kind: "route" });
    }
  }

  return { clips, failures, skippedRoutes, pilotRoutes: pilotRoutes.length ? pilotRoutes : null };
}

// ---------------------------------------------------------------- usage

type Usage = { month: string; chars: Record<string, number> };

function loadUsage(): Usage {
  const month = new Date().toISOString().slice(0, 7);
  const path = join(root, USAGE_FILE);
  if (!existsSync(path)) return { month, chars: {} };
  try {
    const u = JSON.parse(readFileSync(path, "utf8")) as Usage;
    // The F0 allowance resets monthly; a stale month must not suppress the warning.
    return u.month === month ? u : { month, chars: {} };
  } catch {
    return { month, chars: {} };
  }
}

/**
 * Preserves the clips already paid for under the old cache scheme.
 *
 * The first pipeline keyed on `${voice}\n${text}` with voice "default". Adding
 * the provider to the key would have orphaned those files and silently re-spent
 * the allowance re-rendering them.
 */
async function migrateLegacyCache(provider: TtsProvider, clips: Clip[]): Promise<number> {
  if (provider.name !== "chimege") return 0;
  let moved = 0;
  for (const clip of clips) {
    const legacy = join(root, CACHE_DIR, `${createHash("sha256").update(`default\n${clip.text}`, "utf8").digest("hex")}.wav`);
    const current = join(root, CACHE_DIR, `${clipHash(provider, clip.text)}.wav`);
    if (existsSync(legacy) && !existsSync(current)) {
      await rename(legacy, current);
      moved++;
    }
  }
  return moved;
}

// ------------------------------------------------------------------ main

async function main() {
  const provider = await selectProvider();
  console.log(`Vision Access — transit audio pre-render`);
  console.log(`  provider : ${provider.name}`);
  console.log(`  voice    : ${provider.voice}`);
  console.log(`  encode   : Opus mono ${OPUS_BITRATE}`);
  console.log(`  numerals : ${provider.accepts ? "rewritten to words (engine rejects digits)" : "sent as-is (engine expands them)"}\n`);

  const { clips, failures, skippedRoutes, pilotRoutes } = buildClipList(provider);
  const selected = STAGE === "all" ? clips : clips.filter((c) => c.kind === STAGE.replace(/s$/, ""));

  const byKind = selected.reduce<Record<string, number>>((a, c) => ((a[c.kind] = (a[c.kind] ?? 0) + 1), a), {});
  const chars = selected.reduce((a, c) => a + c.text.length, 0);

  if (pilotRoutes) console.log(`  PILOT SCOPE — TTS_ROUTES=${pilotRoutes.join(",")}`);
  console.log(`  clips: ${selected.length}  ${JSON.stringify(byKind)}`);
  console.log(`  characters this run: ${chars.toLocaleString()}`);

  if (skippedRoutes) {
    console.log(`\n  ! ${ROUTE_NAMES} not found — route clips SKIPPED.`);
    console.log(`    Fill route-names.todo.json and save it there, then: npm run audio:routes`);
    console.log(`    Nothing else re-renders; the cache is keyed by provider + voice + text.\n`);
  }

  // A stop we cannot speak is a stop the countdown reaches and says nothing at.
  if (failures.length) {
    await writeFile(join(root, TODO_FILE), JSON.stringify(failures, null, 2), "utf8");
    console.error(`\n${failures.length} clips could not be prepared — wrote ${TODO_FILE}`);
    for (const f of failures.slice(0, 10)) console.error(`  ${f.key}  ${JSON.stringify(f.display)}  ${f.reason}`);
    process.exit(1);
  }

  await mkdir(join(root, OUT_DIR), { recursive: true });
  await mkdir(join(root, CACHE_DIR), { recursive: true });

  const migrated = await migrateLegacyCache(provider, clips);
  if (migrated) console.log(`  re-keyed ${migrated} already-paid-for clips into the provider-aware cache\n`);

  const manifest: Record<string, ManifestEntry> = existsSync(join(root, MANIFEST))
    ? JSON.parse(readFileSync(join(root, MANIFEST), "utf8"))
    : {};

  const usage = loadUsage();
  const alreadyThisMonth = usage.chars[provider.name] ?? 0;

  // What the run will actually spend, after the cache is taken into account.
  const toRender = selected.filter((c) => {
    const hash = clipHash(provider, c.text);
    const cached = join(root, CACHE_DIR, `${hash}.${provider.outputFormat}`);
    const dest = join(root, OUT_DIR, `${c.key}.opus`);
    const entry = manifest[c.key];
    if (!FORCE && entry?.sha === hash && entry.bitrate === OPUS_BITRATE && existsSync(dest)) return false;
    return RESYNTH || !existsSync(cached);
  });
  const newChars = toRender.reduce((a, c) => a + c.text.length, 0);

  console.log(`  cached already: ${selected.length - toRender.length}   to synthesize: ${toRender.length} (${newChars.toLocaleString()} chars)`);
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
    console.log(`\n--dry-run: nothing synthesized.`);
    return;
  }

  let rendered = 0;
  let fromCache = 0;
  let unchanged = 0;
  const errors: string[] = [];
  const minIntervalMs = provider.ratePerSecond ? Math.ceil(1000 / provider.ratePerSecond) : 0;
  let lastCall = 0;

  for (const [i, clip] of selected.entries()) {
    const hash = clipHash(provider, clip.text);
    const rel = `${OUT_DIR.replace("public/", "")}/${clip.key}.opus`;
    const dest = join(root, OUT_DIR, `${clip.key}.opus`);
    const cacheFile = join(root, CACHE_DIR, `${hash}.${provider.outputFormat}`);

    const entry = manifest[clip.key];
    if (!FORCE && entry?.sha === hash && entry.bitrate === OPUS_BITRATE && existsSync(dest)) {
      unchanged++;
      continue;
    }

    try {
      if (!RESYNTH && existsSync(cacheFile)) {
        fromCache++;
      } else {
        const wait = lastCall + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        lastCall = Date.now();
        const audio = await withRetry(() => provider.synthesize(clip.text), { label: clip.key });
        await writeFile(cacheFile, audio);
        rendered++;
      }
      await toOpus(cacheFile, dest);
      await toAac(cacheFile, dest.replace(/\.opus$/, ".m4a"));
      manifest[clip.key] = {
        path: `/${rel}`,
        pathAac: `/${rel.replace(/\.opus$/, ".m4a")}`,
        durationMs: await probeDurationMs(dest),
        sha: hash,
        provider: provider.name,
        voice: provider.voice,
        bitrate: OPUS_BITRATE,
      };
    } catch (e) {
      if (e instanceof AuthError || e instanceof QuotaError) {
        // Terminal. Persist what was spent and stop rather than burning the rest
        // of the allowance against a credential that will not work.
        await persistUsage(usage, provider);
        await writeFile(join(root, MANIFEST), JSON.stringify(manifest, null, 2), "utf8");
        console.error(`\n${e.message}`);
        console.error(`Stopped after ${rendered} clips. ${provider.charsUsed ?? 0} characters spent this run.`);
        process.exit(1);
      }
      errors.push(`${clip.key} (${JSON.stringify(clip.text)}): ${e instanceof Error ? e.message : String(e)}`);
    }

    if ((i + 1) % 25 === 0) process.stdout.write(`\r  ${i + 1}/${selected.length}`);
  }
  process.stdout.write(`\r  ${selected.length}/${selected.length}\n`);

  await persistUsage(usage, provider);

  console.log(`\n${rendered} synthesized, ${fromCache} from cache, ${unchanged} unchanged, ${errors.length} failed`);
  if (errors.length) {
    for (const e of errors.slice(0, 10)) console.error(`  FAIL ${e}`);
    console.error(`\n${errors.length} clips failed. A missing clip becomes silence at runtime — build stopped.`);
    process.exit(1);
  }

  // Every selected key must be in the manifest. A gap is a clip the app looks
  // up, does not find, and plays nothing for.
  const missing = selected.filter((c) => !manifest[c.key]);
  if (missing.length) {
    console.error(`\n${missing.length} keys missing from the manifest: ${missing.slice(0, 5).map((m) => m.key).join(", ")}`);
    process.exit(1);
  }

  // Mixed voices inside one manifest would be audible and confusing.
  const voices = new Set(Object.values(manifest).map((m) => `${m.provider}/${m.voice}`));
  if (voices.size > 1) {
    console.log(`\n  ! manifest mixes ${voices.size} provider/voice combinations: ${[...voices].join(", ")}`);
    console.log(`    Re-render with --force to make it uniform before shipping.`);
  }

  await writeFile(join(root, MANIFEST), JSON.stringify(manifest, null, 2), "utf8");
  await report(selected, manifest, provider);
}

async function persistUsage(usage: Usage, provider: TtsProvider) {
  usage.chars[provider.name] = (usage.chars[provider.name] ?? 0) + (provider.charsUsed ?? 0);
  await mkdir(join(root, CACHE_DIR), { recursive: true });
  await writeFile(join(root, USAGE_FILE), JSON.stringify(usage, null, 2), "utf8");
}

async function report(clips: Clip[], manifest: Record<string, ManifestEntry>, provider: TtsProvider) {
  const sizes = new Map<string, number>();
  for (const c of clips) {
    try {
      sizes.set(c.key, (await stat(join(root, OUT_DIR, `${c.key}.opus`))).size);
    } catch {
      /* already reported as missing */
    }
  }

  const bytesOf = (kind: string) => clips.filter((c) => c.kind === kind).reduce((a, c) => a + (sizes.get(c.key) ?? 0), 0);
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

  const stopSizes = clips.filter((c) => c.kind === "stop").map((c) => sizes.get(c.key) ?? 0).sort((a, b) => a - b);
  const stopsB = bytesOf("stop");
  const mandatory = bytesOf("number") + bytesOf("phrase") + bytesOf("route");

  console.log(`\n=== SIZE REPORT (${provider.name}/${provider.voice}, Opus mono ${OPUS_BITRATE}) ===`);
  for (const kind of ["phrase", "number", "route", "stop"] as const) {
    const n = clips.filter((c) => c.kind === kind).length;
    if (n) console.log(`  ${kind.padEnd(8)} ${String(n).padStart(4)} clips  ${kb(bytesOf(kind)).padStart(10)}`);
  }
  console.log(`  ${"-".repeat(40)}`);
  console.log(`  mandatory (phrases+numbers+routes) ${kb(mandatory).padStart(10)}`);
  console.log(`  TOTAL RENDERED                     ${mb(stopsB + mandatory).padStart(10)}`);

  if (stopSizes.length) {
    const median = stopSizes[stopSizes.length >> 1];
    console.log(`\n  per stop clip: median ${kb(median)}, max ${kb(stopSizes[stopSizes.length - 1])}`);

    // Full-city extrapolation from the pilot's own measured median.
    const allStops: unknown[] = JSON.parse(readFileSync(join(root, "public/transit/stops.json"), "utf8"));
    const projected = median * allStops.length + mandatory;
    console.log(`  extrapolated full city (${allStops.length} stops @ measured median): ${mb(projected)}`);
  }

  const totalMs = Object.values(manifest).reduce((a, e) => a + e.durationMs, 0);
  console.log(`\n  manifest: ${Object.keys(manifest).length} keys, ${(totalMs / 1000 / 60).toFixed(1)} min of audio`);
  console.log(`  characters spent this run: ${(provider.charsUsed ?? 0).toLocaleString()}`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
