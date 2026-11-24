#!/usr/bin/env python3
# fetch-sfx-parallel.py - resumable Freesound fetcher for world sound packs.
import os, sys, json, re, time, argparse, urllib.parse, urllib.request, urllib.error, io
from concurrent.futures import ThreadPoolExecutor, as_completed

REPO = os.path.abspath(os.environ.get("WORLDGEN_ROOT") or os.path.dirname(os.path.dirname(__file__)))
API  = "https://freesound.org/apiv2"
UA   = {"User-Agent": "Mozilla/5.0 (WorldGen-SFX-fetcher-parallel)"}
QUOTE = chr(39)
LICENSE_FILTER = {
  "cc0":  "license:\"Creative Commons 0\"",
  "ccby": "license:(\"Creative Commons 0\" OR \"Attribution\")",
  "any":  "",
}

def _read_env_soma(envpath):
    try:
        for ln in io.open(envpath, encoding="utf-8"):
            ln = ln.strip()
            if ln.startswith("SOMA_API") and "=" in ln:
                v = ln.split("=", 1)[1].strip()
                if v and v[0] in ("\"", QUOTE) and v[-1] == v[0]:
                    v = v[1:-1]
                if v: return v
    except Exception:
        pass
    return None

def get_key():
    k = os.environ.get("FREESOUND_API_KEY") or os.environ.get("SOMA_API")
    if k: return k.strip()
    k = _read_env_soma(os.path.join(REPO, ".env"))
    if k: return k
    kf = os.path.join(REPO, "scripts", ".freesound_key")
    if os.path.exists(kf):
        v = io.open(kf, encoding="utf-8").read().strip()
        if v: return v
    sys.exit("ERROR: no Freesound API key.")

def safe(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(s))[:60].strip("_") or "sound"

def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")

def read_json(path, fallback):
    try:
        return json.load(io.open(path, encoding="utf-8"))
    except Exception:
        return fallback

def write_json(path, value):
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2)
    os.replace(tmp, path)

def audio_files(tdir):
    out = []
    try:
        for fn in sorted(os.listdir(tdir)):
            if fn.lower().endswith((".mp3", ".ogg", ".wav", ".flac")):
                p = os.path.join(tdir, fn)
                if os.path.getsize(p) > 4000:
                    out.append(p)
    except Exception:
        pass
    return out

def rel(path):
    return os.path.relpath(path, REPO).replace("\\", "/")

def state_matches(item, query, per, license_mode):
    return item and item.get("query") == query and item.get("per") == per and item.get("license") == license_mode

def mark_done(state, theme, query, per, license_mode, count):
    state.setdefault("completedThemes", {})[theme] = {
        "query": query,
        "per": per,
        "license": license_mode,
        "count": count,
        "updated": now(),
    }

def existing_manifest_by_file(packroot):
    data = read_json(os.path.join(packroot, "manifest.json"), {})
    by_file = {}
    for s in data.get("sounds", []) if isinstance(data, dict) else []:
        f = s.get("file")
        if f:
            by_file[f] = s
    return by_file

def minimal_entry(theme, dest):
    return {"theme": theme, "file": rel(dest), "name": os.path.basename(dest), "source": "local-resume"}

def api_get(url, retries=4):
    delay = 2.0
    for attempt in range(retries):
        req = urllib.request.Request(url, headers=UA)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == retries - 1:
                raise
            retry_after = e.headers.get("Retry-After")
            try:
                wait = float(retry_after) if retry_after else delay
            except Exception:
                wait = delay
            print("  rate limited by Freesound; sleeping %.1fs" % wait, flush=True)
            time.sleep(wait)
            delay = min(delay * 2, 60.0)

def download(job):
    pack, theme, url, dest, entry = job
    if os.path.exists(dest) and os.path.getsize(dest) > 4000:
        return (pack, theme, dest, entry, "skip", os.path.getsize(dest))
    delay = 2.0
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                b = r.read()
            if len(b) < 2000:
                return (pack, theme, dest, entry, "tiny", len(b))
            tmp = dest + ".part"
            open(tmp, "wb").write(b)
            os.replace(tmp, dest)
            return (pack, theme, dest, entry, "ok", len(b))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                retry_after = e.headers.get("Retry-After")
                try:
                    wait = float(retry_after) if retry_after else delay
                except Exception:
                    wait = delay
                time.sleep(wait)
                delay = min(delay * 2, 60.0)
                continue
            return (pack, theme, dest, entry, "fail:" + str(e)[:80], 0)
        except Exception as e:
            return (pack, theme, dest, entry, "fail:" + str(e)[:80], 0)

