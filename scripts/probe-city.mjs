/**
 * Task 0 probe for the City gateway. Re-runnable, and it prints NO secrets —
 * credentials and the token itself are described by shape and length only.
 *
 * Run:  node --env-file=.env.local scripts/probe-city.mjs [step]
 *
 * Steps: auth | vehicles | freshness | join | coverage | stations | all
 */
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = "https://gateway-city.hamuga.mn/ubtransport";
const KEY = process.env.HAMUGA_API_KEY;
const PHONE = process.env.CITY_PHONE;
const PASSWORD = process.env.CITY_PASSWORD;

const OUT = "probe-output";
mkdirSync(OUT, { recursive: true });

const save = (name, data) => {
  writeFileSync(`${OUT}/${name}`, JSON.stringify(data, null, 2));
  console.log(`  → ${OUT}/${name}`);
};

/** Describes a value's SHAPE without revealing it — for tokens and secrets. */
function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  const t = typeof v;
  if (t === "string") {
    const dots = (v.match(/\./g) ?? []).length;
    const jwt = dots === 2 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(v);
    return `string(len=${v.length}${jwt ? ", JWT" : ""})`;
  }
  if (t === "object") return `object{${Object.keys(v).join(",")}}`;
  return `${t}(${v})`;
}

/** Decodes a JWT payload for expiry only. Never prints the signature. */
function jwtClaims(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function login() {
  if (!KEY) throw new Error("HAMUGA_API_KEY missing");
  if (!PHONE || !PASSWORD) throw new Error("CITY_PHONE / CITY_PASSWORD missing from .env.local");

  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: PHONE, password: PASSWORD }),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, raw: text.slice(0, 300) };
  }
  return { ok: res.ok, status: res.status, body };
}

/** Walks a body looking for anything token-shaped, wherever it is nested. */
function findToken(obj, path = "") {
  if (!obj || typeof obj !== "object") return [];
  const hits = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === "string" && v.length > 40) hits.push({ path: p, value: v });
    else if (typeof v === "object") hits.push(...findToken(v, p));
  }
  return hits;
}

export async function stepAuth() {
  console.log("\n=== 0.1 AUTH ===");
  const t0 = Date.now();
  const r = await login();
  console.log(`  POST /auth/login → ${r.status} in ${Date.now() - t0}ms`);

  if (!r.ok) {
    console.log("  FAILED:", JSON.stringify(r.body ?? r.raw).slice(0, 300));
    return null;
  }

  // Envelope shape, no values.
  console.log("  envelope:");
  for (const [k, v] of Object.entries(r.body)) console.log(`    ${k}: ${describe(v)}`);

  const candidates = findToken(r.body);
  console.log(`  token-shaped fields: ${candidates.length}`);
  for (const c of candidates) console.log(`    ${c.path}: ${describe(c.value)}`);

  if (candidates.length === 0) {
    console.log("  !! no token-shaped field found — inspect the envelope above");
    return null;
  }

  const token = candidates[0].value;
  const claims = jwtClaims(token);
  if (claims) {
    console.log("  JWT claims (non-secret):", JSON.stringify(
      Object.fromEntries(Object.entries(claims).filter(([k]) => !/name|phone|email/i.test(k))),
    ));
    if (claims.exp) {
      const lifetimeSec = claims.exp - (claims.iat ?? Math.floor(Date.now() / 1000));
      console.log(`  TOKEN LIFETIME: ${lifetimeSec}s (${(lifetimeSec / 3600).toFixed(2)}h)`);
      console.log(`  expires at: ${new Date(claims.exp * 1000).toISOString()}`);
    }
  } else {
    console.log("  token is NOT a JWT — lifetime not self-describing, must be probed empirically");
  }

  save("city-01-auth-shape.json", {
    status: r.status,
    envelope: Object.fromEntries(Object.entries(r.body).map(([k, v]) => [k, describe(v)])),
    tokenFields: candidates.map((c) => ({ path: c.path, shape: describe(c.value) })),
    jwtClaims: claims
      ? Object.fromEntries(Object.entries(claims).filter(([k]) => !/name|phone|email/i.test(k)))
      : null,
  });

  return { token, body: r.body };
}

/** Tries several auth header styles — which one the app accepts is unverified. */
export async function authedFetch(token, path, { scheme = "Bearer" } = {}) {
  const headers = { "x-api-key": KEY };
  if (scheme === "Bearer") headers.Authorization = `Bearer ${token}`;
  else if (scheme === "raw") headers.Authorization = token;
  else if (scheme === "token") headers.token = token;
  else if (scheme === "x-token") headers["x-token"] = token;

  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, ok: res.ok, body, bytes: text.length };
}

/** Finds which header style the gateway actually accepts. */
export async function findScheme(token) {
  console.log("\n=== auth header style ===");
  for (const scheme of ["Bearer", "raw", "token", "x-token"]) {
    const r = await authedFetch(token, "/ubcard-api/vehicles", { scheme });
    const msg = r.body?.message ?? "";
    console.log(`  ${scheme.padEnd(8)} → ${r.status} ${r.bytes}B ${String(msg).slice(0, 60)}`);
    if (r.ok) {
      console.log(`  ACCEPTED: ${scheme}`);
      return scheme;
    }
  }
  return null;
}

const step = process.argv[2] ?? "auth";

if (step === "auth" || step === "all") {
  const auth = await stepAuth();
  if (auth) {
    const scheme = await findScheme(auth.token);
    if (!scheme) console.log("\n  !! logged in but no header style was accepted");
    else save("city-02-scheme.json", { scheme });
  }
}
