/**
 * The state machine, tested for the properties that keep a rider safe rather
 * than for the transitions being wired up.
 *
 * The one that matters most is the boarding gate. Everything the ride half of
 * the app says — every stop count, every "get off now" — is derived from the
 * assumption that the rider is on the vehicle it thinks they are on. There is
 * no feed that can check that. So the gate is the only thing standing between a
 * confident countdown and a rider being talked off a bus they never got on.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { APPROACHING_STOPS, AT_STOP_M, nextStates, transition } from "./machine";
import type { JourneyEvent } from "./machine";
import { createJourney } from "./types";
import type { Journey, JourneyRoute, JourneyState } from "./types";
import type { Stop } from "../transit/types";

const T0 = 1_700_000_000_000;

const stop = (id: string, name: string): Stop => ({ id, name, lat: 47.918, lon: 106.917 });

const ROUTE: JourneyRoute = {
  routeId: "11100350",
  directionId: 0,
  displayName: "Ч:35",
  headsign: "Сансар",
  boardingIndex: 2,
  destinationIndex: 10,
};

/** Drives a journey through a list of events, asserting each one applied. */
function run(journey: Journey, events: JourneyEvent[], now = T0): Journey {
  let j = journey;
  for (const e of events) {
    const result = transition(j, e, now);
    assert.ok(result.applied, `${e.type} was rejected in ${j.state}: ${result.rejected}`);
    j = result.journey;
  }
  return j;
}

/** A journey parked at the moment the bus is due and the rider is at the stop. */
function atTheStop(): Journey {
  return run(createJourney(T0), [
    { type: "destination_requested" },
    { type: "destination_confirmed", destination: stop("000000010", "Сансар") },
    { type: "route_chosen", route: ROUTE, origin: stop("000000002", "Их дэлгүүр"), busDueAt: T0 + 180_000 , busDueSource: "timetable"},
    { type: "guidance_started", distanceToStopM: 0 },
    { type: "bus_due" },
  ]);
}

test("a journey cannot reach the bus without the rider saying they are on it", () => {
  // THE GATE. Not a convenience — the app has no vehicle feed and therefore no
  // way to observe boarding, so inferring it would mean counting stops for
  // someone standing on the pavement.
  const waiting = atTheStop();

  for (const sneaky of ["position_updated", "exit_answered"] as const) {
    const event: JourneyEvent =
      sneaky === "position_updated"
        ? { type: "position_updated", remainingStops: 5, etaSeconds: 600 }
        : { type: "exit_answered", exited: true };
    const result = transition(waiting, event, T0);
    assert.equal(result.applied, false, `${sneaky} moved a waiting journey`);
    assert.equal(result.journey.state, "bus_due");
  }

  const asked = run(waiting, [{ type: "boarding_question_raised", reason: "due" }]);
  const boarded = run(asked, [{ type: "boarding_answered", answer: "boarded" }]);
  assert.equal(boarded.state, "on_bus");
  assert.equal(boarded.boardingConfirmedAt, T0, "the moment the rider said yes is recorded");
});

test("no path into on_bus skips the confirmation", () => {
  // Asserted over the transition table itself, so a later edit that adds a
  // shortcut fails here rather than in a bus.
  const sources = (
    [
      "idle", "selecting_destination", "analyzing_route", "route_selected", "walking_to_stop",
      "waiting_for_bus", "bus_due", "confirming_boarding", "on_bus", "approaching_destination",
      "confirming_exit", "arrived", "journey_error",
    ] as JourneyState[]
  ).filter((s) => nextStates(s).includes("on_bus"));

  assert.deepEqual(
    sources.sort(),
    ["approaching_destination", "confirming_boarding", "confirming_exit", "journey_error", "on_bus"],
    "on_bus must only be reachable from the confirmation, from itself, from the two states already past it, and from error recovery",
  );
});

test("saying you did not board is not a failure and does not end the journey", () => {
  // A missed bus is an ordinary thing that happens at bus stops. Ending
  // navigation here would strand someone who is standing exactly where they
  // should be, having done nothing wrong.
  const asked = run(atTheStop(), [{ type: "boarding_question_raised", reason: "due" }]);
  const missed = run(asked, [{ type: "boarding_answered", answer: "not_boarded" }]);

  assert.equal(missed.state, "waiting_for_bus");
  assert.equal(missed.missedBuses, 1);
  assert.equal(missed.fault, null, "a missed bus is not a fault");
  assert.equal(missed.busDueAt, null, "the old estimate is dropped, not left to go stale");
});

