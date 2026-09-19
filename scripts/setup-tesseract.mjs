/**
 * Self-hosts the OCR runtime under public/tesseract/.
 *
 *   node scripts/setup-tesseract.mjs
 *
 * COEP is `require-corp` (next.config.ts), so tesseract's CDN defaults are
 * blocked exactly as onnxruntime's were — every asset it fetches has to be
 * same-origin. That is the whole reason this script exists.
 *
 * WHAT IS COPIED AND WHY THAT ONE:
 *   worker.min.js              the worker entry
 *   tesseract-core-simd-lstm   LSTM-only, SIMD. 2.7 MB against 3.3 MB for the
 *                              full build, and the legacy engine in the larger
 *                              one is not used — `oem` defaults to LSTM.
 *   mon.traineddata            MONGOLIAN, not English. Street signage here is
 *                              Cyrillic; `eng` would read it as noise. The
 *                              `_fast` variant, ~1 MB against ~15 MB for the
 *                              standard one, because a sign is large clean text
 *                              and does not need the full model.
 *
 * Idempotent: an asset already present is left alone, so a re-run costs nothing.
 */
import { createWriteStream } from "node:fs";
import { mkdir, copyFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";

const OUT = "public/tesseract";
const LANG = "mon";
/** tessdata_fast, via jsDelivr. Same host family the app already allows. */
const TESSDATA = `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${LANG}/4.0.0/${LANG}.traineddata.gz`;

const COPY = [
  ["node_modules/tesseract.js/dist/worker.min.js", "worker.min.js"],
  ["node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm", "tesseract-core-simd-lstm.wasm"],
  ["node_modules/tesseract.js-core/tesseract-core-simd-lstm.js", "tesseract-core-simd-lstm.js"],
  // Fallback for a device without SIMD. Small enough to be worth shipping.
  ["node_modules/tesseract.js-core/tesseract-core-lstm.wasm", "tesseract-core-lstm.wasm"],
  ["node_modules/tesseract.js-core/tesseract-core-lstm.js", "tesseract-core-lstm.js"],
];

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function main() {
  await mkdir(OUT, { recursive: true });

  let copied = 0;
  for (const [from, to] of COPY) {
    const dest = join(OUT, to);
    if (existsSync(dest)) { console.log(`  = ${to}`); continue; }
    if (!existsSync(from)) { console.log(`  ! ${from} missing — run npm i tesseract.js`); continue; }
    await copyFile(from, dest);
    console.log(`  + ${to}  ${mb((await stat(dest)).size)}`);
    copied++;
  }

  const langDest = join(OUT, `${LANG}.traineddata`);
  if (existsSync(langDest)) {
    console.log(`  = ${LANG}.traineddata`);
  } else {
    console.log(`  … fetching ${LANG}.traineddata (Cyrillic — English cannot read Mongolian signage)`);
    const res = await fetch(TESSDATA);
    if (!res.ok) throw new Error(`traineddata HTTP ${res.status}`);
    // Gunzipped on the way to disk: tesseract wants the raw file.
    await pipeline(Readable.fromWeb(res.body), createGunzip(), createWriteStream(langDest));
    console.log(`  + ${LANG}.traineddata  ${mb((await stat(langDest)).size)}`);
    copied++;
  }

  const files = await readdir(OUT);
  let total = 0;
  for (const f of files) total += (await stat(join(OUT, f))).size;
  console.log(`\n${files.length} files, ${mb(total)} total in ${OUT}/`);
  console.log(copied === 0 ? "nothing to do." : "done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
