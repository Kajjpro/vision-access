/**
 * YOLO-World inference, off the main thread.
 *
 * Load as a module worker — onnxruntime-web is ESM:
 *   new Worker(new URL("../lib/vision.worker.ts", import.meta.url), { type: "module" })
 *
 * Protocol
 *   in   { type: "frame", bitmap: ImageBitmap }   bitmap transferred, closed here
 *   out  { type: "ready", ... }                   model loaded, safe to send frames
 *   out  { type: "detections", boxes, inferenceMs, dropped }
 *   out  { type: "error", message }               nothing is ever silent
 *
 * Frames that arrive while inference is running are DROPPED, never queued: a
 * queue converts a slow device into an ever-growing lag between what the camera
 * sees and what the user hears.
 */
import * as ort from "onnxruntime-web";

/** Square input the model was exported at. */
const INPUT_SIZE = 640;
/** Budget from CLAUDE.md. Exceeding it is reported, not enforced by throwing. */
const FRAME_BUDGET_MS = 60;
const MODEL_URL = "/models/yolo-world.onnx";

const SCORE_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.45;
const MAX_DETECTIONS = 20;

/** Letterbox fill. Matches the value used by YOLO training/export pipelines. */
const PAD_VALUE = 114;

export type Box = {
  /** Pixel coords in the ORIGINAL frame, not the letterboxed 640x640 input. */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  classId: number;
};

export type WorkerRequest = { type: "frame"; bitmap: ImageBitmap };

export type WorkerResponse =
  | {
      type: "ready";
      inputNames: readonly string[];
      outputNames: readonly string[];
      webgpuAvailable: boolean;
      loadMs: number;
    }
  | {
      type: "detections";
      boxes: Box[];
      /** Whole turn: preprocess + run + decode. This is what to compare to 60ms. */
      inferenceMs: number;
      /** Frames dropped since the last reply, because inference was busy. */
      dropped: number;
    }
  | { type: "error"; message: string };

// Minimal worker-scope shape. tsconfig `lib` is dom-only, so the real
// DedicatedWorkerGlobalScope type is not available here.
interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
}
const ctx = self as unknown as WorkerScope;

function post(message: WorkerResponse) {
  ctx.postMessage(message);
}

function fail(context: string, e: unknown): void {
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  post({ type: "error", message: `${context}: ${detail}` });
}

// The .wasm binary is fetched at runtime and must be same-origin: COEP is
// require-corp (next.config.ts), so the CDN default would be blocked. Copy
// node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm into
// public/wasm/.
ort.env.wasm.wasmPaths = "/wasm/";
// Threads need SharedArrayBuffer, which needs cross-origin isolation.
if (typeof crossOriginIsolated !== "undefined" && crossOriginIsolated) {
  ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
} else {
  ort.env.wasm.numThreads = 1;
}

let session: ort.InferenceSession | null = null;
let busy = false;
let dropped = 0;

// Reused across frames — allocating a 640x640 canvas per frame is a GC stall
// the frame budget cannot absorb.
const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
const canvasCtx = canvas.getContext("2d", { willReadFrequently: true });

/** Maps letterboxed input coords back to original-frame coords. */
type Letterbox = { scale: number; padX: number; padY: number };

function preprocess(bitmap: ImageBitmap): { tensor: ort.Tensor; box: Letterbox } {
  if (!canvasCtx) throw new Error("2D context unavailable in worker");

  // Letterbox: uniform scale + centre pad, so aspect ratio survives and a
  // person at the frame edge is not squashed into a different shape.
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

  // RGBA interleaved -> NCHW planar float32, 0..1.
  const planar = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    planar[i] = data[i * 4] / 255;
    planar[i + pixels] = data[i * 4 + 1] / 255;
    planar[i + pixels * 2] = data[i * 4 + 2] / 255;
  }

  return {
    tensor: new ort.Tensor("float32", planar, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    box: { scale, padX, padY },
  };
}

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - overlap;
  return union <= 0 ? 0 : overlap / union;
}

