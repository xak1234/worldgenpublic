#!/usr/bin/env python3
# enhance-bland-packs.py - use DeepSeek to regenerate themes for packs that fell back to generic city_modern.
# Validates queries against Freesound (must return >0 hits) and retries with simpler queries if needed.
import os, sys, json, re, glob, time, urllib.request, urllib.parse, io
sys.path.insert(0, os.path.dirname(__file__))

ROOT = os.path.abspath(os.environ.get("WORLDGEN_ROOT") or os.path.dirname(os.path.dirname(__file__)))
AUDIO = os.path.join(ROOT, "public", "audio")
_dd = os.environ.get("WORLDGEN_DATA_DIR")
DATA = os.path.abspath(os.path.join(ROOT, _dd)) if _dd else os.path.join(ROOT, "data")
DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"
DEEPSEEK_MODEL = "deepseek-chat"
CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions"
CEREBRAS_MODEL = "gpt-oss-120b"
FREESOUND = "https://freesound.org/apiv2/search/text/"

def getenv(k, envpath=os.path.join(ROOT, ".env")):
    if k in os.environ: return os.environ[k]
    try:
        for ln in io.open(envpath, encoding="utf-8"):
            ln = ln.strip()
            if ln.startswith(k+"=") or ln.startswith(k+" ="):
                v = ln.split("=", 1)[1].strip().strip('"').strip("'")
                return v
    except: pass
    return None

CB_KEY = getenv("CEREBRAS_API_KEY")
DS_KEY = getenv("DEEPSEEK_API_KEY")
FS_KEY = getenv("SOMA_API") or getenv("FREESOUND_API_KEY")
LLM_PROVIDER = "cerebras" if CB_KEY else "deepseek"

def http_json(url, headers=None, data=None, timeout=60):
    if data is not None:
        data = json.dumps(data).encode("utf-8")
    h = dict(headers or {})
    h.setdefault("User-Agent", "Mozilla/5.0 WorldGen-MediaOrchestrator")
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def freesound_count(query):
    params = {"query": query, "page_size": "1", "sort": "rating_desc", "token": FS_KEY,
              "filter": 'license:("Creative Commons 0" OR "Attribution")', "fields": "id"}
    try:
        r = http_json(FREESOUND + "?" + urllib.parse.urlencode(params), timeout=15)
        return r.get("count", 0)
    except Exception:
        return -1

def llm_themes(concept):
    """Try Cerebras first (free, fast), fallback to DeepSeek."""
    prompt = (
        "Generate 6-8 ambient soundscape themes for an interactive world based on: " + json.dumps(concept) + "\n\n"
        "Return ONLY a JSON object. Each key is snake_case (e.g., 'neon_alley', 'lab_buzz'). "
        "Each value is a 2-4 word Freesound search query likely to return concrete ambient/SFX results.\n\n"
        "Rules:\n"
        "- Queries must use COMMON sound words: ambience, hum, drone, room tone, traffic, wind, footsteps, crowd, machine, etc.\n"
        "- AVOID proper nouns, character names, song titles, specific dates, abstract concepts.\n"
        "- AVOID more than 4 words per query.\n"
        "- Themes should fit the era/setting/mood: locations, weather, time-of-day, key activities.\n"
        "- For music biopics/concerts, include 1-2 genre queries (e.g., 'folk acoustic guitar', 'techno electronic loop').\n\n"
        "Return only the JSON object, no markdown fences, no commentary."
    )
    # Try Cerebras
    if CB_KEY:
        try:
            body = {"model": CEREBRAS_MODEL, "messages": [{"role":"user","content":prompt}],
                    "temperature": 0.4, "max_tokens": 600, "response_format":{"type":"json_object"}}
            r = http_json(CEREBRAS_URL, headers={"Content-Type":"application/json","Authorization":"Bearer " + CB_KEY}, data=body, timeout=30)
            txt = r["choices"][0]["message"]["content"]
            txt = re.sub(r"^```(?:json)?|```$", "", txt.strip(), flags=re.M).strip()
            return json.loads(txt)
        except Exception as e:
            print("  CEREBRAS_FAIL: %s -- trying DeepSeek" % str(e)[:120])
    # Fallback DeepSeek
    if DS_KEY:
        try:
            body = {"model": DEEPSEEK_MODEL, "messages": [{"role":"user","content":prompt}],
                    "temperature": 0.4, "response_format":{"type":"json_object"}}
            r = http_json(DEEPSEEK_URL, headers={"Content-Type":"application/json","Authorization":"Bearer " + DS_KEY}, data=body, timeout=90)
            txt = r["choices"][0]["message"]["content"]
            txt = re.sub(r"^```(?:json)?|```$", "", txt.strip(), flags=re.M).strip()
            return json.loads(txt)
        except Exception as e:
            print("  DS_FAIL: %s" % str(e)[:120])
    return None

