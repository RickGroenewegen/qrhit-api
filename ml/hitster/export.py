"""
Export a checkpoint to ONNX, check that ONNX Runtime answers what PyTorch
answers, and time it on one CPU core and on four.

    uv run python export.py runs/v1/last.pt

Writes hitster.onnx (float32) next to the checkpoint. Input "image"
(1, 3, SIZE, SIZE), output "probs" (1, classes, SIZE/16, SIZE/16).

8-bit static quantisation (onnxruntime.quantization, QDQ) was tried on v0 and
dropped: it flipped more than half the verdicts, also with the head kept in
float. For a browser download, float16 weights are the next thing to try.
"""

import argparse
import random
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

import synth
from model import Detector, Exported
from preprocess import SIZE, load


def session(path, threads):
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def timing(path, threads, runs=20):
    s = session(path, threads)
    x = np.random.default_rng(0).standard_normal((1, 3, SIZE, SIZE), dtype=np.float32)
    s.run(None, {"image": x})
    started = time.perf_counter()
    for _ in range(runs):
        s.run(None, {"image": x})
    return (time.perf_counter() - started) / runs * 1000


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint")
    args = parser.parse_args()

    fp32 = Path(args.checkpoint).parent / "hitster.onnx"

    detector = Detector(pretrained=False)
    detector.load_state_dict(torch.load(args.checkpoint, map_location="cpu", weights_only=True)["model"])
    model = Exported(detector).eval()
    example = torch.zeros(1, 3, SIZE, SIZE)
    torch.onnx.export(
        model, example, str(fp32), input_names=["image"], output_names=["probs"], opset_version=17, dynamo=False,
    )

    groups = synth.uploads()
    rng = random.Random(3)
    check = rng.sample(groups["eval"], 24) + groups["positives"]
    with torch.no_grad():
        torch_out = [model(torch.from_numpy(load(p))[None]).numpy() for p in check]
    s = session(fp32, 4)
    onnx_out = [s.run(None, {"image": load(p)[None]})[0] for p in check]
    diff = max(float(np.abs(a - b).max()) for a, b in zip(torch_out, onnx_out))
    print(f"float32: {fp32.stat().st_size / 1e6:.1f} MB, max |onnx - torch| = {diff:.2e}")

    print(f"  {timing(fp32, 1):.0f} ms on 1 thread, {timing(fp32, 4):.0f} ms on 4")


if __name__ == "__main__":
    main()
