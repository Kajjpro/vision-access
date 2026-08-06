# Vision Access — status

## What it is

Camera-based obstacle detection for blind users in Mongolia.
Detect obstacle → announce name in Mongolian → spoken aloud.
Next.js 16 + TypeScript, Turbopack, all inference client-side.

## Working

- Camera (rear, facingMode: 'environment') on iPhone via cloudflared tunnel
- WebAudio beep on tap
- next.config.ts: turbopack:{}, allowedDevOrigins, COOP/COEP headers

## In progress

- iOS silent switch mutes audio → adding navigator.audioSession.type='playback'

## Next

1. requestAnimationFrame frame loop + FPS counter (no ML yet)
2. Azure TTS build script → pre-render Mongolian mp3s to public/audio/
3. lib/vision.worker.ts — YOLO-World ONNX in a Web Worker

## Dev

Two terminals:
npx next dev --experimental-https
npx cloudflared tunnel --url https://localhost:3000
Test on a real iPhone. Desktop browser hides most of the bugs.
