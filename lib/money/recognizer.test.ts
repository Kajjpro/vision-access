/**
 * The recogniser and the reject gates, on a synthetic six-note pack.
 *
 * orb.test.ts proves the matching primitive works. This proves the thing
 * built on top of it makes the right DECISION — in particular that it
 * declines rather than guesses, which is the property CLAUDE.md cares about
 * and the one a wrong answer costs a user money for.
 *
 * Synthetic notes are strictly easier than real ones: no glare, no fold, no
 * shared design language between denominations. So a passing test here is a
 * floor, not a validation. It says the plumbing and the policy are right. It
 * does NOT say MIN_INLIERS is correctly calibrated — only photographs of real
 * tögrög notes can say that.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { detectAndCompute, type Gray } from "./orb";
import { Recognizer, MIN_INLIERS, MARGIN } from "./recognizer";
import { DESCRIPTOR_SIGNATURE, PACK_VERSION, decodePack, encodeEntry, PackError, type ReferencePack } from "./refs";
import { DENOMINATIONS, SIDES } from "./denominations";
import { decide } from "./decide";
import type { Recognition } from "./recognizer";

const W = 420;
const H = 220;

function makePattern(width: number, height: number, seed: number): Gray {
  const data = new Uint8Array(width * height).fill(210);
  let s = seed >>> 0;
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  for (let i = 0; i < 260; i++) {
    const cx = Math.floor(rand() * width), cy = Math.floor(rand() * height);
    const r = 2 + Math.floor(rand() * 7), v = Math.floor(rand() * 90);
    for (let y = Math.max(0, cy - r); y < Math.min(height, cy + r); y++)
      for (let x = Math.max(0, cx - r); x < Math.min(width, cx + r); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) data[y * width + x] = v;
  }
  for (let i = 0; i < 40; i++) {
    const x0 = Math.floor(rand() * width * 0.9), y0 = Math.floor(rand() * height * 0.9);
    const w = 5 + Math.floor(rand() * 30), h = 5 + Math.floor(rand() * 20), v = Math.floor(rand() * 60);
    for (let y = y0; y < Math.min(height, y0 + h); y++)
      for (let x = x0; x < Math.min(width, x0 + w); x++) data[y * width + x] = v;
  }
  return { data, width, height };
}

function toRgba(g: Gray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0, p = 0; i < g.data.length; i++, p += 4) {
    out[p] = out[p + 1] = out[p + 2] = g.data[i];
    out[p + 3] = 255;
  }
  return out;
}

function warp(src: Gray, h: number[], width: number, height: number): Gray {
  const [a, b, c, d, e, f, g, i, j] = h;
  const det = a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  const inv = [
    (e * j - f * i) / det, (c * i - b * j) / det, (b * f - c * e) / det,
    (f * g - d * j) / det, (a * j - c * g) / det, (c * d - a * f) / det,
    (d * i - e * g) / det, (b * g - a * i) / det, (a * e - b * d) / det,
  ];
  const out = new Uint8Array(width * height).fill(235);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const w = inv[6] * x + inv[7] * y + inv[8];
    const sx = (inv[0] * x + inv[1] * y + inv[2]) / w;
    const sy = (inv[3] * x + inv[4] * y + inv[5]) / w;
    if (sx < 0 || sy < 0 || sx >= src.width - 1 || sy >= src.height - 1) continue;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    const p00 = src.data[y0 * src.width + x0], p01 = src.data[y0 * src.width + x0 + 1];
    const p10 = src.data[(y0 + 1) * src.width + x0], p11 = src.data[(y0 + 1) * src.width + x0 + 1];
    const top = p00 + (p01 - p00) * fx, bot = p10 + (p11 - p10) * fx;
    out[y * width + x] = (top + (bot - top) * fy) | 0;
  }
  return { data: out, width, height };
}

/** A distinct pattern per (denomination, side), and the pack built from them. */
const NOTES = new Map<string, Gray>();
function buildPack(): ReferencePack {
  const entries: ReferencePack["entries"] = [];
  let seed = 1000;
  for (const d of DENOMINATIONS) {
    for (const s of SIDES) {
      seed += 7919;
      const img = makePattern(W, H, seed);
      NOTES.set(`${d}:${s}`, img);
      entries.push(encodeEntry(d, s, W, H, detectAndCompute(img, { maxFeatures: 600 })));
    }
  }
  return {
    version: PACK_VERSION,
    signature: DESCRIPTOR_SIGNATURE,
    source: "synthetic (test)",
    builtAt: new Date().toISOString(),
    entries,
  };
}

const PACK = buildPack();

// ---------------------------------------------------------------------------

