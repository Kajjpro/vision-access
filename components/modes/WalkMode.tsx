"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  audioContext,
  hasClip,
  loadAllClips,
  playSequence,
  playTone,
  stopAll,
  stopProximity,
  updateProximity,
} from "@/lib/audio";
import { clearMark, mark, takeCrashStage } from "@/lib/breadcrumb";
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

/** Per-class repeat window, by urgency. `far` is never announced at all. */
const BUCKET_DEBOUNCE_MS: Record<DistanceBucket, number> = {
  urgent: 2000,
  near: 4000,
  mid: 8000,
  far: Infinity,
};

/** Hard cap: one utterance per this window, whatever the bucket. */
const MIN_ANNOUNCE_GAP_MS = 1500;

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
 * Below this frame rate the loop is starved and warnings arrive late — which
 * for a walking user means they arrive after the obstacle.
 */
const SLOW_FPS = 6;
const SLOW_REPEAT_MS = 45_000;

/**
 * Horizontal position in the frame, as a stereo pan from -1 to 1.
 *
 * Announcements only fire for the walking corridor (the middle 50%), so this
 * lands inside roughly -0.5..0.5 in practice. That is deliberate: the point is
 * "slightly to your left", not a sound thrown into one ear.
 */
/** The one place a warning is actually emitted, so a repeat is byte-identical. */
function speak(clips: string[], tone: boolean, pan: number) {
  // Tone first, then the words behind it — stop, then why.
  const offset = tone ? playTone(pan) : 0;
  playSequence(clips, { offsetS: offset, pan });
}

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
 * iOS gates the orientation sensor behind an explicit grant that must be asked
 * for inside a user gesture. Returns false when unavailable, in which case the
 * pitch falls back to a constant and distances get much less accurate.
 */
type OrientationCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

