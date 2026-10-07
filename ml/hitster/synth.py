"""
Training samples: a background (a real customer upload, one of our presets or
a plain fill) with Hitster marks and look-alikes drawn on it, run through the
same letterbox as inference, with the cell targets for the detector.

The uploads are the negatives. A few of them are Hitster material nobody has
labelled yet; score.py ranks them after a first training run, the ones found
go into data/labels/, and the next run treats them as positives.
"""

import io
import json
import random
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

import marks
from preprocess import PAD, SIZE, STRIDE, flatten, letterbox, to_tensor_array

ROOT = Path(__file__).resolve().parent
PRESETS = ROOT.parent.parent.parent / "qrhit" / "src" / "assets" / "images" / "card_backgrounds"
LABELS = ROOT / "data" / "labels"
C = len(marks.CLASSES)
GRID = SIZE // STRIDE
EVAL_SHARE = 0.1


def labelled(name: str) -> set[str]:
    path = LABELS / name
    if not path.exists():
        return set()
    return {line.split()[0] for line in path.read_text().split("\n") if line.strip() and not line.startswith("#")}


def ui_labels() -> dict[str, str]:
    """
    Rick's verdicts from the browse page (node/server.ts): "name pos|neg|clear
    time" per line, the last line per picture wins. They beat every other label.
    """
    path = LABELS / "labels_ui.txt"
    verdicts: dict[str, str] = {}
    if path.exists():
        for line in path.read_text().split("\n"):
            parts = line.split()
            if len(parts) >= 2 and not line.startswith("#"):
                if parts[1] == "clear":
                    verdicts.pop(parts[0], None)
                else:
                    verdicts[parts[0]] = parts[1]
    return verdicts


def _split(md5: str) -> str:
    return "eval" if int(md5[:6], 16) / 0xFFFFFF < EVAL_SHARE else "train"


def _positive_split(md5: str) -> str:
    # Rick's own examples always test; of the reviewed ones about a third does
    return "eval" if int(md5[6:12], 16) / 0xFFFFFF < 0.35 else "train"


@lru_cache(maxsize=1)
def uploads():
    """
    Image paths per group, one per distinct picture (md5 of the original):

    train / eval           unlabelled uploads, the negatives (10% held out)
    hard_train / hard_eval checked negatives (pictures an earlier model flagged wrongly)
    positives              every labelled positive (Rick's and reviewed)
    positives_eval         Rick's plus about a third of the reviewed ones
    positives_train        the rest of the reviewed ones
    unknown                not to be trained on either way: other pictures on
                           an order line with a positive, the ones Rick is
                           asked about, and high scorers nobody has looked at
    """
    ui = ui_labels()
    ui_pos = {n for n, v in ui.items() if v == "pos"}
    ui_neg = {n for n, v in ui.items() if v == "neg"}
    rick = labelled("positives_rick.txt") - ui_neg
    positives = (rick | labelled("positives.txt") | ui_pos) - ui_neg
    negatives_checked = (labelled("negatives.txt") | ui_neg) - ui_pos
    unchecked = (labelled("ask_rick.txt") | labelled("unknown.txt")) - ui_pos - ui_neg
    lines_with_positive = set()
    import csv

    rows = list(csv.DictReader(open(ROOT / "data" / "prod" / "order_lines.tsv"), delimiter="\t"))
    fields = ["background", "backgroundBack", "logo", "boxFrontBackground", "boxFrontLogo", "boxBackBackground"]
    for row in rows:
        if any(Path(row[f] or "").stem in positives for f in fields):
            lines_with_positive.add(row["phpId"])
    on_positive_line = {Path(row[f]).stem for row in rows if row["phpId"] in lines_with_positive for f in fields if row[f]}

    by_md5 = {}
    for line in open(ROOT / "data" / "prod" / "images.jsonl"):
        record = json.loads(line)
        if record.get("status") != 200 or "path" not in record:
            continue
        by_md5.setdefault(record["md5"], record)
    groups = {k: [] for k in ("train", "eval", "hard_train", "hard_eval", "positives", "positives_eval", "positives_train", "unknown")}
    for md5, record in by_md5.items():
        stem = Path(record["name"]).stem
        path = str(ROOT / record["path"])
        if stem in positives:
            groups["positives"].append(path)
            split = "eval" if stem in rick else _positive_split(md5)
            groups[f"positives_{split}"].append(path)
        elif stem in negatives_checked:
            groups[f"hard_{_split(md5)}"].append(path)
        elif stem in unchecked or stem in on_positive_line:
            groups["unknown"].append(path)
        else:
            groups[_split(md5)].append(path)
    return groups


