/**
 * Priority audio queue for the bus modes.
 *
 * Pure and injectable: no React, no DOM, no AudioContext. The queue owns
 * ordering and preemption; a `ClipPlayer` owns making noise. That split is what
 * lets the sequencing be tested against a synthetic GPS trace without a browser.
 *
 * Two rules the whole design exists to enforce:
 *
 *   1. NEVER two clips at once. Overlapping Mongolian speech is unintelligible,
 *      and a user who cannot see the screen has no way to recover the message.
 *   2. A CRITICAL announcement preempts whatever is playing. "Одоо буугаарай"
 *      arriving after the doors close is worse than a cut-off stop name.
 */

/**
 * Priority, as words rather than the spec's 0–3.
 *
 * The mapping is exact: `critical` is the spec's priority 0 — wrong bus,
 * overshoot, "Одоо буугаарай" — and preempts mid-clip. `normal` is 1–2 and
 * queues. `low` is 3. Kept as words because every call site in the app already
 * reads this way and a numeric scale where 0 is the MOST urgent inverts the
 * intuition of everyone who later edits one of them.
 */
export type Priority = "critical" | "normal" | "low";

/** Higher wins. Chosen so `critical` can never queue behind anything. */
const RANK: Record<Priority, number> = { critical: 2, normal: 1, low: 0 };

/**
 * The four earcons. Synthesized, never spoken — see lib/transit/earcons.ts.
 *
 * One per meaning, all under 400 ms, chosen to stay distinguishable through a
 * single earbud with traffic on the other side of it.
 */
export type EarconId = "soft" | "alert" | "urgent" | "error";

/**
 * How far the earcon leads the first word.
 *
 * A tone that lands on top of "Одоо" costs the rider the word that carries the
 * instruction, so the lead is a floor rather than an offset: speech waits for
 * the earcon to finish AND for this much to have elapsed since it started.
 * Earcons are all shorter than this, so in practice it is a clean 250 ms gap;
 * the max() only matters if someone lengthens one.
 */
export const EARCON_LEAD_MS = 250;

export type Announcement = {
  /** Manifest keys played back to back as one utterance. */
  keys: string[];
  priority: Priority;
  /**
   * ABSOLUTE INSTANT PAST WHICH THIS MUST BE DROPPED. Required, deliberately.
   *
   * Checked at dequeue, not at push — the whole point is the announcement that
   * was true when it was queued and is false by the time the queue reaches it.
   * A count queued behind a longer utterance plays after the bus has arrived,
   * and "хоёр буудал үлдлээ" spoken at the destination is worse than silence:
   * it actively tells a rider to stay seated as the doors open.
   *
   * There is no default and no optional marker, so every call site has to name
   * a lifetime for what it is about to say. That question is the feature.
   */
  expiresAt: number;
  /**
   * Collapses repeats. A queued announcement with the same dedupeKey is
   * replaced rather than appended, so a GPS jitter storm cannot build a backlog
   * of stale positions that plays out minutes late.
   */
  dedupeKey?: string;
  /**
   * Suppress an identical `dedupeKey` for this long AFTER it was last spoken.
   *
   * `dedupeKey` alone only collapses items still waiting in the queue. Once one
   * has been spoken the queue has no memory of it, so a state that flaps —
   * exactly what hysteresis exists to prevent and never fully does — says the
   * same sentence over and over. Requires `dedupeKey`; ignored without one.
   */
  cooldownMs?: number;
  /** Played before the words, leading them by EARCON_LEAD_MS. */
  earcon?: EarconId;
  /** `navigator.vibrate` pattern, fired with the earcon. */
  haptic?: number[];
  /** For logs and the on-screen debug panel — never spoken. */
  label?: string;
};

export interface ClipPlayer {
  /**
   * Plays one clip to completion. Must reject or resolve promptly when the
   * signal aborts — preemption depends on it.
   */
  play(key: string, signal: AbortSignal): Promise<void>;
  /** Whether the clip exists. A missing clip is reported, never silently skipped. */
  has(key: string): boolean;
}

export type QueueEvent =
  | { type: "start"; announcement: Announcement }
  | { type: "end"; announcement: Announcement }
  | { type: "preempted"; announcement: Announcement }
  | { type: "missing"; keys: string[]; announcement: Announcement }
  /** A clip never finished and was abandoned. Reported, never silent. */
  | { type: "stalled"; key: string }
  /**
   * Reached the front of the queue after it had stopped being true.
   *
   * Silent to the rider, loud to the debug panel: a stream of these means the
   * queue is running behind the world, which is a tuning problem worth seeing
   * rather than a fault worth speaking.
   */
  | { type: "expired"; announcement: Announcement }
  /** Same dedupeKey inside its cooldown. Dropped without a sound. */
  | { type: "suppressed"; announcement: Announcement };

