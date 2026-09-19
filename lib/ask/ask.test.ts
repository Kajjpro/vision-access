/**
 * Ask the Room, tested against the rules that keep it honest.
 *
 * The load-bearing ones, in order of how badly they fail:
 *
 *   1. Never name a class the detector does not have.
 *   2. Never speak a distance the geometry does not support.
 *   3. Never claim a path is safe.
 *   4. Never upload a frame to find something the detector already knows.
 *   5. Never bind a pronoun to something that is no longer there.
 *
 * Every one of these is asserted against output rather than by reading code,
 * because each is a sentence a blind user would act on and none of them can be
 * checked by holding a phone.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DETECTION_CLASSES } from "../phrases";
import { DEFAULT_HFOV_DEG, type CameraPose } from "../distance";
import {
  CORRIDOR_MIN, DARK_LUMA, ENVIRONMENT_CAP, answerCount, answerEnvironment, answerFind, answerPath,
  type AskInput, type Candidate,
} from "./answer";
import { DETECTABLE, allGoals, canDetect, resolveGoal } from "./capabilities";
import { activeTarget, emptyContext, onCameraMoved, remember, TARGET_TTL_MS } from "./context";
import { parseQuestion } from "./intent";
import { NO_OCR, NO_VISION, VISION_SYSTEM_PROMPT } from "./providers";
import { route, type Availability } from "./router";
import { AHEAD_DEG, bearingDeg, confidenceFor, directionFor, distancePhrase, SLIGHT_DEG } from "./spatial";

const T0 = 1_700_000_000_000;
const POSE: CameraPose = { frameWidth: 640, frameHeight: 480, pitchDeg: 20, cameraHeightM: 1.4 };
const all = () => true;

/** A candidate at a given frame fraction, with a reliable distance by default. */
function at(className: string, centreFrac: number, metres: number | null, score = 0.9): Candidate {
  const w = 60;
  return {
    className,
    box: { x: centreFrac * POSE.frameWidth - w / 2, y: 200, w, h: 80 },
    score,
    distance: metres === null ? null : { metres, reliable: true },
  };
}

const input = (candidates: Candidate[], luma?: number): AskInput => ({
  candidates, pose: POSE, luma, hasClip: all,
});

const OFFLINE: Availability = { online: false, ocr: false, vlm: false };
const ONLINE_BARE: Availability = { online: true, ocr: false, vlm: false };
const ONLINE_FULL: Availability = { online: true, ocr: true, vlm: true };

// ───────────────────────────────────────────────────────── capabilities

test("the registry is derived from the detector, not hand-written", () => {
  // A second list would drift, and the drift would surface as a confident report
  // of an object the model never detected.
  assert.equal(DETECTABLE.size, DETECTION_CLASSES.length);
  for (const c of DETECTION_CLASSES) assert.ok(canDetect(c), `${c} missing from the registry`);
});

test("every detector class is reachable through some goal", () => {
  // A class the model can find but no question can ask for is dead weight in a
  // 37 MB model shipped over a metered connection.
  const reachable = new Set(allGoals().flatMap((g) => resolveGoal(g).available));
  const orphans = DETECTION_CLASSES.filter((c) => !reachable.has(c));
  assert.deepEqual(orphans, [], `unreachable classes: ${orphans.join(", ")}`);
});

test("a goal with no detectable class escalates rather than pretending", () => {
  const scene = resolveGoal("describe_scene");
  assert.deepEqual(scene.available, []);
  assert.equal(scene.tier, "vlm");

  const text = resolveGoal("read_text");
  assert.equal(text.tier, "ocr");
});

test("seating knows it is substituting a bench for a chair", () => {
  // THE HONEST-DECLINE MECHANISM. `chair` ranks above `bench` in the candidate
  // list and this export has no chair, so the gap is computable — which is what
  // makes "I can't recognise a chair, but there is a bench" sayable.
  const seating = resolveGoal("find_seating");
  assert.ok(seating.available.includes("bench"));
  assert.ok(seating.missing.includes("chair"));
  assert.ok(seating.substitutedFor.includes("chair"), "the substitution was not detected");
  assert.equal(seating.tier, "on_device", "must not escalate — a bench is on the phone");
});

