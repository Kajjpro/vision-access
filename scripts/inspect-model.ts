/**
 * Throwaway: prints the tensor signature of an ONNX model so the worker's
 * preprocessing and decoding can be written against the real thing instead of
 * assumptions.
 *
 *   npx tsx scripts/inspect-model.ts [path-to.onnx]
 *
 * Defaults to the model the app actually ships. Runs on CPU via
 * onnxruntime-node — nothing here touches the browser build.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import * as ort from "onnxruntime-node";

/** Keep in step with MODEL_URL in lib/vision.worker.ts. */
const DEFAULT_MODEL = "public/models/yolo11s.onnx";

const modelPath = resolve(process.cwd(), process.argv[2] ?? DEFAULT_MODEL);

if (!existsSync(modelPath)) {
  console.error(`No model at ${modelPath}`);
  console.error(`Put the export at ${DEFAULT_MODEL}, or pass a path:`);
  console.error(`  npx tsx scripts/inspect-model.ts path/to/model.onnx`);
  process.exit(1);
}

/** Symbolic dims come back as strings (e.g. "batch"); numbers are fixed sizes. */
function formatShape(shape: ReadonlyArray<number | string>): string {
  if (shape.length === 0) return "(unspecified)";
  return `[${shape.join(", ")}]`;
}

function printSection(label: string, values: readonly ort.InferenceSession.ValueMetadata[]) {
  console.log(`\n${label} (${values.length})`);

  if (values.length === 0) {
    console.log("  (none)");
    return;
  }

  const width = Math.max(...values.map((v) => v.name.length));

  for (const value of values) {
    if (!value.isTensor) {
      console.log(`  ${value.name.padEnd(width)}  <non-tensor>`);
      continue;
    }
    console.log(`  ${value.name.padEnd(width)}  ${value.type.padEnd(8)}  ${formatShape(value.shape)}`);
  }
}

async function main() {
  const sizeMb = (statSync(modelPath).size / 1024 / 1024).toFixed(1);
  console.log(`${modelPath}\n${sizeMb} MB  ·  onnxruntime-node ${ort.env.versions.common}`);

  const session = await ort.InferenceSession.create(modelPath);

  printSection("INPUTS", session.inputMetadata);
  printSection("OUTPUTS", session.outputMetadata);

  // The thing worth knowing about a YOLO-World export: open-vocabulary builds
  // take a second text/class-embedding input, which changes how the worker
  // feeds it entirely.
  if (session.inputMetadata.length > 1) {
    console.log(
      `\nNOTE: ${session.inputMetadata.length} inputs — lib/vision.worker.ts currently feeds 1.`,
    );
  }

  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
