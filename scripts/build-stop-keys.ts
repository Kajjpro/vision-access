/**
 * Precompute speech-match keys for every stop, at build time.
 *
 *   npx tsx scripts/build-stop-keys.ts        # rewrites public/transit/stops.json
 *   npx tsx scripts/build-stop-keys.ts --check # verify only, non-zero on drift
 *
 * `stopKey()` is not cheap and there are 923 stops. Running it per keystroke —
 * or per utterance — is the difference between a match that lands while the
 * rider is still holding the button and one that lands after they have let go.
 * So it runs exactly once, here, and the result ships in the data file.
 *
 * Reads the file the transit pipeline already produced rather than re-fetching
 * from the gateway: keys are a pure function of the names, so this needs no
 * network and no API key, and it can be re-run after any name change.
 *
 * Emits three fields per stop:
 *   key       the spoken form — platform suffix stripped, because nobody says
 *             "Сансар ШТС хойд" out loud
 *   aliasKeys other spellings that must also hit: the full name including the
 *             platform, and the ordinal-in-words form of any numbered name
 *   placeKey  shared by every platform of one place, so the matcher can offer
 *             "Саппоро" once instead of asking which side of the road
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stopKey } from "../lib/speech/mnNormalize";
import { expandOrdinalsInName } from "../lib/speech/ordinals";

type RawStop = { id: string; name: string; lat: number; lon: number };
type KeyedStop = RawStop & { key: string; aliasKeys?: string[]; placeKey: string };

const STOPS_FILE = join(process.cwd(), "public/transit/stops.json");
const ALIASES_FILE = join(process.cwd(), "data/stop-aliases.json");

/**
 * Human-reviewed spoken variants, keyed by stop id.
 *
 * Produced by `scripts/generate-stop-aliases.ts` and gated on `reviewed`.
 * ONLY REVIEWED ENTRIES ARE READ. A model can write a fluent Mongolian alias
 * for a stop it has never heard of, and a wrong alias routes a blind rider to
 * the wrong district — so the generator marks everything `false` and a person
 * who knows the city flips the ones that are right.
 *
 * Absent file is the normal state before anyone has run the generator; the
 * mechanical aliases below stand on their own.
 */
function reviewedAliases(): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  if (!existsSync(ALIASES_FILE)) return byId;

  let entries: Array<{ id?: string; aliases?: string[]; reviewed?: boolean }>;
  try {
    entries = JSON.parse(readFileSync(ALIASES_FILE, "utf8"));
  } catch (e) {
    // Loud, not silent: a malformed file means aliases someone approved are
    // quietly not shipping, and the symptom is a stop that stops being found.
    throw new Error(`data/stop-aliases.json is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!Array.isArray(entries)) throw new Error("data/stop-aliases.json must be an array.");

  for (const entry of entries) {
    if (entry?.reviewed !== true || !entry.id) continue;
    const texts = (entry.aliases ?? []).filter((a): a is string => typeof a === "string");
    if (texts.length) byId.set(entry.id, texts);
  }
  return byId;
}

/**
 * How far apart two platforms can be and still be one place.
 *
 * Matches SAME_PLACE_RADIUS_M in lib/ui/stop-search.ts deliberately — two
 * different answers to "is this the same place?" in one app is how a stop ends
 * up grouped for browsing and split for speech. Ulaanbaatar reuses names across
 * districts: "5 толгой дэлгүүр" exists twice, 74 km apart.
 */
const SAME_PLACE_RADIUS_M = 800;

/** Compass words the transit authority appends. Nobody speaks them. */
const PLATFORM_SUFFIX = /\s*\/[^/]*\/\s*$/;

const EARTH_M = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(s));
}

export function spokenForm(name: string): string {
  return name.replace(PLATFORM_SUFFIX, "").trim();
}

/**
 * Every key a rider might produce for this stop, besides the primary one.
 *
 * `spokenAliases` are the reviewed, human-approved variants for this stop —
 * what people actually call it, which is routinely not what the feed calls it.
 * They are keyed here rather than in the data file so both sources go through
 * exactly one `stopKey()` implementation; two normalizers would drift and the
 * approved alias would silently stop matching.
 */
export function aliasKeysFor(name: string, spokenAliases: string[] = []): string[] {
  const aliases = new Set<string>();
  const spoken = spokenForm(name);

  for (const alias of spokenAliases) {
    const k = stopKey(alias);
    if (k) aliases.add(k);
  }

  // The full name, compass word included — some riders do read the sign.
  const full = stopKey(name);
  if (full) aliases.add(full);

  // "32-р байр" said as "гучин хоёрдугаар байр". mnNormalize's own table stops
  // at 16; 46 stops carry a higher number and would otherwise be unsayable.
  for (const variant of [spoken, name]) {
    const expanded = expandOrdinalsInName(variant);
    if (expanded) {
      const k = stopKey(expanded);
      if (k) aliases.add(k);
    }
  }

  aliases.delete(stopKey(spoken));
  return [...aliases];
}

/**
 * Assign a placeKey per cluster of same-named platforms within walking distance.
 *
 * Single-linkage on name AND proximity, not name alone: merging every "1-р
 * байр" in the city would put the group's centroid in empty steppe and rank
 * proximity against a location that does not exist.
 */
function assignPlaceKeys(stops: RawStop[]): Map<string, string> {
  const clusters = new Map<string, { lat: number; lon: number; n: number; ids: string[] }[]>();

  for (const stop of stops) {
    const base = stopKey(spokenForm(stop.name));
    if (!base) continue;
    const list = clusters.get(base) ?? [];
    const near = list.find((c) => haversine(c, stop) <= SAME_PLACE_RADIUS_M);
    if (near) {
      near.ids.push(stop.id);
      near.n += 1;
      near.lat += (stop.lat - near.lat) / near.n;
      near.lon += (stop.lon - near.lon) / near.n;
    } else {
      list.push({ lat: stop.lat, lon: stop.lon, n: 1, ids: [stop.id] });
      clusters.set(base, list);
    }
  }

  const byStop = new Map<string, string>();
  for (const [base, list] of clusters) {
    list.forEach((cluster, i) => {
      // Distinct clusters of one name need distinct keys, or two different
      // places are treated as one destination.
      const placeKey = list.length > 1 ? `${base}#${i}` : base;
      for (const id of cluster.ids) byStop.set(id, placeKey);
    });
  }
  return byStop;
}

