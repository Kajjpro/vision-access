"use client";

/**
 * Plays the real earcons against synthesized bus noise.
 *
 * THE NOISE IS SYNTHESIZED, AND THAT IS A LIMITATION, NOT A FEATURE. Filtered
 * brown noise approximates the low rumble of a diesel cabin and nothing else:
 * it has no door chime, no PA, no crowd, no braking squeal, and none of the
 * transients that actually mask a short tone. Playing real bus audio through a
 * speaker beside the phone is the better test, and this is the fallback for
 * when that is not to hand — treat a pass here as necessary, not sufficient.
 *
 * The A/B pair matters more than the individual buttons. Absolute audibility is
 * easy to judge and not the question; whether `soft` and `alert` are
 * DISTINGUISHABLE under masking is the question, and that needs them played
 * back to back without knowing which is which.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { createEarconPlayer, earconDurationS, EARCON_SHAPES } from "@/lib/transit/earcons";

type Id = "soft" | "alert" | "urgent" | "error";
const IDS: Id[] = ["soft", "alert", "urgent", "error"];

const MEANING: Record<Id, string> = {
  soft: "something changed, no action needed",
  alert: "act soon — be at the kerb, press the button",
  urgent: "act now — the doors, the wrong bus",
  error: "that did not work",
};

export function EarconBench() {
  const ctxRef = useRef<AudioContext | null>(null);
  const noiseRef = useRef<{ src: AudioBufferSourceNode; gain: GainNode } | null>(null);
  const [noise, setNoise] = useState(0);
  const [blind, setBlind] = useState<{ answer: Id; revealed: boolean } | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const note = useCallback((line: string) => setLog((l) => [line, ...l].slice(0, 12)), []);

  const ctx = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    void ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  /** Brown noise: a rough stand-in for cabin rumble, weighted to the low end. */
  const startNoise = useCallback(() => {
    const c = ctx();
    if (noiseRef.current) return;
    const seconds = 4;
    const buffer = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = c.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(c.destination);
    src.start();
    noiseRef.current = { src, gain };
  }, [ctx]);

  useEffect(() => () => {
    try { noiseRef.current?.src.stop(); } catch { /* already stopped */ }
    void ctxRef.current?.close().catch(() => {});
  }, []);

  const setNoiseLevel = useCallback((v: number) => {
    setNoise(v);
    startNoise();
    if (noiseRef.current) noiseRef.current.gain.gain.value = v;
  }, [startNoise]);

  const play = useCallback((id: Id, label?: string) => {
    const player = createEarconPlayer(() => ctx());
    void player.play(id, new AbortController().signal).catch(() => {});
    note(`${label ?? id} · ${(earconDurationS(id) * 1000).toFixed(0)} ms`);
  }, [ctx, note]);

  /**
   * The discrimination test. Plays soft or alert without saying which.
   *
   * Absolute audibility is not the question — masking that collapses `alert`
   * into `soft` is, and you cannot judge that while knowing the answer.
   */
  const playBlind = useCallback(() => {
    const answer: Id = Math.random() < 0.5 ? "soft" : "alert";
    setBlind({ answer, revealed: false });
    play(answer, "?");
  }, [play]);

  return (
    <main style={{ font: "15px/1.6 system-ui, sans-serif", padding: 24, maxWidth: 640, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22 }}>Earcon bench</h1>
      <p style={{ color: "#555" }}>
        Play real bus audio through a separate speaker at realistic volume if you have it. The
        slider below is a rough substitute — brown noise has none of the transients that actually
        mask a short tone.
      </p>

      <section style={{ margin: "20px 0", padding: 14, border: "1px solid #ddd", borderRadius: 6 }}>
        <label>
          Masking noise: <strong>{Math.round(noise * 100)}%</strong>
          <input
            type="range" min={0} max={0.9} step={0.05} value={noise}
            onChange={(e) => setNoiseLevel(Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </label>
      </section>

      <h2 style={{ fontSize: 17 }}>Each earcon</h2>
      <div style={{ display: "grid", gap: 8 }}>
        {IDS.map((id) => {
          const notes = EARCON_SHAPES[id];
          return (
            <button
              key={id}
              onClick={() => play(id)}
              style={{ textAlign: "left", padding: "10px 12px", fontSize: 15, cursor: "pointer" }}
            >
              <strong>{id}</strong> — {MEANING[id]}
              <br />
              <span style={{ color: "#666", fontSize: 13 }}>
                {notes.map((n) => `${n.hz}Hz`).join(" → ")} · {(earconDurationS(id) * 1000).toFixed(0)} ms ·
                peak {Math.max(...notes.map((n) => n.gain)).toFixed(2)}
              </span>
            </button>
          );
        })}
      </div>

      <h2 style={{ fontSize: 17, marginTop: 24 }}>soft vs alert, blind</h2>
      <p style={{ color: "#555", marginTop: 0 }}>
        They share a 660 Hz onset. If the second, higher tone of <code>alert</code> is masked,
        &ldquo;act soon&rdquo; is heard as &ldquo;nothing needed&rdquo;. Raise the noise until you
        start guessing wrong, and note that level.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={playBlind} style={{ padding: "10px 14px", cursor: "pointer" }}>
          Play one at random
        </button>
        <button
          onClick={() => setBlind((b) => (b ? { ...b, revealed: true } : b))}
          disabled={!blind || blind.revealed}
          style={{ padding: "10px 14px", cursor: "pointer" }}
        >
          Reveal
        </button>
        <button onClick={() => { play("soft", "soft (A/B)"); setTimeout(() => play("alert", "alert (A/B)"), 700); }}
          style={{ padding: "10px 14px", cursor: "pointer" }}>
          Play both, soft then alert
        </button>
      </div>
      {blind && (
        <p style={{ fontSize: 18, marginTop: 12 }}>
          {blind.revealed ? <>It was <strong>{blind.answer}</strong>.</> : "Decide, then reveal."}
        </p>
      )}

      <h2 style={{ fontSize: 17, marginTop: 24 }}>Log</h2>
      <ol style={{ color: "#444", fontSize: 13, fontFamily: "ui-monospace, monospace" }}>
        {log.map((l, i) => <li key={i}>{l}</li>)}
      </ol>
    </main>
  );
}
