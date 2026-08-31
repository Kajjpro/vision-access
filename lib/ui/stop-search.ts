/**
 * Finding a destination among 923 stop names, entirely offline.
 *
 * No API and no LLM: this runs on a cheap Android in a dead zone, and a search
 * that needs a network is a search that fails exactly when someone is lost.
 *
 * THE SEARCH NEVER PICKS. It returns a ranked list and the caller speaks the
 * top few for the user to cycle. Silently choosing the top hit is how someone
 * ends up riding to the wrong side of the city, and unlike a sighted passenger
 * they cannot glance at the screen and catch it.
 *
 * Grounded in what the data actually contains — see the constants below, each
 * of which exists because of a specific name in stops.json.
 */

export type SearchableStop = { id: string; name: string; lat: number; lon: number };

/**
 * The four platform markers, and ONLY these.
 *
 * `/Хойд/ /Урд/ /Баруун/ /Зүүн/` are compass platforms — nobody says them
 * aloud, so they must not count against a match. But five stops carry a
 * NON-directional marker that is part of the name proper:
 *
 *   Сансар /Тунель/ /Хойд/          ← Тунель distinguishes it from Сансар ШТС
 *   ЗҮРХ УУЛ /Чингэлтэйн эцэс/
 *   Гэмтлийн эмнэлэг /Дунд/
 *   ӨВӨР ГҮНТИЙН ЭЦЭС /зуслан/
 *   Монгол цах/утас компани /Баруун/
 *
 * Stripping every `/…/` would erase the only thing telling two Сансар stops
 * apart, so the strip is keyed on the four words rather than on the slashes.
 */
const PLATFORM_SUFFIX = /\s*\/\s*(хойд|урд|баруун|зүүн)\s*\/\s*/giu;

/**
 * Latin → Cyrillic, covering both visual homoglyphs and plain transliteration.
 *
 * `MSM /Хойд/` is the only Latin-spelled stop in the file, and someone saying
 * or typing it in Cyrillic — "МСМ" — must still reach it. Note that `s → с` is
 * a TRANSLITERATION, not a homoglyph: Latin S looks nothing like Cyrillic С.
 * It is included anyway because the fold runs on both sides of the comparison,
 * so all that matters is that the two agree — and no Cyrillic name can be
 * damaged by it, since after folding there is no Latin left to damage.
 */
const LATIN_TO_CYRILLIC: Record<string, string> = {
  a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м",
  o: "о", p: "р", s: "с", t: "т", x: "х", y: "у",
};

/**
 * Mongolian case endings, longest first.
 *
 * This is the requirement the data forces and a naive matcher misses: there is
 * no stop called `Сансар`. There is `Сансарын үйлчилгээний төв` — genitive —
 * alongside `Сансар ШТС` and `Сансар /Тунель/`. A user saying "Сансар" must
 * reach all three, so a token is compared with its ending removed as well as
 * intact.
 *
 * Only stripped when a real stem remains, or "Тэд" becomes "Т".
 */
const CASE_ENDINGS = [
  "ийнх", "ыынх", "аасаа", "ээсээ", "оосоо", "өөсөө",
  "ийн", "ыын", "уудын", "үүдийн", "аас", "ээс", "оос", "өөс",
  "руу", "рүү", "тай", "тэй", "той", "лаа", "лээ",
  "ын", "ий", "ыг", "ийг", "аа", "ээ", "оо", "өө", "нд", "ад", "эд", "од",
  "ы", "и", "н", "д", "т", "г",
];

const MIN_STEM_LENGTH = 3;

export function stripCaseEnding(token: string): string {
  for (const ending of CASE_ENDINGS) {
    if (token.length - ending.length >= MIN_STEM_LENGTH && token.endsWith(ending)) {
      return token.slice(0, -ending.length);
    }
  }
  return token;
}

/**
 * A stop name or a spoken query, reduced to comparable tokens.
 *
 * Digits are KEPT — `32-р байр`, `ТЭЦ-3` and `5 Шар` are distinguished by their
 * numbers and nothing else. The hyphen is dropped, which also silently
 * reconciles `ТЭЦ-4` and `ТЭЦ4`, both of which are in the data.
 */
