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

| # | Mode     | id     | Label      | State |
|---|----------|--------|------------|-------|
| 1 | Walk     | `walk` | Алхах      | Working — `components/modes/WalkMode.tsx` |
| 2 | Ask      | `ask`  | Юу байна?  | Built, never run on a phone — `components/modes/AskMode.tsx` |
| 3 | Bus      | `bus`  | Автобус    | Built, never run on a phone — `/bus/wait` → `/bus/board` → `/bus/ride` |
| 4 | Settings | `settings` | Тохиргоо | Working — `/settings`, guidance level + heartbeat |

"Scene" became **Ask the Room**: it keeps the `mode_scene` clip and slot, because
"Юу байна?" is exactly the question that feature answers.
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

## SettingsMode — partly shipped

`/settings` ships guidance level (minimal / standard / detailed) and the
heartbeat switch, persisted and spoken on change.

**Volume and sensitivity are still deferred**, and for the original reasons:
volume needs a gain node in `lib/audio.ts` that every clip routes through, and
sensitivity has to reach `CONFIDENCE_THRESHOLD` inside `lib/vision.worker.ts`,
which is a module constant — so it needs a worker message to change at runtime.
Two working controls beat four where two quietly do nothing.

## Deferred: reading a bus route number from a photo

NOT the bus journey flow, which ships. This is the separate idea of reading the
route number off an approaching bus, digit by digit.

**Now cheaper than when this was written:** `scripts/setup-tesseract.mjs` already
self-hosts tesseract for Ask the Room, so the dependency, the COEP workaround and
the wasm hosting are all done. What remains is a digit whitelist and the crop.

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

## The wrong-direction threshold cannot be retuned on synthetic data

`WRONG_DIRECTION_SPACINGS` ships at 1.0 with `WRONG_DIRECTION_SUSTAIN_FIXES` at
10. That pair measured 0 false positives over 146 correct-direction journeys and
fired on 60 of 60 wrong-direction ones — but **both corpora are `gps-sim.ts`
traces with zero-mean 25 m noise, and that is not what Ulaanbaatar GPS does.**

`lib/countdown/geometry.ts` records the reason the whole projection design
exists: drift in the canyon around Sükhbaatar Square exceeds a block. That drift
is larger than 25 m and it is not zero-mean — it is a systematic pull in the
direction of the reflecting facade. Neither property is in the simulator, so the
measured 0/146 is a floor, not the real rate. The true false-positive rate is
above zero and the case for holding at 1.0 is therefore STRONGER than the sweep
suggests, not weaker.

**Do not lower K on the strength of the latency table below.** What the table
prices is the cost of the threshold on the positive side; what it cannot price
is the cost on the negative side, because the negative corpus is synthetic.

| K | true-fire | rider travels first | false-fire (synthetic) |
|---|---|---|---|
| 0.30 | 60/60 | 201 m / 30 s | 8 |
| 0.50 | 60/60 | 295 m / 45 s | 4 |
| 0.75 | 60/60 | 484 m / 69 s | 2 |
| 1.00 | 60/60 | 623 m / 95 s | 0 |

Note also that true-fire saturates at every K, which is structural rather than
reassuring: a bus on a diverging chain accumulates backward displacement without
bound, so any finite threshold is crossed eventually. Detection rate cannot
discriminate between these rows; only latency and the false-positive rate can.

Retuning needs a RECORDED trace — real fixes from a phone on a real route, fed
through `gps-sim.ts`'s trace format into the same two harnesses. Until one
exists, 1.0 stands.

## Deferred: return-route guidance after an overshoot

When a rider misses their stop the app now says they have passed it, adds one
guidance line, and repeats the position for three stops before falling silent
(`OVERSHOOT_REPEAT_STOPS` in `lib/transit/announce.ts`). What it does NOT do is
tell them how to get back.

