/**
 * Mongolian ordinal words for the numbers that actually appear in stop names.
 *
 * WHY THIS EXISTS: `mnNormalize.ORDINALS` maps digits to ordinal words for 1–16,
 * so `"3-р хороолол"` and `"гуравдугаар хороолол"` collapse to one key. Stop
 * names in this city go a great deal higher — measured over all 923, the
 * ordinals present are 1–11, 13, 16, 17, 19, 21, 23, 25, 31, 32, 34, 39, 43, 48,
 * 49, 57, 64, 72, 86, 114, 118, 143, 149, 157, 158, 292, 312, 430, 626 and 801.
 * 46 stops carry one above 16, and for every one of them a rider who says the
 * name in words ("гучин хоёрдугаар байр") produced a key that could never match
 * the digits sitting in the database.
 *
 * These feed `aliasKeys` at build time rather than extending the table in
 * `mnNormalize`: an alias is additive, so a spelling that turns out to be wrong
 * costs a missed match, never a false one. The table stays the hot path.
 */

/** Standalone ordinals, 1–9. The forms `mnNormalize` already uses. */
const UNIT_ORDINAL: Record<number, string> = {
  1: "нэгдүгээр", 2: "хоёрдугаар", 3: "гуравдугаар", 4: "дөрөвдүгээр",
  5: "тавдугаар", 6: "зургаадугаар", 7: "долоодугаар", 8: "наймдугаар",
  9: "есдүгээр",
};

/** Round tens as an ordinal in their own right: "гучдугаар" = 30th. */
const TEN_ORDINAL: Record<number, string> = {
  10: "аравдугаар", 20: "хорьдугаар", 30: "гучдугаар", 40: "дөчдүгээр",
  50: "тавьдугаар", 60: "жардугаар", 70: "далдугаар", 80: "наядугаар",
  90: "ерэндүгээр",
};

/**
 * Attributive tens — the form used when another number follows.
 * 30 alone is "гуч", but 32 is "гучин хоёр", never "гуч хоёр".
 */
const TEN_ATTRIBUTIVE: Record<number, string> = {
  10: "арван", 20: "хорин", 30: "гучин", 40: "дөчин", 50: "тавин",
  60: "жаран", 70: "далан", 80: "наян", 90: "ерэн",
};

/** Attributive hundreds: 800 → "найман зуун". */
const HUNDRED_ATTRIBUTIVE: Record<number, string> = {
  1: "зуун", 2: "хоёр зуун", 3: "гурван зуун", 4: "дөрвөн зуун",
  5: "таван зуун", 6: "зургаан зуун", 7: "долоон зуун", 8: "найман зуун",
  9: "есөн зуун",
};

const HUNDRED_ORDINAL: Record<number, string> = {
  1: "зуудугаар", 2: "хоёр зуудугаар", 3: "гурван зуудугаар",
  4: "дөрвөн зуудугаар", 5: "таван зуудугаар", 6: "зургаан зуудугаар",
  7: "долоон зуудугаар", 8: "найман зуудугаар", 9: "есөн зуудугаар",
};

/**
 * `32` → `"гучин хоёрдугаар"`. Returns null above 999 or below 1 — nothing in
 * the data needs it, and a guess there would be a fabricated alias.
 */
export function ordinalWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 999) return null;

  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];

  if (hundreds > 0) {
    if (rest === 0) return HUNDRED_ORDINAL[hundreds] ?? null;
    parts.push(HUNDRED_ATTRIBUTIVE[hundreds]);
  }

  if (rest > 0) {
    if (rest < 10) {
      parts.push(UNIT_ORDINAL[rest]);
    } else {
      const tens = Math.floor(rest / 10) * 10;
      const units = rest % 10;
      if (units === 0) parts.push(TEN_ORDINAL[tens]);
      else parts.push(TEN_ATTRIBUTIVE[tens], UNIT_ORDINAL[units]);
    }
  }

  return parts.every(Boolean) ? parts.join(" ") : null;
}

/**
 * Every ordinal-looking number in a name, as `[digits, words]` pairs.
 *
 * The boundary is `(?![\p{L}\p{N}])`, never `\b`. JavaScript's `\b` only knows
 * `[A-Za-z0-9_]`, so against Cyrillic it reports boundaries mid-word and none
 * at the edges — it silently matches nothing here. (Confirmed the hard way:
 * a scan written with `\b` reported zero ordinals in a file containing 106.)
 */
export const ORDINAL_PATTERN = /(\d+)\s*[-–—]?\s*[рРpP](?![\p{L}\p{N}])/gu;

/** Rewrite "32-р байр" → "гучин хоёрдугаар байр". Unknown numbers are left alone. */
export function expandOrdinalsInName(name: string): string | null {
  let changed = false;
  const out = name.replace(ORDINAL_PATTERN, (whole, digits: string) => {
    const words = ordinalWords(Number(digits));
    if (!words) return whole;
    changed = true;
    return words;
  });
  return changed ? out : null;
}