test("the exit question can be answered 'not yet' without losing the count", () => {
  const riding = run(atTheStop(), [
    { type: "boarding_question_raised", reason: "due" },
    { type: "boarding_answered", answer: "boarded" },
    { type: "position_updated", remainingStops: 1, etaSeconds: 60 },
    { type: "exit_question_raised" },
  ]);
  assert.equal(riding.state, "confirming_exit");

  const stillOn = run(riding, [{ type: "exit_answered", exited: false }]);
  assert.equal(stillOn.state, "approaching_destination", "the ladder resumes where it was");
  assert.equal(stillOn.remainingStops, 1, "the count survives the detour");
});

test("the approaching boundary is the same one the ladder speaks at", () => {
  // If these drifted, "approaching your destination" would mean one thing on
  // screen and another in the rider's ear.
  const riding = run(atTheStop(), [
    { type: "boarding_question_raised", reason: "due" },
    { type: "boarding_answered", answer: "boarded" },
  ]);

  const far = run(riding, [{ type: "position_updated", remainingStops: APPROACHING_STOPS + 1, etaSeconds: 900 }]);
  assert.equal(far.state, "on_bus");

  const near = run(far, [{ type: "position_updated", remainingStops: APPROACHING_STOPS, etaSeconds: 400 }]);
  assert.equal(near.state, "approaching_destination");
});

test("an overshoot does not throw the rider out of the journey", () => {
  const riding = run(atTheStop(), [
    { type: "boarding_question_raised", reason: "due" },
    { type: "boarding_answered", answer: "boarded" },
    { type: "position_updated", remainingStops: 1, etaSeconds: 60 },
  ]);
  const past = run(riding, [{ type: "position_updated", remainingStops: -2, etaSeconds: null }]);
  assert.equal(past.state, "approaching_destination", "still guided, still counted");
  assert.equal(past.remainingStops, -2);
});

test("walking ends at the stop by distance, not by an assumption", () => {
  const walking = run(createJourney(T0), [
    { type: "destination_requested" },
    { type: "destination_confirmed", destination: stop("000000010", "Сансар") },
    { type: "route_chosen", route: ROUTE, origin: stop("000000002", "Их дэлгүүр"), busDueAt: null , busDueSource: "timetable"},
    { type: "guidance_started", distanceToStopM: 300 },
  ]);
  assert.equal(walking.state, "walking_to_stop");

  const closer = run(walking, [{ type: "walk_progress", distanceToStopM: AT_STOP_M + 1 }]);
  assert.equal(closer.state, "walking_to_stop");

  const there = run(closer, [{ type: "walk_progress", distanceToStopM: AT_STOP_M }]);
  assert.equal(there.state, "waiting_for_bus");
});

test("guidance starts at the stop when the rider is already standing at it", () => {
  const j = run(createJourney(T0), [
    { type: "destination_requested" },
    { type: "destination_confirmed", destination: stop("000000010", "Сансар") },
    { type: "route_chosen", route: ROUTE, origin: stop("000000002", "Их дэлгүүр"), busDueAt: null , busDueSource: "timetable"},
    { type: "guidance_started", distanceToStopM: 10 },
  ]);
  assert.equal(j.state, "waiting_for_bus", "no phantom walking leg");
});

test("events that arrive in the wrong state are ignored, never applied", () => {
  // GPS fixes and timers do not stop arriving because the rider moved on. An
  // ignored event must leave the journey untouched, not half-applied.
  const j = createJourney(T0);
  const result = transition(j, { type: "position_updated", remainingStops: 3, etaSeconds: 100 }, T0);
  assert.equal(result.applied, false);
  assert.ok(result.rejected);
  assert.deepEqual(result.journey, j, "a rejected event changes nothing at all");
});

test("location and guidance level are accepted in every state", () => {
  // Both are journey-wide facts. A fix that could only be recorded in some
  // states would leave the guide answering "where am I" from a stale position
  // in exactly the states where it matters.
  const states: JourneyState[] = [
    "idle", "walking_to_stop", "waiting_for_bus", "confirming_boarding", "on_bus",
    "approaching_destination", "confirming_exit", "arrived", "journey_error",
  ];
  for (const state of states) {
    const j: Journey = { ...createJourney(T0), state };
    const fix = { lat: 47.9, lon: 106.9, accuracyM: 12, at: T0 };
    const moved = transition(j, { type: "location_updated", fix }, T0);
    assert.ok(moved.applied, `location rejected in ${state}`);
    assert.equal(moved.journey.state, state, `location changed state in ${state}`);

    const level = transition(j, { type: "guidance_level_set", level: "detailed" }, T0);
    assert.ok(level.applied, `guidance level rejected in ${state}`);
    assert.equal(level.journey.guidanceLevel, "detailed");
  }
});