export function normalizeStopText(text: string): string {
  let s = String(text ?? "").replace(PLATFORM_SUFFIX, " ").toLowerCase();

  let folded = "";
  for (const ch of s) folded += LATIN_TO_CYRILLIC[ch] ?? ch;
  s = folded;

  // ё and е are interchangeable in practice — typed, and misrecognised.
  s = s.replace(/ё/g, "е");

  // Everything that is not a letter or digit becomes a break. `цах/утас` has an
  // unpaired slash inside a name, so slashes cannot be assumed to be delimiters.
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");

  // Split letter↔digit boundaries. This reconciles `ТЭЦ4` with `ТЭЦ-4` — both
  // spellings are in stops.json for the same kind of place — and makes the
  // number in `32-р байр` a token in its own right rather than glued to a
  // letter, so it can be compared as the distinguishing part that it is.
  s = s.replace(/(\p{L})(\p{N})/gu, "$1 $2").replace(/(\p{N})(\p{L})/gu, "$1 $2");

  return s.replace(/\s+/g, " ").trim();
}

export const tokenize = (text: string): string[] =>
  normalizeStopText(text).split(" ").filter(Boolean);

// ------------------------------------------------------------- distance

/** Levenshtein with an early bail — 923 names on every keystroke of a query. */
export function editDistance(a: string, b: string, ceiling = Infinity): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (row[j] < best) best = row[j];
    }
    if (best > ceiling) return ceiling + 1;
    prev = row;
  }
  return prev[b.length];
}

const similarity = (a: string, b: string): number => {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - editDistance(a, b) / longest;
};

/**
 * How well one query token matches one name token.
 *
 * Prefix matching is generous on purpose: partial input is the normal case, not
 * the exception. Someone half-remembers a name, or ASR clips the ending.
 */
function tokenScore(queryToken: string, nameToken: string): number {
  if (queryToken === nameToken) return 1;

  const qStem = stripCaseEnding(queryToken);
  const nStem = stripCaseEnding(nameToken);
  if (qStem === nStem && qStem.length >= MIN_STEM_LENGTH) return 0.97;

  // "сансар" against "сансарын" — the query is a prefix of the name.
  if (nameToken.startsWith(queryToken) && queryToken.length >= 3) {
    return 0.9 * (queryToken.length / nameToken.length) + 0.08;
  }
  if (queryToken.startsWith(nameToken) && nameToken.length >= 3) {
    return 0.85 * (nameToken.length / queryToken.length) + 0.05;
  }

  // Short tokens are edit-distance hazards: МҮИС and КТМС differ by 2 of 4
  // characters, which a naive ratio calls a 50 % match. Acronyms must match
  // nearly exactly or not at all.
  const shortest = Math.min(queryToken.length, nameToken.length);
  const sim = similarity(qStem, nStem);
  if (shortest <= 5) return sim >= 0.8 ? sim * 0.9 : 0;

  return sim >= 0.62 ? sim * 0.85 : 0;
}

// --------------------------------------------------------------- results

export type StopGroup = {
  /** Normalized base, the grouping key. */
  key: string;
  /** Display name of the representative stop, suffix intact. */
  name: string;
  /**
   * Every platform sharing this name.
   *
   * Grouped deliberately. `Буянт-Ухаа спорт цогцолбор` exists on all four
   * compass platforms, and offering a blind user four options they cannot tell
   * apart — and could not act on if they could — is noise. Which platform to
   * use is a routing decision, not a decision for the person travelling, so the
   * group is carried whole and the planner picks.
   */
  stopIds: string[];
  lat: number;
  lon: number;
};

export type StopSearchResult = {
  group: StopGroup;
  /** 0..1. Text match quality alone. */
  score: number;
  distanceM: number | null;
  visits: number;
  /**
   * Which query text produced this score.
   *
   * Only interesting for a multi-alternative search, where it is the difference
   * between what the recogniser thought it heard and what actually matched — and
   * that difference is the only thing that makes a surprising read-back
   * explicable on the debug overlay.
   */
  matchedQuery: string;
  /** Position of `matchedQuery` in the list searched. 0 for a single query. */
  queryRank: number;
};

export type SearchHistory = Record<string, { visits: number; lastUsedAt: number }>;

const EARTH_M = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(s));
}

/**
 * How far apart two platforms can be and still be one place.
 *
 * A NAME IS NOT A PLACE. Ulaanbaatar reuses generic names across districts, and
 * grouping on the name alone merges stops that are nowhere near each other:
 *
 *   5 толгой дэлгүүр   two stops 74 km apart
 *   1-р байр           ~10 km apart — "Building 1" exists in many districts
 *   11-р байр          ~2 km apart
 *
 * Merging those puts the group centroid in empty steppe, so proximity ranking
 * sorts by a location that does not exist and the planner is handed a
 * destination nobody can travel to. 800 m keeps genuine multi-platform
 * interchanges together — Буянт-Ухаа спорт цогцолбор spans 718 m across four
 * platforms — while splitting every one of the reused names above. The normal
 * case is far below it: the median same-name pair is 85 m apart, p90 is 220 m.
 */
