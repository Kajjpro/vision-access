/**
 * Tier 3 client: one frame, one question, through the server route.
 *
 * NOT VERIFIED. No vision key is configured in this project, so `/api/ask-vision`
 * answers 503 and `available()` is false — the router's decline path is what
 * actually runs. This exists so enabling the tier is a matter of configuration
 * rather than of writing the integration under time pressure later.
 */

import type { Frame, VisionProvider } from "./providers";

/** Probe result, cached for the session: a 503 will not become a 200 mid-journey. */
let configured: boolean | null = null;

export async function probeVision(): Promise<boolean> {
  if (configured !== null) return configured;
  try {
    // A deliberately invalid body: 400 means the route is live and configured,
    // 503 means no key. Either way nothing is uploaded to find out.
    const res = await fetch("/api/ask-vision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    configured = res.status !== 503;
  } catch {
    configured = false;
  }
  return configured;
}

export function createVisionProvider(): VisionProvider {
  return {
    available: () => configured === true,

    async ask(frame: Frame, question: string): Promise<string> {
      const blob = new Blob([frame.bytes as unknown as BlobPart], { type: "image/jpeg" });
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("could not encode frame"));
        reader.readAsDataURL(blob);
      });

      const res = await fetch("/api/ask-vision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image, question }),
      });
      if (!res.ok) throw new Error(`vision ${res.status}`);
      const json = (await res.json()) as { text?: string };
      if (!json.text) throw new Error("vision returned nothing");
      return json.text;
    },
  };
}
