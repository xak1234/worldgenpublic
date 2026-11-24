#!/usr/bin/env python3
"""
fetch-titanic-sfx.py - pull CC0 Titanic-era sound effects from the Freesound
API into the WorldGen project for the Titanic world's soundscape.

Requires a FREE Freesound API key:
  1. Make a free account at https://freesound.org
  2. Apply for an API key: https://freesound.org/apiv2/apply/
  3. Provide it via:
       - env var  FREESOUND_API_KEY        (preferred), OR
       - a file   scripts\.freesound_key   (just the key, one line)

Usage:
  python fetch-titanic-sfx.py                 # default set, 6 per theme, CC0
  python fetch-titanic-sfx.py --per 10        # 10 per theme
  python fetch-titanic-sfx.py --license ccby  # cc0 (default) | ccby | any
"""
import os, sys, json, re, time, argparse, urllib.parse, urllib.request, io

REPO   = os.path.abspath(os.environ.get("WORLDGEN_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUTDIR = os.path.join(REPO, "public", "audio", "titanic")
API    = "https://freesound.org/apiv2"
UA     = {"User-Agent": "Mozilla/5.0 (WorldGen-SFX-fetcher)"}

THEMES = {
  "ship_creak":    "ship creak",
  "steam_whistle": "steam whistle",
  "ocean":         "ocean waves",
  "iceberg":       "ice crack",
  "engine_room":   "steam engine",
  "telegraph":     "morse telegraph",
  "crowd_panic":   "crowd panic",
  "deck_ambience": "ship deck wind",
  "water_rush":    "rushing water",
  "lifeboat":      "rope pulley creak",
}
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
                v = ln.split("=", 1)[1].strip().strip('"').strip("\'")
                if v:
                    return v
    except Exception:
        pass
    return None

def get_key():
    # 1. explicit override
    k = os.environ.get("FREESOUND_API_KEY")
    if k:
        return k.strip()
    # 2. WorldGen's own configured key (SOMA_API in .env) - the one the server uses
    k = os.environ.get("SOMA_API")
    if k:
        return k.strip()
    k = _read_env_soma(os.path.join(REPO, ".env"))
    if k:
        return k
    # 3. local key file fallback
    kf = os.path.join(REPO, "scripts", ".freesound_key")
    if os.path.exists(kf):
        v = io.open(kf, encoding="utf-8").read().strip()
        if v:
            return v
    sys.exit("ERROR: no Freesound API key (checked FREESOUND_API_KEY, SOMA_API, .env, scripts\.freesound_key).")

def api_get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())

def safe(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(s))[:60].strip("_") or "sound"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per", type=int, default=6, help="sounds per theme")
    ap.add_argument("--license", choices=["cc0","ccby","any"], default="ccby")
    args = ap.parse_args()
    key = get_key()
    os.makedirs(OUTDIR, exist_ok=True)
    manifest = []
    lic = LICENSE_FILTER[args.license]
    for theme, q in THEMES.items():
        tdir = os.path.join(OUTDIR, theme); os.makedirs(tdir, exist_ok=True)
        params = {
          "query": q,
          "fields": "id,name,license,username,previews,duration,tags",
          "page_size": str(max(args.per*3, 18)),
          "sort": "rating_desc",
          "token": key,
        }
        if lic: params["filter"] = lic
        url = API + "/search/text/?" + urllib.parse.urlencode(params)
        try:
            data = api_get(url)
        except Exception as e:
            print(f"[{theme}] search failed: {e}"); continue
        got = 0
        for s in data.get("results", []):
            if got >= args.per: break
            prev = (s.get("previews") or {}).get("preview-hq-mp3")
            if not prev: continue
            fn = f"{s['id']}_{safe(s.get('name'))}.mp3"
            dest = os.path.join(tdir, fn)
            if not (os.path.exists(dest) and os.path.getsize(dest) > 4000):
                try:
                    req = urllib.request.Request(prev, headers=UA)
                    with urllib.request.urlopen(req, timeout=25) as r:
                        b = r.read()
                    if len(b) < 2000: continue
                    open(dest, "wb").write(b)
                except Exception as e:
                    print(f"[{theme}] dl {s['id']} failed: {e}"); continue
            manifest.append({
              "theme": theme,
              "file": os.path.relpath(dest, REPO).replace("\\","/"),
              "freesound_id": s["id"], "name": s.get("name"),
              "license": s.get("license"), "author": s.get("username"),
              "source": f"https://freesound.org/s/{s['id']}/",
              "duration": s.get("duration"),
            })
            got += 1
            print(f"[{theme}] {got}/{args.per}  {fn}")
            time.sleep(0.3)
    mpath = os.path.join(OUTDIR, "manifest.json")
    json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "license_mode": args.license, "count": len(manifest),
               "sounds": manifest}, open(mpath,"w",encoding="utf-8"), indent=2)
    print(f"\nDONE: {len(manifest)} sounds -> {OUTDIR}")
    print(f"manifest -> {mpath}  (per-file attribution + license recorded there)")

if __name__ == "__main__":
    main()

