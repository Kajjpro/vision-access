"use client";

/**
 * Guidance level, and whether the activity signal fires at all.
 *
 * ── WHY THESE TWO AND NOTHING ELSE ─────────────────────────────────────────
 *
 * NOTES.md has volume and detector sensitivity queued for this screen. They are
 * not here, because both need machinery that does not exist yet — a gain node
 * every clip routes through, and a worker message to change a module constant at
 * runtime. Shipping a settings screen with two working controls beats shipping
 * one with four, two of which quietly do nothing.
 *
 * ── HOW IT BEHAVES ─────────────────────────────────────────────────────────
 *
 * Selecting a level applies AND SPEAKS IT IMMEDIATELY. A settings screen that
 * saves silently is unusable to the person it is for: the only confirmation a
 * blind rider gets that a control did anything is hearing it happen. The written
 * value is read back by `loadSettings` on the next journey, and by `useJourney`
 * on the next audio start.
 *
 * Every option is a real focusable element via `GestureSurface`, so VoiceOver's
 * own swipe-and-double-tap works here unmodified.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CurrentOption, GestureSurface, type A11yOption } from "@/components/GestureSurface";
import { hasClip, loadClips, playSequence, audioContext } from "@/lib/audio";
import {
  DEFAULT_SETTINGS, GUIDANCE_LEVELS, loadSettings, saveSettings, type GuidanceSettings,
} from "@/lib/journey/settings";
import type { GuidanceLevel } from "@/lib/journey/types";
import { SETTINGS } from "@/lib/ui/announcements";
import { useGestureNav } from "@/lib/ui/useGestureNav";
import type { ListOption } from "@/lib/ui/gesture-nav";

type Entry = {
  id: string;
  keys: string[];
  label: string;
  /** What this row currently reads as, spoken after the name. */
  active: boolean;
  apply: (current: GuidanceSettings) => GuidanceSettings;
};

const LEVEL_PHRASE: Record<GuidanceLevel, { clip: string | null; mn: string }> = {
  minimal: SETTINGS.minimal,
  standard: SETTINGS.standard,
  detailed: SETTINGS.detailed,
};

/** Loaded before anything is spoken here, so the first selection is not silent. */
const FIRST_CLIPS = [
  SETTINGS.guidanceLevel.clip!, SETTINGS.minimal.clip!, SETTINGS.standard.clip!,
  SETTINGS.detailed.clip!, SETTINGS.heartbeatOn.clip!, SETTINGS.heartbeatOff.clip!,
  SETTINGS.saved.clip!,
];

export function SettingsScreen() {
  const router = useRouter();
  const [settings, setSettings] = useState<GuidanceSettings>(DEFAULT_SETTINGS);
  const startedRef = useRef(false);

  const say = useCallback((keys: (string | null)[]) => {
    const playable = keys.filter((k): k is string => k !== null && hasClip(k));
    if (playable.length) playSequence(playable, { interrupt: true });
  }, []);

  /**
   * Audio unlocks on the first touch, as iOS requires, and the STORED settings
   * are read at the same moment — localStorage does not exist during SSR, and
   * this is the first instant the screen is certainly in a browser.
   */
  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    audioContext();
    setSettings(loadSettings());
    await loadClips(FIRST_CLIPS);
    void loadClips().catch(() => {});
  }, []);

  const commit = useCallback((next: GuidanceSettings, spoken: (string | null)[]) => {
    setSettings(next);
    saveSettings(next);
    // Spoken, not just saved. Hearing it happen is the only confirmation the
    // person this screen exists for is going to get.
    say([...spoken, SETTINGS.saved.clip]);
  }, [say]);

  const entries: Entry[] = useMemo(() => {
    const levels: Entry[] = GUIDANCE_LEVELS.map((level) => ({
      id: `level:${level}`,
      keys: [LEVEL_PHRASE[level].clip!],
      label: LEVEL_PHRASE[level].mn,
      active: settings.level === level,
      apply: (current) => ({ ...current, level }),
    }));

    // One row, whose LABEL is the action it performs — "turn the signal off"
    // when it is on. A row reading "activity signal" with a hidden on/off state
    // is unreadable by ear: the rider would have to select it to find out what
    // it was going to do.
    const heartbeat: Entry = settings.heartbeat
      ? {
          id: "heartbeat:off",
          keys: [SETTINGS.heartbeatOff.clip!],
          label: SETTINGS.heartbeatOff.mn,
          active: false,
          apply: (current) => ({ ...current, heartbeat: false }),
        }
      : {
          id: "heartbeat:on",
          keys: [SETTINGS.heartbeatOn.clip!],
          label: SETTINGS.heartbeatOn.mn,
          active: false,
          apply: (current) => ({ ...current, heartbeat: true }),
        };

    return [...levels, heartbeat];
  }, [settings]);

  const listOptions: ListOption<Entry>[] = useMemo(
    () => entries.map((e) => ({ value: e, keys: e.keys, label: e.label })),
    [entries],
  );

  const nav = useGestureNav<Entry>({
    options: listOptions,
    announce: (option) => say(option.value.keys),
    onSelect: (o) => commit(o.value.apply(settings), o.value.keys),
    onBack: () => router.push("/"),
    onRepeat: () => say(nav.current ? nav.current.value.keys : [SETTINGS.guidanceLevel.clip]),
    onWhereAmI: () => say([
      SETTINGS.guidanceLevel.clip,
      LEVEL_PHRASE[settings.level].clip,
      settings.heartbeat ? SETTINGS.heartbeatOn.clip : SETTINGS.heartbeatOff.clip,
    ]),
    enabled: true,
  });

  const a11yOptions: A11yOption[] = entries.map((e, i) => ({
    // The screen reader hears which one is in force, because "active" is not a
    // visual property it can see.
    label: e.active ? `${e.label} — сонгосон` : e.label,
    selected: i === nav.index,
    onActivate: () => { nav.setIndex(i); commit(e.apply(settings), e.keys); },
  }));

  const handlers = {
    ...nav.handlers,
    onTouchStart: (e: React.TouchEvent) => { void start(); nav.handlers.onTouchStart(e); },
  };

  return (
    <GestureSurface
      handlers={handlers}
      options={a11yOptions}
      onFocusOption={(i) => { void start(); nav.setIndex(i); }}
    >
      <p style={{ fontSize: 16, color: "#8a8a8a", margin: "0 0 14px" }}>
        {SETTINGS.guidanceLevel.mn}
      </p>

      <CurrentOption
        title={nav.current?.value.label ?? SETTINGS.guidanceLevel.mn}
        detail={LEVEL_PHRASE[settings.level].mn}
        position={`${nav.index + 1} / ${entries.length}`}
      />

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
              borderLeft: i === nav.index ? "4px solid #fff" : "4px solid transparent",
              paddingLeft: 12,
            }}
          >
            {/* Never colour alone: the chosen level is marked in text too. */}
            {e.active ? `${e.label} ✓` : e.label}
          </li>
        ))}
      </ul>
    </GestureSurface>
  );
}
