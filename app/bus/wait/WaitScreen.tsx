"use client";

/**
 * Mode A — destination first.
 *
 * The first question is "хаашаа явах вэ?", never "which route". Route selection
 * is this screen's problem: the user says or picks a place, and the planner
 * works out which bus serves it.
 *
 * The flow, all by ear:
 *
 *   locate (automatic)  →  destination list  →  plan  →  wait  →  boarding
 *
 * Nothing here requires sight. Every phase speaks itself on entry, the option
 * list is scrolled by swipe and selected by double-tap anywhere, and a long
 * press re-states where you are at any point. The destination list leads with
 * the places this user actually goes, because most journeys repeat.
 *
 * ARRIVAL TIMES ARE ALWAYS HEDGED. We ship schedule-only — the City vehicle
 * feed is closed to us — so every minute count comes from the OTP proxy or a
 * headway, and lib/transit/announce.ts puts "ойролцоогоор" in front of it with
 * no way for this file to opt out.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CurrentOption, GestureSurface, type A11yOption } from "@/components/GestureSurface";
import {
  hasClip, loadClips, loadTransitClips, playListenCue, playSequence, stopAll, audioContext,
} from "@/lib/audio";
import { discardWarmMicrophone, warmMicrophone } from "@/lib/speech/mic";
import { DEGRADED, GESTURE, JOURNEY, LIST, SCREEN, VOICE, WAIT } from "@/lib/ui/announcements";
import { useGestureNav } from "@/lib/ui/useGestureNav";
import { vibrate, type ListOption } from "@/lib/ui/gesture-nav";
/**
 * The engine here used to be `detectVoiceSupport` + `listen` from
 * `lib/ui/voice.ts` — Web Speech only. Chrome does not list `mn-MN`, so this
 * screen answered "voice input is unavailable" every time a rider asked to
 * speak a destination. Swapped to the capture path `/bus/journey` already uses
 * and that is verified at 95% on real stop names. Same contract, working
 * engine; see lib/ui/listen-any.ts.
 */
import { detectCaptureSupport, listenAnyEngine } from "@/lib/ui/listen-any";
import {
  buildStopGroups, frequentDestinations, loadSearchHistory, recordDestination,
  saveSearchHistory, searchStopsAny, type SearchHistory, type StopGroup,
} from "@/lib/ui/stop-search";
import { describeCountdown } from "@/lib/transit/announce";
import { createEarconPlayer } from "@/lib/transit/earcons";
import { armRecordingFromUrl } from "@/lib/transit/recorder";
import {
  becameDue, countdownFor, countdownKeys, COUNTDOWN_CLIP_IDS, crossedAlert, DUE_VIBRATION, earconForMark,
  isStale, MAX_SPOKEN_NUMBER, waitVibration, type Countdown,
} from "@/lib/transit/eta";
import { planJourney, reachableFrom, type JourneyOption } from "@/lib/transit/planner";
import { buildHandoff, writeHandoff } from "@/lib/transit/handoff";
import { findNearestStop, stopsWithin } from "@/lib/transit/geo";
import { locate as runLocate } from "@/lib/transit/locate";
import type { NextArrivalsResponse, Route, RouteStops, Stop, StopRoutes } from "@/lib/transit/types";

type Phase =
  | "locating" | "no-location" | "no-stop"
  | "destinations" | "listening" | "confirm-destination" | "browsing"
  | "routes" | "no-route";

/** Spoken before anything else here, so these must decode first. */
const FIRST_CLIPS = [
  SCREEN.wait.clip!, WAIT.searching.clip!, WAIT.noStopNearby.clip!,
  JOURNEY.askDestination.clip!, JOURNEY.planning.clip!, JOURNEY.noRoute.clip!,
  JOURNEY.routeNeededSuffix.clip!, JOURNEY.stopsToTravelSuffix.clip!,
  JOURNEY.transferWarning.clip!, JOURNEY.liveUnavailable.clip!,
  DEGRADED.location.clip!, VOICE.prompt.clip!, VOICE.didYouSay.clip!,
  VOICE.confirmHint.clip!, VOICE.noMatch.clip!, VOICE.unavailable.clip!,
  // Spoken between recognition attempts. Absent from this list it decodes too
  // late to play, and the retry arrives as unexplained silence.
  VOICE.notUnderstood.clip!,
  LIST.recentHeading.clip!, "bus_you_are_at", "bus_at_stop_suffix", "bus_approx_prefix",
];

