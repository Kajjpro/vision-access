/**
 * The recorder must be invisible to the journey it records.
 *
 * A diagnostic that can delay an announcement corrupts the measurements it
 * exists to take, and could cost a rider their stop. These tests pin the two
 * properties that make it safe to leave in the ride path: it never throws, and
 * it persists as it goes rather than at the end.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  clearRecording, createRecorder, describeRecording, FLUSH_INTERVAL_MS,
  loadRecording, loadResumable, MAX_FIXES, nullRecorder, recordingFilename, STORAGE_KEY,
  type RecorderStorage,
} from "./recorder";

function mem(fail = false): RecorderStorage & { writes: number; last: string | null } {
  const m = new Map<string, string>();
  return {
    writes: 0, last: null,
    getItem: (k) => m.get(k) ?? null,
    setItem(k, v) {
      if (fail) throw new Error("QuotaExceededError");
      m.set(k, v); this.writes++; this.last = v;
    },
    removeItem: (k) => { m.delete(k); },
  };
}

test("the null recorder swallows every call — a forgotten guard cannot write", () => {
  const r = nullRecorder();
  assert.equal(r.active, false);
  r.fix({ lat: 1, lon: 2, accuracy: 10, timestamp: 1 });
  r.engine("advanced"); r.say(2, ["a"], "l"); r.earcon("soft"); r.haptic([1]);
  r.missing(["x"]); r.note("n"); r.battery(0.5, false); r.flush();
  assert.equal(r.snapshot().trace.length, 0);
});

test("storage that always throws never reaches the caller", () => {
  // Out of quota mid-journey must degrade the recording, not end the ride.
  const r = createRecorder(mem(true), { now: () => 0 });
  assert.doesNotThrow(() => {
    r.setRoute({ routeId: "1", directionId: 0, boardingIndex: 0, destinationIndex: 5 });
    for (let i = 0; i < 50; i++) r.fix({ lat: 1, lon: 2, accuracy: 10, timestamp: i });
    r.flush();
    r.stop();
  });
});

test("fixes persist incrementally, not once at the end", () => {
  let clock = 0;
  const store = mem();
  const r = createRecorder(store, { now: () => clock });
  const before = store.writes;
  for (let i = 0; i < 10; i++) {
    clock += FLUSH_INTERVAL_MS + 1;
    r.fix({ lat: 1, lon: 2, accuracy: 10, timestamp: clock });
  }
  assert.ok(store.writes - before >= 10, `expected a write per interval, got ${store.writes - before}`);
});

test("the trace is written in gps-sim's fix shape, so it replays unconverted", () => {
  const store = mem();
  const r = createRecorder(store, { now: () => 0 });
  r.fix({ lat: 47.9, lon: 106.9, accuracy: 12, timestamp: 1700 });
  r.flush();
  const back = loadRecording(store)!;
  assert.deepEqual(back.trace[0], { lat: 47.9, lon: 106.9, accuracy: 12, timestamp: 1700 });
  assert.ok(!("accuracyM" in back.trace[0]), "accuracyM is the engine's name, not the trace format's");
});

test("an over-long ride drops the OLDEST fixes, never the whole recording", () => {
  // Growing until setItem throws would lose the journey at the moment it got
  // interesting. The recent end is the part worth keeping.
  let clock = 0;
  const r = createRecorder(mem(), { now: () => clock });
  for (let i = 0; i < MAX_FIXES + 100; i++) { clock += 1000; r.fix({ lat: 1, lon: 2, accuracy: 10, timestamp: i }); }
  const snap = r.snapshot();
  assert.equal(snap.trace.length, MAX_FIXES);
  assert.equal(snap.trace[snap.trace.length - 1].timestamp, MAX_FIXES + 99, "kept the wrong end");
});

test("clips played are attached to the announcement they belong to", () => {
  // Asked-for and played diverge whenever a stop name is unrendered, and that
  // divergence is one of the things a real journey is recorded to measure.
  const r = createRecorder(mem(), { now: () => 0 });
  r.say(2, ["num_2", "bus_stops_remaining"], "2 left");
  r.clips(["bus_stops_remaining"]);
  const said = r.snapshot().events.find((e) => e.kind === "say");
  assert.deepEqual(said && "clips" in said ? said.clips : null, ["bus_stops_remaining"]);
});

test("a recording round-trips through storage, and clears", () => {
  const store = mem();
  const r = createRecorder(store, { now: () => 0 });
  r.setRoute({ routeId: "11100730", directionId: 0, boardingIndex: 2, destinationIndex: 9 });
  r.fix({ lat: 1, lon: 2, accuracy: 10, timestamp: 5 });
  r.stop();
  const back = loadRecording(store)!;
  assert.equal(back.route?.routeId, "11100730");
  assert.match(recordingFilename(back), /^va-trace-\d{8}-\d{4}-11100730-dir0\.json$/);
  assert.match(describeRecording(back), /1 fixes/);
  clearRecording(store);
  assert.equal(store.getItem(STORAGE_KEY), null);
});

test("a corrupt or foreign payload reads back as nothing, never as a partial trace", () => {
  const store = mem();
  store.setItem(STORAGE_KEY, "{not json");
  assert.equal(loadRecording(store), null);
  store.setItem(STORAGE_KEY, JSON.stringify({ version: 99, trace: [] }));
  assert.equal(loadRecording(store), null);
});

// ------------------------------------------- surviving a remount mid-journey

const ROUTE = { routeId: "11100730", directionId: 0, boardingIndex: 0, destinationIndex: 20 };

test("a remount RESUMES the recording instead of overwriting it", () => {
  /**
   * This is the failure that would have cost a whole field test. A phone locks
   * for forty minutes, the PWA is backgrounded, the browser reclaims memory —
   * and the ride screen remounts. Starting a fresh recorder meant its first
   * flush replaced the stored journey with an empty one, so the file coming off
   * the device would be the last few seconds with nothing to say it had ever
   * been longer.
   */
  const store = mem();
  let clock = 1_000;

  const first = createRecorder(store, { now: () => clock });
  first.setRoute(ROUTE);
  for (let i = 0; i < 100; i++) { clock += 1000; first.fix({ lat: 1, lon: 2, accuracy: 10, timestamp: clock }); }
  first.flush();
  const beforeRemount = loadRecording(store)!.trace.length;
  assert.equal(beforeRemount, 100);

  // --- the screen remounts here; the Recorder instance is gone ---
  const prior = loadResumable(store, ROUTE.routeId, ROUTE.directionId);
  assert.ok(prior, "the stored recording was not offered for resume");

  const second = createRecorder(store, { now: () => clock, resume: prior });
  second.setRoute(ROUTE);
  for (let i = 0; i < 50; i++) { clock += 1000; second.fix({ lat: 3, lon: 4, accuracy: 10, timestamp: clock }); }
  second.flush();

  const after = loadRecording(store)!;
  assert.equal(after.trace.length, 150, "the pre-remount fixes were lost");
  assert.equal(after.trace[0].lat, 1, "the recording restarted rather than continued");
  assert.ok(
    after.events.some((e) => e.kind === "note" && e.text.includes("RESUMED")),
    "the seam was not marked — an unlabelled gap reads as a GPS dropout",
  );
});

