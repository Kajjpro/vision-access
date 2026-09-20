/**
 * The interaction model, once, for every screen.
 *
 * THE WHOLE SCREEN IS THE BUTTON AND POSITION NEVER MATTERS. A blind passenger
 * standing on a moving bus cannot find a target on flat glass, so there are no
 * targets: options are a list scrolled by ear, and the primary action is the
 * entire viewport.
 *
 *   swipe up / down    move through options, announcing each
 *   double-tap         select the announced option
 *   swipe left         go back
 *   two-finger tap     repeat the last announcement
 *   long press         "where am I" — screen name plus current option
 *   two-finger swipe   jump five at a time through a long list
 *
 * The recogniser below is PURE: it consumes normalized samples and emits
 * gestures, with no DOM, no React and no clock of its own. That is what allows
 * it to be tested against deliberately sloppy input rather than clean synthetic
 * swipes — and sloppy is the real case, because Ulaanbaatar winters mean these
 * gestures are made through gloves.
 */

export type Sample = { id: number; x: number; y: number; t: number };

export type RawEvent =
  | { phase: "start"; touches: Sample[]; t: number }
  | { phase: "move"; touches: Sample[]; t: number }
  | { phase: "end"; touches: Sample[]; t: number };

export type Gesture =
  | { type: "next" }
  | { type: "previous" }
  | { type: "select" }
  | { type: "back" }
  | { type: "repeat" }
  | { type: "whereAmI" }
  | { type: "jumpForward" }
  | { type: "jumpBack" }
  /**
   * Press-and-hold edges, emitted ONLY in hold mode — see `setHoldMode`.
   *
   * Push-to-talk is the one interaction in this app that needs the duration of
   * a press rather than its completion: the microphone opens on the way down
   * and closes on the way up. Every other gesture here is a completed act,
   * which is why these are the only two edges in the vocabulary.
   */
  | { type: "holdStart" }
  | { type: "holdEnd" };

/**
 * Thresholds tuned for a gloved hand on a moving bus, NOT for a precise finger
 * on a desk. Every one of these is deliberately permissive: the cost of a
 * missed gesture (the user repeats it, annoyed) is far lower than the cost of a
 * demanded precision the user cannot deliver at all.
 */
export const THRESHOLDS = {
  /** Capacitive touch through a glove smears contact; short drags are noise. */
  swipeMinDistancePx: 60,
  /**
   * How much more the dominant axis must move than the other. 1.2 is lenient —
   * a gloved diagonal swipe still resolves rather than being rejected.
   */
  swipeAxisRatio: 1.2,
  /** Gloved swipes are slow. A generous ceiling avoids demanding a flick. */
  swipeMaxDurationMs: 1200,
  /** A tap that drifts this far is still a tap: gloves wobble. */
  tapMaxDriftPx: 40,
  tapMaxDurationMs: 400,
  /**
   * Gap between the two taps of a double-tap.
   *
   * 800 ms, not the ~300 ms Android uses. Measured double-taps in testing landed
   * at 471 ms without anyone trying to be slow, and that was a bare hand on a
   * responsive page — a gloved hand steadying against a moving bus is slower
   * again. The cost of being generous is only that two genuinely separate taps
   * within 0.8 s merge, which no part of this interface asks for.
   */
  doubleTapMaxGapMs: 800,
  /** Held this long without much movement is "where am I". */
  longPressMs: 600,
  longPressMaxDriftPx: 45,
  /** A list of 72 stops needs coarse movement, five at a time. */
  jumpSize: 5,
} as const;

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(b.x - a.x, b.y - a.y);

type Track = { id: number; start: Sample; last: Sample; maxDrift: number };

/**
 * Consumes touch samples, emits gestures.
 *
 * Deliberately a class with explicit state rather than a stream of callbacks:
 * a test can push a sloppy sequence in and assert exactly what came out.
 */
export class GestureRecognizer {
  private tracks = new Map<number, Track>();
  /** Peak simultaneous contacts in the current interaction — two-finger detection. */
  private peakTouches = 0;
  private lastTapAt: number | null = null;
  private lastTapPos: { x: number; y: number } | null = null;
  private longPressFired = false;
  private holdMode = false;
  /** Latched at holdStart so the release edge fires even if the mode changed. */
  private holdStarted = false;
  private emitted: Gesture[] = [];

