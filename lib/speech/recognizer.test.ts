/**
 * The recording format, the conversion to it, and the capture flow around both.
 *
 * The header here used to say the capture flow needs a microphone and is not
 * testable. That was a statement about reaching for `navigator.mediaDevices`,
 * not about the problem: every browser object the recognizer touches is now
 * injected, exactly as `listenOnce({ create })` does in lib/ui/voice.ts. A
 * recogniser that ends silently, a button released before the microphone
 * opens, a refused permission and an engine that returns six spellings all
 * replay deterministically below — and the first of those was losing every
 * utterance a rider spoke on the primary target browser.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecognizer,
  pickRecordingMimeType,
  type RecognizerDeps,
  type RecorderLike,
  type SttError,
  type SttResult,
} from "./recognizer";
import { blobToWav, encodeWav, mixToMono, resampleMono, TARGET_SAMPLE_RATE } from "./wav";

/** Measured on Chrome 141: ogg NO, wav NO, webm/opus YES. */
const chrome = (t: string) => t.startsWith("audio/webm");
const firefox = (t: string) => t.startsWith("audio/ogg");
const safari = (t: string) => t.startsWith("audio/mp4");

// ----------------------------------------------------- container choice

test("REGRESSION: Chrome gets a usable container, not a refusal", () => {
  // This returned null on Chrome, so `startAzure` bailed before recording:
  // the rider held the button, spoke, and nothing happened at all.
  assert.equal(pickRecordingMimeType(chrome), "audio/webm;codecs=opus");
});

test("Firefox and Safari each get their own native container", () => {
  assert.equal(pickRecordingMimeType(firefox), "audio/ogg;codecs=opus");
  assert.equal(pickRecordingMimeType(safari), "audio/mp4");
});

test("a browser that supports nothing we named lets MediaRecorder choose", () => {
  // Empty string means "you pick", which still records. Refusing does not.
  assert.equal(pickRecordingMimeType(() => false), "");
});

// ------------------------------------------------------------ resampling

test("resampling to 16 kHz keeps the signal's shape and duration", () => {
  const inRate = 48_000;
  const seconds = 0.5;
  const input = new Float32Array(inRate * seconds);
  for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / inRate);

  const out = resampleMono(input, inRate, TARGET_SAMPLE_RATE);
  assert.equal(out.length, TARGET_SAMPLE_RATE * seconds);
  // A 440 Hz tone is far below the 8 kHz Nyquist limit of 16 kHz, so it must
  // survive with its amplitude intact.
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak > 0.9, `peak fell to ${peak.toFixed(3)} — the resampler is losing signal`);
});

test("resampling is a no-op when the rate already matches", () => {
  const input = new Float32Array([0.1, -0.2, 0.3]);
  assert.equal(resampleMono(input, 16_000, 16_000), input);
});

test("stereo is averaged, not truncated to one side", () => {
  const left = new Float32Array([1, 0, -1]);
  const right = new Float32Array([-1, 0, 1]);
  assert.deepEqual([...mixToMono([left, right])], [0, 0, 0]);
  assert.deepEqual([...mixToMono([left])], [1, 0, -1]);
});

// -------------------------------------------------------------- encoding

test("the WAV header says exactly what Azure is told to expect", () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5]), TARGET_SAMPLE_RATE);
  const view = new DataView(wav);
  const ascii = (o: number, n: number) =>
    String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(o + i)));

  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(view.getUint16(20, true), 1, "must be uncompressed PCM");
  assert.equal(view.getUint16(22, true), 1, "must be mono");
  assert.equal(view.getUint32(24, true), 16_000, "must be 16 kHz");
  assert.equal(view.getUint16(34, true), 16, "must be 16-bit");
  assert.equal(view.byteLength, 44 + 3 * 2);
  // Declared data length must match the real payload or decoders truncate.
  assert.equal(view.getUint32(40, true), 3 * 2);
});

test("samples beyond full scale clamp instead of wrapping", () => {
  // Wrapping turns a loud syllable into a full-scale negative click, which the
  // recognizer reads as a consonant that was never spoken.
  const view = new DataView(encodeWav(new Float32Array([2, -2]), 16_000));
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
});

// -------------------------------------------------------- the whole path

test("a recorded blob becomes 16 kHz mono PCM whatever it came in as", async () => {
  // Stands in for Chrome handing back WebM/Opus at 48 kHz stereo.
  const fakeDecode = async () => ({
    channels: [new Float32Array(48_000).fill(0.25), new Float32Array(48_000).fill(0.25)],
    sampleRate: 48_000,
  });
  const wav = await blobToWav(new Blob(["irrelevant"]), fakeDecode);
  assert.equal(wav.type, "audio/wav");

  const view = new DataView(await wav.arrayBuffer());
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(22, true), 1);
  // One second in at 48 kHz is one second out at 16 kHz.
  assert.equal(view.getUint32(40, true), 16_000 * 2);
});

