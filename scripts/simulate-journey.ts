/**
 * Replay a journey and print what the rider would have heard.
 *
 *   npx tsx scripts/simulate-journey.ts --route 10000200 --dir 0 --dest 9
 *   npx tsx scripts/simulate-journey.ts --route 10000200 --dir 0 --dest 9 --dropout 150:40
 *   npx tsx scripts/simulate-journey.ts --trace fixtures/traces/sansar.json --route ... --dir ... --dest ...
 *
 * WHY THIS EXISTS. The countdown cannot be tested on a bus more than once or
 * twice a day, and the failures that matter are sequence failures — a duplicate,
 * a skipped rung, a line arriving after arrival. None of those reproduce from a
 * bug report, because you cannot re-run a bus. Everything in the path is pure, so
 * a trace replays through the real engine and the real ladder in milliseconds.
 *
 * A recorded trace is `[{ lat, lon, accuracy, timestamp }]`. Without one, a
 * seeded synthetic trace is generated over the route's own geometry, which is
 * deterministic — the same flags always produce the same transcript.
 */
import { readFileSync } from "node:fs";

import { simulateJourney, type TranscriptLine } from "../lib/countdown/simulate";
import type { Fix } from "../lib/countdown/engine";
import type { GeometryStop } from "../lib/countdown/geometry";
import { generateTrace } from "../lib/transit/gps-sim";
import type { RouteStops, Stop } from "../lib/transit/types";

type Args = Record<string, string | true>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) { args[key] = value; i++; } else { args[key] = true; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const stops: Stop[] = JSON.parse(readFileSync("public/transit/stops.json", "utf8"));
const routeStops: RouteStops = JSON.parse(readFileSync("public/transit/route-stops.json", "utf8"));
const byId = new Map(stops.map((s) => [s.id, s]));

function chainFor(routeId: string, dir: string): GeometryStop[] {
  return (routeStops[routeId]?.[dir] ?? [])
    .map((id) => byId.get(id))
    .filter((s): s is Stop => Boolean(s))
    .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));
}

/** `--dropout 150:40` — starts at 150 s, lasts 40 s. Repeatable via commas. */
function parseDropouts(spec: string | true | undefined): { startSec: number; durationSec: number }[] {
  if (typeof spec !== "string") return [];
  return spec.split(",").map((part) => {
    const [startSec, durationSec] = part.split(":").map(Number);
    return { startSec, durationSec: durationSec ?? 30 };
  });
}

function main(): void {
  const routeId = typeof args.route === "string" ? args.route : Object.keys(routeStops)[0];
  const dir = typeof args.dir === "string" ? args.dir : "0";
  const chain = chainFor(routeId, dir);

  if (chain.length < 2) {
    console.error(`route ${routeId} direction ${dir} has ${chain.length} stops — nothing to replay`);
    console.error(`known routes: ${Object.keys(routeStops).slice(0, 8).join(", ")} …`);
    process.exit(1);
  }

  const destinationIndex = typeof args.dest === "string" ? Number(args.dest) : chain.length - 1;
  if (!Number.isInteger(destinationIndex) || destinationIndex < 1 || destinationIndex >= chain.length) {
    console.error(`--dest must be 1..${chain.length - 1}`);
    process.exit(1);
  }

  let fixes: Fix[];
  if (typeof args.trace === "string") {
    /**
     * Accepts either a bare fix array or a recorder file.
     *
     * `lib/transit/recorder.ts` writes `{version, route, trace, events, …}` —
     * the diagnostics have to travel with the fixes or a trace arrives with no
     * way to tell which route it was. Unwrapping here is what makes "record on
     * a phone, replay on a laptop" a copy rather than a conversion step.
     */
    const parsed = JSON.parse(readFileSync(args.trace, "utf8")) as unknown;
    const raw = (Array.isArray(parsed) ? parsed : (parsed as { trace?: unknown[] }).trace ?? []) as
      { lat: number; lon: number; accuracy?: number; accuracyM?: number; timestamp: number }[];
    if (!raw.length) {
      console.error(`${args.trace} contains no fixes — expected an array, or an object with a "trace" array`);
      process.exit(1);
    }
    fixes = raw.map((f) => ({
      lat: f.lat, lon: f.lon,
      accuracyM: f.accuracyM ?? f.accuracy ?? 20,
      timestamp: f.timestamp,
    }));
  } else {
    fixes = generateTrace(chain, {
      seed: typeof args.seed === "string" ? Number(args.seed) : 1,
      noiseM: typeof args.noise === "string" ? Number(args.noise) : 25,
      speedKmh: typeof args.speed === "string" ? Number(args.speed) : 25,
      dropouts: parseDropouts(args.dropout),
    }).map((f) => ({ lat: f.lat, lon: f.lon, accuracyM: f.accuracy, timestamp: f.timestamp }));
  }

  const { transcript, finalState } = simulateJourney({ chain, fixes, destinationIndex });

  console.log(`route ${routeId} dir ${dir} — ${chain.length} stops, ${fixes.length} fixes`);
  console.log(`destination: [${destinationIndex}] ${chain[destinationIndex].name}\n`);

  if (transcript.length === 0) {
    console.log("  (silence — nothing reached a rung)");
  }
  for (const line of transcript) {
    console.log(format(line));
  }

  console.log(`\nended at index ${finalState.stopIndex}/${chain.length - 1}, confidence ${finalState.confidence}`);

  // The three sequence failures, checked here so a manual run reports them too.
  const lines = transcript.map((l) => l.keys.join(" "));
  const duplicates = lines.filter((l, i) => lines.indexOf(l) !== i);
  if (duplicates.length) console.error(`\nDUPLICATE announcements: ${[...new Set(duplicates)].join(" | ")}`);

  const counts = transcript.map((l) => l.remaining);
  const climbed = counts.some((c, i) => i > 0 && c > counts[i - 1]);
  if (climbed) console.error(`\nOUT OF ORDER: the count climbed — ${counts.join(" → ")}`);

  if (duplicates.length || climbed) process.exit(1);
}

function format(line: TranscriptLine): string {
  const at = (line.atMs / 1000).toFixed(0).padStart(5);
  const earcon = (line.earcon ?? "—").padEnd(7);
  const remaining = String(line.remaining).padStart(3);
  const haptic = line.haptic?.length ? `~${line.haptic.length}` : "  ";
  return `${at}s  remaining=${remaining}  ${earcon} ${haptic}  ${line.keys.join(" ")}`;
}

main();
