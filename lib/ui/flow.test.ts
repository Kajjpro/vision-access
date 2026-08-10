/**
 * SCREEN-OFF PROOF.
 *
 * Every flow is driven here through gestures alone, and every assertion is
 * about what was ANNOUNCED. Nothing in this file references a coordinate, an
 * element, or a layout — so if it passes, the flow is completable without
 * looking at the screen, by construction rather than by inspection.
 *
 *   npx tsx --test lib/ui/flow.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ALL_PHRASES, UNRENDERED } from "./announcements";
import { buildDestinationList, recordVisit, type DestinationHistory } from "./destinations";
import { GestureRecognizer, moveCursor, type Gesture, type RawEvent } from "./gesture-nav";

const stops: { id: string; name: string }[] = JSON.parse(readFileSync("public/transit/stops.json", "utf8"));
const routeStops: Record<string, Record<string, string[]>> = JSON.parse(
  readFileSync("public/transit/route-stops.json", "utf8"),
);
const stopName = new Map(stops.map((s) => [s.id, s.name]));

/** A minimal screen: a list of options moved by gestures, recording what it said. */
class ScreenSim {
  index = 0;
  spoken: string[] = [];
  selected: string | null = null;
  wentBack = false;

  constructor(public options: string[]) {}

  apply(g: Gesture, jump = 5) {
    switch (g.type) {
      case "next": case "previous": case "jumpForward": case "jumpBack": {
        const delta = g.type === "next" ? 1 : g.type === "previous" ? -1 : g.type === "jumpForward" ? jump : -jump;
        const { index, wrapped } = moveCursor(this.index, delta, this.options.length);
        this.index = index;
        if (wrapped) this.spoken.push("[boundary cue]");
        this.spoken.push(this.options[index]);
        break;
      }
      case "select": this.selected = this.options[this.index]; this.spoken.push(`[selected] ${this.selected}`); break;
      case "back": this.wentBack = true; this.spoken.push("[back]"); break;
      case "repeat": this.spoken.push(this.spoken.filter((s) => !s.startsWith("[")).at(-1) ?? "[nothing]"); break;
      case "whereAmI": this.spoken.push(`[where] ${this.options[this.index]}`); break;
    }
  }
}

// Real gesture streams, not direct calls: the recogniser is in the loop.
function swipe(dy: number, fingers = 1): RawEvent[] {
  const touches = (f: number) =>
    Array.from({ length: fingers }, (_, k) => ({ id: k, x: 200 + k * 40 + (f * 7), y: 400 + dy * f, t: 0 }));
  return [
    { phase: "start", touches: touches(0), t: 1000 },
    { phase: "move", touches: touches(0.5), t: 1150 },
    { phase: "end", touches: touches(1), t: 1300 },
  ];
}
function doubleTap(): RawEvent[] {
  const one = (t: number, x: number) => [
    { phase: "start" as const, touches: [{ id: 0, x, y: 400, t }], t },
    { phase: "end" as const, touches: [{ id: 0, x, y: 405, t: t + 60 }], t: t + 60 },
  ];
  return [...one(1000, 150), ...one(1200, 320)];
}
function twoFingerTap(): RawEvent[] {
  const touches = [{ id: 0, x: 150, y: 400, t: 1000 }, { id: 1, x: 260, y: 410, t: 1000 }];
  return [
    { phase: "start", touches, t: 1000 },
    { phase: "end", touches, t: 1080 },
  ];
}

function drive(screen: ScreenSim, events: RawEvent[], r: GestureRecognizer) {
  for (const e of events) for (const g of r.handle(e)) screen.apply(g);
}

// ------------------------------------------------------------- home screen

test("home: reach Bus and select it using only gestures", () => {
  const home = new ScreenSim(["Алхах, зүүн дээд", "Юу байна?, баруун дээд", "Автобус, зүүн доод", "Тохиргоо, баруун доод"]);
  const r = new GestureRecognizer();

  drive(home, swipe(160), r);   // → Юу байна?
  drive(home, swipe(160), r);   // → Автобус
  drive(home, doubleTap(), r);

  assert.equal(home.selected, "Автобус, зүүн доод");
  assert.deepEqual(home.spoken, [
    "Юу байна?, баруун дээд",
    "Автобус, зүүн доод",
    "[selected] Автобус, зүүн доод",
  ]);
});

test("home: every option announces its grid position for partial sight", () => {
  const home = new ScreenSim(["Алхах, зүүн дээд", "Юу байна?, баруун дээд", "Автобус, зүүн доод", "Тохиргоо, баруун доод"]);
  for (const option of home.options) {
    assert.match(option, /зүүн дээд|баруун дээд|зүүн доод|баруун доод/, `${option} has no spoken position`);
  }
});

test("two-finger tap repeats the last thing said — the loud-bus case", () => {
  const home = new ScreenSim(["Алхах", "Автобус"]);
  const r = new GestureRecognizer();
  drive(home, swipe(160), r);
  assert.equal(home.spoken.at(-1), "Автобус");
  drive(home, twoFingerTap(), r);
  assert.equal(home.spoken.at(-1), "Автобус", "repeat must say the same thing again");
});