test("a goal served by its own first choice declares no substitution", () => {
  // `door` is the top candidate and exists, so saying "I can't recognise that"
  // would be noise about a swap that never happened.
  assert.deepEqual(resolveGoal("find_door").substitutedFor, []);
  assert.deepEqual(resolveGoal("find_person").substitutedFor, []);
});

// ───────────────────────────────────────────────────────── intent

test("the eleven required questions all parse", () => {
  const cases: [string, string][] = [
    ["Where is the door?", "find_object"],
    ["Find the stairs.", "find_object"],
    ["Where can I sit?", "find_object"],
    ["Is someone in front of me?", "find_object"],
    ["How many people are there?", "count"],
    ["What is in front of me?", "environment_query"],
    ["Is the path clear?", "path_query"],
    ["What does this sign say?", "text_query"],
    ["How far away?", "follow_up"],
    ["Where exactly?", "follow_up"],
    ["Repeat that.", "follow_up"],
  ];
  for (const [q, expected] of cases) {
    assert.equal(parseQuestion(q).intent, expected, `"${q}"`);
  }
});

test("four ways of asking for a door are one request", () => {
  // The brief's own test of whether this is keyword matching. It is not: the
  // goal comes from a synonym table over NEEDS, so "exit" and "way out" land on
  // the same goal as "door".
  for (const q of ["Where is the door?", "Find the door.", "Can you locate the entrance?", "Which way is the doorway?"]) {
    const p = parseQuestion(q);
    assert.equal(p.intent, "find_object", q);
    assert.equal(p.goal, "find_door", q);
  }
});

test("Mongolian parses on the same paths", () => {
  assert.equal(parseQuestion("Хаалга хаана байна вэ").goal, "find_door");
  assert.equal(parseQuestion("Шат олж өгөөч").goal, "find_stairs");
  assert.equal(parseQuestion("Хаана суух вэ").goal, "find_seating");
  assert.equal(parseQuestion("Зам цэвэр үү").intent, "path_query");
  assert.equal(parseQuestion("Зогс").intent, "stop");
});

test("stop outranks a sentence that also names a target", () => {
  // Someone saying "stop" over a sentence is interrupting, not asking.
  assert.equal(parseQuestion("Stop, where is the door").intent, "stop");
});

test("a follow-up carries its kind", () => {
  assert.equal(parseQuestion("How far away?").followUp, "distance");
  assert.equal(parseQuestion("What about the other one?").followUp, "others");
  assert.equal(parseQuestion("Repeat that.").followUp, "repeat");
  assert.equal(parseQuestion("Is it empty?").followUp, "availability");
});

test("an unparseable utterance is unknown, never a guess", () => {
  assert.equal(parseQuestion("").intent, "unknown");
  assert.equal(parseQuestion("mmm").intent, "unknown");
});

// ───────────────────────────────────────────────────────── spatial

test("direction bands tile the real field of view", () => {
  // Derived from DEFAULT_HFOV_DEG, not chosen. The frame spans ±34.5°.
  assert.equal(directionFor(0.5), "ahead");
  assert.ok(Math.abs(bearingDeg(0)) - DEFAULT_HFOV_DEG / 2 < 0.001);

  assert.equal(directionFor(0.5 - (AHEAD_DEG - 1) / DEFAULT_HFOV_DEG), "ahead");
  assert.equal(directionFor(0.5 - (AHEAD_DEG + 3) / DEFAULT_HFOV_DEG), "slight_left");
  assert.equal(directionFor(0.5 + (AHEAD_DEG + 3) / DEFAULT_HFOV_DEG), "slight_right");
  assert.equal(directionFor(0.5 - (SLIGHT_DEG + 3) / DEFAULT_HFOV_DEG), "left");
  assert.equal(directionFor(0.5 + (SLIGHT_DEG + 3) / DEFAULT_HFOV_DEG), "right");
});

