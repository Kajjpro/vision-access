/**
 * COCO object detection, off the main thread.
 *
 * The model is a stock COCO-80 YOLO11 detector exported by
 * model/coco_export.py: one image input, one output0, no text encoder and
 * nothing open-vocabulary. lib/coco.ts translates its 80 class names into the
 * dozen phrase ids this app speaks, so everything downstream of this file sees
 * only the app's own vocabulary.
 *
 * Load as a module worker — onnxruntime-web is ESM:
 *   new Worker(new URL("../lib/vision.worker.ts", import.meta.url), { type: "module" })
 *
 * Protocol
 *   in   { type: "frame", bitmap: ImageBitmap }   transferred, closed here
 *   in   { type: "configure", ... }               benchmark knobs
 *   out  { type: "ready", backend, threads, isolated }
 *   out  { type: "detections", boxes, inferenceMs, preprocessMs, skipped, motion }
 *   out  { type: "error", message }               nothing is ever silent
 *
 * Frames arriving mid-inference are DROPPED, never queued: a queue turns a slow
 * device into an ever-growing lag between what the camera sees and what the user
 * hears.
 *
 * The network is also SKIPPED entirely when the scene has not changed — see
 * MOTION GATING below. That is the largest battery saving available here, and
 * the only one that costs no accuracy.
 */
import * as ort from "onnxruntime-web";

import { COCO_CLASSES, phraseIdFor } from "./coco";
import {
  MAX_SKIP_MS,
  MOTION_THRESHOLD,
  createSignature,
  measureFrame,
  motionBetween,
  shouldSkipInference,
} from "./motion";
import { DETECTION_CLASSES } from "./phrases";
import { FULL_PLAN, LEAN_PLAN, type LoadPlan, type PlanId } from "./vision-plan";

/**
 * yolo11s, COCO-80, fp32. 36.3 MB.
 *
 * A SUPERVISED detector, and that is the whole point of it — see lib/coco.ts.
 * The previous file here was YOLOE with a 32-class Mongolian obstacle
 * vocabulary baked in as CLIP text embeddings, and roughly half of those
 * classes scored at noise (0.02-0.14) because the backbone had never seen a
 * labelled box for them. This is a like-for-like swap on download size — it is
 * a megabyte SMALLER than the export it replaced — that trades thirteen
 * classes which never fired for real training on the twelve that do.
 *
 * fp32, and INT8 IS NOT AN OPTION HERE. Measured, twice, on the YOLOE export
 * that preceded this one; the architecture and the failure mode are the same,
 * so the conclusion carries, but the megabyte figures below are that file's.
 * Re-measure before trusting them for this one.
 *
 * INT8 dynamic quantisation took that file from 39.1 MB to 10.2 MB and was
 * ~34% faster on CPU, which over a slow link is the difference between loading
 * and timing out. On a single bright test photo it looked free: same five
 * detections, box IoU 0.95-0.99, distance error 0.2%.
 *
 * It is not free. Across 36 cases (3 images x 4 scales x 3 brightness levels,
 * probing the small-and-dim regime a walking user actually lives in) INT8 lost
 * 31% of the detections fp32 made — 26 of 84 — and EVERY SINGLE ONE OF THEM
 * WAS A PERSON, including one fp32 scored at 0.90. The losses concentrate
 * exactly where they hurt: distant, low light. Ulaanbaatar is dark from
 * mid-afternoon for much of the year.
 *
 * That is not the "silence under uncertainty" CLAUDE.md asks for. It is a
 * detector that is reliably blind to people in the conditions this app exists
 * for, while sounding exactly as confident as a working one. A 39 MB download
 * that takes minutes is a bad experience; missing a third of the pedestrians
 * in front of someone who cannot see them is a different category of thing.
 *
 * If the download size has to come down, the next thing to measure is fp16
 * (~18.6 MB, and unlike INT8 it keeps a WebGPU path) — run the same recall
 * comparison before shipping it, not just a single well-lit frame.
 */
const MODEL_URL = "/models/yolo11s.onnx";
const INPUT_SIZE = 640;

/**
 * The 5-class export that predates the phrases.ts list, in ITS original order.
 * Kept so an older model on disk still produces correct names instead of
 * labelling a tree "person" — spoken aloud, a wrong name is worse than silence.
 */
