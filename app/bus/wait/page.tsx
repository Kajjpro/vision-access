/**
 * Mode A — waiting at a stop.
 *
 * The transit data is baked, so it is read at build time on the server and
 * handed to the client as props. Only the arrival times touch the network, and
 * they go through /api/transit/next so the gateway key stays server-side.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AudioManifest, Route, RouteStops, Stop, StopRoutes } from "@/lib/transit/types";
import { WaitScreen } from "./WaitScreen";

export const metadata = { title: "Автобус хүлээх" };

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relative), "utf8")) as T;
}

export default function BusWaitPage() {
  const stops = readJson<Stop[]>("public/transit/stops.json");
  const routes = readJson<Route[]>("public/transit/routes.json");
  const stopRoutes = readJson<StopRoutes>("public/transit/stop-routes.json");
  const routeStops = readJson<RouteStops>("public/transit/route-stops.json");

  let manifest: AudioManifest = {};
  try {
    manifest = readJson<AudioManifest>("public/audio/transit/manifest.json");
  } catch {
    // Pilot render only covers four routes so far. The screen must still work
    // and must say so rather than going quiet.
  }

  return (
    <WaitScreen
      stops={stops}
      routes={routes}
      stopRoutes={stopRoutes}
      routeStops={routeStops}
      manifest={manifest}
    />
  );
}
