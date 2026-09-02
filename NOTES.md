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
| 5 | Money    | `money`    | Мөнгө      | Built — `components/modes/MoneyMode.tsx`; needs a reference pack |

Money **is** on the home screen now (see "MoneyMode" below). That makes five
tiles, so the grid derives its rows from `MODES` and the last tile spans both
columns — an odd tile count would otherwise leave a hole, and a hole is a dead
zone that touch-explore reports as silence.

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
- YOLO11s COCO-80 detector in a Web Worker, WebGPU with wasm fallback.
  Supervised, not zero-shot — see "Detector vocabulary" below
- Distance fused from up to three independent estimators (ground plane, height
  prior, width prior) with a confidence signal — never speaks a number the
  geometry cannot support (`lib/distance.ts`)
- Class identity decided by a score-weighted vote across ~1.2 s, not by the
  latest frame; the name is withheld when the vote is not decisive
  (`lib/tracker.ts`, `nameIsTrusted()` in `WalkMode`)
- Lock-on box drawn around the tracked target (`components/TargetOverlay.tsx`)
- Duty-cycle pacing: the loop rests in proportion to what inference cost, so a
  slow phone no longer runs the network continuously (`MAX_DUTY_CYCLE`)
- Motion gating: inference is skipped entirely while the scene holds still,
  bounded by a 600 ms safety ceiling (`lib/motion.ts`)

## Measuring performance on a phone

Nothing on a laptop answers this. Open **`/dev/bench`** on the device: it runs
the real worker against the real camera for 2 x 30 s — once with motion gating
off, once on — and prints backend, thread count, cross-origin isolation,
inference p50/p90/p99, duty cycle, thermal drift and the observed motion
distribution on screen. There is no console on a phone, so everything is
rendered.

The camera needs a secure context, so the phone must reach the dev server over
HTTPS (the tunnel in "Dev on a phone" below). Read the **duty cycle**, not the
frame rate: 5 fps at 95% duty and 5 fps at 40% duty look identical to a user and
differ by half the battery.
- 76 pre-rendered Chimege clips, one shared AudioContext (`lib/audio.ts`)
- Crash breadcrumb survives an iOS OOM kill (`lib/breadcrumb.ts`)

## MoneyMode — built, needs reference photographs

Identifies 100 / 500 / 1000 / 5000 / 10000 / 20000 tögrög notes. Tap to
capture, three frames, decide, speak — the shape this file specified for
BusMode. Code is complete and tested; what it still needs is twelve
photographs.

**The old blocker was the wrong diagnosis.** This section used to say the mode
needed "YOLO classes that do not exist yet and training data we do not have",
and a labelling campaign over folded, angled, partly-covered notes. That is the
right answer for a CATEGORY like `person` — endless intra-class variation, which
is exactly what tens of thousands of labelled boxes buy. A banknote is not a
category. It is a rigid, planar, mass-produced object with one fixed printed
design, which makes it INSTANCE recognition: match against a picture of the
thing rather than learn what the thing tends to look like.

So there is no training run and no dataset. `lib/money/` implements ORB
keypoints and rBRIEF descriptors, matched against a reference pack with a
RANSAC homography, and the pack is built from **one flat scan per note per
side**. Adding a denomination is two photographs, not a labelling campaign.

That choice also fits the safety rule better than a classifier would.
CLAUDE.md demands null over guessing because a wrong banknote value causes real
harm, and a softmax head cannot honour that — it is normalised over the classes
it was given, so shown a napkin it still emits a confident-looking distribution.
Inlier counting has no such floor: rejection is the default state, and an
unrelated image produces a handful of correspondences that fit no consistent
homography. Measured on synthetic notes, an unrelated pattern scores 0 inliers
against a gate of 18.

Five gates, each able to reject on its own: Lowe ratio test → mutual
cross-check → RANSAC → quad plausibility (a homography must map a rectangle to
a convex, sensibly-sized quadrilateral) → a 1.6x margin over the runner-up
denomination. Then `lib/money/decide.ts` requires two of three frames to agree,
and treats CONTRADICTION AS DISQUALIFYING rather than as a majority vote: two
frames saying 1000 and one saying 5000 is evidence the matcher is unreliable
right now, not evidence for 1000.

### What is left

1. **Twelve reference photographs.** `<value>-front.jpg` / `<value>-back.jpg`
   in `reference-notes/`, then `npm run money:refs`. Shooting guidance is in
   the header of `scripts/build-money-refs.ts` and it matters more than any
   threshold — a weak reference is a SYSTEMATIC error, and the three-frame
   agreement cannot catch one, because every frame is wrong the same way and
   agrees perfectly. The script refuses to write a pack where any image is too
   sparse to match.

2. **Calibrate the gates.** `MIN_INLIERS = 18` and `MARGIN = 1.6` in
   `lib/money/recognizer.ts` are reasoned defaults, NOT measured. Run
   `npm run money:eval -- --dir test-notes --negatives not-money` on
   photographs of real worn notes in real light. It sweeps both thresholds and
   reports **false naming** separately from accuracy, which is the only
   framing that makes sense here: abstaining costs a retap, naming a 20000 as
   a 1000 costs the difference at a till with no way to notice. Pick the
   cheapest setting with FALSE = 0.

3. **Eight wavs.** `money_100` … `money_20000`, `money_prompt`,
   `money_reading` are in `lib/phrases.ts` (~150 characters) but not yet
   rendered. They are part of the 46 phrases currently missing wavs — the 38
   `ui_*` ones predate this work.

