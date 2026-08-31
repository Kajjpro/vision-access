/**
 * A ClipPlayer backed by the bundled Opus manifest.
 *
 * Browser-side. Decodes into the app's shared AudioContext — CLAUDE.md requires
 * buffers decoded up front rather than at playback time, because a clip that
 * decodes before it speaks is a clip that arrives late.
 *
 * The whole transit set is ~3.6 MB bundled, so there is no lazy path and no
 * service worker: everything the bus modes can say is on the device before the
 * user boards.
 */
import { ALL_PHRASES } from "@/lib/ui/announcements";
import type { ClipPlayer } from "./audio-queue";
import type { AudioManifest } from "./types";

/**
 * Every `ui_*` clip the announcement registry knows about.
 *
 * Derived from ALL_PHRASES rather than hand-listed, so adding a phrase to
 * lib/ui/announcements.ts is enough — there is no second list to forget.
 */
const DEFAULT_UI_KEYS: string[] = [
  ...new Set(
    Object.values(ALL_PHRASES)
      .map((p) => p.clip)
      .filter((c): c is string => c !== null && c.startsWith("ui_")),
  ),
];

export class ManifestClipPlayer implements ClipPlayer {
  private buffers = new Map<string, AudioBuffer>();
  private current: AudioBufferSourceNode | null = null;

  /**
   * Whether this browser can be trusted with Ogg Opus.
   *
   * Safari — every iOS browser, since they all use WebKit — either rejects Ogg
   * Opus outright or decodes it inconsistently by version. Rather than sniff the
   * user agent, ask the browser what it can play and fall back to the AAC twin.
   * A stop name that fails to decode is a stop announced as silence, which reads
   * to the rider as "not yet".
   */
  private preferAac = (() => {
    if (typeof document === "undefined") return false;
    const probe = document.createElement("audio");
    // canPlayType returns "" for "definitely not"; Safari returns "" for Ogg Opus.
    return probe.canPlayType('audio/ogg; codecs="opus"') === "";
  })();

  constructor(
    private manifest: AudioManifest,
    private ctx: AudioContext,
    /** UI phrase keys to load alongside the manifest. Defaults to all of them. */
    private uiKeys: string[] = DEFAULT_UI_KEYS,
  ) {}

  /** The URL this device should actually fetch for a clip. */
  private urlFor(entry: { path: string; pathAac?: string }): string {
    return this.preferAac && entry.pathAac ? entry.pathAac : entry.path;
  }

  /**
   * UI phrases live outside the transit manifest, as WAVs in public/audio.
   *
   * The project deliberately splits the two: 923 stop names are Opus because
   * size matters, while UI phrases are WAV because iOS Safari decodes WAV
   * natively and these are the clips a first-time user hears. That split left a
   * gap — this player only knew the manifest, so every `ui_*` key the ride
   * screen tried to speak came back as a missing clip and the countdown lost
   * its wording ("өнгөрлөө", the status readout, the screen name).
   *
   * Resolving them here rather than merging the two sets keeps the format
   * choice intact and means a screen can name any phrase without caring which
   * pipeline rendered it.
   */
  private uiUrlFor(key: string): string | null {
    return key.startsWith("ui_") ? `/audio/${key}.wav` : null;
  }

  has(key: string): boolean {
    return this.buffers.has(key);
  }

  /** Keys present in the manifest but not yet decoded. */
  get loaded(): number {
    return this.buffers.size;
  }

  get total(): number {
    return Object.keys(this.manifest).length;
  }

  /**
   * Fetches and decodes. `keys` limits the work to what a screen can actually
   * say; passing nothing loads the lot.
   */
  async load(keys?: string[]): Promise<{ loaded: number; failed: string[] }> {
    // Default: the whole manifest PLUS every UI phrase, so a screen can speak
    // any announcement without having to enumerate which pipeline rendered it.
    const wanted = keys ?? [...Object.keys(this.manifest), ...this.uiKeys];
    const failed: string[] = [];

    await Promise.all(
      wanted.map(async (key) => {
        if (this.buffers.has(key)) return;
        const entry = this.manifest[key];
        const url = entry ? this.urlFor(entry) : this.uiUrlFor(key);
        if (!url) {
          failed.push(key);
          return;
        }
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(String(res.status));
          this.buffers.set(key, await this.ctx.decodeAudioData(await res.arrayBuffer()));
        } catch {
          failed.push(key);
        }
      }),
    );

    return { loaded: this.buffers.size, failed };
  }

  /**
   * Plays one clip, resolving when it ends.
   *
   * Aborting stops the source immediately — preemption of a critical
   * announcement depends on this being prompt rather than waiting out the clip.
   */
  play(key: string, signal: AbortSignal): Promise<void> {
    const buffer = this.buffers.get(key);
    if (!buffer) return Promise.reject(new Error(`no buffer for ${key}`));
    if (signal.aborted) return Promise.reject(new Error("aborted"));

    return new Promise<void>((resolve, reject) => {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.ctx.destination);

      const onAbort = () => {
        try {
          source.stop();
        } catch {
          /* already stopped */
        }
        cleanup();
        reject(new Error("aborted"));
      };

      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        if (this.current === source) this.current = null;
      };

      source.onended = () => {
        cleanup();
        resolve();
      };

      signal.addEventListener("abort", onAbort, { once: true });
      this.current = source;
      source.start();
    });
  }
}