/** Greedy per-class NMS. Input must be sorted by score, descending. */
function nms(boxes: Box[]): Box[] {
  const kept: Box[] = [];
  for (const candidate of boxes) {
    if (kept.length >= MAX_DETECTIONS) break;
    const suppressed = kept.some(
      (k) => k.classId === candidate.classId && iou(k, candidate) > IOU_THRESHOLD,
    );
    if (!suppressed) kept.push(candidate);
  }
  return kept;
}

/**
 * Decodes the raw YOLO head: [1, 4 + numClasses, numAnchors], xywh centre form
 * in input-space pixels, class scores already sigmoid'd (the usual export).
 * Some exports emit the transposed [1, numAnchors, 4 + numClasses]; both are
 * accepted by comparing the two trailing dims.
 */
function decode(output: ort.Tensor, box: Letterbox): Box[] {
  const dims = output.dims;
  if (dims.length !== 3 || dims[0] !== 1) {
    throw new Error(
      `unexpected output shape [${dims.join(", ")}] — expected [1, 4+numClasses, numAnchors]. ` +
        `This export needs its own decoder.`,
    );
  }

  const data = output.data as Float32Array;
  // Anchors vastly outnumber channels, so the larger trailing dim is anchors.
  const transposed = dims[1] > dims[2];
  const channels = transposed ? dims[2] : dims[1];
  const anchors = transposed ? dims[1] : dims[2];
  const numClasses = channels - 4;

  if (numClasses < 1) {
    throw new Error(`output has ${channels} channels — too few for 4 box coords + classes`);
  }

  const at = (channel: number, anchor: number) =>
    transposed ? data[anchor * channels + channel] : data[channel * anchors + anchor];

  const candidates: Box[] = [];
  for (let a = 0; a < anchors; a++) {
    let bestScore = 0;
    let bestClass = -1;
    for (let c = 0; c < numClasses; c++) {
      const score = at(4 + c, a);
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestClass < 0 || bestScore < SCORE_THRESHOLD) continue;

    // Centre xywh in letterboxed space -> top-left xywh in original space.
    const cx = at(0, a);
    const cy = at(1, a);
    const w = at(2, a);
    const h = at(3, a);

    candidates.push({
      x: (cx - w / 2 - box.padX) / box.scale,
      y: (cy - h / 2 - box.padY) / box.scale,
      w: w / box.scale,
      h: h / box.scale,
      score: bestScore,
      classId: bestClass,
    });
  }

  candidates.sort((p, q) => q.score - p.score);
  return nms(candidates);
}

async function load() {
  const started = performance.now();
  try {
    session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["webgpu", "wasm"],
      graphOptimizationLevel: "all",
    });

    post({
      type: "ready",
      // Surfaced so the real tensor names/shapes can be checked on the phone —
      // there is no console there.
      inputNames: session.inputNames,
      outputNames: session.outputNames,
      webgpuAvailable: typeof navigator !== "undefined" && "gpu" in navigator,
      loadMs: Math.round(performance.now() - started),
    });
  } catch (e) {
    fail(`failed to load ${MODEL_URL}`, e);
  }
}

async function handleFrame(bitmap: ImageBitmap) {
  // Not ready, or still working: drop it on the floor and free it immediately.
  if (!session || busy) {
    dropped++;
    bitmap.close();
    return;
  }

  busy = true;
  const started = performance.now();

  try {
    if (session.inputNames.length !== 1) {
      // YOLO-World exports often take a second text/class-embedding input. That
      // needs its embeddings computed and fed here; guessing would silently
      // produce garbage detections.
      throw new Error(
        `model expects ${session.inputNames.length} inputs (${session.inputNames.join(", ")}), ` +
          `this worker feeds 1`,
      );
    }

    const { tensor, box } = preprocess(bitmap);
    const results = await session.run({ [session.inputNames[0]]: tensor });
    const output = results[session.outputNames[0]];
    const boxes = decode(output, box);

    post({
      type: "detections",
      boxes,
      inferenceMs: Math.round(performance.now() - started),
      dropped,
    });
    dropped = 0;
  } catch (e) {
    fail("inference failed", e);
  } finally {
    bitmap.close();
    busy = false;
  }
}

ctx.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as WorkerRequest;
  if (msg?.type === "frame") void handleFrame(msg.bitmap);
});

void load();

// FRAME_BUDGET_MS is exported for the main thread's drop/backoff logic.
export { FRAME_BUDGET_MS };
