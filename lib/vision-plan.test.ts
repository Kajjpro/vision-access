/**
 * The rule that keeps an iOS reload loop from repeating forever.
 *
 * The whole mechanism is one decision — which configuration to load with — and
 * it is made from evidence written by a run that DIED, so none of it can be
 * checked at the time it is used. These are the properties that make the
 * decision safe: it degrades on the stages where memory is the cause, it does
 * not degrade on the ones where it is not, and once degraded it stays that way.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FULL_PLAN, LEAN_PLAN, isModelLoadCrash, planFor } from "./vision-plan";

test("a clean start gets the fast configuration", () => {
  assert.equal(planFor({ pinned: null, crashStage: null }).id, "full");
});

test("a kill while the model was in memory degrades the next run", () => {
  // Exactly what the phone reported: the download completes, the session is
  // being built, and the tab is gone. `mark()` writes the percentage alongside
  // the stage, so the detail has to survive the match.
  assert.equal(planFor({ crashStage: "model-session (100%)" }).id, "lean");
  assert.equal(planFor({ crashStage: "model-downloading (62%)" }).id, "lean");
  assert.equal(planFor({ crashStage: "model-ready (webgpu/wasm)" }).id, "lean");
});

test("a kill before the model was loaded does not cost the fast path", () => {
  // A tab killed while the camera was opening tells us nothing about whether
  // this device can hold the model, and answering it with a permanently slower
  // detector would be a real cost paid on a guess.
  for (const stage of ["mount", "audio-context", "phrases-decoded", "camera-open", "worker-spawned"]) {
    assert.equal(planFor({ crashStage: stage }).id, "full", stage);
  }
});

test("a run that finished leaves nothing to degrade on", () => {
  // `clearMark()` writes `done`, and takeCrashStage() already filters it — this
  // asserts the plan does not resurrect it by a different route.
  assert.equal(isModelLoadCrash("done"), false);
  assert.equal(isModelLoadCrash(null), false);
  assert.equal(isModelLoadCrash(undefined), false);
  assert.equal(isModelLoadCrash(""), false);
});

test("a pin outlives the crash that caused it", () => {
  // THE POINT OF THE PIN. A lean run succeeds, so it clears the breadcrumb; if
  // the plan were read from the breadcrumb alone the next launch would go back
  // to `full` and be killed again — a working launch every other time, which
  // reads as random to someone who cannot see the screen.
  assert.equal(planFor({ pinned: "lean", crashStage: null }).id, "lean");
});

test("a pin is never talked out of by a clean-looking run", () => {
  assert.equal(planFor({ pinned: "lean", crashStage: "done" }).id, "lean");
});

test("lean gives up exactly the three things that cost memory", () => {
  // Named individually because each is a separate allocation on the phone, and
  // a future edit that quietly restores one would put the crash back.
  assert.ok(!LEAN_PLAN.providers.includes("webgpu"), "webgpu keeps a second copy of the weights");
  assert.equal(LEAN_PLAN.maxThreads, 1, "every extra thread carries its own tensor arena");
  assert.equal(LEAN_PLAN.optimization, "basic", "extended passes duplicate initialisers");
});

test("full is still worth having — it is not lean with extra steps", () => {
  assert.ok(FULL_PLAN.providers.includes("webgpu"));
  assert.ok(FULL_PLAN.maxThreads > LEAN_PLAN.maxThreads);
});
