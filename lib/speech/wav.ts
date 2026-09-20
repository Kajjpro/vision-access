/**
 * Turning whatever the browser recorded into what Azure will accept.
 *
 * THE PROBLEM THIS SOLVES. `MediaRecorder` gives you the container the browser
 * feels like: Chrome (desktop and Android, the primary target) supports ONLY
 * `audio/webm;codecs=opus` for recording — not OGG, not WAV. iOS Safari gives
 * MP4/AAC. Azure's short-audio REST endpoint accepts neither: its documented
 * inputs are WAV (16-bit PCM) and OGG-OPUS.
 *
 * Every way out of that is bad except this one:
 *   - send WebM anyway            → Azure refuses it, every utterance fails
 *   - refuse to record            → the rider cannot speak at all
 *   - transcode on the server     → an ffmpeg in the request path
 *   - capture raw PCM via an AudioWorklet → a second capture stack to maintain
 *
 * So: record in the browser's native container, then decode and re-encode it as
 * 16 kHz mono PCM WAV before upload. `decodeAudioData` already knows how to
 * read whatever that browser just produced — Chrome decodes its own WebM/Opus,
 * Safari its own MP4/AAC — which is exactly the property needed, and it costs
 * one pass over a few seconds of audio.
 *
 * The two functions doing the real work are pure and tested; only `blobToWav`
 * touches Web Audio, and its decoder is injected.
 */

/** Azure's short-audio API wants 16 kHz mono. 8 kHz is also accepted. */
export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Linear-interpolation resample.
 *
 * Not a windowed-sinc, deliberately. This runs on a cheap Android between the
 * rider letting go of the button and the recognizer answering, the source is a
 * voice band well under the Nyquist limit of both rates, and the consumer is a
 * speech recognizer rather than an ear. The artefacts a better filter would
 * remove are not ones the recognizer is sensitive to.
 */
export function resampleMono(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate || input.length === 0) return input;

  const ratio = inRate / outRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, input.length - 1);
    const t = at - low;
    out[i] = input[low] * (1 - t) + input[high] * t;
  }
  return out;
}

/** Average the channels. A stereo mic would otherwise arrive half-cancelled. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];

  const length = channels[0].length;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Float samples → a RIFF/WAVE file of 16-bit signed PCM.
 *
 * Written by hand because the alternative is a dependency for 40 lines of
 * header, on a project that ships over expensive mobile data.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);                              // PCM header size
  view.setUint16(20, 1, true);                               // format: PCM
  view.setUint16(22, 1, true);                               // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);     // byte rate
  view.setUint16(32, bytesPerSample, true);                  // block align
  view.setUint16(34, 16, true);                              // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: a sample above 1.0 would wrap to full-scale
    // negative and arrive as a click the recognizer reads as a consonant.
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += bytesPerSample;
  }
  return buffer;
}

export type DecodedAudio = { channels: Float32Array[]; sampleRate: number };

/**
 * `decodeAudioData` across the two shapes browsers implement.
 *
 * Safari's returns `undefined` and answers through the callbacks on builds that
 * predate the promise form, so awaiting the return value alone hangs forever —
 * on the one platform whose container we most need to decode. Both are wired,
 * and whichever fires first wins.
 */
function decodeAudioData(context: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false;
    const ok = (buffer: AudioBuffer) => { if (!settled) { settled = true; resolve(buffer); } };
    const no = (e: unknown) => {
      if (!settled) { settled = true; reject(e instanceof Error ? e : new Error("decode failed")); }
    };
    let returned: Promise<AudioBuffer> | undefined;
    try {
      returned = context.decodeAudioData(bytes, ok, no);
    } catch (e) {
      no(e);
      return;
    }
    if (returned && typeof returned.then === "function") returned.then(ok, no);
  });
}

/**
 * Decode with Web Audio. Separated so the pipeline above can be tested.
 *
 * AN OFFLINE CONTEXT, NOT A LIVE ONE. `new AudioContext()` claims a hardware
 * output: iOS allows only a handful per page, refuses to open more, and — worse
 * here — constructing one moments after a recording ends can interrupt the
 * shared context that every warning and stop name plays through. Decoding needs
 * no output at all, and `OfflineAudioContext` provides the same decoder with no
 * hardware attached. The live context stays the fallback for any build that
 * refuses to decode on an offline one.
 *
 * `slice()` per attempt because `decodeAudioData` DETACHES the buffer it is
 * given; the fallback would otherwise be handed zero bytes.
 */
export async function decodeWithWebAudio(bytes: ArrayBuffer): Promise<DecodedAudio> {
  const read = (decoded: AudioBuffer): DecodedAudio => {
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
    return { channels, sampleRate: decoded.sampleRate };
  };

  const Offline: typeof OfflineAudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : (window.OfflineAudioContext ??
        (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
          .webkitOfflineAudioContext);

  if (Offline) {
    try {
      // One frame at a common rate: the length is irrelevant to decoding, and a
      // rate every browser accepts avoids a constructor throw on Safari.
      const offline = new Offline(1, 1, 44_100);
      return read(await decodeAudioData(offline, bytes.slice(0)));
    } catch {
      /* fall through to a live context */
    }
  }

  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Ctor();
  try {
    return read(await decodeAudioData(context, bytes.slice(0)));
  } finally {
    // Every AudioContext holds a hardware handle; leaking one per utterance
    // eventually refuses to open any more of them.
    void context.close().catch(() => {});
  }
}

/**
 * Recorded blob → 16 kHz mono PCM WAV blob.
 *
 * Throws if the browser cannot decode its own recording, which the caller must
 * treat as "voice is unavailable" and fall through to the stop list rather than
 * uploading something the recognizer will reject.
 */
export async function blobToWav(
  blob: Blob,
  decode: (bytes: ArrayBuffer) => Promise<DecodedAudio> = decodeWithWebAudio,
  targetRate = TARGET_SAMPLE_RATE,
): Promise<Blob> {
  const { channels, sampleRate } = await decode(await blob.arrayBuffer());
  const mono = mixToMono(channels);
  if (mono.length === 0) throw new Error("recording decoded to no audio");
  const resampled = resampleMono(mono, sampleRate, targetRate);
  return new Blob([encodeWav(resampled, targetRate)], { type: "audio/wav" });
}
