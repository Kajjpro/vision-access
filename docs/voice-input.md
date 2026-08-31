# Voice input

## Status, 2026-08-13: built on Azure. Web Speech still unverified.

There are **two** recognition paths in this repo and they are at different
stages. Conflating them is what made this document read as "voice does not
work" long after half of it did.

| path | screen | engine | state |
|---|---|---|---|
| `lib/ui/voice.ts` | wait screen | Web Speech only | unverified, unwired |
| `lib/speech/recognizer.ts` | journey screen | Azure REST, via `/api/stt` | **working** |

**`mn-MN` speech-to-text is real and it is good enough.** Verified against the
live subscription rather than a support table:

- `GET {region}.api.cognitive.microsoft.com/speechtotext/v3.2/transcriptions/locales`
  lists 150 locales for `southeastasia`, `mn-MN` among them. TTS and STT are
  separate lists, so owning `mn-MN-YesuiNeural` had never proved this.
- 40 real names from `public/transit/stops.json`, spoken by a *different* voice
  than the app renders with, round-tripped through `/api/stt` and resolved with
  the app's own matcher: **95%** land on the right stop (92.5% reading only the
  top transcript). Re-run it with `npx tsx scripts/stt-accuracy.ts`.

That number is a **clean-room upper bound** and should be quoted as one. It has
no traffic, no wind, no cheap phone microphone, no accent and no hurry in it.
It says the language is supported and the matcher is sane — both genuinely
unknown before — and it says nothing about a rider at a stop on Peace Avenue.
Only recordings of real riders can settle that. Until they exist, the
confirmation read-back is the thing standing between a misrecognition and
someone stranded in the wrong district, and it stays mandatory.

Of the two names in that sample that did not resolve, neither is a wrong
answer the rider would be given: `1-р байр` names two stops 10 km apart, and
the app **asks** "Аль нь вэ?" rather than choosing. The other is `MSM`, a
Latin-named stop that a Mongolian voice reads as a near-homophone of `МҮИС`
3.5 km away — separated in practice by the GPS bias on the origin.

**Gestures remain the whole interface.** Voice is an optional layer on top and
never the only path; see the section at the end, which is unchanged and still
holds.

### Why this looked completely broken

The recognizer was never the problem. Two things were:

1. **The flow was mute.** 13 of the 21 phrases the journey screen speaks had no
   playable clip — including `askOrigin`, the first question, and every
   fragment of the confirmation read-back. A clip id has to be given a name in
   `lib/ui/announcements.ts`, be rendered to disk, *and* be registered in
   `lib/phrases.ts` for `loadClips()` to fetch it; only the first two were
   done, so files sat on disk that nothing ever loaded. To someone who cannot
   see the screen, that is an app that does nothing at all.
   `lib/speech/announcements.test.ts` now fails the build on any gap.
2. **The fallback threw the sentence away.** Web Speech ran first and Azure
   only after it failed — but Web Speech signals an unsupported language by
   ending *silently*, and only once the button is released. So the Azure
   "fallback" opened the microphone after the rider had finished speaking,
   recorded ten seconds of the street, and uploaded that. On Chrome for
   Android, whose recognizer does not list `mn-MN`, that was every attempt.
   Capture is now unconditional and Web Speech, when enabled at all, races
   alongside it: it can win, it can never lose the audio.

### Why it worked on Android and did nothing on iOS

Reported from a phone: on Android a rider can speak a stop name; on iOS the same
build does nothing at all. Neither platform logs anything, and there is no
console on a phone to read it from if it did. Two WebKit rules, both invisible
from a desktop Chrome test:

1. **The audio session forbade capture.** `lib/audio.ts` declared
   `navigator.audioSession.type = "playback"` before constructing the
   AudioContext — which is correct, and is what makes obstacle warnings audible
   with the ringer switch off. It also maps to iOS's playback audio category,
   under which the microphone **cannot open at all**. Android has no session
   concept, so the same line was a no-op there. The type is now `playback` while
   the app is only talking and `play-and-record` for exactly as long as a
   capture is open, refcounted in `beginCaptureSession` / `endCaptureSession`.

