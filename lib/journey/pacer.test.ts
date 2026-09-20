/**
 * The pacer, tested against both requirements it has to satisfy at once.
 *
 * From CLAUDE.md: audio is not a progress bar, so the default must not produce
 * speech on a timer. From the brief: the app must never fall silent long enough
 * for a rider to conclude it has stopped working. A test suite that only checked
 * one of them would pass while breaking the other, so both are asserted on the
 * same function.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FAULT_REPEAT_MS, HEARTBEAT_MS, faultReminder, heartbeat, pace } from "./pacer";
import { createJourney } from "./types";
import type { GuidanceLevel, Journey, JourneyState } from "./types";

const T0 = 1_700_000_000_000;

function journeyIn(state: JourneyState, patch: Partial<Journey> = {}): Journey {
  return { ...createJourney(T0), state, lastAnnouncementAt: T0, ...patch };
}

/** Long enough that any state's heartbeat is due. */
const LATER = T0 + 600_000;

test("the default guidance level never speaks on a timer", () => {
  // THE INVARIANT FROM CLAUDE.md. A heartbeat that spoke would mask traffic the
  // rider is using to cross a road, every few minutes, forever.
  for (const state of ["walking_to_stop", "waiting_for_bus", "bus_due", "on_bus", "approaching_destination"] as JourneyState[]) {
    const beat = heartbeat(journeyIn(state, { guidanceLevel: "standard" }), LATER);
    assert.ok(beat, `${state} produced no heartbeat at all`);
    assert.deepEqual(beat.keys, [], `${state} spoke words at the default level`);
  }
});

test("but the default still proves the app is alive", () => {
  // THE REQUIREMENT FROM THE BRIEF. Silence and a crash are indistinguishable to
  // someone who cannot see the screen; a tone and a buzz separate them without
  // costing a word.
  const beat = heartbeat(journeyIn("waiting_for_bus"), LATER);
  assert.ok(beat);
  assert.equal(beat.earcon, "soft");
  assert.ok(beat.haptic?.length, "the one channel that survives a coat pocket");
  assert.equal(beat.priority, "low", "anything with real news must outrank it");
});

test("minimal is silent, and detailed speaks", () => {
  const minimal = heartbeat(journeyIn("on_bus", { guidanceLevel: "minimal" }), LATER);
  assert.equal(minimal, null, "minimal opted out of reassurance entirely");

  const detailed = heartbeat(journeyIn("on_bus", { guidanceLevel: "detailed" }), LATER);
  assert.ok(detailed);
  assert.ok(detailed.keys.length > 0, "detailed asked for words and got none");
});

test("a busy journey gets no heartbeat — there is no silence to fill", () => {
  // The heartbeat reads the last time ANYTHING was spoken, ladder included, so
  // a stretch of real announcements suppresses it completely. Without this the
  // rider would get a reassurance tone moments after being told to get off.
  const j = journeyIn("approaching_destination");
  const interval = HEARTBEAT_MS.approaching_destination!;
  assert.equal(heartbeat(j, T0 + interval - 1), null, "fired while the guide was still talking");
  assert.ok(heartbeat(j, T0 + interval), "did not fire once the silence was long enough");
});

test("nothing is ever said before the journey's own first announcement", () => {
  // Firing here would double the opening announcement, which is the caller's
  // job — the rider would hear the same thing twice half a second apart.
  const fresh = journeyIn("waiting_for_bus", { lastAnnouncementAt: null });
  assert.equal(heartbeat(fresh, LATER), null);
});

test("an idle or finished journey is silent", () => {
  for (const state of ["idle", "selecting_destination", "analyzing_route", "route_selected", "arrived"] as JourneyState[]) {
    assert.equal(heartbeat(journeyIn(state), LATER), null, `${state} produced a heartbeat`);
  }
});

test("an unanswered question is re-asked at every guidance level", () => {
  // NOT reassurance. These two states block the journey until the rider answers,
  // so an unheard question is a stalled journey — and a stalled journey is
  // indistinguishable from a quiet one to the person waiting in it. Minimal opts
  // out of comfort, not out of being asked a question it needs an answer to.
  for (const level of ["minimal", "standard", "detailed"] as GuidanceLevel[]) {
    for (const state of ["confirming_boarding", "confirming_exit"] as JourneyState[]) {
      const ask = heartbeat(journeyIn(state, { guidanceLevel: level }), LATER);
      assert.ok(ask, `${state} at ${level} was not re-asked`);
      assert.ok(ask.keys.length > 0, `${state} at ${level} re-asked without words`);
    }
  }
});

test("a re-asked question never cuts off an instruction", () => {
  // `critical` is reserved for the things that move a rider next to traffic.
  // A question can wait a few seconds; "Одоо буугаарай" cannot.
  const ask = heartbeat(journeyIn("confirming_boarding"), LATER);
  assert.ok(ask);
  assert.equal(ask.priority, "normal");
});

