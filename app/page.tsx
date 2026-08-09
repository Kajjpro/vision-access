"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useState } from "react";

import { audioContext, hasClip, loadAllClips, playSequence } from "@/lib/audio";

/**
 * WalkMode owns the camera, so it must never be server-rendered — and `ssr:false`
 * is only legal inside a Client Component (next/dist/docs 01-app/02-guides/
 * lazy-loading.md), which is why this page carries "use client" rather than
 * staying a Server Component.
 *
 * Loading it lazily also keeps onnxruntime-web out of the menu's bundle: the
 * menu is what a user sees first, and it should not wait on a model runtime it
 * may never need.
 */
const WalkMode = dynamic(() => import("@/components/modes/WalkMode"), {
  ssr: false,
  loading: () => (
    <div className="w-screen h-dvh bg-black text-green-400 font-mono text-sm p-4">
      Ачаалж байна…
    </div>
  ),
});

type ModeId = "walk" | "scene" | "bus" | "settings";

/** Grid order is also the order the spoken menu reads them in. */
const MODES: { id: ModeId; clip: string; label: string; ready: boolean }[] = [
  { id: "walk", clip: "mode_walk", label: "Алхах", ready: true },
  { id: "scene", clip: "mode_scene", label: "Юу байна?", ready: false },
  { id: "bus", clip: "mode_bus", label: "Автобус", ready: false },
  { id: "settings", clip: "mode_settings", label: "Тохиргоо", ready: false },
];

const LAST_MODE_KEY = "va:lastMode";

/** Android only — iOS Safari has no Vibration API, so this is silently a no-op there. */
function buzz(ms: number) {
  navigator.vibrate?.(ms);
}

