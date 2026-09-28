import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TITLE = "Харааны Хандалт";
const SUBTITLE = "Vision Access";
const TAGLINE = "Харааны бэрхшээлтэй иргэдэд зориулсан автобусны дуут навигаци";

/**
 * satori (the OG image renderer) ships no Cyrillic glyphs by default, so
 * Mongolian text would render as tofu without an explicit font. Google's CSS2
 * API returns a per-character-subset font as a plain .ttf — not .woff2, which
 * satori can't read — when asked for `text=` with no `Accept` header; that's
 * the standard workaround for non-Latin OG images (Vercel's own og examples
 * use the same trick). Fixed at request time, not build time, so it always
 * covers exactly the characters this image actually uses.
 */
async function loadCyrillicFont(text: string) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=Noto+Sans:wght@700&text=${encodeURIComponent(text)}`;
  const css = await (await fetch(cssUrl)).text();
  const match = css.match(/src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/);
  if (!match) throw new Error("opengraph-image: could not find a truetype font URL in Google Fonts CSS");
  const fontRes = await fetch(match[1]);
  return fontRes.arrayBuffer();
}

export default async function OpengraphImage() {
  const fontData = await loadCyrillicFont(TITLE + SUBTITLE + TAGLINE);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#000",
          color: "#fff",
          fontFamily: "Noto Sans",
          padding: 80,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 88, fontWeight: 700, display: "flex" }}>{TITLE}</div>
        <div style={{ fontSize: 40, color: "#aaaaaa", marginTop: 16, display: "flex" }}>{SUBTITLE}</div>
        <div style={{ fontSize: 32, color: "#dddddd", marginTop: 48, maxWidth: 900, display: "flex" }}>
          {TAGLINE}
        </div>
      </div>
    ),
    { ...size, fonts: [{ name: "Noto Sans", data: fontData, weight: 700, style: "normal" }] },
  );
}
