/**
 * Build-time transit data pipeline. Emits public/transit/*.json — everything
 * Mode B needs to count down stops with the radio off.
 *
 *   node --env-file=.env.local scripts/build-transit-data.mjs
 *   node --env-file=.env.local scripts/build-transit-data.mjs --refresh
 *   node --env-file=.env.local scripts/build-transit-data.mjs --allow-missing-spoken
 *
 * Runs from `prebuild`, so `npm run build` regenerates it. HAMUGA_API_KEY is
 * read here and never reaches the client — the app ships the generated JSON.
 *
 * SOURCE OF TRUTH is OTP's index GraphQL, not `rot_stop_by_route`. The REST
 * endpoint returns exactly ONE direction per route (it is byte-identical to OTP
 * pattern directionId 0) and exposes no parameter for the other; `up_down`,
 * `page`, `limit` and `size` are all accepted and all ignored. OTP returns both
 * patterns per route with an ordered stop list, a directionId and a real
 * headsign, for every route, in a single POST.
 *
 * `rot_stop_by_route` is still fetched — for all 104 routes — but only as an
 * INDEPENDENT second opinion on which stops are genuinely served. A stop the
 * transit authority says is served outranks the routing engine omitting it:
 * dropping a real stop means a user standing at it is confidently told the name
 * of a different stop hundreds of metres away.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";

const TRANSPORT = "https://gateway.hamuga.mn/transport";
const GRAPHQL = "https://gateway.hamuga.mn/route/routers/default/index/graphql";

const OUT_DIR = "public/transit";
const CACHE_DIR = ".cache/transit";
const TODO_FILE = "route-names.todo.json";
const NAMES_FILE = "data/route-names.json";
const DROPPED_FILE = "probe-output/dropped-stops.json";

/** 5dp is ~1.1 m — finer than any phone GPS fix, and it roughly halves the file. */
const COORD_DP = 5;

/**
 * The gateway rate-limits by locking the key out of EVERY endpoint with a bare
 * `{"message":"Unauthorized"}` — not a 429, not scoped to the endpoint that
 * tripped it. An unthrottled sweep of ~50 requests cost 14 minutes of total
 * lockout during discovery. 700 ms between request starts, 2 in flight, keeps
 * the 104-route loop under ~75 s and has not tripped it.
 */
const MIN_REQUEST_INTERVAL_MS = 700;
const CONCURRENCY = 2;

/** A stop further than this from the nearest kept stop is a real coverage hole. */
const COVERAGE_ALARM_M = 300;

/** Only these get case-normalised. `зуслан`, `Чингэлтэйн эцэс` etc. are places. */
const DIRECTION_WORDS = ["Хойд", "Урд", "Зүүн", "Баруун", "Дунд"];

const args = new Set(process.argv.slice(2));
const REFRESH = args.has("--refresh");
const ALLOW_MISSING_SPOKEN = args.has("--allow-missing-spoken");

const root = process.cwd();
if (!existsSync(join(root, "public"))) {
  console.error(`No public/ under ${root} — run this from the project root.`);
  process.exit(1);
}

const KEY = process.env.HAMUGA_API_KEY ?? process.env.HAMUGA_KEY;
if (!KEY) {
  console.error("HAMUGA_API_KEY is not set (checked HAMUGA_API_KEY and HAMUGA_KEY).");
  console.error("Run: node --env-file=.env.local scripts/build-transit-data.mjs");
  process.exit(1);
}

const log = (...a) => console.log(...a);
const warn = (...a) => console.log("  ! ", ...a);

// ---------------------------------------------------------------- throttle

let lastStart = 0;
let inFlight = 0;
const queue = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire() {
  while (inFlight >= CONCURRENCY) await new Promise((r) => queue.push(r));
  inFlight++;
  const wait = lastStart + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastStart = Date.now();
}

function release() {
  inFlight--;
  queue.shift()?.();
}

