/**
 * Task 0 — Hamuga API discovery. Writes real samples to probe-output/ so the
 * TypeScript types can be derived from what the API actually returns rather
 * than from what a transit API usually looks like.
 *
 *   node --env-file=.env.local scripts/probe-hamuga.mjs
 *
 * Build-time only. The key is read from process.env and is REDACTED from every
 * file this writes — probe-output/ is safe to read but is gitignored anyway.
 *
 * Phases:
 *   1. auth      — which header/query param carries the key
 *   2. static    — the six documented /transport endpoints
 *   3. params    — real parameter names for the two parameterised endpoints
 *   4. otp       — /route plan, both date formats, realTime flag on transit legs
 *   5. realtime  — hunt for undocumented vehicle_positions / trip_updates
 *   6. report    — counts and byte sizes
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TRANSPORT = "https://gateway.hamuga.mn/transport";
const ROUTE = "https://gateway.hamuga.mn/route";
const OUT = "probe-output";
const TIMEOUT_MS = 20000;

/**
 * The gateway rate-limits, and it does so by locking the key out of EVERY
 * endpoint with a bare `{"message":"Unauthorized"}` — not with a 429, and not
 * scoped to the endpoint that tripped it. An unthrottled sweep of ~50 requests
 * locked the key out for several minutes during the first run. Every request
 * this script makes goes through `req`, which paces them.
 */
const THROTTLE_MS = 1200;
let lastRequestAt = 0;

/** True once a 401 arrives on a request that previously authorized fine. */
let rateLimited = false;

const KEY = process.env.HAMUGA_KEY ?? process.env.HAMUGA_API_KEY;
if (!KEY) {
  console.error("HAMUGA_KEY is not set.");
  console.error("Run: node --env-file=.env.local scripts/probe-hamuga.mjs");
  process.exit(1);
}

/** Never let the key reach a file or the console. */
const redact = (s) => String(s).split(KEY).join("<REDACTED_KEY>");

const findings = {};
const sizes = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, { headers = {}, method = "GET", body } = {}) {
  const wait = lastRequestAt + THROTTLE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON — keep the text for the report */
    }
    // A bare {"message":"Unauthorized"} after auth already succeeded is the
    // rate limiter, not a bad key. Distinguishing the two matters: one means
    // wait, the other means the scheme is wrong.
    if (res.status === 401 && AUTH && /Unauthorized/.test(text)) rateLimited = true;
    return { ok: res.ok, status: res.status, text, json, bytes: Buffer.byteLength(text) };
  } catch (e) {
    return { ok: false, status: 0, text: String(e?.message ?? e), json: null, bytes: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function save(name, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  await writeFile(join(OUT, name), redact(text), "utf8");
  sizes[name] = Buffer.byteLength(text);
}

/**
 * The envelope this gateway uses: HTTP 200 with `{ code, msg, data }`, where a
 * non-"0000" code is still a 200. Auth detection has to look past the status
 * line or every variant "succeeds".
 */
function envelopeOk(r) {
  if (!r.ok) return false;
  if (r.json && typeof r.json === "object" && !Array.isArray(r.json)) {
    if (typeof r.json.code === "string" && r.json.code !== "0000") return false;
  }
  return r.json !== null;
}

function payload(r) {
  const j = r.json;
  if (j && typeof j === "object" && !Array.isArray(j) && "data" in j) return j.data;
  return j;
}

/**
 * The array inside a response, wherever it sits.
 *
 * `rotStopList` and `routeList` are real wrapper keys this gateway uses — the
 * first run missed `rot_stop_by_route` entirely because they were absent here,
 * and reported "no parameter works" for an endpoint that was answering fine.
 */
const WRAPPER_KEYS = [
  "rotStopList", "routeList", "busRouteList", "stopList", "busStopList",
  "list", "items", "rows", "records", "content", "data", "result",
];

function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const k of WRAPPER_KEYS) if (Array.isArray(data[k])) return data[k];
  }
  return null;
}

