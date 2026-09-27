/**
 * What is worth saying, and when.
 *
 * WHAT THIS FILE IS FOR. The detector answers "what is in frame". The tracker
 * answers "which of those are the same object as last frame". Neither answers
 * the question a person walking actually has, which is "is there anything I
 * need to know RIGHT NOW" — and the honest answer to that is usually no.
 *
 * Before this existed, WalkMode spoke whenever a track was in the corridor and
 * a timer had expired. That is a narrator, not a guide: a pavement holds a
 * dozen announceable things, and a narrator reads all of them, forever, in a
 * loop, while the user tries to hear a bus. The rule here is the opposite —
 *
 *     Do not describe everything. Say what changed.
 *
 * — and everything below is an implementation of that one sentence.
 *
 * THREE THINGS CHANGED, and they are separable on purpose:
 *
 *   1. WHAT COUNTS AS RELEVANT widened. The corridor is no longer the whole
 *      story: something closing fast from outside it — the cyclist coming up
 *      the pavement on your right — used to be invisible to this app, and it
 *      is the hazard a white cane is least able to find. See isRelevant().
 *
 *   2. WHAT IS SAID got more specific. Direction is spoken, not just panned,
 *      so a warning survives one earphone and a noisy street. See bearingOf().
 *
 *   3. HOW OFTEN it is said collapsed. A SpeechGate keeps the utterance quiet
 *      unless its CONTENT is new, and lets it through immediately when the
 *      situation materially changes. (1) and (2) both cost speech budget;
 *      (3) is what pays for them, and then some.
 *
 * Everything here is pure and synchronous: no audio, no DOM, no clock of its
 * own. `now` is always passed in. That is what makes the policy testable
 * without a camera, which matters more here than anywhere else in the app —
 * the failure mode being guarded against is one that only shows up over tens
 * of seconds of real walking, and nobody debugs that on a phone.
 */
import { nameMinScore } from "./coco";
import { announcementFor, distanceBucket } from "./distance";
import type { CameraPose, DistanceBucket } from "./distance";
import { isApproaching, isOverhead } from "./path";
import type { Track } from "./tracker";

// ---------------------------------------------------------------------------
// Bearing — where a thing is, in words
// ---------------------------------------------------------------------------

/**
 * Horizontal position, quantised to what is worth saying out loud.
 *
 * Five bands, not three, because "slightly to your left" and "on your left"
 * are genuinely different instructions to a body: one is something you will
 * brush past, the other is something you would have to turn toward.
 */
export type Bearing = "left" | "slightly_left" | "ahead" | "slightly_right" | "right";

/**
 * Band edges as a fraction of frame width.
 *
 * The centre band is DELIBERATELY WIDE — 0.35 to 0.65, a third of the frame.
 * The walking corridor is 0.25..0.75, so most of what gets announced sits in
 * the middle here and is described with no direction word at all. That is the
 * point: a narrower centre would put "бага зэрэг зүүн талд" on nearly every
 * warning, half a second each, to tell the user something they had already
 * assumed.
 */
const BAND_FAR_LEFT = 0.15;
const BAND_LEFT = 0.35;
const BAND_RIGHT = 0.65;
const BAND_FAR_RIGHT = 0.85;

/** Which side of the frame a bearing is on. Used to detect a real crossing. */
function side(bearing: Bearing): -1 | 0 | 1 {
  if (bearing === "left" || bearing === "slightly_left") return -1;
  if (bearing === "right" || bearing === "slightly_right") return 1;
  return 0;
}

export function bearingOf(box: { x: number; w: number }, pose: CameraPose): Bearing {
  if (pose.frameWidth <= 0) return "ahead";
  const centre = (box.x + box.w / 2) / pose.frameWidth;
  if (centre < BAND_FAR_LEFT) return "left";
  if (centre < BAND_LEFT) return "slightly_left";
  if (centre < BAND_RIGHT) return "ahead";
  if (centre < BAND_FAR_RIGHT) return "slightly_right";
  return "right";
}

