/**
 * Listening harness for the TTS pilot. DEV ONLY.
 *
 * `notFound()` in production keeps it out of the shipped app: the route still
 * exists in the build, but returns 404 rather than exposing an internal tool.
 *
 * This is a tool for making three decisions by ear, in the order they cost to
 * reverse — voice first, because re-encoding is free but re-synthesizing is
 * not. Read scripts/render-listening-set.ts for what each section contains.
 */
import { notFound } from "next/navigation";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ListeningHarness, type ListeningManifest } from "./ListeningHarness";

export const metadata = { title: "Vision Access — listening harness" };

export default function DevAudioPage() {
  if (process.env.NODE_ENV === "production") notFound();

  let manifest: ListeningManifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(process.cwd(), ".cache/listening/listening.json"), "utf8"),
    );
  } catch {
    return (
      <main style={{ padding: 32, fontFamily: "system-ui, sans-serif", maxWidth: 720 }}>
        <h1>Listening harness</h1>
        <p>No listening set found. Render it first:</p>
        <pre style={{ background: "#111", color: "#eee", padding: 16, borderRadius: 8 }}>
          npx tsx scripts/render-listening-set.ts
        </pre>
      </main>
    );
  }

  return <ListeningHarness manifest={manifest} />;
}
