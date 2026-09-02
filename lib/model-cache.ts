/**
 * The detector's weights, and everything about getting them onto the phone.
 *
 * Shared by two callers with very different needs, which is the whole reason
 * this is a module and not part of the worker:
 *
 *   - The HOME SCREEN calls `downloadModel()` while the user is still listening
 *     to the welcome. It only wants the bytes to be ON DISK; it never asks for
 *     them, so it never allocates 39 MB on the main thread.
 *   - The WORKER calls `readModelBytes()` when it actually needs to build a
 *     session, and gets one buffer.
 *
 * Before this split the download did not begin until WalkMode had mounted AND
 * the camera stream was live, so the longest part of startup was queued behind
 * the part that needs a permission prompt. Nothing about that ordering was
 * necessary: the weights do not depend on the camera.
 *
 * RESUMABILITY IS THE POINT ON MOBILE DATA. The model is downloaded as a
 * sequence of Range requests, each stored as its own Cache Storage entry, so a
 * connection that drops at 80% costs the current chunk and not the other 31 MB.
 * A user walking through a city is exactly the user whose connection drops, and
 * restarting a 39 MB download from zero on a metered link is how someone
 * decides this app is not worth keeping installed.
 *
 * MEMORY IS THE OTHER CONSTRAINT. iOS Safari kills a tab that grows past a few
 * hundred MB and reloads it, which to a user who cannot see the screen looks
 * exactly like "the app restarted itself and never worked". `cache.put()` is
 * handed the Response directly so the browser streams it to disk without the
 * bytes ever passing through a JS array, and the one place a full-size buffer
 * is allocated — `readModelBytes()` — fills it in place from one chunk at a
 * time.
 */

/** Bump to invalidate cached model bytes after re-exporting. */
export const MODEL_CACHE = "vision-model-v4";

/** Everything this app has ever written, so stale versions can be found again. */
const MODEL_CACHE_PREFIX = "vision-model-";

/**
 * Kept in step with MODEL_URL in lib/vision.worker.ts, which is the one the app
 * actually loads — nothing imports this module yet.
 */
export const MODEL_URL = "/models/yolo11s.onnx";

/**
 * 4 MB.
 *
 * The trade is bounded on both sides. Smaller chunks lose less to a dropped
 * connection but cost a request each — over a high-latency mobile link the
 * per-request overhead starts to dominate somewhere below a megabyte. Larger
 * chunks are cheaper but throw away more when the link fails, which is the
 * failure this exists to fix. At 4 MB a 39 MB model is 10 requests and a drop
 * costs at most 4 MB.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Where the download's own bookkeeping lives — total size, and the validator
 * the server gave us for the file those chunks were cut from.
 *
 * Kept inside the same cache as the chunks so that deleting the cache deletes
 * the metadata with it, and a bumped MODEL_CACHE cannot ever be read using a
 * previous export's byte count.
 */
const META_KEY = `${MODEL_URL}?meta`;

/** The non-resumable fallback: the whole file as a single entry. */
const WHOLE_KEY = MODEL_URL;

const chunkKey = (index: number) => `${MODEL_URL}?part=${index}`;

type Meta = {
  total: number;
  /** ETag or Last-Modified. Null when the server sends neither. */
  validator: string | null;
};

export type ProgressFn = (loaded: number, total: number) => void;

/**
 * Deletes model caches from previous exports.
 *
 * Bumping MODEL_CACHE without this only ADDS a cache: the old entry keeps its
 * copy of the previous model forever. Two or three exports in and the origin is
 * over its Cache Storage quota, `put` starts throwing, and the model is then
 * re-downloaded in full on every single load — slow on desktop, terminal on a
 * phone.
 */
export async function purgeStaleModelCaches(): Promise<void> {
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(MODEL_CACHE_PREFIX) && k !== MODEL_CACHE)
        .map((k) => caches.delete(k)),
    );
  } catch {
    // Private mode / no Cache API. Nothing to clean up, and nothing to report.
  }
}

/** null when Cache Storage is unavailable — private mode, mostly. */
async function openCache(): Promise<Cache | null> {
  try {
    return await caches.open(MODEL_CACHE);
  } catch {
    return null;
  }
}

function validatorOf(res: Response): string | null {
  return res.headers.get("etag") ?? res.headers.get("last-modified");
}