test("a fault is reachable from anywhere active, and recoverable", () => {
  const waiting = atTheStop();
  const broken = run(waiting, [{ type: "failed", fault: "location_unavailable" }]);
  assert.equal(broken.state, "journey_error");
  assert.equal(broken.fault, "location_unavailable");

  const back = run(broken, [{ type: "recovered", to: "waiting_for_bus" }]);
  assert.equal(back.state, "waiting_for_bus");
  assert.equal(back.fault, null, "recovering clears the fault, so the guide stops reporting it");
});

test("reset clears everything a previous journey knew", () => {
  const done = run(atTheStop(), [
    { type: "boarding_question_raised", reason: "due" },
    { type: "boarding_answered", answer: "boarded" },
    { type: "position_updated", remainingStops: 0, etaSeconds: 0 },
    { type: "exit_question_raised" },
    { type: "exit_answered", exited: true },
  ]);
  assert.equal(done.state, "arrived");

  const fresh = run(done, [{ type: "reset" }]);
  // A stale destination surviving into the next journey is how someone ends up
  // being guided to where they went yesterday.
  assert.equal(fresh.destination, null);
  assert.equal(fresh.route, null);
  assert.equal(fresh.boardingConfirmedAt, null);
  assert.equal(fresh.remainingStops, null);
  assert.equal(fresh.missedBuses, 0);
});

test("previousState always records where the journey actually came from", () => {
  const asked = run(atTheStop(), [{ type: "boarding_question_raised", reason: "due" }]);
  assert.equal(asked.previousState, "bus_due");
  const boarded = run(asked, [{ type: "boarding_answered", answer: "boarded" }]);
  assert.equal(boarded.previousState, "confirming_boarding");
});

test("'I'm not sure' never becomes a boarded bus", () => {
  // The worst outcome this flow has is being guided off a bus you are not on.
  // A rider who explicitly declined to confirm has not confirmed, and no amount
  // of convenience justifies reading their uncertainty as a yes.
  const asked = run(atTheStop(), [{ type: "boarding_question_raised", reason: "due" }]);
  const unsure = run(asked, [{ type: "boarding_answered", answer: "unsure" }]);

  assert.equal(unsure.state, "waiting_for_bus");
  assert.equal(unsure.boardingConfirmedAt, null, "an 'I don't know' was recorded as a yes");
});

test("'I'm not sure' does not invent a missed bus either", () => {
  // `missedBuses` drives "shall I find you another route". We have no evidence a
  // bus was missed — only that the rider cannot tell us — and counting one would
  // be the app filling in its own facts.
  const asked = run(atTheStop(), [{ type: "boarding_question_raised", reason: "due" }]);
  const unsure = run(asked, [{ type: "boarding_answered", answer: "unsure" }]);

  assert.equal(unsure.missedBuses, 0);
  // Unlike a definite "no", the estimate survives: if a bus really is still
  // coming, the rider is back to waiting for it with the number intact.
  assert.equal(unsure.busDueAt, atTheStop().busDueAt);
});

test("why the boarding question was asked is carried, not inferred", () => {
  // "The timetable says a bus is due" and "the timetable said one was due and
  // that time has passed" need different wording, and the screen must not have
  // to re-derive which it is from a clock.
  const due = run(atTheStop(), [{ type: "boarding_question_raised", reason: "due" }]);
  assert.equal(due.boardingAskReason, "due");

  const expired = run(atTheStop(), [{ type: "boarding_question_raised", reason: "expired" }]);
  assert.equal(expired.boardingAskReason, "expired");

  // Cleared on the way out, so a later question cannot inherit stale wording.
  const boarded = run(expired, [{ type: "boarding_answered", answer: "boarded" }]);
  assert.equal(boarded.boardingAskReason, null);
});

test("an estimate never travels without its provenance", () => {
  // A time with no source is a number nothing can decide the register for, and
  // the register is the whole safety property on the waiting half of the app.
  const j = atTheStop();
  assert.equal(j.busDueSource, "timetable");

  const refreshed = run(j, [
    { type: "estimate_updated", busDueAt: T0 + 60_000, busDueSource: "timetable" },
  ]);
  assert.equal(refreshed.busDueAt, T0 + 60_000);
  assert.equal(refreshed.busDueSource, "timetable");

  // Dropping the estimate drops the claim with it.
  const asked = run(refreshed, [{ type: "boarding_question_raised", reason: "expired" }]);
  const missed = run(asked, [{ type: "boarding_answered", answer: "not_boarded" }]);
  assert.equal(missed.busDueAt, null);
  assert.equal(missed.busDueSource, null, "a source outlived the number it described");
});
