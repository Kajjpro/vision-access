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

export const metadata = {
  title: "Автобус хүлээх",
  description: "Ойролцоох зогсоол, тэдгээрийг үйлчилдэг автобус, ирэх цагийг дуугаар сонсоно.",
  alternates: { canonical: "/bus/wait" },
};

// The literal "public/transit" segment (rather than a fully dynamic path)
// lets the build's file tracer scope to that folder instead of the whole
// project — see the sibling board/journey/ride pages for the same pattern.
function readTransitJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), "public/transit", name), "utf8")) as T;
}

export default function BusWaitPage() {
  const stops = readTransitJson<Stop[]>("stops.json");
  const routes = readTransitJson<Route[]>("routes.json");
  const stopRoutes = readTransitJson<StopRoutes>("stop-routes.json");
  const routeStops = readTransitJson<RouteStops>("route-stops.json");

  // The screen speaks through the shared WAV pipeline (lib/audio.ts), which
  // iOS decodes natively — no manifest needed here.
  return <WaitScreen stops={stops} routes={routes} stopRoutes={stopRoutes} routeStops={routeStops} />;
}
