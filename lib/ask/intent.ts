/**
 * What the user actually asked for.
 *
 * ── NOT KEYWORD MATCHING ───────────────────────────────────────────────────
 *
 * "Хаалга хаана байна вэ", "Хаалгыг ол", "Гарц хаана вэ" and "Би гарах гэсэн
 * юм" are four different sentences and one request. Matching on the word
 * `хаалга` gets the first two and misses the rest, which is exactly the failure
 * the brief names.
 *
 * So the parse runs in two independent passes and combines them:
 *
 *   1. INTENT — what kind of act is this? Locate, count, check the way, read,
 *      describe, follow up. Carried by the VERB and the question shape.
 *   2. GOAL — what real-world need is behind it? Carried by the NOUN, mapped
 *      through a synonym table to a semantic goal rather than to a class name.
 *
 * A sentence with a goal and no recognisable verb is still a locate — "хаалга?"
 * is a question. A sentence with a verb and no goal is a follow-up if there is
 * context to bind to, and a clarifying question if there is not.
 *
 * ── LANGUAGE ───────────────────────────────────────────────────────────────
 *
 * Mongolian is the product language; the recognition path returns Mongolian
 * text. English is matched too, because development and the accuracy harness run
 * on a desktop where dictating Mongolian is not practical — it is a test
 * affordance, not a supported user language, and no English is ever spoken back.
 *
 * All Mongolian here is DRAFT pending the same native review as lib/ui/announcements.ts.
 */

import { fold } from "../speech/mnNormalize";
import type { SemanticGoal } from "./capabilities";

export type Intent =
  /** Where is X. The most common act by a wide margin. */
  | "find_object"
  /** How many X. Distinct from find: the answer is a number, not a bearing. */
  | "count"
  /** Is the way ahead clear. Never answered yes or no — see answerPath. */
  | "path_query"
  /** What is in front of me. A summary, capped at two objects. */
  | "environment_query"
  /** What kind of place is this. Needs a model.  */
  | "scene_query"
  /** Read that. Needs OCR. */
  | "text_query"
  /** How far / where exactly / what about the others / repeat / guide me. */
  | "follow_up"
  /** Stop talking. Handled before anything else. */
  | "stop"
  /** Nothing recognisable. */
  | "unknown";

export type FollowUp =
  | "distance"
  | "direction"
  | "others"
  | "repeat"
  | "guide"
  | "availability";

export type ParsedQuestion = {
  intent: Intent;
  /** Null when the sentence named no target — a follow-up, or unparseable. */
  goal: SemanticGoal | null;
  /** Set only when `intent` is `follow_up`. */
  followUp: FollowUp | null;
  /** The normalised text the parse ran on. For the debug panel only. */
  normalized: string;
};

/**
 * Goal synonyms. The NEED on the left, the words people use on the right.
 *
 * Longest-match wins, so `гарц` (exit) resolving to a door does not get
 * shadowed by a shorter fragment. These are folded through `fold()` before
 * comparison, which strips case endings and homoglyphs — that is what lets
 * `хаалгыг`, `хаалганы` and `хаалга` all match one entry.
 */
const GOAL_WORDS: ReadonlyArray<readonly [SemanticGoal, readonly string[]]> = [
  ["read_text", ["юу гэж бичсэн", "юу бичсэн", "уншиж өг", "унших", "бичээс", "what does", "read", "written", "say"]],
  ["describe_scene", ["ямар газар", "энэ хаана", "юу харагдаж", "тайлбарла", "what kind of", "describe", "what place", "what am i looking"]],
  ["check_path", ["зам цэвэр", "зам чөлөө", "урагш явж", "урд юм бий", "path clear", "walk forward", "can i walk", "is it clear"]],
  ["find_door", ["хаалга", "гарц", "орох хаалга", "гарах", "door", "exit", "entrance", "doorway", "way out"]],
  ["find_stairs", ["шат", "шатаар", "лифт", "цахилгаан шат", "stairs", "staircase", "steps", "elevator", "lift", "escalator"]],
  ["find_seating", ["суух", "сандал", "суудал", "ширээ", "sit", "seat", "chair", "bench", "somewhere to sit", "table"]],
  ["find_person", ["хүн", "хүмүүс", "хэн нэгэн", "person", "people", "someone", "anyone"]],
  ["find_sign", ["тэмдэг", "самбар", "sign", "board"]],
  ["find_transit", ["автобус", "машин", "bus", "car", "vehicle"]],
  ["find_crossing", ["гэрлэн дохио", "гарц дохио", "хашлага", "traffic light", "crossing", "crosswalk", "curb", "kerb"]],
  /**
   * `хана` (wall) is DELIBERATELY ABSENT.
   *
   * `fold()` collapses doubled letters, so `хаана` — "where", the single most
   * common word in this whole feature — folds to exactly `хана`. Keeping the
   * wall keyword would route "Хаана суух вэ" ("where can I sit") to
   * find_obstacle. Caught by the suite, not by reading.
   *
   * A wall is still findable through check_path and the environment summary,
   * which is where a wall actually matters.
   */
  ["find_obstacle", ["саад", "шон", "мод", "obstacle", "pole", "tree", "wall"]],
];

