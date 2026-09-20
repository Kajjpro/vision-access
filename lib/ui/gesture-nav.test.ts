/**
 * Gesture recognition under SLOPPY input.
 *
 * Clean synthetic swipes prove nothing: the real input is a gloved hand on a
 * moving bus, and a recogniser that only accepts tidy straight gestures fails
 * exactly when it matters. Every swipe here is generated with jitter, curvature
 * and irregular sample timing, and the tests assert the gesture still resolves.
 *
 *   npx tsx --test lib/ui/gesture-nav.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GestureRecognizer, moveCursor, THRESHOLDS, type Gesture, type RawEvent, type Sample,
} from "./gesture-nav";
import {
  buildDestinationList, FREQUENT_THRESHOLD, recordVisit, type DestinationHistory,
} from "./destinations";

/** Deterministic jitter — a test that fails only on some seeds gets ignored. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A swipe as an unsteady hand actually makes it: wandering off-axis, varying
 * speed, and sampled at irregular intervals.
 */
function sloppySwipe(
  opts: {
    dx: number; dy: number; fingers?: number; durationMs?: number;
    jitterPx?: number; curvePx?: number; seed?: number; startX?: number; startY?: number;
  },
): RawEvent[] {
  const {
    dx, dy, fingers = 1, durationMs = 400, jitterPx = 18, curvePx = 25,
    seed = 1, startX = 200, startY = 400,
  } = opts;
  const rand = rng(seed);
  const events: RawEvent[] = [];
  const steps = 7;
  let t = 1000;

  const at = (f: number, i: number): Sample[] =>
    Array.from({ length: fingers }, (_, k) => ({
      id: k,
      // Curvature: the path bows off-axis and comes back, as a real drag does.
      x: startX + dx * f + Math.sin(f * Math.PI) * curvePx + (rand() - 0.5) * jitterPx + k * 45,
      y: startY + dy * f + Math.cos(f * Math.PI) * (curvePx * 0.4) + (rand() - 0.5) * jitterPx,
      t,
    }));

  events.push({ phase: "start", touches: at(0, 0), t });
  for (let i = 1; i < steps; i++) {
    // Irregular sampling — real touch streams are not evenly spaced.
    t += (durationMs / steps) * (0.5 + rand());
    events.push({ phase: "move", touches: at(i / steps, i), t });
  }
  t += durationMs / steps;
  events.push({ phase: "end", touches: at(1, steps), t });
  return events;
}

function tap(opts: { fingers?: number; at?: number; driftPx?: number; x?: number; y?: number } = {}): RawEvent[] {
  const { fingers = 1, at = 1000, driftPx = 12, x = 200, y = 400 } = opts;
  const touches = (dx: number): Sample[] =>
    Array.from({ length: fingers }, (_, k) => ({ id: k, x: x + dx + k * 40, y: y + dx * 0.5, t: at }));
  return [
    { phase: "start", touches: touches(0), t: at },
    { phase: "move", touches: touches(driftPx), t: at + 40 },
    { phase: "end", touches: touches(driftPx), t: at + 90 },
  ];
}

function run(events: RawEvent[], recognizer = new GestureRecognizer()): Gesture[] {
  const out: Gesture[] = [];
  for (const e of events) out.push(...recognizer.handle(e));
  return out;
}

// ------------------------------------------------------------ swipes

test("a sloppy downward swipe still means next, across many seeds", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = run(sloppySwipe({ dx: 0, dy: 160, seed }));
    assert.deepEqual(g, [{ type: "next" }], `seed ${seed} failed`);
  }
});

test("a sloppy upward swipe still means previous, across many seeds", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = run(sloppySwipe({ dx: 0, dy: -160, seed }));
    assert.deepEqual(g, [{ type: "previous" }], `seed ${seed} failed`);
  }
});

test("a badly skewed diagonal still resolves rather than being rejected", () => {
  // 160 px down but wandering 70 px sideways — a gloved hand on a moving bus.
  for (let seed = 1; seed <= 25; seed++) {
    const g = run(sloppySwipe({ dx: 70, dy: 160, jitterPx: 30, curvePx: 40, seed }));
    assert.deepEqual(g, [{ type: "next" }], `seed ${seed}: skewed swipe lost`);
  }
});

