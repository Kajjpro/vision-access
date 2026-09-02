/**
 * End-to-end check of the chain the app actually depends on:
 *
 *   image -> ONNX -> boxes -> class names -> distance -> the wav files spoken
 *
 *   npx tsx scripts/verify-pipeline.ts [image ...]
 *
 * Runs the SHIPPED model from public/models through onnxruntime-node, decoding
 * it with the same maths as lib/vision.worker.ts, then feeds the result through
 * the real lib/distance.ts and lib/phrases.ts. Nothing here is mocked, so a
 * mismatch between the export's class count, DETECTION_CLASSES, and the files in
 * public/audio fails here rather than silently on a phone — where the failure
 * mode is an obstacle announced with no name, or no announcement at all.
 *
 * Exits non-zero on any failure, so it can gate a deploy.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import * as ort from "onnxruntime-node";
import sharp from "sharp";

import {
  DEFAULT_PITCH_DEG,
  announcementFor,
  distanceBucket,
  estimateObjectDistance,
} from "../lib/distance";
import type { CameraPose } from "../lib/distance";
import { COCO_CLASSES, phraseIdFor } from "../lib/coco";
import { PHRASES } from "../lib/phrases";

// Must match lib/vision.worker.ts exactly, or this proves nothing about the app.
const MODEL = "public/models/yolo11s.onnx";
const INPUT_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.3;
const IOU_THRESHOLD = 0.45;
const PAD_VALUE = 114;
const BOX_CHANNELS = 4;

/** Camera pose the app assumes while walking. */
const CAMERA_HEIGHT_M = 1.4;

type Detection = {
  classId: number;
  className: string;
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function iou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - overlap;
  return union <= 0 ? 0 : overlap / union;
}

function nms(candidates: Detection[]): Detection[] {
  const kept: Detection[] = [];
  for (const candidate of candidates) {
    if (!kept.some((k) => k.classId === candidate.classId && iou(k, candidate) > IOU_THRESHOLD)) {
      kept.push(candidate);
    }
  }
  return kept;
}

