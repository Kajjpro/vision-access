"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import TargetOverlay from "@/components/TargetOverlay";
import type { OverlayTrack } from "@/components/TargetOverlay";
import {
  audioContext,
  hasClip,
  loadAllClips,
  playFocus,
  playSequence,
  playTone,
  stopAll,
  stopProximity,
  updateProximity,
} from "@/lib/audio";
import { openCamera, requestTiltPermission } from "@/lib/camera";
import { nameMinScore } from "@/lib/coco";
import { clearMark, mark, takeCrashStage } from "@/lib/breadcrumb";
import { pitchFromBeta } from "@/lib/tilt";
import { pinPlan, pinnedPlan, planFor } from "@/lib/vision-plan";
import { PHRASES } from "@/lib/phrases";
import { clearestDirection, isApproaching, isOverhead } from "@/lib/path";
import { Tracker } from "@/lib/tracker";
import type { Track } from "@/lib/tracker";
import {
  DEFAULT_PITCH_DEG,
  announcementFor,
  distanceBucket,
  estimateObjectDistance,
} from "@/lib/distance";
import type { CameraPose, DistanceBucket } from "@/lib/distance";
import type { WorkerResponse } from "@/lib/vision.worker";

/** Requested capture size. The camera may hand back something else, so the real
 *  dimensions are read off the video element rather than assumed. */
const REQUEST_W = 640;
const REQUEST_H = 480;

/** Height of the camera above the ground while walking, metres. */
const CAMERA_HEIGHT_M = 1.4;

/** Walking corridor: the middle 50% of the frame. Edges are not in the path. */
const CORRIDOR_MIN = 0.25;
const CORRIDOR_MAX = 0.75;

/**
 * Per-class repeat window, by urgency. `far` is never announced at all.
 *
 * near and mid are deliberately long. The complaint these answer is being
 * "barraged by a bunch of different words": a pavement holds a dozen
 * announceable things, and at four seconds apart the app narrates continuously
 * without ever saying anything new. Urgent stays short — that one is a hazard
 * report, and a user who is still walking toward something needs telling again.
 */
const BUCKET_DEBOUNCE_MS: Record<DistanceBucket, number> = {
  urgent: 2000,
  near: 6000,
  mid: 12_000,
  far: Infinity,
};

/**
 * Frames a track must have been SEEN IN before the app will speak its name.
 *
 * This is the accuracy fix and the "give it time before calling out" fix, and
 * they are the same fix. A zero-shot detector flickers — one confident frame
 * naming a lamp post a person, then nothing — and a single frame is exactly
 * enough evidence to say something wrong out loud. Three frames of agreement
 * is not, and costs roughly a third of a second.
 *
 * It also buys the settling time the user asked for: nothing is announced the
 * instant it appears at the edge of the frame, so the app stops reacting to
 * everything that flits past and speaks about things that are actually there.
 *
 * Urgent hazards confirm faster. Waiting the full count on something about to
 * be walked into would trade a false alarm for a collision, which is the wrong
 * way round — and the proximity tone is already sounding for it regardless,
 * with no confirmation delay at all.
 */
const CONFIRM_HITS = 3;
const CONFIRM_HITS_URGENT = 2;

/**
 * How much of the recent evidence must agree on the class before its name is
 * spoken. See Track.classConfidence and nameIsTrusted().
 *
 * 0.6 is "clearly ahead", not "unanimous". Demanding unanimity would silence
 * the name on a perfectly good car that the detector reads as a truck one frame
 * in four, which is ordinary behaviour at range and not the failure this guards
 * against. What it does reject is a genuine coin flip.
 */
const MIN_CLASS_CONFIDENCE = 0.6;

/**
 * Weight given to each new pitch sample, 0..1. Lower is steadier and laggier.
 *
 * 0.25 settles a step change in roughly ten samples — well under a second at
 * the rate DeviceOrientation fires — while removing the frame-to-frame jitter
 * that the distance maths multiplies into metres.
 */
const PITCH_SMOOTHING = 0.25;

/**
 * How often a frame is actually handed to the detector, in the two states.
 *
 * BATTERY. Before this, the loop dispatched a frame whenever the worker was
 * free, which means a phone ran neural-network inference flat out, continuously,
 * for the whole walk — the single largest drain in the app by a wide margin.
 * Nothing needed that: at 1.4 m/s a person covers 13 cm between frames at 11fps,
 * and the tracker's velocity window still sees a dozen samples.
 *
 * IDLE is for an empty corridor. Watching nothing at 11fps costs the same as
 * watching a bus, so when there is nothing in front of the user the loop halves
 * its rate and the phone gets to idle between frames. The cost is up to ~200ms
 * of extra latency on the first sighting, or about 28cm of walking — and that
 * first sighting still has to clear CONFIRM_HITS before it is spoken anyway, so
 * in practice it costs nothing that was going to be said sooner.
 */
const FRAME_INTERVAL_ACTIVE_MS = 90;
const FRAME_INTERVAL_IDLE_MS = 200;

/**
 * Ceiling on the fraction of wall-clock time spent running the network.
 *
 * THE BUG THIS FIXES. The intervals above only rate-limit a device that is
 * already FAST. The loop dispatches when `now - lastDispatch >= interval` and
 * the worker is free — so once inference takes longer than the interval, the
 * interval has always elapsed by the time the worker frees up, and the next
 * frame goes out on the very next animation tick. Measured against the real
 * model, that is the normal case, not an edge case: yolo11s at 640 costs 241ms
 * single-threaded and 71ms across four threads on an M3, and a cheap Android
 * core is several times slower again. So on exactly the phones this app targets
 * the throttle did nothing and the device ran neural-network inference
 * continuously, at a ~95% duty cycle, for the whole walk.
 *
 * Pacing on time since the last COMPLETION rather than the last dispatch fixes
 * it: whatever inference costs, the CPU now gets a proportional rest afterwards.
 *
 * 0.6 rather than something lower because the cost is paid in latency, and
 * latency here is metres. At a 300ms inference the period becomes 500ms, or
 * about 70cm of walking between looks — noticeably worse than 300ms, and still
 * inside the range where the confirmation count dominates when a warning
 * actually fires. Below ~0.5 the app starts missing things it should have seen;
 * above ~0.75 the saving stops being worth measuring.
 */
const MAX_DUTY_CYCLE = 0.6;

/** The same ceiling with nothing in the corridor, where latency costs much less. */
const MAX_DUTY_CYCLE_IDLE = 0.3;

/**
 * Smoothing on the measured inference time that feeds the pacing above.
 *
 * Thermal throttling and a passing GC spike look identical in a single sample,
 * and pacing off a single sample makes the frame rate hunt. This settles over
 * roughly ten frames, which is fast enough to follow a phone getting hot and
 * slow enough to ignore one bad frame.
 */
const INFERENCE_SMOOTHING = 0.2;