test("a slow gloved swipe is still a swipe", () => {
  // 1.1 s: nowhere near a flick, which is exactly the point.
  const g = run(sloppySwipe({ dx: 0, dy: 180, durationMs: 1100, seed: 5 }));
  assert.deepEqual(g, [{ type: "next" }]);
});

test("leftward swipe is back; rightward is deliberately inert", () => {
  assert.deepEqual(run(sloppySwipe({ dx: -170, dy: 0, seed: 3 })), [{ type: "back" }]);
  assert.deepEqual(run(sloppySwipe({ dx: 170, dy: 0, seed: 3 })), [], "right must do nothing");
});

test("a short drag is not a swipe — that is a steadying hand, not an instruction", () => {
  const g = run(sloppySwipe({ dx: 0, dy: THRESHOLDS.swipeMinDistancePx - 25, seed: 9 }));
  assert.deepEqual(g.filter((x) => x.type === "next" || x.type === "previous"), []);
});

// -------------------------------------------------------------- taps

test("a single tap does nothing — a hand braced on the glass must not select", () => {
  assert.deepEqual(run(tap()), []);
});

test("two taps select, even when they land far apart", () => {
  const r = new GestureRecognizer();
  const out = [...run(tap({ at: 1000, x: 120, y: 300 }), r), ...run(tap({ at: 1300, x: 330, y: 620 }), r)];
  assert.deepEqual(out, [{ type: "select" }], "position must not matter");
});

test("two slow taps still count as a double-tap", () => {
  const r = new GestureRecognizer();
  const out = [...run(tap({ at: 1000 }), r), ...run(tap({ at: 1000 + THRESHOLDS.doubleTapMaxGapMs - 40 }), r)];
  assert.deepEqual(out, [{ type: "select" }]);
});

test("taps too far apart in time do not select", () => {
  const r = new GestureRecognizer();
  const out = [...run(tap({ at: 1000 }), r), ...run(tap({ at: 1000 + THRESHOLDS.doubleTapMaxGapMs + 300 }), r)];
  assert.deepEqual(out, []);
});

test("a wobbly tap through a glove is still a tap", () => {
  const r = new GestureRecognizer();
  const out = [
    ...run(tap({ at: 1000, driftPx: THRESHOLDS.tapMaxDriftPx - 6 }), r),
    ...run(tap({ at: 1300, driftPx: THRESHOLDS.tapMaxDriftPx - 6 }), r),
  ];
  assert.deepEqual(out, [{ type: "select" }]);
});

test("two-finger tap repeats — the loud-bus gesture", () => {
  assert.deepEqual(run(tap({ fingers: 2 })), [{ type: "repeat" }]);
});

// ------------------------------------------------ two-finger and long press

test("two-finger vertical swipe jumps, one-finger does not", () => {
  assert.deepEqual(run(sloppySwipe({ dx: 0, dy: 170, fingers: 2, seed: 11 })), [{ type: "jumpForward" }]);
  assert.deepEqual(run(sloppySwipe({ dx: 0, dy: -170, fingers: 2, seed: 11 })), [{ type: "jumpBack" }]);
});

test("two-finger HORIZONTAL swipe is inert — an accident must not leave the screen", () => {
  assert.deepEqual(run(sloppySwipe({ dx: -180, dy: 0, fingers: 2, seed: 4 })), []);
});

test("a held finger reports where am I, and does not also fire a tap", () => {
  const r = new GestureRecognizer();
  r.handle({ phase: "start", touches: [{ id: 0, x: 200, y: 400, t: 1000 }], t: 1000 });
  r.handle({ phase: "move", touches: [{ id: 0, x: 210, y: 408, t: 1200 }], t: 1200 });
  assert.deepEqual(r.tick(1000 + THRESHOLDS.longPressMs - 50), [], "must not fire early");
  assert.deepEqual(r.tick(1000 + THRESHOLDS.longPressMs + 10), [{ type: "whereAmI" }]);
  const onRelease = r.handle({ phase: "end", touches: [{ id: 0, x: 210, y: 408, t: 2000 }], t: 2000 });
  assert.deepEqual(onRelease, [], "release after a long press must not also tap");
});

