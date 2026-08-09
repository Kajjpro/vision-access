"use client";

/**
 * Mode A — waiting at a stop.
 *
 * The whole flow must be completable with the screen off. Visual text is
 * `aria-hidden` and every state change speaks through the audio queue, so our
 * pre-rendered Mongolian and TalkBack do not read the same thing twice over
 * each other. The settings toggle inverts that for users who prefer their own
 * screen reader's voice.
 *
 * Screen order is fixed: locate → confirm the stop → pick a route → hear
 * arrivals → board. A user who cannot see the screen relies on that order not
 * changing between sessions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { AudioQueue, type QueueEvent } from "@/lib/transit/audio-queue";
import { ManifestClipPlayer } from "@/lib/transit/clip-player";
import {
  announceArrival, announceAtStop, announceDegraded, announceLocationUnavailable,
  announceNoStopNearby, announceRoute, routeKey, stopKey,
} from "@/lib/transit/announce";
import { buildHandoff, writeHandoff } from "@/lib/transit/handoff";
import { findNearestStop, resolveByRoute, routeChoicesFor, type StopCandidate } from "@/lib/transit/geo";
import type {
  AudioManifest, NextArrivalsResponse, Route, RouteStops, Stop, StopRoutes,
} from "@/lib/transit/types";

type Phase = "idle" | "locating" | "no-location" | "no-stop" | "ambiguous" | "confirm" | "routes" | "arrivals";

const SETTINGS_KEY = "vision-access:announce-mode";

/** Standing on a moving bus, not looking at the screen. */
const touchTarget: React.CSSProperties = {
  display: "block", width: "100%", minHeight: 88, padding: "18px 20px",
  marginBottom: 14, borderRadius: 14, border: "2px solid #3a3a3a",
  background: "#1c1c1c", color: "#fff", fontSize: 22, textAlign: "left",
  fontFamily: "inherit", cursor: "pointer",
};
const primaryTarget: React.CSSProperties = {
  ...touchTarget, minHeight: 120, background: "#1d4e2a", borderColor: "#2f6b3f", fontSize: 26,
};