/** Plays one earcon. Separate from ClipPlayer: these are synthesized, not files. */
export interface EarconPlayer {
  play(id: EarconId, signal: AbortSignal): Promise<void>;
}

export type AudioQueueOptions = {
  clipTimeoutMs?: number;
  /** Injected so expiry is driven by a test clock rather than waited for. */
  now?: () => number;
  earcons?: EarconPlayer;
  vibrate?: (pattern: number[]) => void;
  /** Resolves after `ms`; injected for the same reason as `now`. */
  wait?: (ms: number) => Promise<void>;
};

/**
 * Longest any single clip may hold the queue before it is abandoned.
 *
 * A `play()` that never settles deadlocks the drain loop, and every later
 * announcement — including the critical "Одоо буугаарай" — is then lost to
 * silence, which is precisely the failure this queue exists to prevent. It is
 * not hypothetical: an AudioContext that is suspended while the queue believes
 * it is running never fires `onended`, so the promise simply never resolves.
 * Observed exactly that way when the page was backgrounded.
 *
 * Well above the longest rendered phrase (~4 s), so it can only ever fire on a
 * genuine stall, never on a slow clip.
 */
export const CLIP_TIMEOUT_MS = 15_000;

export class AudioQueue {
  private queue: Announcement[] = [];
  private current: Announcement | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private listeners = new Set<(e: QueueEvent) => void>();

  /** When each dedupeKey was last SPOKEN, for `cooldownMs`. */
  private lastSpokenAt = new Map<string, number>();

  /**
   * Held while the microphone is open.
   *
   * Two microphone consumers is a solvable problem; the phone talking into its
   * own recording is not. Push-to-talk takes this lock, and the queue simply
   * stops draining — items keep expiring against the clock while it is held, so
   * a long utterance does not come back to a backlog of stale counts.
   */
  private micOpen = false;

  private readonly clipTimeoutMs: number;
  private readonly now: () => number;
  private readonly earcons: EarconPlayer | null;
  private readonly vibrate: (pattern: number[]) => void;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(
    private player: ClipPlayer,
    options: AudioQueueOptions | number = {},
  ) {
    // The second argument used to be a bare `clipTimeoutMs`. Accepted still, so
    // this stayed a widening change rather than a sweep of every construction.
    const o: AudioQueueOptions = typeof options === "number" ? { clipTimeoutMs: options } : options;
    this.clipTimeoutMs = o.clipTimeoutMs ?? CLIP_TIMEOUT_MS;
    this.now = o.now ?? (() => Date.now());
    this.earcons = o.earcons ?? null;
    this.vibrate = o.vibrate ?? (() => {});
    this.wait = o.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Open or close the microphone lock.
   *
   * Closing it resumes the drain, which will discard anything that expired
   * while the rider was speaking rather than answering a question they asked
   * ten seconds ago with a count from before it.
   */
  setMicOpen(open: boolean): void {
    this.micOpen = open;
    if (!open) void this.drain();
  }

  on(fn: (e: QueueEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: QueueEvent) {
    for (const fn of this.listeners) fn(e);
  }

  get isPlaying(): boolean {
    return this.current !== null;
  }

  get pending(): number {
    return this.queue.length;
  }

  /**
   * Enqueues, preempting the current utterance if this one outranks it.
   *
   * Equal priority does NOT preempt: two `normal` announcements should queue,
   * or a burst of position updates would each cut off the last and the user
   * would hear nothing but first syllables.
   */
  push(announcement: Announcement): void {
    const at = this.now();

    // Already stale on arrival — a fix that took too long to reach us, or a
    // caller stamping a lifetime shorter than its own latency.
    if (announcement.expiresAt <= at) {
      this.emit({ type: "expired", announcement });
      return;
    }

    if (announcement.dedupeKey) {
      const spokenAt = this.lastSpokenAt.get(announcement.dedupeKey);
      const cooldown = announcement.cooldownMs ?? 0;
      if (spokenAt !== undefined && cooldown > 0 && at - spokenAt < cooldown) {
        this.emit({ type: "suppressed", announcement });
        return;
      }
      const i = this.queue.findIndex((q) => q.dedupeKey === announcement.dedupeKey);
      if (i >= 0) this.queue.splice(i, 1);
    }

    this.queue.push(announcement);
    // Stable sort by rank, so equal priorities keep insertion order.
    this.queue.sort((a, b) => RANK[b.priority] - RANK[a.priority]);

    if (this.current && RANK[announcement.priority] > RANK[this.current.priority]) {
      this.emit({ type: "preempted", announcement: this.current });
      this.abort?.abort();
    }

    void this.drain();
  }

  /** Drops everything queued and stops what is playing. */
  clear(): void {
    this.queue = [];
    this.abort?.abort();
  }

  /**
   * Forget the cooldown history — a new journey, or a rider who asked again.
   *
   * Without this a status query answered five seconds ago is silently swallowed
   * when the rider asks a second time, which reads as the app ignoring them.
   */
  resetCooldowns(): void {
    this.lastSpokenAt.clear();
  }

  /**
   * `player.play`, but guaranteed to settle.
   *
   * Rejects rather than resolves on timeout, so the caller treats it exactly as
   * it treats a playback failure — stop this utterance rather than continue
   * into a half-spoken sentence — and the `stalled` event surfaces the gap
   * instead of it passing as silence.
   */
  private playWithTimeout(key: string, controller: AbortController): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.emit({ type: "stalled", key });
        // Abort so the player can stop the source it is still holding.
        controller.abort();
        reject(new Error(`clip stalled: ${key}`));
      }, this.clipTimeoutMs);

