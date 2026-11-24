#!/usr/bin/env python3
"""
fetch-sfx.py - reusable CC0/CC-BY sound-effect puller for any WorldGen audio pack.

Usage:
  python fetch-sfx.py --pack event_horizon --per 6
  python fetch-sfx.py --pack red_dwarf --per 6 --license cc0

Reads theme->query map from  public/audio/<pack>/_themes.json
Downloads HQ preview MP3s to   public/audio/<pack>/<theme>/
Writes                          public/audio/<pack>/manifest.json  (per-file licence + attribution)

Key resolution order: env FREESOUND_API_KEY, env SOMA_API, .env SOMA_API, scripts/.freesound_key
"""
import os, sys, json, re, time, argparse, urllib.parse, urllib.request, io

REPO = os.path.abspath(os.environ.get("WORLDGEN_ROOT") or os.path.dirname(os.path.dirname(__file__)))
API  = "https://freesound.org/apiv2"
UA   = {"User-Agent": "Mozilla/5.0 (WorldGen-SFX-fetcher)"}
LICENSE_FILTER = {
  "cc0":  'license:"Creative Commons 0"',
  "ccby": 'license:("Creative Commons 0" OR "Attribution")',
  "any":  "",
}

def _read_env_soma(envpath):
    try:
        for ln in io.open(envpath, encoding="utf-8"):
            ln = ln.strip()
            if ln.startswith("SOMA_API") and "=" in ln:
                v = ln.split("=", 1)[1].strip().strip('"').strip("'")
                if v:
                    return v
    except Exception:
        pass
    return None

def get_key():
    k = os.environ.get("FREESOUND_API_KEY") or os.environ.get("SOMA_API")
    if k:
        return k.strip()
    k = _read_env_soma(os.path.join(REPO, ".env"))
    if k:
        return k
    kf = os.path.join(REPO, "scripts", ".freesound_key")
    if os.path.exists(kf):
        v = io.open(kf, encoding="utf-8").read().strip()
        if v:
            return v
    sys.exit("ERROR: no Freesound API key (FREESOUND_API_KEY / SOMA_API / .env / scripts/.freesound_key).")

def api_get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())

def safe(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(s))[:60].strip("_") or "sound"

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

def read_manifest(packroot):
    mpath = os.path.join(packroot, "manifest.json")
    try:
        data = json.load(io.open(mpath, encoding="utf-8"))
        return {s.get("file"): s for s in data.get("sounds", []) if isinstance(s, dict) and s.get("file")}
    except Exception:
        return {}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", required=True)
    ap.add_argument("--per", type=int, default=6)
    ap.add_argument("--license", choices=["cc0","ccby","any"], default="ccby")
    args = ap.parse_args()
    packroot = os.path.join(REPO, "public", "audio", args.pack)
    tf = os.path.join(packroot, "_themes.json")
    if not os.path.exists(tf):
        sys.exit("ERROR: missing %s (theme->query map)" % tf)
    themes = json.load(io.open(tf, encoding="utf-8"))
    key = get_key()
    os.makedirs(packroot, exist_ok=True)
    manifest = read_manifest(packroot)
    lic = LICENSE_FILTER[args.license]
    for theme, q in themes.items():
        tdir = os.path.join(packroot, theme)
        os.makedirs(tdir, exist_ok=True)
        existing = audio_files(tdir)
        for p in existing:
            rf = os.path.relpath(p, REPO).replace("\\", "/")
            manifest.setdefault(rf, {"theme": theme, "file": rf, "name": os.path.basename(p), "source": "local-resume"})
        if len(existing) >= args.per:
            print("[%s] skip: already has %d files" % (theme, len(existing)))
            continue
        params = {
          "query": q,
          "fields": "id,name,license,username,previews,duration,tags",
          "page_size": str(max(args.per*3, 18)),
          "sort": "rating_desc",
          "token": key,
        }
        if lic:
            params["filter"] = lic
        url = API + "/search/text/?" + urllib.parse.urlencode(params)
        try:
            data = api_get(url)
        except Exception as e:
            print("[%s] search failed: %s" % (theme, e)); continue
        got = len(existing)
        for s in data.get("results", []):
            if got >= args.per:
                break
            prev = (s.get("previews") or {}).get("preview-hq-mp3")
            if not prev:
                continue
            fn = "%s_%s.mp3" % (s["id"], safe(s.get("name")))
            dest = os.path.join(tdir, fn)
            if not (os.path.exists(dest) and os.path.getsize(dest) > 4000):
                try:
                    req = urllib.request.Request(prev, headers=UA)
                    with urllib.request.urlopen(req, timeout=25) as r:
                        b = r.read()
                    if len(b) < 2000:
                        continue
                    open(dest, "wb").write(b)
                except Exception as e:
                    print("[%s] dl %s failed: %s" % (theme, s["id"], e)); continue
            rf = os.path.relpath(dest, REPO).replace("\\", "/")
            manifest[rf] = {
              "theme": theme,
              "file": rf,
              "freesound_id": s["id"], "name": s.get("name"),
              "license": s.get("license"), "author": s.get("username"),
              "source": "https://freesound.org/s/%s/" % s["id"],
              "duration": s.get("duration"),
            }
            got += 1
            print("[%s] %d/%d  %s" % (theme, got, args.per, fn))
            time.sleep(0.3)
    mpath = os.path.join(packroot, "manifest.json")
    sounds = sorted(manifest.values(), key=lambda s: (s.get("theme", ""), s.get("file", "")))
    json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "pack": args.pack, "license_mode": args.license,
                "count": len(sounds), "sounds": sounds},
               io.open(mpath, "w", encoding="utf-8"), indent=2)
    print("\nDONE pack=%s: %d sounds -> %s" % (args.pack, len(sounds), packroot))

if __name__ == "__main__":
    main()
