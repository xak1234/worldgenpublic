#!/usr/bin/env python3
import argparse, glob, json, os, re, time, urllib.parse, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_dd = os.environ.get("WORLDGEN_DATA_DIR")
DATA = os.path.abspath(os.path.join(ROOT, _dd)) if _dd else os.path.join(ROOT, "data")
PUBLIC = os.path.join(ROOT, "public")
GENERATED = os.path.join(PUBLIC, "generated")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
PANELS = ("geography", "economy")

def req(url, accept="*/*", referer="https://duckduckgo.com/"):
    return urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": referer,
    })

def fetch_text(url, timeout=25, accept="text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", referer="https://duckduckgo.com/"):
    with urllib.request.urlopen(req(url, accept=accept, referer=referer), timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")

def clean_title(raw):
    s = str(raw or "")
    s = re.sub(r"[_]+", " ", s)
    s = re.sub(r"\s*[\-–—:|]\s*(full text|shooting script|screenplay|script|transcript|dialogue transcript|movie|film|book|novel|wikipedia).*$", "", s, flags=re.I)
    s = re.sub(r"\([^)]*(script|transcript|screenplay|film|movie|novel|book)[^)]*\)", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:120]

def world_title(world):
    docs = world.get("sourceDocuments") or []
    if isinstance(docs, list):
        for d in reversed(docs):
            title = clean_title((d or {}).get("title") or (d or {}).get("source") or (d or {}).get("path"))
            if title:
                return title
    return clean_title(world.get("name") or world.get("title") or world.get("concept") or world.get("id"))

def enhanced(world):
    docs = world.get("sourceDocuments") or []
    return isinstance(docs, list) and len(docs) > 0

def ddg_images(query, limit=8):
    q = urllib.parse.quote_plus(query)
    search_url = f"https://duckduckgo.com/?q={q}&iax=images&ia=images&kl=us-en"
    html = fetch_text(search_url)
    m = re.search(r"vqd=['\"]?([^'\"&<>]+)", html)
    if not m:
        raise RuntimeError("DuckDuckGo vqd token not found")
    vqd = urllib.parse.quote_plus(m.group(1))
    data = fetch_text(
        f"https://duckduckgo.com/i.js?l=us-en&o=json&q={q}&vqd={vqd}&f=,,,&p=1",
        accept="application/json,text/javascript,*/*;q=0.8",
        referer=search_url,
    )
    raw = json.loads(data)
    out = []
    seen = set()
    for item in raw.get("results") or []:
        url = str(item.get("image") or item.get("thumbnail") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(url)
        if len(out) >= limit:
            break
    return out

def download_image(url, dest_base):
    with urllib.request.urlopen(req(url, accept="image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"), timeout=30) as r:
        ctype = str(r.headers.get("content-type") or "").lower()
        if not ctype.startswith("image/"):
            raise RuntimeError("not image: " + ctype)
        ext = ".jpg"
        if "png" in ctype: ext = ".png"
        elif "webp" in ctype: ext = ".webp"
        elif "gif" in ctype: ext = ".gif"
        data = r.read(12 * 1024 * 1024 + 1)
        if len(data) < 4096 or len(data) > 12 * 1024 * 1024:
            raise RuntimeError("image size out of range")
    dest = dest_base + ext
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(data)
    return dest

def fetch_for_world(path, force=False, dry_run=False):
    with open(path, encoding="utf-8") as f:
        world = json.load(f)
    wid = world.get("id") or os.path.basename(path).replace("world-", "").replace(".json", "")
    title = world_title(world)
    if not wid or not title:
        return {"worldId": wid, "changed": False, "error": "missing world id/title"}
    images = world.setdefault("images", {})
    panels = images.setdefault("panelBackgrounds", {})
    sources = images.setdefault("panelBackgroundSources", {})
    missing = [p for p in PANELS if force or not panels.get(p)]
    if not missing:
        return {"worldId": wid, "title": title, "changed": False, "skipped": "already populated"}
    query = f"{title} film still movie scene"
    if dry_run:
        return {"worldId": wid, "title": title, "query": query, "needed": missing, "changed": False}
    urls = ddg_images(query, limit=10)
    changed = False
    used = set()
    for panel in missing:
        for url in urls:
            if url in used:
                continue
            try:
                dest = download_image(url, os.path.join(GENERATED, wid, f"panel-{panel}"))
                rel = "/" + os.path.relpath(dest, PUBLIC).replace(os.sep, "/")
                panels[panel] = rel
                sources[panel] = {"kind": "duckduckgo", "query": query, "sourceUrl": url, "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                used.add(url)
                changed = True
                break
            except Exception:
                continue
    if changed:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(world, f, indent=2, ensure_ascii=False)
            f.write("\n")
    return {"worldId": wid, "title": title, "query": query, "changed": changed, "filled": [p for p in PANELS if panels.get(p)]}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", help="only one world id")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--all-worlds", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    files = sorted(glob.glob(os.path.join(DATA, "world-*.json")))
    done = failed = 0
    for path in files:
        if args.limit and done + failed >= args.limit:
            break
        try:
            with open(path, encoding="utf-8") as f:
                world = json.load(f)
            if args.world and world.get("id") != args.world:
                continue
            if not args.all_worlds and not enhanced(world):
                continue
            result = fetch_for_world(path, force=args.force, dry_run=args.dry_run)
            print(json.dumps(result, ensure_ascii=False))
            if result.get("error") or (not result.get("changed") and not result.get("skipped") and not args.dry_run):
                failed += 1
            else:
                done += 1
        except Exception as e:
            failed += 1
            print(json.dumps({"file": os.path.basename(path), "error": str(e)}))
    if failed:
        raise SystemExit(1)

if __name__ == "__main__":
    main()
