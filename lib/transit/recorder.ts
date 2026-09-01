/**
 * Recording a real journey, so that one stops being a thing we cannot test.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Every threshold in lib/countdown/ was chosen against `gps-sim.ts` traces with
 * zero-mean 25 m noise, and real Ulaanbaatar GPS is neither. `geometry.ts`
 * records the reason the whole projection design exists: drift in the canyon
 * around Sükhbaatar Square exceeds a block, and it is a systematic pull toward
 * the reflecting facade rather than noise that averages out. NOTES.md is
 * explicit that `WRONG_DIRECTION_SPACINGS` cannot be retuned until a recorded
 * trace exists. This is how one comes to exist.
 *
 * ── IT OBSERVES, IT DOES NOT PARTICIPATE ───────────────────────────────────
 *
 * Nothing here returns a value any caller branches on, nothing here awaits, and
 * nothing here throws — every entry point swallows its own failures. A recorder
 * that can delay an announcement would corrupt the very measurements it exists
 * to take, and worse, could cost a rider their stop for the sake of a
 * diagnostic. If storage is full, recording degrades and the journey does not.
 *
 * ── THE TRACE IS THE POINT ─────────────────────────────────────────────────
 *
 * `trace` is written in `gps-sim.ts`'s own fix shape, so a recording replays
 * through `scripts/simulate-journey.ts --trace` and becomes a permanent
 * fixture. Everything else in the file is diagnostics wrapped around it.
 */

/** Exactly what `generateTrace` emits, so the two are interchangeable. */
export type RecordedFix = {
  lat: number;
  lon: number;
  /** Metres. Named `accuracy` to match gps-sim; the engine's Fix says accuracyM. */
  accuracy: number;
  timestamp: number;
};

export type RecordedEvent =
  /** Engine state transition — advanced, at-stop, confidence, wrong-direction, … */
  | { t: number; kind: "engine"; type: string; detail?: string }
  /** Something was said. `clips` is what the queue actually played, not what was asked for. */
  | { t: number; kind: "say"; remaining: number | null; keys: string[]; clips?: string[]; label: string }
  | { t: number; kind: "earcon"; id: string }
  | { t: number; kind: "haptic"; pattern: number[] }
  /** A clip the player did not have. The gap between asked-for and played. */
  | { t: number; kind: "missing"; keys: string[] }
  /**
   * Page and screen lifecycle: mount, unmount, visibility, pagehide, pageshow,
   * wake-lock acquire and release. Logged so a remount is LEGIBLE afterwards
   * rather than inferred from a hole in the trace.
   */
  | { t: number; kind: "lifecycle"; event: string; detail?: string }
  /**
   * Proof the page was alive, independent of whether fixes were arriving.
   *
   * THIS IS WHAT SEPARATES THE TWO STALLS. A gap in the trace alone is
   * ambiguous: geolocation may have stopped delivering, or the whole page may
   * have been frozen, and those have completely different fixes. With a
   * heartbeat running on its own timer the two become distinguishable —
   *
   *   heartbeats continue, fix count frozen  →  geolocation stalled
   *   heartbeats stop too                    →  the page was suspended
   *
   * `lastFixAt` carried on each beat also gives staleness at every moment,
   * without logging an event per fix and tripling the file.
   */
  | { t: number; kind: "heartbeat"; fixes: number; lastFixAt: number | null; visible: boolean }
  | { t: number; kind: "note"; text: string };

export type BatterySample = { t: number; level: number; charging: boolean };

export type Recording = {
  version: 1;
  startedAt: number;
  device: string;
  route: {
    routeId: string;
    directionId: number;
    boardingIndex: number;
    destinationIndex: number | null;
  } | null;
  /** gps-sim.ts format. Replays with no conversion. */
  trace: RecordedFix[];
  events: RecordedEvent[];
  battery: BatterySample[];
};

export const STORAGE_KEY = "va:recording";

/**
 * Session flag that arms recording. Lives here so BOTH bus screens share it.
 *
 * It has to be armable from the wait screen, not just the ride screen. A
 * journey only reaches /bus/ride through `router.push("/bus/ride")`, which
 * carries no query string — so `?record=1` on the ride URL is either lost at
 * navigation or arrives on a screen with no handoff, which refuses to start.
 * There was no path that had both a handoff and an armed recorder.
 */
export const RECORDING_FLAG = "va:record-journey";

/**
 * Arm from `?record=1`, once, and report whether the field-test UI should show.
 *
 * Called from a first gesture rather than a mount effect: sessionStorage does
 * not exist during SSR, and reading it in an effect renders once without it and
 * again with it — the second render landing while the user may already be
 * swiping.
 */
