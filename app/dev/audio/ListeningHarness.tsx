"use client";

/**
 * The interactive half of the listening harness.
 *
 * Design notes, since this is a judgement tool rather than a display:
 *
 *  - The voice A/B is BLIND by default. Knowing which clip is Yesui and which
 *    is Bataa is exactly the kind of thing that decides a close call before the
 *    ear does. The reveal is one click away, and the running tally is kept so
 *    a preference across ten names is visible rather than remembered.
 *  - A/B pairs are prefetched and decoded before playback so switching between
 *    them is instant. A pause between two clips is enough to lose the
 *    comparison.
 *  - Keyboard: A/B play each side, Space replays the last, arrows move between
 *    rows. Comparing by ear means not looking for a mouse target.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ListeningManifest = {
  generatedAt: string;
  bitrate: string;
  voiceA: string;
  voiceB: string;
  clipDir: string;
  voiceCompare: { id: string; display: string; text: string; a: string; b: string }[];
  numeralCompare: {
    id: string; display: string; engineText: string; wordsText: string | null;
    engine: string; words: string | null; reason?: string;
  }[];
  stress: { id: string; display: string; note: string; text: string; clip: string }[];
};

type Verdict = "a" | "b" | "same" | undefined;

const card: React.CSSProperties = {
  border: "1px solid #2a2a2a", borderRadius: 10, padding: "14px 16px",
  marginBottom: 10, background: "#141414",
};
const btn: React.CSSProperties = {
  padding: "10px 16px", borderRadius: 8, border: "1px solid #3a3a3a",
  background: "#1e1e1e", color: "#eee", cursor: "pointer", fontSize: 15,
  minWidth: 62, fontFamily: "inherit",
};
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 13 };

export function ListeningHarness({ manifest }: { manifest: ListeningManifest }) {
  const [section, setSection] = useState<"voice" | "numerals" | "stress">("voice");
  const [blind, setBlind] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [numeralVerdicts, setNumeralVerdicts] = useState<Record<string, Verdict>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const lastRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const url = useCallback((h: string) => `${manifest.clipDir}/${h}.opus`, [manifest.clipDir]);

  /**
   * One element, reused. Two overlapping clips make both unintelligible, which
   * is the same rule the app's audio queue enforces.
   */
  const play = useCallback((h: string) => {
    audioRef.current?.pause();
    const a = new Audio(url(h));
    audioRef.current = a;
    lastRef.current = h;
    setPlaying(h);
    a.onended = () => setPlaying((p) => (p === h ? null : p));
    void a.play().catch(() => setPlaying(null));
  }, [url]);

  // Which pair the keyboard acts on.
  const rows = section === "voice" ? manifest.voiceCompare
    : section === "numerals" ? manifest.numeralCompare
    : manifest.stress;
  const current = rows[Math.min(cursor, rows.length - 1)] as Record<string, unknown> | undefined;

  const pairFor = useCallback((row: Record<string, unknown> | undefined) => {
    if (!row) return null;
    if (section === "voice") return { a: row.a as string, b: row.b as string };
    if (section === "numerals") return { a: row.engine as string, b: (row.words as string) ?? null };
    return { a: row.clip as string, b: null };
  }, [section]);

  // Prefetch the current pair so the switch between them has no gap.
  useEffect(() => {
    const p = pairFor(current);
    if (!p) return;
    for (const h of [p.a, p.b]) if (h) new Audio(url(h)).load();
  }, [current, pairFor, url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const p = pairFor(current);
      if (e.key === "a" || e.key === "A") { if (p?.a) play(p.a); e.preventDefault(); }
      else if (e.key === "b" || e.key === "B") { if (p?.b) play(p.b); e.preventDefault(); }
      else if (e.key === " ") { if (lastRef.current) play(lastRef.current); e.preventDefault(); }
      else if (e.key === "ArrowDown") { setCursor((c) => Math.min(c + 1, rows.length - 1)); e.preventDefault(); }
      else if (e.key === "ArrowUp") { setCursor((c) => Math.max(c - 1, 0)); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, pairFor, play, rows.length]);

  const tally = useMemo(() => {
    const v = Object.values(verdicts);
    return {
      a: v.filter((x) => x === "a").length,
      b: v.filter((x) => x === "b").length,
      same: v.filter((x) => x === "same").length,
      done: v.filter(Boolean).length,
    };
  }, [verdicts]);

  const numeralTally = useMemo(() => {
    const v = Object.values(numeralVerdicts);
    return {
      engine: v.filter((x) => x === "a").length,
      words: v.filter((x) => x === "b").length,
      same: v.filter((x) => x === "same").length,
      done: v.filter(Boolean).length,
    };
  }, [numeralVerdicts]);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", background: "#0b0b0b", color: "#eaeaea", minHeight: "100vh", padding: "28px 24px" }}>
      <div style={{ maxWidth: 940, margin: "0 auto" }}>
        <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>Listening harness</h1>
        <p style={{ color: "#888", margin: "0 0 18px", fontSize: 14 }}>
          Opus mono {manifest.bitrate} · rendered {new Date(manifest.generatedAt).toLocaleString()} ·{" "}
          <kbd>A</kbd>/<kbd>B</kbd> play · <kbd>Space</kbd> replay · <kbd>↑</kbd>/<kbd>↓</kbd> move
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          {([
            ["voice", `1. Voice A/B (${manifest.voiceCompare.length})`],
            ["numerals", `2. Numerals (${manifest.numeralCompare.length})`],
            ["stress", `3. Stress (${manifest.stress.length})`],
          ] as const).map(([k, label]) => (
            <button key={k} onClick={() => { setSection(k); setCursor(0); }}
              style={{ ...btn, background: section === k ? "#2b4a6f" : "#1e1e1e", minWidth: 0 }}>
              {label}
            </button>
          ))}
        </div>

        {section === "voice" && (
          <>
            <div style={{ ...card, background: "#16202b" }}>
              <strong>The expensive decision.</strong> Re-encoding at another bitrate is free from
              cache; changing voice means re-synthesizing all 923 stop names. Pick by ear here.
              <div style={{ marginTop: 10, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ fontSize: 14 }}>
                  <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} /> blind
                  (hide which voice is which)
                </label>
                <span style={{ color: "#9ad", fontSize: 14 }}>
                  A {tally.a} · B {tally.b} · same {tally.same} — {tally.done}/{manifest.voiceCompare.length} judged
                </span>
                {!blind && (
                  <span style={{ ...mono, color: "#888" }}>A = {manifest.voiceA} · B = {manifest.voiceB}</span>
                )}
              </div>
            </div>

            {manifest.voiceCompare.map((row, i) => (
              <div key={row.id} style={{ ...card, outline: i === cursor ? "2px solid #3a6ea5" : "none" }}
                onClick={() => setCursor(i)}>
                <div style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 16 }}>{row.display}</span>
                  <span style={{ ...mono, color: "#777", marginLeft: 10 }}>→ {row.text}</span>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button style={{ ...btn, borderColor: playing === row.a ? "#5c9" : "#3a3a3a" }}
                    onClick={() => play(row.a)}>▶ A</button>
                  <button style={{ ...btn, borderColor: playing === row.b ? "#5c9" : "#3a3a3a" }}
                    onClick={() => play(row.b)}>▶ B</button>
                  <span style={{ width: 16 }} />
                  {(["a", "b", "same"] as const).map((v) => (
                    <button key={v}
                      onClick={() => setVerdicts((s) => ({ ...s, [row.id]: s[row.id] === v ? undefined : v }))}
                      style={{ ...btn, minWidth: 0, padding: "8px 12px", fontSize: 13,
                        background: verdicts[row.id] === v ? "#2f6b3f" : "#1e1e1e" }}>
                      {v === "same" ? "no difference" : `prefer ${v.toUpperCase()}`}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}

        {section === "numerals" && (
          <>
            <div style={{ ...card, background: "#2b2116" }}>
              <strong>Is the engine&apos;s ordinal actually right?</strong> Matching durations only
              showed it spoke for the same length of time — not that it produced the correct
              Mongolian ordinal. <b>A</b> is the numeral sent as-is for Azure to expand.
              <b> B</b> is <code style={mono}>data/number-words.json</code>. If A is wrong anywhere,
              the table stays in the shipping path.
              <div style={{ marginTop: 10, color: "#dca", fontSize: 14 }}>
                engine {numeralTally.engine} · table {numeralTally.words} · same {numeralTally.same}
                {" "}— {numeralTally.done}/{manifest.numeralCompare.length} judged
              </div>
            </div>

            {manifest.numeralCompare.map((row, i) => (
              <div key={row.id} style={{ ...card, outline: i === cursor ? "2px solid #3a6ea5" : "none" }}
                onClick={() => setCursor(i)}>
                <div style={{ marginBottom: 8, fontSize: 16 }}>{row.display}</div>
                <div style={{ ...mono, color: "#888", marginBottom: 8 }}>
                  A: {row.engineText}
                  <br />
                  B: {row.wordsText ?? <span style={{ color: "#c66" }}>no word-form — {row.reason}</span>}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button style={{ ...btn, borderColor: playing === row.engine ? "#5c9" : "#3a3a3a" }}
                    onClick={() => play(row.engine)}>▶ A engine</button>
                  <button disabled={!row.words}
                    style={{ ...btn, opacity: row.words ? 1 : 0.4, borderColor: playing === row.words ? "#5c9" : "#3a3a3a" }}
                    onClick={() => row.words && play(row.words)}>▶ B table</button>
                  <span style={{ width: 16 }} />
                  {(["a", "b", "same"] as const).map((v) => (
                    <button key={v}
                      onClick={() => setNumeralVerdicts((s) => ({ ...s, [row.id]: s[row.id] === v ? undefined : v }))}
                      style={{ ...btn, minWidth: 0, padding: "8px 12px", fontSize: 13,
                        background: numeralVerdicts[row.id] === v ? "#2f6b3f" : "#1e1e1e" }}>
                      {v === "same" ? "both fine" : v === "a" ? "engine ok" : "table better"}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}

        {section === "stress" && (
          <>
            <div style={{ ...card, background: "#1b2418" }}>
              The longest and most sibilant names at the shipping bitrate. Band-energy measurement
              said {manifest.bitrate} loses no more sibilance than 24k; this is the ear check on that.
            </div>
            {manifest.stress.map((row, i) => (
              <div key={row.id + row.note} style={{ ...card, outline: i === cursor ? "2px solid #3a6ea5" : "none" }}
                onClick={() => setCursor(i)}>
                <div style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 16 }}>{row.display}</span>
                  <span style={{ color: "#777", marginLeft: 10, fontSize: 13 }}>({row.note})</span>
                </div>
                <button style={{ ...btn, borderColor: playing === row.clip ? "#5c9" : "#3a3a3a" }}
                  onClick={() => play(row.clip)}>▶ play</button>
              </div>
            ))}
          </>
        )}

        <details style={{ marginTop: 24, color: "#888" }}>
          <summary style={{ cursor: "pointer" }}>Copy verdicts as JSON</summary>
          <pre style={{ ...mono, background: "#111", padding: 14, borderRadius: 8, overflowX: "auto" }}>
            {JSON.stringify({ voice: verdicts, numerals: numeralVerdicts }, null, 2)}
          </pre>
        </details>
      </div>
    </main>
  );
}