test("a re-ask expires with the question it is asking about", () => {
  // Queued behind a long utterance, it must not arrive after the rider has
  // already answered — asking again about a decision already made is how an
  // assistant starts sounding broken.
  const ask = heartbeat(journeyIn("confirming_boarding"), LATER);
  assert.ok(ask);
  assert.ok(ask.expiresAt > LATER, "already dead on arrival");
  assert.ok(ask.expiresAt <= LATER + HEARTBEAT_MS.confirming_boarding!);
});

test("a heartbeat is short-lived, because it is a claim about now", () => {
  const beat = heartbeat(journeyIn("on_bus"), LATER);
  assert.ok(beat);
  // "I am still here", delivered ninety seconds late after the state moved on,
  // is a claim about a journey that no longer exists.
  assert.ok(beat.expiresAt - LATER <= 15_000);
});

test("the wait is checked on more often than the ride", () => {
  // Shaped by what the rider is doing. Standing at a kerb not knowing whether
  // the app is alive is worse than sitting on a bus in the same doubt, and a
  // bus that is nearly there is the least patient moment of all.
  assert.ok(HEARTBEAT_MS.bus_due! < HEARTBEAT_MS.waiting_for_bus!);
  assert.ok(HEARTBEAT_MS.waiting_for_bus! < HEARTBEAT_MS.on_bus!);
  assert.ok(HEARTBEAT_MS.walking_to_stop! < HEARTBEAT_MS.on_bus!);
});

test("a degraded journey does not go quiet either", () => {
  // CLAUDE.md says a confidence downgrade is announced exactly once, and that
  // governs the DOWNGRADE. Being degraded five minutes later, with the rider
  // still stuck, is a different fact and needs its own mention.
  const broken = journeyIn("journey_error", { fault: "location_unavailable" });
  assert.equal(faultReminder(broken, T0 + 1_000), null, "repeated the downgrade immediately");

  const later = faultReminder(broken, T0 + FAULT_REPEAT_MS);
  assert.ok(later);
  assert.equal(later.earcon, "error");
  assert.ok(later.cooldownMs! >= FAULT_REPEAT_MS, "would nag");
});

test("pace is the single call site, so a screen cannot wire half of it", () => {
  // The failure this prevents: a screen that hooks up the heartbeat, forgets
  // the re-ask, and leaves the rider looking at a question the app has quietly
  // stopped asking.
  const asked = pace(journeyIn("confirming_boarding"), LATER);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].keys.length > 0);

  const broken = pace(journeyIn("journey_error", { fault: "network_unavailable" }), LATER);
  assert.equal(broken.length, 1, "a fault in a non-active state still gets a reminder");
});

test("the heartbeat can be switched off without changing the guidance level", () => {
  // Someone with one earbud in traffic may want detailed spoken guidance and no
  // tone at all. Tying the two together forces a choice nobody asked for.
  const off = journeyIn("waiting_for_bus", { guidanceLevel: "detailed", heartbeatEnabled: false });
  assert.equal(heartbeat(off, LATER), null);

  const on = journeyIn("waiting_for_bus", { guidanceLevel: "detailed", heartbeatEnabled: true });
  assert.ok(heartbeat(on, LATER));
});

test("a question is still asked when the heartbeat is switched off", () => {
  // The switch turns off REASSURANCE. It cannot turn off the question the
  // journey is blocked on, or the rider is stuck with no way to know why.
  const off = journeyIn("confirming_boarding", { heartbeatEnabled: false, guidanceLevel: "minimal" });
  const ask = heartbeat(off, LATER);
  assert.ok(ask);
  assert.ok(ask.keys.length > 0);
});

test("the heartbeat is dropped while the queue is busy, not queued behind it", () => {
  // `low` priority stops it preempting; it does not stop it playing the instant
  // a real announcement ends. A rider who has just heard "three stops remaining"
  // does not need a tone half a second later telling them the app is running.
  const j = journeyIn("on_bus");
  assert.equal(pace(j, LATER, { speaking: true, pending: 0 }).length, 0);
  assert.equal(pace(j, LATER, { speaking: false, pending: 2 }).length, 0);
  assert.equal(pace(j, LATER, { speaking: false, pending: 0 }).length, 1);
});

test("a question is exempt from the busy rule", () => {
  // Not reassurance — the journey is blocked on it, so it queues normally and
  // waits its turn rather than being dropped.
  const asked = pace(journeyIn("confirming_boarding"), LATER, { speaking: true, pending: 3 });
  assert.equal(asked.length, 1);
  assert.ok(asked[0].keys.length > 0);
});

test("pace without a queue status still works", () => {
  // The screens pass it; the tests and any future caller need not.
  assert.equal(pace(journeyIn("on_bus"), LATER).length, 1);
});
