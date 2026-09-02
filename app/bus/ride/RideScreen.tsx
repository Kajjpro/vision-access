"use client";

/**
 * Mode B — riding. Rebuilt on the gesture model.
 *
 * The user should never need to ask where they are. Stops are announced as they
 * pass; a long press gives the full status immediately, at any moment.
 *
 * THE COUNTDOWN IS GPS-BASED AND STAYS THAT WAY. It works in tunnels and dead
 * zones, which is exactly where a vehicle feed does not. Nothing on this screen
 * consults the live feed, and if one is ever opened it may cross-check but must
 * never override — GPS is what the user is actually sitting inside.
 *
 * The failure this screen is built around is SILENCE. To someone who cannot see
 * the counter, no announcement means "we have not arrived yet" — so a frozen
 * countdown reads exactly like a working one right up until they have ridden
 * past their stop. Every path that stops tracking says so.
 *
 * The counting is in lib/countdown/ — engine, geometry and ladder, all pure.
 * This file owns only what cannot be: geolocation, the wake lock, vibration,
 * and the audio queue.
 *
 * lib/transit/stop-matcher.ts used to do the counting and is now retired from
 * this path. It is deliberately NOT deleted: its 168 route/direction pair suite
 * is the only empirical evidence in the repository, and gps-sim.ts imports its
 * types. The engine replaced it because the matcher has no confidence concept —
 * only a binary `degraded` — which would leave the alight instruction as the
 * one announcement not governed by the confidence gate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CurrentOption, GestureSurface, type A11yOption } from "@/components/GestureSurface";
import { AudioQueue, type Announcement, type QueueEvent } from "@/lib/transit/audio-queue";
import { ManifestClipPlayer } from "@/lib/transit/clip-player";
import { announceStatus, announceTrackingDegraded, TTL, vibrationFor } from "@/lib/transit/announce";
import { clearHandoff, readHandoff, validateHandoff, type BusHandoff } from "@/lib/transit/handoff";
import {
  advanceManually, createEngine, onFix, onTick, remainingForAlighting, secondsToDestination,
  type EngineEvent, type EngineState,
} from "@/lib/countdown/engine";
import { StopChainGeometry, type GeometryStop } from "@/lib/countdown/geometry";
import { alightingAnnouncement, confidenceLost } from "@/lib/countdown/ladder";
import { createEarconPlayer } from "@/lib/transit/earcons";
import {
  armRecordingFromUrl, clearRecording, createRecorder, describeRecording, loadRecording,
  loadResumable, nullRecorder, RECORDING_FLAG, recordingFilename, type Recorder,
} from "@/lib/transit/recorder";
import {
  createBoardingState, onWaitingPosition, type BoardingState,
} from "@/lib/transit/boarding";
/**
 * `OrderedStop` still comes from stop-matcher, which is RETIRED from this
 * screen's runtime path but deliberately not deleted: its 168-pair suite is the
 * only empirical evidence in the repository, and gps-sim.ts imports its types.
 */
import type { OrderedStop } from "@/lib/transit/stop-matcher";
import { GESTURE, JOURNEY, RIDE, SCREEN } from "@/lib/ui/announcements";
import { useGestureNav } from "@/lib/ui/useGestureNav";
import type { ListOption } from "@/lib/ui/gesture-nav";
import type { AudioManifest, RouteStops, Stop } from "@/lib/transit/types";

type BatteryManager = { level: number; charging: boolean };
type NavigatorWithBattery = Navigator & { getBattery?: () => Promise<BatteryManager> };

type Action =
  | { kind: "destination"; index: number }
  | { kind: "advance" }
  | { kind: "record" }
  | { kind: "share" }
  | { kind: "finish" };