export function armRecordingFromUrl(
  search: string,
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void },
): { show: boolean; armed: boolean } {
  try {
    const wanted = new URLSearchParams(search).get("record") === "1";
    const already = storage.getItem(RECORDING_FLAG) !== null;
    if (wanted && !already) storage.setItem(RECORDING_FLAG, "1");
    if (!wanted && !already) return { show: false, armed: false };
    return { show: true, armed: storage.getItem(RECORDING_FLAG) === "1" };
  } catch {
    return { show: false, armed: false };
  }
}

/**
 * How often the buffer reaches storage.
 *
 * NOT every fix. A `localStorage.setItem` of a growing JSON string is a
 * synchronous serialise-and-write on the main thread, and at 1 Hz over an hour
 * that is 3600 writes of an ever-larger string — which would eventually be felt
 * as jank in the audio path, i.e. the recorder changing behaviour. Batching
 * bounds the cost; the exposure is at most this many seconds of trace if the
 * tab dies, against a journey measured in tens of minutes.
 */
export const FLUSH_INTERVAL_MS = 10_000;

/**
 * Hard cap on retained fixes — roughly two hours at 1 Hz.
 *
 * A recording that grows until `setItem` throws would lose the WHOLE journey at
 * the moment it got interesting. Dropping the oldest fixes instead keeps the
 * recent, relevant end of a long ride, and the cap is logged so a truncated
 * trace is never mistaken for a complete one.
 */
export const MAX_FIXES = 7_200;
export const MAX_EVENTS = 20_000;

export interface RecorderStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type Recorder = {
  readonly active: boolean;
  fix(f: RecordedFix): void;
  engine(type: string, detail?: string): void;
  say(remaining: number | null, keys: string[], label: string): void;
  clips(keys: string[]): void;
  earcon(id: string): void;
  haptic(pattern: number[]): void;
  missing(keys: string[]): void;
  lifecycle(event: string, detail?: string): void;
  heartbeat(visible: boolean): void;
  note(text: string): void;
  battery(level: number, charging: boolean): void;
  setRoute(route: Recording["route"]): void;
  /** Force a write. Called on visibilitychange and teardown. */
  flush(): void;
  snapshot(): Recording;
  stop(): Recording;
};

/**
 * A recorder that does nothing, returned when recording is off.
 *
 * An object rather than a null check at every call site: a screen peppered with
 * `if (recorder)` is a screen where one forgotten check writes to storage during
 * a normal journey.
 */
export function nullRecorder(): Recorder {
  const empty: Recording = {
    version: 1, startedAt: 0, device: "", route: null, trace: [], events: [], battery: [],
  };
  return {
    active: false,
    fix() {}, engine() {}, say() {}, clips() {}, earcon() {}, haptic() {},
    missing() {}, lifecycle() {}, heartbeat() {}, note() {}, battery() {}, setRoute() {}, flush() {},
    snapshot: () => empty, stop: () => empty,
  };
}

/**
 * The recording to CONTINUE, if the stored one belongs to this same journey.
 *
 * Without this, a remount mid-ride is not a truncation — it is a total loss.
 * `createRecorder` starts with an empty trace, and its first flush overwrites
 * the stored recording with that empty one. Forty minutes of a locked phone,
 * a backgrounded PWA, or one memory reclaim, and the file that comes off the
 * device is the last few seconds with nothing to say it was ever longer.
 *
 * Matched on route AND direction: appending a return leg to an outbound trace
 * would produce a fixture whose fixes walk backwards through the chain halfway
 * through, which is indistinguishable from the wrong-direction case the trace
 * exists to help tune.
 */
export function loadResumable(
  storage: RecorderStorage,
  routeId: string,
  directionId: number,
): Recording | null {
  const prior = loadRecording(storage);
  if (!prior || !prior.route) return null;
  if (prior.route.routeId !== routeId || prior.route.directionId !== directionId) return null;
  return prior;
}

