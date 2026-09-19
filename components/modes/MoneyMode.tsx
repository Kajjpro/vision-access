"use client";

/**
 * MoneyMode — name the tögrög note in front of the camera.
 *
 * Tap to capture, same shape NOTES.md specifies for BusMode: tap, a few
 * frames, decide, speak. NOT a continuous loop like WalkMode, for two
 * reasons. Nobody holds a banknote while walking down a street, and CLAUDE.md
 * allows one spoken announcement per 1.5 seconds — a mode that narrated
 * every frame would spend that budget on a note the user is already holding
 * and knows about.
 *
 * The screen layout is deliberately identical to WalkMode's: back is the top
 * 15%, the large middle is the action, the bottom edge repeats. Three
 * landmarks findable by feel, in the same place in every mode.
 *
 * WHAT THIS MODE WILL NOT DO. It does not guess. A capture that does not
 * clear the gates in lib/money/recognizer.ts, or whose frames disagree, is
 * reported as "Тодорхойгүй" and the user taps again. CLAUDE.md: a wrong
 * banknote value causes real harm, and unlike a missed obstacle it is an
 * assertion the user acts on at a till with no way to check it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { hasClip, loadClips, playSequence, stopAll } from "@/lib/audio";
import { openCamera } from "@/lib/camera";
import {
  FRAMES_PER_CAPTURE,
  FRAME_INTERVAL_MS,
  decide,
  type Decision,
} from "@/lib/money/decide";
import { DENOMINATION_INFO, denominationPhraseIds } from "@/lib/money/denominations";
import type { Recognition } from "@/lib/money/recognizer";
import type { MoneyWorkerRequest, MoneyWorkerResponse } from "@/lib/money.worker";

/** Everything this mode can say, loaded before it claims to be ready. */
const CLIPS = [
  ...denominationPhraseIds(),
  "money_prompt",
  "money_reading",
  "mode_money",
  "unclear",
  "try_again",
  "ready",
  "error",
  "loading",
  "coming_soon",
];

type Status = "loading" | "ready" | "capturing" | "failed" | "no-pack";

