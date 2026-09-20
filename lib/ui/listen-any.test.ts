/**
 * Why "voice input is unavailable" was the only thing this app would say.
 *
 * Two independent bugs stacked, and each of them alone is enough to make a
 * blind rider unable to speak a destination:
 *
 *   1. Support was decided by `window.SpeechRecognition`. The working engine
 *      records audio and uploads it and does not use that API at all, so a
 *      device that could have recognized speech perfectly was refused before
 *      it ever reached a microphone.
 *   2. On plain HTTP `navigator.mediaDevices` is `undefined`. `localhost` is
 *      exempt, so this passes every desktop test and fails on the phone —
 *      and it reported the same "unavailable" as a genuinely unsupported
 *      language, which then switched voice off for the session.
 *
 * These tests pin both. They manipulate globals directly because that is the
 * environment being modelled: a browser missing one specific capability.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { detectCaptureSupport } from "./listen-any";

/**
 * `defineProperty`, not assignment.
 *
 * Node 24 exposes `globalThis.navigator` as a getter-only accessor, so a plain
 * `g.navigator = …` throws. Every override here is `configurable` so the
 * original descriptor can be restored between tests.
 */
const NAMES = ["window", "navigator", "MediaRecorder"] as const;
const saved = new Map(
  NAMES.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)] as const),
);

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
function unsetGlobal(name: string) {
  if (Object.getOwnPropertyDescriptor(globalThis, name)) {
    Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
  }
}

afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else unsetGlobal(name);
  }
});

/** A browser with exactly the capabilities named. */
function browser({
  secure = true,
  mediaDevices = true,
  recorder = true,
  online = true,
  speechRecognition = false,
} = {}) {
  setGlobal("window", {
    isSecureContext: secure,
    ...(speechRecognition ? { SpeechRecognition: class {} } : {}),
  });
  setGlobal("navigator", {
    onLine: online,
    ...(mediaDevices ? { mediaDevices: { getUserMedia: () => Promise.resolve({}) } } : {}),
  });
  if (recorder) setGlobal("MediaRecorder", class {});
  else unsetGlobal("MediaRecorder");
}

test("REGRESSION: no Web Speech is NOT a reason to refuse", () => {
  // The first bug, exactly. Chrome on Android does not list mn-MN, so the old
  // check refused every rider on the destination screen — while the engine that
  // does work sat unused. Support must not depend on an API we do not call.
  browser({ speechRecognition: false });
  assert.deepEqual(detectCaptureSupport(), { available: true });
});

test("REGRESSION: an insecure origin is reported as such, not as a broken device", () => {
  // The second bug. http:// on a phone removes navigator.mediaDevices outright.
  browser({ secure: false });
  const support = detectCaptureSupport();
  assert.equal(support.available, false);
  assert.equal(support.available === false && support.reason, "insecure");
  // The hint has to name the fix — nobody debugs this from "unavailable".
  assert.match(
    support.available === false ? support.hint : "",
    /HTTPS|https/,
    "the hint must say the page needs TLS",
  );
});

test("an insecure origin must not look like an unsupported language", () => {
  // These are the same word to the rider and opposite problems to fix. Treating
  // the URL scheme as a language failure switches voice off for the session, so
  // serving the page correctly afterwards still leaves it disabled.
  browser({ secure: false });
  const support = detectCaptureSupport();
  assert.notEqual(
    support.available === false && support.reason,
    "no-network",
    "an insecure origin is not a network problem either",
  );
});

test("each blocker is distinguishable, because each has a different fix", () => {
  browser({ mediaDevices: false });
  assert.equal(
    detectCaptureSupport().available === false &&
      (detectCaptureSupport() as { reason: string }).reason,
    "no-mediadevices",
  );

  browser({ recorder: false });
  assert.equal(
    (detectCaptureSupport() as { reason: string }).reason,
    "no-recorder",
  );

  browser({ online: false });
  assert.equal((detectCaptureSupport() as { reason: string }).reason, "no-network");
});

test("a capable browser is allowed to try", () => {
  browser();
  assert.deepEqual(detectCaptureSupport(), { available: true });
});

test("every blocker carries a hint a developer can act on", () => {
  for (const opts of [
    { secure: false },
    { mediaDevices: false },
    { recorder: false },
    { online: false },
  ]) {
    browser(opts);
    const s = detectCaptureSupport();
    assert.equal(s.available, false);
    assert.ok(
      s.available === false && s.hint.length > 20,
      `${JSON.stringify(opts)} must explain itself, not just name a code`,
    );
  }
});

test("server-side rendering does not throw", () => {
  unsetGlobal("window");
  unsetGlobal("navigator");
  const s = detectCaptureSupport();
  assert.equal(s.available, false);
});
