/**
 * Read a recorded journey and answer the questions a trace exists to answer.
 *
 *   npx tsx scripts/analyse-trace.ts va-trace-20260901-0830-11100730-dir0.json
 *
 * THE CENTRAL QUESTION IS WHICH CLOCK STOPPED. A hole in the trace has at least
 * three causes and they need different fixes:
 *
 *   heartbeats continue, no fixes    geolocation stalled; the page was fine
 *   heartbeats stop, page returns    the page was suspended (locked pocket)
 *   pagehide UNLOADED, then mount    the document was destroyed and rebuilt
 *
 * Without the heartbeat all three look identical, and the wrong one gets fixed.
 */
import { readFileSync } from "node:fs";

import type { Recording } from "../lib/transit/recorder";

const path = process.argv[2];
if (!path) {
  console.error("usage: npx tsx scripts/analyse-trace.ts <recording.json>");
  process.exit(1);
}

const rec = JSON.parse(readFileSync(path, "utf8")) as Recording;
if (rec.version !== 1) {
  console.error(`unknown recording version ${rec.version}`);
  process.exit(1);
}

const t0 = rec.trace.length ? rec.trace[0].timestamp : rec.startedAt;
const rel = (t: number) => `${((t - t0) / 1000).toFixed(0)}s`;
const mins = (ms: number) => (ms / 60_000).toFixed(1);

console.log(`\n=== ${path} ===`);
console.log(`device: ${rec.device || "unknown"}`);
if (rec.route) {
  console.log(`route ${rec.route.routeId} dir ${rec.route.directionId}, boarded ${rec.route.boardingIndex}, destination ${rec.route.destinationIndex}`);
}

// ---------------------------------------------------------------- fix rate
console.log(`\n--- GPS ---`);
if (rec.trace.length < 2) {
  console.log("  not enough fixes to characterise");
} else {
  const span = rec.trace[rec.trace.length - 1].timestamp - rec.trace[0].timestamp;
  const gaps: number[] = [];
  for (let i = 1; i < rec.trace.length; i++) gaps.push(rec.trace[i].timestamp - rec.trace[i - 1].timestamp);
  gaps.sort((a, b) => a - b);
  const q = (p: number) => gaps[Math.floor(gaps.length * p)];
  const acc = rec.trace.map((f) => f.accuracy).sort((a, b) => a - b);
  const qa = (p: number) => acc[Math.floor(acc.length * p)];

  console.log(`  ${rec.trace.length} fixes over ${mins(span)} min — mean ${(rec.trace.length / (span / 1000)).toFixed(2)} Hz`);
  console.log(`  inter-fix gap: median ${(q(0.5) / 1000).toFixed(1)}s  p90 ${(q(0.9) / 1000).toFixed(1)}s  max ${(gaps[gaps.length - 1] / 1000).toFixed(0)}s`);
  console.log(`  accuracy:      median ${qa(0.5).toFixed(0)}m  p90 ${qa(0.9).toFixed(0)}m  worst ${acc[acc.length - 1].toFixed(0)}m`);
  /**
   * The engine discards fixes worse than 100 m rather than smoothing them, and
   * the confirmation windows assume roughly 1 Hz. Both assumptions are stated
   * here against what the phone actually delivered.
   */
  const unusable = acc.filter((a) => a > 100).length;
  console.log(`  over the 100 m accuracy limit: ${unusable} (${((unusable / acc.length) * 100).toFixed(1)}%) — these are discarded, not smoothed`);
}

// ------------------------------------------------------------- which clock
const beats = rec.events.filter((e): e is Extract<typeof e, { kind: "heartbeat" }> => e.kind === "heartbeat");
console.log(`\n--- WHICH CLOCK STOPPED ---`);
if (!beats.length) {
  console.log("  no heartbeats — recording predates the instrumentation, or never became active");
} else {
  const pageStalls: string[] = [];
  const gpsStalls: string[] = [];
  for (let i = 1; i < beats.length; i++) {
    const dt = beats[i].t - beats[i - 1].t;
    // The heartbeat runs at 5 s; anything past ~12 s means the timer itself
    // stopped, which means the page was not running.
    if (dt > 12_000) {
      pageStalls.push(`${rel(beats[i - 1].t)} → ${rel(beats[i].t)} (${(dt / 1000).toFixed(0)}s, page not running)`);
    } else if (beats[i].fixes === beats[i - 1].fixes) {
      gpsStalls.push(`${rel(beats[i - 1].t)} → ${rel(beats[i].t)} (page alive, no new fix)`);
    }
  }
  console.log(`  heartbeats: ${beats.length}, expected ~${Math.round((beats[beats.length - 1].t - beats[0].t) / 5000)}`);
  console.log(`  PAGE stalls (heartbeat gap > 12s): ${pageStalls.length}`);
  for (const s of pageStalls.slice(0, 12)) console.log(`     ${s}`);
  console.log(`  GEOLOCATION stalls (page alive, fix count static): ${gpsStalls.length} beats`);
  for (const s of gpsStalls.slice(0, 6)) console.log(`     ${s}`);
  const hiddenBeats = beats.filter((b) => !b.visible).length;
  console.log(`  heartbeats while hidden: ${hiddenBeats} — proof the page kept running in the background`);

  /**
   * THE THIRD FAILURE. Page running, fixes arriving, audio dead — invisible to
   * both clocks above, and the one that produces a silent journey that looks
   * like a working one.
   */
  const deadAudio = beats.filter((b) => b.audio !== "running");
  console.log(`  beats with audio NOT running: ${deadAudio.length}/${beats.length}`);
  if (deadAudio.length) {
    const states: Record<string, number> = {};
    for (const b of deadAudio) states[b.audio] = (states[b.audio] ?? 0) + 1;
    console.log(`     states: ${JSON.stringify(states)}`);
    console.log(`     first at ${rel(deadAudio[0].t)}, last at ${rel(deadAudio[deadAudio.length - 1].t)}`);
  }
}

