# Voice input — NOT built, feasibility unverified

## Status: unverified, and therefore not implemented

The brief was explicit that voice input must not be designed around until
`mn-MN` support is verified in Chrome on Android. It has **not** been verified,
so nothing in the app depends on it. Gestures are the whole interface.

## What was tested, and why it was inconclusive

Desktop Chrome on macOS, via the automation harness:

| language | outcome | events |
|---|---|---|
| `en-US` (control) | timeout after 6 s | none |
| `mn-MN` | timeout after 6 s | none |

Microphone permission was stuck at `prompt` — the automation cannot grant it —
so **neither** language produced a single event. The control failing identically
to the test means the apparatus was blocked, not that Mongolian is unsupported.
Reporting "mn-MN doesn't work" from this would have been wrong.

Two further reasons this environment cannot answer the question:

- Desktop Chrome and Chrome on Android use different speech backends, so a
  desktop result would not transfer even if it had worked.
- Chrome's `SpeechRecognition` is server-side. It needs a network, which
  conflicts with the offline requirement regardless of language support.

## How to get the real answer

`public/voice-test.html` is a standalone page for the target device:

1. Open `http://<dev-host>:3000/voice-test.html` in Chrome on the Android phone.
2. Press **Test en-US** first. If the control fails, the phone or network is the
   problem, not the language.
3. Press **Test mn-MN** and say a place name such as `Сансар`.

Read the `RESULT:` line:

- `language-not-supported` → mn-MN is unsupported. Stop here; do not reach for a
  paid ASR service, which would break the no-runtime-API constraint. Gestures
  already solve the problem.
- `WORKS` with a transcript → supported, and the constraints below apply.

## If it turns out to work

Voice is an optional layer and never the only path. The strings are already
written in `lib/ui/announcements.ts` under `VOICE`.

- **Wait screen only.** Never while riding: a moving bus is too loud for
  reliable recognition, and that is exactly when a mistake strands someone.
- **Explicit activation** by two-finger long press. Never always-listening —
  that is a privacy problem and a battery problem.
- **Always confirm before acting.** "Сансар руу явах уу?" then wait for a
  double-tap. A misrecognised destination puts someone off in the wrong place,
  so an unconfirmed recognition must never cause an action.
- **Gestures stay fully sufficient** with voice disabled or unavailable.
- Requires a network, so it must degrade to gestures silently and announce
  `VOICE.unavailable` when it cannot run.
