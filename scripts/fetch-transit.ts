/**
 * Build-time. Fetches the static Hamuga transit data once and writes a flat
 * public/data/stops.json that the client loads with no key and no round trip.
 *
 *   npx tsx scripts/fetch-transit.ts            # fetch and write
 *   npx tsx scripts/fetch-transit.ts --inspect  # print sample records, write nothing
 *
 * CLAUDE.md allows this: it is not inference and it does not run at request
 * time. HAMUGA_API_KEY is read here and nowhere else, and nothing it touches
 * reaches the browser — the app ships the generated JSON instead.
 *
 * Written WITHOUT the OpenAPI spec, so field names are matched leniently and
 * anything unrecognised is reported with the keys that actually arrived rather
 * than throwing something unreadable. Run --inspect first against a new API
 * version; it is faster than guessing.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const BASE = "https://gateway.hamuga.mn/transport";
const GROUP_INFO = "/api/bus/v1/group/info";
const STATION_LIST = "/api/bus/v1/bus_station_list";
const PER_PAGE = 100;
const OUT = "public/data/stops.json";

/** The API answers HTTP 200 with a failure body, so this is the real check. */
const SUCCESS_CODE = "0000";

/** 5dp is ~1.1m — finer than any phone GPS fix, and it roughly halves the file. */
const COORD_DP = 5;

const root = process.cwd();
if (!existsSync(join(root, "public"))) {
  console.error(`No public/ under ${root} — run this from the project root.`);
  process.exit(1);
}

const inspect = process.argv.includes("--inspect");

/** Minimal .env.local reader — this is a standalone script, not a Next runtime. */
function loadEnvLocal() {
  const path = join(root, ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, name, raw] = match;
    if (!process.env[name]) process.env[name] = raw.replace(/^["']|["']$/g, "");
  }
}

loadEnvLocal();

const apiKey = process.env.HAMUGA_API_KEY;
if (!apiKey) {
  console.error("HAMUGA_API_KEY is not set (looked in the environment and .env.local).");
  console.error("Add it to .env.local — it is build-time only and must never ship to the client.");
  process.exit(1);
}

type Row = Record<string, unknown>;

/**
 * One request, envelope unwrapped.
 *
 * `{ status, code, msg, data }` with code "0000" for success — a non-"0000"
 * body still arrives as HTTP 200, so checking the status line alone would
 * happily write a file full of error objects.
 */
async function api(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url, { headers: { "x-api-key": apiKey! } });
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`${path}: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }

  let body: { code?: string; msg?: string; data?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path}: response was not JSON — ${text.slice(0, 200)}`);
  }

  if (body.code !== undefined && body.code !== SUCCESS_CODE) {
    throw new Error(`${path}: code ${body.code} — ${body.msg ?? "no message"}`);
  }
  return body.data ?? body;
}

/**
 * The array inside a response, wherever the API chose to put it.
 *
 * Without the spec this cannot be assumed, so the common wrappers are tried and
 * a miss reports the keys that were actually present — enough to fix the caller
 * in one run instead of bisecting blind.
 */
function asRows(data: unknown, path: string): Row[] {
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    for (const key of ["list", "items", "rows", "records", "content", "data", "result"]) {
      const value = (data as Row)[key];
      if (Array.isArray(value)) return value as Row[];
    }
    throw new Error(
      `${path}: expected an array; got an object with keys [${Object.keys(data).join(", ")}]`,
    );
  }
  throw new Error(`${path}: expected an array, got ${typeof data}`);
}

/** First present field among several spellings — camelCase, snake_case, or short. */
function pick(row: Row, ...names: string[]): unknown {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return row[name];
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Truthy across the several ways an API can spell a boolean. */
function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "1", "y", "yes"].includes(v)) return true;
    if (["false", "0", "n", "no"].includes(v)) return false;
  }
  return undefined;
}

const round = (n: number) => Number(n.toFixed(COORD_DP));

/**
 * A route as it will eventually be spoken, e.g. "Ч:81".
 *
 * Routes may arrive as plain strings or as objects; both are handled, and an
 * unrecognised shape is skipped rather than serialised into the file as
 * "[object Object]" for someone to discover on a phone later.
 */
function routeLabel(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() || null;
  if (typeof entry === "number") return String(entry);
  if (entry && typeof entry === "object") {
    const row = entry as Row;
    const direct = pick(row, "routeName", "route_name", "busNumber", "bus_number", "name", "code");
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    if (typeof direct === "number") return String(direct);
    // Some shapes carry the prefix and the number apart.
    const prefix = pick(row, "prefix", "routeType", "route_type", "typeCode");
    const number = pick(row, "number", "routeNo", "route_no", "no");
    if (number !== undefined) {
      return prefix !== undefined ? `${prefix}:${number}` : String(number);
    }
  }
  return null;
}

