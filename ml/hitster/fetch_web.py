"""
Download the public Hitster pictures (and look-alikes) a research pass listed,
one plain GET per image, two at a time per host. Input: a JSON-lines file of
{"url", "fallback_url"?, "label": "hitster"|"negative", "what", "edition",
"source"}. Output: data/web/<label>/<sha1 of url>.<ext>, at most 1280 px, and
data/web/index.jsonl. Safe to rerun.

    uv run python fetch_web.py <urls.jsonl>
"""

import hashlib
import io
import json
import sys
import threading
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "web"
INDEX = OUT / "index.jsonl"
AGENT = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"}
# Our own product pictures come from the repo, not from the site
SKIP_HOSTS = {"www.qrsong.io", "qrsong.io"}
# The word is the name, whoever uses it
RELABEL = {"hitster.fm": "hitster"}
MAX_SIDE = 1280
host_locks = defaultdict(lambda: threading.Semaphore(2))


def get(url):
    host = urlparse(url).netloc
    with host_locks[host]:
        request = urllib.request.Request(url, headers=AGENT)
        with urllib.request.urlopen(request, timeout=40) as response:
            return response.read()


def save(row):
    label = row["label"]
    for needle, new in RELABEL.items():
        if needle in row["url"].lower() or needle in (row.get("source") or "").lower():
            label = new
    key = hashlib.sha1(row["url"].encode()).hexdigest()[:16]
    record = {**row, "label": label, "key": key}
    for url in [row["url"]] + ([row["fallback_url"]] if row.get("fallback_url") else []):
        try:
            raw = get(url)
            image = Image.open(io.BytesIO(raw))
            image.load()
            # YouTube's "no maxres" placeholder is a 120x90 grey picture
            if image.width <= 120 and "ytimg" in url:
                continue
            has_alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
            image = image.convert("RGBA" if has_alpha else "RGB")
            image.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
            folder = OUT / label
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / f"{key}.{'png' if has_alpha else 'jpg'}"
            image.save(path, "PNG" if has_alpha else "JPEG", **({} if has_alpha else {"quality": 92}))
            record.update(status="ok", fetched=url, path=str(path.relative_to(ROOT)), size=image.size)
            return record
        except Exception as e:
            record.update(status="error", error=f"{type(e).__name__}: {e}"[:160])
    return record


def main():
    rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
    rows = [r for r in rows if urlparse(r["url"]).netloc not in SKIP_HOSTS]
    done = set()
    if INDEX.exists():
        done = {json.loads(l)["url"] for l in open(INDEX) if json.loads(l).get("status") == "ok"}
    todo = [r for r in rows if r["url"] not in done]
    print(f"{len(rows)} urls, {len(done)} done before, {len(todo)} to fetch", flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    counts = defaultdict(int)
    with open(INDEX, "a") as index, ThreadPoolExecutor(8) as pool:
        for record in pool.map(save, todo):
            index.write(json.dumps(record) + "\n")
            counts[(record["label"], record["status"])] += 1
    print(dict(counts))


if __name__ == "__main__":
    main()