test("nothing outside the frame is given a direction", () => {
  // NEVER "behind you". The camera cannot see behind it and must not imply it can.
  assert.equal(directionFor(-0.1), "not_in_view");
  assert.equal(directionFor(1.2), "not_in_view");
  assert.equal(directionFor(Number.NaN), "not_in_view");
});

test("an unreliable estimate never becomes a number", () => {
  // `reliable: false` means the ground-plane assumption broke. The figure it
  // still returns is fabrication, and speaking it is the worst thing this
  // module could do.
  // VERY_CLOSE_M (0.3) is the sentinel `estimateObjectDistance` returns when the
  // object fills the frame — the one unreliable case that DOES carry meaning.
  assert.deepEqual(distancePhrase({ metres: 0.3, reliable: false }), { kind: "very_close" });
  // Any other unreliable figure is just a number the geometry could not stand
  // behind, and it becomes a direction with no distance.
  assert.deepEqual(distancePhrase({ metres: 1.0, reliable: false }), { kind: "none" });
  assert.deepEqual(distancePhrase({ metres: 3.2, reliable: false }), { kind: "none" });
  assert.deepEqual(distancePhrase(null), { kind: "none" });
});

test("distance is spoken only in the range that has clips", () => {
  // Metre clips run m_2…m_5. Outside that the answer keeps the direction and
  // drops the number rather than rounding into a figure nobody measured.
  assert.deepEqual(distancePhrase({ metres: 3.1, reliable: true }), { kind: "metres", metres: 3 });
  assert.deepEqual(distancePhrase({ metres: 0.9, reliable: true }), { kind: "very_close" });
  assert.deepEqual(distancePhrase({ metres: 12, reliable: true }), { kind: "none" });
  assert.deepEqual(distancePhrase({ metres: 5.4, reliable: true }), { kind: "metres", metres: 5 });
});

test("confidence becomes a register, never a number", () => {
  assert.equal(confidenceFor(0.95), "high");
  assert.equal(confidenceFor(0.6), "medium");
  assert.equal(confidenceFor(0.45), "low");
  assert.equal(confidenceFor(0.2), "reject");
});

// ───────────────────────────────────────────────────────── tier 1 answers

test("'Where is the door?' answers from the detector", () => {
  const a = answerFind("find_door", input([at("door", 0.62, 3.1)]));
  assert.equal(a.tier, "on_device");
  assert.equal(a.decline, false);
  assert.ok(a.keys.includes("door"));
  assert.ok(a.keys.includes("ui_ask_dir_slight_right"));
  assert.ok(a.keys.includes("m_3"));
  assert.ok(a.keys.includes("approx"), "an unhedged distance reached the user");
});

test("a door with no usable distance keeps its direction", () => {
  const a = answerFind("find_door", input([{ ...at("door", 0.62, null) }]));
  assert.ok(a.keys.includes("ui_ask_dir_slight_right"));
  assert.equal(a.keys.some((k) => k.startsWith("m_")), false, "invented a distance");
});

test("asking for a chair gets a bench AND the declaration", () => {
  // The single most important answer in the feature. Reporting the bench alone
  // would be a silent substitution and the user would walk to it expecting a chair.
  const a = answerFind("find_seating", input([at("bench", 0.3, 4.0)]));
  assert.ok(a.keys.includes("bench"));
  assert.ok(a.keys.includes("ui_ask_cannot_recognise"), "the substitution was not declared");
  assert.equal(a.keys.indexOf("ui_ask_cannot_recognise"), 0, "the limit must come first");
});

test("a class the detector has is never prefixed with a denial", () => {
  const a = answerFind("find_door", input([at("door", 0.5, 3)]));
  assert.equal(a.keys.includes("ui_ask_cannot_recognise"), false);
});

test("nothing in frame is a decline plus one instruction", () => {
  const a = answerFind("find_door", input([at("bench", 0.5, 3)]));
  assert.equal(a.decline, true);
  assert.ok(a.keys.includes("ui_ask_not_found"));
  assert.ok(a.keys.includes("ui_ask_scan_slowly"));
  assert.equal(a.target, null);
});