async function requestTiltPermission(): Promise<boolean> {
  if (typeof DeviceOrientationEvent === "undefined") return false;
  const ctor = DeviceOrientationEvent as OrientationCtor;
  if (typeof ctor.requestPermission !== "function") return true; // Android: no gate
  try {
    return (await ctor.requestPermission()) === "granted";
  } catch {
    return false;
  }
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
 * `beta` is the front-to-back tilt: 90 with the phone held upright, 0 laid flat.
 * The rear camera points level at beta 90, so downward pitch is 90 - beta.
 */
function pitchFromBeta(beta: number | null): number | null {
  if (beta === null || Number.isNaN(beta)) return null;
  return Math.min(80, Math.max(0, 90 - beta));
}

export default function WalkMode({ onBack }: { onBack: () => void }) {
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
  /** Latest tracked frame, so the path scan describes now and not a memory. */
  const lastTracksRef = useRef<Track[]>([]);
  /** Live camera pose. Refs so the message handler always reads current values. */
  const pitchRef = useRef(DEFAULT_PITCH_DEG);
  const frameSizeRef = useRef({ w: REQUEST_W, h: REQUEST_H });

  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState("model loading…");
  const [fps, setFps] = useState(0);
  const [inferenceMs, setInferenceMs] = useState(0);
  /** Name + distance, nearest first — computed in the message handler, where
   *  reading the pose refs is legitimate. */
  const [sightings, setSightings] = useState<
    { name: string; distance: number; reliable: boolean }[]
  >([]);
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
    };
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
   */
  const announce = useCallback((tracks: Track[], pose: CameraPose) => {
    const now = nowMs();
    if (now - lastAnnounceRef.current < MIN_ANNOUNCE_GAP_MS) return;

    // Tracks arrive sorted by time-to-contact, so the first one in the corridor
    // is the most urgent — not the nearest. A parked car two metres to the side
    // is less pressing than a cyclist six metres out closing fast, and only a
    // time ranking can express that.
    const target = tracks.find((t) => {
      const centreX = (t.x + t.w / 2) / pose.frameWidth;
      return centreX >= CORRIDOR_MIN && centreX <= CORRIDOR_MAX;
    });
    if (!target) return;

    const estimate = { metres: target.metres, reliable: target.reliable };
    const bucket = distanceBucket(estimate);
    const { tone: baseTone, clips: baseClips } = announcementFor(estimate, target.className);

    // Overhead hazards are the case a white cane cannot cover: it sweeps the
    // ground and passes under the branch, the tailgate, the scaffolding. They
    // have no ground contact, so distance.ts correctly refuses to measure them
    // and announcementFor() would say nothing at all — this is where the
    // warning has to come from instead. Always with the alarm.
    const overhead = isOverhead(target, pose);
    const clips = overhead ? ["overhead", target.className] : [...baseClips];
    const tone = overhead || baseTone;

    // "Машин" and "Машин ойртож байна" are different facts. The closing speed
    // was already being computed and thrown away; the word costs half a second
    // and is only spent when something is genuinely moving at the user.
    if (isApproaching(target)) clips.push("approaching");

    if (!tone && clips.length === 0) return;

    // Drop any clip that failed to decode rather than the whole warning: losing
    // the object's name should not cost the user the distance too.
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
    speak(available, tone, pan);
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
          pitchRef.current = pitch;
          tiltMeasuredRef.current = true;
          setTilt(pitch);
        });
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: REQUEST_W, height: REQUEST_H },
        audio: false,
      });

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
    }
  }

  useEffect(() => {
    if (!running) return;

    // Relative specifier, not the @/ alias: bundlers only detect a worker when
    // new URL() gets a literal relative path.
    const worker = new Worker(new URL("../../lib/vision.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    mark("worker-spawned");

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
        setModelStatus(`model ready · ${msg.backend}`);
        mark("model-ready", msg.backend);
        return;
      }

      if (msg.type === "error") {
        workerBusyRef.current = false;
        setError(msg.message);
        return;
      }

      workerBusyRef.current = false;
      setInferenceMs(msg.inferenceMs);
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

      // The continuous channel, updated every frame. The most urgent thing in
      // the walking corridor sets the pitch; nothing in the corridor is
      // silence. This runs regardless of the announcement debounce — the tone
      // is how the user tracks approach during the seconds when speech is not
      // allowed to fire, and it is the only honest cue at ranges where
      // lib/distance.ts refuses to state a number.
      const inCorridor = tracks.find((t) => {
        const centreX = (t.x + t.w / 2) / pose.frameWidth;
        return centreX >= CORRIDOR_MIN && centreX <= CORRIDOR_MAX;
      });

      lastTracksRef.current = tracks;

      updateProximity(
        inCorridor && Number.isFinite(inCorridor.metres) ? inCorridor.metres : null,
        inCorridor ? panFor(inCorridor, pose) : 0,
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
      announce(tracks, pose);
    };

    worker.onerror = (ev) => setError(`worker: ${ev.message}`);

    // Captured now: the ref may point elsewhere by the time cleanup runs.
    const tracker = trackerRef.current;
    let rafId = 0;
    let drawn = 0;
    let windowStart = nowMs();

    const tick = () => {
      rafId = requestAnimationFrame(tick);

      const video = videoRef.current;
      // HAVE_CURRENT_DATA. Below this there is no frame to capture.
      if (video && video.readyState >= 2) {
        drawn++;

        if (workerReadyRef.current && !workerBusyRef.current) {
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
      }

      const now = nowMs();
      const elapsed = now - windowStart;
      if (elapsed >= 1000) {
        const rate = Math.round((drawn * 1000) / elapsed);
        setFps(rate);
        drawn = 0;
        windowStart = now;

        // A starved loop means warnings land after the obstacle rather than
        // before it. On screen this is just a number; the user needs to hear
        // that the app has become slower than they are walking.
        if (
          rate < SLOW_FPS &&
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
  }, [running, announce]);

  return (
    <div className="w-screen h-screen bg-black relative">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover"
      />

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
            {fps} fps · {inferenceMs} ms · tilt {tilt === null ? "n/a" : `${tilt.toFixed(0)}°`}
          </p>
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