  /** Time of the earliest active contact, for long-press timing. */
  private interactionStart: number | null = null;

  constructor(private thresholds = THRESHOLDS) {}

  /** Feed one event; returns any gestures it completed. */
  handle(event: RawEvent): Gesture[] {
    this.emitted = [];
    switch (event.phase) {
      case "start":
        this.onStart(event);
        break;
      case "move":
        this.onMove(event);
        break;
      case "end":
        this.onEnd(event);
        break;
    }
    return this.emitted;
  }

  /**
   * Called on a timer by the host, because a long press completes by the
   * ABSENCE of movement — no touch event will ever announce it.
   */
  tick(now: number): Gesture[] {
    this.emitted = [];
    if (
      !this.longPressFired &&
      this.interactionStart !== null &&
      this.tracks.size === 1 &&
      now - this.interactionStart >= this.thresholds.longPressMs
    ) {
      const track = [...this.tracks.values()][0];
      if (track.maxDrift <= this.thresholds.longPressMaxDriftPx) {
        this.longPressFired = true;
        if (this.holdMode) {
          this.holdStarted = true;
          this.emitted.push({ type: "holdStart" });
        } else {
          this.emitted.push({ type: "whereAmI" });
        }
      }
    }
    return this.emitted;
  }

  /**
   * Turn a long press into a hold rather than "where am I", for the duration of
   * a screen phase that is listening.
   *
   * A mode rather than a second gesture because the two meanings genuinely
   * conflict: both are "one finger, held still", and a user cannot be asked to
   * distinguish them. The screen knows which one it wants — during the question
   * "where are you going?" a held finger means speak, and at no other time.
   *
   * Turning the mode off mid-hold still emits `holdEnd` on release: a flag
   * change must never be able to leave the microphone open.
   */
  setHoldMode(on: boolean): void {
    this.holdMode = on;
  }

  reset(): void {
    this.tracks.clear();
    this.peakTouches = 0;
    this.interactionStart = null;
    this.longPressFired = false;
    this.holdStarted = false;
  }

  private onStart(event: RawEvent) {
    if (this.tracks.size === 0) {
      this.interactionStart = event.t;
      this.longPressFired = false;
      this.peakTouches = 0;
    }
    for (const touch of event.touches) {
      if (!this.tracks.has(touch.id)) {
        this.tracks.set(touch.id, { id: touch.id, start: touch, last: touch, maxDrift: 0 });
      }
    }
    this.peakTouches = Math.max(this.peakTouches, this.tracks.size);
  }

  private onMove(event: RawEvent) {
    for (const touch of event.touches) {
      const track = this.tracks.get(touch.id);
      if (!track) continue;
      track.last = touch;
      track.maxDrift = Math.max(track.maxDrift, distance(track.start, touch));
    }
    this.peakTouches = Math.max(this.peakTouches, this.tracks.size);
  }

