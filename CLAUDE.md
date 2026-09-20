# Journey Countdown & Announcements

> Decisions in this section were reached deliberately and have non-obvious rationale.
> Do not change a constant or invariant here without reading the "why" line attached to it.

## Audio pipeline invariants

- **No runtime TTS.** All speech is pre-rendered Azure `mn-MN-YesuiNeural`. If a string cannot be spoken from the manifest, the correct behaviour is to degrade to a generic clip and log — never to synthesize, never to fall back to browser `speechSynthesis` (its `mn-MN` support is absent or unusable on target hardware).
- **Whole-sentence clips, not fragment concatenation.** Two reasons, both hard blockers: (a) Mongolian numerals take attributive forms before nouns — `гурав` + `буудал` is ungrammatical, it must be `гурван буудал`; (b) concatenated fragments carry sentence-final intonation mid-sentence, which is measurably harder to parse in traffic noise. Fragment concat exists only as a marked fallback for rare slot combinations.
- **Attributive numeral forms** (used in all count templates): 1 нэгэн · 2 хоёр · 3 гурван · 4 дөрвөн · 5 таван · 6 зургаан · 7 долоон · 8 найман · 9 есөн · 10 арван.
- **Route-scoped preload.** Ship name-only clips for all 923 stops in the offline bundle (~5.5 MB). Fetch and pin the full template set for the active route on journey start (~240 clips, ~1.5 MB). Do not ship the full cross-product — it does not fit.
- **Clip filenames are the clip key** (`bus_get_off_now.opus`), not a content hash; `public/audio/transit/manifest.json` is the source of truth. `scripts/generate-transit-audio.ts` is idempotent: each entry carries a `sha` over provider + voice + text, and a clip is re-synthesized only when that changes, so a re-run costs no API quota.
- **Missing `spokenName` in `route-names.json` must never reach speech as a raw ID.** Degrade to the generic form, warn in logs.

## Safety gate (extends the existing stop-resolve gate)

The LLM layer may rank candidates but may **never** emit a stop or route name that did not come from the deterministic matcher. This applies to countdown and announcement copy exactly as it applies to stop resolution. No exceptions for "just formatting" a name.

## Map matching constants

Raw nearest-stop lookup is **not acceptable** — GPS drift in the downtown canyon near Sükhbaatar Square exceeds a block. Project onto the route variant polyline, derive a scalar distance-along-route, then derive stop index from that.

| Constant                | Value                    | Why                                                                                           |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| Advance threshold       | 40 m past stop           | Below this, normal fix noise triggers false advances                                          |
| Confirmation fixes      | 2 consecutive            | Single-fix advance causes duplicate announcements — the most common bug in this feature class  |
| Backward-jump rejection | unless stationary >120 s | Index is monotonic within a trip; the exception covers terminus turnaround                    |
| Dead-reckoning validity | 180 s                    | Beyond this, extrapolation error exceeds one stop interval                                    |

All three are measured **along the route**, never perpendicular to it, so the chord approximation below does not affect them.

### The geometry is chords, and that decides what may be built on it

`public/transit/` ships no shapes, and the Hamuga shape endpoint is unverified. `StopChainGeometry` synthesizes the polyline by joining each variant's ordered stop coordinates. Real shapes swap in behind the same `RouteGeometry` interface without touching callers.

- **Along-route distance stays good.** A chord is shorter than the arc it spans, so the scalar runs slightly short between stops and re-syncs exactly at every stop, where chord and road touch by construction. Error cannot accumulate across a journey.
- **Perpendicular distance is NOT usable for any decision.** `Projection.offRouteM` is diagnostics only.

### Divergence is topological, never a distance

> Superseded: a ">150 m for 2 stop-intervals" divergence alert. **Do not reintroduce it.**

Measured over the shipped data: across 1,555 ordinary urban bends (both legs ≤ 800 m), the worst perpendicular offset of a real stop from the chord that skips it is **546 m** — on route 11100115. A 150 m threshold would fire on a bus tracking its lane perfectly, at every turn, and a spurious wrong-bus alert that makes a rider leave a *correct* bus is a real harm. The regression test carrying that measurement is in `lib/countdown/geometry.test.ts`.

So both §6.1 detectors are topological:

| Condition       | Test                                                                | Sustained for      |
| --------------- | ------------------------------------------------------------------- | ------------------ |
| Wrong direction | stop index decreases monotonically                                  | 2 stop-intervals   |
| Wrong bus       | nearest stop lies outside the expected route variant's own stop set | 2 stop-intervals   |

The sustained requirement stays: never fire on a single fix.

**Identity rules:**

