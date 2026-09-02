/**
 * Measure the recogniser against real photographs, and calibrate its gates.
 *
 *   npx tsx scripts/eval-money.ts --dir test-notes
 *   npx tsx scripts/eval-money.ts --dir test-notes --negatives not-money
 *
 * MIN_INLIERS and MARGIN in lib/money/recognizer.ts are reasoned defaults, not
 * measured ones. This script is how they stop being guesses. Do not trust the
 * feature in a shop until it has been run on photographs of real notes in real
 * light — the synthetic tests in lib/money/*.test.ts prove the maths works and
 * prove nothing whatsoever about worn paper under a fluorescent tube.
 *
 * INPUT. Photographs named <denomination>-<anything>.jpg, the denomination
 * being the truth:
 *
 *   test-notes/1000-folded.jpg   test-notes/1000-dim-indoor.jpg
 *   test-notes/5000-in-hand.jpg  test-notes/20000-angled.jpg
 *
 * Shoot the cases that will actually happen, not the flattering ones: held in
 * a hand with fingers across the note, folded, on a dark surface, under a
 * street lamp, at an angle, partly shadowed. A test set of flat well-lit notes
 * measures nothing that a user will ever encounter.
 *
 * `--negatives <dir>` takes images containing NO banknote — a table, a
 * receipt, a phone, a wall. Every one of them must come back unidentified.
 *
 * THE METRIC THAT MATTERS IS FALSE NAMING, NOT ACCURACY.
 *
 * Abstaining costs a user one more tap. Naming a 20000 as a 1000 costs them
 * the difference, at a till, with no way to notice. These are NOT two sides of
 * one number and must never be traded off against each other: a build that
 * abstains half the time and is never wrong is shippable, and a build that
 * answers every time and is wrong in one case per hundred is not.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import sharp from "sharp";

import { DENOMINATIONS, type Denomination } from "../lib/money/denominations";
import { MARGIN, MIN_INLIERS, Recognizer, workingSize } from "../lib/money/recognizer";
import type { ReferencePack } from "../lib/money/refs";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string | null = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PACK_PATH = resolve(process.cwd(), flag("pack", "public/money/refs.json")!);
const DIR = resolve(process.cwd(), flag("dir", "test-notes")!);
const NEGATIVES = flag("negatives");

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function images(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
    .map((f) => join(dir, f));
}

function truthOf(path: string): Denomination | null {
  const stem = path.split("/").pop()!.split(".")[0];
  const value = Number(stem.split("-")[0]);
  return (DENOMINATIONS as readonly number[]).includes(value) ? (value as Denomination) : null;
}

async function pixelsOf(path: string) {
  const meta = await sharp(path).metadata();
  const target = workingSize(meta.width ?? 0, meta.height ?? 0);
  const { data, info } = await sharp(path)
    .rotate()
    .resize(target.width, target.height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

type Row = {
  file: string;
  truth: Denomination | null;
  said: Denomination | null;
  inliers: number;
  runnerUp: number;
  /** Best inlier count per denomination, for re-scoring at other thresholds. */
  scores: { denomination: Denomination; inliers: number }[];
};

/** Re-apply the gates at candidate settings, without re-running the matcher. */
function verdictAt(row: Row, minInliers: number, margin: number): Denomination | null {
  const best = new Map<Denomination, number>();
  for (const s of row.scores) {
    best.set(s.denomination, Math.max(best.get(s.denomination) ?? 0, s.inliers));
  }
  let winner: Denomination | null = null;
  let top = 0;
  let second = 0;
  for (const [d, n] of best) {
    if (n > top) { second = top; top = n; winner = d; }
    else if (n > second) second = n;
  }
  if (!winner || top < minInliers) return null;
  if (second > 0 && top < second * margin) return null;
  return winner;
}

