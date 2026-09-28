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

export const metadata = {
  title: "Аяллаа хэлэх",
  description: "Хаашаа явахаа дуугаараа хэлж, тохирох автобус, чиглэлээ сонгоно.",
  alternates: { canonical: "/bus/journey" },
};

// The literal "public/transit" segment (rather than a fully dynamic path)
// lets the build's file tracer scope to that folder instead of the whole
// project — see the sibling board/ride/wait pages for the same pattern.
function readTransitJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), "public/transit", name), "utf8")) as T;
}

export default function BusJourneyPage() {
  const stops = readTransitJson<Stop[]>("stops.json");
  const routes = readTransitJson<Route[]>("routes.json");
  const routeStops = readTransitJson<RouteStops>("route-stops.json");

  return <JourneyScreen stops={stops} routes={routes} routeStops={routeStops} />;
}