test("a DIFFERENT journey does not append to the previous one", () => {
  // Appending a return leg to an outbound trace produces a fixture whose fixes
  // walk backwards halfway through — indistinguishable from the wrong-direction
  // case the trace exists to help tune.
  const store = mem();
  const first = createRecorder(store, { now: () => 1 });
  first.setRoute(ROUTE);
  first.fix({ lat: 1, lon: 2, accuracy: 10, timestamp: 1 });
  first.flush();

  assert.equal(loadResumable(store, ROUTE.routeId, 1), null, "resumed across a direction change");
  assert.equal(loadResumable(store, "99999999", 0), null, "resumed across a route change");
});

test("a recording with no route yet is not resumable", () => {
  // Nothing to match on, so continuing it could silently splice two journeys.
  const store = mem();
  const r = createRecorder(store, { now: () => 1 });
  r.fix({ lat: 1, lon: 2, accuracy: 10, timestamp: 1 });
  r.flush();
  assert.equal(loadResumable(store, ROUTE.routeId, 0), null);
});

// ------------------------------------------ separating the two kinds of stall

test("heartbeats make a page stall distinguishable from a geolocation stall", () => {
  /**
   * A hole in the trace alone is ambiguous, and the two causes need different
   * fixes: geolocation stopped delivering while the page ran, or the whole page
   * was suspended in a locked pocket. The heartbeat runs on its own timer, so
   * whether IT continued is the discriminator.
   */
  const store = mem();
  let clock = 0;
  const r = createRecorder(store, { now: () => clock });

  // Alive and receiving: heartbeats advance and so does the fix count.
  for (let i = 0; i < 3; i++) {
    clock += 5000;
    r.fix({ lat: 1, lon: 2, accuracy: 10, timestamp: clock });
    r.heartbeat(true, "running");
  }
  // GEOLOCATION stall: the page keeps beating, no fixes arrive.
  for (let i = 0; i < 3; i++) { clock += 5000; r.heartbeat(true, "running"); }
  // PAGE stall: no beats at all for a minute, then it comes back.
  clock += 60_000;
  r.heartbeat(false, "suspended");

  const beats = r.snapshot().events.filter((e) => e.kind === "heartbeat") as
    Extract<ReturnType<typeof r.snapshot>["events"][number], { kind: "heartbeat" }>[];

  assert.equal(beats.length, 7);
  // During the geolocation stall the fix count is static across beats.
  assert.equal(beats[3].fixes, beats[5].fixes, "fix count moved during a geolocation stall");
  // The page stall shows up as a gap between consecutive beat timestamps.
  const gap = beats[6].t - beats[5].t;
  assert.ok(gap > 12_000, `a page stall must leave a heartbeat gap, got ${gap}ms`);
  assert.equal(beats[6].visible, false, "the beat did not record that the page was hidden");
});

test("lifecycle events are written immediately, not at the next interval", () => {
  // These are exactly the moments the page may never come back from, so
  // waiting for the flush interval could lose the one line that explains the
  // hole in the trace.
  const store = mem();
  const r = createRecorder(store, { now: () => 0 });
  const before = store.writes;
  r.lifecycle("pagehide", "UNLOADED");
  assert.ok(store.writes > before, "a lifecycle event did not force a write");
  const back = loadRecording(store)!;
  assert.ok(
    back.events.some((e) => e.kind === "lifecycle" && e.event === "pagehide"),
    "the lifecycle event never reached storage",
  );
});
