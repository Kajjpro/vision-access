/**
 * Split one spoken utterance into an origin fragment and a destination fragment.
 *
 * Mongolian marks these roles morphologically, which is a gift: the case suffix
 * is attached to the stop name itself, so no word-order assumptions are needed.
 *
 *   Сансараас Драмын театр хүртэл   → origin=Сансар,  dest=Драмын театр
 *   Би Сансарт байна, Зайсан руу    → origin=Сансар,  dest=Зайсан
 *   Драмын театр явна               → dest=Драмын театр  (origin unknown)
 *
 * When only one role is recoverable the caller asks a follow-up question. That
 * is the normal path, not an error path — most riders say only a destination.
 */

import { deHomoglyph } from './mnNormalize';

export interface JourneyFragments {
  originText: string | null;
  destText: string | null;
  /** Set when the utterance carried no role markers at all. */
  ambiguous: boolean;
}

/** Ablative / locative — "from here", "I'm at". */
const ORIGIN_MARKERS = /(аасаа|ээсээ|оосоо|өөсөө|аас|ээс|оос|өөс)$/;
const LOCATIVE_MARKERS = /(даа|дээ|доо|дөө|д|т)$/;

/** Directive / terminative — "to", "until". */
const DEST_MARKERS = /(руугаа|рүүгээ|руу|рүү)$/;
const DEST_KEYWORDS = ['хүртэл', 'очно', 'очих', 'явна', 'явах', 'орно', 'орох', 'буух'];

/** Filler that ASR reliably picks up and that carries no location information. */
const STOPWORDS = new Set([
  'би', 'бид', 'та', 'энэ', 'тэр', 'одоо', 'байна', 'байгаа', 'юм',
  'уу', 'үү', 'бэ', 'вэ', 'аа', 'ээ', 'зогсоол', 'буудал', 'дээр',
  'хэрэгтэй', 'хүсч', 'хүсэж', 'гэсэн', 'болох',
]);

function clean(tokens: string[]): string {
  return tokens
    .filter((t) => t.length > 0 && !STOPWORDS.has(t.toLowerCase()))
    .join(' ')
    .trim();
}

export function parseJourney(utterance: string): JourneyFragments {
  const text = deHomoglyph(utterance)
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return { originText: null, destText: null, ambiguous: true };

  const tokens = text.split(' ');

  // Locate role anchors. Scan right-to-left so that in "Сансараас Зайсан руу"
  // the destination anchor claims only the tokens after the origin anchor.
  let originAt = -1;
  let destAt = -1;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (DEST_MARKERS.test(t) || DEST_KEYWORDS.includes(t)) {
      if (destAt === -1) destAt = i;
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (ORIGIN_MARKERS.test(t) && t.length > 4) {
      originAt = i;
      break;
    }
  }
  if (originAt === -1) {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].toLowerCase();
      if (LOCATIVE_MARKERS.test(t) && t.length > 3 && !STOPWORDS.has(t)) {
        // Locative is weak evidence — only trust it if a destination exists too,
        // otherwise "Зайсанд" most likely means "to Zaisan", not "at Zaisan".
        if (destAt !== -1 && i < destAt) originAt = i;
        break;
      }
    }
  }

  if (originAt === -1 && destAt === -1) {
    // `|| null` to match the typed contract and the other return path below.
    // Without it a filler-only utterance ("би байна") yields destText: "",
    // which is not nullish — so `destText ?? originText ?? transcript` in the
    // caller selects the empty string and the raw transcript is never tried.
    return { originText: null, destText: clean(tokens) || null, ambiguous: true };
  }

  let originTokens: string[] = [];
  let destTokens: string[] = [];

  if (originAt !== -1 && destAt !== -1) {
    if (originAt < destAt) {
      originTokens = tokens.slice(0, originAt + 1);
      destTokens = tokens.slice(originAt + 1, destAt + 1);
    } else {
      destTokens = tokens.slice(0, destAt + 1);
      originTokens = tokens.slice(destAt + 1, originAt + 1);
    }
  } else if (originAt !== -1) {
    originTokens = tokens.slice(0, originAt + 1);
    destTokens = tokens.slice(originAt + 1);
  } else {
    destTokens = tokens.slice(0, destAt + 1);
  }

  // A trailing keyword like "хүртэл" is grammar, not part of the name.
  destTokens = destTokens.filter((t) => !DEST_KEYWORDS.includes(t.toLowerCase()));

  const originText = clean(originTokens) || null;
  const destText = clean(destTokens) || null;

  return { originText, destText, ambiguous: false };
}
