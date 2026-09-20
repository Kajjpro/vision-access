/**
 * Mongolian text normalization for speech-to-text matching.
 *
 * ASR output never matches your stop database character-for-character. Three
 * failure modes dominate, and all three are handled here:
 *
 *  1. Homoglyphs. ASR engines emit Latin `A/C/E/O/P/T/X` inside otherwise
 *     Cyrillic strings. `"Cансар" !== "Сансар"` even though they look identical.
 *  2. Vowel/sign variation. ө/о, ү/у, э/е, й/и, ь/ъ, doubled vowels.
 *  3. Case suffixes. The speaker says "Сансараас" (from Sansar), the database
 *     says "Сансар".
 *
 * Order matters: de-homoglyph → strip suffixes → fold. Suffix stripping runs on
 * real Cyrillic, before folding destroys the vowel distinctions the suffix
 * patterns rely on.
 */

/** Latin characters that render identically (or near-identically) to Cyrillic. */
const HOMOGLYPHS: Record<string, string> = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'И', K: 'К', M: 'М',
  O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
  // Deliberately NOT mapping '3' → 'З'. Digits in this dataset are almost
  // always real ordinals ("3-р хороолол"), and folding them into a letter
  // destroys the ordinal expansion below.
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'и', k: 'к', m: 'м',
  o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
  // Unicode lookalikes from other blocks that occasionally appear in transit data
  '\u04AF': 'ү', '\u04AE': 'Ү', '\u04E9': 'ө', '\u04E8': 'Ө',
};

/** Fold characters that Mongolian ASR routinely confuses. Lossy by design. */
const FOLD: Record<string, string> = {
  ө: 'о', ү: 'у', ё: 'е', э: 'е', й: 'и', щ: 'ш', ъ: '', ь: '',
};

/**
 * Case suffixes, longest first. Ablative (-аас) marks origin, directive (-руу)
 * and terminative (-хүртэл) mark destination; `journeyGrammar.ts` reads those
 * roles. Here we only need them gone.
 */
const CASE_SUFFIXES = [
  'хүртэл', 'руугаа', 'рүүгээ', 'аасаа', 'ээсээ', 'оосоо', 'өөсөө',
  'аас', 'ээс', 'оос', 'өөс', 'руу', 'рүү', 'ийн', 'ын', 'ний', 'ны',
  'даа', 'дээ', 'доо', 'дөө', 'тай', 'тэй', 'той', 'тэй',
  'ыг', 'ийг', 'д', 'т', 'г',
];

/** Digits → Mongolian ordinal words, both directions. Stop names use both. */
const ORDINALS: Array<[string, string]> = [
  ['1', 'нэгдүгээр'], ['2', 'хоёрдугаар'], ['3', 'гуравдугаар'],
  ['4', 'дөрөвдүгээр'], ['5', 'тавдугаар'], ['6', 'зургаадугаар'],
  ['7', 'долоодугаар'], ['8', 'наймдугаар'], ['9', 'есдүгээр'],
  ['10', 'аравдугаар'], ['11', 'арван нэгдүгээр'], ['12', 'арван хоёрдугаар'],
  ['13', 'арван гуравдугаар'], ['14', 'арван дөрөвдүгээр'],
  ['15', 'арван тавдугаар'], ['16', 'арван зургаадугаар'],
];

export function deHomoglyph(input: string): string {
  let out = '';
  for (const ch of input) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

/**
 * Turn "3-р хороолол" and "гуравдугаар хороолол" into the same string.
 *
 * JavaScript's `\b` only recognizes [A-Za-z0-9_], so it reports a boundary in
 * the middle of Cyrillic text and none at its edges. Every boundary here is
 * written explicitly with Unicode property lookarounds instead.
 */
export function expandOrdinals(input: string): string {
  let out = input;
  // Longest first, so "13-р" is not eaten by the rule for "1-р".
  const ordered = [...ORDINALS].sort((a, b) => b[0].length - a[0].length);
  for (const [digit, word] of ordered) {
    // "3-р", "3 р", "3-Р", "3-p" (Latin p homoglyph)
    out = out.replace(
      new RegExp(`(?<![\\p{N}])${digit}\\s*[-–]?\\s*[рРpP](?![\\p{L}\\p{N}])`, 'gu'),
      word,
    );
    // A bare number directly before a word: "3 хороолол"
    out = out.replace(
      new RegExp(`(?<![\\p{N}])${digit}(?![\\p{N}])(?=\\s+\\p{L})`, 'gu'),
      word,
    );
  }
  return out;
}

/** Remove one trailing case suffix from a word. Guards against over-stripping. */
export function stripCase(word: string): string {
  const lower = word.toLowerCase();
  for (const suffix of CASE_SUFFIXES) {
    if (lower.length > suffix.length + 2 && lower.endsWith(suffix)) {
      return lower.slice(0, -suffix.length);
    }
  }
  return lower;
}

/** Collapse ASR-confusable characters. Apply last — this is destructive. */
export function fold(input: string): string {
  let out = '';
  for (const ch of input.toLowerCase()) out += FOLD[ch] ?? ch;
  return out
    // LETTERS ONLY. This was `(.)\1+`, which also collapsed repeated DIGITS —
    // so "112-ын буудал" became "12 будал", the same key as "12-ын буудал",
    // a stop 12.5 km away. Found on the real 923-stop set, not hypothesised.
    // The same rule turned 100 into 10 and 11 into 1. Doubled vowels are what
    // ASR confuses; a repeated digit is information.
    .replace(/(\p{L})\1+/gu, '$1')     // доод → дод, аа → а
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation, hyphens, quotes
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Canonical match key. Run this over every stop name at build time and cache the
 * result alongside the stop — never recompute for 923 stops per keystroke.
 */
export function stopKey(input: string): string {
  // Ordinals first: deHomoglyph would otherwise rewrite the Latin "p" in "3-p"
  // before the ordinal rule has a chance to see the digit alongside it.
  const cleaned = deHomoglyph(expandOrdinals(input));
  const stripped = cleaned.split(/\s+/).map(stripCase).join(' ');
  return fold(stripped);
}

/** Sørensen–Dice over character bigrams. Robust to insertions and swaps. */
export function diceScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const n of A.values()) sizeA += n;
  for (const n of B.values()) sizeB += n;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) ?? 0);
  return sizeA + sizeB === 0 ? 0 : (2 * overlap) / (sizeA + sizeB);
}

/**
 * Composite similarity. Dice alone under-scores cases where the speaker says a
 * short fragment of a long official name ("Драм" for "Улсын драмын эрдмийн
 * театр"), which is the single most common real-world utterance shape.
 */
export function similarity(queryKey: string, stopKeyValue: string): number {
  const dice = diceScore(queryKey, stopKeyValue);
  const qTokens = queryKey.split(' ').filter(Boolean);
  const sTokens = stopKeyValue.split(' ').filter(Boolean);
  if (qTokens.length === 0 || sTokens.length === 0) return dice;

  let contained = 0;
  for (const qt of qTokens) {
    if (sTokens.some((st) => st === qt || (qt.length >= 4 && st.startsWith(qt)))) {
      contained++;
    }
  }
  const coverage = contained / qTokens.length;
  const prefixBonus = stopKeyValue.startsWith(queryKey) ? 0.1 : 0;

  return Math.min(1, 0.55 * dice + 0.45 * coverage + prefixBonus);
}
