"use client";

/**
 * Asking for the microphone, out loud, at a moment we choose.
 *
 * THE BROWSER'S PERMISSION DIALOG IS A VISUAL, UNLABELLED OBJECT. A screen
 * reader may announce it as little as "Allow"; VoiceOver users get a dialog
 * with no context about what is asking or why. So the app says what is about
 * to happen BEFORE the dialog appears, and says what happened after it closes
 * — otherwise the rider is left holding a phone that has silently changed
 * state.
 *
 * ASKED IN ONBOARDING, NEVER MID-JOURNEY. Standing at a stop with a bus coming
 * is the worst possible moment to meet an unexplained dialog, and a refusal
 * there costs the trip. Asked once, early, when nothing is at stake, and
 * remembered so the rider is never asked twice.
 *
 * ── WHY THIS IS TWO STEPS AND NOT ONE ──────────────────────────────────────
 *
 * It used to be one call: speak the explanation, await it, then ask. On iOS
 * that await is fatal. WebKit shows the microphone prompt only while the page
 * holds a user activation — the synchronous run of a touch handler — and an
 * awaited clip has already spent it. The request was therefore never put to the
 * rider at all; it came back refused, the app announced "voice input is
 * unavailable, use the list instead" during the welcome, and marked the
 * question as asked so it would never be raised again. An iOS user was told at
 * startup that the feature was gone, on a device where it works.
 *
 * So: `armMicrophonePrompt` explains, and the dialog opens on the NEXT touch,
 * through `primeArmedMicrophone`. The rider hears why before they are asked,
 * which was the point of the original ordering, and iOS gets the activation it
 * requires.
 */

import { primeMicrophonePermission } from "@/lib/speech/recognizer";
import { VOICE, VOICE_JOURNEY } from "@/lib/ui/announcements";

const ASKED_KEY = "vision-access:mic-asked";

export type MicPrimeResult = "granted" | "denied" | "unknown" | "already-asked";

type Speak = (clips: (string | null | undefined)[]) => void;

function alreadyAsked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === "1";
  } catch {
    return false; // private mode: ask again rather than assume a refusal
  }
}

function markAsked(): void {
  try {
    localStorage.setItem(ASKED_KEY, "1");
  } catch {
    /* private mode — harmless, we simply ask again next session */
  }
}

/** Armed by step one, consumed by step two. */
let armed: Speak | null = null;

/**
 * Step one: explain, at the calmest moment there is.
 *
 * Returns true when a prompt is now waiting on the next touch. Returns false —
 * and says nothing — when the rider has been asked before, or when this browser
 * has no microphone API to ask about.
 */
export function armMicrophonePrompt({ speak }: { speak: Speak; }): boolean {
  if (armed) return true;
  if (alreadyAsked()) return false;
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return false;

  speak([VOICE_JOURNEY.holdToSpeak.clip]);
  armed = speak;
  return true;
}

/**
 * Step two: open the dialog. CALL THIS SYNCHRONOUSLY FROM A TOUCH HANDLER.
 *
 * A no-op unless `armMicrophonePrompt` armed it, so it is safe to call from
 * every touch. Nothing is awaited before the permission request itself — an
 * await here would spend the activation and put us back where we started.
 */
export function primeArmedMicrophone(): Promise<MicPrimeResult> {
  const speak = armed;
  if (!speak) return Promise.resolve("already-asked");
  armed = null;

  // Marked before the answer arrives: a rider who dismisses the dialog must not
  // meet it again on the next touch.
  markAsked();

  return primeMicrophonePermission().then((outcome) => {
    // Say what happened either way. A granted permission that is never confirmed
    // leaves the rider unsure whether to expect voice to work at all.
    speak([
      outcome === "granted"
        ? VOICE.listening.clip
        : outcome === "denied"
          ? VOICE_JOURNEY.micDenied.clip
          : VOICE.unavailable.clip,
      outcome === "granted" ? null : VOICE_JOURNEY.useListInstead.clip,
    ]);
    return outcome;
  });
}

/** True while an explanation has been spoken and the dialog is still owed. */
export function microphonePromptArmed(): boolean {
  return armed !== null;
}

/** For a settings screen or a debug gesture: ask again next time. */
export function forgetMicrophonePrompt(): void {
  armed = null;
  try {
    localStorage.removeItem(ASKED_KEY);
  } catch {
    /* ignore */
  }
}
