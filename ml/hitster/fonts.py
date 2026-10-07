"""
The fonts the word renderer may use: the Google Fonts download plus this Mac's
own, each checked to really draw the Latin letters (a font without a glyph
draws its "missing" box, and symbol fonts draw pictures). Families are split
into train and eval by a hash of their name, so the eval set measures the
word class on lettering it never saw.

    uv run python fonts.py      # writes data/fonts/usable.json
"""

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "fonts" / "usable.json"
SYSTEM_DIRS = ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", str(Path.home() / "Library/Fonts")]
# Fonts that map letters onto pictures, blocks or waves
EXCLUDE = (
    "dingbat", "wingding", "webding", "symbol", "emoji", "ornament", "icon", "lastresort",
    "barcode", "wavefont", "linefont", "redacted", "flow ", "flowcircular", "flowblock", "flowrounded",
    "braille", "bodoni ornaments", "zapf", "keyboard", "music", "math", "notosans", "notoserif",
    "apple symbols", "applecoloremoji", "sfns", "sf-", "sfcompact", "sfpro", "sfmono",
)
LETTERS = "HITSERhitser"
EVAL_SHARE = 0.15
# CJK collections of tens of MB add nothing to Latin lettering and cost every
# data worker their full size in memory
MAX_BYTES = 5_000_000


def bitmap(font, char):
    image = Image.new("L", (96, 96), 0)
    ImageDraw.Draw(image).text((8, 8), char, font=font, fill=255)
    return np.asarray(image)


def draws_latin(path: str, index: int = 0) -> bool:
    try:
        font = ImageFont.truetype(path, 64, index=index)
        missing = bitmap(font, "")
        seen = []
        for char in LETTERS:
            glyph = bitmap(font, char)
            if glyph.sum() < 255 * 20 or np.array_equal(glyph, missing):
                return False
            seen.append(glyph)
        # A symbol font draws the same picture for different letters, or
        # upper and lower case alike for every letter
        distinct = {g.tobytes() for g in seen}
        return len(distinct) >= len(LETTERS) - 3
    except Exception:
        return False


def family_of(path: str) -> str:
    return Path(path).stem.split("-")[0].lower()


def split_of(family: str) -> str:
    h = int(hashlib.md5(family.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "eval" if h < EVAL_SHARE else "train"


def main():
    candidates = []
    for line in open(ROOT / "data" / "fonts" / "google.jsonl"):
        row = json.loads(line)
        candidates.append((str(ROOT / row["path"]), 0, row["category"]))
    for directory in SYSTEM_DIRS:
        for path in sorted(Path(directory).glob("*")):
            if path.suffix.lower() in (".ttf", ".otf"):
                candidates.append((str(path), 0, "system"))
            elif path.suffix.lower() == ".ttc":
                for index in range(4):
                    candidates.append((str(path), index, "system"))

    usable = []
    for path, index, category in candidates:
        name = Path(path).name.lower()
        if any(word in name for word in EXCLUDE) or Path(path).stat().st_size > MAX_BYTES:
            continue
        if draws_latin(path, index):
            family = family_of(path) + (f"#{index}" if index else "")
            usable.append({"path": path, "index": index, "category": category, "family": family, "split": split_of(family_of(path))})

    # One TTC can hold the same face several times; keep distinct entries only
    seen = set()
    unique = []
    for row in usable:
        key = (row["path"], row["index"])
        if key not in seen:
            seen.add(key)
            unique.append(row)
    OUT.write_text(json.dumps(unique, indent=0))
    by_split = {s: sum(1 for r in unique if r["split"] == s) for s in ("train", "eval")}
    print(f"{len(unique)} usable font faces of {len(candidates)} candidates: {by_split}")


if __name__ == "__main__":
    main()
