/**
 * Mode B — riding the bus. Fully offline.
 *
 * Every byte this screen needs is baked: the stop sequence, the names, and the
 * audio. Nothing here touches the network, because the one thing that must
 * never fail is the thing you cannot rely on a network for.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AudioManifest, RouteStops, Stop } from "@/lib/transit/types";
import { RideScreen } from "./RideScreen";

export const metadata = { title: "Автобусанд явж байна" };

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relative), "utf8")) as T;
}

export default function BusRidePage() {
  const stops = readJson<Stop[]>("public/transit/stops.json");
  const routeStops = readJson<RouteStops>("public/transit/route-stops.json");

  let manifest: AudioManifest = {};
  try {
    manifest = readJson<AudioManifest>("public/audio/transit/manifest.json");
  } catch {
    // Pilot render covers four routes. The screen still works and says so.
  }

  return <RideScreen stops={stops} routeStops={routeStops} manifest={manifest} />;
}