@lru_cache(maxsize=1)
def presets():
    return sorted(str(p) for p in PRESETS.glob("*") if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"))


def open_rgb(path: str) -> Image.Image:
    image = ImageOps.exif_transpose(Image.open(path))
    return flatten(image)


# --- backgrounds ---------------------------------------------------------------

def procedural(rng, w, h, dark=None):
    kind = rng.random()
    if kind < 0.45:
        return Image.new("RGB", (w, h), marks.random_colour(rng, dark))
    if kind < 0.75:
        return marks._gradient((w, h), marks.random_colour(rng, dark), marks.random_colour(rng, dark), rng.uniform(0, 3.14))
    noise = rng.integers(0, 256, (max(2, h // 32), max(2, w // 32), 3), dtype=np.uint8)
    image = Image.fromarray(noise).resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(3))
    if dark:
        image = ImageEnhance.Brightness(image).enhance(0.25)
    return image


def background(rng, w, h, pool, dark=None):
    pick = rng.random()
    if pick < 0.55 and pool:
        image = open_rgb(pool[rng.integers(len(pool))])
    elif pick < 0.65 and presets():
        image = open_rgb(presets()[rng.integers(len(presets()))])
    else:
        return procedural(rng, w, h, dark)
    # A random crop of it at the canvas aspect
    iw, ih = image.size
    target = w / h
    if iw / ih > target:
        cw, ch = int(ih * target), ih
    else:
        cw, ch = iw, int(iw / target)
    scale = rng.uniform(0.5, 1.0)
    cw, ch = max(8, int(cw * scale)), max(8, int(ch * scale))
    x, y = rng.integers(0, iw - cw + 1), rng.integers(0, ih - ch + 1)
    image = image.crop((x, y, x + cw, y + ch)).resize((w, h), Image.BILINEAR)
    if dark:
        image = ImageEnhance.Brightness(image).enhance(rng.uniform(0.15, 0.4))
    return image


# --- placing marks ---------------------------------------------------------------

def place(canvas: Image.Image, mark: Image.Image, boxes, rng, fraction: float, fill=False):
    """Scale `mark` to `fraction` of the canvas width, paste it, return its boxes on the canvas."""
    w, h = canvas.size
    if fill:
        scale = min(w * fraction / mark.width, h * fraction / mark.height)
    else:
        scale = w * fraction / mark.width
        scale = min(scale, h * 1.3 / mark.height)
    nw, nh = max(2, int(mark.width * scale)), max(2, int(mark.height * scale))
    mark = mark.resize((nw, nh), Image.LANCZOS)
    if fill:
        x, y = (w - nw) // 2 + int(rng.integers(-w // 20, w // 20 + 1)), (h - nh) // 2 + int(rng.integers(-h // 20, h // 20 + 1))
    else:
        x = int(rng.integers(-nw // 4, max(1, w - nw * 3 // 4)))
        y = int(rng.integers(-nh // 4, max(1, h - nh * 3 // 4)))
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    layer.paste(mark, (x, y), mark)
    canvas.paste(Image.alpha_composite(canvas.convert("RGBA"), layer).convert("RGB"))
    placed, ignored = [], []
    for c, (x0, y0, x1, y1) in boxes:
        bx = (x + x0 * scale, y + y0 * scale, x + x1 * scale, y + y1 * scale)
        clipped = (max(0, bx[0]), max(0, bx[1]), min(w, bx[2]), min(h, bx[3]))
        area = max(0, bx[2] - bx[0]) * max(0, bx[3] - bx[1])
        seen = max(0, clipped[2] - clipped[0]) * max(0, clipped[3] - clipped[1])
        if area > 0 and seen / area >= 0.45:
            placed.append((c, clipped))
        elif seen > 0:
            ignored.append((c, clipped))
    return placed, ignored


def augment(image: Image.Image, rng) -> Image.Image:
    if rng.random() < 0.35:
        image = ImageEnhance.Brightness(image).enhance(rng.uniform(0.7, 1.3))
        image = ImageEnhance.Contrast(image).enhance(rng.uniform(0.7, 1.3))
        image = ImageEnhance.Color(image).enhance(rng.uniform(0.5, 1.5))
    if rng.random() < 0.2:
        image = image.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.6)))
    if rng.random() < 0.2:
        w, h = image.size
        f = rng.uniform(0.3, 0.7)
        image = image.resize((max(8, int(w * f)), max(8, int(h * f))), Image.BILINEAR).resize((w, h), Image.BILINEAR)
    if rng.random() < 0.12:
        array = np.asarray(image, np.float32) + rng.normal(0, rng.uniform(3, 14), (image.height, image.width, 3))
        image = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))
    if rng.random() < 0.05:
        image = ImageOps.grayscale(image).convert("RGB")
    if rng.random() < 0.5:
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=int(rng.integers(25, 92)))
        image = Image.open(io.BytesIO(buffer.getvalue())).convert("RGB")
    return image


# --- targets ----------------------------------------------------------------------

def targets(boxes, ignored, scale, ox, oy):
    """(target, mask) of shape (C, GRID, GRID): 1 on a mark's core cells, ignore on its rim."""
    target = np.zeros((C, GRID, GRID), np.float32)
    mask = np.ones((C, GRID, GRID), np.float32)
    centres = (np.arange(GRID) + 0.5) * STRIDE

    def to_input(box):
        return (box[0] * scale + ox, box[1] * scale + oy, box[2] * scale + ox, box[3] * scale + oy)

    for c, box in ignored:
        x0, y0, x1, y1 = to_input(box)
        mask[c][np.ix_((centres >= y0 - STRIDE) & (centres <= y1 + STRIDE), (centres >= x0 - STRIDE) & (centres <= x1 + STRIDE))] = 0
    for c, box in boxes:
        x0, y0, x1, y1 = to_input(box)
        bw, bh = x1 - x0, y1 - y0
        rim_y = (centres >= y0 - STRIDE / 2) & (centres <= y1 + STRIDE / 2)
        rim_x = (centres >= x0 - STRIDE / 2) & (centres <= x1 + STRIDE / 2)
        mask[c][np.ix_(rim_y, rim_x)] = 0
        core_y = (centres >= y0 + 0.15 * bh) & (centres <= y1 - 0.15 * bh)
        core_x = (centres >= x0 + 0.15 * bw) & (centres <= x1 - 0.15 * bw)
        target[c][np.ix_(core_y, core_x)] = 1
        cy, cx = int(np.clip((y0 + y1) / 2 // STRIDE, 0, GRID - 1)), int(np.clip((x0 + x1) / 2 // STRIDE, 0, GRID - 1))
        target[c, cy, cx] = 1
        mask[c][target[c] > 0] = 1
    return target, mask


# --- the dataset -----------------------------------------------------------------

class Synth(torch.utils.data.Dataset):
    """
    Map-style so sample i is the same picture every time for a given seed:
    the eval split is a fixed set. `fonts` is "train" or "eval".
    """

    def __init__(self, length: int, seed: int, fonts: str = "train", pool: str = "train", weak_positives=None, real_positives=None, hard=None):
        self.length = length
        self.seed = seed
        self.font_split = fonts
        self.pool_name = pool
        # Real Hitster pictures without boxes: web photos, and labelled uploads
        self.weak_positives = weak_positives or []
        self.real_positives = real_positives or []
        # Uploads an earlier model flagged that are not Hitster
        self.hard = hard or []
        self._fonts = None

    def __len__(self):
        return self.length

    @property
    def fonts(self):
        if self._fonts is None:
            self._fonts = marks.fonts(self.font_split)
        return self._fonts

    def __getitem__(self, index):
        rng = np.random.default_rng([self.seed, index])
        for _ in range(5):
            try:
                return self.make(rng)
            except Exception:
                continue
        return self.make_negative(rng)

    def pool(self):
        return uploads()[self.pool_name]

    def canvas_size(self, rng):
        if rng.random() < 0.5:
            return SIZE, SIZE
        aspect = float(np.exp(rng.uniform(np.log(0.4), np.log(2.6))))
        return (SIZE, max(64, int(SIZE / aspect))) if aspect >= 1 else (max(64, int(SIZE * aspect)), SIZE)

    def make_negative(self, rng):
        w, h = self.canvas_size(rng)
        canvas = background(rng, w, h, self.pool())
        return self.finish(canvas, [], [], rng, present=np.zeros(C, np.float32))

    def make(self, rng):
        kind = rng.random()
        if (self.weak_positives or self.real_positives) and kind < 0.12:
            return self.make_weak(rng)
        if self.hard and 0.12 <= kind < 0.18:
            return self.make_hard(rng)
        if kind < 0.40:
            return self.make_negative(rng)
        w, h = self.canvas_size(rng)
        boxes, ignored = [], []
        positive = kind < 0.80
        choice = rng.random()
        dark = None
        if positive and 0.42 <= choice < 0.75:
            dark = rng.random() < 0.75
        canvas = background(rng, w, h, self.pool(), dark)

        # The look-alikes appear in positives too, next to the real thing
        for _ in range(int(rng.integers(0, 3)) if positive else int(rng.integers(1, 4))):
            decoy = rng.random()
            if decoy < 0.6:
                image, _ = marks.render_lettering(rng, self.fonts, False)
            else:
                image, _ = marks.render_rings(rng, 300, False)
            if image is not None:
                place(canvas, image, [], rng, rng.uniform(0.2, 0.9))

        if positive:
            if choice < 0.42:
                image, mark_boxes = marks.render_lettering(rng, self.fonts, True)
                if image is None:
                    raise ValueError("lettering")
                fill = rng.random() < 0.45
                fraction = rng.uniform(0.6, 0.98) if fill else float(np.exp(rng.uniform(np.log(0.12), np.log(0.95))))
            elif choice < 0.75:
                # A real Hitster card back fills the picture: rings mostly do
                image, mark_boxes = marks.render_rings(rng, 400, True)
                fill = rng.random() < 0.65
                fraction = rng.uniform(0.8, 1.2) if fill else rng.uniform(0.25, 1.0)
            else:
                image, mark_boxes = marks.render_reference(rng)
                fill = rng.random() < 0.4
                fraction = rng.uniform(0.6, 0.98) if fill else float(np.exp(rng.uniform(np.log(0.15), np.log(0.95))))
            placed, lost = place(canvas, image, mark_boxes, rng, fraction, fill)
            boxes += placed
            ignored += lost
        present = np.zeros(C, np.float32)
        for c, _ in boxes:
            present[c] = 1
        # A class that was only partly visible is neither present nor absent
        for c, _ in ignored:
            if present[c] == 0:
                present[c] = -1
        return self.finish(canvas, boxes, ignored, rng, present)

    def make_hard(self, rng):
        """An upload that looked like Hitster to an earlier model and is not."""
        image = open_rgb(self.hard[rng.integers(len(self.hard))])
        return self.finish(image, [], [], rng, present=np.zeros(C, np.float32))

    def make_weak(self, rng):
        """A real Hitster picture with no boxes: only "something is here" is known."""
        real = self.real_positives and (not self.weak_positives or rng.random() < 0.6)
        pool = self.real_positives if real else self.weak_positives
        path = pool[rng.integers(len(pool))]
        image = open_rgb(path)
        w, h = image.size
        if rng.random() < 0.5:
            f = rng.uniform(0.75, 1.0)
            cw, ch = int(w * f), int(h * f)
            x, y = rng.integers(0, w - cw + 1), rng.integers(0, h - ch + 1)
            image = image.crop((x, y, x + cw, y + ch))
        present = np.full(C, -1, np.float32)
        sample = self.finish(image, [], [], rng, present)
        sample["mask"][:] = 0
        sample["any"] = torch.tensor(1.0)
        return sample

    def finish(self, canvas, boxes, ignored, rng, present):
        canvas = augment(canvas, rng)
        pad = PAD if rng.random() < 0.8 else marks.random_colour(rng)
        boxed, scale, ox, oy = letterbox(canvas, SIZE, pad)
        target, mask = targets(boxes, ignored, scale, ox, oy)
        return {
            "image": torch.from_numpy(to_tensor_array(boxed)),
            "target": torch.from_numpy(target),
            "mask": torch.from_numpy(mask),
            "present": torch.from_numpy(present),
            "any": torch.tensor(-1.0),
        }
