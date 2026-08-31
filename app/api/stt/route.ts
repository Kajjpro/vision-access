/**
 * Azure Speech short-audio proxy.
 *
 * Keeps the subscription key server-side (the browser must never see it) and
 * reuses the same AZURE_SPEECH_KEY / AZURE_SPEECH_REGION already configured for
 * the pre-rendered mn-MN-YesuiNeural TTS pipeline.
 *
 * mn-MN IS SUPPORTED HERE — verified 2026-08-13, not assumed. TTS and STT are
 * separate language lists, so having mn-MN-YesuiNeural never proved the
 * recognizer existed. Two checks, both against the live subscription:
 *
 *   GET {region}.api.cognitive.microsoft.com/speechtotext/v3.2/transcriptions/locales
 *     → 150 locales for southeastasia, `mn-MN` among them.
 *   40 real stop names from public/transit/stops.json, spoken by a DIFFERENT
 *     voice than the app renders with (mn-MN-BataaNeural), round-tripped
 *     through this endpoint → 95% resolved to the correct stop.
 *
 * Re-run the second one with scripts/stt-accuracy.ts before trusting a region
 * change: locale availability is per-region, and a region without mn-MN fails
 * as a plain recognition error rather than as anything self-describing.
 *
 * If a different provider is ever needed, this route is the only file that
 * changes — nothing on the client knows who transcribed.
 */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 20;

const MAX_BYTES = 1_500_000; // ~15s of Opus; short-audio API caps at 60s anyway

export async function POST(req: NextRequest) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    return NextResponse.json(
      { error: 'Speech service not configured' },
      { status: 503 },
    );
  }

  /**
   * WAV or OGG-OPUS only — the two containers Azure's short-audio endpoint
   * documents.
   *
   * WebM used to be accepted here and forwarded verbatim, which was worse than
   * rejecting it: Chrome records WebM/Opus, so every request from the primary
   * target browser was passed straight through to a recognizer that refuses it,
   * and the failure surfaced as an opaque upstream error rather than as
   * anything a developer could act on. The client now converts to 16 kHz mono
   * PCM before upload — see lib/speech/wav.ts.
   */
  const contentType = req.headers.get('content-type') ?? '';
  if (!/^audio\/(wav|wave|x-wav|ogg)/.test(contentType)) {
    return NextResponse.json(
      {
        error: 'Unsupported audio type',
        detail: `Azure short-audio accepts WAV (PCM) or OGG-OPUS; got "${contentType}". ` +
          `Convert in the browser with blobToWav().`,
      },
      { status: 415 },
    );
  }

  const audio = await req.arrayBuffer();
  if (audio.byteLength === 0) {
    return NextResponse.json({ error: 'Empty audio' }, { status: 400 });
  }
  if (audio.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: 'Audio too large' }, { status: 413 });
  }

  const endpoint =
    `https://${region}.stt.speech.microsoft.com` +
    `/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=mn-MN&format=detailed&profanity=raw`;

  try {
    const azure = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        // Azure needs the CODEC and SAMPLE RATE spelled out for WAV, not just
        // the container — a bare `audio/wav` is rejected as unsupported.
        'Content-Type': contentType.startsWith('audio/ogg')
          ? 'audio/ogg; codecs=opus'
          : 'audio/wav; codecs=audio/pcm; samplerate=16000',
        Accept: 'application/json',
      },
      body: audio,
      signal: AbortSignal.timeout(15_000),
    });

    if (!azure.ok) {
      const detail = await azure.text().catch(() => '');
      console.error('[stt] azure error', azure.status, detail.slice(0, 300));
      return NextResponse.json(
        { error: 'Recognition failed' },
        { status: azure.status === 401 || azure.status === 403 ? 502 : 502 },
      );
    }

    const data = (await azure.json()) as {
      RecognitionStatus?: string;
      DisplayText?: string;
      NBest?: Array<{ Display?: string; Lexical?: string; ITN?: string; Confidence?: number }>;
    };

    if (data.RecognitionStatus !== 'Success') {
      return NextResponse.json({ transcript: '', confidence: 0, alternatives: [] });
    }

    /**
     * EVERY alternative is returned, not just the first.
     *
     * The recognizer is transcribing a proper noun that is not in its language
     * model, so its ranking between near-homophones is close to arbitrary — but
     * only one of them is a real stop name, and stops.json knows which. Ranking
     * is preserved in array order so the client can penalize lower ones; see
     * ALTERNATIVE_PENALTY in lib/ui/stop-search.ts.
     *
     * Both spellings of each entry go in. Lexical carries no punctuation or
     * capitalization and so normalizes more cleanly, while Display is the one
     * that survives `stopKey()` intact when the name contains a numeral. They
     * usually collapse to the same key, and the client dedupes on that rather
     * than letting one spelling take two ranks.
     */
    const alternatives: string[] = [];
    for (const entry of data.NBest ?? []) {
      for (const form of [entry.Display, entry.Lexical, entry.ITN]) {
        const text = form?.trim();
        if (text && !alternatives.includes(text)) alternatives.push(text);
      }
    }
    const fallback = data.DisplayText?.trim();
    if (alternatives.length === 0 && fallback) alternatives.push(fallback);

    const best = data.NBest?.[0];
    return NextResponse.json({
      transcript: best?.Display ?? data.DisplayText ?? '',
      confidence: best?.Confidence ?? 0.5,
      alternatives,
    });
  } catch (e) {
    console.error('[stt] proxy failure', e);
    return NextResponse.json({ error: 'Recognition failed' }, { status: 502 });
  }
}
