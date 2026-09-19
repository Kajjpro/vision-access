/**
 * Guidance settings, the assistant menu, and the missing-audio ladder.
 *
 * Small surfaces, but each one is a place a rider's explicit choice can be
 * quietly discarded — which is worse than never offering the choice.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { assistantMenu, hasAssistant } from "./assistant";
import { NO_SPEECH_FALLBACK, createMissingClipReporter } from "./audio-fallback";
import { DEFAULT_SETTINGS, isGuidanceLevel, loadSettings, saveSettings } from "./settings";
import { createJourney } from "./types";
import type { Journey, JourneyState } from "./types";

const T0 = 1_700_000_000_000;

/** An in-memory Storage, so the tests never touch a real one. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, v); },
  } as Storage;
}

/** A Storage that throws on everything, like private mode. */
const hostileStorage = new Proxy({} as Storage, {
  get() { throw new Error("private mode"); },
});

function journeyIn(state: JourneyState, patch: Partial<Journey> = {}): Journey {
  return { ...createJourney(T0), state, ...patch };
}

// ------------------------------------------------------------------ settings

test("the default is the setting that satisfies both halves of the policy", () => {
  // No speech on a timer, and audible proof the app is running. Not "the middle
  // option" — the one that resolves the conflict.
  assert.equal(DEFAULT_SETTINGS.level, "standard");
  assert.equal(DEFAULT_SETTINGS.heartbeat, true);
});

test("a chosen level survives a reload", () => {
  const store = fakeStorage();
  saveSettings({ level: "detailed", heartbeat: false }, store);
  assert.deepEqual(loadSettings(store), { level: "detailed", heartbeat: false });
});

test("the two knobs are independent", () => {
  // A rider can want detailed speech AND no tone, or silence in words and a
  // pulse to know the app is alive. Tying them together forces a choice nobody
  // asked for.
  const store = fakeStorage();
  saveSettings({ level: "detailed", heartbeat: true }, store);
  assert.deepEqual(loadSettings(store), { level: "detailed", heartbeat: true });
  saveSettings({ level: "minimal", heartbeat: false }, store);
  assert.deepEqual(loadSettings(store), { level: "minimal", heartbeat: false });
});

test("a corrupt or absent value falls back rather than throwing", () => {
  assert.deepEqual(loadSettings(fakeStorage()), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(fakeStorage({ "va:guidance-level": "loud" })), DEFAULT_SETTINGS);
  // Settings are not worth failing a journey over.
  assert.deepEqual(loadSettings(hostileStorage), DEFAULT_SETTINGS);
  assert.doesNotThrow(() => saveSettings({ level: "minimal", heartbeat: true }, hostileStorage));
});

test("only an explicit off turns the heartbeat off", () => {
  // An absent key is a rider who has never chosen, and they get the proof of
  // life rather than the silence.
  assert.equal(loadSettings(fakeStorage({})).heartbeat, true);
  assert.equal(loadSettings(fakeStorage({ "va:guidance-heartbeat": "0" })).heartbeat, false);
  assert.equal(loadSettings(fakeStorage({ "va:guidance-heartbeat": "1" })).heartbeat, true);
});

test("isGuidanceLevel rejects anything not on the list", () => {
  assert.ok(isGuidanceLevel("minimal") && isGuidanceLevel("standard") && isGuidanceLevel("detailed"));
  for (const bad of ["", "MINIMAL", "verbose", null, 3, undefined]) {
    assert.equal(isGuidanceLevel(bad), false, String(bad));
  }
});

// ----------------------------------------------------------------- assistant

test("the assistant only offers questions the journey can answer", () => {
  // Offering a question the app must then decline teaches the rider it is
  // unreliable. "How many stops remain" is absent while waiting because the
  // honest answer would be about a journey that has not started.
  const waiting = assistantMenu(journeyIn("waiting_for_bus")).map((e) => e.id);
  assert.ok(!waiting.includes("stops_left"));
  assert.ok(waiting.includes("when_bus"));

  const riding = assistantMenu(journeyIn("on_bus")).map((e) => e.id);
  assert.ok(riding.includes("stops_left"));
  assert.ok(!riding.includes("when_bus"), "a bus you are already on has no arrival to ask about");
});

