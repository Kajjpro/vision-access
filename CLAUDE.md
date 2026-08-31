# Journey Countdown & Announcements

> Decisions in this section were reached deliberately and have non-obvious rationale.
> Do not change a constant or invariant here without reading the "why" line attached to it.

## Audio pipeline invariants

- **No runtime TTS.** All speech is pre-rendered Azure `mn-MN-YesuiNeural`. If a string cannot be spoken from the manifest, the correct behaviour is to degrade to a generic clip and log — never to synthesize, never to fall back to browser `speechSynthesis` (its `mn-MN` support is absent or unusable on target hardware).
- **Whole-sentence clips, not fragment concatenation.** Two reasons, both hard blockers: (a) Mongolian numerals take attributive forms before nouns — `гурав` + `буудал` is ungrammatical, it must be `гурван буудал`; (b) concatenated fragments carry sentence-final intonation mid-sentence, which is measurably harder to parse in traffic noise. Fragment concat exists only as a marked fallback for rare slot combinations.
- **Attributive numeral forms** (used in all count templates): 1 нэгэн · 2 хоёр · 3 гурван · 4 дөрвөн · 5 таван · 6 зургаан · 7 долоон · 8 найман · 9 есөн · 10 арван.
- **Route-scoped preload.** Ship name-only clips for all 923 stops in the offline bundle (~5.5 MB). Fetch and pin the full template set for the active route on journey start (~240 clips, ~1.5 MB). Do not ship the full cross-product — it does not fit.
- **Clip filenames are content-hashed**; `data/audio-manifest.json` is the source of truth. `scripts/render-audio.ts` is idempotent and diffs against the manifest.
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

Boarding ladder: silent ≥6 stops · optional at 5 (default off) · 3 · 2 · 1 (alert) · vehicle within 80 m (urgent).
Alighting ladder: silent >3 stops · 3 · 2 · 1 (alert, "press the button") · arrival (urgent) · overshoot (priority 0).

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
