@AGENTS.md

# Vision Access

Obstacle detection for blind users in Mongolia. Camera → detection → Mongolian speech.

Project constraints below override general Next.js conventions in AGENTS.md.

## Inference

- ALL inference is CLIENT-SIDE, in every mode. Never add a server
  inference route. A network round trip is ~400ms; a person walks half
  a metre in that time.
- Camera frames never leave the device. There is no upload path, so
  there is nothing to disclose and nothing to retain.
- Inference runs in a Web Worker. Never on the main thread — it breaks audio.
- Frame budget: 60ms. If exceeded, DROP frames. Never queue them.
  Always .close() dropped ImageBitmaps.

## Audio

- Warning audio is PRE-RENDERED from Chimege, never a live TTS call.
- Decode all AudioBuffers at startup. Never decode at playback time.
- Sequence clips with AudioBufferSourceNode.start(when), never setTimeout.
- Max one spoken announcement per 1.5s. Debounce repeats by class for 3s.
- Object name ALWAYS precedes distance.
- iOS: set navigator.audioSession.type='playback' before creating the
  AudioContext, or the silent switch kills all warnings.
- Create the AudioContext inside a user gesture. Keep it in a ref.

## TTS providers

- TTS is BUILD-TIME ONLY, behind `lib/tts/provider.ts`. Build scripts talk to
  the interface and NEVER name a vendor. Switching is `TTS_PROVIDER=`, not a
  refactor — we have been forced off one provider mid-build already.
- The clip cache keys on `hash(provider + voice + text)`. Without the provider
  and voice in the key, a switch silently mixes two voices inside one manifest;
  a stop name in one voice then "Одоо буугаарай" in another is disorienting to
  someone who cannot look at the screen to work out why.
- The cache stores the PROVIDER'S OWN audio, not the encoded Opus. Re-encoding
  at a different bitrate must never cost API quota. `--force` re-encodes;
  `--resynthesize` is the explicit expensive one.
- **Azure** (`mn-MN-YesuiNeural`, default) — F0 free tier, 500,000 chars/month,
  HARD CAPPED. The build prints cumulative usage against that allowance and
  aborts rather than exceeding it. Azure expands numerals and reads Latin
  itself, so stop names go through `toSpeechText()` only.
- **Chimege** — kept as an implementation, not deleted. Free tier stops at 100
  requests; the project token is currently suspended (403). Accepts Cyrillic
  plus `? ! . - ' " : ,` and 400s on digits, slashes and Latin, so it needs the
  `data/number-words.json` rewrite that Azure does not.
- **MMS** (`facebook/mms-tts-mon`) — local Python fallback, zero cost, no
  network. **Licensed CC-BY-NC 4.0: non-commercial use only.** Its Mongolian
  dialect quality is UNVERIFIED — MMS is trained on religious-recording corpora
  and the register may not match how a UB passenger expects a stop name to
  sound. Insurance against losing Azure, not a shipping choice.
- Display text and spoken text are ALWAYS different fields. Routes have
  `displayName` / `spokenName`; stops have `name` and `toSpeechText(name)`.
  Never send a display string to an engine, and never fall back to one.

## Safety

- This app supplements a white cane. It never replaces one.
- Describe, never instruct. Say what the camera sees, not what to do.
  Never "you can go" or "stop" for traffic signals.
- Silence is the correct output under uncertainty. A missing warning
  costs nothing; a false one costs trust or injury.
- Never announce a distance number when the estimate is unreliable.
  Monocular geometry cannot measure centimetres. Say "very close" instead.
- Server calls must prefer returning null over guessing. A wrong bus
  number or banknote value causes real harm.

## Users cannot see the screen

- Every state change must be audible. No silent failures.
- Debug output goes ON SCREEN. There is no console on a phone.
- Camera components are client-only. dynamic(..., { ssr: false }) must
  live inside a Client Component — it is banned in Server Components.
- Announce degradation: low battery, low light, model failure.

## Platform

- Target: cheap Android over expensive mobile data. iOS Safari has
  hard memory limits — quantized models only, .close() every bitmap.
- Never expose ANTHROPIC_API_KEY or CHIMEGE_TOKEN to the client.
- Next.js 16, Turbopack. No webpack config.
- Warning audio (WalkMode) is PRE-RENDERED. Never a live TTS call —
  latency and offline both forbid it.
- Open-vocabulary text (bus stop names) MAY use a server TTS proxy,
  cached permanently in IndexedDB on first use. The Chimege token
  stays server-side. This never applies to obstacle warnings.
