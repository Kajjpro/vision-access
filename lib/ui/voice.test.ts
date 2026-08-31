/**
 * Destination matching from speech, and the recogniser that feeds it.
 *
 * The MATCHING half is pure, and it is the half that decides whether someone
 * gets off at the right stop — so it is tested against the real 923 stop names
 * and against the ways recognition actually mangles Mongolian.
 *
 * The RECOGNITION half used to be untestable and untested, on the grounds that
 * it needs a microphone. It does not: it needs a `SpeechRecognition`, and that
 * is now injected. The scenarios below are the ones that happen at a bus stop —
 * a microphone that never opens because the permission prompt is unanswered, a
 * user who hesitates, an engine that returns three spellings, and a language
 * the engine does not have.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  listen, listenOnce, matchStops, normalizeForMatch,
  type ListenEvent, type SpeechRecognitionLike,
} from "./voice";

const stops: { id: string; name: string }[] = JSON.parse(
  readFileSync("public/transit/stops.json", "utf8"),
);

test("nobody says the platform suffix aloud, so it is stripped before matching", () => {
  assert.equal(normalizeForMatch("Сансар /Хойд/"), "сансар");
  assert.equal(normalizeForMatch("Монгол Улсын Их Сургууль /Хойд/"), "монгол улсын их сургууль");
  assert.equal(normalizeForMatch("Салхит завсар-1 /Зүүн/"), "салхит завсар 1");
});

test("saying a stop name plainly finds it", () => {
  const matches = matchStops("Сансар", stops);
  assert.ok(matches.length > 0, "Сансар must match something");
  assert.match(matches[0].name, /Сансар/);
});

test("case endings recognition gets wrong still match", () => {
  // Mongolian is agglutinative and ASR routinely returns an inflected form.
  for (const said of ["Сансарт", "Сансараас", "сансар"]) {
    const matches = matchStops(said, stops);
    assert.ok(matches.length > 0, `${said} found nothing`);
    assert.match(matches[0].name, /Сансар/, `${said} matched ${matches[0].name}`);
  }
});

test("a multi-word name matches without the direction marker", () => {
  const matches = matchStops("Монгол Улсын Их Сургууль", stops);
  assert.ok(matches.length > 0);
  assert.match(matches[0].name, /Монгол Улсын Их Сургууль/);
});

test("all platforms of a stop are offered, not silently collapsed", () => {
  // Сансар exists on more than one side of the road; the user picks which,
  // because we cannot know their direction from the name alone.
  const matches = matchStops("Сансар", stops, { limit: 10 });
  const distinct = new Set(matches.map((m) => m.name));
  assert.ok(distinct.size >= 2, `expected several platforms, got ${[...distinct].join(", ")}`);
});

test("nonsense matches nothing rather than guessing", () => {
  // The dangerous failure: confidently offering a stop the user never named.
  for (const said of ["зздкжцу", "qqqq", "xyzzy plugh"]) {
    assert.deepEqual(matchStops(said, stops), [], `${said} produced a false match`);
  }
});

test("an empty transcript matches nothing", () => {
  assert.deepEqual(matchStops("", stops), []);
  assert.deepEqual(matchStops("   ", stops), []);
});

test("a full name outranks a bare prefix of it", () => {
  const full = matchStops("Сансар", stops);
  const partial = matchStops("Сан", stops);
  const bestFull = full[0]?.score ?? 0;
  const bestPartial = partial[0]?.score ?? 0;
  assert.ok(bestFull > bestPartial, `full ${bestFull} should beat partial ${bestPartial}`);
});

test("results are ordered by score, best first", () => {
  const matches = matchStops("сургууль", stops, { limit: 8 });
  for (let i = 1; i < matches.length; i++) {
    assert.ok(matches[i - 1].score >= matches[i].score, "results out of order");
  }
});

test("matching never returns a stop the app cannot name", () => {
  const nameless = stops.filter((s) => !s.name.trim());
  assert.equal(nameless.length, 0, "stops.json should carry no empty names");
  const matches = matchStops("буудал", stops, { limit: 20 });
  for (const m of matches) assert.ok(m.name.trim().length > 0);
});

// ------------------------------------------------------- the recogniser

type Step =
  | { afterMs: number; event: "start" | "audiostart" | "speechstart" | "speechend" | "nomatch" | "end" }
  | { afterMs: number; event: "result"; alternatives: string[]; confidence?: number }
  | { afterMs: number; event: "error"; error: string };

/** Replays a scripted engine on a timeline. */
function fakeRecognizer(script: Step[]) {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const state = { started: 0, aborted: 0, maxAlternatives: 0, lang: "" };

  const make = (): SpeechRecognitionLike => {
    const r: SpeechRecognitionLike = {
      lang: "", continuous: false, interimResults: true, maxAlternatives: 0,
      start() {
        state.started++;
        state.maxAlternatives = r.maxAlternatives;
        state.lang = r.lang;
        for (const step of script) {
          timers.push(setTimeout(() => {
            if (step.event === "result") {
              const result: Record<number, { transcript: string; confidence?: number }> & { length: number } =
                { length: step.alternatives.length };
              step.alternatives.forEach((t, i) => {
                result[i] = { transcript: t, confidence: step.confidence ?? 0.8 };
              });
              r.onresult?.({ results: { 0: result } });
            } else if (step.event === "error") {
              r.onerror?.({ error: step.error });
            } else if (step.event === "audiostart") r.onaudiostart?.();
            else if (step.event === "start") r.onstart?.();
            else if (step.event === "speechstart") r.onspeechstart?.();
            else if (step.event === "speechend") r.onspeechend?.();
            else if (step.event === "nomatch") r.onnomatch?.();
            else if (step.event === "end") r.onend?.();
          }, step.afterMs));
        }
      },
      abort() { state.aborted++; for (const t of timers) clearTimeout(t); timers.length = 0; },
      onstart: null, onaudiostart: null, onspeechstart: null, onspeechend: null,
      onnomatch: null, onresult: null, onerror: null, onend: null,
    };
    return r;
  };

  return { create: make, state };
}

