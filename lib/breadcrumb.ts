/**
 * A crash breadcrumb that survives the page dying.
 *
 * When iOS Safari runs a tab out of memory it does not throw, does not log, and
 * does not fire an error event — it kills the renderer and reloads the page. On
 * a phone there is no console to inspect afterwards, so the failure is
 * completely invisible: the app simply "reloads and never works".
 *
 * So the current stage is written to localStorage as it advances, and read back
 * on the next load. A run that reached `done` clears its own breadcrumb; a run
 * that died leaves the last stage it got to sitting there, which is a direct
 * answer to "where did it die" without a debugger attached.
 *
 * localStorage, not sessionStorage: a renderer kill can start a fresh session.
 */
const KEY = "va:stage";

/** Stages in the order they are reached. The last one written is where it died. */
export type Stage =
  | "mount"
  | "audio-context"
  | "phrases-decoded"
  | "camera-open"
  | "worker-spawned"
  | "model-downloading"
  | "model-session"
  | "model-ready"
  | "first-detection"
  | "done";

/**
 * Stages after which a reload is a crash rather than a normal restart. Reaching
 * `done` (or never starting) is not interesting; dying while pulling 37 MB of
 * model into memory very much is.
 */
const BENIGN: ReadonlySet<string> = new Set<Stage>(["done"]);

export function mark(stage: Stage, detail?: string) {
  try {
    localStorage.setItem(KEY, detail ? `${stage} (${detail})` : stage);
  } catch {
    // Private mode. Diagnostics are not worth failing a warning app over.
  }
}

/** Call once the app is up and stable; a clean run should leave nothing behind. */
export function clearMark() {
  mark("done");
}

/**
 * The stage the PREVIOUS run died at, or null if the last run ended cleanly or
 * there was no last run. Reads once and immediately overwrites, so a stale
 * breadcrumb cannot be reported twice.
 */
export function takeCrashStage(): string | null {
  try {
    const previous = localStorage.getItem(KEY);
    if (!previous || BENIGN.has(previous.split(" ")[0])) return null;
    return previous;
  } catch {
    return null;
  }
}
