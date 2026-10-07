"""
A contact sheet of images, numbered, for looking at many at once.

    uv run python sheet.py out.jpg name-or-path ... [--cols 5] [--tile 300]

A bare upload name is looked up in data/prod/images. Transparent pixels show
as a grey checkerboard, so a white logo stays visible.
"""

import argparse
import glob
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent


def resolve(item: str) -> Path:
    path = Path(item)
    if path.exists():
        return path
    found = glob.glob(str(ROOT / "data" / "prod" / "images" / "*" / f"{Path(item).stem}.*"))
    if not found:
        raise FileNotFoundError(item)
    return Path(found[0])


def checker(size, step=16):
    board = Image.new("RGB", size, (200, 200, 200))
    draw = ImageDraw.Draw(board)
    for y in range(0, size[1], step):
        for x in range((y // step) % 2 * step, size[0], step * 2):
            draw.rectangle([x, y, x + step - 1, y + step - 1], fill=(150, 150, 150))
    return board


def tile_of(path: Path, tile: int) -> Image.Image:
    image = Image.open(path).convert("RGBA")
    image.thumbnail((tile, tile))
    base = checker(image.size).convert("RGBA")
    base.alpha_composite(image)
    return base.convert("RGB")


def build(items, out, cols=5, tile=300, labels=None):
    tiles = [tile_of(resolve(i), tile) for i in items]
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (tile + 8), rows * (tile + 26)), "white")
    draw = ImageDraw.Draw(sheet)
    for n, image in enumerate(tiles):
        x = (n % cols) * (tile + 8)
        y = (n // cols) * (tile + 26)
        sheet.paste(image, (x + (tile - image.width) // 2, y + 22 + (tile - image.height) // 2))
        label = labels[n] if labels else ""
        draw.text((x + 2, y + 4), f"{n + 1}. {label}"[:48], fill="black")
    sheet.save(out, quality=85)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("items", nargs="+")
    parser.add_argument("--cols", type=int, default=5)
    parser.add_argument("--tile", type=int, default=300)
    args = parser.parse_args()
    build(args.items, args.out, args.cols, args.tile, [Path(i).stem[:10] for i in args.items])


if __name__ == "__main__":
    main()