**That is cheaper than it looks.** `lib/transit/planner.ts` is offline, pure and
instant against the baked route graph — no network, nothing to rate-limit. A
re-plan from the rider's current position back to the original destination is an
existing capability called with different arguments, not new work. What is
actually missing is the Mongolian for the guidance, and a decision about whether
to name the return route number or just say to get off and wait.

The same string gap blocks the long-press status query, which today drops both
the number and the suffix when `left` is negative (`statusNow` in
`app/bus/ride/RideScreen.tsx`) — so after an overshoot it names two stops with no
relationship between them.

## iOS reloads at "model 100%" — the load plan

Reported from a phone: Safari reaches 100%, the page reloads, and the app is
back on the main menu. Both halves are one event. iOS kills a tab whose memory
spikes and reloads it — no exception, no log — and Walk mode is component state
on `/` (`setActive` in `HomeGestures`), never a route, so the reload can only
come back on the menu.

100% is where the spike is, because 100% is where `InferenceSession.create`
starts. The peak holds at once: 37 MB of model bytes in the JS heap, ort's copy
inside the wasm heap, the parsed weights, and the graph optimiser's transient
duplicates — over a 26.8 MB wasm module and its compiled code, the decoded
clips, and a live camera.

`lib/vision-plan.ts` picks how hard to push. `lean` drops WebGPU (the JSEP path
keeps the weights in the wasm heap *and* uploads them to the GPU, which on a
phone is the same memory), takes one wasm thread (each thread carries its own
intermediate-tensor arena, which at 640×640 dwarfs the weights), and uses basic
graph optimisation. The worker no longer loads on module evaluation — it waits
for `{type:"start", plan}`, because the evidence lives in `localStorage` and a
worker cannot read it.

**The pin is the part that matters.** A lean run succeeds, which clears the
breadcrumb; choosing from the breadcrumb alone would send the next launch back
to `full` and kill it again — a working app every other launch, which to someone
who cannot see the screen is indistinguishable from random. So the first
model-stage crash pins `lean` permanently (`va:vision-plan`), and so does an
in-run fallback that succeeds.

Two things this does NOT do. It does not make the model cheaper — the input is
a static `[1,3,640,640]` (`npx tsx scripts/inspect-model.ts`), so nothing in the
browser can tune it. And it does not tell the rider why the app got slower; the
generic `error` clip on a post-crash run is all there is, and a real string
belongs in the one strings file, not here.

The next lever, if a phone still dies on `lean`: `onnxruntime-web/wasm` uses
`ort-wasm-simd-threaded.wasm` (13.5 MB) instead of the jsep build's 26.8 MB —
half the binary to download, compile and hold. It costs a second vendored wasm
blob in git, permanently, which is why it is not taken yet.

## The journey architecture

`lib/journey/` — one `Journey` object, one state machine, five pure modules and
45 tests. It replaces `phase` strings held separately in three screens, which is
what made the flow feel disconnected: each screen knew its own middle and
nothing knew the whole, so "what is happening" had no single place to be
answered from and two of the three screens could not answer it at all once
something had gone wrong.

| module | owns |
| ------ | ---- |
| `types.ts` | the `Journey` object, 13 states, guidance levels |
| `machine.ts` | legal transitions as data; illegal events rejected, not applied |
| `pacer.ts` | when to speak unprompted — the heartbeat and the question re-ask |
| `guide.ts` | what to answer when asked; deterministic, never generative |
| `present.ts` | journey → headline, detail, actions, progress step |

`/bus/board` is the gate this created room for. See CLAUDE.md for both
invariants it establishes.

**Three states from the brief are deliberately absent**, and the absences are
the honest part. `BUS_APPROACHING` and `BUS_ARRIVED` collapse into `bus_due`,
because separating them needs a vehicle to watch and we have a timetable.
`WALKING_TO_DESTINATION` is not modelled: turn-by-turn after alighting needs a
compass heading and pedestrian data this repo has no source for, and "walk
straight for eighty metres" invented from a bearing is the kind of confident
wrong instruction that costs more than saying nothing.

