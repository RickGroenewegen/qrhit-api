"""
Score every downloaded upload with a checkpoint and list the most
Hitster-looking ones, for labelling: data/review/<run>/ranking.tsv and contact
sheets of the top N not yet labelled, each tile with the cells that lit up
outlined.

    uv run python score.py runs/v0/last.pt --top 120
"""

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

import synth
from marks import CLASSES
from model import Detector
from preprocess import SIZE, STRIDE, flatten, letterbox, load
from sheet import checker

ROOT = Path(__file__).resolve().parent


class Pictures(torch.utils.data.Dataset):
    def __init__(self, paths):
        self.paths = paths

    def __len__(self):
        return len(self.paths)

    def __getitem__(self, i):
        return torch.from_numpy(load(self.paths[i]))


@torch.no_grad()
def score(model, paths, device, workers=8):
    loader = torch.utils.data.DataLoader(Pictures(paths), batch_size=32, num_workers=workers)
    maxima, maps = [], []
    for batch in loader:
        probs = torch.sigmoid(model(batch.to(device))).cpu().numpy()
        maxima.append(probs.max(axis=(2, 3)))
        maps.append(probs.astype(np.float16))
    return np.concatenate(maxima), np.concatenate(maps)


def overlay(path, prob_map, tile=260, threshold=0.3):
    """The picture as the model saw it, with the hot cells outlined per class."""
    image = flatten(Image.open(path))
    canvas, *_ = letterbox(image, SIZE)
    draw = ImageDraw.Draw(canvas)
    colours = [(0, 255, 0), (255, 0, 255), (0, 200, 255), (255, 200, 0)]
    for c in range(prob_map.shape[0]):
        ys, xs = np.where(prob_map[c] >= threshold)
        for y, x in zip(ys, xs):
            draw.rectangle([x * STRIDE, y * STRIDE, (x + 1) * STRIDE - 1, (y + 1) * STRIDE - 1], outline=colours[c], width=2)
    canvas.thumbnail((tile, tile))
    return canvas


def sheet(items, out, cols=6, tile=260):
    rows = (len(items) + cols - 1) // cols
    page = Image.new("RGB", (cols * (tile + 8), rows * (tile + 30)), "white")
    draw = ImageDraw.Draw(page)
    for n, (image, label) in enumerate(items):
        x, y = (n % cols) * (tile + 8), (n // cols) * (tile + 30)
        page.paste(image, (x, y + 26))
        draw.text((x + 2, y + 4), label, fill="black")
    page.save(out, quality=85)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint")
    parser.add_argument("--top", type=int, default=120)
    parser.add_argument("--per-sheet", type=int, default=30)
    args = parser.parse_args()

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model = Detector(pretrained=False).to(device)
    model.load_state_dict(torch.load(args.checkpoint, map_location=device, weights_only=True)["model"])
    model.eval()

    groups = synth.uploads()
    paths, group_of = [], {}
    for group, items in groups.items():
        # "positives" is the union of positives_eval and positives_train
        if group == "positives":
            continue
        for p in items:
            paths.append(p)
            group_of[p] = group
    maxima, maps = score(model, paths, device)

    run = Path(args.checkpoint).parent.name
    out = ROOT / "data" / "review" / run
    out.mkdir(parents=True, exist_ok=True)
    # Every mark counts (Rick, 2026-10-06: the rings, the speaker and the pill alone too)
    main_score = maxima.max(axis=1)
    order = np.argsort(-main_score)
    with open(out / "ranking.tsv", "w") as f:
        f.write("rank\tname\tgroup\tscore\t" + "\t".join(CLASSES) + "\n")
        for rank, i in enumerate(order, 1):
            f.write(f"{rank}\t{Path(paths[i]).stem}\t{group_of[paths[i]]}\t{main_score[i]:.4f}\t" + "\t".join(f"{v:.4f}" for v in maxima[i]) + "\n")

    labelled = (
        synth.labelled("positives_rick.txt") | synth.labelled("positives.txt") | synth.labelled("negatives.txt")
        | set(synth.ui_labels())
    )
    review = [i for i in order if Path(paths[i]).stem not in labelled][: args.top]
    for page in range(0, len(review), args.per_sheet):
        items = []
        for n, i in enumerate(review[page : page + args.per_sheet], page + 1):
            best = CLASSES[int(np.argmax(maxima[i]))]
            items.append((overlay(paths[i], maps[i].astype(np.float32)), f"{n}. {Path(paths[i]).stem[:12]} {main_score[i]:.2f} {best}"))
        sheet(items, out / f"top_{page // args.per_sheet + 1:02d}.jpg")
    (out / "review.json").write_text(json.dumps([Path(paths[i]).stem for i in review]))

    pos = [main_score[i] for i, p in enumerate(paths) if group_of[p].startswith("positives")]
    print(f"scored {len(paths)}; labelled positives: min {min(pos):.3f} median {np.median(pos):.3f}")
    for t in (0.3, 0.5, 0.7, 0.9):
        print(f"  >= {t}: {(main_score >= t).sum()} pictures")
    print(f"sheets in {out}")


if __name__ == "__main__":
    main()
