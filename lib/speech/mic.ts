/**
 * Opening the microphone at a moment iOS is willing to grant it.
 *
 * ── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────
 *
 * WebKit will only show the microphone permission prompt while the page holds a
 * user activation — the synchronous run of a touch or click handler. A promise
 * continuation is not one. Neither is a `setTimeout`, and neither is a
 * `setInterval` tick.
 *
 * Both voice paths in this app were built to call `getUserMedia` after exactly
 * those things:
 *
 *   /bus/wait      double-tap → speak "Хаашаа явахаа хэлнэ үү" → AWAIT the clip
 *                  → getUserMedia. The await spends the activation.
 *   /bus/journey   finger down → 600 ms long-press timer → holdStart →
 *                  getUserMedia. The timer never had one.
 *
 * On Android neither matters: Chrome remembers the grant per origin and never
 * needed a gesture. On iOS the prompt is simply never shown, so permission is
 * never granted, so the next attempt is not shown either — a failure that
 * repairs itself never. The rider holds the phone, speaks a stop name, and
 * nothing whatsoever happens, forever.
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────
 *
 * `warmMicrophone()` is called SYNCHRONOUSLY from the touch handler, where the
 * activation still exists, and starts opening the microphone. The recogniser
 * calls `acquireMicrophone()` later — after the prompt has played, or 600 ms
 * into a hold — and gets that already-opening stream instead of asking again
 * from a context iOS refuses.
 *
 * The mic does not stay open behind the rider's back. A warm stream nobody
 * claims closes itself after WARM_TTL_MS, which is the whole point of a
 * push-to-talk design and the reason the recording indicator means what it says.
 */

import { beginCaptureSession, endCaptureSession } from "@/lib/audio";

/** The slice of MediaStream this module and the recognizer need. */
export type MicStream = {
  getTracks(): { stop(): void; readyState?: string }[];
};

/**
 * How long a warm stream waits to be claimed before closing itself.
 *
 * Long enough to cover the spoken prompt on /bus/wait — a clip of a couple of
 * seconds plus the gap after it — and the 600 ms long-press threshold on
 * /bus/journey with room for a slow hand. Short enough that a rider who taps and
 * changes their mind is not left with a live microphone.
 */
export const WARM_TTL_MS = 8_000;

/**
 * `echoCancellation` matters more than it looks: the app talks through the same
 * speaker it is recording next to, and on /bus/wait the read-back can begin
 * while the stream is still open.
 */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export type MicOpener = () => Promise<MicStream>;

const defaultOpener: MicOpener = () =>
  navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS }) as Promise<MicStream>;

let opener: MicOpener = defaultOpener;

/** Test seam. Pass null to restore the real `getUserMedia`. */
export function setMicrophoneOpener(open: MicOpener | null): void {
  opener = open ?? defaultOpener;
}

type Warm = {
  promise: Promise<MicStream>;
  /** Resolved stream, once it arrives — needed to close an unclaimed one. */
  stream: MicStream | null;
  error: unknown;
  at: number;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Whether this entry still owns a `beginCaptureSession`.
   *
   * Every path out of a warm stream — claimed, expired, refused, discarded —
   * has to release the session exactly once. A missed release leaves iOS in
   * `play-and-record` for the rest of the session, which is how warnings end up
   * quiet and routed to the earpiece; a double release drops it out of
   * `play-and-record` while a second capture is still open.
   */
  session: boolean;
};

function releaseSession(entry: Warm): void {
  if (!entry.session) return;
  entry.session = false;
  endCaptureSession();
}

let warm: Warm | null = null;

/** Live streams handed out by `acquireMicrophone`, for the session refcount. */
const acquired = new Set<MicStream>();

const now = () => Date.now();

function stopTracks(stream: MicStream): void {
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch {
    /* already gone */
  }
}

function clearWarm(): Warm | null {
  const previous = warm;
  if (previous?.timer) clearTimeout(previous.timer);
  warm = null;
  return previous;
}

