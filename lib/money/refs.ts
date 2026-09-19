/**
 * The reference pack — this app's banknote "model".
 *
 * One entry per (denomination, side): the ORB features of a single flat
 * reference photograph of that note. Recognition compares a camera frame
 * against these, so the pack is what gets shipped and cached in place of a
 * retrained ONNX file.
 *
 * WHAT IT COSTS. Twelve entries at ~500 features is roughly 250 KB of
 * descriptors, against the 36 MB the obstacle detector already pulls over
 * mobile data. Adding a denomination is two photographs and a rebuild.
 *
 * COMPATIBILITY IS CHECKED, NOT ASSUMED. The descriptor is defined by the
 * sampling pattern in orb.ts, which is seeded so it is stable across builds.
 * If that seed, the bit count or the patch radius ever changes, every stored
 * descriptor becomes meaningless — but it stays a well-formed number, so
 * nothing would visibly break. Matching would just quietly degrade to noise,
 * and a recogniser degraded to noise still returns SOMETHING. The header
 * below turns that silent failure into a refusal to load.
 */
import { DESCRIPTOR_BITS, DESCRIPTOR_WORDS, type Features } from "./orb";
import { DENOMINATIONS, SIDES, type Denomination, type Side } from "./denominations";

/** Bump when anything about descriptor geometry changes. */
export const PACK_VERSION = 1;

/**
 * Identifies the descriptor definition itself. orb.ts derives its pattern from
 * a fixed seed; this string pins the other two parameters that would silently
 * invalidate a pack. See the note above about failing loudly.
 */
export const DESCRIPTOR_SIGNATURE = `orb-${DESCRIPTOR_BITS}-r15disk-s0x2545f491`;

export type ReferenceEntry = {
  denomination: Denomination;
  side: Side;
  /** Reference image dimensions, needed to sanity-check the homography. */
  width: number;
  height: number;
  count: number;
  /** base64 Float32Array, length `count`. */
  x: string;
  y: string;
  /** base64 Uint32Array, length `count * DESCRIPTOR_WORDS`. */
  descriptors: string;
};

export type ReferencePack = {
  version: number;
  signature: string;
  /** Free text recording where the reference images came from. */
  source: string;
  builtAt: string;
  entries: ReferenceEntry[];
};

// ---------------------------------------------------------------------------
// base64, working in both the browser worker and the node build script
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Copy through a fresh buffer: a typed array view may not be byte-aligned. */
function bytesOf(a: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
}

// ---------------------------------------------------------------------------
// Serialise / deserialise
// ---------------------------------------------------------------------------

export function encodeEntry(
  denomination: Denomination,
  side: Side,
  width: number,
  height: number,
  features: Features,
): ReferenceEntry {
  return {
    denomination,
    side,
    width,
    height,
    count: features.count,
    x: toBase64(bytesOf(features.x)),
    y: toBase64(bytesOf(features.y)),
    descriptors: toBase64(bytesOf(features.descriptors)),
  };
}

export type DecodedReference = {
  denomination: Denomination;
  side: Side;
  width: number;
  height: number;
  features: Features;
};

export function decodeEntry(entry: ReferenceEntry): DecodedReference {
  const xBytes = fromBase64(entry.x);
  const yBytes = fromBase64(entry.y);
  const dBytes = fromBase64(entry.descriptors);

  const x = new Float32Array(xBytes.buffer, xBytes.byteOffset, entry.count);
  const y = new Float32Array(yBytes.buffer, yBytes.byteOffset, entry.count);
  const descriptors = new Uint32Array(
    dBytes.buffer,
    dBytes.byteOffset,
    entry.count * DESCRIPTOR_WORDS,
  );

  return {
    denomination: entry.denomination,
    side: entry.side,
    width: entry.width,
    height: entry.height,
    features: {
      count: entry.count,
      x,
      y,
      // Neither is read after decoding — matching uses descriptors and
      // positions only — but Features is one type and a half-filled one
      // invites a reader to trust a field that is zeros.
      angle: new Float32Array(entry.count),
      score: new Float32Array(entry.count),
      descriptors,
    },
  };
}

export class PackError extends Error {}

/**
 * Validate and decode. Throws rather than returning a partial pack: a pack
 * missing a denomination does not fail loudly at match time, it just never
 * recognises that note, and "the app never says 5000" is a bug that could
 * survive a long time in the field.
 */
export function decodePack(pack: ReferencePack): DecodedReference[] {
  if (pack.version !== PACK_VERSION) {
    throw new PackError(`pack version ${pack.version}, expected ${PACK_VERSION}`);
  }
  if (pack.signature !== DESCRIPTOR_SIGNATURE) {
    throw new PackError(
      `pack built for descriptor ${pack.signature}, this build computes ${DESCRIPTOR_SIGNATURE}. ` +
        `Rebuild: npx tsx scripts/build-money-refs.ts`,
    );
  }
  if (!Array.isArray(pack.entries) || pack.entries.length === 0) {
    throw new PackError("pack has no entries");
  }

  const decoded = pack.entries.map(decodeEntry);
  const seen = new Set(decoded.map((d) => `${d.denomination}:${d.side}`));
  const missing: string[] = [];
  for (const d of DENOMINATIONS) {
    for (const s of SIDES) {
      if (!seen.has(`${d}:${s}`)) missing.push(`${d} ${s}`);
    }
  }
  if (missing.length) throw new PackError(`pack is missing: ${missing.join(", ")}`);

  return decoded;
}
