/**
 * Joining the live vehicle feed's `route_name` onto our `Route.displayName`.
 *
 * A WRONG JOIN ANNOUNCES THE WRONG BUS. That is the whole reason this is a
 * module with its own tests rather than a `.replace(":", "-")` at a call site.
 * Someone who cannot see the vehicle has no way to notice that the Ч:48 we
 * announced is actually the Ч:48А pulling in, and boarding the wrong bus is
 * exactly the outcome the app exists to prevent.
 *
 * Everything below is forced by measured data, not by defensive habit — see
 * docs/city-gateway.md §0.4 for the counts behind each rule.
 *
 * THE SEPARATOR PROBLEM IS OURS TOO. The brief frames this as "the feed uses
 * `Ч-1`, we use `Ч:1`", but 1 of our own 84 routes is already `Ч-38` with a
 * hyphen. A join that normalised only the feed side would leave that route
 * permanently unmatched — dark, with no error, because an unmatched vehicle is
 * indistinguishable from a route with no vehicles running.
 */
import type { Route } from "./types";

/**
 * Latin characters that render identically to a Cyrillic letter used in our
 * route names.
 *
 * This is the failure mode most likely to survive code review: a feed emitting
 * Latin `M-1` fails an equality test against Cyrillic `М:1` while looking
 * completely correct in every log line, error message and debugger. Nothing
 * about the bug is visible in its own output.
 *
 * Folding runs Latin → Cyrillic on BOTH sides of the join, so it does not
 * matter which convention the feed picked, only that we apply the same one.
 */
const LATIN_TO_CYRILLIC: Record<string, string> = {
  A: "А", B: "В", E: "Е", K: "К", M: "М", H: "Н", O: "О",
  P: "Р", C: "С", T: "Т", X: "Х", Y: "У", I: "І",
  a: "а", b: "в", e: "е", k: "к", m: "м", o: "о",
  p: "р", c: "с", t: "т", x: "х", y: "у",
};

/**
 * Every separator seen or plausible between prefix and number, collapsed to
 * one canonical form. Includes the several Unicode dashes a CMS can emit
 * without anyone noticing: hyphen-minus, non-breaking hyphen, figure dash,
 * en/em dash, horizontal bar, and minus sign.
 *
 * The hyphen is escaped deliberately: unescaped, `[:-‐]` is a RANGE from U+003A
 * to U+2010 that swallows every Latin and Cyrillic letter, and the symptom is
 * that every route name in the city becomes unparseable at once.
 */
const SEPARATORS = /[:\-‐‑‒–—―−/.\s_]+/g;

const CANONICAL_SEPARATOR = ":";

export type ParsedRouteName = {
  /** Cyrillic, uppercased. `Ч`, `ШҮ`, `АТ`. */
  prefix: string;
  /** Leading zeros stripped. `38`, `1`. */
  number: string;
  /** Uppercased, or "" when absent. `А`, `Б`. */
  suffix: string;
  /** `Ч:38`, `М:1Б` — what the join actually compares. */
  key: string;
};

/**
 * Parses a route label from either side into a canonical key.
 *
 * Returns null rather than a best guess whenever the input cannot be resolved
 * to exactly one route. A null here means "fall back to schedule", which is a
 * correct and safe answer; a guess is neither.
 */
export function parseRouteName(raw: string | null | undefined): ParsedRouteName | null {
  if (raw == null) return null;

  // 1. Fold Latin homoglyphs before anything else, so the character classes
  //    used by every later step see one alphabet.
  let s = "";
  for (const ch of String(raw).trim()) s += LATIN_TO_CYRILLIC[ch] ?? ch;

  // 2. Collapse any separator run to one colon, then strip stray edges.
  s = s.replace(SEPARATORS, CANONICAL_SEPARATOR).replace(/^:+|:+$/g, "");
  if (!s) return null;

  // 3. Case-fold. Our own data is inconsistent here — `Ч:16а` and `Ч:24б` are
  //    lowercase while `Ч:17А` and `Ч:48А` are uppercase — and folding is
  //    verified to produce no collisions across all 84 routes.
  s = s.toUpperCase();

  // 4. Structural parse. Deliberately explicit rather than one dense regex:
  //    each part is a rule with a reason, and a malformed input must fail
  //    loudly here rather than silently match something adjacent.
  const match = /^([^\d:]+):?(\d+)([^\d:]*)$/.exec(s);
  if (!match) return null;

  const prefix = match[1].replace(/:/g, "").trim();
  // Leading zeros stripped — verified safe, no `Ч:9`/`Ч:09` pair exists, so
  // this cannot merge two real routes.
  const number = match[2].replace(/^0+(?=\d)/, "");
  const suffix = match[3].replace(/:/g, "").trim();

  // A bare number cannot be joined. 10 numbers are ambiguous across prefixes —
  // `4` alone is ШҮ:4, М:4, АТ:4 and ЗҮ:4 — so a prefixless label identifies
  // no single route and must not be resolved to the first one that fits.
  if (!prefix) return null;
  if (!number) return null;

  return { prefix, number, suffix, key: `${prefix}${CANONICAL_SEPARATOR}${number}${suffix}` };
}

