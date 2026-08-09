/**
 * Streams a listening-harness clip from .cache/listening/. DEV ONLY.
 *
 * The clips deliberately do not live in public/. Anything under public/ is
 * copied into the production build and served, so a page that 404s in
 * production still leaves its assets reachable — 876 KB of A/B comparison audio
 * shipped to a phone on mobile data for no reason. Serving them through a
 * dev-gated handler keeps the whole harness out of the build.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

const CLIP_DIR = ".cache/listening";

export async function GET(_req: Request, { params }: { params: Promise<{ hash: string }> }) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const { hash } = await params;

  // The hash is a path segment; anything but hex is a traversal attempt.
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return new NextResponse("Bad clip id", { status: 400 });
  }

  try {
    const buf = await readFile(join(process.cwd(), CLIP_DIR, `${hash}.opus`));
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "audio/ogg",
        "Content-Length": String(buf.length),
        // A/B comparison depends on instant replay; these never change.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new NextResponse("Clip not rendered", { status: 404 });
  }
}