**Distances are shown, not spoken.** `num_` clips run to 40, so a spoken metre
count would be silent for most values. The screen shows metres; the voice says
"the stop is near".

### The screens are on it now

`/bus/wait`, `/bus/board` and `/bus/ride` all render `present(journey)` through
one `JourneySurface` — top: where you are in the journey; centre: the one fact
that matters; bottom: the contextual actions, primary first. No cards, no
dashboard.

- **`/bus/wait`** — `Phase` became `InputMode`, and the three failure phases
  (`no-location`, `no-stop`, `no-route`) are journey faults, so the same cause
  gets the same phrase from anywhere in the app.
- **`/bus/board`** — the gate. Three answers now: boarded / not boarded / not
  sure.
- **`/bus/ride`** — the countdown engine, recorder and audio-lifecycle
  instrumentation are untouched; what moved is the layer above them. The engine
  feeds `position_updated`, and the count on screen and the count in the rider's
  ear are now the same number from the same call. Arrival raises the **exit**
  question rather than ending the journey.
- **`Асуух`** — one action per active state, opening a short contextual list of
  the questions that are answerable *now*. Deliberately not a chat box: composing
  a sentence at a bus stop, without sight, is the most expensive interaction
  available. Closed entirely while a confirmation is open.
- **`/settings`** — guidance level (minimal / standard / detailed) and the
  heartbeat switch, persisted, spoken on change. Volume and detector sensitivity
  are still absent; both need machinery that does not exist yet, and two working
  controls beat four where two do nothing.

### The two-platform fix

Reported as "when they have chosen the bus, it is chaos" — and it was, for one
structural reason. The planner searches every platform within 400 m and picks
whichever reaches the destination. That is routinely **not** the platform the
rider is standing on, and three things then went wrong at once:

1. **The plan never named its boarding platform.** It spoke route, stop count
   and time. A rider at `Сансар /Урд/` heard "Ч:35, twelve stops, about five
   minutes" while the plan boarded at `Сансар /Хойд/` across the way.
2. **`/bus/board` hard-coded `distanceToStopM: 0`**, with a comment claiming the
   wait screen had located the rider at that stop. It had not. The journey
   skipped `walking_to_stop` entirely and started a countdown for a kerb the
   rider had not reached.
3. **`destinationIndex` was passed as `-1`** from the wait screen.

All three fixed. The handoff now carries `boardingDistanceM` measured from the
live fix, the machine picks `walking_to_stop` on its own, the walk is watched by
GPS, and "Би буудал дээр байна" is handled as the manual override for a drifting
fix. See CLAUDE.md for the measurements behind it.

## Ask the Room — the engine

`lib/ask/` — 49 tests. A question in, a spoken answer out, routed to the
cheapest capability that can serve it.

| module | owns |
| ------ | ---- |
| `capabilities.ts` | semantic goals → detector classes, **derived from `DETECTION_CLASSES`** |
| `intent.ts` | utterance → intent + goal, token-boundary matching over folded text |
| `spatial.ts` | bearing bands from the real 69° HFOV, distance phrasing, confidence register |
| `answer.ts` | Tier 1 answers: find, count, path, environment |
| `context.ts` | what "it" binds to, and when it expires |
| `router.ts` | the tier decision; returns an answer or an escalation request |
| `providers.ts` | OCR and VLM seams — typed, **not implemented, not faked** |

**Seven of the twelve example questions resolve on-device**, because the detector
already has `door`, `stairs`, `bench`, `table`, `sign`, `person` and `curb`.

### Two things the suite caught that reading would not have

**`fold()` collapses `хаана` ("where") to exactly `хана` ("wall").** Doubled
letters are collapsed on purpose so ASR confusions match, and the side effect is
that short Mongolian words contain one another afterwards. Substring matching
routed "Хаана суух вэ" — *where can I sit* — to `find_obstacle`. Fixed by
matching whole-token runs, and `хана` is deliberately absent from the obstacle
keywords with the reason recorded there. **The same hazard applies anywhere else
`fold()` output is substring-matched.**