/** Small budgets so the suite runs in milliseconds, same shape as production. */
const budgets = {
  readyTimeoutMs: 200, startTimeoutMs: 200, speechTimeoutMs: 300, resultTimeoutMs: 150,
};

const heard = (t: string[]): Step[] => [
  { afterMs: 5, event: "audiostart" },
  { afterMs: 15, event: "speechstart" },
  { afterMs: 25, event: "speechend" },
  { afterMs: 30, event: "result", alternatives: t },
];

test("every alternative the engine offers is returned, not just the first", () => {
  // The whole reason the matcher gets to see them: for a proper noun outside
  // the language model, the ranking between these is close to arbitrary.
  const { create } = fakeRecognizer(heard(["сан сар", "сансар", "сансара"]));
  return listenOnce({ create, ...budgets }).then((outcome) => {
    assert.equal(outcome.kind, "heard");
    assert.deepEqual(
      outcome.kind === "heard" ? outcome.alternatives : [],
      ["сан сар", "сансар", "сансара"],
    );
  });
});

test("more alternatives are asked for than the engine's default", async () => {
  const { create, state } = fakeRecognizer(heard(["сансар"]));
  await listenOnce({ create, ...budgets });
  assert.ok(state.maxAlternatives >= 6, `asked for only ${state.maxAlternatives}`);
});

test("duplicate spellings collapse — the same word is not three chances", async () => {
  const { create } = fakeRecognizer(heard(["сансар", "сансар", " сансар "]));
  const outcome = await listenOnce({ create, ...budgets });
  assert.deepEqual(outcome.kind === "heard" ? outcome.alternatives : [], ["сансар"]);
});

test("partial transcripts are never requested — nobody can read the screen", async () => {
  const r = fakeRecognizer(heard(["сансар"]));
  let seen: SpeechRecognitionLike | null = null;
  await listenOnce({ create: () => (seen = r.create()), ...budgets });
  assert.equal(seen!.interimResults, false);
});

// --- the phased clock ---------------------------------------------------

test("the microphone opening is announced, so the user knows when to speak", async () => {
  const events: ListenEvent[] = [];
  const { create } = fakeRecognizer(heard(["сансар"]));
  await listenOnce({ create, ...budgets, onEvent: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => e.type), ["ready", "speech-start", "speech-end"]);
});

test("a microphone that never opens is distinct from a user who says nothing", async () => {
  // An unanswered permission prompt. The remedy is not "say it again".
  const { create } = fakeRecognizer([]);
  const outcome = await listenOnce({ create, ...budgets });
  assert.equal(outcome.kind === "error" && outcome.error, "no-mic");
  assert.equal(outcome.kind === "error" && outcome.retryable, false);
});

test("hesitating does not eat the time available to speak", async () => {
  // The old single 8 s wall clock started at start(): a user who paused was cut
  // off mid-name. The speaking budget must begin when speech does.
  const { create } = fakeRecognizer([
    { afterMs: 5, event: "audiostart" },
    { afterMs: 150, event: "speechstart" }, // hesitated most of the start budget
    { afterMs: 380, event: "result", alternatives: ["сансар"] }, // spoke past it
  ]);
  const outcome = await listenOnce({ create, ...budgets });
  assert.equal(outcome.kind, "heard", "a slow starter was cut off mid-name");
});

test("silence resolves as no-speech once the mic has been live long enough", async () => {
  const { create } = fakeRecognizer([{ afterMs: 5, event: "audiostart" }]);
  const outcome = await listenOnce({ create, ...budgets });
  assert.equal(outcome.kind === "error" && outcome.error, "no-speech");
  assert.equal(outcome.kind === "error" && outcome.retryable, true);
});

