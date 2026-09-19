/**
 * "Has the scene changed?" — the decision that lets the app skip inference.
 *
 * Split out of lib/vision.worker.ts so it can be tested without a GPU, a
 * camera or onnxruntime. That matters more here than in most of this codebase:
 * the worker decides, dozens of times a second, NOT to look at the world, and
 * the cost of getting that wrong is a warning that arrives late to someone
 * crossing a road. A rule with that consequence should not live only inside a
 * module that can only be exercised on a phone.
 *
 * THE SIGNAL is a coarse luma grid — 16x16 cells over the letterboxed input,
 * sampled every 8th pixel. Deliberately crude. It is not trying to describe the
 * scene, only to answer whether anything moved, and a coarse grid is both
 * cheaper and steadier against sensor noise than a fine one. It rides along
 * with the brightness pass the worker already runs, so it costs one add and one
 * divide per sample rather than a second traversal of the image.
 */

/** Cells per axis. 256 cells total. */
export const SIG_GRID = 16;

/** Sample every Nth pixel on each axis. */
export const SIG_STEP = 8;

/**
 * Largest single-cell change below which the scene counts as unchanged.
 *
 * MEASURED, and the first version of this was a safety bug worth recording.
 * It averaged the change across all 256 cells, which is the obvious statistic
 * and the wrong one: a pedestrian occupies two or three cells, so a large local
 * change gets divided by 256 and comes out looking like nothing. On synthetic
 * frames (lib/motion.test.ts builds these):
 *
 *                     mean      max
 *   noise +/-2       0.00076   0.00267
 *   noise +/-5       0.00188   0.00612
 *   noise +/-10      0.00367   0.01129
 *   noise +/-20      0.00732   0.02369
 *   person appears   0.00471   0.25098
 *   person steps     0.01103   0.35294
 *   distant person   0.00110   0.18824
 *   tiny far person  0.00037   0.06275
 *
 * By mean, A DISTANT PERSON IS QUIETER THAN SENSOR NOISE — 0.0011 against
 * 0.0019. A gate built on that column would have skipped inference while
 * somebody walked into frame. By max the two populations are 10-30x apart.
 *
 * 0.03 sits above even the +/-20 noise case and roughly half of the faintest
 * real object. The margin on the noise side matters less than it looks, because
 * that error is self-correcting in the safe direction: a noisy sensor pushes
 * the max UP, which suppresses skipping and costs power rather than warnings.
 */
export const MOTION_THRESHOLD = 0.03;

/**
 * Longest a still-looking scene may go without a real inference.
 *
 * THE SAFETY BOUND, and the reason gating is allowed at all. A change too
 * gradual to trip the threshold — something approaching very slowly, a slow
 * pan, a light level drifting — must not be able to hide indefinitely behind a
 * run of skipped frames. Measured from the last REAL inference rather than the
 * last decision, so a sequence of skips cannot extend its own deadline.
 *
 * 600ms is about 84cm at walking pace. That is the worst case this adds, and it
 * only applies to something the grid could not see move at all.
 */
export const MAX_SKIP_MS = 600;

export type Signature = Float32Array;

export function createSignature(): Signature {
  return new Float32Array(SIG_GRID * SIG_GRID);
}

/**
 * Fills `out` with the coarse luma grid and returns the frame's mean brightness
 * (0..1), which lib/vision.worker.ts separately needs for the darkness warning.
 *
 * One pass, two answers: the brightness check had to read these pixels anyway,
 * so motion gating is very nearly free.
 */
export function measureFrame(data: Uint8ClampedArray, size: number, out: Signature): number {
  out.fill(0);
  let sum = 0;
  let n = 0;

  for (let y = 0; y < size; y += SIG_STEP) {
    const row = ((y * SIG_GRID) / size) | 0;
    for (let x = 0; x < size; x += SIG_STEP) {
      const o = (y * size + x) * 4;
      // Rec. 601 luma.
      const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      out[row * SIG_GRID + (((x * SIG_GRID) / size) | 0)] += luma;
      sum += luma;
      n++;
    }
  }

  // Every cell receives the same number of samples, so one divisor normalises
  // them all to 0..1.
  const perCell = (size / SIG_STEP / SIG_GRID) ** 2;
  for (let i = 0; i < out.length; i++) out[i] /= perCell * 255;

  return n === 0 ? 1 : sum / n / 255;
}

/**
 * How much the scene changed: the LARGEST single-cell difference, 0..1.
 *
 * Max, not mean — see MOTION_THRESHOLD for the measurements that forced this.
 * The question being asked is "did anything move", and a thing is local. Any
 * statistic that averages over the whole frame answers a different question
 * ("did everything move") and answers it in a way that hides pedestrians.
 */
export function motionBetween(a: Signature, b: Signature): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i]);
    if (delta > max) max = delta;
  }
  return max;
}

export type SkipDecision = {
  enabled: boolean;
  /** False on the very first frame, when there is nothing to compare against. */
  hasPrevious: boolean;
  motion: number;
  threshold: number;
  /** Time since the network last actually ran, not since the last decision. */
  msSinceRealInference: number;
  maxSkipMs: number;
};

/**
 * Whether inference may be skipped for this frame.
 *
 * Every condition is a veto, and they are all "refuse to skip" rather than
 * "allow a skip" — which is the correct default for a decision whose failure
 * mode is silence.
 */
export function shouldSkipInference(d: SkipDecision): boolean {
  if (!d.enabled) return false;
  // Nothing to compare against: the first frame after a start or a resume must
  // always be looked at properly.
  if (!d.hasPrevious) return false;
  // Something moved.
  if (d.motion >= d.threshold) return false;
  // The safety ceiling. Look anyway, however still it seems.
  if (d.msSinceRealInference > d.maxSkipMs) return false;
  return true;
}
