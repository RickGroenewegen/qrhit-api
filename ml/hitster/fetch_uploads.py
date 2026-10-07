"""
Download every card and box image customers used on Print&Bind order lines.

Reads the two exports made with the read-only database user (see README.md):
data/prod/order_lines.tsv and data/prod/extra_designs.tsv. Each distinct
upload is fetched once from https://api.qrsong.io/public/<folder>/<file>,
shrunk to at most 1280 px on the long side (training never looks closer) and
written to data/prod/images/<folder>/. data/prod/images.jsonl says per file
which fields used it, how many order lines, and the md5 of the original bytes
(a preset picked in the designer is copied under a new random name, so many
uploads are the same picture).

Safe to rerun: files already on disk are skipped.

    uv run python fetch_uploads.py [--workers 6]
"""

import argparse
import csv
import hashlib
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
PROD = ROOT / "data" / "prod"
OUT = PROD / "images"
INDEX = PROD / "images.jsonl"
BASE = "https://api.qrsong.io/public"
MAX_SIDE = 1280
# The names Designer gives its uploads (src/designer.ts). Anything else, such
# as legacy_default_blue.png, is our own artwork.
UPLOAD = re.compile(r"^[a-z0-9]{8,64}\.(png|jpe?g|webp)$", re.I)

# Which public folder serves each field
FIELDS = {
    "background": ("background", "card"),
    "backgroundBack": ("background", "card"),
    "logo": ("logo", "card"),
    "boxFrontBackground": ("background", "box"),
    "boxFrontLogo": ("logo", "box"),
    "boxBackBackground": ("background", "box"),
}

Image.MAX_IMAGE_PIXELS = 200_000_000


def references():
    """(folder, filename) -> {fields, kinds, lines}."""
    refs = defaultdict(lambda: {"fields": set(), "kinds": set(), "lines": set()})

    def add(row, field, php_id):
        value = (row.get(field) or "").strip()
        if not value or value == "NULL" or not UPLOAD.match(value):
            return
        folder, kind = FIELDS[field]
        ref = refs[(folder, value)]
        ref["fields"].add(field)
        ref["kinds"].add(kind)
        ref["lines"].add(php_id)

    with open(PROD / "order_lines.tsv", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            for field in FIELDS:
                add(row, field, row["phpId"])
    with open(PROD / "extra_designs.tsv", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            for field in ("background", "backgroundBack", "logo"):
                add(row, field, row["phpId"])
    return refs


def shrink(raw: bytes):
    """The picture at most MAX_SIDE wide or high: PNG when it has alpha, else JPEG."""
    image = Image.open(io.BytesIO(raw))
    image.load()
    width, height = image.size
    has_alpha = image.mode in ("RGBA", "LA", "PA") or (
        image.mode == "P" and "transparency" in image.info
    )
    image = image.convert("RGBA" if has_alpha else "RGB")
    image.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    buffer = io.BytesIO()
    if has_alpha:
        image.save(buffer, "PNG", optimize=True)
        extension = "png"
    else:
        image.save(buffer, "JPEG", quality=92)
        extension = "jpg"
    return buffer.getvalue(), extension, (width, height)


def fetch(folder: str, name: str):
    url = f"{BASE}/{folder}/{name}"
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "qrsong-ml-dataset/1"})
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return 404, None
            if attempt == 2:
                return e.code, None
        except Exception:
            if attempt == 2:
                return 0, None
        time.sleep(2 * (attempt + 1))
    return 0, None


def done_names():
    if not INDEX.exists():
        return set()
    with open(INDEX) as f:
        return {(r["folder"], r["name"]) for r in map(json.loads, f) if r["status"] in (200, 404)}


def work(key, ref):
    folder, name = key
    record = {
        "folder": folder,
        "name": name,
        "fields": sorted(ref["fields"]),
        "kinds": sorted(ref["kinds"]),
        "lines": len(ref["lines"]),
    }
    status, raw = fetch(folder, name)
    record["status"] = status
    if raw:
        record["bytes"] = len(raw)
        record["md5"] = hashlib.md5(raw).hexdigest()
        try:
            data, extension, size = shrink(raw)
            path = OUT / folder / f"{Path(name).stem}.{extension}"
            path.write_bytes(data)
            record["path"] = str(path.relative_to(ROOT))
            record["size"] = size
        except Exception as e:
            record["error"] = f"{type(e).__name__}: {e}"
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    for folder in ("background", "logo"):
        (OUT / folder).mkdir(parents=True, exist_ok=True)
    refs = references()
    skip = done_names()
    todo = [(key, ref) for key, ref in refs.items() if key not in skip]
    print(f"{len(refs)} distinct uploads, {len(skip)} done before, {len(todo)} to fetch", flush=True)

    counts = defaultdict(int)
    started = time.time()
    with open(INDEX, "a") as index, ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(work, key, ref) for key, ref in todo]
        for n, future in enumerate(as_completed(futures), 1):
            record = future.result()
            index.write(json.dumps(record) + "\n")
            counts[record["status"]] += 1
            if n % 250 == 0 or n == len(futures):
                index.flush()
                rate = n / (time.time() - started)
                print(f"{n}/{len(futures)} {dict(counts)} {rate:.1f}/s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
