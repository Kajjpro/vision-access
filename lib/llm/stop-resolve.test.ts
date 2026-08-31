/**
 * The gate between a model's reply and where a blind rider gets sent.
 *
 * Every test here is one sentence: A MODEL CANNOT NAME A STOP. It may reorder
 * candidates the deterministic matcher already found and it may pick one of
 * four pre-rendered questions; anything else it says is discarded. If one of
 * these ever goes red, the failure mode is a rider standing somewhere they did
 * not ask to be, unable to see why — so treat a red test here as a shipping
 * blocker rather than a regression to triage later.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { applyModelReply, sanitizeRequest, UNKNOWN, type ModelReply } from "./stop-resolve";

const allowed = new Set(["s1", "s2", "s3"]);
const apply = (raw: ModelReply | null, seen?: string[]) =>
  applyModelReply(raw, allowed, seen ? (r) => seen.push(r) : undefined);

// ------------------------------------------------- the invariant that matters

test("REGRESSION: an invented stop id is never returned", () => {
  // The single failure this whole layer is designed around. A fluent, confident
  // reply naming a stop that does not exist must resolve to nothing.
  const violations: string[] = [];
  assert.deepEqual(
    apply({ action: "resolved", stopId: "s99", confidence: 0.99 }, violations),
    UNKNOWN,
  );
  assert.equal(violations.length, 1, "and it is reported, not swallowed");
});

test("a real stop name in the id field is still not an id", () => {
  // Models reach for the human-readable thing. `Сансар` is a name, not an id,
  // and treating it as one would look like a near-miss rather than a rejection.
  assert.deepEqual(apply({ action: "resolved", stopId: "Сансар" }), UNKNOWN);
});

test("an id we did supply resolves", () => {
  assert.deepEqual(apply({ action: "resolved", stopId: "s2", confidence: 0.8 }), {
    kind: "resolved",
    stopId: "s2",
    confidence: 0.8,
  });
});

test("questions cannot name a stop we did not offer", () => {
  // These ids become `stop_<id>` clips. One we never rendered is silence, and
  // silence to someone who cannot see the screen is a frozen app.
  const violations: string[] = [];
  assert.deepEqual(
    apply({ action: "ask", question: "which_one", stopIds: ["s1", "s99", "s3"] }, violations),
    { kind: "ask", question: "which_one", stopIds: ["s1", "s3"] },
  );
  assert.equal(violations.length, 1);
});

// ------------------------------------------------------------ malformed input

test("every shape of nonsense degrades to unknown, never to a guess", () => {
  for (const raw of [
    null,
    undefined,
    {},
    { action: "resolved" }, // no id at all
    { action: "resolved", stopId: 42 },
    { action: "resolved", stopId: null },
    { action: "ask" }, // no question
    { action: "ask", question: "improvise" }, // not one of the four
    { action: "delete_everything" },
    { action: "unknown" },
  ] as (ModelReply | null | undefined)[]) {
    assert.deepEqual(apply(raw ?? null), UNKNOWN, `input: ${JSON.stringify(raw)}`);
  }
});

test("a question with nothing answerable in it is not asked", () => {
  // "Аль нь вэ?" with no options, or "did you say?" naming nobody, is a prompt
  // the rider physically cannot answer — worse than falling back.
  assert.deepEqual(apply({ action: "ask", question: "which_one", stopIds: [] }), UNKNOWN);
  assert.deepEqual(apply({ action: "ask", question: "did_you_say", stopIds: ["s99"] }), UNKNOWN);
});

test("say_again and use_list need no ids", () => {
  assert.deepEqual(apply({ action: "ask", question: "say_again" }), {
    kind: "ask",
    question: "say_again",
    stopIds: [],
  });
  assert.deepEqual(apply({ action: "ask", question: "use_list", stopIds: [] }), {
    kind: "ask",
    question: "use_list",
    stopIds: [],
  });
});

test("a garbage confidence does not reject a valid id", () => {
  // The id is the load-bearing part; the number only orders things that already
  // passed the gate, so a bad one means "no opinion", not "throw the answer out".
  for (const confidence of [undefined, "high", NaN, -1, 2, null]) {
    const out = apply({ action: "resolved", stopId: "s1", confidence });
    assert.deepEqual(out, { kind: "resolved", stopId: "s1", confidence: 0.5 });
  }
});

test("duplicate ids are collapsed and the list is capped at three", () => {
  const out = apply({
    action: "ask",
    question: "which_one",
    stopIds: ["s1", "s1", "s2", "s3", "s2"],
  });
  assert.deepEqual(out, { kind: "ask", question: "which_one", stopIds: ["s1", "s2", "s3"] });
});

// ------------------------------------------------------- outbound minimisation

test("only transcripts and id/name reach the request — nothing else", () => {
  // The recommended free tier may train on what it receives, so a client that
  // attached coordinates or a rider id must not be able to leak them by
  // accident. Enforced at the boundary rather than by convention.
  const { transcripts, candidates } = sanitizeRequest({
    transcripts: ["Сансар", "", "   ", 42, null],
    candidates: [
      { id: "s1", name: "Сансар", lat: 47.92, lon: 106.94, placeKey: "сансар", visits: 12 },
      { id: "s2", name: "Зайсан" },
      { nope: true },
    ],
    deviceId: "abc-123",
    position: [47.92, 106.94],
    history: ["home", "work"],
  });

  assert.deepEqual(transcripts, ["Сансар"]);
  assert.deepEqual(candidates, [
    { id: "s1", name: "Сансар" },
    { id: "s2", name: "Зайсан" },
  ]);
  // Belt and braces: assert on the serialized payload, because that is what
  // actually crosses the wire.
  const wire = JSON.stringify({ transcripts, candidates });
  for (const leaked of ["lat", "lon", "deviceId", "history", "placeKey", "visits", "47.92"]) {
    assert.ok(!wire.includes(leaked), `${leaked} must not reach the provider`);
  }
});

test("oversized payloads are truncated, not forwarded whole", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, name: `stop ${i}` }));
  const { transcripts, candidates } = sanitizeRequest(
    { transcripts: Array.from({ length: 50 }, (_, i) => `t${i}`), candidates: many },
    { maxTranscripts: 8, maxCandidates: 8 },
  );
  assert.equal(transcripts.length, 8);
  assert.equal(candidates.length, 8);
});

test("a junk body yields empty lists rather than throwing", () => {
  for (const body of [null, undefined, "nope", 7, [], { candidates: "no" }]) {
    const out = sanitizeRequest(body);
    assert.deepEqual(out, { transcripts: [], candidates: [] });
  }
});
