/**
 * Where along a route a position is — as a SCALAR, not as a nearest stop.
 *
 * ── WHY NOT NEAREST-STOP ───────────────────────────────────────────────────
 *
 * Nearest-stop lookup answers "which stop is closest", and that is a different
 * question from "how far along the route are we". The two diverge exactly where
 * it matters: in the downtown canyon around Sükhbaatar Square, GPS drift can
 * exceed a block, and a fix that lands nearer a stop on the return leg of the
 * same variant reads as the bus having gone backwards. A scalar
 * distance-along-route has no such failure — a drifted fix moves the scalar by
 * the drift, not to a different part of the route.
 *
 * It also gives the monotonic constraint somewhere to live. "Index may not
 * decrease" is unenforceable against a nearest-stop lookup that can legitimately
 * return anything; against a scalar it is one comparison.
 *
 * ── THE GEOMETRY WE ACTUALLY HAVE ──────────────────────────────────────────
 *
 * None. `public/transit/` ships stops, routes, and a stop sequence per variant;
 * there are no shapes and the Hamuga shape endpoint is unverified. So
 * `StopChainGeometry` synthesizes the polyline by joining a variant's ordered
 * stop coordinates — chords across the road's actual arc.
 *
 * That approximation is HONEST ABOUT ONE THING AND WRONG ABOUT ANOTHER, and the
 * distinction decides what may be built on it:
 *
 *   ALONG-ROUTE distance stays good. A chord is shorter than the arc it spans,
 *   so the scalar runs slightly short between stops and re-syncs at every stop —
 *   where the chord and the route touch by construction. The 40 m advance
 *   threshold and the 2-fix confirmation are measured along this axis and are
 *   unaffected.
 *
 *   PERPENDICULAR distance is not usable. On a bend the chord can sit a hundred
 *   metres inside the road, so a bus tracking its lane perfectly looks
 *   "divergent" at every turn. Any wrong-bus or wrong-direction test built on
 *   perpendicular distance would fire constantly on this geometry. That is why
 *   §6.1 is topological here — decreasing index, or a nearest stop outside the
 *   route's own set — and why there is no 150 m constant anywhere in this file.
 *
 * Real shapes swap in as another `RouteGeometry`. Nothing above the interface
 * changes, and the same tests cover both.
 */

export type LatLon = { lat: number; lon: number };

export type Projection = {
  /** Metres travelled from the first stop of the variant, along the chain. */
  alongM: number;
  /**
   * Index of the last stop the projection has REACHED — the stop at or before
   * `alongM`. Never a nearest-stop answer; derived from the scalar.
   */
  stopIndex: number;
  /**
   * Metres from the fix to the chain. Reported for diagnostics ONLY.
   *
   * Deliberately not used for any decision: see the header. A chord cuts every
   * corner, so this number is as much a statement about the road's curvature as
   * about the bus.
   */
  offRouteM: number;
  /** Metres from `alongM` to the NEXT stop, so callers need no second lookup. */
  toNextStopM: number;
};

/**
 * "We think we are about here" — required on loop variants, harmless elsewhere.
 *
 * A loop passes the same ground twice, so a fix there maps to TWO points on the
 * chain and the globally nearest is a coin toss. Without a hint the second pass
 * projects onto the first, the scalar collapses backwards by most of a circuit,
 * and the engine rejects every fix as drift — a rider on the return leg simply
 * stops being counted.
 *
 * With one, the search is restricted to a window around where the last fix put
 * us, which is what makes the two passes distinguishable at all.
 */
export type ProjectionHint = {
  nearAlongM: number;
  /** Metres either side of `nearAlongM` to consider. */
  windowM: number;
};

export interface RouteGeometry {
  /** Number of stops in the variant. */
  readonly stopCount: number;
  /** Cumulative distance from the first stop to stop `i`, in metres. */
  distanceToStop(index: number): number;
  /** Project a position onto the route. */
  project(at: LatLon, hint?: ProjectionHint): Projection;
  /**
   * Mean metres between consecutive stops — the dead-reckoning rate.
   *
   * From THIS variant rather than a city-wide constant: stop spacing on a
   * suburban run is several times the downtown figure, and using the wrong one
   * is how a bus in an underpass is reckoned three stops past where it is.
   */
  readonly meanStopSpacingM: number;
}

const EARTH_M = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(s));
}

/**
 * Local metre plane, anchored at the route's own latitude.
 *
 * Projecting a point onto a segment needs a flat space. Over the few hundred
 * metres of one segment the error from treating lat/lon as planar is far below
 * GPS noise, provided the longitude scale uses the local latitude — at 47.9°N
 * a degree of longitude is 0.67 of a degree of latitude, and ignoring that
 * skews every projection eastward.
 */
type Plane = { x: number; y: number };

function planeFactory(anchorLat: number) {
  const mPerDegLat = 111_132;
  const mPerDegLon = 111_320 * Math.cos(toRad(anchorLat));
  return (p: LatLon): Plane => ({ x: p.lon * mPerDegLon, y: p.lat * mPerDegLat });
}

/**
 * Distance along segment AB at which P projects, clamped to the segment, plus
 * the perpendicular distance. Pure planar geometry.
 */
function projectOnSegment(p: Plane, a: Plane, b: Plane): { t: number; alongM: number; offM: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) {
    return { t: 0, alongM: 0, offM: Math.hypot(p.x - a.x, p.y - a.y) };
  }
  const raw = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  const t = Math.max(0, Math.min(1, raw));
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return { t, alongM: t * Math.sqrt(lenSq), offM: Math.hypot(p.x - cx, p.y - cy) };
}

