/**
 * Does the cheaper model still SEE what the expensive one sees?
 *
 *   npx tsx scripts/compare-recall.ts <reference.onnx> <candidate.onnx> <image ...>
 *
 * This is the harness NOTES.md demands before any model is swapped for a
 * smaller one, and it exists because of a specific near-miss: int8
 * quantisation looked free on one bright photo — same detections, box IoU
 * 0.95-0.99 — and across 36 real cases turned out to have lost 31% of the
 * detections, EVERY ONE OF THEM A PERSON. A spot check cannot find that.
 *
 * METHOD. Each image is probed across the regime a walking user actually lives
 * in rather than the one that flatters a model: four scales (objects get small
 * as they get far away) and three brightness levels (Ulaanbaatar is dark from
 * mid-afternoon for much of the year). Reference detections are matched to
 * candidate detections by class and IoU > 0.5; anything the reference found and
 * the candidate did not is a MISS.
 *
 * WHAT TO LOOK AT. Not the total. The per-class miss table, and `person` above
 * all — a model that loses distant pedestrians in low light while sounding
 * exactly as confident as a working one is not a cheaper model, it is a broken
 * one. Overall recall above ~90% with no concentration in person/car is the bar
 * for shipping the candidate.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import * as ort from "onnxruntime-node";
import sharp from "sharp";

import { COCO_CLASSES, phraseIdFor } from "../lib/coco";

const CONFIDENCE_THRESHOLD = 0.3;
const IOU_THRESHOLD = 0.45;
const PAD_VALUE = 114;
const BOX_CHANNELS = 4;

/** A detection matches if it is the same class and overlaps this much. */
const MATCH_IOU = 0.5;

/** Object scale: 1.0 is the photo as shot, 0.35 is roughly three times further away. */
const SCALES = [1.0, 0.75, 0.5, 0.35];

/** Exposure: daylight, dusk, night. */
const BRIGHTNESS = [1.0, 0.5, 0.25];

type Det = { className: string; score: number; x: number; y: number; w: number; h: number };

function iou(a: Det, b: Det): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - overlap;
  return union <= 0 ? 0 : overlap / union;
}

function nms(candidates: Det[]): Det[] {
  const kept: Det[] = [];
  for (const c of candidates) {
    if (!kept.some((k) => k.className === c.className && iou(k, c) > IOU_THRESHOLD)) kept.push(c);
  }
  return kept;
}

/** Letterbox to the model's input size, exactly as lib/vision.worker.ts does. */
async function preprocess(buffer: Buffer, size: number) {
  const image = sharp(buffer);
  const meta = await image.metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  const scale = Math.min(size / srcW, size / srcH);
  const drawW = Math.round(srcW * scale);
  const drawH = Math.round(srcH * scale);
  const padX = Math.floor((size - drawW) / 2);
  const padY = Math.floor((size - drawH) / 2);

  const resized = await image
    .resize(drawW, drawH, { fit: "fill" })
    .extend({
      top: padY,
      bottom: size - drawH - padY,
      left: padX,
      right: size - drawW - padX,
      background: { r: PAD_VALUE, g: PAD_VALUE, b: PAD_VALUE },
    })
    .removeAlpha()
    .raw()
    .toBuffer();

  const pixels = size * size;
  const planar = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    planar[i] = resized[i * 3] / 255;
    planar[i + pixels] = resized[i * 3 + 1] / 255;
    planar[i + pixels * 2] = resized[i * 3 + 2] / 255;
  }
  return { planar, scale, padX, padY, srcW, srcH };
}