2. **The permission prompt was never shown.** WebKit opens the microphone dialog
   only while the page holds a *user activation* — the synchronous run of a
   touch handler. Both voice paths called `getUserMedia` after that had been
   spent:

   | screen | what ran first | why the activation was gone |
   |---|---|---|
   | `/bus/wait` | `await sayAndWait([VOICE.prompt])` | a promise continuation |
   | `/bus/journey` | 600 ms long-press timer → `holdStart` | a timer callback |
   | home onboarding | `await sleep(welcome)` then prime | a timer callback |

   The dialog was therefore never put to the rider, so permission was never
   granted, so the next attempt was not shown either — a failure that never
   repairs itself. Worse, the onboarding prime read the silent refusal as a
   denial and announced *"Дуу хоолойгоор оруулах боломжгүй байна, жагсаалтаас
   сонгоно уу"* during the welcome: an iOS rider was told at startup that voice
   was unavailable on a device where it works.

   `lib/speech/mic.ts` fixes the ordering rather than the call site.
   `warmMicrophone()` runs **in the touch handler** and starts opening the
   microphone there; the recogniser calls `acquireMicrophone()` later — after the
   prompt clip, or 600 ms into a hold — and gets the stream that is already open.
   A warm stream nobody claims closes itself after `WARM_TTL_MS`, so push-to-talk
   still means the microphone is live only while the rider intends it. The
   onboarding prime became two steps for the same reason: `armMicrophonePrompt`
   explains at the calm moment, `primeArmedMicrophone` opens the dialog on the
   next touch.

Two smaller iOS-only faults were fixed alongside them: `decodeAudioData` for the
uploaded recording now runs on an `OfflineAudioContext` rather than a fresh
`AudioContext` per utterance — iOS allows only a handful of those and
constructing one can interrupt the context every warning plays through — and
`MediaRecorder` is constructed without a `mimeType` option when
`pickRecordingMimeType()` finds nothing, instead of being handed `""`, which the
constructor treats as an unsupported type and throws on.

### Why Web Speech is off by default

It is not merely unproven — enabling it costs something. It needs a second
microphone capture running next to the one that works, and what that does on a
cheap Android is exactly what cannot be tested from here. An unproven
optimisation risking the proven path, switched on by default and hoped about,
is how the old chain came to lose every utterance.

So it is opt-in per device, via `setWebSpeechProven(true)` after
`public/voice-test.html` produces a transcript on that phone. When on, it is
purely additive: it may answer faster and for free, its errors are never shown
to the rider, and the recording happens regardless.

## Web Speech: what was tested, and why it was inconclusive

Everything below concerns **engine 1 only** — Chrome's built-in
`SpeechRecognition`, used by `lib/ui/voice.ts`. None of it bears on the Azure
path above, which is measured and working.

Desktop Chrome on macOS, via the automation harness. Run twice, months apart,
with the same result both times:

| language | outcome | events |
|---|---|---|
| `en-US` (control) | timeout after 6–7 s | none |
| `mn-MN` | timeout after 6–7 s | none |

Microphone permission was stuck at `prompt` — the automation cannot grant it —
so **neither** language produced a single event: no `start`, no `audiostart`,
no `error`. The control failing identically to the test means the apparatus was
blocked, not that Mongolian is unsupported. Reporting "mn-MN doesn't work" from
this would have been wrong.

Re-verified 2026-08-10 against the running app. `SpeechRecognition` **exists**
(`hasSR=true`), the page is a secure context, and the network is up — so the
API surface is present and the only missing piece is a granted microphone,
which no amount of automation can supply. CDP-synthesised clicks do not even
count as user activation (`navigator.userActivation.hasBeenActive === false`),
so the permission prompt cannot be driven from here at all.

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

Then read two more lines, because the app's accuracy now rests on them:

- `ALTERNATIVES: n` — how many spellings the engine returns for a Mongolian
  place name. Searching them all is the single biggest accuracy win available
  here, and it is worth exactly nothing if `n` is 1. **Unverified.**
- `TIMING:` — `start→audiostart` is how long the microphone takes to open on
  this phone, which is the delay the "speak now" earcon exists to cover. If it
  is anywhere near `READY_TIMEOUT_MS`, that budget is wrong for this hardware.

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

## How the recogniser is driven

Unverified language support is not a reason to drive the API badly. These are
properties of `lib/ui/voice.ts` and hold whether or not `mn-MN` turns out to
work.