/**
 * How far around the user to collect boarding platforms.
 *
 * Wider than the 150 m used to NAME a stop, and deliberately so: the two
 * directions of a route share no stop ids, so a return journey boards from the
 * opposite platform — which on ШҮ:1 sits 344 m away. Planning from a single
 * platform makes return trips look unroutable (18 % of same-name pairs are
 * further apart than 150 m), so every nearby platform is offered to the planner
 * and it picks.
 */
const BOARDING_RADIUS_M = 400;

/**
 * Silence between the phone finishing a question and the microphone opening.
 *
 * Short, but not zero: the tail of a clip and the mic opening in the same
 * instant means the engine's first audio frame is our own reverb, and a person
 * needs a beat to register that a question has ended before they answer it.
 */
const PROMPT_GAP_MS = 250;

/**
 * How many boarding platforms get their own arrivals call.
 *
 * One per DISTINCT platform among the suggested plans, capped. Each is an
 * upstream call against a gateway that locks the whole account out for ~14
 * minutes when it is pushed (lib/transit/breaker.ts), and the planner offers at
 * most MAX_OPTIONS routes anyway.
 */
const MAX_ARRIVAL_STOPS = 3;

/**
 * How often the arrivals are re-fetched while someone is actually waiting.
 *
 * Longer than the proxy's own 45 s cache, so most refreshes are free to the
 * gateway and still newer than the window in which a schedule estimate drifts.
 */
const ARRIVALS_REFRESH_MS = 60_000;

/** How often the derived countdown is recomputed. Minutes, not seconds. */
const COUNTDOWN_TICK_MS = 10_000;

type Choice =
  | { kind: "voice" }
  | { kind: "browse" }
  /** "I am actually at this other stop" — corrects a low-confidence match. */
  | { kind: "here"; stop: Stop }
  | { kind: "destination"; group: StopGroup }
  | { kind: "plan"; option: JourneyOption };

