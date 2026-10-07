"""
Take in new labels: continue training from an earlier model, export it and
score every upload with it, so the browse page (node/server.ts) can show it.

    uv run python retrain.py --from v1 --name v2            # ~15 minutes, 1500 steps
    uv run python retrain.py --from v1 --name v2 --steps 6000   # a full run, ~50 minutes

Labels are read when training starts: the verdicts given on the browse page
(data/labels/labels_ui.txt) and every other label file. One training at a
time: two at once do not fit in the Mac's memory.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV = {
    **{k: v for k, v in os.environ.items() if k != "PYTHONPATH"},
    "PYTORCH_ENABLE_MPS_FALLBACK": "1",
    "PYTORCH_MPS_HIGH_WATERMARK_RATIO": "0.6",
    "PYTORCH_MPS_LOW_WATERMARK_RATIO": "0.5",
}


def run(*args):
    print("$", " ".join(args), flush=True)
    subprocess.run([sys.executable, *args], cwd=ROOT, env=ENV, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="start", required=True, help="run to continue from, e.g. v1")
    parser.add_argument("--name", required=True, help="name of the new run, e.g. v2")
    parser.add_argument("--steps", type=int, default=1500)
    parser.add_argument("--lr", type=float, default=2e-4)
    args = parser.parse_args()

    start = ROOT / "runs" / args.start / "last.pt"
    if not start.exists():
        sys.exit(f"no checkpoint at {start}")
    if (ROOT / "runs" / args.name).exists():
        sys.exit(f"runs/{args.name} exists already: pick another name")
    (ROOT / "runs" / args.name).mkdir(parents=True)

    run(
        "train.py", "--name", args.name, "--init", str(start), "--steps", str(args.steps), "--lr", str(args.lr),
        "--eval-every", str(args.steps), "--weak", "data/labels/weak_web.txt", "--seed", str(abs(hash(args.name)) % 1000),
    )
    run("export.py", f"runs/{args.name}/last.pt")
    run("score.py", f"runs/{args.name}/last.pt", "--top", "180")
    print(f"done: pick {args.name} on http://localhost:5197/browse")


if __name__ == "__main__":
    main()
