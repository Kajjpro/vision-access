#!/usr/bin/env python3
"""
YOLOE with a fixed 32-class Mongolian obstacle vocabulary: validate, then export
for onnxruntime-web.

    python3 model/yoloe_export.py --source 0 --frames 120
    python3 model/yoloe_export.py --source samples/ --export
    python3 model/yoloe_export.py --export --no-run          # export only

The vocabulary is set ONCE, here, at export time -- not per frame and not in the
browser. get_text_pe() runs MobileCLIP's text encoder over the class prompts and
set_classes() bakes the resulting embeddings into the detection head. What comes
out of export() is therefore an ordinary closed-set detector with a single image
input: no text encoder, no second input, nothing open-vocabulary left at
runtime. That is the only form that fits the app's 60ms frame budget.

Latency printed here is a sanity check on the MODEL, not a prediction for the
target. The target is mobile Safari on WebGPU; a PyTorch number from a Mac says
nothing about it. The number that matters comes from the phone. What this script
is genuinely good for is the per-class hit table at the end, which shows which
of the 32 classes ever fire at all before you spend an hour shipping 50 MB to a
device.
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
DEFAULT_CLASSES = REPO / "model" / "classes.txt"
DEFAULT_MODEL = "yoloe-11s-seg.pt"

# The worker letterboxes to 640 and hardcodes it; changing this means changing
# INPUT_SIZE in lib/vision.worker.ts too.
DEFAULT_IMGSZ = 640

# onnxruntime-web 1.27 is comfortable well past this, but 17 is the widest
# intersection with older mobile Safari builds and costs nothing.
ONNX_OPSET = 17


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Set a fixed YOLOE vocabulary, measure it, export it to ONNX.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--classes", type=Path, default=DEFAULT_CLASSES,
                   help="class list, one 'id = prompt' per line")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help="YOLOE checkpoint; downloads on first use")
    p.add_argument("--source", default="0",
                   help="webcam index, image file, directory, or video file")
    p.add_argument("--device", default=None,
                   help="cuda / mps / cpu (default: let ultralytics choose)")
    p.add_argument("--imgsz", type=int, default=DEFAULT_IMGSZ)
    p.add_argument("--conf", type=float, default=0.4,
                   help="matches CONFIDENCE_THRESHOLD in lib/vision.worker.ts")
    p.add_argument("--frames", type=int, default=100,
                   help="stop after this many frames (0 = run the source to exhaustion)")
    p.add_argument("--export", action="store_true", help="write an ONNX export afterwards")
    p.add_argument("--keep-masks", action="store_true",
                   help="leave the segmentation outputs in the export (see strip_segmentation)")
    p.add_argument("--no-run", action="store_true", help="skip inference; useful with --export")
    return p.parse_args()


def load_classes(path: Path) -> tuple[list[str], list[str]]:
    """
    Returns (ids, prompts) in file order. Line order is the ONNX class index
    order, so this must never be reordered or filtered.

    `id` is the wav filename in public/audio and the name baked into the ONNX
    metadata; `prompt` is what the text encoder sees. They differ deliberately --
    "hole" embeds terribly, "pothole in the road" does not.
    """
    if not path.exists():
        sys.exit(f"No class list at {path}\nGenerate it:  npx tsx scripts/export-classes.ts")

    ids: list[str] = []
    prompts: list[str] = []

    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            ident, _, prompt = line.partition("=")
            ident, prompt = ident.strip(), prompt.strip()
        else:
            # Plain 'one class per line' also works; the id doubles as the prompt.
            ident = prompt = line
        if not ident or not prompt:
            sys.exit(f"{path}:{lineno}: malformed line: {raw!r}")
        ids.append(ident)
        prompts.append(prompt)

    if not ids:
        sys.exit(f"{path} has no classes.")

    dupes = [i for i, n in Counter(ids).items() if n > 1]
    if dupes:
        sys.exit(f"{path}: duplicate ids {dupes} -- class indices would be ambiguous.")

    return ids, prompts


def build_model(checkpoint: str, ids: list[str], prompts: list[str]):
    """
    Load YOLOE and freeze the vocabulary into it. This is the expensive step --
    it pulls MobileCLIP -- and it happens exactly once.
    """
    try:
        from ultralytics import YOLOE
    except ImportError:
        sys.exit(
            "ultralytics is not installed.\n"
            "  python3 -m venv model/.venv && source model/.venv/bin/activate\n"
            "  pip install -r model/requirements.txt"
        )

    print(f"loading {checkpoint} ...", flush=True)
    model = YOLOE(checkpoint)

    print(f"embedding {len(prompts)} class prompts (MobileCLIP text encoder) ...", flush=True)
    started = time.perf_counter()
    text_pe = model.get_text_pe(prompts)
    model.set_classes(prompts, text_pe)
    elapsed = (time.perf_counter() - started) * 1000
    print(f"vocabulary set in {elapsed:.0f}ms -- once, not per frame")

    # set_classes names the classes after the PROMPTS. Rename to the stable ids
    # so the ONNX metadata carries "hole", matching public/audio/hole.wav, rather
    # than "pothole in the road".
    model.model.names = {i: ident for i, ident in enumerate(ids)}
    if hasattr(model, "predictor") and model.predictor is not None:
        model.predictor = None  # force a rebuild so the rename takes effect

    return model


def run_inference(model, args, ids: list[str]) -> None:
    """Stream the source, print per-frame latency, and tally which classes fire."""
    print(f"\nsource={args.source}  imgsz={args.imgsz}  conf={args.conf}")
    print(f"{'frame':>5}  {'pre':>7}  {'infer':>7}  {'post':>7}  {'total':>7}   detections")
    print("-" * 78)

    totals: list[float] = []
    hits: Counter[str] = Counter()
    frames = 0

    stream = model.predict(
        source=args.source,
        imgsz=args.imgsz,
        conf=args.conf,
        device=args.device,
        stream=True,
        verbose=False,
    )

    try:
        for result in stream:
            # Ultralytics reports these in ms, already split by stage.
            speed = result.speed
            pre = speed.get("preprocess", 0.0)
            inf = speed.get("inference", 0.0)
            post = speed.get("postprocess", 0.0)
            total = pre + inf + post

            names = [ids[int(c)] for c in result.boxes.cls.tolist()] if result.boxes else []
            hits.update(names)
            totals.append(total)
            frames += 1

            summary = ", ".join(sorted(set(names))) if names else "-"
            print(f"{frames:>5}  {pre:>6.1f}m  {inf:>6.1f}m  {post:>6.1f}m  {total:>6.1f}m   {summary}")

            if args.frames and frames >= args.frames:
                break
    except KeyboardInterrupt:
        print("\ninterrupted")

    if not totals:
        print("\nNo frames processed -- check --source.")
        return

    report_latency(totals)
    report_class_hits(ids, hits, frames)


def report_latency(totals: list[float]) -> None:
    ordered = sorted(totals)
    p50 = statistics.median(ordered)
    p90 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.90))]

    print(f"\n{len(totals)} frames   p50 {p50:.1f}ms   p90 {p90:.1f}ms   "
          f"max {ordered[-1]:.1f}ms   ~{1000 / p50:.1f} FPS")
    print("This is PyTorch on this machine. The app's 60ms budget is mobile Safari")
    print("on WebGPU -- expect a different, usually worse, number there.")


def report_class_hits(ids: list[str], hits: Counter, frames: int) -> None:
    """
    The useful output. A class that never fires across a representative source is
    a class the user will never hear, no matter how good the wav file is.
    """
    print(f"\nper-class hits over {frames} frames")
    print("-" * 78)
    fired = [(ident, hits[ident]) for ident in ids if hits[ident]]
    silent = [ident for ident in ids if not hits[ident]]

    for ident, count in sorted(fired, key=lambda kv: -kv[1]):
        print(f"  {ident:<16} {count:>5}")
    if not fired:
        print("  (nothing detected)")

    if silent:
        print(f"\nnever fired ({len(silent)}/{len(ids)}):")
        print("  " + ", ".join(silent))
        print("\nGround hazards (hole, puddle, ice, curb) and 'stuff' classes (wall,")
        print("fence, bridge) are the expected members of this list -- they are surface")
        print("regions, not objects, and detection pretraining has few boxed examples.")
        print("A class silent on a representative source should be cut or handled another way.")


def export_onnx(model, args, ids: list[str]) -> Path | None:
    print(f"\nexporting ONNX (imgsz={args.imgsz}, opset={ONNX_OPSET}, fp32, static) ...", flush=True)
    exported = Path(model.export(
        format="onnx",
        imgsz=args.imgsz,
        opset=ONNX_OPSET,
        simplify=True,
        # The worker allocates one fixed 640x640 planar buffer and letterboxes
        # into it, so a dynamic axis would buy nothing and cost shape inference.
        dynamic=False,
        # NMS stays in JS -- lib/vision.worker.ts does per-class greedy NMS and
        # needs raw boxes to map back through the letterbox transform.
        nms=False,
        # fp32: onnxruntime-web's wasm fallback has no fp16 path, and the worker
        # decodes into a Float32Array.
        device="cpu",
    ))

    # export() writes beside the checkpoint, which ultralytics downloaded into
    # the cwd. Keep build artefacts in model/ so .gitignore can cover them.
    path = REPO / "model" / exported.name
    if exported.resolve() != path.resolve():
        exported.replace(path)

    size_mb = path.stat().st_size / 1024 / 1024
    print(f"{path}  ({size_mb:.1f} MB)")

    if not args.keep_masks:
        # Kept alongside the stripped file only long enough to diff against it.
        reference = path.with_name(f"{path.stem}.unstripped.onnx")
        reference.write_bytes(path.read_bytes())

        print("\nstripping segmentation outputs ...")
        if strip_segmentation(path, len(ids)):
            if verify_strip(reference, path, args.imgsz, 4 + len(ids)):
                stripped_mb = path.stat().st_size / 1024 / 1024
                print(f"  {size_mb:.1f} MB -> {stripped_mb:.1f} MB")
                reference.unlink()
            else:
                # Put the known-good export back rather than shipping a file
                # whose boxes have quietly moved.
                reference.replace(path)
                print("  reverted to the unstripped export")
        else:
            reference.unlink()

    inspect_export(path, ids)
    return path


def strip_segmentation(path: Path, num_classes: int) -> bool:
    """
    Turn the seg export into a plain detector, in place.

    Every published YOLOE checkpoint is a -seg variant, so export() gives:

        output0  [1, 4 + nc + 32, 8400]   boxes, scores, 32 mask coefficients
        output1  [1, 32, 160, 160]        mask prototypes

    The app draws boxes and speaks names; it has no use for either mask tensor.
    Left in place they cost real time on a phone -- output1 alone is 819k floats
    read back off the GPU on every single frame, and the prototype branch that
    produces it is convolution at 160x160.

    So: slice output0 down to 4 + nc, drop output1 from the graph outputs, and
    let onnxslim dead-code-eliminate the now-unreachable prototype branch. The
    result matches exactly what lib/vision.worker.ts already expects, which is
    why the worker needs no change to consume it.

    Returns False and leaves the file untouched if anything is unexpected --
    a wrong graph edit here would be far worse than a slow model.
    """
    import onnx
    from onnx import TensorProto, helper

    keep = 4 + num_classes
    model = onnx.load(str(path))
    graph = model.graph

    names = [o.name for o in graph.output]
    if names != ["output0", "output1"]:
        print(f"  skipping strip: outputs are {names}, expected ['output0', 'output1']")
        return False

    # Rename the producer's edge so "output0" is free for the sliced tensor.
    # Every downstream consumer must follow, or the graph silently splits in two.
    renamed = False
    for node in graph.node:
        for i, out in enumerate(node.output):
            if out == "output0":
                node.output[i] = "output0_full"
                renamed = True
        for i, inp in enumerate(node.input):
            if inp == "output0":
                node.input[i] = "output0_full"
    if not renamed:
        print("  skipping strip: no node produces output0")
        return False

    def const(name: str, value: int):
        return helper.make_tensor(name, TensorProto.INT64, [1], [value])

    graph.initializer.extend([
        const("det_slice_starts", 0),
        const("det_slice_ends", keep),
        const("det_slice_axes", 1),
    ])
    # Appended last, which is topologically valid: it only consumes a tensor
    # produced by an earlier node.
    graph.node.append(helper.make_node(
        "Slice",
        inputs=["output0_full", "det_slice_starts", "det_slice_ends", "det_slice_axes"],
        outputs=["output0"],
        name="det_head_slice",
    ))

    anchors = graph.output[0].type.tensor_type.shape.dim[2].dim_value
    del graph.output[:]
    graph.output.append(helper.make_tensor_value_info(
        "output0", TensorProto.FLOAT, [1, keep, anchors or 8400]
    ))

    onnx.checker.check_model(model)
    onnx.save(model, str(path))

    # Slimming is what actually deletes the prototype branch; without it the
    # nodes stay and still execute.
    try:
        import onnxslim
        onnxslim.slim(str(path), str(path))
    except Exception as e:
        print(f"  onnxslim failed ({e}); graph is correct but still carries dead nodes")

    return True


def verify_strip(original: Path, stripped: Path, imgsz: int, keep: int) -> bool:
    """
    Prove the surgery changed nothing that matters: same input, and the stripped
    output0 must equal the original's first `keep` channels. Graph edits that
    look right and silently shift boxes are exactly the failure this app cannot
    afford, so it is checked rather than assumed.
    """
    import numpy as np
    import onnxruntime as ort

    rng = np.random.default_rng(0)
    x = rng.random((1, 3, imgsz, imgsz), dtype=np.float32)

    def run(p: Path):
        s = ort.InferenceSession(str(p), providers=["CPUExecutionProvider"])
        return s.run(None, {s.get_inputs()[0].name: x})[0]

    before = run(original)[:, :keep, :]
    after = run(stripped)

    if before.shape != after.shape:
        print(f"  VERIFY FAILED: {before.shape} vs {after.shape}")
        return False

    delta = float(np.abs(before - after).max())
    ok = delta < 1e-4
    print(f"  verified against the unstripped export: max delta {delta:.2e} "
          f"{'OK' if ok else 'FAILED'}")
    return ok


def inspect_export(path: Path, ids: list[str]) -> None:
    """
    Print the tensor signature and check it against what lib/vision.worker.ts
    actually decodes. This catches the failure that is otherwise silent: every
    published YOLOE checkpoint is a -seg variant, and a seg export appends 32
    mask coefficients to output0. The worker computes numClasses = channels - 4,
    so 4+32+32 channels reads as 64 classes, matches no known class list, and
    classNamesFor() returns [] -- every obstacle is then announced as a bare
    distance with no name, forever, with no error anywhere.
    """
    try:
        import onnxruntime as ort
    except ImportError:
        print("\n(install onnxruntime to have this script verify the export)")
        return

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])

    print("\nINPUTS")
    for value in session.get_inputs():
        print(f"  {value.name:<12} {value.type:<16} {value.shape}")
    print("OUTPUTS")
    for value in session.get_outputs():
        print(f"  {value.name:<12} {value.type:<16} {value.shape}")

    if len(session.get_inputs()) > 1:
        print("\nWARNING: more than one input -- the text encoder was not folded in.")
        print("The worker feeds exactly one tensor. Re-check set_classes().")

    shape = session.get_outputs()[0].shape
    if len(shape) != 3:
        print(f"\nWARNING: output0 is {shape}; the worker expects [1, 4+classes, anchors].")
        return

    channels = shape[1]
    n = len(ids)
    if not isinstance(channels, int):
        print(f"\noutput0 channel dim is symbolic ({channels!r}) -- cannot verify statically.")
    elif channels == 4 + n:
        print(f"\nOK: output0 has {channels} channels = 4 + {n} classes.")
        print("lib/vision.worker.ts decodes this as-is.")
    elif channels == 4 + n + 32:
        print(f"\nSEGMENTATION EXPORT: output0 has {channels} channels = 4 + {n} + 32 mask coeffs.")
        print("lib/vision.worker.ts will compute numClasses = channels - 4 = "
              f"{channels - 4}, match no class list, and announce every detection")
        print("WITHOUT A NAME. Fix the worker before shipping this file:")
        print()
        print(f"  const numClasses = DETECTION_CLASSES.length;   // {n}, not channels - 4")
        print()
        print("Boxes and scores are still correct; only the trailing mask")
        print("coefficients need ignoring.")
    else:
        print(f"\nWARNING: output0 has {channels} channels; expected {4 + n} "
              f"(detect) or {4 + n + 32} (seg) for {n} classes.")


def main() -> None:
    args = parse_args()

    # ultralytics downloads checkpoints and MobileCLIP into the CURRENT directory,
    # and MobileCLIP arrives as `mobileclip_blt.ts` -- a 572 MB TorchScript file
    # with a TypeScript extension. Dropped in the repo root it matches tsconfig's
    # `**/*.ts` include and breaks `tsc` outright. Working from model/ keeps every
    # build artefact in one gitignored, tsconfig-excluded place.
    args.classes = args.classes.resolve()
    if args.source and Path(args.source).exists():
        args.source = str(Path(args.source).resolve())
    os.chdir(REPO / "model")

    ids, prompts = load_classes(args.classes)
    print(f"{args.classes}: {len(ids)} classes")

    model = build_model(args.model, ids, prompts)

    if not args.no_run:
        run_inference(model, args, ids)

    if args.export:
        export_onnx(model, args, ids)
        print(f"\nCopy it to public/models/ and bump MODEL_CACHE in lib/vision.worker.ts,")
        print("or the phone will keep serving the old bytes out of Cache Storage.")


if __name__ == "__main__":
    main()
