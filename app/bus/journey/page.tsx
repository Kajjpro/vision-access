/**
 * Spoken journey capture.
 *
 * Same shape as the other bus screens: the baked transit data is read on the
 * server at build time and handed to the client as props, so none of it is
 * bundled into the JS and the gateway key never leaves this process.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Route, RouteStops, Stop } from "@/lib/transit/types";
import { JourneyScreen } from "./JourneyScreen";

export const metadata = { title: "Аяллаа хэлэх" };

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relative), "utf8")) as T;
}

export default function BusJourneyPage() {
  const stops = readJson<Stop[]>("public/transit/stops.json");
  const routes = readJson<Route[]>("public/transit/routes.json");
  const routeStops = readJson<RouteStops>("public/transit/route-stops.json");

  return <JourneyScreen stops={stops} routes={routes} routeStops={routeStops} />;
}
