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

// Literal directory segments (rather than a fully dynamic path) let the
// build's file tracer scope to these two folders instead of the whole
// project — see the sibling board/journey/wait pages for the same pattern.
function readTransitJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), "public/transit", name), "utf8")) as T;
}

function readManifest(): AudioManifest {
  return JSON.parse(readFileSync(join(process.cwd(), "public/audio/transit/manifest.json"), "utf8"));
}

export default function BusRidePage() {
  const stops = readTransitJson<Stop[]>("stops.json");
  const routeStops = readTransitJson<RouteStops>("route-stops.json");

  let manifest: AudioManifest = {};
  try {
    manifest = readManifest();
  } catch {
    // Pilot render covers four routes. The screen still works and says so.
  }

  return <RideScreen stops={stops} routeStops={routeStops} manifest={manifest} />;
}
