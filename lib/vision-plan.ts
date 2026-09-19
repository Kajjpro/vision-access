/**
 * How aggressively the vision worker is allowed to load the model.
 *
 * THE FAILURE THIS EXISTS FOR. On iOS Safari the app reached "model 100%" and
 * then the tab reloaded and landed back on the home menu. That is not a
 * navigation and not a crash the app can catch: iOS kills the whole renderer
 * when a tab's memory spikes, and reloads it. Walk mode is component state on
 * `/` (HomeGestures `setActive`), never a route, so the reload necessarily comes
 * back on the main menu — the "pushes to the main page" half of the symptom is
 * just what a reload of `/` looks like.
 *
 * The spike is at `InferenceSession.create`, which is exactly where 100% lands:
 * the download finishes, and the peak that follows holds, at once, the 37 MB of
 * model bytes in the JS heap, ort's copy of them inside the wasm heap, the
 * parsed weights, and whatever the graph optimiser transiently duplicates —
 * on top of a 26.8 MB wasm module and its compiled code, the decoded phrase
 * clips, and a live camera.
 *
 * `full` is the configuration that spike comes from. `lean` gives up the parts
 * of it that cost the most memory for the least certainty:
 *
 *   - WebGPU is dropped. The JSEP path keeps the weights in the wasm heap AND
 *     uploads a copy to the GPU, which on a phone's unified memory is the same
 *     pool. Worse, a WebGPU init that FAILS costs the whole allocation twice:
 *     the old code caught it, re-read 37 MB, and built a second session while
 *     the first one's buffers were still being reclaimed.
 *   - One wasm thread. Each ort thread carries its own arena for intermediate
 *     tensors, and at 640x640 those dwarf the weights.
 *   - Basic graph optimisation. The extended passes rewrite initialisers, which
 *     means holding the old and the new set at the same moment.
 *
 * IT MUST BE STICKY, AND THAT IS THE WHOLE POINT. A renderer kill leaves no
 * error, so the only record that the previous attempt died is the breadcrumb.
 * If the choice were made from the breadcrumb alone, a successful lean run would
 * clear it and the next launch would go back to `full` and die again — every
 * other launch a reload. So the first model-stage crash pins `lean` for good,
 * and a device that needs it keeps it.
 *
 * NEITHER PLAN IS THE REAL FIX. The model is fp32 with a static 640x640 input
 * (`npx tsx scripts/inspect-model.ts`), so its cost cannot be tuned from the
 * browser at all — only re-exported. The fp16 build NOTES.md already recommends
 * (~18.6 MB, keeps WebGPU) halves the largest single term here and is still not
 * built. This buys a phone that cannot hold `full` a working app, not a fast one.
 */

/** Which configuration to attempt. Ordered: every later plan is cheaper. */
export type PlanId = "full" | "lean";

export type LoadPlan = {
  id: PlanId;
  /** Execution providers, in order, handed to ort. */
  providers: readonly string[];
  /**
   * Upper bound on wasm threads — a cap, not a count. The worker still takes the
   * minimum of this and what the device reports, so `full` on a two-core phone
   * stays at two.
   */
  maxThreads: number;
  optimization: "all" | "basic";
};

export const FULL_PLAN: LoadPlan = {
  id: "full",
  providers: ["webgpu", "wasm"],
  maxThreads: 4,
  optimization: "all",
};

export const LEAN_PLAN: LoadPlan = {
  id: "lean",
  providers: ["wasm"],
  maxThreads: 1,
  optimization: "basic",
};

export const PLANS: Record<PlanId, LoadPlan> = { full: FULL_PLAN, lean: LEAN_PLAN };

/**
 * Breadcrumb stages that mean the previous run died with the model in memory.
 *
 * `model-ready` is in the list on purpose: the session exists by then but the
 * warm-up inference and the first real frames still have to allocate their
 * activations, and dying there is the same memory story as dying in `create`.
 *
 * Stages BEFORE these are not: a kill at `camera-open` is not something a
 * cheaper model load would have prevented, and degrading on it would cost the
 * fast path to no purpose.
 */
const MODEL_STAGES: ReadonlySet<string> = new Set([
  "model-downloading",
  "model-session",
  "model-ready",
]);

/**
 * Did the previous run die while loading the model?
 *
 * Takes the raw breadcrumb, detail and all — `mark()` writes `model-session
 * (100%)`, and the percentage is the most useful part of it to a human, so it is
 * kept in storage and stripped here rather than never written.
 */
export function isModelLoadCrash(stage: string | null | undefined): boolean {
  if (!stage) return false;
  return MODEL_STAGES.has(stage.split(" ")[0]);
}

/**
 * The plan to load with.
 *
 * A pin always wins, including over a clean previous run: a device that has ever
 * failed on `full` does not get asked again. Nothing here downgrades a pin —
 * proving `full` works after it has been seen to fail needs evidence this
 * function does not have.
 */
export function planFor(opts: {
  pinned?: PlanId | null;
  crashStage?: string | null;
}): LoadPlan {
  if (opts.pinned && PLANS[opts.pinned]) return PLANS[opts.pinned];
  if (isModelLoadCrash(opts.crashStage)) return LEAN_PLAN;
  return FULL_PLAN;
}

const PIN_KEY = "va:vision-plan";

/** The pinned plan, or null. Main thread only — a worker has no localStorage. */
export function pinnedPlan(): PlanId | null {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    return raw === "full" || raw === "lean" ? raw : null;
  } catch {
    // Private mode. Costs the stickiness, not the app: the breadcrumb still
    // degrades the run that follows a crash, it just cannot remember further.
    return null;
  }
}

export function pinPlan(id: PlanId) {
  try {
    localStorage.setItem(PIN_KEY, id);
  } catch {
    // Private mode; see above.
  }
}

/** For the dev panel and for testing on a phone that has been pinned by a fluke. */
export function clearPinnedPlan() {
  try {
    localStorage.removeItem(PIN_KEY);
  } catch {
    // Nothing was stored, so nothing to clear.
  }
}