async function readMeta(cache: Cache): Promise<Meta | null> {
  try {
    const res = await cache.match(META_KEY);
    return res ? ((await res.json()) as Meta) : null;
  } catch {
    return null;
  }
}

async function writeMeta(cache: Cache, meta: Meta): Promise<void> {
  try {
    await cache.put(META_KEY, new Response(JSON.stringify(meta)));
  } catch {
    // Over quota. The download still works; it just cannot resume next time.
  }
}

/**
 * Asks the server how big the model is and whether it will serve ranges, in one
 * request, by requesting a single byte.
 *
 * A HEAD would be the obvious call and tells us less: plenty of servers answer
 * HEAD with a Content-Length while still ignoring Range on the real GET, and
 * discovering that only after committing to the chunked path means discovering
 * it 10 requests in. A one-byte Range request answers both questions — 206 with
 * a Content-Range means ranges work and names the total; anything else sends us
 * down the whole-file path immediately.
 */
async function probe(): Promise<{ total: number; validator: string | null; ranges: boolean }> {
  const res = await fetch(MODEL_URL, { headers: { Range: "bytes=0-0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  // Drain the single byte so the connection can be reused.
  await res.arrayBuffer().catch(() => {});

  const validator = validatorOf(res);

  if (res.status === 206) {
    // "bytes 0-0/39142584"
    const total = Number(res.headers.get("content-range")?.split("/")[1] ?? 0);
    if (total > 0) return { total, validator, ranges: true };
  }

  const total = Number(res.headers.get("content-length") ?? 0);
  return { total, validator, ranges: false };
}

/**
 * Downloads the whole file as one Cache Storage entry.
 *
 * The path taken when the server will not serve ranges. Not resumable — a drop
 * costs the entire download — which is precisely why it is the fallback and not
 * the default.
 */
async function downloadWhole(cache: Cache | null, onProgress?: ProgressFn): Promise<void> {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  onProgress?.(0, total);
  if (!cache) return; // Nothing to store into; the worker will fetch it itself.
  await cache.put(WHOLE_KEY, res);
  onProgress?.(total, total);
}

/**
 * Ensures every byte of the model is in Cache Storage, resuming whatever a
 * previous attempt left behind.
 *
 * Safe to call repeatedly and from anywhere: a fully cached model makes this a
 * handful of `cache.match` calls and no network at all. Concurrent callers are
 * collapsed onto one in-flight download by `inFlight` below, so the home screen
 * warming the cache and WalkMode starting for real never fetch the same chunk
 * twice.
 */
async function downloadModelUncoalesced(onProgress?: ProgressFn): Promise<void> {
  const cache = await openCache();

  // No Cache API at all (private mode). There is nothing useful to do ahead of
  // time — the worker will download it when it needs it.
  if (!cache) return;

  // Already complete from a previous session?
  if (await cache.match(WHOLE_KEY)) {
    const meta = await readMeta(cache);
    onProgress?.(meta?.total ?? 0, meta?.total ?? 0);
    return;
  }

  let meta = await readMeta(cache);

  if (!meta) {
    const found = await probe();
    if (!found.ranges || found.total <= 0) {
      await writeMeta(cache, { total: found.total, validator: found.validator });
      await downloadWhole(cache, onProgress);
      return;
    }
    meta = { total: found.total, validator: found.validator };
    await writeMeta(cache, meta);
  }

  const chunks = Math.ceil(meta.total / CHUNK_BYTES);
  let loaded = 0;

  for (let i = 0; i < chunks; i++) {
    const key = chunkKey(i);
    const have = await cache.match(key);
    if (have) {
      // Trusting the stored length rather than reading the body: this runs on
      // the main thread during startup and the point of the prefetch is to
      // touch as little as possible.
      loaded += Number(have.headers.get("content-length") ?? 0);
      onProgress?.(Math.min(loaded, meta.total), meta.total);
      continue;
    }

    const start = i * CHUNK_BYTES;
    const end = Math.min(start + CHUNK_BYTES, meta.total) - 1;
    const res = await fetch(MODEL_URL, { headers: { Range: `bytes=${start}-${end}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const size = end - start + 1;

    /**
     * The file changed under a partially downloaded set.
     *
     * Mixing chunks from two exports produces a file that is the right length
     * and is not any valid model. Throwing away what we have and starting again
     * costs a download; not checking costs a session that fails to initialise
     * for reasons nothing in the logs would explain.
     */
    const validator = validatorOf(res);
    if (meta.validator && validator && validator !== meta.validator) {
      await Promise.all([...Array(chunks).keys()].map((n) => cache.delete(chunkKey(n))));
      await cache.delete(META_KEY);
      throw new Error("model changed mid-download — cache cleared, retry");
    }

    await cache.put(key, res);
    loaded += end - start + 1;
    onProgress?.(Math.min(loaded, meta.total), meta.total);
  }
}

/** One download at a time, however many callers ask for it. */
let inFlight: Promise<void> | null = null;

export function downloadModel(onProgress?: ProgressFn): Promise<void> {
  inFlight ??= downloadModelUncoalesced(onProgress).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Streams a response into an existing buffer at `offset`.
 *
 * Reading `res.arrayBuffer()` would be shorter and would hold the chunk twice
 * at the moment of the copy. At 4 MB that is survivable and at whole-file sizes
 * it is not, and this same function serves both paths.
 */
async function readInto(res: Response, dest: Uint8Array, offset: number): Promise<number> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    dest.set(buf, offset);
    return buf.length;
  }
  const reader = res.body.getReader();
  let written = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + written + value.length > dest.length) {
      throw new Error("model longer than its declared length");
    }
    dest.set(value, offset + written);
    written += value.length;
  }
  return written;
}

/**
 * The model bytes, as one buffer, downloading whatever is missing first.
 *
 * This is the only place a 39 MB allocation happens. It is filled in place from
 * one chunk at a time, so the peak is one copy of the model plus one chunk —
 * not the two copies that collecting chunks into an array and concatenating
 * would cost.
 */
export async function readModelBytes(onProgress?: ProgressFn): Promise<Uint8Array> {
  await downloadModel(onProgress);

  const cache = await openCache();

  // No Cache Storage: straight to the network, no resumability available.
  if (!cache) {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const total = Number(res.headers.get("content-length") ?? 0);
    if (total <= 0) return new Uint8Array(await res.arrayBuffer());
    const bytes = new Uint8Array(total);
    const got = await readInto(res, bytes, 0);
    if (got !== total) throw new Error(`model truncated: ${got}/${total} bytes`);
    return bytes;
  }

  const whole = await cache.match(WHOLE_KEY);
  if (whole) {
    const total = Number(whole.headers.get("content-length") ?? 0);
    if (total > 0) {
      const bytes = new Uint8Array(total);
      const got = await readInto(whole, bytes, 0);
      if (got !== total) throw new Error(`model truncated: ${got}/${total} bytes`);
      return bytes;
    }
    return new Uint8Array(await whole.arrayBuffer());
  }

  const meta = await readMeta(cache);
  if (!meta || meta.total <= 0) throw new Error("model cache has no size recorded");

  const bytes = new Uint8Array(meta.total);
  const chunks = Math.ceil(meta.total / CHUNK_BYTES);
  let offset = 0;

  for (let i = 0; i < chunks; i++) {
    const res = await cache.match(chunkKey(i));
    if (!res) throw new Error(`model chunk ${i} missing after download`);
    offset += await readInto(res, bytes, offset);
    onProgress?.(offset, meta.total);
  }

  if (offset !== meta.total) throw new Error(`model truncated: ${offset}/${meta.total} bytes`);
  return bytes;
}

/**
 * Whether a background prefetch is appropriate on this connection.
 *
 * Save-Data is a user telling the browser they are paying for every megabyte,
 * and 39 MB of weights for a mode they may not open is exactly the download
 * that setting exists to prevent. On 2G the prefetch would also still be
 * running when the user reached Walk mode, so it buys nothing and competes with
 * the clips the app needs in order to speak at all.
 *
 * Nothing is lost by declining: WalkMode downloads the model itself, with a
 * progress readout, when the user actually asks for it.
 */
type NetworkInformation = { saveData?: boolean; effectiveType?: string };

export function shouldPrefetch(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (!connection) return true; // Safari reports nothing; assume it is fine.
  if (connection.saveData) return false;
  return connection.effectiveType !== "slow-2g" && connection.effectiveType !== "2g";
}
