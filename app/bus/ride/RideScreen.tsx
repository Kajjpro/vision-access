"use client";

/**
 * Mode B — riding the bus.
 *
 * The matcher is pure and lives in lib/transit/stop-matcher.ts. Everything here
 * is the parts that cannot be pure: geolocation, the wake lock, vibration, and
 * the audio queue. Keeping that boundary is what let the counting logic be
 * tested against 168 route/direction pairs without a browser.
 *
 * The failure this screen is built around is SILENCE. To someone who cannot see
 * the counter, no announcement means "we have not arrived yet" — so a frozen
 * countdown reads exactly like a working one right up until they have ridden
 * past their stop. Every path that stops tracking must therefore say so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { AudioQueue, type QueueEvent } from "@/lib/transit/audio-queue";
import { ManifestClipPlayer } from "@/lib/transit/clip-player";
import { announceRemaining, announceTrackingDegraded, vibrationFor } from "@/lib/transit/announce";
import { clearHandoff, readHandoff, validateHandoff, type BusHandoff } from "@/lib/transit/handoff";
import {
  checkGpsLoss, createState, manualAdvance, onPosition,
  type MatcherEvent, type MatcherState, type OrderedStop,
} from "@/lib/transit/stop-matcher";
import type { AudioManifest, RouteStops, Stop } from "@/lib/transit/types";

const SETTINGS_KEY = "vision-access:announce-mode";

/** Battery Status API — Chrome-only and still unprefixed, so not in lib.dom. */
type BatteryManager = { level: number; charging: boolean };
type NavigatorWithBattery = Navigator & { getBattery?: () => Promise<BatteryManager> };

