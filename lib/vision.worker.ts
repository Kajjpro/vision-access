/**
 * YOLOE inference, off the main thread.
 *
 * The model is a 32-class detector exported by model/yoloe_export.py, which
 * bakes the class vocabulary in at export time via set_classes(). Nothing
 * open-vocabulary survives into the browser: there is no text encoder here and
 * no second input, just images -> output0. Re-exporting is how the class list
 * changes; see model/classes.txt, generated from phrases.ts.
 *
 * Load as a module worker — onnxruntime-web is ESM:
 *   new Worker(new URL("../lib/vision.worker.ts", import.meta.url), { type: "module" })
 *
 * Protocol
 *   in   { type: "start", plan }                  begins the load; see below
 *   in   { type: "frame", bitmap: ImageBitmap }   transferred, closed here
 *   out  { type: "ready", backend, plan }         model loaded, frames accepted
 *   out  { type: "detections", boxes, inferenceMs }
 *   out  { type: "error", message }               nothing is ever silent
 *
 * NOTHING LOADS UNTIL `start` ARRIVES. The load used to begin on module
 * evaluation, which is one message earlier and was worth it right up until the
 * configuration stopped being a constant. Which plan to use is decided from a
 * breadcrumb in localStorage, and a worker cannot read localStorage — so the
 * main thread has to hand it over, and the load has to wait for it.
 *
 * Frames arriving mid-inference are DROPPED, never queued: a queue turns a slow
 * device into an ever-growing lag between what the camera sees and what the user
 * hears.
 */
import * as ort from "onnxruntime-web";

import { DETECTION_CLASSES } from "./phrases";
import { FULL_PLAN, LEAN_PLAN, type LoadPlan, type PlanId } from "./vision-plan";

const MODEL_URL = "/models/yoloe-11s.onnx";
const INPUT_SIZE = 640;

/**
 * The 5-class export that predates the phrases.ts list, in ITS original order.
 * Kept so an older model on disk still produces correct names instead of
 * labelling a tree "person" — spoken aloud, a wrong name is worse than silence.
 */
const LEGACY_CLASSES = ["tree", "pole", "car", "person", "dog"];

/**
 * Class names are chosen by matching the model's actual class count. An
 * unrecognised count yields no names at all, so nothing gets mislabelled: the
 * UI falls back to announcing distance alone.
 */
function classNamesFor(numClasses: number): readonly string[] {
  if (numClasses === DETECTION_CLASSES.length) return DETECTION_CLASSES;
  if (numClasses === LEGACY_CLASSES.length) return LEGACY_CLASSES;
  return [];
}

/** output0 is [1, 4 + numClasses, numAnchors]; the class count is read at runtime. */
const BOX_CHANNELS = 4;

const CONFIDENCE_THRESHOLD = 0.4;
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
  | { type: "start"; plan: LoadPlan }
  | { type: "frame"; bitmap: ImageBitmap };

export type WorkerResponse =
  /** Model download progress. total is 0 when the server sends no length. */
  | { type: "progress"; loaded: number; total: number }
  /** `plan` is the one that actually worked, which is not always the one asked for. */
  | { type: "ready"; backend: string; plan: PlanId }
  | { type: "detections"; boxes: Detection[]; inferenceMs: number; luma: number }
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
 * matters is the tab's total memory, not the core count — a 4-thread pool buys
 * a few ms of inference and costs headroom the model load needs more. Above 4
 * reported cores the device is a laptop and can afford the extra pair.
 *
 * The plan's cap is applied on top: `lean` asks for one thread, which is how a
 * phone that could not hold the full configuration gets the arena back.
 */
function applyThreads(plan: LoadPlan) {
  const cores = navigator.hardwareConcurrency || 1;
  const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  const wanted = Math.min(cores > 4 ? 4 : 2, cores, plan.maxThreads);
  ort.env.wasm.numThreads = isolated ? Math.max(1, wanted) : 1;
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

  lastLuma = meanLuma(data, pixels);

  return { scale, padX, padY, srcW: bitmap.width, srcH: bitmap.height };
}

