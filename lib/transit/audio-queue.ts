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

export type Priority = "critical" | "normal" | "low";

/** Higher wins. Chosen so `critical` can never queue behind anything. */
const RANK: Record<Priority, number> = { critical: 2, normal: 1, low: 0 };

export type Announcement = {
  /** Manifest keys played back to back as one utterance. */
  keys: string[];
  priority: Priority;
  /**
   * Collapses repeats. A queued announcement with the same dedupeKey is
   * replaced rather than appended, so a GPS jitter storm cannot build a backlog
   * of stale positions that plays out minutes late.
   */
  dedupeKey?: string;
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
  | { type: "missing"; keys: string[]; announcement: Announcement };

export class AudioQueue {
  private queue: Announcement[] = [];
  private current: Announcement | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private listeners = new Set<(e: QueueEvent) => void>();

  constructor(private player: ClipPlayer) {}

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
    if (announcement.dedupeKey) {
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

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (this.queue.length > 0) {
        const announcement = this.queue.shift()!;
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
        for (const key of playable) {
          try {
            await this.player.play(key, controller.signal);
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
        if (!aborted) this.emit({ type: "end", announcement });
      }
    } finally {
      this.running = false;
    }
    // A critical push during the final await lands after the loop exits.
    if (this.queue.length > 0) void this.drain();
  }
}