test("a transcript that never lands is given up on promptly after speech ends", async () => {
  // Holding the full speaking budget open here would leave someone who has
  // finished their sentence listening to silence with no idea it failed.
  const started = Date.now();
  const { create } = fakeRecognizer([
    { afterMs: 5, event: "audiostart" },
    { afterMs: 15, event: "speechstart" },
    { afterMs: 25, event: "speechend" },
  ]);
  const outcome = await listenOnce({ create, ...budgets });
  assert.equal(outcome.kind === "error" && outcome.error, "timeout");
  assert.ok(Date.now() - started < 280, "waited out the whole speaking budget after speech had ended");
});

// --- failure handling ---------------------------------------------------

test("an unsupported language is terminal, never retried", async () => {
  const { create, state } = fakeRecognizer([
    { afterMs: 5, event: "audiostart" },
    { afterMs: 10, event: "error", error: "language-not-supported" },
  ]);
  const outcome = await listen({ create, ...budgets, attempts: 3 });
  assert.equal(outcome.kind === "error" && outcome.languageUnsupported, true);
  assert.equal(outcome.kind === "error" && outcome.retryable, false);
  assert.equal(state.started, 1, "re-prompted for a language the engine will never have");
});

test("a refused microphone is terminal — asking again cannot help", async () => {
  const { create, state } = fakeRecognizer([
    { afterMs: 5, event: "audiostart" },
    { afterMs: 10, event: "error", error: "not-allowed" },
  ]);
  await listen({ create, ...budgets, attempts: 3 });
  assert.equal(state.started, 1);
});

test("hesitation gets a second chance rather than dropping to a 100-item list", async () => {
  let attempt = 0;
  const silent: Step[] = [{ afterMs: 5, event: "audiostart" }];
  const spoke = heard(["сансар"]);
  const create = () => {
    attempt++;
    return fakeRecognizer(attempt === 1 ? silent : spoke).create();
  };
  const events: ListenEvent[] = [];
  const outcome = await listen({ create, ...budgets, onEvent: (e) => events.push(e) });
  assert.equal(outcome.kind, "heard");
  assert.ok(events.some((e) => e.type === "retry"), "retried silently");
});

test("the retry announcement is awaited, so the mic is shut while the phone talks", async () => {
  // An open microphone during our own prompt is how the engine ends up
  // transcribing our voice instead of the user's.
  const order: string[] = [];
  let attempt = 0;
  const create = () => {
    attempt++;
    order.push(`listen${attempt}`);
    return fakeRecognizer(attempt === 1 ? [{ afterMs: 5, event: "audiostart" }] : heard(["сансар"])).create();
  };
  await listen({
    create, ...budgets,
    beforeRetry: async () => {
      order.push("say-start");
      await new Promise((r) => setTimeout(r, 40));
      order.push("say-end");
    },
  });
  assert.deepEqual(order, ["listen1", "say-start", "say-end", "listen2"]);
});

test("retries are bounded — the app never traps someone in a listening loop", async () => {
  const { create, state } = fakeRecognizer([{ afterMs: 5, event: "audiostart" }]);
  await listen({ create, ...budgets, attempts: 2 });
  assert.equal(state.started, 2);
});

test("no recogniser at all resolves rather than hanging", async () => {
  const outcome = await listenOnce({ create: () => null, ...budgets });
  assert.equal(outcome.kind === "error" && outcome.error, "no-api");
});

test("a constructor that throws resolves rather than hanging", async () => {
  const outcome = await listenOnce({ create: () => { throw new Error("boom"); }, ...budgets });
  assert.equal(outcome.kind, "error");
});

test("an empty transcript is reported as no-match, never as a heard destination", async () => {
  const { create } = fakeRecognizer(heard(["   "]));
  const outcome = await listenOnce({ create, ...budgets });
  assert.equal(outcome.kind === "error" && outcome.error, "no-match");
});

test("the recogniser is always released — a live mic is a battery and privacy cost", async () => {
  const { create, state } = fakeRecognizer(heard(["сансар"]));
  await listenOnce({ create, ...budgets });
  assert.ok(state.aborted > 0, "the microphone was left open after a result");
});

test("every path settles exactly once", async () => {
  for (const script of [
    heard(["сансар"]),
    [{ afterMs: 5, event: "audiostart" } as Step],
    [{ afterMs: 5, event: "error", error: "network" } as Step],
    [{ afterMs: 5, event: "audiostart" } as Step, { afterMs: 10, event: "nomatch" } as Step],
    [{ afterMs: 5, event: "audiostart" } as Step, { afterMs: 10, event: "end" } as Step],
    [],
  ]) {
    const { create } = fakeRecognizer(script);
    const outcome = await listenOnce({ create, ...budgets });
    assert.ok(["heard", "error"].includes(outcome.kind));
  }
});