# legacy name kept for any external callers
def ds_themes(concept):
    prompt = (
        "Generate 6-8 ambient soundscape themes for an interactive world based on: " + json.dumps(concept) + "\n\n"
        "Return ONLY a JSON object. Each key is snake_case (e.g., 'neon_alley', 'lab_buzz'). "
        "Each value is a 2-4 word Freesound search query likely to return concrete ambient/SFX results.\n\n"
        "Rules:\n"
        "- Queries must use COMMON sound words: ambience, hum, drone, room tone, traffic, wind, footsteps, crowd, machine, etc.\n"
        "- AVOID proper nouns, character names, song titles, specific dates, abstract concepts.\n"
        "- AVOID more than 4 words per query.\n"
        "- Themes should fit the era/setting/mood: locations, weather, time-of-day, key activities.\n"
        "- For music biopics/concerts, include 1-2 genre queries (e.g., 'folk acoustic guitar', 'techno electronic loop').\n\n"
        "Return only the JSON object, no markdown fences, no commentary."
    )
    body = {"model": DEEPSEEK_MODEL, "messages": [{"role":"user","content":prompt}], "temperature": 0.4, "response_format":{"type":"json_object"}}
    headers = {"Content-Type":"application/json","Authorization":"Bearer " + DS_KEY}
    try:
        r = http_json(DEEPSEEK_URL, headers=headers, data=body, timeout=90)
        txt = r["choices"][0]["message"]["content"]
        # strip any fences if model ignored response_format
        txt = re.sub(r"^```(?:json)?|```$", "", txt.strip(), flags=re.M).strip()
        return json.loads(txt)
    except Exception as e:
        print("  DS_FAIL: %s" % e); return None

def validate_themes(themes):
    """Drop queries that return 0 results. Return validated dict."""
    out = {}
    for k, q in themes.items():
        c = freesound_count(q)
        if c > 0:
            out[k] = q
        else:
            # try shorter
            words = q.split()
            if len(words) >= 3:
                short = " ".join(words[:2])
                if freesound_count(short) > 0:
                    out[k] = short
                    continue
            print("    drop  %-22s '%s' (0 hits)" % (k, q))
    return out

def is_bland(pack_dir):
    # Delegate to shared lib so detection rules stay consistent with auto-pack-worlds.py
    from _pack_themes import pack_is_bland
    return pack_is_bland(pack_dir)

def get_concept_for_pack(pack_dir):
    pj = os.path.join(AUDIO, pack_dir, "pack.json")
    with open(pj, encoding="utf-8") as f: p = json.load(f)
    wids = p.get("worldIds") or []
    if not wids: return None
    wid = wids[0]
    candidates = glob.glob(os.path.join(DATA, "world*%s*.json" % wid))
    if not candidates: return None
    with open(candidates[0], encoding="utf-8") as f: w = json.load(f)
    c = w.get("concept")
    return c if isinstance(c, str) else None

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=999)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--all", action="store_true", help="regen themes for ALL packs, not just bland ones")
    ap.add_argument("--packs", type=str, default="", help="comma-separated specific packs")
    args = ap.parse_args()

    if args.packs:
        targets = [p.strip() for p in args.packs.split(",") if p.strip()]
    elif args.all:
        targets = sorted(os.listdir(AUDIO))
    else:
        targets = [d for d in sorted(os.listdir(AUDIO)) if is_bland(d)]

    print("targets: %d packs%s" % (len(targets), " (dry-run)" if args.dry_run else ""))
    for t in targets: print("  - %s" % t)
    if args.dry_run: return
    if not targets:
        print("DONE: no bland packs need theme enhancement")
        return
    if not (CB_KEY or DS_KEY):
        sys.exit("missing CEREBRAS_API_KEY and DEEPSEEK_API_KEY")
    if not FS_KEY:
        sys.exit("missing SOMA_API")
    print("LLM: %s" % LLM_PROVIDER, flush=True)

    done = 0; fail = 0
    for pd in targets[:args.limit]:
        concept = get_concept_for_pack(pd)
        if not concept:
            print("\n[%s] no concept, skip" % pd); continue
        print("\n[%s] concept=%.70s" % (pd, concept))
        themes = llm_themes(concept)
        if not themes:
            fail += 1; continue
        print("  raw: %s" % json.dumps(themes))
        valid = validate_themes(themes)
        if len(valid) < 4:
            print("  too few valid (%d), skip" % len(valid)); fail += 1; continue
        tj = os.path.join(AUDIO, pd, "_themes.json")
        # backup
        if os.path.exists(tj):
            with open(tj, encoding="utf-8") as f: old = f.read()
            with open(tj + ".bak", "w", encoding="utf-8") as f: f.write(old)
        with open(tj, "w", encoding="utf-8") as f: json.dump(valid, f, indent=2)
        # mark pack.json so future is_bland() will skip this pack
        pj = os.path.join(AUDIO, pd, "pack.json")
        try:
            with open(pj, encoding="utf-8") as f: pj_data = json.load(f)
            pj_data["themesSource"] = "llm"
            # also retarget base/detail defaults to actual new theme keys
            keys = list(valid.keys())
            if keys:
                pj_data.setdefault("base", {})["default"] = keys[0]
                pj_data.setdefault("detail", {})["default"] = keys[-1]
                pj_data["base"].setdefault("byKeyword", [])
                pj_data["detail"].setdefault("byKeyword", [])
            with open(pj, "w", encoding="utf-8") as f: json.dump(pj_data, f, indent=2)
        except Exception as e:
            print("  warn: could not update pack.json: %s" % e)
        print("  WROTE %d themes -> %s" % (len(valid), tj))
        done += 1
        time.sleep(0.5)

    print("\nDONE: %d regenerated, %d failed" % (done, fail))

if __name__ == "__main__":
    main()


