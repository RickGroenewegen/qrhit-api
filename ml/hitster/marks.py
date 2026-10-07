"""
Drawing what the detector has to find, and what it must not confuse with it.

Classes (CLASSES): the word Hitster in any lettering, the rings of the back of
a Hitster card, the chrome speaker and the "THE MUSIC CARD GAME" pill of the
box. Every drawing comes back as an RGBA picture plus the boxes of the marks
in it, in that picture's pixels; synth.py places it on a background.

Look-alikes (similar words, single-colour rings, vinyl records, targets) are
drawn by the same code with no boxes, so the model learns where the line is.
"""

import json
import math
import random
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent
REFERENCE_DIR = ROOT.parent.parent / "assets" / "hitster_reference"
CLASSES = ["word", "rings", "speaker", "pill"]
WORD, RINGS, SPEAKER, PILL = range(4)

# The name and the near-spellings Rick counts as the name ("HITSER", "Hitstor",
# "HITSTAR": his examples and his answers of 2026-10-06)
POSITIVE_WORDS = ["HITSTER"] * 14 + ["HITSER", "HITSTOR", "HITSTAR", "H1TSTER", "HITST3R", "HITSTR", "HlTSTER"]
# Words one letter or one sound away that are not the name. A name or word
# with "-ster" on it (Brittster, Swiftster, Sipster) and JITSTER are not
# Hitster by Rick's answer of 2026-10-06, nor is HITSPEL (Dutch: hit game).
LOOKALIKE_WORDS = [
    "HIPSTER", "TIPSTER", "TWISTER", "SISTER", "MISTER", "MASTER", "HAMSTER", "MONSTER", "LOBSTER",
    "ROOSTER", "BOOSTER", "TOASTER", "POSTER", "HOLSTER", "HITTER", "HITS", "HITLIST", "HITPARADE",
    "HIT", "STER", "TOPSTER", "POPSTER", "HOTSTEPPER", "HISTORY", "HEISTER", "WHISTLE", "HISSTER",
    "JITSTER", "SIPSTER", "SHIPSTER", "BRITTSTER", "SWIFTSTER", "LIEDSTER", "HITSPEL", "LISTSTER",
]
FILLER_WORDS = [
    "PARTY", "EDITION", "MUSIC", "QUIZ", "SONG", "SONGS", "BINGO", "GAME", "SPEL", "FEEST", "JAREN",
    "MUZIEK", "KAARTEN", "CARDS", "PLAYLIST", "GEBURTSTAG", "VERJAARDAG", "FAMILY", "FAMILIE",
    "SUMMER", "KERST", "XMAS", "SING", "DANCE", "DISCO", "RADIO", "LIVE", "TOP", "HITS", "CLASSICS",
    "QRSONG", "SUPER", "MEGA", "THE", "BEST", "OF", "TIME", "LINE", "NIGHT", "AVOND", "CLUB",
]
NAMES = [
    "Marco", "Pia", "Liv", "Niki", "Sanne", "Bram", "Emma", "Daan", "Lotte", "Jesse", "Fenna", "Tim",
    "Anouk", "Ruben", "Mila", "Sem", "Julia", "Lars", "Noor", "Thijs", "Jan", "Kim", "Max", "Eva",
    "Familie Jansen", "Team Rood", "De Vries", "Oma", "Papa", "Mama", "Jonas", "Lea", "Lukas", "Mia",
]
TEMPLATES = [
    ["{w}"], ["{w}"], ["{w}"], ["{n}'s", "{w}"], ["{n}'s {w}"], ["{w}", "{f} edition"], ["{w}", "{f}"],
    ["{w} {f}"], ["{n}", "{w}"], ["{w}", "{n}"], ["{f}", "{w}", "{f}"], ["{w} {y}"], ["{w}", "{y}"],
    ["{n}'s {w}", "{f} edition"], ["{w}", "{n}'s {f}"], ["onze {w}"], ["{w}", "{y} jaar"],
]
YEARS = ["70s", "80s", "90s", "00s", "2025", "2026", "10", "40", "50", "18", "21", "30"]

# The colours of the Hitster rings and wordmark, roughly
NEON = [(230, 0, 126), (255, 237, 0), (0, 160, 233), (155, 89, 182), (243, 146, 0), (190, 160, 220), (90, 200, 90), (235, 40, 70)]


