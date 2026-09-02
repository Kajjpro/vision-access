/**
 * The tögrög notes MoneyMode can name, and nothing else.
 *
 * WHY THIS IS NOT A YOLO CLASS LIST
 * ---------------------------------
 * The obstacle detector is a stock COCO-80 checkpoint (lib/coco.ts). COCO has
 * no banknote, so adding entries to DETECTION_CLASSES cannot make a note
 * appear — the same wall that left pole, tree and door scoring 0.02-0.14
 * against a 0.30 threshold. phrases.ts:48 says it outright: "Adding a class
 * here does NOT make the detector find it."
 *
 * A note is also the wrong SHAPE of problem for a category detector. "person"
 * is a category — endless intra-class variation, which is exactly what
 * tens of thousands of labelled boxes buy you. A 5000₮ note is a rigid,
 * planar, mass-produced object with one fixed printed design. That is
 * INSTANCE recognition, and it is solved by matching against a picture of the
 * thing rather than by learning what the thing tends to look like.
 *
 * So the "model" here is lib/money/refs.ts: a pack of ORB descriptors taken
 * from one reference scan per note per side. Adding a denomination is adding
 * two photographs, not a labelling campaign.
 *
 * WHAT IS DELIBERATELY NOT USED AS A SIGNAL
 * -----------------------------------------
 *   Physical size. Mongolian notes do differ in millimetres, and it is
 *   useless here: a monocular photo has no scale reference, so a 1000₮ held
 *   close and a 20000₮ held at arm's length subtend the same box. Reading
 *   size off an uncalibrated frame is how you confidently misname a note by
 *   a factor of twenty.
 *
 *   Colour. A real weak prior and a terrible primary one — the notes share a
 *   palette family, they fade with wear, and UB street light in winter is
 *   nothing like the indoor light a reference scan is shot under. It is not
 *   consulted at all; see lib/money/match.ts, which decides on print
 *   geometry alone.
 *
 * SCOPE. NOTES.md fixes the set at 100 through 20000. The 1/5/10/20/50₮ notes
 * are omitted because inflation has taken them out of ordinary circulation,
 * and every added denomination costs a wav in the startup download and one
 * more thing the matcher can confuse. Adding one later is an entry here, a
 * phrase in lib/phrases.ts, and two reference photographs.
 */

/** Ascending by value. The order is the reference pack's slot order. */
export const DENOMINATIONS = [100, 500, 1000, 5000, 10000, 20000] as const;

export type Denomination = (typeof DENOMINATIONS)[number];

export type DenominationInfo = {
  value: Denomination;
  /**
   * Phrase id, so the wav filename and the spoken text stay in lib/phrases.ts
   * where every other spoken string lives. NOTES.md warns these two must be
   * added together or they drift.
   */
  phraseId: string;
  /**
   * On-screen only. CLAUDE.md: display text and spoken text are ALWAYS
   * different fields, and a display string must never reach a speech engine —
   * "20000₮" would be read out as Latin digits and a symbol Chimege rejects.
   */
  display: string;
};

export const DENOMINATION_INFO: Readonly<Record<Denomination, DenominationInfo>> = {
  100: { value: 100, phraseId: "money_100", display: "100₮" },
  500: { value: 500, phraseId: "money_500", display: "500₮" },
  1000: { value: 1000, phraseId: "money_1000", display: "1000₮" },
  5000: { value: 5000, phraseId: "money_5000", display: "5000₮" },
  10000: { value: 10000, phraseId: "money_10000", display: "10000₮" },
  20000: { value: 20000, phraseId: "money_20000", display: "20000₮" },
};

/** Both faces are matched independently; either one identifies the note. */
export const SIDES = ["front", "back"] as const;
export type Side = (typeof SIDES)[number];

export function isDenomination(v: number): v is Denomination {
  return (DENOMINATIONS as readonly number[]).includes(v);
}

export function infoFor(value: Denomination): DenominationInfo {
  return DENOMINATION_INFO[value];
}

/** Every phrase id MoneyMode needs loaded before it can speak. */
export function denominationPhraseIds(): string[] {
  return DENOMINATIONS.map((d) => DENOMINATION_INFO[d].phraseId);
}
