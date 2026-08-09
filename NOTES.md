# Vision Access — status

## What it is

Camera-based obstacle detection for blind users in Mongolia.
Detect obstacle → announce name in Mongolian → spoken aloud.
Next.js 16 + TypeScript, Turbopack. All inference client-side; nothing
the camera sees leaves the device.

## Modes

A 2×2 home screen (`app/page.tsx`). Touch-explore for non-VoiceOver users
(drag to hear names, lift to activate); real `<button>`s so VoiceOver's own
swipe + double-tap works unmodified.

Grid order is also the order the spoken menu reads them in.

| # | Mode     | id         | Label      | State |
|---|----------|------------|------------|-------|
| 1 | Walk     | `walk`     | Алхах      | Working — `components/modes/WalkMode.tsx` |
| 2 | Scene    | `scene`    | Юу байна?  | Deferred — not started |
| 3 | Bus      | `bus`      | Автобус    | Deferred — see below |
| 4 | Settings | `settings` | Тохиргоо   | Deferred — volume + sensitivity |

Money is **not** on the home screen. It is deferred on data, not on UI, so
it would sit there saying "coming soon" indefinitely; the `mode_money` clip
is kept so re-adding it costs nothing.

A deferred mode speaks its own name then `coming_soon` ("Тун удахгүй") and
stays on the menu. Deliberately not the error clip: "not built yet" and
"something broke" are different facts, and the error clip would report a
fault and invite a retry that cannot succeed.

## Deferred: SettingsMode

Volume and sensitivity. Small but not trivial — volume needs a gain node in
`lib/audio.ts` that every clip routes through, and sensitivity has to reach
`CONFIDENCE_THRESHOLD` inside `lib/vision.worker.ts`, which today is a
module constant. That means a worker message to change it at runtime.
Both settings persist to localStorage and must be announced when changed.

## Deferred: BusMode

Read bus route numbers from a tap-to-capture photo, announced digit by
digit.

**Plan of record: tesseract.js, on-device.** Nothing external blocks it —
no key, no account, no network. What it needs:

    npm i tesseract.js

plus the worker, core wasm, and `eng.traineddata` self-hosted under
`public/tesseract/`, because COEP is `require-corp` and tesseract's CDN
defaults are blocked exactly as onnxruntime's were (`public/wasm/`).
Use `tessdata_fast` (~2 MB), not standard (~15 MB) — a digit whitelist does
not need the full model.

Expect a low hit rate on uncropped street photos. `tessedit_char_whitelist`
means tesseract can never return "no digits found" — it maps whatever it
sees onto digits, so window frames and grille slats become numbers. And
three frames 400 ms apart are highly correlated: agreement across them rules
out hand-shake and motion blur, but not a systematic misread. The mitigation
is to crop first — the YOLO detector already on the device finds `bus` at
0.95 confidence — before OCR ever runs.

**Alternative raised: the Hamuga API.** Recorded because it was asked for,
not chosen. It would reintroduce a server round trip, which CLAUDE.md now
forbids in every mode, so taking it means restoring the on-demand exception
that was deliberately removed. Nothing in this repo references Hamuga and
no access exists yet.

## Working

- Camera (rear, `facingMode: 'environment'`) on iPhone via cloudflared tunnel
- YOLOE 32-class detector in a Web Worker, WebGPU with wasm fallback
- Ground-plane distance with a confidence signal — never speaks a number the
  geometry cannot support (`lib/distance.ts`)
- 76 pre-rendered Chimege clips, one shared AudioContext (`lib/audio.ts`)
- Crash breadcrumb survives an iOS OOM kill (`lib/breadcrumb.ts`)

## Deferred: MoneyMode

Not on the home screen. Blocked on the model, not the UI. Identifying tögrög notes (100 / 500 /
1000 / 5000 / 10000 / 20000) needs YOLO classes that do not exist yet and
training data we do not have. The banknote photographs have to be
collected and labelled — folded, angled, partly covered by fingers, under
indoor and street light — before this is worth building.

The spoken denominations are NOT yet in `lib/phrases.ts`; add them with
the classes so the two cannot drift.

Not blocked on: the capture UI, which will be the same tap → 3 frames →
decide → speak shape as BusMode.

## Open decisions

- **Which detector to ship.** `public/models/yoloe-11s.onnx` is fp32 @320,
  37.2 MB. int8 quantizes to 9.6 MB but dropped a person at 0.90 confidence
  in testing, and its `ConvInteger` ops force the CPU path. fp16 (~18.6 MB,
  keeps WebGPU) is the recommendation but is not built yet.
- **Debounce.** CLAUDE.md says repeats debounce by class for 3s; WalkMode
  currently uses per-urgency windows of 2s/4s/8s keyed on the whole spoken
  sequence. Reconcile.
- `public/models/yolo-world.onnx` (50 MB) is dead and still shipped.

## Dev

Two terminals:

    npx next dev --experimental-https
    npx cloudflared tunnel --url https://localhost:3000

Test on a real iPhone. Desktop browser hides most of the bugs — including
every memory limit that matters.

Regenerate audio after editing `lib/phrases.ts`:

    npx tsx scripts/generate-audio.ts        # --force to re-render existing

Check the model/phrase/audio contract end to end:

    npx tsx scripts/verify-pipeline.ts
