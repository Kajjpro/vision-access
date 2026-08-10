"use client";

/**
 * Mode A — waiting at a stop. Rebuilt on the gesture model.
 *
 * WHAT CHANGED AND WHY:
 *
 * The old screen was a column of buttons: press to locate, press to confirm,
 * press a route. Every one of those required finding a target on glass, which
 * is the thing a blind passenger cannot do. Now:
 *
 *   - Locating starts BY ITSELF on arrival. Nothing to press.
 *   - Everything else is one list, scrolled by ear, selected by double-tap
 *     anywhere.
 *   - SAYING the destination is the first option, because scrolling 36 stops
 *     by ear to find one is not a real option for a daily journey.
 *
 * Voice never becomes the only path: if recognition is unsupported, offline, or
 * simply misheard, the route list is right behind it and the app says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CurrentOption, GestureSurface, type A11yOption } from "@/components/GestureSurface";
import { audioContext, hasClip, loadClips, loadTransitClips, playSequence, stopAll } from "@/lib/audio";
import { DEGRADED, GESTURE, SCREEN, VOICE, WAIT } from "@/lib/ui/announcements";
import { useGestureNav } from "@/lib/ui/useGestureNav";
import type { ListOption } from "@/lib/ui/gesture-nav";
import { detectVoiceSupport, listenOnce, matchStops } from "@/lib/ui/voice";
import { buildHandoff, writeHandoff } from "@/lib/transit/handoff";
import { findNearestStop, resolveByRoute, routeChoicesFor, type StopCandidate } from "@/lib/transit/geo";
import type { NextArrivalsResponse, Route, RouteStops, Stop, StopRoutes } from "@/lib/transit/types";

type Phase = "locating" | "no-location" | "no-stop" | "menu" | "listening" | "confirm-voice" | "routes";

/** Spoken before anything else on this screen, so it must decode first. */
const FIRST_CLIPS = [
  SCREEN.wait.clip!, WAIT.searching.clip!, WAIT.sayDestination.clip!, WAIT.browseRoutes.clip!,
  WAIT.noStopNearby.clip!, DEGRADED.location.clip!, VOICE.prompt.clip!, VOICE.didYouSay.clip!,
  VOICE.confirmHint.clip!, VOICE.noMatch.clip!, VOICE.unavailable.clip!,
  "bus_you_are_at", "bus_at_stop_suffix",
];

type Choice =
  | { kind: "voice" }
  | { kind: "browse" }
  | { kind: "route"; routeId: string }
  | { kind: "otherStop" }
  | { kind: "voiceMatch"; stopId: string; name: string };