test("the assistant is closed while a question is open", () => {
  // The journey is blocked on an answer, and the answers are the screen's own
  // options. Burying "yes I boarded" under a menu at that moment is the
  // interface getting in the way of the one thing it needs.
  for (const state of ["confirming_boarding", "confirming_exit"] as JourneyState[]) {
    assert.deepEqual(assistantMenu(journeyIn(state)), []);
    assert.equal(hasAssistant(journeyIn(state)), false);
  }
});

test("the list is shortest at the moment the rider has least attention", () => {
  // About to stand up and move in a vehicle they cannot see out of.
  const approaching = assistantMenu(journeyIn("approaching_destination"));
  const riding = assistantMenu(journeyIn("on_bus"));
  assert.ok(approaching.length < riding.length);
  assert.ok(approaching.length >= 1, "still answerable, just briefer");
});

test("every assistant entry can be both spoken and read", () => {
  const states: JourneyState[] = [
    "walking_to_stop", "waiting_for_bus", "bus_due", "on_bus", "approaching_destination",
    "journey_error",
  ];
  for (const state of states) {
    for (const e of assistantMenu(journeyIn(state))) {
      assert.ok(e.keys.length > 0, `${state}/${e.id} has no clip`);
      assert.ok(e.label.trim().length > 0, `${state}/${e.id} has no label`);
      assert.doesNotMatch(e.label, /[A-Za-z]/, `${state}/${e.id} leaked Latin: ${e.label}`);
    }
  }
});

test("the assistant is absent where there is no journey to ask about", () => {
  for (const state of ["idle", "selecting_destination", "arrived"] as JourneyState[]) {
    assert.equal(hasAssistant(journeyIn(state)), false, state);
  }
});

// ------------------------------------------------------------ audio fallback

test("a missing clip is reported once per key, not once per occurrence", () => {
  // A stop name missing on every tick would bury the console in one fact, which
  // is how a real warning stops being read.
  const warnings: string[] = [];
  const reporter = createMissingClipReporter({ warn: (m) => warnings.push(m), verbose: true });

  reporter.record(["stop_000000010"]);
  reporter.record(["stop_000000010"]);
  reporter.record(["stop_000000010", "ui_confirm_boarded_q"]);

  assert.equal(warnings.length, 2, "one warning per distinct key");
  assert.match(warnings[0], /stop_000000010/);
  assert.match(warnings[0], /render-ui-audio/, "the warning must say how to fix it");
});

test("the counts survive, because they order the rendering backlog", () => {
  const reporter = createMissingClipReporter({ warn: () => {}, verbose: false });
  reporter.record(["a", "b"]);
  reporter.record(["a"]);
  const report = reporter.report();
  assert.deepEqual(report.keys, ["a", "b"], "first-seen order");
  assert.equal(report.counts.a, 2);
  assert.equal(report.counts.b, 1);
  assert.equal(report.total, 3);
});

test("production stays quiet on the console but still counts", () => {
  const warnings: string[] = [];
  const reporter = createMissingClipReporter({ warn: (m) => warnings.push(m), verbose: false });
  reporter.record(["x"]);
  assert.deepEqual(warnings, []);
  assert.equal(reporter.report().total, 1);
});

test("the shipped speech fallback refuses, and says why", async () => {
  // The rung exists so the decision is on the record; the implementation does
  // not, because a confident English phoneme set reading Mongolian Cyrillic at a
  // kerb is worse than a gap the rider can recognise as a gap.
  assert.equal(NO_SPEECH_FALLBACK.canSpeak(), false);
  // Awaited: an unawaited rejects assertion runs after the test has already
  // passed, so a wrong message would never fail anything.
  await assert.rejects(
    () => NO_SPEECH_FALLBACK.speak("тест", new AbortController().signal),
    /mn-MN/,
  );
});