      this.player.play(key, controller.signal).then(
        () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } },
        (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
      );
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (this.queue.length > 0) {
        // Re-checked every iteration, not just on entry: the lock can be taken
        // while a long utterance is playing.
        if (this.micOpen) break;

        const announcement = this.queue.shift()!;

        /**
         * THE EXPIRY CHECK, AT THE FRONT OF THE QUEUE.
         *
         * Here rather than at push, because the interesting case is the
         * announcement that was true when it was queued and has since stopped
         * being true — queued behind a longer utterance, or behind the
         * microphone lock. Speaking "хоёр буудал үлдлээ" as the doors open at
         * the destination is not a stale nicety; it tells a rider to stay in
         * their seat.
         */
        if (announcement.expiresAt <= this.now()) {
          this.emit({ type: "expired", announcement });
          continue;
        }

        this.current = announcement;

        const missing = announcement.keys.filter((k) => !this.player.has(k));
        if (missing.length) {
          // A missing clip must never become silence. Silence reads to the user
          // as "nothing to report", which is the dangerous failure: it is
          // indistinguishable from "we have not arrived yet".
          this.emit({ type: "missing", keys: missing, announcement });
        }

        const playable = announcement.keys.filter((k) => this.player.has(k));
        if (playable.length === 0) {
          this.current = null;
          continue;
        }

        const controller = new AbortController();
        this.abort = controller;
        this.emit({ type: "start", announcement });

        let aborted = false;

        /**
         * Earcon and haptic together, then the words.
         *
         * The three channels carry the same state, so a rider with the phone in
         * a pocket feels what a rider with an earbud hears (§5, parallel
         * channels). Firing them at `start` rather than after the speech means
         * the alerting half still lands even if the utterance is preempted
         * half a syllable later.
         */
        if (announcement.haptic?.length) this.vibrate(announcement.haptic);

        if (announcement.earcon && this.earcons) {
          const startedAt = this.now();
          try {
            await this.earcons.play(announcement.earcon, controller.signal);
          } catch {
            // An earcon that will not play must never cost the words that
            // follow it. It is the redundant channel, not the message.
          }
          if (!controller.signal.aborted) {
            const elapsed = this.now() - startedAt;
            if (elapsed < EARCON_LEAD_MS) await this.wait(EARCON_LEAD_MS - elapsed);
          }
        }

        // Preempted during the lead-in — the tone was right, the words no
        // longer are.
        if (controller.signal.aborted) {
          this.abort = null;
          this.current = null;
          continue;
        }

        for (const key of playable) {
          try {
            // Raced against a watchdog: a clip that never settles must not take
            // the whole queue down with it. On timeout the source is aborted so
            // the player can release it, and the queue moves on.
            await this.playWithTimeout(key, controller);
          } catch {
            // Abort or playback failure — either way stop this utterance
            // rather than continuing into a half-spoken sentence.
            aborted = true;
            break;
          }
          if (controller.signal.aborted) {
            aborted = true;
            break;
          }
        }

        this.abort = null;
        this.current = null;
        if (!aborted) {
          // Only a COMPLETED utterance starts its cooldown. A preempted one was
          // not heard, and suppressing its repeat would lose it entirely.
          if (announcement.dedupeKey && announcement.cooldownMs) {
            this.lastSpokenAt.set(announcement.dedupeKey, this.now());
          }
          this.emit({ type: "end", announcement });
        }
      }
    } finally {
      this.running = false;
    }
    // A critical push during the final await lands after the loop exits.
    if (this.queue.length > 0 && !this.micOpen) void this.drain();
  }
}
