"use client";

/**
 * The lock-on box: a viewfinder bracket around the ONE object the app is
 * currently paying attention to.
 *
 * WHO THIS IS FOR. Not the blind user — they get the focus blip, the proximity
 * tone and the spoken warning, and none of that changes here. This is for the
 * sighted person: the helper setting the phone up, and whoever is working out
 * why the app just called a lamp post a person. CLAUDE.md is explicit that
 * debug output has to go on screen because there is no console on a phone, and
 * a list of class names in the corner cannot answer the only question that
 * matters — *is the box on the thing I am pointing at?* This can.
 *
 * It renders the SAME lock WalkMode announces (`lockedTrackIdRef`, chosen by
 * pickTarget), so what is bracketed is exactly what is being spoken about. If
 * the two ever disagree the overlay is lying, which is worse than not having
 * it, so both come from one source of truth rather than each picking a target.
 *
 * Purely decorative to assistive tech: aria-hidden, and pointer-events-none so
 * the full-screen tap zones underneath keep working. A box that swallowed the
 * "where is the gap" tap would be a real regression for the actual user.
 */
import { useEffect, useRef, useState } from "react";

import { coverTransform, isOnScreen, projectRect, projectX } from "@/lib/ui/overlay";
import type { Size } from "@/lib/ui/overlay";

export type OverlayTrack = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  className: string;
  metres: number;
  reliable: boolean;
  /** Frames seen in. Below the confirmation count the box is drawn provisionally. */
  hits: number;
  /** Mean detector score for the winning class, 0..1. */
  score: number;
  /** Share of recent frames that agreed on the class, 0..1. */
  classConfidence: number;
  /** Whether the name cleared both bars and would actually be spoken. */
  trusted: boolean;
};

/** Frames a track must be seen in before its box stops looking provisional. */
const CONFIRMED_HITS = 3;

/** Roughly the label's own height. Below this the label goes under the box instead. */
const LABEL_HEIGHT_PX = 24;

/** Corner bracket length: about a third of the shorter side, capped. */
function bracketPx(rect: { width: number; height: number }): number {
  return Math.max(6, Math.min(24, Math.min(rect.width, rect.height) / 3));
}

/** Distance text under the bracket. Never a number the warning would not speak. */
function distanceLabel(track: OverlayTrack): string {
  if (!track.reliable) return track.metres <= 1 ? "very close" : "—";
  if (!Number.isFinite(track.metres)) return "—";
  return `${track.metres.toFixed(1)} m`;
}

/**
 * Tracks the element's own size.
 *
 * ResizeObserver rather than a window resize listener: this has to be right
 * after an orientation change, after the URL bar collapses, and after the
 * dynamic viewport units settle — all of which move the element without
 * necessarily firing a useful resize event.
 */
function useElementSize(): [React.RefObject<HTMLDivElement | null>, Size | null] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ width: box.width, height: box.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

export default function TargetOverlay({
  frame,
  tracks,
  lockedId,
  corridor,
}: {
  /** True capture size, in the pixels the detector's boxes are expressed in. */
  frame: Size;
  /** Everything seen in the latest frame. Usually two or three things. */
  tracks: OverlayTrack[];
  /** The one track being announced, or null when the corridor is empty. */
  lockedId: number | null;
  /** Walking corridor as fractions of frame width, drawn as guides. */
  corridor: { min: number; max: number };
}) {
  const [ref, viewport] = useElementSize();
  const transform = viewport ? coverTransform(frame, viewport) : null;

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden pointer-events-none"
    >
      {transform && viewport && (
        <>
          {/* Where the corridor is, so the phone can be aimed. Only the middle
              50% of the frame is announced at all (WalkMode: CORRIDOR_MIN /
              CORRIDOR_MAX), and without these lines "the app ignored that
              bollard" and "the bollard was outside the corridor" look
              identical from the outside. */}
          {[corridor.min, corridor.max].map((fraction) => (
            <div
              key={fraction}
              className="absolute top-0 bottom-0 w-px bg-white/15"
              style={{ left: projectX(fraction * frame.width, transform) }}
            />
          ))}

          {tracks.map((track) => {
            const rect = projectRect(track, transform);
            if (!isOnScreen(rect, viewport)) return null;

            const locked = track.id === lockedId;
            const style = {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            };

            // Everything that is not the target: a thin outline, deliberately
            // quiet. It shows the detector is alive and seeing the scene
            // without competing with the one box that means something.
            if (!locked) {
              return (
                <div
                  key={track.id}
                  className="absolute border border-white/25 rounded-sm"
                  style={style}
                />
              );
            }

            return (
              <div key={track.id} className="absolute" style={style}>
                {/* Corner brackets, not a plain rectangle. A camera's
                    focus-lock shape reads as "this one, right now" at a
                    glance, and it leaves the object itself unobscured — the
                    helper is trying to see what is inside the box. */}
                <div className="absolute inset-0 border border-amber-300/40 rounded-sm" />
                {[
                  "top-0 left-0 border-t-4 border-l-4 rounded-tl-md",
                  "top-0 right-0 border-t-4 border-r-4 rounded-tr-md",
                  "bottom-0 left-0 border-b-4 border-l-4 rounded-bl-md",
                  "bottom-0 right-0 border-b-4 border-r-4 rounded-br-md",
                ].map((corner) => (
                  <div
                    key={corner}
                    className={`absolute border-amber-300 ${corner}`}
                    // Sized to the box, not fixed. A distant bollard is thirty
                    // pixels wide, and four fixed 24px brackets on it meet in
                    // the middle and render as a solid amber square — which
                    // hides the very object the helper is checking.
                    style={{ width: bracketPx(rect), height: bracketPx(rect) }}
                  />
                ))}

                {/* Name and distance, pinned just above the bracket. Object
                    name before distance, in the same order the audio says it —
                    someone comparing the screen against what they just heard
                    should not have to reorder it in their head.

                    The two confidence figures are the answer to "why did it not
                    say the word": detector score, then how much of the recent
                    evidence agreed on the class. A name the app is NOT willing
                    to speak is struck through, so the screen and the audio can
                    be reconciled without guessing which bar was missed.

                    Clamped to the top of the overlay so a box at the very top
                    of the frame does not push its own label off-screen. */}
                <p
                  className="absolute left-0 whitespace-nowrap text-amber-300 text-xs font-mono bg-black/70 px-1.5 py-0.5 rounded"
                  style={
                    rect.top < LABEL_HEIGHT_PX
                      ? { top: "100%", marginTop: 4 }
                      : { bottom: "100%", marginBottom: 4 }
                  }
                >
                  <span className={track.trusted ? "" : "line-through opacity-60"}>
                    {track.className || "?"}
                  </span>
                  {track.hits < CONFIRMED_HITS && " ?"}
                  {` ${track.score.toFixed(2)}/${track.classConfidence.toFixed(2)}`}
                  {` · ${distanceLabel(track)}`}
                </p>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
