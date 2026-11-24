"""Build a one-time FanCaps catalog index: title+year -> movieid"""
import json, os, re, time, string
from pathlib import Path
from curl_cffi import requests

ROOT = Path(os.environ.get("WORLDGEN_ROOT") or Path(__file__).resolve().parent.parent)
OUT = ROOT / "public" / "imdb-cache" / "_fancaps_index.json"
OUT.parent.mkdir(parents=True, exist_ok=True)

LETTERS = ["0"] + list(string.ascii_lowercase)
items = {}   # movieid -> {name_slug, title, year}
for L in LETTERS:
    url = f"https://fancaps.net/movies/showList.php?{L}"
    r = requests.get(url, impersonate="chrome120", timeout=30)
    found = re.findall(r'href="/movies/MovieImages\.php\?name=([^&]+)&movieid=(\d+)"', r.text)
    new = 0
    for name, mid in found:
        if mid in items: continue
        # parse trailing year if present
        m = re.search(r"_(\d{4})$", name)
        year = int(m.group(1)) if m else None
        title = re.sub(r"_\d{4}$", "", name).replace("_", " ")
        items[mid] = {"name": name, "title": title, "year": year}
        new += 1
    print(f"  letter {L}: +{new}  total={len(items)}")
    time.sleep(0.4)

OUT.write_text(json.dumps(items, indent=2), encoding="utf-8")
print(f"\nwrote {OUT}  ({len(items)} movies)")
