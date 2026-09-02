#!/usr/bin/env python3
"""
Export a COCO-pretrained YOLO detector for onnxruntime-web.

    python3 model/coco_export.py                       # export yolo11s
    python3 model/coco_export.py --model yolo11n.pt    # smaller, weaker
    python3 model/coco_export.py --source samples/ --frames 200

WHY THIS REPLACED yoloe_export.py
---------------------------------
That script bakes a Mongolian obstacle vocabulary into YOLOE as CLIP text
embeddings, which produces a detector that LOOKS like it knows 25 classes and
measurably knows about 12 of them. From lib/phrases.ts, peak scores on real
photos:

    bus 0.95   person 0.94   dog 0.49          <- COCO-trained
    trash_can 0.14   tree 0.04   pole <0.02    <- text prompt only

Against a 0.30 threshold the second row never fires. Zero-shot detection is
real, but it is not free accuracy: a class the backbone never saw a labelled
box for stays at noise no matter how good the prompt is.

This script ships the first row instead. Every class in a COCO checkpoint has
tens of thousands of human-drawn boxes behind it, which is what "sure it is a
person" actually requires. lib/coco.ts maps the 80 COCO names onto the 12
phrase ids the app has audio for and drops the rest.

The 13 classes lost in the swap (pole, tree, wall, fence, door, stairs,
trash_can, curb, scaffolding, cable, hole, ice, rock) were never detected, so
nothing the user could hear changed. Winning them back is a DATA problem:
an Objects365 or LVIS checkpoint (both contain poles and bins), or a few
thousand hand-labelled UB street photos. Not a threshold, and not a prompt.

OUTPUT CONTRACT
---------------
lib/vision.worker.ts decodes output0 as [1, 4 + numClasses, anchors], derives
numClasses from the channel count, and does its own letterboxing and NMS. A
stock ultralytics detection export matches that exactly, which is why nothing
in the worker's decode path had to change. This script verifies it rather than
assuming it.
"""
from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# yolo11s: 9.4M params, COCO mAP50-95 47.0, ~38 MB as fp32 ONNX.
#
# Chosen to be the SAME download the app already pays for (the YOLOE export is
# 37.3 MB), so the accuracy comes free of any regression on mobile data.
# yolo11n is 2.6M params and ~10 MB, at mAP 39.5 — a quarter of the size for
# roughly a fifth less accuracy, and worth measuring if the download is what
# hurts. Anything above 's' (yolo11m is 20M params, ~80 MB) is not a phone-over-
# mobile-data model.
DEFAULT_MODEL = "yolo11s.pt"

# The worker letterboxes to 640 and hardcodes it; changing this means changing
# INPUT_SIZE in lib/vision.worker.ts too.
DEFAULT_IMGSZ = 640

# onnxruntime-web 1.27 is comfortable well past this, but 17 is the widest
# intersection with older mobile Safari builds and costs nothing.
ONNX_OPSET = 17

# Must match COCO_CLASSES in lib/coco.ts, in this order. Checked, not trusted:
# the position in this list is the ONNX class id, and a checkpoint whose names
# disagree would rename every detection to something else — silently, and out
# loud, to someone who cannot look up and see that it is wrong.
EXPECTED_NAMES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush",
]

