"""
Record review verdicts by their number on a score.py sheet.

    uv run python label.py v0 pos 1 2 3 ... [--note "..."]
    uv run python label.py v0 neg 26 28
    uv run python label.py v0 ask 9 --note "HITSTAR"

pos -> data/labels/positives.txt, neg -> negatives.txt, ask -> ask_rick.txt
(the ones Rick has to decide). Numbers are the global ones on the sheets.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILES = {"pos": "positives.txt", "neg": "negatives.txt", "ask": "ask_rick.txt"}


def main():
    args = sys.argv[1:]
    note = ""
    if "--note" in args:
        at = args.index("--note")
        note = args[at + 1]
        args = args[:at] + args[at + 2 :]
    run, kind, numbers = args[0], args[1], [int(n) for n in args[2:]]
    review = json.loads((ROOT / "data" / "review" / run / "review.json").read_text())
    path = ROOT / "data" / "labels" / FILES[kind]
    existing = path.read_text() if path.exists() else ""
    with open(path, "a") as f:
        for n in numbers:
            name = review[n - 1]
            if name not in existing:
                f.write(f"{name}  # {run} sheet #{n}{' ' + note if note else ''}\n")
    print(f"{len(numbers)} -> {path.name}")


if __name__ == "__main__":
    main()
