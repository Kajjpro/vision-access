/**
 * The two iOS rules that made voice input impossible on one platform.
 *
 * Neither is visible on Android, neither produces an error anyone can read on a
 * phone, and both are ordinary-looking code: call `getUserMedia` when you want
 * the microphone, and declare a playback audio session so warnings survive the
 * silent switch. Together they meant an iOS rider could hold the screen, say a
 * stop name, and have nothing whatsoever happen — every time, forever, because
 * a permission that is never prompted for is never granted.
 *
 * So the rules are asserted here rather than trusted to a comment:
 *
 *   1. The microphone is REQUESTED IN THE TOUCH HANDLER, not after the prompt
 *      clip has played. `warmMicrophone()` must reach `getUserMedia` before it
 *      returns — an `await` anywhere ahead of it spends the user activation
 *      WebKit requires, and the dialog is silently never shown.
 *
 *   2. The audio session LEAVES `playback` BEFORE the request and returns to it
 *      after. iOS will not capture under a playback session, and leaving it in
 *      `play-and-record` afterwards costs the ringer-switch override that makes
 *      obstacle warnings audible at all.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

type Track = { stop(): void; readyState?: string };

/** Records every audio-session type the module declares, in order. */
let sessions: string[] = [];

function stubNavigator(): void {
  sessions = [];
  const audioSession = {
    _type: "auto",
    get type() { return this._type; },
    set type(next: string) { this._type = next; sessions.push(next); },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { audioSession, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    configurable: true,
    writable: true,
  });
}

function fakeStream(tracks: Track[] = [{ stop() {}, readyState: "live" }]) {
  const stopped: Track[] = [];
  return {
    stream: {
      getTracks: () => tracks.map((t) => ({
        ...t,
        stop: () => { stopped.push(t); t.stop(); },
      })),
    },
    get stopped() { return stopped.length; },
  };
}

/** Fresh module per test: the warm stream and the session count are module state. */
async function load() {
  const mic = await import(`./mic?${Math.random()}`);
  return mic as typeof import("./mic");
}

test("the microphone is requested INSIDE the call, not after an await", async () => {
  stubNavigator();
  const mic = await load();
  let opened = false;
  mic.setMicrophoneOpener(async () => { opened = true; return fakeStream().stream; });

  mic.warmMicrophone();

  // Synchronously true. This is the entire iOS fix: a touch handler that
  // returns before reaching getUserMedia has already lost its activation, and
  // WebKit will not show the permission dialog for the call that follows.
  assert.equal(opened, true, "getUserMedia must be reached before warmMicrophone returns");
  mic.resetMicrophoneForTests();
});

test("the audio session leaves playback BEFORE the request and returns after", async () => {
  stubNavigator();
  const mic = await load();
  const seenAtOpen: string[] = [];
  const s = fakeStream();
  mic.setMicrophoneOpener(async () => {
    seenAtOpen.push((navigator as unknown as { audioSession: { type: string } }).audioSession.type);
    return s.stream;
  });

  mic.warmMicrophone();
  const stream = await mic.acquireMicrophone();

  // iOS refuses to capture under a playback session, so the switch has to be
  // in place by the time the request is made — not once the recorder starts.
  assert.deepEqual(seenAtOpen, ["play-and-record"]);

  mic.releaseMicrophone(stream);
  assert.equal(
    sessions.at(-1),
    "playback",
    "warnings must survive the silent switch again once the mic is closed",
  );
});

test("a claimed warm stream is the same one, opened once", async () => {
  stubNavigator();
  const mic = await load();
  let opens = 0;
  const s = fakeStream();
  mic.setMicrophoneOpener(async () => { opens += 1; return s.stream; });

  mic.warmMicrophone();
  mic.warmMicrophone(); // a second finger, or a second tap
  const stream = await mic.acquireMicrophone();

  assert.equal(opens, 1, "asking twice would prompt twice");
  assert.equal(stream, s.stream);
  mic.resetMicrophoneForTests();
});

test("the session is released exactly once, whoever ends up holding the stream", async () => {
  stubNavigator();
  const mic = await load();
  const s = fakeStream();
  mic.setMicrophoneOpener(async () => s.stream);

  mic.warmMicrophone();
  const stream = await mic.acquireMicrophone();
  mic.releaseMicrophone(stream);
  mic.releaseMicrophone(stream); // a double release must not unbalance it

  assert.deepEqual(sessions, ["play-and-record", "playback"]);
});

test("an unclaimed warm microphone closes itself rather than staying live", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  stubNavigator();
  const mic = await load();
  const s = fakeStream();
  mic.setMicrophoneOpener(async () => s.stream);

  mic.warmMicrophone();
  await Promise.resolve(); // let the opener resolve

  t.mock.timers.tick(mic.WARM_TTL_MS + 1);

  // Push-to-talk means the microphone is live only while the rider intends it.
  // A tap that never became a hold must not leave one open behind them.
  assert.equal(s.stopped, 1);
  assert.equal(sessions.at(-1), "playback");
});

test("a warm stream that went stale is replaced, not recorded from", async () => {
  stubNavigator();
  const mic = await load();
  const dead = fakeStream([{ stop() {}, readyState: "ended" }]);
  const fresh = fakeStream();
  let opens = 0;
  mic.setMicrophoneOpener(async () => { opens += 1; return opens === 1 ? dead.stream : fresh.stream; });

  mic.warmMicrophone();
  const stream = await mic.acquireMicrophone();

  // An iOS interruption — a call, a switch away and back — ends the tracks. A
  // recorder attached to those produces an empty file and the rider is told
  // nothing was heard, which sends them off rehearsing a name that was fine.
  assert.equal(stream, fresh.stream);
  assert.equal(opens, 2);
  mic.releaseMicrophone(stream);
  assert.equal(sessions.at(-1), "playback");
});

test("a refusal reaches the caller as the browser's own error", async () => {
  stubNavigator();
  const mic = await load();
  const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
  mic.setMicrophoneOpener(async () => { throw denied; });

  mic.warmMicrophone();
  await assert.rejects(() => mic.acquireMicrophone(), (e: Error) => e.name === "NotAllowedError");

  // The distinction matters: 'permission-denied' hands the rider the stop list,
  // while a generic failure asks them to say it again for no reason.
  assert.equal(sessions.at(-1), "playback", "a mic that never opened is not a capture");
});

test("a warm microphone never outlives the screen that opened it", async () => {
  stubNavigator();
  const mic = await load();
  const s = fakeStream();
  mic.setMicrophoneOpener(async () => s.stream);

  mic.warmMicrophone();
  await Promise.resolve();
  mic.discardWarmMicrophone();

  assert.equal(s.stopped, 1);
  assert.equal(sessions.at(-1), "playback");
});

test("no microphone API at all is a quiet no-op, never a throw in a touch handler", async () => {
  Object.defineProperty(globalThis, "navigator", {
    value: {}, configurable: true, writable: true,
  });
  const mic = await load();
  assert.doesNotThrow(() => mic.warmMicrophone());
  mic.resetMicrophoneForTests();
});
