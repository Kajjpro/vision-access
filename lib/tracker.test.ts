/**
 * The two things the tracker now guarantees the speech path depends on.
 *
 *   npx tsx --test lib/tracker.test.ts
 *
 * Both exist because of a user report: objects being named wrongly, and
 * distances that changed every time they were spoken.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Tracker } from "./tracker";
import type { TrackedBox } from "./tracker";

/** A box in the same place every frame, so association always matches. */
function box(metres: number, over: Partial<TrackedBox> = {}): TrackedBox {
  return {
    className: "person",
    // Comfortably above every NAME_MIN_SCORE, so a test that is about tracking
    // is never accidentally also a test about the confidence gate.
    score: 0.9,
    x: 100,
    y: 100,
    w: 50,
    h: 120,
    metres,
    reliable: true,
    ...over,
  };
}

test("hits count the frames an object was actually seen in", () => {
  const tracker = new Tracker();
  let t = 0;
  let seen = 0;
  for (let frame = 0; frame < 4; frame++) {
    const [track] = tracker.update([box(3)], (t += 100));
    seen = track.hits;
  }
  assert.equal(seen, 4, "four frames of the same object should be four hits");
});

test("a one-frame ghost never reaches the confirmation threshold", () => {
  // WalkMode requires CONFIRM_HITS (3) before speaking. This is the flicker
  // that used to get announced: a confident detection on a single frame.
  const tracker = new Tracker();
  const [ghost] = tracker.update([box(3, { className: "dog" })], 100);
  assert.equal(ghost.hits, 1);
  assert.ok(ghost.hits < 3, "a single sighting must not be announceable");

  // And it is gone rather than coasting once it stops being seen.
  const next = tracker.update([], 1200);
  assert.equal(next.length, 0, "an unseen track must not survive as a memory");
});

test("a wild distance outlier does not reach the spoken distance", () => {
  const tracker = new Tracker();
  let t = 0;
  // A stationary object at 3 m, with one frame where the box bottom jumped.
  const readings = [3.0, 3.1, 9.0, 2.9, 3.0];
  let last = 0;
  for (const m of readings) {
    const [track] = tracker.update([box(m)], (t += 100));
    last = track.metres;
  }
  assert.ok(
    Math.abs(last - 3.0) < 0.3,
    `median should reject the 9 m outlier, got ${last}`,
  );
});

test("smoothing lags a closing object by well under the error budget", () => {
  // The risk of a median is that it reports the MIDDLE of its window, so on an
  // approach it always reads further away than the truth — the one direction
  // this app must not err in. At walking pace (1.4 m/s, ~0.14 m per frame at
  // 10fps) that lag has to stay small next to the ~18.5% the ground-plane
  // model already carries.
  const tracker = new Tracker();
  let t = 0;
  let track!: ReturnType<Tracker["update"]>[number];
  let truth = 0;
  for (let m = 5.0; m > 1.9; m -= 0.14) {
    truth = m;
    [track] = tracker.update([box(Number(m.toFixed(3)))], (t += 100));
  }
  const lag = track.metres - truth;
  assert.ok(lag >= 0, "median should never read closer than truth on an approach");
  assert.ok(lag < 0.2, `lag must stay under 20 cm, got ${(lag * 100).toFixed(0)} cm`);
  assert.ok(
    track.closingMps !== null && track.closingMps > 1,
    `closing speed must survive smoothing, got ${track.closingMps}`,
  );
});

// ---------------------------------------------------------------------------
// Class identity
//
// Detection now decides WHAT an object is by vote across a window, not by
// whatever the newest frame said. These tests cover both directions of that:
// a settled track must not be renamed by one stray frame, and a genuine
// disagreement must be reported as one rather than resolved by guessing.
// ---------------------------------------------------------------------------

test("one stray label does not rename a settled track", () => {
  const tracker = new Tracker();
  let t = 0;
  let track!: ReturnType<Tracker["update"]>[number];

  // Four confident frames of car, then a single frame the detector calls a
  // truck — ordinary behaviour at range, and not a reason to change the noun.
  for (const name of ["car", "car", "car", "car", "truck"]) {
    [track] = tracker.update([box(4, { className: name, score: 0.8 })], (t += 100));
  }

  assert.equal(track.className, "car");
  assert.ok(track.classConfidence > 0.6, `confidence ${track.classConfidence}`);
});

test("a genuine coin flip is reported as one, not resolved", () => {
  const tracker = new Tracker();
  let t = 0;
  let track!: ReturnType<Tracker["update"]>[number];

  for (const name of ["car", "truck", "car", "truck", "car", "truck"]) {
    [track] = tracker.update([box(4, { className: name, score: 0.5 })], (t += 100));
  }

  // Whichever way it lands, the caller must be able to see it is not sure.
  // WalkMode's MIN_CLASS_CONFIDENCE is 0.6, so this withholds the name and
  // speaks the distance alone.
  assert.ok(
    track.classConfidence < 0.6,
    `an even split must not read as confident, got ${track.classConfidence}`,
  );
});

