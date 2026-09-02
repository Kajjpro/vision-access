# City gateway — Task 0 findings

Probed 2026-08-10 against `gateway-city.hamuga.mn/ubtransport`.

**Status: the live vehicle feed has never been observed.** No account credentials
exist, so every question that depends on seeing a vehicle is unanswered. What is
recorded below is split strictly into what was *measured* and what is *blocked* —
nothing here is inferred from what a transit API usually looks like.

---

## 0.1 Auth — shape answered, lifetime unknown

**The brief's premise is wrong in a way that matters.** This gateway is not
"token auth, not `x-api-key`". It is **both, in series**:

| Request | Response |
|---|---|
| no headers | `401` · `www-authenticate: Key realm="kong"` · `"No API key found in request"` |
| `x-api-key: $HAMUGA_API_KEY` | `401` · `"Токен хугацаа дууссан эсвэл буруу байна"` |

The message changes between those two rows. Our **existing** `HAMUGA_API_KEY`
authenticates at the Kong edge on this host — the same key used for
`gateway.hamuga.mn`. Only then does an application-layer token check reject us.
So the console's generated curl lacking a key header did not mean the key was
unnecessary; it meant the console was already past Kong.

### The login contract

Derived by probing, not from docs:

```
POST /ubtransport/auth/login
Content-Type: application/json
x-api-key: <HAMUGA_API_KEY>

{"phone": "<string>", "password": "<string>"}
```

Evidence for each element:

| Sent | Response | What it proves |
|---|---|---|
| `{}` | `400` `Field validation for 'Phone' failed on the 'required' tag` (and `Password`) | Go service, struct `Login`, both fields required |
| `{"phone": 99999999, …}` | `400` `cannot unmarshal number into Go struct field Login.phone of type string` | `phone` is a **string**, and the JSON tag is lowercase `phone` |
| `{"phone":"99999999","password":"x"}` | `400` `"Нууц үг буруу байна."` | wrong password ≠ unknown user; the endpoint does not leak which |

This is a **user account** — a phone number and password — not a service
credential.

### Credentials supplied 2026-08-10 do NOT authenticate

`CITY_PHONE` (8 digits) and `CITY_PASSWORD` (4-digit PIN) were added to
`.env.local`. Both parse cleanly — no whitespace, no stray quotes. Login still
returns `400 "Нууц үг буруу байна."`

The phone **format is correct**: a `phone` validator tag exists and rejects
country-code prefixes with a *different* error
(`failed on the 'phone' tag` for `976…`, `+976…`, `00976…`), so our bare 8
digits are passing validation and reaching the credential check.

**The failure cannot be diagnosed from outside.** The endpoint returns the
identical message for all three of:

| | |
|---|---|
| real phone + real password | `400 "Нууц үг буруу байна."` |
| real phone + junk password | `400 "Нууц үг буруу байна."` |
| nonexistent phone + real password | `400 "Нууц үг буруу байна."` |

So "wrong PIN" and "no such account on this gateway" are indistinguishable —
good practice on their part, but it means the next step is confirming with
Hamuga whether the VisionAccess registration actually provisioned an account,
rather than anything that can be resolved by probing. No lockout or throttling
was observed across ~30 requests.

Re-run with `node --env-file=.env.local scripts/probe-city.mjs auth` — the
script prints token *shape* and JWT lifetime, never the token or credentials.

### Token lifetime: UNKNOWN, and unknowable without an account

The response body of a *successful* login has never been seen, so the token's
field name, format, and expiry are all unverified. Do not assume JWT; do not
assume an `expires_in`.

`/auth/refresh` **cannot be confirmed to exist.** The token middleware runs
*before* routing — `/auth/definitely-not-real-xyz` returns the identical `401` —
so a 401 on `/auth/refresh` is equally consistent with "exists, needs a token"
and "does not exist". Refresh handling must therefore be written defensively:
re-login on 401 rather than assuming a refresh endpoint is there.

### There is no way in without logging in

Every path was probed with a valid `x-api-key`. Exactly two are exempt from the
token check:

| Path | Result |
|---|---|
| `/ubtransport/health` | `200 OK` — exempt |
| `/ubtransport/auth/login` | `400` validation — **exempt** |
| `/ubtransport/auth/{refresh,token,register,guest,device,anonymous,otp}` | `401` token message |
| `/ubtransport/ubcard-api/{vehicles,routes,stations,kiosks}` | `401` token message |
| `/ubtransport/definitely-not-real-xyz` | `401` token message |
| `/ubcard-api/vehicles` (outside `/ubtransport`) | `404` Kong `"no Route matched with those values"` |