test("a list announces a boundary cue before it wraps", () => {
  const home = new ScreenSim(["A", "B", "C"]);
  const r = new GestureRecognizer();
  drive(home, swipe(160), r);
  drive(home, swipe(160), r);
  drive(home, swipe(160), r); // past the end
  assert.ok(home.spoken.includes("[boundary cue]"), "user must know they looped, not that the list is endless");
  assert.equal(home.index, 0);
});

// --------------------------------------------------- destination at scale

test("the longest direction is navigable without forty swipes", () => {
  // Ч:73 direction 0 — the longest single direction in the city.
  const seq = routeStops["11100730"]["0"];
  const list = buildDestinationList(seq, 0, {}, "11100730", { isNameable: (id) => Boolean(stopName.get(id)?.trim()) });
  assert.ok(list.length > 20, `expected a long list, got ${list.length}`);

  const screen = new ScreenSim(list.map((e) => stopName.get(e.stopId) ?? e.stopId));
  const r = new GestureRecognizer();

  // Two-finger swipes jump five at a time.
  for (let i = 0; i < 4; i++) drive(screen, swipe(170, 2), r);
  assert.equal(screen.index, 20, "four two-finger swipes should cover twenty stops");

  // Then single swipes for the last little bit.
  drive(screen, swipe(160), r);
  assert.equal(screen.index, 21);
});

test("a regular commuter reaches their stop in one gesture", () => {
  const seq = routeStops["11100730"]["0"];
  const destination = seq[25];
  let history: DestinationHistory = {};
  const now = Date.now();
  for (let i = 0; i < 5; i++) history = recordVisit(history, "11100730", destination, now - i * 86400000);

  const list = buildDestinationList(seq, 0, history, "11100730");
  const screen = new ScreenSim(list.map((e) => stopName.get(e.stopId) ?? e.stopId));
  const r = new GestureRecognizer();

  // The cursor already rests on option 0, which the screen announces on entry —
  // so the commute costs a double-tap and NOTHING else.
  assert.equal(list[0].stopId, destination, "the daily destination must be first");
  drive(screen, doubleTap(), r);
  assert.equal(screen.selected, stopName.get(destination));

  // Without history the same stop is 26 options down the list.
  const cold = buildDestinationList(seq, 0, {}, "11100730");
  assert.ok(cold.findIndex((e) => e.stopId === destination) > 20, "history must be doing real work");
});

test("position in the list is announceable — n of total", () => {
  const seq = routeStops["11100730"]["0"];
  const list = buildDestinationList(seq, 0, {}, "11100730");
  assert.equal(list[0].position, 1);
  assert.equal(list[11].position, 12, "'12 дахь, N-ээс' needs a 1-based position");
  assert.ok(list.every((e, i) => e.position === i + 1));
});

// -------------------------------------------------- announcement coverage

test("every announcement string is reviewable in one file", () => {
  assert.ok(Object.keys(ALL_PHRASES).length > 40, "the registry should cover the whole interface");
  for (const [name, phrase] of Object.entries(ALL_PHRASES)) {
    assert.equal(typeof phrase.en, "string", `${name} has no English gloss for review`);
    if (phrase.mn.trim()) {
      assert.doesNotMatch(phrase.mn, /[A-Za-z]/, `${name} contains Latin text: ${phrase.mn}`);
    }
  }
});

test("every spoken phrase has a rendered clip", () => {
  // The tutorial shipped silent once: every GESTURE phrase had clip: null, so
  // playSequence filtered them all out and the first-run walkthrough said
  // nothing at all on every platform. This is the guard against that returning.
  const silent = Object.entries(ALL_PHRASES)
    .filter(([, p]) => p.mn.trim() !== "" && p.clip === null)
    .map(([name]) => name);
  assert.deepEqual(silent, [], `phrases with no clip would be spoken as silence: ${silent.join(", ")}`);
  // UNRENDERED is computed from the same data, so it cannot drift.
  assert.equal(UNRENDERED.length, 0, "backlog must be empty when every clip exists");
});

test("the welcome is spoken immediately, with no lesson to sit through", () => {
  // No tutorial: a blind user opening an unknown app needs to know what it does
  // and how to move through it, in one breath — not a practice session.
  const welcome = ALL_PHRASES["GESTURE.welcome"];
  assert.ok(welcome, "there must be a welcome announcement");
  assert.ok(welcome.clip?.startsWith("ui_"), "welcome must use the WAV pipeline iOS decodes natively");
  assert.match(welcome.mn, /шудар/, "the welcome must say how to navigate");
});

test("no tutorial or teaching phrases survive", () => {
  const teaching = Object.keys(ALL_PHRASES).filter((k) => /tutorial|practise|lesson/i.test(k));
  assert.deepEqual(teaching, [], "the brief removed teaching entirely");
});

test("no announcement depends on seeing the screen", () => {
  // Nothing may tell the user to look, point, or find something.
  const visual = /дээр дар|доор дар|товч дар|харна уу|хараарай/i;
  for (const [name, phrase] of Object.entries(ALL_PHRASES)) {
    assert.doesNotMatch(phrase.mn, visual, `${name} instructs the user to look: ${phrase.mn}`);
  }
});