/**
 * Detections older than this stop being drawn.
 *
 * Comfortably above FRAME_INTERVAL_IDLE_MS plus a slow device's inference, so
 * an app merely conserving battery over an empty pavement never flickers its
 * boxes — this only fires when the detector has genuinely stopped answering.
 */
const OVERLAY_STALE_MS = 1500;

/**
 * Whether to paint the camera preview.
 *
 * ON by default, and the reason is a lesson rather than a preference. It was
 * briefly off to save battery — the user of this app cannot see the picture,
 * and black pixels are close to free on an OLED panel. What that overlooked is
 * that a black screen and a broken camera look EXACTLY the same to the sighted
 * person setting the phone up, and the first thing they did was report the
 * camera as broken. A working camera has to be visibly working.
 *
 * When this is false the video element is still painted normally and a black
 * overlay is drawn ON TOP of it. That is deliberate: hiding the element itself
 * (opacity, visibility, display) invites the browser to stop decoding frames
 * that nothing appears to be looking at, and createImageBitmap() reads from
 * exactly those frames. Covering it keeps the decode path untouched and still
 * leaves the panel dark, which is where the OLED saving actually comes from.
 */
const SHOW_PREVIEW = true;

/** Urgency, lowest wins. `far` is never announced, so it ranks last. */
const BUCKET_RANK: Record<DistanceBucket, number> = { urgent: 0, near: 1, mid: 2, far: 3 };

/**
 * The full warning for one track: what would be played and whether it leads
 * with the alarm. The one place the sentence is assembled, so target selection
 * and playback cannot drift apart.
 */
/**
 * Whether the app is sure enough of WHAT this is to say the word out loud.
 *
 * Two independent bars, because there are two different ways to be unsure and
 * only one of them is visible in a single frame:
 *
 *   - `score` is the detector's own confidence, averaged over the frames that
 *     voted for the winning class. A weak box is a weak box however consistent.
 *   - `classConfidence` is how much of the recent evidence agreed. A detector
 *     that alternates "car" and "truck" is confident twice per second and
 *     right at most half the time, and no single-frame score can catch that.
 *
 * Failing either one costs the NAME and nothing else. The tone still sounds,
 * the distance is still spoken, the object is still tracked and still holds the
 * lock — the app just stops claiming to know what it is. That is the trade
 * CLAUDE.md asks for: silence under uncertainty, and a missing word costs
 * nothing next to a wrong one said to someone who cannot look up and check it.
 */
function nameIsTrusted(target: Track): boolean {
  if (!target.className) return false;
  return (
    target.score >= nameMinScore(target.className) &&
    target.classConfidence >= MIN_CLASS_CONFIDENCE
  );
}

function announcementForTrack(
  target: Track,
  pose: CameraPose,
): { tone: boolean; clips: string[] } {
  const estimate = { metres: target.metres, reliable: target.reliable };
  // An untrusted name is passed as "" — announcementFor() then omits the noun
  // and speaks the distance alone, rather than dropping the warning entirely.
  const { tone: baseTone, clips: baseClips } = announcementFor(
    estimate,
    nameIsTrusted(target) ? target.className : "",
  );

  // Overhead hazards are the case a white cane cannot cover: it sweeps the
  // ground and passes under the branch, the tailgate, the scaffolding. They
  // have no ground contact, so distance.ts correctly refuses to measure them
  // and announcementFor() would say nothing at all — this is where the
  // warning has to come from instead. Always with the alarm.
  const overhead = isOverhead(target, pose);
  // "Дээр саад" alone is still a complete, actionable warning — the hazard is
  // that something is at head height, not which thing it is.
  const clips = overhead
    ? ["overhead", ...(nameIsTrusted(target) ? [target.className] : [])]
    : [...baseClips];
  const tone = overhead || baseTone;

  // "Машин" and "Машин ойртож байна" are different facts. The closing speed
  // was already being computed and thrown away; the word costs half a second
  // and is only spent when something is genuinely moving at the user.
  if (isApproaching(target)) clips.push("approaching");

  return { tone, clips };
}

/** Whether this track would produce any sound at all, right now. */
function canAnnounce(target: Track, pose: CameraPose): boolean {
  const { tone, clips } = announcementForTrack(target, pose);
  return tone || clips.length > 0;
}

/**
 * How urgently the target deserves the speech channel. A toned warning —
 * imminent contact or an overhead hazard — outranks every untoneed sentence:
 * the alarm must never wait behind a routine "approximately three metres".
 */
function urgencyRank(target: Track, pose: CameraPose): number {
  const { tone } = announcementForTrack(target, pose);
  return tone
    ? 0
    : BUCKET_RANK[distanceBucket({ metres: target.metres, reliable: target.reliable })];
}

/**
 * Hard cap: one utterance per this window, whatever the bucket.
 *
 * CLAUDE.md sets the ceiling at one per 1.5s; this sits below it deliberately.
 * 1.5s back to back is a voice that never stops, and a warning only works if
 * there is silence around it for the user to hear the street through.
 */
const MIN_ANNOUNCE_GAP_MS = 2500;

/**
 * Mean frame brightness below which detection is not trustworthy.
 *
 * Measured in the worker. Below this the model stops finding things, which to
 * someone who cannot see the screen is indistinguishable from an empty
 * pavement — so it has to be said out loud rather than inferred from silence.
 */
const DARK_LUMA = 0.12;
/** Sustained darkness, not a passing shadow or a hand over the lens. */
const DARK_SUSTAIN_MS = 2500;
/** Re-warned at most this often; it is a condition, not an event. */
const DARK_REPEAT_MS = 60_000;

/** Below this the phone is close to leaving the user with no app at all. */
const BATTERY_LOW = 0.15;

/**
 * Beyond this downward tilt the camera is looking at the user's own feet.
 *
 * A phone aimed at the pavement detects nothing, and nothing detected sounds
 * exactly like a clear path. The user has no way to see how they are holding
 * it, so the device has to say so.
 */
const CAMERA_DOWN_DEG = 60;
const CAMERA_DOWN_SUSTAIN_MS = 3000;
const CAMERA_DOWN_REPEAT_MS = 30_000;

/**
 * Above this per-frame inference time the device cannot keep up, and warnings
 * arrive after the obstacle rather than before it.
 *
 * Measured on inference duration rather than achieved frame rate, because the
 * loop now throttles itself deliberately (see FRAME_INTERVAL_IDLE_MS) and a low
 * rate is usually the app conserving battery, not the device struggling. 250ms
 * is past the point where even the idle cadence cannot be met.
 */
const SLOW_INFERENCE_MS = 250;
const SLOW_REPEAT_MS = 45_000;

/**
 * Horizontal position in the frame, as a stereo pan from -1 to 1.
 *
 * Announcements only fire for the walking corridor (the middle 50%), so this
 * lands inside roughly -0.5..0.5 in practice. That is deliberate: the point is
 * "slightly to your left", not a sound thrown into one ear.
 */
