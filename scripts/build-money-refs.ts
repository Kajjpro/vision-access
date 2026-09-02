/**
 * Build public/money/refs.json — the reference pack MoneyMode matches against.
 *
 *   npx tsx scripts/build-money-refs.ts
 *   npx tsx scripts/build-money-refs.ts --dir reference-notes --source "shot on iPhone 13"
 *
 * This is the closest thing this feature has to a training run, and it takes
 * about a second. There is no dataset, no labelling pass and no GPU: a
 * banknote is a rigid planar object with one fixed printed design, so
 * recognising it is matching against a picture of it rather than learning
 * what it tends to look like. See lib/money/denominations.ts.
 *
 * INPUT. One image per denomination per side, named <value>-<side>.<ext>:
 *
 *   reference-notes/100-front.jpg    reference-notes/100-back.jpg
 *   reference-notes/500-front.jpg    ...
 *   reference-notes/20000-front.jpg  reference-notes/20000-back.jpg
 *
 * HOW TO SHOOT THEM. This matters more than any threshold in the recogniser,
 * because a bad reference is a systematic error and NOTES.md's three-frame
 * agreement cannot detect one — every frame is wrong the same way and agrees.
 *
 *   - Flat. No curl, no fold. Weight the corners if the note will not lie.
 *   - Square on. The homography handles perspective at match time; baking a
 *     tilt into the reference wastes half the tolerance budget.
 *   - Even, diffuse light. No flash, no single hard lamp. A specular
 *     highlight burns out print detail, and burnt-out detail is missing
 *     keypoints in exactly the region that distinguishes one note from
 *     another.
 *   - Fill the frame, note edges just inside it.
 *   - A note in ordinary circulated condition beats a crisp new one. The
 *     reference should look like what a user will actually be holding.
 *
 * The script reports a feature count per image and refuses to write a pack
 * where any image is too sparse to match reliably.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import sharp from "sharp";

import { DENOMINATIONS, SIDES, type Denomination, type Side } from "../lib/money/denominations";
import { detectAndCompute, toGray } from "../lib/money/orb";
import { DESCRIPTOR_SIGNATURE, PACK_VERSION, encodeEntry, type ReferencePack } from "../lib/money/refs";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const IN_DIR = resolve(process.cwd(), flag("dir", "reference-notes"));
const OUT = resolve(process.cwd(), "public/money/refs.json");
const SOURCE = flag("source", "unspecified");

/** Long edge each reference is scaled to. Matches the recogniser's working size. */
const REFERENCE_SIZE = 900;

/**
 * A reference below this is not usable. Roughly: a note that fills the frame
 * under even light yields several hundred. Under 120 means the image is
 * blurred, badly lit, or is not a banknote.
 */
const MIN_FEATURES = 120;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"]);

function findImage(denomination: Denomination, side: Side): string | null {
  if (!existsSync(IN_DIR)) return null;
  for (const file of readdirSync(IN_DIR)) {
    if (!IMAGE_EXT.has(extname(file).toLowerCase())) continue;
    const stem = file.slice(0, file.length - extname(file).length).toLowerCase();
    if (stem === `${denomination}-${side}`) return join(IN_DIR, file);
  }
  return null;
}

async function main() {
  console.log(`reading reference notes from ${IN_DIR}`);
  console.log(`descriptor: ${DESCRIPTOR_SIGNATURE}\n`);

  const missing: string[] = [];
  const sparse: string[] = [];
  const entries: ReferencePack["entries"] = [];

  for (const denomination of DENOMINATIONS) {
    for (const side of SIDES) {
      const path = findImage(denomination, side);
      if (!path) {
        missing.push(`${denomination}-${side}`);
        continue;
      }

      const { data, info } = await sharp(path)
        .rotate() // Honour EXIF orientation, or a portrait shot arrives sideways.
        .resize(REFERENCE_SIZE, REFERENCE_SIZE, { fit: "inside", withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const gray = toGray(new Uint8Array(data), info.width, info.height);
      const features = detectAndCompute(gray, { maxFeatures: 600 });

      const label = `${denomination} ${side}`.padEnd(16);
      console.log(
        `  ${label} ${String(features.count).padStart(4)} features  ` +
          `${info.width}x${info.height}  ${path.replace(process.cwd() + "/", "")}`,
      );

      if (features.count < MIN_FEATURES) sparse.push(`${denomination}-${side} (${features.count})`);
      entries.push(encodeEntry(denomination, side, info.width, info.height, features));
    }
  }

  if (missing.length) {
    console.error(`\nMissing ${missing.length} reference image(s):`);
    for (const m of missing) console.error(`  ${m}`);
    console.error(
      `\nExpected files named <value>-<side>.jpg in ${IN_DIR}.\n` +
        `A pack missing a denomination does not fail loudly at match time — the\n` +
        `app simply never says that note. Refusing to write a partial pack.`,
    );
    process.exit(1);
  }

  if (sparse.length) {
    console.error(`\nToo few features to match reliably:`);
    for (const s of sparse) console.error(`  ${s}`);
    console.error(
      `\nRe-shoot these: flatter, more even light, filling more of the frame.\n` +
        `A weak reference is a SYSTEMATIC error — every frame misreads the same\n` +
        `way, so the three-frame agreement in lib/money/decide.ts cannot catch it.`,
    );
    process.exit(1);
  }

  const pack: ReferencePack = {
    version: PACK_VERSION,
    signature: DESCRIPTOR_SIGNATURE,
    source: SOURCE,
    builtAt: new Date().toISOString(),
    entries,
  };

  await mkdir(dirname(OUT), { recursive: true });
  const json = JSON.stringify(pack);
  await writeFile(OUT, json);

  const total = entries.reduce((s, e) => s + e.count, 0);
  console.log(
    `\nwrote ${OUT.replace(process.cwd() + "/", "")}  ` +
      `${entries.length} entries, ${total} features, ${(json.length / 1024).toFixed(0)} KB`,
  );
  console.log(
    `\nNEXT: the inlier thresholds in lib/money/recognizer.ts are uncalibrated.\n` +
      `Run scripts/eval-money.ts against photographs of REAL notes before\n` +
      `trusting this in a shop.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
