/**
 * The journey state machine, driven end to end.
 *
 * The assertions that matter most are the negative ones: that no transition is
 * silent, that boarding can be undone, that the feed dying is audible, and that
 * the confident wording is unreachable from unverified data.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  RESUME_WINDOW_MS, clearPersisted, createJourney, persist, reduce, restore,
  shouldAnnounceStop, type JourneyEvent, type JourneyPlan, type JourneyState, type Naming,
} from "./journey";
import { JOURNEY } from "@/lib/ui/announcements";
import type { ArrivalClaim, FeedHealth, Vehicle } from "./vehicles";

const T0 = 1_700_000_000_000;

/** Every clip exists, so tests assert on routing rather than on render gaps. */
const naming: Naming = {
  stopKey: (id) => `stop_${id}`,
  routeKey: (id) => `route_${id}`,
  has: () => true,
};

const plan: JourneyPlan = {
  routeId: "11100350", routeDisplayName: "Ч:35", directionId: 0,
  boardingStopId: "000000004", boardingIndex: 2,
  destinationStopId: "000000005", destinationIndex: 10,
  transfer: null,
};

const vehicle: Vehicle = {
  id: 1, plateNumber: "1234 УБА", routeName: "Ч-35",
  speed: 30, bearing: 90, latitude: 47.9186, longitude: 106.9177,
};

const liveFeed: FeedHealth = { state: "live", vehicleCount: 4, movedCount: 2 };
const liveClaim = (over: Partial<Extract<ArrivalClaim, { kind: "live" }>> = {}): ArrivalClaim => ({
  kind: "live", vehicle, distanceM: 900, stopsAway: 3, etaMinutes: 4, freshAt: T0, ...over,
});

/** Runs a sequence and collects every announcement produced. */
function run(events: JourneyEvent[], start?: JourneyState) {
  let state = start ?? createJourney(T0);
  const spoken: string[] = [];
  const phases: string[] = [state.phase];
  for (const event of events) {
    const r = reduce(state, event, naming, T0);
    state = r.state;
    for (const a of r.announcements) spoken.push(a.label ?? "");
    if (phases[phases.length - 1] !== state.phase) phases.push(state.phase);
  }
  return { state, spoken, phases };
}

// ------------------------------------------------------------ happy path

test("the full journey walks the documented phase sequence", () => {
  const { phases } = run([
    { type: "destination-chosen", stopId: "000000005" },
    { type: "plan-found", plan },
    { type: "wait-started" },
    { type: "vehicle-update", claim: liveClaim(), next: null, feed: liveFeed },
    { type: "vehicle-update", claim: liveClaim({ stopsAway: 1, distanceM: 300 }), next: null, feed: liveFeed },
    { type: "vehicle-update", claim: liveClaim({ stopsAway: 0, distanceM: 20 }), next: null, feed: liveFeed },
    { type: "boarding-detected", plate: "1234 УБА" },
    { type: "boarding-confirmed" },
    { type: "stop-passed", index: 7, stopId: "s7", remaining: 3 },
    { type: "arrived-at-destination" },
  ]);

  assert.deepEqual(phases, [
    "IDLE", "DESTINATION_SET", "PLANNED", "WAITING", "APPROACHING",
    "ARRIVED_AT_STOP", "BOARDED", "RIDING", "NEARING_DESTINATION", "ALIGHT",
  ]);
});

test("EVERY phase change produces at least one announcement", () => {
  // A transition nobody can hear did not happen, for this user.
  let state = createJourney(T0);
  const events: JourneyEvent[] = [
    { type: "destination-chosen", stopId: "000000005" },
    { type: "plan-found", plan },
    { type: "vehicle-update", claim: liveClaim({ stopsAway: 1 }), next: null, feed: liveFeed },
    { type: "vehicle-update", claim: liveClaim({ stopsAway: 0, distanceM: 20 }), next: null, feed: liveFeed },
    { type: "boarding-detected", plate: null },
    { type: "stop-passed", index: 7, stopId: "s7", remaining: 3 },
    { type: "arrived-at-destination" },
  ];
  for (const event of events) {
    const before = state.phase;
    const r = reduce(state, event, naming, T0);
    if (r.state.phase !== before) {
      assert.ok(
        r.announcements.length > 0 && r.announcements.some((a) => a.keys.length > 0),
        `silent transition ${before} → ${r.state.phase} on ${event.type}`,
      );
    }
    state = r.state;
  }
});

// ------------------------------------------------------------- the hedge

