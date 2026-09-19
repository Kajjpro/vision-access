/**
 * Tier 1: answering from the on-device detector, offline, with no frame leaving
 * the phone.
 *
 * Pure over a list of candidates. The camera, the worker and React all stay
 * outside — which is what lets every rule below be asserted against real numbers
 * instead of checked by holding a phone.
 *
 * ── THE THREE RULES EVERY ANSWER OBEYS ─────────────────────────────────────
 *
 *   1. Never name a class the detector does not have. `capabilities.ts` decides
 *      what is findable; a substitution is always declared as one.
 *   2. Never speak a distance the geometry does not support. `distancePhrase`
 *      returns `none` and the answer keeps the direction.
 *   3. Never claim safety. The path answer reports what was detected and
 *      carries the mobility-aid clause in the sentence itself.
 */

import { ASK } from "../ui/announcements";
import type { Box, CameraPose, DistanceEstimate } from "../distance";
import { resolveGoal, type SemanticGoal, type Tier } from "./capabilities";
import {
  centreXOf, confidenceFor, directionFor, distancePhrase, rankCandidates,
  type Confidence, type Direction,
} from "./spatial";

/** One detection, with its distance already estimated by lib/distance.ts. */
export type Candidate = {
  className: string;
  box: Box;
  score: number;
  distance: DistanceEstimate | null;
};

/** What the answer was about, kept so a follow-up can bind a pronoun to it. */
export type Target = {
  className: string;
  goal: SemanticGoal | null;
  direction: Direction;
  distance: DistanceEstimate | null;
  centreX: number;
  confidence: Confidence;
  /** How many others of the same class were in frame. */
  siblings: number;
};

export type AskAnswer = {
  /** Clip ids in speaking order. Filtered to what exists before returning. */
  keys: string[];
  /** The same content as text, for the screen and the screen reader. */
  text: string;
  tier: Tier;
  target: Target | null;
  /** True when this reports a limit rather than a finding. */
  decline: boolean;
};

export type AskInput = {
  candidates: Candidate[];
  pose: CameraPose;
  /** Mean frame luminance, 0–255, as the worker already reports it. */
  luma?: number;
  hasClip: (key: string) => boolean;
};

/** The forward corridor, matching WalkMode's own filter exactly. */
export const CORRIDOR_MIN = 0.25;
export const CORRIDOR_MAX = 0.75;

/** Below this mean luminance the detector is outside what it was characterised on. */
export const DARK_LUMA = 28;

const DIR_CLIP: Record<Direction, string | null> = {
  ahead: ASK.dirAhead.clip,
  slight_left: ASK.dirSlightLeft.clip,
  slight_right: ASK.dirSlightRight.clip,
  left: ASK.dirLeft.clip,
  right: ASK.dirRight.clip,
  not_in_view: null,
};

const DIR_TEXT: Record<Direction, string> = {
  ahead: ASK.dirAhead.mn,
  slight_left: ASK.dirSlightLeft.mn,
  slight_right: ASK.dirSlightRight.mn,
  left: ASK.dirLeft.mn,
  right: ASK.dirRight.mn,
  not_in_view: ASK.notInView.mn,
};

/** Hedge clips by register. `high` adds nothing — a plain assertion is the norm. */
const HEDGE_CLIP: Record<Confidence, string | null> = {
  high: null,
  medium: ASK.maybe.clip,
  low: ASK.uncertain.clip,
  reject: null,
};

const HEDGE_TEXT: Record<Confidence, string> = {
  high: "",
  medium: ASK.maybe.mn,
  low: ASK.uncertain.mn,
  reject: "",
};

/** Mongolian display name for a class, from the one registry that has them. */
import { PHRASES } from "../phrases";
const MN_OF = new Map(PHRASES.filter((p) => p.kind === "object").map((p) => [p.id, p.mn]));
const mnName = (className: string) => MN_OF.get(className) ?? className;

function answer(
  parts: { keys: (string | null)[]; text: string[] },
  input: AskInput,
  extra: { tier: Tier; target: Target | null; decline?: boolean },
): AskAnswer {
  return {
    // A clip that has not been rendered is dropped rather than played as
    // silence; the text still carries it for the screen reader.
    keys: parts.keys.filter((k): k is string => Boolean(k) && input.hasClip(k!)),
    text: parts.text.filter(Boolean).join(". "),
    tier: extra.tier,
    target: extra.target,
    decline: extra.decline ?? false,
  };
}

