/**
 * The countdown, and the reason it is no longer a number anyone can store.
 *
 * A sighted passenger watches a countdown board tick and catches it when it
 * lies. Someone relying on this voice cannot: the number they are told IS the
 * world. So the invariant asserted here is narrow and absolute — every spoken
 * minute is derived from an absolute arrival instant against the clock at the
 * moment of speaking, and there is no path by which a value computed earlier
 * can be replayed later.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ALERT_MINUTES,
  countdownFor,
  countdownKeys,
  countdownRank,
  crossedAlert,
  becameDue,
  DUE_GRACE_MS,
  isStale,
  MAX_SPOKEN_NUMBER,
  STALE_AFTER_MS,
  waitVibration,
  type Countdown,
} from "./eta";
import type { Arrival } from "./types";

const NOW = Date.parse("2026-08-14T09:00:00Z");
const has = () => true;

const at = (minutesFromNow: number, over: Partial<Arrival> = {}): Arrival => ({
  routeId: "11100350",
  routeDisplayName: "Ч:35",
  arrivesAt: NOW + minutesFromNow * 60_000,
  // Deliberately contradictory: nothing may read this field.
  minutes: 99,
  headsign: null,
  isEstimate: true,
  source: "schedule",
  ...over,
});

// ------------------------------------------------------------- derivation

test("REGRESSION: the same arrival counts down as the clock moves", () => {
  // This is the whole bug. One fetch, held on screen while a rider cycles four
  // route options by ear, used to announce its opening number forever.
  const arrival = at(8);
  assert.deepEqual(countdownFor(arrival, NOW), { kind: "minutes", minutes: 8 });
  assert.deepEqual(countdownFor(arrival, NOW + 3 * 60_000), { kind: "minutes", minutes: 5 });
  assert.deepEqual(countdownFor(arrival, NOW + 7 * 60_000), { kind: "minutes", minutes: 1 });
});

test("the stored minute count is never consulted", () => {
  // `minutes: 99` on every fixture. If anything read it, this would say 99.
  assert.deepEqual(countdownFor(at(4), NOW), { kind: "minutes", minutes: 4 });
});

test("a bus inside the grace window is due, not gone", () => {
  // Schedule times are routinely a minute out, and a bus 40 s past its slot is
  // the one pulling in. Declaring it gone sends a rider away from a bus they
  // could still have caught.
  assert.deepEqual(countdownFor(at(0), NOW), { kind: "due" });
  assert.deepEqual(countdownFor(at(0), NOW + DUE_GRACE_MS - 1_000), { kind: "due" });
});

test("REGRESSION: past the grace window it is gone, never a positive number", () => {
  assert.deepEqual(countdownFor(at(0), NOW + DUE_GRACE_MS + 1_000), { kind: "gone" });
  assert.deepEqual(countdownFor(at(5), NOW + 30 * 60_000), { kind: "gone" });
});

test("no absolute time is 'unknown', which is not the same as 'gone'", () => {
  // Distinct on purpose: 'unknown' means say the route and no time. 'gone'
  // means this option should not be offered as arriving at all.
  assert.deepEqual(countdownFor(at(5, { arrivesAt: null }), NOW), { kind: "unknown" });
  assert.deepEqual(countdownFor(at(5, { arrivesAt: NaN }), NOW), { kind: "unknown" });
});

test("beyond the last cardinal clip there is no number to speak", () => {
  assert.deepEqual(countdownFor(at(MAX_SPOKEN_NUMBER), NOW), { kind: "minutes", minutes: 40 });
  assert.deepEqual(countdownFor(at(MAX_SPOKEN_NUMBER + 1), NOW), { kind: "unknown" });
});

test("rounding never lands on zero — that state is called 'due'", () => {
  for (let s = 31; s < 20 * 60; s += 7) {
    const c = countdownFor({ ...at(0), arrivesAt: NOW + s * 1000 }, NOW);
    assert.equal(c.kind, "minutes");
    assert.ok((c as { minutes: number }).minutes >= 1, `${s}s produced a zero`);
  }
});

// ------------------------------------------------------------- staleness

test("a payload older than the stale window is refused outright", () => {
  const fresh = new Date(NOW - 60_000).toISOString();
  assert.equal(isStale(fresh, NOW), false);
  assert.equal(isStale(new Date(NOW - STALE_AFTER_MS - 1_000).toISOString(), NOW), true);
  // A phone that slept: the plan behind these times has since been superseded.
  assert.equal(isStale(fresh, NOW + 40 * 60_000), true);
  assert.equal(isStale(null, NOW), true);
  assert.equal(isStale("not a date", NOW), true);
});

// ------------------------------------------------------------- ordering

test("soonest first, and a bus with no estimate is ranked behind — never dropped", () => {
  const order = (["gone", "unknown", "due", "minutes"] as const).map((kind) =>
    countdownRank(kind === "minutes" ? { kind, minutes: 6 } : ({ kind } as Countdown)),
  );
  const [gone, unknown, due, six] = order;
  assert.ok(due < six, "a bus that is here must come before one in six minutes");
  assert.ok(six < unknown, "a known time beats an unknown one");
  assert.ok(unknown < gone, "an unknown bus is still offerable; a gone one is not");
});

// ------------------------------------------------------------- the ladder

test("the ladder fires once per mark, on the tick that crosses it", () => {
  const m = (minutes: number): Countdown => ({ kind: "minutes", minutes });
  assert.equal(crossedAlert(m(6), m(5)), 5);
  assert.equal(crossedAlert(m(5), m(5)), null, "standing still must not re-announce");
  assert.equal(crossedAlert(m(5), m(4)), null, "4 is not a mark");
  assert.equal(crossedAlert(m(4), m(3)), 3);
  assert.equal(crossedAlert(m(2), m(1)), 1);
});

test("a mark skipped while the screen was asleep still announces once", () => {
  // A backgrounded phone, a late GPS fix, a poll that missed a minute. Firing
  // on the next tick is the whole reason crossing is evaluated against the
  // previous VALUE rather than against a wall-clock timer.
  const m = (minutes: number): Countdown => ({ kind: "minutes", minutes });
  assert.equal(crossedAlert(m(12), m(4)), 10, "the largest mark crossed is the one to say");
});

test("the first observation never fires the ladder", () => {
  // Arriving at the stop to be told "5 minutes" is the opening announcement's
  // job. Firing both would say it twice, half a second apart.
  assert.equal(crossedAlert(null, { kind: "minutes", minutes: 5 }), null);
});

test("becoming due announces exactly once", () => {
  assert.equal(becameDue({ kind: "minutes", minutes: 1 }, { kind: "due" }), true);
  assert.equal(becameDue({ kind: "due" }, { kind: "due" }), false);
  assert.equal(becameDue({ kind: "due" }, { kind: "gone" }), false);
});

test("every mark has a haptic, and they get more insistent as the bus closes", () => {
  const total = (p: number[] | null) => (p ?? []).reduce((a, b) => a + b, 0);
  let previous = 0;
  for (const mark of [...ALERT_MINUTES].reverse()) {
    const pattern = waitVibration(mark);
    assert.ok(pattern, `no haptic for the ${mark}-minute mark`);
    previous = total(pattern);
  }
  assert.ok(previous > 0);
  // The phone in a pocket must be able to tell 10 minutes from 1 by feel alone.
  assert.notDeepEqual(waitVibration(10), waitVibration(1));
  assert.ok(total(waitVibration(1)) > total(waitVibration(10)));
});

// ------------------------------------------------------------- speech keys

test("THE HEDGE IS STRUCTURAL — no countdown produces a bare number", () => {
  for (let minutes = 1; minutes <= MAX_SPOKEN_NUMBER; minutes++) {
    const keys = countdownKeys({ kind: "minutes", minutes }, has);
    assert.equal(keys[0], "bus_approx_prefix", `${minutes} min came out unhedged`);
    assert.deepEqual(keys, ["bus_approx_prefix", `num_${minutes}`, "bus_minutes_suffix"]);
  }
});

test("due keeps the hedge and never borrows the live arrival wording", () => {
  // "ирлээ" and "ойртож байна" are gated on a vehicle we watched move. Schedule
  // data reaching for them is the single most dangerous thing this app could do.
  const keys = countdownKeys({ kind: "due" }, has);
  assert.ok(keys.includes("bus_approx_prefix"));
  assert.ok(!keys.some((k) => k.includes("arrived") || k.includes("approaching")));
});

test("REGRESSION: a missing clip drops the whole time rather than leaving a hole", () => {
  // The wait screen assembled these three inline and handed them to a speaker
  // that silently drops undecoded keys. They live in the TRANSIT manifest and
  // that screen never loaded them, so the minute was deleted from every
  // announcement and the rider heard the route name alone.
  assert.deepEqual(countdownKeys({ kind: "minutes", minutes: 7 }, (k) => k !== "num_7"), []);
  assert.deepEqual(countdownKeys({ kind: "minutes", minutes: 7 }, (k) => k !== "bus_approx_prefix"), []);
  assert.deepEqual(countdownKeys({ kind: "minutes", minutes: 7 }, (k) => k !== "bus_minutes_suffix"), []);
});

test("nothing honest to say produces no keys at all", () => {
  assert.deepEqual(countdownKeys({ kind: "gone" }, has), []);
  assert.deepEqual(countdownKeys({ kind: "unknown" }, has), []);
});
