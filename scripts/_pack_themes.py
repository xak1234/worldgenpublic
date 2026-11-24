# _pack_themes.py - shared helpers for soundscape theme generation.
# Used by auto-pack-worlds.py (LLM fallback) and enhance-bland-packs.py (regen).
import os, sys, json, re, urllib.parse, urllib.request, io, time

ROOT = os.path.abspath(os.environ.get("WORLDGEN_ROOT") or os.path.dirname(os.path.dirname(__file__)))
AUDIO = os.path.join(ROOT, "public", "audio")
_dd = os.environ.get("WORLDGEN_DATA_DIR")
DATA = os.path.abspath(os.path.join(ROOT, _dd)) if _dd else os.path.join(ROOT, "data")
DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"
DEEPSEEK_MODEL = "deepseek-chat"
CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions"
CEREBRAS_MODEL = "gpt-oss-120b"
FREESOUND = "https://freesound.org/apiv2/search/text/"
UA = {"User-Agent": "Mozilla/5.0 WorldGen-Orchestrator"}

# Canned theme set that historically came from the city_modern fallback.
# A pack whose themes are a subset of this is treated as never-LLM-enhanced.
CITY_FALLBACK_KEYS = frozenset({"city_street", "office", "subway", "apartment"})

def getenv(k, envpath=os.path.join(ROOT, ".env")):
    if k in os.environ: return os.environ[k]
    try:
        for ln in io.open(envpath, encoding="utf-8"):
            ln = ln.strip()
            if ln.startswith(k + "=") or ln.startswith(k + " ="):
                v = ln.split("=", 1)[1].strip().strip("\"").strip("'")
                return v
    except Exception:
        pass
    return None

def http_json(url, headers=None, data=None, timeout=60):
    if data is not None:
        data = json.dumps(data).encode("utf-8")
    h = dict(headers or {}); h.setdefault("User-Agent", UA["User-Agent"])
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def freesound_count(query, key):
    params = {"query": query, "page_size": "1", "sort": "rating_desc", "token": key,
              "filter": 'license:("Creative Commons 0" OR "Attribution")', "fields": "id"}
    try:
        r = http_json(FREESOUND + "?" + urllib.parse.urlencode(params), timeout=15)
        return r.get("count", 0)
    except Exception:
        return -1

def _theme_prompt(concept):
    return (
        "Generate 6-10 ambient soundscape themes for an interactive world based on: " + json.dumps(concept) + "\n\n"
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

def llm_themes(concept, cb_key=None, ds_key=None, verbose=True):
    """Generate themes via Cerebras (primary) -> DeepSeek (fallback). Returns dict or None."""
    cb_key = cb_key or getenv("CEREBRAS_API_KEY")
    ds_key = ds_key or getenv("DEEPSEEK_API_KEY")
    prompt = _theme_prompt(concept)
    if cb_key:
        try:
            body = {"model": CEREBRAS_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.4, "max_tokens": 700,
                    "response_format": {"type": "json_object"}}
            r = http_json(CEREBRAS_URL,
                          headers={"Content-Type": "application/json",
                                   "Authorization": "Bearer " + cb_key},
                          data=body, timeout=30)
            txt = r["choices"][0]["message"]["content"]
            txt = re.sub(r"^```(?:json)?|```$", "", txt.strip(), flags=re.M).strip()
            return json.loads(txt)
        except Exception as e:
            if verbose: print("  CEREBRAS_FAIL: %s -- trying DeepSeek" % str(e)[:120])
    if ds_key:
        try:
            body = {"model": DEEPSEEK_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.4,
                    "response_format": {"type": "json_object"}}
            r = http_json(DEEPSEEK_URL,
                          headers={"Content-Type": "application/json",
                                   "Authorization": "Bearer " + ds_key},
                          data=body, timeout=90)
            txt = r["choices"][0]["message"]["content"]
            txt = re.sub(r"^```(?:json)?|```$", "", txt.strip(), flags=re.M).strip()
            return json.loads(txt)
        except Exception as e:
            if verbose: print("  DS_FAIL: %s" % str(e)[:120])
    return None

def validate_themes(themes, fs_key, verbose=True):
    """Drop queries with 0 Freesound hits. Retry with shorter form (first 2 words). Returns dict."""
    out = {}
    for k, q in (themes or {}).items():
        c = freesound_count(q, fs_key)
        if c > 0:
            out[k] = q; continue
        words = q.split()
        if len(words) >= 3:
            short = " ".join(words[:2])
            if freesound_count(short, fs_key) > 0:
                out[k] = short; continue
        if verbose: print("    drop  %-22s '%s' (0 hits)" % (k, q))
    return out

def pack_is_bland(pack_dir):
    """True if a pack's themes look like an un-enhanced city_modern fallback OR has no themesSource marker."""
    pj = os.path.join(AUDIO, pack_dir, "pack.json")
    tj = os.path.join(AUDIO, pack_dir, "_themes.json")
    if not (os.path.exists(pj) and os.path.exists(tj)): return False
    with open(tj, encoding="utf-8") as f: themes = json.load(f)
    with open(pj, encoding="utf-8") as f: pack   = json.load(f)
    src = pack.get("themesSource")
    if src == "llm" or src == "manual": return False
    keys = set(themes.keys())
    if not keys: return True
    # Exact city_modern fallback fingerprint
    if keys.issubset(CITY_FALLBACK_KEYS) and len(keys) <= 4: return True
    # Marked bank but small
    if src == "bank" and len(keys) <= 4 and ("city_street" in keys or "horror_drone" in keys): return True
    # Legacy unmarked: be conservative -- 4 keys exactly = canned bank category
    if src is None and len(keys) <= 4 and "city_street" in keys: return True
    return False

def get_concept_for_pack(pack_dir):
    pj = os.path.join(AUDIO, pack_dir, "pack.json")
    if not os.path.exists(pj): return None
    with open(pj, encoding="utf-8") as f: p = json.load(f)
    wids = p.get("worldIds") or []
    if not wids: return None
    import glob
    candidates = glob.glob(os.path.join(DATA, "world*%s*.json" % wids[0]))
    if not candidates: return None
    with open(candidates[0], encoding="utf-8") as f: w = json.load(f)
    c = w.get("concept")
    return c if isinstance(c, str) else None