export function createRecorder(
  storage: RecorderStorage,
  options: { now?: () => number; device?: string; resume?: Recording | null } = {},
): Recorder {
  const now = options.now ?? (() => Date.now());
  const prior = options.resume && options.resume.version === 1 ? options.resume : null;
  const data: Recording = prior ?? {
    version: 1,
    startedAt: now(),
    device: options.device ?? "",
    route: null,
    trace: [],
    events: [],
    battery: [],
  };
  if (prior) {
    /**
     * Mark the seam. A resumed trace has a gap in it wherever the screen was
     * gone, and a gap that is not labelled reads as a GPS dropout — which would
     * be attributed to the device rather than to the remount, and could move a
     * threshold in the wrong direction.
     */
    data.events.push({
      t: now(),
      kind: "note",
      text: `RESUMED after remount — ${data.trace.length} fixes already recorded`,
    });
  }

  let lastFlush = now();
  let truncated = false;

  /** Every write is best-effort. A full quota must not end the journey. */
  const write = () => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(data));
      lastFlush = now();
    } catch {
      /**
       * Out of quota, or private mode. Drop the oldest half and try once more —
       * a recording of the last twenty minutes is worth much more than nothing,
       * and this is the moment the trace would otherwise be lost entirely.
       */
      if (!truncated) {
        truncated = true;
        data.trace.splice(0, Math.floor(data.trace.length / 2));
        data.events.splice(0, Math.floor(data.events.length / 2));
        data.events.push({ t: now(), kind: "note", text: "TRUNCATED: storage full, oldest half dropped" });
        try { storage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* give up quietly */ }
      }
    }
  };

  const maybeFlush = () => {
    if (now() - lastFlush >= FLUSH_INTERVAL_MS) write();
  };

  const push = (e: RecordedEvent) => {
    data.events.push(e);
    if (data.events.length > MAX_EVENTS) data.events.splice(0, data.events.length - MAX_EVENTS);
    maybeFlush();
  };

  return {
    active: true,

    fix(f) {
      data.trace.push(f);
      if (data.trace.length > MAX_FIXES) data.trace.splice(0, data.trace.length - MAX_FIXES);
      maybeFlush();
    },

    engine(type, detail) { push({ t: now(), kind: "engine", type, detail }); },
    say(remaining, keys, label) { push({ t: now(), kind: "say", remaining, keys, label }); },

    /**
     * What the queue actually PLAYED, attached to the last thing said.
     *
     * Asked-for and played diverge whenever a clip is missing, and that
     * divergence is one of the things a real journey is being recorded to
     * measure — 153 of 923 stop names are rendered, so it will happen.
     */
    clips(keys) {
      for (let i = data.events.length - 1; i >= 0; i--) {
        const e = data.events[i];
        if (e.kind === "say") { e.clips = keys; return; }
      }
    },

    earcon(id) { push({ t: now(), kind: "earcon", id }); },

    lifecycle(event, detail) {
      push({ t: now(), kind: "lifecycle", event, detail });
      // Lifecycle events are exactly the moments the page may not come back,
      // so they are written immediately rather than waiting for the interval.
      write();
    },

    heartbeat(visible) {
      const last = data.trace.length ? data.trace[data.trace.length - 1].timestamp : null;
      push({ t: now(), kind: "heartbeat", fixes: data.trace.length, lastFixAt: last, visible });
    },
    haptic(pattern) { push({ t: now(), kind: "haptic", pattern }); },
    missing(keys) { push({ t: now(), kind: "missing", keys }); },
    note(text) { push({ t: now(), kind: "note", text }); },
    battery(level, charging) { data.battery.push({ t: now(), level, charging }); maybeFlush(); },
    setRoute(route) { data.route = route; write(); },

    flush() { write(); },
    snapshot: () => data,
    stop() { write(); return data; },
  };
}

/** Read back whatever survived, for the share/download path after a reload. */
export function loadRecording(storage: RecorderStorage): Recording | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Recording;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function clearRecording(storage: RecorderStorage): void {
  try { storage.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
}

/** A stable, sortable filename — several traces will be collected in a day. */
export function recordingFilename(r: Recording): string {
  const d = new Date(r.startedAt);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const route = r.route ? `${r.route.routeId}-dir${r.route.directionId}` : "unknown";
  return `va-trace-${stamp}-${route}.json`;
}

/**
 * Summary for the debug panel and the report.
 *
 * Exists so a tester can tell a good recording from a useless one BEFORE
 * leaving the bus, which is the only time it can be redone.
 */
export function describeRecording(r: Recording): string {
  const mins = r.trace.length
    ? ((r.trace[r.trace.length - 1].timestamp - r.trace[0].timestamp) / 60_000).toFixed(1)
    : "0";
  const acc = r.trace.length
    ? (r.trace.reduce((s, f) => s + f.accuracy, 0) / r.trace.length).toFixed(0)
    : "–";
  const said = r.events.filter((e) => e.kind === "say").length;
  const missing = r.events.filter((e) => e.kind === "missing").length;
  const wrongDir = r.events.filter((e) => e.kind === "engine" && e.type === "wrong-direction").length;
  const rejected = r.events.filter((e) => e.kind === "engine" && e.type === "rejected").length;
  const batt = r.battery.length
    ? `${Math.round(r.battery[0].level * 100)}→${Math.round(r.battery[r.battery.length - 1].level * 100)}%`
    : "–";
  return [
    `${r.trace.length} fixes / ${mins} min`,
    `mean acc ${acc} m`,
    `${said} spoken`,
    `${missing} missing-clip`,
    `${wrongDir} wrong-dir`,
    `${rejected} rejected`,
    `battery ${batt}`,
  ].join(" · ");
}
