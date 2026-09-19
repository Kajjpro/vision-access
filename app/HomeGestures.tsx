"use client";

/**
 * Home screen.
 *
 * NO TUTORIAL. The first thing that happens on opening is a spoken sentence
 * naming what the app does and how to move through it. A blind user opening an
 * unknown app needs those two facts immediately, not a practice session they
 * have to complete before the app becomes useful.
 *
 * Options are a list scrolled by ear. The grid position is spoken as part of
 * each option for partial sight, but position is never required to act.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";

import { GestureSurface, CurrentOption, type A11yOption } from "@/components/GestureSurface";
import { audioContext, hasClip, loadClips, playSequence, stopAll } from "@/lib/audio";
import { GESTURE, MODE, POSITION, SCREEN } from "@/lib/ui/announcements";
import { armMicrophonePrompt, primeArmedMicrophone } from "@/lib/ui/microphone";
import { useGestureNav } from "@/lib/ui/useGestureNav";
import type { ListOption } from "@/lib/ui/gesture-nav";

const WalkMode = dynamic(() => import("@/components/modes/WalkMode"), { ssr: false });
/**
 * Ask the Room. Loaded on demand like Walk mode — it pulls the detector, the
 * OCR runtime and the camera, none of which a rider who only wanted a bus
 * should pay for.
 */
const AskMode = dynamic(() => import("@/components/modes/AskMode"), { ssr: false });

type ModeId = "walk" | "ask" | "scene" | "bus" | "settings";

type Mode = {
  id: ModeId;
  clip: string;
  label: string;
  position: string;
  route?: string;
  component?: "walk" | "ask";
};

/** Working modes first: a user should not swipe past two dead ends to reach the bus. */
const MODES: Mode[] = [
  { id: "walk", clip: "mode_walk", label: MODE.walk.mn, position: POSITION.topLeft.mn, component: "walk" },
  { id: "ask", clip: "mode_scene", label: MODE.scene.mn, position: POSITION.topRight.mn, component: "ask" },
  { id: "bus", clip: "mode_bus", label: MODE.bus.mn, position: POSITION.bottomLeft.mn, route: "/bus/wait" },
  { id: "settings", clip: "mode_settings", label: MODE.settings.mn, position: POSITION.bottomRight.mn, route: "/settings" },
];

const isReady = (m: Mode) => Boolean(m.route || m.component);
export const HOME_TILE_ROUTES = MODES.filter((m) => m.route).map((m) => m.route!);

/**
 * The handful of clips needed before the app can say anything useful.
 *
 * Loaded first and spoken immediately. The remaining ~120 clips (9 MB of WAV)
 * load afterwards in the background — waiting for all of them left the app
 * silent for many seconds on a phone, which is indistinguishable from broken.
 */
const FIRST_CLIPS = [GESTURE.welcome.clip!, ...MODES.map((m) => m.clip), MODE.comingSoon.clip!];

export function HomeGestures() {
  const router = useRouter();
  const [active, setActive] = useState<ModeId | null>(null);
  const [ready, setReady] = useState(false);
  const lastSpokenRef = useRef<string[]>([]);
  const startedRef = useRef(false);

  /** Returns how long the utterance occupies, so a caller can wait it out exactly. */
  const say = useCallback((clips: string[]): number => {
    const playable = clips.filter(hasClip);
    lastSpokenRef.current = playable;
    // Interrupting matters: swiping quickly through options must not queue a
    // backlog of names that plays out long after the finger has moved on.
    if (!playable.length) return 0;
    return playSequence(playable, { interrupt: true });
  }, []);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const options: ListOption<Mode>[] = useMemo(
    () => MODES.map((m) => ({ value: m, keys: [m.clip], label: `${m.label}, ${m.position}` })),
    [],
  );

  const announce = useCallback(
    (option: ListOption<Mode>, ctx: { wrapped: boolean }) => {
      say(ctx.wrapped ? [GESTURE.listWrapped.clip!, option.value.clip] : [option.value.clip]);
    },
    [say],
  );

  const enterMode = useCallback(
    (mode: Mode) => {
      if (!isReady(mode)) {
        say([mode.clip, MODE.comingSoon.clip!]);
        return;
      }
      try { localStorage.setItem("va:lastMode", mode.id); } catch { /* private mode */ }
      if (mode.route) router.push(mode.route);
      else setActive(mode.id);
    },
    [router, say],
  );

  const nav = useGestureNav<Mode>({
    options,
    announce,
    onSelect: (o) => enterMode(o.value),
    onRepeat: () => { if (lastSpokenRef.current.length) playSequence(lastSpokenRef.current, { interrupt: true }); },
    onWhereAmI: (o) => say([GESTURE.whereAmI.clip!, SCREEN.home.clip!, ...(o ? [o.value.clip] : [])]),
    enabled: ready,
  });

  /**
   * Unlocks audio and speaks the welcome.
   *
   * iOS only allows an AudioContext to start inside a user gesture, so this
   * runs on the first touch anywhere — there is nothing to find. The welcome
   * plays as soon as its own handful of clips decode; everything else streams
   * in behind it.
   */
  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    audioContext();

    await loadClips(FIRST_CLIPS);
    setReady(true);
    const welcome = say([GESTURE.welcome.clip!, MODES[0].clip]);

    // The rest, in the background. A missing clip costs one phrase, not the
    // app's voice, so failures are logged rather than thrown.
    void loadClips().catch(() => {});

    /**
     * Explain the microphone HERE, once, at the calmest moment there is.
     *
     * The browser's permission dialog is a visual, unlabelled object; a rider
     * meeting it for the first time while standing at a stop with a bus coming
     * has no way to know what is being asked, and a refusal there costs the
     * trip. So it is explained during the welcome and never raised again.
     *
     * The DIALOG itself opens on the next touch, not here — iOS only shows it
     * inside a touch handler, and asking from this timer meant an iOS rider was
     * told "voice input is unavailable" at startup on a device where it works.
     * See lib/ui/microphone.ts.
     *
     * Deliberately after the welcome finishes: two voices at once is no voice.
     */
    void (async () => {
      await sleep(welcome * 1000 + 400);
      armMicrophonePrompt({
        speak: (clips) => say(clips.filter((c): c is string => Boolean(c))),
      });
    })().catch(() => {});
  }, [say]);

  useEffect(() => () => stopAll(), []);

  const a11yOptions: A11yOption[] = options.map((o, i) => ({
    label: o.label,
    selected: i === nav.index,
    onActivate: () => { nav.setIndex(i); enterMode(o.value); },
  }));

  const handlers = {
    ...nav.handlers,
    onTouchStart: (e: React.TouchEvent) => {
      void start();
      // The armed permission dialog, opened from inside the touch itself — the
      // only place iOS will show it. A no-op on every touch but the one.
      void primeArmedMicrophone();
      nav.handlers.onTouchStart(e);
    },
  };

  if (active === "ask") return <AskMode />;

  if (active === "walk") {
    return <WalkMode onBack={() => { setActive(null); say([SCREEN.home.clip!]); }} />;
  }

  const current = nav.current;

  return (
    <GestureSurface
      handlers={handlers}
      options={ready ? a11yOptions : []}
      onFocusOption={(i) => { void start(); nav.setIndex(i); }}
    >
      <CurrentOption
        title={ready ? current?.value.label ?? SCREEN.home.mn : SCREEN.home.mn}
        detail={ready ? current?.value.position : "Дэлгэцэнд хүрнэ үү"}
        position={ready ? `${nav.index + 1} / ${options.length}` : undefined}
      />
    </GestureSurface>
  );
}
