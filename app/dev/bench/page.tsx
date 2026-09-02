/**
 * Device benchmark. DEV ONLY.
 *
 * `notFound()` in production keeps it out of the shipped app, matching
 * app/dev/audio: the route still exists in the build but returns 404 rather
 * than exposing an internal tool that opens the camera.
 *
 * Open this on the actual phone — see NOTES.md "Dev on a phone" for the tunnel.
 * Nothing measured on a laptop answers the question this page answers.
 */
import { notFound } from "next/navigation";

import BenchHarness from "./BenchHarness";

export const metadata = { title: "Vision Access — device benchmark" };

export default function DevBenchPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <BenchHarness />;
}
