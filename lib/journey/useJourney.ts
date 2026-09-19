"use client";

/**
 * The journey, wired to a browser. One hook, used by every bus screen.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The screens each built their own audio queue, their own clip player, their own
 * "say this and remember that we said it", and their own idea of what state the
 * journey was in. That duplication was the actual cause of the disconnection:
 * three implementations of the same thing drift, and the rider experiences the
 * drift as an app that behaves differently depending on which screen it happens
 * to be on.
 *
 * Everything journey-shaped now lives here — the machine, the queue, the pacer,
 * the guide, the settings, the missing-clip reporting. A screen's job is reduced
 * to two things it genuinely owns: gathering its own inputs (a GPS fix, a route
 * choice, a stop sequence) and rendering `present()`.
 *
 * ── WHAT A SCREEN STILL OWNS ───────────────────────────────────────────────
 *
 * Input mode. `/bus/wait` has a listening state and a browsing state, and those
 * are NOT journey states: the journey is `selecting_destination` throughout,
 * whether the rider is speaking, scrolling a list, or thinking. Modelling an
 * input mode as a journey state was the original mistake — it is why the flow
 * had nine phases on one screen and no way to say where the rider was.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { audioContext } from "@/lib/audio";
import { AudioQueue, type Announcement, type QueueEvent } from "@/lib/transit/audio-queue";
import { ManifestClipPlayer } from "@/lib/transit/clip-player";
import { createEarconPlayer } from "@/lib/transit/earcons";
import type { AudioManifest } from "@/lib/transit/types";
import { vibrate } from "@/lib/ui/gesture-nav";

import { assistantMenu, type AssistantEntry } from "./assistant";
import { createMissingClipReporter, type MissingClipReport } from "./audio-fallback";
import { answer, answerStopsLeft, type GuideQuestion } from "./guide";
import { transition, type JourneyEvent } from "./machine";
import { pace } from "./pacer";
import { present, type Presentation } from "./present";
import { loadSettings, saveSettings, type GuidanceSettings } from "./settings";
import { createJourney, type GuidanceLevel, type Journey } from "./types";

/** How often the pacer is offered a turn. It declines most of them. */
const PACE_MS = 15_000;
/** Re-render cadence for anything derived from the clock. Minutes, not seconds. */
const TICK_MS = 10_000;

export type UseJourney = {
  journey: Journey;
  /** Everything the screen renders, derived from the journey. */
  view: Presentation;
  /** The contextual quick-assistant entries for this state. */
  assistant: AssistantEntry[];
  /** Send an event to the machine. Rejected events are logged, never applied. */
  send: (event: JourneyEvent) => void;
  /** Speak, and record that something was said so the pacer can see it. */
  speak: (announcement: Announcement | null) => void;
  /** Answer one of the rider's questions from the journey object. */
  ask: (question: GuideQuestion) => void;
  /** Re-speak the last thing said. */
  repeat: () => void;
  /** Change the guidance level and persist it. */
  setGuidanceLevel: (level: GuidanceLevel) => void;
  setHeartbeat: (enabled: boolean) => void;
  /** Must be called from inside a touch handler — iOS will not start audio otherwise. */
  startAudio: () => Promise<void>;
  /** Whether a clip exists. Screens pass this into anything that builds keys. */
  has: (key: string) => boolean;
  /**
   * Narrows what `startAudio` will decode, for callers that know their route.
   * Must be called BEFORE the first touch, or the default UI-only set is used.
   */
  setPreloadKeys: (keys: string[]) => void;
  /** Diagnostics for the debug panel. */
  log: string[];
  note: (line: string) => void;
  missingClips: MissingClipReport;
};