export const SAME_PLACE_RADIUS_M = 800;

/**
 * Groups the 923 platforms into distinct places.
 *
 * Built once and reused — regrouping per keystroke would be 923 normalizations
 * on every swipe.
 *
 * Grouping is by name AND proximity, single-linkage: a stop joins an existing
 * group when it shares the name and sits within SAME_PLACE_RADIUS_M of any
 * member. Same-name clusters far apart become separate places, each keeping the
 * name — so a user searching "1-р байр" is offered both and cycles to the one
 * they meant, rather than being handed a single average of the two.
 */
export function buildStopGroups(stops: SearchableStop[]): StopGroup[] {
  const byName = new Map<string, StopGroup[]>();

  for (const stop of stops) {
    const key = normalizeStopText(stop.name);
    if (!key) continue;

    const clusters = byName.get(key) ?? [];
    const near = clusters.find((c) => haversine(c, stop) <= SAME_PLACE_RADIUS_M);

    if (near) {
      near.stopIds.push(stop.id);
      // Running centroid, so proximity ranking is not biased toward whichever
      // platform happened to come first in the file.
      const n = near.stopIds.length;
      near.lat += (stop.lat - near.lat) / n;
      near.lon += (stop.lon - near.lon) / n;
    } else {
      clusters.push({ key, name: stop.name, stopIds: [stop.id], lat: stop.lat, lon: stop.lon });
      byName.set(key, clusters);
    }
  }

  // Distinct clusters of one name need distinct keys, or history and dedupe
  // would treat two different places as the same destination.
  const out: StopGroup[] = [];
  for (const clusters of byName.values()) {
    clusters.forEach((c, i) => out.push(clusters.length > 1 ? { ...c, key: `${c.key}#${i}` } : c));
  }
  return out;
}

/** Text match quality for one query against one group. */
export function scoreGroup(queryTokens: string[], group: StopGroup): number {
  if (queryTokens.length === 0) return 0;
  const nameTokens = tokenize(group.name);
  if (nameTokens.length === 0) return 0;

  // Each query token takes its best available name token. Coverage of the QUERY
  // is what matters — a user says the distinctive part of a name, not all of
  // it, so unmatched name tokens must not be punished heavily.
  let total = 0;
  for (const q of queryTokens) {
    let best = 0;
    for (const n of nameTokens) {
      const s = tokenScore(q, n);
      if (s > best) best = s;
    }
    total += best;
  }
  const coverage = total / queryTokens.length;

  // A mild preference for names the query covers more of, so "сансар" ranks
  // `Сансар ШТС` (2 tokens) above `Сансарын үйлчилгээний төв` (3) — the shorter
  // name is more likely what a one-word query meant.
  const brevity = 1 - 0.12 * Math.max(0, nameTokens.length - queryTokens.length) / nameTokens.length;

  return Math.max(0, Math.min(1, coverage * brevity));
}

/** Below this a result is noise and is not offered at all. */
export const MIN_SCORE = 0.55;

/** Text scores within this are treated as tied, letting the tiebreakers bite. */
export const SCORE_EPSILON = 0.06;

export type SearchOptions = {
  from?: { lat: number; lon: number } | null;
  history?: SearchHistory;
  limit?: number;
  minScore?: number;
};

/**
 * Score an alternative must give up for each place it sits below the
 * recogniser's own first choice.
 *
 * The recogniser's ranking of Mongolian proper nouns is weak — that is the
 * whole reason for reading past the first alternative — but it is not
 * worthless, so a lower alternative has to win by a real margin, not a rounding
 * error. Three alternatives span exactly SCORE_EPSILON, the same margin that
 * decides a tie between two stops: an alternative displaces the primary
 * transcript only when it would also have beaten it outright as a stop match.
 *
 * The penalty applies BEFORE the minScore cut as well, which is the other half
 * of its job. Searching N transcripts otherwise gives noise N independent
 * chances to clear the bar, and a false match here puts a blind passenger on a
 * bus to the wrong district.
 */
export const ALTERNATIVE_PENALTY = 0.03;