test("low confidence is hedged, not suppressed", () => {
  const a = answerFind("find_door", input([at("door", 0.5, 3, 0.46)]));
  assert.ok(a.keys.includes("ui_ask_uncertain"));
  assert.ok(a.keys.includes("door"), "a usable detection was thrown away");
});

test("a detection below the detector's own floor is not reported at all", () => {
  const a = answerFind("find_door", input([at("door", 0.5, 3, 0.2)]));
  assert.equal(a.decline, true);
});

test("multiple matches report the nearest and how many there are", () => {
  const a = answerFind("find_seating", input([at("bench", 0.2, 5), at("bench", 0.5, 2), at("bench", 0.8, 4)]));
  assert.equal(a.target?.siblings, 2, "the other two benches were not counted");
  assert.ok(a.keys.includes("m_2"), "did not lead with the nearest");
});

test("a reliable estimate outranks a nominally closer unreliable one", () => {
  // An unreliable 1 m is not a measurement. Letting it win would put a
  // fabricated number at the top of the answer.
  const unreliable: Candidate = { ...at("bench", 0.5, 1), distance: { metres: 1, reliable: false } };
  const a = answerFind("find_seating", input([unreliable, at("bench", 0.55, 3)]));
  assert.equal(a.target?.distance?.reliable, true);
});

test("the path answer never says the path is clear", () => {
  // It reports what the CAMERA detected and carries the mobility-aid clause in
  // the sentence itself, not in a settings screen nobody visits.
  const a = answerPath(input([]));
  assert.ok(a.keys.includes("ui_ask_nothing_ahead"));
  assert.ok(a.keys.includes("ui_ask_use_cane"), "the mobility-aid clause was dropped");
  assert.equal(a.text.includes("аюулгүй"), false, "claimed safety");
});

test("the path answer reports an obstacle in the corridor", () => {
  const a = answerPath(input([at("pole", 0.5, 2)]));
  assert.ok(a.keys.includes("pole"));
  assert.ok(a.keys.includes("ui_ask_use_cane"));
});

test("objects outside the corridor are not path obstacles", () => {
  // A bench well to one side is not in the way, and reporting it as one would
  // teach the user to ignore the answer.
  const a = answerPath(input([at("bench", CORRIDOR_MIN - 0.1, 2)]));
  assert.ok(a.keys.includes("ui_ask_nothing_ahead"));
});

test("'what is in front of me' is capped at two objects", () => {
  const many = ["pole", "tree", "bench", "car", "sign"].map((c, i) => at(c, 0.4 + i * 0.03, 2 + i));
  const a = answerEnvironment(input(many));
  const named = a.keys.filter((k) => DETECTABLE.has(k));
  assert.ok(named.length <= ENVIRONMENT_CAP, `named ${named.length} objects: ${named.join(", ")}`);
});

test("counting reports a number and the nearest", () => {
  const a = answerCount("find_person", input([at("person", 0.4, 5), at("person", 0.6, 3)]));
  assert.ok(a.keys.includes("num_2"));
  assert.ok(a.keys.includes("person"));
});

test("counting nobody is not a failure", () => {
  const a = answerCount("find_person", input([]));
  assert.equal(a.decline, false);
  assert.ok(a.keys.includes("ui_ask_none_visible"));
});

test("darkness reports the condition and nothing it might have seen", () => {
  // A hedged guess made in conditions the detector was never characterised for
  // is the least trustworthy output available.
  const a = answerFind("find_door", input([at("door", 0.5, 3)], DARK_LUMA - 1));
  assert.equal(a.decline, true);
  assert.ok(a.keys.includes("ui_ask_too_dark"));
  assert.equal(a.keys.includes("door"), false, "guessed in the dark");
});

test("an unrendered clip is dropped, and the text still carries it", () => {
  // 20 of these clips do not exist on disk yet. The answer degrades to what can
  // be spoken; the screen reader still gets the whole sentence.
  const a = answerFind("find_door", { ...input([at("door", 0.5, 3)]), hasClip: () => false });
  assert.deepEqual(a.keys, []);
  assert.ok(a.text.length > 0, "the screen lost the answer too");
});