test("a recording that decodes to nothing throws rather than uploading silence", async () => {
  const empty = async () => ({ channels: [new Float32Array(0)], sampleRate: 48_000 });
  await assert.rejects(() => blobToWav(new Blob(["x"]), empty), /no audio/);
});

// ============================================================ the capture flow

type SpeechHandlers = {
  onresult: ((e: { results: unknown }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

/** A `results` list shaped the way the DOM shapes it: array-LIKE, not an array. */
function finalResult(transcripts: string[]) {
  const alternatives: Record<number, { transcript: string; confidence?: number }> = {};
  transcripts.forEach((t, i) => (alternatives[i] = { transcript: t, confidence: 0.8 }));
  const result = { ...alternatives, length: transcripts.length, isFinal: true };
  return { results: { 0: result, length: 1 } };
}

class FakeRecorder implements RecorderLike {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  /** Bytes handed over on stop. Below MIN_RECORDING_BYTES reads as a stray tap. */
  constructor(private bytes = 5000) {}
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(this.bytes)]) });
    this.onstop?.();
  }
}

function harness(
  options: {
    probe?: boolean | null;
    bytes?: number;
    openMicrophone?: () => Promise<{ getTracks(): { stop(): void }[] }>;
    upload?: (wav: Blob) => Promise<{
      transcript: string;
      confidence: number;
      alternatives?: string[];
    }>;
  } = {},
) {
  const results: SttResult[] = [];
  const errors: SttError[] = [];
  const states: string[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const speech: SpeechHandlers = { onresult: null, onerror: null, onend: null };

  let tracksStopped = 0;
  let recordersCreated = 0;
  let speechStarted = 0;
  let recorder: FakeRecorder | null = null;
  let probeWritten: boolean | null = null;

  const stream = {
    getTracks: () => [{ stop: () => { tracksStopped++; } }],
  };

  const deps: RecognizerDeps = {
    createSpeechRecognition: () => {
      speechStarted++;
      return {
        lang: "",
        continuous: false,
        interimResults: false,
        maxAlternatives: 1,
        start() {},
        stop() {},
        abort() {},
        set onresult(fn: SpeechHandlers["onresult"]) { speech.onresult = fn; },
        set onerror(fn: SpeechHandlers["onerror"]) { speech.onerror = fn; },
        set onend(fn: SpeechHandlers["onend"]) { speech.onend = fn; },
      } as never;
    },
    openMicrophone: options.openMicrophone ?? (async () => stream),
    createRecorder: () => {
      recordersCreated++;
      recorder = new FakeRecorder(options.bytes);
      return recorder;
    },
    toWav: async (blob) => blob,
    upload:
      options.upload ??
      (async () => ({ transcript: "Сансар", confidence: 0.9, alternatives: ["Сансар"] })),
    readProbe: () => options.probe ?? null,
    writeProbe: (v) => { probeWritten = v; },
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => { (h as { cancelled: boolean }).cancelled = true; },
  };

  const recognizer = createRecognizer(
    {
      onResult: (r) => results.push(r),
      onError: (e) => errors.push(e),
      onStateChange: (s) => states.push(s),
    },
    deps,
  );

  return {
    recognizer,
    results,
    errors,
    states,
    speech,
    finalResult,
    get recorder() { return recorder; },
    get recordersCreated() { return recordersCreated; },
    get speechStarted() { return speechStarted; },
    get tracksStopped() { return tracksStopped; },
    get probeWritten() { return probeWritten; },
    /** Fire the longest pending timer, standing in for a real timeout elapsing. */
    fireTimers: () => {
      for (const t of [...timers]) if (!t.cancelled) { t.cancelled = true; t.fn(); }
    },
    /** Let queued microtasks (the upload chain) run to completion. */
    flush: async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); },
  };
}

test("REGRESSION: a silent Web Speech must not swallow the rider's sentence", async () => {
  // The whole reason this file was rewritten. Web Speech reports an unsupported
  // language by ending with no result and no error, and it only does so after
  // the button comes up — so the old serial fallback opened the microphone once
  // the rider had already finished, recorded the street, and lost the name.
  // Every attempt on Chrome for Android failed exactly this way.
  const h = harness({ probe: true });
  await h.recognizer.start();
  assert.equal(h.recordersCreated, 1, "the recording must start with the utterance");

  h.recognizer.stop();
  h.speech.onend?.();
  await h.flush();

  assert.equal(h.errors.length, 0);
  assert.equal(h.results.length, 1, "the utterance must still be recognized");
  assert.equal(h.results[0].engine, "azure");
  assert.equal(h.results[0].transcript, "Сансар");
});