test("the confident arrival wording is unreachable from unverified data", () => {
  const unverified: ArrivalClaim = { kind: "unverified", reason: "freshness:stale:frozen-coordinates" };
  const r = reduce(
    { ...createJourney(T0), phase: "WAITING", plan },
    { type: "vehicle-update", claim: unverified, next: null, feed: liveFeed },
    naming, T0,
  );
  assert.equal(r.state.phase, "WAITING", "advanced on unverified evidence");
  assert.deepEqual(r.announcements, []);
});

test("expired freshness cannot produce the arrival wording either", () => {
  const stale = liveClaim({ distanceM: 10, stopsAway: 0, freshAt: T0 - 10 * 60_000 });
  const r = reduce(
    { ...createJourney(T0), phase: "WAITING", plan },
    { type: "vehicle-update", claim: stale, next: null, feed: liveFeed },
    naming, T0,
  );
  assert.notEqual(r.state.phase, "ARRIVED_AT_STOP");
  const labels = r.announcements.map((a) => a.label ?? "").join(" ");
  assert.ok(!labels.includes("ARRIVED"), `announced arrival on expired evidence: ${labels}`);
});

test("a live claim within 50 m DOES produce the arrival wording", () => {
  const r = reduce(
    { ...createJourney(T0), phase: "WAITING", plan },
    { type: "vehicle-update", claim: liveClaim({ distanceM: 20, stopsAway: 0 }), next: null, feed: liveFeed },
    naming, T0,
  );
  assert.equal(r.state.phase, "ARRIVED_AT_STOP");
  assert.ok(r.announcements[0].keys.includes(JOURNEY.arrived.clip!));
  assert.equal(r.announcements[0].priority, "critical");
});

// ------------------------------------------------------- degrade loudly

test("the feed dying mid-journey is ANNOUNCED, not absorbed", () => {
  const waiting: JourneyState = { ...createJourney(T0), phase: "WAITING", plan };
  for (const feed of [
    { state: "error", reason: "timeout" },
    { state: "empty", vehicleCount: 0 },
    { state: "suspect", vehicleCount: 9, reason: "nothing-moved" },
  ] as FeedHealth[]) {
    const r = reduce(waiting, { type: "vehicle-update", claim: { kind: "no-vehicle" }, next: null, feed }, naming, T0);
    assert.ok(
      r.announcements.some((a) => a.keys.includes(JOURNEY.liveLost.clip!)),
      `feed ${feed.state} degraded silently`,
    );
  }
});

test("the feed loss is announced once, not on every poll", () => {
  let state: JourneyState = { ...createJourney(T0), phase: "WAITING", plan };
  const dead: FeedHealth = { state: "error", reason: "timeout" };
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const r = reduce(state, { type: "vehicle-update", claim: { kind: "no-vehicle" }, next: null, feed: dead }, naming, T0);
    state = r.state;
    total += r.announcements.length;
  }
  assert.equal(total, 1);
});

test("a recovered feed re-arms the loss announcement", () => {
  let state: JourneyState = { ...createJourney(T0), phase: "WAITING", plan };
  const dead: FeedHealth = { state: "error", reason: "timeout" };
  state = reduce(state, { type: "vehicle-update", claim: { kind: "no-vehicle" }, next: null, feed: dead }, naming, T0).state;
  assert.equal(state.liveLostAnnounced, true);

  state = reduce(state, { type: "vehicle-update", claim: liveClaim(), next: null, feed: liveFeed }, naming, T0).state;
  assert.equal(state.liveLostAnnounced, false);

  const again = reduce(state, { type: "vehicle-update", claim: { kind: "no-vehicle" }, next: null, feed: dead }, naming, T0);
  assert.equal(again.announcements.length, 1, "a second outage went unannounced");
});

// ----------------------------------------------------------- boarding

test("boarding is reversible, and the reversal is announced", () => {
  let state: JourneyState = { ...createJourney(T0), phase: "WAITING", plan };
  state = reduce(state, { type: "boarding-detected", plate: "1234 УБА" }, naming, T0).state;
  assert.equal(state.phase, "BOARDED");
  assert.equal(state.boardingReversible, true);

  const undo = reduce(state, { type: "boarding-rejected" }, naming, T0);
  assert.equal(undo.state.phase, "WAITING");
  assert.equal(undo.state.boardedVehiclePlate, null);
  assert.ok(undo.announcements.some((a) => a.keys.includes(JOURNEY.boardedUndone.clip!)));
});

test("boarding detection always offers the undo hint", () => {
  const r = reduce({ ...createJourney(T0), phase: "WAITING", plan }, { type: "boarding-detected", plate: null }, naming, T0);
  assert.ok(r.announcements[0].keys.includes(JOURNEY.boardedUndoHint.clip!));
});