def build_search_items(pack, theme, query, packroot, per, license_mode, key):
    params = {"query": query, "fields": "id,name,license,username,previews,duration",
              "page_size": str(max(per * 3, 18)), "sort": "rating_desc", "token": key}
    lic = LICENSE_FILTER[license_mode]
    if lic: params["filter"] = lic
    url = API + "/search/text/?" + urllib.parse.urlencode(params)
    data = api_get(url)
    items = []
    got = 0
    tdir = os.path.join(packroot, theme)
    for s in data.get("results", []):
        if got >= per: break
        prev = (s.get("previews") or {}).get("preview-hq-mp3")
        if not prev: continue
        fn = "%s_%s.mp3" % (s["id"], safe(s.get("name")))
        dest = os.path.join(tdir, fn)
        items.append({
            "preview": prev,
            "entry": {"theme": theme, "file": rel(dest), "freesound_id": s["id"], "name": s.get("name"),
                      "license": s.get("license"), "author": s.get("username"),
                      "source": "https://freesound.org/s/%s/" % s["id"], "duration": s.get("duration")}
        })
        got += 1
    return items

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--packs", required=True, help="comma-separated pack names")
    ap.add_argument("--per", type=int, default=6)
    ap.add_argument("--license", choices=["cc0","ccby","any"], default="ccby")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--query-delay", type=float, default=1.0, help="seconds between uncached Freesound searches")
    args = ap.parse_args()
    key = get_key()
    all_jobs = []
    pack_meta = {}
    searched = {}

    for pack in args.packs.split(","):
        pack = pack.strip()
        if not pack: continue
        packroot = os.path.join(REPO, "public", "audio", pack)
        tf = os.path.join(packroot, "_themes.json")
        if not os.path.exists(tf):
            print("SKIP %s: missing _themes.json" % pack); continue
        themes = json.load(io.open(tf, encoding="utf-8"))
        os.makedirs(packroot, exist_ok=True)
        state_path = os.path.join(packroot, "_fetch_progress.json")
        state = read_json(state_path, {})
        state.setdefault("version", 1)
        state.setdefault("pack", pack)
        state.setdefault("completedThemes", {})
        state.setdefault("searches", {})
        state["updated"] = now()
        manifest_by_file = existing_manifest_by_file(packroot)
        pack_meta[pack] = {"packroot": packroot, "state": state, "state_path": state_path, "manifest": manifest_by_file}
        searched[pack] = {}

        for theme, q in themes.items():
            tdir = os.path.join(packroot, theme)
            os.makedirs(tdir, exist_ok=True)
            files = audio_files(tdir)
            completed = state_matches(state["completedThemes"].get(theme), q, args.per, args.license)
            if completed and len(files) >= min(args.per, max(1, state["completedThemes"][theme].get("count", 0))):
                print("[%s/%s] resume skip: complete (%d files)" % (pack, theme, len(files)))
                for p in files:
                    manifest_by_file.setdefault(rel(p), minimal_entry(theme, p))
                continue
            if len(files) >= args.per:
                print("[%s/%s] resume mark: already has %d files" % (pack, theme, len(files)))
                for p in files:
                    manifest_by_file.setdefault(rel(p), minimal_entry(theme, p))
                mark_done(state, theme, q, args.per, args.license, len(files))
                write_json(state_path, state)
                continue

            cache = state["searches"].get(theme)
            if state_matches(cache, q, args.per, args.license) and isinstance(cache.get("items"), list):
                items = cache["items"]
                print("[%s/%s] resume search cache: %d results" % (pack, theme, len(items)))
            else:
                try:
                    items = build_search_items(pack, theme, q, packroot, args.per, args.license, key)
                    state["searches"][theme] = {"query": q, "per": args.per, "license": args.license, "items": items, "updated": now()}
                    write_json(state_path, state)
                    time.sleep(max(0, args.query_delay))
                except Exception as e:
                    print("[%s/%s] search fail: %s" % (pack, theme, e)); continue
            searched[pack][theme] = {"query": q, "planned": len(items)}
            if not items:
                mark_done(state, theme, q, args.per, args.license, len(files))
                write_json(state_path, state)
                continue
            for item in items:
                entry = item.get("entry") or {}
                dest = os.path.join(REPO, entry.get("file", ""))
                if os.path.exists(dest) and os.path.getsize(dest) > 4000:
                    manifest_by_file.setdefault(entry["file"], entry)
                else:
                    all_jobs.append((pack, theme, item.get("preview"), dest, entry))

    workers = max(1, min(int(args.workers), 8))
    print("queued %d downloads across %d packs, workers=%d" % (len(all_jobs), len(pack_meta), workers))
    t0 = time.time()
    done = 0
    failed_themes = set()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(download, j) for j in all_jobs]
        for f in as_completed(futs):
            pack, theme, dest, entry, status, n = f.result()
            done += 1
            if status in ("ok", "skip") and os.path.exists(dest) and os.path.getsize(dest) > 4000:
                pack_meta[pack]["manifest"].setdefault(entry["file"], entry)
            else:
                failed_themes.add((pack, theme))
            if done % 10 == 0 or status.startswith("fail"):
                print("  [%d/%d] %s %s" % (done, len(all_jobs), status, os.path.basename(dest)))

    dt = time.time() - t0
    for pack, meta in pack_meta.items():
        packroot = meta["packroot"]
        state = meta["state"]
        for theme, info in searched.get(pack, {}).items():
            if (pack, theme) in failed_themes:
                continue
            tdir = os.path.join(packroot, theme)
            files = audio_files(tdir)
            target = min(args.per, max(1, info.get("planned", 0)))
            if len(files) >= target:
                mark_done(state, theme, info["query"], args.per, args.license, len(files))
        write_json(meta["state_path"], state)
        sounds = sorted(meta["manifest"].values(), key=lambda s: (s.get("theme", ""), s.get("file", "")))
        mpath = os.path.join(packroot, "manifest.json")
        write_json(mpath, {"generated": now(), "pack": pack, "license_mode": args.license, "count": len(sounds), "sounds": sounds})
    print("\nFINISHED in %.1fs - manifests written for %d packs" % (dt, len(pack_meta)))

if __name__ == "__main__":
    main()
