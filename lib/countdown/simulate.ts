/**
 * A whole journey, replayed through the real engine and the real ladder.
 *
 * THIS IS THE ONLY WAY THE FEATURE GETS TESTED BEFORE A BUS.
 *
 * Everything in the countdown path is pure — engine, geometry, ladder, queue —
 * precisely so a recorded or synthetic GPS trace can be pushed through all of it
 * in milliseconds and the exact sequence of announcements captured. A bug that
 * only shows up as "it said two stops twice, somewhere near Sansar, once" is
 * otherwise unreproducible: you cannot re-run a bus.
 *
 * What comes out is a TRANSCRIPT — an ordered list of what the rider would have
 * heard, with the state that caused each line. Tests assert the whole sequence
 * rather than individual calls, because the failures that matter here are
 * sequence failures: a duplicate, a rung skipped, a stale line arriving after
 * arrival. None of those are visible one announcement at a time.
 */

import type { Announcement } from "../transit/audio-queue";
import {
  createEngine, isDowngrade, onFix, onTick, remainingTo,
  type EngineEvent, type EngineState, type Fix,
} from "./engine";
import { StopChainGeometry, type GeometryStop } from "./geometry";
import { alightingAnnouncement, confidenceLost } from "./ladder";

export type TranscriptLine = {
  /** ms since the first fix — readable in a diff, unlike an epoch. */
  atMs: number;
  /** Clip keys, in order. What the rider actually hears. */
  keys: string[];
  earcon?: string;
  haptic?: number[];
  priority: Announcement["priority"];
  /** Engine state at the moment it was said, for diagnosing a bad line. */
  stopIndex: number;
  remaining: number;
  confidence: string;
  label: string;
};

export type SimulationResult = {
  transcript: TranscriptLine[];
  events: EngineEvent[];
  finalState: EngineState;
};

export type SimulateOptions = {
  chain: GeometryStop[];
  fixes: Fix[];
  /** Index in `chain` the rider is getting off at. */
  destinationIndex: number;
  startIndex?: number;
  /** Defaults to every clip existing — a render gap is a different test. */
  hasClip?: (key: string) => boolean;
  /**
   * Wall-clock ticks between fixes, for the staleness path.
   *
   * Without these a dropout is invisible to `onTick`, and the whole point of a
   * dropout scenario is that the register degrades while no fix arrives.
   */
  tickEveryMs?: number;
};

/**
 * Replay a trace and return everything the rider would have heard.
 *
 * The queue is deliberately NOT in the loop. Its ordering and expiry have their
 * own tests; putting it here would mean a ladder bug and a queue bug produce the
 * same failing transcript, and the point of this harness is to say which.
 */
export function simulateJourney(options: SimulateOptions): SimulationResult {
  const {
    chain, fixes, destinationIndex, startIndex = 0,
    hasClip = () => true, tickEveryMs = 10_000,
  } = options;

  const geometry = new StopChainGeometry(chain);
  const destination = chain[destinationIndex];
  let state = createEngine(startIndex, geometry);

  const transcript: TranscriptLine[] = [];
  const events: EngineEvent[] = [];
  const t0 = fixes.length ? fixes[0].timestamp : 0;

  /** The count at the last thing we SAID, not at the last fix. See the ladder. */
  let lastSpokenRemaining: number | null = null;
  let downgradeAnnounced = false;
  let nextTickAt = t0 + tickEveryMs;

  const record = (announcement: Announcement | null, now: number) => {
    if (!announcement) return;
    transcript.push({
      atMs: now - t0,
      keys: announcement.keys,
      earcon: announcement.earcon,
      haptic: announcement.haptic,
      priority: announcement.priority,
      stopIndex: state.stopIndex,
      remaining: remainingTo(state, destinationIndex),
      confidence: state.confidence,
      label: announcement.label ?? "",
    });
  };

  const speakLadder = (now: number) => {
    const remaining = remainingTo(state, destinationIndex);
    const announcement = alightingAnnouncement(
      { remaining, confidence: state.confidence, destination, now },
      lastSpokenRemaining,
      hasClip,
    );
    if (announcement) {
      record(announcement, now);
      lastSpokenRemaining = remaining;
    }
  };

  for (const fix of fixes) {
    // Ticks between fixes, so a dropout degrades the register instead of the
    // count simply freezing with nothing said.
    while (nextTickAt < fix.timestamp) {
      const before = state.confidence;
      const ticked = onTick(state, nextTickAt);
      state = ticked.state;
      events.push(...ticked.events);
      if (isDowngrade(before, state.confidence) && state.confidence === "none" && !downgradeAnnounced) {
        downgradeAnnounced = true;
        record(confidenceLost(nextTickAt), nextTickAt);
      }
      nextTickAt += tickEveryMs;
    }

    const before = state.confidence;
    const result = onFix(state, fix, geometry, fix.timestamp);
    state = result.state;
    events.push(...result.events);

    // Recovered: a later loss is worth announcing again.
    if (!isDowngrade(before, state.confidence) && state.confidence !== "none") {
      downgradeAnnounced = false;
    }

    speakLadder(fix.timestamp);
    if (fix.timestamp >= nextTickAt) nextTickAt = fix.timestamp + tickEveryMs;
  }

  return { transcript, events, finalState: state };
}

/**
 * The transcript as lines of text, for a golden file or a failure message.
 *
 * Deliberately terse and stable: a diff of two of these should read like a diff
 * of what the rider heard, not like a diff of a data structure.
 */
export function formatTranscript(transcript: TranscriptLine[]): string[] {
  return transcript.map((l) => {
    const earcon = l.earcon ? `earcon:${l.earcon} ` : "";
    return `remaining=${l.remaining} ${earcon}${l.keys.join(" ")}`;
  });
}
