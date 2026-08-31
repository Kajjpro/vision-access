/**
 * Fuzzy stop search, tested against all 923 real stop names.
 *
 * Fixtures would be written from the same assumptions as the code. The cases
 * that matter — `Сансарын` genitive, `MSM` in Latin, `ТЭЦ-4` vs `ТЭЦ4`, the
 * four-platform Буянт-Ухаа — are all properties of the real file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStopGroups, frequentDestinations, normalizeStopText, recordDestination,
  SAME_PLACE_RADIUS_M, searchStops, searchStopsAny, stripCaseEnding, tokenize,
  type SearchableStop,
} from "./stop-search";

const stops: SearchableStop[] = JSON.parse(
  readFileSync(join(process.cwd(), "public/transit/stops.json"), "utf8"),
);
const groups = buildStopGroups(stops);

const names = (q: string, opts = {}) => searchStops(q, groups, opts).map((r) => r.group.name);
const anyNames = (qs: string[], opts = {}) => searchStopsAny(qs, groups, opts).map((r) => r.group.name);

// --------------------------------------------------------- normalization

test("compass platform suffixes are stripped — nobody says them aloud", () => {
  assert.equal(normalizeStopText("Сансар ШТС /Хойд/"), "сансар штс");
  assert.equal(normalizeStopText("Саппоро /Урд/"), "саппоро");
});

test("NON-directional bracketed text is KEPT — it is part of the name", () => {
  // Тунель is the only thing distinguishing this from Сансар ШТС.
  assert.equal(normalizeStopText("Сансар /Тунель/ /Хойд/"), "сансар тунель");
  assert.equal(normalizeStopText("Гэмтлийн эмнэлэг /Дунд/"), "гэмтлийн эмнэлэг дунд");
});

test("an unpaired slash inside a name does not break tokenization", () => {
  // Монгол цах/утас компани /Баруун/ — the inner slash is not a delimiter.
  assert.deepEqual(tokenize("Монгол цах/утас компани /Баруун/"), ["монгол", "цах", "утас", "компани"]);
});

test("digits are preserved — several names differ only by number", () => {
  assert.equal(normalizeStopText("32-р байр"), "32 р байр");
  assert.notEqual(normalizeStopText("32-р байр"), normalizeStopText("34-р байр"));
});

test("hyphenation inconsistency in our own data is reconciled", () => {
  // Both ТЭЦ-4 and ТЭЦ4 exist in stops.json.
  assert.equal(normalizeStopText("ТЭЦ-4"), normalizeStopText("ТЭЦ4"));
});

test("Latin and Cyrillic spellings of the same name converge", () => {
  // MSM is genuinely Latin in the data; a user says it in Cyrillic.
  assert.equal(normalizeStopText("MSM"), normalizeStopText("МСМ"));
});

test("ё and е are interchangeable", () => {
  assert.equal(normalizeStopText("Тёмör"), normalizeStopText("Темör"));
});

// ------------------------------------------------------- case endings

test("Mongolian case endings are stripped down to a real stem", () => {
  assert.equal(stripCaseEnding("сансарын"), "сансар");
  assert.equal(stripCaseEnding("гэмтлийн"), "гэмтл");
  // Never strips into nothing — a 3-character stem is the floor.
  assert.equal(stripCaseEnding("тэд"), "тэд");
  assert.equal(stripCaseEnding("ын"), "ын");
});

// ------------------------------------------------------------- the brief

test("'сансар' finds every Сансар place, including the genitive form", () => {
  const found = names("сансар");
  assert.ok(found.length >= 2, `only found ${JSON.stringify(found)}`);
  // Сансар ШТС and Сансар /Тунель/ are both plain matches...
  assert.ok(found.some((n) => /ШТС/.test(n)), `no ШТС in ${JSON.stringify(found)}`);
  assert.ok(found.some((n) => /Тунель/.test(n)), `no Тунель in ${JSON.stringify(found)}`);
});

test("the genitive Сансарын is reachable from the nominative query", () => {
  // There is no stop called plain `Сансар`. `Сансарын үйлчилгээний төв` must be
  // findable by someone who says "сансар" — this is the case a naive matcher
  // misses entirely.
  const found = searchStops("сансар", groups, { limit: 10 }).map((r) => r.group.name);
  assert.ok(found.some((n) => /Сансарын/.test(n)), `genitive unreachable: ${JSON.stringify(found)}`);
});

test("the search returns a list and never silently picks one", () => {
  const results = searchStops("сансар", groups, { limit: 3 });
  assert.ok(results.length > 1, "a single result would remove the user's choice");
  assert.ok(results.length <= 3);
});

test("partial input works — a half-remembered name still lands", () => {
  assert.ok(names("саппор").length > 0);
  assert.ok(names("цамбагара").length > 0);
});

test("a misheard ending does not lose the match", () => {
  // ASR routinely mangles Mongolian case endings.
  assert.ok(names("саппорог").some((n) => /Саппоро/i.test(n)));
});

// ------------------------------------------------------------- grouping

test("platforms of one place collapse into a single choice", () => {
  // Буянт-Ухаа спорт цогцолбор exists on all four compass platforms. Offering
  // four indistinguishable options to a blind user is noise.
  const found = searchStops("буянт ухаа спорт", groups, { limit: 3 });
  assert.ok(found.length >= 1);
  assert.equal(found[0].group.stopIds.length, 4, "the four platforms did not group");
});

test("grouping is case-insensitive against our own inconsistent data", () => {
  // The file really does contain both `Буянт-ухаа` and `Буянт-Ухаа`.
  const g = groups.find((x) => x.stopIds.length === 4 && /буянт/i.test(x.name));
  assert.ok(g, "case difference split one place into two groups");
});

test("923 platforms reduce to meaningfully fewer places", () => {
  assert.ok(groups.length < stops.length, "grouping did nothing");
  assert.ok(groups.length > 400, `over-grouped to ${groups.length} — distinct places were merged`);
});

test("a NAME is not a PLACE — same-name stops far apart stay separate", () => {
  // `5 толгой дэлгүүр` names two stops 74 km apart, and `1-р байр` is a generic
  // building name reused across districts ~10 km apart. Merging them puts the
  // centroid in empty steppe and hands the planner a destination that does not
  // exist.
  for (const query of ["5 толгой дэлгүүр", "1-р байр"]) {
    const matching = groups.filter((g) => normalizeStopText(g.name).startsWith(normalizeStopText(query)));
    assert.ok(matching.length >= 2, `${query} collapsed into one place`);
  }
});

test("no group spans more than the same-place radius", () => {
  const byId = new Map(stops.map((s) => [s.id, s]));
  const rad = (d: number) => (d * Math.PI) / 180;
  const metres = (a: typeof stops[0], b: typeof stops[0]) => {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  };
  for (const g of groups) {
    const members = g.stopIds.map((id) => byId.get(id)!).filter(Boolean);
    for (const a of members) {
      // Single-linkage, so the guarantee is against the centroid, not pairwise.
      assert.ok(
        metres(a, { ...a, lat: g.lat, lon: g.lon }) <= SAME_PLACE_RADIUS_M * 1.5,
        `${g.name} has a platform far from its own centroid`,
      );
    }
  }
});

test("a genuine multi-platform interchange still groups", () => {
  // Буянт-Ухаа спорт цогцолбор spans 718 m across four platforms and is one
  // place, so the radius must not be tightened below that.
  const g = groups.find((x) => /буянт/i.test(x.name) && x.stopIds.length === 4);
  assert.ok(g, "the four-platform interchange was split");
});

// -------------------------------------------------------------- ranking

test("proximity breaks a tie between equally-good text matches", () => {
  const tied = groups.filter((g) => g.stopIds.length >= 2).slice(0, 1)[0];
  const near = { lat: tied.lat, lon: tied.lon };
  const results = searchStops(tied.name, groups, { from: near, limit: 3 });
  assert.equal(results[0].group.key, tied.key);
});

test("history outranks an equally-good, equally-near alternative", () => {
  const q = "байр";
  const baseline = searchStops(q, groups, { limit: 5 });
  assert.ok(baseline.length >= 2, "need at least two candidates to test ranking");
  const underdog = baseline[1].group.key;

  const history = recordDestination(recordDestination({}, underdog, 1), underdog, 2);
  const ranked = searchStops(q, groups, { history, limit: 5 });
  assert.ok(
    ranked.findIndex((r) => r.group.key === underdog) <= baseline.findIndex((r) => r.group.key === underdog),
    "history did not promote a previously-used destination",
  );
});

test("text quality still dominates — history cannot promote a bad match", () => {
  const history = recordDestination({}, "саппоро", 1);
  const found = names("цамбагарав", { history });
  assert.ok(!found.includes("Саппоро /Урд/"), "history overrode a clearly better text match");
});

// ------------------------------------------------------------- refusals

test("nonsense returns nothing rather than a bad guess", () => {
  assert.deepEqual(names("zzzzqqqqxxxx"), []);
  assert.deepEqual(names(""), []);
  assert.deepEqual(names("   "), []);
});

test("short acronyms do not cross-match", () => {
  // МҮИС and КТМС differ by 2 of 4 characters — a naive ratio calls that 50 %.
  const found = names("мүис");
  assert.ok(!found.some((n) => /КТМС/i.test(n)), `КТМС matched a query for МҮИС: ${JSON.stringify(found)}`);
});

// ------------------------------------------------- recognition alternatives

test("a real stop name buried below a junk transcript is still found", () => {
  // The whole point: "сан сар" matches nothing, and on the old single-transcript
  // path that was the end of the journey — the user was told to try again while
  // the right answer sat in alternative 2.
  assert.deepEqual(names("сан сар"), [], "fixture is only meaningful if the primary matches nothing");
  const found = anyNames(["сан сар", "сансар"]);
  assert.ok(found.includes("Сансар ШТС /Хойд/"), `alternatives were not searched: ${JSON.stringify(found)}`);
});

test("the recogniser's first choice leads when two alternatives match equally well", () => {
  // Both are exact names, so nothing but the recogniser's own order separates
  // them, and the read-back offers the first one.
  assert.equal(anyNames(["саппоро", "цамбагарав"])[0], "Саппоро /Урд/");
  assert.equal(anyNames(["цамбагарав", "саппоро"])[0], "Цамбагарав /Урд/");
});

test("a lower alternative must win by a margin, not a rounding error", () => {
  const results = searchStopsAny(["саппоро", "цамбагарав"], groups, { limit: 4 });
  const primary = results.find((r) => r.matchedQuery === "саппоро")!;
  const alternative = results.find((r) => r.matchedQuery === "цамбагарав")!;
  assert.ok(
    primary.score > alternative.score,
    "an equally-good alternative outscored the primary — the rank penalty is not applied",
  );
});

test("the same place matched by two alternatives is offered once, not twice", () => {
  const results = searchStopsAny(["сансар", "сансарт", "сансар шатахуун"], groups, { limit: 5 });
  const keys = results.map((r) => r.group.key);
  assert.equal(new Set(keys).size, keys.length, `a place was offered twice: ${JSON.stringify(keys)}`);
});

test("searching more transcripts does not give noise more chances to match", () => {
  assert.deepEqual(anyNames(["zzzzqqqq", "qqqqxxxx", "vvvvbbbb"]), []);
  assert.deepEqual(anyNames([]), []);
  assert.deepEqual(anyNames(["", "   "]), []);
});

test("an empty transcript does not promote the next alternative into first place", () => {
  // Rank is the position in the list the recogniser gave, so dropping a blank
  // primary must not hand its penalty-free slot to whatever followed it.
  const [promoted] = searchStopsAny(["", "сансар"], groups, { limit: 1 });
  const [primary] = searchStopsAny(["сансар"], groups, { limit: 1 });
  assert.equal(promoted.group.key, primary.group.key);
  assert.ok(promoted.score < primary.score, "a blank primary was silently dropped from the ranking");
});

test("the matched transcript is reported, so a surprising read-back is explicable", () => {
  const [top] = searchStopsAny(["сан сар", "сансар"], groups, { limit: 1 });
  assert.equal(top.matchedQuery, "сансар");
  assert.equal(top.queryRank, 1);
});

test("a single-query search is unchanged by the multi-query path", () => {
  const single = searchStops("сансар", groups, { limit: 3 });
  assert.ok(single.length > 0);
  assert.ok(single.every((r) => r.queryRank === 0 && r.matchedQuery === "сансар"));
});

// -------------------------------------------------------------- history

test("frequent destinations are offered before any search", () => {
  let history = {};
  const target = groups[10].key;
  for (let i = 0; i < 3; i++) history = recordDestination(history, target, i);
  const frequent = frequentDestinations(history, groups);
  assert.equal(frequent[0].key, target);
});

test("history entries for stops that no longer exist are skipped, not crashed on", () => {
  const history = recordDestination({}, "a place that was renamed", 1);
  assert.deepEqual(frequentDestinations(history, groups), []);
});

// ------------------------------------------------------------ performance

test("a full search over 923 stops is fast enough to run per keystroke", () => {
  const started = Date.now();
  for (let i = 0; i < 50; i++) searchStops("сансар", groups, { limit: 3 });
  const perSearch = (Date.now() - started) / 50;
  assert.ok(perSearch < 20, `${perSearch.toFixed(1)}ms per search is too slow on a cheap Android`);
});