/**
 * The interior of a segment, as a FRACTION rather than as metres.
 *
 * `projectOnSegment` measures in the planar approximation while the cumulative
 * table is built from haversine, and the two disagree by a fraction of a percent
 * over a segment. Adding a planar length to a haversine cumulative therefore
 * lands slightly off the next stop's own distance — which sounds like rounding
 * and is not: a fix taken standing ON stop 3 projected to a hair under stop 3's
 * distance, so the derived index came back 2, and the countdown was one stop
 * behind for the whole journey. Scaling `t` onto the haversine length is exact
 * at both endpoints by construction, so the two can never drift apart again.
 */


export type GeometryStop = { id: string; name: string; lat: number; lon: number };

/**
 * A variant's polyline, synthesized from its ordered stops.
 *
 * Built once per journey — the cumulative table makes `project` a single pass
 * over segments with no allocation, which matters because it runs on every GPS
 * fix on a cheap Android that is also decoding audio.
 */
export class StopChainGeometry implements RouteGeometry {
  private readonly points: Plane[];
  private readonly cumulative: number[];
  private readonly toPlane: (p: LatLon) => Plane;

  constructor(private readonly stops: GeometryStop[]) {
    if (stops.length === 0) throw new Error("a route variant with no stops has no geometry");
    this.toPlane = planeFactory(stops[0].lat);
    this.points = stops.map((s) => this.toPlane(s));

    this.cumulative = new Array(stops.length).fill(0);
    for (let i = 1; i < stops.length; i++) {
      this.cumulative[i] = this.cumulative[i - 1] + haversineM(stops[i - 1], stops[i]);
    }
  }

  get stopCount(): number {
    return this.stops.length;
  }

  distanceToStop(index: number): number {
    const i = Math.max(0, Math.min(this.cumulative.length - 1, index));
    return this.cumulative[i];
  }

  get meanStopSpacingM(): number {
    if (this.stops.length < 2) return 0;
    return this.cumulative[this.cumulative.length - 1] / (this.stops.length - 1);
  }

  /**
   * The nearest point on the chain, and how far along it sits.
   *
   * WITHOUT A HINT every segment is tested, so the answer depends on the fix
   * alone and the monotonic constraint stays where it belongs — visible, in the
   * engine, applied afterwards. Longest UB variant is 36 stops, so this is 35
   * segments and the sweep costs nothing.
   *
   * WITH A HINT the search is restricted to a window around it. That is not an
   * optimisation: on a loop variant the same ground carries two scalars, the
   * globally nearest is arbitrary between them, and the second pass projects
   * onto the first — collapsing the scalar backwards by most of a circuit. The
   * window is the only thing that tells the two passes apart. See ProjectionHint.
   */
  project(at: LatLon, hint?: ProjectionHint): Projection {
    const p = this.toPlane(at);

    let bestOff = Infinity;
    let bestAlong = 0;

    for (let i = 0; i < this.points.length - 1; i++) {
      // Skip segments wholly outside the window; a segment straddling it stays.
      if (hint) {
        const from = this.cumulative[i];
        const to = this.cumulative[i + 1];
        if (to < hint.nearAlongM - hint.windowM) continue;
        if (from > hint.nearAlongM + hint.windowM) continue;
      }
      const seg = projectOnSegment(p, this.points[i], this.points[i + 1]);
      if (seg.offM < bestOff) {
        bestOff = seg.offM;
        // `t`, not `seg.alongM` — see the note above projectOnSegment.
        const segmentM = this.cumulative[i + 1] - this.cumulative[i];
        bestAlong = this.cumulative[i] + seg.t * segmentM;
      }
    }

    /**
     * The hint was wrong. Sweep the whole route instead.
     *
     * Two ways it can be wrong, and both matter: the window can exclude every
     * segment (nothing found), or — far more insidiously — it can contain
     * segments that are all hopeless, in which case the search happily returns
     * the least-bad one. A bus that left the terminus and reappeared at the
     * start of the route projected 9.4 KM off its own chain and the turnaround
     * was recorded four stops from where it happened.
     *
     * The threshold sits well clear of what the chord approximation itself can
     * produce: the worst measured offset on a real urban bend is 546 m (see
     * geometry.test.ts), so anything past a kilometre is not "on the route with
     * a bad chord", it is somewhere else entirely.
     */
    const FALLBACK_OFF_ROUTE_M = 1_000;
    if (hint && this.points.length > 1 && (bestOff === Infinity || bestOff > FALLBACK_OFF_ROUTE_M)) {
      const global = this.project(at);
      if (global.offRouteM < bestOff) return global;
    }

    // Single-stop variant: no segments, so the projection is that stop.
    if (this.points.length === 1) {
      bestOff = Math.hypot(p.x - this.points[0].x, p.y - this.points[0].y);
      bestAlong = 0;
    }

    return {
      alongM: bestAlong,
      stopIndex: this.stopIndexAt(bestAlong),
      offRouteM: bestOff,
      toNextStopM: this.toNextStopM(bestAlong),
    };
  }

  /**
   * Last stop at or before `alongM`. Binary search over the cumulative table.
   *
   * The epsilon absorbs the last bit of floating-point slack: standing exactly
   * on a stop must derive that stop's index, not the one before it, and a
   * centimetre is far below anything a GPS can distinguish anyway.
   */
  private stopIndexAt(alongM: number): number {
    const EPSILON_M = 0.01;
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.cumulative[mid] <= alongM + EPSILON_M) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private toNextStopM(alongM: number): number {
    const i = this.stopIndexAt(alongM);
    if (i >= this.cumulative.length - 1) return 0;
    return this.cumulative[i + 1] - alongM;
  }
}
