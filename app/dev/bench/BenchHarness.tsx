"use client";

/**
 * On-device performance benchmark. The only thing in this repo that measures
 * the target rather than a proxy.
 *
 * WHY IT EXISTS. Everything else about this app's speed has been measured on a
 * laptop, and a laptop answers the wrong question. onnxruntime-node on an M3
 * says yolo11s costs 241ms on one core and 71ms across four; the app runs
 * onnxruntime-web on a phone, usually on WebGPU, sometimes on a wasm fallback
 * with a thread cap. Those are different numbers and the gap between them is
 * where every wrong performance decision comes from.
 *
 * So this page runs THE REAL WORKER against THE REAL CAMERA on the actual
 * device and prints what it finds on screen, because there is no console on a
 * phone. It answers four questions the app cannot answer for itself:
 *
 *   1. Which backend did onnxruntime actually pick, with how many threads, and
 *      is the page cross-origin isolated? (Without isolation, threads drop to
 *      one and everything is roughly four times slower.)
 *   2. What does one inference really cost, at p50/p90/p99?
 *   3. Does it get SLOWER over a minute? Phones throttle when they get hot, and
 *      a walk lasts longer than a benchmark. The first-vs-last quartile split is
 *      the only honest way to see it.
 *   4. How much does motion gating actually save on this device and this scene?
 *      Measured by running both ways back to back, not by arguing about it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { openCamera } from "@/lib/camera";
import { MOTION_THRESHOLD } from "@/lib/motion";
import type { WorkerResponse } from "@/lib/vision.worker";

/** Long enough for a phone to start throttling; short enough to actually run. */
const PHASE_MS = 30_000;

/** Requested capture size, matching WalkMode. */
const REQUEST_W = 640;
const REQUEST_H = 480;

type Sample = { t: number; inferenceMs: number; preprocessMs: number; skipped: boolean; motion: number };

