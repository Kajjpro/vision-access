/**
 * Push-to-talk speech capture.
 *
 * CAPTURE ALWAYS HAPPENS. RECOGNITION IS A RACE.
 *
 * This file used to run the two engines in SERIES: Web Speech first, and if it
 * failed, Azure. That ordering quietly threw away the rider's sentence. Web
 * Speech reports an unsupported language by ending silently, and it only ends
 * once the rider has released the button — so the Azure "fallback" opened the
 * microphone AFTER the person had stopped talking, recorded ten seconds of a
 * bus stop, and uploaded it. The rider heard "Ойлгосонгүй", said the same name
 * again, and got the same nothing, forever. On Chrome for Android — the primary
 * target, whose recognizer does not list mn-MN — that was every single attempt.
 *
 * So the MediaRecorder now runs from the moment the button goes down, and Web
 * Speech, when it runs at all, runs alongside it on the same utterance. The
 * recording is the thing that is guaranteed to exist; Web Speech can only ever
 * win the race, never lose the audio.
 *
 * ENGINE 1 — Web Speech (`SpeechRecognition`). Free and low latency, but
 *   `mn-MN` is not in Chrome's published language list and Safari only
 *   recognizes what Siri does. OFF UNLESS A DEVICE HAS PROVEN IT — see
 *   `setWebSpeechProven`. Two microphone consumers at once is not free: a
 *   second capture can fail, or take the input, on hardware we cannot test
 *   here, and the thing it would be risking is the engine that actually works.
 *   Turning an unproven optimisation on by default and hoping is how the
 *   previous version lost every utterance. When it IS enabled it runs
 *   alongside the recording and is purely additive — it may answer first, it
 *   can never lose the audio, and its failures are never shown to the rider.
 *
 * ENGINE 2 — Azure Speech REST (short audio), via /api/stt. Same subscription
 *   as the pre-rendered TTS. mn-MN verified present, and 95% accurate over 40
 *   real stop names; see the header of app/api/stt/route.ts. Costs a round trip
 *   (~700ms on Ulaanbaatar mobile) and requires network. This is the engine
 *   that actually answers today.
 *
 * ENGINE 3 — the gesture-driven stop list, in JourneyScreen. If capture fails
 *   outright, a rider standing at a stop must still be able to pick a
 *   destination. Voice is never the only input path.
 *
 * Push-to-talk rather than voice-activated: no silence detection to tune, no
 * accidental activation from traffic noise, and the rider controls exactly when
 * the microphone is live — which matters for consent as much as for accuracy.
 *
 * THE MICROPHONE IS NOT OPENED HERE. `lib/speech/mic.ts` owns it, because on
 * iOS opening one is not a matter of calling `getUserMedia`: the page must have
 * left the `playback` audio session, and the call must happen inside the touch
 * handler itself rather than after the prompt has finished playing. Both were
 * wrong here, and the result was a voice feature that worked on Android and did
 * nothing at all on iOS.
 */

import { acquireMicrophone, releaseMicrophone as closeMicrophone } from './mic';
import { blobToWav } from './wav';

export type SttEngine = 'webspeech' | 'azure';

export interface SttResult {
  /** The best single transcript. Kept for display and logging. */
  transcript: string;
  /**
   * Every distinct transcript the engine offered, best-ranked first.
   *
   * The caller matches ALL of these against the stop list and keeps the best
   * match rather than the best transcript — `сан сар` matches nothing on its
   * own while `Сансар` sits unread in alternative 2. Lower ranks must be
   * penalized (ALTERNATIVE_PENALTY) so this widens what can be found without
   * giving noise N chances to clear the bar.
   */
  alternatives: string[];
  confidence: number;
  engine: SttEngine;
}

export interface SttCallbacks {
  onPartial?: (text: string) => void;
  onResult: (result: SttResult) => void;
  onError: (error: SttError) => void;
  onStateChange?: (state: 'idle' | 'listening' | 'processing') => void;
}

export type SttErrorCode =
  | 'no-microphone'
  | 'permission-denied'
  | 'language-unsupported'
  | 'no-speech'
  | 'network'
  | 'unknown';

export interface SttError {
  code: SttErrorCode;
  message: string;
  /** True when the gesture-driven list fallback should be offered immediately. */
  fatal: boolean;
}

const LANG = 'mn-MN';
const PROBE_KEY = 'va.webspeech.mn.supported';

/** A runaway recording is a battery and privacy cost. Nobody says a stop name for ten seconds. */
const MAX_UTTERANCE_MS = 10_000;