- Track `vehicleId`, never `routeId`. Convoys of the same route are routine here.
- On loop routes the same stop appears twice in a variant. **Stop index is the identity, never stop ID.** Three genuine duplicate stop names already exist in source data.

## Confidence → phrasing contract

The register of the spoken string is bound to data quality. This is a safety contract, not a style choice: a rider steps toward live traffic on the strength of these words.

| Source          | Staleness | Confidence | Register                                       |
| --------------- | --------- | ---------- | ---------------------------------------------- |
| `gps_matched`   | <30 s     | high       | assertive — "ирж байна"                        |
| `gps_matched`   | 30–90 s   | medium     | hedged — "ойртож байна"                        |
| `eta_inferred`  | any       | medium     | "тооцоолсоноор"                                |
| `dead_reckoned` | <180 s    | low        | explicit uncertainty — "магадгүй"              |
| none / >180 s   | —         | —          | announce loss **once**, offer bystander assist |

Confidence _downgrades_ are announced exactly once. Never repeat a degradation notice.

## Announcement policy

**Silence is the default.** Audio is not a progress bar. The rider navigates by ear and every unnecessary word masks traffic they need to hear. Speak on state change only — never on a timer, never as a periodic update.

### The one timer, and why it is not speech

A rider who cannot see the screen cannot tell a working app from a crashed one.
Silence and failure are the same experience, and a journey that goes quiet for
four minutes gets abandoned by someone standing next to a road.

That does not license periodic speech, because the rule above is also true. It
licenses **proof of life in a channel that does not mask traffic**:
`lib/journey/pacer.ts` emits a `soft` earcon and a 60 ms haptic — no words —
after a state-dependent silence, at `low` priority so anything with real news
outranks it. Guidance level is the rider's control: `minimal` is silent,
`standard` (default) is the tone, `detailed` adds a short line.

The heartbeat reads the last time **anything** was spoken, ladders included, so
a busy stretch suppresses it entirely — it fills silence, and there is no
silence to fill.

**Questions are the exception to the exception.** `confirming_boarding` and
`confirming_exit` block the journey until answered, so an unheard question is a
stalled journey — and the rider cannot tell that from a quiet one. Those re-ask
with words at **every** level, `minimal` included, on a ~25 s cooldown, at
`normal` priority — never `critical`, so a re-ask can never cut off "Одоо
буугаарай".

## Estimate versus sighting

**The most important distinction in the waiting half of the app.** "The bus is
arriving" asserts a vehicle was observed. "The timetable says a bus is due"
asserts only that a schedule exists. A rider steps off a kerb into traffic on
the strength of the first, and **we have never observed a vehicle.**

`Journey.busDueSource` carries `"timetable" | "live"` beside every `busDueAt`,
and `evidenceFor` in `lib/journey/types.ts` is the **only** place `Arrival.source`
becomes that claim. `headway` maps to `timetable`, not `live` — a headway
average is further from an observation than a schedule, not closer.

**Two hedges, and they are not interchangeable.** `ойролцоогоор` hedges the
NUMBER; `ui_timetable_prefix` ("Цагийн хуваарийн мэдээллээр") hedges the CLAIM.
"In approximately four minutes" still sounds like something is being watched.
Both are required, the claim-hedge leads — a hedge after the number is a
correction, and the rider has already acted on the number.

- An **unattributed** time is spoken as the weaker claim, never the stronger.
- Asked about the bus directly, the guide adds `ui_timetable_no_live`. On a
  routine status read it does not — a caveat every time is a caveat unheard.
- The screen carries the same label in **words** (`Цагийн хуваарь` / `Шууд
  байршил`), never as a colour. A test asserts no headline can claim an arrival.

If the feed ever opens, `evidenceFor` is the single switch and the prefix simply
stops being selected.

## Which platform — the two-side problem

A named stop here is almost always **two platforms**, one per direction, with
different stop ids and opposite route directions. Board the wrong one and you
ride away from where you are going, and a blind rider cannot see that happen.

**It cannot be sensed, and both obvious approaches were measured and rejected.**
Over the shipped 923 stops: **351 opposite-side pairs, 334 sharing a route.**

| | |
| --- | --- |
| separation | min 0 m · median **82 m** · p95 199 m |
| inside `MAX_MATCH_M` (150 m) | **310 of 351 — 88%** |
| inside `CONFIDENT_ACCURACY_M` (60 m) | 100 of 351 |

So GPS cannot choose between them; a position-derived "you are on the north
platform" is a coin flip wearing the costume of a measurement.