export default function MoneyMode({
  onBack,
  initialStream,
}: {
  onBack: () => void;
  /** Camera opened by the menu inside its tap gesture; null on a deep link. */
  initialStream?: MediaStream | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const acquiredStreamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [decision, setDecision] = useState<Decision | null>(null);
  /** On-screen only. There is no console on a phone (CLAUDE.md). */
  const [diagnostic, setDiagnostic] = useState<string>("starting");

  /** Frames of the capture currently in flight, keyed by the capture's token. */
  const captureRef = useRef<{ token: number; frames: (Recognition | null)[] } | null>(null);
  const nextTokenRef = useRef(1);
  /** Exactly what was last said, so the repeat zone replays it verbatim. */
  const lastSpokenRef = useRef<string[]>([]);

  const say = useCallback((clips: string[]) => {
    lastSpokenRef.current = clips;
    playSequence(clips.filter(hasClip), { interrupt: true });
  }, []);

  // --- audio + camera + worker ---------------------------------------------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await loadClips(CLIPS);
      } catch {
        // A missing clip must not stop the mode; hasClip() filters at playback
        // and the on-screen readout still reports what happened.
        if (!cancelled) setDiagnostic("some audio failed to load");
      }

      // The menu opened the camera inside ITS tap gesture and handed it over.
      // Calling getUserMedia from this effect on iOS never shows the prompt.
      let stream = initialStream ?? null;
      if (!stream) {
        try {
          stream = await openCamera();
          acquiredStreamRef.current = stream;
        } catch (e) {
          if (cancelled) return;
          setStatus("failed");
          setDiagnostic(`camera: ${e instanceof Error ? e.message : String(e)}`);
          say(["error"]);
          return;
        }
      }
      if (cancelled) return;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        void video.play().catch(() => {
          // Autoplay refusal surfaces as a black preview, which a sighted
          // helper can see; the mode itself does not depend on the preview.
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialStream, say]);

  useEffect(() => {
    const worker = new Worker(new URL("../../lib/money.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<MoneyWorkerResponse>) => {
      const message = event.data;

      if (message.type === "ready") {
        setStatus("ready");
        setDiagnostic(`pack: ${message.entries} references · ${message.source}`);
        // Both, in order: the mode is up, and here is what to do with it.
        say(["ready", "money_prompt"]);
        return;
      }

      if (message.type === "error") {
        setDiagnostic(message.message);
        if (message.kind === "missing") {
          // No reference pack has been built yet. The mode works; the notes
          // have not been photographed. NOTES.md: a thing that is not ready
          // says so and does NOT use the error clip, which would report a
          // fault and invite a retry that cannot possibly succeed.
          setStatus("no-pack");
          say(["mode_money", "coming_soon"]);
          return;
        }
        setStatus("failed");
        // CLAUDE.md: announce degradation. Silence here is indistinguishable
        // from a mode that is working and seeing nothing.
        say(["error"]);
        return;
      }

      if (message.type === "result") {
        const capture = captureRef.current;
        // A result from a superseded capture — the user tapped again mid-read.
        if (!capture || capture.token !== message.token) return;

        capture.frames.push(message.result);
        setDiagnostic(
          `frame ${capture.frames.length}/${FRAMES_PER_CAPTURE} · ${message.debug.features} features · ` +
            `${message.debug.elapsedMs}ms · ${message.debug.reason}`,
        );

        if (capture.frames.length < FRAMES_PER_CAPTURE) return;

        const verdict = decide(capture.frames);
        captureRef.current = null;
        setDecision(verdict);
        setStatus("ready");

        if (verdict.kind === "identified") {
          say([DENOMINATION_INFO[verdict.denomination].phraseId]);
        } else {
          // "unclear" then "try again" — two facts, and neither is the error
          // clip: nothing is broken, the note simply was not readable.
          say(["unclear", "try_again"]);
        }
      }
    };

    worker.onerror = (e) => {
      setStatus("failed");
      setDiagnostic(`worker: ${e.message}`);
      say(["error"]);
    };

    worker.postMessage({ type: "init" } satisfies MoneyWorkerRequest);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [say]);

  // Release a camera this screen opened itself (deep link, retry).
  useEffect(() => {
    return () => {
      stopAll();
      const owned = acquiredStreamRef.current;
      if (owned) for (const track of owned.getTracks()) track.stop();
    };
  }, []);

  // --- capture -------------------------------------------------------------

  const capture = useCallback(() => {
    const worker = workerRef.current;
    const video = videoRef.current;
    if (status === "no-pack") {
      // Repeating the true reason beats the error clip every time it is tapped.
      say(["mode_money", "coming_soon"]);
      return;
    }
    if (status === "failed" || !worker) {
      say(["error"]);
      return;
    }
    if (status === "loading") {
      say(["loading"]);
      return;
    }
    if (!video || video.readyState < 2 || video.videoWidth === 0) {
      setDiagnostic("camera has no frames yet");
      say(["error"]);
      return;
    }

    const token = nextTokenRef.current++;
    captureRef.current = { token, frames: [] };
    setDecision(null);
    setStatus("capturing");
    say(["money_reading"]);

    // Frames spaced out rather than grabbed back to back: the point of taking
    // several is to sample DIFFERENT glare, blur and hand position, and three
    // frames from one 30ms window are the same frame three times.
    for (let i = 0; i < FRAMES_PER_CAPTURE; i++) {
      window.setTimeout(() => {
        if (captureRef.current?.token !== token) return; // Superseded.
        const live = videoRef.current;
        if (!live) return;
        createImageBitmap(live)
          .then((bitmap) =>
            worker.postMessage({ type: "frame", bitmap, token } satisfies MoneyWorkerRequest, [
              bitmap,
            ]),
          )
          .catch((e) => setDiagnostic(`capture: ${e instanceof Error ? e.message : String(e)}`));
      }, i * FRAME_INTERVAL_MS);
    }
  }, [status, say]);

  const repeat = useCallback(() => {
    if (lastSpokenRef.current.length === 0) {
      say(["money_prompt"]);
      return;
    }
    playSequence(lastSpokenRef.current.filter(hasClip), { interrupt: true });
  }, [say]);

  // --- render --------------------------------------------------------------

  const readout =
    decision === null
      ? status === "capturing"
        ? "…"
        : ""
      : decision.kind === "identified"
        ? DENOMINATION_INFO[decision.denomination].display
        : "?";

  return (
    <div className="w-screen h-dvh bg-black relative">
      <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />

      {/* Large, high contrast, and the ONLY thing on screen at size: a sighted
          helper standing next to the user should be able to read the verdict
          from arm's length without interpreting anything else.
          pointer-events-none so the capture zone underneath keeps the tap. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
      >
        <span className="text-white text-7xl font-bold drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">
          {readout}
        </span>
      </div>

      {/* Back to the menu: the top 15% of every mode screen, in the same place
          in every mode, so it can be found without looking. */}
      <button
        onClick={onBack}
        aria-label="Цэс рүү буцах"
        className="absolute top-0 left-0 right-0 h-[15dvh] z-20"
      />

      {/* The middle — the largest target, and the only region a finger lands on
          without aiming — takes the photograph. */}
      <button
        onClick={capture}
        aria-label="Мөнгө унших"
        className="absolute top-[15dvh] bottom-[15dvh] left-0 right-0 z-10"
      />

      {/* Repeat, mirroring the back zone: top edge goes back, bottom repeats.
          The single most likely thing a user wants after an announcement they
          did not quite catch, and it must never re-run the camera — a repeat
          that re-reads could say something different and there would be no way
          to tell which reading was the real one. */}
      <button
        onClick={repeat}
        aria-label="Дахин хэлэх"
        className="absolute bottom-0 left-0 right-0 h-[15dvh] z-20"
      />

      {/* System readout only. There is no console on a phone, so this is the
          only place status can surface. Below the back zone so it cannot
          swallow that tap. */}
      <div
        aria-hidden="true"
        className="absolute top-[15dvh] left-0 right-0 px-3 py-2 text-[11px] leading-tight text-white/70 font-mono pointer-events-none"
      >
        <div>{status}</div>
        <div>{diagnostic}</div>
        {decision?.kind === "identified" && (
          <div>
            {decision.agreeing}/{FRAMES_PER_CAPTURE} frames · {decision.inliers} inliers
          </div>
        )}
        {decision?.kind === "unclear" && <div>{decision.reason}</div>}
      </div>
    </div>
  );
}