/** The canonical key alone, for callers that do not need the parts. */
export function normalizeRouteName(raw: string | null | undefined): string | null {
  return parseRouteName(raw)?.key ?? null;
}

export type RouteIndex = {
  /** Canonical key → Route. Built once from our 84. */
  byKey: Map<string, Route>;
  /** Prefixes present in our data, for the digit-3 recovery below. */
  prefixes: Set<string>;
};

/**
 * Builds the lookup our side of the join.
 *
 * Throws on a collision rather than silently dropping a route. Two routes
 * normalising to one key would make one of them permanently unreachable, and a
 * data refresh is exactly when that could start happening — so it must fail the
 * build, not degrade at runtime. Verified clean against the current 84.
 */
export function buildRouteIndex(routes: Route[]): RouteIndex {
  const byKey = new Map<string, Route>();
  const prefixes = new Set<string>();
  const collisions: string[] = [];

  for (const route of routes) {
    const parsed = parseRouteName(route.displayName);
    if (!parsed) {
      collisions.push(`unparseable: ${route.displayName} (${route.id})`);
      continue;
    }
    const existing = byKey.get(parsed.key);
    if (existing) {
      collisions.push(`${parsed.key}: ${existing.displayName} (${existing.id}) vs ${route.displayName} (${route.id})`);
      continue;
    }
    byKey.set(parsed.key, route);
    prefixes.add(parsed.prefix);
  }

  if (collisions.length) {
    throw new Error(`route name collisions — the join would announce the wrong bus:\n  ${collisions.join("\n  ")}`);
  }

  return { byKey, prefixes };
}

export type JoinResult =
  | { ok: true; route: Route; key: string }
  | { ok: false; reason: "unparseable" | "no-prefix" | "unknown-route"; raw: string };

/**
 * Resolves one feed `route_name` to one of our routes.
 *
 * FULL-KEY EQUALITY ONLY — never a prefix match. `Ч:48` is a strict prefix of
 * `Ч:48А`, and eight such families exist (`М:1`/`М:1Б`, `Ч:57`/`Ч:57Б`,
 * `Ч:17А`/`Ч:17Б`, …). A `startsWith` here announces the wrong bus for every
 * one of them, and would pass any test written against a route without a
 * lettered sibling.
 */
export function joinRouteName(raw: string | null | undefined, index: RouteIndex): JoinResult {
  const text = String(raw ?? "");

  const parsed = parseRouteName(raw);
  if (parsed) {
    const direct = index.byKey.get(parsed.key);
    if (direct) return { ok: true, route: direct, key: parsed.key };
  }

  /**
   * Cyrillic З and the digit 3 are visually identical, and one of our prefixes
   * is `ЗҮ`.
   *
   * Unlike the Latin homoglyphs this cannot be folded in `parseRouteName`,
   * because 3 is also a legitimate digit — folding it there would corrupt every
   * route numbered 3, 13, 23, 30-39. So it is retried HERE, against the index,
   * and only when the rewritten prefix is one we actually have. That makes a
   * false positive impossible rather than merely unlikely.
   *
   * The retry runs on the raw text, not on `parsed`: a leading digit means
   * `parseRouteName` rejects the input outright, so there is no `parsed.prefix`
   * to inspect.
   */
  const leadingThree = /^\s*3(?=[^\d\s])/.exec(text);
  if (leadingThree) {
    const retryParsed = parseRouteName(text.replace(/^\s*3/, "З"));
    if (retryParsed && index.prefixes.has(retryParsed.prefix)) {
      const route = index.byKey.get(retryParsed.key);
      if (route) return { ok: true, route, key: retryParsed.key };
    }
  }

  if (!parsed) {
    // Distinguish "we could not read this at all" from "this had no prefix, so
    // it is ambiguous by construction". They need different follow-up: the
    // first is a parser gap, the second is a feed that cannot be joined.
    const bareNumber = /^\s*\d+\s*$/.test(text);
    return { ok: false, reason: bareNumber ? "no-prefix" : "unparseable", raw: text };
  }

  return { ok: false, reason: "unknown-route", raw: text };
}

/**
 * Audits the whole feed's route vocabulary against ours in one pass.
 *
 * Exists because the per-vehicle path must stay quiet about failures — a route
 * we cannot join falls back to schedule and says nothing about why — but
 * somebody has to be able to see the total. Run it against a real
 * `/ubcard-api/vehicles` payload before trusting the live path.
 */
export function auditJoin(
  feedRouteNames: Iterable<string>,
  index: RouteIndex,
): {
  matched: Map<string, string>;
  unmatched: { raw: string; reason: string }[];
  ourRoutesWithNoVehicle: string[];
} {
  const matched = new Map<string, string>();
  const unmatched: { raw: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const raw of feedRouteNames) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const result = joinRouteName(raw, index);
    if (result.ok) matched.set(raw, result.route.displayName);
    else unmatched.push({ raw, reason: result.reason });
  }

  const hit = new Set([...matched.values()]);
  const ourRoutesWithNoVehicle = [...index.byKey.values()]
    .map((r) => r.displayName)
    .filter((name) => !hit.has(name));

  return { matched, unmatched, ourRoutesWithNoVehicle };
}
