#!/usr/bin/env python3
"""Render one line of Mongolian to a WAV with facebook/mms-tts-mon.

Called per clip by lib/tts/providers/mms.ts. Build-time only, CPU, offline
after the model is cached locally by transformers.

    python3 -m venv .venv-tts
    .venv-tts/bin/pip install torch transformers scipy

MMS is CC-BY-NC 4.0 — non-commercial use only. See CLAUDE.md.
"""
import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="facebook/mms-tts-mon")
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        import torch
        from scipy.io import wavfile
        from transformers import VitsModel, AutoTokenizer
    except ImportError as e:
        print(f"missing dependency: {e}", file=sys.stderr)
        print(
            "install once: python3 -m venv .venv-tts && "
            ".venv-tts/bin/pip install torch transformers scipy",
            file=sys.stderr,
        )
        return 2

    # Loaded per invocation. Slow, but this provider is a fallback that renders
    # a few hundred clips once, not a hot path — and a resident server process
    # would be another thing to supervise.
    model = VitsModel.from_pretrained(args.model)
    tokenizer = AutoTokenizer.from_pretrained(args.model)

    inputs = tokenizer(args.text, return_tensors="pt")
    with torch.no_grad():
        waveform = model(**inputs).waveform

    audio = waveform.squeeze().cpu().numpy()
    # VITS emits float in [-1, 1]; the rest of the pipeline expects 16-bit PCM.
    import numpy as np

    pcm = np.clip(audio, -1.0, 1.0)
    pcm = (pcm * 32767).astype(np.int16)
    wavfile.write(args.out, model.config.sampling_rate, pcm)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