const target: React.CSSProperties = {
  display: "block", width: "100%", minHeight: 88, padding: "18px 20px",
  marginBottom: 14, borderRadius: 14, border: "2px solid #3a3a3a",
  background: "#1c1c1c", color: "#fff", fontSize: 22, textAlign: "left",
  fontFamily: "inherit", cursor: "pointer",
};
const primary: React.CSSProperties = { ...target, minHeight: 120, background: "#1d4e2a", borderColor: "#2f6b3f", fontSize: 26 };
const alert: React.CSSProperties = { ...target, minHeight: 110, background: "#5c2222", borderColor: "#8a3535" };

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
  const [battery, setBattery] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [screenReaderMode, setScreenReaderMode] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);

  const queueRef = useRef<AudioQueue | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const matcherRef = useRef<MatcherState | null>(null);
  const watchRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);

  const stopsById = useMemo(() => new Map(stops.map((s) => [s.id, s])), [stops]);

  const note = useCallback((line: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 60));
  }, []);

  useEffect(() => {
    setScreenReaderMode(localStorage.getItem(SETTINGS_KEY) === "screen-reader");
  }, []);

  // ---------------------------------------------------------- handoff

  useEffect(() => {
    const h = readHandoff(sessionStorage);
    if (!h) {
      setHandoffError("Чиглэл сонгоогүй байна");
      return;
    }
    // The index is re-derived, never trusted: a data rebuild between the two
    // screens can shift a sequence, and a stale index counts confidently wrong.
    const valid = validateHandoff(h, routeStops);
    if (!valid.ok) {
      setHandoffError(valid.reason);
      note(`handoff rejected: ${valid.reason}`);
      return;
    }
    const seq = (routeStops[valid.handoff.routeId]?.[String(valid.handoff.directionId)] ?? [])
      .map((id) => stopsById.get(id))
      .filter((s): s is Stop => Boolean(s))
      .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));

    setHandoff(valid.handoff);
    setSequence(seq);
    note(`route ${valid.handoff.routeDisplayName} dir ${valid.handoff.directionId}, boarding index ${valid.handoff.boardingIndex} of ${seq.length - 1}`);
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
        else if (e.type === "start") note(`say: ${e.announcement.label ?? ""}`);
      });
      queueRef.current = queue;
      const { failed } = await player.load();
      if (failed.length) note(`${failed.length} clips missing from the pilot render`);
    }
    return queueRef.current;
  }, [manifest, note]);

  const handleEvents = useCallback(
    (events: MatcherEvent[], seq: OrderedStop[], dest: number) => {
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
          const a = announceRemaining(e.remaining, e.stop, (k) => Boolean(manifest[k]));
          if (a) queueRef.current?.push(a);
          const v = vibrationFor(e.remaining);
          if (v) navigator.vibrate?.(v);
        } else if (e.type === "arrived") {
          note(`ARRIVED at ${e.stop.name}`);
          // Critical: preempts whatever is playing. A stop name finishing after
          // the doors close is worth nothing.
          const a = announceRemaining(0, e.stop, (k) => Boolean(manifest[k]));
          if (a) queueRef.current?.push(a);
          navigator.vibrate?.(vibrationFor(0) ?? [800]);
        } else if (e.type === "overshoot") {
          note(`OVERSHOT at ${e.stop.name}`);
          const a = announceRemaining(-1, e.stop, (k) => Boolean(manifest[k]));
          if (a) queueRef.current?.push(a);
          navigator.vibrate?.(vibrationFor(-1) ?? [200, 100, 200]);
        }
      }
      void seq;
      void dest;
    },
    [manifest, note],
  );

  // ------------------------------------------------------- wake lock

  /**
   * Without this the screen sleeps, Chrome throttles background timers, and
   * `watchPosition` simply stops firing — with NO error and no callback. It is
   * the single most likely reason a demo that worked on a desk fails on a bus.
   */
  const acquireWakeLock = useCallback(async () => {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
        setWakeLockActive(true);
        note("wake lock acquired");
        wakeLockRef.current.addEventListener("release", () => setWakeLockActive(false));
        return;
      }
    } catch (e) {
      note(`wake lock failed: ${e instanceof Error ? e.message : e}`);
    }
    // Fallback: a looping silent audio element keeps the page "playing", which
    // most browsers treat as a reason not to throttle it.
    if (!silentAudioRef.current) {
      const el = document.createElement("audio");
      el.loop = true;
      // 0.1 s of silence, inline so it needs no network.
      el.src =
        "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";
      silentAudioRef.current = el;
      void el.play().catch(() => note("silent-audio fallback blocked until a gesture"));
      note("wake lock unsupported — using silent-audio fallback");
    }
  }, [note]);

  // Re-acquire after the tab is backgrounded; the lock is dropped automatically.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && matcherRef.current && !wakeLockRef.current) {
        void acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireWakeLock]);

  // ------------------------------------------------------------ start

  const start = useCallback(
    async (dest: number) => {
      if (!handoff) return;
      await ensureAudio();
      await acquireWakeLock();

      const initial = createState(handoff.boardingIndex, dest, Date.now());
      matcherRef.current = initial;
      setMatcher(initial);
      setDestIndex(dest);
      note(`tracking to index ${dest}: ${sequence[dest]?.name}`);

      const nav = navigator as NavigatorWithBattery;
      if (nav.getBattery) {
        void nav.getBattery().then((b) => {
          setBattery(`${Math.round(b.level * 100)}%`);
          note(`battery ${Math.round(b.level * 100)}%${b.charging ? " (charging)" : ""}`);
        });
      }

      watchRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const current = matcherRef.current;
          if (!current) return;
          const r = onPosition(
            current,
            { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, timestamp: pos.timestamp },
            sequence,
          );
          matcherRef.current = r.state;
          setMatcher(r.state);
          handleEvents(r.events, sequence, dest);
        },
        (err) => note(`geolocation error: ${err.message}`),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
    },
    [acquireWakeLock, ensureAudio, handleEvents, handoff, note, sequence],
  );

  /**
   * The stale-countdown watchdog.
   *
   * `watchPosition` going quiet is invisible to the callback — nothing fires,
   * nothing throws. Only a timer comparing against the last good fix notices,
   * which is why this is a separate interval rather than logic inside onPosition.
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
        handleEvents(r.events, sequence, destIndex);
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [destIndex, handleEvents, matcher, sequence]);

  /**
   * Stops everything. Called explicitly on leaving, and again on unmount.
   *
   * Explicit-before-navigation is the one that matters. Relying on unmount
   * alone leaves a window where the queue is still draining as the route
   * changes, and a stale "Одоо буугаарай" arriving thirty seconds after someone
   * has left ride mode will put them off at the wrong stop. Order matters too:
   * silence the audio FIRST, then release the hardware.
   */
  const teardown = useCallback(async () => {
    queueRef.current?.clear();

    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }

    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        note("wake lock released");
      } catch (e) {
        note(`wake lock release failed: ${e instanceof Error ? e.message : e}`);
      }
      wakeLockRef.current = null;
      setWakeLockActive(false);
    }

    silentAudioRef.current?.pause();
    silentAudioRef.current = null;

    matcherRef.current = null;

    if (ctxRef.current && ctxRef.current.state !== "closed") {
      await ctxRef.current.close().catch(() => {});
    }
    ctxRef.current = null;
    queueRef.current = null;
  }, [note]);

  // Safety net. The explicit call above is what guarantees ordering; this
  // catches a crash, a hardware back button, or a tab close.
  useEffect(() => {
    return () => {
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      void wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
      silentAudioRef.current?.pause();
      queueRef.current?.clear();
      if (ctxRef.current && ctxRef.current.state !== "closed") {
        void ctxRef.current.close().catch(() => {});
      }
    };
  }, []);

  const goHome = useCallback(async () => {
    await teardown();
    router.push("/");
  }, [router, teardown]);

  const advance = useCallback(() => {
    const current = matcherRef.current;
    if (!current || destIndex === null) return;
    const r = manualAdvance(current, sequence);
    matcherRef.current = r.state;
    setMatcher(r.state);
    handleEvents(r.events, sequence, destIndex);
  }, [destIndex, handleEvents, sequence]);

  const finish = useCallback(async () => {
    await teardown();
    clearHandoff(sessionStorage);
    router.push("/bus/wait");
  }, [router, teardown]);

  // ---------------------------------------------------------- render

  if (handoffError) {
    return (
      <main style={{ minHeight: "100vh", background: "#0b0b0b", color: "#fff", padding: 20, fontFamily: "system-ui, sans-serif" }}>
        <div style={{ maxWidth: 560, margin: "0 auto" }}>
          <h1 style={{ fontSize: 24 }}>Алдаа</h1>
          <p style={{ fontSize: 18, color: "#e6a23c" }}>{handoffError}</p>
          <button style={primary} onClick={() => router.push("/bus/wait")}>Буудал сонгох</button>
          <button style={target} onClick={() => router.push("/")}>Үндсэн цэс</button>
        </div>
      </main>
    );
  }

  const remaining = matcher && destIndex !== null ? destIndex - matcher.currentIndex : null;
  const overshot = matcher?.overshot ?? false;

  return (
    <main
      style={{ minHeight: "100vh", background: "#0b0b0b", color: "#fff", padding: 20, fontFamily: "system-ui, sans-serif" }}
      aria-hidden={!screenReaderMode}
    >
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, marginBottom: 2 }}>
          {handoff?.routeDisplayName} → {handoff?.headsign}
        </h1>

        {/* --- destination picker ------------------------------------- */}
        {destIndex === null && handoff && (
          <>
            <p style={{ color: "#aaa", fontSize: 17 }}>Хаана буух вэ?</p>
            {sequence.map((s, i) => {
              // Unnameable stops stay in the SEQUENCE so the count stays right,
              // but cannot be chosen — a user cannot pick what cannot be named.
              if (i <= handoff.boardingIndex || !s.name.trim()) return null;
              return (
                <button key={s.id} style={target} onClick={() => void start(i)}>
                  <span style={{ fontSize: 21 }}>{s.name}</span>
                  <span style={{ display: "block", fontSize: 15, color: "#888" }}>
                    {i - handoff.boardingIndex} буудлын дараа
                  </span>
                </button>
              );
            })}
          </>
        )}

        {/* --- countdown ---------------------------------------------- */}
        {destIndex !== null && matcher && (
          <>
            {overshot ? (
              <div style={{ ...alert, cursor: "default" }}>
                <p style={{ fontSize: 26, margin: 0 }}>Та буудлаа өнгөрчээ</p>
                <p style={{ fontSize: 18, color: "#f5c6c6", marginBottom: 0 }}>
                  Одоо: {sequence[matcher.currentIndex]?.name}
                </p>
              </div>
            ) : (
              <>
                <p style={{ fontSize: 64, margin: "10px 0 0", fontWeight: 700 }}>{remaining}</p>
                <p style={{ fontSize: 20, color: "#aaa", marginTop: 0 }}>буудал үлдлээ</p>
                <p style={{ fontSize: 20 }}>→ {sequence[destIndex]?.name}</p>
                <p style={{ fontSize: 16, color: "#888" }}>
                  Сүүлд: {sequence[matcher.currentIndex]?.name || "—"}
                </p>
              </>
            )}

            {degraded && (
              <div style={{ ...alert, cursor: "default" }}>
                <p style={{ fontSize: 19, margin: 0 }}>
                  Байршил тодорхойгүй. Буудал бүрт товчийг дарна уу.
                </p>
              </div>
            )}

            {/* Always available, not only when degraded: the user knows they
                passed a stop before we do, and waiting for the degraded state
                to surface it would cost them the stop. */}
            {!overshot && (
              <button style={degraded ? primary : target} onClick={advance}>
                Нэг буудал өнгөрлөө
              </button>
            )}

            <button style={target} onClick={() => void finish()}>Дуусгах</button>

            <p style={{ color: "#666", fontSize: 14 }}>
              {wakeLockActive ? "Дэлгэц асаалттай" : "Дэлгэц унтарч болзошгүй"}
              {battery ? ` · батарей ${battery}` : ""}
              {" · GPS өндөр нарийвчлал (батарей их зарцуулна)"}
            </p>
          </>
        )}

        <button style={target} onClick={() => void goHome()}>Үндсэн цэс рүү буцах</button>

        <hr style={{ margin: "24px 0 12px", borderColor: "#222" }} />
        <label style={{ display: "block", fontSize: 16, color: "#aaa" }}>
          <input
            type="checkbox"
            checked={screenReaderMode}
            onChange={(e) => {
              setScreenReaderMode(e.target.checked);
              localStorage.setItem(SETTINGS_KEY, e.target.checked ? "screen-reader" : "app");
              queueRef.current?.clear();
            }}
            style={{ width: 28, height: 28, marginRight: 10, verticalAlign: "middle" }}
          />
          Дэлгэц уншигчийн хоолойг ашиглах
        </label>

        <details>
          <summary style={{ color: "#666", fontSize: 14 }}>Debug</summary>
          <pre style={{ fontSize: 12, color: "#777", whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
        </details>
      </div>
    </main>
  );
}