test("a finger that wanders is a swipe, not a long press", () => {
  const r = new GestureRecognizer();
  r.handle({ phase: "start", touches: [{ id: 0, x: 200, y: 400, t: 1000 }], t: 1000 });
  r.handle({ phase: "move", touches: [{ id: 0, x: 205, y: 560, t: 1100 }], t: 1100 });
  assert.deepEqual(r.tick(1700), [], "drifted too far to be a long press");
});

// ----------------------------------------------------------- wrap-around

test("wrapping is reported so a loop can be signalled", () => {
  assert.deepEqual(moveCursor(3, 1, 5), { index: 4, wrapped: false });
  assert.deepEqual(moveCursor(4, 1, 5), { index: 0, wrapped: true });
  assert.deepEqual(moveCursor(0, -1, 5), { index: 4, wrapped: true });
  // A five-jump past the end still lands in range and still reports the wrap.
  assert.deepEqual(moveCursor(3, 5, 10), { index: 8, wrapped: false });
  assert.deepEqual(moveCursor(8, 5, 10), { index: 3, wrapped: true });
});

test("an empty list cannot move", () => {
  assert.deepEqual(moveCursor(0, 1, 0), { index: 0, wrapped: false });
});

// ------------------------------------------------------- destination list

const seq = Array.from({ length: 30 }, (_, i) => `s${i}`);

test("with no history the list is just the route ahead of you", () => {
  const list = buildDestinationList(seq, 0, {}, "R1");
  assert.equal(list.length, 29, "every stop after boarding");
  assert.equal(list[0].stopId, "s1");
  assert.ok(list.every((e) => e.group === "all"));
  assert.deepEqual(list.map((e) => e.position).slice(0, 3), [1, 2, 3]);
});

test("a frequent destination is reachable in one or two gestures", () => {
  let history: DestinationHistory = {};
  const now = Date.now();
  for (let i = 0; i < FREQUENT_THRESHOLD; i++) history = recordVisit(history, "R1", "s25", now - i * 86400000);
  const list = buildDestinationList(seq, 0, history, "R1");
  assert.equal(list[0].stopId, "s25", "the daily commute must come first");
  assert.equal(list[0].group, "frequent");
  assert.equal(list[0].index, 25, "index into the route sequence is preserved");
});

test("a promoted stop does not appear twice", () => {
  let history: DestinationHistory = {};
  const now = Date.now();
  for (let i = 0; i < FREQUENT_THRESHOLD; i++) history = recordVisit(history, "R1", "s25", now - i * 86400000);
  const list = buildDestinationList(seq, 0, history, "R1");
  assert.equal(list.filter((e) => e.stopId === "s25").length, 1, "hearing it twice would be disorienting");
  assert.equal(list.length, 29, "total is unchanged, only the order");
});

test("history from a different route does not leak in", () => {
  const history = recordVisit({}, "R2", "s25", Date.now());
  const list = buildDestinationList(seq, 0, history, "R1");
  assert.equal(list[0].stopId, "s1");
});

test("stops behind the boarding point are never offered", () => {
  const history = recordVisit({}, "R1", "s2", Date.now());
  const list = buildDestinationList(seq, 10, history, "R1");
  assert.ok(list.every((e) => e.index > 10), "cannot alight where the bus has already been");
  assert.ok(!list.some((e) => e.stopId === "s2"));
});

test("unnameable stops are not offered but keep their sequence index", () => {
  const list = buildDestinationList(seq, 0, {}, "R1", { isNameable: (id) => id !== "s5" });
  assert.ok(!list.some((e) => e.stopId === "s5"), "cannot choose what cannot be spoken");
  // The remaining entries still carry true sequence indices, so the countdown
  // stays right even though the picker skipped one.
  assert.equal(list.find((e) => e.stopId === "s6")!.index, 6);
});

