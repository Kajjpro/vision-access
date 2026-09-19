/**
 * Tier 2 and Tier 3: the tools that are not on the phone.
 *
 * ── WHAT IS AND IS NOT IMPLEMENTED ─────────────────────────────────────────
 *
 * OCR IS. `lib/ask/ocr.ts` runs tesseract.js against a self-hosted Mongolian
 * model — see `scripts/setup-tesseract.mjs`, which exists because COEP blocks
 * tesseract's CDN defaults exactly as it blocked onnxruntime's.
 *
 * THE VISION MODEL IS NOT. `lib/ask/vision.ts` implements the provider against
 * the OpenAI-compatible shape, but no key is configured in this project, so it
 * reports itself unavailable and the router's decline path is what runs. It has
 * never been executed against a live model and is not claimed to work.
 *
 * The null implementations below stay as the shipped default and as what the
 * suite exercises: a stub returning plausible text would make the router
 * untestable in the one way that matters — you could no longer tell a real
 * answer from an invented one. Same idiom as `NO_SPEECH_FALLBACK`.
 */

import type { Box } from "../distance";

/** A still frame, already captured. Never a stream. */
export type Frame = {
  /** JPEG or PNG bytes. The caller encodes; nothing here holds a video handle. */
  bytes: Uint8Array;
  width: number;
  height: number;
};

export type OcrLine = {
  text: string;
  /** 0–100, as tesseract reports it. */
  confidence: number;
  /** Text height in pixels, used to pick the most prominent line on a sign. */
  heightPx?: number;
};

export interface OcrProvider {
  available(): boolean;
  /**
   * Reads text from a frame, optionally cropped to a detected region.
   *
   * THE CROP IS THE WHOLE TRICK. The detector finds `sign` reliably, and OCR on
   * a cropped sign beats OCR on a street photograph by a wide margin — fewer
   * candidate glyphs, better scale, no competing text from three shopfronts.
   * A caller that has a sign box must pass it.
   */
  read(frame: Frame, crop?: Box): Promise<OcrLine[]>;
}

export interface VisionProvider {
  available(): boolean;
  /**
   * Answers ONE question about ONE frame.
   *
   * The question goes with the image deliberately. "Describe this image" returns
   * a paragraph about the wallpaper; the user asked something specific and the
   * model should answer only that. The prompt must also forbid inference about
   * identity, emotion, intent or personal attributes — the same rule the
   * on-device path obeys by simply not being able to.
   */
  ask(frame: Frame, question: string): Promise<string>;
}

/** The fallback when OCR is not wired for this caller. */
export const NO_OCR: OcrProvider = {
  available: () => false,
  read: async () => {
    throw new Error("no OCR provider configured for this caller");
  },
};

export const NO_VISION: VisionProvider = {
  available: () => false,
  ask: async () => {
    throw new Error("no vision provider: no vision-language model is configured");
  },
};

/**
 * The system prompt a real vision provider must use.
 *
 * Kept here rather than at a future call site so the constraints are reviewable
 * now, and so that whoever wires the model cannot quietly write a looser one.
 */
export const VISION_SYSTEM_PROMPT = [
  "The user is blind and is asking about the space in front of them.",
  "Answer only the question asked, in at most two short sentences.",
  "Do not describe anything that was not asked about.",
  "Never infer identity, emotion, intention, age, or any personal attribute of a person.",
  "Never state that a path, route, or action is safe.",
  "If you are not confident, say so plainly rather than guessing.",
].join(" ");
