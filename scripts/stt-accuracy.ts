/**
 * Does the recognizer actually understand Mongolian stop names?
 *
 *   npx tsx scripts/stt-accuracy.ts [--sample=40] [--voice=mn-MN-BataaNeural]
 *
 * Renders real names from public/transit/stops.json, pushes each through the
 * same Azure short-audio endpoint app/api/stt/route.ts calls, and scores the
 * transcripts against the stop list with the app's own matcher. Reports the
 * number that matters — how often a rider naming a stop gets that stop — for
 * both the old single-transcript path and the alternative search that replaced
 * it.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT. Synthetic speech is a clean-room
 * upper bound: no traffic, no wind, no phone microphone, no accent, no hurry.
 * It answers "is mn-MN supported and is the matcher sane", which was genuinely
 * unknown and is now answered. It does NOT predict accuracy at a bus stop in
 * Ulaanbaatar, and no amount of running it will. Only recordings of real riders
 * can do that, and until those exist the confirmation read-back is what stands
 * between a misrecognition and someone stranded in the wrong district.
 *
 * Renders with a DIFFERENT voice than the app's pre-rendered clips by default.
 * Asking YesuiNeural to read a name back to the recognizer that was trained
 * alongside it flatters the result; BataaNeural at least makes it two voices.
 *
 * Costs TTS characters against the hard-capped free tier — roughly 20 per stop,
 * so the default sample is ~800. Synthesized audio is cached under .cache/stt
 * and reused, so re-running to compare matcher changes costs nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { matchStops, matchStopsAny, type Stop } from "../lib/routing/resolveJourney";

const root = process.cwd();
const CACHE = join(root, ".cache/stt");

function loadEnvLocal() {
  const p = join(root, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const KEY = process.env.AZURE_SPEECH_KEY;
const REGION = process.env.AZURE_SPEECH_REGION;
const VOICE = arg("voice", "mn-MN-BataaNeural");
const SAMPLE = Number(arg("sample", "40"));

if (!KEY || !REGION) {
  console.error("AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must be set (.env.local).");
  process.exit(1);
}

const stops: Stop[] = JSON.parse(
  readFileSync(join(root, "public/transit/stops.json"), "utf8"),
);

/**
 * What a rider actually says. Stop names carry a platform qualifier —
 * `Саппоро /Урд/` — that nobody speaks aloud and that is a routing detail
 * rather than a destination.
 */
const spoken = (name: string) =>
  name.replace(/\s*\/[^/]*\/\s*/g, " ").replace(/\s+/g, " ").trim();

async function synthesize(text: string, file: string): Promise<Buffer> {
  if (existsSync(file)) return readFileSync(file);
  const ssml =
    `<speak version='1.0' xml:lang='mn-MN'><voice name='${VOICE}'>${text}</voice></speak>`;
  const res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": KEY!,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "riff-16khz-16bit-mono-pcm",
    },
    body: ssml,
  });
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

type NBest = { Display?: string; Lexical?: string; ITN?: string };

async function recognize(wav: Buffer): Promise<string[]> {
  const url =
    `https://${REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=mn-MN&format=detailed&profanity=raw`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": KEY!,
      "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
      Accept: "application/json",
    },
    body: new Uint8Array(wav),
  });
  if (!res.ok) throw new Error(`stt ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { DisplayText?: string; NBest?: NBest[] };

  // The same ordering app/api/stt/route.ts returns, so this measures the real
  // input to the matcher rather than an idealized one.
  const out: string[] = [];
  for (const entry of data.NBest ?? []) {
    for (const form of [entry.Display, entry.Lexical, entry.ITN]) {
      const t = form?.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  if (out.length === 0 && data.DisplayText?.trim()) out.push(data.DisplayText.trim());
  return out;
}

async function main() {
  mkdirSync(CACHE, { recursive: true });

  // Spread across the whole list rather than taking the first N, which would be
  // one district and one naming style.
  const step = Math.max(1, Math.floor(stops.length / SAMPLE));
  const sample = Array.from({ length: SAMPLE }, (_, i) => stops[i * step]).filter(Boolean);

  console.log(`STT accuracy — ${sample.length} of ${stops.length} stops, voice ${VOICE}\n`);

  let firstOnly = 0;
  let allAlts = 0;
  let silent = 0;
  const wrong: string[] = [];

  for (const [i, target] of sample.entries()) {
    const text = spoken(target.name);
    let heard: string[];
    try {
      heard = await recognize(await synthesize(text, join(CACHE, `${target.id}.wav`)));
    } catch (e) {
      console.log(`  ! ${text}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (heard.length === 0) silent++;

    const same = (m?: { stop: Stop }) =>
      m !== undefined && (m.stop.placeKey ?? m.stop.id) === (target.placeKey ?? target.id);

    if (same(matchStops(heard[0] ?? "", stops, { limit: 1 })[0])) firstOnly++;

    const best = matchStopsAny(heard, stops, { limit: 1 })[0];
    if (same(best)) allAlts++;
    else wrong.push(`  said "${text}" → heard "${heard[0] ?? ""}" → ${best?.stop.name ?? "(no match)"}`);

    process.stdout.write(`\r  ${i + 1}/${sample.length}`);
  }

  const pct = (n: number) => `${((100 * n) / sample.length).toFixed(1)}%`;
  console.log(`\n\n  returned nothing        : ${silent}`);
  console.log(`  top transcript only     : ${firstOnly}/${sample.length}  ${pct(firstOnly)}`);
  console.log(`  every alternative       : ${allAlts}/${sample.length}  ${pct(allAlts)}`);

  if (wrong.length) {
    console.log(`\n  not resolved (${wrong.length}):`);
    for (const w of wrong.slice(0, 25)) console.log(w);
  }
  console.log(
    `\n  Clean-room upper bound. A real rider at a real stop will do worse, ` +
      `which is why the read-back is mandatory.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
