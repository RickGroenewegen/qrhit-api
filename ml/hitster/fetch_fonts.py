"""
Fetch open-licence font families from Google Fonts, for rendering the word
"Hitster" (and the look-alike words it must not be confused with) in as many
styles as customers might use.

Every Display family, and a sample of Handwriting, Sans Serif, Serif and
Monospace ones, regular and (where there is one) bold. Saved as TTF under
data/fonts/google/<family>-<weight>.ttf; data/fonts/google.jsonl lists them.
Safe to rerun.

    uv run python fetch_fonts.py
"""

import json
import random
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "fonts" / "google"
INDEX = ROOT / "data" / "fonts" / "google.jsonl"
SAMPLE = {"Display": 10_000, "Handwriting": 170, "Sans Serif": 130, "Serif": 90, "Monospace": 25}
# The CSS API hands a plain user agent TrueType files
AGENT = {"User-Agent": "curl/8"}


def get(url: str) -> bytes:
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=AGENT), timeout=30) as r:
                return r.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)
    raise RuntimeError(url)


def families():
    meta = json.loads(get("https://fonts.google.com/metadata/fonts"))["familyMetadataList"]
    usable = [
        f for f in meta
        if "latin" in f.get("subsets", [])
        and not f.get("isNoto")
        and f.get("primaryScript", "") in ("", "Latn")
        and f.get("isOpenSource", True)
    ]
    rng = random.Random(7)
    chosen = []
    for category, count in SAMPLE.items():
        group = sorted((f for f in usable if f["category"] == category), key=lambda f: f["family"])
        rng.shuffle(group)
        chosen += group[:count]
    return chosen


def fetch(family: dict):
    name = family["family"]
    weights = ["400"] + (["700"] if "700" in family.get("fonts", {}) else [])
    if "400" not in family.get("fonts", {}):
        weights = [sorted(w for w in family.get("fonts", {}) if w.isdigit())[0]]
    saved = []
    for weight in weights:
        slug = re.sub(r"[^A-Za-z0-9]+", "", name)
        path = OUT / f"{slug}-{weight}.ttf"
        if not path.exists():
            query = urllib.parse.quote(name) + (f":wght@{weight}" if weight != "400" else "")
            css = get(f"https://fonts.googleapis.com/css2?family={query}").decode()
            urls = re.findall(r"url\((https://fonts\.gstatic\.com/[^)]+\.ttf)\)", css)
            if not urls:
                continue
            path.write_bytes(get(urls[-1]))
        saved.append({"family": name, "category": family["category"], "weight": weight, "path": str(path.relative_to(ROOT))})
    return saved


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    chosen = families()
    print(f"{len(chosen)} families", flush=True)
    rows = []
    with ThreadPoolExecutor(6) as pool:
        for n, result in enumerate(pool.map(lambda f: _safe(fetch, f), chosen), 1):
            rows += result
            if n % 100 == 0:
                print(f"{n}/{len(chosen)} families, {len(rows)} files", flush=True)
    with open(INDEX, "w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    print(f"{len(rows)} font files", flush=True)


def _safe(fn, arg):
    try:
        return fn(arg)
    except Exception as e:
        print(f"skip {arg['family']}: {e}", flush=True)
        return []


if __name__ == "__main__":
    main()