/** Nothing usable in frame, and a reason for it. */
function sensorProblem(input: AskInput): AskAnswer | null {
  if (typeof input.luma === "number" && input.luma < DARK_LUMA) {
    // Deliberately reports NOTHING it might have seen. A hedged guess made in
    // conditions the detector was never characterised for is the least
    // trustworthy output available.
    return answer(
      { keys: [ASK.tooDark.clip], text: [ASK.tooDark.mn] },
      input,
      { tier: "none", target: null, decline: true },
    );
  }
  return null;
}

function toTarget(c: Candidate, goal: SemanticGoal | null, pose: CameraPose, siblings: number): Target {
  const centreX = centreXOf(c.box, pose);
  return {
    className: c.className,
    goal,
    direction: directionFor(centreX),
    distance: c.distance,
    centreX,
    confidence: confidenceFor(c.score),
    siblings,
  };
}

/** object · hedge · direction · distance — the fixed order, every time. */
function describe(target: Target): { keys: (string | null)[]; text: string[] } {
  const phrase = distancePhrase(target.distance);
  const distKeys =
    phrase.kind === "metres"
      ? [ASK.approx.clip, `m_${phrase.metres}`]
      : phrase.kind === "very_close"
        ? ["very_close"]
        : [];
  const distText =
    phrase.kind === "metres"
      ? `${ASK.approx.mn} ${phrase.metres === 2 ? "хоёр" : phrase.metres === 3 ? "гурван" : phrase.metres === 4 ? "дөрвөн" : "таван"} метр`
      : phrase.kind === "very_close"
        ? "Маш ойрхон"
        : "";

  return {
    keys: [target.className, HEDGE_CLIP[target.confidence], DIR_CLIP[target.direction], ...distKeys],
    text: [mnName(target.className), HEDGE_TEXT[target.confidence], DIR_TEXT[target.direction], distText],
  };
}

/**
 * "Where is the door?" — the most common act in the feature.
 *
 * Reports one target and how many others share its class. Three benches is
 * "three benches, the nearest is…", never three separate sentences.
 */
export function answerFind(goal: SemanticGoal, input: AskInput): AskAnswer {
  const problem = sensorProblem(input);
  if (problem) return problem;

  const resolution = resolveGoal(goal);

  // NOTHING THIS DETECTOR CAN SERVE THE NEED WITH. Escalation is the router's
  // decision, not this function's; here it reports the limit truthfully.
  if (resolution.available.length === 0) {
    return answer(
      { keys: [ASK.cannotRecognise.clip], text: [ASK.cannotRecognise.mn] },
      input,
      { tier: resolution.tier, target: null, decline: true },
    );
  }

  const matches = input.candidates
    .filter((c) => resolution.available.includes(c.className))
    .filter((c) => confidenceFor(c.score) !== "reject")
    .map((c) => ({ c, centreX: centreXOf(c.box, input.pose), distance: c.distance, score: c.score }));

  if (matches.length === 0) {
    return answer(
      { keys: [ASK.notFound.clip, ASK.scanSlowly.clip], text: [ASK.notFound.mn, ASK.scanSlowly.mn] },
      input,
      { tier: "on_device", target: null, decline: true },
    );
  }

  const ranked = rankCandidates(matches);
  const best = ranked[0];
  const siblings = ranked.filter((m) => m.c.className === best.c.className).length - 1;
  const target = toTarget(best.c, goal, input.pose, siblings);

  const parts = describe(target);

  /**
   * A SUBSTITUTION IS ALWAYS DECLARED.
   *
   * A user asking for a chair, answered with a bench, must hear that chairs are
   * not something this device recognises. Reporting the bench alone would be a
   * silent substitution — the exact failure the capability registry exists to
   * prevent — and the user would walk to it believing it was a chair.
   *
   * Only when something was actually substituted. If the class found was the
   * top preference, nothing was swapped and saying so would be noise.
   */
  if (resolution.substitutedFor.length > 0) {
    parts.keys.unshift(ASK.cannotRecognise.clip);
    parts.text.unshift(ASK.cannotRecognise.mn);
  }

  return answer(parts, input, { tier: "on_device", target });
}

