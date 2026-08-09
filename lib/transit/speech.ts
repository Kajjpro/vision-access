/**
 * Display text → spoken text.
 *
 * Chimege accepts Cyrillic letters, spaces and `? ! . - ' " : ,` and nothing
 * else — digits, slashes and Latin letters all come back as HTTP 400. Of the
 * 923 stop names in the feed, 895 contain at least one rejected character, so
 * a stop name can never be sent to TTS as written.
 *
 * This is the same rule the route names follow: `displayName` is what goes on
 * screen and matches the signage, spoken text is a separate value, and the two
 * must never share a source. The difference is that 84 route names are worth
 * hand-authoring and 923 stop names are not — so stop speech is derived
 * mechanically here, from a reviewed table of the 77 numeric tokens that
 * actually occur.
 *
 * Nothing in here falls back to the display string. An unmappable name throws;
 * the build turns that into a listed failure rather than a clip that says a
 * digit out loud or, worse, plays silence.
 */

/** Exactly what the API documents, verified against it: everything else 400s. */
export const CHIMEGE_ALLOWED = /^[Ѐ-ӿ ?!.\-'":,]+$/;

/** Direction suffixes, already case-normalised by the build pipeline. */
const DIRECTION_WORDS = ["Хойд", "Урд", "Зүүн", "Баруун", "Дунд"];

export type NumberWords = Record<string, string>;

/** Table entries starting with `_` are documentation, not mappings. */
export function loadNumberWords(raw: Record<string, unknown>): NumberWords {
  const out: NumberWords = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    if (typeof v !== "string" || !v.trim()) continue;
    out[k] = v.trim();
  }
  return out;
}

/** Tokens that must be replaced before the text can be sent. */
export function findUnspeakableTokens(name: string, table: NumberWords): string[] {
  const remaining = applyTable(stripSuffix(name).base, table);
  const bad = new Set<string>();
  for (const m of remaining.matchAll(/[0-9]+[^\s]*|[A-Za-z]+/g)) bad.add(m[0]);
  return [...bad];
}

function stripSuffix(name: string): { base: string; suffix: string | null } {
  const m = /^(.*?)\s*\/\s*([^/]+?)\s*\/\s*$/.exec(name);
  if (!m) return { base: name.trim(), suffix: null };
  return { base: m[1].trim(), suffix: m[2].trim() };
}

/**
 * Slashes that are not the trailing platform suffix.
 *
 * Two shapes occur: a second bracketed qualifier (`Сансар /Тунель/ /Хойд/`),
 * which reads naturally as an appositive, and a separator inside a word
 * (`Монгол цах/утас компани`), where the slash stands in for "and". Both are
 * rejected by Chimege, and neither should reach it as a literal.
 */
