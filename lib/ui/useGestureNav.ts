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
  /**
   * Push-to-talk. While true a long press emits hold edges instead of
   * "where am I" — the two are the same physical gesture and cannot coexist.
   * Set it only for the phases that are actually listening.
   */
  holdMode?: boolean;
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
  /**
   * Fired the instant a finger lands in hold mode, BEFORE the press is known to
   * be a hold.
   *
   * `holdStart` arrives from the 600 ms timer below, and a timer callback carries
   * no user activation — which iOS requires before it will show the microphone
   * prompt. So the microphone is asked for here, in the touch handler, where the
   * activation still exists; `onHoldStart` then gets a stream that is already
   * open. A press that turns out not to be a hold costs a warm microphone that
   * closes itself seconds later, unused.
   */
  onHoldPrewarm?: () => void;
  /** Two-finger vertical swipe distance, in options. */
  jumpSize?: number;
  enabled?: boolean;
  /**
   * Changes whenever the list becomes a DIFFERENT list — normally the screen's
   * phase. The cursor jumps back to the top when it changes.
   *
   * Without this the index carries over: selecting the second item of a
   * two-item menu and landing on the second item of the hundred-item list
   * behind it. A sighted user sees where they are; someone navigating by ear
   * hears item two and has no way to know they skipped item one.
   */
  resetKey?: string | number;
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
  resetKey, holdMode = false, onHoldStart, onHoldEnd, onHoldPrewarm,
}: GestureNavOptions<T>) {
  const [index, setIndex] = useState(0);
  const recognizer = useMemo(() => new GestureRecognizer(), []);
  const indexRef = useRef(0);
  const optionsRef = useRef(options);

  indexRef.current = index;
  optionsRef.current = options;

  /**
   * Send the cursor to the top when the list is replaced.
   *
   * Adjusted DURING RENDER rather than in an effect — the documented React
   * pattern for state derived from a changing prop. An effect would render the
   * wrong position first and correct it after, and on this screen the "wrong
   * position" is spoken aloud before it gets fixed.
   */
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  if (resetKey !== seenResetKey) {
    setSeenResetKey(resetKey);
    // `indexRef` is deliberately NOT touched here. Setting state during render
    // makes React re-run this component immediately, and the assignment above
    // re-syncs the ref from the new index on that pass.
    setIndex(0);
  }

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
        case "holdStart":
          vibrate(HAPTICS.select);
          onHoldStart?.();
          break;
        case "holdEnd":
          onHoldEnd?.();
          break;
      }
    },
    [jumpSize, move, onBack, onHoldEnd, onHoldStart, onRepeat, onSelect, onWhereAmI],
  );

  // Mode changes take effect on the NEXT press, never mid-gesture: the
  // recognizer latches a hold when it starts so the release still lands.
  useEffect(() => {
    holdModeRef.current = holdMode;
    prewarmRef.current = onHoldPrewarm;
    recognizer.setHoldMode(holdMode);
  }, [holdMode, onHoldPrewarm, recognizer]);

  /**
   * Read through refs, synced in the same effect that sets the recogniser's
   * mode below, so the prewarm decision uses the CURRENT mode without
   * rebuilding `feed` — and therefore the touch handlers — on every phase
   * change. Rebuilding them mid-press is how a release lands on a recogniser
   * that never saw the press.
   */
  const holdModeRef = useRef(holdMode);
  const prewarmRef = useRef(onHoldPrewarm);

  const feed = useCallback(
    (event: RawEvent) => {
      if (!enabled) return;
      // The last moment that still carries a user activation. See onHoldPrewarm.
      if (event.phase === "start" && holdModeRef.current && event.touches.length === 1) {
        prewarmRef.current?.();
      }
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