Until a pack exists the mode still enters and says "мөнгө, тун удахгүй" for
itself, deliberately NOT the error clip: nothing is broken, and the error clip
would invite a retry that cannot succeed. It starts working the moment a pack
lands, with no flag to remember to flip — the stale-flag bug that left
`/bus/wait` unreachable after it was built.

### Not used as signals, on purpose

**Physical size.** The notes do differ in millimetres, and it is useless from a
monocular photo: with no scale reference, a 1000 held close and a 20000 at
arm's length subtend the same box. That is how you misname a note by a factor
of twenty.

**Colour.** A real weak prior and a terrible primary one — shared palette
family, fades with wear, and UB winter street light is nothing like the light a
reference is scanned under. The matcher never consults it; decisions rest on
print geometry alone.

## Open decisions

- **Detector vocabulary.** SETTLED, in favour of supervised COCO.
  `public/models/yolo11s.onnx`, fp32 @640 (verified: input `[1,3,640,640]`,
  output `[1,84,8400]`), 36.3 MB — a megabyte *smaller* than the YOLOE export
  it replaced. Rebuild with `model/coco_export.py`.

  The old file baked 32 Mongolian obstacle classes into YOLOE as CLIP text
  embeddings. Measured peaks: `bus 0.95, person 0.94, dog 0.49` against
  `trash_can 0.14, tree 0.04, door 0.02, pole <0.02` — the split is exactly
  "was this class in COCO's training data". Half the vocabulary never cleared
  the 0.30 threshold, so the app looked like it knew 25 classes and knew 12.

  What the swap costs: pole, tree, wall, fence, door, stairs, trash_can, curb,
  scaffolding, cable, hole, ice, rock. All thirteen were already unreachable,
  so nothing audible changed. What it buys: those twelve are now backed by real
  labelled data instead of a prompt, plus COCO `chair` mapping onto the
  existing "Сандал" clip for free.

  Getting the lost classes back is a **data** problem, not a threshold or
  prompt one: an Objects365 or LVIS checkpoint (both contain poles and bins),
  or a few thousand hand-labelled UB street photos. `model/yoloe_export.py` is
  kept for cheaply *probing* whether a candidate class is worth labelling —
  read its per-class hit table — but its output is not shippable.

  Next size lever, if the download hurts: `yolo11n` (2.6M params, ~10 MB,
  COCO mAP 39.5 vs 47.0). `model/coco_export.py --model yolo11n.pt` already
  supports it. Run the recall comparison below before shipping it.

- **Model cost.** MEASURED on a laptop, NOT YET on a phone. `npx tsx
  scripts/bench-model.ts` (onnxruntime-node, Apple M3, CPU):

  | config | 1 thread | 4 threads | size |
  |---|---|---|---|
  | **yolo11s@640 (shipped)** | **241 ms** | **71 ms** | 36.3 MB |
  | yolo11s@480 | 139 ms | 40 ms | 36.2 MB |
  | yolo11n@640 | 85 ms | 27 ms | 10.2 MB |
  | yolo11n@480 | 49 ms | 15 ms | 10.2 MB |

  The budget is 60 ms. Even four-threaded on an M3 the shipped model misses it,
  and a cheap Android core is several times slower again. Ratios transfer
  between backends; absolutes do not — run `/dev/bench` on the device.

- **Shrinking the model.** REJECTED, twice, on recall. `npx tsx
  scripts/compare-recall.ts <ref> <candidate> <images...>` over 48 cases
  (4 images x 4 scales x 3 brightness):

  | candidate | overall recall | person | car |
  |---|---|---|---|
  | yolo11n@640 | 78% | **80%** | 74% |
  | yolo11s@480 | 82% | **76%** | 88% |

  Both lose a fifth to a quarter of the PEOPLE, concentrated small-and-dim —
  the same signature as the int8 failure below, found the same way. Neither is
  shippable as a straight swap. The model stays yolo11s@640, and performance
  has to come from *when* inference runs rather than *what* runs.

- **Quantisation.** SETTLED, against int8. Measured on the previous YOLOE
  export; the architecture and failure mode carry over, but re-measure the
  megabyte figures for the current file. That export was 39.1 MB.
  int8 dynamic quantisation gives 10.2 MB and ~34% faster CPU inference, and on
  one bright photo looks free — same detections, box IoU 0.95-0.99, distance
  error 0.2%. Measured properly it is not: over 36 cases (3 images x 4 scales x
  3 brightness levels) it lost **31% of fp32's detections, 26 of 84, every one
  of them a person**, one at fp32 confidence 0.90. The earlier "dropped a person
  at 0.90" note was not a fluke, it was the pattern. Losses concentrate in the
  small-and-dim regime, i.e. a UB winter afternoon. Do not ship it, and do not
  re-evaluate it on a single well-lit frame.
  fp16 (~18.6 MB, keeps a WebGPU path) is still the open candidate — but note
  `model/yoloe_export.py` claims the wasm fallback has no fp16 kernels, so that
  needs confirming before the work. Run the same recall comparison, not a spot
  check. The harness is straightforward: letterbox to 640, decode `[1,4+nc,8400]`
  channel-major, match by class + IoU>0.5, and count what fp32 found that the
  candidate missed.
- **Debounce.** CLAUDE.md says repeats debounce by class for 3s; WalkMode
  currently uses per-urgency windows of 2s/4s/8s keyed on the whole spoken
  sequence. Reconcile.
- ~~`public/models/yolo-world.onnx` (50 MB) is dead and still shipped.~~ Deleted;
  recoverable from git history if a YOLO-World comparison is ever wanted again.

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

Banknote reference pack, and the calibration run that must follow it:

    npm run money:refs
    npm run money:eval -- --dir test-notes --negatives not-money