/**
 * The clip that speaks a bearing, or null when it is not worth speaking.
 *
 * `ahead` returns null and there is no `dir_ahead` wav. Straight ahead is the
 * default assumption behind every warning this app gives, so the word carries
 * no information and costs half a second out of a 1.5-second budget. Direction
 * is spoken only when it is news.
 */
export function bearingClip(bearing: Bearing): string | null {
  switch (bearing) {
    case "left":
      return "dir_left";
    case "slightly_left":
      return "dir_slightly_left";
    case "slightly_right":
      return "dir_slightly_right";
    case "right":
      return "dir_right";
    case "ahead":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Relevance — what is even a candidate
// ---------------------------------------------------------------------------

/** The walking corridor: the middle 50% of the frame. */
export const CORRIDOR_MIN = 0.25;
export const CORRIDOR_MAX = 0.75;

/**
 * How soon an off-corridor object must reach the user to be worth mentioning.
 *
 * THE GAP THIS CLOSES. Only the corridor was ever considered, so a bicycle
 * closing at 4 m/s down the right-hand side of the pavement was detected,
 * tracked, measured, and never spoken about — right up until it entered the
 * corridor, which is roughly the moment of impact. It is also precisely the
 * hazard a white cane cannot report: the cane covers the ground in front of
 * the feet, not a fast object arriving from the side.
 *
 * Four seconds because that is about the shortest warning a walking person can
 * still act on, and because the gate is TIME rather than distance on purpose:
 * a parked car two metres to the left has an infinite time-to-contact and
 * stays silent, which is correct — it is not going anywhere, and the user is
 * not walking into it.
 */
export const APPROACH_TTC_S = 4;

/**
 * Whether this track is a candidate for the announcement channel at all.
 *
 * Two independent reasons to qualify, and nothing else gets in:
 *
 *   - It is in the walking corridor. The thing being walked toward.
 *   - It is closing fast and will arrive soon. The thing walking toward you.
 *
 * Everything else in frame — the parked cars, the pedestrians on the far
 * pavement, the dog thirty metres away — is real, correctly detected, and
 * deliberately not mentioned. That is the whole discipline of this file.
 */
export function isRelevant(track: Track, pose: CameraPose): boolean {
  if (pose.frameWidth > 0) {
    const centre = (track.x + track.w / 2) / pose.frameWidth;
    if (centre >= CORRIDOR_MIN && centre <= CORRIDOR_MAX) return true;
  }
  return isApproaching(track) && track.ttcS <= APPROACH_TTC_S;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * How much of the recent evidence must agree on the class before its name is
 * spoken. 0.6 is "clearly ahead", not "unanimous" — see Track.classConfidence.
 */
export const MIN_CLASS_CONFIDENCE = 0.6;

/**
 * Whether the app is sure enough of WHAT this is to say the word out loud.
 *
 * Two independent bars, because there are two different ways to be unsure and
 * only one of them is visible in a single frame:
 *
 *   - `score` is the detector's own confidence, averaged over the frames that
 *     voted for the winning class. A weak box is a weak box however consistent.
 *   - `classConfidence` is how much of the recent evidence agreed. A detector
 *     that alternates "car" and "truck" is confident twice per second and
 *     right at most half the time, and no single-frame score can catch that.
 *
 * Failing either one costs the NAME and nothing else. The tone still sounds,
 * the direction and distance are still spoken, the object is still tracked and
 * still holds the lock — the app just stops claiming to know what it is. That
 * is the trade CLAUDE.md asks for: silence under uncertainty, and a missing
 * word costs nothing next to a wrong one said to someone who cannot look up
 * and check it.
 */
export function nameIsTrusted(target: Track): boolean {
  if (!target.className) return false;
  return (
    target.score >= nameMinScore(target.className) &&
    target.classConfidence >= MIN_CLASS_CONFIDENCE
  );
}

// ---------------------------------------------------------------------------
// The utterance
// ---------------------------------------------------------------------------

/**
 * What the app would say about one track, and the facts that sentence asserts.
 *
 * `clips` is the sound; `summary` is the MEANING, and the two are separated
 * because the gate below reasons about meaning. Two different lamp posts three
 * metres ahead produce different track ids and identical summaries, and the
 * user learns nothing from hearing the second one.
 */
export type Utterance = {
  /** Lead with the alarm tone. */
  tone: boolean;
  /** Phrase ids in speaking order. */
  clips: string[];
  summary: Summary;
};

export type Summary = {
  trackId: number;
  /** "" when the name is not trusted — the app knows something is there, not what. */
  className: string;
  bearing: Bearing;
  bucket: DistanceBucket;
  approaching: boolean;
  overhead: boolean;
};

/** Urgency, lowest wins. `far` is never announced, so it ranks last. */
const BUCKET_RANK: Record<DistanceBucket, number> = { urgent: 0, near: 1, mid: 2, far: 3 };

/**
 * Assemble the whole sentence for one track, or null when it has nothing to say.
 *
 * WORD ORDER: name, direction, distance, motion.
 *
 *   "Дугуй  баруун талд  ойртож байна"     bicycle, on the right, approaching
 *   "Машин  ойролцоогоор гурван метр"      car, approximately three metres
 *   "Хүн    бага зэрэг зүүн талд  маш ойрхон"
 *
 * CLAUDE.md fixes the first half of that: the object name ALWAYS precedes the
 * distance. Direction goes between them because it is part of locating the
 * object, not part of measuring it, and because Mongolian is verb-final —
 * "ойртож байна" has to land at the end or the sentence stops being Mongolian.
 *
 * Overhead is the one inversion. It leads, ahead of the name, because at head
 * height the user needs to duck before they need to know what they are ducking
 * under — and it is deliberately still spoken when the name is not trusted,
 * since "something is at head height" is already a complete warning.
 */
export function planUtterance(target: Track, pose: CameraPose): Utterance | null {
  const estimate = { metres: target.metres, reliable: target.reliable };
  const bucket = distanceBucket(estimate);
  const bearing = bearingOf(target, pose);
  const overhead = isOverhead(target, pose);
  const approaching = isApproaching(target);

  // Passed "" deliberately: announcementFor() then returns the distance
  // fragment alone, and the name and direction are placed around it here.
  const { tone: distanceTone, clips: distanceClips } = announcementFor(estimate, "");

  const named = nameIsTrusted(target);
  const name = named ? [target.className] : [];
  const dir = bearingClip(bearing);
  const direction = dir ? [dir] : [];

  // A NAME IS NOT A WARNING. Something has to be true of the object beyond its
  // existence before the app spends the channel on it: it is close enough to
  // place, it is overhead, or it is coming at you. Otherwise this is a
  // narrator reading out a street — "car", "person", "car" — about things
  // forty metres away that the user will never meet.
  //
  // This is the check announcementFor() used to make implicitly, by returning
  // nothing at all past the announceable range and taking the name down with
  // it. Splitting the name out to make room for direction lost that, and the
  // first thing the tests caught was a lone "Машин" for a car at forty metres.
  if (!overhead && !approaching && distanceClips.length === 0) return null;

  const clips = overhead
    ? ["overhead", ...name, ...direction]
    : [...name, ...direction, ...distanceClips];

  // "Машин" and "Машин ойртож байна" are different facts. The closing speed is
  // already computed for the ranking; the word costs half a second and is only
  // spent when something is genuinely moving at the user.
  if (approaching) clips.push("approaching");

  const tone = overhead || distanceTone;
  if (!tone && clips.length === 0) return null;

  return {
    tone,
    clips,
    summary: {
      trackId: target.id,
      className: named ? target.className : "",
      bearing,
      bucket,
      approaching,
      overhead,
    },
  };
}

/**
 * How urgently a track deserves the speech channel. A toned warning — imminent
 * contact or an overhead hazard — outranks every untoned sentence: the alarm
 * must never wait behind a routine "approximately three metres".
 */
export function urgencyRank(target: Track, pose: CameraPose): number {
  const plan = planUtterance(target, pose);
  if (!plan) return Infinity;
  return plan.tone ? 0 : BUCKET_RANK[plan.summary.bucket];
}

// ---------------------------------------------------------------------------
// The gate — when a sentence is worth the channel
// ---------------------------------------------------------------------------

/**
 * Hard ceiling: one utterance per this window, whatever else is true.
 *
 * CLAUDE.md sets the limit at one per 1.5s; this sits below it deliberately.
 * 1.5s back to back is a voice that never stops, and a warning only works if
 * there is silence around it for the user to hear the street through.
 */
export const MIN_ANNOUNCE_GAP_MS = 2500;

/** Per-track repeat window by urgency. `far` is never announced at all. */
export const BUCKET_DEBOUNCE_MS: Record<DistanceBucket, number> = {
  urgent: 2000,
  near: 6000,
  mid: 12_000,
  far: Infinity,
};

/**
 * How long the same SENTENCE stays suppressed, whichever object produces it.
 *
 * THE BUG THIS FIXES, and why it is a second gate rather than a change to the
 * first one. The per-track debounce is keyed on identity, which is right for
 * "stop repeating yourself about that car" and useless against a row of
 * bollards: five objects, five track ids, five clean debounce slots, and the
 * app says "ойролцоогоор гурван метр" five times in fifteen seconds. Each one
 * is individually justified. Together they are noise, and the user has learned
 * nothing after the first.
 *
 * Keying the ONLY gate on content was tried and was worse — it silenced a
 * genuinely different second object at the same distance and re-announced one
 * lamp post whenever its estimate crossed a rounding boundary. So both gates
 * run, and a sentence must clear both. Identity stops one object nagging;
 * content stops many objects saying one thing.
 *
 * Eight seconds: long enough to cover walking past a run of similar street
 * furniture, short enough that a genuinely persistent hazard still gets
 * re-stated while the user is still near it.
 */
export const CONTENT_REPEAT_MS = 8000;

/** Urgent warnings repeat on their own short clock and ignore the content gate. */
const URGENT_REPEAT_MS = 2000;

function contentKey(s: Summary): string {
  return [s.className, s.bearing, s.bucket, s.approaching, s.overhead].join("|");
}

/**
 * Whether the second summary says something MATERIALLY new about the same
 * object — new enough to be worth interrupting for, ahead of any timer.
 *
 * This is the other half of "only speak when it matters". The gates above make
 * the app quiet; without this they would also make it slow, because the single
 * most important moment in a track's life is when its situation changes, and
 * that moment can land anywhere inside a twelve-second debounce.
 *
 * Four changes qualify, and each is something the user would act on:
 *
 *   - It got closer by a whole band. Approaching in the sense that matters.
 *   - It started closing on you. Was scenery, is now traffic.
 *   - It became an overhead hazard. The cane cannot find this one.
 *   - It acquired a name. "Something, three metres" became "bus, three metres",
 *     and which of those it is changes what a person does about it.
 *
 * Bearing is deliberately NOT on that list, with one exception. A tracked box
 * drifts across a band edge constantly on a hand-held phone, and treating each
 * crossing as news would undo the whole file. Crossing the CENTRE LINE is
 * different — something that was on your left is now on your right, which
 * means it has passed in front of you — and that is worth saying.
 */
export function isMaterialChange(prev: Summary, next: Summary): boolean {
  if (BUCKET_RANK[next.bucket] < BUCKET_RANK[prev.bucket]) return true;
  if (next.approaching && !prev.approaching) return true;
  if (next.overhead && !prev.overhead) return true;
  if (next.className !== "" && next.className !== prev.className) return true;
  const crossed = side(prev.bearing) !== 0 && side(next.bearing) !== 0 &&
    side(prev.bearing) !== side(next.bearing);
  return crossed;
}

/**
 * Remembers what has been said, and decides what may be said next.
 *
 * Deliberately a class with explicit `now` arguments rather than anything that
 * reads a clock: the whole value of this policy is in behaviour over tens of
 * seconds of walking, which is exactly the timescale nobody can debug on a
 * phone in the street. A test can walk a scene through in a millisecond.
 */
export class SpeechGate {
  private lastAnyMs = -Infinity;
  /**
   * When the channel is actually free again.
   *
   * MIN_ANNOUNCE_GAP_MS alone is not enough, because it is measured from the
   * START of the last utterance and utterances are not all the same length.
   * "Хүн бага зэрэг зүүн талд ойролцоогоор гурван метр" is 3.3 seconds of
   * audio; releasing the channel 2.5 seconds in schedules the next warning ON
   * TOP of it — playSequence() writes to the AudioContext timeline, so the two
   * genuinely play at once rather than queueing. Two Mongolian sentences
   * overlapping is not a degraded warning, it is no warning at all.
   */
  private freeAtMs = -Infinity;
  private lastByTrack = new Map<number, { at: number; summary: Summary }>();
  private lastByContent = new Map<string, number>();

  /**
   * May this utterance be spoken now?
   *
   * The order of the checks IS the policy, so it is worth reading top to
   * bottom: the hard ceiling binds everyone; urgency outranks tidiness;
   * material change outranks a timer; and only then do the two repeat gates
   * get their say.
   */
  allows(plan: Utterance, now: number): boolean {
    if (now - this.lastAnyMs < MIN_ANNOUNCE_GAP_MS) return false;
    if (now < this.freeAtMs) return false;

    const previous = this.lastByTrack.get(plan.summary.trackId);

    // An urgent warning is a hazard report, not a description. A user still
    // walking toward something needs telling again, and neither the content
    // gate nor a twelve-second debounce may hold that back.
    if (plan.tone) return now - (previous?.at ?? -Infinity) >= URGENT_REPEAT_MS;

    // Something changed about this object that the user would act on. This is
    // the news the rest of the file exists to make room for.
    if (previous && isMaterialChange(previous.summary, plan.summary)) return true;

    if (now - (previous?.at ?? -Infinity) < BUCKET_DEBOUNCE_MS[plan.summary.bucket]) return false;

    const said = this.lastByContent.get(contentKey(plan.summary)) ?? -Infinity;
    return now - said >= CONTENT_REPEAT_MS;
  }

  /**
   * Record what was actually spoken.
   *
   * Call this only when the audio was really played, and pass how long it will
   * occupy the channel — playSequence() returns exactly that. Omitting the
   * duration falls back to MIN_ANNOUNCE_GAP_MS alone, which is right for a
   * caller that has not scheduled audio and wrong for one that has.
   */
  record(plan: Utterance, now: number, spokenForMs = 0): void {
    this.lastAnyMs = now;
    this.freeAtMs = now + spokenForMs;
    this.lastByTrack.set(plan.summary.trackId, { at: now, summary: plan.summary });
    this.lastByContent.set(contentKey(plan.summary), now);
    this.prune(now);
  }

  /**
   * Drop memories of objects long gone.
   *
   * Track ids are never reused, so without this the map grows for the whole
   * walk — on a busy street that is thousands of entries on a phone that is
   * already close to an iOS memory ceiling with a 36 MB model resident.
   */
  private prune(now: number): void {
    const cutoff = now - Math.max(CONTENT_REPEAT_MS, BUCKET_DEBOUNCE_MS.mid) * 2;
    for (const [id, entry] of this.lastByTrack) {
      if (entry.at < cutoff) this.lastByTrack.delete(id);
    }
    for (const [key, at] of this.lastByContent) {
      if (at < cutoff) this.lastByContent.delete(key);
    }
  }

  reset(): void {
    this.lastAnyMs = -Infinity;
    this.freeAtMs = -Infinity;
    this.lastByTrack.clear();
    this.lastByContent.clear();
  }
}

// ---------------------------------------------------------------------------
// "The path ahead is clear"
// ---------------------------------------------------------------------------

/**
 * How long the corridor must stay empty before the app volunteers that it is.
 *
 * A gap between two parked cars is empty for half a second. This is not that.
 */
export const CLEAR_SETTLE_MS = 2500;

/**
 * After this long, an empty corridor has stopped being news.
 *
 * The sentence is only ever a report of a CHANGE — "the thing I told you about
 * is gone". If the app was silenced for half a minute by darkness or a phone
 * pointed at the pavement, announcing "clear" on recovery would be answering a
 * question the user stopped asking, with information about a street they have
 * since walked down.
 */
export const CLEAR_MAX_LAG_MS = 20_000;

/**
 * Decides when to say "the path ahead is clear".
 *
 * THIS IS THE ONLY ASSERTION THE APP MAKES ABOUT THE ABSENCE OF SOMETHING, and
 * absence is the one thing a detector cannot actually observe. Every other
 * warning is grounded in a positive detection; a false one costs the user a
 * flinch. This one is grounded in nothing having been detected, and a false one
 * says "walk on" to someone about to hit a pole. It is the most dangerous
 * sentence in the app, and it is guarded accordingly:
 *
 *   ARMED, not spontaneous. It will only ever follow a warning the app
 *   actually gave. Silence that was ALWAYS silence stays silence — an app that
 *   opens with "clear ahead" is claiming to have looked, and a model that is
 *   failing looks exactly like a model that sees nothing. CLAUDE.md: silence is
 *   the correct output under uncertainty.
 *
 *   HEALTHY. The caller must be able to show that detection is actually
 *   working right now — frames arriving, enough light, camera not aimed at the
 *   user's shoes. Every one of those failure states already produces an empty
 *   corridor, and every one of them must produce silence instead of an
 *   all-clear.
 *
 *   SETTLED, and not stale. Long enough that it is a real gap, recent enough
 *   that it is still about the obstacle the user was told about.
 *
 * Note what is still NOT claimed: it says the path ahead is clear, not that it
 * is safe to walk, and never what to do about it. CLAUDE.md: describe, never
 * instruct.
 */
export class ClearPathWatcher {
  private armed = false;
  private lastHazardMs = -Infinity;

  /**
   * An obstacle warning was actually spoken. Only now is there a change for a
   * subsequent all-clear to report.
   */
  markAnnounced(now: number): void {
    this.armed = true;
    this.lastHazardMs = now;
  }

  /**
   * Call once per detector frame. Returns true on the single frame where the
   * all-clear should be spoken; it will not return true again until another
   * obstacle has been announced.
   *
   * `healthy` is the caller's honest assessment of whether the detector is
   * currently capable of seeing an obstacle at all.
   */
  update(hazardPresent: boolean, healthy: boolean, now: number): boolean {
    if (hazardPresent) {
      this.lastHazardMs = now;
      return false;
    }
    if (!this.armed || !healthy) return false;

    const quietFor = now - this.lastHazardMs;
    if (quietFor < CLEAR_SETTLE_MS) return false;
    if (quietFor > CLEAR_MAX_LAG_MS) {
      // The moment passed. Disarm rather than say it late.
      this.armed = false;
      return false;
    }
    this.armed = false;
    return true;
  }

  reset(): void {
    this.armed = false;
    this.lastHazardMs = -Infinity;
  }
}