/** Verbs and question shapes that mark the KIND of act. */
const INTENT_WORDS: ReadonlyArray<readonly [Intent, readonly string[]]> = [
  ["stop", ["зогс", "болих", "чимээгүй", "stop", "quiet", "be quiet"]],
  ["count", ["хэдэн", "хэд байна", "хэчнээн", "how many", "count"]],
  ["environment_query", ["урд юу", "миний өмнө", "юу байна", "what is in front", "in front of me"]],
  ["find_object", ["хаана", "ол", "олж өг", "хайж өг", "аль зүг", "where", "find", "locate", "which way"]],
];

/** Follow-ups. Matched only when nothing above named a target. */
const FOLLOW_WORDS: ReadonlyArray<readonly [FollowUp, readonly string[]]> = [
  ["repeat", ["давта", "дахин хэл", "repeat", "again", "say that again"]],
  ["guide", ["хүргэж өг", "чиглүүл", "тийш аваач", "guide me", "take me", "lead me"]],
  ["distance", ["хэр хол", "хэр зайтай", "хэдэн метр", "how far", "how close", "distance"]],
  ["direction", ["яг хаана", "аль талд", "where exactly", "which side", "which direction"]],
  ["others", ["бусад нь", "нөгөө нь", "өөр байна уу", "the others", "what about the other", "any other"]],
  ["availability", ["сул юу", "хоосон юу", "суух боломжтой", "is it empty", "is it free", "can i sit"]],
];

/**
 * Whether a folded phrase appears as a WHOLE-TOKEN run in the folded utterance.
 *
 * Token boundaries, not substrings. `fold()` is lossy on purpose — it collapses
 * doubled letters so ASR confusions match — and that makes short Mongolian words
 * contain one another after folding. Substring matching over the result finds
 * `хана` inside `хаана` and `ол` inside half the language.
 */
function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true;
    for (let k = 0; k < needle.length; k++) {
      if (haystack[i + k] !== needle[k]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * The most specific match wins.
 *
 * Specificity is the TOKEN COUNT first — a two-word phrase is a stronger signal
 * than either word alone — then character length. Without that, "юу гэж бичсэн"
 * loses to a one-word match it contains.
 */
function firstMatch<T>(text: string, table: ReadonlyArray<readonly [T, readonly string[]]>): T | null {
  const tokens = text.split(" ").filter(Boolean);
  let best: { value: T; words: number; chars: number } | null = null;

  for (const [value, words] of table) {
    for (const word of words) {
      const needle = fold(word).split(" ").filter(Boolean);
      if (!containsPhrase(tokens, needle)) continue;
      const chars = needle.join("").length;
      if (!best || needle.length > best.words || (needle.length === best.words && chars > best.chars)) {
        best = { value, words: needle.length, chars };
      }
    }
  }
  return best?.value ?? null;
}

/**
 * Parse one utterance.
 *
 * Total: every input returns something, and `unknown` is a legitimate answer
 * that the router turns into a four-word clarifying question rather than a
 * guess.
 */
export function parseQuestion(utterance: string): ParsedQuestion {
  const normalized = fold(String(utterance ?? ""));
  const empty: ParsedQuestion = { intent: "unknown", goal: null, followUp: null, normalized };
  if (!normalized) return empty;

  // Stop outranks everything, including a sentence that also names a target.
  // A user saying "stop" while the phone is mid-sentence is not asking a
  // question, and treating it as one is the app talking over an interruption.
  if (firstMatch(normalized, INTENT_WORDS.filter(([i]) => i === "stop")) === "stop") {
    return { ...empty, intent: "stop" };
  }

  const goal = firstMatch(normalized, GOAL_WORDS);
  const verb = firstMatch(normalized, INTENT_WORDS);

  // A goal that names its own act — reading, describing, checking the way —
  // outranks a generic locate verb. "Энэ тэмдэг дээр юу гэж бичсэн бэ" contains
  // both a sign and a read, and it is a read.
  if (goal === "read_text") return { ...empty, intent: "text_query", goal };
  if (goal === "describe_scene") return { ...empty, intent: "scene_query", goal };
  if (goal === "check_path") return { ...empty, intent: "path_query", goal };

  if (goal && verb === "count") return { ...empty, intent: "count", goal };

  if (goal) {
    // "What is in front of me" with a target is still a locate — the target is
    // more specific than the summary and is what the user actually wants.
    return { ...empty, intent: "find_object", goal };
  }

  // No target named. Either a follow-up bound to context, or a bare summary.
  const follow = firstMatch(normalized, FOLLOW_WORDS);
  if (follow) return { ...empty, intent: "follow_up", followUp: follow };

  if (verb === "environment_query") return { ...empty, intent: "environment_query", goal: null };
  if (verb === "count") return { ...empty, intent: "count", goal: "find_person" };

  return empty;
}