export function WaitScreen({
  stops, routes, stopRoutes, routeStops,
}: {
  stops: Stop[]; routes: Route[]; stopRoutes: StopRoutes; routeStops: RouteStops;
  manifest?: unknown;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("locating");
  const [stop, setStop] = useState<Stop | null>(null);
  const [candidates, setCandidates] = useState<StopCandidate[]>([]);
  const [arrivals, setArrivals] = useState<NextArrivalsResponse | null>(null);
  const [heard, setHeard] = useState<{ transcript: string; matches: { id: string; name: string }[] } | null>(null);
  const [voiceOff, setVoiceOff] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const lastSpokenRef = useRef<string[]>([]);
  const startedRef = useRef(false);
  const routesById = useMemo(() => new Map(routes.map((r) => [r.id, r])), [routes]);

  const note = useCallback((line: string) => setLog((l) => [line, ...l].slice(0, 30)), []);

  const say = useCallback((clips: (string | undefined | null)[]) => {
    const playable = clips.filter((c): c is string => Boolean(c)).filter(hasClip);
    lastSpokenRef.current = playable;
    if (playable.length) playSequence(playable, { interrupt: true });
  }, []);

  // ------------------------------------------------------------ locate

  /**
   * Runs on arrival, unprompted.
   *
   * Requiring a button press to start was the old screen's first barrier: the
   * user had to find something before the app would tell them anything.
   */
  const locate = useCallback(() => {
    setPhase("locating");
    say([SCREEN.wait.clip, WAIT.searching.clip]);

    if (!("geolocation" in navigator)) {
      setPhase("no-location");
      say([DEGRADED.location.clip]);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const at = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const result = findNearestStop(at, stops);
        note(`fix ±${Math.round(pos.coords.accuracy)}m → ${result.kind}`);

        if (result.kind === "none") {
          // No answer is a real answer. Naming a stop hundreds of metres away
          // would be a confident lie the user cannot check.
          setPhase("no-stop");
          say([WAIT.noStopNearby.clip]);
          return;
        }
        const found = result.kind === "ambiguous" ? result.candidates : result.candidates;
        setCandidates(found);
        setStop(found[0].stop);
        setPhase("menu");

        // Fetch the names this screen is about to speak before speaking them.
        // Only a handful — the nearby stops and the routes serving them.
        const needed = [
          ...found.map((c) => `stop_${c.stop.id}`),
          ...(stopRoutes[found[0].stop.id] ?? []).map((r) => `route_${r}`),
        ];
        void loadTransitClips(needed).then(({ failed }) => {
          if (failed.length) note(`${failed.length} names not yet rendered`);
          say(["bus_you_are_at", `stop_${found[0].stop.id}`, "bus_at_stop_suffix", WAIT.sayDestination.clip]);
        });
      },
      (err) => {
        setPhase("no-location");
        note(`geolocation: ${err.message}`);
        say([DEGRADED.location.clip]);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  }, [note, say, stopRoutes, stops]);

  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    audioContext();
    await loadClips(FIRST_CLIPS);
    void loadClips().catch(() => {});
    locate();
  }, [locate]);

  useEffect(() => () => stopAll(), []);

  // ------------------------------------------------------------ voice

  /**
   * Ask, listen, then READ BACK. Nothing acts on what was heard.
   *
   * The confirmation step is the whole safety property: a misheard stop name
   * puts someone off the bus somewhere they did not choose, and unlike a
   * sighted passenger they cannot glance up and notice.
   */
  const askDestination = useCallback(async () => {
    const support = detectVoiceSupport();
    if (!support.available) {
      note(`voice unavailable: ${support.reason}`);
      setVoiceOff(true);
      say([VOICE.unavailable.clip, WAIT.browseRoutes.clip]);
      setPhase("menu");
      return;
    }

    setPhase("listening");
    say([VOICE.prompt.clip]);
    // Let the prompt finish before the microphone opens, or it records itself.
    await new Promise((r) => setTimeout(r, 2200));

    const outcome = await listenOnce("mn-MN");
    if (outcome.kind === "error") {
      note(`voice error: ${outcome.error}`);
      if (outcome.languageUnsupported) {
        // Permanent for this device — stop offering it rather than inviting a
        // retry that cannot succeed.
        setVoiceOff(true);
        say([VOICE.unavailable.clip, WAIT.browseRoutes.clip]);
      } else {
        say([VOICE.noMatch.clip, WAIT.browseRoutes.clip]);
      }
      setPhase("menu");
      return;
    }

    const matches = matchStops(outcome.transcript, stops, { limit: 5 });
    note(`heard "${outcome.transcript}" → ${matches.length} matches`);
    if (matches.length === 0) {
      say([VOICE.noMatch.clip, WAIT.browseRoutes.clip]);
      setPhase("menu");
      return;
    }

    setHeard({ transcript: outcome.transcript, matches: matches.map((m) => ({ id: m.stop.id, name: m.stop.name })) });
    setPhase("confirm-voice");
    // The read-back is the safety step, so its audio must exist before it runs.
    await loadTransitClips(matches.map((m) => `stop_${m.stop.id}`));
    say([VOICE.didYouSay.clip, `stop_${matches[0].stop.id}`, VOICE.confirmHint.clip]);
  }, [note, say, stops]);

  // ------------------------------------------------------------ board

  const board = useCallback(
    (routeId: string) => {
      if (!stop) return;
      const route = routesById.get(routeId);
      if (!route) return;
      for (const direction of route.directions) {
        const built = buildHandoff(
          { routeId, directionId: direction.id, boardingStopId: stop.id,
            routeDisplayName: route.displayName, headsign: direction.headsign },
          routeStops,
        );
        if (built.ok) {
          writeHandoff(built.handoff, sessionStorage);
          router.push("/bus/ride");
          return;
        }
      }
      note(`cannot board ${route.displayName} here`);
      say([DEGRADED.routeInfo.clip]);
    },
    [note, routeStops, routesById, router, say, stop],
  );

  /**
   * A confirmed spoken destination picks the route for the user.
   *
   * This is the point of speaking: they said where they are going, so the app
   * works out which bus serves it rather than making them choose one.
   */
  const boardTowards = useCallback(
    (destinationStopId: string) => {
      if (!stop) return;
      const here = stopRoutes[stop.id] ?? [];
      for (const routeId of here) {
        const dirs = routeStops[routeId];
        if (!dirs) continue;
        for (const [directionId, sequence] of Object.entries(dirs)) {
          const from = sequence.indexOf(stop.id);
          const to = sequence.indexOf(destinationStopId);
          // Both on this direction, and the destination genuinely ahead of us.
          if (from < 0 || to < 0 || to <= from) continue;
          const route = routesById.get(routeId);
          const built = buildHandoff(
            { routeId, directionId: Number(directionId), boardingStopId: stop.id,
              routeDisplayName: route?.displayName ?? routeId,
              headsign: route?.directions.find((d) => d.id === Number(directionId))?.headsign ?? "" },
            routeStops,
          );
          if (built.ok) {
            writeHandoff({ ...built.handoff }, sessionStorage);
            try {
              sessionStorage.setItem("vision-access:intended-destination", destinationStopId);
            } catch { /* private mode */ }
            note(`voice → ${route?.displayName} dir ${directionId}`);
            router.push("/bus/ride");
            return;
          }
        }
      }
      // Said a real stop, but nothing from here reaches it.
      note("no route from here reaches that stop");
      say([DEGRADED.routeInfo.clip, WAIT.browseRoutes.clip]);
      setPhase("menu");
    },
    [note, routeStops, routesById, router, say, stop, stopRoutes],
  );

  // ------------------------------------------------------------ options

  const options: ListOption<Choice>[] = useMemo(() => {
    if (phase === "confirm-voice" && heard) {
      return heard.matches.map((m) => ({
        value: { kind: "voiceMatch" as const, stopId: m.id, name: m.name },
        keys: [`stop_${m.id}`],
        label: m.name,
      }));
    }
    if (phase === "menu" || phase === "routes") {
      const routeOptions: ListOption<Choice>[] = (stop ? stopRoutes[stop.id] ?? [] : []).map((routeId) => {
        const route = routesById.get(routeId);
        const arrival = arrivals?.arrivals.find((a) => a.routeId === routeId);
        return {
          value: { kind: "route" as const, routeId },
          keys: [`route_${routeId}`],
          label: `${route?.displayName ?? routeId}${arrival ? ` · ойролцоогоор ${arrival.minutes} мин` : ""}`,
        };
      });
      // Speaking first: it is the shortest path to a daily journey.
      const head: ListOption<Choice>[] = voiceOff
        ? []
        : [{ value: { kind: "voice" }, keys: [WAIT.sayDestination.clip!], label: WAIT.sayDestination.mn }];
      const tail: ListOption<Choice>[] =
        candidates.length > 1
          ? [{ value: { kind: "otherStop" }, keys: [WAIT.otherStop.clip!], label: WAIT.otherStop.mn }]
          : [];
      return [...head, ...routeOptions, ...tail];
    }
    return [];
  }, [arrivals, candidates.length, heard, phase, routesById, stop, stopRoutes, voiceOff]);

  const announce = useCallback(
    (option: ListOption<Choice>, ctx: { wrapped: boolean }) => {
      say([ctx.wrapped ? GESTURE.listWrapped.clip : null, ...option.keys]);
    },
    [say],
  );

  const onSelect = useCallback(
    (option: ListOption<Choice>) => {
      const choice = option.value;
      if (choice.kind === "voice") { void askDestination(); return; }
      if (choice.kind === "browse") { setPhase("routes"); return; }
      if (choice.kind === "route") { board(choice.routeId); return; }
      if (choice.kind === "voiceMatch") { boardTowards(choice.stopId); return; }
      if (choice.kind === "otherStop") {
        const next = candidates[1];
        if (next) {
          setStop(next.stop);
          setCandidates([...candidates.slice(1), candidates[0]]);
          say(["bus_you_are_at", `stop_${next.stop.id}`, "bus_at_stop_suffix"]);
        }
      }
    },
    [askDestination, board, boardTowards, candidates, say],
  );

  const nav = useGestureNav<Choice>({
    options,
    announce,
    onSelect,
    onBack: () => {
      if (phase === "confirm-voice") { setPhase("menu"); setHeard(null); say([WAIT.sayDestination.clip]); return; }
      router.push("/");
    },
    onRepeat: () => { if (lastSpokenRef.current.length) playSequence(lastSpokenRef.current, { interrupt: true }); },
    onWhereAmI: (o) => say([GESTURE.whereAmI.clip, SCREEN.wait.clip, stop ? `stop_${stop.id}` : null, ...(o?.keys ?? [])]),
    enabled: phase !== "locating" && phase !== "listening",
  });

  // Arrival times, once a stop is known. The only network call on this screen.
  useEffect(() => {
    if (!stop) return;
    let cancelled = false;
    fetch(`/api/transit/next?stopId=${encodeURIComponent(stop.id)}`)
      .then((r) => r.json())
      .then((body: NextArrivalsResponse) => {
        if (cancelled) return;
        setArrivals(body);
        if (body.degraded) say([DEGRADED.service.clip]);
      })
      .catch(() => { if (!cancelled) say([DEGRADED.network.clip]); });
    return () => { cancelled = true; };
  }, [say, stop]);

  const a11yOptions: A11yOption[] = options.map((o, i) => ({
    label: o.label,
    selected: i === nav.index,
    onActivate: () => { nav.setIndex(i); onSelect(o); },
  }));

  const handlers = {
    ...nav.handlers,
    onTouchStart: (e: React.TouchEvent) => { void start(); nav.handlers.onTouchStart(e); },
  };

  const title =
    phase === "locating" ? WAIT.searching.mn
    : phase === "listening" ? VOICE.listening.mn
    : phase === "no-stop" ? WAIT.noStopNearby.mn
    : phase === "no-location" ? DEGRADED.location.mn
    : nav.current?.label ?? (stop?.name ?? SCREEN.wait.mn);

  return (
    <GestureSurface
      handlers={handlers}
      options={a11yOptions}
      onFocusOption={(i) => { void start(); nav.setIndex(i); }}
    >
      <CurrentOption
        title={title}
        detail={stop?.name}
        position={options.length ? `${nav.index + 1} / ${options.length}` : undefined}
      />
      <details style={{ position: "absolute", bottom: 6, left: 6, fontSize: 11, color: "#333" }}>
        <summary>debug</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
      </details>
    </GestureSurface>
  );
}
