/**
 * The announcement POLICY, which is the part of this app a phone cannot test.
 *
 *   npx tsx --test lib/salience.test.ts
 *
 * Everything here is about behaviour over tens of seconds of walking — a row
 * of bollards, a cyclist arriving from the side, a corridor that empties out.
 * On a device those take tens of seconds to reproduce and cannot be replayed;
 * here they are a loop over integers.
 *
 * The invariants worth defending are the ones where being wrong is expensive:
 * an all-clear from a blind detector, a warning that arrives after the object,
 * and a voice that talks so continuously the user stops listening to it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUCKET_DEBOUNCE_MS,
  CLEAR_MAX_LAG_MS,
  CLEAR_SETTLE_MS,
  CONTENT_REPEAT_MS,
  ClearPathWatcher,
  MIN_ANNOUNCE_GAP_MS,
  SpeechGate,
  bearingClip,
  bearingOf,
  isMaterialChange,
  isRelevant,
  nameIsTrusted,
  planUtterance,
} from "./salience";
import type { Summary } from "./salience";
import { DEFAULT_PITCH_DEG } from "./distance";
import type { CameraPose } from "./distance";
import type { Track } from "./tracker";

const POSE: CameraPose = {
  frameWidth: 640,
  frameHeight: 480,
  pitchDeg: DEFAULT_PITCH_DEG,
  cameraHeightM: 1.4,
  pitchMeasured: true,
};

/**
 * A track sitting dead centre, three metres away, confidently named. Anything
 * a test cares about is passed as an override, so a test about bearing is
 * never accidentally also a test about the naming gate.
 */
function track(over: Partial<Track> = {}): Track {
  const w = 80;
  return {
    id: 1,
    className: "car",
    score: 0.9,
    classConfidence: 0.9,
    x: POSE.frameWidth / 2 - w / 2,
    y: 300,
    w,
    h: 90,
    metres: 3,
    reliable: true,
    hits: 5,
    firstSeenMs: 0,
    lastSeenMs: 0,
    closingMps: null,
    ttcS: Infinity,
    ...over,
  };
}

/** Place a track's centre at a fraction of the frame width. */
function atX(fraction: number, over: Partial<Track> = {}): Track {
  const w = 60;
  return track({ x: POSE.frameWidth * fraction - w / 2, w, ...over });
}

