"use client";

/**
 * Waiting for the bus, and the question at the end of it.
 *
 * ── WHAT THIS FIXES ────────────────────────────────────────────────────────
 *
 * The seam between choosing a bus and riding one had nothing in it. `board()`
 * on the wait screen wrote a handoff and called `router.push("/bus/ride")`, and
 * the ride screen started counting stops from the boarding index. Between
 * picking a route off a list and a bus actually arriving there are several
 * minutes in which a rider stands next to a road, and the old flow was already
 * telling them things about a journey that had not started. Then it never
 * checked whether it ever did.
 *
 * ── WHAT IT REFUSES TO CLAIM ───────────────────────────────────────────────
 *
 * There is no vehicle feed. So this screen never says a bus is arriving, never
 * says one has arrived, and never concludes from a clock that one came and went.
 * `bus_due` means a printed timetable ran out. When the estimate expires with no
 * answer it says exactly that — "the bus was expected around now" — and asks.
 *
 * All journey logic lives in `useJourney`. What this screen owns is its own
 * input: reading the handoff, polling one platform's arrivals, and mapping a
 * selected option onto an event.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { JourneySurface } from "@/components/navigation/JourneySurface";
import { evidenceFor } from "@/lib/journey/types";
import { useJourney, useJourneyClock } from "@/lib/journey/useJourney";
import { countdownFor, isStale } from "@/lib/transit/eta";
import { haversine } from "@/lib/transit/geo";
import { readHandoff, validateHandoff } from "@/lib/transit/handoff";
import type {
  Arrival, AudioManifest, NextArrivalsResponse, RouteStops, Stop,
} from "@/lib/transit/types";

/** Same cadence the wait screen refreshes arrivals on. */
const ARRIVALS_REFRESH_MS = 60_000;
/** How often the due/overdue boundary is checked. Cheap, and no state is set unless it moved. */
const DUE_CHECK_MS = 5_000;

