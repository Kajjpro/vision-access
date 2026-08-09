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
import type { ClipPlayer } from "./audio-queue";
import type { AudioManifest } from "./types";

export class ManifestClipPlayer implements ClipPlayer {
  private buffers = new Map<string, AudioBuffer>();
  private current: AudioBufferSourceNode | null = null;

  constructor(
    private manifest: AudioManifest,
    private ctx: AudioContext,
  ) {}

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
    const wanted = keys ?? Object.keys(this.manifest);
    const failed: string[] = [];

    await Promise.all(
      wanted.map(async (key) => {
        if (this.buffers.has(key)) return;
        const entry = this.manifest[key];
        if (!entry) {
          failed.push(key);
          return;
        }
        try {
          const res = await fetch(entry.path);
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
