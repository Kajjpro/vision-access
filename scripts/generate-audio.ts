/**
 * Pre-renders every phrase in lib/phrases.ts to public/audio/<id>.wav using the
 * Chimege TTS API. Warning audio is pre-rendered, never a live TTS call.
 *
 *   npx tsx scripts/generate-audio.ts
 *
 * Reads CHIMEGE_TOKEN from .env.local (or the environment). Optional:
 * CHIMEGE_VOICE picks a voice, e.g. FEMALE1 / MALE1; unset uses the API default.
 *
 * Existing files are left alone. Pass --force to re-synthesize them (needed
 * after changing the voice, or the text of a phrase that already has a file).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { PHRASES, type Phrase } from "../lib/phrases";

const ENDPOINT = "https://api.chimege.com/v1.2/synthesize";

/**
 * Chimege rejects anything outside this set with a plain-text error:
 * Cyrillic letters, spaces, ? ! . - ' " : and commas. Checked before sending so
 * a bad phrase fails here rather than writing an "audio" file full of English
 * error prose.
 */
const ALLOWED_TEXT = /^[Ѐ-ӿ ?!.\-'":,]+$/;

const root = process.cwd();
if (!existsSync(join(root, "public"))) {
  console.error(`No public/ directory under ${root} — run this from the project root.`);
  process.exit(1);
}

/** Minimal .env.local reader — this is a standalone script, not a Next runtime. */
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

function requireToken(): string {
  const value = process.env.CHIMEGE_TOKEN;
  if (value) return value;
  console.error("CHIMEGE_TOKEN is not set (looked in the environment and .env.local).");
  process.exit(1);
}

const token = requireToken();

const voice = process.env.CHIMEGE_VOICE;
const force = process.argv.includes("--force");
const outDir = resolve(root, "public/audio");

async function synthesize(phrase: Phrase): Promise<Buffer> {
  if (!ALLOWED_TEXT.test(phrase.mn)) {
    throw new Error(`"${phrase.mn}" has characters Chimege rejects (Cyrillic + ? ! . - ' " : , only)`);
  }

  const headers: Record<string, string> = {
    token,
    // Plain text, NOT SSML — Chimege treats markup as illegal characters.
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (voice) headers["voice-id"] = voice;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: Buffer.from(phrase.mn, "utf8"),
  });

  const body = Buffer.from(await res.arrayBuffer());

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} — ${body.toString("utf8").trim()}`);
  }

  // Chimege returns its errors as HTTP 200 with a text body. Without this check
  // the error prose gets written to disk as a .wav that plays nothing.
  if (body.subarray(0, 4).toString("ascii") !== "RIFF") {
    throw new Error(`not audio — ${body.toString("utf8").trim().slice(0, 200)}`);
  }

  return body;
}

async function main() {
  const seen = new Set<string>();
  for (const phrase of PHRASES) {
    if (seen.has(phrase.id)) {
      console.error(`Duplicate id "${phrase.id}" — ids are filenames and must be unique.`);
      process.exit(1);
    }
    seen.add(phrase.id);
  }

  await mkdir(outDir, { recursive: true });
  console.log(`Chimege${voice ? ` (${voice})` : ""} → public/audio/  (${PHRASES.length} phrases)\n`);

  let written = 0;
  let skipped = 0;
  const failed: string[] = [];

  // Sequential on purpose: a handful of files, and it keeps well under any rate limit.
  for (const phrase of PHRASES) {
    const file = join(outDir, `${phrase.id}.wav`);

    if (!force && existsSync(file)) {
      console.log(`skip   ${phrase.id}.wav`);
      skipped++;
      continue;
    }

    try {
      const audio = await synthesize(phrase);
      await writeFile(file, audio);
      console.log(`write  ${phrase.id}.wav  "${phrase.mn}"  ${(audio.length / 1024).toFixed(1)} KB`);
      written++;
    } catch (e) {
      console.error(`FAIL   ${phrase.id}.wav  ${e instanceof Error ? e.message : String(e)}`);
      failed.push(phrase.id);
    }
  }

  console.log(`\n${written} written, ${skipped} skipped, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error(`Re-run to retry: ${failed.join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