export function WaitScreen({
  stops, routes, stopRoutes, routeStops, manifest,
}: {
  stops: Stop[]; routes: Route[]; stopRoutes: StopRoutes; routeStops: RouteStops; manifest: AudioManifest;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [candidates, setCandidates] = useState<StopCandidate[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [ambiguous, setAmbiguous] = useState<{ name: string; candidates: StopCandidate[] } | null>(null);
  const [stop, setStop] = useState<Stop | null>(null);
  const [arrivals, setArrivals] = useState<NextArrivalsResponse | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [missingClips, setMissingClips] = useState<string[]>([]);
  /** false = our audio drives everything (default); true = defer to the screen reader. */
  const [screenReaderMode, setScreenReaderMode] = useState(false);

  const queueRef = useRef<AudioQueue | null>(null);
  const playerRef = useRef<ManifestClipPlayer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  const routesById = useMemo(() => new Map(routes.map((r) => [r.id, r])), [routes]);

  // Debug output goes ON SCREEN — there is no console on a phone.
  const note = useCallback((line: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 40));
  }, []);

  useEffect(() => {
    setScreenReaderMode(localStorage.getItem(SETTINGS_KEY) === "screen-reader");
  }, []);

  /**
   * The AudioContext MUST be constructed inside a user gesture or iOS leaves it
   * suspended forever — so everything starts from the one big button.
   */
  const ensureAudio = useCallback(async () => {
    if (!ctxRef.current) {
      if ("audioSession" in navigator) {
        (navigator as unknown as { audioSession: { type: string } }).audioSession.type = "playback";
      }
      ctxRef.current = new AudioContext();
    }
    if (ctxRef.current.state === "suspended") await ctxRef.current.resume();

    if (!playerRef.current) {
      const player = new ManifestClipPlayer(manifest, ctxRef.current);
      playerRef.current = player;
      const queue = new AudioQueue(player);
      queue.on((e: QueueEvent) => {
        if (e.type === "missing") {
          setMissingClips((m) => [...new Set([...m, ...e.keys])]);
          note(`NO CLIP: ${e.keys.join(", ")}`);
        } else if (e.type === "start") {
          note(`say: ${e.announcement.label ?? e.announcement.keys.join("+")}`);
        }
      });
      queueRef.current = queue;
      const { failed } = await player.load();
      if (failed.length) note(`${failed.length} clips failed to decode`);
    }
    return queueRef.current!;
  }, [manifest, note]);

  const say = useCallback(
    async (...announcements: ReturnType<typeof announceAtStop>[]) => {
      if (screenReaderMode) return; // the user's own screen reader is driving
      const queue = await ensureAudio();
      for (const a of announcements) queue.push(a);
    },
    [ensureAudio, screenReaderMode],
  );

  const hasClip = useCallback((key: string) => Boolean(manifest[key]), [manifest]);

  // ---------------------------------------------------------------- locate

  const locate = useCallback(async () => {
    await ensureAudio();
    setPhase("locating");
    note("requesting position…");

    if (!("geolocation" in navigator)) {
      setPhase("no-location");
      void say(announceLocationUnavailable());
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const at = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        note(`fix ±${Math.round(pos.coords.accuracy)} m`);
        const result = findNearestStop(at, stops);

        if (result.kind === "none") {
          // We have no answer, so we say we have no answer rather than naming
          // something far away that the user cannot check against a sign.
          setPhase("no-stop");
          note(`nearest is ${result.nearestDistanceM?.toFixed(0) ?? "?"} m — beyond 150 m`);
          void say(announceNoStopNearby());
          return;
        }

        if (result.kind === "ambiguous") {
          // GPS error exceeds the gap between them, so position is not evidence.
          // Ask which route instead.
          setAmbiguous({ name: result.sharedName, candidates: result.candidates });
          setPhase("ambiguous");
          note(`${result.candidates.length} stops share "${result.sharedName}" — resolving by route`);
          return;
        }

        setCandidates(result.candidates);
        setCandidateIndex(0);
        setStop(result.candidates[0].stop);
        setPhase("confirm");
        void say(announceAtStop(result.candidates[0].stop));
      },
      (err) => {
        setPhase("no-location");
        note(`geolocation error: ${err.message}`);
        void say(announceLocationUnavailable());
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  }, [ensureAudio, note, say, stops]);

  const cycleCandidate = useCallback(() => {
    if (candidates.length < 2) return;
    const next = (candidateIndex + 1) % candidates.length;
    setCandidateIndex(next);
    setStop(candidates[next].stop);
    void say(announceAtStop(candidates[next].stop));
  }, [candidateIndex, candidates, say]);

  // ------------------------------------------------------------- arrivals

  const loadArrivals = useCallback(
    async (forStop: Stop) => {
      setPhase("arrivals");
      note(`fetching arrivals for ${forStop.name}`);
      try {
        const res = await fetch(`/api/transit/next?stopId=${encodeURIComponent(forStop.id)}`);
        const body = (await res.json()) as NextArrivalsResponse;
        setArrivals(body);
        note(`${body.arrivals.length} arrivals${body.degraded ? ` (degraded: ${body.degraded})` : ""}`);

        // Degradation is spoken, never silent: silence reads as "nothing to
        // report", which here means "no bus is coming".
        if (body.degraded) void say(announceDegraded(body.degraded));

        for (const a of body.arrivals.slice(0, 3)) {
          const announcement = announceArrival(a, hasClip);
          if (announcement) void say(announcement);
          else note(`no announcement for ${a.routeDisplayName} (${a.minutes} min — outside 1..40)`);
        }
      } catch (e) {
        note(`arrival fetch failed: ${e instanceof Error ? e.message : e}`);
        setArrivals({ stopId: forStop.id, arrivals: [], degraded: "offline", generatedAt: new Date().toISOString() });
        void say(announceDegraded("offline"));
      }
    },
    [hasClip, note, say],
  );

  // --------------------------------------------------------------- board

  const board = useCallback(
    (routeId: string) => {
      if (!stop) return;
      const route = routesById.get(routeId);
      if (!route) return;

      // Try each direction; hand off only where the boarding stop has a known
      // position in the ordered sequence. Without an index there is nothing to
      // count from, and a guessed one would be confidently wrong all trip.
      for (const direction of route.directions) {
        const built = buildHandoff(
          {
            routeId, directionId: direction.id, boardingStopId: stop.id,
            routeDisplayName: route.displayName, headsign: direction.headsign,
          },
          routeStops,
        );
        if (built.ok) {
          writeHandoff(built.handoff, sessionStorage);
          note(`handoff: ${route.displayName} dir ${direction.id} index ${built.handoff.boardingIndex}`);
          router.push("/bus/ride");
          return;
        }
      }
      note(`cannot board ${route.displayName} here — stop is not in either direction's sequence`);
      void say(announceDegraded("no-service"));
    },
    [note, routeStops, routesById, router, say, stop],
  );

  /** Flush audio before leaving, so nothing speaks over the next screen. */
  const goHome = useCallback(async () => {
    queueRef.current?.clear();
    queueRef.current = null;
    if (ctxRef.current && ctxRef.current.state !== "closed") {
      await ctxRef.current.close().catch(() => {});
    }
    ctxRef.current = null;
    router.push("/");
  }, [router]);

  useEffect(() => {
    return () => {
      queueRef.current?.clear();
      if (ctxRef.current && ctxRef.current.state !== "closed") {
        void ctxRef.current.close().catch(() => {});
      }
    };
  }, []);

  const stopRouteIds = stop ? stopRoutes[stop.id] ?? [] : [];

  // ---------------------------------------------------------------- render
  // Every visual element is aria-hidden: announcements come from the audio
  // queue, so a screen reader must not read the same thing a second time.

  return (
    <main
      style={{ minHeight: "100vh", background: "#0b0b0b", color: "#fff", padding: 20, fontFamily: "system-ui, sans-serif" }}
      aria-hidden={!screenReaderMode}
    >
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Автобус хүлээх</h1>
        <p style={{ color: "#888", fontSize: 15, marginTop: 0 }}>
          {phase === "idle" && "Товчийг дарна уу"}
          {phase === "locating" && "Байршил тодорхойлж байна…"}
          {phase === "no-location" && "Байршил тодорхойгүй байна"}
          {phase === "no-stop" && "Ойролцоо буудал олдсонгүй"}
        </p>

        {phase === "idle" && (
          <button style={primaryTarget} onClick={locate}>Буудлаа олох</button>
        )}

        {(phase === "no-location" || phase === "no-stop") && (
          <button style={primaryTarget} onClick={locate}>Дахин оролдох</button>
        )}

        {phase === "ambiguous" && ambiguous && (
          <>
            <p style={{ fontSize: 18, color: "#ccc" }}>
              {ambiguous.candidates.length} буудал нэг нэртэй: {ambiguous.name}. Аль чиглэл рүү явах вэ?
            </p>
            {routeChoicesFor(ambiguous.candidates, stopRoutes).map((routeId) => {
              const route = routesById.get(routeId);
              return (
                <button
                  key={routeId}
                  style={touchTarget}
                  onClick={() => {
                    // Resolve by ROUTE, not by which is nearer.
                    const picked = resolveByRoute(ambiguous.candidates, routeId, stopRoutes);
                    if (!picked) return;
                    setStop(picked.stop);
                    setCandidates(ambiguous.candidates);
                    setAmbiguous(null);
                    setPhase("confirm");
                    void say(announceAtStop(picked.stop));
                  }}
                >
                  {route?.displayName ?? routeId}
                  <span style={{ display: "block", fontSize: 15, color: "#aaa" }}>{route?.longName ?? ""}</span>
                </button>
              );
            })}
          </>
        )}

        {phase === "confirm" && stop && (
          <>
            <p style={{ fontSize: 26, margin: "18px 0 8px" }}>{stop.name}</p>
            <p style={{ color: "#888", marginTop: 0 }}>
              {candidates[candidateIndex]?.distanceM.toFixed(0)} м
              {candidates.length > 1 ? ` · ${candidateIndex + 1}/${candidates.length}` : ""}
            </p>
            <button style={primaryTarget} onClick={() => { setPhase("routes"); void loadArrivals(stop); }}>
              Тийм, энэ буудал
            </button>
            {candidates.length > 1 && (
              <button style={touchTarget} onClick={cycleCandidate}>Өөр буудал</button>
            )}
          </>
        )}

        {(phase === "routes" || phase === "arrivals") && stop && (
          <>
            <p style={{ fontSize: 22, margin: "18px 0 6px" }}>{stop.name}</p>
            {arrivals?.degraded && (
              <p style={{ color: "#e6a23c", fontSize: 16 }}>
                Тооцоолсон хугацаа ({arrivals.degraded})
              </p>
            )}
            {stopRouteIds.map((routeId) => {
              const route = routesById.get(routeId);
              const arrival = arrivals?.arrivals.find((a) => a.routeId === routeId);
              return (
                <button key={routeId} style={touchTarget} onClick={() => board(routeId)}>
                  <span style={{ fontSize: 24 }}>{route?.displayName ?? routeId}</span>
                  <span style={{ display: "block", fontSize: 17, color: "#9ad", marginTop: 4 }}>
                    {arrival ? `ойролцоогоор ${arrival.minutes} минутын дараа` : "хугацаа тодорхойгүй"}
                  </span>
                </button>
              );
            })}
            {stopRouteIds.length === 0 && <p style={{ color: "#c66" }}>Энэ буудлаар автобус явахгүй</p>}
          </>
        )}

        <button style={touchTarget} onClick={() => void goHome()}>Үндсэн цэс рүү буцах</button>

        <hr style={{ margin: "28px 0 14px", borderColor: "#222" }} />

        <label style={{ display: "block", fontSize: 16, color: "#aaa", marginBottom: 16 }}>
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

        {missingClips.length > 0 && (
          <p style={{ color: "#e6a23c", fontSize: 14 }}>
            {missingClips.length} дуут файл дутуу (pilot render covers 4 routes)
          </p>
        )}

        <details>
          <summary style={{ color: "#666", fontSize: 14 }}>Debug</summary>
          <pre style={{ fontSize: 12, color: "#777", whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
        </details>
      </div>
    </main>
  );
}
