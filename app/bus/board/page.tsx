/**
 * The boarding gate — the state the flow did not have.
 *
 * `/bus/wait` used to write a handoff and push straight to `/bus/ride`, which
 * begins counting stops. So the app decided the rider was on a bus at the moment
 * they picked one off a list, minutes before anything arrived, and every
 * announcement afterwards rested on that. This screen is what stands in the gap:
 * it waits, it tells the rider what is happening while it waits, and it asks.
 *
 * Needs the manifest and the stops for the same reason the ride screen does —
 * the audio and the names are baked, and the wait must survive a dead network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AudioManifest, RouteStops, Stop } from "@/lib/transit/types";
import { BoardScreen } from "./BoardScreen";

export const metadata = { title: "Автобус хүлээж байна" };

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relative), "utf8")) as T;
}

export default function BusBoardPage() {
  const stops = readJson<Stop[]>("public/transit/stops.json");
  const routeStops = readJson<RouteStops>("public/transit/route-stops.json");

  let manifest: AudioManifest = {};
  try {
    manifest = readJson<AudioManifest>("public/audio/transit/manifest.json");
  } catch {
    // Same as the ride screen: the flow still works and says so.
  }

  return <BoardScreen stops={stops} routeStops={routeStops} manifest={manifest} />;
}