# The subset lib/coco.ts actually announces. Reported separately at the end,
# because a per-class hit table over 80 classes buries the 13 that matter.
ANNOUNCED = [
    "person", "dog", "cat", "horse", "cow",
    "car", "bus", "truck", "motorcycle", "bicycle",
    "bench", "chair", "dining table",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Export a COCO-pretrained YOLO detector to ONNX for the browser.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--model", default=DEFAULT_MODEL, help="checkpoint; downloads on first use")
    p.add_argument("--imgsz", type=int, default=DEFAULT_IMGSZ)
    p.add_argument("--opset", type=int, default=ONNX_OPSET)
    p.add_argument("--source", default=None,
                   help="webcam index, image, directory or video to measure first")
    p.add_argument("--frames", type=int, default=100, help="stop after this many frames")
    p.add_argument("--conf", type=float, default=0.3,
                   help="matches CONFIDENCE_THRESHOLD in lib/vision.worker.ts")
    p.add_argument("--device", default=None, help="cuda / mps / cpu")
    p.add_argument("--no-export", action="store_true", help="measure only")
    return p.parse_args()


def load(checkpoint: str):
    try:
        from ultralytics import YOLO
    except ImportError:
        sys.exit(
            "ultralytics is not installed.\n"
            "  python3 -m venv model/.venv && source model/.venv/bin/activate\n"
            "  pip install -r model/requirements.txt"
        )

    print(f"loading {checkpoint} ...", flush=True)
    model = YOLO(checkpoint)

    names = [model.names[i] for i in sorted(model.names)]
    if names != EXPECTED_NAMES:
        # Not a warning. A checkpoint with a different vocabulary produces boxes
        # that decode fine and are labelled wrongly, which is the exact failure
        # this app cannot ship: a confident wrong noun spoken to someone who
        # cannot check it.
        extra = set(names) - set(EXPECTED_NAMES)
        missing = set(EXPECTED_NAMES) - set(names)
        sys.exit(
            f"\n{checkpoint} is not a COCO-80 checkpoint.\n"
            f"  {len(names)} classes, expected {len(EXPECTED_NAMES)}\n"
            f"  unexpected: {sorted(extra) or '-'}\n"
            f"  missing:    {sorted(missing) or '-'}\n"
            "Update COCO_CLASSES in lib/coco.ts and EXPECTED_NAMES here together,\n"
            "or the app will announce every object as some other object."
        )

    print(f"COCO-80 vocabulary verified against lib/coco.ts")
    return model


def measure(model, args) -> None:
    """Per-class hit table. Which classes actually fire beats any mAP number."""
    print(f"\nsource={args.source}  imgsz={args.imgsz}  conf={args.conf}")
    totals: list[float] = []
    hits: Counter[str] = Counter()
    frames = 0

    stream = model.predict(source=args.source, imgsz=args.imgsz, conf=args.conf,
                           device=args.device, stream=True, verbose=False)
    try:
        for result in stream:
            speed = result.speed
            totals.append(sum(speed.get(k, 0.0) for k in ("preprocess", "inference", "postprocess")))
            if result.boxes is not None:
                hits.update(model.names[int(c)] for c in result.boxes.cls.tolist())
            frames += 1
            if args.frames and frames >= args.frames:
                break
    except KeyboardInterrupt:
        print("\ninterrupted")

    if not totals:
        print("No frames processed — check --source.")
        return

    ordered = sorted(totals)
    print(f"\n{frames} frames   p50 {statistics.median(ordered):.1f}ms   "
          f"p90 {ordered[min(len(ordered) - 1, int(len(ordered) * 0.9))]:.1f}ms")
    print("PyTorch on this machine. The app's 60ms budget is mobile Safari on")
    print("WebGPU — expect a different, usually worse, number there.")

    print(f"\nannounced classes (the {len(ANNOUNCED)} in lib/coco.ts)")
    print("-" * 60)
    for name in ANNOUNCED:
        print(f"  {name:<16} {hits[name]:>5}")

    other = [(n, c) for n, c in hits.most_common() if n not in ANNOUNCED]
    if other:
        print("\ndetected but NOT announced (dropped by COCO_TO_PHRASE):")
        print("  " + ", ".join(f"{n}×{c}" for n, c in other[:15]))


def export(model, args) -> Path:
    print(f"\nexporting ONNX (imgsz={args.imgsz}, opset={args.opset}, fp32, static) ...", flush=True)
    started = time.perf_counter()
    exported = Path(model.export(
        format="onnx",
        imgsz=args.imgsz,
        opset=args.opset,
        simplify=True,
        # The worker allocates one fixed 640x640 planar buffer and letterboxes
        # into it, so a dynamic axis would buy nothing and cost shape inference.
        dynamic=False,
        # NMS stays in JS — lib/vision.worker.ts does per-class greedy NMS and
        # needs raw boxes to map back through its own letterbox transform.
        nms=False,
        # fp32: onnxruntime-web's wasm fallback has no fp16 kernels, and the
        # worker decodes into a Float32Array.
        half=False,
        device="cpu",
    ))
    print(f"exported in {time.perf_counter() - started:.1f}s")

    path = REPO / "model" / exported.name
    if exported.resolve() != path.resolve():
        exported.replace(path)
    return path


def verify(path: Path) -> bool:
    """
    Check the tensor signature against what lib/vision.worker.ts decodes.

    This is not ceremony. The worker computes numClasses = channels - 4 and
    looks the count up in classNamesFor(); a shape it does not recognise
    produces boxes with NO NAMES, forever, with no error anywhere — every
    obstacle announced as a bare distance. Cheaper to catch here.
    """
    try:
        import onnxruntime as ort
    except ImportError:
        print("\n(install onnxruntime to have this script verify the export)")
        return True

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])

    print("\nINPUTS")
    for value in session.get_inputs():
        print(f"  {value.name:<10} {value.type:<16} {value.shape}")
    print("OUTPUTS")
    for value in session.get_outputs():
        print(f"  {value.name:<10} {value.type:<16} {value.shape}")

    if len(session.get_inputs()) != 1:
        print("\nFAILED: the worker feeds exactly one tensor.")
        return False
    if len(session.get_outputs()) != 1:
        print("\nFAILED: extra outputs. A -seg checkpoint was used; this needs a detect one.")
        return False

    shape = session.get_outputs()[0].shape
    expected = 4 + len(EXPECTED_NAMES)
    if len(shape) != 3 or shape[1] != expected:
        print(f"\nFAILED: output0 is {shape}, expected [1, {expected}, anchors].")
        return False

    print(f"\nOK: output0 has {expected} channels = 4 + {len(EXPECTED_NAMES)} classes.")
    print("lib/vision.worker.ts decodes this as-is; classNamesFor(80) returns COCO_CLASSES.")
    return True


def main() -> None:
    args = parse_args()

    # ultralytics downloads checkpoints into the CURRENT directory. Working from
    # model/ keeps every build artefact in one gitignored, tsconfig-excluded
    # place — the repo root is worse than untidy, because MobileCLIP arrives as
    # `mobileclip_blt.ts` and breaks `tsc` outright.
    if args.source and Path(args.source).exists():
        args.source = str(Path(args.source).resolve())
    os.chdir(REPO / "model")

    model = load(args.model)

    if args.source:
        measure(model, args)

    if args.no_export:
        return

    path = export(model, args)
    size_mb = path.stat().st_size / 1024 / 1024
    print(f"\n{path}  ({size_mb:.1f} MB)")

    if not verify(path):
        sys.exit("export did not match the worker's contract; not shipping it.")

    print("\nNext:")
    print(f"  cp {path} public/models/{path.name}")
    print(f"  # then in lib/vision.worker.ts: MODEL_URL = \"/models/{path.name}\"")
    print("  # and BUMP MODEL_CACHE, or phones keep serving the old bytes from Cache Storage.")


if __name__ == "__main__":
    main()