/**
 * Rank by text score, then proximity, then history — in that order.
 *
 * Bucketed rather than lexicographic on raw floats: two names that match the
 * query equally well never score bit-identically, so a strict comparison
 * would let a meaningless 0.001 of text score outweigh the user standing next
 * to one of them. SCORE_EPSILON is what makes the later keys actually apply.
 */
function byRank(a: StopSearchResult, b: StopSearchResult): number {
  if (Math.abs(a.score - b.score) > SCORE_EPSILON) return b.score - a.score;
  if (a.distanceM !== null && b.distanceM !== null && Math.abs(a.distanceM - b.distanceM) > 100) {
    return a.distanceM - b.distanceM;
  }
  if (a.visits !== b.visits) return b.visits - a.visits;
  // Last real signal before an arbitrary one: with everything else tied, prefer
  // the stop that matched what the recogniser thought it heard first. The
  // penalty alone cannot do this — it is smaller than SCORE_EPSILON by design,
  // so two exact matches from different alternatives land in the same bucket and
  // would otherwise be ordered alphabetically, which is a coin flip that the
  // user pays for in an extra gesture on the read-back.
  if (a.queryRank !== b.queryRank) return a.queryRank - b.queryRank;
  return a.group.name.localeCompare(b.group.name, "mn");
}

export function searchStops(
  query: string,
  groups: StopGroup[],
  options: SearchOptions = {},
): StopSearchResult[] {
  return searchStopsAny([query], groups, options);
}

/**
 * Searches every transcript the recogniser offered and keeps the best MATCH,
 * not the best transcript.
 *
 * Speech recognition is transcribing a proper noun that is not in its language
 * model, so the ordering between near-homophones is close to arbitrary — but
 * only one of them is a real stop name, and the stop list knows which. Ranking
 * `Сансар` above `Сан сар` is a question the recogniser cannot answer and this
 * function can.
 *
 * Each group takes its best-scoring alternative; the alternatives do not each
 * get a slot in the result, so a user is never read back the same place twice
 * because two transcripts of it both matched.
 */
export function searchStopsAny(
  queries: string[],
  groups: StopGroup[],
  { from = null, history = {}, limit = 3, minScore = MIN_SCORE }: SearchOptions = {},
): StopSearchResult[] {
  // Rank is the index in the ORIGINAL list, so filtering empty transcripts
  // cannot promote a later alternative into the primary's penalty-free slot.
  const parsed = queries
    .map((query, rank) => ({ query, rank, tokens: tokenize(query) }))
    .filter((q) => q.tokens.length > 0);
  if (parsed.length === 0) return [];

  const scored: StopSearchResult[] = [];
  for (const group of groups) {
    let best: { score: number; query: string; rank: number } | null = null;
    for (const { query, rank, tokens } of parsed) {
      const score = scoreGroup(tokens, group) - rank * ALTERNATIVE_PENALTY;
      if (!best || score > best.score) best = { score, query, rank };
    }
    if (!best || best.score < minScore) continue;
    scored.push({
      group,
      score: best.score,
      matchedQuery: best.query,
      queryRank: best.rank,
      distanceM: from ? haversine(from, group) : null,
      visits: history[group.key]?.visits ?? 0,
    });
  }

  scored.sort(byRank);
  return scored.slice(0, limit);
}

// --------------------------------------------------------------- history

export const HISTORY_KEY = "vision-access:destination-history";

/**
 * Most journeys repeat, so a regular commuter should reach their stop in one
 * gesture. History is keyed on the normalized group, not a stop id, so a
 * platform change in a data rebuild does not lose someone's daily commute.
 */
export function recordDestination(history: SearchHistory, key: string, now: number): SearchHistory {
  return { ...history, [key]: { visits: (history[key]?.visits ?? 0) + 1, lastUsedAt: now } };
}

/** The places this user actually goes, most-used first. Offered before any search. */
export function frequentDestinations(
  history: SearchHistory,
  groups: StopGroup[],
  limit = 5,
): StopGroup[] {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  return Object.entries(history)
    .sort(([, a], [, b]) => b.visits - a.visits || b.lastUsedAt - a.lastUsedAt)
    .map(([key]) => byKey.get(key))
    .filter((g): g is StopGroup => Boolean(g))
    .slice(0, limit);
}

export function loadSearchHistory(storage: Storage): SearchHistory {
  try {
    const raw = storage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as SearchHistory) : {};
  } catch {
    return {};
  }
}

export function saveSearchHistory(storage: Storage, history: SearchHistory): void {
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Private mode. Search still works; it just stops learning.
  }
}