export function RideScreen({
  stops, routeStops, manifest,
}: { stops: Stop[]; routeStops: RouteStops; manifest: AudioManifest }) {
  const router = useRouter();
  const [handoff, setHandoff] = useState<BusHandoff | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [sequence, setSequence] = useState<OrderedStop[]>([]);
  const [destIndex, setDestIndex] = useState<number | null>(null);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const queueRef = useRef<AudioQueue | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const engineRef = useRef<EngineState | null>(null);
  const geometryRef = useRef<StopChainGeometry | null>(null);
  const boardingRef = useRef<BoardingState>(createBoardingState());
  /**
   * The count at the last thing SPOKEN, not at the last fix.
   *
   * The ladder compares against this to make a rung fire once. Comparing
   * against the last fix re-announces on every tick that holds the same value.
   */
  const lastSpokenRef = useRef<number | null>(null);
  const downgradeAnnouncedRef = useRef(false);
  /**
   * OBSERVER ONLY. Nothing downstream branches on it, nothing awaits it.
   * `nullRecorder` rather than null so a forgotten guard cannot start writing
   * during an ordinary journey.
   */
  const recorderRef = useRef<Recorder>(nullRecorder());
  /**
   * ARMED vs ACTIVELY RECORDING — deliberately two states, because they differ
   * exactly when it matters most.
   *
   * `armed` is the sessionStorage flag and survives a remount. `recordingActive`
   * mirrors whether a live Recorder exists, and does not. Driving the indicator
   * from `armed` meant ● REC lit up on the first touch after a remount while
   * `recorderRef` was still the null recorder — the indicator claiming a
   * recording that was not running, which is the one thing it must never do.
   */
  const [armed, setArmed] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  /**
   * Field-test controls are hidden unless explicitly opted into with ?record=1.
   *
   * They have no rendered Mongolian, so to an ordinary rider they would be
   * silent options in the swipe list — worse than absent ones.
   */
  const [showFieldTest, setShowFieldTest] = useState(false);

  /**
   * Read on the FIRST GESTURE, not in a mount effect.
   *
   * Same reason `loadHandoff` gives: sessionStorage does not exist during SSR,
   * so reading it in an effect renders once without it and again with it — and
   * the second render lands while the user may already be swiping.
   */
  const armFieldTest = useCallback(() => {
    const r = armRecordingFromUrl(window.location.search, sessionStorage);
    // Arming state only. The indicator follows the recorder, not the flag.
    if (r.show) { setShowFieldTest(true); setArmed(r.armed); }
  }, []);
  const watchRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const startedRef = useRef(false);

  const stopsById = useMemo(() => new Map(stops.map((s) => [s.id, s])), [stops]);
  const has = useCallback((key: string) => Boolean(manifest[key]), [manifest]);

  const note = useCallback((line: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 60));
  }, []);

  /** AudioContext.state, or "none" before the first gesture has built one. */
  const audioState = useCallback(() => ctxRef.current?.state ?? "none", []);

  /**
   * EVERY announcement goes through here, so nothing can be spoken — or lost —
   * without the trace knowing.
   *
   * The case this exists for is the one neither clock sees: the page is
   * running, fixes are arriving, the count is correct, the announcement is
   * built and queued — and the AudioContext is suspended, so it plays into
   * nothing. The rider hears the silence of a working journey between stops.
   * What would have been said is captured at the moment it is lost, because it
   * cannot be reconstructed afterwards.
   */
  const enqueue = useCallback((a: Announcement) => {
    const state = audioState();
    if (state !== "running") {
      recorderRef.current.silentPush(a.keys, a.label ?? "", state);
      note(`SILENT (audio ${state}): ${a.label ?? a.keys.join(" ")}`);
    }
    queueRef.current?.push(a);
  }, [audioState, note]);

  /**
   * Every vibrate call, with what the platform said about it.
   *
   * `navigator.vibrate` returns a boolean, and is absent entirely on some
   * platforms. Recording the return value per call is how the dry run answers
   * whether a haptic channel exists on THIS device — which decides whether §5
   * parallel channels is satisfiable at all when audio is dead.
   */
  const buzz = useCallback((pattern: number[]) => {
    if (typeof navigator.vibrate !== "function") {
      recorderRef.current.haptic(pattern, undefined);
      return;
    }
    let accepted = false;
    try { accepted = navigator.vibrate(pattern); } catch { accepted = false; }
    recorderRef.current.haptic(pattern, accepted);
  }, []);

  /**
   * Hands an announcement to the queue WITHOUT pre-filtering unrendered clips.
   *
   * An earlier version dropped missing keys here and pushed nothing when none
   * survived — which is precisely the failure AudioQueue exists to prevent. A
   * missing clip must reach the queue so it can emit `missing` and the gap gets
   * reported; silently pushing nothing turns an unrendered phrase into silence,
   * and silence reads to the user as "nothing to report".
   *
   * Only nulls are stripped, because those are branches that genuinely do not
   * apply (no route clip, no number to say) rather than gaps in the render.
   */
  const push = useCallback((
    keys: (string | null)[],
    label: string,
    priority: "critical" | "normal" = "normal",
    extra: Partial<Pick<Announcement, "earcon" | "haptic" | "dedupeKey" | "cooldownMs">> & { ttlMs?: number } = {},
  ) => {
    const wanted = keys.filter((k): k is string => Boolean(k));
    if (!wanted.length) return;
    const { ttlMs, ...rest } = extra;
    enqueue({
      keys: wanted,
      priority,
      label,
      ...rest,
      /**
       * A critical utterance on this screen is always about the doors of the
       * bus the rider is sitting on, so it defaults to the shortest lifetime in
       * the app. Anything queued behind a long stop name and reaching the front
       * after the bus has pulled away is not late information, it is wrong
       * information — see Announcement.expiresAt.
       */
      expiresAt: Date.now() + (ttlMs ?? (priority === "critical" ? TTL.IMMEDIATE : TTL.ROUTINE)),
    });
  }, [enqueue]);

  // ---------------------------------------------------------- handoff

  /**
   * Reads the handoff the wait screen left behind.
   *
   * Called from the first gesture rather than a mount effect. sessionStorage
   * does not exist during SSR, so reading it in an effect means rendering once
   * with nothing and again with the route — and the second render lands while
   * the user may already be swiping. Audio and geolocation both need a user
   * gesture anyway, so there is nothing to gain by starting earlier.
   *
   * Returns the destination index so the caller can begin tracking in the same
   * turn, without waiting for state to settle.
   */
  const loadHandoff = useCallback((): { sequence: OrderedStop[]; destIndex: number | null; handoff: BusHandoff } | null => {
    const h = readHandoff(sessionStorage);
    if (!h) { setHandoffError("Чиглэл сонгоогүй байна"); return null; }

    // The index is re-derived, never trusted: a data rebuild between screens can
    // shift a sequence, and a stale index counts confidently wrong.
    const valid = validateHandoff(h, routeStops);
    if (!valid.ok) {
      setHandoffError(valid.reason);
      note(`handoff rejected: ${valid.reason}`);
      return null;
    }

    const seq = (routeStops[valid.handoff.routeId]?.[String(valid.handoff.directionId)] ?? [])
      .map((id) => stopsById.get(id))
      .filter((s): s is Stop => Boolean(s))
      .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));

    setHandoff(valid.handoff);
    setSequence(seq);

    // The wait screen already chose where we are going, so the destination
    // picker is skipped entirely — the user answered that question before
    // boarding and should not be asked twice.
    let preset: string | null = null;
    try { preset = sessionStorage.getItem("vision-access:alight-stop"); } catch { /* private mode */ }
    const presetIndex = preset ? seq.findIndex((s) => s.id === preset) : -1;
    const dest = presetIndex > valid.handoff.boardingIndex ? presetIndex : null;
    if (dest !== null) setDestIndex(dest);

    note(`route ${valid.handoff.routeDisplayName} dir ${valid.handoff.directionId}, boarding ${valid.handoff.boardingIndex}/${seq.length - 1}`);
    return { sequence: seq, destIndex: dest, handoff: valid.handoff };
  }, [note, routeStops, stopsById]);

  // ------------------------------------------------------------ audio

  const ensureAudio = useCallback(async () => {
    if (!ctxRef.current) {
      if ("audioSession" in navigator) {
        (navigator as unknown as { audioSession: { type: string } }).audioSession.type = "playback";
      }
      ctxRef.current = new AudioContext();
      /**
       * The transition log for the third failure mode. A context that goes
       * suspended in a pocket and cannot be resumed without a gesture is the
       * difference between a journey that speaks and one that only appears to.
       */
      ctxRef.current.addEventListener("statechange", () => {
        const st = ctxRef.current?.state ?? "none";
        note(`audio context -> ${st}`);
        recorderRef.current.lifecycle("audiocontext", `${st} (visibility=${document.visibilityState})`);
      });
    }
    if (ctxRef.current.state === "suspended") await ctxRef.current.resume();
    if (!queueRef.current) {
      const player = new ManifestClipPlayer(manifest, ctxRef.current);
      /**
       * Earcons are synthesized, so they survive the case where every clip
       * failed to decode — which is exactly when the rider most needs to know
       * something happened. Passing them here is what makes the parallel-channel
       * rule true: speech, earcon and haptic all carry the same state.
       */
      const ctx = ctxRef.current!;
      const queue = new AudioQueue(player, {
        earcons: createEarconPlayer(() => ctx),
        // Through `buzz`, not navigator directly, so queue-driven haptics are
        // recorded with the platform's verdict like every other call.
        vibrate: buzz,
      });
      queue.on((e: QueueEvent) => {
        if (e.type === "missing") { note(`NO CLIP: ${e.keys.join(", ")}`); recorderRef.current.missing(e.keys); }
        else if (e.type === "stalled") note(`STALLED: ${e.key} — abandoned so the queue keeps moving`);
        else if (e.type === "start") {
          note(`say: ${e.announcement.label ?? ""}`);
          // What was actually played, which diverges from what was asked for
          // whenever a stop name is one of the 770 not yet rendered.
          recorderRef.current.clips(e.announcement.keys.filter((k) => player.has(k)));
          if (e.announcement.earcon) recorderRef.current.earcon(e.announcement.earcon);
          if (e.announcement.haptic?.length) recorderRef.current.haptic(e.announcement.haptic);
        }
      });
      queueRef.current = queue;
      const { failed } = await player.load();
      if (failed.length) note(`${failed.length} clips missing`);
    }
    return queueRef.current;
  }, [buzz, manifest, note]);

  // ------------------------------------------------------- wake lock

  /**
   * Without this the screen sleeps, Chrome throttles background timers, and
   * `watchPosition` simply stops firing — with NO error and no callback.
   *
   * This is what makes screen-off operation work at all. The silent-audio
   * fallback covers browsers with no Wake Lock API: a page that is "playing"
   * is one most browsers decline to throttle.
   */
  const acquireWakeLock = useCallback(async () => {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
        note("wake lock acquired");
        recorderRef.current.lifecycle("wakelock", "acquired");
        wakeLockRef.current.addEventListener("release", () => {
          note("wake lock released by system");
          // The system releases it whenever the page stops being visible, so
          // this line is the marker for "the screen went away".
          recorderRef.current.lifecycle("wakelock", `released by system (visibility=${document.visibilityState})`);
        });
        return;
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      note(`wake lock failed: ${why}`);
      recorderRef.current.lifecycle("wakelock", `request failed: ${why}`);
    }
    if (!silentAudioRef.current) {
      const el = document.createElement("audio");
      el.loop = true;
      el.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";
      silentAudioRef.current = el;
      void el.play().catch(() => note("silent-audio fallback blocked until a gesture"));
      note("wake lock unsupported — silent-audio fallback");
      recorderRef.current.lifecycle("wakelock", "unsupported — silent-audio fallback");
    }
  }, [note]);

  /**
   * PAGE LIFECYCLE, INSTRUMENTED.
   *
   * A remount is currently only inferable from a hole in the trace, and a hole
   * has at least three causes with different fixes: geolocation stopped
   * delivering, the page was frozen but survived, or the page was unloaded and
   * rebuilt. These listeners make the three distinguishable after the fact.
   *
   * `pagehide` with `persisted: false` is the unload; `visibilitychange` to
   * hidden without a pagehide is backgrounded-but-alive. Both flush, because
   * neither is guaranteed to be followed by anything.
   */
  useEffect(() => {
    recorderRef.current.lifecycle("mount");

    const onVisible = () => {
      if (document.visibilityState === "visible" && engineRef.current && !wakeLockRef.current) {
        void acquireWakeLock();
      }
    };
    const onVisibility = () => {
      const hidden = document.visibilityState === "hidden";
      recorderRef.current.lifecycle("visibilitychange", document.visibilityState);
      // A backgrounded tab may not come back. Flush before it can be killed.
      if (hidden) recorderRef.current.flush();
    };
    const onPageHide = (e: PageTransitionEvent) => {
      // persisted:true means the bfcache took it and it can come back intact;
      // persisted:false means this document is being destroyed.
      recorderRef.current.lifecycle("pagehide", e.persisted ? "persisted (bfcache)" : "UNLOADED");
      recorderRef.current.flush();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      recorderRef.current.lifecycle("pageshow", e.persisted ? "restored from bfcache" : "fresh load");
    };
    const onFreeze = () => recorderRef.current.lifecycle("freeze");
    const onResume = () => recorderRef.current.lifecycle("resume");

    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("freeze", onFreeze);
    document.addEventListener("resume", onResume);

    return () => {
      recorderRef.current.lifecycle("unmount");
      recorderRef.current.flush();
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
    };
  }, [acquireWakeLock]);

  /**
   * Heartbeat — the second clock.
   *
   * Runs on its own timer, so a gap in fixes with heartbeats continuing is a
   * geolocation stall, while a gap in both is the page being suspended. Only
   * started while actually recording, so an ordinary journey pays nothing.
   */
  useEffect(() => {
    if (!recordingActive) return;
    const timer = setInterval(() => {
      recorderRef.current.heartbeat(document.visibilityState === "visible", audioState());
    }, 5_000);
    return () => clearInterval(timer);
  }, [audioState, recordingActive]);

  // ----------------------------------------------------------- events

  /**
   * The stop set of the boarded variant, for the §6.1 wrong-BUS test.
   *
   * The engine cannot answer "is the globally nearest stop on this variant"
   * without all 923 stops, so it stays pure and the caller decides. The ride
   * page already loads the full set server-side and passes it as props, so this
   * costs no second load and no new allocation on a screen expected to survive
   * an hour on a locked phone.
   */
  const variantStopIds = useMemo(() => new Set(sequence.map((s) => s.id)), [sequence]);

  const nearestIsOnVariant = useCallback(
    (lat: number, lon: number): boolean | undefined => {
      if (variantStopIds.size === 0) return undefined;
      let bestId: string | null = null;
      let bestD = Infinity;
      for (const st of stops) {
        const dLat = (st.lat - lat) * 111_132;
        const dLon = (st.lon - lon) * 111_320 * Math.cos((lat * Math.PI) / 180);
        const d = dLat * dLat + dLon * dLon;
        if (d < bestD) { bestD = d; bestId = st.id; }
      }
      return bestId === null ? undefined : variantStopIds.has(bestId);
    },
    [stops, variantStopIds],
  );

  /**
   * Engine events → log, UI state, and the ONE announcement the engine owns.
   *
   * The ladder owns the count's announcements; this owns only the state
   * transitions. wrong-direction is deliberately logged and never spoken: the
   * detector is not retunable on synthetic data (see NOTES.md), and a spurious
   * alert that makes a rider leave a CORRECT bus is a real harm.
   */
  const handleEngineEvents = useCallback(
    (events: EngineEvent[]) => {
      for (const e of events) {
        recorderRef.current.engine(e.type, JSON.stringify(e));
        switch (e.type) {
          case "advanced":
            note(`advanced ${e.from} -> ${e.to}`);
            break;
          case "at-stop":
            note(`at stop ${e.index}`);
            break;
          case "wrong-direction":
            // LOGGING ONLY. No speech, no string, no earcon.
            note(`WRONG DIRECTION (logging only) at index ${e.index}`);
            break;
          case "off-route":
            note(`OFF ROUTE (logging only) at index ${e.index}`);
            break;
          case "layover":
            note(`layover at ${e.index}`);
            break;
          case "confidence":
            note(`confidence ${e.from} -> ${e.to} (${e.source})`);
            setDegraded(e.to === "none" || e.to === "low");
            break;
          case "rejected":
            // Diagnostic only: 2455 of these across 146 simulated journeys.
            break;
        }
      }
    },
    [note],
  );

  /**
   * Run the ladder for the current engine state.
   *
   * INVARIANT 8: a confidence collapse is announced, once. To someone who
   * cannot see the counter, silence reads as "not there yet" right up until
   * they have ridden past their stop, so a countdown that stops working has to
   * say so out loud.
   */
  const speakLadder = useCallback(
    (state: EngineState, dest: number, now: number) => {
      const geometry = geometryRef.current;
      if (!geometry) return;

      if (state.confidence === "none" && !downgradeAnnouncedRef.current) {
        downgradeAnnouncedRef.current = true;
        enqueue(confidenceLost(now));
        buzz([200, 100, 200]);
        note("confidence lost — announced once");
        return;
      }
      if (state.confidence !== "none") downgradeAnnouncedRef.current = false;

      const remaining = remainingForAlighting(state, dest);
      const destination = sequence[dest];
      if (!destination) return;

      const announcement = alightingAnnouncement(
        {
          remaining,
          confidence: state.confidence,
          destination,
          now,
          secondsToDestination: secondsToDestination(state, geometry, dest),
        },
        lastSpokenRef.current,
        has,
      );
      if (announcement) {
        enqueue(announcement);
        lastSpokenRef.current = remaining;
        recorderRef.current.say(remaining, announcement.keys, announcement.label ?? "");
        const v = vibrationFor(remaining);
        if (v) buzz(v);
        note(`say: ${announcement.label ?? announcement.keys.join(" ")}`);
      }
    },
    [buzz, enqueue, has, note, sequence],
  );

  // ------------------------------------------------------------ start

  const beginTracking = useCallback(
    async (dest: number, seq: OrderedStop[] = sequence, h: BusHandoff | null = handoff) => {
      if (!h || seq.length === 0) return;
      await ensureAudio();
      await acquireWakeLock();

      const chain: GeometryStop[] = seq.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));
      const geometry = new StopChainGeometry(chain);
      geometryRef.current = geometry;

      const initial = createEngine(h.boardingIndex, geometry);
      engineRef.current = initial;
      setEngine(initial);
      setDestIndex(dest);
      lastSpokenRef.current = null;
      downgradeAnnouncedRef.current = false;
      boardingRef.current = createBoardingState();

      /**
       * Recording begins here, not on mount: a trace is only meaningful once
       * the route and destination are known, and those come from the handoff.
       */
      let armedNow = false;
      try { armedNow = sessionStorage.getItem(RECORDING_FLAG) === "1"; } catch { /* private mode */ }
      if (armedNow) {
        /**
         * Continue the stored recording if it belongs to this same journey.
         * Starting fresh here would overwrite it on the first flush, so a
         * remount would destroy the ride rather than interrupt it.
         */
        const prior = loadResumable(window.localStorage, h.routeId, h.directionId);
        recorderRef.current = createRecorder(window.localStorage, {
          device: navigator.userAgent,
          resume: prior,
        });
        recorderRef.current.setRoute({
          routeId: h.routeId,
          directionId: h.directionId,
          boardingIndex: h.boardingIndex,
          destinationIndex: dest,
        });
        setRecordingActive(recorderRef.current.active);
        note(prior
          ? `RESUMED recording — ${prior.trace.length} fixes already captured`
          : "RECORDING this journey");
        /**
         * Confirmation the tester can act on BEFORE the bus moves, which is the
         * only moment the run can be redone. Non-verbal because there is no
         * rendered Mongolian for it, and an unrendered key is dropped silently.
         */
        try {
          const p2 = createEarconPlayer(() => ctxRef.current!);
          void p2.play("alert", new AbortController().signal).catch(() => {});
        } catch { /* no context yet */ }
        buzz([60, 80, 60]);
      }

      note(`tracking to ${dest}: ${seq[dest]?.name}`);

      push([SCREEN.ride.clip, has(`stop_${seq[dest]?.id}`) ? `stop_${seq[dest].id}` : null,
        dest - h.boardingIndex <= 40 ? `num_${dest - h.boardingIndex}` : null,
        RIDE.stopsRemaining.clip], `riding to ${seq[dest]?.name}`);

      const nav = navigator as NavigatorWithBattery;
      if (nav.getBattery) {
        void nav.getBattery().then((b) => {
          note(`battery ${Math.round(b.level * 100)}%${b.charging ? " charging" : ""}`);
          recorderRef.current.battery(b.level, b.charging);
          // Sampled through the ride, because drain over a real hour is one of
          // the numbers the polling budget is meant to be set from.
          setInterval(() => {
            void nav.getBattery!().then((s2) => recorderRef.current.battery(s2.level, s2.charging));
          }, 60_000);
        });
      }

      recorderRef.current.lifecycle("watch-start");
      watchRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const current = engineRef.current;
          const geom = geometryRef.current;
          if (!current || !geom) return;
          const now = Date.now();

          /**
           * ADAPTER: the engine's Fix is `accuracyM`; geolocation and the
           * retired matcher both say `accuracy`. Getting this wrong yields
           * undefined, then NaN, and the count simply stops moving in silence.
           */
          const fix = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracyM: pos.coords.accuracy,
            timestamp: pos.timestamp,
          };

          // gps-sim.ts's own shape, so the trace replays with no conversion.
          recorderRef.current.fix({
            lat: fix.lat, lon: fix.lon, accuracy: fix.accuracyM, timestamp: fix.timestamp,
          });

          /**
           * Boarding detection runs alongside the count rather than gating it:
           * the wait screen has already committed a route, so the count starts
           * from the boarding index either way. What this adds is the spoken
           * confirmation that the rider is on a bus following the corridor —
           * sustained agreement, because a passing car has a bus's speed
           * signature but not its path.
           */
          const b = onWaitingPosition(
            boardingRef.current,
            { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracyM, timestamp: fix.timestamp },
            chain,
            { fromIndex: h.boardingIndex },
          );
          boardingRef.current = b.state;
          for (const ev of b.events) {
            if (ev.type === "boarded") {
              note(`boarded, ${ev.speedKmh.toFixed(0)} km/h in corridor`);
              push([JOURNEY.boardedDetected.clip], "boarded", "normal");
            }
          }

          const r = onFix(current, fix, geom, now, nearestIsOnVariant(fix.lat, fix.lon));
          engineRef.current = r.state;
          setEngine(r.state);
          handleEngineEvents(r.events);
          speakLadder(r.state, dest, now);
        },
        (err) => {
          note(`geolocation error: ${err.message}`);
          recorderRef.current.lifecycle("geolocation-error", `${err.code}: ${err.message}`);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
    },
    [acquireWakeLock, buzz, ensureAudio, handleEngineEvents, handoff, has, nearestIsOnVariant, note, push, sequence, speakLadder],
  );

  /**
   * The stale-countdown watchdog.
   *
   * `watchPosition` going quiet is invisible to the callback — nothing fires,
   * nothing throws. Only a timer comparing against the last good fix notices.
   */
  useEffect(() => {
    if (!engine || destIndex === null) return;
    const timer = setInterval(() => {
      const current = engineRef.current;
      if (!current) return;
      const now = Date.now();
      const r = onTick(current, now);
      if (r.events.length) {
        engineRef.current = r.state;
        setEngine(r.state);
        handleEngineEvents(r.events);
        // The loss itself has to become audible; see speakLadder.
        speakLadder(r.state, destIndex, now);
        if (r.state.confidence === "none") enqueue(announceTrackingDegraded(now));
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [destIndex, engine, enqueue, handleEngineEvents, speakLadder]);

  /**
   * First gesture: read the handoff, open audio, and start counting.
   *
   * If the wait screen already chose a destination — the normal path — tracking
   * begins here and the user is never asked again. Otherwise the destination
   * picker is the option list and `beginTracking` runs on their selection.
   */
  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    armFieldTest();
    await ensureAudio();
    const loaded = loadHandoff();
    if (loaded?.destIndex != null) {
      void beginTracking(loaded.destIndex, loaded.sequence, loaded.handoff);
    }
  }, [armFieldTest, beginTracking, ensureAudio, loadHandoff]);

  // ---------------------------------------------------------- teardown

  const teardown = useCallback(async () => {
    // Silence FIRST, then release hardware: a stale "Одоо буугаарай" arriving
    // after the user has left ride mode puts them off at the wrong stop.
    recorderRef.current.flush();
    queueRef.current?.clear();
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    if (wakeLockRef.current) {
      try { await wakeLockRef.current.release(); } catch { /* already gone */ }
      wakeLockRef.current = null;
    }
    silentAudioRef.current?.pause();
    silentAudioRef.current = null;
    engineRef.current = null;
    geometryRef.current = null;
    if (ctxRef.current && ctxRef.current.state !== "closed") await ctxRef.current.close().catch(() => {});
    ctxRef.current = null;
    queueRef.current = null;
  }, []);

  useEffect(() => () => {
    if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
    void wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    silentAudioRef.current?.pause();
    queueRef.current?.clear();
    if (ctxRef.current && ctxRef.current.state !== "closed") void ctxRef.current.close().catch(() => {});
  }, []);

  // ---------------------------------------------------------- options

  const remaining = engine && destIndex !== null ? remainingForAlighting(engine, destIndex) : null;

  const options: ListOption<Action>[] = useMemo(() => {
    // Before tracking starts, the list is the destination picker — only reached
    // when the wait screen did not already choose one.
    if (destIndex === null && handoff) {
      return sequence
        .map((s, i) => ({ s, i }))
        .filter(({ s, i }) => i > handoff.boardingIndex && s.name.trim())
        .map(({ s, i }) => ({
          value: { kind: "destination" as const, index: i },
          keys: [`stop_${s.id}`],
          label: `${s.name} · ${i - handoff.boardingIndex} буудлын дараа`,
        }));
    }
    const base: ListOption<Action>[] = [
      { value: { kind: "advance" }, keys: [RIDE.manualAdvance.clip!], label: RIDE.manualAdvance.mn },
      { value: { kind: "finish" }, keys: [RIDE.finish.clip!], label: RIDE.finish.mn },
    ];
    if (showFieldTest) {
      base.push(
        { value: { kind: "record" }, keys: [], label: armed ? "Бичлэг зогсоох" : "Бичлэг эхлүүлэх" },
        { value: { kind: "share" }, keys: [], label: "Бичлэг илгээх" },
      );
    }
    return base;
  }, [armed, destIndex, handoff, sequence, showFieldTest]);

  const say = useCallback((keys: (string | null)[], label: string) => push(keys, label, "normal"), [push]);

  const statusNow = useCallback(() => {
    const current = engineRef.current;
    const at = current ? sequence[current.stopIndex] ?? null : null;
    const target = destIndex !== null ? sequence[destIndex] ?? null : null;
    const left = current && destIndex !== null ? remainingForAlighting(current, destIndex) : null;

    // Built in lib/transit/announce.ts, so the overshot-rider path is covered by
    // the suite rather than by inspection of a screen that has no tests.
    enqueue(
      announceStatus(
        {
          at, destination: target, remaining: left,
          statusPrefixKey: JOURNEY.statusPrefix.clip!,
          stopsRemainingKey: RIDE.stopsRemaining.clip!,
        },
        has,
      ),
    );
  }, [destIndex, enqueue, has, sequence]);

  /**
   * Manual advance, clamped at the destination.
   *
   * Pressing against the clamp SPEAKS. A rider pressing repeatedly at a button
   * that answers with nothing has no way to tell a clamp from a frozen app, so
   * the clamp answers with the full status — which is the question they were
   * really asking.
   */
  const manualAdvanceClamped = useCallback(() => {
    const current = engineRef.current;
    if (!current || destIndex === null) return;
    const r = advanceManually(current, destIndex);
    if (r.clamped) {
      note(`manual advance CLAMPED at ${current.stopIndex} (destination ${destIndex})`);
      statusNow();
      return;
    }
    engineRef.current = r.state;
    setEngine(r.state);
    note(`manual advance -> ${r.state.stopIndex}`);
    push([RIDE.manualAdvance.clip], "manual advance", "normal");
    speakLadder(r.state, destIndex, Date.now());
  }, [destIndex, note, push, speakLadder, statusNow]);

  /**
   * Get the trace off the phone, without a cable.
   *
   * Share sheet FIRST, download second. On iOS a blob download is unreliable
   * and lands in a Files app a blind tester then has to navigate; the share
   * sheet is the path VoiceOver handles well and can send straight to a
   * messaging app. `navigator.share` with files must be called inside the
   * gesture, which is why this runs from onSelect and not from an effect.
   */
  const shareRecording = useCallback(async () => {
    const rec = loadRecording(window.localStorage);
    if (!rec || rec.trace.length === 0) {
      note("no recording to share");
      return;
    }
    const name = recordingFilename(rec);
    const json = JSON.stringify(rec);
    note(`recording: ${describeRecording(rec)}`);

    try {
      const file = new File([json], name, { type: "application/json" });
      const canShare = typeof navigator.share === "function"
        && (!navigator.canShare || navigator.canShare({ files: [file] }));
      if (canShare) {
        await navigator.share({ files: [file], title: name });
        note("shared");
        return;
      }
    } catch {
      // Cancelled or unsupported — fall through to the download.
    }

    try {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      note(`downloaded ${name}`);
    } catch (e) {
      note(`share failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [note]);

  const toggleRecording = useCallback(() => {
    let current = false;
    try { current = sessionStorage.getItem(RECORDING_FLAG) === "1"; } catch { /* private mode */ }
    const next = !current;
    try { sessionStorage.setItem(RECORDING_FLAG, next ? "1" : "0"); } catch { /* private mode */ }
    if (!next) {
      recorderRef.current.flush();
      recorderRef.current = nullRecorder();
    } else {
      // Arming starts a NEW journey, so the old trace goes rather than being
      // resumed into. Disarm-then-arm is how a bad run is discarded.
      clearRecording(window.localStorage);
    }
    setArmed(next);
    setRecordingActive(recorderRef.current.active);
    note(next ? "recording ARMED — restart the journey to capture it" : "recording disarmed");
  }, [note]);

  const nav = useGestureNav<Action>({
    options,
    announce: (option, ctx) => say([ctx.wrapped ? GESTURE.listWrapped.clip : null, ...option.keys], option.label),
    onSelect: (option) => {
      const a = option.value;
      if (a.kind === "destination") { void beginTracking(a.index); return; }
      if (a.kind === "advance") { manualAdvanceClamped(); return; }
      if (a.kind === "record") { toggleRecording(); return; }
      if (a.kind === "share") { void shareRecording(); return; }
      if (a.kind === "finish") {
        void teardown().then(() => { clearHandoff(sessionStorage); router.push("/"); });
      }
    },
    onBack: () => { void teardown().then(() => router.push("/")); },
    onRepeat: () => {
      // Repeat is the same answer as "where am I" here — there is only ever one
      // thing worth re-hearing on this screen.
      statusNow();
    },
    /**
     * Long press: the full status, immediately, whatever else is happening.
     *
     * Critical priority so it preempts a queued stop name — a user who asks
     * where they are is asking NOW, usually because they think something has
     * gone wrong.
     */
    onWhereAmI: () => statusNow(),
    // A new list starts at the top — see resetKey in useGestureNav.
    resetKey: destIndex === null ? "picker" : "riding",
  });

  const a11yOptions: A11yOption[] = options.map((o, i) => ({
    label: o.label, selected: i === nav.index,
    onActivate: () => { nav.setIndex(i); },
  }));

  const handlers = {
    ...nav.handlers,
    onTouchStart: (e: React.TouchEvent) => { void start(); nav.handlers.onTouchStart(e); },
  };

  if (handoffError) {
    return (
      <GestureSurface handlers={handlers} options={[]}>
        <CurrentOption title="Алдаа" detail={handoffError} />
      </GestureSurface>
    );
  }

  const title = (remaining !== null && remaining < 0)
    ? RIDE.passedStop.mn
    : remaining !== null
      ? `${remaining} ${RIDE.stopsRemaining.mn}`
      : nav.current?.label ?? SCREEN.ride.mn;

  return (
    <GestureSurface
      handlers={handlers}
      options={a11yOptions}
      onFocusOption={(i) => { void start(); nav.setIndex(i); }}
    >
      <CurrentOption
        title={title}
        detail={destIndex !== null ? sequence[destIndex]?.name : handoff?.routeDisplayName}
        position={[degraded ? "GPS сул" : null, recordingActive ? "● REC" : null]
          .filter(Boolean).join(" · ") || undefined}
      />
      <details style={{ position: "absolute", bottom: 6, left: 6, fontSize: 11, color: "#333" }}>
        <summary>debug</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
      </details>
    </GestureSurface>
  );
}