/**
 * Start opening the microphone. CALL THIS FROM THE TOUCH HANDLER ITSELF.
 *
 * Never throws and never returns a rejecting promise: a refusal is remembered
 * and re-thrown from `acquireMicrophone`, where a caller exists to speak it. A
 * rejection surfacing here would be an unhandled one in a touch handler, which
 * on some builds is a console error and nothing else — invisible on a phone.
 */
export function warmMicrophone(): void {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
  // Already warm or already open — asking twice would prompt twice.
  if (warm && now() - warm.at < WARM_TTL_MS && !warm.error) return;
  if (acquired.size > 0) return;

  clearWarm();
  beginCaptureSession();

  const entry: Warm = {
    promise: null!, stream: null, error: null, at: now(), timer: null, session: true,
  };
  entry.promise = opener().then(
    (stream) => {
      entry.stream = stream;
      // Claimed while it was opening: `acquireMicrophone` is already awaiting
      // this promise and owns the stream now, so the expiry must not fire.
      if (warm === entry) armExpiry(entry);
      return stream;
    },
    (error: unknown) => {
      entry.error = error;
      if (warm === entry) clearWarm();
      // Released here whoever is waiting, because a microphone that never
      // opened is a capture that never happened.
      releaseSession(entry);
      throw error;
    },
  );
  // The rejection is delivered through `acquireMicrophone`; this keeps the
  // unclaimed copy from being reported as unhandled.
  entry.promise.catch(() => {});
  warm = entry;
}

function armExpiry(entry: Warm): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (warm !== entry) return;
    clearWarm();
    if (entry.stream) stopTracks(entry.stream);
    releaseSession(entry);
  }, Math.max(0, WARM_TTL_MS - (now() - entry.at)));
}

/** A stream whose tracks have all ended is not one we can record from. */
function isUsable(stream: MicStream): boolean {
  try {
    const tracks = stream.getTracks();
    return tracks.length > 0 && tracks.some((t) => t.readyState !== "ended");
  } catch {
    return false;
  }
}

/**
 * The microphone, warm if one is waiting and freshly opened otherwise.
 *
 * Rejects with the browser's own error — `NotAllowedError` and the rest — so the
 * caller can tell a refusal from a missing device and say the right thing.
 */
export async function acquireMicrophone(): Promise<MicStream> {
  const entry = clearWarm();

  if (entry && now() - entry.at < WARM_TTL_MS) {
    // Throws the browser's own error; warmMicrophone already released the
    // session on that path, so there is nothing to undo here.
    const stream = await entry.promise;
    if (isUsable(stream)) {
      // The warm entry's `beginCaptureSession` transfers to the live stream:
      // one begin, one end, whichever object is holding it at the time.
      entry.session = false;
      acquired.add(stream);
      return stream;
    }
    // Went stale while it waited — an interruption, or the rider switched apps.
    stopTracks(stream);
    releaseSession(entry);
  } else if (entry) {
    if (entry.stream) stopTracks(entry.stream);
    releaseSession(entry);
  }

  beginCaptureSession();
  try {
    const stream = await opener();
    acquired.add(stream);
    return stream;
  } catch (error) {
    endCaptureSession();
    throw error;
  }
}

/** Close a stream from `acquireMicrophone` and restore the playback session. */
export function releaseMicrophone(stream: MicStream | null | undefined): void {
  if (!stream) return;
  stopTracks(stream);
  if (acquired.delete(stream)) endCaptureSession();
}

/**
 * Drop a warm stream nobody is going to claim — leaving a screen, or a flow that
 * failed before it reached the recogniser.
 */
export function discardWarmMicrophone(): void {
  const entry = clearWarm();
  if (!entry) return;
  if (entry.stream) stopTracks(entry.stream);
  // Still opening: close it when it lands rather than leaving a microphone the
  // rider has already walked away from.
  entry.promise.then((stream) => stopTracks(stream)).catch(() => {});
  releaseSession(entry);
}

/** Test helper: forget every stream and reset the session refcount. */
export function resetMicrophoneForTests(): void {
  setMicrophoneOpener(null);
  discardWarmMicrophone();
  for (const stream of [...acquired]) releaseMicrophone(stream);
}