test("stale history is dropped rather than suggested forever", () => {
  const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
  const history = recordVisit({}, "R1", "s25", old);
  const list = buildDestinationList(seq, 0, history, "R1");
  assert.equal(list[0].stopId, "s1", "a trip from last year is not a suggestion");
});

// ----------------------------------------------------- push-to-talk edges

/** One finger, held still, then lifted. The push-to-talk gesture. */
function hold(r: GestureRecognizer, { liftAt = 2000 } = {}): Gesture[] {
  const out: Gesture[] = [];
  out.push(...r.handle({ phase: "start", touches: [{ id: 0, x: 200, y: 400, t: 1000 }], t: 1000 }));
  out.push(...r.tick(1000 + THRESHOLDS.longPressMs + 10));
  out.push(...r.handle({ phase: "end", touches: [{ id: 0, x: 204, y: 403, t: liftAt }], t: liftAt }));
  return out;
}

test("hold mode turns a long press into microphone edges", () => {
  const r = new GestureRecognizer();
  r.setHoldMode(true);
  assert.deepEqual(hold(r), [{ type: "holdStart" }, { type: "holdEnd" }]);
});

test("without hold mode the same gesture still means where am I", () => {
  const r = new GestureRecognizer();
  assert.deepEqual(hold(r), [{ type: "whereAmI" }]);
});

test("a hold that started still CLOSES when the mode is turned off mid-press", () => {
  // Otherwise a phase change while the rider is speaking leaves the microphone
  // open until the recognizer's own timeout, recording someone who believes
  // they have stopped.
  const r = new GestureRecognizer();
  r.setHoldMode(true);
  r.handle({ phase: "start", touches: [{ id: 0, x: 200, y: 400, t: 1000 }], t: 1000 });
  assert.deepEqual(r.tick(1000 + THRESHOLDS.longPressMs + 10), [{ type: "holdStart" }]);
  r.setHoldMode(false);
  const released = r.handle({ phase: "end", touches: [{ id: 0, x: 200, y: 400, t: 2000 }], t: 2000 });
  assert.deepEqual(released, [{ type: "holdEnd" }], "the microphone was left open");
});

test("a touch cancelled by the system still closes the microphone", () => {
  // iOS fires touchcancel readily; useGestureNav feeds it as an end.
  const r = new GestureRecognizer();
  r.setHoldMode(true);
  r.handle({ phase: "start", touches: [{ id: 0, x: 200, y: 400, t: 1000 }], t: 1000 });
  r.tick(1000 + THRESHOLDS.longPressMs + 10);
  assert.deepEqual(
    r.handle({ phase: "end", touches: [{ id: 0, x: 200, y: 400, t: 1800 }], t: 1800 }),
    [{ type: "holdEnd" }],
  );
});

test("a quick tap in hold mode is not a hold — it never opened anything", () => {
  const r = new GestureRecognizer();
  r.setHoldMode(true);
  r.handle({ phase: "start", touches: [{ id: 0, x: 200, y: 400, t: 1000 }], t: 1000 });
  const quick = r.handle({ phase: "end", touches: [{ id: 0, x: 202, y: 401, t: 1100 }], t: 1100 });
  assert.deepEqual(quick, [], "a single tap alone still does nothing");
});

test("holdEnd fires exactly once", () => {
  const r = new GestureRecognizer();
  r.setHoldMode(true);
  hold(r);
  const again = r.handle({ phase: "end", touches: [{ id: 0, x: 200, y: 400, t: 2100 }], t: 2100 });
  assert.deepEqual(again, [], "a second release re-closed the microphone");
});

test("double-tap, swipe left and two-finger tap keep their meanings in hold mode", () => {
  // The voice flow maps these to confirm / reject / restart. They must not
  // change behaviour just because the screen is listening.
  const r = new GestureRecognizer();
  r.setHoldMode(true);
  assert.deepEqual(run(sloppySwipe({ dx: -180, dy: 0, fingers: 1, seed: 7 }), r), [{ type: "back" }]);
});