function flattenInteriorSlashes(text: string): string {
  return text
    .replace(/\s*\/\s*([^/]+?)\s*\/\s*/g, ", $1, ")
    .replace(/\//g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*$/, "")
    .trim();
}

/**
 * Longest key first, so `7 буудал` wins over the bare `7` and `112-ын` wins
 * over `112`. Without that ordering the compound tokens get shredded into a
 * number followed by an orphaned noun.
 */
function applyTable(text: string, table: NumberWords): string {
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  let out = text;
  for (const key of keys) {
    if (!out.includes(key)) continue;
    out = out.split(key).join(` ${table[key]} `);
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Display text → spoken text, for engines that read numerals themselves.
 *
 * `Сансар /Хойд/` → `Сансар Хойд`. The platform marker is kept as a word — at a
 * shared-name pair it is the only thing separating the two — but the slashes
 * never reach the engine. Azure returns 200 for them, yet a punctuation mark
 * whose handling is undefined sits one model update away from being read aloud
 * or breaking the prosody, and there is no reason to send it.
 *
 * Whitespace variants in the feed are real: `/ Баруун /`, `Салхит завсар-1/Баруун/`,
 * and double-slashed forms like `Сансар /Тунель/ /Хойд/` all occur.
 *
 * This is the stop-name half of the same rule the routes follow: what is shown
 * and what is spoken are different fields.
 */
export function toSpeechText(displayName: string): string {
  return String(displayName ?? "")
    // Bracketed groups anywhere in the string, not just the trailing suffix.
    .replace(/\s*\/\s*([^/]+?)\s*\/\s*/g, " $1 ")
    // A lone slash used as a separator, e.g. `Монгол цах/утас компани`.
    .replace(/\//g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type SpeechResult = { text: string; ok: true } | { text: null; ok: false; reason: string };

/**
 * The spoken form of a stop name.
 *
 * `Саппоро /Урд/` → `Саппоро, Урд` — the platform side is kept, because at a
 * shared-name pair it is the only thing distinguishing the two, and the comma
 * gives Chimege a prosodic break instead of running the words together.
 */
export function stopNameToSpeech(displayName: string, table: NumberWords, accepts?: RegExp): SpeechResult {
  // Engines that read numerals themselves need none of the rewriting below.
  // Azure expands `19-р` to a spoken ordinal of the same duration as the
  // hand-written `арван есдүгээр`, so on that provider the number table — which
  // is a DRAFT awaiting native review — is bypassed entirely rather than being
  // a source of wrong Mongolian nobody has checked.
  if (!accepts) {
    const text = toSpeechText(displayName);
    return text ? { text, ok: true } : { text: null, ok: false, reason: "empty stop name" };
  }

  const { base, suffix } = stripSuffix(displayName);
  if (!base) return { text: null, ok: false, reason: "empty stop name" };

  let spoken = applyTable(flattenInteriorSlashes(base), table);

  if (suffix) {
    const canonical = DIRECTION_WORDS.find((w) => w.toLowerCase() === suffix.toLowerCase());
    const spokenSuffix = applyTable(canonical ?? suffix, table);
    if (spokenSuffix) spoken = `${spoken}, ${spokenSuffix}`;
  }

  spoken = spoken.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();

  if (!spoken) return { text: null, ok: false, reason: "nothing left after transformation" };
  if (!CHIMEGE_ALLOWED.test(spoken)) {
    const bad = [...new Set(spoken.split("").filter((c) => !/[Ѐ-ӿ ?!.\-'":,]/.test(c)))];
    return {
      text: null,
      ok: false,
      reason: `unmapped characters ${JSON.stringify(bad.join(""))} — add the token to data/number-words.json`,
    };
  }
  return { text: spoken, ok: true };
}

/** Route short names are hand-authored; this only guards what was written. */
export function routeSpokenNameToSpeech(spokenName: string): SpeechResult {
  const text = String(spokenName ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { text: null, ok: false, reason: "empty spokenName" };
  if (!CHIMEGE_ALLOWED.test(text)) {
    const bad = [...new Set(text.split("").filter((c) => !/[Ѐ-ӿ ?!.\-'":,]/.test(c)))];
    return { text: null, ok: false, reason: `spokenName contains characters Chimege rejects: ${JSON.stringify(bad.join(""))}` };
  }
  return { text, ok: true };
}

/**
 * Mongolian cardinals 1–40, for "N буудал үлдлээ".
 *
 * Attributive forms (`нэгэн`, `хоёр`…) are not used: the countdown says the
 * number as a standalone count before a noun phrase the clip already carries.
 */
export const CARDINALS: Record<number, string> = {
  1: "нэг", 2: "хоёр", 3: "гурав", 4: "дөрөв", 5: "тав",
  6: "зургаа", 7: "долоо", 8: "найм", 9: "ес", 10: "арав",
  11: "арван нэг", 12: "арван хоёр", 13: "арван гурав", 14: "арван дөрөв", 15: "арван тав",
  16: "арван зургаа", 17: "арван долоо", 18: "арван найм", 19: "арван ес", 20: "хорь",
  21: "хорин нэг", 22: "хорин хоёр", 23: "хорин гурав", 24: "хорин дөрөв", 25: "хорин тав",
  26: "хорин зургаа", 27: "хорин долоо", 28: "хорин найм", 29: "хорин ес", 30: "гуч",
  31: "гучин нэг", 32: "гучин хоёр", 33: "гучин гурав", 34: "гучин дөрөв", 35: "гучин тав",
  36: "гучин зургаа", 37: "гучин долоо", 38: "гучин найм", 39: "гучин ес", 40: "дөч",
};

/**
 * Every fixed phrase the bus modes speak.
 *
 * The `…` in a template is a gap filled by another clip at playback time, never
 * by string interpolation — there is no runtime TTS. `Ойролцоогоор … минутын
 * дараа` is deliberately hedged: a schedule-derived estimate spoken as a bare
 * arrival time would be a false certainty, and unlike a sighted passenger the
 * user cannot see that the countdown board disagrees.
 */
export const FIXED_PHRASES: { id: string; mn: string; en: string }[] = [
  { id: "bus_you_are_at", mn: "Та", en: "you are at stop … (prefix)" },
  { id: "bus_at_stop_suffix", mn: "буудал дээр байна", en: "… (suffix) you are at stop" },
  { id: "bus_stops_remaining", mn: "буудал үлдлээ", en: "… stops remaining" },
  { id: "bus_next_stop", mn: "Дараагийн буудал", en: "next stop" },
  { id: "bus_get_ready", mn: "Бэлдээрэй", en: "get ready" },
  { id: "bus_get_off_now", mn: "Одоо буугаарай", en: "get off now" },
  { id: "bus_passed_stop", mn: "Та буудлаа өнгөрчээ", en: "you passed your stop" },
  // --- degraded states -------------------------------------------------
  // One phrase per CAUSE. Speaking "location unavailable" for a rate limit
  // sends a user looking for open sky, which cannot help them; the wrong
  // explanation wastes the one action they might take.
  { id: "bus_location_unavailable", mn: "Байршил тодорхойгүй байна", en: "location unavailable (GPS)" },
  { id: "bus_network_unavailable", mn: "Сүлжээ алдагдлаа", en: "network unavailable" },
  { id: "bus_service_unavailable", mn: "Үйлчилгээ түр боломжгүй байна", en: "service unavailable (upstream degraded / breaker open)" },
  { id: "bus_no_stop_nearby", mn: "Ойролцоо буудал олдсонгүй", en: "no nearby stop found" },
  { id: "bus_route_info_unavailable", mn: "Чиглэлийн мэдээлэл алга байна", en: "route information unavailable" },
  { id: "bus_tracking_degraded", mn: "Байршил тодорхойгүй боллоо. Товчоор буудал нэмнэ үү", en: "tracking degraded — use the manual advance button" },
  { id: "bus_approx_prefix", mn: "Ойролцоогоор", en: "in approximately … (prefix)" },
  { id: "bus_minutes_suffix", mn: "минутын дараа", en: "… minutes (suffix)" },
  { id: "bus_unnamed_stop", mn: "Нэргүй буудал", en: "generic phrase for an unnamed stop" },
];
