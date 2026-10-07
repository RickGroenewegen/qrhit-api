"""
Train the detector on synth.py samples, on the Mac's GPU (MPS).

    uv run python train.py --name v0 --steps 6000
    uv run python train.py --name v1 --steps 20000 --init runs/v0/last.pt

Every --eval-every steps it scores (1) a fixed synthetic set drawn with fonts
and uploads it never trains on and (2) the real pictures: the labelled
positives against the held-out uploads. Checkpoints and a log go to
runs/<name>/.
"""

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

import synth
from marks import CLASSES
from model import Detector
from preprocess import load

ROOT = Path(__file__).resolve().parent


def focal(logits, target, mask, gamma=2.0, alpha=0.25):
    p = torch.sigmoid(logits)
    ce = F.binary_cross_entropy_with_logits(logits, target, reduction="none")
    p_t = p * target + (1 - p) * (1 - target)
    a_t = alpha * target + (1 - alpha) * (1 - target)
    loss = a_t * ce * (1 - p_t) ** gamma * mask
    return loss.sum() / torch.clamp((target * mask).sum(), min=1.0)


def image_level(logits, present, any_label):
    pooled = logits.amax(dim=(2, 3))
    known = (present >= 0).float()
    per_class = F.binary_cross_entropy_with_logits(pooled, present.clamp(min=0), reduction="none")
    loss = (per_class * known).sum() / torch.clamp(known.sum(), min=1.0)
    weak = any_label >= 0
    if weak.any():
        loss = loss + F.binary_cross_entropy_with_logits(pooled.amax(dim=1)[weak], any_label[weak]).mean()
    return loss


@torch.no_grad()
def score_paths(model, paths, device, batch=16):
    """Highest cell probability per class for each picture, (N, C)."""
    out = []
    for i in range(0, len(paths), batch):
        arrays = np.stack([load(p) for p in paths[i : i + batch]])
        probs = torch.sigmoid(model(torch.from_numpy(arrays).to(device)))
        out.append(probs.amax(dim=(2, 3)).cpu().numpy())
    return np.concatenate(out) if out else np.zeros((0, len(CLASSES)))