**Geometry cannot choose either, and this is the counter-intuitive part.** The
angle between the platform-to-platform line and the route heading has a median
of **15°**, and only 45 of 341 pairs exceed 45°. Real platform pairs are
staggered **along** the road, not across it — so there is no honest way to say
"cross the road" from this data. Do not add one.

**What is done instead: derive, then name.** The destination determines the
platform — `planJourney` already picks whichever boarding stop reaches it — so
the side is derived, never measured. Then it is spoken: **876 of 923 names carry
the side as a word** (Хойд · Урд · Баруун · Зүүн) and `stopNameToSpeech` already
keeps it ("Саппоро, Урд"). That word is on the physical sign and is the word to
say to a passerby, so naming the platform costs no new audio and is worth more
than any amount of sensing.

`lib/transit/platform.ts` owns the parse, the opposites, and `boardingRelation`.
Every plan option names its boarding platform whenever it is not the one the
rider is standing at.

## The boarding gate

**Never infer that a rider boarded.** There is no vehicle feed, so boarding
cannot be observed. The flow used to write a handoff and push straight to
`/bus/ride`, which starts counting stops — so picking a bus off a list was
treated as being on it, typically minutes before anything arrived, and every
announcement for the rest of the ride rested on that.

`/bus/board` holds the wait and asks. The machine in `lib/journey/machine.ts`
has **no path into `on_bus`** that does not pass through `confirming_boarding`
and a `boarding_answered` carrying the rider's own yes — asserted over the
transition table itself in `machine.test.ts`, so a shortcut added later fails
there rather than in a bus.

Answering "no" is **not a failure and is never phrased as one**. A missed bus is
an ordinary event at a bus stop: `missedBuses` increments, the stale estimate is
dropped, the alternatives appear, and the wait continues.

`bus_due` means **the timetable ran out**, never that a bus was seen — one
definition, owned by `countdownFor`.

**An expired estimate is not an arrival and not a departure.** When `countdownFor`
returns `gone`, the app knows only that a printed time has passed — not that a
bus came, not that it did not. It says exactly that (`ui_confirm_expected_now`)
and asks. `boardingAskReason` carries `"due" | "expired"` so the wording follows
the reason rather than being re-derived from a clock.

**Three answers, not two.** `boarded` / `not_boarded` / `unsure`. Forcing a
yes/no on a rider who genuinely cannot tell produces a guess, and a guessed yes
starts a stop countdown for a bus nobody is on. `unsure` resolves toward safety:
never `on_bus`, and it does **not** increment `missedBuses` either — we have no
evidence a bus was missed, only that the rider cannot tell us, and inventing one
would be the app filling in its own facts.

## Journey state

`lib/journey/` is the source of truth for an active journey. All pure and tested
(80 tests):

| module | owns |
| ------ | ---- |
| `types.ts` | the one `Journey` object, 13 states, evidence, guidance levels |
| `machine.ts` | legal transitions as data; illegal events rejected, not applied |
| `pacer.ts` | when to speak unprompted — the heartbeat and the question re-ask |
| `guide.ts` | what to answer when asked; deterministic, never generative |
| `present.ts` | journey → headline, detail, actions, progress step |
| `assistant.ts` | the contextual "Асуух" menu, per state |
| `settings.ts` | guidance level + heartbeat, persisted to localStorage |
| `audio-fallback.ts` | what happens when a clip is missing |

**Screens own input, never journey state.** `/bus/wait` keeps an `InputMode`
(locating / listening / browsing / …) because a rider speaking a destination and
a rider scrolling a list are in the *same* journey state — `selecting_destination`
— and only the input differs. Modelling input as journey state is what produced
nine phases on one screen and no way to say where the rider was. The three former
failure phases are journey **faults** now, so the guide can answer for them from
anywhere.

`/bus/board` uses the `useJourney` hook. `/bus/wait` and `/bus/ride` drive the
same pure modules with their own audio plumbing, and **must**: the ride screen
owns page-lifecycle and interruption instrumentation, the wait screen speaks
through `playSequence`, and giving either a second `AudioQueue` would put two
pipelines on one `AudioContext`.

**Missing audio is never silence.** The queue plays what resolved and still fires
the earcon and haptic; `audio-fallback.ts` logs each missing key once in dev with
the command that renders it. The TTS rung is defined and **deliberately not
wired** — `NO_SPEECH_FALLBACK` is what ships, because a confident English phoneme
set reading Mongolian Cyrillic at a kerb is worse than a gap a rider recognises
as a gap.