test("once a stop is counted the undo is withdrawn — the bus is plainly moving", () => {
  let state: JourneyState = { ...createJourney(T0), phase: "WAITING", plan };
  state = reduce(state, { type: "boarding-detected", plate: null }, naming, T0).state;
  state = reduce(state, { type: "stop-passed", index: 3, stopId: "s3", remaining: 7 }, naming, T0).state;
  assert.equal(state.boardingReversible, false);
  assert.equal(reduce(state, { type: "boarding-rejected" }, naming, T0).state.phase, "RIDING");
});

// ------------------------------------------------------------- riding

test("announce every stop within the last five, every third before that", () => {
  assert.deepEqual(
    [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(shouldAnnounceStop),
    [true, false, false, true, false, false, true, true, true, true, true, true],
  );
});

test("GPS jitter cannot repeat a stop announcement", () => {
  const state: JourneyState = { ...createJourney(T0), phase: "RIDING", plan };
  const a = reduce(state, { type: "stop-passed", index: 7, stopId: "s7", remaining: 3 }, naming, T0);
  const b = reduce(a.state, { type: "stop-passed", index: 7, stopId: "s7", remaining: 3 }, naming, T0);
  assert.equal(a.announcements[0].dedupeKey, b.announcements[0].dedupeKey);
});

test("the last three stops are spoken, and the last is critical", () => {
  const state: JourneyState = { ...createJourney(T0), phase: "RIDING", plan };
  const one = reduce(state, { type: "stop-passed", index: 9, stopId: "s9", remaining: 1 }, naming, T0);
  assert.equal(one.announcements[0].priority, "critical");
  assert.equal(one.state.phase, "NEARING_DESTINATION");
});

// ---------------------------------------------------------- persistence

test("a backgrounded journey resumes", () => {
  const storage = memoryStorage();
  const state: JourneyState = { ...createJourney(T0), phase: "RIDING", plan, currentIndex: 5, updatedAt: T0 };
  persist(state, storage);
  const restored = restore(storage, T0 + 60_000);
  assert.equal(restored?.phase, "RIDING");
  assert.equal(restored?.currentIndex, 5);
});

test("a journey older than the resume window is NOT resumed", () => {
  const storage = memoryStorage();
  persist({ ...createJourney(T0), phase: "RIDING", plan, updatedAt: T0 }, storage);
  assert.equal(restore(storage, T0 + RESUME_WINDOW_MS + 1), null);
});

test("an IDLE journey is cleared rather than stored", () => {
  const storage = memoryStorage();
  persist({ ...createJourney(T0), phase: "RIDING", plan }, storage);
  persist(createJourney(T0), storage);
  assert.equal(restore(storage, T0), null);
});

test("corrupt or wrong-schema storage restores nothing rather than crashing", () => {
  const storage = memoryStorage();
  storage.setItem("vision-access:journey", "{not json");
  assert.equal(restore(storage, T0), null);
  storage.setItem("vision-access:journey", JSON.stringify({ schema: 99, state: { phase: "RIDING" } }));
  assert.equal(restore(storage, T0), null);
});

test("clearPersisted survives a storage that throws", () => {
  const hostile = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); },
    removeItem: () => { throw new Error("x"); } } as unknown as Storage;
  assert.doesNotThrow(() => clearPersisted(hostile));
  assert.doesNotThrow(() => persist(createJourney(T0), hostile));
  assert.equal(restore(hostile, T0), null);
});

// ------------------------------------------------------------- transfers

test("a transfer is announced at planning time, before boarding", () => {
  const withTransfer: JourneyPlan = {
    ...plan,
    transfer: { atStopId: "000000009", toRouteId: "11100390", toRouteDisplayName: "Ч:39" },
  };
  // A plan cannot exist before a destination does, so go through the phase.
  const chosen = reduce(createJourney(T0), { type: "destination-chosen", stopId: "000000005" }, naming, T0).state;
  const r = reduce(chosen, { type: "plan-found", plan: withTransfer }, naming, T0);
  assert.ok(r.announcements.some((a) => a.keys.includes(JOURNEY.transferWarning.clip!)));
  assert.equal(r.state.phase, "PLANNED", "the transfer must be known before WAITING");
});

test("PLANNED is unreachable without a destination", () => {
  const r = reduce(createJourney(T0), { type: "plan-found", plan }, naming, T0);
  assert.equal(r.state.phase, "IDLE");
});

// --------------------------------------------------------- illegal moves

test("an illegal transition is refused, not crashed on", () => {
  const idle = createJourney(T0);
  // You cannot alight from IDLE.
  const r = reduce(idle, { type: "arrived-at-destination" }, naming, T0);
  assert.equal(r.state.phase, "IDLE");
});

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}
