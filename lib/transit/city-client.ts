/**
 * The City gateway client. SERVER-SIDE ONLY — credentials never reach a browser.
 *
 * CURRENTLY DARK. `gateway-city.hamuga.mn/ubtransport` requires BOTH an
 * `x-api-key` at the Kong edge AND a bearer token from `/auth/login`, and the
 * account credentials we hold do not authenticate. Hamuga's published spec
 * declares `x-api-key` as an alternative security scheme for these paths, which
 * the running service contradicts; that is raised with them. Full probe record
 * in docs/city-gateway.md.
 *
 * So this ships behind `CITY_FEED_ENABLED` and nothing calls it. It is kept
 * complete and correct because the alternative — deleting it and rewriting it
 * later — is how a working integration becomes a rewrite. If Hamuga opens the
 * key-only path, `keyOnly: true` is the whole change.
 *
 * Token handling is deliberately defensive. The login response has never been
 * observed, so nothing here assumes a JWT, an `expires_in`, or that
 * `/auth/refresh` exists — a 401 on that path proves nothing, because the auth
 * middleware runs BEFORE routing and answers every unknown path identically.
 * The only reliable recovery is to log in again.
 */
import type { Vehicle } from "./vehicles";

const BASE = "https://gateway-city.hamuga.mn/ubtransport";

/** Refresh this far before a known expiry, so a call never races the deadline. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Assumed lifetime when the token does not describe its own expiry.
 *
 * Conservative on purpose: re-logging in more often than necessary costs one
 * request, while treating an expired token as valid costs a failed call at the
 * moment a user is waiting for an answer.
 */
const ASSUMED_LIFETIME_MS = 10 * 60_000;

export class CityAuthError extends Error {}
export class CityDisabledError extends Error {}

type Token = { value: string; expiresAt: number };

/** Module-scope, per server instance — the right granularity for a shared account. */
let cached: Token | null = null;
let inFlight: Promise<Token> | null = null;

export const isCityFeedEnabled = (): boolean => process.env.CITY_FEED_ENABLED === "true";

/** Reads a JWT's `exp` without verifying it — we are not the audience. */
function expiryFromJwt(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: number };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Walks a response body for the token, since its field name is unobserved. */
function extractToken(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const named = ["token", "accessToken", "access_token", "jwt", "idToken"];
  const walk = (node: unknown, depth: number): string | null => {
    if (depth > 4 || !node || typeof node !== "object") return null;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 40 && named.includes(key)) return value;
      if (typeof value === "object") {
        const found = walk(value, depth + 1);
        if (found) return found;
      }
    }
    // Fall back to any long string — the field name is a guess either way.
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 40) return value;
    }
    return null;
  };
  return walk(body, 0);
}

async function login(signal?: AbortSignal): Promise<Token> {
  const apiKey = process.env.HAMUGA_API_KEY;
  const phone = process.env.CITY_PHONE;
  const password = process.env.CITY_PASSWORD;

  if (!apiKey) throw new CityAuthError("HAMUGA_API_KEY missing");
  if (!phone || !password) throw new CityAuthError("CITY_PHONE / CITY_PASSWORD missing");

  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
    signal,
  });

  if (!res.ok) {
    // The gateway returns an identical message for a wrong password and for an
    // account that does not exist, so the text cannot be used to diagnose which.
    const body = await res.text().catch(() => "");
    throw new CityAuthError(`login ${res.status}: ${body.slice(0, 120)}`);
  }

  const token = extractToken(await res.json().catch(() => null));
  if (!token) throw new CityAuthError("login succeeded but no token-shaped field was found");

  return { value: token, expiresAt: expiryFromJwt(token) ?? Date.now() + ASSUMED_LIFETIME_MS };
}

/**
 * A valid token, logging in only when needed.
 *
 * Concurrent callers share one login. Without that, ten simultaneous requests
 * after an expiry become ten logins against one account, which is exactly the
 * burst that gets an account throttled.
 */
export async function getToken({ force = false, signal }: { force?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  if (!force && cached && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) return cached.value;
  if (inFlight) return (await inFlight).value;

  inFlight = login(signal).finally(() => { inFlight = null; });
  cached = await inFlight;
  return cached.value;
}

export function clearToken(): void {
  cached = null;
}

/** Shape of the documented `/ubcard-api/vehicles` row, before our renaming. */
type RawVehicle = {
  id?: number; plate_number?: string; route_name?: string;
  speed?: number; bearing?: number; latitude?: number; longitude?: number;
};

const toVehicle = (r: RawVehicle): Vehicle | null => {
  if (typeof r.latitude !== "number" || typeof r.longitude !== "number") return null;
  return {
    id: r.id ?? -1,
    plateNumber: r.plate_number ?? "",
    routeName: r.route_name ?? "",
    speed: typeof r.speed === "number" ? r.speed : 0,
    bearing: typeof r.bearing === "number" ? r.bearing : 0,
    latitude: r.latitude,
    longitude: r.longitude,
  };
};

/**
 * Live vehicle positions.
 *
 * Retries exactly once, on a 401, after forcing a fresh login — that covers an
 * expired token without turning a genuine auth failure into a retry storm
 * against a shared account.
 */
export async function fetchVehicles({ signal }: { signal?: AbortSignal } = {}): Promise<Vehicle[]> {
  if (!isCityFeedEnabled()) throw new CityDisabledError("CITY_FEED_ENABLED is not true");

  const apiKey = process.env.HAMUGA_API_KEY;
  if (!apiKey) throw new CityAuthError("HAMUGA_API_KEY missing");

  const call = async (token: string) =>
    fetch(`${BASE}/ubcard-api/vehicles`, {
      headers: { "x-api-key": apiKey, Authorization: `Bearer ${token}` },
      signal,
    });

  let res = await call(await getToken({ signal }));
  if (res.status === 401) {
    clearToken();
    res = await call(await getToken({ force: true, signal }));
  }
  if (!res.ok) throw new Error(`vehicles ${res.status}`);

  const body = (await res.json()) as unknown;
  // The envelope is unobserved: the sibling gateway wraps rows in
  // `{status, code, msg, data}`, so accept either that or a bare array.
  const rows: RawVehicle[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? ((body as { data: RawVehicle[] }).data)
      : [];

  return rows.map(toVehicle).filter((v): v is Vehicle => v !== null);
}
