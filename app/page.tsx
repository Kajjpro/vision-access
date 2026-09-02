"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { audioContext, hasClip, loadAllClips, playSequence } from "@/lib/audio";
import { openCamera, requestTiltPermission } from "@/lib/camera";

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

/**
 * Same treatment as WalkMode and for the same two reasons: it owns the camera,
 * so it must never be server-rendered, and its reference pack plus matcher
 * have no business in the menu's bundle.
 */
const MoneyMode = dynamic(() => import("@/components/modes/MoneyMode"), {
  ssr: false,
  loading: () => (
    <div className="w-screen h-dvh bg-black text-green-400 font-mono text-sm p-4">
      Ачаалж байна…
    </div>
  ),
});

type ModeId = "walk" | "scene" | "bus" | "settings" | "money";

/**
 * Grid order is also the order the spoken menu reads them in.
 *
 * A mode is reached one of two ways, and the difference matters:
 *
 *   `route`     — a real page under app/. Entering navigates there, so the mode
 *                 owns its own lifecycle and its cleanup runs on unmount.
 *   `component` — rendered inline by this page. WalkMode predates the router
 *                 split and still works this way.
 *
 * `ready: false` means built-but-not-here: the tile speaks its name then
 * "тун удахгүй" and stays put. Anything with a route or a component is ready by
 * definition, which is what stops a shipped screen from sitting behind a stale
 * flag — the bug that left /bus/wait unreachable after it was built.
 */
type Mode = {
  id: ModeId;
  clip: string;
  label: string;
  route?: string;
  component?: "walk" | "money";
  /**
   * The mode needs getUserMedia opened inside the ENTERING TAP. iOS Safari
   * will not show the permission prompt for a request made from a mount
   * effect — it never resolves and the tile just looks dead. A flag rather
   * than `id === "walk"`, which is what this was before Money arrived and
   * would have silently left the second camera mode without a stream.
   */
  camera?: boolean;
};

const MODES: Mode[] = [
  { id: "walk", clip: "mode_walk", label: "Алхах", component: "walk", camera: true },
  { id: "scene", clip: "mode_scene", label: "Юу байна?" },
  { id: "bus", clip: "mode_bus", label: "Автобус", route: "/bus/wait" },
  { id: "settings", clip: "mode_settings", label: "Тохиргоо" },
  // NOTES.md kept Money off this screen while it was blocked on a model that
  // did not exist. It is here now because the recogniser does: a banknote is
  // matched against reference scans (lib/money/), not detected by the COCO
  // network, so it never needed the retraining that was blocking it.
  //
  // With no reference pack built the mode still enters and says "мөнгө, тун
  // удахгүй" for itself — the tile is honest either way, and unlike a
  // `ready: false` entry it starts working the moment a pack lands without
  // anyone remembering to flip a flag here. That stale-flag bug is exactly
  // what left /bus/wait unreachable after it was built.
  { id: "money", clip: "mode_money", label: "Мөнгө", component: "money", camera: true },
];

/** Single source of truth for "can this tile go anywhere". */
const isReady = (m: Mode) => Boolean(m.route || m.component);

/** Exported so the route smoke test can assert every tile points somewhere real. */
export const HOME_TILE_ROUTES = MODES.filter((m) => m.route).map((m) => m.route!);

const LAST_MODE_KEY = "va:lastMode";

/**
 * How long the first tap waits for clips to decode on a slow tunnel before
 * proceeding anyway. The load runs in the background either way; this only
 * bounds how long the MENU is allowed to block the user's first interaction.
 */
const AUDIO_READY_WAIT_MS = 6_000;

/**
 * The mount-time clip load, shared so ensureAudio and the mount effect await
 * the same work instead of starting two races over the same fetches.
 */
let clipsLoadPromise: Promise<{ ok: string[]; failed: string[] }> | null = null;

/**
 * localStorage read through useSyncExternalStore rather than a useState
 * initializer or an effect. Both of those looked reasonable and both cause a
 * hydration mismatch or an effect-time setState: the SERVER always renders
 * with no window, but the CLIENT's very first render already has one, so
 * anything that reads localStorage during render disagrees with the HTML the
 * server sent. useSyncExternalStore is the API React ships specifically for
 * this — a fixed `null` server snapshot, hydrate with that, then resync to
 * the real value in one extra paint, with no lint-flagged setState-in-effect.
 */
