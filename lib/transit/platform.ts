/**
 * Which side of the road the rider needs, and how we know.
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 *
 * A named stop in Ulaanbaatar is almost always TWO physical platforms, one per
 * direction, and the two carry different stop ids and different route
 * directions. Board the wrong one and you ride away from where you are going.
 * For a blind rider that error is invisible until the journey has already gone
 * wrong.
 *
 * ── WHY IT CANNOT BE SENSED ────────────────────────────────────────────────
 *
 * Measured over the shipped 923 stops: 351 opposite-side pairs, 334 of them
 * sharing at least one route. Separation runs min 0 m, median 82 m, p95 199 m.
 *
 *   310 of 351 (88%) sit inside MAX_MATCH_M (150 m)
 *   100 of 351 sit inside CONFIDENT_ACCURACY_M (60 m)
 *
 * So GPS cannot choose between them. Any "you are on the north platform"
 * derived from a fix is a coin flip wearing the costume of a measurement — and
 * this app's own rule is that a confident wrong answer is worse than an admitted
 * unknown.
 *
 * GEOMETRY CANNOT CHOOSE EITHER, and that surprised me enough to be worth
 * recording. The intuition is that opposite platforms sit ACROSS a road, so the
 * line between them should run perpendicular to the route. It does not: the
 * angle between the platform-to-platform line and the route heading has a median
 * of 15°, and only 45 of 341 pairs exceed 45°. Real platform pairs are staggered
 * ALONG the road, not across it. There is therefore no honest way to say "cross
 * the road" from this data, and this module does not try.
 *
 * ── WHAT WE DO INSTEAD ─────────────────────────────────────────────────────
 *
 * Invert the question. Nothing needs to sense which platform the rider is on,
 * because the DESTINATION determines which platform they need — `planJourney`
 * already picks it by finding the boarding stop that actually reaches the
 * destination. The side is derived, never measured.
 *
 * Then say it. 876 of 923 stop names carry the side as a word — Хойд, Урд,
 * Баруун, Зүүн — and `stopNameToSpeech` already keeps it ("Саппоро, Урд"). That
 * word is on the physical sign and is the word a rider can say to a passerby.
 * Naming the platform is worth more than any amount of sensing it.
 */

import type { Stop } from "./types";

/** The four side words, exactly as they appear in the shipped stop names. */
export const SIDES = ["Хойд", "Урд", "Баруун", "Зүүн"] as const;
export type Side = (typeof SIDES)[number];

/** North faces south, east faces west. The two axes never mix. */
const OPPOSITE: Record<Side, Side> = {
  Хойд: "Урд",
  Урд: "Хойд",
  Баруун: "Зүүн",
  Зүүн: "Баруун",
};

export function oppositeSide(side: Side): Side {
  return OPPOSITE[side];
}

export type PlatformName = {
  /** The station, without the side. `Сансар /Хойд/` → `Сансар`. */
  base: string;
  /** Null for the 47 stops that carry no side word, and for anything unparsed. */
  side: Side | null;
};

/**
 * Splits a display name into station and side.
 *
 * Only a TRAILING bracketed group counts, and only when its content is one of
 * the four side words. `Монгол цах/утас компани` has an interior slash and no
 * side; treating that as a platform marker would invent a second platform for a
 * stop that has one.
 */
export function splitPlatform(displayName: string): PlatformName {
  const raw = String(displayName ?? "").trim();
  const m = raw.match(/^(.*?)\s*[/(]\s*([^)/]+?)\s*[)/]\s*$/);
  if (!m) return { base: raw, side: null };
  const side = SIDES.find((s) => s === m[2]);
  return side ? { base: m[1].trim(), side } : { base: raw, side: null };
}

/** Same station, ignoring the side. Case- and spacing-insensitive. */
export function sameStation(a: string, b: string): boolean {
  const norm = (n: string) => splitPlatform(n).base.toLowerCase().replace(/[\s\-.,]+/g, "");
  const na = norm(a);
  return na.length > 0 && na === norm(b);
}

/**
 * How the platform the rider needs relates to the one they are standing at.
 *
 * Deliberately coarse. These four cases are the ones that change what a rider
 * DOES, and a finer distinction would be a distinction we cannot support with
 * the data.
 */
export type BoardingRelation =
  /** The rider is already in the right place. Say nothing about platforms. */
  | "same_platform"
  /**
   * Same station, the facing side. THE DANGEROUS ONE: it is the case a rider
   * is most likely to get wrong, and the one GPS is least able to warn about.
   */
  | "opposite_side"
  /** Same station, a side that is not simply the opposite — a three-way junction. */
  | "same_station_other"
  /** A different station entirely. Ordinary walking, no ambiguity to resolve. */
  | "different_station";

export function boardingRelation(standingAt: Stop | null, boardAt: Stop | null): BoardingRelation {
  if (!standingAt || !boardAt) return "different_station";
  if (standingAt.id === boardAt.id) return "same_platform";
  if (!sameStation(standingAt.name, boardAt.name)) return "different_station";

  const here = splitPlatform(standingAt.name).side;
  const there = splitPlatform(boardAt.name).side;
  if (here && there && OPPOSITE[here] === there) return "opposite_side";
  return "same_station_other";
}

/**
 * Whether the rider must be TOLD which platform, rather than just walked to it.
 *
 * True whenever the boarding platform is not the one they are at. The bar is
 * deliberately this low: at a shared-name pair the side word is the only thing
 * distinguishing two stops 82 m apart that go opposite ways, and withholding it
 * saves one clip and costs a journey.
 */
export function needsPlatformCallout(relation: BoardingRelation): boolean {
  return relation !== "same_platform";
}

/**
 * The clip keys naming the boarding platform, or nothing.
 *
 * The stop clip already carries the side — `stopNameToSpeech` renders
 * `Саппоро /Урд/` as "Саппоро, Урд" — so no new side vocabulary is needed and
 * none is invented here. A stop whose name has not been rendered yet (770 of
 * 923) returns nothing rather than a bare prefix with a hole where the name
 * should be.
 */
export function platformCalloutKeys(
  boardAt: Stop,
  relation: BoardingRelation,
  hasClip: (key: string) => boolean,
): string[] {
  if (!needsPlatformCallout(relation)) return [];
  const name = `stop_${boardAt.id}`;
  return hasClip(name) ? [name] : [];
}
