"use client";

import { useRef, useState } from "react";

import { PHRASES } from "@/lib/phrases";

// Chimege returns 22050 Hz mono WAV. scripts/generate-audio.ts writes them here.
const AUDIO_DIR = "/audio";
const AUDIO_EXT = ".wav";

// iOS honours the ringer/silent switch for WebAudio unless the page declares a
// playback session. Must be set BEFORE the AudioContext is constructed.
type AudioSessionType =
  | "auto"
  | "playback"
  | "transient"
  | "transient-solo"
  | "ambient"
  | "play-and-record";

interface NavigatorWithAudioSession extends Navigator {
  audioSession: { type: AudioSessionType };
}

/**
 * Without this the iOS silent switch mutes every warning. Module scope, not
 * inside the component: mutating `navigator` from a component body trips
 * react-hooks/immutability.
 */
function enablePlaybackAudioSession() {
  if ("audioSession" in navigator) {
    (navigator as NavigatorWithAudioSession).audioSession.type = "playback";
  }
}

export default function CameraView() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef<Map<string, AudioBuffer>>(new Map());

  const [running, setRunning] = useState(false);
  // Ids whose buffer is decoded and playable. State, not a ref: the buttons
  // enable themselves off this, and a ref mutation would not re-render.
  const [ready, setReady] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState<string>("");

  /**
   * Decodes every phrase up front. Decoding at playback time would add tens of
   * ms to a warning that has to be immediate.
   */
  async function loadPhrases(ctx: AudioContext) {
    const ok: string[] = [];
    const bad: string[] = [];

    await Promise.all(
      PHRASES.map(async (phrase) => {
        const url = `${AUDIO_DIR}/${phrase.id}${AUDIO_EXT}`;
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = await res.arrayBuffer();
          buffersRef.current.set(phrase.id, await ctx.decodeAudioData(bytes));
          ok.push(phrase.id);
          setReady([...ok]);
        } catch {
          bad.push(phrase.id);
          setFailed([...bad]);
        }
      }),
    );
  }

  /**
   * Synchronous on purpose: a warning must fire on the frame it is decided, not
   * a microtask later. Buffers are already decoded, so there is nothing to await.
   */
  function play(id: string) {
    const ctx = audioCtxRef.current;
    const buffer = buffersRef.current.get(id);
    if (!ctx || !buffer) {
      setError(`No decoded audio for "${id}"`);
      return;
    }

    // iOS suspends the context when the tab backgrounds. Kick it without
    // awaiting so playback stays synchronous.
    if (ctx.state === "suspended") void ctx.resume();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
  }

  async function start() {
    try {
      setError("");

      // Must happen before the AudioContext is constructed.
      enablePlaybackAudioSession();

      // MUST be created inside a user gesture, or iOS stays silent. Held in a
      // ref so re-renders never rebuild it and GC never collects it.
      let ctx = audioCtxRef.current;
      if (!ctx) {
        ctx = new AudioContext();
        audioCtxRef.current = ctx;
      }
      await ctx.resume();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: 640, height: 480 },
        audio: false,
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setRunning(true);

      // After the video is up: the picture should not wait on audio decoding.
      await loadPhrases(ctx);
    } catch (e) {
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }

  return (
    <div className="w-screen h-screen bg-black relative">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover"
      />

      {!running && (
        <button
          onClick={start}
          aria-label="Эхлүүлэх"
          className="absolute inset-0 w-full h-full text-white text-4xl font-bold"
        >
          Эхлүүлэх
        </button>
      )}

      {running && (
        <div className="absolute top-4 left-4 right-4 flex flex-col gap-3">
          <p className="text-green-400 text-lg font-mono bg-black/80 px-2 py-1 rounded">
            {ready.length}/{PHRASES.length} loaded
            {failed.length > 0 && ` — FAILED: ${failed.join(", ")}`}
          </p>

          <div className="flex flex-wrap gap-2">
            {PHRASES.map((phrase) => (
              <button
                key={phrase.id}
                onClick={() => play(phrase.id)}
                disabled={!ready.includes(phrase.id)}
                aria-label={phrase.mn}
                className="bg-white/90 text-black text-2xl font-bold px-5 py-4 rounded disabled:opacity-30"
              >
                {phrase.mn}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="absolute bottom-4 left-4 right-4 text-red-400 text-sm bg-black/80 p-3 rounded">
          {error}
        </p>
      )}
    </div>
  );
}