type PhaseResult = {
  label: string;
  samples: Sample[];
  wallMs: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Summary of one phase. `duty` is the fraction of wall-clock time the CPU spent
 * inside the model, which is the number that maps most directly onto battery —
 * frame rate does not, because 5fps at 95% duty and 5fps at 40% duty look
 * identical to a user and differ by half the battery.
 */
function summarise(phase: PhaseResult) {
  const real = phase.samples.filter((s) => !s.skipped);
  const times = real.map((s) => s.inferenceMs).sort((a, b) => a - b);
  const busyMs = phase.samples.reduce((a, s) => a + s.inferenceMs, 0);

  // Thermal drift: the first quarter of the run against the last. A phone that
  // is throttling shows here and nowhere else.
  const quarter = Math.max(1, Math.floor(real.length / 4));
  const mean = (xs: Sample[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, s) => a + s.inferenceMs, 0) / xs.length;
  const first = mean(real.slice(0, quarter));
  const last = mean(real.slice(-quarter));

  return {
    frames: phase.samples.length,
    inferences: real.length,
    skipPct: phase.samples.length === 0 ? 0 : (1 - real.length / phase.samples.length) * 100,
    fps: (phase.samples.length / phase.wallMs) * 1000,
    p50: percentile(times, 0.5),
    p90: percentile(times, 0.9),
    p99: percentile(times, 0.99),
    preprocess: real.length === 0 ? 0 : real.reduce((a, s) => a + s.preprocessMs, 0) / real.length,
    duty: (busyMs / phase.wallMs) * 100,
    drift: first === 0 ? 0 : ((last - first) / first) * 100,
    motionP50: percentile(phase.samples.map((s) => s.motion).sort((a, b) => a - b), 0.5),
    motionP90: percentile(phase.samples.map((s) => s.motion).sort((a, b) => a - b), 0.9),
  };
}

export default function BenchHarness() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const samplesRef = useRef<Sample[]>([]);
  const busyRef = useRef(false);
  const readyRef = useRef(false);

  const [status, setStatus] = useState("idle");
  const [results, setResults] = useState<PhaseResult[]>([]);
  const [running, setRunning] = useState(false);

  /**
   * Everything about the device that changes how to read the numbers.
   *
   * Read in a lazy initialiser rather than an effect: none of it can change
   * while the page is open, and `navigator` does not exist during SSR. Same
   * shape as the crash-breadcrumb read in WalkMode.
   */
  const [env, setEnv] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    const nav = navigator as Navigator & { deviceMemory?: number };
    return [
      `ua: ${navigator.userAgent}`,
      `cores: ${navigator.hardwareConcurrency ?? "?"} · memory: ${nav.deviceMemory ?? "?"} GB`,
      `crossOriginIsolated: ${typeof crossOriginIsolated !== "undefined" && crossOriginIsolated}`,
      `webgpu: ${"gpu" in navigator ? "present" : "ABSENT (wasm fallback only)"}`,
      `dpr: ${window.devicePixelRatio} · screen: ${screen.width}x${screen.height}`,
    ];
  });

  const runPhase = useCallback(
    (label: string, gating: boolean): Promise<PhaseResult> =>
      new Promise((resolve) => {
        const worker = workerRef.current!;
        worker.postMessage({ type: "configure", motionGating: gating });
        samplesRef.current = [];
        setStatus(`${label}: warming up…`);

        // Discard the first second: the very first frames after a configure
        // change include shader recompiles and a cold signature buffer, and
        // averaging those in would report a cost the app never pays again.
        const warmUntil = performance.now() + 1000;
        const startAt = warmUntil;
        const endAt = warmUntil + PHASE_MS;

        const tick = () => {
          const now = performance.now();
          if (now >= endAt) {
            resolve({ label, samples: samplesRef.current, wallMs: PHASE_MS });
            return;
          }
          if (now >= startAt) {
            const left = Math.ceil((endAt - now) / 1000);
            setStatus(`${label}: ${left}s left · ${samplesRef.current.length} frames`);
          }

          const video = videoRef.current;
          if (video && video.readyState >= 2 && readyRef.current && !busyRef.current) {
            busyRef.current = true;
            createImageBitmap(video)
              .then((bitmap) => worker.postMessage({ type: "frame", bitmap }, [bitmap]))
              .catch(() => {
                busyRef.current = false;
              });
          }
          requestAnimationFrame(tick);
        };

        // NOTE: dispatched as fast as the worker allows, with no duty-cycle
        // pacing. That is deliberate — this measures what one inference COSTS,
        // which is the input to choosing a pace. WalkMode's own pacing is a
        // separate thing and would only obscure the number being sought here.
        requestAnimationFrame(tick);
      }),
    [],
  );

  const start = useCallback(async () => {
    setRunning(true);
    setResults([]);
    try {
      setStatus("opening camera…");
      const stream = await openCamera();
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      setStatus("loading model…");
      const worker = new Worker(new URL("../../../lib/vision.worker.ts", import.meta.url), {
        type: "module",
      });
      workerRef.current = worker;

      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
          const msg = ev.data;
          if (msg.type === "progress") {
            const pct = msg.total > 0 ? Math.round((msg.loaded / msg.total) * 100) : 0;
            setStatus(`downloading model ${pct}%`);
            return;
          }
          if (msg.type === "ready") {
            readyRef.current = true;
            setEnv((prev) => [
              ...prev,
              `backend: ${msg.backend} · threads: ${msg.threads} · isolated: ${msg.isolated}`,
            ]);
            resolve();
            return;
          }
          if (msg.type === "error") {
            reject(new Error(msg.message));
            return;
          }
          // Detections during a phase.
          busyRef.current = false;
          samplesRef.current.push({
            t: performance.now(),
            inferenceMs: msg.inferenceMs,
            preprocessMs: msg.preprocessMs,
            skipped: msg.skipped,
            motion: msg.motion,
          });
        };
        worker.onerror = (e) => reject(new Error(e.message));
      });

      // Gating OFF first, so the honest worst case is measured before anything
      // that flatters it. Both phases see the same scene back to back, which is
      // the only way the comparison means anything.
      const off = await runPhase("no gating", false);
      setResults([off]);
      const on = await runPhase("motion gating", true);
      setResults([off, on]);
      setStatus("done");
    } catch (e) {
      setStatus(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      workerRef.current?.terminate();
      workerRef.current = null;
      readyRef.current = false;
      for (const t of streamRef.current?.getTracks() ?? []) t.stop();
      streamRef.current = null;
      setRunning(false);
    }
  }, [runPhase]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    };
  }, []);

  const report = results.map((phase) => ({ phase, s: summarise(phase) }));

  return (
    <main className="min-h-screen bg-black text-green-400 font-mono text-sm p-4 space-y-4">
      <h1 className="text-lg text-white">Vision Access — device benchmark</h1>

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        width={REQUEST_W}
        height={REQUEST_H}
        className="w-40 border border-green-900"
      />

      <button
        onClick={start}
        disabled={running}
        className="block w-full py-4 text-lg bg-green-900 text-white rounded disabled:opacity-40"
      >
        {running ? "running…" : `Run benchmark (2 × ${PHASE_MS / 1000}s)`}
      </button>

      <p className="text-amber-300">{status}</p>

      <section>
        <h2 className="text-white">device</h2>
        {env.map((line) => (
          <p key={line} className="break-all text-xs">
            {line}
          </p>
        ))}
      </section>

      {report.map(({ phase, s }) => (
        <section key={phase.label} className="border-t border-green-900 pt-2">
          <h2 className="text-white">{phase.label}</h2>
          <p>
            inference p50 <b className="text-white">{s.p50.toFixed(0)}ms</b> · p90{" "}
            {s.p90.toFixed(0)}ms · p99 {s.p99.toFixed(0)}ms
          </p>
          <p>
            preprocess {s.preprocess.toFixed(0)}ms · {s.inferences} inferences /{" "}
            {s.frames} frames
          </p>
          <p>
            achieved {s.fps.toFixed(1)} fps · skipped{" "}
            <b className="text-white">{s.skipPct.toFixed(0)}%</b>
          </p>
          <p>
            duty cycle <b className="text-white">{s.duty.toFixed(0)}%</b> — the battery number
          </p>
          <p className={s.drift > 20 ? "text-red-400" : ""}>
            thermal drift {s.drift > 0 ? "+" : ""}
            {s.drift.toFixed(0)}% (last quarter vs first)
            {s.drift > 20 && " — THROTTLING"}
          </p>
          <p className="text-xs text-green-600">
            motion p50 {s.motionP50.toFixed(4)} · p90 {s.motionP90.toFixed(4)} (threshold{" "}
            {MOTION_THRESHOLD})
          </p>
        </section>
      ))}

      {report.length === 2 && (
        <section className="border-t border-green-900 pt-2">
          <h2 className="text-white">verdict</h2>
          <p>
            budget 60ms · measured{" "}
            <b className={report[0].s.p50 > 60 ? "text-red-400" : "text-white"}>
              {report[0].s.p50.toFixed(0)}ms
            </b>{" "}
            ({(report[0].s.p50 / 60).toFixed(1)}× budget)
          </p>
          <p>
            gating cut duty cycle {report[0].s.duty.toFixed(0)}% →{" "}
            <b className="text-white">{report[1].s.duty.toFixed(0)}%</b>
          </p>
          <p className="text-xs text-green-600">
            Hold the phone still for the second phase to see the best case, and walk
            with it to see the worst. Both are real; the truth is in between.
          </p>
        </section>
      )}
    </main>
  );
}