test("an unprobed device never opens a second microphone alongside the recording", async () => {
  // Web Speech is unproven for mn-MN, and two capture stacks at once is a risk
  // taken with the engine that actually works. Off until a device proves it.
  const h = harness({ probe: null });
  await h.recognizer.start();
  assert.equal(h.speechStarted, 0);
  assert.equal(h.recordersCreated, 1);

  h.recognizer.stop();
  await h.flush();
  assert.equal(h.results[0]?.engine, "azure");
});

test("Web Speech wins the race when it answers, and the upload is skipped", async () => {
  let uploads = 0;
  const h = harness({
    probe: true,
    upload: async () => {
      uploads++;
      return { transcript: "wrong", confidence: 0.1, alternatives: ["wrong"] };
    },
  });
  await h.recognizer.start();
  h.recognizer.stop();
  h.speech.onresult?.(finalResult(["Сансар"]));
  await h.flush();

  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].engine, "webspeech");
  assert.equal(uploads, 0, "no round trip when the free engine already answered");
  assert.equal(h.probeWritten, true, "a real transcript is what proves the device");
});

test("releasing before the microphone opens records nothing at all", async () => {
  // A quick tap, or a first-run permission dialog. Starting the recorder after
  // the rider has finished would capture ten seconds of the street and upload
  // it — which is the same bug in a different disguise.
  let openMic!: (s: { getTracks(): { stop(): void }[] }) => void;
  const pending = new Promise<{ getTracks(): { stop(): void }[] }>((r) => { openMic = r; });

  const h = harness({ openMicrophone: () => pending });
  const starting = h.recognizer.start();
  h.recognizer.stop();
  openMic({ getTracks: () => [{ stop() {} }] });
  await starting;
  await h.flush();

  assert.equal(h.recordersCreated, 0, "the microphone opened too late to be useful");
  assert.equal(h.results.length, 0);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].code, "no-speech");
  assert.equal(h.errors[0].fatal, false, "asking them to repeat themselves is the right remedy");
});

test("a refused microphone is fatal — the stop list has to take over", async () => {
  const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
  const h = harness({ openMicrophone: () => Promise.reject(denied) });
  await h.recognizer.start();
  await h.flush();

  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].code, "permission-denied");
  assert.equal(h.errors[0].fatal, true);
});

test("every alternative reaches the caller, deduped, best first", async () => {
  // The matcher searches all of these; the engine's own ranking between
  // homophones of a proper noun is close to a coin flip.
  const h = harness({
    upload: async () => ({
      transcript: "сан сар",
      confidence: 0.4,
      alternatives: ["сан сар", "Сан сар.", "Сансар", "сансар"],
    }),
  });
  await h.recognizer.start();
  h.recognizer.stop();
  await h.flush();

  assert.deepEqual(h.results[0].alternatives, ["сан сар", "Сансар"]);
});

test("a stray tap is reported as nothing heard, never uploaded", async () => {
  let uploads = 0;
  const h = harness({
    bytes: 10,
    upload: async () => { uploads++; return { transcript: "", confidence: 0 }; },
  });
  await h.recognizer.start();
  h.recognizer.stop();
  await h.flush();

  assert.equal(uploads, 0);
  assert.equal(h.errors[0].code, "no-speech");
});

test("the microphone is always released — a live mic is a battery and privacy cost", async () => {
  const h = harness();
  await h.recognizer.start();
  h.recognizer.stop();
  await h.flush();
  assert.ok(h.tracksStopped > 0);

  const aborted = harness();
  await aborted.recognizer.start();
  aborted.recognizer.abort();
  assert.ok(aborted.tracksStopped > 0);
});

test("abort after release stays silent — the screen has already moved on", async () => {
  const h = harness();
  await h.recognizer.start();
  h.recognizer.abort();
  await h.flush();
  assert.equal(h.results.length, 0);
  assert.equal(h.errors.length, 0);
});

test("a runaway recording is capped rather than held open", async () => {
  const h = harness();
  await h.recognizer.start();
  h.fireTimers();
  await h.flush();
  assert.equal(h.results.length + h.errors.length, 1, "the utterance ends itself");
});

test("exactly one outcome per utterance, whoever gets there first", async () => {
  const h = harness({ probe: true });
  await h.recognizer.start();
  h.recognizer.stop();
  // Web Speech answers, then ends, then the grace timer fires: three paths that
  // all used to be able to deliver.
  h.speech.onresult?.(finalResult(["Сансар"]));
  h.speech.onend?.();
  h.fireTimers();
  await h.flush();
  assert.equal(h.results.length + h.errors.length, 1);
});

test("a network failure is fatal, so the rider is offered the list", async () => {
  const h = harness({ upload: async () => { throw new Error("offline"); } });
  await h.recognizer.start();
  h.recognizer.stop();
  await h.flush();

  assert.equal(h.errors[0].code, "network");
  assert.equal(h.errors[0].fatal, true);
});