// ───────────────────────────────────────────────────────── routing

test("a question the detector can answer never escalates", () => {
  // RULE 4, and it holds even with every remote tool available and online.
  for (const q of ["Where is the door?", "Find the stairs.", "Where can I sit?", "Is the path clear?"]) {
    const r = route(q, input([at("door", 0.5, 3)]), emptyContext(), ONLINE_FULL, T0);
    assert.equal(r.kind, "answer", `"${q}" escalated`);
    if (r.kind === "answer") assert.notEqual(r.answer.tier, "vlm", `"${q}" reached the model`);
  }
});

test("a scene question escalates when the model is there", () => {
  const r = route("What kind of place is this?", input([]), emptyContext(), ONLINE_FULL, T0);
  assert.equal(r.kind, "escalate");
  if (r.kind === "escalate") assert.equal(r.to, "vlm");
});

test("a scene question offline declines by naming the connection", () => {
  // Distinct from "I cannot recognise that": one is worth retrying with signal,
  // the other never is.
  const r = route("What kind of place is this?", input([]), emptyContext(), OFFLINE, T0);
  assert.equal(r.kind, "answer");
  if (r.kind === "answer") assert.ok(r.answer.keys.includes("ui_ask_no_network"));
});

test("a text question routes to OCR, and declines when it is not wired", () => {
  const wired = route("What does this sign say?", input([]), emptyContext(), ONLINE_FULL, T0);
  assert.equal(wired.kind, "escalate");
  if (wired.kind === "escalate") assert.equal(wired.to, "ocr");

  const bare = route("What does this sign say?", input([]), emptyContext(), ONLINE_BARE, T0);
  assert.equal(bare.kind, "answer", "escalated to a provider that does not exist");
});

test("stop is not routed as a question", () => {
  assert.equal(route("Stop", input([]), emptyContext(), ONLINE_FULL, T0).kind, "stop");
});

test("an ambiguous question asks, and does not guess", () => {
  const r = route("Where is it?", input([at("bench", 0.5, 2)]), emptyContext(), ONLINE_FULL, T0);
  assert.equal(r.kind, "answer");
  // A bench is right there. Answering about it would be answering a question
  // the user did not ask.
  if (r.kind === "answer") assert.ok(r.answer.keys.includes("ui_ask_what_to_find"));
});

// ───────────────────────────────────────────────────────── context

test("'how far' binds to the last target", () => {
  const first = route("Where is the door?", input([at("door", 0.62, 3)]), emptyContext(), OFFLINE, T0);
  assert.equal(first.kind, "answer");
  if (first.kind !== "answer") return;

  const ctx = remember(emptyContext(), "find_object", first.answer, T0);
  const second = route("How far away?", input([at("door", 0.62, 3)]), ctx, OFFLINE, T0 + 5_000);
  assert.equal(second.kind, "answer");
  if (second.kind === "answer") assert.ok(second.answer.keys.includes("m_3"));
});

test("a target expires, and the follow-up then asks rather than guesses", () => {
  const first = route("Where is the door?", input([at("door", 0.62, 3)]), emptyContext(), OFFLINE, T0);
  if (first.kind !== "answer") throw new Error("setup");
  const ctx = remember(emptyContext(), "find_object", first.answer, T0);

  assert.ok(activeTarget(ctx, T0 + TARGET_TTL_MS - 1));
  assert.equal(activeTarget(ctx, T0 + TARGET_TTL_MS + 1), null);

  const late = route("How far away?", input([at("door", 0.62, 3)]), ctx, OFFLINE, T0 + TARGET_TTL_MS + 1);
  assert.equal(late.kind, "answer");
  if (late.kind === "answer") assert.ok(late.answer.keys.includes("ui_ask_what_to_find"));
});

test("panning the camera away expires the target early", () => {
  // The room changed even though the clock did not.
  const first = route("Where is the door?", input([at("door", 0.2, 3)]), emptyContext(), OFFLINE, T0);
  if (first.kind !== "answer") throw new Error("setup");
  const ctx = remember(emptyContext(), "find_object", first.answer, T0);
  assert.equal(onCameraMoved(ctx, 0.9).target, null);
  assert.ok(onCameraMoved(ctx, 0.25).target);
});