export function WaitScreen({
  stops, routes, stopRoutes, routeStops,
}: {
  stops: Stop[]; routes: Route[]; stopRoutes: StopRoutes; routeStops: RouteStops;
  manifest?: unknown;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("locating");
  const [here, setHere] = useState<{ lat: number; lon: number } | null>(null);
  const [nearbyStop, setNearbyStop] = useState<Stop | null>(null);
  /**
   * The other stops the fix could plausibly mean, offered so a wrong guess is
   * correctable. With a coarse fix the top candidate is right about half the
   * time, but the right one is almost always in this list.
   */
  const [nearbyOptions, setNearbyOptions] = useState<Stop[]>([]);
  const [boardingIds, setBoardingIds] = useState<string[]>([]);
  const [destination, setDestination] = useState<StopGroup | null>(null);
  const [plans, setPlans] = useState<JourneyOption[]>([]);
  const [candidates, setCandidates] = useState<StopGroup[]>([]);
  const [history, setHistory] = useState<SearchHistory>({});
  const [voiceOff, setVoiceOff] = useState(false);
  /**
   * Arrivals keyed by the stop they were fetched FOR.
   *
   * A single response used to be fetched for `plans[0]`'s boarding stop and
   * then matched against every option by route id alone. Boarding platforms are
   * collected within 400 m and the two directions of a route share no stop ids,
   * so the second and third suggestions routinely board somewhere else — and
   * were given the first stop's times. The map makes that impossible: an option
   * can only ever read the arrivals for its own platform.
   */
  const [arrivalsByStop, setArrivalsByStop] = useState<Map<string, NextArrivalsResponse>>(new Map());
  /**
   * The clock the countdowns are derived against.
   *
   * State rather than `Date.now()` at render, because the render has to happen
   * for the number to change. Ticking it is what turns a frozen estimate into a
   * countdown — see lib/transit/eta.ts.
   */
  const [now, setNow] = useState(() => Date.now());
  const [log, setLog] = useState<string[]>([]);

  const lastSpokenRef = useRef<string[]>([]);
  const startedRef = useRef(false);

  const routesById = useMemo(() => new Map(routes.map((r) => [r.id, r])), [routes]);
  const groups = useMemo(() => buildStopGroups(stops), [stops]);

  const note = useCallback((line: string) => setLog((l) => [line, ...l].slice(0, 30)), []);

  /**
   * The earcon channel. Synthesized, so it survives a total decode failure.
   *
   * Fire-and-forget with its own abort controller: this screen speaks through
   * `playSequence` rather than the AudioQueue, so there is no drain loop to
   * sequence the tone against the words. That is acceptable here because the
   * wait-screen ladder fires on a MARK CROSSING — an event that happens at most
   * four times in a wait — rather than continuously, so the tone leading the
   * speech by a few tens of milliseconds is the whole interaction.
   */
  const playEarcon = useCallback((id: "soft" | "alert" | "urgent") => {
    try {
      const player = createEarconPlayer(() => audioContext());
      void player.play(id, new AbortController().signal).catch(() => {
        // The redundant channel must never cost the words that follow it.
      });
    } catch {
      // No AudioContext yet — the first gesture has not happened.
    }
  }, []);

  /** Returns how long the utterance occupies, so a caller can wait for it exactly. */
  const say = useCallback((clips: (string | undefined | null)[]): number => {
    const playable = clips.filter((c): c is string => Boolean(c)).filter(hasClip);
    lastSpokenRef.current = playable;
    if (!playable.length) return 0;
    return playSequence(playable, { interrupt: true });
  }, []);

  /**
   * Speaks, and waits for the audio to ACTUALLY finish.
   *
   * The voice flow used to wait a fixed 2200 ms — a guess at the length of a
   * clip that TTS can re-render at any length. Guess short and the microphone
   * opens while the phone is still speaking, so the engine transcribes our own
   * question; guess long and there is dead air in which the user starts talking
   * before anything is listening, and the first syllable of a Mongolian stop
   * name is the most distinctive part of it. `playSequence` knows the real
   * duration because it scheduled the clips on the audio clock.
   */
  const sayAndWait = useCallback(
    async (clips: (string | undefined | null)[]) => {
      const seconds = say(clips);
      await new Promise((r) => setTimeout(r, seconds * 1000 + PROMPT_GAP_MS));
    },
    [say],
  );

  // A warm microphone must never outlive the screen that opened it.
  useEffect(() => () => { stopAll(); discardWarmMicrophone(); }, []);

  // ---------------------------------------------------------- locate

  /**
   * Runs on arrival, unprompted. Nothing to find, nothing to press.
   *
   * Waits for GPS to CONVERGE rather than believing the first answer. The
   * previous version asked once with `maximumAge: 30000`, which on a cold start
   * hands back a cell-tower estimate hundreds of metres out — and then matched
   * stops against it and reported "no stop nearby" while the user stood at one.
   * See lib/transit/locate.ts.
   */
  const locate = useCallback(async () => {
    setPhase("locating");
    say([SCREEN.wait.clip, WAIT.searching.clip]);

    const outcome = await runLocate({
      geolocation: typeof navigator !== "undefined" && "geolocation" in navigator ? navigator.geolocation : null,
      onEvent: (e) => {
        if (e.type === "improved") note(`fix ±${Math.round(e.accuracyM)}m`);
        // Say something while GPS settles. Silence during a 12-second wait is
        // indistinguishable from the app having died.
        if (e.type === "progress") say([WAIT.stillLocating.clip]);
      },
    });

    if (outcome.kind === "denied" || outcome.kind === "unavailable" || outcome.kind === "timeout") {
      setPhase("no-location");
      note(`locate: ${outcome.kind}`);
      say([DEGRADED.location.clip]);
      return;
    }

    if (outcome.kind === "poor") {
      // A signal problem, NOT a stop problem — different phrase, because the
      // useful action is to move into the open rather than to walk off looking
      // for a stop.
      setPhase("no-location");
      note(`locate: poor fix ±${Math.round(outcome.best.accuracyM)}m`);
      say([WAIT.gpsWeak.clip]);
      return;
    }

    const { fix } = outcome;
    const at = { lat: fix.lat, lon: fix.lon };
    setHere(at);

    // The search radius scales with the reported accuracy — a fixed 150 m
    // assumes the phone is exactly where it says it is.
    const nearest = findNearestStop(at, stops, { accuracyM: fix.accuracyM });
    note(`fix ±${Math.round(fix.accuracyM)}m${outcome.converged ? " (converged)" : ""} → ${nearest.kind}`);

    if (nearest.kind === "unusable-fix") {
      setPhase("no-location");
      say([WAIT.gpsWeak.clip]);
      return;
    }

    // Boarding platforms widen with accuracy too, for the same reason.
    const reachable = stopsWithin(at, stops, BOARDING_RADIUS_M + Math.min(fix.accuracyM, 300))
      .filter((c) => (stopRoutes[c.stop.id] ?? []).length > 0);
    setBoardingIds(reachable.map((c) => c.stop.id));

    if (nearest.kind === "none" || reachable.length === 0) {
      setPhase("no-stop");
      say([WAIT.noStopNearby.clip]);
      return;
    }

    // Low confidence offers the list rather than asserting the first entry: the
    // true stop is in the top three ~100 % of the time up to ±300 m, but the
    // TOP one only about half the time, so the hedge is the honest wording.
    const hedged = nearest.confidence === "low";
    setCandidates([]);
    const stop = nearest.candidates[0].stop;
    setNearbyStop(stop);
    setNearbyOptions(nearest.candidates.slice(0, 3).map((c) => c.stop));
    setPhase("destinations");

    void loadTransitClips(nearest.candidates.slice(0, 3).map((c) => `stop_${c.stop.id}`)).then(() => {
      say([
        hedged ? WAIT.approximateStop.clip : "bus_you_are_at",
        `stop_${stop.id}`,
        hedged ? null : "bus_at_stop_suffix",
        JOURNEY.askDestination.clip,
      ]);
    });
  }, [note, say, stopRoutes, stops]);

  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    audioContext();

    /**
     * Arm the field-test recorder here, not on the ride screen.
     *
     * The ride screen is only ever reached by `router.push("/bus/ride")`, which
     * carries no query string — so `?record=1` had no way to survive the
     * navigation, and putting it on the ride URL directly lands on a screen
     * with no handoff, which refuses to start. Arming from the session that
     * creates the handoff is the only path that has both.
     */
    const rec = armRecordingFromUrl(window.location.search, sessionStorage);
    if (rec.armed) {
      note("RECORDING ARMED — will capture the ride");
      // Non-verbal on purpose: there is no rendered Mongolian for "recording",
      // and an unrendered key would be dropped without a sound.
      playEarcon("alert");
    }
    // Read on the first gesture rather than in a mount effect: localStorage
    // does not exist during SSR, and seeding it from an effect costs a second
    // render of a list the user may already be swiping through.
    setHistory(loadSearchHistory(localStorage));
    await loadClips(FIRST_CLIPS);
    void loadClips().catch(() => {});
    void locate();
  }, [locate, note, playEarcon]);

  // ------------------------------------------------------- destinations

  /**
   * The places this user actually goes, first.
   *
   * A commuter riding the same line twice a day reaches their stop in one or
   * two gestures; only a genuinely new journey costs a search.
   */
  const shortcuts = useMemo(() => frequentDestinations(history, groups, 5), [groups, history]);

  /**
   * Every place reachable on one bus from here, as destination groups.
   *
   * The gesture-only path to a destination. Without it, a first-time user with
   * no history and no working speech recognition has NOTHING to select — which
   * is what running the screen actually revealed.
   */
  const reachable = useMemo(() => {
    if (boardingIds.length === 0) return [];
    const groupOf = new Map<string, StopGroup>();
    for (const g of groups) for (const id of g.stopIds) groupOf.set(id, g);

    const seen = new Set<string>();
    const out: StopGroup[] = [];
    for (const r of reachableFrom(boardingIds, routeStops, stopRoutes)) {
      const g = groupOf.get(r.stopId);
      if (!g || seen.has(g.key)) continue;
      seen.add(g.key);
      out.push(g);
    }
    return out;
  }, [boardingIds, groups, routeStops, stopRoutes]);

  const chooseDestination = useCallback(
    (group: StopGroup) => {
      setDestination(group);
      say([JOURNEY.planning.clip]);

      const options = planJourney(boardingIds, group.stopIds, routeStops, stopRoutes, routesById);
      setPlans(options);

      if (options.length === 0) {
        setPhase("no-route");
        note(`no route from ${boardingIds.length} platforms to ${group.name}`);
        say([JOURNEY.noRoute.clip]);
        return;
      }

      const next = recordDestination(history, group.key, Date.now());
      setHistory(next);
      saveSearchHistory(localStorage, next);

      setPhase("routes");
      note(`${options.length} option(s), best ${options[0].legs.map((l) => l.routeDisplayName).join(" → ")}`);

      // "{route} хэрэгтэй. {n} буудал явна." — spoken as a plan.
      const best = options[0];
      /**
       * EVERY option's clips, not just the best one's — and the countdown
       * vocabulary with them.
       *
       * `say()` drops any key that is not decoded, silently. Only the best
       * route's name was ever loaded here, so the second and third suggestions
       * announced nothing at all; and `bus_approx_prefix` / `num_N` /
       * `bus_minutes_suffix` live in the transit manifest and were never loaded
       * by this screen at all, which deleted the time from every one of them.
       * A missing clip has to cost a phrase, not the whole announcement.
       */
      void loadTransitClips([
        ...COUNTDOWN_CLIP_IDS,
        ...options.flatMap((o) => o.legs.map((l) => `route_${l.routeId}`)),
        ...options.flatMap((o) => o.legs.map((l) => `stop_${l.alightStopId}`)),
        ...options.map((o) => `num_${o.totalStops}`).filter((k) => Number(k.slice(4)) <= MAX_SPOKEN_NUMBER),
      ]).then(() => {
        say([
          `route_${best.legs[0].routeId}`, JOURNEY.routeNeededSuffix.clip,
          best.totalStops <= 40 ? `num_${best.totalStops}` : null,
          JOURNEY.stopsToTravelSuffix.clip,
          // The transfer is spoken NOW, before boarding — never at the
          // transfer point, where it is a nasty surprise to someone committed.
          best.transfers > 0 ? JOURNEY.transferWarning.clip : null,
          best.transfers > 0 ? `stop_${best.legs[0].alightStopId}` : null,
          best.transfers > 0 ? `route_${best.legs[1].routeId}` : null,
        ]);
      });
    },
    [boardingIds, history, note, routeStops, routesById, say, stopRoutes],
  );

  /** Ask, listen, read back. Nothing acts on an unconfirmed recognition. */
  const askDestination = useCallback(async () => {
    const support = detectCaptureSupport();
    if (!support.available) {
      /**
       * On screen, in full, because there is no console on a phone and these
       * four reasons have four different fixes. "insecure" in particular is not
       * a device limitation at all — it is the page being served over http://,
       * which silently removes `navigator.mediaDevices` on every browser except
       * at localhost. That is why this passed every desktop test and failed on
       * the one device that matters.
       */
      note(`voice unavailable: ${support.reason} — ${support.hint}`);
      // Only a genuinely unsupported language should disable voice for the
      // session. A bad URL scheme must not, or fixing the URL still leaves the
      // rider with voice switched off.
      if (support.reason !== "insecure") setVoiceOff(true);
      say([VOICE.unavailable.clip]);
      setPhase("destinations");
      return;
    }

    /**
     * THE MICROPHONE IS ASKED FOR HERE, BEFORE THE PROMPT — NOT AFTER IT.
     *
     * This function runs synchronously from the double-tap that selected
     * "speak", so at this line the page still holds a user activation. The
     * `await` below spends it, and iOS shows the microphone permission prompt
     * for nothing else: from a promise continuation the request is simply never
     * put to the rider, so it is never granted, so the next attempt is never
     * shown either. That is the whole of why speaking a stop name worked on
     * Android and did nothing on iOS.
     *
     * Warming does not start the recording. The prompt still plays to the end
     * and `listenAnyEngine` still opens the recorder afterwards — it just finds
     * a microphone that is already open. See lib/speech/mic.ts.
     */
    warmMicrophone();

    setPhase("listening");
    await sayAndWait([VOICE.prompt.clip]);

    const outcome = await listenAnyEngine({
      // The cue, not the end of the prompt, is what tells the user to speak —
      // `start()` returning does not mean the microphone is open, and on a
      // cheap Android the gap is long enough to swallow a whole word.
      onEvent: (e) => {
        if (e.type === "ready") playListenCue("start");
        else if (e.type === "speech-end") playListenCue("end");
        else if (e.type === "retry") note(`voice retry after ${e.after}`);
      },
      beforeRetry: () => sayAndWait([VOICE.notUnderstood.clip]),
    });

    if (outcome.kind === "error") {
      note(`voice error: ${outcome.error}`);
      if (outcome.languageUnsupported) setVoiceOff(true);
      /**
       * Say what actually went wrong.
       *
       * Every failure used to speak "no stop found with that name", which is a
       * lie whenever nothing was heard at all — and an expensive one: it sends
       * someone off rehearsing a name that was never the problem, when the real
       * cause was a microphone that never opened.
       */
      say([
        outcome.languageUnsupported || outcome.error === "no-mic" ||
        outcome.error === "not-allowed" || outcome.error === "service-not-allowed"
          ? VOICE.unavailable.clip
          : outcome.error === "no-match"
            ? VOICE.noMatch.clip
            : VOICE.notUnderstood.clip,
      ]);
      setPhase("destinations");
      return;
    }

    const matches = searchStopsAny(outcome.alternatives, groups, { from: here, history, limit: 3 });
    // Both transcripts go on the overlay when they differ. A read-back of a
    // name the user did not say is otherwise unexplainable to whoever is
    // helping them, and this is the debug channel — a phone has no console.
    const matched = matches[0]?.matchedQuery;
    note(
      `heard "${outcome.transcript}"` +
        (matched && matched !== outcome.transcript ? ` (matched "${matched}")` : "") +
        ` → ${matches.length}`,
    );
    if (matches.length === 0) {
      say([VOICE.noMatch.clip]);
      setPhase("destinations");
      return;
    }

    // The read-back is the safety step, so its audio must exist before it runs.
    setCandidates(matches.map((m) => m.group));
    setPhase("confirm-destination");
    await loadTransitClips(matches.map((m) => `stop_${m.group.stopIds[0]}`));
    say([VOICE.didYouSay.clip, `stop_${matches[0].group.stopIds[0]}`, VOICE.confirmHint.clip]);
  }, [groups, here, history, note, say, sayAndWait]);

  // ------------------------------------------------------------ board

  const board = useCallback(
    (option: JourneyOption) => {
      const leg = option.legs[0];
      const built = buildHandoff(
        {
          routeId: leg.routeId, directionId: leg.directionId, boardingStopId: leg.boardStopId,
          routeDisplayName: leg.routeDisplayName,
          headsign: routesById.get(leg.routeId)?.directions.find((d) => d.id === leg.directionId)?.headsign ?? "",
        },
        routeStops,
      );
      if (!built.ok) {
        note(`handoff rejected: ${built.reason}`);
        say([DEGRADED.routeInfo.clip]);
        return;
      }
      writeHandoff(built.handoff, sessionStorage);
      try {
        // The ride screen counts to this, so it must survive the navigation.
        sessionStorage.setItem("vision-access:alight-stop", leg.alightStopId);
      } catch { /* private mode */ }
      router.push("/bus/ride");
    },
    [note, routeStops, routesById, router, say],
  );

  // ---------------------------------------------------------- options

  /**
   * One option's countdown, from ITS OWN platform's arrivals.
   *
   * Returns `unknown` — never a guess — when the payload is missing, too old to
   * trust, or carries nothing for this route. The lookup is by boarding stop
   * AND route because a single response used to be fetched for the first plan's
   * platform and then matched by route id alone; boarding platforms are
   * collected within 400 m, so the later suggestions were given another stop's
   * times.
   */
  const countdownOf = useCallback(
    (option: JourneyOption, at: number): Countdown => {
      const leg = option.legs[0];
      const payload = arrivalsByStop.get(leg.boardStopId);
      if (!payload || isStale(payload.generatedAt, at)) return { kind: "unknown" };
      const arrival = payload.arrivals.find((a) => a.routeId === leg.routeId);
      if (!arrival) return { kind: "unknown" };
      return countdownFor(arrival, at);
    },
    [arrivalsByStop],
  );

  const options: ListOption<Choice>[] = useMemo(() => {
    if (phase === "confirm-destination") {
      return candidates.map((g) => ({
        value: { kind: "destination" as const, group: g },
        keys: [`stop_${g.stopIds[0]}`],
        label: g.name,
      }));
    }
    if (phase === "routes") {
      return plans.map((option) => {
        const countdown = countdownOf(option, now);
        /**
         * "{n} буудал явна" — both clips or neither.
         *
         * The same all-or-none rule `countdownKeys` applies to the time, for
         * the same reason: a suffix whose number failed to decode leaves "…
         * буудал явна" opening on nothing, which sounds like a number that was
         * said and misheard rather than one that was never there.
         */
        const stops = `num_${option.totalStops}`;
        const stopsSuffix = JOURNEY.stopsToTravelSuffix.clip;
        const stopsKeys =
          option.totalStops >= 1 && option.totalStops <= MAX_SPOKEN_NUMBER &&
          hasClip(stops) && Boolean(stopsSuffix) && hasClip(stopsSuffix!)
            ? [stops, stopsSuffix!]
            : [];
        return {
          value: { kind: "plan" as const, option },
          /**
           * WHICH BUS, HOW FAR, THEN WHEN — in that order, every time.
           *
           * The route name alone was all this ever actually said. The minute
           * keys were assembled here inline and handed to `say()`, which drops
           * any clip that is not decoded; all three of them live in the TRANSIT
           * manifest and nothing on this screen ever loaded it, so the time was
           * silently deleted from every option. The stop count was never spoken
           * at all — it existed only in the on-screen label, which is precisely
           * the half of the interface the user cannot reach.
           *
           * The count is the journey LENGTH ("12 буудал явна"), not stops until
           * this bus reaches the kerb: that would need live vehicle positions,
           * and the City feed is dark (docs/city-gateway.md). Claiming it from
           * a timetable would be inventing the one number a rider would act on.
           */
          keys: [
            `route_${option.legs[0].routeId}`,
            ...stopsKeys,
            // Hedged, always, and derived against `now` rather than stored —
            // the prefix and the derivation are both structural, see eta.ts.
            ...countdownKeys(countdown, hasClip),
            option.transfers > 0 ? JOURNEY.transferWarning.clip : null,
          ].filter((k): k is string => Boolean(k)),
          label: `${option.legs.map((l) => l.routeDisplayName).join(" → ")} · ${option.totalStops} буудал`
            + ` · ${describeCountdown(countdown)}`,
        };
      });
    }
    if (phase === "browsing") {
      return reachable.map((g) => ({
        value: { kind: "destination" as const, group: g },
        keys: [`stop_${g.stopIds[0]}`],
        label: g.name,
      }));
    }
    if (phase === "destinations") {
      const head: ListOption<Choice>[] = voiceOff
        ? []
        : [{ value: { kind: "voice" }, keys: [WAIT.sayDestination.clip!], label: WAIT.sayDestination.mn }];
      // History first — most journeys repeat.
      const recent: ListOption<Choice>[] = shortcuts.map((g) => ({
        value: { kind: "destination" as const, group: g },
        keys: [`stop_${g.stopIds[0]}`],
        label: g.name,
      }));
      // Always last, and always present: the path that needs no speech and no
      // history. Gestures alone must be able to finish the journey.
      const browse: ListOption<Choice>[] = reachable.length
        ? [{ value: { kind: "browse" }, keys: [WAIT.browseRoutes.clip!], label: WAIT.browseRoutes.mn }]
        : [];
      // Correcting the stop we guessed. Offered only when there is something
      // else it could be — a single-candidate fix has nothing to correct to.
      const others: ListOption<Choice>[] = nearbyOptions
        .filter((s) => s.id !== nearbyStop?.id)
        .map((s) => ({ value: { kind: "here" as const, stop: s }, keys: [`stop_${s.id}`], label: s.name }));
      return [...head, ...recent, ...browse, ...others];
    }
    return [];
  }, [candidates, countdownOf, nearbyOptions, nearbyStop, now, phase, plans, reachable, shortcuts, voiceOff]);

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
      if (choice.kind === "browse") {
        setPhase("browsing");
        say([LIST.allStopsHeading.clip]);
        // Names are fetched before they are spoken, so the list never goes quiet.
        void loadTransitClips(reachable.slice(0, 40).map((g) => `stop_${g.stopIds[0]}`));
        return;
      }
      if (choice.kind === "here") {
        setNearbyStop(choice.stop);
        // Re-anchor boarding on the corrected stop so planning uses it first.
        setBoardingIds((ids) => [choice.stop.id, ...ids.filter((id) => id !== choice.stop.id)]);
        say(["bus_you_are_at", `stop_${choice.stop.id}`, "bus_at_stop_suffix"]);
        return;
      }
      if (choice.kind === "destination") { chooseDestination(choice.group); return; }
      if (choice.kind === "plan") { board(choice.option); return; }
    },
    [askDestination, board, chooseDestination, reachable, say],
  );

  const nav = useGestureNav<Choice>({
    options,
    announce,
    onSelect,
    onBack: () => {
      if (phase === "routes" || phase === "no-route" || phase === "confirm-destination" || phase === "browsing") {
        setPhase("destinations");
        setCandidates([]);
        say([JOURNEY.askDestination.clip]);
        return;
      }
      router.push("/");
    },
    onRepeat: () => { if (lastSpokenRef.current.length) playSequence(lastSpokenRef.current, { interrupt: true }); },
    // Long press: always an immediate answer to "where am I".
    onWhereAmI: (o) => say([
      GESTURE.whereAmI.clip, SCREEN.wait.clip,
      nearbyStop ? `stop_${nearbyStop.id}` : null,
      destination ? `stop_${destination.stopIds[0]}` : null,
      ...(o?.keys ?? []),
    ]),
    enabled: phase !== "locating" && phase !== "listening",
    // A new list starts at the top — see resetKey in useGestureNav.
    resetKey: phase,
  });

  /**
   * Arrival times, one fetch per BOARDING PLATFORM, refreshed while waiting.
   *
   * An enrichment — the plan is complete without it — but a self-refreshing
   * one. A countdown derived from a single fetch decays: after STALE_AFTER_MS
   * `isStale` correctly refuses to speak from it, and the rider standing at the
   * stop would simply stop being told anything. Refreshing is what lets the
   * numbers stay true for as long as someone is actually waiting.
   */
  useEffect(() => {
    if (phase !== "routes") return;
    const stopIds = [...new Set(plans.map((p) => p.legs[0].boardStopId))].slice(0, MAX_ARRIVAL_STOPS);
    if (stopIds.length === 0) return;

    let cancelled = false;
    let spokenDegraded = false;

    const load = () => {
      for (const stopId of stopIds) {
        fetch(`/api/transit/next?stopId=${encodeURIComponent(stopId)}`)
          .then((r) => r.json())
          .then((body: NextArrivalsResponse) => {
            if (cancelled) return;
            setArrivalsByStop((prev) => new Map(prev).set(stopId, body));
            setNow(Date.now());
            // Degrade audibly, but ONCE. Silence would read as "no bus is
            // coming"; saying it on every refresh would be its own noise.
            if (body.degraded && !spokenDegraded) {
              spokenDegraded = true;
              note(`arrivals degraded at ${stopId}: ${body.degraded}`);
              say([JOURNEY.liveUnavailable.clip]);
            }
          })
          .catch(() => {
            if (cancelled || spokenDegraded) return;
            spokenDegraded = true;
            say([DEGRADED.network.clip]);
          });
      }
    };

    load();
    const timer = setInterval(load, ARRIVALS_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [note, phase, plans, say]);

  /**
   * The countdown clock, ticking only while there is a countdown to show.
   *
   * Every 10 s rather than every second: the numbers are minutes, the source is
   * a timetable, and a per-second re-render on a cheap Android buys nothing an
   * ear can hear.
   */
  useEffect(() => {
    if (phase !== "routes") return;
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [phase]);

  /**
   * THE WAIT, NARRATED — the countdown speaks up as it changes.
   *
   * A blind rider cannot glance at a board, so a number spoken once and then
   * never again is a number that quietly stops being true. But narrating every
   * tick trains someone to ignore the voice, which costs more than it gives.
   * So only the marks that change what a person DOES are announced: enough time
   * to still be walking, time to be at the kerb, time to have the card out, and
   * now. See ALERT_MINUTES in lib/transit/eta.ts.
   *
   * It follows the option under the cursor — the bus the rider last heard and
   * is therefore thinking about — and always names the route, so "one minute"
   * can never be ambiguous about WHICH bus.
   *
   * The haptic goes out with it. That is the channel that survives a phone in a
   * coat pocket, traffic on Peace Avenue, and gloves: the one set of conditions
   * this app is actually used in.
   */
  const watched = useRef<{ key: string; countdown: Countdown } | null>(null);

  useEffect(() => {
    if (phase !== "routes") { watched.current = null; return; }
    const option = plans[nav.index];
    if (!option) { watched.current = null; return; }

    const key = `${option.legs[0].routeId}@${option.legs[0].boardStopId}`;
    const countdown = countdownOf(option, now);
    const previous = watched.current?.key === key ? watched.current.countdown : null;
    watched.current = { key, countdown };

    const mark = crossedAlert(previous, countdown);
    if (mark !== null) {
      note(`countdown ${option.legs[0].routeDisplayName}: ${mark} min mark`);
      playEarcon(earconForMark(mark));
      vibrate(waitVibration(mark) ?? []);
      say([`route_${option.legs[0].routeId}`, ...countdownKeys(countdown, hasClip)]);
      return;
    }
    if (becameDue(previous, countdown)) {
      note(`countdown ${option.legs[0].routeDisplayName}: due`);
      playEarcon("urgent");
      vibrate(DUE_VIBRATION);
      say([`route_${option.legs[0].routeId}`, ...countdownKeys(countdown, hasClip)]);
    }
  }, [countdownOf, nav.index, note, now, phase, plans, playEarcon, say]);

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
    : phase === "no-route" ? JOURNEY.noRoute.mn
    : nav.current?.label ?? JOURNEY.askDestination.mn;

  return (
    <GestureSurface
      handlers={handlers}
      options={a11yOptions}
      onFocusOption={(i) => { void start(); nav.setIndex(i); }}
    >
      <CurrentOption
        title={title}
        detail={destination?.name ?? nearbyStop?.name}
        position={options.length ? `${nav.index + 1} / ${options.length}` : undefined}
      />
      <details style={{ position: "absolute", bottom: 6, left: 6, fontSize: 11, color: "#333" }}>
        <summary>debug</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
      </details>
    </GestureSurface>
  );
}