function decode(
  values: Float32Array,
  channels: number,
  anchors: number,
  box: { scale: number; padX: number; padY: number; srcW: number; srcH: number },
): Det[] {
  const numClasses = channels - BOX_CHANNELS;
  const at = (c: number, a: number) => values[c * anchors + a];
  const out: Det[] = [];

  for (let a = 0; a < anchors; a++) {
    let bestScore = 0;
    let bestClass = -1;
    for (let c = 0; c < numClasses; c++) {
      const s = at(BOX_CHANNELS + c, a);
      if (s > bestScore) {
        bestScore = s;
        bestClass = c;
      }
    }
    if (bestClass < 0 || bestScore <= CONFIDENCE_THRESHOLD) continue;
    const phraseId = phraseIdFor(COCO_CLASSES[bestClass] ?? "");
    if (phraseId === null) continue;

    const cx = at(0, a);
    const cy = at(1, a);
    const w = at(2, a);
    const h = at(3, a);
    const x0 = Math.max(0, (cx - w / 2 - box.padX) / box.scale);
    const y0 = Math.max(0, (cy - h / 2 - box.padY) / box.scale);
    const x1 = Math.min(box.srcW, (cx + w / 2 - box.padX) / box.scale);
    const y1 = Math.min(box.srcH, (cy + h / 2 - box.padY) / box.scale);
    if (x1 <= x0 || y1 <= y0) continue;
    out.push({ className: phraseId, score: bestScore, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }

  out.sort((p, q) => q.score - p.score);
  return nms(out);
}

async function inputSize(session: ort.InferenceSession): Promise<number> {
  const meta = session.inputMetadata[0] as unknown as { shape?: ReadonlyArray<number | string> };
  const dim = meta.shape?.[2];
  return typeof dim === "number" && dim > 0 ? dim : 640;
}

async function run(session: ort.InferenceSession, buffer: Buffer): Promise<Det[]> {
  const size = await inputSize(session);
  const box = await preprocess(buffer, size);
  const tensor = new ort.Tensor("float32", box.planar, [1, 3, size, size]);
  const results = await session.run({ [session.inputNames[0]]: tensor });
  const out = results.output0;
  const [, channels, anchors] = out.dims;
  return decode(out.data as Float32Array, channels, anchors, box);
}

async function main() {
  const [refPath, candPath, ...images] = process.argv.slice(2);
  if (!refPath || !candPath || images.length === 0) {
    console.error("usage: compare-recall.ts <reference.onnx> <candidate.onnx> <image ...>");
    process.exit(2);
  }
  for (const p of [refPath, candPath, ...images]) {
    if (!existsSync(resolve(p))) {
      console.error(`missing: ${p}`);
      process.exit(2);
    }
  }

  const reference = await ort.InferenceSession.create(resolve(refPath), {
    executionProviders: ["cpu"],
  });
  const candidate = await ort.InferenceSession.create(resolve(candPath), {
    executionProviders: ["cpu"],
  });

  console.log(`reference: ${refPath}  (${await inputSize(reference)}px)`);
  console.log(`candidate: ${candPath}  (${await inputSize(candidate)}px)`);
  console.log(
    `${images.length} images x ${SCALES.length} scales x ${BRIGHTNESS.length} brightness ` +
      `= ${images.length * SCALES.length * BRIGHTNESS.length} cases\n`,
  );

  let found = 0;
  let matched = 0;
  let extra = 0;
  const missByClass = new Map<string, number>();
  const foundByClass = new Map<string, number>();
  const worstCases: string[] = [];

  for (const image of images) {
    const original = sharp(resolve(image));
    const meta = await original.metadata();

    for (const scale of SCALES) {
      for (const brightness of BRIGHTNESS) {
        const buffer = await sharp(resolve(image))
          .resize(Math.round((meta.width ?? 640) * scale), Math.round((meta.height ?? 480) * scale))
          .modulate({ brightness })
          .jpeg({ quality: 92 })
          .toBuffer();

        const refDets = await run(reference, buffer);
        const candDets = await run(candidate, buffer);

        const claimed = new Set<Det>();
        let caseMisses = 0;
        for (const r of refDets) {
          found++;
          foundByClass.set(r.className, (foundByClass.get(r.className) ?? 0) + 1);
          const hit = candDets.find(
            (c) => !claimed.has(c) && c.className === r.className && iou(c, r) > MATCH_IOU,
          );
          if (hit) {
            claimed.add(hit);
            matched++;
          } else {
            missByClass.set(r.className, (missByClass.get(r.className) ?? 0) + 1);
            caseMisses++;
          }
        }
        extra += candDets.length - claimed.size;

        if (caseMisses > 0) {
          worstCases.push(
            `${image.split("/").pop()} scale ${scale} bright ${brightness}: ` +
              `missed ${caseMisses}/${refDets.length}`,
          );
        }
      }
    }
  }

  const recall = found === 0 ? 1 : matched / found;
  console.log(`reference found  ${found}`);
  console.log(`candidate matched ${matched}   (recall ${(recall * 100).toFixed(1)}%)`);
  console.log(`candidate extras  ${extra}   (not necessarily wrong — may be real)\n`);

  console.log("per-class recall");
  console.log("-".repeat(52));
  for (const [name, total] of [...foundByClass].sort((a, b) => b[1] - a[1])) {
    const missed = missByClass.get(name) ?? 0;
    const pct = ((total - missed) / total) * 100;
    const flag = name === "person" && pct < 90 ? "  <-- PEOPLE" : "";
    console.log(`  ${name.padEnd(12)} ${String(total - missed).padStart(4)}/${String(total).padEnd(4)}  ${pct.toFixed(0).padStart(3)}%${flag}`);
  }

  if (worstCases.length > 0) {
    console.log("\ncases with misses");
    console.log("-".repeat(52));
    for (const c of worstCases.slice(0, 14)) console.log(`  ${c}`);
    if (worstCases.length > 14) console.log(`  ... and ${worstCases.length - 14} more`);
  }

  const personTotal = foundByClass.get("person") ?? 0;
  const personMissed = missByClass.get("person") ?? 0;
  const personRecall = personTotal === 0 ? 1 : (personTotal - personMissed) / personTotal;

  console.log("\nverdict");
  console.log("-".repeat(52));
  if (recall >= 0.9 && personRecall >= 0.9) {
    console.log("  Candidate holds up. Recall and person-recall both >= 90%.");
  } else {
    console.log(`  DO NOT SHIP as a straight swap. overall ${(recall * 100).toFixed(0)}%, ` +
      `person ${(personRecall * 100).toFixed(0)}%.`);
  }
}

void main();
