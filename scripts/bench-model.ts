/**
 * How expensive is one inference, and can it fit the frame budget?
 *
 *   npx tsx scripts/bench-model.ts [model.onnx ...]
 *
 * WHAT THIS IS AND IS NOT. This runs onnxruntime-NODE on this machine's CPU.
 * The app runs onnxruntime-WEB on a phone, usually on WebGPU. So the absolute
 * numbers here are not the app's numbers and must never be quoted as if they
 * were — `app/dev/bench` is the only thing that measures the real target.
 *
 * What it IS good for is the ratio between configurations, which is a property
 * of the arithmetic rather than the runtime: a model with a third of the FLOPs
 * takes roughly a third of the time on any backend. That is enough to choose a
 * model and an input size without a device in hand, and enough to know whether
 * a 60ms budget is even reachable before spending an hour on a tunnel.
 *
 * The single-thread column is the one to read. A phone's wasm fallback is
 * effectively one core's worth of work, and it is the floor the app has to
 * survive on when WebGPU is missing or wedged.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import * as ort from "onnxruntime-node";

/** Must match INPUT_SIZE in lib/vision.worker.ts for the shipped model. */
const WARMUP = 3;
const RUNS = 12;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function bench(path: string, threads: number) {
  ort.env.wasm.numThreads = threads;
  const session = await ort.InferenceSession.create(path, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
  });

  const input = session.inputNames[0];
  // Read the size off the model rather than assuming 640, so a 480 export is
  // measured at 480 instead of failing a shape check. `shape` is the same field
  // scripts/inspect-model.ts prints; symbolic dims come back as strings.
  const meta = session.inputMetadata[0] as unknown as {
    shape?: ReadonlyArray<number | string>;
  };
  const dims = (meta.shape ?? [1, 3, 640, 640]).map((d) =>
    typeof d === "number" && d > 0 ? d : 640,
  );
  const size = dims[2];
  const data = new Float32Array(dims[0] * dims[1] * dims[2] * dims[3]);
  for (let i = 0; i < data.length; i++) data[i] = Math.random();

  const run = async () => {
    const tensor = new ort.Tensor("float32", data, dims as number[]);
    const started = performance.now();
    await session.run({ [input]: tensor });
    return performance.now() - started;
  };

  for (let i = 0; i < WARMUP; i++) await run();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) times.push(await run());
  times.sort((a, b) => a - b);

  await session.release();
  return { size, p50: percentile(times, 0.5), p90: percentile(times, 0.9) };
}

async function main() {
  const args = process.argv.slice(2);
  const models = args.length > 0 ? args : ["public/models/yolo11s.onnx"];

  console.log("onnxruntime-node, CPU. Ratios transfer to the phone; absolutes do not.\n");
  console.log(
    `${"model".padEnd(22)} ${"in".padEnd(5)} ${"MB".padEnd(6)} ` +
      `${"1-thread".padEnd(20)} ${"4-thread".padEnd(20)}`,
  );
  console.log("-".repeat(78));

  for (const arg of models) {
    const path = resolve(process.cwd(), arg);
    if (!existsSync(path)) {
      console.log(`${arg.padEnd(22)} MISSING`);
      continue;
    }
    const mb = (statSync(path).size / 1024 / 1024).toFixed(1);
    const one = await bench(path, 1);
    const four = await bench(path, 4);
    const name = path.split("/").pop()!.replace(".onnx", "");
    console.log(
      `${name.padEnd(22)} ${String(one.size).padEnd(5)} ${mb.padEnd(6)} ` +
        `${`${one.p50.toFixed(0)}ms p90 ${one.p90.toFixed(0)}`.padEnd(20)} ` +
        `${`${four.p50.toFixed(0)}ms p90 ${four.p90.toFixed(0)}`.padEnd(20)}`,
    );
  }

  console.log(
    "\nThe app's budget is 60ms per frame (CLAUDE.md). A cheap Android core is\n" +
      "roughly 3-5x slower than this machine's, and the wasm fallback gets no GPU.",
  );
}

void main();