let lastUsedListeners: (() => void)[] = [];

function subscribeLastUsed(listener: () => void) {
  lastUsedListeners.push(listener);
  return () => {
    lastUsedListeners = lastUsedListeners.filter((l) => l !== listener);
  };
}

function readLastUsed(): ModeId | null {
  try {
    const stored = localStorage.getItem(LAST_MODE_KEY) as ModeId | null;
    return stored && MODES.some((m) => m.id === stored) ? stored : null;
  } catch {
    return null; // Private mode. The menu simply does not mention a previous choice.
  }
}

function getLastUsedServerSnapshot(): ModeId | null {
  return null;
}

/** Persists the choice and tells every mounted Home instance to re-read it. */
function rememberLastUsed(id: ModeId) {
  try {
    localStorage.setItem(LAST_MODE_KEY, id);
  } catch {
    // Private mode; the choice simply is not remembered.
  }
  for (const listener of lastUsedListeners) listener();
}

/** Android only — iOS Safari has no Vibration API, so this is silently a no-op there. */
function buzz(ms: number) {
  navigator.vibrate?.(ms);
}

export default function Home() {
  const router = useRouter();
  const [active, setActive] = useState<ModeId | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [failedClips, setFailedClips] = useState(0);

  /** Quadrant currently under the finger, so a name is spoken on CHANGE only. */
  const hoveredRef = useRef<ModeId | null>(null);
  /** The first gesture speaks the menu; per-quadrant names start from the second. */
  const introducedRef = useRef(false);
  /** The camera stream opened inside the tap that entered Walk mode; the menu owns it. */
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  /** Mirror of cameraStream for teardown: unmount cleanup must not read state. */
  const cameraStreamRef = useRef<MediaStream | null>(null);
  /** True while the walk tile's getUserMedia is in flight — one request at a time. */
  const cameraOpeningRef = useRef(false);
  const lastUsed = useSyncExternalStore(subscribeLastUsed, readLastUsed, getLastUsedServerSnapshot);

  /**
   * Starts fetching and decoding every clip the moment the menu mounts, rather
   * than waiting for the first tap. Previously the first touch had to download
   * every clip before anything could happen — on a slow tunnel that made the
   * first tap, the only way into Walk mode, hang for tens of seconds.
   */
  useEffect(() => {
    clipsLoadPromise ??= loadAllClips();
    void clipsLoadPromise.then(({ failed }) => {
      setFailedClips(failed.length);
      setAudioReady(true);
    });
  }, []);

  /**
   * Resumes the context (created at mount, so iOS starts it suspended) inside
   * the gesture that calls this, and waits a bounded time for clips already on
   * their way. A slow tunnel must never turn a tap into a hang: after the
   * bound, whatever has decoded is what gets played, and the rest arrives in
   * the background.
   */
  const ensureAudio = useCallback(async () => {
    audioContext();
    if (audioReady) return true;
    await Promise.race([
      clipsLoadPromise ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, AUDIO_READY_WAIT_MS)),
    ]);
    return true;
  }, [audioReady]);

  /** Stops the camera this page opened and forgets it. Safe to call with none. */
  function releaseCamera() {
    for (const track of cameraStreamRef.current?.getTracks() ?? []) track.stop();
    cameraStreamRef.current = null;
    setCameraStream(null);
  }

  // Leaving the app entirely must also release the camera.
  useEffect(() => {
    return () => {
      for (const track of cameraStreamRef.current?.getTracks() ?? []) track.stop();
      cameraStreamRef.current = null;
    };
  }, []);

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

  const enter = useCallback(async (id: ModeId) => {
    const mode = MODES.find((m) => m.id === id)!;
    if (!isReady(mode)) {
      // CLAUDE.md: no silent failures. Name, then "тун удахгүй" — the button is
      // real, the mode simply is not built yet. Deliberately NOT the error clip:
      // that would report a fault and invite a retry that cannot ever succeed.
      playSequence([mode.clip, "coming_soon"].filter(hasClip), { interrupt: true });
      return;
    }
    rememberLastUsed(id);
    playSequence([mode.clip].filter(hasClip), { interrupt: true });

    // A routed mode navigates; only the legacy inline one is swapped in here.
    // Before this, EVERY ready mode rendered WalkMode regardless of which tile
    // was tapped, because `active` was never consulted.
    if (mode.route) {
      router.push(mode.route);
      return;
    }

    // Walk mode owns the camera, and iOS Safari will not show the permission
    // prompt unless getUserMedia runs inside THIS tap — from the mount effect
    // that follows, the request silently never resolves and the mode looks
    // dead. So the camera is opened here, in the gesture, and the stream is
    // handed to WalkMode, which starts the video with it instead of asking
    // again. Denied or unavailable, the tile says so and stays on the menu.
    if (mode.camera) {
      // One camera request at a time: a second tap while the first is still
      // opening must not start a parallel getUserMedia (two prompts, and a
      // leaked stream if both resolve).
      if (cameraOpeningRef.current) return;
      cameraOpeningRef.current = true;
      try {
        // The tilt sensor has the same iOS gesture gate as the camera; asking
        // here, while the tap is live, means WalkMode's listener gets a
        // granted sensor instead of silently degrading to the pitch guess.
        // Walk only: it feeds the ground-plane distance estimate, and Money
        // has no use for pitch — asking would be a second permission dialog
        // in front of someone who cannot see it, bought for nothing.
        if (id === "walk") await requestTiltPermission();
        const stream = await openCamera();
        // A stream from a fast back+re-enter can still be alive; stop it
        // before taking over the camera.
        for (const track of cameraStreamRef.current?.getTracks() ?? []) track.stop();
        cameraStreamRef.current = stream;
        setCameraStream(stream);
      } catch {
        playSequence(["error", "try_again"].filter(hasClip), { interrupt: true });
        return;
      } finally {
        cameraOpeningRef.current = false;
      }
    }
    setActive(id);
  }, [router]);

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
    if (id) void enter(id);
  }

  /** Every inline mode leaves the same way, so back behaves identically in all of them. */
  const leaveMode = () => {
    releaseCamera();
    setActive(null);
    hoveredRef.current = null;
    playSequence(["menu"].filter(hasClip), { interrupt: true });
  };

  if (active === "walk") {
    return <WalkMode onBack={leaveMode} initialStream={cameraStream} />;
  }

  if (active === "money") {
    return <MoneyMode onBack={leaveMode} initialStream={cameraStream} />;
  }

  return (
    <div
      className="w-screen h-dvh bg-black"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* dvh, not vh: iOS resizes vh when the URL bar shows and hides, which
          would move the touch targets under a finger that cannot see them move.

          Rows are derived from MODES rather than written as grid-rows-2, and
          the tiles size themselves from the cell instead of the old fixed
          w-[50vw] h-[50dvh]. Adding Money as a fifth mode under the hardcoded
          version would have overflowed the screen and pushed a tile out of
          reach — silently, since nobody using this app can see that happen. */}
      <div
        className="grid grid-cols-2 w-full h-full"
        style={{ gridTemplateRows: `repeat(${Math.ceil(MODES.length / 2)}, 1fr)` }}
      >
        {MODES.map((m, i) => (
          <button
            key={m.id}
            data-mode={m.id}
            aria-label={m.label}
            // VoiceOver's double-tap arrives here as a click, bypassing the
            // touch handlers entirely — which is why activation must also live
            // on onClick and not only on touchend.
            onClick={() => {
              // The camera request must reach getUserMedia while this click
              // still counts as a gesture. Awaiting the (possibly slow) audio
              // load first would push it past the gesture window on iOS and
              // the button would appear dead, so audio loads in the
              // background while the tap proceeds.
              introducedRef.current = true;
              void ensureAudio();
              void enter(m.id);
            }}
            // An odd number of modes leaves a hole in the last row, and a hole
            // is a DEAD ZONE for touch-explore: a finger dragging into it
            // hears nothing and cannot tell "empty" from "the app stopped
            // responding". The final tile spans both columns instead, so every
            // point on the screen belongs to some mode.
            className={`${
              MODES.length % 2 === 1 && i === MODES.length - 1 ? "col-span-2" : ""
            } w-full h-full flex items-center justify-center border border-white/20 text-white text-3xl font-bold`}
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
