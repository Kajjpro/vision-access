@AGENTS.md

# Vision Access

Obstacle detection for blind users in Mongolia. Camera → detection → Mongolian speech.

## Hard constraints

- All inference is CLIENT-SIDE. Never add server-side inference.
- Inference runs in a Web Worker. Never on the main thread — it breaks audio.
- Frame budget: 60ms. If exceeded, DROP frames. Never queue them.
- Warning audio is PRE-RENDERED mp3, never a live TTS call.
- Camera components are client-only: dynamic(..., { ssr: false }).
- Max one spoken announcement per 1.5s. Debounce repeats by track ID for 6s.
- Never expose ANTHROPIC_API_KEY to the client.

## Users cannot see the screen

Every state change must be audible. No silent failures.

- iOS: navigator.audioSession.type='playback' or the silent switch kills all warnings.
- Debug output goes ON SCREEN. There is no console on a phone.
