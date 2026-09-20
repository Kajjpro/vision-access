/**
 * Clip sequences for the pre-rendered mn-MN-YesuiNeural audio pipeline.
 *
 * Nothing here plays audio — it returns an ordered list of clip ids for the
 * existing player to queue. Because every fragment is pre-rendered at build
 * time, voice output stays instant and works with no network, which is the
 * whole reason the TTS is pre-rendered rather than synthesized live.
 *
 * CLIP IDS ARE UNDERSCORED, NOT DOTTED. This file was written against
 * `phrase.ask_origin` / `stop.<id>` / `route.<id>`; the manifest this app
 * actually ships uses `ui_*`, `stop_<id>`, `route_<id>`, `num_<n>` and has 293
 * such keys, none containing a dot. Renaming the code was a one-line change per
 * family; renaming 293 rendered clips would have orphaned every file and cost a
 * full re-render against a hard-capped TTS quota.
 *
 * PHRASES REUSE WHAT THE APP ALREADY SAYS. Nine of these already existed —
 * "Хаашаа явах вэ?", "Сонсож байна", "Ойлгосонгүй. Дахин оролдоно уу." — and
 * are referenced from `lib/ui/announcements.ts` rather than re-rendered. Two
 * copies of one sentence is not a duplicate file, it is two different voices
 * saying the same thing to someone who cannot see why.
 *
 * BUILD REQUIREMENT: three clip families, all already produced by the pipeline.
 *   ui_*          fixed fragments — `npx tsx scripts/render-ui-audio.ts`
 *   stop_<stopId> 923 stop names  — `npx tsx scripts/generate-transit-audio.ts`
 *   route_<routeId> 84 route names — the same script, `--stage=routes`
 *   num_<n>       1–40, already rendered; the longest route is 36 stops
 *
 * Stop and route names are rendered with flat final intonation and a short
 * trailing pause so they splice into these carrier phrases without sounding
 * like sentence endings — see `toSpeechText` in lib/transit/speech.ts.
 */

import { JOURNEY, VOICE, VOICE_JOURNEY } from "@/lib/ui/announcements";

export type ClipId = string;

/**
 * A phrase whose clip has not been rendered yet resolves to null here rather
 * than to a plausible-looking id that will never load. The player logs the gap;
 * see `speakClips` in lib/ui/speak.ts.
 */
const clip = (phrase: { clip: string | null }): ClipId => phrase.clip ?? "";

export const PHRASES = {
  askOrigin: clip(VOICE_JOURNEY.askOrigin),
  /** Already in the app as the first question of the journey flow. */
  askDestination: clip(JOURNEY.askDestination),
  holdToSpeak: clip(VOICE_JOURNEY.holdToSpeak),
  /** "Сонсож байна" — the existing listening cue. */
  listening: clip(VOICE.listening),
  processing: clip(JOURNEY.planning),
  /** "Ойлгосонгүй. Дахин оролдоно уу." */
  notHeard: clip(VOICE.notUnderstood),

  whichOne: clip(VOICE_JOURNEY.whichOne),
  or: clip(VOICE_JOURNEY.or),
  /**
   * "Та ингэж хэлсэн үү:" — read one candidate back when it is likely but not
   * certain. Already rendered for the wait screen's voice flow; reused here so
   * the optional model layer's "did_you_say" answer costs no new audio and
   * speaks in the voice the rider already knows.
   */
  didYouSay: clip(VOICE.didYouSay),

  from: clip(VOICE_JOURNEY.from),
  to: clip(VOICE_JOURNEY.to),
  /**
   * "Та" — the same single word the countdown already opens with
   * (`bus_you_are_at`). Reused rather than rendered a second time.
   */
  confirmPrefix: "bus_you_are_at",
  confirmSuffix: clip(VOICE_JOURNEY.confirmSuffix),

  boardRoute: clip(VOICE_JOURNEY.boardRoute),
  boardRouteSuffix: clip(VOICE_JOURNEY.boardRouteSuffix),
  /** "буудал явна" — how many stops to travel. Already rendered. */
  stopsCount: clip(JOURNEY.stopsToTravelSuffix),

  sameStop: clip(VOICE_JOURNEY.sameStop),
  wrongDirection: clip(VOICE_JOURNEY.wrongDirection),
  noRoute: clip(JOURNEY.noRoute),

  micDenied: clip(VOICE_JOURNEY.micDenied),
  useListInstead: clip(VOICE_JOURNEY.useListInstead),
  /** Network or engine gone. The existing "voice input is unavailable". */
  offline: clip(VOICE.unavailable),
} as const;

export const stopClip = (stopId: string): ClipId => `stop_${stopId}`;
export const routeClip = (routeId: string): ClipId => `route_${routeId}`;
export const numberClip = (n: number): ClipId => `num_${n}`;

export function confirmJourneyClips(
  originStopId: string,
  destStopId: string,
): ClipId[] {
  return [
    PHRASES.confirmPrefix,
    stopClip(originStopId),
    PHRASES.from,
    stopClip(destStopId),
    PHRASES.to,
    PHRASES.confirmSuffix,
  ];
}

export function boardingClips(
  routeId: string,
  boardStopId: string,
  hops: number,
): ClipId[] {
  return [
    PHRASES.boardRoute,
    routeClip(routeId),
    PHRASES.boardRouteSuffix,
    stopClip(boardStopId),
    numberClip(hops),
    PHRASES.stopsCount,
  ];
}

export function disambiguationClips(stopIds: string[]): ClipId[] {
  const clips: ClipId[] = [PHRASES.whichOne];
  stopIds.forEach((id, i) => {
    if (i > 0) clips.push(PHRASES.or);
    clips.push(numberClip(i + 1), stopClip(id));
  });
  return clips;
}
