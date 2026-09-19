"use client";

/**
 * Ask the Room.
 *
 * Hold anywhere, ask a question, let go. The detector answers offline if it can;
 * only what it cannot answer leaves the phone.
 *
 * ── WHY THIS IS NOT WALK MODE WITH A MICROPHONE ────────────────────────────
 *
 * Walk mode is a reflex loop: continuous, on-device, sub-60 ms, and its whole
 * job is to interrupt you about a car. This is a question loop: on demand,
 * latency-tolerant, and sometimes several seconds because a model is thinking.
 *
 * Merging them would put a network round trip in the path of an obstacle
 * warning, so they are separate modes with separate camera sessions. Nothing in
 * here is allowed to be the thing that warns anyone about anything.
 *
 * ── THE TWO iOS HAZARDS, BOTH ALREADY SOLVED ELSEWHERE ─────────────────────
 *
 * docs/voice-input.md records how this path failed for months, and both fixes
 * are reused rather than re-derived:
 *
 *   1. The audio session must be `play-and-record` while capturing, or the
 *      microphone cannot open at all on iOS. `beginCaptureSession` /
 *      `endCaptureSession` are refcounted around the capture.
 *   2. WebKit shows the permission dialog only while a real user activation is
 *      live. `warmMicrophone()` therefore runs in the touch handler via
 *      `onHoldPrewarm`, and the recogniser claims the already-open stream later.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CurrentOption, GestureSurface, type A11yOption } from "@/components/GestureSurface";
import type { AskAnswer, Candidate } from "@/lib/ask/answer";
import { emptyContext, onCameraMoved, remember, type AskContext } from "@/lib/ask/context";
import { createOcrProvider, selectLines } from "@/lib/ask/ocr";
import { route, type Availability } from "@/lib/ask/router";
import { probeVision } from "@/lib/ask/vision";
import { audioContext, beginCaptureSession, endCaptureSession, hasClip, loadAllClips, playListenCue, playSequence, stopAll } from "@/lib/audio";
import {
  DEFAULT_PITCH_DEG, estimateObjectDistance, type CameraPose,
} from "@/lib/distance";
import { discardWarmMicrophone, warmMicrophone } from "@/lib/speech/mic";
import { ASK } from "@/lib/ui/announcements";
import { listenOnceAnyEngine } from "@/lib/ui/listen-any";
import { vibrate } from "@/lib/ui/gesture-nav";
import { useGestureNav } from "@/lib/ui/useGestureNav";
import type { ListOption } from "@/lib/ui/gesture-nav";
import type { Detection, WorkerResponse } from "@/lib/vision.worker";
import { pinPlan, pinnedPlan, planFor } from "@/lib/vision-plan";
import { takeCrashStage } from "@/lib/breadcrumb";
import { pitchFromBeta, requestTiltPermission } from "@/lib/tilt";

/** Matching Walk mode, so the two modes see the same picture. */
const REQUEST_W = 640;
const REQUEST_H = 480;
const CAMERA_HEIGHT_M = 1.4;

/**
 * How often a frame is sent for detection.
 *
 * Far slower than Walk mode's continuous loop. Nothing here is time-critical —
 * the answer is to a question already asked — and a phone held up in a room does
 * not need sixty inferences a second to find a door.
 */
const FRAME_INTERVAL_MS = 400;

type Phase = "idle" | "listening" | "thinking" | "answered";