test("pack survives an encode/decode round trip", () => {
  const decoded = decodePack(PACK);
  assert.equal(decoded.length, DENOMINATIONS.length * SIDES.length);
  const first = decoded[0];
  const source = detectAndCompute(NOTES.get(`${first.denomination}:${first.side}`)!, { maxFeatures: 600 });
  assert.equal(first.features.count, source.count);
  for (let i = 0; i < source.descriptors.length; i++) {
    assert.equal(first.features.descriptors[i], source.descriptors[i]);
  }
});

test("a pack from a different descriptor build is REFUSED, not used", () => {
  const stale = { ...PACK, signature: "orb-256-r15-oldseed" };
  assert.throws(() => decodePack(stale), PackError);
});

test("a pack missing a denomination is REFUSED, not silently partial", () => {
  const partial = { ...PACK, entries: PACK.entries.filter((e) => e.denomination !== 5000) };
  assert.throws(() => decodePack(partial), /missing/);
});

test("identifies the right note, and separates it clearly from the others", () => {
  const r = Recognizer.fromPack(PACK);
  const note = NOTES.get("5000:front")!;
  const view = warp(note, [0.94, 0.09, 14, -0.05, 0.97, 6, 0.00018, 0.00008, 1], W, H);

  const { result, debug } = r.recognize(toRgba(view), W, H);
  assert.ok(result, `expected a match; recogniser said: ${debug.reason}`);
  assert.equal(result.denomination, 5000);

  // The gap between right and wrong is what MIN_INLIERS and MARGIN are set
  // against, so record it rather than just asserting a boolean.
  const wrong = debug.scores.find((s) => s.denomination !== 5000)!;
  assert.ok(
    result.inliers > wrong.inliers * MARGIN,
    `winner ${result.inliers} vs runner-up ${wrong.inliers} — margin too thin`,
  );
});

test("every denomination in the pack is reachable", () => {
  const r = Recognizer.fromPack(PACK);
  for (const d of DENOMINATIONS) {
    const view = warp(NOTES.get(`${d}:back`)!, [1, 0, 6, 0, 1, -4, 0, 0, 1], W, H);
    const { result, debug } = r.recognize(toRgba(view), W, H);
    assert.ok(result, `${d} back not recognised: ${debug.reason}`);
    assert.equal(result.denomination, d, `${d} back read as ${result?.denomination}`);
  }
});

test("REJECTS an object that is not a banknote", () => {
  const r = Recognizer.fromPack(PACK);
  const notMoney = makePattern(W, H, 424242); // In no pack entry.
  const { result, debug } = r.recognize(toRgba(notMoney), W, H);
  assert.equal(result, null, `named a non-note: ${debug.reason}`);
});

test("REJECTS a blank frame", () => {
  const r = Recognizer.fromPack(PACK);
  const blank: Gray = { data: new Uint8Array(W * H).fill(205), width: W, height: H };
  assert.equal(r.recognize(toRgba(blank), W, H).result, null);
});

test("MIN_INLIERS gate is what stops a weak match being named", () => {
  const r = Recognizer.fromPack(PACK);
  const { debug } = r.recognize(toRgba(makePattern(W, H, 31337)), W, H);
  const best = debug.scores[0].inliers;
  assert.ok(best < MIN_INLIERS, `unrelated image reached ${best} inliers, gate is ${MIN_INLIERS}`);
});

// ---------------------------------------------------------------------------
// decide(): the multi-frame policy
// ---------------------------------------------------------------------------

const rec = (denomination: number, inliers = 40): Recognition => ({
  denomination: denomination as Recognition["denomination"],
  side: "front",
  inliers,
  runnerUpInliers: 5,
  runnerUp: null,
  homography: null,
});

test("decide: two agreeing frames identify the note", () => {
  const d = decide([rec(1000, 40), null, rec(1000, 32)]);
  assert.equal(d.kind, "identified");
  assert.equal(d.kind === "identified" && d.denomination, 1000);
  // Reports the weakest agreeing frame, not the strongest.
  assert.equal(d.kind === "identified" && d.inliers, 32);
});

test("decide: contradiction is DISQUALIFYING, never outvoted", () => {
  const d = decide([rec(1000), rec(1000), rec(5000)]);
  assert.equal(d.kind, "unclear", "2-vs-1 must not resolve to a majority");
  assert.match(d.kind === "unclear" ? d.reason : "", /disagree/);
});

test("decide: one good frame out of three is not enough", () => {
  assert.equal(decide([rec(1000), null, null]).kind, "unclear");
});

test("decide: all abstentions is unclear, not a crash", () => {
  assert.equal(decide([null, null, null]).kind, "unclear");
});
