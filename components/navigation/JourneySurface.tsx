"use client";

/**
 * The journey screen. One layout, every state.
 *
 * ── WHY ONE COMPONENT ──────────────────────────────────────────────────────
 *
 * The three bus screens each built their own title, their own option list and
 * their own long-press handler. They looked like one app only by coincidence,
 * and they drifted — the same question got a different answer depending on which
 * screen the rider happened to be on. Everything visual now derives from
 * `present(journey)`, so "what does the app show right now" is a pure function
 * with tests rather than something you find out by holding a phone.
 *
 * ── THE HIERARCHY ──────────────────────────────────────────────────────────
 *
 *   TOP     where the rider is in the journey — step N of 6, in words.
 *   CENTRE  the single most important fact right now. One line, large.
 *   BOTTOM  the contextual actions, one primary, spoken in order.
 *
 * No cards. No dashboard. Nothing is on this screen that does not answer one of
 * "what is happening", "what matters now", "what do I do next" — which is the
 * whole of what a guide owes someone who cannot see it.
 *
 * ── THE ASSISTANT IS A SUB-LIST, NOT A SCREEN ──────────────────────────────
 *
 * `Асуух` swaps the option list for the questions answerable in this state and
 * swaps back on answer or on Back. It is deliberately not a route: a rider who
 * asked a question should land back exactly where they were, and a navigation
 * would put the journey screen through a remount to get there.
 */
import { useCallback, useMemo, useState } from "react";
import type React from "react";

import { CurrentOption, GestureSurface, type A11yOption } from "@/components/GestureSurface";
import type { AssistantEntry } from "@/lib/journey/assistant";
import type { MissingClipReport } from "@/lib/journey/audio-fallback";
import type { GuideQuestion } from "@/lib/journey/guide";
import type { Presentation } from "@/lib/journey/present";
import type { Journey } from "@/lib/journey/types";
import { useGestureNav } from "@/lib/ui/useGestureNav";
import type { ListOption } from "@/lib/ui/gesture-nav";

export type SurfaceEntry = { id: string; keys: string[]; label: string };
type Entry = SurfaceEntry;

/**
 * Props are the PIECES, not the hook.
 *
 * `/bus/board` gets them from `useJourney`. `/bus/ride` cannot: it owns an audio
 * pipeline with page-lifecycle and interruption instrumentation that took three
 * commits to get right, and handing it a second `AudioQueue` would mean two
 * queues talking over each other. So it drives the same pure journey modules
 * with its own plumbing and passes the results here. Both screens render
 * identically because both render `present()`.
 */
