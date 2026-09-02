/**
 * Banknote recognition, off the main thread.
 *
 * CLAUDE.md puts inference in a Web Worker because running it on the main
 * thread breaks audio, and that rule binds here at least as hard as it does
 * in vision.worker.ts. Matching one frame against twelve references is a few
 * hundred milliseconds of tight integer work — on the main thread that is a
 * few hundred milliseconds during which the AudioContext cannot schedule, so
 * the app would go silent at exactly the moment it is about to speak.
 *
 * Unlike the obstacle worker there is NO frame loop and no dropping policy.
 * Money is tap-to-capture: a small fixed number of frames per tap, all of them
 * wanted. See lib/money/decide.ts for why more than one.
 *
 * Load as a module worker:
 *   new Worker(new URL("../lib/money.worker.ts", import.meta.url), { type: "module" })
 *
 * Protocol
 *   in   { type: "init" }
 *   in   { type: "frame", bitmap: ImageBitmap, token: number }   transferred, closed here
 *   out  { type: "ready", entries: number, source: string }
 *   out  { type: "result", token, result, debug }
 *   out  { type: "error", message }                             never silent
 */
import { Recognizer, workingSize, type Recognition, type RecognizeDebug } from "./money/recognizer";
import { PackError, type ReferencePack } from "./money/refs";

/**
 * Built by scripts/build-money-refs.ts. Fetched rather than imported so a pack
 * rebuild does not require a JS rebuild, and so a MISSING pack is a runtime
 * error this file can report out loud instead of a build failure nobody on a
 * phone would ever see.
 */
const PACK_URL = "/money/refs.json";

export type MoneyWorkerRequest =
  | { type: "init" }
  | { type: "frame"; bitmap: ImageBitmap; token: number };

export type MoneyWorkerResponse =
  | { type: "ready"; entries: number; source: string }
  | { type: "result"; token: number; result: Recognition | null; debug: RecognizeDebug }
  /**
   * `kind` separates two facts a user cannot otherwise tell apart, and which
   * NOTES.md already insists must sound different:
   *
   *   "missing"  — no pack has been built yet. The mode is finished, the
   *                reference photographs are not. Nothing is broken and no
   *                amount of retrying will help.
   *   "fault"    — anything genuinely wrong: a pack that is unusable (wrong
   *                descriptor build, missing a denomination, corrupt), or a
   *                failure while reading a frame. This one has earned the
   *                error clip.
   *
   * Collapsing them would make the app report a fault and invite a retry that
   * cannot succeed — the exact mistake the `coming_soon` clip exists to avoid.
   */
  | { type: "error"; kind: "missing" | "fault"; message: string };

let recognizer: Recognizer | null = null;

function post(message: MoneyWorkerResponse) {
  (self as unknown as Worker).postMessage(message);
}

async function init() {
  try {
    const response = await fetch(PACK_URL);
    if (response.status === 404) {
      post({
        type: "error",
        kind: "missing",
        message: `no reference pack at ${PACK_URL}. Build one: npx tsx scripts/build-money-refs.ts`,
      });
      return;
    }
    if (!response.ok) {
      throw new Error(`${PACK_URL} returned ${response.status}`);
    }
    const pack = (await response.json()) as ReferencePack;
    recognizer = Recognizer.fromPack(pack);
    post({ type: "ready", entries: recognizer.size, source: pack.source });
  } catch (e) {
    // A PackError means the pack loaded but is incompatible or incomplete.
    // That distinction matters to whoever is debugging on a phone, where this
    // string is the entire diagnostic available.
    const prefix = e instanceof PackError ? "reference pack rejected" : "reference pack failed";
    post({
      type: "error",
      kind: "fault",
      message: `${prefix}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/**
 * ImageBitmap -> pixels, downscaled to the recogniser's working size.
 *
 * Drawn through OffscreenCanvas, which applies the browser's own resampling
 * rather than orb.ts's bilinear path — the same pixels either way, and this
 * one is hardware accelerated.
 */
function readPixels(bitmap: ImageBitmap): ImageData {
  const { width, height } = workingSize(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

self.onmessage = (event: MessageEvent<MoneyWorkerRequest>) => {
  const message = event.data;

  if (message.type === "init") {
    void init();
    return;
  }

  if (message.type === "frame") {
    const { bitmap, token } = message;
    try {
      if (!recognizer) {
        post({ type: "error", kind: "fault", message: "frame arrived before the pack was loaded" });
        return;
      }
      const pixels = readPixels(bitmap);
      const { result, debug } = recognizer.recognize(pixels.data, pixels.width, pixels.height);
      post({ type: "result", token, result, debug });
    } catch (e) {
      post({ type: "error", kind: "fault", message: e instanceof Error ? e.message : String(e) });
    } finally {
      // CLAUDE.md: always close bitmaps. iOS Safari's memory ceiling is low
      // enough that a leaked one per capture is a crash within a session.
      bitmap.close();
    }
  }
};