**An unreliable distance is only meaningful at the sentinel.**
`estimateObjectDistance` returns `VERY_CLOSE_M` (0.3) with `reliable: false`
when an object fills the frame — that one case means "very close". Any other
unreliable figure is a number the geometry could not stand behind, and it
becomes a direction with no distance.

### Wired, and what that cost

- **All 55 clips rendered.** `render-ui-audio.ts` against Azure — the CONFIRM,
  TIMETABLE, ASSIST, SETTINGS, GUIDE and ASK vocabularies are on disk. Every
  `ui_*` phrase in the app is now registered **and** rendered; there is no
  backlog left. 1,128 characters of quota.
- **OCR is real.** tesseract.js 7, self-hosted under `public/tesseract/` because
  COEP blocks its CDN defaults exactly as it blocked onnxruntime's.
  **`mon.traineddata`, not `eng`** — signage here is Cyrillic and the English
  model reads it as confident noise. `npm run ocr:setup`, and `prebuild` runs it
  so a fresh clone is never silently without OCR. 7.8 MB, gitignored: unlike
  `public/wasm`, this one regenerates from a script.
- **`components/modes/AskMode.tsx`** — camera, detector, push-to-talk, routing,
  speech. Reached from the home list. Uses the same `vision-plan` degrade
  machinery Walk mode does.
- **`lib/tilt.ts`** — `requestTiltPermission` and `pitchFromBeta` extracted from
  WalkMode, because both modes feed `CameraPose.pitchDeg` and a second copy is
  how two modes come to disagree about how far away the same door is.

### The `ui_` prefix is load-bearing

The ASK clips were first written as `ask_*` and **would never have rendered or
loaded**. Two consumers filter on the prefix — `render-ui-audio.ts` renders only
`ui_*`, and `ManifestClipPlayer`'s default key set loads only `ui_*` — and both
failures are silent. Renamed to `ui_ask_*`, with the reason recorded at the
group.

### Two test bugs found by fixing a third

`assert.rejects` **must be awaited**. Unawaited, the assertion runs after the
test has already passed and node reports it as stray async activity rather than
as a failure — which is how a stale error-message assertion survived a green
run. Fixed here and in `lib/journey/settings.test.ts`.

### Not yet done

- **The new clips are unrendered.** 40 phrases across `CONFIRM`, `TIMETABLE`,
  `ASSIST`, `SETTINGS` and `GUIDE` are in `lib/ui/announcements.ts` and
  registered in `lib/phrases.ts`, but no WAV exists yet. One command:
  `npx tsx scripts/render-ui-audio.ts` (needs the Azure key). Until then the
  queue reports each missing key once in the console with that command, and the
  earcon and haptic carry the state. Mongolian is draft, pending the same native
  review as the rest of the file.
- **Pre-existing lint errors** in `lib/ui/useGestureNav.ts` and
  `lib/ui/useVoiceJourney.ts` (`react-hooks/refs`, `set-state-in-effect`).
  Untouched by this work and failing before it; `npm run lint` also still dies
  with `RangeError: Invalid string length` on a binary in the project.
- **`/bus/journey`** is still its own screen and has not been folded in.

## Open decisions

- **Which detector to ship.** `public/models/yoloe-11s.onnx` is fp32, 37.2 MB,
  with a static 640×640 input — *not* @320, as this line said until the iOS
  memory work measured it. int8 quantizes to 9.6 MB but dropped a person at 0.90
  confidence in testing, and its `ConvInteger` ops force the CPU path. fp16
  (~18.6 MB, keeps WebGPU) is the recommendation and is still not built. It is
  now the largest single term in the peak that kills an iPhone, so it is no
  longer only a bandwidth question.
- **Debounce.** CLAUDE.md says repeats debounce by class for 3s; WalkMode
  currently uses per-urgency windows of 2s/4s/8s keyed on the whole spoken
  sequence. Reconcile.
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