export default function AskMode() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const busyRef = useRef(false);
  const startedRef = useRef(false);

  const ocrRef = useRef<ReturnType<typeof createOcrProvider> | null>(null);

  /**
   * Camera pose, as state.
   *
   * PITCH IS THROTTLED TO ONE DEGREE. The sensor fires many times a second and
   * a render per event would be absurd, but a degree is far finer than the
   * distance model's own ±0.185 relative error — so rounding costs nothing real
   * and keeps the whole answer path free of mutable values React cannot see.
   */
  const [pitchDeg, setPitchDeg] = useState(DEFAULT_PITCH_DEG);
  const [frameSize, setFrameSize] = useState({ w: REQUEST_W, h: REQUEST_H });

  /**
   * The latest frame, as STATE rather than a ref.
   *
   * Walk mode keeps this in a ref because it runs a 60 fps loop that must not be
   * torn down on every frame. This mode looks 2.5 times a second at a phone held
   * still in front of something, so a render per frame costs nothing — and state
   * keeps the answer path free of ref reads, which is what lets the question
   * handler be called from a screen-reader activation without reaching into
   * mutable values React cannot see.
   */
  const [detections, setDetections] = useState<Detection[]>([]);
  const [luma, setLuma] = useState<number | undefined>(undefined);
  /** Changes once per question. State, for the same reason. */
  const [context, setContext] = useState<AskContext>(emptyContext);

  const [phase, setPhase] = useState<Phase>("idle");
  const [modelReady, setModelReady] = useState(false);
  const [answerText, setAnswerText] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [availability, setAvailability] = useState<Availability>({
    online: true, ocr: false, vlm: false,
  });

  const note = useCallback((line: string) => {
    setLog((l) => [...l.slice(-40), `${new Date().toLocaleTimeString()} ${line}`]);
  }, []);

  const pose = useCallback((): CameraPose => ({
    frameWidth: frameSize.w,
    frameHeight: frameSize.h,
    pitchDeg,
    cameraHeightM: CAMERA_HEIGHT_M,
  }), [frameSize, pitchDeg]);

  /**
   * The detector's boxes turned into what the answer layer consumes.
   *
   * Distance is computed HERE, once per question, rather than per frame: at one
   * question every several seconds there is nothing to gain from doing it sixty
   * times a second, and `estimateObjectDistance` is the same call Walk mode uses.
   */
  const candidates = useCallback((): Candidate[] => {
    const p = pose();
    return detections.map((d) => ({
      className: d.className,
      box: { x: d.x, y: d.y, w: d.w, h: d.h },
      score: d.score,
      distance: estimateObjectDistance({ x: d.x, y: d.y, w: d.w, h: d.h }, d.className, p),
    }));
  }, [detections, pose]);

  const speak = useCallback((a: AskAnswer) => {
    setAnswerText(a.text);
    // The queue is not used here: this mode never produces a safety-critical
    // utterance, so there is nothing for a priority queue to arbitrate. One
    // answer at a time, and a new question interrupts the last one.
    const playable = a.keys.filter(hasClip);
    if (playable.length) playSequence(playable, { interrupt: true });
    else note(`no clips for: ${a.text}`);
  }, [note]);

  // ------------------------------------------------------------- camera

  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;

    audioContext();
    void loadAllClips();

    if (await requestTiltPermission()) {
      window.addEventListener("deviceorientation", (ev: DeviceOrientationEvent) => {
        const pitch = pitchFromBeta(ev.beta);
        if (pitch === null) return;
        const rounded = Math.round(pitch);
        setPitchDeg((p) => (p === rounded ? p : rounded));
      });
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: REQUEST_W, height: REQUEST_H },
        audio: false,
      });
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
        setFrameSize({ w: video.videoWidth || REQUEST_W, h: video.videoHeight || REQUEST_H });
      }
    } catch (e) {
      note(`camera: ${e instanceof Error ? e.message : e}`);
      speak({ keys: [ASK.cameraBlocked.clip!], text: ASK.cameraBlocked.mn, tier: "none", target: null, decline: true });
      return;
    }

    ocrRef.current = createOcrProvider();
    const vlm = await probeVision();
    setAvailability({ online: navigator.onLine, ocr: true, vlm });
    note(`tiers: on-device yes · ocr yes · vlm ${vlm ? "yes" : "no"}`);
  }, [note, speak]);

  /** The detector, on the same plan machinery Walk mode uses. */
  useEffect(() => {
    const worker = new Worker(new URL("../../lib/vision.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    const crashStage = typeof window === "undefined" ? null : takeCrashStage();
    const plan = planFor({ pinned: pinnedPlan(), crashStage });
    if (plan.id !== "full") pinPlan(plan.id);
    worker.postMessage({ type: "start", plan });

    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === "ready") { setModelReady(true); note(`model ready · ${msg.backend}`); return; }
      if (msg.type === "error") { note(msg.message); return; }
      if (msg.type === "detections") {
        busyRef.current = false;
        setDetections(msg.boxes);
        setLuma(msg.luma);
      }
    };

    return () => { worker.terminate(); workerRef.current = null; };
  }, [note]);

  /** Frames, slowly. See FRAME_INTERVAL_MS. */
  useEffect(() => {
    if (!modelReady) return;
    const timer = setInterval(() => {
      const video = videoRef.current;
      const worker = workerRef.current;
      if (!video || !worker || busyRef.current || video.readyState < 2) return;
      busyRef.current = true;
      createImageBitmap(video)
        .then((bitmap) => worker.postMessage({ type: "frame", bitmap }, [bitmap]))
        .catch(() => { busyRef.current = false; });
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [modelReady]);

  // ------------------------------------------------------------- asking

  /**
   * Read a sign.
   *
   * CROPS TO THE DETECTED BOX FIRST. The detector finds `sign` at high
   * confidence, and OCR on a cropped sign is a completely different problem from
   * OCR on a street photograph — one block of large text at a known scale. The
   * uncropped path exists only for "read this", where the user has pointed the
   * camera deliberately and no sign box was found.
   */
  const runOcr = useCallback(async (readEverything: boolean) => {
    const ocr = ocrRef.current;
    const video = videoRef.current;
    if (!ocr || !video) return;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = frameSize.w;
      canvas.height = frameSize.h;
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
      if (!blob) throw new Error("could not capture a frame");

      const sign = detections
        .filter((d) => d.className === "sign")
        .sort((a, b) => b.score - a.score)[0];

      const lines = await ocr.read(
        { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height },
        sign ? { x: sign.x, y: sign.y, w: sign.w, h: sign.h } : undefined,
      );

      const chosen = selectLines(lines, readEverything ? "full" : "summary");
      if (chosen.length === 0) {
        speak({ keys: [ASK.notFound.clip!], text: ASK.notFound.mn, tier: "ocr", target: null, decline: true });
      } else {
        /**
         * OCR TEXT CANNOT BE SPOKEN. Every voice in this app is a pre-rendered
         * clip and arbitrary text has none, so the sign's words reach the screen
         * and the screen reader but not the speaker. Saying nothing at all would
         * be worse — the earcon marks that something was read.
         */
        setAnswerText(chosen.map((l) => l.text).join(" · "));
        note(`OCR (${sign ? "cropped to sign" : "full frame"}): ${chosen.length} line(s)`);
        vibrate([60]);
      }
    } catch (e) {
      note(`ocr failed: ${e instanceof Error ? e.message : e}`);
      speak({ keys: [ASK.notFound.clip!], text: ASK.notFound.mn, tier: "ocr", target: null, decline: true });
    }
    setPhase("answered");
  }, [detections, frameSize, note, speak]);

  /**
   * One question, end to end.
   *
   * The router decides; this function only carries out what it decided. That
   * split is why the routing rules are testable without a camera.
   */
  const handle = useCallback(async (utterance: string) => {
    const input = {
      candidates: candidates(),
      pose: pose(),
      luma,
      hasClip,
    };

    // The camera has been swept somewhere else since the last answer — a pronoun
    // must not bind to something that is no longer in front of the user.
    const tracked = detections.find((d) => d.className === context.target?.className);
    const bound = onCameraMoved(
      context,
      tracked ? (tracked.x + tracked.w / 2) / input.pose.frameWidth : null,
    );
    setContext(bound);

    const decision = route(utterance, input, bound, { ...availability, online: navigator.onLine }, Date.now());
    note(`"${utterance}" → ${decision.kind} (${decision.parsed.intent}/${decision.parsed.goal ?? "—"})`);

    if (decision.kind === "stop") { stopAll(); setPhase("idle"); return; }

    if (decision.kind === "repeat") {
      if (decision.answer) speak(decision.answer);
      else speak({ keys: [ASK.whatToFind.clip!], text: ASK.whatToFind.mn, tier: "none", target: null, decline: true });
      setPhase("answered");
      return;
    }

    if (decision.kind === "answer") {
      setContext(remember(bound, decision.parsed.intent, decision.answer, Date.now()));
      speak(decision.answer);
      setPhase("answered");
      return;
    }

    // ESCALATION. Everything below this line may leave the device, and the user
    // is told so before it does.
    setPhase("thinking");

    if (decision.to === "ocr") {
      await runOcr(decision.parsed.followUp === "others");
      return;
    }

    // The vision tier is not configured in this project; `route` only returns
    // this when a probe said otherwise, and a failure degrades honestly.
    note("vlm escalation requested");
    speak({ keys: [ASK.noNetwork.clip!], text: ASK.noNetwork.mn, tier: "vlm", target: null, decline: true });
    setPhase("answered");
  }, [availability, candidates, context, detections, luma, note, pose, runOcr, speak]);

  /**
   * Push to talk.
   *
   * `warmMicrophone` has already run inside the touch handler (`onHoldPrewarm`),
   * so the permission dialog was raised while the user activation was still
   * alive. This only claims the stream that is already opening.
   */
  const holdStart = useCallback(() => {
    setPhase("listening");
    beginCaptureSession();
    stopAll();
    playListenCue("start");
  }, []);

  const holdEnd = useCallback(async () => {
    playListenCue("end");
    setPhase("thinking");
    try {
      const outcome = await listenOnceAnyEngine({ maxUtteranceMs: 6_000 });
      if (outcome.kind === "heard" && outcome.transcript.trim()) {
        await handle(outcome.transcript);
      } else {
        speak({ keys: [ASK.whatToFind.clip!], text: ASK.whatToFind.mn, tier: "none", target: null, decline: true });
        setPhase("answered");
      }
    } finally {
      endCaptureSession();
      discardWarmMicrophone();
    }
  }, [handle, speak]);

  // ---------------------------------------------------------------- ui

  /**
   * Four quick actions, for a rider who cannot or does not want to speak.
   *
   * Voice is the primary path and these are the floor under it — every one is
   * a question the on-device detector answers, so the list works with no
   * network and no microphone permission at all.
   */
  const actions: ListOption<string>[] = useMemo(() => [
    { value: "Урд юу байна", keys: [ASK.dirAhead.clip!], label: "Урд юу байна?" },
    { value: "Зам цэвэр үү", keys: [ASK.nothingAhead.clip!], label: "Зам цэвэр үү?" },
    { value: "Хаалга хаана байна", keys: ["door"], label: "Хаалга хаана байна?" },
    { value: "Хаана суух вэ", keys: ["bench"], label: "Хаана суух вэ?" },
  ], []);

  const nav = useGestureNav<string>({
    options: actions,
    announce: (o) => { const k = o.keys.filter(hasClip); if (k.length) playSequence(k, { interrupt: true }); },
    onSelect: (o) => { void handle(o.value); },
    onBack: () => router.push("/"),
    onRepeat: () => { void handle("давта"); },
    onWhereAmI: () => { void handle("урд юу байна"); },
    holdMode: true,
    onHoldPrewarm: () => warmMicrophone(),
    onHoldStart: holdStart,
    onHoldEnd: () => { void holdEnd(); },
    enabled: true,
  });

  /**
   * The screen-reader path: VoiceOver's double-tap lands here.
   *
   * `react-hooks/refs` flags `handle` because it reaches `videoRef` and
   * `ocrRef` — a DOM element and a lazily-created OCR worker, both of which
   * genuinely have to be refs. `onActivate` is only ever invoked from
   * `GestureSurface`'s click handler, so nothing here reads a ref during render;
   * the rule cannot see that through the memo and the array.
   *
   * Chasing it did produce three real changes, all kept: the detections, the
   * conversation context and the camera pose are now state rather than refs.
   * What remains is the irreducible part.
   */
  const a11yOptions: A11yOption[] = useMemo(
    () => actions.map((o, i) => ({
      label: o.label,
      selected: i === nav.index,
      // eslint-disable-next-line react-hooks/refs
      onActivate: () => { nav.setIndex(i); void handle(o.value); },
    })),
    [actions, handle, nav],
  );

  const handlers = {
    ...nav.handlers,
    onTouchStart: (e: React.TouchEvent) => { void start(); nav.handlers.onTouchStart(e); },
  };

  const title =
    phase === "listening" ? "Сонсож байна"
    : phase === "thinking" ? "Хайж байна"
    : answerText || (modelReady ? "Асууна уу" : "Ачаалж байна");

  return (
    <>
      {/* Never mirrored, never shown large: this is a sensor, not a viewfinder. */}
      <video
        ref={videoRef}
        playsInline
        muted
        aria-hidden="true"
        style={{ position: "fixed", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.12 }}
      />
      <GestureSurface
        handlers={handlers}
        options={a11yOptions}
        onFocusOption={(i) => { void start(); nav.setIndex(i); }}
      >
        <CurrentOption
          title={title}
          detail={phase === "answered" ? undefined : nav.current?.label}
          position={modelReady ? undefined : "…"}
        />
        <details style={{ position: "absolute", bottom: 6, left: 6, fontSize: 11, color: "#333" }}>
          <summary>debug</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {`phase ${phase} · boxes ${detections.length} · luma ${luma ?? "—"}\n`}
            {`ocr ${availability.ocr} · vlm ${availability.vlm}\n`}
            {log.join("\n")}
          </pre>
        </details>
      </GestureSurface>
    </>
  );
}