/**
 * The one place a warning is actually emitted, so a repeat is byte-identical.
 * Returns total seconds occupied (tone + speech), so a caller can know when
 * the channel is free again without re-deriving it from the clip list.
 */
function speak(clips: string[], tone: boolean, pan: number): number {
  // Tone first, then the words behind it — stop, then why.
  const offset = tone ? playTone(pan) : 0;
  const duration = playSequence(clips, { offsetS: offset, pan });
  return offset + duration;
}

/** Gap left after an urgent warning finishes before a path check may speak. */
const SCAN_DEFER_BUFFER_MS = 200;

/**
 * Floor on how often the lock-on sound may fire.
 *
 * The lock itself is sticky, so in a normal scene it changes rarely. This is
 * for the pathological one: two objects swapping which is nearest on alternate
 * frames, at 15fps, with speech held off by the per-track debounce so nothing
 * else rate-limits the loop. Without this floor that scene is a machine-gun of
 * blips at the exact moment the user most needs to be able to think.
 */
const FOCUS_MIN_GAP_MS = 800;

function panFor(box: { x: number; w: number }, pose: CameraPose): number {
  const centreX = (box.x + box.w / 2) / pose.frameWidth;
  return Math.max(-1, Math.min(1, (centreX - 0.5) * 2));
}

/**
 * Monotonic clock. Module scope so react-hooks/purity can see it is only ever
 * reached from event handlers and the rAF loop, never during render.
 */
function nowMs(): number {
  return performance.now();
}

/**
 * Screen Wake Lock. Not in TypeScript's DOM lib in this configuration.
 *
 * This is the difference between an app that works and one that appears to:
 * a user who cannot see the screen never touches it, so the display sleeps
 * after about thirty seconds, requestAnimationFrame stops being called, and the
 * warnings simply cease. No error, no sound — the exact silent failure
 * CLAUDE.md forbids, and the most dangerous one possible here.
 */
type WakeLockLike = { released: boolean; release: () => Promise<void> };

function requestWakeLock(): Promise<WakeLockLike> | null {
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: "screen") => Promise<WakeLockLike> };
  };
  try {
    return nav.wakeLock?.request("screen") ?? null;
  } catch {
    // Some browsers throw synchronously when not allowed (e.g. not visible).
    return null;
  }
}

/**
 * The Battery Status API, which TypeScript's DOM lib does not declare and iOS
 * Safari does not implement. Returns null where unsupported.
 */
type BatteryLike = EventTarget & { level: number; charging: boolean };

function getBattery(): Promise<BatteryLike> | null {
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
  return typeof nav.getBattery === "function" ? nav.getBattery() : null;
}

/**
 * `pitchFromBeta` is NOT redefined here. It moved to lib/tilt.ts when Ask mode
 * needed the same function, because both modes feed `CameraPose.pitchDeg` and a
 * second copy is how two modes come to disagree about how far away the same
 * door is.
 */