// --------------------------------------------------- announcements lost
const silent = rec.events.filter((e): e is Extract<typeof e, { kind: "silent-push" }> => e.kind === "silent-push");
console.log(`\n--- ANNOUNCEMENTS PUSHED INTO A DEAD CONTEXT: ${silent.length} ---`);
if (!silent.length) {
  console.log("  none — every announcement reached a running context");
} else {
  console.log("  These were built, queued, and never heard. This is the evidence.");
  for (const e of silent) {
    console.log(`  ${rel(e.t).padStart(7)}  audio=${e.audio}  ${e.label || e.keys.join(" ")}`);
  }
}

// ---------------------------------------------------------- haptics
const buzzes = rec.events.filter((e): e is Extract<typeof e, { kind: "haptic" }> => e.kind === "haptic");
console.log(`\n--- HAPTICS: ${buzzes.length} calls ---`);
if (!buzzes.length) {
  console.log("  none fired");
} else {
  const absent = buzzes.filter((b) => b.accepted === undefined).length;
  const refused = buzzes.filter((b) => b.accepted === false).length;
  const ok = buzzes.filter((b) => b.accepted === true).length;
  console.log(`  accepted ${ok} · refused ${refused} · API ABSENT ${absent}`);
  if (absent === buzzes.length) {
    console.log("  navigator.vibrate does not exist on this device.");
    console.log("  The haptic channel is UNAVAILABLE, so §5 parallel channels cannot be");
    console.log("  satisfied by buzzing when audio is dead. Speech is the only channel.");
  } else if (ok > 0) {
    console.log("  The haptic channel works on this device — it needs no gesture and no");
    console.log("  audio graph, so it survives the failure that silences speech.");
  }
}

// -------------------------------------------------------------- lifecycle
const life = rec.events.filter((e): e is Extract<typeof e, { kind: "lifecycle" }> => e.kind === "lifecycle");
console.log(`\n--- PAGE LIFECYCLE (${life.length} events) ---`);
for (const e of life) console.log(`  ${rel(e.t).padStart(7)}  ${e.event}${e.detail ? ` — ${e.detail}` : ""}`);
const unloaded = life.filter((e) => e.event === "pagehide" && e.detail?.includes("UNLOADED")).length;
const mounts = life.filter((e) => e.event === "mount").length;
console.log(`  mounts: ${mounts}${mounts > 1 ? "  << THE SCREEN REMOUNTED MID-JOURNEY" : ""}`);
console.log(`  hard unloads: ${unloaded}`);

// ------------------------------------------------------------------ audio
console.log(`\n--- WHAT THE RIDER HEARD ---`);
for (const e of rec.events) {
  if (e.kind === "say") {
    const played = e.clips ? ` [played: ${e.clips.join(" ") || "NOTHING"}]` : "";
    console.log(`  ${rel(e.t).padStart(7)}  remaining=${e.remaining}  ${e.keys.join(" ")}${played}`);
  } else if (e.kind === "missing") {
    console.log(`  ${rel(e.t).padStart(7)}  MISSING CLIP: ${e.keys.join(", ")}`);
  }
}

// ---------------------------------------------------------------- battery
console.log(`\n--- BATTERY (Phase 3 input) ---`);
if (rec.battery.length < 2) {
  console.log("  not enough samples");
} else {
  const a = rec.battery[0], b = rec.battery[rec.battery.length - 1];
  const dropPct = (a.level - b.level) * 100;
  const hours = (b.t - a.t) / 3_600_000;
  console.log(`  ${Math.round(a.level * 100)}% → ${Math.round(b.level * 100)}% over ${mins(b.t - a.t)} min`);
  console.log(`  drain: ${dropPct.toFixed(1)} pp, ${hours > 0 ? (dropPct / hours).toFixed(1) : "–"} pp/hour${b.charging ? " (CHARGING — figure is meaningless)" : ""}`);
  const below15 = rec.battery.find((s) => s.level < 0.15);
  console.log(`  crossed the 15% halving threshold: ${below15 ? `yes, at ${rel(below15.t)}` : "no"}`);
}

// ------------------------------------------------------------- detectors
const eng = rec.events.filter((e): e is Extract<typeof e, { kind: "engine" }> => e.kind === "engine");
const byType: Record<string, number> = {};
for (const e of eng) byType[e.type] = (byType[e.type] ?? 0) + 1;
console.log(`\n--- ENGINE EVENTS ---`);
for (const [k, v] of Object.entries(byType).sort((x, y) => y[1] - x[1])) console.log(`  ${k.padEnd(18)} ${v}`);
const wd = eng.filter((e) => e.type === "wrong-direction");
console.log(`  wrong-direction fired: ${wd.length}${wd.length ? "  << ON A CORRECT BUS, THIS IS A FALSE POSITIVE — K IS TOO LOW" : ""}`);
for (const e of wd) console.log(`     ${rel(e.t)}  ${e.detail ?? ""}`);
console.log();