export function JourneySurface({
  journey,
  view,
  assistant,
  missingClips,
  log = [],
  onAsk,
  onRepeat,
  onAnnounceOption,
  onAction,
  onBack,
  onStart,
  extraActions = [],
  extraDebug,
}: {
  journey: Journey;
  view: Presentation;
  assistant: AssistantEntry[];
  missingClips?: MissingClipReport;
  log?: string[];
  onAsk: (question: GuideQuestion) => void;
  onRepeat: () => void;
  /** Speak an option as the rider scrolls onto it. */
  onAnnounceOption: (keys: string[], label: string) => void;
  /** Called with the id of an action the rider selected. */
  onAction: (id: string) => void;
  onBack: () => void;
  /** Runs inside the first touch — iOS will not start audio outside one. */
  onStart: () => void | Promise<void>;
  /**
   * Rows this screen adds beyond the journey's own — the manual stop advance,
   * the field-test controls. Appended AFTER, so the journey's primary action
   * stays first and stays the thing a rider hears without swiping.
   */
  extraActions?: SurfaceEntry[];
  extraDebug?: string;
}) {
  const [assistantOpen, setAssistantOpen] = useState(false);

  /**
   * Closing the assistant when the state moves under it.
   *
   * A journey does not wait for a rider to finish browsing questions — a bus
   * becomes due, a stop passes. Leaving a stale question list open would mean
   * the next selection answers a question about a journey that has moved on.
   */
  const stateKey = journey.state;
  const entries: Entry[] = useMemo(() => {
    if (assistantOpen) return assistant.map((a) => ({ id: a.id, keys: a.keys, label: a.label }));
    /**
     * A question state offers its answers and NOTHING else — not even the
     * screen's own extras. The journey is blocked on one of them, and a manual
     * stop advance sitting under "did you board" is a way to answer neither.
     */
    if (view.awaitingAnswer) return view.actions;
    return [...view.actions, ...extraActions];
  }, [assistant, assistantOpen, extraActions, view.actions, view.awaitingAnswer]);

  const select = useCallback((entry: Entry) => {
    if (!assistantOpen) {
      if (entry.id === "ask") {
        setAssistantOpen(true);
        return;
      }
      onAction(entry.id);
      return;
    }

    const chosen = assistant.find((a) => a.id === entry.id);
    setAssistantOpen(false);
    if (!chosen) return;

    switch (chosen.action.kind) {
      case "ask":
        onAsk(chosen.action.question);
        return;
      case "repeat":
        onRepeat();
        return;
      case "find_other_route":
        onAction("find_other");
        return;
      case "stop_guidance":
        onAction("stop_guidance");
        return;
    }
  }, [assistant, assistantOpen, onAction, onAsk, onRepeat]);

  const listOptions: ListOption<Entry>[] = useMemo(
    () => entries.map((e) => ({ value: e, keys: e.keys, label: e.label })),
    [entries],
  );

  const nav = useGestureNav<Entry>({
    options: listOptions,
    announce: (option) => onAnnounceOption(option.value.keys, option.value.label),
    onSelect: (o) => select(o.value),
    onBack: () => {
      // Back out of the assistant first. A rider who opened it and changed their
      // mind should not be thrown off the journey screen entirely.
      if (assistantOpen) { setAssistantOpen(false); return; }
      onBack();
    },
    onRepeat,
    // Long press is always the direct question, answered from the journey rather
    // than from whatever this screen happens to hold.
    onWhereAmI: () => onAsk("status"),
    enabled: entries.length > 0,
    // A new list starts at the top: opening the assistant, and every state
    // change, re-anchors the cursor.
    resetKey: `${stateKey}:${assistantOpen}`,
  });

  const a11yOptions: A11yOption[] = entries.map((e, i) => ({
    label: e.label,
    selected: i === nav.index,
    onActivate: () => { nav.setIndex(i); select(e); },
  }));

  const handlers = {
    ...nav.handlers,
    onTouchStart: (e: React.TouchEvent) => { void onStart(); nav.handlers.onTouchStart(e); },
  };

  return (
    <GestureSurface
      handlers={handlers}
      options={a11yOptions}
      onFocusOption={(i) => { void onStart(); nav.setIndex(i); }}
      heading={assistantOpen ? "Асуух" : view.headline}
    >
      {/*
        TOP — where the rider is. Rendered for screen readers as well as drawn:
        a progress indicator that exists only as dots is one half the intended
        audience cannot use. `aria-live` is deliberately absent; announcements go
        through the controlled audio element, because competing with VoiceOver
        for the DOM produces double-speaking.
      */}
      <p
        style={{ fontSize: 16, color: "#8a8a8a", margin: "0 0 14px", letterSpacing: 0.2 }}
        aria-label={`Аяллын явц: ${view.progress.label}`}
      >
        {view.progress.label}
      </p>

      {/* CENTRE — the one fact that matters now. */}
      <CurrentOption
        title={assistantOpen ? "Асуух" : view.headline}
        detail={assistantOpen ? undefined : (view.detail ?? undefined)}
        position={entries.length > 1 ? `${nav.index + 1} / ${entries.length}` : undefined}
      />

      {/*
        BOTTOM — the contextual actions, in the order they are spoken. Shown as
        text rather than as buttons: the whole viewport is the target, and the
        real focusable controls are the ones GestureSurface renders from
        `options` for VoiceOver and the keyboard.
      */}
      {entries.length > 0 && (
        <ul
          style={{
            listStyle: "none", padding: 0, margin: "28px 0 0",
            display: "flex", flexDirection: "column", gap: 10,
          }}
          aria-hidden="true"
        >
          {entries.map((e, i) => (
            <li
              key={e.id}
              style={{
                fontSize: i === nav.index ? 26 : 20,
                fontWeight: i === nav.index ? 700 : 400,
                color: i === nav.index ? "#fff" : "#7c7c7c",
                // Never colour alone: the selected entry is also the larger and
                // heavier one, and it is what the voice is reading.
                borderLeft: i === nav.index ? "4px solid #fff" : "4px solid transparent",
                paddingLeft: 12,
                lineHeight: 1.25,
              }}
            >
              {e.label}
            </li>
          ))}
        </ul>
      )}

      <details style={{ position: "absolute", bottom: 6, left: 6, fontSize: 11, color: "#333" }}>
        <summary>debug</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>
          {`state ${journey.state} (from ${journey.previousState ?? "—"})\n`}
          {`evidence ${journey.busDueSource ?? "—"} · missed ${journey.missedBuses}\n`}
          {`guidance ${journey.guidanceLevel} · heartbeat ${journey.heartbeatEnabled ? "on" : "off"}\n`}
          {missingClips && missingClips.total > 0
            ? `missing clips (${missingClips.total}): ${missingClips.keys.join(", ")}\n`
            : ""}
          {extraDebug ? `${extraDebug}\n` : ""}
          {log.join("\n")}
        </pre>
      </details>
    </GestureSurface>
  );
}
