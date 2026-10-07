"""
What the Python pipeline answers for a fixed set of pictures, for
node/parity.ts to compare against: preprocess.load + the ONNX model on
onnxruntime. Half held-out uploads (transparent logos included), half
positives.

    uv run python parity_ref.py runs/v1/hitster.onnx   # writes data/parity.json
"""

import json
import random
import sys
from pathlib import Path

import onnxruntime as ort

import synth
from preprocess import load

ROOT = Path(__file__).resolve().parent


def main():
    model = sys.argv[1]
    groups = synth.uploads()
    rng = random.Random(11)
    logos = [p for p in groups["eval"] if "/logo/" in p and p.endswith(".png")]
    paths = rng.sample(logos, min(30, len(logos))) + rng.sample(groups["eval"], 45) + rng.sample(groups["positives"], 75)
    session = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    rows = []
    for path in paths:
        probs = session.run(None, {"image": load(path)[None]})[0][0]
        rows.append({"path": path, "maxima": [float(probs[c].max()) for c in range(probs.shape[0])]})
    out = ROOT / "data" / "parity.json"
    out.write_text(json.dumps({"model": str(Path(model).resolve()), "rows": rows}))
    print(f"{len(rows)} pictures -> {out}")


if __name__ == "__main__":
    main()
