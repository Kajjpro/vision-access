/**
 * "Ask VisionAccess" — one action during a journey, whose CONTENTS change with
 * the state.
 *
 * ── WHY A MENU AND NOT A CHATBOT ───────────────────────────────────────────
 *
 * A chat box asks the rider to compose a sentence. At a bus stop, in traffic,
 * without sight, that is the most expensive interaction available: it needs a
 * microphone that works, a recogniser that handles mn-MN, a network, and the
 * rider's full attention — and it can fail in ways they cannot diagnose. This
 * is a short list of the questions that are ANSWERABLE RIGHT NOW, read by ear
 * and selected with the same swipe-and-double-tap as everything else.
 *
 * The list being short and fixed is the accessibility feature. A rider learns
 * four phrases and keeps them; a generative assistant would offer a different
 * surface every time, which is precisely what someone navigating by ear cannot
 * build a habit around.
 *
 * ── WHY IT IS CONTEXTUAL ───────────────────────────────────────────────────
 *
 * Every entry here routes to `guide.answer`, which answers from the journey
 * object. So a question is only offered when the journey actually holds the data
 * to answer it: "how many stops remain" is absent while waiting, because the
 * honest answer would be about a journey that has not started. Offering a
 * question the app must then decline is worse than not offering it — it teaches
 * the rider the assistant is unreliable.
 */

import { ASSIST } from "../ui/announcements";
import type { GuideQuestion } from "./guide";
import type { Journey } from "./types";

/**
 * What selecting an entry does.
 *
 * Most ask the guide. Two are navigation, and they are in the same list rather
 * than as separate buttons because from the rider's side "find me another
 * route" is the same kind of act as "what is happening" — a thing you say to
 * the assistant.
 */
export type AssistantAction =
  | { kind: "ask"; question: GuideQuestion }
  | { kind: "repeat" }
  | { kind: "find_other_route" }
  | { kind: "stop_guidance" };

export type AssistantEntry = {
  id: string;
  /** Spoken when the rider scrolls onto it. */
  keys: string[];
  /** Rendered, and read by a screen reader. Same words as the clip. */
  label: string;
  action: AssistantAction;
};

const entry = (
  id: string,
  phrase: { clip: string | null; mn: string },
  action: AssistantAction,
): AssistantEntry => ({ id, keys: phrase.clip ? [phrase.clip] : [], label: phrase.mn, action });

/**
 * The questions worth offering in this state.
 *
 * Returns empty where there is no journey to ask about — the assistant is not
 * offered at all then, rather than offered and empty.
 */
export function assistantMenu(journey: Journey): AssistantEntry[] {
  switch (journey.state) {
    case "walking_to_stop":
      return [
        entry("what_happening", ASSIST.whatIsHappening, { kind: "ask", question: "status" }),
        entry("when_bus", ASSIST.whenIsBus, { kind: "ask", question: "time_left" }),
        entry("repeat", ASSIST.repeatLast, { kind: "repeat" }),
        entry("stop_guidance", ASSIST.stopGuidance, { kind: "stop_guidance" }),
      ];

    case "waiting_for_bus":
    case "bus_due":
      return [
        entry("what_happening", ASSIST.whatIsHappening, { kind: "ask", question: "status" }),
        // Answered with the timetable prefix AND the "I cannot confirm its
        // position" line — see `answer`. Asking directly about the bus is
        // exactly when the rider needs to know what kind of claim they are being
        // given.
        entry("when_bus", ASSIST.whenIsBus, { kind: "ask", question: "time_left" }),
        entry("find_other", ASSIST.stopGuidance, { kind: "find_other_route" }),
        entry("repeat", ASSIST.repeatLast, { kind: "repeat" }),
      ];

    case "on_bus":
      return [
        entry("stops_left", ASSIST.howManyStops, { kind: "ask", question: "stops_left" }),
        entry("how_long", ASSIST.howLong, { kind: "ask", question: "time_left" }),
        entry("next_stop", ASSIST.nextStop, { kind: "ask", question: "next_stop" }),
        entry("repeat", ASSIST.repeatLast, { kind: "repeat" }),
      ];

    case "approaching_destination":
      // Deliberately the shortest list in the app. The rider is about to have to
      // stand up and move in a vehicle they cannot see out of, and a four-item
      // menu at that moment is a menu nobody reaches the end of.
      return [
        entry("what_do", ASSIST.whatShouldIDo, { kind: "ask", question: "what_should_i_do" }),
        entry("repeat", ASSIST.repeatLast, { kind: "repeat" }),
      ];

    case "journey_error":
      return [
        entry("what_happening", ASSIST.whatIsHappening, { kind: "ask", question: "status" }),
        entry("find_other", ASSIST.stopGuidance, { kind: "find_other_route" }),
      ];

    /**
     * The confirmation states offer NOTHING.
     *
     * They are already a question, and the answers to it are the screen's own
     * options. Burying "yes I boarded" under an assistant menu, at the one
     * moment the journey is blocked waiting for it, would be the interface
     * getting in the way of the single thing it needs.
     */
    case "confirming_boarding":
    case "confirming_exit":
      return [];

    default:
      return [];
  }
}

/** Whether the quick assistant is offered at all right now. */
export function hasAssistant(journey: Journey): boolean {
  return assistantMenu(journey).length > 0;
}