/** Which wrapper key held the array — recorded so the types can name it. */
function wrapperOf(data) {
  if (Array.isArray(data)) return "(top-level array)";
  if (data && typeof data === "object") {
    for (const k of WRAPPER_KEYS) if (Array.isArray(data[k])) return k;
  }
  return null;
}

/** Stops carry coordinates as STRINGS in gpxY (lat) / gpxX (lon). */
function coordsOf(row) {
  const lat = Number(row?.gpxY ?? row?.lat ?? row?.latitude);
  const lon = Number(row?.gpxX ?? row?.lon ?? row?.lng ?? row?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

// ---------------------------------------------------------------- 1. auth

const AUTH_VARIANTS = [
  { label: "header x-api-key", headers: { "x-api-key": KEY } },
  { label: "header X-API-KEY", headers: { "X-API-KEY": KEY } },
  { label: "header api-key", headers: { "api-key": KEY } },
  { label: "header apikey", headers: { apikey: KEY } },
  { label: "header Authorization: Bearer", headers: { Authorization: `Bearer ${KEY}` } },
  { label: "header Authorization: raw", headers: { Authorization: KEY } },
  { label: "header Authorization: Api-Key", headers: { Authorization: `Api-Key ${KEY}` } },
  { label: "header x-hamuga-key", headers: { "x-hamuga-key": KEY } },
  { label: "header token", headers: { token: KEY } },
  { label: "query api_key", query: { api_key: KEY } },
  { label: "query apikey", query: { apikey: KEY } },
  { label: "query key", query: { key: KEY } },
  { label: "query token", query: { token: KEY } },
  { label: "query access_token", query: { access_token: KEY } },
];

let AUTH = null;

async function probeAuth() {
  console.log("=== 1. AUTH ===");
  const target = `${TRANSPORT}/api/bus/v1/bus_station_list`;
  const results = [];

  // Stop at the first variant that works. Sweeping all fourteen costs requests
  // against a rate limit that locks the key out of the whole gateway, and the
  // remaining variants change nothing once one is known good.
  for (const v of AUTH_VARIANTS) {
    const url = new URL(target);
    for (const [k, val] of Object.entries(v.query ?? {})) url.searchParams.set(k, val);
    const r = await req(url, { headers: v.headers ?? {} });
    const good = envelopeOk(r);
    results.push({
      variant: v.label,
      httpStatus: r.status,
      envelopeCode: r.json?.code ?? null,
      envelopeMsg: r.json?.msg ?? null,
      accepted: good,
      bytes: r.bytes,
      bodyHead: redact(r.text.slice(0, 200)),
    });
    console.log(`  ${good ? "OK  " : "FAIL"}  ${v.label.padEnd(30)} http=${r.status} bytes=${r.bytes}`);
    if (good) {
      AUTH = v;
      break;
    }
  }

  await save("01-auth-variants.json", results);

  if (!AUTH) {
    console.error("\nAUTH FAILED ON EVERY VARIANT — stopping.");
    console.error("Pull the exact scheme from the Hamuga console's 'Турших' tab.");
    await save("00-SUMMARY.json", { authScheme: null, stopped: "auth failed on every variant", results });
    process.exit(2);
  }

  findings.authScheme = AUTH.label;
  console.log(`\n  AUTH SCHEME: ${AUTH.label}\n`);
}

/** Every request after phase 1 goes through the winning variant. */
function authed(base, params = {}) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (const [k, v] of Object.entries(AUTH.query ?? {})) url.searchParams.set(k, v);
  return { url, headers: AUTH.headers ?? {} };
}

const get = (base, params) => {
  const { url, headers } = authed(base, params);
  return req(url, { headers });
};

// -------------------------------------------------------------- 2. static

const STATIC = [
  ["bus_station_list", "/api/bus/v1/bus_station_list"],
  ["bus_route_categorized_list", "/api/bus/v1/bus_route_categorized_list"],
  ["group_info", "/api/bus/v1/group/info"],
  ["gtfs_shapes", "/api/gtfs/v1/shapes"],
];

const statics = {};

async function probeStatic() {
  console.log("=== 2. STATIC ENDPOINTS ===");
  for (const [name, path] of STATIC) {
    const r = await get(TRANSPORT + path);
    const data = payload(r);
    const rows = rowsOf(data);
    statics[name] = { rows, data, bytes: r.bytes };

    console.log(
      `  ${name.padEnd(30)} http=${r.status} code=${r.json?.code ?? "-"} ` +
        `bytes=${r.bytes} rows=${rows ? rows.length : "n/a"}`,
    );

    await save(`02-${name}.sample.json`, {
      endpoint: path,
      httpStatus: r.status,
      envelopeKeys: r.json && typeof r.json === "object" ? Object.keys(r.json) : null,
      totalBytes: r.bytes,
      rowCount: rows ? rows.length : null,
      topLevelShape: rows ? "array" : typeof data,
      wrapperKey: wrapperOf(data),
      firstRowKeys: rows?.[0] ? Object.keys(rows[0]) : null,
      firstRows: rows ? rows.slice(0, 3) : data,
    });
    // Full body too — types get derived from these.
    await save(`02-${name}.full.json`, r.json ?? r.text);
  }
  console.log();
}

// -------------------------------------------------------------- 3. params

/** Pull a plausible id out of a sample row, trying the usual spellings. */
function pickId(row, ...names) {
  for (const n of names) if (row?.[n] !== undefined && row[n] !== null) return row[n];
  return undefined;
}

async function probeParams() {
  console.log("=== 3. PARAMETER NAMES ===");

  const stationRows = statics.bus_station_list?.rows ?? [];
  const routeRows = statics.bus_route_categorized_list?.rows ?? [];

  // Categorized list may nest routes under categories.
  const flatRoutes = [];
  for (const r of routeRows) {
    if (Array.isArray(r?.routes)) flatRoutes.push(...r.routes);
    else if (Array.isArray(r?.list)) flatRoutes.push(...r.list);
    else flatRoutes.push(r);
  }

  const sampleRoute = flatRoutes[0] ?? {};
  const sampleStation = stationRows[0] ?? {};

  const routeId = pickId(sampleRoute, "routeId", "route_id", "id", "busRouteId", "bus_route_id");
  const stopId = pickId(sampleStation, "busStopId", "bus_stop_id", "stationId", "station_id", "id");

  console.log(`  sample routeId=${JSON.stringify(routeId)} stopId=${JSON.stringify(stopId)}`);

  const ROUTE_PARAMS = [
    "route_id", "routeId", "id", "bus_route_id", "busRouteId",
    "rot_id", "rotId", "route", "routeNumber", "route_number",
  ];
  const STOP_PARAMS = [
    "stop_id", "stopId", "id", "bus_stop_id", "busStopId",
    "station_id", "stationId", "stop",
  ];

  async function findParam(path, candidates, value) {
    const tried = [];
    let winner = null;
    for (const p of candidates) {
      const r = await get(TRANSPORT + path, { [p]: value });
      const data = payload(r);
      const rows = rowsOf(data);
      const good = envelopeOk(r) && rows !== null && rows.length > 0;
      tried.push({
        param: p,
        httpStatus: r.status,
        envelopeCode: r.json?.code ?? null,
        envelopeMsg: r.json?.msg ?? null,
        rowCount: rows ? rows.length : null,
        wrapperKey: wrapperOf(data),
        accepted: good,
        bodyHead: redact(r.text.slice(0, 160)),
      });
      console.log(
        `    ${good ? "OK  " : "fail"}  ${path} ?${p}=  rows=${rows ? rows.length : "-"}` +
          `${good ? ` wrapper=${wrapperOf(data)}` : ""}`,
      );
      if (good) {
        winner = { param: p, rows, bytes: r.bytes, body: r.json, wrapper: wrapperOf(data) };
        break; // first hit wins; the rest are wasted requests against the limiter
      }
    }
    return { winner, tried };
  }

  console.log("  rot_stop_by_route:");
  const rot = await findParam("/api/bus/v1/rot_stop_by_route", ROUTE_PARAMS, routeId);
  console.log("  bus_route_by_stop_id:");
  const bys = await findParam("/api/bus/v1/bus_route_by_stop_id", STOP_PARAMS, stopId);

  findings.rotStopByRouteParam = rot.winner?.param ?? null;
  findings.busRouteByStopIdParam = bys.winner?.param ?? null;

  await save("03-param-discovery.json", {
    sampleRouteRowKeys: Object.keys(sampleRoute),
    sampleStationRowKeys: Object.keys(sampleStation),
    usedRouteId: routeId,
    usedStopId: stopId,
    rot_stop_by_route: { accepted: findings.rotStopByRouteParam, tried: rot.tried },
    bus_route_by_stop_id: { accepted: findings.busRouteByStopIdParam, tried: bys.tried },
  });

  if (rot.winner) {
    await save("03-rot_stop_by_route.full.json", rot.winner.body);
    await save("03-rot_stop_by_route.sample.json", {
      param: rot.winner.param,
      rowCount: rot.winner.rows.length,
      firstRowKeys: Object.keys(rot.winner.rows[0] ?? {}),
      firstRows: rot.winner.rows.slice(0, 5),
    });
  }
  if (bys.winner) {
    await save("03-bus_route_by_stop_id.full.json", bys.winner.body);
    await save("03-bus_route_by_stop_id.sample.json", {
      param: bys.winner.param,
      wrapperKey: bys.winner.wrapper,
      rowCount: bys.winner.rows.length,
      firstRowKeys: Object.keys(bys.winner.rows[0] ?? {}),
      firstRows: bys.winner.rows.slice(0, 5),
    });
  }

  // --- direction ------------------------------------------------------
  // routeType is "Outbound and Inbound", so one route id covers both
  // directions. Whether the ordered sequence is split by a parameter or
  // returned interleaved with a field decides the whole route-stops shape.
  if (rot.winner) {
    const rows = rot.winner.rows;
    const rowKeys = Object.keys(rows[0] ?? {});
    const dirFields = rowKeys.filter((k) => /up.?down|direction|dir$|isUp|way/i.test(k));
    const dirValues = {};
    for (const f of dirFields) dirValues[f] = [...new Set(rows.map((r) => r[f]))].slice(0, 6);

    console.log(`  direction fields on rotStop rows: ${dirFields.join(", ") || "(none)"}`);
    for (const [f, v] of Object.entries(dirValues)) console.log(`    ${f}: ${JSON.stringify(v)}`);

    const dirTried = [];
    for (const p of ["up_down", "upDown", "direction", "dir", "is_up"]) {
      for (const v of [0, 1]) {
        const r = await get(TRANSPORT + "/api/bus/v1/rot_stop_by_route", {
          [findings.rotStopByRouteParam]: routeId,
          [p]: v,
        });
        const rr = rowsOf(payload(r));
        dirTried.push({ param: p, value: v, rowCount: rr ? rr.length : null, envelopeCode: r.json?.code ?? null });
        console.log(`    ?${p}=${v} rows=${rr ? rr.length : "-"} (unfiltered=${rows.length})`);
      }
    }

    findings.rotStopDirectionFields = dirFields;
    await save("03-rot-direction.json", { rowKeys, dirFields, dirValues, dirTried, unfilteredRowCount: rows.length });
  }

  // --- shapes ---------------------------------------------------------
  // The bare call returned two rows with empty route_id and null shapes, which
  // is the endpoint asking for a route.
  const shp = await get(TRANSPORT + "/api/gtfs/v1/shapes", { route_id: routeId });
  const shpRows = rowsOf(payload(shp));
  console.log(`  gtfs shapes ?route_id= : http=${shp.status} rows=${shpRows?.length ?? "-"} bytes=${shp.bytes}`);
  await save("03-gtfs_shapes-by-route.json", {
    usedRouteId: routeId,
    httpStatus: shp.status,
    bytes: shp.bytes,
    rowCount: shpRows?.length ?? null,
    firstRowKeys: shpRows?.[0] ? Object.keys(shpRows[0]) : null,
    body: shp.json,
  });

  console.log();
  return { stationRows, flatRoutes, routeId, stopId };
}

// ------------------------------------------------------------------ 4. otp

async function probeOtp(stationRows) {
  console.log("=== 4. OTP /route plan ===");

  // Two real stops far enough apart to force a transit leg. Coordinates live in
  // gpxY/gpxX as strings; reading lat/lon here silently yielded NaN on the first
  // run and the probe fell back to hardcoded points without saying so.
  const withCoords = stationRows
    .map(coordsOf)
    .filter((p) => p && p.lat > 47.8 && p.lat < 48.05 && p.lon > 106.6 && p.lon < 107.2);

  if (withCoords.length < 10) {
    console.log(`  WARNING: only ${withCoords.length} usable stop coordinates — check gpxY/gpxX parsing`);
  }

  const sorted = [...withCoords].sort((a, b) => a.lon - b.lon);
  const from = sorted[Math.floor(sorted.length * 0.2)];
  const to = sorted[Math.floor(sorted.length * 0.8)];
  console.log(`  from=${from.lat},${from.lon}  to=${to.lat},${to.lon}`);

  /**
   * Disambiguating the date format needs a date whose two readings DIFFER.
   * Probing with today's date proves nothing: if OTP cannot parse MM-DD-YYYY
   * and silently falls back to today, the two responses are byte-identical —
   * which is exactly what the first run saw. A day-of-month above 12 makes the
   * transposed reading impossible, and the `serviceDate` on the returned leg
   * says which date OTP actually planned for.
   */
  const target = new Date(Date.now() + 8 * 86400000);
  const yyyy = target.getFullYear();
  const mm = String(target.getMonth() + 1).padStart(2, "0");
  const dd = String(target.getDate()).padStart(2, "0");
  const expectISO = `${yyyy}-${mm}-${dd}`;

  const DATE_FORMATS = [
    { label: "YYYY-MM-DD", value: expectISO },
    { label: "MM-DD-YYYY", value: `${mm}-${dd}-${yyyy}` },
  ];
  console.log(`  probing with ${expectISO} (day ${dd}) — expect serviceDate=${expectISO} from the format OTP parses`);

  const attempts = [];
  let best = null;

  for (const fmt of DATE_FORMATS) {
    const r = await get(`${ROUTE}/routers/default/plan`, {
      fromPlace: `${from.lat},${from.lon}`,
      toPlace: `${to.lat},${to.lon}`,
      date: fmt.value,
      time: "09:00",
      mode: "TRANSIT,WALK",
      numItineraries: 3,
      // Not on by default — the brief assumed intermediateStops was always
      // present, and on the first run every leg came back without it.
      showIntermediateStops: true,
    });

    const plan = r.json?.plan ?? payload(r)?.plan ?? null;
    const itineraries = plan?.itineraries ?? [];
    const legs = itineraries.flatMap((i) => i.legs ?? []);
    const transitLegs = legs.filter((l) => l.transitLeg === true || l.mode === "BUS" || l.routeShortName);

    // The real test: did OTP plan for the date we asked for?
    const serviceDates = [...new Set(transitLegs.map((l) => l.serviceDate).filter(Boolean))];
    const parsedOurDate = serviceDates.includes(expectISO);
    const accepted = itineraries.length > 0 && parsedOurDate;

    attempts.push({
      dateFormat: fmt.label,
      sent: fmt.value,
      expectedServiceDate: expectISO,
      serviceDatesReturned: serviceDates,
      parsedOurDate,
      httpStatus: r.status,
      error: r.json?.error ?? null,
      itineraryCount: itineraries.length,
      transitLegCount: transitLegs.length,
      accepted,
      bytes: r.bytes,
      bodyHead: redact(r.text.slice(0, 200)),
    });
    console.log(
      `  ${accepted ? "OK  " : "fail"}  date=${fmt.label.padEnd(10)} sent=${fmt.value.padEnd(10)} ` +
        `itineraries=${itineraries.length} serviceDate=${serviceDates.join(",") || "-"} ` +
        `${parsedOurDate ? "MATCHES" : "does NOT match request"}`,
    );

    if (accepted && !best) best = { fmt, body: r.json, transitLegs };
  }

  findings.otpDateFormat = best?.fmt.label ?? null;

  // realTime flag — this is the branch that decides live vs estimated.
  let realTimeFlags = [];
  if (best) {
    realTimeFlags = best.transitLegs.map((l) => ({
      routeShortName: l.routeShortName ?? null,
      realTime: l.realTime ?? null,
      departureDelay: l.departureDelay ?? null,
      arrivalDelay: l.arrivalDelay ?? null,
      headway: l.headway ?? null,
      isNonExactFrequency: l.isNonExactFrequency ?? null,
      headsign: l.headsign ?? null,
      routeId: l.routeId ?? null,
      tripId: l.tripId ?? null,
      serviceDate: l.serviceDate ?? null,
      fromStopId: l.from?.stopId ?? null,
      toStopId: l.to?.stopId ?? null,
      from: l.from?.name ?? null,
      to: l.to?.name ?? null,
      startTime: l.startTime ?? null,
      intermediateStopCount: Array.isArray(l.intermediateStops) ? l.intermediateStops.length : null,
    }));
    await save("04-otp-plan.full.json", best.body);
    await save("04-otp-transit-legs.json", {
      dateFormat: best.fmt.label,
      legKeys: best.transitLegs[0] ? Object.keys(best.transitLegs[0]) : null,
      intermediateStopKeys: best.transitLegs[0]?.intermediateStops?.[0]
        ? Object.keys(best.transitLegs[0].intermediateStops[0])
        : null,
      legs: realTimeFlags,
    });
  }

  const anyRealTime = realTimeFlags.some((l) => l.realTime === true);
  findings.realtimeFromOtp = anyRealTime;
  console.log(
    `\n  REALTIME AVAILABLE (OTP realTime flag): ${anyRealTime ? "YES" : "NO"} ` +
      `(${realTimeFlags.filter((l) => l.realTime === true).length}/${realTimeFlags.length} transit legs)`,
  );

  await save("04-otp-date-formats.json", { attempts, realTimeFlags });
  console.log();
  return best;
}

// ------------------------------------------------------------- 5. realtime

const REALTIME_CANDIDATES = [
  `${TRANSPORT}/api/bus/v1/vehicle_positions`,
  `${TRANSPORT}/api/bus/v1/trip_updates`,
  `${TRANSPORT}/api/bus/v1/bus_location`,
  `${TRANSPORT}/api/bus/v1/bus_location_list`,
  `${TRANSPORT}/api/bus/v1/realtime`,
  `${TRANSPORT}/api/bus/v1/live`,
  `${TRANSPORT}/api/bus/v1/bus_position`,
  `${TRANSPORT}/api/gtfs/v1/vehicle_positions`,
  `${TRANSPORT}/api/gtfs/v1/trip_updates`,
  `${TRANSPORT}/api/gtfs/v1/alerts`,
  `${TRANSPORT}/api/gtfs/v1/realtime`,
  `${TRANSPORT}/api/gtfs-rt/v1/vehicle_positions`,
  `${ROUTE}/routers/default/index/graphql`,
  `${ROUTE}/otp/routers/default/vehiclePositions`,
];

/**
 * `/api/bus/v1/realtime` answered `{"code":"4001","msg":["bbox параметр хоосон
 * байна"]}` to a bare GET — it exists, it authorizes, and it wants a bounding
 * box. Whether it returns live vehicles decides the entire arrival-prediction
 * branch, so it gets its own probe with both axis orders.
 */
const UB_BBOX = [
  { label: "lon,lat,lon,lat", value: "106.6,47.8,107.2,48.05" },
  { label: "lat,lon,lat,lon", value: "47.8,106.6,48.05,107.2" },
];

async function probeRealtimeBbox() {
  console.log("=== 5a. /api/bus/v1/realtime (bbox) ===");
  const out = [];
  for (const b of UB_BBOX) {
    const r = await get(`${TRANSPORT}/api/bus/v1/realtime`, { bbox: b.value });
    const data = payload(r);
    const rows = rowsOf(data);
    const usable = envelopeOk(r) && rows !== null;
    out.push({
      bboxOrder: b.label,
      sent: b.value,
      httpStatus: r.status,
      envelopeCode: r.json?.code ?? null,
      envelopeMsg: r.json?.msg ?? null,
      rowCount: rows?.length ?? null,
      wrapperKey: wrapperOf(data),
      firstRowKeys: rows?.[0] ? Object.keys(rows[0]) : null,
      usable,
      bytes: r.bytes,
      body: r.json,
    });
    console.log(
      `  ${usable ? "USABLE" : "fail  "} bbox(${b.label}) http=${r.status} ` +
        `code=${r.json?.code ?? "-"} rows=${rows?.length ?? "-"} bytes=${r.bytes}`,
    );
    if (rows?.[0]) console.log(`    row keys: ${Object.keys(rows[0]).join(", ")}`);
  }
  const live = out.find((o) => o.usable && o.rowCount > 0);
  findings.realtimeBbox = live
    ? { param: "bbox", axisOrder: live.bboxOrder, vehicleCount: live.rowCount, fields: live.firstRowKeys }
    : null;
  await save("05-realtime-bbox.json", out);
  console.log();
}

async function probeRealtime() {
  console.log("=== 5b. UNDOCUMENTED REALTIME HUNT ===");
  const results = [];
  for (const url of REALTIME_CANDIDATES) {
    const { url: u, headers } = authed(url);
    const r = await req(u, { headers });
    const exists = r.status !== 404 && r.status !== 0;
    const usable = envelopeOk(r);
    results.push({
      url: url.replace(TRANSPORT, "{transport}").replace(ROUTE, "{route}"),
      httpStatus: r.status,
      exists,
      usable,
      bytes: r.bytes,
      bodyHead: redact(r.text.slice(0, 160)),
    });
    console.log(`  http=${String(r.status).padEnd(4)} ${usable ? "USABLE" : exists ? "exists" : "-     "}  ${url.replace(TRANSPORT, "").replace(ROUTE, "")}`);
  }
  findings.undocumentedRealtime = results.filter((r) => r.usable).map((r) => r.url);
  await save("05-realtime-hunt.json", results);
  console.log();
}

// ------------------------------------------------------- 6. OTP index/graphql

/**
 * The find that reshapes Task 1.
 *
 * `rot_stop_by_route` returns exactly ONE direction — it is byte-identical to
 * OTP pattern directionId 0 — and the gateway exposes no parameter for the
 * other. OTP's index GraphQL returns both patterns per route, each with an
 * ordered stop list, a directionId and a real headsign, for every route in one
 * POST. That is the authoritative source for route-stops.json, and it removes
 * the 104-request loop that tripped the rate limiter in the first place.
 */
const GRAPHQL = `${ROUTE}/routers/default/index/graphql`;

const ALL_ROUTES_QUERY = `{
  routes {
    gtfsId shortName longName mode
    patterns { code directionId headsign
      stops { gtfsId name lat lon } }
  }
}`;

async function probeGraphql() {
  console.log("=== 6. OTP INDEX / GRAPHQL ===");

  const idx = await req(new URL(`${ROUTE}/routers/default/index/routes`), { headers: AUTH.headers ?? {} });
  console.log(`  index/routes: http=${idx.status} bytes=${idx.bytes} routes=${Array.isArray(idx.json) ? idx.json.length : "-"}`);
  await save("06-otp-index-routes.json", idx.json ?? idx.text);

  const r = await req(new URL(GRAPHQL), {
    method: "POST",
    headers: { ...(AUTH.headers ?? {}), "Content-Type": "application/json" },
    body: JSON.stringify({ query: ALL_ROUTES_QUERY }),
  });

  if (r.status !== 200 || !r.json?.data?.routes) {
    console.log(`  graphql: http=${r.status} — NOT usable`);
    console.log(`    ${redact(r.text.slice(0, 300))}`);
    findings.otpGraphql = null;
    return;
  }

  const all = r.json.data.routes;
  // The 660000xxx block is staging data: it carries the `test1..test5` stops
  // and duplicate route numbers. Real feed ids never start 66.
  const real = all.filter((x) => !x.gtfsId.includes(":66"));
  const patterns = real.flatMap((x) => x.patterns ?? []);
  const stops = new Map();
  for (const x of real) for (const p of x.patterns ?? []) for (const s of p.stops ?? []) {
    stops.set(s.gtfsId.split(":")[1], s);
  }

  const counts = patterns.map((p) => p.stops?.length ?? 0).sort((a, b) => a - b);
  findings.otpGraphql = {
    endpoint: "/routers/default/index/graphql (POST)",
    bytes: r.bytes,
    routesTotal: all.length,
    routesReal: real.length,
    routesStaging: all.length - real.length,
    patterns: patterns.length,
    patternsPerRoute: [...new Set(real.map((x) => x.patterns?.length ?? 0))],
    directionIds: [...new Set(patterns.map((p) => p.directionId))],
    emptyPatterns: patterns.filter((p) => !p.stops?.length).length,
    missingHeadsigns: patterns.filter((p) => !p.headsign).length,
    stopsPerPattern: { min: counts[0], median: counts[counts.length >> 1], max: counts[counts.length - 1] },
    servedStops: stops.size,
  };

  console.log(`  graphql: http=${r.status} bytes=${r.bytes}`);
  console.log(`    routes=${all.length} (real ${real.length}, staging ${all.length - real.length})`);
  console.log(`    patterns=${patterns.length}, directionIds=${JSON.stringify(findings.otpGraphql.directionIds)}`);
  console.log(`    empty patterns=${findings.otpGraphql.emptyPatterns}, missing headsigns=${findings.otpGraphql.missingHeadsigns}`);
  console.log(`    stops/pattern min=${counts[0]} median=${counts[counts.length >> 1]} max=${counts[counts.length - 1]}`);
  console.log(`    served stops=${stops.size}`);

  await save("06-otp-all-routes.json", r.json);
  console.log();
}

// --------------------------------------------------------------- 7. report

async function report(ctx) {
  console.log("=== 6. SUMMARY ===");

  const stopCount = ctx.stationRows.length;
  const routeCount = ctx.flatRoutes.length;
  const largest = Object.entries(sizes)
    .filter(([n]) => n.includes(".full."))
    .sort((a, b) => b[1] - a[1])[0];

  findings.stopCount = stopCount;
  findings.routeCount = routeCount;
  findings.largestResponse = largest ? { file: largest[0], bytes: largest[1] } : null;
  findings.realtimeAvailable =
    Boolean(findings.realtimeFromOtp) ||
    Boolean(findings.realtimeBbox) ||
    findings.undocumentedRealtime.length > 0;

  console.log(`  auth scheme            : ${findings.authScheme}`);
  console.log(`  rot_stop_by_route param: ${findings.rotStopByRouteParam}`);
  console.log(`  bus_route_by_stop_id   : ${findings.busRouteByStopIdParam}`);
  console.log(`  OTP date format        : ${findings.otpDateFormat}`);
  console.log(`  REALTIME AVAILABLE     : ${findings.realtimeAvailable ? "YES" : "NO"}`);
  console.log(`    via OTP realTime flag: ${findings.realtimeFromOtp ? "yes" : "no"}`);
  console.log(`    via /realtime bbox   : ${findings.realtimeBbox ? JSON.stringify(findings.realtimeBbox) : "no"}`);
  if (rateLimited) console.log(`  NOTE: hit the gateway rate limiter during this run — some results may be incomplete`);
  console.log(`  stops                  : ${stopCount}`);
  console.log(`  routes                 : ${routeCount}`);
  if (largest) console.log(`  largest response       : ${largest[0]} — ${(largest[1] / 1024).toFixed(1)} KB`);

  await save("00-SUMMARY.json", { generatedAt: new Date().toISOString(), findings, fileSizes: sizes });
  console.log(`\n  wrote ${Object.keys(sizes).length} files to ${OUT}/`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await probeAuth();
  await probeStatic();
  const ctx = await probeParams();
  await probeOtp(ctx.stationRows);
  await probeRealtimeBbox();
  await probeRealtime();
  await probeGraphql();
  await report(ctx);
}

main().catch(async (e) => {
  console.error(`\nprobe failed: ${redact(e?.stack ?? e)}`);
  process.exit(1);
});
