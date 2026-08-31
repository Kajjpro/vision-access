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
 * The counting itself is in lib/transit/stop-matcher.ts, pure and tested
 * against 168 route/direction pairs. This file owns only what cannot be pure:
 * geolocation, the wake lock, vibration, and the audio queue.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CurrentOption, GestureSurface, type A11yOption } from "@/components/GestureSurface";
import { AudioQueue, type Announcement, type QueueEvent } from "@/lib/transit/audio-queue";
import { ManifestClipPlayer } from "@/lib/transit/clip-player";
import { announceRemaining, announceTrackingDegraded, TTL, vibrationFor } from "@/lib/transit/announce";
import { clearHandoff, readHandoff, validateHandoff, type BusHandoff } from "@/lib/transit/handoff";
import { shouldAnnounceStop } from "@/lib/transit/journey";
import {
  checkGpsLoss, createState, manualAdvance, onPosition,
  type MatcherEvent, type MatcherState, type OrderedStop,
} from "@/lib/transit/stop-matcher";
import { GESTURE, JOURNEY, RIDE, SCREEN } from "@/lib/ui/announcements";
import { useGestureNav } from "@/lib/ui/useGestureNav";
import type { ListOption } from "@/lib/ui/gesture-nav";
import type { AudioManifest, RouteStops, Stop } from "@/lib/transit/types";

type BatteryManager = { level: number; charging: boolean };
type NavigatorWithBattery = Navigator & { getBattery?: () => Promise<BatteryManager> };

type Action =
  | { kind: "destination"; index: number }
  | { kind: "advance" }
  | { kind: "finish" };

