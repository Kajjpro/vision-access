/**
 * GPS acquisition, replayed deterministically.
 *
 * The scenarios are the ones that actually happen on a phone at a bus stop: a
 * cold start that begins with a cell-tower estimate and converges, a fix that
 * degrades mid-acquisition, a denied permission, and a phone that never gets a
 * lock at all.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { locate, type GeolocationLike, type LocateEvent } from "./locate";

/** Emits a scripted sequence of fixes/errors on a timeline. */
function fakeGeolocation(
  script: { afterMs: number; accuracy?: number; errorCode?: number }[],
): GeolocationLike & { cleared: boolean } {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const api = {
    cleared: false,
    watchPosition(success: PositionCallback, error?: PositionErrorCallback | null) {
      for (const step of script) {
        timers.push(setTimeout(() => {
          if (step.errorCode !== undefined) {
            error?.({ code: step.errorCode, message: "", PERMISSION_DENIED: 1,
              POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
          } else {
            success({
              coords: { latitude: 47.9186, longitude: 106.9177, accuracy: step.accuracy!,
                altitude: null, altitudeAccuracy: null, heading: null, speed: null,
                toJSON: () => ({}) },
              timestamp: Date.now(), toJSON: () => ({}),
            } as GeolocationPosition);
          }
        }, step.afterMs));
      }
      return 1;
    },
    clearWatch() { api.cleared = true; for (const t of timers) clearTimeout(t); },
  };
  return api;
}

const opts = { goodEnoughM: 30, improveDeadlineMs: 300, hardDeadlineMs: 600, progressIntervalMs: 100 };

test("a cold start that converges returns the GOOD fix, not the first one", async () => {
  // What a real phone does: cell tower, then Wi-Fi, then GPS.
  const geolocation = fakeGeolocation([
    { afterMs: 10, accuracy: 1200 },
    { afterMs: 60, accuracy: 180 },
    { afterMs: 120, accuracy: 18 },
  ]);
  const outcome = await locate({ geolocation, ...opts });
  assert.equal(outcome.kind, "fix");
  assert.equal(outcome.kind === "fix" && outcome.converged, true);
  assert.equal(outcome.kind === "fix" && outcome.fix.accuracyM, 18);
});

test("the watch is cleared once a fix is accepted — GPS is expensive", async () => {
  const geolocation = fakeGeolocation([{ afterMs: 10, accuracy: 12 }]);
  await locate({ geolocation, ...opts });
  assert.equal(geolocation.cleared, true);
});

test("the BEST fix wins, not the most recent", async () => {
  // Accuracy is not monotonic: a phone can fall back to Wi-Fi mid-acquisition.
  const geolocation = fakeGeolocation([
    { afterMs: 10, accuracy: 90 },
    { afterMs: 60, accuracy: 45 },
    { afterMs: 110, accuracy: 400 },
  ]);
  const outcome = await locate({ geolocation, ...opts });
  assert.equal(outcome.kind, "fix");
  assert.equal(outcome.kind === "fix" && outcome.fix.accuracyM, 45, "kept the degraded newer fix");
});

test("a usable-but-not-great fix is returned at the improve deadline", async () => {
  const geolocation = fakeGeolocation([{ afterMs: 10, accuracy: 120 }]);
  const outcome = await locate({ geolocation, ...opts });
  assert.equal(outcome.kind, "fix");
  assert.equal(outcome.kind === "fix" && outcome.converged, false);
  assert.equal(outcome.kind === "fix" && outcome.fix.accuracyM, 120);
});

test("a hopeless fix is reported as POOR, distinct from no fix at all", async () => {
  // A desktop browser geolocating by IP. The user needs a different message
  // from "no stop nearby" — this one is about signal, not about stops.
  const geolocation = fakeGeolocation([{ afterMs: 10, accuracy: 25000 }]);
  const outcome = await locate({ geolocation, ...opts, usableM: 500 });
  assert.equal(outcome.kind, "poor");
  assert.equal(outcome.kind === "poor" && outcome.best.accuracyM, 25000);
});

test("permission denied resolves immediately and terminally", async () => {
  const started = Date.now();
  const geolocation = fakeGeolocation([{ afterMs: 10, errorCode: 1 }]);
  const outcome = await locate({ geolocation, ...opts });
  assert.equal(outcome.kind, "denied");
  assert.ok(Date.now() - started < 250, "waited out the deadline on a terminal error");
});

test("a transient POSITION_UNAVAILABLE does not end the attempt", async () => {
  // The browser's own timeout is not the end of the story — a later fix often
  // still arrives, and giving up on the first error loses it.
  const geolocation = fakeGeolocation([
    { afterMs: 10, errorCode: 2 },
    { afterMs: 80, accuracy: 20 },
  ]);
  const outcome = await locate({ geolocation, ...opts });
  assert.equal(outcome.kind, "fix");
  assert.equal(outcome.kind === "fix" && outcome.fix.accuracyM, 20);
});

test("a phone that never gets a lock times out rather than hanging", async () => {
  const outcome = await locate({ geolocation: fakeGeolocation([]), ...opts });
  assert.equal(outcome.kind, "timeout");
});

test("no geolocation API resolves rather than hanging", async () => {
  assert.equal((await locate({ geolocation: null, ...opts })).kind, "unavailable");
});

test("progress is emitted so the wait is never silent", async () => {
  const events: LocateEvent[] = [];
  const geolocation = fakeGeolocation([{ afterMs: 250, accuracy: 15 }]);
  await locate({ geolocation, ...opts, onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.type === "progress"), "the user got no sign we were still working");
});

test("every path settles exactly once", async () => {
  // A promise that never settles leaves the screen silent, which reads to the
  // user as "nothing to report" — the failure that strands someone.
  for (const script of [
    [{ afterMs: 10, accuracy: 5 }],
    [{ afterMs: 10, errorCode: 1 }],
    [{ afterMs: 10, errorCode: 2 }, { afterMs: 40, accuracy: 900 }],
    [],
  ]) {
    const outcome = await locate({ geolocation: fakeGeolocation(script), ...opts });
    assert.ok(["fix", "poor", "denied", "timeout", "unavailable"].includes(outcome.kind));
  }
});