const LEGACY_CLASSES = ["tree", "pole", "car", "person", "dog"];

/**
 * The 32-class YOLOE vocabulary, in ITS original order.
 *
 * No longer the shipping model — see MODEL_URL — but a phone that has
 * yoloe-11s.onnx sitting in Cache Storage from a previous visit will keep
 * decoding it until the bumped MODEL_CACHE evicts it. Without this list those
 * detections would go nameless mid-rollout: distance only, on a model that was
 * naming things correctly a minute earlier.
 */
const LEGACY_32_CLASSES = [
  "person", "child", "dog", "cat", "horse", "cow", "bird",
  "car", "bus", "truck", "motorcycle", "bicycle", "scooter", "cart",
  "pole", "tree", "wall", "fence", "door", "window", "stairs", "bench",
  "table", "trash_can", "traffic_light", "sign", "bridge", "curb",
  "hole", "puddle", "ice", "rock",
];

/** Shared, so the mask cache below can key on the identity of the returned list. */
const NO_NAMES: readonly string[] = [];

/**
 * Class names are chosen by matching the model's actual class count. An
 * unrecognised count yields no names at all, so nothing gets mislabelled: the
 * UI falls back to announcing distance alone.
 *
 * NOTE: the four lists must stay different lengths, since length is the only
 * thing distinguishing them. They are 80 / 32 / 25 / 5 today. Taking
 * DETECTION_CLASSES to exactly 32 or 80 would silently start naming the
 * deployed model with the wrong vocabulary — every object announced as some
 * other object, confidently, to someone who cannot look up and check.
 */
function classNamesFor(numClasses: number): readonly string[] {
  // The shipping model. A stock COCO-80 detection export, and the only entry
  // here whose classes were actually TRAINED rather than prompted — see
  // lib/coco.ts for why that swap happened.
  if (numClasses === COCO_CLASSES.length) return COCO_CLASSES;
  if (numClasses === DETECTION_CLASSES.length) return DETECTION_CLASSES;
  if (numClasses === LEGACY_32_CLASSES.length) return LEGACY_32_CLASSES;
  if (numClasses === LEGACY_CLASSES.length) return LEGACY_CLASSES;
  return NO_NAMES;
}

/**
 * Model class index -> the phrase id to announce, or null for "drop it".
 *
 * THE VOCABULARY SEAM. The model speaks COCO ("dining table", "chair") and the
 * app speaks phrase ids that name .wav files ("table", "bench"). Translating
 * here, once, at the only boundary where both are visible, is what let the
 * detector be swapped without touching the tracker, the distance model, the
 * announcement logic or the audio: everything downstream of this file has only
 * ever seen phrase ids and still does.
 *
 * It also does the curation. COCO detects toothbrushes and giraffes; a class
 * with no entry in COCO_TO_PHRASE returns null and never reaches the user,
 * which matters because CLAUDE.md allows ONE spoken warning per 1.5 seconds —
 * a correctly-detected teddy bear is a car that went unsaid.
 *
 * Matched by NAME, never by index, so a re-export that renumbers every class
 * needs no change here.
 */
const phraseCache = new WeakMap<readonly string[], (string | null)[]>();

/** null means "do not filter" — an unnamed model still produces usable boxes. */
function phraseIds(names: readonly string[]): (string | null)[] | null {
  if (names.length === 0) return null;
  let ids = phraseCache.get(names);
  if (!ids) {
    // Built once per name list: decode consults this 8400 times a frame.
    ids = names.map(phraseIdFor);
    phraseCache.set(names, ids);
  }
  return ids;
}

/** output0 is [1, 4 + numClasses, numAnchors]; the class count is read at runtime. */
const BOX_CHANNELS = 4;

/**
 * 0.30, down from 0.40.
 *
 * Not an attempt to rescue the zero-shot classes — measured peaks for those
 * are 0.02-0.14, and no threshold recovers signal that is not there. This is
 * for the COCO-native classes at range: a person or a car that scores 0.9
 * filling the frame scores far lower as a small box across the street, and 0.4
 * was cutting those off while they were still the thing worth warning about.
 *
 * The false positives this lets in are caught downstream rather than here:
 * WalkMode requires CONFIRM_HITS frames of agreement before it will speak, so
 * a detection that flickers at 0.31 for one frame never reaches the user.
 * Lowering this without that confirmation step would have been reckless.
 */
