/**
 * Earcon bench — the five-minute pre-flight test.
 *
 * None of the four earcons had ever played on a device before this week: the
 * ride screen constructed its AudioQueue without an earcon player, and the wait
 * screen had no earcon path at all. They have therefore never been heard
 * against the thing they were designed for, which is a bus.
 *
 * The specific question this bench exists to answer: `soft` and `alert` share a
 * 660 Hz onset and differ only in whether a second, higher tone follows. If bus
 * noise masks that second tone, "act soon" is heard as "nothing needed" — a
 * failure running in the wrong direction. Five minutes here decides whether to
 * fix that before spending a whole ride discovering it.
 *
 * Sighted, hands-on, one-off: this is a bench instrument, not part of the app,
 * so it is an ordinary page with buttons rather than a gesture surface.
 */
import { notFound } from "next/navigation";

import { EarconBench } from "./EarconBench";

export const metadata = { title: "Earcon bench" };

export default function EarconBenchPage() {
  // Same guard as /dev/audio: a bench instrument has no business on a
  // production build a rider might reach.
  if (process.env.NODE_ENV === "production") notFound();
  return <EarconBench />;
}