async function detect(session: ort.InferenceSession, imagePath: string) {
  const image = sharp(imagePath).removeAlpha();
  const meta = await image.metadata();
  const srcW = meta.width!;
  const srcH = meta.height!;

  // Letterbox: uniform scale, centre pad with 114 — identical to preprocess().
  const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
  const drawW = Math.round(srcW * scale);
  const drawH = Math.round(srcH * scale);
  const padX = Math.floor((INPUT_SIZE - drawW) / 2);
  const padY = Math.floor((INPUT_SIZE - drawH) / 2);

  const { data } = await image
    .resize(drawW, drawH)
    .extend({
      top: padY,
      bottom: INPUT_SIZE - drawH - padY,
      left: padX,
      right: INPUT_SIZE - drawW - padX,
      background: { r: PAD_VALUE, g: PAD_VALUE, b: PAD_VALUE },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Interleaved RGB -> planar, 0..1.
  const pixels = INPUT_SIZE * INPUT_SIZE;
  const planar = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    planar[i] = data[i * 3] / 255;
    planar[i + pixels] = data[i * 3 + 1] / 255;
    planar[i + pixels * 2] = data[i * 3 + 2] / 255;
  }

  const started = performance.now();
  const results = await session.run({
    [session.inputNames[0]]: new ort.Tensor("float32", planar, [1, 3, INPUT_SIZE, INPUT_SIZE]),
  });
  const inferenceMs = performance.now() - started;

  const output = results.output0;
  const [, channels, anchors] = output.dims;
  const numClasses = channels - BOX_CHANNELS;
  const values = output.data as Float32Array;
  const at = (c: number, a: number) => values[c * anchors + a];

  const candidates: Detection[] = [];
  for (let a = 0; a < anchors; a++) {
    let bestScore = 0;
    let bestClass = -1;
    for (let c = 0; c < numClasses; c++) {
      const score = at(BOX_CHANNELS + c, a);
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestClass < 0 || bestScore <= CONFIDENCE_THRESHOLD) continue;

    // The vocabulary seam, exactly as lib/vision.worker.ts applies it: the
    // model speaks COCO, the app speaks phrase ids, and a class with no mapping
    // is dropped rather than announced namelessly.
    const phraseId = phraseIdFor(COCO_CLASSES[bestClass] ?? "");
    if (phraseId === null) continue;

    const cx = at(0, a);
    const cy = at(1, a);
    const w = at(2, a);
    const h = at(3, a);
    const x0 = Math.max(0, (cx - w / 2 - padX) / scale);
    const y0 = Math.max(0, (cy - h / 2 - padY) / scale);
    const x1 = Math.min(srcW, (cx + w / 2 - padX) / scale);
    const y1 = Math.min(srcH, (cy + h / 2 - padY) / scale);
    if (x1 <= x0 || y1 <= y0) continue;

    candidates.push({
      classId: bestClass,
      className: phraseId,
      score: bestScore,
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0,
    });
  }

  candidates.sort((p, q) => q.score - p.score);
  return { boxes: nms(candidates), srcW, srcH, inferenceMs, numClasses };
}

/**
 * The close-range bug, as geometry rather than as prose.
 *
 * A wall ~10 cm from the lens fills the frame: its box spans the full height, so
 * its base is below the bottom edge and the ground-plane model reads the lowest
 * visible pixel as the contact point. Before the confidence signal that returned
 * roughly a metre, stated as fact.
 */
function checkCloseRange() {
  console.log("\n=== close range (the reported bug) ===");

  const pose: CameraPose = {
    frameWidth: 640,
    frameHeight: 480,
    pitchDeg: DEFAULT_PITCH_DEG,
    cameraHeightM: CAMERA_HEIGHT_M,
    // DEFAULT_PITCH_DEG is the fallback, not a reading, so this must say so:
    // it is what makes estimateObjectDistance() use the pitch-independent
    // size prior instead of a ground plane it cannot trust.
    pitchMeasured: false,
  };

  // A wall filling the frame. No height prior exists for `wall`, by design.
  const wall = { x: 0, y: 0, w: 640, h: 480 };
  const wallEstimate = estimateObjectDistance(wall, "wall", pose);
  const wallSaid = announcementFor(wallEstimate, "wall");

  console.log(
    `  full-frame wall -> metres=${wallEstimate.metres}, reliable=${wallEstimate.reliable}, ` +
      `tone=${wallSaid.tone}, clips=[${wallSaid.clips.join(", ")}]`,
  );
  check(!wallEstimate.reliable, "full-frame object is marked unreliable");
  check(wallEstimate.metres <= 1, "full-frame object is treated as VERY CLOSE, not far");
  check(wallSaid.tone, "full-frame object triggers the urgent tone");
  check(wallSaid.clips.includes("very_close"), 'full-frame object says "very close"');
  check(
    !wallSaid.clips.some((c) => c.startsWith("m_")),
    "full-frame object never speaks a number",
  );
  check(distanceBucket(wallEstimate) === "urgent", "full-frame object is bucketed urgent");

  // Sorting: the unmeasurable close object must outrank a measured farther one.
  const farPerson = { x: 300, y: 300, w: 40, h: 110 };
  const farEstimate = estimateObjectDistance(farPerson, "person", pose);
  check(
    wallEstimate.metres < farEstimate.metres,
    "unmeasurable close object sorts ahead of a measured one",
    `${wallEstimate.metres} vs ${farEstimate.metres.toFixed(1)}`,
  );

  // A base near the frame's bottom edge makes the GROUND estimate suspect —
  // the true contact point may be below the frame, which reads as too far.
  //
  // That alone no longer condemns the whole estimate. It used to, and the cost
  // was severe: this box is a person whose feet are 5px clear of the edge, so
  // they are fully visible and the height prior measures them perfectly well.
  // Marking it unreliable made announcementFor() return SILENT, so a visible
  // person four metres ahead produced no warning at all. The rule is now
  // narrower — the ground vote is dropped, and reliability follows whether any
  // estimator that does NOT read the bottom edge survived.
  const clipped = { x: 250, y: 300, w: 100, h: 175 };
  check(
    estimateObjectDistance(clipped, "person", pose).reliable,
    "a clipped base is carried by the size priors rather than silencing the warning",
  );

  // With no size prior at all there is nothing to carry it, and the guard still
  // applies: `pole` has neither a height nor a width prior by design.
  const clippedNoPrior = { x: 250, y: 300, w: 30, h: 175 };
  check(
    !estimateObjectDistance(clippedNoPrior, "pole", pose).reliable,
    "a clipped base with no size prior stays unreliable",
  );

  // Above the horizon there is no ground intersection at all.
  const sky = { x: 300, y: 5, w: 40, h: 20 };
  const skyEstimate = estimateObjectDistance(sky, "sign", pose);
  check(!skyEstimate.reliable, "box above the horizon is unreliable");
  check(
    announcementFor(skyEstimate, "sign").clips.length === 0,
    "unreliable-but-not-close stays silent rather than crying wolf",
  );

  // A normal, well-formed detection must still speak a number.
  const normal = { x: 280, y: 210, w: 70, h: 190 };
  const normalEstimate = estimateObjectDistance(normal, "person", pose);
  const normalSaid = announcementFor(normalEstimate, "person");
  console.log(
    `  mid-frame person -> metres=${normalEstimate.metres.toFixed(1)}, ` +
      `reliable=${normalEstimate.reliable}, clips=[${normalSaid.clips.join(", ")}]`,
  );
  check(normalEstimate.reliable, "an ordinary detection is still reliable");
  check(
    normalSaid.clips.length > 0 && !normalSaid.tone,
    "an ordinary detection speaks without the urgent tone",
  );
}

async function main() {
  const modelPath = resolve(process.cwd(), MODEL);
  if (!existsSync(modelPath)) {
    console.error(`No model at ${modelPath} — run model/yoloe_export.py first.`);
    process.exit(1);
  }

  const images = process.argv.slice(2);
  if (images.length === 0) images.push("model/samples/bus.jpg");

  checkCloseRange();

  console.log("=== contract between model, phrases and audio ===");
  const session = await ort.InferenceSession.create(modelPath);
  const outMeta = session.outputMetadata[0];
  const channels = (outMeta.isTensor ? outMeta.shape[1] : 0) as number;

  check(session.inputMetadata.length === 1, "model takes exactly one input (no text encoder)");
  check(session.outputMetadata.length === 1, "model has one output (segmentation stripped)");
  check(
    channels === BOX_CHANNELS + COCO_CLASSES.length,
    "output0 channels match COCO_CLASSES",
    `${channels} vs 4+${COCO_CLASSES.length}`,
  );

  // Every name the app can speak must exist as a decoded clip, or the warning is
  // silent at exactly the moment it matters.
  const missing = PHRASES.filter((p) => !existsSync(resolve(`public/audio/${p.id}.wav`)));
  check(missing.length === 0, "every phrase has a wav", missing.map((p) => p.id).join(", "));

  for (const image of images) {
    console.log(`\n=== ${image} ===`);
    const { boxes, srcW, srcH, inferenceMs } = await detect(session, resolve(image));
    const pose: CameraPose = {
      frameWidth: srcW,
      frameHeight: srcH,
      pitchDeg: DEFAULT_PITCH_DEG,
      cameraHeightM: CAMERA_HEIGHT_M,
      pitchMeasured: false,
    };

    console.log(`  ${srcW}x${srcH}, ${boxes.length} objects after NMS, ${inferenceMs.toFixed(0)}ms\n`);
    check(boxes.length > 0, "at least one object detected");

    const spoken = boxes
      .map((b) => ({ b, e: estimateObjectDistance(b, b.className, pose) }))
      .sort((p, q) => p.e.metres - q.e.metres);

    for (const { b, e } of spoken) {
      const bucket = distanceBucket(e);
      const { tone, clips } = announcementFor(e, b.className);

      // What the user would actually hear, in order.
      const words = clips.map((id) => PHRASES.find((p) => p.id === id)?.mn ?? `?${id}?`);
      const sentence =
        !tone && clips.length === 0
          ? "(silent — beyond the warning range)"
          : `${tone ? "[BEEP] " : ""}"${words.join(" ")}"`;

      const shown = e.reliable ? `${e.metres.toFixed(1)}m` : "unreliable";
      console.log(
        `  ${b.className.padEnd(12)} ${b.score.toFixed(2)}  ${shown.padEnd(10)} ${bucket.padEnd(6)} ${sentence}`,
      );

      for (const id of clips) {
        check(
          PHRASES.some((p) => p.id === id),
          `clip "${id}" has a phrase`,
        );
      }
      // The rule that matters most: no number is ever spoken for an estimate the
      // geometry cannot support.
      check(
        e.reliable || !clips.some((id) => id.startsWith("m_")),
        `unreliable estimate for "${b.className}" speaks no number`,
      );
    }
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