`/ubtransport` is the only Kong service on the host. There is no guest path, no
device path, and no self-registration — `/auth/register` is itself behind the
token, so an account cannot even be created through this gateway.

---

## 0.2 Is it live — BLOCKED

Not answerable. `/ubcard-api/vehicles` has never returned a body. Vehicle count,
coordinate plausibility, and the 20 s / 60 s position diff all require a token.

**This must not be skipped once credentials arrive.** The endpoint existing is
not the finding; the positions *changing* is.

---

## 0.3 Freshness — the important part is decidable now

The documented vehicle shape carries no timestamp:

```json
{ "id": 1234, "plate_number": "1234 УБА", "route_name": "Ч-1",
  "speed": 45, "bearing": 90, "latitude": 47.92, "longitude": 106.93 }
```

That has a hard consequence, and it does not depend on ever seeing the feed:

> **Absolute freshness is not recoverable from this payload.** Nothing in a
> response says when it was true. We can only ever measure *change since our own
> previous poll*. A feed frozen before our first poll is, on that first poll,
> indistinguishable from a live feed of stationary buses.

So staleness is detectable only in the positive direction, and only after two
polls. Two signals are available, and they differ in strength:

**Weak — set-level change.** If any vehicle moved between polls, the feed was
live at some point inside the poll interval. Absence of movement proves nothing:
at 03:00, or in a jam, a live feed is legitimately static.

**Strong — per-vehicle speed/displacement contradiction.** A vehicle reporting
`speed: 45` whose position is bit-identical across a 60 s gap is a stale record,
because 45 km/h for 60 s is 750 m. This is a genuine per-vehicle staleness
detector and it does not need a timestamp. Formally, flag a vehicle stale when:

```
speed > SPEED_MOVING_KMH  AND  displacement < speed * elapsed * TOLERANCE
```

Both signals are contingent on `speed` actually being populated and honest,
which is **unverified**. If `speed` turns out to be always 0, or a constant, the
strong detector is gone and only the weak one remains.

### Therefore, plainly

**Arrival must not be announced from a vehicle we have not personally watched
move.** "Ч:35 ирлээ" requires a positive freshness observation within a recent
window — a tracked vehicle whose position changed on our own last poll. On a
first poll, after a reconnect, or for any vehicle failing the consistency check,
the correct output is the hedged schedule estimate, explicitly flagged.

If `speed` proves unusable and the vehicle set proves static, then freshness is
genuinely undetectable, and in that case **we cannot safely announce arrivals at
all** — the live path must be abandoned in favour of the schedule path rather
than shipped with a caveat.

---

## 0.4 The route-name join — answered on our side

Measured against all 84 routes in `public/transit/routes.json`.

### The inconsistency is in OUR data, not only the gateway's

The brief frames this as feed-uses-hyphen vs we-use-colon. That is not the whole
picture:

- **83 of 84** of our own names use a colon: `Ч:35`, `М:4`, `ШҮ:1`
- **1 of 84 already uses a hyphen**: **`Ч-38`** (U+002D)

So the separator must be normalised on *both* sides. A join written to convert
only the feed's hyphens to colons would leave `Ч-38` unmatched — one route
silently dark.

### Four rules, each forced by real data

**1. Separator → canonical.** Any of `:` `-` `/` `.` whitespace, one or more,
collapses to a single separator. Forced by `Ч-38`.

**2. Case-fold the suffix letter.** Suffixes are inconsistently cased in our own
data: `Ч:16а`, `Ч:24б`, `М:3а`, `Ч:7а` are lowercase; `Ч:17А`, `Ч:18Б`, `Ч:48А`
are uppercase. Verified: folding to uppercase produces **no collisions** across
all 84.

**3. Fold Latin homoglyphs to Cyrillic.** The prefixes use Cyrillic `А`(U+0410)
`М`(U+041C) `Х`(U+0425) `Т`(U+0422) `З`(U+0417) `С` `Е` `О` `Р` `В` `Н` `К`,
every one of which has a visually identical Latin twin. A feed emitting Latin
`M-1` would fail an equality test against Cyrillic `М:1` while looking correct
in every log and error message. This is the failure mode most likely to survive
code review.

**4. Strip leading zeros in the numeric part.** Verified safe — no pair like
`Ч:9`/`Ч:09` exists, so this cannot merge two real routes.

Applying all four: **all 84 route names normalise to 84 distinct keys. No
collisions.**

### Two hard prohibitions

**Never prefix-match.** Eight families would announce the wrong bus:

| | |
|---|---|
| `М:1` vs `М:1Б` | `Ч:24б` vs `Ч:24А` |
| `Ч:17А` vs `Ч:17Б` | `Ч:48` vs `Ч:48А` |
| `Ч:18А` vs `Ч:18Б` | `Ч:57` vs `Ч:57Б` |
| `Ч:20А` vs `Ч:20Б` | `Ч:21А` vs `Ч:21Б` |

`Ч:48` is a strict prefix of `Ч:48А`. Only full normalised-key equality is safe.

**Never join on the bare number.** The prefix is load-bearing — 10 numbers are
ambiguous across prefixes:

```
4  → ШҮ:4, М:4, АТ:4, ЗҮ:4      2  → Д:2, ШҮ:2, М:2, Х:2
6  → Д:6, М:6, Х:6              1  → ШҮ:1, М:1, Д:1
5  → Д:5, АТ:5                  9  → Ч:9, Д:9
11 → Х:11, Д:11                 12 → Х:12, Д:12
13 → Х:13, Д:13                 23 → Ч:23, Х:23
```

If the feed emits `route_name` without a prefix, **the join is impossible** for
these ten and they must fall back to schedule rather than guess.

### Still unverified

The feed's actual `route_name` values. The rule above is derived from one
documented example (`Ч-1`) plus our own 84. Whether the feed uses Cyrillic or
Latin, pads numbers, or carries suffixes at all is unknown until a token exists.
**Every one of the 84 must be re-checked against real values**, and any route
that fails to map reported by name.

---

## 0.5 Direction — inferable, with a large margin

### First: we have no route shapes

The brief asks about "projecting position and bearing onto our route shapes."
**Those shapes do not exist.** `/api/gtfs/v1/shapes` returns rows with
`shapes: null` and empty `route_id` (`probe-output/02-gtfs_shapes.sample.json`),
and nothing under `public/transit/` carries a polyline. The only geometry we
have is the **ordered stop sequence** in `route-stops.json` — a coarse polyline
with ~568 m median spacing.

### Measured separability

Using stop-to-stop chords as the route shape, for all 84 routes carrying both
directions: sample each segment of direction 0, find the nearest segment of
direction 1, and compare bearings.

```
segments sampled                                    1253
of which the opposite direction runs within 120 m    739
  bearings OPPOSED (>90° apart) — separable          739
  bearings SIMILAR (≤90°)      — ambiguous             0
```

Angular separation across those 739:

| min | p1 | p5 | median | max |
|---|---|---|---|---|
| **90°** (`Ч:61`) | 156° | 164° | **179°** | 180° |

Only **one** segment in 739 falls below 120° separation.

### Verdict

Direction is inferable, and the error budget is generous: misclassification
needs roughly **45° of bearing error** before even the tightest case (`Ч:61`,
90° apart, 76 m separation) flips. The remaining 514 segments have no nearby
opposite-direction segment at all, so position alone separates them — the easier
case.

Reliability is therefore **not limited by our geometry**. It is limited by
whether the feed's `bearing` field is populated and truthful, which is
unverified. A stationary bus has no meaningful bearing, so the rule must be:
infer direction only when `speed` is above a walking threshold, and otherwise
carry the direction forward from the last confident inference.

---

## 0.6 Coverage — BLOCKED

How many of the 84 routes report vehicles cannot be known without the feed. The
requirement stands regardless: **a route with no vehicles falls back to schedule,
never to silence.**

---

## 0.7 `/ubcard-api/stations` cross-check — BLOCKED

Cannot be fetched. Note the shape difference to reconcile when it can be: the
gateway keys direction as `up_down` with **1 = inbound, 2 = outbound**, while
`route-stops.json` keys directions **`"0"` and `"1"`**. That is an off-by-one
trap — `up_down: 1` is *not* our direction `1`. The mapping must be established
from data, not assumed, and any disagreement in stop sequence reported before
anything is changed.

---

## Blocker found that is independent of the feed

**The app cannot speak a single route number today.**

| | count |
|---|---|
| `route_*` clips in `public/audio/transit/manifest.json` | **0 of 84** |
| `spokenName` filled in `routes.json` | **0 of 84** |
| `stop_*` clips | 153 of 923 |
| `num_*` clips | 40 |
| `bus_*` phrases | 16 |

`announceRoute()` in `lib/transit/announce.ts` already handles this correctly —
it falls back to `bus_unnamed_stop` and reports the gap rather than going silent
— but the consequence is that **every** route announcement is currently the
generic phrase.

This blocks the Task 2 line "Сансар руу явахад **Ч:35** хэрэгтэй" and the Task 3
lines "**Ч:35** хоёр буудлын зайд" and "**Ч:35** ирлээ" — none of which can be
spoken as written. Rendering 84 route clips is a prerequisite for the journey
flow, and it is entirely independent of the live feed.
