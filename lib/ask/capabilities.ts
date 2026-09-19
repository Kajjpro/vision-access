/**
 * What this device can actually answer, derived from the model that is loaded.
 *
 * ── WHY THIS IS DERIVED AND NOT A LIST ─────────────────────────────────────
 *
 * `DETECTION_CLASSES` is generated from `lib/phrases.ts`, and its ARRAY ORDER IS
 * THE ONNX CLASS INDEX — re-exporting the model renumbers every class. A second
 * hand-maintained list of "things Ask the Room can find" would drift from it
 * silently, and the failure mode of that drift is the worst one available:
 * confidently reporting an object the model never detected.
 *
 * So the registry computes itself. Adding `chair` to the detector export makes
 * `find_seating` prefer it automatically; removing `bench` makes the same goal
 * degrade automatically. Nothing here needs editing either way.
 *
 * ── THE SEMANTIC GOAL IS THE POINT ─────────────────────────────────────────
 *
 * A user says "I need somewhere to sit". They do not know, and must never need
 * to know, that the detector has `bench` and `table` but no `chair`. The goal
 * names the NEED; `resolveGoal` reports which classes can serve it and which
 * requested ones cannot, and the answer layer turns that into an honest sentence
 * rather than a substitution.
 */

import { DETECTION_CLASSES } from "../phrases";

/** Every class the loaded detector can actually name. */
export const DETECTABLE: ReadonlySet<string> = new Set(DETECTION_CLASSES);

/**
 * A real-world need, not a class name.
 *
 * Deliberately coarse. Each of these is a different thing a person walks up to
 * an unfamiliar space wanting, and a finer split would be a split the detector
 * cannot support.
 */
export type SemanticGoal =
  | "find_door"
  | "find_stairs"
  | "find_seating"
  | "find_person"
  | "find_sign"
  | "find_transit"
  | "find_crossing"
  | "find_obstacle"
  | "check_path"
  | "describe_scene"
  | "read_text";

/**
 * Which tier can serve a goal at best. `on_device` never guarantees an ANSWER —
 * the object may simply not be in frame — it guarantees that no image leaves the
 * phone while we look.
 */
export type Tier = "on_device" | "ocr" | "vlm" | "none";

type GoalSpec = {
  id: SemanticGoal;
  /**
   * Classes that would satisfy this need, BEST FIRST.
   *
   * Includes classes the current export does not have. That is the feature: the
   * gap between what was asked for and what exists is what the honest decline is
   * built from, and it cannot be computed from a list that only contains things
   * that work.
   */
  candidates: readonly string[];
  /** Where this goes when no candidate class is detectable. */
  escalation: Tier;
};

/**
 * The goals, with their candidate classes.
 *
 * Names here are ONNX class ids, matched against `DETECTABLE` at call time.
 * Several are deliberately aspirational — `chair`, `elevator`, `escalator`,
 * `crosswalk` — so that asking for them produces "I cannot recognise that"
 * rather than silence or, far worse, a substitution.
 */
const GOALS: readonly GoalSpec[] = [
  { id: "find_door", candidates: ["door", "window"], escalation: "vlm" },
  { id: "find_stairs", candidates: ["stairs", "escalator", "elevator"], escalation: "vlm" },
  // `chair` first because it is what people ask for; `bench` and `table` are
  // what this export actually has.
  { id: "find_seating", candidates: ["chair", "seat", "sofa", "bench", "table"], escalation: "vlm" },
  { id: "find_person", candidates: ["person", "child"], escalation: "none" },
  { id: "find_sign", candidates: ["sign"], escalation: "vlm" },
  { id: "find_transit", candidates: ["bus", "truck", "car"], escalation: "none" },
  { id: "find_crossing", candidates: ["traffic_light", "crosswalk", "curb"], escalation: "vlm" },
  {
    id: "find_obstacle",
    candidates: ["pole", "tree", "wall", "fence", "curb", "hole", "puddle", "ice", "rock", "trash_can"],
    escalation: "none",
  },
  // Not a search for one class — every class participates. See `answerPath`.
  { id: "check_path", candidates: [...DETECTION_CLASSES], escalation: "none" },
  // No on-device model produces a scene label. This goal exists to route.
  { id: "describe_scene", candidates: [], escalation: "vlm" },
  // The detector can find the sign; reading it is a different tool entirely.
  { id: "read_text", candidates: [], escalation: "ocr" },
];

const BY_ID = new Map(GOALS.map((g) => [g.id, g]));

export type GoalResolution = {
  goal: SemanticGoal;
  /** Candidate classes this detector actually has, best first. May be empty. */
  available: string[];
  /**
   * Candidate classes it does not have.
   *
   * Drives the decline. "I cannot recognise a chair" is only sayable because
   * `chair` is a known candidate that is known to be missing — an unknown word
   * would produce a different, vaguer answer.
   */
  missing: string[];
  /**
   * Missing candidates that rank ABOVE the best available one.
   *
   * The difference between a substitution and an ordinary answer. `find_seating`
   * lists chair before bench, so on a detector with only `bench` this holds
   * `chair` — which is what makes "I cannot recognise a chair, but I can see a
   * bench" sayable. When the best available class is already the top preference
   * this is empty and no substitution is declared, because none happened.
   */
  substitutedFor: string[];
  /** The cheapest tier that can serve this goal on this device. */
  tier: Tier;
};

export function resolveGoal(goal: SemanticGoal): GoalResolution {
  const spec = BY_ID.get(goal);
  if (!spec) return { goal, available: [], missing: [], substitutedFor: [], tier: "none" };

  const available = spec.candidates.filter((c) => DETECTABLE.has(c));
  const missing = spec.candidates.filter((c) => !DETECTABLE.has(c));

  const firstAvailableAt = spec.candidates.findIndex((c) => DETECTABLE.has(c));
  const substitutedFor =
    firstAvailableAt <= 0 ? [] : spec.candidates.slice(0, firstAvailableAt).filter((c) => !DETECTABLE.has(c));

  return {
    goal,
    available,
    missing,
    substitutedFor,
    // On-device wins whenever a single candidate class survives. That is the
    // whole routing rule: never upload a frame to find something the detector
    // already knows.
    tier: available.length > 0 ? "on_device" : spec.escalation,
  };
}

/** Every goal, for the debug panel and for the test that walks all of them. */
export function allGoals(): SemanticGoal[] {
  return GOALS.map((g) => g.id);
}

/**
 * Whether a class the user named is one this detector has.
 *
 * Used for the direct case — the user asked for something by name rather than
 * by need — so the same honesty applies without inventing a goal for it.
 */
export function canDetect(className: string): boolean {
  return DETECTABLE.has(className);
}
