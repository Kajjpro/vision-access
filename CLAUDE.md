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
