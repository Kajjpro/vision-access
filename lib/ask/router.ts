/**
 * The routing decision: which capability answers this question.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * Route to the cheapest tool that can answer. Escalate only when it cannot.
 *
 * "Cheapest" is not only latency. On-device costs no network, no upload, and no
 * photograph of wherever the user is standing leaving their phone. That last one
 * is why the rule is absolute rather than a performance preference: a frame is
 * never uploaded to find something the detector already knows.
 *
 * ── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not call a model, run OCR, or touch a network. It DECIDES, and returns
 * either a finished on-device answer or an escalation request for a caller to
 * fulfil. That split is what makes every routing rule below testable without a
 * camera, a key, or a signal — and it is why the OCR and VLM providers can be
 * absent without the router being untestable.
 */

import { ASK } from "../ui/announcements";
import {
  answerCount, answerEnvironment, answerFind, answerPath,
  type AskAnswer, type AskInput,
} from "./answer";
import { resolveGoal, type Tier } from "./capabilities";
import { activeTarget, type AskContext } from "./context";
import { parseQuestion, type ParsedQuestion } from "./intent";

/**
 * What the caller must do next.
 *
 * `answer` is finished and speakable. `escalate` needs a tool this module
 * deliberately does not own.
 */
export type Routed =
  | { kind: "answer"; answer: AskAnswer; parsed: ParsedQuestion }
  | { kind: "escalate"; to: Exclude<Tier, "on_device" | "none">; question: string; parsed: ParsedQuestion }
  | { kind: "stop"; parsed: ParsedQuestion }
  | { kind: "repeat"; answer: AskAnswer | null; parsed: ParsedQuestion };

/** What the device can currently do. Supplied by the caller, never assumed. */
export type Availability = {
  online: boolean;
  /** An OCR provider is wired and ready. Currently false — see ask/providers.ts. */
  ocr: boolean;
  /** A vision-language provider is wired AND the user has consented to uploads. */
  vlm: boolean;
};

function declined(clip: { clip: string | null; mn: string }, input: AskInput, tier: Tier): AskAnswer {
  return {
    keys: clip.clip && input.hasClip(clip.clip) ? [clip.clip] : [],
    text: clip.mn,
    tier,
    target: null,
    decline: true,
  };
}

/**
 * Route one utterance.
 *
 * Pure. `now` and `availability` are parameters so the whole decision tree can
 * be driven from a test.
 */
export function route(
  utterance: string,
  input: AskInput,
  context: AskContext,
  availability: Availability,
  now: number,
): Routed {
  const parsed = parseQuestion(utterance);

  // Stop outranks the router entirely — it is not a question.
  if (parsed.intent === "stop") return { kind: "stop", parsed };

  if (parsed.intent === "follow_up") return routeFollowUp(parsed, input, context, availability, now);

  switch (parsed.intent) {
    case "path_query":
      return { kind: "answer", answer: answerPath(input), parsed };

    case "environment_query":
      return { kind: "answer", answer: answerEnvironment(input), parsed };

    case "count":
      return { kind: "answer", answer: answerCount(parsed.goal ?? "find_person", input), parsed };

    case "find_object": {
      if (!parsed.goal) break;
      const resolution = resolveGoal(parsed.goal);

      // ON-DEVICE WINS WHENEVER A CANDIDATE CLASS EXISTS. Note this is decided
      // before looking at the frame: whether the object is actually visible is a
      // different question from whether we are allowed to look for it locally.
      if (resolution.tier === "on_device") {
        return { kind: "answer", answer: answerFind(parsed.goal, input), parsed };
      }
      return escalateOr(resolution.tier, utterance, input, availability, parsed);
    }

    case "text_query":
      return escalateOr("ocr", utterance, input, availability, parsed);

    case "scene_query":
      return escalateOr("vlm", utterance, input, availability, parsed);
  }

  // Nothing recognisable, and nothing to bind it to. Four words, no apology.
  return { kind: "answer", answer: declined(ASK.whatToFind, input, "none"), parsed };
}

/**
 * Escalate, or explain why not.
 *
 * The decline names the MISSING PIECE — no connection, or a tool that is not
 * wired — rather than saying the question failed. Those send the user to
 * different actions: one is worth retrying somewhere with signal, the other
 * never is.
 */
function escalateOr(
  to: Tier,
  utterance: string,
  input: AskInput,
  availability: Availability,
  parsed: ParsedQuestion,
): Routed {
  if (to !== "ocr" && to !== "vlm") {
    return { kind: "answer", answer: declined(ASK.cannotRecognise, input, "none"), parsed };
  }

  if (!availability.online) {
    return { kind: "answer", answer: declined(ASK.noNetwork, input, to), parsed };
  }
  const ready = to === "ocr" ? availability.ocr : availability.vlm;
  if (!ready) {
    return { kind: "answer", answer: declined(ASK.cannotRecognise, input, to), parsed };
  }

  return { kind: "escalate", to, question: utterance, parsed };
}

/**
 * Follow-ups, resolved against the remembered target.
 *
 * An unbound follow-up is a clarifying question, never a guess. "How far?" with
 * nothing to measure must not silently measure the nearest thing in frame — the
 * user believes they are asking about the object they were just told about.
 */
function routeFollowUp(
  parsed: ParsedQuestion,
  input: AskInput,
  context: AskContext,
  availability: Availability,
  now: number,
): Routed {
  if (parsed.followUp === "repeat") {
    return { kind: "repeat", answer: context.previousAnswer, parsed };
  }

  const target = activeTarget(context, now);
  if (!target) {
    return { kind: "answer", answer: declined(ASK.whatToFind, input, "none"), parsed };
  }

  switch (parsed.followUp) {
    case "distance":
    case "direction":
      // Re-runs the SAME goal against the CURRENT frame rather than replaying a
      // stored measurement. The user has been standing there since they asked;
      // a fresh look is both cheap and more truthful.
      return {
        kind: "answer",
        answer: target.goal ? answerFind(target.goal, input) : answerEnvironment(input),
        parsed,
      };

    case "others":
      return { kind: "answer", answer: answerEnvironment(input), parsed };

    case "availability":
      /**
       * AVAILABILITY IS NEVER ASSERTED FROM A DETECTION.
       *
       * A bounding box says a bench is there. It says nothing about whether
       * somebody is sitting on it, and sitting on a stranger is the failure this
       * refusal exists to prevent. Escalation may be able to judge it; the
       * detector never can.
       */
      if (availability.online && availability.vlm) {
        return { kind: "escalate", to: "vlm", question: parsed.normalized, parsed };
      }
      return { kind: "answer", answer: declined(ASK.cannotTellFree, input, "vlm"), parsed };

    case "guide":
      // Guidance is a mode, not an answer. The caller owns it; the router only
      // confirms there is something to guide toward.
      return { kind: "answer", answer: answerFind(target.goal ?? "find_obstacle", input), parsed };

    default:
      return { kind: "answer", answer: declined(ASK.whatToFind, input, "none"), parsed };
  }
}