const CONFIDENCE_THRESHOLD = 0.3;
const IOU_THRESHOLD = 0.45;

/** Letterbox fill, matching the value YOLO training pipelines use. */
const PAD_VALUE = 114;

export type Detection = {
  classId: number;
  className: string;
  score: number;
  /** Pixel coords in the ORIGINAL frame, not the letterboxed 640x640 input. */
  x: number;
  y: number;
  w: number;
  h: number;
};

export type WorkerRequest =
  /**
   * Begins the load. NOTHING LOADS UNTIL THIS ARRIVES: which plan to use is
   * decided from a breadcrumb in localStorage, and a worker cannot read it.
   */
  | { type: "start"; plan: LoadPlan }
  | { type: "frame"; bitmap: ImageBitmap }
  /** Runtime knobs, for app/dev/bench to measure with and without gating. */
  | { type: "configure"; motionGating?: boolean; motionThreshold?: number };

export type WorkerResponse =
  /** Model download progress. total is 0 when the server sends no length. */
  | { type: "progress"; loaded: number; total: number }
  /** `plan` is the one that actually worked, which is not always the one asked for. */
  | { type: "ready"; backend: string; threads: number; isolated: boolean; plan: PlanId }
  | {
      type: "detections";
      boxes: Detection[];
      /** Whole turn: preprocess + run + decode. Compare against the 60ms budget. */
      inferenceMs: number;
      /** Just the capture-to-tensor half, so a slow model and a slow copy are distinguishable. */
      preprocessMs: number;
      luma: number;
      /** True when the network was SKIPPED because the scene had not changed. */
      skipped: boolean;
      /** How different this frame was from the last, 0..1. The gating signal itself. */
      motion: number;
    }
  | { type: "error"; message: string };

// tsconfig `lib` is dom-only, so DedicatedWorkerGlobalScope is not available.
interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
}
const ctx = self as unknown as WorkerScope;

function post(message: WorkerResponse) {
  ctx.postMessage(message);
}

function fail(context: string, e: unknown) {
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  post({ type: "error", message: `${context}: ${detail}` });
}

// The .wasm binary is fetched at runtime and must be same-origin: COEP is
// require-corp (next.config.ts), so ort's CDN default would be blocked.
ort.env.wasm.wasmPaths = "/wasm/";
/**
 * Threads need SharedArrayBuffer, which needs cross-origin isolation.
 *
 * Capped at 2 rather than 4 even on the full plan. Every extra wasm thread is
 * another worker with its own stack sharing one growable SharedArrayBuffer AND
 * its own arena for intermediate tensors, and on a phone the ceiling that
 * matters is the tab's total memory, not the core count.
 *
 * The plan's cap is applied on top: `lean` asks for one thread, which is how a
 * phone that could not hold the full configuration gets the arena back.
 */
function isolated(): boolean {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
}

function applyThreads(plan: LoadPlan) {
  const cores = navigator.hardwareConcurrency || 1;
  const wanted = Math.min(cores > 4 ? 4 : 2, cores, plan.maxThreads);
  ort.env.wasm.numThreads = isolated() ? Math.max(1, wanted) : 1;
}

let session: ort.InferenceSession | null = null;
let busy = false;

// Allocated once. A per-frame 640x640 canvas or a 1.2M-element array is a GC
// stall the 60ms budget cannot absorb.
const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
const canvasCtx = canvas.getContext("2d", { willReadFrequently: true });
const planar = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);

/** Maps letterboxed 640x640 coords back to original-frame coords. */
type Letterbox = { scale: number; padX: number; padY: number; srcW: number; srcH: number };