/** "How many people are there?" — a number and a direction, nothing else. */
export function answerCount(goal: SemanticGoal, input: AskInput): AskAnswer {
  const problem = sensorProblem(input);
  if (problem) return problem;

  const resolution = resolveGoal(goal);
  if (resolution.available.length === 0) {
    return answer(
      { keys: [ASK.cannotRecognise.clip], text: [ASK.cannotRecognise.mn] },
      input,
      { tier: resolution.tier, target: null, decline: true },
    );
  }

  const matches = input.candidates
    .filter((c) => resolution.available.includes(c.className))
    .filter((c) => confidenceFor(c.score) !== "reject");

  if (matches.length === 0) {
    return answer(
      { keys: [ASK.noneVisible.clip], text: [ASK.noneVisible.mn] },
      input,
      { tier: "on_device", target: null, decline: false },
    );
  }

  const n = matches.length;
  const ranked = rankCandidates(
    matches.map((c) => ({ c, centreX: centreXOf(c.box, input.pose), distance: c.distance, score: c.score })),
  );
  const target = toTarget(ranked[0].c, goal, input.pose, n - 1);
  const nearest = describe(target);

  // `num_*` lives in the transit manifest, so it is guarded like every other
  // clip rather than assumed — a count with a silent number is worse than none.
  return answer(
    {
      keys: [n <= 40 ? `num_${n}` : null, target.className, ...nearest.keys.slice(1)],
      text: [`${n} ${mnName(target.className)}`, ...nearest.text.slice(1)],
    },
    input,
    { tier: "on_device", target },
  );
}

/**
 * "Is the path clear?" — and it never answers yes.
 *
 * A yes is a safety verdict from a camera that sees one frame of a corridor and
 * knows nothing about the floor, the kerb behind it, or the cyclist out of
 * shot. What it can honestly do is report what it detected, and say so with the
 * mobility-aid clause attached to the sentence rather than filed in a setting.
 */
export function answerPath(input: AskInput): AskAnswer {
  const problem = sensorProblem(input);
  if (problem) return problem;

  const inCorridor = input.candidates
    .filter((c) => confidenceFor(c.score) !== "reject")
    .map((c) => ({ c, centreX: centreXOf(c.box, input.pose), distance: c.distance, score: c.score }))
    .filter((m) => m.centreX >= CORRIDOR_MIN && m.centreX <= CORRIDOR_MAX);

  if (inCorridor.length === 0) {
    return answer(
      { keys: [ASK.nothingAhead.clip, ASK.useCane.clip], text: [ASK.nothingAhead.mn, ASK.useCane.mn] },
      input,
      { tier: "on_device", target: null },
    );
  }

  const ranked = rankCandidates(inCorridor);
  const target = toTarget(ranked[0].c, "check_path", input.pose, ranked.length - 1);
  const parts = describe(target);
  parts.keys.push(ASK.useCane.clip);
  parts.text.push(ASK.useCane.mn);
  return answer(parts, input, { tier: "on_device", target });
}

/** "What is in front of me?" — at most two objects. A third stops being an answer. */
export const ENVIRONMENT_CAP = 2;

export function answerEnvironment(input: AskInput): AskAnswer {
  const problem = sensorProblem(input);
  if (problem) return problem;

  const usable = input.candidates
    .filter((c) => confidenceFor(c.score) !== "reject")
    .map((c) => ({ c, centreX: centreXOf(c.box, input.pose), distance: c.distance, score: c.score }));

  if (usable.length === 0) {
    return answer(
      { keys: [ASK.noneVisible.clip], text: [ASK.noneVisible.mn] },
      input,
      { tier: "on_device", target: null },
    );
  }

  const ranked = rankCandidates(usable).slice(0, ENVIRONMENT_CAP);
  const targets = ranked.map((m) => toTarget(m.c, null, input.pose, 0));
  const parts = targets.map((t) => describe(t));

  return answer(
    {
      keys: parts.flatMap((p) => p.keys),
      text: parts.map((p) => p.text.filter(Boolean).join(" ")),
    },
    input,
    { tier: "on_device", target: targets[0] },
  );
}