export function RideScreen({
  stops, routeStops, manifest,
}: { stops: Stop[]; routeStops: RouteStops; manifest: AudioManifest }) {
  const router = useRouter();
  const [handoff, setHandoff] = useState<BusHandoff | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [sequence, setSequence] = useState<OrderedStop[]>([]);
  const [destIndex, setDestIndex] = useState<number | null>(null);
  const [matcher, setMatcher] = useState<MatcherState | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const queueRef = useRef<AudioQueue | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const matcherRef = useRef<MatcherState | null>(null);
  const watchRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const startedRef = useRef(false);

  const stopsById = useMemo(() => new Map(stops.map((s) => [s.id, s])), [stops]);
  const has = useCallback((key: string) => Boolean(manifest[key]), [manifest]);

  const note = useCallback((line: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 60));
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
    queueRef.current?.push({
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
  }, []);

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
    }
    if (ctxRef.current.state === "suspended") await ctxRef.current.resume();
    if (!queueRef.current) {
      const player = new ManifestClipPlayer(manifest, ctxRef.current);
      const queue = new AudioQueue(player);
      queue.on((e: QueueEvent) => {
        if (e.type === "missing") note(`NO CLIP: ${e.keys.join(", ")}`);
        else if (e.type === "stalled") note(`STALLED: ${e.key} — abandoned so the queue keeps moving`);
        else if (e.type === "start") note(`say: ${e.announcement.label ?? ""}`);
      });
      queueRef.current = queue;
      const { failed } = await player.load();
      if (failed.length) note(`${failed.length} clips missing`);
    }
    return queueRef.current;
  }, [manifest, note]);

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
        wakeLockRef.current.addEventListener("release", () => note("wake lock released by system"));
        return;
      }
    } catch (e) {
      note(`wake lock failed: ${e instanceof Error ? e.message : e}`);
    }
    if (!silentAudioRef.current) {
      const el = document.createElement("audio");
      el.loop = true;
      el.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";
      silentAudioRef.current = el;
      void el.play().catch(() => note("silent-audio fallback blocked until a gesture"));
      note("wake lock unsupported — silent-audio fallback");
    }
  }, [note]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && matcherRef.current && !wakeLockRef.current) {
        void acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireWakeLock]);

  // ----------------------------------------------------------- events

  const handleEvents = useCallback(
    (events: MatcherEvent[], dest: number) => {
      for (const e of events) {
        if (e.type === "degraded") {
          setDegraded(true);
          note(`DEGRADED: ${e.reason}`);
          queueRef.current?.push(announceTrackingDegraded());
          navigator.vibrate?.([100, 80, 100]);
        } else if (e.type === "recovered") {
          setDegraded(false);
          note("tracking recovered");
        } else if (e.type === "stop-passed") {
          note(`passed ${e.index}: ${e.stop.name} (${e.remaining} to go)`);
          // Every stop within the last five, every third before that.
          // Announcing all of them on a 36-stop run trains the user to stop
          // listening, and the value of the last few is that they are rare.
          if (shouldAnnounceStop(e.remaining)) {
            push(
              [has(`stop_${e.stop.id}`) ? `stop_${e.stop.id}` : "bus_unnamed_stop",
                JOURNEY.passedSuffix.clip,
                e.remaining > 0 && e.remaining <= 40 ? `num_${e.remaining}` : null,
                e.remaining > 0 ? RIDE.stopsRemaining.clip : null],
              `passed ${e.stop.name}, ${e.remaining} left`,
              e.remaining <= 1 ? "critical" : "normal",
            );
          }
          const v = vibrationFor(e.remaining);
          if (v) navigator.vibrate?.(v);
        } else if (e.type === "arrived") {
          note(`ARRIVED at ${e.stop.name}`);
          const a = announceRemaining(0, e.stop, has);
          if (a) queueRef.current?.push(a);
          navigator.vibrate?.(vibrationFor(0) ?? [800]);
        } else if (e.type === "overshoot") {
          note(`OVERSHOT at ${e.stop.name}`);
          const a = announceRemaining(-1, e.stop, has);
          if (a) queueRef.current?.push(a);
          navigator.vibrate?.(vibrationFor(-1) ?? [200, 100, 200]);
        }
      }
      void dest;
    },
    [has, note, push],
  );

  // ------------------------------------------------------------ start

  const beginTracking = useCallback(
    async (dest: number, seq: OrderedStop[] = sequence, h: BusHandoff | null = handoff) => {
      if (!h || seq.length === 0) return;
      await ensureAudio();
      await acquireWakeLock();

      const initial = createState(h.boardingIndex, dest, Date.now());
      matcherRef.current = initial;
      setMatcher(initial);
      setDestIndex(dest);
      note(`tracking to ${dest}: ${seq[dest]?.name}`);

      push([SCREEN.ride.clip, has(`stop_${seq[dest]?.id}`) ? `stop_${seq[dest].id}` : null,
        dest - h.boardingIndex <= 40 ? `num_${dest - h.boardingIndex}` : null,
        RIDE.stopsRemaining.clip], `riding to ${seq[dest]?.name}`);

      const nav = navigator as NavigatorWithBattery;
      if (nav.getBattery) {
        void nav.getBattery().then((b) => note(`battery ${Math.round(b.level * 100)}%${b.charging ? " charging" : ""}`));
      }

      watchRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const current = matcherRef.current;
          if (!current) return;
          const r = onPosition(
            current,
            { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, timestamp: pos.timestamp },
            // `seq`, not the state variable: when start() loads the handoff and
            // begins tracking in one turn, `sequence` has not re-rendered yet
            // and every fix would be matched against an empty route.
            seq,
          );
          matcherRef.current = r.state;
          setMatcher(r.state);
          handleEvents(r.events, dest);
        },
        (err) => note(`geolocation error: ${err.message}`),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
    },
    [acquireWakeLock, ensureAudio, handleEvents, handoff, has, note, push, sequence],
  );

  /**
   * The stale-countdown watchdog.
   *
   * `watchPosition` going quiet is invisible to the callback — nothing fires,
   * nothing throws. Only a timer comparing against the last good fix notices.
   */
  useEffect(() => {
    if (!matcher || destIndex === null) return;
    const timer = setInterval(() => {
      const current = matcherRef.current;
      if (!current) return;
      const r = checkGpsLoss(current, Date.now());
      if (r.events.length) {
        matcherRef.current = r.state;
        setMatcher(r.state);
        handleEvents(r.events, destIndex);
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [destIndex, handleEvents, matcher]);

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
    await ensureAudio();
    const loaded = loadHandoff();
    if (loaded?.destIndex != null) {
      void beginTracking(loaded.destIndex, loaded.sequence, loaded.handoff);
    }
  }, [beginTracking, ensureAudio, loadHandoff]);

  // ---------------------------------------------------------- teardown

  const teardown = useCallback(async () => {
    // Silence FIRST, then release hardware: a stale "Одоо буугаарай" arriving
    // after the user has left ride mode puts them off at the wrong stop.
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
    matcherRef.current = null;
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

  const remaining = matcher && destIndex !== null ? destIndex - matcher.currentIndex : null;

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
    return [
      { value: { kind: "advance" }, keys: [RIDE.manualAdvance.clip!], label: RIDE.manualAdvance.mn },
      { value: { kind: "finish" }, keys: [RIDE.finish.clip!], label: RIDE.finish.mn },
    ];
  }, [destIndex, handoff, sequence]);

  const say = useCallback((keys: (string | null)[], label: string) => push(keys, label, "normal"), [push]);

  const statusNow = useCallback(() => {
    const current = matcherRef.current;
    const at = current ? sequence[current.currentIndex] : null;
    const target = destIndex !== null ? sequence[destIndex] : null;
    const left = current && destIndex !== null ? destIndex - current.currentIndex : null;

    push(
      [
        JOURNEY.statusPrefix.clip,
        at && has(`stop_${at.id}`) ? `stop_${at.id}` : null,
        target && has(`stop_${target.id}`) ? `stop_${target.id}` : null,
        left !== null && left > 0 && left <= 40 ? `num_${left}` : null,
        left !== null && left > 0 ? RIDE.stopsRemaining.clip : null,
      ],
      `status: at ${at?.name ?? "?"}, ${left ?? "?"} to ${target?.name ?? "?"}`,
      "critical",
    );
  }, [destIndex, has, push, sequence]);

  const nav = useGestureNav<Action>({
    options,
    announce: (option, ctx) => say([ctx.wrapped ? GESTURE.listWrapped.clip : null, ...option.keys], option.label),
    onSelect: (option) => {
      const a = option.value;
      if (a.kind === "destination") { void beginTracking(a.index); return; }
      if (a.kind === "advance") {
        const current = matcherRef.current;
        if (!current || destIndex === null) return;
        const r = manualAdvance(current, sequence);
        matcherRef.current = r.state;
        setMatcher(r.state);
        handleEvents(r.events, destIndex);
        return;
      }
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

  const title = matcher?.overshot
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
        position={degraded ? "GPS сул" : undefined}
      />
      <details style={{ position: "absolute", bottom: 6, left: 6, fontSize: 11, color: "#333" }}>
        <summary>debug</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
      </details>
    </GestureSurface>
  );
}