/**
 * How long the recording waits for Web Speech after the button comes up.
 *
 * Web Speech finalizes a moment after the audio ends, so uploading the instant
 * the button is released would beat it to the answer every time and make the
 * free engine pointless. Bounded tightly: this delay is added to every
 * utterance that Web Speech does not answer, and the rider is standing at a bus
 * stop waiting to be told something.
 */
const WEBSPEECH_GRACE_MS = 700;

/** Below this a "recording" is a stray tap, not speech. ~0.3s of Opus. */
const MIN_RECORDING_BYTES = 2000;

/**
 * The slice of the Web Speech surface this file touches.
 *
 * Typed rather than `any` because the repo's lint forbids it, and because the
 * event shapes are the part most easily got wrong: `results` is an array-LIKE
 * of array-likes, not an array, so `.map` and spread both fail on it silently
 * in the ways that matter.
 */
type SpeechAlternative = { transcript: string; confidence?: number };
type SpeechResult = { [index: number]: SpeechAlternative; length: number; isFinal: boolean };
type SpeechResultList = { [index: number]: SpeechResult; length: number };

type SpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: SpeechResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

type SpeechWindow = typeof window & {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
};

/**
 * The recorder surface this file uses, so tests can supply one.
 *
 * Structurally satisfied by a real `MediaRecorder`; narrower than the DOM type
 * because widening it would drag in the whole event-target machinery for four
 * members.
 */
export type RecorderLike = {
  readonly state: string;
  readonly mimeType?: string;
  start(): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
};

export type StreamLike = { getTracks(): { stop(): void }[] };

/** What /api/stt answers with. */
export interface SttResponse {
  transcript: string;
  confidence: number;
  alternatives?: string[];
}

/**
 * Everything that touches a browser API, injected.
 *
 * The same shape as `listenOnce({ create })` in lib/ui/voice.ts and the
 * geolocation object in lib/transit/locate.ts. A microphone that is refused, a
 * recogniser that ends silently, a button released before the microphone opens,
 * and a recognizer that returns six spellings all replay deterministically in
 * recognizer.test.ts because of this.
 */