The guide is **deterministic, not generative**. It answers "where am I" / "how
many stops" from the journey object by template. That is what makes the safety
gate above hold by construction: every `stop_*` / `route_*` key it can emit is
built from an id already on the journey, which got there through the matcher.
It also works offline and gives the same words for the same situation every
time, which is what a rider navigating by ear actually wants.

### "Boarding ladder" names two different things — only one of them ships

This was one line for a long time and it hid a fact that matters: **the boarding
ladder that ships is not the one described below it.** Check which you mean
before changing either.

**WAITING — time-based. This is the one that ships.** `lib/transit/eta.ts`,
live on the wait screen. Driven by arrival estimates from the OTP proxy, which
is schedule data, so every minute it speaks is hedged and cannot be unhedged by
a caller.

| Rung | Marks | Channels |
| ---- | ----- | -------- |
| `ALERT_MINUTES` | 10 · 5 · 3 · 1 minutes, then `due` | speech (`bus_approx_prefix` + `num_N` + `bus_minutes_suffix`, all-or-none) · haptic (`waitVibration`, `DUE_VIBRATION`) |

Marks are crossed against the PREVIOUS countdown, not wall-clock, so a
backgrounded screen or a skipped poll announces the mark late rather than losing
it. It never fires on first observation — that is the initial announcement's job.

**WAITING — stops-away. Specified, built, and CANNOT RUN.** `boardingRung` in
`lib/countdown/ladder.ts`: silent ≥6 stops · optional at 5 (default off) · 3 · 2
· 1 (alert) · vehicle within 80 m (urgent).

It counts a *vehicle's* position toward the rider's stop, and vehicle positions
come from the City feed, which is dark (see "Out of scope"). `PositionSource`
has an `eta_inferred` member that could drive it from schedule data instead, but
nothing in the repository produces one. So `boardingRung` has no announcement
builder, no caller, and no input. **Do not wire it. Do not count it as the
boarding half being covered — `eta.ts` is that.**

**ALIGHTING — stops-away. Ships.** silent >3 stops · 3 · 2 · 1 (alert, "press the
button") · arrival (urgent) · overshoot (priority 0).

Two rules the table above does not carry:

- Rung 1 is suppressed below `RUNG1_MIN_LEAD_S`. Where the last two stops sit
  close together, "get ready" and "get off now" land together, and a rider then
  gets a preparation signal and an action signal at the same moment — which is
  less than the action signal alone, and the preparation one is cut off mid-word
  by it. The time is absent from the geometry; no threshold can manufacture it.
- Overshoot repeats for `OVERSHOOT_REPEAT_STOPS` stops and then stops, and every
  follow-up re-speaks `bus_passed_stop`. The suffix says "N stops have passed"
  and does not name the missed stop, so without the anchor the third follow-up
  is a bare number several minutes adrift from what it refers to.

**Scheduler invariants:**

- One `AudioContext`, one pipeline. Announcements never overlap.
- **`expiresAt` is mandatory on every announcement.** A message queued behind a longer one must be dropped once state moves on. Saying "two stops left" after arrival is worse than silence.
- `dedupeKey` + `cooldownMs` suppress repeats silently.
- Priority 0 (wrong bus, overshoot) preempts mid-clip.
- **Never speak while the mic is open.** Push-to-talk holds a lock; queued items still respect `expiresAt`.
- Earcon leads speech by 250 ms so the rider can attend before the first word.
- Speech, earcon, and haptic carry the same state. Any one alone must be sufficient to act on — UB buses are loud enough that audio alone fails regularly.

**Announcements do not go through `aria-live`.** Use the controlled audio element. TalkBack/VoiceOver keeps ownership of the DOM; competing for it produces double-speaking.

## Background survival

A browser tab on a locked phone dies mid-journey, which invalidates every other feature here. Required and load-bearing:

- Screen Wake Lock while a journey is active, re-acquired on `visibilitychange`.
- Media Session + looping silent audio track — keeps the audio pipeline alive **and** provides headphone controls: single click = repeat last announcement, double click = status query.
- On `resume`, reconcile state before speaking. If >90 s elapsed, re-fetch first. Never announce stale state after a suspension.
- Journey must complete entirely on cached data. Network loss mid-ride is expected, not exceptional.

## Polling budget

Mobile data is metered and a real cost to users. Adaptive rates: >6 stops 30 s · 3–6 stops 15 s · ≤2 stops 8 s · riding >3 stops 20 s · riding ≤3 stops 10 s · **inactive journey polls not at all**. Errors back off to 60 s with jitter. Battery <15 % halves all rates and announces once.

## Strings

All user-facing Mongolian lives in one file. Current strings are drafts pending native review and will be rewritten wholesale — do not scatter them into components.