export default function WalkMode({
  onBack,
  initialStream,
}: {
  onBack: () => void;
  /** Camera opened by the menu inside its tap gesture; null on a deep link. */
  initialStream?: MediaStream | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const workerRef = useRef<Worker | null>(null);
  // Refs, not state: the rAF loop must read the live value without being torn
  // down and rebuilt on every change.
  const workerReadyRef = useRef(false);
  const workerBusyRef = useRef(false);
  const lastSpokenRef = useRef<Map<string, number>>(new Map());
  const lastAnnounceRef = useRef(0);
  /** Frame-to-frame identity, so repeats debounce per object as CLAUDE.md asks. */
  const trackerRef = useRef(new Tracker());
  const darkSinceRef = useRef<number | null>(null);
  const lastDarkWarnRef = useRef(0);
  const cameraDownSinceRef = useRef<number | null>(null);
  const lastCameraWarnRef = useRef(0);
  const lastSlowWarnRef = useRef(0);
  /** True once a real sensor reading has arrived; false means pitch is the fallback. */
  const tiltMeasuredRef = useRef(false);
  /** Exactly what was last said, so the repeat zone can replay it verbatim. */
  const lastUtteranceRef = useRef<{ clips: string[]; tone: boolean; pan: number } | null>(null);
  /** Wall-clock time an in-flight urgent tone+warning finishes; scanPath waits rather than cutting it off. */
  const urgentUntilRef = useRef(0);
  /** True while a deferred scanPath retry is already queued, so repeated taps don't stack timers. */
  const scanDeferredRef = useRef(false);
  /** Latest tracked frame, so the path scan describes now and not a memory. */
  const lastTracksRef = useRef<Track[]>([]);
  /**
   * The track currently being announced, so several objects in the corridor
   * do not make the target flicker between them frame to frame — that reads
   * as the app being confused rather than the street being busy. Cleared
   * when the locked track leaves the corridor.
   */
  const lockedTrackIdRef = useRef<number | null>(null);
  /** When the lock-on sound last played, so it cannot become a stutter. */
  const lastFocusRef = useRef(0);
  /** Live camera pose. Refs so the message handler always reads current values. */
  const pitchRef = useRef(DEFAULT_PITCH_DEG);
  const frameSizeRef = useRef({ w: REQUEST_W, h: REQUEST_H });
  /** Guards the mount-time auto-start against React StrictMode's double effect invoke in dev. */
  const autoStartedRef = useRef(false);
  /** A camera this screen opened itself (deep link or the retry button); it owns and releases it. */
  const acquiredStreamRef = useRef<MediaStream | null>(null);
  /**
   * Whether anything is currently in the walking corridor. Drives the frame
   * rate: an empty corridor does not need to be looked at eleven times a
   * second. A ref, not state, because the rAF loop reads it every tick and must
   * not be rebuilt when it flips.
   */
  const corridorBusyRef = useRef(false);
  /** Latest inference duration, for the starved-loop check inside the rAF loop. */
  const inferenceMsRef = useRef(0);
  /**
   * Smoothed cost of a REAL inference, in ms, and when the worker last finished.
   * Together these are what pace the loop — see MAX_DUTY_CYCLE.
   *
   * Skipped frames are deliberately excluded from the average: they cost almost
   * nothing, so folding them in would report the model as cheap and wind the
   * dispatch rate back up, which is precisely backwards. A scene that goes
   * still should slow the loop down, not speed it up.
   */
  const smoothedInferenceRef = useRef(0);
  const lastCompletedRef = useRef(0);
  /** Rolling telemetry for the on-screen readout: how much work is being skipped. */
  const skipStatsRef = useRef({ skipped: 0, total: 0 });
  const [dutyInfo, setDutyInfo] = useState("");
  /** When detections last arrived, so a frozen overlay can be cleared rather than believed. */
  const lastDetectionRef = useRef(0);

  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState("model loading…");
  const [fps, setFps] = useState(0);
  const [inferenceMs, setInferenceMs] = useState(0);
  /** Live camera health, refreshed once a second by the rAF loop. */
  const [camInfo, setCamInfo] = useState("camera: opening…");
  /** Name + distance, nearest first — computed in the message handler, where
   *  reading the pose refs is legitimate. */
  const [sightings, setSightings] = useState<
    { name: string; distance: number; reliable: boolean }[]
  >([]);
  /**
   * What the lock-on overlay draws: the tracks in the latest frame, the one
   * that is locked, and the frame size those boxes are measured in.
   *
   * All three captured together, in the same message handler that picks the
   * target. Reading the frame size from its ref at render time instead would
   * let a camera that changed resolution mid-run pair new dimensions with old
   * boxes for a frame — every bracket drawn in the wrong place, briefly, which
   * is exactly the kind of thing this overlay exists to rule out.
   *
   * Null while the preview is off (SHOW_PREVIEW), so nothing is computed or
   * painted over a screen that is deliberately black.
   */
  const [overlay, setOverlay] = useState<{
    frame: { width: number; height: number };
    tracks: OverlayTrack[];
    lockedId: number | null;
  } | null>(null);
  const [tilt, setTilt] = useState<number | null>(null);
  const [error, setError] = useState<string>("");
  /**
   * Where the previous run died, if it did. Read once on mount, before anything
   * this run does can overwrite it. An OOM kill leaves no error and no log, so
   * without this the phone reports nothing at all.
   */
  const [crashedAt] = useState<string | null>(() =>
    typeof window === "undefined" ? null : takeCrashStage(),
  );

  /**
   * Decodes every phrase into the SHARED context. The mode menu already created
   * it and may already have decoded these; loadAllClips skips what it has, so
   * entering a mode costs no second decode and never a second AudioContext —
   * iOS tolerates very few of those.
   */
  async function loadPhrases() {
    const { ok, failed: bad } = await loadAllClips();
    setReady(ok);
    setFailed(bad);
  }

  /** Pose at this instant: measured tilt, and the camera's true frame size. */
  function currentPose(): CameraPose {
    return {
      frameWidth: frameSizeRef.current.w,
      frameHeight: frameSizeRef.current.h,
      pitchDeg: pitchRef.current,
      cameraHeightM: CAMERA_HEIGHT_M,
      // Carried into the estimate rather than checked at the point of speech.
      // distance.ts can do something better than go quiet when this is false:
      // the size prior is pitch-independent, so a phone with no orientation
      // sensor still gets a real number for anything it has a prior for.
      pitchMeasured: tiltMeasuredRef.current,
    };
  }

  /**
   * The single object of attention this frame, or null when the corridor is
   * empty.
   *
   * "One object at a time": the announcement commits to one track and holds
   * it, and the proximity tone and the spoken warning describe the same
   * object — several objects in the corridor do not make the target flicker
   * between them, which reads as the app being confused rather than the
   * street being busy. The lock breaks only when the locked track leaves the
   * corridor, stops being announceable (drifted out of range), or something
   * strictly more urgent arrives.
   */
  function pickTarget(tracks: Track[], pose: CameraPose): Track | null {
    // Read BEFORE the staleness check below can clear the lock. Comparing
    // against a value that check already nulled would report "attention
    // moved" every time the SAME object merely drifted out of announceable
    // range and back, which is the one case that is not a new acquisition.
    const previousLockId = lockedTrackIdRef.current;

    const inCorridor = tracks.filter((t) => {
      const centreX = (t.x + t.w / 2) / pose.frameWidth;
      return centreX >= CORRIDOR_MIN && centreX <= CORRIDOR_MAX;
    });
    if (inCorridor.length === 0) {
      lockedTrackIdRef.current = null;
      return null;
    }

    // A lock that has gone silent (the object drifted past the announceable
    // range, or became unmeasurable) must not silence the object behind it.
    const locked = inCorridor.find((t) => t.id === lockedTrackIdRef.current);
    if (locked && !canAnnounce(locked, pose)) lockedTrackIdRef.current = null;

    // Tracks arrive sorted by time-to-contact, so the first one in the
    // corridor is the most imminent — not the nearest. A parked car two
    // metres to the side is less pressing than a cyclist six metres out
    // closing fast, and only a time ranking can express that.
    const soonest = inCorridor[0];
    const held = inCorridor.find((t) => t.id === lockedTrackIdRef.current);

    // Preempt only for a strictly more urgent object — or, within the same
    // band, for one meaningfully closer to contact. Two objects in the same
    // band do not make the announcement hop between them every frame, but a
    // commitment must never cost a genuinely imminent hazard: a car closing
    // fast half a metre in front of the locked pole gets the channel.
    const heldRank = held ? urgencyRank(held, pose) : Infinity;
    const soonestRank = urgencyRank(soonest, pose);
    const preempt =
      !held ||
      soonestRank < heldRank ||
      (soonestRank === heldRank && soonest.ttcS < held.ttcS * 0.7);
    const target = preempt ? soonest : held;
    lockedTrackIdRef.current = target.id;

    // The sound of attention MOVING, not of attention continuing — it fires on
    // acquisition only, so holding one object stays silent and the blip always
    // means "I have switched to something new".
    //
    // It runs here rather than in announce() on purpose: this is the frame the
    // detector actually commits, and announce() may then hold the words back
    // for up to several seconds behind the per-track debounce. Those are the
    // seconds when a user who cannot see the screen has no way to tell a
    // working detector from a dead one, and this is what fills them.
    if (target.id !== previousLockId) {
      const since = nowMs();
      if (since - lastFocusRef.current >= FOCUS_MIN_GAP_MS) {
        lastFocusRef.current = since;
        playFocus(panFor(target, pose));
      }
    }
    return target;
  }

  /**
   * Announces the nearest obstacle in the walking corridor.
   *
   * The sentence is chosen by announcementFor(), which refuses to speak a number
   * when the geometry cannot support one — a screen-filling wall gets an urgent
   * tone and "маш ойрхон", never a fabricated "about one metre".
   *
   * Nearest is by ESTIMATED metres, and an unmeasurable close object carries
   * VERY_CLOSE_M, so it sorts ahead of everything measured. That ordering is the
   * point: the object too close to measure is the one about to be walked into.
   *
   * Debounce is keyed on the whole sequence, so a steady approach does not repeat
   * the same sentence, but a change in name or distance does get through.
   *
   * The target arrives already picked by pickTarget(), so the tone, the readout
   * and this warning all describe the same single object.
   */
  const announce = useCallback((target: Track | null, pose: CameraPose) => {
    if (!target) return;
    const now = nowMs();
    if (now - lastAnnounceRef.current < MIN_ANNOUNCE_GAP_MS) return;

    const estimate = { metres: target.metres, reliable: target.reliable };
    const bucket = distanceBucket(estimate);
    const { tone, clips } = announcementForTrack(target, pose);
    if (!tone && clips.length === 0) return;

    // Not seen for long enough to be believed yet. See CONFIRM_HITS: one frame
    // of a zero-shot detector is not evidence, and the cost of waiting for two
    // more is a third of a second against the cost of naming the wrong thing to
    // someone who cannot look up and check.
    if (target.hits < (tone ? CONFIRM_HITS_URGENT : CONFIRM_HITS)) return;

    // Drop any clip that failed to decode rather than the whole warning: losing
    // the object's name should not cost the user the distance too.
    //
    // No pitch gate here any more. It used to strip every distance clip when
    // the tilt sensor was silent, which was right about the danger and far too
    // blunt about the remedy — it silenced distances the size prior could have
    // measured perfectly well. estimateObjectDistance() now makes that call
    // per object, with the geometry in front of it, and marks anything it
    // cannot stand behind as unreliable so announcementFor() omits the number.
    const available = clips.filter((id) => hasClip(id));
    if (!tone && available.length === 0) return;

    // Keyed on the TRACK, as CLAUDE.md asks — not on the words. Keying on the
    // sentence silenced two different lamp posts that happened to be the same
    // distance away, and re-announced one lamp post the moment its estimate
    // crossed a rounding boundary.
    const key = `${target.id}`;
    if (now - (lastSpokenRef.current.get(key) ?? -Infinity) < BUCKET_DEBOUNCE_MS[bucket]) return;

    lastAnnounceRef.current = now;
    lastSpokenRef.current.set(key, now);

    // Panned to where the object actually is. Direction arrives WITH the name
    // rather than after it, which is the whole point — the spoken left/right
    // clips cost half a second each out of a 1.5s budget.
    const pan = panFor(target, pose);
    lastUtteranceRef.current = { clips: available, tone, pan };
    const occupiedS = speak(available, tone, pan);

    // Only an urgent (toned) warning blocks a path check — a routine "car,
    // approximately four metres" is not safety-critical enough to make the
    // user wait for an answer to "where's the gap".
    if (tone) urgentUntilRef.current = now + occupiedS * 1000;
  }, []);

  /**
   * Describe where the gap is.
   *
   * The app otherwise only ever says what is in the way, never where there is
   * room — which is half the information a person actually walking needs.
   *
   * Describes, never instructs: "the left side is clear" is a fact the user
   * weighs against everything the camera cannot see. "Go left" would be the app
   * steering someone through a world it only partly perceives, and CLAUDE.md
   * rules that out for good reason.
   */
  function scanPath() {
    // An urgent tone+warning is still occupying the channel. Cutting it off
    // for a path check — whether the tap was deliberate or the user's grip
    // brushed the huge middle hit-zone while an obstacle warning was firing —
    // is exactly backwards: the thing already playing is the more urgent
    // fact. Let it finish, then answer a beat late rather than never (no
    // silent failures).
    const wait = urgentUntilRef.current - nowMs();
    if (wait > 0) {
      if (!scanDeferredRef.current) {
        scanDeferredRef.current = true;
        setTimeout(() => {
          scanDeferredRef.current = false;
          scanPath();
        }, wait + SCAN_DEFER_BUFFER_MS);
      }
      return;
    }

    const tracks = lastTracksRef.current;
    const pose = currentPose();
    const dir = clearestDirection(tracks, pose);
    stopAll();
    if (!dir) {
      playSequence(["no_path"].filter(hasClip));
      return;
    }
    playSequence([dir, "clear"].filter(hasClip), {
      // Panned to the side being described, so the direction is audible before
      // the word finishes.
      pan: dir === "left" ? -0.6 : dir === "right" ? 0.6 : 0,
    });
  }

  /**
   * Repeat the last warning verbatim.
   *
   * Audio has no scrollback. A bus passes, the user looks away for a moment,
   * and the announcement is simply gone — so this deliberately bypasses both
   * the 1.5s gap and the per-class debounce: it is an explicit request, not the
   * detector repeating itself.
   */
  function repeatLast() {
    const last = lastUtteranceRef.current;
    if (!last) {
      playSequence(["error"].filter(hasClip), { interrupt: true });
      return;
    }
    stopAll();
    speak(last.clips, last.tone, last.pan);
  }

  async function start() {
    try {
      setError("");

      mark("mount");

      // The shared context. The menu already created it inside the tap that
      // launched this mode, so this returns that instance and resumes it —
      // it does not build a second one. Still called from a gesture, because
      // deep-linking straight into a mode must also work.
      audioContext();
      mark("audio-context");

      // Must be asked for inside the gesture. Without it the pitch is a guess,
      // and a guessed pitch is the single largest source of distance error.
      if (await requestTiltPermission()) {
        window.addEventListener("deviceorientation", (ev: DeviceOrientationEvent) => {
          const pitch = pitchFromBeta(ev.beta);
          if (pitch === null) return;
          // Low-passed, because this sensor is noisy and distance is far more
          // sensitive to it than it looks: lib/distance.ts puts 5 degrees of
          // pitch error at ~21% of distance error, so raw sample-to-sample
          // jitter of a couple of degrees is what makes a stationary wall
          // announce three different distances. The first real reading snaps
          // rather than easing, so the 20-degree fallback is not smeared into
          // the first few seconds of measurements.
          pitchRef.current = tiltMeasuredRef.current
            ? pitchRef.current * (1 - PITCH_SMOOTHING) + pitch * PITCH_SMOOTHING
            : pitch;
          tiltMeasuredRef.current = true;
          setTilt(pitchRef.current);
        });
      }

      // The menu opened the camera inside ITS tap gesture and hands the stream
      // over — iOS Safari will not show the permission prompt from the mount
      // effect that calls this. The fallback covers a deep link straight into
      // this screen and the Эхлүүлэх retry button, both of which have a real
      // gesture of their own (or none, in which case the timeout reports it).
      let stream = initialStream ?? null;
      if (!stream) {
        stream = await openCamera();
        // Acquired here: this screen owns it and releases it on unmount.
        acquiredStreamRef.current = stream;
      }

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
        // The camera can ignore the requested size; boxes are in ITS pixels.
        frameSizeRef.current = {
          w: video.videoWidth || REQUEST_W,
          h: video.videoHeight || REQUEST_H,
        };
      }

      mark("camera-open");
      setRunning(true);

      // After the video is up: the picture should not wait on audio decoding.
      await loadPhrases();
      mark("phrases-decoded");

      // CLAUDE.md: every state change must be audible. A previous run that died
      // silently is a state change the user has no other way to notice — and the
      // clips only exist now that loadPhrases has run.
      if (crashedAt) playSequence(["error"]);
    } catch (e) {
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      // CLAUDE.md: no silent failures. A camera-permission denial or a missing
      // device otherwise leaves only the on-screen red text — invisible to
      // the person this app is for.
      playSequence(["error"].filter(hasClip), { interrupt: true });
    }
  }

  /**
   * Requests the camera the moment this screen mounts, rather than making the
   * user find and tap a second, invisible "Эхлүүлэх" button. Entering Walk
   * mode already IS the user's request to start; the tile tap in the menu is
   * the gesture that covers the permission prompt.
   *
   * The "Эхлүүлэх" button stays in the tree as the retry path — if start()
   * fails (permission denied, no camera), `running` never flips true, so the
   * button still renders and the user can tap it again after fixing whatever
   * blocked it.
   */
  useEffect(() => {
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    void start();
    // start() only closes over refs and stable setters, so it does not need
    // to be in the dependency array — this must run exactly once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Release a camera this screen opened itself (deep link, retry). A stream
   * handed over by the menu belongs to the menu, which stops it on exit.
   */
  useEffect(() => {
    return () => {
      const own = acquiredStreamRef.current;
      if (own) for (const track of own.getTracks()) track.stop();
    };
  }, []);

  useEffect(() => {
    if (!running) return;

    // Relative specifier, not the @/ alias: bundlers only detect a worker when
    // new URL() gets a literal relative path.
    const worker = new Worker(new URL("../../lib/vision.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    mark("worker-spawned");

    /**
     * How hard the worker is allowed to push, decided HERE because the evidence
     * lives in localStorage and a worker cannot read it.
     *
     * On iOS a tab killed for memory reloads with no error, no log and no
     * exception — the app comes back on the home menu and the user tries again,
     * which is the loop reported from the phone. `crashedAt` is the only trace
     * that run left, so if it died with the model in memory the next attempt is
     * the cheap configuration, and that choice is pinned rather than re-derived:
     * a lean run SUCCEEDS, which clears the breadcrumb, which would otherwise
     * send the launch after it straight back into the crash.
     */
    const plan = planFor({ pinned: pinnedPlan(), crashStage: crashedAt });
    if (plan.id !== "full") pinPlan(plan.id);
    worker.postMessage({ type: "start", plan });

    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;

      if (msg.type === "progress") {
        const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
        const pct = msg.total > 0 ? Math.round((msg.loaded / msg.total) * 100) : 0;
        setModelStatus(
          msg.total > 0
            ? `model ${pct}% (${mb(msg.loaded)}/${mb(msg.total)} MB)`
            : `model ${mb(msg.loaded)} MB`,
        );
        // The stage most likely to be killed: 37 MB arriving into memory while
        // the camera and 49 decoded clips are already resident.
        mark(msg.loaded === msg.total ? "model-session" : "model-downloading", `${pct}%`);
        return;
      }

      if (msg.type === "ready") {
        workerReadyRef.current = true;
        setModelStatus(`model ready · ${msg.backend} · ${msg.plan}`);
        mark("model-ready", msg.backend);
        // Pin what actually WORKED, not what was asked for. The worker falls
        // back on its own when WebGPU wedges, and that fallback is the most
        // memory-expensive path there is — two sessions built back to back.
        // Recording the outcome means the next launch goes straight to the
        // configuration that survived instead of paying for the discovery again.
        if (msg.plan !== "full") pinPlan(msg.plan);
        return;
      }

      if (msg.type === "error") {
        workerBusyRef.current = false;
        setError(msg.message);
        return;
      }

      workerBusyRef.current = false;
      inferenceMsRef.current = msg.inferenceMs;
      lastDetectionRef.current = nowMs();
      lastCompletedRef.current = nowMs();
      setInferenceMs(msg.inferenceMs);

      // Only real inferences feed the pacing average; see smoothedInferenceRef.
      if (!msg.skipped) {
        smoothedInferenceRef.current =
          smoothedInferenceRef.current === 0
            ? msg.inferenceMs
            : smoothedInferenceRef.current * (1 - INFERENCE_SMOOTHING) +
              msg.inferenceMs * INFERENCE_SMOOTHING;
      }
      const stats = skipStatsRef.current;
      stats.total++;
      if (msg.skipped) stats.skipped++;
      // Survived download, session init, warm-up and a real frame. Anything
      // after this point is steady-state, so stop blaming startup for it.
      clearMark();

      const pose = currentPose();

      // Associate this frame's boxes with the previous frame's objects. Doing
      // it here rather than in announce() means the tone, the readout and the
      // warning all describe the same tracked objects.
      const now = nowMs();
      const tracks = trackerRef.current.update(
        msg.boxes.map((b) => {
          const estimate = estimateObjectDistance(b, b.className, pose);
          return { ...b, metres: estimate.metres, reliable: estimate.reliable };
        }),
        now,
      );

      // ONE object of attention per frame, shared by the proximity tone and
      // the spoken warning, so the user hears one coherent story instead of
      // several objects competing for the channel. pickTarget() holds the
      // lock on one track until it leaves the corridor or something strictly
      // more urgent arrives — see the function for the full rule.
      const target = pickTarget(tracks, pose);

      lastTracksRef.current = tracks;

      // The visible half of the lock. Fed from the SAME `tracks` and the SAME
      // target pickTarget just committed to, so the bracket on screen can
      // never disagree with the object being spoken about.
      if (SHOW_PREVIEW) {
        setOverlay({
          frame: { width: pose.frameWidth, height: pose.frameHeight },
          lockedId: target?.id ?? null,
          tracks: tracks.map((t) => ({
            id: t.id,
            x: t.x,
            y: t.y,
            w: t.w,
            h: t.h,
            className: t.className,
            metres: t.metres,
            reliable: t.reliable,
            hits: t.hits,
            score: t.score,
            classConfidence: t.classConfidence,
            trusted: nameIsTrusted(t),
          })),
        });
      }

      // Something to watch: go back to the faster cadence. Set from the target
      // rather than the raw box list so the rate follows what the app is
      // actually paying attention to, not anything that happened to be in shot.
      corridorBusyRef.current = target !== null;

      updateProximity(
        target && Number.isFinite(target.metres) ? target.metres : null,
        target ? panFor(target, pose) : 0,
      );

      // Low light. Sustained, not a passing shadow, and re-stated rarely: it is
      // a condition the user must act on (torch, or stop relying on the app),
      // not an event. Announced even though nothing was detected — especially
      // then, because "nothing detected" is exactly what darkness looks like.
      if (msg.luma < DARK_LUMA) {
        darkSinceRef.current ??= now;
        if (
          now - darkSinceRef.current > DARK_SUSTAIN_MS &&
          now - lastDarkWarnRef.current > DARK_REPEAT_MS
        ) {
          lastDarkWarnRef.current = now;
          playSequence(["dark"].filter(hasClip), { interrupt: true });
        }
      } else {
        darkSinceRef.current = null;
      }

      setSightings(
        msg.boxes
          .map((b) => {
            const estimate = estimateObjectDistance(b, b.className, pose);
            return { name: b.className, distance: estimate.metres, reliable: estimate.reliable };
          })
          .sort((a, z) => a.distance - z.distance),
      );
      announce(target, pose);
    };

    worker.onerror = (ev) => setError(`worker: ${ev.message}`);

    // Captured now: the ref may point elsewhere by the time cleanup runs.
    const tracker = trackerRef.current;
    let rafId = 0;
    let drawn = 0;
    let windowStart = nowMs();
    let lastDispatchMs = 0;

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const now = nowMs();

      const video = videoRef.current;
      // Rate-limited rather than "whenever the worker is free". See
      // FRAME_INTERVAL_ACTIVE_MS: running inference back to back is what made
      // this app a battery hog, and nothing needed it to.
      const busy = corridorBusyRef.current;
      const interval = busy ? FRAME_INTERVAL_ACTIVE_MS : FRAME_INTERVAL_IDLE_MS;

      // The rest owed to the CPU after the last inference, so that running the
      // network occupies at most MAX_DUTY_CYCLE of wall-clock time. On a fast
      // device this is ~0 and the fixed interval above still governs; on a slow
      // one it is what stops the phone inferring continuously.
      const duty = busy ? MAX_DUTY_CYCLE : MAX_DUTY_CYCLE_IDLE;
      const restMs = smoothedInferenceRef.current * ((1 - duty) / duty);

      // HAVE_CURRENT_DATA. Below this there is no frame to capture.
      if (
        video &&
        video.readyState >= 2 &&
        workerReadyRef.current &&
        !workerBusyRef.current &&
        now - lastDispatchMs >= interval &&
        now - lastCompletedRef.current >= restMs
      ) {
        lastDispatchMs = now;
        // Counts frames actually SENT to the detector, which is the rate that
        // matters. It used to count rAF ticks instead, so it read ~60 on every
        // device and the starved-loop warning below could never fire.
        drawn++;

        // Re-read the real capture size every dispatch. start() reads it once,
        // right after play() resolves — but play() can resolve before the
        // metadata lands, leaving videoWidth at 0 and the fallback 640x480 in
        // place. If the camera then delivers 1280x720, every box is scaled
        // against the wrong frame and EVERY DISTANCE IS WRONG, silently. Two
        // integer reads a frame is a cheap price for that not being possible.
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          frameSizeRef.current = { w: video.videoWidth, h: video.videoHeight };
        }
        // Claim the slot before the async capture, so the next tick cannot
        // also claim it. Frames arriving while busy are never even created —
        // nothing queues.
        workerBusyRef.current = true;
        // Straight from the video element: no intermediate canvas, which
        // removes a full-frame draw and a copy from every single tick.
        createImageBitmap(video)
          .then((bitmap) => worker.postMessage({ type: "frame", bitmap }, [bitmap]))
          .catch(() => {
            workerBusyRef.current = false;
          });
      }

      const elapsed = now - windowStart;
      if (elapsed >= 1000) {
        const rate = Math.round((drawn * 1000) / elapsed);
        setFps(rate);
        drawn = 0;
        windowStart = now;

        // Is the camera actually delivering? "Permission granted but nothing
        // happens" is indistinguishable from "working but nothing detected"
        // without this, and there is no console on a phone to check it from.
        // live/ended comes from the track itself, so a camera revoked or
        // grabbed by another app shows up here rather than as mysterious quiet.
        const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()[0];
        setCamInfo(
          !video || !video.srcObject
            ? "camera: no stream"
            : `camera: ${video.videoWidth}x${video.videoHeight} ${track?.readyState ?? "?"}` +
              `${video.paused ? " PAUSED" : ""} rs${video.readyState}`,
        );

        // Duty cycle and skip rate, on screen because there is nowhere else to
        // put them. These are the two numbers that decide whether this app
        // drains a phone in an hour or a morning, and neither is visible from
        // the frame rate alone: 5fps at 95% duty and 5fps at 40% duty look
        // identical to the user and differ by half the battery.
        const stats = skipStatsRef.current;
        const inferMs = smoothedInferenceRef.current;
        const period = stats.total > 0 ? elapsed / stats.total : 0;
        const dutyPct = period > 0 ? Math.round((inferMs / period) * 100) : 0;
        const skipPct = stats.total > 0 ? Math.round((stats.skipped / stats.total) * 100) : 0;
        setDutyInfo(`duty ~${dutyPct}% · skip ${skipPct}% · infer ${inferMs.toFixed(0)}ms`);
        skipStatsRef.current = { skipped: 0, total: 0 };

        // A bracket left painted over a dead detector is worse than no bracket
        // at all: it says "still locked on" while nothing is being detected,
        // to the one person on the scene who could otherwise notice. Cleared
        // well outside the idle cadence, so throttling never blanks a live one.
        if (now - lastDetectionRef.current > OVERLAY_STALE_MS) setOverlay(null);

        // A starved loop means warnings land after the obstacle rather than
        // before it. On screen this is just a number; the user needs to hear
        // that the app has become slower than they are walking.
        //
        // Judged on how long inference TAKES, not on the achieved frame rate:
        // now that the loop throttles itself on purpose, a low rate is usually
        // the app saving battery over an empty pavement, and warning about
        // that would be crying wolf. A single frame taking longer than the
        // budget is unambiguous — the device genuinely cannot keep up.
        if (
          inferenceMsRef.current > SLOW_INFERENCE_MS &&
          workerReadyRef.current &&
          now - lastSlowWarnRef.current > SLOW_REPEAT_MS
        ) {
          lastSlowWarnRef.current = now;
          playSequence(["slow"].filter(hasClip), { interrupt: true });
        }

        // Camera aim. Only checked when the tilt is actually measured — with
        // permission denied, pitchRef holds a constant fallback, and warning
        // off a constant would mean warning forever or never.
        if (tiltMeasuredRef.current) {
          if (pitchRef.current > CAMERA_DOWN_DEG) {
            cameraDownSinceRef.current ??= now;
            if (
              now - cameraDownSinceRef.current > CAMERA_DOWN_SUSTAIN_MS &&
              now - lastCameraWarnRef.current > CAMERA_DOWN_REPEAT_MS
            ) {
              lastCameraWarnRef.current = now;
              playSequence(["camera_down"].filter(hasClip), { interrupt: true });
            }
          } else {
            cameraDownSinceRef.current = null;
          }
        }
      }
    };


    /**
     * Hold the screen awake for as long as this mode is running.
     *
     * Re-acquired on visibilitychange because the lock is dropped whenever the
     * page is hidden — a phone call, a notification, or the user switching apps
     * silently ends it, and without re-acquiring the app would run once and
     * then quietly stop on the next return.
     */
    let wakeLock: WakeLockLike | null = null;
    let releasedByUs = false;

    const acquireWakeLock = async () => {
      if (releasedByUs || document.visibilityState !== "visible") return;
      try {
        wakeLock = (await requestWakeLock()) ?? null;
      } catch {
        // Denied or unsupported. The screen will sleep; the degraded-rate
        // warning below is what the user hears when that starts to bite.
        wakeLock = null;
      }
    };
    void acquireWakeLock();

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void acquireWakeLock();
      // Coming back from a suspended tab: say so. The user cannot see that the
      // app was paused, and resuming silently would let them assume the last
      // few seconds of quiet meant a clear path.
      playSequence(["ready"].filter(hasClip), { interrupt: true });
    };
    document.addEventListener("visibilitychange", onVisibility);

    /**
     * Battery. CLAUDE.md: announce degradation.
     *
     * This app is what a user is relying on to cross a road; a phone that dies
     * mid-route strands them somewhere they cannot see. Warned once on crossing
     * the threshold, not repeatedly — nagging costs the speech channel that
     * obstacles need.
     *
     * Absent on iOS Safari, which has no Battery API. Guarded rather than
     * polyfilled: there is no way to know, and inventing a level would be worse
     * than staying quiet.
     */
    let battery: BatteryLike | null = null;
    let warnedLowBattery = false;
    const onBatteryChange = () => {
      if (!battery || battery.charging || warnedLowBattery) return;
      if (battery.level <= BATTERY_LOW) {
        warnedLowBattery = true;
        playSequence(["battery_low"].filter(hasClip), { interrupt: true });
      }
    };
    void getBattery()?.then((b) => {
      battery = b;
      b.addEventListener("levelchange", onBatteryChange);
      b.addEventListener("chargingchange", onBatteryChange);
      onBatteryChange();
    });

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      worker.terminate();
      workerRef.current = null;
      workerReadyRef.current = false;
      workerBusyRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      releasedByUs = true;
      void wakeLock?.release().catch(() => {
        // Already released with the page; nothing to undo.
      });
      battery?.removeEventListener("levelchange", onBatteryChange);
      battery?.removeEventListener("chargingchange", onBatteryChange);
      tracker.reset();
      // The tone lives on the shared AudioContext, so it would keep sounding
      // over the menu after this screen is gone.
      stopProximity();
    };
    // speak/play only touch refs, so the loop does not need rebuilding when
    // they change identity.
    // crashedAt is read once at mount and never set again, so it cannot
    // re-trigger this; it is listed because the plan is derived from it.
  }, [running, announce, crashedAt]);

  return (
    <div className="w-screen h-screen bg-black relative">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover"
      />

      {/* The lock, made visible. Sits above the video and below every tap
          zone, and is pointer-events-none throughout, so the three gesture
          regions keep the whole screen to themselves. */}
      {running && overlay && (
        <TargetOverlay
          frame={overlay.frame}
          tracks={overlay.tracks}
          lockedId={overlay.lockedId}
          corridor={{ min: CORRIDOR_MIN, max: CORRIDOR_MAX }}
        />
      )}

      {/* Covers the preview rather than hiding the element — see SHOW_PREVIEW.
          pointer-events-none so the tap zones underneath keep working, and it
          sits before them in the DOM so it can never paint over the readout. */}
      {!SHOW_PREVIEW && (
        <div aria-hidden="true" className="absolute inset-0 bg-black pointer-events-none" />
      )}

      {/* Back to the menu: the top 15% of every mode screen, in the same place
          in every mode, so it can be found without looking. A real <button> so
          VoiceOver reaches it by swipe; z-20 so it sits above the start overlay
          and the readout rather than competing with them for the tap. */}
      <button
        onClick={onBack}
        aria-label="Цэс рүү буцах"
        className="absolute top-0 left-0 right-0 h-[15dvh] z-20"
      />

      {/* The middle of the screen — by far the largest target, and the only
          region a finger lands on without aiming — asks where the gap is.
          Three zones the user can find by feel alone: top edge goes back,
          middle asks about the path, bottom edge repeats. */}
      {running && (
        <button
          onClick={scanPath}
          aria-label="Зам шалгах"
          className="absolute top-[15dvh] bottom-[15dvh] left-0 right-0 z-10"
        />
      )}

      {/* Repeat, mirroring the back zone at the top: top edge goes back, bottom
          edge repeats. Two landmarks findable by feel on a screen that cannot
          be seen, and a real <button> so VoiceOver reaches it by swipe.
          A two-finger tap would have been faster but VoiceOver claims that
          gesture for pause/resume, so it would never reach the app. */}
      {running && (
        <button
          onClick={repeatLast}
          aria-label="Дахин хэлэх"
          className="absolute bottom-0 left-0 right-0 h-[15dvh] z-20"
        />
      )}

      {!running && (
        <button
          onClick={start}
          aria-label="Эхлүүлэх"
          className="absolute inset-0 w-full h-full text-white text-4xl font-bold"
        >
          Эхлүүлэх
        </button>
      )}

      {/* System readout only. Phrase names are not shown; there is no console
          on a phone, so this is the only place status can surface. Pushed below
          the back zone so it cannot swallow that tap. */}
      {running && (
        <div
          aria-hidden="true"
          className="absolute top-[16dvh] left-3 right-3 text-green-400 text-sm font-mono bg-black/70 px-2 py-1 rounded leading-tight"
        >
          <p>
            {fps} fps · {inferenceMs} ms · tilt{" "}
            {tilt === null ? "NOT MEASURED (no distances)" : `${tilt.toFixed(0)}°`}
          </p>
          <p>{camInfo}</p>
          <p>{dutyInfo}</p>
          <p>
            {modelStatus} · {ready.length}/{PHRASES.length} audio
            {failed.length > 0 && ` · FAILED ${failed.length}`}
          </p>
          <p>
            {sightings.length === 0
              ? "—"
              : sightings
                  .slice(0, 4)
                  .map((s) => {
                    // An unreliable estimate shows as "close?" or "??", never a
                    // number — the debug readout should not claim precision the
                    // warning itself refuses to speak.
                    if (!s.reliable) return `${s.name || "?"} ${s.distance <= 1 ? "close?" : "??"}`;
                    return `${s.name || "?"} ${s.distance === Infinity ? "∞" : `${s.distance.toFixed(1)}m`}`;
                  })
                  .join(" · ")}
          </p>
        </div>
      )}

      {/* The previous run died without throwing — almost always an iOS memory
          kill, which produces no error event and no log. This is the only
          surface that can report it. */}
      {crashedAt && (
        <p
          aria-hidden="true"
          className="absolute bottom-20 left-4 right-4 text-amber-300 text-sm font-mono bg-black/80 p-3 rounded"
        >
          previous run died at: {crashedAt}
        </p>
      )}

      {error && (
        <p className="absolute bottom-4 left-4 right-4 text-red-400 text-sm bg-black/80 p-3 rounded">
          {error}
        </p>
      )}
    </div>
  );
}