export interface RecognizerDeps {
  /**
   * Hard cap on one capture, in ms. Defaults to MAX_UTTERANCE_MS.
   *
   * Push-to-talk callers can leave it long — the rider's finger ends the
   * recording. A TAP-driven caller has no release event, so this timer is the
   * only thing that ends the utterance, and ten seconds of waiting after a
   * two-second stop name reads as a hung app to someone who cannot see it.
   */
  maxUtteranceMs?: number;
  createSpeechRecognition?: () => SpeechRecognitionInstance | null;
  openMicrophone?: () => Promise<StreamLike>;
  /** Counterpart to `openMicrophone`; also restores the iOS audio session. */
  releaseStream?: (stream: StreamLike) => void;
  createRecorder?: (stream: StreamLike) => RecorderLike;
  toWav?: (blob: Blob) => Promise<Blob>;
  upload?: (wav: Blob) => Promise<SttResponse>;
  readProbe?: () => boolean | null;
  writeProbe?: (supported: boolean) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** `NotAllowedError` etc. arrive as unknown from a catch. */
function errorName(e: unknown): string {
  return e instanceof Error ? e.name : '';
}

/**
 * The best container THIS BROWSER can record.
 *
 * Not the best container Azure accepts — those sets barely intersect, and an
 * earlier version of this function tried to pick from Azure's list and returned
 * null on Chrome, which records only WebM/Opus. The result was a recognizer
 * that refused to open the microphone at all: the rider held the button, spoke,
 * and nothing whatsoever happened.
 *
 * Record whatever the browser is willing to produce; `blobToWav` converts it to
 * the 16 kHz mono PCM Azure wants, using the same browser's own decoder. An
 * empty string is valid — it tells MediaRecorder to choose for itself, which is
 * strictly better than refusing.
 */
export function pickRecordingMimeType(
  isSupported: (t: string) => boolean =
    typeof MediaRecorder !== 'undefined'
      ? MediaRecorder.isTypeSupported.bind(MediaRecorder)
      : () => false,
): string {
  for (const type of [
    'audio/webm;codecs=opus', // Chrome, Edge, Android — the primary target
    'audio/ogg;codecs=opus',  // Firefox
    'audio/mp4',              // iOS Safari
    'audio/webm',
  ]) {
    if (isSupported(type)) return type;
  }
  return '';
}

function readProbeDefault(): boolean | null {
  try {
    const v = localStorage.getItem(PROBE_KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

function writeProbeDefault(supported: boolean): void {
  try {
    localStorage.setItem(PROBE_KEY, supported ? '1' : '0');
  } catch {
    /* private mode — re-probe next session, harmless */
  }
}

/** Clear the cached verdict, e.g. from a debug gesture. */
export function resetEngineProbe(): void {
  try {
    localStorage.removeItem(PROBE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Turn the free engine on for THIS device, once something has proven it works.
 *
 * The proof is `public/voice-test.html` run on the actual phone, per
 * docs/voice-input.md: press "Test mn-MN", say a place name, and read the
 * RESULT line. A transcript there means Chrome on that device has a Mongolian
 * recognizer, and the journey screen may as well use it and skip the upload.
 *
 * Deliberately manual. Nothing auto-enables this, because the way to find out
 * is to run a second microphone capture next to the working one and see what
 * breaks — which is a fine thing to do on a bench and not on a rider standing
 * at a stop trying to get home.
 */
export function setWebSpeechProven(proven: boolean): void {
  writeProbeDefault(proven);
}

/**
 * Collapse repeated spellings, preserving rank.
 *
 * The engine often returns the same word as Display and Lexical, and the caller
 * penalizes by position — so leaving both in would spend two ranks on one guess
 * and push a genuinely different candidate further down for no reason.
 */
function distinct(texts: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    const text = t?.trim();
    if (!text) continue;
    const key = text.toLowerCase().replace(/[.,!?;:]/g, '').replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

async function uploadDefault(wav: Blob): Promise<SttResponse> {
  const res = await fetch('/api/stt', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav,
  });
  if (!res.ok) throw new Error(`STT ${res.status}`);
  return (await res.json()) as SttResponse;
}

export interface Recognizer {
  start(): Promise<void>;
  stop(): void;
  abort(): void;
  readonly engine: SttEngine;
}

export function createRecognizer(
  callbacks: SttCallbacks,
  deps: RecognizerDeps = {},
): Recognizer {
  const {
    maxUtteranceMs = MAX_UTTERANCE_MS,
    createSpeechRecognition = () => {
      const Ctor = getSpeechRecognition();
      return Ctor ? new Ctor() : null;
    },
    /**
     * The microphone comes from lib/speech/mic.ts, NOT from `getUserMedia`
     * here.
     *
     * That module owns two things this file cannot: the iOS audio session,
     * which must leave `playback` before a capture is even possible, and the
     * pre-warmed stream opened inside the touch handler, which is the only kind
     * of `getUserMedia` call WebKit will show a permission prompt for. Calling
     * `getUserMedia` directly from here is what made voice input impossible on
     * iOS while working on Android.
     */
    openMicrophone = acquireMicrophone,
    releaseStream = closeMicrophone,
    // `as unknown as` because MediaRecorder's handlers are typed against the
    // full DOM event, and RecorderLike deliberately names only the one field
    // this file reads. Structurally compatible at runtime; contravariance in
    // the handler parameter is what TypeScript objects to.
    createRecorder = (stream) => {
      // An empty string means "you choose" to us, but the constructor treats it
      // as an unsupported type and throws — which surfaced as a microphone that
      // refused to open at all. Omit the option instead.
      const mimeType = pickRecordingMimeType();
      return new MediaRecorder(
        stream as MediaStream,
        mimeType ? { mimeType } : undefined,
      ) as unknown as RecorderLike;
    },
    toWav = blobToWav,
    upload = uploadDefault,
    readProbe = readProbeDefault,
    writeProbe = writeProbeDefault,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  } = deps;

  /** Which engine produced the last delivered result. Reported, never assumed. */
  let engine: SttEngine = 'azure';

  let recognition: SpeechRecognitionInstance | null = null;
  let recorder: RecorderLike | null = null;
  let stream: StreamLike | null = null;
  let chunks: Blob[] = [];

  let utteranceTimer: unknown = null;
  let graceTimer: unknown = null;

  /** Set by abort(). Suppresses every callback — the screen has moved on. */
  let cancelled = false;
  /** Set by stop(). Distinguishes "released early" from "still holding". */
  let stopRequested = false;
  /** Guarantees exactly one onResult/onError per start(), whoever gets there first. */
  let settled = false;
  /** A final Web Speech transcript, if it beat the upload. */
  let webSpeechAlternatives: string[] | null = null;
  let webSpeechConfidence = 0;
  /** Whether Web Speech is still plausibly going to answer. */
  let webSpeechPending = false;

  const setState = (s: 'idle' | 'listening' | 'processing') =>
    callbacks.onStateChange?.(s);

  const clearTimers = () => {
    if (utteranceTimer !== null) { clearTimer(utteranceTimer); utteranceTimer = null; }
    if (graceTimer !== null) { clearTimer(graceTimer); graceTimer = null; }
  };

  const releaseMicrophone = () => {
    try {
      if (stream) releaseStream(stream);
    } catch {
      /* already gone */
    }
    stream = null;
  };

  /** Exactly one of these fires per utterance, and only if we still care. */
  function settle(deliver: () => void): void {
    if (settled || cancelled) return;
    settled = true;
    clearTimers();
    setState('idle');
    deliver();
  }

  const succeed = (result: SttResult) => settle(() => callbacks.onResult(result));
  const fail = (error: SttError) => settle(() => callbacks.onError(error));

  // ---------------------------------------------------------------- Web Speech
  //
  // Opportunistic and strictly additive. It never reports an error and never
  // ends the utterance: the recording is the contract, and everything below is
  // an attempt to answer faster and for free. A conflict with our own
  // getUserMedia, an unsupported language, a refused permission — all of them
  // just mean Azure answers instead.

  function startWebSpeech(): void {
    let instance: SpeechRecognitionInstance | null;
    try {
      instance = createSpeechRecognition();
    } catch {
      return;
    }
    if (!instance) return;

    recognition = instance;
    webSpeechPending = true;

    instance.lang = LANG;
    instance.interimResults = true;
    instance.continuous = false;
    // Ask for more than we used to read. The engine has already ranked these
    // server-side, so the extra ones cost nothing and one of them is often the
    // real name; see SttResult.alternatives.
    instance.maxAlternatives = 6;

    instance.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      if (!last) return;
      const texts: string[] = [];
      for (let i = 0; i < last.length; i++) texts.push(last[i]?.transcript ?? '');

      if (!last.isFinal) {
        callbacks.onPartial?.(texts[0] ?? '');
        return;
      }
      const alternatives = distinct(texts);
      if (alternatives.length === 0) return;

      // A real mn-MN transcript is the only proof this device supports it.
      writeProbe(true);
      webSpeechAlternatives = alternatives;
      webSpeechConfidence = last[0]?.confidence ?? 0.5;
      webSpeechPending = false;

      // Only answer straight away if the rider has finished speaking. Mid-hold
      // this is just an early partial that happened to be marked final.
      if (stopRequested) deliverWebSpeech();
    };

    instance.onerror = (event) => {
      // 'language-not-supported' is the definitive negative and worth caching:
      // it will fail identically forever, and skipping it next time saves the
      // battery of opening a second recognizer we know will refuse.
      if (event.error === 'language-not-supported' || event.error === 'bad-grammar') {
        writeProbe(false);
      }
      webSpeechPending = false;
      if (stopRequested) finishFromRecording();
    };

    instance.onend = () => {
      webSpeechPending = false;
      // A silent end with no result is how some builds report an unsupported
      // language, but it is also what a genuine silence looks like — too weak a
      // signal to cache a verdict on. Azure decides.
      if (stopRequested) {
        if (webSpeechAlternatives) deliverWebSpeech();
        else finishFromRecording();
      }
    };

    try {
      instance.start();
    } catch {
      webSpeechPending = false;
    }
  }

  function deliverWebSpeech(): void {
    if (!webSpeechAlternatives) return;
    engine = 'webspeech';
    releaseMicrophone();
    succeed({
      transcript: webSpeechAlternatives[0],
      alternatives: webSpeechAlternatives,
      confidence: webSpeechConfidence,
      engine: 'webspeech',
    });
  }

  // --------------------------------------------------------------------- Azure

  /**
   * Called once the recording has stopped AND Web Speech has either answered,
   * given up, or run out of grace. Uploads unless something already settled.
   */
  function finishFromRecording(): void {
    if (settled || cancelled) return;
    if (webSpeechAlternatives) { deliverWebSpeech(); return; }
    // Still waiting on Web Speech and the grace window has not run out yet.
    if (webSpeechPending && graceTimer !== null) return;
    if (recorder && recorder.state === 'recording') return;

    void uploadRecording();
  }

  async function uploadRecording(): Promise<void> {
    if (settled || cancelled) return;

    const type = recorder?.mimeType || 'audio/webm';
    const recorded = new Blob(chunks, { type });
    releaseMicrophone();

    if (recorded.size < MIN_RECORDING_BYTES) {
      fail({ code: 'no-speech', message: 'Recording too short.', fatal: false });
      return;
    }

    setState('processing');
    engine = 'azure';

    try {
      // Converted HERE, in the browser that produced it, because that browser
      // is the one guaranteed to be able to decode its own container. Azure
      // accepts neither Chrome's WebM nor Safari's MP4.
      const wav = await toWav(recorded);
      const data = await upload(wav);
      if (cancelled) return;

      const alternatives = distinct(
        data.alternatives?.length ? data.alternatives : [data.transcript],
      );
      if (alternatives.length === 0) {
        fail({ code: 'no-speech', message: 'Nothing recognized.', fatal: false });
        return;
      }
      succeed({
        transcript: alternatives[0],
        alternatives,
        confidence: data.confidence,
        engine: 'azure',
      });
    } catch {
      fail({
        code: 'network',
        message: 'Speech service unreachable.',
        fatal: true,
      });
    }
  }

  // ------------------------------------------------------------------- capture

  async function openCapture(): Promise<void> {
    try {
      stream = await openMicrophone();
    } catch (e: unknown) {
      fail({
        code: errorName(e) === 'NotAllowedError' ? 'permission-denied' : 'no-microphone',
        message: 'Microphone unavailable.',
        fatal: true,
      });
      return;
    }

    /**
     * The rider may have let go while the permission dialog or the microphone
     * was still opening — a quick tap, or a first-run prompt. Starting the
     * recorder now would capture ten seconds of the street after they had
     * finished speaking, which is precisely the failure this file exists to
     * remove. Bail to the recording path and let it report the empty capture.
     */
    if (cancelled) { releaseMicrophone(); return; }
    if (stopRequested) { releaseMicrophone(); finishFromRecording(); return; }

    chunks = [];
    let created: RecorderLike;
    try {
      created = createRecorder(stream);
    } catch {
      releaseMicrophone();
      fail({ code: 'no-microphone', message: 'Recording unavailable.', fatal: true });
      return;
    }
    recorder = created;

    created.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    created.onstop = () => {
      if (cancelled) { releaseMicrophone(); return; }
      // Give Web Speech its short head start, then upload regardless.
      if (webSpeechPending && graceTimer === null) {
        graceTimer = setTimer(() => {
          graceTimer = null;
          webSpeechPending = false;
          finishFromRecording();
        }, WEBSPEECH_GRACE_MS);
        return;
      }
      finishFromRecording();
    };

    created.start();
    setState('listening');

    utteranceTimer = setTimer(() => {
      utteranceTimer = null;
      stopRequested = true;
      if (recorder?.state === 'recording') recorder.stop();
    }, maxUtteranceMs);
  }

  return {
    get engine() {
      return engine;
    },

    async start() {
      cancelled = false;
      stopRequested = false;
      settled = false;
      webSpeechAlternatives = null;
      webSpeechConfidence = 0;
      webSpeechPending = false;
      recorder = null;
      chunks = [];
      clearTimers();

      // Kicked off first so it hears the same opening syllable the recorder
      // does. Fire-and-forget: nothing below waits on it, and on all but a
      // device that has proven mn-MN it does not run at all.
      if (readProbe() === true) startWebSpeech();

      await openCapture();
    },

    stop() {
      stopRequested = true;
      if (utteranceTimer !== null) { clearTimer(utteranceTimer); utteranceTimer = null; }

      if (recognition) {
        try { recognition.stop(); } catch { /* already stopped */ }
      }
      if (recorder?.state === 'recording') {
        recorder.stop();
        return;
      }
      // No recorder yet — either the microphone is still opening (openCapture
      // will see stopRequested) or it never opened at all.
      if (recorder) finishFromRecording();
    },

    abort() {
      cancelled = true;
      settled = true;
      clearTimers();
      setState('idle');
      if (recognition) {
        try { recognition.abort(); } catch { /* ignore */ }
      }
      recognition = null;
      if (recorder?.state === 'recording') {
        try { recorder.stop(); } catch { /* ignore */ }
      }
      recorder = null;
      chunks = [];
      releaseMicrophone();
    },
  };
}

/**
 * Request microphone permission at a moment you control, not mid-journey.
 * The browser permission dialog is visual and unlabelled for a screen reader
 * user, so speak an explanation first, then call this, then confirm the result.
 *
 * MUST BE CALLED FROM INSIDE A TOUCH OR CLICK HANDLER. iOS shows the prompt
 * only while the page holds a user activation, and an `await` before this call
 * has already spent it — see lib/speech/mic.ts. Calling it from a timer does
 * not merely fail: it reports 'denied' for a rider who was never asked, and the
 * caller then tells them voice is unavailable when it would have worked.
 */
export async function primeMicrophonePermission(): Promise<'granted' | 'denied' | 'unknown'> {
  try {
    const s = await acquireMicrophone();
    closeMicrophone(s);
    return 'granted';
  } catch (e: unknown) {
    return errorName(e) === 'NotAllowedError' ? 'denied' : 'unknown';
  }
}