export function BoardScreen({
  stops, routeStops, manifest,
}: { stops: Stop[]; routeStops: RouteStops; manifest: AudioManifest }) {
  const router = useRouter();
  const now = useJourneyClock();
  const j = useJourney(manifest, now);
  const { journey, send, note } = j;

  const [arrival, setArrival] = useState<Arrival | null>(null);
  const seededRef = useRef(false);
  const stopsById = useMemo(() => new Map(stops.map((s) => [s.id, s])), [stops]);

  /**
   * Seeds the journey from the handoff the wait screen wrote.
   *
   * RE-VALIDATED rather than trusted: a data rebuild between the two screens can
   * shift a sequence, and an index that no longer points at the stop the rider
   * is standing at would produce a confident, wrong countdown for the whole ride.
   */
  const seed = useCallback(() => {
    if (seededRef.current) return;
    seededRef.current = true;

    const raw = readHandoff(sessionStorage);
    if (!raw) {
      note("no handoff — nothing to wait for");
      send({ type: "failed", fault: "route_data_missing" });
      return;
    }
    const checked = validateHandoff(raw, routeStops);
    if (!checked.ok) {
      note(`handoff rejected: ${checked.reason}`);
      send({ type: "failed", fault: "route_data_missing" });
      return;
    }

    const h = checked.handoff;
    const origin = stopsById.get(h.boardingStopId) ?? null;
    const alightId = sessionStorage.getItem("vision-access:alight-stop");
    const destination = alightId ? (stopsById.get(alightId) ?? null) : null;
    const sequence = routeStops[h.routeId]?.[String(h.directionId)] ?? [];
    const destinationIndex = alightId ? sequence.indexOf(alightId) : -1;

    if (!origin || !destination || destinationIndex < 0) {
      note(`incomplete journey: origin=${!!origin} dest=${!!destination} idx=${destinationIndex}`);
      send({ type: "failed", fault: "route_data_missing" });
      return;
    }

    send({ type: "destination_requested" });
    send({ type: "destination_confirmed", destination });
    send({
      type: "route_chosen",
      origin,
      busDueAt: null,
      busDueSource: null,
      route: {
        routeId: h.routeId,
        directionId: h.directionId,
        displayName: h.routeDisplayName,
        headsign: h.headsign,
        boardingIndex: h.boardingIndex,
        destinationIndex,
      },
    });
    // Reached from the wait screen, which located the rider at this stop, so
    // there is no walking leg to invent.
    /**
     * WHERE THE RIDER ACTUALLY IS, not where it would be convenient to assume.
     *
     * This was hard-coded to zero, with a comment claiming the wait screen had
     * located the rider at this stop. It had not. The planner searches every
     * platform within 400 m and picks whichever one reaches the destination —
     * which for a named stop with two platforms (351 such pairs in the shipped
     * data, median 82 m apart) is routinely the one across the way.
     *
     * So the journey went straight to `waiting_for_bus` and began a countdown
     * for a kerb the rider had not reached, while they stood on the opposite
     * platform waiting for a bus that would never stop there. That is the chaos.
     *
     * With the real distance the machine picks `walking_to_stop` on its own
     * whenever the platform is more than AT_STOP_M away, and the walk announces
     * the platform by name — the side word included.
     */
    send({ type: "guidance_started", distanceToStopM: h.boardingDistanceM ?? null });
  }, [note, routeStops, send, stopsById]);

  const start = useCallback(async () => {
    await j.startAudio();
    seed();
  }, [j, seed]);

  /**
   * Arrival times for the boarding platform, refreshed while the rider waits.
   *
   * A countdown from one fetch decays: past `isStale` it correctly refuses to be
   * spoken from, and the rider standing at the stop would simply stop being told
   * anything.
   *
   * THE EVIDENCE TRAVELS WITH THE NUMBER. `Arrival.source` is the only input to
   * that decision and `evidenceFor` is the only place it is made — a time that
   * reached the journey without its provenance would be a number nothing could
   * choose a register for.
   */
  useEffect(() => {
    const stopId = journey.origin?.id;
    const routeId = journey.route?.routeId;
    if (!stopId || !routeId) return;

    let cancelled = false;
    const load = () => {
      fetch(`/api/transit/next?stopId=${encodeURIComponent(stopId)}`)
        .then((r) => r.json())
        .then((body: NextArrivalsResponse) => {
          if (cancelled) return;
          if (isStale(body.generatedAt, Date.now())) return;
          const next = body.arrivals.find((a) => a.routeId === routeId);
          if (!next) return;
          setArrival(next);
          send({
            type: "estimate_updated",
            busDueAt: next.arrivesAt,
            busDueSource: next.arrivesAt === null ? null : evidenceFor(next.source),
          });
        })
        .catch(() => {
          if (cancelled) return;
          note("arrivals fetch failed");
        });
    };

    load();
    const timer = setInterval(load, ARRIVALS_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [journey.origin?.id, journey.route?.routeId, note, send]);

  const arrivalRef = useRef<Arrival | null>(null);
  useEffect(() => { arrivalRef.current = arrival; }, [arrival]);
  const journeyRef = useRef(journey);
  useEffect(() => { journeyRef.current = journey; }, [journey]);

  /**
   * The only thing that decides a bus is due, or overdue.
   *
   * Both defer to `countdownFor` rather than comparing timestamps here, so there
   * is one definition of `due` and `gone` in the app instead of two that drift.
   *
   * `gone` DOES NOT MEAN THE BUS LEFT. It means a printed time has passed. The
   * app cannot distinguish "it came and you missed it" from "it is running late"
   * from "you are already on it and have not said" — so it asks, with wording
   * that claims only what it knows. The decision lives in a timer callback
   * rather than an effect body because it is a subscription to a clock, not
   * derived state.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const current = journeyRef.current;
      const next = arrivalRef.current;
      if (!next) return;

      const countdown = countdownFor(next, Date.now());

      if (current.state === "waiting_for_bus" && countdown.kind === "due") {
        send({ type: "bus_due" });
        return;
      }
      if (
        (current.state === "waiting_for_bus" || current.state === "bus_due") &&
        countdown.kind === "gone"
      ) {
        send({ type: "boarding_question_raised", reason: "expired" });
      }
    }, DUE_CHECK_MS);
    return () => clearInterval(timer);
  }, [send]);

  /**
   * The walk to the boarding platform.
   *
   * Only while walking — a geolocation watch running through the whole wait
   * would cost battery for a position nothing reads. `walk_progress` crosses to
   * `waiting_for_bus` on its own at AT_STOP_M, and the rider can always say so
   * first with the primary action above.
   *
   * A failing watch is not a fault here. The manual override covers it, and
   * raising a GPS error while someone is successfully walking to a stop would
   * be alarming about nothing.
   */
  useEffect(() => {
    if (journey.state !== "walking_to_stop") return;
    const target = journey.origin;
    if (!target || typeof navigator === "undefined" || !navigator.geolocation) return;

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const fix = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          at: Date.now(),
        };
        send({ type: "location_updated", fix });
        send({ type: "walk_progress", distanceToStopM: Math.round(haversine(fix, target)) });
      },
      (err) => note(`walk watch: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [journey.origin, journey.state, note, send]);

  /** Once due, ask — and let the pacer keep asking until it is answered. */
  useEffect(() => {
    if (journey.state !== "bus_due") return;
    const timer = setTimeout(() => send({ type: "boarding_question_raised", reason: "due" }), 1_500);
    return () => clearTimeout(timer);
  }, [journey.state, send]);

  const act = useCallback((id: string) => {
    switch (id) {
      case "boarded":
        // The one transition the whole screen exists to gate.
        send({ type: "boarding_answered", answer: "boarded" });
        router.push("/bus/ride");
        return;
      case "not_boarded":
        send({ type: "boarding_answered", answer: "not_boarded" });
        return;
      case "unsure":
        // Resolved toward safety by the machine: back to waiting, nothing
        // counted, and no countdown started on an answer the rider did not give.
        send({ type: "boarding_answered", answer: "unsure" });
        return;
      case "at_stop":
        /**
         * The manual override, and it is not a convenience.
         *
         * GPS in the downtown canyon drifts further than the distance between
         * two platforms, so a rider standing at the right kerb can be told to
         * keep walking with no way to correct it. Unlike a sighted user they
         * cannot look up and see they have arrived.
         */
        send({ type: "reached_stop" });
        return;
      case "find_other":
      case "stop_guidance":
        router.push("/bus/wait");
        return;
      default:
        note(`unhandled action ${id}`);
    }
  }, [note, router, send]);

  return (
    <JourneySurface
      journey={journey}
      view={j.view}
      assistant={j.assistant}
      missingClips={j.missingClips}
      log={j.log}
      onAsk={j.ask}
      onRepeat={j.repeat}
      onAnnounceOption={(keys, label) => j.speak({
        keys, priority: "normal", expiresAt: Date.now() + 10_000, label: `option ${label}`,
      })}
      onAction={act}
      onBack={() => router.push("/bus/wait")}
      onStart={start}
      extraDebug={arrival ? `arrival source ${arrival.source} · estimate ${arrival.isEstimate}` : "no arrival yet"}
    />
  );
}