function preprocess(bitmap: ImageBitmap): Letterbox {
  if (!canvasCtx) throw new Error("2D context unavailable in worker");

  // Uniform scale + centre pad. Squashing to a square would distort every box
  // and change what a person looks like at the frame edge.
  const scale = Math.min(INPUT_SIZE / bitmap.width, INPUT_SIZE / bitmap.height);
  const drawW = Math.round(bitmap.width * scale);
  const drawH = Math.round(bitmap.height * scale);
  const padX = (INPUT_SIZE - drawW) / 2;
  const padY = (INPUT_SIZE - drawH) / 2;

  canvasCtx.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`;
  canvasCtx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  canvasCtx.drawImage(bitmap, padX, padY, drawW, drawH);

  const { data } = canvasCtx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const pixels = INPUT_SIZE * INPUT_SIZE;

  // RGBA interleaved -> RGB planar (channel-first), 0..255 -> 0..1.
  for (let i = 0; i < pixels; i++) {
    planar[i] = data[i * 4] / 255;
    planar[i + pixels] = data[i * 4 + 1] / 255;
    planar[i + pixels * 2] = data[i * 4 + 2] / 255;
  }

  lastLuma = measureFrame(data, INPUT_SIZE, signature);

  return { scale, padX, padY, srcW: bitmap.width, srcH: bitmap.height };
}

/**
 * MOTION GATING — the one battery saving that costs no accuracy.
 *
 * Running a 21.6 GFLOP network eleven times a second at a scene that has not
 * changed is the single largest pointless expense in this app. Standing at a
 * bus stop, waiting to cross, sitting on the bus, phone pointed at the ground:
 * in all of them the previous answer is still the correct answer, and the
 * device is burning through the battery to recompute it.
 *
 * The check is a coarse luma grid — 16x16 cells, sampled every 8th pixel — and
 * it is nearly free because it rides along with the brightness pass that
 * already had to read these pixels. When the mean absolute difference against
 * the previous frame is below MOTION_THRESHOLD, session.run() is skipped and
 * the previous boxes are returned unchanged.
 *
 * WHY RETURNING THE OLD BOXES IS CORRECT, not a lie: the scene did not change,
 * so the objects are still where they were. Re-reporting them keeps the tracker
 * alive with the right geometry, and a static scene correctly yields a closing
 * speed of zero.
 *
 * THE SAFETY BOUND is MAX_SKIP_MS. A change too gradual to trip the threshold —
 * something approaching very slowly, or a slow pan — must not be able to hide
 * indefinitely, so a real inference is forced at least this often no matter how
 * still the frame looks. That caps the worst-case added latency rather than
 * leaving it open-ended, which is the only form this optimisation is allowed to
 * take in an app someone crosses roads with.
 */
let motionGating = true;
let motionThreshold = MOTION_THRESHOLD;

/** Two buffers, swapped each frame, so neither is reallocated. */
let signature = createSignature();
let prevSignature = createSignature();
let hasPrevSignature = false;

/** The last real detections, replayed while the scene holds still. */
let lastBoxes: Detection[] = [];

/**
 * When the network last actually ran. MAX_SKIP_MS is measured from here, so a
 * run of skipped frames cannot extend its own deadline — the ceiling is on time
 * since real evidence, not time since the last decision.
 */
let lastSkipBaseMs = 0;

/** Last measured frame brightness, reported alongside the detections. */
let lastLuma = 1;

function iou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - overlap;
  return union <= 0 ? 0 : overlap / union;
}

/**
 * Greedy per-class NMS. Input must be sorted by score, descending.
 *
 * Suppresses on the PHRASE ID rather than the model's class index, which
 * matters now that two COCO classes can map to one spoken word: `bench` (13)
 * and `chair` (56) are both "Сандал". Keyed on classId, one chair scored as
 * both would survive as two boxes, become two tracks, and be announced twice —
 * out of a budget of one warning per 1.5 seconds. Two boxes the user cannot
 * tell apart when spoken ARE duplicates, whatever the model called them.
 */
function nms(candidates: Detection[]): Detection[] {
  const kept: Detection[] = [];
  for (const candidate of candidates) {
    const suppressed = kept.some(
      (k) => k.className === candidate.className && iou(k, candidate) > IOU_THRESHOLD,
    );
    if (!suppressed) kept.push(candidate);
  }
  return kept;
}

function decode(output: ort.Tensor, box: Letterbox): Detection[] {
  const [batch, channels, anchors] = output.dims;
  if (batch !== 1 || channels < BOX_CHANNELS + 1) {
    throw new Error(`output0 is [${output.dims.join(", ")}], expected [1, 4+classes, anchors]`);
  }

  // Taken from the tensor, not from CLASS_NAMES: a model exported with a
  // different class list still produces usable boxes, and boxes are all the
  // distance warning needs. Names fall back to classN when the lists disagree.
  const numClasses = channels - BOX_CHANNELS;
  const names = classNamesFor(numClasses);
  const ids = phraseIds(names);

  const data = output.data as Float32Array;
  // Channel-major: the value for channel c at anchor a is data[c * anchors + a].
  const at = (c: number, a: number) => data[c * anchors + a];

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

    // Filtered AFTER the argmax, deliberately — never by excluding channels
    // from the search itself. Masking the argmax would let a street sign the
    // model scored at 0.9 come back as whatever essential class happened to
    // score second, and a confident wrong name is the one failure mode this
    // file already refuses elsewhere: the user cannot look up to check it.
    // Dropping the detection outright is the correct trade.
    const phraseId = ids ? ids[bestClass] : "";
    if (phraseId === null) continue;

    // Centre xywh in letterboxed space -> top-left xywh in original space.
    const cx = at(0, a);
    const cy = at(1, a);
    const w = at(2, a);
    const h = at(3, a);

    const x = (cx - w / 2 - box.padX) / box.scale;
    const y = (cy - h / 2 - box.padY) / box.scale;
    const boxW = w / box.scale;
    const boxH = h / box.scale;

    // Clamp: a box straddling the pad region can land outside the frame.
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(box.srcW, x + boxW);
    const y1 = Math.min(box.srcH, y + boxH);
    if (x1 <= x0 || y1 <= y0) continue;

    candidates.push({
      classId: bestClass,
      // Already the app's phrase id, not the model's own name — translated at
      // the vocabulary seam above, so nothing downstream needs to know the
      // detector speaks COCO. Empty when the class count is unrecognised: the
      // UI then says the distance without naming the object, rather than
      // naming it wrongly.
      className: phraseId,
      score: bestScore,
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0,
    });
  }

  candidates.sort((p, q) => q.score - p.score);
  return nms(candidates);
}

async function handleFrame(bitmap: ImageBitmap) {
  // Not ready, or still working: drop it and free it immediately.
  if (!session || busy) {
    bitmap.close();
    return;
  }

  busy = true;
  const started = performance.now();

  try {
    const box = preprocess(bitmap);
    const preprocessMs = performance.now() - started;

    // Decided with the pixels already in hand, after preprocess() has filled
    // `signature`. Comparing before the copy would need a second decode of the
    // frame, which is most of what skipping was meant to save.
    const motion = hasPrevSignature ? motionBetween(signature, prevSignature) : 1;
    const skip = shouldSkipInference({
      enabled: motionGating,
      hasPrevious: hasPrevSignature,
      motion,
      threshold: motionThreshold,
      msSinceRealInference: performance.now() - lastSkipBaseMs,
      maxSkipMs: MAX_SKIP_MS,
    });

    // Swapped rather than copied: two buffers, neither reallocated per frame.
    const previous = prevSignature;
    prevSignature = signature;
    signature = previous;
    hasPrevSignature = true;

    if (skip) {
      post({
        type: "detections",
        // The scene did not change, so the previous answer is still the correct
        // one. Replaying it keeps every track alive with the right geometry.
        boxes: lastBoxes,
        luma: lastLuma,
        inferenceMs: Math.round(performance.now() - started),
        preprocessMs: Math.round(preprocessMs),
        skipped: true,
        motion,
      });
      return;
    }

    const tensor = new ort.Tensor("float32", planar, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const results = await session.run({ [session.inputNames[0]]: tensor });
    const boxes = decode(results.output0, box);

    lastBoxes = boxes;
    lastSkipBaseMs = performance.now();

    post({
      type: "detections",
      boxes,
      luma: lastLuma,
      // Whole turn: preprocess + run + decode. This is the number to compare
      // against the 60ms budget.
      inferenceMs: Math.round(performance.now() - started),
      preprocessMs: Math.round(preprocessMs),
      skipped: false,
      motion,
    });
  } catch (e) {
    fail("inference failed", e);
  } finally {
    bitmap.close();
    busy = false;
  }
}

ctx.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as WorkerRequest;
  if (msg?.type === "start") {
    if (started) return;
    started = true;
    // An unrecognised or absent plan falls back to the fast one rather than to
    // nothing: a worker that silently refuses to load is the failure mode the
    // plan machinery exists to prevent.
    void load(msg.plan ?? FULL_PLAN);
    return;
  }

  if (msg?.type === "frame") {
    void handleFrame(msg.bitmap);
    return;
  }
  if (msg?.type === "configure") {
    // Exists so app/dev/bench can measure the SAME device with gating on and
    // off. A saving claimed from two different runs on two different scenes is
    // not a measurement.
    if (typeof msg.motionGating === "boolean") motionGating = msg.motionGating;
    if (typeof msg.motionThreshold === "number") motionThreshold = msg.motionThreshold;
  }
});

/**
 * Model download can stall on a slow tunnel; session init can hang on a bad GPU
 * driver.
 *
 * The download bound is 10 minutes and not the old 5 because 5 was quietly
 * doing the opposite of its job. This model is 39 MB, and it does not download
 * alone — WalkMode starts the worker and decodes the ~5.6 MB phrase set at the
 * same time, over the same link. On anything slower than a good 4G connection
 * the model's share runs past 5 minutes easily, and a bound that trips on a
 * download still making steady progress reports a hang that is not happening
 * and costs the user the whole session.
 *
 * This is a hang detector, not a patience budget. It belongs far enough above
 * the worst plausible real download that firing means something is wedged.
 * Progress is already visible meanwhile: streamToBuffer() posts every 250 ms
 * and WalkMode renders it as a percentage.
 */
const DOWNLOAD_TIMEOUT_MS = 600_000;
const SESSION_TIMEOUT_MS = 120_000;

/**
 * Turns a hang into a reportable failure. Without this, a stalled download or a
 * wedged WebGPU init leaves the UI on "model loading…" forever with nothing to
 * show the user — the exact failure this app must never have.
 */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Fetched here rather than handing ort a URL, so the download reports progress.
 * On a phone over a tunnel this is minutes of otherwise blank waiting.
 *
 * MEMORY IS THE WHOLE PROBLEM HERE. iOS Safari kills a tab that grows past a few
 * hundred MB and reloads it, which looks exactly like "the page reloads and never
 * works". A ~37 MB model is not big, but it is very easy to hold three or four
 * copies of it at once, and that is fatal. Every allocation below is deliberate:
 * one buffer, filled in place, released the moment ort has taken it.
 */

/** Bump to invalidate cached model bytes after re-exporting. */
const MODEL_CACHE = "vision-model-v4";

/** Everything this app has ever written, so stale versions can be found again. */
const MODEL_CACHE_PREFIX = "vision-model-";

/**
 * Deletes model caches from previous exports.
 *
 * Bumping MODEL_CACHE without this only ADDS a cache: the old entry keeps its
 * copy of the previous model forever. Two or three exports in and the origin is
 * over its Cache Storage quota, `put` starts throwing, and the model is then
 * re-downloaded in full on every single load — slow on desktop, terminal on a
 * phone.
 */
async function purgeStaleModelCaches() {
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(MODEL_CACHE_PREFIX) && k !== MODEL_CACHE)
        .map((k) => caches.delete(k)),
    );
  } catch {
    // Private mode / no Cache API. Nothing to clean up, and nothing to report.
  }
}

/**
 * Streams a response into ONE pre-sized buffer.
 *
 * The obvious version — push chunks into an array, then concatenate — holds the
 * whole model twice at the moment of concatenation. Content-Length lets us size
 * the destination up front and write each chunk straight into it, so the peak is
 * one copy. The chunk-list path is kept only for responses with no length.
 */
async function streamToBuffer(res: Response): Promise<Uint8Array> {
  const total = Number(res.headers.get("content-length") ?? 0);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  let loaded = 0;
  let lastPost = 0;

  const tick = () => {
    const now = performance.now();
    if (now - lastPost > 250) {
      post({ type: "progress", loaded, total });
      lastPost = now;
    }
  };

  if (total > 0) {
    const bytes = new Uint8Array(total);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // A response longer than its own Content-Length would overrun the buffer.
      if (loaded + value.length > total) throw new Error("model longer than Content-Length");
      bytes.set(value, loaded);
      loaded += value.length;
      tick();
    }
    if (loaded !== total) throw new Error(`model truncated: ${loaded}/${total} bytes`);
    post({ type: "progress", loaded, total });
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    tick();
  }
  post({ type: "progress", loaded, total: loaded });

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  chunks.length = 0;
  return bytes;
}

/**
 * The model bytes, from Cache Storage when possible.
 *
 * Note what is NOT done here: `cache.put(url, res.clone())` before reading. A
 * clone tees the stream, so the browser buffers a second full copy in memory
 * while the first is being read. Writing to the cache AFTER the buffer exists
 * costs a little time and no extra peak.
 */
async function fetchModel(): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE);
  } catch {
    cache = null; // Private mode / no Cache API: download every time.
  }

  const hit = cache ? await cache.match(MODEL_URL) : undefined;
  const res = hit ?? (await fetch(MODEL_URL));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const bytes = await streamToBuffer(res);

  if (cache && !hit) {
    try {
      // The underlying buffer, not the view: every path above allocates exactly
      // the model's length, so the two are the same bytes, and handing over the
      // ArrayBuffer avoids a copy that a view would force.
      await cache.put(MODEL_URL, new Response(bytes.buffer as ArrayBuffer));
    } catch {
      // Over quota. The model still works this session; it just re-downloads
      // next time. Not worth failing the load over.
    }
  }

  return bytes;
}

async function load(plan: LoadPlan) {
  await purgeStaleModelCaches();

  // Download and init are timed separately: the download legitimately takes
  // minutes on a phone, while a session init that slow means something is wedged.
  const create = async (attempt: LoadPlan) => {
    applyThreads(attempt);
    // Re-read per attempt because ort detaches the buffer into wasm memory, so
    // the same bytes cannot be handed to a second attempt. This is a Cache
    // Storage read, not a network download — fetchModel() populates the cache on
    // the first pass, so the fallback costs a disk read rather than another
    // 37 MB over the wire.
    const bytes = await withTimeout(fetchModel(), DOWNLOAD_TIMEOUT_MS, "model download");
    return withTimeout(
      ort.InferenceSession.create(bytes, {
        executionProviders: [...attempt.providers],
        graphOptimizationLevel: attempt.optimization,
      }),
      SESSION_TIMEOUT_MS,
      "session init",
    );
  };

  /**
   * One throwaway inference before declaring ready. WebGPU compiles its shaders
   * on the first run, which can stall for seconds — paying that here means the
   * first real camera frame is already fast.
   *
   * Reuses the frame buffer rather than allocating a second one: on the backend
   * that is most likely to be memory-starved, a spare 4.7 MB at exactly the
   * moment the GPU is uploading weights is not worth the tidiness.
   *
   * Throws on failure. A backend that cannot complete one blank inference cannot
   * do a real one either, and reporting "ready" here would send every subsequent
   * camera frame into a broken session — a silent failure, which for a user who
   * cannot see the screen means the app simply stops warning them.
   */
  const warmUp = async (s: ort.InferenceSession) => {
    planar.fill(0);
    await s.run({
      [s.inputNames[0]]: new ort.Tensor("float32", planar, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    });
  };

  try {
    session = await create(plan);
    await warmUp(session);
    post({
      type: "ready",
      backend: plan.providers.join("/"),
      threads: ort.env.wasm.numThreads ?? 1,
      isolated: isolated(),
      plan: plan.id,
    });
    return;
  } catch (e) {
    /**
     * A plan that is ALREADY lean has nowhere to fall back to, and retrying it
     * would only spend another 38 MB proving the same thing.
     */
    if (plan.id === LEAN_PLAN.id) {
      fail("failed to create an inference session", e);
      return;
    }
    // Falls through to a plainer configuration rather than dying here: WebGPU
    // and threaded wasm are the two parts most likely to wedge on mobile Safari.
    // Release first — a half-initialised WebGPU session still holds its weight
    // buffers, and the wasm attempt needs that memory back.
    try {
      await session?.release();
    } catch {
      // Already dead; nothing to reclaim.
    }
    session = null;

    post({
      type: "error",
      message: `webgpu/wasm failed (${e instanceof Error ? e.message : String(e)}) — retrying single-threaded wasm`,
    });
  }

  try {
    session = await create(LEAN_PLAN);
    await warmUp(session);
    post({
      type: "ready",
      backend: "wasm (1 thread)",
      threads: 1,
      isolated: isolated(),
      plan: LEAN_PLAN.id,
    });
  } catch (e) {
    fail("failed to create an inference session", e);
  }
}

/** A second `start` would build a second session beside the first one. */
let started = false;