export function useJourney(manifest: AudioManifest, now: number): UseJourney {
  const [journey, setJourney] = useState<Journey>(() => createJourney(Date.now()));
  const [log, setLog] = useState<string[]>([]);
  const [missing, setMissing] = useState<MissingClipReport>({ keys: [], counts: {}, total: 0 });

  const queueRef = useRef<AudioQueue | null>(null);
  const startedRef = useRef(false);
  const lastSpokenRef = useRef<Announcement | null>(null);
  const reporterRef = useRef(createMissingClipReporter());
  /** Set by the screen once the route is known; see `setPreloadKeys`. */
  const preloadKeysRef = useRef<string[] | null>(null);

  const has = useCallback((key: string) => Boolean(manifest[key]), [manifest]);

  const note = useCallback((line: string) => {
    setLog((l) => [...l.slice(-60), `${new Date().toLocaleTimeString()} ${line}`]);
  }, []);

  /**
   * The one door into the machine.
   *
   * A rejected event is logged and DISCARDED. GPS ticks and poll responses keep
   * arriving after the rider has moved on, and the machine returning a reason
   * rather than throwing is what lets them pass without corrupting anything.
   */
  const send = useCallback((event: JourneyEvent) => {
    setJourney((current) => {
      const result = transition(current, event, Date.now());
      if (!result.applied) note(`ignored ${event.type}: ${result.rejected}`);
      return result.journey;
    });
  }, [note]);

  /**
   * The one function that speaks.
   *
   * `lastAnnouncementAt` is what the pacer reads to decide whether there is any
   * silence to fill, so it must be stamped here rather than at the call sites —
   * a screen that forgets produces a reassurance tone moments after a real
   * announcement, which is the exact thing the pacer exists to avoid.
   */
  const speak = useCallback((announcement: Announcement | null) => {
    if (!announcement) return;
    lastSpokenRef.current = announcement;
    queueRef.current?.push(announcement);
    setJourney((j) => ({
      ...j,
      lastAnnouncementAt: Date.now(),
      lastAnnouncementLabel: announcement.label ?? null,
    }));
  }, []);

  const journeyRef = useRef(journey);
  useEffect(() => { journeyRef.current = journey; }, [journey]);

  const ask = useCallback((question: GuideQuestion) => {
    const j = journeyRef.current;
    // The short question gets the short answer. Handing back the full status
    // sentence for "how many stops" is how a guide becomes something you stop
    // asking.
    const short = question === "stops_left" ? answerStopsLeft(j, has, Date.now()) : null;
    speak(short ?? answer(j, question, has, Date.now()));
  }, [has, speak]);

  const repeat = useCallback(() => {
    const last = lastSpokenRef.current;
    if (!last) {
      // Nothing to repeat is itself a state, and the honest answer to "say that
      // again" when nothing was said is the current status.
      ask("status");
      return;
    }
    // Re-stamped: an expiry from the original utterance would drop it at the
    // front of the queue, and the rider would ask twice and hear nothing twice.
    speak({ ...last, expiresAt: Date.now() + 30_000, dedupeKey: undefined });
  }, [ask, speak]);

  /**
   * Audio must be constructed inside a user gesture on iOS.
   *
   * Idempotent, so every screen can call it from `onTouchStart` without
   * coordinating — the second call is free.
   */
  const startAudio = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;

    const ctx = audioContext();
    const player = new ManifestClipPlayer(manifest, ctx);
    const queue = new AudioQueue(player, {
      earcons: createEarconPlayer(() => ctx),
      vibrate,
    });

    queue.on((e: QueueEvent) => {
      switch (e.type) {
        case "missing":
          /**
           * A MISSING CLIP IS NEVER SILENCE.
           *
           * The queue plays whatever keys did resolve and still fires the earcon
           * and haptic, so the state reaches the rider through the parallel
           * channels. What was absent was any way for a DEVELOPER to see the
           * gap — it only showed up as a phrase nobody heard.
           */
          reporterRef.current.record(e.keys);
          setMissing(reporterRef.current.report());
          note(`NO CLIP: ${e.keys.join(", ")}`);
          break;
        case "stalled":
          note(`STALLED: ${e.key} — abandoned so the queue keeps moving`);
          break;
        case "start":
          note(`say: ${e.announcement.label ?? ""}`);
          break;
        case "expired":
          note(`expired: ${e.announcement.label ?? ""}`);
          break;
        case "suppressed":
          note(`suppressed: ${e.announcement.label ?? ""}`);
          break;
      }
    });

    queueRef.current = queue;

    /**
     * ROUTE-SCOPED, NEVER THE WHOLE MANIFEST.
     *
     * `load()` with no argument decodes all 1,065 clips — 37 minutes of audio,
     * which `decodeAudioData` resamples to the context rate, so roughly 400 MB
     * of float32 PCM resident on a phone this project already fights to keep
     * under iOS's tab limit. It would not crash diagnosably: the tab would die
     * and reload exactly like the detector bug.
     *
     * The caller supplies the journey's own keys. Until it does, only the UI
     * phrases load — enough to speak every state and every question, and not
     * one stop name that is not on this route.
     */
    await player.load(preloadKeysRef.current ?? undefined);

    // Settings are read here rather than at mount: localStorage does not exist
    // during SSR, and this is the first moment the app is certainly in a browser.
    const settings = loadSettings();
    setJourney((j) => ({
      ...j,
      guidanceLevel: settings.level,
      heartbeatEnabled: settings.heartbeat,
    }));
  }, [manifest, note]);

  const persist = useCallback((next: Partial<GuidanceSettings>) => {
    setJourney((j) => {
      const merged: GuidanceSettings = {
        level: next.level ?? j.guidanceLevel,
        heartbeat: next.heartbeat ?? j.heartbeatEnabled,
      };
      saveSettings(merged);
      return { ...j, guidanceLevel: merged.level, heartbeatEnabled: merged.heartbeat };
    });
  }, []);

  const setGuidanceLevel = useCallback((level: GuidanceLevel) => persist({ level }), [persist]);
  const setHeartbeat = useCallback((heartbeat: boolean) => persist({ heartbeat }), [persist]);

  /**
   * The pacer, offered a turn on a timer.
   *
   * The timer is NOT the announcement schedule — `pace` decides, and usually
   * declines. Polling it cheaply is what keeps the decision inside one tested
   * pure function instead of spread across an interval per state.
   *
   * The queue's status goes in with it, so a heartbeat is DROPPED rather than
   * queued behind a real announcement. Reassurance that arrives after the thing
   * it was substituting for is noise.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const queue = queueRef.current;
      if (!queue) return;
      const status = { speaking: queue.isPlaying, pending: queue.pending };
      for (const announcement of pace(journeyRef.current, Date.now(), status)) speak(announcement);
    }, PACE_MS);
    return () => clearInterval(timer);
  }, [speak]);

  /**
   * Every state change says itself. That is the app's whole contract with
   * someone who cannot see the screen.
   */
  const spokenState = useRef<string | null>(null);
  useEffect(() => {
    if (!queueRef.current) return;
    if (spokenState.current === journey.state) return;
    spokenState.current = journey.state;
    speak(answer(journey, "status", has, Date.now()));
  }, [has, journey, speak]);

  const view = useMemo(() => present(journey, now), [journey, now]);
  const assistant = useMemo(() => assistantMenu(journey), [journey]);

  const setPreloadKeys = useCallback((keys: string[]) => { preloadKeysRef.current = keys; }, []);

  return {
    journey, view, assistant, send, speak, ask, repeat,
    setGuidanceLevel, setHeartbeat, startAudio, has, log, note, setPreloadKeys,
    missingClips: missing,
  };
}

/** A clock for anything derived from elapsed time. Minutes, so ten seconds is plenty. */
export function useJourneyClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
