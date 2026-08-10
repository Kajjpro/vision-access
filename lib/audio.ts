/**
 * The app's single AudioContext, and every clip decoded into it.
 *
 * Module scope, not React state, for two reasons. iOS allows only a handful of
 * AudioContexts per page and behaves badly near that limit, so the menu and the
 * modes must share one rather than each building their own. And CLAUDE.md
 * requires every buffer decoded at startup, never at playback time — a warning
 * that has to decode before it speaks is a warning that arrives late.
 *
 * The context is created lazily because it MUST be constructed inside a user
 * gesture or iOS leaves it suspended forever. Call `audioContext()` from a tap
 * handler, never from a render or an effect.
 */
import { PHRASES } from "./phrases";

const AUDIO_DIR = "/audio";
const AUDIO_EXT = ".wav";

let ctx: AudioContext | null = null;
const buffers = new Map<string, AudioBuffer>();

/** Everything currently scheduled, so a new announcement can cut the old one off. */
let active: AudioBufferSourceNode[] = [];

// iOS honours the ringer/silent switch for WebAudio unless the page declares a
// playback session, and it must be declared BEFORE the context is constructed.
type AudioSessionType = "auto" | "playback" | "transient" | "transient-solo" | "ambient" | "play-and-record";
interface NavigatorWithAudioSession extends Navigator {
  audioSession: { type: AudioSessionType };
}

/**
 * The shared context, created on first call. MUST be called from inside a user
 * gesture; every later call returns the same instance.
 */