function summary(over: Partial<Summary> = {}): Summary {
  return {
    trackId: 1,
    className: "car",
    bearing: "ahead",
    bucket: "near",
    approaching: false,
    overhead: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Bearing
// ---------------------------------------------------------------------------

test("the centre band is wide enough that most warnings carry no direction word", () => {
  // Every one of these is inside the walking corridor, which is where the
  // great majority of announcements come from. If any of them acquired a
  // direction clip, the common case would grow half a second for no
  // information — the exact cost this band width exists to avoid.
  for (const f of [0.4, 0.45, 0.5, 0.55, 0.6]) {
    assert.equal(bearingOf(atX(f), POSE), "ahead", `centre ${f}`);
    assert.equal(bearingClip(bearingOf(atX(f), POSE)), null, `centre ${f}`);
  }
});

test("off-centre objects get a spoken direction, graded by how far off", () => {
  assert.equal(bearingOf(atX(0.05), POSE), "left");
  assert.equal(bearingOf(atX(0.25), POSE), "slightly_left");
  assert.equal(bearingOf(atX(0.75), POSE), "slightly_right");
  assert.equal(bearingOf(atX(0.95), POSE), "right");

  assert.equal(bearingClip("left"), "dir_left");
  assert.equal(bearingClip("slightly_right"), "dir_slightly_right");
});

test("a zero-width frame does not produce a direction out of a division by zero", () => {
  // frameWidth is read off the video element and is 0 until metadata lands.
  const blind: CameraPose = { ...POSE, frameWidth: 0 };
  assert.equal(bearingOf(track(), blind), "ahead");
});

// ---------------------------------------------------------------------------
// Relevance
// ---------------------------------------------------------------------------

test("a parked car outside the corridor is detected and deliberately not announced", () => {
  const parked = atX(0.05, { closingMps: null, ttcS: Infinity });
  assert.equal(isRelevant(parked, POSE), false);
});

test("something closing fast from outside the corridor IS announced", () => {
  // The cyclist coming up the pavement on your right: previously invisible to
  // this app until it entered the corridor, which is roughly the moment of
  // impact, and the hazard a white cane is least able to find.
  const cyclist = atX(0.9, { className: "bicycle", closingMps: 4, ttcS: 2 });
  assert.equal(isRelevant(cyclist, POSE), true);
});

test("closing fast but still far away stays quiet", () => {
  // Same speed, thirty metres out. Nothing to act on yet, and saying so now
  // spends the announcement budget a nearer hazard will need.
  const distant = atX(0.9, { className: "car", closingMps: 4, ttcS: 12 });
  assert.equal(isRelevant(distant, POSE), false);
});

test("anything in the corridor is relevant whether it moves or not", () => {
  assert.equal(isRelevant(atX(0.5, { closingMps: null, ttcS: Infinity }), POSE), true);
});

// ---------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------

test("the object name precedes the distance, with direction between them", () => {
  const plan = planUtterance(atX(0.75, { metres: 3, reliable: true }), POSE);
  assert.ok(plan);
  assert.deepEqual(plan.clips, ["car", "dir_slightly_right", "approx", "m_3"]);
});

test("approaching lands last, where a Mongolian verb belongs", () => {
  const plan = planUtterance(
    atX(0.9, { className: "bicycle", metres: 3, reliable: true, closingMps: 4, ttcS: 2 }),
    POSE,
  );
  assert.ok(plan);
  assert.deepEqual(plan.clips, ["bicycle", "dir_right", "approx", "m_3", "approaching"]);
});

test("an untrusted name costs the name and nothing else", () => {
  // A detector alternating car/truck is confident twice a second and right at
  // most half the time. The warning must survive without the noun.
  const unsure = atX(0.75, { classConfidence: 0.4, metres: 3, reliable: true });
  assert.equal(nameIsTrusted(unsure), false);
  const plan = planUtterance(unsure, POSE);
  assert.ok(plan);
  assert.deepEqual(plan.clips, ["dir_slightly_right", "approx", "m_3"]);
});

test("an unreliable estimate never yields a spoken number", () => {
  // Monocular geometry cannot measure centimetres, and CLAUDE.md forbids
  // announcing a distance the estimate cannot support.
  const plan = planUtterance(track({ metres: 0.3, reliable: false }), POSE);
  assert.ok(plan);
  assert.equal(plan.tone, true);
  assert.ok(plan.clips.includes("very_close"));
  assert.ok(!plan.clips.some((c) => c.startsWith("m_")));
});

test("an overhead hazard leads with the alarm and still warns when unnamed", () => {
  // Above the horizon, large in frame, no ground contact: the branch or the
  // tailgate a cane sweeps straight under.
  const overhead = track({
    y: 0,
    h: 60,
    classConfidence: 0.2,
    metres: Infinity,
    reliable: false,
  });
  const plan = planUtterance(overhead, POSE);
  assert.ok(plan);
  assert.equal(plan.clips[0], "overhead");
  assert.equal(plan.tone, true);
});

test("a track beyond the announceable range produces no sentence at all", () => {
  // Not even the name. A bare "Машин" for a car forty metres away is a
  // narrator reading out a street, and it costs the channel a real hazard
  // needed. Something has to be true of an object beyond its existence.
  assert.equal(planUtterance(track({ metres: 40, reliable: true }), POSE), null);
});

test("a distant object still gets a warning once it starts closing on you", () => {
  // The exception, and the reason the range check is not simply a distance
  // cut-off: past five metres there is no number worth quoting, but "on your
  // right, approaching" is complete and actionable without one.
  const plan = planUtterance(
    atX(0.9, { className: "bicycle", metres: 7, reliable: true, closingMps: 4, ttcS: 2 }),
    POSE,
  );
  assert.ok(plan);
  assert.deepEqual(plan.clips, ["bicycle", "dir_right", "approaching"]);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("the same object does not nag inside its debounce window", () => {
  const gate = new SpeechGate();
  const plan = planUtterance(track({ metres: 3 }), POSE)!;
  assert.equal(gate.allows(plan, 0), true);
  gate.record(plan, 0);
  assert.equal(gate.allows(plan, BUCKET_DEBOUNCE_MS[plan.summary.bucket] - 1), false);
  assert.equal(gate.allows(plan, BUCKET_DEBOUNCE_MS[plan.summary.bucket]), true);
});

test("a row of identical bollards is announced once, not five times", () => {
  // THE COMPLAINT THIS ANSWERS. Five objects, five track ids, five clean
  // per-track debounce slots — and the app says the same sentence five times
  // in fifteen seconds. Each is individually justified; together they are
  // noise, and the user has learned nothing after the first.
  const gate = new SpeechGate();
  let spoken = 0;
  let now = 0;
  for (let id = 1; id <= 5; id++) {
    const plan = planUtterance(track({ id, metres: 3 }), POSE)!;
    // 1.4 m/s past bollards about 1.5 m apart: one every 1.1 seconds.
    now += 1100;
    if (gate.allows(plan, now)) {
      gate.record(plan, now);
      spoken++;
    }
  }
  assert.equal(spoken, 1, "identical sentences from different objects say one thing once");
});

test("a genuinely different object at the same distance is still announced", () => {
  // The other half of the same trade. Content-keying alone was tried and was
  // worse: it silenced a real second object because a first one happened to be
  // the same distance away.
  const gate = new SpeechGate();
  const car = planUtterance(track({ id: 1, className: "car", metres: 3 }), POSE)!;
  assert.equal(gate.allows(car, 0), true);
  gate.record(car, 0);

  const dog = planUtterance(track({ id: 2, className: "dog", metres: 3 }), POSE)!;
  assert.equal(gate.allows(dog, MIN_ANNOUNCE_GAP_MS), true);
});

test("nothing at all is spoken inside the hard gap, however urgent", () => {
  const gate = new SpeechGate();
  const first = planUtterance(track({ id: 1, metres: 3 }), POSE)!;
  gate.record(first, 0);
  const urgent = planUtterance(track({ id: 2, metres: 0.3, reliable: false }), POSE)!;
  assert.equal(urgent.tone, true);
  assert.equal(gate.allows(urgent, MIN_ANNOUNCE_GAP_MS - 1), false);
  assert.equal(gate.allows(urgent, MIN_ANNOUNCE_GAP_MS), true);
});

test("an object getting closer is reported immediately, not after the debounce", () => {
  // The single most important moment in a track's life is when its situation
  // changes, and it can land anywhere inside a twelve-second window. A gate
  // that made the app quiet but also slow would have traded one failure for a
  // worse one.
  const gate = new SpeechGate();
  const far = planUtterance(track({ metres: 4.5 }), POSE)!;
  assert.equal(far.summary.bucket, "mid");
  gate.record(far, 0);

  const near = planUtterance(track({ metres: 2 }), POSE)!;
  assert.equal(near.summary.bucket, "near");
  const soon = MIN_ANNOUNCE_GAP_MS;
  assert.ok(soon < BUCKET_DEBOUNCE_MS.mid, "this test is only meaningful inside the window");
  assert.equal(gate.allows(near, soon), true);
});

test("an object that starts closing on you is news the moment it does", () => {
  const gate = new SpeechGate();
  const still = planUtterance(track({ metres: 3 }), POSE)!;
  gate.record(still, 0);
  const moving = planUtterance(track({ metres: 3, closingMps: 4, ttcS: 1 }), POSE)!;
  assert.equal(moving.summary.approaching, true);
  assert.equal(gate.allows(moving, MIN_ANNOUNCE_GAP_MS), true);
});

test("learning what something is counts as news; forgetting does not", () => {
  const unnamed = summary({ className: "" });
  const named = summary({ className: "bus" });
  assert.equal(isMaterialChange(unnamed, named), true);
  assert.equal(isMaterialChange(named, unnamed), false);
});

test("drifting across a band edge is not news; crossing in front of you is", () => {
  // A hand-held phone drifts a box across a band edge constantly. Treating
  // each crossing as news would undo the entire file.
  assert.equal(
    isMaterialChange(summary({ bearing: "slightly_left" }), summary({ bearing: "ahead" })),
    false,
  );
  assert.equal(
    isMaterialChange(summary({ bearing: "left" }), summary({ bearing: "right" })),
    true,
  );
});

test("moving away is never urgent enough to interrupt", () => {
  const gate = new SpeechGate();
  const near = planUtterance(track({ metres: 2 }), POSE)!;
  gate.record(near, 0);
  const receding = planUtterance(track({ metres: 4.5 }), POSE)!;
  assert.equal(gate.allows(receding, MIN_ANNOUNCE_GAP_MS), false);
});

test("a static scene collapses to near-silence over a minute of walking", () => {
  // The end-to-end version of the complaint: one unchanging object in the
  // corridor, sixty seconds, a detector frame every 90ms. Before the content
  // gate this was a sentence every few seconds forever.
  const gate = new SpeechGate();
  let spoken = 0;
  for (let now = 0; now <= 60_000; now += 90) {
    const plan = planUtterance(track({ metres: 3 }), POSE)!;
    if (gate.allows(plan, now)) {
      gate.record(plan, now);
      spoken++;
    }
  }
  // Bounded by the content gate rather than the per-track debounce, which is
  // the whole point: 60s / CONTENT_REPEAT_MS, plus the first.
  assert.ok(spoken <= 60_000 / CONTENT_REPEAT_MS + 1, `spoke ${spoken} times in a minute`);
  assert.ok(spoken >= 1, "an obstacle in the corridor must still be reported");
});

test("an urgent hazard keeps repeating while the user walks into it", () => {
  // The inverse invariant. Quiet is right for scenery and wrong for a hazard
  // someone is still closing on.
  const gate = new SpeechGate();
  let spoken = 0;
  for (let now = 0; now <= 20_000; now += 90) {
    const plan = planUtterance(track({ metres: 0.3, reliable: false }), POSE)!;
    if (gate.allows(plan, now)) {
      gate.record(plan, now);
      spoken++;
    }
  }
  assert.ok(spoken >= 5, `an imminent hazard should repeat, spoke ${spoken} times in 20s`);
});

// ---------------------------------------------------------------------------
// The all-clear
// ---------------------------------------------------------------------------

test("the app never opens with an all-clear it has not earned", () => {
  // THE DANGEROUS CASE. A model that is failing looks exactly like a model
  // that sees nothing, and "clear ahead" said by a blind detector is the worst
  // sentence this app could utter.
  const watcher = new ClearPathWatcher();
  let said = false;
  for (let now = 0; now <= 60_000; now += 90) {
    if (watcher.update(false, true, now)) said = true;
  }
  assert.equal(said, false, "silence that was always silence must stay silence");
});

test("an all-clear follows a warning, once, after the corridor settles", () => {
  const watcher = new ClearPathWatcher();
  watcher.markAnnounced(0);
  assert.equal(watcher.update(false, true, CLEAR_SETTLE_MS - 1), false);
  assert.equal(watcher.update(false, true, CLEAR_SETTLE_MS), true);
  // Once. It is a report of a change, not a running commentary.
  assert.equal(watcher.update(false, true, CLEAR_SETTLE_MS + 1000), false);
});

test("a blind detector never reports a clear path", () => {
  // Darkness, a camera aimed at the user's shoes, a dead model: every one
  // produces an empty corridor, and every one must produce silence.
  const watcher = new ClearPathWatcher();
  watcher.markAnnounced(0);
  let said = false;
  for (let now = 0; now <= 30_000; now += 90) {
    if (watcher.update(false, false, now)) said = true;
  }
  assert.equal(said, false);
});

test("an all-clear that has gone stale is dropped rather than said late", () => {
  const watcher = new ClearPathWatcher();
  watcher.markAnnounced(0);
  // Unhealthy throughout the window, healthy again long after.
  assert.equal(watcher.update(false, false, CLEAR_MAX_LAG_MS), false);
  assert.equal(watcher.update(false, true, CLEAR_MAX_LAG_MS + 1000), false);
});

test("a hazard reappearing rearms nothing on its own", () => {
  // Only an ANNOUNCED warning arms the all-clear. A hazard that was detected
  // but never spoken about — still confirming, or held behind the gate — has
  // not told the user anything for a subsequent all-clear to update.
  const watcher = new ClearPathWatcher();
  watcher.update(true, true, 0);
  assert.equal(watcher.update(false, true, CLEAR_SETTLE_MS + 1), false);
});

test("a second warning re-earns a second all-clear", () => {
  const watcher = new ClearPathWatcher();
  watcher.markAnnounced(0);
  assert.equal(watcher.update(false, true, CLEAR_SETTLE_MS), true);
  watcher.markAnnounced(10_000);
  assert.equal(watcher.update(false, true, 10_000 + CLEAR_SETTLE_MS), true);
});

test("a long sentence holds the channel until it has finished", () => {
  // playSequence() writes to the AudioContext timeline rather than a queue, so
  // an utterance released early does not wait its turn — it plays ON TOP of
  // the one still running. Two Mongolian sentences at once is not a degraded
  // warning, it is no warning at all.
  const gate = new SpeechGate();
  const plan = planUtterance(track({ metres: 3 }), POSE)!;
  const long = 3300; // "Хүн бага зэрэг зүүн талд ойролцоогоор гурван метр"
  gate.record(plan, 0, long);

  const other = planUtterance(track({ id: 2, className: "dog", metres: 3 }), POSE)!;
  assert.ok(long > MIN_ANNOUNCE_GAP_MS, "this test is only meaningful for a long clip");
  assert.equal(gate.allows(other, MIN_ANNOUNCE_GAP_MS), false, "still speaking");
  assert.equal(gate.allows(other, long), true);
});