test("a confident detection outweighs two weak ones", () => {
  const tracker = new Tracker();
  let t = 0;
  let track!: ReturnType<Tracker["update"]>[number];

  // Plain majority would call this a truck. Weighted by score it is a car,
  // which is what the evidence actually says.
  [track] = tracker.update([box(4, { className: "car", score: 0.92 })], (t += 100));
  [track] = tracker.update([box(4, { className: "truck", score: 0.31 })], (t += 100));
  [track] = tracker.update([box(4, { className: "truck", score: 0.33 })], (t += 100));

  assert.equal(track.className, "car");
});

test("the reported score belongs to the winning class alone", () => {
  const tracker = new Tracker();
  let t = 0;
  let track!: ReturnType<Tracker["update"]>[number];

  for (const [name, score] of [["car", 0.9], ["car", 0.8], ["truck", 0.1]] as const) {
    [track] = tracker.update([box(4, { className: name, score })], (t += 100));
  }

  // Mean of the two car frames — 0.85. Averaging the truck frame in would
  // report a confidence that belongs to no class at all.
  assert.ok(Math.abs(track.score - 0.85) < 1e-6, `got ${track.score}`);
});

/**
 * The regression that made this change necessary.
 *
 * Association used to refuse to cross class boundaries, so a car the detector
 * alternately called a truck produced two tracks that took turns existing.
 * Neither ever reached CONFIRM_HITS (3), so WalkMode never spoke — a car three
 * metres away, silently. Refusing to associate looked cautious and converted an
 * uncertain NAME into a missing WARNING, which is the wrong way round.
 */
test("a flickering label still accumulates one track's worth of evidence", () => {
  const tracker = new Tracker();
  let t = 0;
  let tracks: ReturnType<Tracker["update"]> = [];

  for (const name of ["car", "truck", "car", "truck", "car"]) {
    tracks = tracker.update([box(3, { className: name, score: 0.6 })], (t += 100));
  }

  assert.equal(tracks.length, 1, "one object must not become two tracks");
  assert.ok(tracks[0].hits >= 3, `hits must clear CONFIRM_HITS, got ${tracks[0].hits}`);
});

/**
 * The failure the high cross-class bar exists to prevent. A pedestrian standing
 * in front of a parked car is two obstacles at two distances, and merging them
 * would hide one of them completely.
 */
test("two different objects that merely overlap stay two tracks", () => {
  const tracker = new Tracker();
  let t = 0;
  let tracks: ReturnType<Tracker["update"]> = [];

  for (let frame = 0; frame < 4; frame++) {
    tracks = tracker.update(
      [
        box(8, { className: "car", x: 100, y: 100, w: 300, h: 200, score: 0.85 }),
        // Inside the car's box, far smaller — a person in front of it.
        box(3, { className: "person", x: 150, y: 180, w: 60, h: 140, score: 0.85 }),
      ],
      (t += 100),
    );
  }

  assert.equal(tracks.length, 2);
  assert.deepEqual(
    tracks.map((tr) => tr.className).sort(),
    ["car", "person"],
    "neither object may absorb the other",
  );
});

test("votes age out, so an object that genuinely changes label follows", () => {
  const tracker = new Tracker();
  let t = 0;
  let track!: ReturnType<Tracker["update"]>[number];

  for (let frame = 0; frame < 5; frame++) {
    [track] = tracker.update([box(4, { className: "car", score: 0.8 })], (t += 100));
  }
  assert.equal(track.className, "car");

  // VOTE_WINDOW_MS is 1200; MAX_AGE_MS is 900, so the track has to keep being
  // seen. Ten frames of truck at 100ms leaves no car vote inside the window.
  for (let frame = 0; frame < 14; frame++) {
    [track] = tracker.update([box(4, { className: "truck", score: 0.8 })], (t += 100));
  }
  assert.equal(track.className, "truck");
  assert.ok(track.classConfidence > 0.9, `stale votes must not linger: ${track.classConfidence}`);
});

test("a brand new track is not treated as confirmed despite a unanimous vote", () => {
  const tracker = new Tracker();
  const [track] = tracker.update([box(4, { className: "car", score: 0.9 })], 0);
  // One frame agreeing with itself is unanimous and means nothing; `hits` is
  // what callers gate on, and it is the honest signal here.
  assert.equal(track.classConfidence, 1);
  assert.equal(track.hits, 1);
});
