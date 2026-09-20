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
 * Mongolian cardinals 1–40 in ATTRIBUTIVE form, for "N буудал үлдлээ".
 *
 * ── THE BUG THIS REPLACES ──────────────────────────────────────────────────
 *
 * The comment here used to say attributive forms "are not used: the countdown
 * says the number as a standalone count before a noun phrase the clip already
 * carries". That reasoning is wrong about the grammar. A Mongolian numeral
 * standing before the noun it counts takes the attributive form whether or not
 * the two arrived from separate audio clips — the listener hears one phrase, and
 * `гурав буудал` is ungrammatical in it. The app has been saying that, and
 * `дөрөв буудал`, and `тав минутын дараа`, to every rider since the countdown
 * shipped.
 *
 * Every one of the ~10 places that plays a `num_N` clip puts a noun immediately
 * after it — `буудал`, `буудлын`, `минутын` — so there is no site that wants the
 * standalone form and no branch is needed. The table is simply the right one now.
 *
 * ── BUILT FROM PARTS, NOT TYPED OUT FORTY TIMES ────────────────────────────
 *
 * §11 says every Mongolian string is a draft pending a native review pass. A
 * reviewer correcting `дөрвөн` should change one word, not hunt for the four
 * places 4 appears. So the table is composed from ten units and three tens, and
 * `speech.test.ts` asserts the generated output against the reviewed table in
 * CLAUDE.md.
 *
 * Note the tens were ALREADY attributive as compound modifiers — `арван нэг`,
 * not `арав нэг`. Only the trailing unit was wrong, plus the bare tens
 * themselves: standalone `хорь`/`гуч`/`дөч` become `хорин`/`гучин`/`дөчин`
 * before a noun.
 */
const UNITS_ATTRIBUTIVE: Record<number, string> = {
  1: "нэгэн", 2: "хоёр", 3: "гурван", 4: "дөрвөн", 5: "таван",
  6: "зургаан", 7: "долоон", 8: "найман", 9: "есөн",
};

/** Also the modifier form used inside compounds: `хорин гурван`. */
const TENS_ATTRIBUTIVE: Record<number, string> = {
  10: "арван", 20: "хорин", 30: "гучин", 40: "дөчин",
};

function attributiveCardinal(n: number): string {
  const tens = Math.floor(n / 10) * 10;
  const unit = n % 10;
  if (unit === 0) return TENS_ATTRIBUTIVE[tens];
  if (tens === 0) return UNITS_ATTRIBUTIVE[unit];
  return `${TENS_ATTRIBUTIVE[tens]} ${UNITS_ATTRIBUTIVE[unit]}`;
}

export const CARDINALS: Record<number, string> = Object.fromEntries(
  Array.from({ length: 40 }, (_, i) => [i + 1, attributiveCardinal(i + 1)]),
);

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
  /**
   * The overshoot follow-ups. Both mirror an existing reviewed phrase rather
   * than being composed: `буудал өнгөрлөө` is `ui_ride_manual_advance` with its
   * numeral removed, and so is the sibling of `буудал үлдлээ` — same noun, same
   * slot, same tense marker under vowel harmony. `Дараагийн буудалд буугаарай`
   * keeps the imperative of `bus_get_off_now` and takes its place phrase from
   * `bus_next_stop`.
   *
   * The suffix means "N stops have passed", NOT "N stops past your stop". What
   * supplies the destination is `bus_passed_stop`, which is why every overshoot
   * utterance re-speaks it — see announceRemaining.
   */
  { id: "bus_stops_past_suffix", mn: "буудал өнгөрлөө", en: "… stops have passed (suffix, pairs with num_N)" },
  { id: "bus_get_off_next_stop", mn: "Дараагийн буудалд буугаарай", en: "get off at the next stop" },
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