export function keyStops(
  stops: RawStop[],
  spokenAliases: Map<string, string[]> = new Map(),
): KeyedStop[] {
  const places = assignPlaceKeys(stops);
  return stops.map((stop) => {
    const key = stopKey(spokenForm(stop.name));
    const aliasKeys = aliasKeysFor(stop.name, spokenAliases.get(stop.id));
    return {
      ...stop,
      key,
      ...(aliasKeys.length ? { aliasKeys } : {}),
      placeKey: places.get(stop.id) ?? (key || stop.id),
    };
  });
}

function main() {
  const check = process.argv.includes("--check");
  const raw: RawStop[] = JSON.parse(readFileSync(STOPS_FILE, "utf8"));
  const approved = reviewedAliases();
  const keyed = keyStops(raw, approved);

  if (approved.size) {
    const n = [...approved.values()].reduce((a, list) => a + list.length, 0);
    console.log(`spoken aliases: ${n} reviewed across ${approved.size} stops`);
  }

  const empty = keyed.filter((s) => !s.key);
  if (empty.length) {
    console.error(`${empty.length} stops produced an EMPTY key — they can never be spoken:`);
    for (const s of empty.slice(0, 10)) console.error(`  ${s.id} ${JSON.stringify(s.name)}`);
    process.exit(1);
  }

  // A key shared by two stops that are not the same place is a correctness bug:
  // the rider says one name and can be sent to the other.
  const byKey = new Map<string, KeyedStop[]>();
  for (const s of keyed) {
    const list = byKey.get(s.key) ?? [];
    list.push(s);
    byKey.set(s.key, list);
  }
  const collisions: string[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const places = new Set(list.map((s) => s.placeKey));
    if (places.size < 2) continue; // same place, different platforms — fine
    let max = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) max = Math.max(max, haversine(list[i], list[j]));
    }
    collisions.push(
      `  ${(max / 1000).toFixed(1)}km  ${JSON.stringify(key)}  <- ${[...new Set(list.map((s) => s.name))].join(" | ")}`,
    );
  }

  const places = new Set(keyed.map((s) => s.placeKey)).size;
  console.log(`${keyed.length} stops -> ${byKey.size} keys, ${places} places`);
  console.log(`aliases: ${keyed.reduce((n, s) => n + (s.aliasKeys?.length ?? 0), 0)}`);
  if (collisions.length) {
    console.log(`KEY COLLISIONS across different places: ${collisions.length}`);
    for (const line of collisions) console.log(line);
  } else {
    console.log("no key collisions across distinct places");
  }

  const next = `${JSON.stringify(keyed)}\n`;
  if (check) {
    const current = readFileSync(STOPS_FILE, "utf8");
    if (current !== next) {
      console.error("stops.json is stale — run: npx tsx scripts/build-stop-keys.ts");
      process.exit(1);
    }
    console.log("stops.json keys are up to date");
    return;
  }
  writeFileSync(STOPS_FILE, next, "utf8");
  console.log(`wrote ${STOPS_FILE}`);
}

if (process.argv[1]?.endsWith("build-stop-keys.ts")) main();