def auc(pos, neg):
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    pos, neg = np.asarray(pos), np.asarray(neg)
    return float(((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()))


@torch.no_grad()
def evaluate(model, device, synth_eval, real):
    model.eval()
    report = {}
    # Synthetic: per class, image level, at 0.5
    hits, misses, false = np.zeros(len(CLASSES)), np.zeros(len(CLASSES)), np.zeros(len(CLASSES))
    negatives = 0
    loader = torch.utils.data.DataLoader(synth_eval, batch_size=16, num_workers=3)
    for batch in loader:
        probs = torch.sigmoid(model(batch["image"].to(device))).amax(dim=(2, 3)).cpu().numpy()
        present = batch["present"].numpy()
        for c in range(len(CLASSES)):
            hits[c] += ((probs[:, c] >= 0.5) & (present[:, c] == 1)).sum()
            misses[c] += ((probs[:, c] < 0.5) & (present[:, c] == 1)).sum()
            false[c] += ((probs[:, c] >= 0.5) & (present[:, c] == 0)).sum()
        negatives += (present.max(axis=1) <= 0).sum()
    report["synth"] = {
        CLASSES[c]: {"recall": round(hits[c] / max(1, hits[c] + misses[c]), 3), "false_pos": int(false[c])}
        for c in range(len(CLASSES))
    }
    # Real: labelled positives against held-out uploads. Every mark counts
    # (Rick, 2026-10-06: the rings, the speaker and the pill alone too)
    pos = score_paths(model, real["positives"], device)
    neg = score_paths(model, real["negatives"], device)
    pos_score = pos.max(axis=1) if len(pos) else np.zeros(0)
    neg_score = neg.max(axis=1)
    threshold_1pct = float(np.quantile(neg_score, 0.99))
    report["real"] = {
        "auc": round(auc(pos_score, neg_score), 4),
        "recall@0.5": round(float((pos_score >= 0.5).mean()), 3) if len(pos) else None,
        "fp@0.5": int((neg_score >= 0.5).sum()),
        "negatives": len(neg_score),
        "recall@1%fp": round(float((pos_score > threshold_1pct).mean()), 3) if len(pos) else None,
        "threshold@1%fp": round(threshold_1pct, 3),
        "positives": len(pos_score),
        "missed@0.5": int((pos_score < 0.5).sum()),
    }
    # Rick's own examples were not found by a model, so they are the unbiased test
    rick = synth.labelled("positives_rick.txt")
    rick_score = np.array([s for p, s in zip(real["positives"], pos_score) if Path(p).stem in rick])
    if len(rick_score):
        report["rick"] = {
            "auc": round(auc(rick_score, neg_score), 4),
            "recall@0.5": round(float((rick_score >= 0.5).mean()), 3),
            "recall@1%fp": round(float((rick_score > threshold_1pct).mean()), 3),
        }
    model.train()
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--steps", type=int, default=6000)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--lr", type=float, default=5e-4)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--eval-every", type=int, default=1000)
    parser.add_argument("--init", default=None)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--weak", default=None, help="text file of real Hitster pictures without boxes")
    args = parser.parse_args()

    run = ROOT / "runs" / args.name
    run.mkdir(parents=True, exist_ok=True)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    torch.manual_seed(args.seed)

    model = Detector().to(device)
    if args.init:
        model.load_state_dict(torch.load(args.init, map_location=device, weights_only=True)["model"])

    weak = [l.strip() for l in open(args.weak) if l.strip()] if args.weak else []
    groups = synth.uploads()
    print(json.dumps({k: len(v) for k, v in groups.items()}), flush=True)
    train_set = synth.Synth(
        args.steps * args.batch, seed=args.seed, fonts="train", pool="train",
        weak_positives=weak, real_positives=groups["positives_train"], hard=groups["hard_train"],
    )
    synth_eval = synth.Synth(384, seed=999, fonts="eval", pool="eval")
    real = {"positives": groups["positives_eval"], "negatives": groups["eval"] + groups["hard_eval"]}

    loader = torch.utils.data.DataLoader(
        train_set, batch_size=args.batch, num_workers=args.workers, shuffle=False,
        persistent_workers=True, prefetch_factor=4, drop_last=True,
    )
    optimiser = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    warmup = min(500, args.steps // 10)

    def lr_at(step):
        if step < warmup:
            return (step + 1) / warmup
        t = (step - warmup) / max(1, args.steps - warmup)
        return 0.02 + 0.98 * 0.5 * (1 + math.cos(math.pi * t))

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimiser, lr_at)
    log = open(run / "log.jsonl", "a")
    started = time.time()
    model.train()
    running = {"cell": 0.0, "image": 0.0}
    for step, batch in enumerate(loader):
        images = batch["image"].to(device, non_blocking=True)
        logits = model(images)
        cell = focal(logits, batch["target"].to(device), batch["mask"].to(device))
        image = image_level(logits, batch["present"].to(device), batch["any"].to(device))
        loss = cell + 0.5 * image
        optimiser.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        optimiser.step()
        scheduler.step()
        running["cell"] += cell.detach().item()
        running["image"] += image.detach().item()

        if (step + 1) % 50 == 0:
            rate = (step + 1) * args.batch / (time.time() - started)
            line = {"step": step + 1, "cell": round(running["cell"] / 50, 4), "image": round(running["image"] / 50, 4), "lr": round(scheduler.get_last_lr()[0], 6), "img_s": round(rate, 1)}
            print(json.dumps(line), flush=True)
            log.write(json.dumps(line) + "\n")
            log.flush()
            running = {"cell": 0.0, "image": 0.0}
        if (step + 1) % args.eval_every == 0 or step + 1 == args.steps:
            report = {"step": step + 1, **evaluate(model, device, synth_eval, real)}
            print(json.dumps(report), flush=True)
            log.write(json.dumps(report) + "\n")
            log.flush()
            torch.save({"model": model.state_dict(), "step": step + 1}, run / "last.pt")
            if device.type == "mps":
                torch.mps.empty_cache()
        if step + 1 >= args.steps:
            break
    torch.save({"model": model.state_dict(), "step": args.steps}, run / "last.pt")


if __name__ == "__main__":
    main()