async function main() {
  if (!existsSync(PACK_PATH)) {
    console.error(
      `No reference pack at ${PACK_PATH}.\n` +
        `Build one first: npx tsx scripts/build-money-refs.ts`,
    );
    process.exit(1);
  }
  const pack = JSON.parse(readFileSync(PACK_PATH, "utf8")) as ReferencePack;
  const recognizer = Recognizer.fromPack(pack);
  console.log(`pack: ${recognizer.size} references, source "${pack.source}"\n`);

  const files = images(DIR);
  if (files.length === 0) {
    console.error(`No test images in ${DIR}. See the header of this file for naming.`);
    process.exit(1);
  }

  const rows: Row[] = [];
  for (const file of files) {
    const truth = truthOf(file);
    if (truth === null) {
      console.log(`  SKIP ${file} — filename does not start with a known denomination`);
      continue;
    }
    const { data, width, height } = await pixelsOf(file);
    const { result, debug } = recognizer.recognize(data, width, height);
    rows.push({
      file,
      truth,
      said: result?.denomination ?? null,
      inliers: result?.inliers ?? debug.scores[0]?.inliers ?? 0,
      runnerUp: result?.runnerUpInliers ?? 0,
      scores: debug.scores.map((s) => ({ denomination: s.denomination, inliers: s.inliers })),
    });
  }

  for (const file of NEGATIVES ? images(resolve(process.cwd(), NEGATIVES)) : []) {
    const { data, width, height } = await pixelsOf(file);
    const { result, debug } = recognizer.recognize(data, width, height);
    rows.push({
      file,
      truth: null,
      said: result?.denomination ?? null,
      inliers: result?.inliers ?? debug.scores[0]?.inliers ?? 0,
      runnerUp: result?.runnerUpInliers ?? 0,
      scores: debug.scores.map((s) => ({ denomination: s.denomination, inliers: s.inliers })),
    });
  }

  // --- per image ---------------------------------------------------------
  console.log("file                                    truth    said     inliers  runner-up");
  for (const r of rows) {
    const verdict = r.said === null ? "—" : String(r.said);
    const wrong = r.said !== null && r.said !== r.truth;
    console.log(
      `${wrong ? "!" : " "} ${r.file.replace(process.cwd() + "/", "").padEnd(38)} ` +
        `${String(r.truth ?? "none").padEnd(8)} ${verdict.padEnd(8)} ` +
        `${String(r.inliers).padStart(7)}  ${String(r.runnerUp).padStart(9)}`,
    );
  }

  // --- headline ----------------------------------------------------------
  const named = rows.filter((r) => r.said !== null);
  const falseNames = rows.filter((r) => r.said !== null && r.said !== r.truth);
  const correct = rows.filter((r) => r.truth !== null && r.said === r.truth);
  const abstained = rows.filter((r) => r.truth !== null && r.said === null);

  console.log(`\n${rows.length} images`);
  console.log(`  correct        ${correct.length}`);
  console.log(`  abstained      ${abstained.length}   (costs a retap)`);
  console.log(`  FALSE NAMING   ${falseNames.length}   <- the number that matters`);
  for (const f of falseNames) {
    console.log(`      ${f.file.replace(process.cwd() + "/", "")}: said ${f.said}, was ${f.truth ?? "not money"}`);
  }
  if (named.length) {
    console.log(`  false-naming rate among answers given: ${((falseNames.length / named.length) * 100).toFixed(1)}%`);
  }

  // --- threshold sweep ---------------------------------------------------
  // The whole point of collecting the per-denomination scores above: pick the
  // gate from the data instead of from an argument about what sounds safe.
  console.log(`\nthreshold sweep (current: MIN_INLIERS=${MIN_INLIERS}, MARGIN=${MARGIN})`);
  console.log("  min  margin   correct  abstained  FALSE");
  for (const min of [10, 14, 18, 22, 26, 30, 40]) {
    for (const margin of [1.3, 1.6, 2.0, 2.5]) {
      let c = 0, a = 0, f = 0;
      for (const r of rows) {
        const said = verdictAt(r, min, margin);
        if (said === null) { if (r.truth !== null) a++; }
        else if (said === r.truth) c++;
        else f++;
      }
      const mark = min === MIN_INLIERS && margin === MARGIN ? " <- current" : "";
      console.log(
        `  ${String(min).padStart(3)}  ${margin.toFixed(1).padStart(6)}   ` +
          `${String(c).padStart(7)}  ${String(a).padStart(9)}  ${String(f).padStart(5)}${mark}`,
      );
    }
  }
  console.log(
    `\nChoose the cheapest setting with FALSE = 0. Do not trade a false naming\n` +
      `for several correct ones: they are not the same unit.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
