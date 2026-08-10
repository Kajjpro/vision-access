"use client";

/**
 * The full-viewport gesture surface every screen sits on.
 *
 * TWO INPUT PATHS, because one is not enough on iOS.
 *
 *  1. RAW GESTURES, for users with no screen reader running. The whole viewport
 *     is the button; position never matters.
 *
 *  2. REAL FOCUSABLE BUTTONS, for VoiceOver and TalkBack. When a screen reader
 *     is active it CONSUMES every touch gesture before the page sees it — a
 *     swipe becomes "move focus", a double-tap becomes "activate the focused
 *     element", and the page receives neither. No amount of threshold tuning
 *     changes that; it is how the platform works.
 *
 * An earlier version marked this whole surface `aria-hidden` and rendered
 * nothing focusable, to stop the screen reader double-reading text the audio
 * queue already speaks. On Android with TalkBack off that was fine. On an
 * iPhone with VoiceOver on — which is what a blind user actually has — it left
 * VoiceOver with nothing to focus, so swipes and double-taps did nothing at
 * all. That is the bug this file now exists to prevent.
 *
 * The buttons carry the SAME labels the audio queue speaks and call the SAME
 * actions, so both paths lead to identical behaviour.
 */
import { useEffect, useRef, type ReactNode } from "react";

export type A11yOption = {
  /** Spoken by the screen reader. Should match what the audio queue says. */
  label: string;
  onActivate: () => void;
  selected?: boolean;
};

export function GestureSurface({
  handlers,
  children,
  options = [],
  screenReaderMode = false,
  onFocusOption,
}: {
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    onTouchCancel: (e: React.TouchEvent) => void;
  };
  children: ReactNode;
  /** One entry per option. Rendered as real buttons for screen-reader users. */
  options?: A11yOption[];
  screenReaderMode?: boolean;
  /** Called when a screen reader moves focus onto an option. */
  onFocusOption?: (index: number) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  /**
   * Non-passive touchmove, attached natively.
   *
   * React attaches touch listeners passively, so `preventDefault` inside
   * `onTouchMove` is ignored. Without it iOS Safari treats a vertical drag as a
   * page scroll, fires `touchcancel`, and the swipe is lost halfway through —
   * which looked exactly like the gesture not being recognised.
   */
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      // SINGLE finger only. Blocking two-finger moves would also kill pinch
      // zoom, and partial-sight users magnify the screen — losing that to win
      // a gesture is the wrong trade. Our two-finger jump is occasionally
      // read as a pinch instead; that is the acceptable side of it.
      if (e.touches.length === 1 && e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchmove", block, { passive: false });
    return () => el.removeEventListener("touchmove", block);
  }, []);

  return (
    <div
      ref={surfaceRef}
      {...handlers}
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
        /**
         * iOS specifics, all load-bearing:
         *
         * `manipulation` disables double-tap-to-zoom — which Safari otherwise
         * swallows our select gesture for — while STILL allowing pinch zoom,
         * so partial-sight users keep magnification.
         *
         * `WebkitTouchCallout` stops the long-press callout. Without it, our
         * "where am I" long press pops up iOS's copy/share sheet instead.
         */
        touchAction: "manipulation",
        overscrollBehavior: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {/* Visual layer only. aria-hidden so a screen reader does not read it in
          addition to the focusable buttons below — that would double every
          announcement. */}
      <div aria-hidden="true" style={{ pointerEvents: "none" }}>
        {children}
      </div>

      {/*
        The screen-reader path. Visually hidden but FOCUSABLE and on-screen —
        `display:none`, `visibility:hidden` and zero-size all remove an element
        from the accessibility tree, so none of those can be used here.

        VoiceOver's swipe moves between these; its double-tap activates one.
        That maps exactly onto our own model, so a VoiceOver user gets the same
        interaction without the app ever seeing a raw touch.
      */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          // Above the visual layer so VoiceOver's focus ring lands sensibly.
          zIndex: 1,
        }}
      >
        {options.map((option, i) => (
          <button
            key={`${i}-${option.label}`}
            /**
             * `detail === 0` means the click did NOT come from a physical
             * pointer — it was synthesised by an assistive technology or the
             * keyboard. That is exactly a VoiceOver double-tap.
             *
             * Real finger taps (detail >= 1) are ignored here and left to the
             * gesture recogniser, which requires a DOUBLE tap. Without this
             * guard a single stray tap on the invisible button layer would
             * select an option — precisely what the model forbids.
             */
            onClick={(e) => {
              if (e.detail === 0 || screenReaderMode) option.onActivate();
            }}
            onFocus={() => onFocusOption?.(i)}
            aria-current={option.selected ? "true" : undefined}
            style={{
              flex: 1,
              width: "100%",
              // Transparent rather than hidden: it must stay in the a11y tree.
              background: "transparent",
              border: "none",
              color: "transparent",
              font: "inherit",
              padding: 0,
              margin: 0,
              /**
               * Always interactive. VoiceOver activates by synthesising a tap
               * AT the element, so `pointer-events: none` would stop it working
               * — and these buttons exist precisely for VoiceOver.
               *
               * Raw gestures are unaffected: touch events bubble from the
               * button up to the surface, and the onClick guard above ignores
               * physical taps.
               */
              pointerEvents: "auto",
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The current option, shown large. Informational only — never a target. */
export function CurrentOption({
  title, detail, position,
}: { title: string; detail?: string; position?: string }) {
  return (
    <>
      {position && <p style={{ fontSize: 18, color: "#888", margin: "0 0 12px" }}>{position}</p>}
      <p style={{ fontSize: 44, fontWeight: 700, margin: 0, lineHeight: 1.15 }}>{title}</p>
      {detail && <p style={{ fontSize: 22, color: "#aaa", marginTop: 14 }}>{detail}</p>}
    </>
  );
}