export function audioContext(): AudioContext {
  if (!ctx) {
    if ("audioSession" in navigator) {
      (navigator as NavigatorWithAudioSession).audioSession.type = "playback";
    }
    ctx = new AudioContext();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function isAudioReady(): boolean {
  return ctx !== null && buffers.size > 0;
}

export function hasClip(id: string): boolean {
  return buffers.has(id);
}

export function loadedCount(): number {
  return buffers.size;
}

/**
 * Fetches and decodes every phrase. Safe to call more than once — already
 * decoded clips are skipped, so a second screen entering does no extra work.
 *
 * Failures are collected rather than thrown: losing one clip should cost that
 * one word, not the whole app's voice.
 */
export async function loadAllClips(
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ ok: string[]; failed: string[] }> {
  return loadClips(undefined, onProgress);
}

/**
 * Loads a SUBSET, or everything when `ids` is omitted.
 *
 * The subset form exists because decoding all 123 clips is ~9 MB of WAV, and
 * on a phone that is many seconds during which the app cannot say a word —
 * indistinguishable, to someone who cannot see it, from an app that is broken.
 * Screens load the few clips they need to speak first, then the rest behind.
 */
export async function loadClips(
  ids?: string[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ ok: string[]; failed: string[] }> {
  const context = audioContext();
  const ok: string[] = [];
  const failed: string[] = [];
  const wanted = ids ? PHRASES.filter((p) => ids.includes(p.id)) : PHRASES;

  await Promise.all(
    wanted.map(async (phrase) => {
      if (buffers.has(phrase.id)) {
        ok.push(phrase.id);
        onProgress?.(ok.length, wanted.length);
        return;
      }
      try {
        const res = await fetch(`${AUDIO_DIR}/${phrase.id}${AUDIO_EXT}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buffers.set(phrase.id, await context.decodeAudioData(await res.arrayBuffer()));
        ok.push(phrase.id);
      } catch {
        failed.push(phrase.id);
      }
      onProgress?.(ok.length, wanted.length);
    }),
  );

  return { ok, failed };
}

/**
 * Loads transit clips (stop and route names) into the SAME buffer map.
 *
 * These live in public/audio/transit as Opus with an AAC twin, separate from
 * the WAV UI clips, because there are ~900 of them and size matters. Sharing
 * the buffer map means playSequence can interleave a stop name with fixed
 * phrases without knowing where any of them came from.
 *
 * Format is chosen per device: Safari — every iOS browser — cannot be relied on
 * to decode Ogg Opus, and a stop name that fails to decode is announced as
 * silence, which a rider reads as "not yet".
 */
let transitManifest: Record<string, { path: string; pathAac?: string }> | null = null;

const preferAac = (() => {
  if (typeof document === "undefined") return false;
  return document.createElement("audio").canPlayType('audio/ogg; codecs="opus"') === "";
})();

export async function loadTransitClips(ids: string[]): Promise<{ ok: string[]; failed: string[] }> {
  const context = audioContext();
  const ok: string[] = [];
  const failed: string[] = [];

  if (!transitManifest) {
    try {
      transitManifest = await fetch("/audio/transit/manifest.json").then((r) => r.json());
    } catch {
      // No manifest yet (nothing rendered). Callers degrade to fixed phrases.
      transitManifest = {};
    }
  }

  await Promise.all(
    ids.map(async (id) => {
      if (buffers.has(id)) { ok.push(id); return; }
      const entry = transitManifest![id];
      if (!entry) { failed.push(id); return; }
      try {
        const url = preferAac && entry.pathAac ? entry.pathAac : entry.path;
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        buffers.set(id, await context.decodeAudioData(await res.arrayBuffer()));
        ok.push(id);
      } catch {
        failed.push(id);
      }
    }),
  );
  return { ok, failed };
}

/** Cuts off everything currently playing or scheduled. */
export function stopAll() {
  for (const source of active) {
    try {
      source.stop();
    } catch {
      // Already finished; nothing to stop.
    }
  }
  active = [];
}

/**
 * Schedules clips back to back on the audio clock and returns how long they
 * occupy, so a caller can schedule a repeat after a gap.
 *
 * start(when), never setTimeout: the audio clock is sample-accurate and does
 * not drift when the main thread is busy decoding a frame.
 */
export function playSequence(
  ids: string[],
  {
    interrupt = false,
    offsetS = 0,
    pan = 0,
  }: { interrupt?: boolean; offsetS?: number; pan?: number } = {},
): number {
  const context = audioContext();
  if (interrupt) stopAll();

  let when = context.currentTime + offsetS;
  const start = when;

  // One panner for the whole sequence: the object does not move between the
  // syllables of its own name, and a node per clip would be pointless garbage.
  const out = panNode(context, pan);

  for (const id of ids) {
    const buffer = buffers.get(id);
    // A missing clip skips rather than throwing: losing the object's name
    // should not also cost the user the distance.
    if (!buffer) continue;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(out);
    source.start(when);
    source.onended = () => {
      active = active.filter((s) => s !== source);
    };
    active.push(source);
    when += buffer.duration;
  }

  // Speech wins the channel. The proximity tone drops under it and comes back
  // after, so the two never compete for the same moment of attention.
  duckProximity(start, when - start);

  return when - start;
}

/**
 * Urgent beep, synthesised rather than played from a clip.
 *
 * It must exist even if every wav failed to decode, because it is the warning
 * for the one case the app cannot measure. An oscillator is not a TTS call —
 * CLAUDE.md bans runtime speech synthesis, not runtime audio.
 *
 * Returns its duration so words scheduled after it do not overlap.
 */
export function playTone(pan = 0): number {
  const context = audioContext();
  const DURATION_S = 0.18;

  const osc = context.createOscillator();
  const gain = context.createGain();

  // Square at 880 Hz cuts through street noise far better than a sine, and
  // reads as an alarm rather than a notification.
  osc.type = "square";
  osc.frequency.value = 880;

  // Ramped, not switched: a hard edge on a square wave clicks, and a click
  // through a phone speaker is indistinguishable from a fault.
  const start = context.currentTime;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.35, start + 0.01);
  gain.gain.setValueAtTime(0.35, start + DURATION_S - 0.02);
  gain.gain.linearRampToValueAtTime(0, start + DURATION_S);

  osc.connect(gain).connect(panNode(context, pan));
  osc.start(start);
  osc.stop(start + DURATION_S);
  duckProximity(start, DURATION_S);
  return DURATION_S;
}

// ---------------------------------------------------------------------------
// Spatial placement
// ---------------------------------------------------------------------------

/**
 * A panner feeding the destination, or the destination itself when centred.
 *
 * Panning is how direction gets delivered for free. The `left`/`right`/`ahead`
 * clips each cost about half a second of a budget capped at one announcement
 * per 1.5s; a warning that simply ARRIVES from the left says the same thing in
 * no time at all, and arrives together with the object's name instead of after
 * it.
 *
 * Only the horizontal axis is used. StereoPannerNode is equal-power and cheap;
 * a full PannerNode with HRTF would add elevation and distance nobody can act
 * on, at real CPU cost on a phone already running a detector.
 */
function panNode(context: AudioContext, pan: number): AudioNode {
  if (!pan) return context.destination;
  const panner = context.createStereoPanner();
  // Hard-panned audio in one ear is disorienting and, worse, deafens the user
  // on that side — the ear is their primary channel. Kept well inside full.
  panner.pan.value = Math.max(-MAX_PAN, Math.min(MAX_PAN, pan));
  panner.connect(context.destination);
  return panner;
}

/** Never fully one-sided; see panNode. */
const MAX_PAN = 0.7;

// ---------------------------------------------------------------------------
// Proximity tone
// ---------------------------------------------------------------------------

/**
 * A quiet continuous tone whose pitch rises as the nearest obstacle closes.
 *
 * Distance is continuous data, and forcing it through discrete words wastes the
 * one scarce channel. A tone carries approach between announcements at zero
 * speech cost, and it can convey "closing" honestly in exactly the case where
 * lib/distance.ts refuses to state a number, because a tone claims no precision.
 */
const PROX_NEAR_M = 0.4;
const PROX_FAR_M = 6;
const PROX_NEAR_HZ = 1000;
const PROX_FAR_HZ = 260;
const PROX_GAIN = 0.05;
/** Under speech. Not silence — losing the approach cue mid-warning is worse. */
const PROX_DUCKED_GAIN = 0.012;
/** Ramp constant. Long enough to avoid zipper noise, short enough to feel live. */
const PROX_GLIDE_S = 0.08;

/**
 * Pitch for a distance. Exponential, because pitch is perceived
 * logarithmically — a linear map would crowd every useful step into the last
 * metre and waste the rest of the range.
 *
 * Exported for testing: this is the mapping the whole feature rests on and it
 * needs to be checkable without a browser.
 */
export function proximityHz(metres: number): number {
  const clamped = Math.max(PROX_NEAR_M, Math.min(PROX_FAR_M, metres));
  const t = (clamped - PROX_NEAR_M) / (PROX_FAR_M - PROX_NEAR_M);
  return PROX_NEAR_HZ * Math.pow(PROX_FAR_HZ / PROX_NEAR_HZ, t);
}

let proxOsc: OscillatorNode | null = null;
let proxGain: GainNode | null = null;
let proxPanner: StereoPannerNode | null = null;
let proxDuckedUntil = 0;

/**
 * Sets the tone to a distance, or silences it with `null` when nothing is in
 * the corridor. Safe to call every frame — everything glides rather than jumps.
 */
export function updateProximity(metres: number | null, pan = 0) {
  const context = audioContext();

  if (!proxOsc) {
    // Sine, not the square the alarm uses: it has to sit under speech for
    // minutes without becoming something the user wants to switch off.
    proxOsc = context.createOscillator();
    proxOsc.type = "sine";
    proxGain = context.createGain();
    proxGain.gain.value = 0;
    proxPanner = context.createStereoPanner();
    proxOsc.connect(proxGain).connect(proxPanner).connect(context.destination);
    proxOsc.start();
  }

  const now = context.currentTime;
  const target = metres === null ? 0 : now < proxDuckedUntil ? PROX_DUCKED_GAIN : PROX_GAIN;

  proxGain!.gain.setTargetAtTime(target, now, PROX_GLIDE_S);
  proxPanner!.pan.setTargetAtTime(
    Math.max(-MAX_PAN, Math.min(MAX_PAN, pan)),
    now,
    PROX_GLIDE_S,
  );
  if (metres !== null) {
    proxOsc.frequency.setTargetAtTime(proximityHz(metres), now, PROX_GLIDE_S);
  }
}

/** Drops the tone under a speech burst and restores it afterwards. */
function duckProximity(startTime: number, durationS: number) {
  if (!proxGain) return;
  const end = startTime + durationS;
  proxDuckedUntil = end;
  proxGain.gain.setTargetAtTime(PROX_DUCKED_GAIN, startTime, PROX_GLIDE_S);
  proxGain.gain.setTargetAtTime(PROX_GAIN, end, PROX_GLIDE_S);
}

/** Stops the tone and releases the nodes — call when leaving the mode. */
export function stopProximity() {
  if (!proxOsc || !proxGain) return;
  const context = audioContext();
  const now = context.currentTime;
  // Ramp before stopping: cutting an oscillator at a non-zero sample is a click.
  proxGain.gain.cancelScheduledValues(now);
  proxGain.gain.setTargetAtTime(0, now, 0.05);
  proxOsc.stop(now + 0.3);
  proxOsc = null;
  proxGain = null;
  proxPanner = null;
  proxDuckedUntil = 0;
}