/**
 * Mean perceived brightness of the frame, 0..1.
 *
 * In the dark the detector does not fail loudly — it simply stops finding
 * things, which is indistinguishable from an empty pavement to someone who
 * cannot see the screen. CLAUDE.md requires degradation to be announced, and
 * this is the measurement that makes that possible. It matters here in
 * particular: Ulaanbaatar is dark from mid-afternoon for much of the year.
 *
 * Rec. 601 luma, sampled every 16th pixel. The average over a 640x640 frame is
 * not improved by reading all 409,600 of them, and this runs inside the 60ms
 * budget on every frame.
 */
const LUMA_STRIDE = 16;

function meanLuma(data: Uint8ClampedArray, pixels: number): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pixels; i += LUMA_STRIDE) {
    const o = i * 4;
    sum += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    n++;
  }
  return n === 0 ? 1 : sum / n / 255;
}

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

/** Greedy per-class NMS. Input must be sorted by score, descending. */
function nms(candidates: Detection[]): Detection[] {
  const kept: Detection[] = [];
  for (const candidate of candidates) {
    const suppressed = kept.some(
      (k) => k.classId === candidate.classId && iou(k, candidate) > IOU_THRESHOLD,
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
      // Empty when the class count is unrecognised — the UI then says the
      // distance without naming the object, rather than naming it wrongly.
      className: names[bestClass] ?? "",
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
    const tensor = new ort.Tensor("float32", planar, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const results = await session.run({ [session.inputNames[0]]: tensor });
    const boxes = decode(results.output0, box);

    post({
      type: "detections",
      boxes,
      luma: lastLuma,
      // Whole turn: preprocess + run + decode. This is the number to compare
      // against the 60ms budget.
      inferenceMs: Math.round(performance.now() - started),
    });
  } catch (e) {
    fail("inference failed", e);
  } finally {
    bitmap.close();
    busy = false;
  }
}

/** A second `start` would build a second session beside the first one. */
let started = false;

ctx.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as WorkerRequest;

  if (msg?.type === "start") {
    if (started) return;
    started = true;
    // An unrecognised or absent plan falls back to the fast one rather than to
    // nothing: a worker that silently refuses to load is the failure mode this
    // whole file is written against.
    void load(msg.plan ?? FULL_PLAN);
    return;
  }

  if (msg?.type === "frame") void handleFrame(msg.bitmap);
});

/** Model download can stall on a slow tunnel; session init can hang on a bad GPU driver. */
const DOWNLOAD_TIMEOUT_MS = 300_000;
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
const MODEL_CACHE = "vision-model-v3";

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
    post({ type: "ready", backend: plan.providers.join("/"), plan: plan.id });
    return;
  } catch (e) {
    // A plan that is ALREADY lean has nowhere to fall back to, and retrying it
    // would only spend another 37 MB proving the same thing.
    if (plan.id === LEAN_PLAN.id) {
      fail("failed to create an inference session", e);
      return;
    }

    // Falls through to a plainer configuration rather than dying here: WebGPU
    // and threaded wasm are the two parts most likely to wedge on mobile Safari.
    // Release first — a half-initialised WebGPU session still holds its weight
    // buffers, and the lean attempt needs that memory back.
    //
    // This retry is the most memory-expensive moment the worker has: it builds a
    // second session while the first one's buffers may still be in flight. It is
    // kept because a WEDGED WebGPU driver is a different failure from a memory
    // one and is recoverable in-run — but a tab killed here is exactly what pins
    // `lean` for next time, so this path is walked once per device, not once per
    // launch.
    try {
      await session?.release();
    } catch {
      // Already dead; nothing to reclaim.
    }
    session = null;

    post({
      type: "error",
      message: `${plan.providers.join("/")} failed (${e instanceof Error ? e.message : String(e)}) — retrying single-threaded wasm`,
    });
  }

  try {
    session = await create(LEAN_PLAN);
    await warmUp(session);
    post({ type: "ready", backend: "wasm (1 thread)", plan: LEAN_PLAN.id });
  } catch (e) {
    fail("failed to create an inference session", e);
  }
}