def fonts(split: str):
    rows = json.loads((ROOT / "data" / "fonts" / "usable.json").read_text())
    return [r for r in rows if r["split"] == split]


FONT_SIZES = (36, 48, 64, 100)


# Every open face holds its whole file in memory, per data worker: a few
# sizes and a small cache keep a worker at tens of MB instead of gigabytes.
@lru_cache(maxsize=48)
def font_at(path: str, index: int, size: int):
    return ImageFont.truetype(path, size, index=index)


def random_colour(rng, dark=None):
    if dark is None:
        return tuple(int(c) for c in rng.integers(0, 256, 3))
    if dark:
        return tuple(int(c) for c in rng.integers(0, 70, 3))
    return tuple(int(c) for c in rng.integers(170, 256, 3))


def pick_word(rng, positive: bool, lookalike_share=0.6):
    if positive:
        word = POSITIVE_WORDS[rng.integers(len(POSITIVE_WORDS))]
    elif rng.random() < lookalike_share:
        word = LOOKALIKE_WORDS[rng.integers(len(LOOKALIKE_WORDS))]
    else:
        word = FILLER_WORDS[rng.integers(len(FILLER_WORDS))]
    case = rng.random()
    if case < 0.55:
        return word.upper()
    if case < 0.85:
        return word.capitalize()
    return word.lower()


def fill_text(template: str, rng, word: str):
    return (
        template.replace("{w}", word)
        .replace("{n}", NAMES[rng.integers(len(NAMES))])
        .replace("{f}", pick_word(rng, False, 0.0).capitalize())
        .replace("{y}", YEARS[rng.integers(len(YEARS))])
    )


def _gradient(size, a, b, angle):
    w, h = size
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    t = (x * math.cos(angle) + y * math.sin(angle))
    t = (t - t.min()) / max(1e-6, t.max() - t.min())
    a, b = np.array(a, np.float32), np.array(b, np.float32)
    rgb = a[None, None] * (1 - t[..., None]) + b[None, None] * t[..., None]
    return Image.fromarray(rgb.astype(np.uint8), "RGB")


