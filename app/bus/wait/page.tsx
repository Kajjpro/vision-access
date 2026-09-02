/**
 * Mode A — waiting at a stop.
 *
 * The transit data is baked, so it is read at build time on the server and
 * handed to the client as props. Only the arrival times touch the network, and
 * they go through /api/transit/next so the gateway key stays server-side.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Route, RouteStops, Stop, StopRoutes } from "@/lib/transit/types";
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

  // The screen speaks through the shared WAV pipeline (lib/audio.ts), which
  // iOS decodes natively — no manifest needed here.
  return <WaitScreen stops={stops} routes={routes} stopRoutes={stopRoutes} routeStops={routeStops} />;
}