**The recogniser is injected, so all of this is tested.** `listenOnce({ create })`
takes a factory, exactly as `lib/transit/locate.ts` takes a geolocation object.
This file's header used to state that the recognition half could not be tested
here; that was a statement about reaching for `window.SpeechRecognition`, not
about the problem. A microphone that never opens, a user who hesitates, an
engine that returns three spellings, and a refused permission all now replay
deterministically in `lib/ui/voice.test.ts`.

**The timeout is phased, not one wall clock.** The old version gave the whole
interaction 8 s from `start()`, covering the permission prompt, the microphone
opening, the user deciding what to say, and saying it — so someone who paused
three seconds had three left to speak and was cut off mid-name. Each phase now
has its own budget and its own outcome:

| phase | budget | failure |
|---|---|---|
| `start()` → microphone live | `READY_TIMEOUT_MS` 5 s | `no-mic`, terminal |
| microphone live → speech starts | `START_TIMEOUT_MS` 6 s | `no-speech`, retryable |
| speech starts → engine responds | `SPEECH_TIMEOUT_MS` 8 s | `timeout` |
| speech ends → transcript lands | `RESULT_TIMEOUT_MS` 5 s | `timeout` |

`no-mic` is worth distinguishing because the remedy differs: an unanswered
permission prompt is not fixed by asking someone to repeat themselves, and the
screen says `VOICE.unavailable` rather than "no stop by that name" — which was
the old blanket response to every failure, and sent people off rehearsing a name
that was never the problem.

**The microphone announces itself.** Every other voice UI shows a waveform or a
pulsing dot; none of that helps here. `start()` returning does not mean the
microphone is open, and on a cheap Android the gap is long enough to swallow a
word — so the "speak now" earcon fires on the engine's own `audiostart`, and a
second, falling cue confirms that speech was heard. These are quiet sine pairs
(`playListenCue`), deliberately **not** `playTone`: that one is an 880 Hz square
wave meaning an unmeasurable obstacle, and teaching a blind user that the danger
sound sometimes means "microphone ready" is the one confusion this app cannot
afford.

**The prompt is waited out exactly.** `say()` returns the scheduled duration, so
the microphone opens when the clip actually ends rather than after a fixed
2200 ms guess at it. Guessing short means the engine transcribes our own
question; guessing long means dead air the user talks into.

**One retry.** A single hesitation used to drop the user back to a list of a
hundred destinations. `listen()` retries once on `no-speech`/`no-match` only —
never on a refused microphone or an unsupported language, which fail identically
forever — and `beforeRetry` is awaited so the microphone is provably shut while
the phone says "Ойлгосонгүй, дахин оролдоно уу".

### Every alternative is searched, not just the first

`listenOnce()` has always asked for alternatives and, until now, read only
the first. It now asks for `MAX_ALTERNATIVES` (6, up from 3): the engine has
already ranked them server-side, so the extra ones cost nothing.

The engine is transcribing a proper noun that is not in its language
model, so its ranking between near-homophones is close to arbitrary — but only
one of them is a real stop name, and `stops.json` knows which. `searchStopsAny()`
scores them all and keeps the best *match* rather than the best *transcript*:
`сан сар` matches nothing on its own, and used to end the journey there while
`Сансар` sat unread in alternative 2.

Two rules keep this from becoming a licence to guess:

- A lower alternative pays `ALTERNATIVE_PENALTY` per place, applied before the
  `MIN_SCORE` cut, so searching six transcripts does not give noise six
  independent chances to clear the bar.
- With everything else tied, the recogniser's own order wins. It is weak
  evidence, not no evidence.

The read-back is unchanged and still mandatory — this widens what can be found,
never what can be acted on unconfirmed. When the winning transcript is not the
one heard first, the debug overlay shows both; a read-back of a name the user
did not say is otherwise inexplicable to whoever is helping them.

## Gestures are sufficient today — verified, not assumed

This was a real gap until 2026-08-10. The wait screen offered "say where you
are going" plus the user's travel history, and a first-time user has no
history — so with recognition unavailable the destination list held exactly one
option, the one that does not work. There was no way to choose a destination by
gesture at all.

Fixed by `reachableFrom()` in `lib/transit/planner.ts`: every place reachable on
one bus from the current stop, in route order, always offered as the last item
on the destination list. From Сансар ШТС that is 100 destinations, cycled by
swipe and jumped five at a time.

The whole journey — destination, plan, board, ride, arrive — has since been
driven end to end with **voice off and touch only**. Whether `mn-MN` works
changes nothing about whether the app is usable.
