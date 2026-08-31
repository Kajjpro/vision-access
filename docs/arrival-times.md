# Arrival times

## The rule

**A countdown is never stored. It is derived, at the moment of speaking, from an
absolute arrival instant against the current clock.**

`Arrival.arrivesAt` (epoch ms) is the only field any spoken minute may come
from. `Arrival.minutes` still exists, is still populated, and is for the
on-screen debug panel — nothing reads it, and `lib/transit/eta.test.ts` sets it
to a contradictory `99` on every fixture so that anything which starts reading it
fails loudly.

`countdownFor(arrival, now)` in `lib/transit/eta.ts` is the single place a
countdown is produced. It returns one of four states, and the distinctions
matter:

| state | meaning | spoken as |
|---|---|---|
| `minutes` | 1..40 minutes out | "Ойролцоогоор N минутын дараа" |
| `due` | inside ±90 s of the arrival instant | the hedged one-minute wording |
| `gone` | past the grace window | nothing — the option offers no time |
| `unknown` | no absolute time, or past the last cardinal clip | nothing |

`due` may **never** borrow the live arrival vocabulary — "ирлээ", "ойртож
байна". Those are gated in `lib/transit/journey.ts` on a vehicle we watched
move, and they are the strings that make a blind rider step toward a road. They
have to keep meaning "a bus is verifiably there".

## Why: three ways the minute was wrong at once

Reported from a phone as "the minute is incorrect". It was, for three unrelated
reasons, and each on its own was enough.

**1. The number was frozen at fetch time.** The proxy computed
`minutes = (leg.startTime - now) / 60000` and shipped an integer. That integer
then passed through a 45-second server cache into `WaitScreen`, which fetched
once, held the response in state, and never re-based it. A rider cycling four
route options by ear — each one spoken in full, at a bus stop, with a decision to
make — is on that screen for minutes, and heard the same opening number
throughout. Nothing expired it either: once `startTime` had passed, the stored
value was still positive, so the app went on promising a bus that had gone.

A sighted passenger glances at a countdown board and catches it when it lies.
Someone relying on this voice cannot: the number they are told **is** the world.

**2. The times belonged to a different stop.** One request was made, for
`plans[0].legs[0].boardStopId`, and every option then looked its own route up in
that one response by route id alone. Boarding platforms are collected within
400 m (`BOARDING_RADIUS_M`) and the two directions of a route share no stop ids,
so the second and third suggestions routinely board somewhere else — and were
given the first platform's times. Arrivals are now keyed by the stop they were
fetched for, and an option can only read its own platform's.

**3. The minute was never actually spoken.** `bus_approx_prefix`, `num_N` and
`bus_minutes_suffix` live in the **transit** manifest (`lib/transit/speech.ts`),
not in `lib/phrases.ts`. The wait screen assembled those three keys inline and
handed them to `say()`, which silently drops any clip that is not decoded — and
nothing on that screen ever called `loadTransitClips` for them. So the time was
deleted from every announcement and the rider heard the route name alone. The
number was visible only in the on-screen debug label, which is precisely the half
of the interface the user cannot reach.

`COUNTDOWN_CLIP_IDS` now exists so a screen loads exactly what it is going to
speak, and `countdownKeys` returns **all three keys or none** — a suffix whose
number failed to decode leaves "Ойролцоогоор … минутын дараа" with a hole in the
middle, which sounds like a number that was said and misheard.

## What each suggested bus now says

Which bus, how far, then when — the same order every time, because someone
navigating by ear relies on the shape being constant:

> «Ч:35. Арван хоёр буудал явна. Ойролцоогоор таван минутын дараа.»

The stop count is the **journey length**, not stops until the bus reaches the
kerb. The latter would need live vehicle positions and the City feed is dark
(see `city-gateway.md`); claiming it from a timetable would be inventing the one
number a rider would actually act on.

## The wait, narrated

Deriving on demand made something possible that a frozen number could not: the
countdown can speak up as it changes.

- **`ALERT_MINUTES = [10, 5, 3, 1]`** — the only marks that change what a person
  does: enough time to still be walking, time to be at the kerb, time to have the
  card out, and now. Not a countdown every ten seconds, which trains someone to
  stop listening.
- Crossing is evaluated against the **previous value**, not a wall-clock timer,
  so a backgrounded phone or a skipped poll still announces the mark once on the
  next tick rather than missing it.
- It never fires on the first observation — that is the opening announcement's
  job, and firing both says it twice half a second apart.
- It follows the option **under the cursor** and always names the route, so "one
  minute" is never ambiguous about which bus.

**The haptic ladder goes out with it** (`waitVibration`, `DUE_VIBRATION`), in the
same module as the speech so the two cannot drift apart — the same reason
`vibrationFor` lives next to `announceRemaining`. Patterns get shorter and more
insistent as the bus closes. This is the one channel that survives a phone in a
coat pocket, traffic on Peace Avenue, and gloves, which describes most of a
Ulaanbaatar winter at a bus stop.

Arrivals re-fetch every 60 s while the routes list is up (one call per distinct
platform, capped at `MAX_ARRIVAL_STOPS`), so the countdown stays true for as long
as someone is actually waiting. Past `STALE_AFTER_MS` a payload stops being
spoken from at all rather than being narrated from a plan that has since been
superseded.

## The hedge is still structural

Nothing above weakens it. Every number the app can produce about a bus is
schedule- or headway-derived, `countdownKeys` puts "Ойролцоогоор" in front of it,
and there is no call site that assembles a time without going through that
function. `announce.test.ts` and `eta.test.ts` assert it against real output
rather than by reading the code.