test("a decline never becomes the referent", () => {
  // "I can't see a door" then "how far?" must ask what to look for, not measure
  // something else that happens to be in frame.
  const miss = answerFind("find_door", input([at("bench", 0.5, 2)]));
  const ctx = remember(emptyContext(), "find_object", miss, T0);
  assert.equal(activeTarget(ctx, T0 + 1), null);
});

test("repeat replays the stored answer verbatim", () => {
  const first = answerFind("find_door", input([at("door", 0.62, 3)]));
  const ctx = remember(emptyContext(), "find_object", first, T0);
  const r = route("Repeat that.", input([]), ctx, OFFLINE, T0 + 1_000);
  assert.equal(r.kind, "repeat");
  if (r.kind === "repeat") assert.deepEqual(r.answer?.keys, first.keys);
});

test("availability is never asserted from a detection", () => {
  // A bounding box says a bench is there. It says nothing about whether somebody
  // is sitting on it, and sitting on a stranger is the failure being prevented.
  const found = answerFind("find_seating", input([at("bench", 0.5, 3)]));
  const ctx = remember(emptyContext(), "find_object", found, T0);
  const r = route("Is it empty?", input([at("bench", 0.5, 3)]), ctx, OFFLINE, T0 + 1_000);
  assert.equal(r.kind, "answer");
  if (r.kind === "answer") assert.ok(r.answer.keys.includes("ui_ask_cannot_tell_free"));
});

// ───────────────────────────────────────────────────────── every class

test("every detector class can be found and described", () => {
  // Walks all 32. Catches a class with no goal, no Mongolian name, or a
  // describe path that throws on a missing height prior.
  for (const className of DETECTION_CLASSES) {
    const a = answerEnvironment(input([at(className, 0.5, 3)]));
    assert.ok(a.keys.includes(className), `${className} was not named`);
    assert.ok(a.text.length > 0, `${className} produced no text`);
    assert.equal(a.decline, false, `${className} declined`);
  }
});

test("no answer in any state claims safety or invents a distance", () => {
  // A sweep, because these two rules are the ones a future edit is most likely
  // to break somewhere unexpected.
  const frames: AskInput[] = [
    input([]),
    input([at("door", 0.5, 3)]),
    input([{ ...at("wall", 0.5, 1), distance: { metres: 0.3, reliable: false } }]),
    input([at("person", 0.5, 12)]),
  ];
  for (const f of frames) {
    for (const a of [answerPath(f), answerEnvironment(f), answerFind("find_door", f)]) {
      assert.equal(a.text.includes("аюулгүй"), false, "claimed safety");
      const spokenMetres = a.keys.filter((k) => /^m_\d+$/.test(k));
      if (spokenMetres.length > 0) {
        assert.ok(a.keys.includes("approx"), "spoke an unhedged distance");
      }
    }
  }
});

// ───────────────────────────────────────────────────────── providers

test("the null providers refuse and say why", async () => {
  // AWAITED. Unawaited, `assert.rejects` escapes the test entirely — the
  // assertion still runs, after the test has passed, and node reports it as
  // stray async activity rather than as a failure. That is how a stale message
  // here survived a green run.
  const frame = { bytes: new Uint8Array(), width: 1, height: 1 };
  assert.equal(NO_OCR.available(), false);
  assert.equal(NO_VISION.available(), false);
  await assert.rejects(() => NO_OCR.read(frame), /no OCR provider/);
  await assert.rejects(() => NO_VISION.ask(frame, "?"), /no vision provider/);
});

test("the vision prompt forbids the inferences the on-device path cannot make", () => {
  // The remote tier must not be a way around a rule the local tier obeys simply
  // by being unable to break it.
  for (const rule of ["identity", "emotion", "safe", "blind"]) {
    assert.match(VISION_SYSTEM_PROMPT.toLowerCase(), new RegExp(rule));
  }
});