  private onEnd(event: RawEvent) {
    for (const touch of event.touches) {
      const track = this.tracks.get(touch.id);
      if (track) track.last = touch;
    }

    const lifted = new Set(event.touches.map((t) => t.id));
    const remaining = [...this.tracks.keys()].filter((id) => !lifted.has(id));
    // Wait for the last finger before deciding — a two-finger gesture must not
    // be classified on the first release.
    if (remaining.length > 0) {
      for (const id of lifted) this.tracks.delete(id);
      return;
    }

    const tracks = [...this.tracks.values()];
    const fingers = this.peakTouches;
    const duration = event.t - (this.interactionStart ?? event.t);
    const wasLongPress = this.longPressFired;
    const wasHolding = this.holdStarted;

    this.tracks.clear();
    this.interactionStart = null;
    this.peakTouches = 0;
    this.longPressFired = false;
    this.holdStarted = false;

    // The release edge of push-to-talk. Emitted before the early return below,
    // because a hold that opened the microphone MUST close it — a lift that
    // produced no event would leave it live until the recognizer's own
    // timeout, recording a rider who believes they have stopped talking.
    if (wasHolding) {
      this.emitted.push({ type: "holdEnd" });
      return;
    }

    if (tracks.length === 0 || wasLongPress) return;

    // The dominant track decides direction; with two fingers they move together.
    const primary = tracks.reduce((a, b) => (b.maxDrift > a.maxDrift ? b : a));
    const dx = primary.last.x - primary.start.x;
    const dy = primary.last.y - primary.start.y;
    const travelled = Math.hypot(dx, dy);

    const isSwipe =
      travelled >= this.thresholds.swipeMinDistancePx &&
      duration <= this.thresholds.swipeMaxDurationMs;

    if (isSwipe) {
      const horizontal = Math.abs(dx) > Math.abs(dy) * this.thresholds.swipeAxisRatio;
      const vertical = Math.abs(dy) > Math.abs(dx) * this.thresholds.swipeAxisRatio;

      if (fingers >= 2) {
        // Coarse navigation. Horizontal two-finger swipes are unassigned rather
        // than aliased onto back — an accidental one must not leave the screen.
        if (vertical) this.emitted.push({ type: dy > 0 ? "jumpForward" : "jumpBack" });
        return;
      }
      if (vertical) {
        // Swipe DOWN moves to the next option, matching the way a list reads
        // downward. Up goes back toward the start.
        this.emitted.push({ type: dy > 0 ? "next" : "previous" });
        return;
      }
      if (horizontal && dx < 0) {
        this.emitted.push({ type: "back" });
        return;
      }
      // A rightward swipe is deliberately unassigned: nothing should happen by
      // accident, and "forward" has no meaning in a list navigated by ear.
      return;
    }

    // --- taps ---------------------------------------------------------
    const isTap =
      primary.maxDrift <= this.thresholds.tapMaxDriftPx &&
      duration <= this.thresholds.tapMaxDurationMs;
    if (!isTap) return;

    if (fingers >= 2) {
      this.emitted.push({ type: "repeat" });
      this.lastTapAt = null;
      return;
    }

    const at = { x: primary.last.x, y: primary.last.y };
    /**
     * Timing alone pairs the taps. NO position constraint.
     *
     * An earlier version required the two taps to land within a few hundred
     * pixels of each other, which quietly reintroduced exactly the requirement
     * this whole model exists to remove: a user who cannot see the screen has
     * no way to tap twice in the same place, and on a moving bus the second tap
     * can land anywhere. "Position never matters" has to mean never.
     */
    const isSecondTap =
      this.lastTapAt !== null && event.t - this.lastTapAt <= this.thresholds.doubleTapMaxGapMs;

    if (isSecondTap) {
      this.lastTapAt = null;
      this.lastTapPos = null;
      this.emitted.push({ type: "select" });
      return;
    }

    // A single tap alone does nothing. Activation requires a double-tap so a
    // hand steadying itself against a moving bus cannot select by accident.
    this.lastTapAt = event.t;
    this.lastTapPos = at;
  }
}

// ------------------------------------------------------------------ list

export type ListOption<T> = {
  value: T;
  /** Manifest keys announced when this option is landed on. */
  keys: string[];
  /** Human-readable, for the debug panel. Never spoken. */
  label: string;
};

export type CursorMove = {
  index: number;
  /** True when the move ran off an end and came back round. */
  wrapped: boolean;
};

/**
 * Moves a cursor through a list, wrapping.
 *
 * Wrapping is reported rather than hidden so the caller can play a boundary cue
 * — without one, a user cycling a 40-stop list has no way to tell a loop from
 * an endless list, and will keep swiping forever looking for an end.
 */
export function moveCursor(current: number, delta: number, length: number): CursorMove {
  if (length <= 0) return { index: 0, wrapped: false };
  const raw = current + delta;
  const index = ((raw % length) + length) % length;
  const wrapped = raw < 0 || raw >= length;
  return { index, wrapped };
}

/** Haptics. Distinct patterns so a gesture's effect is felt as well as heard. */
export const HAPTICS = {
  /** Every option change — short, so rapid scrolling does not become a buzz. */
  optionChange: [15] as number[],
  /** Selection is heavier and doubled, clearly different from a move. */
  select: [40, 60, 40] as number[],
  /** Hitting a list boundary, alongside the spoken cue. */
  boundary: [10, 40, 10] as number[],
  back: [25] as number[],
} as const;

export function vibrate(pattern: number[]): void {
  if (typeof navigator !== "undefined") navigator.vibrate?.(pattern);
}