def render_line(text: str, target: str | None, font_row: dict, height: int, rng):
    """
    One line of lettering in a random style. Returns (RGBA, box of `target`
    inside it or None). The box is approximate at the ends (stroke, glow),
    which the cell targets in synth.py tolerate.
    """
    size = min(FONT_SIZES, key=lambda s: abs(s - height))
    font = font_at(font_row["path"], font_row["index"], size)
    style = rng.random()
    stroke = int(size * rng.uniform(0.02, 0.12)) if rng.random() < 0.55 else 0
    glow = rng.random() < 0.3
    extrude = int(size * rng.uniform(0.03, 0.1)) if rng.random() < 0.2 else 0
    pad = stroke + extrude + (size // 2 if glow else 4) + 4
    left, top, right, bottom = font.getbbox(text, stroke_width=stroke)
    w, h = right - left + 2 * pad, bottom - top + 2 * pad
    if w <= 0 or h <= 0 or w > 6000:
        return None, None
    origin = (pad - left, pad - top)

    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).text(origin, text, font=font, fill=255)
    stroke_mask = None
    if stroke:
        stroke_mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(stroke_mask).text(origin, text, font=font, fill=255, stroke_width=stroke, stroke_fill=255)

    if style < 0.5:
        fill = Image.new("RGB", (w, h), random_colour(rng))
    elif style < 0.8:
        fill = _gradient((w, h), random_colour(rng), random_colour(rng), rng.uniform(0, math.pi))
    else:
        fill = Image.new("RGB", (w, h), NEON[rng.integers(len(NEON))])
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    if extrude:
        shade = Image.new("RGBA", (w, h), random_colour(rng, dark=True) + (255,))
        base = stroke_mask or mask
        for k in range(extrude, 0, -1):
            out.alpha_composite(Image.composite(shade, Image.new("RGBA", (w, h)), ImageChops.offset(base, k, k)))
    if glow:
        colour = NEON[rng.integers(len(NEON))]
        halo = (stroke_mask or mask).filter(ImageFilter.GaussianBlur(size * rng.uniform(0.06, 0.2)))
        halo = halo.point(lambda v: min(255, int(v * 1.8)))
        out.alpha_composite(Image.composite(Image.new("RGBA", (w, h), colour + (255,)), Image.new("RGBA", (w, h)), halo))
    if stroke_mask is not None:
        ring = random_colour(rng) if rng.random() < 0.6 else ((255, 255, 255) if rng.random() < 0.5 else (0, 0, 0))
        out.alpha_composite(Image.composite(Image.new("RGBA", (w, h), ring + (255,)), Image.new("RGBA", (w, h)), stroke_mask))
    # Neon tube: the letters as outline only, like the Hitster wordmark
    if rng.random() < 0.15:
        inner = mask.filter(ImageFilter.MinFilter(max(3, (size // 14) | 1)))
        mask = ImageChops.subtract(mask, inner)
    out.alpha_composite(Image.composite(fill.convert("RGBA"), Image.new("RGBA", (w, h)), mask))

    box = None
    if target:
        at = text.find(target)
        x0 = origin[0] + font.getlength(text[:at])
        x1 = origin[0] + font.getlength(text[: at + len(target)])
        box = (x0 - stroke, pad - stroke, x1 + stroke, h - pad + stroke)
    return out, box


def render_lettering(rng, font_rows, positive: bool):
    """A one to three line logo-like lettering. Returns (RGBA, [(class, box)])."""
    word = pick_word(rng, positive)
    template = TEMPLATES[rng.integers(len(TEMPLATES))]
    lines = [fill_text(t, rng, word) for t in template]
    main_font = font_rows[rng.integers(len(font_rows))]
    pieces = []
    for line in lines:
        is_main = word in line
        font_row = main_font if (is_main or rng.random() < 0.5) else font_rows[rng.integers(len(font_rows))]
        height = 100 if is_main else 100 * rng.uniform(0.35, 0.8)
        image, box = render_line(line, word if (is_main and positive) else None, font_row, height, rng)
        if image is None:
            return None, []
        pieces.append((image, box))

    width = max(p[0].width for p in pieces)
    gap = int(rng.uniform(-6, 18))
    height = sum(p[0].height for p in pieces) + gap * (len(pieces) - 1)
    if height <= 0:
        return None, []
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    boxes = []
    y = 0
    for image, box in pieces:
        x = (width - image.width) // 2
        canvas.alpha_composite(image, (x, max(0, y)))
        if box:
            boxes.append((WORD, (box[0] + x, box[1] + y, box[2] + x, box[3] + y)))
        y += image.height + gap

    # A badge or sticker behind it, like many customer logos
    if rng.random() < 0.3:
        canvas, boxes = _badge(canvas, boxes, rng)
    if rng.random() < 0.35:
        canvas, boxes = _rotate(canvas, boxes, rng.uniform(-18, 18) if rng.random() < 0.85 else rng.uniform(-45, 45))
    return canvas, boxes


def _badge(canvas, boxes, rng):
    pad = int(max(canvas.size) * rng.uniform(0.04, 0.15))
    w, h = canvas.width + 2 * pad, canvas.height + 2 * pad
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(out)
    shape = rng.random()
    colour = random_colour(rng) + (255,)
    if shape < 0.5:
        draw.rounded_rectangle([0, 0, w - 1, h - 1], radius=int(min(w, h) * rng.uniform(0.1, 0.5)), fill=colour)
    elif shape < 0.8:
        draw.ellipse([0, 0, w - 1, h - 1], fill=colour)
    else:
        alpha = canvas.split()[3].filter(ImageFilter.MaxFilter(((pad // 2) | 1)))
        sticker = Image.new("RGBA", canvas.size, (255, 255, 255, 255))
        out.paste(sticker, (pad, pad), alpha)
    out.alpha_composite(canvas, (pad, pad))
    return out, [(c, (b[0] + pad, b[1] + pad, b[2] + pad, b[3] + pad)) for c, b in boxes]


def _rotate(canvas, boxes, degrees):
    w, h = canvas.size
    rotated = canvas.rotate(degrees, resample=Image.BICUBIC, expand=True)
    cx, cy, ncx, ncy = w / 2, h / 2, rotated.width / 2, rotated.height / 2
    a = math.radians(-degrees)
    out = []
    for c, (x0, y0, x1, y1) in boxes:
        pts = []
        for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
            dx, dy = x - cx, y - cy
            pts.append((ncx + dx * math.cos(a) - dy * math.sin(a), ncy + dx * math.sin(a) + dy * math.cos(a)))
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        out.append((c, (min(xs), min(ys), max(xs), max(ys))))
    return rotated, out


def render_rings(rng, size: int, hitster: bool):
    """
    Concentric rings. Hitster's: several thin neon arcs in different colours,
    broken by gaps. Not Hitster: one colour, thick target bands, a vinyl
    record, a spiral. Returns (RGBA, boxes) on a transparent canvas.
    """
    scale = 4
    big = size * scale
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    cx, cy = big / 2, big / 2
    r_max = big * rng.uniform(0.38, 0.5)
    r_min = r_max * rng.uniform(0.25, 0.75)
    if hitster:
        variant = "cardback" if rng.random() < 0.55 else "hitster"
    else:
        variant = rng.choice(["mono", "target", "vinyl", "spiral", "squares", "dots"])

    if variant == "cardback":
        # The back of a real Hitster card: 7-11 evenly spaced rings of one
        # width, the outer ones whole circles, the inner ones shorter arcs,
        # colours in turn, often a QR code in the middle
        n = int(rng.integers(7, 12))
        r_max = big * rng.uniform(0.44, 0.5)
        r_min = r_max * rng.uniform(0.3, 0.5)
        width = max(scale, int(big * rng.uniform(0.004, 0.009)))
        order = [0, 2, 1, 3, 4, 5] if rng.random() < 0.5 else list(rng.permutation(len(NEON)))
        whole = int(rng.integers(2, n // 2 + 2))
        for k in range(n):
            r = r_max - (r_max - r_min) * k / max(1, n - 1)
            colour = NEON[order[k % len(order)]]
            colour = tuple(int(np.clip(c + rng.normal(0, 12), 0, 255)) for c in colour)
            box = [cx - r, cy - r, cx + r, cy + r]
            if k < whole:
                draw.ellipse(box, outline=colour + (255,), width=width)
            else:
                start = rng.uniform(0, 360)
                draw.arc(box, start, start + rng.uniform(80, 320), fill=colour + (255,), width=width)
        if rng.random() < 0.6:
            _draw_qr(draw, cx, cy, r_min * rng.uniform(0.55, 0.75), rng)
        if rng.random() < 0.3:
            glow = image.filter(ImageFilter.GaussianBlur(width * 1.2))
            image = Image.alpha_composite(glow, image)
    elif variant in ("hitster", "mono"):
        n = int(rng.integers(3, 13))
        width = max(scale, int(big * rng.uniform(0.004, 0.02)))
        colour_order = rng.permutation(len(NEON))
        mono = random_colour(rng) if rng.random() < 0.5 else NEON[rng.integers(len(NEON))]
        for k in range(n):
            r = r_min + (r_max - r_min) * k / max(1, n - 1) + rng.normal(0, width * 0.3)
            colour = NEON[colour_order[k % len(NEON)]] if variant == "hitster" else mono
            colour = tuple(int(np.clip(c + rng.normal(0, 18), 0, 255)) for c in colour)
            pieces = int(rng.choice([1, 1, 2, 2, 3])) if rng.random() < 0.85 else 4
            start = rng.uniform(0, 360)
            gap_total = 0 if rng.random() < 0.15 else rng.uniform(20, 150)
            span = (360 - gap_total) / pieces
            for p in range(pieces):
                a0 = start + p * (360 / pieces)
                draw.arc([cx - r, cy - r, cx + r, cy + r], a0, a0 + span * rng.uniform(0.6, 1.0), fill=colour + (255,), width=width)
        if rng.random() < 0.4:
            glow = image.filter(ImageFilter.GaussianBlur(width * 1.5))
            image = Image.alpha_composite(glow, image)
    elif variant == "target":
        n = int(rng.integers(3, 8))
        colours = [random_colour(rng) for _ in range(2)]
        for k in range(n):
            r = r_max * (1 - k / n)
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=colours[k % 2] + (255,))
    elif variant == "vinyl":
        draw.ellipse([cx - r_max, cy - r_max, cx + r_max, cy + r_max], fill=(20, 20, 22, 255))
        for r in np.arange(r_max * 0.35, r_max, scale * 3):
            shade = int(30 + 20 * rng.random())
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(shade, shade, shade, 255), width=scale)
        r = r_max * 0.3
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=random_colour(rng) + (255,))
    elif variant == "spiral":
        colour = random_colour(rng) + (255,)
        pts = [(cx + (r_max * t / 30) * math.cos(t), cy + (r_max * t / 30) * math.sin(t)) for t in np.linspace(0, 30, 600)]
        draw.line(pts, fill=colour, width=max(scale, int(big * 0.01)))
    elif variant == "squares":
        for k in range(int(rng.integers(3, 9))):
            r = r_min + (r_max - r_min) * k / 8
            draw.rectangle([cx - r, cy - r, cx + r, cy + r], outline=NEON[rng.integers(len(NEON))] + (255,), width=max(scale, int(big * 0.01)))
    else:
        for _ in range(60):
            x, y, r = rng.uniform(0, big), rng.uniform(0, big), rng.uniform(big * 0.01, big * 0.05)
            draw.ellipse([x - r, y - r, x + r, y + r], fill=NEON[rng.integers(len(NEON))] + (255,))

    image = image.resize((size, size), Image.LANCZOS)
    boxes = []
    if hitster:
        r = r_max / scale
        boxes = [(RINGS, (size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r))]
    return image, boxes


def _draw_qr(draw, cx, cy, half, rng):
    """A QR-code-like square: random modules and the three finder patterns, light on dark."""
    modules = int(rng.choice([21, 25, 29, 33]))
    cell = 2 * half / modules
    x0, y0 = cx - half, cy - half
    light = (230, 240, 255, 255) if rng.random() < 0.7 else (160, 200, 255, 255)
    dark = (0, 0, 0, 255)
    draw.rectangle([x0 - cell, y0 - cell, x0 + 2 * half + cell, y0 + 2 * half + cell], fill=dark)
    grid = rng.random((modules, modules)) < 0.5
    for fy, fx in ((0, 0), (0, modules - 7), (modules - 7, 0)):
        grid[fy : fy + 7, fx : fx + 7] = False
        grid[fy, fx : fx + 7] = grid[fy + 6, fx : fx + 7] = True
        grid[fy : fy + 7, fx] = grid[fy : fy + 7, fx + 6] = True
        grid[fy + 2 : fy + 5, fx + 2 : fx + 5] = True
    for y, x in zip(*np.nonzero(grid)):
        draw.rectangle([x0 + x * cell, y0 + y * cell, x0 + (x + 1) * cell - 1, y0 + (y + 1) * cell - 1], fill=light)


@lru_cache(maxsize=1)
def references():
    """The marks cut out of the two reference photos, with their boxes."""
    box = Image.open(REFERENCE_DIR / "hitster_box.png").convert("RGBA")
    card = Image.open(REFERENCE_DIR / "hitster_card.png").convert("RGBA").crop((150, 0, 450, 300))
    pieces = [
        (box.crop((236, 124, 1708, 563)), [(WORD, (50, 50, 1422, 389))]),
        (box.crop((574, 624, 1308, 1369)), [(SPEAKER, (50, 50, 684, 695))]),
        (box.crop((257, 1858, 1684, 2218)), [(PILL, (50, 50, 1377, 310))]),
        (box, [(WORD, (286, 174, 1658, 513)), (SPEAKER, (624, 674, 1258, 1319)), (PILL, (307, 1908, 1634, 2168))]),
        (card, [(RINGS, (10, 35, 287, 264)), (WORD, (8, 112, 292, 190))]),
    ]
    return pieces


def render_reference(rng):
    """One of the reference cut-outs, as it is (on black) or with black made transparent."""
    image, boxes = references()[rng.integers(len(references()))]
    if rng.random() < 0.4:
        rgb = np.asarray(image.convert("RGB")).astype(np.float32)
        alpha = np.clip((rgb.max(axis=2) - 25) * 4, 0, 255).astype(np.uint8)
        image = image.copy()
        image.putalpha(Image.fromarray(alpha))
    if rng.random() < 0.3:
        image = ImageOps.mirror(image) if rng.random() < 0.0 else image
        hue = rng.uniform(-0.5, 0.5)
        image = _shift_hue(image, hue)
    return image, list(boxes)


def _shift_hue(image, amount):
    rgba = np.asarray(image).copy()
    hsv = np.asarray(Image.fromarray(rgba[..., :3]).convert("HSV")).copy()
    hsv[..., 0] = (hsv[..., 0].astype(int) + int(amount * 255)) % 256
    rgba[..., :3] = np.asarray(Image.fromarray(hsv, "HSV").convert("RGB"))
    return Image.fromarray(rgba, "RGBA")