/** Every page of a paginated list endpoint. */
async function fetchAllPages(path: string): Promise<Row[]> {
  const all: Row[] = [];
  for (let page = 1; ; page++) {
    const rows = asRows(await api(path, { page, perPage: PER_PAGE }), path);
    all.push(...rows);
    process.stdout.write(`\r  ${path}: ${all.length} rows`);
    // A short page is the last page. Also stops if the API ignores paging
    // entirely and returns everything at once.
    if (rows.length < PER_PAGE) break;
    if (page > 500) throw new Error(`${path}: pagination did not terminate`);
  }
  process.stdout.write("\n");
  return all;
}

function sample(rows: Row[], label: string) {
  console.log(`\n--- ${label}: ${rows.length} rows ---`);
  if (rows.length === 0) return;
  console.log(`keys: ${Object.keys(rows[0]).join(", ")}`);
  console.log(JSON.stringify(rows[0], null, 2).slice(0, 900));
}

type Stop = { id: string; name: string; lat: number; lon: number; routes: string[] };

async function main() {
  console.log(`Hamuga → ${OUT}\n`);

  const groups = asRows(await api(GROUP_INFO), GROUP_INFO);
  console.log(`  ${GROUP_INFO}: ${groups.length} rows`);
  const stations = await fetchAllPages(STATION_LIST);

  if (inspect) {
    sample(groups, GROUP_INFO);
    sample(stations, STATION_LIST);
    console.log("\n--inspect: nothing written.");
    return;
  }

  // Coordinates, keyed by stop id.
  const coords = new Map<string, { lat: number; lon: number }>();
  let missingCoords = 0;
  for (const row of stations) {
    const id = pick(row, "busStopId", "bus_stop_id", "stationId", "station_id", "id");
    const lat = asNumber(pick(row, "lat", "latitude", "yCoord", "y"));
    const lon = asNumber(pick(row, "lon", "lng", "longitude", "xCoord", "x"));
    if (id === undefined || lat === undefined || lon === undefined) {
      missingCoords++;
      continue;
    }
    coords.set(String(id), { lat, lon });
  }

  const stops: Stop[] = [];
  let dropped = 0;
  let unmatched = 0;
  const allRoutes = new Set<string>();

  for (const row of groups) {
    const id = pick(row, "busStopId", "bus_stop_id", "stationId", "station_id", "id");
    if (id === undefined) continue;

    // Inactive and deleted stops are excluded. Defaulting to KEEP when the flag
    // is absent: a stop wrongly dropped is a stop the user can never be told
    // about, which is worse than one extra entry in a lookup table.
    const isActive = asBool(pick(row, "isActive", "is_active", "active"));
    const isDeleted = asBool(pick(row, "isDeleted", "is_deleted", "deleted"));
    if (isActive === false || isDeleted === true) {
      dropped++;
      continue;
    }

    const point = coords.get(String(id));
    if (!point) {
      unmatched++;
      continue;
    }

    const rawRoutes = pick(row, "routes", "routeList", "route_list", "buses", "busList");
    const routes = Array.isArray(rawRoutes)
      ? [...new Set(rawRoutes.map(routeLabel).filter((r): r is string => r !== null))]
      : [];
    for (const r of routes) allRoutes.add(r);

    const name = pick(row, "busStopName", "bus_stop_name", "stationName", "station_name", "name");

    stops.push({
      id: String(id),
      name: typeof name === "string" ? name.trim() : String(id),
      lat: round(point.lat),
      lon: round(point.lon),
      routes,
    });
  }

  if (stops.length === 0) {
    console.error("\nNo stops survived the join. Run with --inspect to see the real field names.");
    process.exit(1);
  }

  const outPath = resolve(root, OUT);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(stops), "utf8");

  const prefixes = [...new Set([...allRoutes].map((r) => r.split(":")[0]).filter((p) => /\D/.test(p)))];

  console.log(`\n${stops.length} stops written`);
  console.log(`  ${dropped} dropped (inactive or deleted)`);
  console.log(`  ${unmatched} had no coordinates`);
  if (missingCoords) console.log(`  ${missingCoords} station rows unusable`);

  // These two lines decide how a route can be spoken. There are digit clips
  // (n_0..n_9) and NO Cyrillic letter clips, so a prefix like "Ч" currently has
  // no pronunciation — see NOTES.md before wiring the announcement.
  console.log(`\ndistinct routes: ${allRoutes.size}`);
  console.log(`route prefixes: ${prefixes.sort().join(" ") || "(none — routes are bare numbers)"}`);
  console.log(`distinct stop names: ${new Set(stops.map((s) => s.name)).size}`);

  console.log(`\n${OUT} — ${(statSync(outPath).size / 1024).toFixed(1)} KB`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  console.error("Run with --inspect to dump the raw shapes.");
  process.exit(1);
});
