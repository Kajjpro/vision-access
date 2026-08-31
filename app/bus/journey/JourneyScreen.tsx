"use client";

/**
 * Spoken journey capture — "I am at X, I want to go to Y" → "take route N".
 *
 * The gesture vocabulary is the app's existing one, not a new one:
 *
 *   hold          speak (push-to-talk; the microphone is live only while held)
 *   double-tap    confirm — and NOTHING commits without it
 *   swipe left    reject / re-ask
 *   two-finger tap  start over
 *   swipe up/down  move through candidates, double-tap to pick one
 *
 * The last of those is how disambiguation is answered. `chooseCandidate(n)`
 * takes a 1-based number, but a rider is never asked to produce a number by
 * gesture — the candidates become an ordinary option list, read aloud one at a
 * time, exactly like every other list in this app. Selecting the option at
 * index i calls chooseCandidate(i + 1).
 *
 * VOICE IS NEVER THE ONLY PATH. When both engines fail — permission refused,
 * offline, Mongolian unsupported — `onFallbackNeeded` swaps the same list over
 * to every reachable stop and the journey continues by gesture alone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { audioContext, loadClips, stopAll } from "@/lib/audio";
import { discardWarmMicrophone, warmMicrophone } from "@/lib/speech/mic";
import type { Route, RouteStops, Stop as PipelineStop } from "@/lib/transit/types";
import { toSpeechTransitData, type KeyedPipelineStop } from "@/lib/routing/adapt";
import { PHRASES, stopClip } from "@/lib/speech/announcements";
import type { ListOption } from "@/lib/ui/gesture-nav";
import { createSpeaker } from "@/lib/ui/speak";
import { useGestureNav } from "@/lib/ui/useGestureNav";
import { useVoiceJourney } from "@/lib/ui/useVoiceJourney";

/** Decoded at startup so the first question never waits on a fetch. */
const FIRST_CLIPS = [
  PHRASES.askOrigin, PHRASES.askDestination, PHRASES.holdToSpeak, PHRASES.listening,
  PHRASES.notHeard, PHRASES.whichOne, PHRASES.or, PHRASES.from, PHRASES.to,
  PHRASES.confirmPrefix, PHRASES.confirmSuffix, PHRASES.boardRoute,
  PHRASES.boardRouteSuffix, PHRASES.stopsCount, PHRASES.sameStop,
  PHRASES.wrongDirection, PHRASES.noRoute, PHRASES.micDenied,
  PHRASES.useListInstead, PHRASES.offline,
].filter(Boolean);

type Choice =
  | { kind: "candidate"; index: number }
  | { kind: "fallbackStop"; stopId: string };