/** Bare `{"message":"Unauthorized"}` after a successful call is the limiter. */
class RateLimited extends Error {}

async function request(url, init = {}) {
  await acquire();
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "x-api-key": KEY, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (res.status === 401) throw new RateLimited(`401 from ${url} — gateway rate limiter`);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url} — ${text.slice(0, 160)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`non-JSON from ${url} — ${text.slice(0, 160)}`);
    }
  } finally {
    release();
  }
}

// ------------------------------------------------------------------- cache

const cachePath = (name) => join(root, CACHE_DIR, `${name}.json`);

async function cached(name, produce) {
  const path = cachePath(name);
  if (!REFRESH && existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      warn(`cache ${name} unreadable — refetching`);
    }
  }
  const value = await produce();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
  return value;
}

// ------------------------------------------------------------------ fetch

/**
 * Deliberately does NOT select stop `name`.
 *
 * 40 stops in the feed have a null name, and the schema declares `name`
 * non-null — so a single one of them makes the error bubble all the way up and
 * returns `routes: null`, losing all 104 routes. Every one of those stops
 * belongs to a staging route, but the query dies before we can filter them.
 * Names are resolved separately below, where a null costs one stop instead of
 * the whole build.
 */
const ALL_ROUTES_QUERY = `{
  routes {
    gtfsId shortName longName mode
    patterns { code directionId headsign
      stops { gtfsId lat lon } }
  }
}`;

/** Partial data is expected here: the null-name stops come back as null entries. */
const ALL_STOP_NAMES_QUERY = `{ stops { gtfsId name } }`;

const graphql = (query) =>
  request(GRAPHQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

const fetchGraphqlRoutes = () =>
  cached("otp-routes", async () => {
    const body = await graphql(ALL_ROUTES_QUERY);
    if (body.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
    if (!Array.isArray(body.data?.routes)) throw new Error("GraphQL returned no routes array");
    return body.data.routes;
  });

const fetchGraphqlStopNames = () =>
  cached("otp-stop-names", async () => {
    const body = await graphql(ALL_STOP_NAMES_QUERY);
    const rows = body.data?.stops;
    if (!Array.isArray(rows)) throw new Error("GraphQL returned no stops array");
    // Nulled-out entries are the unnameable stops; keep the rest.
    const named = rows.filter((s) => s?.gtfsId && s.name);
    return { named, nulled: rows.length - named.length, total: rows.length };
  });

/** The gateway answers HTTP 200 with a failure body; code "0000" is success. */
function unwrap(body, label) {
  if (body?.code !== undefined && body.code !== "0000") {
    throw new Error(`${label}: code ${body.code} — ${JSON.stringify(body.msg)}`);
  }
  return body?.data ?? body;
}

const fetchStationList = () =>
  cached("bus-station-list", async () => {
    const data = unwrap(await request(`${TRANSPORT}/api/bus/v1/bus_station_list`), "bus_station_list");
    if (!Array.isArray(data)) throw new Error("bus_station_list did not return an array");
    return data;
  });

const fetchRotStops = (routeId) =>
  cached(`rot-${routeId}`, async () => {
    const url = new URL(`${TRANSPORT}/api/bus/v1/rot_stop_by_route`);
    url.searchParams.set("route_id", routeId);
    const data = unwrap(await request(url), `rot_stop_by_route(${routeId})`);
    return data?.rotStopList ?? [];
  });

const fetchRouteList = () =>
  cached("bus-route-list", async () => {
    const data = unwrap(
      await request(`${TRANSPORT}/api/bus/v1/bus_route_categorized_list`),
      "bus_route_categorized_list",
    );
    if (!Array.isArray(data)) throw new Error("bus_route_categorized_list did not return an array");
    return data;
  });

// ----------------------------------------------------------------- parsing

/**
 * Coordinates arrive as STRINGS in gpxY (lat) / gpxX (lon). Reading `lat`/`lon`
 * here yields undefined → NaN, which is exactly how the first probe run
 * silently planned routes from hardcoded fallback coordinates. Throw instead.
 */
function parseCoords(row, label) {
  const lat = Number(row?.gpxY);
  const lon = Number(row?.gpxX);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`${label}: unparseable coordinates gpxY=${JSON.stringify(row?.gpxY)} gpxX=${JSON.stringify(row?.gpxX)}`);
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error(`${label}: coordinates out of range lat=${lat} lon=${lon}`);
  }
  return { lat, lon };
}

