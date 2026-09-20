/**
 * The guide and the presenter.
 *
 * The guide is the layer the brief calls "AI". These tests are what make it
 * safe to call that: every name it can utter is asserted to have come from an id
 * already on the journey, so the safety gate in CLAUDE.md — the model layer may
 * never emit a stop or route name the deterministic matcher did not produce —
 * holds by construction rather than by review.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { answer, answerStopsLeft, options } from "./guide";
import { present, progressOf, PROGRESS_STEPS } from "./present";
import { createJourney } from "./types";
import type { Journey, JourneyRoute, JourneyState } from "./types";
import { isUnhedgedTime } from "../transit/announce";
import type { Stop } from "../transit/types";

const T0 = 1_700_000_000_000;
const all = () => true;
const none = () => false;

const ORIGIN: Stop = { id: "000000002", name: "Их дэлгүүр", lat: 47.918, lon: 106.917 };
const DEST: Stop = { id: "000000010", name: "Сансар", lat: 47.93, lon: 106.94 };
const ROUTE: JourneyRoute = {
  routeId: "11100350",
  directionId: 0,
  displayName: "Ч:35",
  headsign: "Сансар",
  boardingIndex: 2,
  destinationIndex: 10,
};

function journeyIn(state: JourneyState, patch: Partial<Journey> = {}): Journey {
  return {
    ...createJourney(T0),
    state,
    origin: ORIGIN,
    destination: DEST,
    route: ROUTE,
    ...patch,
  };
}

const ALL_STATES: JourneyState[] = [
  "idle", "selecting_destination", "analyzing_route", "route_selected", "walking_to_stop",
  "waiting_for_bus", "bus_due", "confirming_boarding", "on_bus", "approaching_destination",
  "confirming_exit", "arrived", "journey_error",
];

test("the guide answers in every state, and never with nothing", () => {
  // "Never provide a generic response when journey data is available" — the
  // failure being prevented is a rider asking what is happening and hearing
  // silence, which is the exact fear the whole guide exists to answer.
  for (const state of ALL_STATES) {
    const j = journeyIn(state, { fault: state === "journey_error" ? "location_unavailable" : null });
    const a = answer(j, "status", all, T0);
    assert.ok(a.keys.length > 0, `${state} answered with no clips at all`);
    assert.equal(a.priority, "critical", `${state}: a direct question must not queue behind a count`);
  }
});

test("every name the guide speaks comes from an id already on the journey", () => {
  // THE SAFETY GATE, asserted over output rather than by reading the code. A
  // stop_ or route_ key naming something the matcher never produced is the
  // failure mode that puts a confident wrong name in a blind rider's ear.
  const permitted = new Set([`stop_${ORIGIN.id}`, `stop_${DEST.id}`, `route_${ROUTE.routeId}`]);
  for (const state of ALL_STATES) {
    const j = journeyIn(state, { remainingStops: 4, busDueAt: T0 + 300_000, fault: "tracking_lost" });
    for (const key of answer(j, "status", all, T0).keys) {
      if (key.startsWith("stop_") || key.startsWith("route_")) {
        assert.ok(permitted.has(key), `${state} invented ${key}`);
      }
    }
  }
});

test("a spoken time is always hedged", () => {
  // Every number this app can produce about a bus is schedule-derived. There is
  // no call site that assembles a time without the hedge, and this is the
  // assertion that keeps it that way.
  const waiting = journeyIn("waiting_for_bus", { busDueAt: T0 + 5 * 60_000 });
  const a = answer(waiting, "status", all, T0);
  assert.ok(a.keys.includes("num_5"), "the minutes were dropped");
  assert.ok(a.keys.includes("bus_approx_prefix"), "an unhedged time reached the rider");
  assert.equal(isUnhedgedTime(a), false);
});

test("the minutes are all three clips or none of them", () => {
  // A suffix whose number failed to decode leaves "Ойролцоогоор … минутын
  // дараа" with a hole in the middle, which sounds like a number that WAS said
  // and misheard — worse than not saying it.
  const waiting = journeyIn("waiting_for_bus", { busDueAt: T0 + 5 * 60_000 });
  const partial = answer(waiting, "status", (k) => k !== "num_5", T0);
  assert.equal(partial.keys.includes("bus_minutes_suffix"), false, "a bare hedge with no number");
  assert.equal(partial.keys.includes("bus_approx_prefix"), false);
});

test("a time past the rendered numbers is not spoken at all", () => {
  // num_ clips run to 40. Above that the honest output is the stop name and no
  // time, not a time with a silent number in it.
  const far = journeyIn("waiting_for_bus", { busDueAt: T0 + 90 * 60_000 });
  const a = answer(far, "status", all, T0);
  assert.equal(a.keys.some((k) => k.startsWith("num_")), false);
  assert.ok(a.keys.length > 0, "it still says where the rider is");
});

test("an unanswered question is what the guide answers with", () => {
  // A rider asking "what is happening" while a question is open is telling us
  // they did not hear it. Repeating the state instead would leave them stuck.
  for (const state of ["confirming_boarding", "confirming_exit"] as JourneyState[]) {
    const a = answer(journeyIn(state), "status", all, T0);
    assert.ok(a.keys.some((k) => k.startsWith("ui_confirm_")), `${state} did not re-ask`);
  }
});

test("past the destination, the guide says how far past and names the stop", () => {
  const overshot = journeyIn("approaching_destination", { remainingStops: -2 });
  const a = answer(overshot, "status", all, T0);
  assert.ok(a.keys.includes("bus_passed_stop"));
  assert.ok(a.keys.includes(`stop_${DEST.id}`), "the anchor the follow-ups drop");
  assert.ok(a.keys.includes("num_2"));
});

test("a missing stop name costs the name, never the count", () => {
  const riding = journeyIn("on_bus", { remainingStops: 4 });
  const a = answer(riding, "status", (k) => !k.startsWith("stop_"), T0);
  assert.ok(a.keys.includes("num_4"), "losing a name should not lose the number");
  assert.equal(a.keys.some((k) => k.startsWith("stop_")), false);
});

test("the short question gets the short answer", () => {
  const riding = journeyIn("on_bus", { remainingStops: 4 });
  const short = answerStopsLeft(riding, all, T0);
  assert.ok(short);
  assert.deepEqual(short.keys, ["num_4", "bus_stops_remaining"]);

  // Nothing to say rather than something vague: at the destination, "zero stops
  // remaining" is not an answer anyone wants.
  assert.equal(answerStopsLeft(journeyIn("on_bus", { remainingStops: 0 }), all, T0), null);
  assert.equal(answerStopsLeft(journeyIn("on_bus", { remainingStops: 4 }), none, T0), null);
});

// ------------------------------------------------------------- presentation

test("a quiet state offers the assistant and nothing else", () => {
  // While a bus is simply on its way there is nothing to DECIDE. What the rider
  // may still want is to ask — so exactly one entry stands, and the questions
  // live behind it rather than being flattened into a menu read aloud at a kerb.
  assert.deepEqual(options(journeyIn("waiting_for_bus")).map((o) => o.id), ["ask"]);
  assert.deepEqual(options(journeyIn("on_bus", { remainingStops: 5 })).map((o) => o.id), ["ask"]);
  assert.deepEqual(options(journeyIn("bus_due")).map((o) => o.id), ["ask"]);
});

test("a question state offers its answers and nothing else at all", () => {
  // The journey is blocked on one of them, and anything beside them is in the
  // way — including the assistant.
  assert.deepEqual(
    options(journeyIn("confirming_boarding")).map((o) => o.id),
    ["boarded", "not_boarded", "unsure"],
  );
  assert.deepEqual(options(journeyIn("confirming_exit")).map((o) => o.id), ["exited", "not_yet"]);
});

test("'I'm not sure' is offered, because forcing a guess produces one", () => {
  // A guessed yes starts a stop countdown for a bus nobody is on.
  const ids = options(journeyIn("confirming_boarding")).map((o) => o.id);
  assert.ok(ids.includes("unsure"));
});

test("the alternatives appear only once a bus has actually been missed", () => {
  assert.deepEqual(options(journeyIn("waiting_for_bus", { missedBuses: 0 })).map((o) => o.id), ["ask"]);
  const after = options(journeyIn("waiting_for_bus", { missedBuses: 1 }));
  assert.deepEqual(after.map((o) => o.id), ["ask", "find_other"]);
});

test("the primary action is first, because first is what a rider hears", () => {
  // The list is scrolled by ear, so "primary" is position one — the thing heard
  // without swiping at all. Walking to a stop, that is the manual override for a
  // GPS fix that is wrong, which in the downtown canyon is routine.
  assert.equal(options(journeyIn("walking_to_stop"))[0].id, "at_stop");
  assert.equal(options(journeyIn("confirming_boarding"))[0].id, "boarded");
  assert.equal(options(journeyIn("arrived"))[0].id, "finish");
});

test("the screen and the voice offer exactly the same choices", () => {
  // The failure this prevents: a screen showing three actions while the voice
  // reads two, and the rider selecting the one nobody read to them.
  for (const state of ALL_STATES) {
    const j = journeyIn(state, { missedBuses: 1 });
    const spoken = options(j).map((o) => o.id);
    const shown = present(j, T0).actions.map((a) => a.id);
    assert.deepEqual(shown, spoken, `${state} shows different actions than it speaks`);
  }
});

test("every action has a label and a clip to speak it with", () => {
  for (const state of ALL_STATES) {
    for (const action of present(journeyIn(state, { missedBuses: 1 }), T0).actions) {
      assert.ok(action.label.trim().length > 0, `${state}/${action.id} has no label`);
      assert.notEqual(action.label, action.id, `${state}/${action.id} fell back to its raw id`);
      assert.ok(action.keys.length > 0, `${state}/${action.id} cannot be spoken`);
    }
  }
});

test("progress is announceable as a step, not just drawn", () => {
  const p = progressOf(journeyIn("waiting_for_bus"));
  assert.equal(p.step, "waiting");
  assert.equal(p.index, 3);
  assert.equal(p.total, PROGRESS_STEPS.length);
  assert.match(p.label, /3 \/ 6/, "a screen reader needs the position, not a picture");
});

test("being asked a question is not progress", () => {
  // Inflating the confirmation to its own step would move the marker forward
  // for something the rider has not done yet.
  assert.equal(progressOf(journeyIn("confirming_boarding")).step, "waiting");
  assert.equal(progressOf(journeyIn("confirming_exit")).step, "arriving");
});

test("a fault does not move the progress marker", () => {
  // The rider is still exactly where they were. What changed is that we can no
  // longer help them from there.
  assert.equal(progressOf(journeyIn("journey_error")).index, null);
});

test("the headline never leaves the rider without a state", () => {
  for (const state of ALL_STATES) {
    const p = present(journeyIn(state, { remainingStops: 3, busDueAt: T0 + 120_000 }), T0);
    assert.ok(p.headline.trim().length > 0, `${state} has no headline`);
    assert.doesNotMatch(p.headline, /[A-Za-z]/, `${state} headline leaked Latin text: ${p.headline}`);
  }
});

test("the on-screen time carries the same hedge the spoken one does", () => {
  // The hedge is a property of the DATA, not of the audio channel. A rider with
  // partial sight reading an unhedged number would be reading something the app
  // never said.
  const p = present(journeyIn("waiting_for_bus", { busDueAt: T0 + 4 * 60_000 }), T0);
  assert.match(p.detail ?? "", /Ойролцоогоор/);
});

test("awaitingAnswer is true exactly in the states that block on the rider", () => {
  for (const state of ALL_STATES) {
    const expected = state === "confirming_boarding" || state === "confirming_exit";
    assert.equal(present(journeyIn(state), T0).awaitingAnswer, expected, state);
  }
});

// ------------------------------------------------- estimate versus sighting

test("a timetable estimate is always led by what kind of claim it is", () => {
  // THE PRODUCT DECISION. "Ойролцоогоор таван минутын дараа" hedges the NUMBER
  // and still sounds like something is being watched. Nothing is being watched.
  const waiting = journeyIn("waiting_for_bus", {
    busDueAt: T0 + 5 * 60_000,
    busDueSource: "timetable",
  });
  const keys = answer(waiting, "status", all, T0).keys;
  assert.ok(keys.includes("ui_timetable_prefix"), "a schedule time was spoken as an observation");
  // Before the number it qualifies. A hedge that arrives after is a correction,
  // and a rider who heard the number has already acted on it.
  assert.ok(keys.indexOf("ui_timetable_prefix") < keys.indexOf("num_5"));
});

test("an unattributed time is treated as the weaker claim, never the stronger", () => {
  // Guessing wrong in the other direction means a rider believing a bus was seen.
  const noSource = journeyIn("waiting_for_bus", { busDueAt: T0 + 3 * 60_000, busDueSource: null });
  assert.ok(answer(noSource, "status", all, T0).keys.includes("ui_timetable_prefix"));
});

test("a live sighting would drop the prefix — and only that", () => {
  // The single behavioural difference the City feed opening would make here.
  const live = journeyIn("waiting_for_bus", { busDueAt: T0 + 5 * 60_000, busDueSource: "live" });
  const keys = answer(live, "status", all, T0).keys;
  assert.equal(keys.includes("ui_timetable_prefix"), false);
  assert.ok(keys.includes("num_5"), "the time itself is unchanged");
  assert.ok(keys.includes("bus_approx_prefix"), "the number is still hedged as an estimate");
});

test("asking about the bus directly says we cannot confirm its position", () => {
  // On a routine status read this would be a caveat every time, which is how a
  // caveat stops being heard. Asked directly, it is the answer.
  const waiting = journeyIn("waiting_for_bus", {
    busDueAt: T0 + 4 * 60_000,
    busDueSource: "timetable",
  });
  assert.ok(answer(waiting, "time_left", all, T0).keys.includes("ui_timetable_no_live"));
  assert.equal(answer(waiting, "status", all, T0).keys.includes("ui_timetable_no_live"), false);
});

test("no prefix is spoken when there is no time to qualify", () => {
  const noTime = journeyIn("waiting_for_bus", { busDueAt: null, busDueSource: null });
  const keys = answer(noTime, "status", all, T0).keys;
  assert.equal(keys.includes("ui_timetable_prefix"), false);
  assert.ok(keys.length > 0, "it still says where the rider is");
});

test("an expired estimate is reported as a passed time, not as an arrival", () => {
  // The app knows a printed time has passed. It does NOT know a bus came, and it
  // does not know one did not. Saying "the bus has arrived" here would invent the
  // single fact the whole boarding gate exists because we lack.
  const expired = journeyIn("confirming_boarding", { boardingAskReason: "expired" });
  const keys = answer(expired, "status", all, T0).keys;
  assert.ok(keys.includes("ui_confirm_expected_now"));
  assert.ok(keys.includes("ui_confirm_boarded_q"), "it still asks");

  const due = journeyIn("confirming_boarding", { boardingAskReason: "due" });
  assert.equal(answer(due, "status", all, T0).keys.includes("ui_confirm_expected_now"), false);
});

test("the screen labels the evidence in words, not by colour", () => {
  // A rider with low vision reading at arm's length needs it in the same line as
  // the number. This app may never rely on colour to carry a distinction.
  const timetable = present(
    journeyIn("waiting_for_bus", { busDueAt: T0 + 4 * 60_000, busDueSource: "timetable" }),
    T0,
  );
  assert.match(timetable.detail ?? "", /Цагийн хуваарь/);
  assert.match(timetable.detail ?? "", /Ойролцоогоор/);

  const live = present(
    journeyIn("waiting_for_bus", { busDueAt: T0 + 4 * 60_000, busDueSource: "live" }),
    T0,
  );
  assert.match(live.detail ?? "", /Шууд байршил/);
});

test("no headline claims a bus was seen", () => {
  // `bus_due` means a timetable ran out. "Arriving" and "approaching" both
  // assert an observation, and there has never been one.
  for (const state of ALL_STATES) {
    const h = present(journeyIn(state, { busDueAt: T0, busDueSource: "timetable" }), T0).headline;
    assert.doesNotMatch(h, /ирлээ|ирж байна/, `${state} claims an arrival: ${h}`);
  }
});