export function JourneyScreen({
  stops,
  routes,
  routeStops,
}: {
  stops: PipelineStop[];
  routes: Route[];
  routeStops: RouteStops;
}) {
  const [log, setLog] = useState<string[]>([]);
  const note = useCallback((line: string) => setLog((l) => [line, ...l].slice(0, 30)), []);

  const [position, setPosition] = useState<[number, number] | undefined>();
  const [fallback, setFallback] = useState(false);

  /**
   * Adapted once. The key check walks 923 stops and the direction mapper walks
   * every direction of every route — neither belongs in a render path that
   * runs on every GPS update.
   */
  const data = useMemo(
    () => toSpeechTransitData(stops as KeyedPipelineStop[], routes, routeStops),
    [routeStops, routes, stops],
  );

  const speak = useMemo(
    () => createSpeaker({ onMissing: (ids) => note(`MISSING CLIP: ${ids.join(", ")}`) }),
    [note],
  );

  const journey = useVoiceJourney({
    stops: data.stops,
    routes: data.routes,
    mapDirection: data.mapDirection,
    speak,
    position,
    onResolved: (leg) => note(`route ${leg.route.name} ${leg.direction} ${leg.hops} hops`),
    onFallbackNeeded: () => {
      note("voice unavailable — falling back to the stop list");
      setFallback(true);
    },
  });

  const { phase, candidates, beginListening, endListening, chooseCandidate,
    confirm, reject, restart, start } = journey;

  // ------------------------------------------------------------- startup

  /**
   * `started` is state, not just the ref.
   *
   * The ref guards against a second start; the state is what `enabled` below
   * reads. A ref read during render does not re-render when it changes, so
   * gestures would have stayed disabled after the first tap until something
   * else happened to re-render — on a screen where the first tap IS the
   * interface, that is the whole app appearing dead.
   */
  const startedRef = useRef(false);
  const [started, setStarted] = useState(false);

  const begin = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    // The AudioContext must be created inside the gesture that started us.
    audioContext();
    await loadClips(FIRST_CLIPS as string[]);
    setStarted(true);
    start();
  }, [start]);

  // A warm microphone must never outlive the screen that opened it.
  useEffect(() => () => { stopAll(); discardWarmMicrophone(); }, []);

  // GPS biases ORIGIN matching only — the rider is standing at the origin.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setPosition([p.coords.latitude, p.coords.longitude]),
      () => { /* the flow works without it; it only breaks same-name ties */ },
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // --------------------------------------------------------------- lists

  const placesById = useMemo(() => {
    // One entry per PLACE, not per platform: offering both sides of a road to
    // someone who cannot see which side they are on is not a choice.
    const seen = new Set<string>();
    return data.stops.filter((s) => {
      const key = s.placeKey ?? s.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [data.stops]);

  const options: ListOption<Choice>[] = useMemo(() => {
    if (fallback) {
      return placesById.map((s) => ({
        value: { kind: "fallbackStop" as const, stopId: s.id },
        keys: [stopClip(s.id)],
        label: s.name,
      }));
    }
    if (phase === "disambiguating") {
      return candidates.map((m, i) => ({
        value: { kind: "candidate" as const, index: i },
        keys: [stopClip(m.stop.id)],
        label: m.stop.name,
      }));
    }
    return [];
  }, [candidates, fallback, phase, placesById]);

  const { chooseStop } = journey;

  const onSelect = useCallback(
    (option: ListOption<Choice>) => {
      const choice = option.value;
      if (choice.kind === "candidate") {
        // chooseCandidate is 1-based, matching the spoken numbering.
        chooseCandidate(choice.index + 1);
        return;
      }
      const stop = data.stops.find((s) => s.id === choice.stopId);
      if (!stop) return;
      note(`fallback picked ${stop.name}`);
      /**
       * The fallback fills the same slot the voice flow would have, through the
       * same commit path — so the read-back and the confirming double-tap are
       * identical whether the destination was spoken or chosen from the list.
       * A parallel path that skipped the read-back would mean the safety
       * property held only for the input mode that happened to be working.
       */
      chooseStop(stop);
    },
    [chooseCandidate, chooseStop, data.stops, note],
  );

  // ------------------------------------------------------------ gestures

  const listening = phase === "awaiting-origin" || phase === "awaiting-destination";

  const nav = useGestureNav<Choice>({
    options,
    enabled: started,
    resetKey: fallback ? "fallback" : phase,
    announce: (option) => speak(option.keys),
    onSelect,
    // Double-tap outside a list is the confirmation. Nothing commits without it.
    onBack: () => reject(),
    onRepeat: () => restart(),
    holdMode: listening,
    /**
     * The microphone is asked for on the way down, not 600 ms later when the
     * press is confirmed as a hold. iOS shows the permission prompt only inside
     * a touch handler, and `onHoldStart` arrives from a timer — so on iOS the
     * prompt was never shown, permission was never granted, and every hold on
     * this screen recorded nothing at all.
     */
    onHoldPrewarm: () => warmMicrophone(),
    onHoldStart: () => beginListening(),
    onHoldEnd: () => endListening(),
    intercept: (gesture) => {
      // The confirmation prompt takes the select gesture before navigation can,
      // because at that moment there is no list to navigate.
      if (gesture.type === "select" && phase === "confirming") {
        confirm();
        return true;
      }
      return false;
    },
  });

  return (
    <main
      {...nav.handlers}
      onClick={begin}
      className="fixed inset-0 bg-black text-white p-4 select-none touch-none"
      aria-label="Аяллын дуут оруулга"
    >
      <p className="text-2xl">{phase}</p>
      <p className="text-lg opacity-70">
        {journey.origin?.name ?? "—"} → {journey.destination?.name ?? "—"}
      </p>
      {listening && <p className="text-xl mt-2">Дэлгэцийг дараад барина уу</p>}
      {/* Debug goes ON SCREEN: there is no console on a phone. */}
      <ul className="mt-4 text-xs opacity-60 space-y-1">
        {log.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </main>
  );
}
