/**
 * Propose the names riders actually say for each stop.
 *
 *   npx tsx scripts/generate-stop-aliases.ts --dry-run     # show the prompt, spend nothing
 *   npx tsx scripts/generate-stop-aliases.ts --limit=40    # a sample, to judge quality first
 *   npx tsx scripts/generate-stop-aliases.ts               # the whole city
 *   npx tsx scripts/generate-stop-aliases.ts --review      # print what is pending review
 *
 * THE PROBLEM. `aliasKeys` in stops.json is mechanical today — the full name
 * with its `/Баруун/` platform word, plus an ordinal-in-words form. What it
 * does not contain is the thing that actually breaks recognition: the name the
 * rider says is not the name in the feed. Someone travelling to `Улсын их
 * дэлгүүр` says `Их дэлгүүр`, or just `Дэлгүүр`. `MSM` is spoken `эм эс эм`.
 * The recognizer hears those correctly and the matcher then fails to find them,
 * which reads to the rider as the app not knowing a stop everyone knows.
 *
 * WHY A MODEL, AND WHY ONLY HERE. This is the one place in the app where an
 * LLM is unambiguously the right tool: an open-ended generation task over a
 * closed list, run once, offline, with no rider waiting and a human between the
 * output and production. It costs ~47 batched requests against a free tier for
 * all 923 stops. The runtime path is a different question entirely — see
 * `app/api/stop-resolve/route.ts`.
 *
 * NOTHING HERE SHIPS UNREVIEWED. Output goes to `data/stop-aliases.json` with
 * every entry marked `"reviewed": false`, and `scripts/build-stop-keys.ts`
 * folds in ONLY the reviewed ones. A model can produce a plausible Mongolian
 * alias for a stop it has never heard of; a wrong alias silently routes a blind
 * rider to the wrong district, which is the exact failure this app exists to
 * prevent. I can generate candidates. I cannot verify what Ulaanbaatar calls a
 * bus stop — that needs someone who lives there.
 *
 * Responses are cached per batch under `.cache/stop-aliases/`, so re-running
 * after an interruption costs nothing and iterating on the fold-in step is free.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  LlmQuotaError,
  LlmUnavailable,
  selectLlmProvider,
  sleep,
  withLlmRetry,
} from "../lib/llm/provider";
import { stopKey } from "../lib/speech/mnNormalize";

const root = process.cwd();
const STOPS_FILE = join(root, "public/transit/stops.json");
const OUT_FILE = join(root, "data/stop-aliases.json");
const CACHE_DIR = join(root, ".cache/stop-aliases");

/** Small enough that one bad batch is cheap; large enough to fit the free tier. */
const BATCH_SIZE = 20;

function loadEnvLocal() {
  for (const file of [".env.local", ".env"]) {
    const p = join(root, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnvLocal();

type RawStop = { id: string; name: string; lat: number; lon: number };

export type AliasEntry = {
  id: string;
  name: string;
  /** Spoken variants, as written Mongolian. Keys are derived at fold-in time. */
  aliases: string[];
  /** Gate for shipping. Flip to true only after a human who knows the city checks it. */
  reviewed: boolean;
  /** Which provider/model proposed it, so a bad batch can be traced and re-run. */
  source: string;
};

const SYSTEM = `Чи Улаанбаатар хотын нийтийн тээврийн буудлын нэрийг сайн мэддэг туслах.

Хэрэглэгч бол харааны бэрхшээлтэй зорчигч. Тэр автобусны буудлын нэрийг ЯРЬЖ хэлдэг.
Албан ёсны нэр, ярианы нэр хоёр өөр байдаг. Чиний ажил бол зорчигчийн АМААР хэлж
магадгүй хувилбаруудыг санал болгох.

Дүрэм:
- Зөвхөн кирилл үсэг ашигла.
- Албан ёсны нэрийг өөрөө давтаж бичих шаардлагагүй.
- Латин үсэг, товчлол байвал уншдаг хэлбэрээр нь бич (жишээ: "MSM" -> "эм эс эм").
- Тоо байвал үгээр бич (жишээ: "3-р хороолол" -> "гуравдугаар хороолол").
- Зөвхөн ҮНЭХЭЭР хэлж болох хувилбарыг бич. Мэдэхгүй бол хоосон жагсаалт буцаа.
- Огт таамаглаж болохгүй. Буруу нэр нь харааны бэрхшээлтэй хүнийг буруу газар
  буулгана.
- Нэг буудалд хамгийн ихдээ 4 хувилбар.`;

const SCHEMA = {
  type: "object",
  properties: {
    stops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          aliases: { type: "array", items: { type: "string" }, maxItems: 4 },
        },
        required: ["id", "aliases"],
      },
    },
  },
  required: ["stops"],
} as const;