function checkCoords(lat, lon, label) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`${label}: non-finite coordinates lat=${lat} lon=${lon}`);
  }
  return { lat: round(lat), lon: round(lon) };
}

const round = (n) => Number(n.toFixed(COORD_DP));

/** OTP ids are the Hamuga id behind a feed prefix: "1:000000288" → "000000288". */
const bareId = (gtfsId) => String(gtfsId).split(":").pop();

/**
 * Stop names carry their platform in a trailing `/…/` suffix, but inconsistently:
 * `/Хойд/` and `/хойд/` both occur, as do `/ Баруун /` and `Салхит завсар-1/Баруун/`.
 * Left alone, TTS renders a separate clip per spelling of the same stop.
 * Only the five real direction words are case-folded — `зуслан` and
 * `Чингэлтэйн эцэс` are place names that appear in the same position.
 */
function normalizeStopName(raw) {
  let name = String(raw ?? "").replace(/\s+/g, " ").trim();
  const m = /^(.*?)\s*\/\s*([^/]+?)\s*\/\s*$/.exec(name);
  if (!m) return name;

  const [, base, suffixRaw] = m;
  const suffix = suffixRaw.replace(/\s+/g, " ").trim();
  const canonical = DIRECTION_WORDS.find((w) => w.toLowerCase() === suffix.toLowerCase());
  return `${base.trim()} /${canonical ?? suffix}/`;
}

const EARTH_M = 6371000;
const rad = (d) => (d * Math.PI) / 180;

function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(s));
}

// ------------------------------------------------------------------- build

