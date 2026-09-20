/**
 * Tier 2: reading a sign.
 *
 * ── THE CROP IS THE WHOLE TRICK ────────────────────────────────────────────
 *
 * OCR on a street photograph is a bad bet: three shopfronts of competing text,
 * wrong scale, motion blur. OCR on a region the detector has already located as
 * `sign` is a completely different problem — one block of large text, roughly
 * fronto-parallel, at a scale the engine was trained for. The detector finds
 * signage at high confidence, so the pipeline is always
 *
 *     detect `sign` → crop to its box → OCR the crop
 *
 * and the uncropped path exists only for "read this", where the user has
 * deliberately pointed the camera at something and no `sign` box was found.
 *
 * ── LANGUAGE ───────────────────────────────────────────────────────────────
 *
 * `mon`, not `eng`. Signage here is Cyrillic and the English model reads it as
 * noise — confidently, which is worse than not reading it. `tessdata_fast`,
 * because a sign is large clean text and does not need the 15 MB model.
 *
 * ── EVERYTHING IS SELF-HOSTED ──────────────────────────────────────────────
 *
 * COEP is `require-corp`, so tesseract's CDN defaults are blocked exactly as
 * onnxruntime's were. `scripts/setup-tesseract.mjs` puts the worker, the core
 * and the language data under `public/tesseract/`; nothing here reaches a CDN.
 */

import type { Box } from "../distance";
import type { Frame, OcrLine, OcrProvider } from "./providers";

/** Self-hosted, because COEP blocks anything else. */
const BASE = "/tesseract";
const LANG = "mon";

/** A line the engine is this unsure of is noise, not text. */
export const MIN_LINE_CONFIDENCE = 55;

/**
 * Which lines to speak, and in what order.
 *
 * Pure, so the rule is testable without a browser — which matters because it is
 * the rule that decides what a rider hears, and the OCR engine itself cannot be
 * run in this suite.
 *
 * `summary` returns the ONE most prominent line. Prominence is text height: on a
 * sign the headline is the biggest thing on it, and the headline is what someone
 * standing in front of it wants. `full` returns everything readable, in reading
 * order, and is only reached when the user says "read everything".
 */
export function selectLines(
  lines: ReadonlyArray<OcrLine & { heightPx?: number }>,
  mode: "summary" | "full",
): OcrLine[] {
  const usable = lines
    .filter((l) => l.text.trim().length > 0)
    .filter((l) => l.confidence >= MIN_LINE_CONFIDENCE);

  if (usable.length === 0) return [];
  if (mode === "full") return usable.map(({ text, confidence }) => ({ text: text.trim(), confidence }));

  const byProminence = [...usable].sort((a, b) => {
    const ah = a.heightPx ?? 0;
    const bh = b.heightPx ?? 0;
    if (Math.abs(ah - bh) > 1) return bh - ah;
    // Same size: trust the engine's own confidence rather than reading order,
    // because a misread headline is worse than a correctly read subtitle.
    return b.confidence - a.confidence;
  });

  return [{ text: byProminence[0].text.trim(), confidence: byProminence[0].confidence }];
}

type TesseractWorker = {
  recognize(
    image: Blob | ImageBitmap | HTMLCanvasElement,
    options?: { rectangle?: { left: number; top: number; width: number; height: number } },
  ): Promise<{ data: { lines?: { text: string; confidence: number; bbox?: { y0: number; y1: number } }[] } }>;
  terminate(): Promise<void>;
};

/**
 * The browser OCR provider.
 *
 * The worker is created on FIRST USE and kept, not created per question:
 * spinning one up costs the language load every time, which is seconds a rider
 * spends standing in front of a sign. It is torn down with the mode.
 */
export function createOcrProvider(): OcrProvider & { dispose(): Promise<void> } {
  let worker: TesseractWorker | null = null;
  let starting: Promise<TesseractWorker> | null = null;

  async function ensure(): Promise<TesseractWorker> {
    if (worker) return worker;
    if (!starting) {
      starting = (async () => {
        const { createWorker } = await import("tesseract.js");
        const w = (await createWorker(LANG, 1, {
          workerPath: `${BASE}/worker.min.js`,
          corePath: BASE,
          langPath: BASE,
          // The language file is shipped uncompressed by the setup script.
          gzip: false,
        })) as unknown as TesseractWorker;
        worker = w;
        return w;
      })();
    }
    return starting;
  }

  return {
    // Availability is a claim about the ASSETS, and it cannot be checked
    // synchronously without fetching them. Returning true here means "wired";
    // a missing file surfaces as a failed read, which the router already
    // degrades honestly.
    available: () => typeof window !== "undefined",

    async read(frame: Frame, crop?: Box): Promise<OcrLine[]> {
      const w = await ensure();
      const blob = new Blob([frame.bytes as unknown as BlobPart], { type: "image/jpeg" });

      /**
       * The crop is passed as a RECTANGLE rather than by re-encoding a cropped
       * image. Same result, one fewer encode of a frame we are trying not to
       * keep around any longer than the answer takes.
       */
      const rectangle = crop
        ? {
            left: Math.max(0, Math.round(crop.x)),
            top: Math.max(0, Math.round(crop.y)),
            width: Math.min(frame.width, Math.round(crop.w)),
            height: Math.min(frame.height, Math.round(crop.h)),
          }
        : undefined;

      const result = await w.recognize(blob, rectangle ? { rectangle } : undefined);
      return (result.data.lines ?? []).map((l) => ({
        text: l.text ?? "",
        confidence: l.confidence ?? 0,
        heightPx: l.bbox ? Math.abs(l.bbox.y1 - l.bbox.y0) : undefined,
      })) as OcrLine[];
    },

    async dispose() {
      const w = worker;
      worker = null;
      starting = null;
      if (w) await w.terminate();
    },
  };
}