export default function Home() {
  const [active, setActive] = useState<ModeId | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [failedClips, setFailedClips] = useState(0);

  /** Quadrant currently under the finger, so a name is spoken on CHANGE only. */
  const hoveredRef = useRef<ModeId | null>(null);
  /** The first gesture speaks the menu; per-quadrant names start from the second. */
  const introducedRef = useRef(false);
  /**
   * Read once at mount, not in an effect: an effect that immediately setStates
   * renders the menu twice, and the window guard is needed anyway because this
   * Client Component is still prerendered on the server, where localStorage
   * does not exist.
   */
  const [lastUsed, setLastUsed] = useState<ModeId | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const stored = localStorage.getItem(LAST_MODE_KEY) as ModeId | null;
      return stored && MODES.some((m) => m.id === stored) ? stored : null;
    } catch {
      // Private mode. The menu simply does not mention a previous choice.
      return null;
    }
  });

  /**
   * Builds the AudioContext and decodes every clip. MUST run inside a gesture:
   * a context created anywhere else stays suspended on iOS and the app is mute.
   *
   * Returns true once clips are playable.
   */
  const ensureAudio = useCallback(async () => {
    audioContext();
    if (audioReady) return true;
    const { failed } = await loadAllClips();
    setFailedClips(failed.length);
    setAudioReady(true);
    return true;
  }, [audioReady]);

  /**
   * Spoken menu, read once after the very first touch anywhere on the screen.
   *
   * The user cannot see the grid, so this is how they learn what is on it and in
   * what order — the four names in reading order, which is also the order their
   * finger will meet them going left-to-right, top-to-bottom.
   */
  const speakMenu = useCallback(() => {
    const last = lastUsed;
    const clips = ["menu", ...MODES.map((m) => m.clip)];
    // The previous choice is named again at the end, so returning to a familiar
    // mode does not require re-exploring the whole grid.
    if (last) clips.push(MODES.find((m) => m.id === last)!.clip);
    playSequence(clips.filter(hasClip), { interrupt: true });
  }, [lastUsed]);

  const enter = useCallback((id: ModeId) => {
    const mode = MODES.find((m) => m.id === id)!;
    if (!mode.ready) {
      // CLAUDE.md: no silent failures. Name, then "тун удахгүй" — the button is
      // real, the mode simply is not built yet. Deliberately NOT the error clip:
      // that would report a fault and invite a retry that cannot ever succeed.
      playSequence([mode.clip, "coming_soon"].filter(hasClip), { interrupt: true });
      return;
    }
    try {
      localStorage.setItem(LAST_MODE_KEY, id);
      setLastUsed(id);
    } catch {
      // Private mode; the choice simply is not remembered.
    }
    playSequence([mode.clip].filter(hasClip), { interrupt: true });
    setActive(id);
  }, []);

  /**
   * Which quadrant the finger is over right now.
   *
   * Touch events keep firing at the element the gesture STARTED on for its whole
   * duration, so the element under the finger has to be hit-tested every move —
   * `event.target` would report the first quadrant forever.
   */
  function quadrantAt(touch: { clientX: number; clientY: number }): ModeId | null {
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const id = el?.closest("[data-mode]")?.getAttribute("data-mode");
    return (MODES.find((m) => m.id === id)?.id ?? null) as ModeId | null;
  }

  // NOTE: nothing in this component calls preventDefault. Doing so on touch
  // events is precisely what breaks VoiceOver's own swipe/double-tap handling,
  // and VoiceOver users reach these buttons through that, not through the
  // touch-explore path below.

  async function onTouchStart(e: React.TouchEvent) {
    await ensureAudio();

    if (!introducedRef.current) {
      // First contact of the session: unlock audio and read the menu. The
      // quadrant name is deliberately NOT spoken here — both at once is noise,
      // and the menu is what a first-time user needs.
      introducedRef.current = true;
      hoveredRef.current = null;
      speakMenu();
      return;
    }

    const id = quadrantAt(e.touches[0]);
    if (!id) return;
    hoveredRef.current = id;
    buzz(20);
    playSequence([MODES.find((m) => m.id === id)!.clip].filter(hasClip), { interrupt: true });
  }

  function onTouchMove(e: React.TouchEvent) {
    if (!introducedRef.current) return;
    const id = quadrantAt(e.touches[0]);
    if (!id || id === hoveredRef.current) return; // speak on CHANGE only
    hoveredRef.current = id;
    buzz(20);
    // interrupt: sweeping four quadrants must not queue four names.
    playSequence([MODES.find((m) => m.id === id)!.clip].filter(hasClip), { interrupt: true });
  }

  /**
   * Activation happens on LIFT, never on touchstart: a user who cannot see the
   * grid has to be able to explore it with a finger down without committing to
   * whatever they happen to land on first.
   */
  function onTouchEnd(e: React.TouchEvent) {
    if (!introducedRef.current) return;
    const id = quadrantAt(e.changedTouches[0]);
    hoveredRef.current = null;
    if (id) enter(id);
  }

  if (active) {
    return (
      <WalkMode
        onBack={() => {
          setActive(null);
          hoveredRef.current = null;
          playSequence(["menu"].filter(hasClip), { interrupt: true });
        }}
      />
    );
  }

  return (
    <div
      className="w-screen h-dvh bg-black"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* dvh, not vh: iOS resizes vh when the URL bar shows and hides, which
          would move the touch targets under a finger that cannot see them move. */}
      <div className="grid grid-cols-2 grid-rows-2 w-full h-full">
        {MODES.map((m) => (
          <button
            key={m.id}
            data-mode={m.id}
            aria-label={m.label}
            // VoiceOver's double-tap arrives here as a click, bypassing the
            // touch handlers entirely — which is why activation must also live
            // on onClick and not only on touchend.
            onClick={async () => {
              await ensureAudio();
              introducedRef.current = true;
              enter(m.id);
            }}
            className="w-[50vw] h-[50dvh] flex items-center justify-center border border-white/20 text-white text-3xl font-bold"
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* On-screen debug: there is no console on a phone. aria-hidden so it does
          not clutter the VoiceOver rotor with text the buttons already carry. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-2 left-2 right-2 text-green-400 text-xs font-mono bg-black/70 px-2 py-1 rounded"
      >
        audio {audioReady ? "ready" : "tap to start"}
        {failedClips > 0 && ` · ${failedClips} CLIPS FAILED`}
        {lastUsed && ` · last ${lastUsed}`}
      </div>
    </div>
  );
}