async function main() {
  log("Vision Access — transit data build\n");
  if (REFRESH) log("--refresh: ignoring .cache/\n");

  // --- sources -------------------------------------------------------
  log("Fetching sources…");
  const [otpRoutes, otpNames, stations, routeList] = await Promise.all([
    fetchGraphqlRoutes(),
    fetchGraphqlStopNames(),
    fetchStationList(),
    fetchRouteList(),
  ]);
  log(`  OTP routes           : ${otpRoutes.length}`);
  log(`  OTP stop names       : ${otpNames.named.length} named, ${otpNames.nulled} unnameable of ${otpNames.total}`);
  log(`  bus_station_list     : ${stations.length}`);
  log(`  categorized route list: ${routeList.length}`);

  const otpNameById = new Map(otpNames.named.map((s) => [bareId(s.gtfsId), s.name]));
  const stationById = new Map(stations.map((s) => [String(s.busStopId), s]));

  // The 660000xxx block is staging data — it carries the `test1..test5` stops
  // and duplicate route numbers for four real lines. Real feed ids never start 66.
  const isStaging = (id) => /:66/.test(id) || /^66/.test(bareId(id));
  const routes = otpRoutes.filter((r) => !isStaging(r.gtfsId));
  const staging = otpRoutes.length - routes.length;
  log(`  real routes          : ${routes.length} (${staging} staging filtered)`);

  // --- stop order assertion ------------------------------------------
  // The countdown rests entirely on this, so it is checked, not assumed.
  log("\nFetching rot_stop_by_route for all routes (independent served-set + order check)…");
  const rotByRoute = new Map();
  const rotFailures = [];
  let done = 0;

  await Promise.all(
    routeList.map(async (r) => {
      const id = String(r.routeId);
      try {
        rotByRoute.set(id, await fetchRotStops(id));
      } catch (e) {
        // A single bad route must never fail the build.
        if (e instanceof RateLimited) throw e;
        rotFailures.push({ routeId: id, busRouteNo: r.busRouteNo, error: String(e.message ?? e) });
      } finally {
        process.stdout.write(`\r  ${++done}/${routeList.length}`);
      }
    }),
  );
  process.stdout.write("\n");
  if (rotFailures.length) {
    warn(`${rotFailures.length} route fetches failed (continuing):`);
    for (const f of rotFailures.slice(0, 5)) warn(`   ${f.busRouteNo} ${f.routeId}: ${f.error}`);
  }

  const order = assertStopOrder(routes, rotByRoute);

  // --- served-set cross-check ----------------------------------------
  const otpServed = new Set();
  for (const r of routes) for (const p of r.patterns ?? []) for (const s of p.stops ?? []) {
    otpServed.add(bareId(s.gtfsId));
  }

  /**
   * The authority's own served set — but only from REAL routes.
   *
   * Without the route-level staging filter this set is contaminated: every one
   * of the stops it claimed that OTP omitted turned out to come from a
   * 660000xxx staging route, the same block that carries the `test1..test5`
   * stops. Keeping them on the "authority outranks routing engine" rule would
   * have shipped 53 test records as real bus stops.
   */
  const knownRouteIds = new Set(routes.map((r) => bareId(r.gtfsId)));
  const hamugaServed = new Set();
  const hamugaStopRows = new Map();
  const rotStagingRoutes = [];
  const rotUnknownRoutes = [];

  for (const [rid, rows] of rotByRoute) {
    if (/^66/.test(rid)) {
      rotStagingRoutes.push(rid);
      continue;
    }
    if (!knownRouteIds.has(rid)) {
      // A real Hamuga route OTP has never heard of would be a genuine feed gap.
      rotUnknownRoutes.push(rid);
      continue;
    }
    for (const row of rows) {
      if (!row?.busStopId) continue;
      const id = String(row.busStopId);
      if (/^66/.test(id)) continue;
      hamugaServed.add(id);
      if (!hamugaStopRows.has(id)) hamugaStopRows.set(id, row);
    }
  }
  if (rotUnknownRoutes.length) {
    warn(`${rotUnknownRoutes.length} non-staging Hamuga routes absent from OTP: ${rotUnknownRoutes.slice(0, 5).join(", ")}`);
  }

  const agreed = [...otpServed].filter((id) => hamugaServed.has(id));
  const hamugaOnly = [...hamugaServed].filter((id) => !otpServed.has(id));
  const hamugaOnlySet = new Set(hamugaOnly);
  const otpOnly = [...otpServed].filter((id) => !hamugaServed.has(id));

  log(`\nServed-set cross-check:`);
  log(`  OTP patterns say served      : ${otpServed.size}`);
  log(`  Hamuga rot_stop says served  : ${hamugaServed.size}`);
  log(`  both agree                   : ${agreed.length}`);
  log(`  OTP only  (kept)             : ${otpOnly.length}`);
  log(`  Hamuga only (kept — authority outranks routing engine): ${hamugaOnly.length}`);

  // --- stop table -----------------------------------------------------
  const stopById = new Map();
  const unnameable = [];

  /**
   * Names come from OTP first, then the transit authority's own two sources.
   * A stop with no name anywhere cannot be announced, so it is dropped and
   * reported rather than shipped as an id the countdown would read out.
   */
  const resolveName = (id) =>
    normalizeStopName(
      otpNameById.get(id) ??
        stationById.get(id)?.busStopName ??
        hamugaStopRows.get(id)?.busStopName ??
        "",
    );

  for (const r of routes) for (const p of r.patterns ?? []) for (const s of p.stops ?? []) {
    const id = bareId(s.gtfsId);
    if (stopById.has(id)) continue;
    const { lat, lon } = checkCoords(s.lat, s.lon, `OTP stop ${s.gtfsId}`);
    const name = resolveName(id);
    if (!name) {
      unnameable.push({ id, route: r.shortName, gtfsId: r.gtfsId, lat, lon });
      continue;
    }
    stopById.set(id, { id, name, lat, lon, source: "otp" });
  }

  if (unnameable.length) {
    warn(`${unnameable.length} stops on real routes have no name in any source — dropped:`);
    for (const u of unnameable.slice(0, 10)) warn(`   ${u.id} on ${u.route}`);
  }

  // Hamuga-only stops need coordinates from the rot row (gpxY/gpxX strings).
  const hamugaOnlyDetail = [];
  for (const id of hamugaOnly) {
    const row = hamugaStopRows.get(id);
    const station = stationById.get(id);
    let coords;
    try {
      coords = parseCoords(row?.gpxX ? row : station, `Hamuga-only stop ${id}`);
    } catch (e) {
      warn(`dropping Hamuga-only stop ${id}: ${e.message}`);
      continue;
    }
    const name = normalizeStopName(row?.busStopName ?? station?.busStopName ?? "");
    if (!name) {
      warn(`dropping Hamuga-only stop ${id}: empty name`);
      continue;
    }
    stopById.set(id, { id, name, lat: round(coords.lat), lon: round(coords.lon), source: "hamuga" });
    hamugaOnlyDetail.push({ id, name, ...coords });
  }

  const stops = [...stopById.values()]
    .map(({ id, name, lat, lon }) => ({ id, name, lat, lon }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const emptyNames = stops.filter((s) => !s.name);
  if (emptyNames.length) {
    throw new Error(`${emptyNames.length} kept stops have an empty name — they cannot be spoken`);
  }

  // --- routes ---------------------------------------------------------
  const spokenNames = loadSpokenNames();
  const routesOut = routes
    .map((r) => ({
      id: bareId(r.gtfsId),
      displayName: r.shortName,
      spokenName: spokenNames[r.shortName] || null,
      longName: r.longName ?? null,
      directions: (r.patterns ?? [])
        .map((p) => ({ id: p.directionId, headsign: normalizeStopName(p.headsign) }))
        .sort((a, b) => a.id - b.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // --- route-stops / stop-routes --------------------------------------
  const routeStops = {};
  const stopRoutes = {};
  for (const r of routes) {
    const rid = bareId(r.gtfsId);
    routeStops[rid] = {};
    for (const p of r.patterns ?? []) {
      const ids = (p.stops ?? []).map((s) => bareId(s.gtfsId));
      routeStops[rid][p.directionId] = ids;
      for (const sid of ids) (stopRoutes[sid] = stopRoutes[sid] ?? new Set()).add(rid);
    }
  }

  /**
   * The Hamuga-only stops would otherwise sit in stops.json with no routes at
   * all — findable by the nearest-stop search, then answering "nothing serves
   * this stop", which is the opposite of why we kept them. Their routes come
   * from the authority's own rot data.
   *
   * They are deliberately NOT inserted into route-stops.json: we know THAT a
   * route serves them, not WHERE in the ordered sequence they sit, and
   * inventing a position would corrupt the countdown Mode B depends on. So
   * Mode A can offer them and Mode B must refuse them — see `orderGap` below.
   */
  let hamugaOnlyLinked = 0;
  for (const [rid, rows] of rotByRoute) {
    if (!knownRouteIds.has(rid)) continue;
    for (const row of rows) {
      const sid = String(row?.busStopId ?? "");
      if (!stopById.has(sid) || !hamugaOnlySet.has(sid)) continue;
      (stopRoutes[sid] = stopRoutes[sid] ?? new Set()).add(rid);
      hamugaOnlyLinked++;
    }
  }
  const stopRoutesOut = Object.fromEntries(
    Object.entries(stopRoutes)
      .map(([k, v]) => [k, [...v].sort()])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );

  // Every id referenced by a route must exist in stops.json, or the countdown
  // reaches a stop it cannot name.
  const missing = [...new Set(Object.values(routeStops).flatMap((d) => Object.values(d).flat()))].filter(
    (id) => !stopById.has(id),
  );
  if (missing.length) {
    throw new Error(
      `${missing.length} route-stop ids are missing from stops.json (${missing.slice(0, 5).join(", ")}). ` +
        `A route that reaches a stop we cannot name would make the countdown announce nothing. ` +
        `${unnameable.length ? `${unnameable.length} were dropped for having no name in any source.` : ""}`,
    );
  }

  /**
   * Stops that stop-routes.json offers but route-stops.json cannot sequence.
   * Mode A may name them and list their routes; Mode B must refuse to start a
   * countdown from one, because we have no position for it in the order.
   */
  const orderGap = [];
  for (const [sid, rids] of Object.entries(stopRoutes)) {
    for (const rid of rids) {
      const dirs = routeStops[rid];
      if (!dirs) continue;
      if (!Object.values(dirs).some((seq) => seq.includes(sid))) orderGap.push({ stopId: sid, routeId: rid });
    }
  }

  // --- dropped stops --------------------------------------------------
  const kept = stopById;
  const dropped = [];
  for (const s of stations) {
    const id = String(s.busStopId);
    if (kept.has(id)) continue;
    let coords;
    try {
      coords = parseCoords(s, `dropped stop ${id}`);
    } catch {
      dropped.push({
        id,
        name: normalizeStopName(s.busStopName),
        lat: null,
        lon: null,
        nearestKeptId: null,
        nearestKeptName: null,
        distanceM: null,
        note: "unparseable coordinates",
      });
      continue;
    }
    let best = null;
    for (const k of kept.values()) {
      const d = haversine(coords, k);
      if (!best || d < best.d) best = { d, k };
    }
    dropped.push({
      id,
      name: normalizeStopName(s.busStopName),
      lat: round(coords.lat),
      lon: round(coords.lon),
      nearestKeptId: best?.k.id ?? null,
      nearestKeptName: best?.k.name ?? null,
      distanceM: best ? Math.round(best.d) : null,
    });
  }
  dropped.sort((a, b) => (b.distanceM ?? Infinity) - (a.distanceM ?? Infinity));
  const beyondAlarm = dropped.filter((d) => (d.distanceM ?? Infinity) > COVERAGE_ALARM_M);

  // --- emit -----------------------------------------------------------
  const meta = {
    generatedAt: new Date().toISOString(),
    stopCount: stops.length,
    routeCount: routesOut.length,
    droppedStopCount: dropped.length,
    sourceCommit: gitCommit(),
  };

  await mkdir(join(root, OUT_DIR), { recursive: true });
  const written = [];
  for (const [name, value] of [
    ["stops.json", stops],
    ["routes.json", routesOut],
    ["route-stops.json", routeStops],
    ["stop-routes.json", stopRoutesOut],
    ["meta.json", meta],
  ]) {
    const json = JSON.stringify(value);
    await writeFile(join(root, OUT_DIR, name), json, "utf8");
    written.push({ name, raw: Buffer.byteLength(json), gz: gzipSync(json).length });
  }

  await mkdir(join(root, dirname(DROPPED_FILE)), { recursive: true });
  await writeFile(
    join(root, DROPPED_FILE),
    JSON.stringify(
      {
        generatedAt: meta.generatedAt,
        alarmThresholdM: COVERAGE_ALARM_M,
        droppedCount: dropped.length,
        beyondThresholdCount: beyondAlarm.length,
        servedSetDiff: {
          otpServed: otpServed.size,
          hamugaServed: hamugaServed.size,
          agreed: agreed.length,
          otpOnlyKept: otpOnly.length,
          hamugaOnlyKept: hamugaOnly.length,
          // rot_stop_by_route returns direction 0 ONLY, so this source can never
          // report a stop served exclusively in direction 1. "Hamuga does not
          // list it" is therefore weak evidence of not-served; "OTP lists no
          // routes for it" is the strong one.
          hamugaCaveat: "rot_stop_by_route returns directionId 0 only — it structurally under-reports the served set",
          hamugaOnlyStops: hamugaOnlyDetail,
        },
        modeBOrderGap: orderGap,
        dropped,
      },
      null,
      2,
    ),
    "utf8",
  );

  // --- report ---------------------------------------------------------
  log("\nEmitted:");
  let totalGz = 0;
  for (const w of written) {
    totalGz += w.gz;
    log(`  ${w.name.padEnd(18)} ${(w.raw / 1024).toFixed(1).padStart(8)} KB raw  ${(w.gz / 1024).toFixed(1).padStart(7)} KB gz`);
  }
  log(`  ${"TOTAL".padEnd(18)} ${" ".repeat(8)}         ${(totalGz / 1024).toFixed(1).padStart(7)} KB gz`);

  const routeStopsGz = written.find((w) => w.name === "route-stops.json").gz;
  if (routeStopsGz > 500 * 1024) {
    await splitPerRoute(routeStops);
  } else {
    log(`\n  route-stops.json is ${(routeStopsGz / 1024).toFixed(1)} KB gz — far under the 500 KB split threshold, shipping whole`);
  }

  log(`\nStop order: ${order.summary}`);
  log(`\nMode A / Mode B asymmetry:`);
  log(`  Hamuga-only stops linked to a route in stop-routes.json: ${hamugaOnlyLinked}`);
  log(`  (stopId, routeId) pairs Mode A can offer but Mode B cannot sequence: ${orderGap.length}`);
  if (orderGap.length) {
    log(`  Mode B must refuse to start a countdown from these — there is no position for them`);
    log(`  in the ordered sequence, and inventing one would corrupt the count.`);
  }
  log(`\nCoverage:`);
  log(`  kept stops     : ${stops.length}`);
  log(`  dropped stops  : ${dropped.length}`);
  log(`  dropped > ${COVERAGE_ALARM_M}m from nearest kept: ${beyondAlarm.length}`);
  if (beyondAlarm.length) {
    log(`  worst offenders:`);
    for (const d of beyondAlarm.slice(0, 10)) {
      log(`    ${String(d.distanceM ?? "?").padStart(6)} m  ${d.id}  ${d.name || "(no name)"}`);
    }
  }
  log(`  full list → ${DROPPED_FILE}`);

  // --- spokenName gate -------------------------------------------------
  const missingSpoken = routesOut.filter((r) => !r.spokenName);
  if (missingSpoken.length) {
    await writeFile(
      join(root, TODO_FILE),
      JSON.stringify(
        Object.fromEntries(
          routesOut.map((r) => [r.displayName, { spokenName: r.spokenName ?? "", longName: r.longName }]),
        ),
        null,
        2,
      ),
      "utf8",
    );
    log(`\n${missingSpoken.length}/${routesOut.length} routes have no spokenName.`);
    log(`Wrote ${TODO_FILE} — fill every spokenName, then save it as ${NAMES_FILE}.`);
    log(`Display and speech are separate fields: "${routesOut[0].displayName}" is what goes on screen,`);
    log(`spokenName is the Mongolian phrase a person actually says. Chimege must never see the label.`);
    if (!ALLOW_MISSING_SPOKEN) {
      console.error(`\nBuild failed: ${missingSpoken.length} routes cannot be spoken.`);
      console.error(`Re-run with --allow-missing-spoken to inspect the emitted JSON anyway.`);
      process.exit(1);
    }
    warn("--allow-missing-spoken: continuing with null spokenName. NOT shippable.");
  }

  log("\nDone.");
}

/**
 * Is the stop order explicit, or are we trusting incidental array order?
 *
 * OTP's `pattern.stops` is an ordered list with no sequence field on it — the
 * order is positional. Hamuga's rot rows DO carry an explicit `busStopSeq`.
 * Where both describe the same direction, agreement between OTP's array order
 * and Hamuga's explicit sequence is what turns "the array looked right" into
 * evidence. Disagreement is reported loudly rather than absorbed.
 */
function assertStopOrder(routes, rotByRoute) {
  let compared = 0;
  let identical = 0;
  let nonContiguous = 0;
  const mismatches = [];

  for (const r of routes) {
    const rows = rotByRoute.get(bareId(r.gtfsId));
    if (!rows?.length) continue;

    const seqs = rows.map((x) => Number(x.busStopSeq));
    if (seqs.some((n) => !Number.isFinite(n))) {
      warn(`route ${r.shortName}: non-numeric busStopSeq — skipping order check`);
      continue;
    }
    const sorted = [...rows].sort((a, b) => Number(a.busStopSeq) - Number(b.busStopSeq));
    const ordered = sorted.map((x) => Number(x.busStopSeq));
    const contiguous = ordered.every((n, i) => n === i);
    if (!contiguous) {
      nonContiguous++;
      warn(`route ${r.shortName}: busStopSeq not contiguous 0..n-1 → ${ordered.slice(0, 8).join(",")}…`);
    }

    // rot_stop_by_route is directionId 0.
    const dir0 = (r.patterns ?? []).find((p) => p.directionId === 0);
    if (!dir0) continue;
    compared++;
    const otpIds = dir0.stops.map((s) => bareId(s.gtfsId));
    const hamugaIds = sorted.map((x) => String(x.busStopId));
    if (JSON.stringify(otpIds) === JSON.stringify(hamugaIds)) identical++;
    else mismatches.push({ route: r.shortName, otp: otpIds.length, hamuga: hamugaIds.length });
  }

  const summary =
    `OTP array order matched Hamuga's explicit busStopSeq on ${identical}/${compared} routes` +
    (nonContiguous ? `; ${nonContiguous} routes had non-contiguous busStopSeq` : "; all busStopSeq contiguous") +
    (mismatches.length ? `; ${mismatches.length} MISMATCHED` : "");

  if (mismatches.length) {
    warn("ORDER MISMATCH — OTP positional order disagrees with Hamuga's explicit sequence:");
    for (const m of mismatches.slice(0, 10)) warn(`   ${m.route}: otp=${m.otp} stops, hamuga=${m.hamuga} stops`);
  }
  return { summary, compared, identical, mismatches, nonContiguous };
}

function loadSpokenNames() {
  const path = join(root, NAMES_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? v.trim() : String(v?.spokenName ?? "").trim()]),
    );
  } catch (e) {
    warn(`${NAMES_FILE} unreadable (${e.message}) — treating all spokenNames as missing`);
    return {};
  }
}

async function splitPerRoute(routeStops) {
  const dir = join(root, OUT_DIR, "routes");
  await mkdir(dir, { recursive: true });
  for (const [rid, dirs] of Object.entries(routeStops)) {
    await writeFile(join(dir, `${rid}.json`), JSON.stringify(dirs), "utf8");
  }
  const files = await readdir(dir);
  log(`\n  route-stops.json exceeded 500 KB gz — split into ${files.length} files under ${OUT_DIR}/routes/`);
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

main().catch((e) => {
  if (e instanceof RateLimited) {
    console.error(`\n${e.message}`);
    console.error("The gateway locks the key out of every endpoint for ~14 minutes. Wait, then re-run —");
    console.error("cached responses in .cache/ mean the run resumes rather than starting over.");
    process.exit(2);
  }
  console.error(`\nBuild failed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