/** The platform word is a routing detail; nobody says it. */
const spoken = (name: string) => name.replace(/\s*\/[^/]*\/\s*/g, " ").replace(/\s+/g, " ").trim();

function buildPrompt(batch: RawStop[]): string {
  const lines = batch.map((s) => `- id=${s.id} нэр="${spoken(s.name)}"`).join("\n");
  return `Дараах автобусны буудал бүрд зорчигчийн амаар хэлж болох хувилбаруудыг бич.\n\n${lines}`;
}

const cacheKeyFor = (batch: RawStop[], model: string) =>
  createHash("sha256").update(model).update(batch.map((s) => `${s.id}:${s.name}`).join("|")).digest("hex").slice(0, 16);

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const review = process.argv.includes("--review");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

  const stops: RawStop[] = JSON.parse(readFileSync(STOPS_FILE, "utf8"));

  // --review reports the shipping gate without touching the network.
  if (review) {
    if (!existsSync(OUT_FILE)) {
      console.log("No data/stop-aliases.json yet — nothing has been generated.");
      return;
    }
    const entries: AliasEntry[] = JSON.parse(readFileSync(OUT_FILE, "utf8"));
    const approved = entries.filter((e) => e.reviewed);
    const pending = entries.filter((e) => !e.reviewed && e.aliases.length > 0);
    console.log(`stop-aliases.json: ${entries.length} stops`);
    console.log(`  reviewed and shipping : ${approved.length}`);
    console.log(`  awaiting review       : ${pending.length}\n`);
    for (const e of pending.slice(0, 40)) {
      console.log(`  ${e.name}\n      ${e.aliases.join("  |  ")}`);
    }
    if (pending.length > 40) console.log(`  … ${pending.length - 40} more`);
    console.log(`\nEdit ${OUT_FILE} and set "reviewed": true on the correct ones.`);
    console.log(`Only reviewed entries are folded in by scripts/build-stop-keys.ts.`);
    return;
  }

  const selected = stops.slice(0, Number.isFinite(limit) ? limit : undefined);
  const batches: RawStop[][] = [];
  for (let i = 0; i < selected.length; i += BATCH_SIZE) {
    batches.push(selected.slice(i, i + BATCH_SIZE));
  }

  if (dryRun) {
    console.log(`Would send ${batches.length} request(s) for ${selected.length} stops.\n`);
    console.log("--- system ---");
    console.log(SYSTEM);
    console.log("\n--- first user message ---");
    console.log(buildPrompt(batches[0] ?? []));
    console.log("\n--dry-run: nothing sent, nothing spent.");
    return;
  }

  let provider;
  try {
    provider = await selectLlmProvider();
  } catch (e) {
    if (e instanceof LlmUnavailable) {
      console.error(`\n${e.message}\n`);
      console.error("Set LLM_PROVIDER and the matching key in .env.local, e.g.:");
      console.error("  LLM_PROVIDER=gemini");
      console.error("  GEMINI_API_KEY=...\n");
      process.exit(1);
    }
    throw e;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });

  // Pace against the free tier rather than being cut off by it.
  const gapMs = Math.ceil(60_000 / (provider.requestsPerMinute ?? 10)) + 250;

  console.log(`Stop aliases → ${OUT_FILE}`);
  console.log(`  provider : ${provider.name} / ${provider.model}`);
  console.log(`  stops    : ${selected.length}`);
  console.log(`  requests : ${batches.length} (paced ${(gapMs / 1000).toFixed(1)}s apart)\n`);

  // Keep any review decisions already made.
  const previous = new Map<string, AliasEntry>();
  if (existsSync(OUT_FILE)) {
    for (const e of JSON.parse(readFileSync(OUT_FILE, "utf8")) as AliasEntry[]) {
      previous.set(e.id, e);
    }
  }

  const byId = new Map(selected.map((s) => [s.id, s]));
  const results: AliasEntry[] = [];
  let cached = 0;
  let failed = 0;

  for (const [i, batch] of batches.entries()) {
    const cacheFile = join(CACHE_DIR, `${cacheKeyFor(batch, provider.model)}.json`);
    let parsed: { stops?: Array<{ id?: string; aliases?: string[] }> } | null = null;

    if (existsSync(cacheFile)) {
      parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
      cached++;
    } else {
      try {
        parsed = (await withLlmRetry(
          () =>
            provider.complete({
              system: SYSTEM,
              user: buildPrompt(batch),
              schema: SCHEMA as unknown as Record<string, unknown>,
              maxOutputTokens: 2048,
            }),
          { label: `batch ${i + 1}/${batches.length}` },
        )) as typeof parsed;
        if (parsed) writeFileSync(cacheFile, JSON.stringify(parsed, null, 2), "utf8");
      } catch (e) {
        if (e instanceof LlmQuotaError) {
          console.error(`\n\nFree tier exhausted at batch ${i + 1}/${batches.length}.`);
          console.error("Partial results are cached — re-run tomorrow to continue.\n");
          break;
        }
        console.error(`\n  batch ${i + 1} failed: ${e instanceof Error ? e.message : e}`);
        failed++;
      }
      await sleep(gapMs);
    }

    for (const row of parsed?.stops ?? []) {
      const stop = byId.get(String(row.id));
      if (!stop) continue; // A model-invented id. Dropped, never trusted.

      const seen = new Set<string>([stopKey(spoken(stop.name))]);
      const aliases: string[] = [];
      for (const raw of row.aliases ?? []) {
        const text = String(raw).trim();
        // Cyrillic only, and never a restatement of the name we already key on.
        if (!text || !/^[Ѐ-ӿ\s'’-]+$/.test(text)) continue;
        const k = stopKey(text);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        aliases.push(text);
      }

      const prior = previous.get(stop.id);
      results.push({
        id: stop.id,
        name: stop.name,
        aliases,
        // A previously reviewed entry stays reviewed only if it is unchanged;
        // new suggestions must be looked at again.
        reviewed:
          prior?.reviewed === true &&
          JSON.stringify(prior.aliases) === JSON.stringify(aliases),
        source: `${provider.name}/${provider.model}`,
      });
    }
    process.stdout.write(`\r  ${i + 1}/${batches.length} batches`);
  }

  // Carry forward stops this run did not cover, so --limit never truncates the file.
  for (const [id, entry] of previous) {
    if (!results.some((r) => r.id === id)) results.push(entry);
  }
  results.sort((a, b) => a.id.localeCompare(b.id));

  writeFileSync(OUT_FILE, `${JSON.stringify(results, null, 2)}\n`, "utf8");

  const withAliases = results.filter((r) => r.aliases.length > 0);
  const approved = results.filter((r) => r.reviewed);
  console.log(`\n\n  stops with suggestions : ${withAliases.length}`);
  console.log(`  total suggestions      : ${results.reduce((n, r) => n + r.aliases.length, 0)}`);
  console.log(`  reviewed (will ship)   : ${approved.length}`);
  console.log(`  requests sent          : ${provider.requestsUsed ?? 0} (${cached} served from cache)`);
  if (failed) console.log(`  failed batches         : ${failed}`);

  console.log(`\nNOTHING SHIPS UNTIL IT IS REVIEWED.`);
  console.log(`  npx tsx scripts/generate-stop-aliases.ts --review   # see what is pending`);
  console.log(`  then set "reviewed": true on the correct entries in ${OUT_FILE}`);
  console.log(`  npx tsx scripts/build-stop-keys.ts                  # fold them into stops.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
