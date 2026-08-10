"use client";

/**
 * Headless hook wrapping the pure recogniser.
 *
 * Owns only the things that cannot be pure — touch events, a timer for long
 * press, haptics — and delegates every decision to GestureRecognizer, so the
 * behaviour under sloppy input is decided in a tested module rather than here.
 *
 * Returns handlers to spread onto a full-viewport element. There is no other
 * target: the whole screen is the button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  GestureRecognizer, HAPTICS, moveCursor, vibrate,
  type Gesture, type ListOption, type RawEvent, type Sample,
} from "./gesture-nav";

export type GestureNavOptions<T> = {
  options: ListOption<T>[];
  /** Announce an option. Must interrupt whatever is playing. */
  announce: (option: ListOption<T>, context: { index: number; total: number; wrapped: boolean }) => void;
  onSelect: (option: ListOption<T>) => void;
  onBack?: () => void;
  onRepeat?: () => void;
  onWhereAmI?: (option: ListOption<T> | null) => void;
  /** Two-finger vertical swipe distance, in options. */
  jumpSize?: number;
  enabled?: boolean;
  /**
   * First refusal on every gesture. Return true to consume it.
   *
   * Used by any overlay that must take gestures before they reach navigation —
   * a confirmation prompt, for instance. Kept generic so an overlay always runs
   * against the SAME recogniser and thresholds as the rest of the app.
   */
  intercept?: (gesture: Gesture) => boolean;
};

export function useGestureNav<T>({
  options, announce, onSelect, onBack, onRepeat, onWhereAmI, jumpSize = 5, enabled = true, intercept,
}: GestureNavOptions<T>) {
  const [index, setIndex] = useState(0);
  const recognizer = useMemo(() => new GestureRecognizer(), []);
  const indexRef = useRef(0);
  const optionsRef = useRef(options);

  indexRef.current = index;
  optionsRef.current = options;

  // Keep the cursor inside a list that changed under it.
  useEffect(() => {
    if (index >= options.length && options.length > 0) setIndex(0);
  }, [index, options.length]);

  const move = useCallback(
    (delta: number) => {
      const list = optionsRef.current;
      if (list.length === 0) return;
      const { index: next, wrapped } = moveCursor(indexRef.current, delta, list.length);
      setIndex(next);
      indexRef.current = next;
      vibrate(wrapped ? HAPTICS.boundary : HAPTICS.optionChange);
      announce(list[next], { index: next, total: list.length, wrapped });
    },
    [announce],
  );

  const interceptRef = useRef(intercept);
  interceptRef.current = intercept;

  const apply = useCallback(
    (gesture: Gesture) => {
      // Consumed by an overlay before it can navigate anywhere.
      if (interceptRef.current?.(gesture)) return;
      const list = optionsRef.current;
      switch (gesture.type) {
        case "next": move(1); break;
        case "previous": move(-1); break;
        case "jumpForward": move(jumpSize); break;
        case "jumpBack": move(-jumpSize); break;
        case "select":
          if (list.length > 0) {
            vibrate(HAPTICS.select);
            onSelect(list[indexRef.current]);
          }
          break;
        case "back":
          vibrate(HAPTICS.back);
          onBack?.();
          break;
        case "repeat":
          onRepeat?.();
          break;
        case "whereAmI":
          onWhereAmI?.(list[indexRef.current] ?? null);
          break;
      }
    },
    [jumpSize, move, onBack, onRepeat, onSelect, onWhereAmI],
  );

  const feed = useCallback(
    (event: RawEvent) => {
      if (!enabled) return;
      for (const gesture of recognizer.handle(event)) apply(gesture);
    },
    [apply, enabled, recognizer],
  );

  // Long press completes through the ABSENCE of events, so it needs a timer:
  // no touch event will ever announce that a finger has stayed still.
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      for (const gesture of recognizer.tick(Date.now())) apply(gesture);
    }, 100);
    return () => clearInterval(timer);
  }, [apply, enabled, recognizer]);

  const toSamples = (list: React.TouchList): Sample[] =>
    Array.from({ length: list.length }, (_, i) => {
      const t = list[i];
      return { id: t.identifier, x: t.clientX, y: t.clientY, t: Date.now() };
    });

  const handlers = useMemo(
    () => ({
      onTouchStart: (e: React.TouchEvent) => feed({ phase: "start", touches: toSamples(e.touches), t: Date.now() }),
      onTouchMove: (e: React.TouchEvent) => feed({ phase: "move", touches: toSamples(e.touches), t: Date.now() }),
      onTouchEnd: (e: React.TouchEvent) => feed({ phase: "end", touches: toSamples(e.changedTouches), t: Date.now() }),
      /**
       * iOS fires touchcancel readily — a notification, an edge gesture, the
       * system taking over. Resetting here threw away gestures that had already
       * travelled far enough to count, which read as the swipe being ignored.
       * Finalise instead: feed the cancel as an end so a completed swipe still
       * lands, and only genuinely partial gestures are dropped.
       */
      onTouchCancel: (e: React.TouchEvent) =>
        feed({ phase: "end", touches: toSamples(e.changedTouches), t: Date.now() }),
    }),
    [feed, recognizer],
  );

  return {
    index,
    setIndex: (i: number) => { setIndex(i); indexRef.current = i; },
    current: options[index] ?? null,
    handlers,
    /** Exposed so a screen can drive the same paths from a keyboard in dev. */
    apply,
  };
}
