#!/usr/bin/env python3
r"""
complete-all-media.py - AI-agnostic orchestrator that drives WorldGen audio + photo completion to done.

Idempotent, resumable, observable. Can be run by ANY AI agent (Claude Code, DeepSeek-driven loop,
future chat session, plain cron) with:

    python complete-all-media.py             # one pass
    python complete-all-media.py --loop      # loop until nothing left
    python complete-all-media.py --dry-run   # show what it would do
    python complete-all-media.py --status    # print current progress JSON, no work

State file:  <root>/state/media-progress.json (written each pass)
Log file:    $WORLDGEN_LOG_DIR/media-pipeline.log (default <root>/logs)
Task spec:   <root>/MEDIA_PIPELINE.md (read this first if you are an AI)
"""
import os, sys, json, re, glob, time, argparse, subprocess, urllib.request, urllib.parse, io, shutil
from datetime import datetime

ROOT = os.path.abspath(os.environ.get("WORLDGEN_ROOT") or os.path.dirname(os.path.dirname(__file__)))
_dd = os.environ.get("WORLDGEN_DATA_DIR")
DATA = os.path.abspath(os.path.join(ROOT, _dd)) if _dd else os.path.join(ROOT, "data")
AUDIO = os.path.join(ROOT, "public", "audio")
PUBLIC = os.path.join(ROOT, "public")
GENERATED = os.path.join(PUBLIC, "generated")
COVERS = os.path.join(PUBLIC, "covers")
SOUNDS = os.path.join(PUBLIC, "sounds")
MEDIA_TRASH = os.path.join(PUBLIC, "media-trash")
STATE_DIR = os.path.join(ROOT, "state")
STATE_FILE = os.path.join(STATE_DIR, "media-progress.json")
CRON_STATE_FILE = os.path.join(STATE_DIR, "orchestrator-cron.json")
LOG_DIR = os.path.abspath(os.path.join(ROOT, os.environ.get("WORLDGEN_LOG_DIR") or "logs"))
try: os.makedirs(LOG_DIR, exist_ok=True)
except OSError: pass
LOG_FILE = os.path.join(LOG_DIR, "media-pipeline.log")
MIN_AUDIO_FILES = 6  # "pack is populated" threshold
MIN_AUDIO_THEMES = 3  # avoid "one populated folder" packs being treated as usable
DEFAULT_AUDIO_BATCH = 2
SOURCE_VISUAL_PROMPT_VERSION = "source-visual-v2"
BASE_URL = os.environ.get("WORLDGEN_BASE_URL", "http://localhost:3002")
MEDIA_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp3", ".wav", ".flac", ".ogg", ".aac")
STATIC_MEDIA_ROOTS = ((GENERATED, "generated"), (COVERS, "covers"), (SOUNDS, "sounds"))
FRONTEND_REFERENCE_FILES = (
    os.path.join(PUBLIC, "index.html"),
    os.path.join(PUBLIC, "index.compiled.js"),
    os.path.join(PUBLIC, "observatory.html"),
    os.path.join(PUBLIC, "audio-config.js"),
    os.path.join(PUBLIC, "audio-manager.js"),
)
PROTECTED_FALLBACK_AUDIO_PACKS = {
    "event_horizon",
    "alien_1979_the_nostromo_rescue_signal",
    "alien_planet_2099_earths_last_remaining",
    "blade_runner",
    "year_3000_humans_live_on_stsrships",
    "red_dwarf",
    "the_exorcist",
    "the_possession",
    "hellraiser",
    "dracula",
    "lost_boys",
    "texas_chainsaw_massacre",
    "the_hills_have_eyes",
    "the_shining",
    "phantasm",
}

os.makedirs(STATE_DIR, exist_ok=True)

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = "[%s] %s" % (ts, msg)
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f: f.write(line + "\n")
    except: pass

def run(cmd, timeout=None):
    log("$ " + " ".join(cmd))
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if r.stdout: log(r.stdout.strip()[-2000:])
        if r.returncode != 0: log("  EXIT %d: %s" % (r.returncode, r.stderr.strip()[-500:]))
        return r.returncode == 0
    except subprocess.TimeoutExpired:
        log("  TIMEOUT after %ds" % timeout); return False
    except Exception as e:
        log("  ERR: %s" % e); return False

def http_post(url, data=None, timeout=120):
    try:
        payload = json.dumps(data or {}).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers={"Content-Type":"application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return -1, str(e)

def cron_enabled():
    try:
        if not os.path.exists(CRON_STATE_FILE):
            return True
        with open(CRON_STATE_FILE, encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict) and isinstance(raw.get("enabled"), bool):
            return raw["enabled"]
    except:
        pass
    return True

# ---------------- inventory ----------------
MEDIA_PATH_HINTS = ("generated/", "/generated/", "covers/", "/covers/", "sounds/", "/sounds/", "audio/", "/audio/")
MEDIA_REF_RX = re.compile(r"(?:(?:/|\./)?(?:generated|covers|sounds|audio)/|(?:/|\./)?public/(?:generated|covers|sounds|audio)/)[^\"'`\s)]+")
SKIP_MEDIA_SCAN_KEYS = {
    "extractedText", "fullText", "rawText", "digest", "content", "detail", "npcThoughtAfter",
    "transmittedBelief", "originalBelief", "description", "backstory", "physicalDescription",
}

def extract_json_section(raw, key, opener, closer, top_level=False):
    prefix = r'(?m)^\s{2}' if top_level else ""
    m = re.search(prefix + r'"%s"\s*:\s*%s' % (re.escape(key), re.escape(opener)), raw)
    if not m:
        return None
    start = raw.find(opener, m.start())
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(raw)):
        ch = raw[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return raw[start:i + 1]
    return None

def first_json_string(raw, key):
    m = re.search(r'"%s"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"' % re.escape(key), raw)
    if not m:
        return None
    try:
        return json.loads('"' + m.group(1) + '"')
    except:
        return m.group(1)

def load_world_summary(wf):
    try:
        raw = open(wf, encoding="utf-8").read()
    except:
        return None
    images = {}
    img_raw = extract_json_section(raw, "images", "{", "}", top_level=True)
    if img_raw:
        try:
            images = json.loads(img_raw)
        except:
            images = {}
    npc_count = 0
    npc_raw = extract_json_section(raw, "npcs", "[", "]", top_level=True)
    if npc_raw:
        try:
            npcs = json.loads(npc_raw)
            npc_count = len(npcs) if isinstance(npcs, list) else 0
        except:
            npc_count = len(re.findall(r'"id"\s*:', npc_raw))
    loc_count = 0
    loc_raw = extract_json_section(raw, "locations", "[", "]", top_level=True)
    if loc_raw:
        try:
            locs = json.loads(loc_raw)
            loc_count = len(locs) if isinstance(locs, list) else 0
        except:
            loc_count = len(re.findall(r'"id"\s*:', loc_raw))
    source_start = re.search(r'(?m)^\s{2}"sourceDocuments"\s*:\s*\[', raw)
    has_source = False
    if source_start:
        pos = source_start.end()
        while pos < len(raw) and raw[pos].isspace():
            pos += 1
        has_source = pos < len(raw) and raw[pos] != "]"
    wid = first_json_string(raw, "id") or os.path.basename(wf).replace("world-", "").replace(".json", "")
    return {
        "id": wid,
        "concept": first_json_string(raw, "concept") or "",
        "images": images if isinstance(images, dict) else {},
        "_hasSourceDocuments": has_source,
        "_npcCount": npc_count,
        "_locCount": loc_count,
        "_mediaRefs": MEDIA_REF_RX.findall(" ".join([img_raw or "", npc_raw or "", loc_raw or ""])),
    }

def is_enhanced(world):
    """Enhanced world = has at least one sourceDocument."""
    if "_hasSourceDocuments" in world:
        return bool(world.get("_hasSourceDocuments"))
    sd = world.get("sourceDocuments") or []
    return isinstance(sd, list) and len(sd) > 0

def list_worlds(enhanced_only=True):
    out = []
    for wf in sorted(glob.glob(os.path.join(DATA, "world-*.json"))):
        w = load_world_summary(wf)
        if not w:
            continue
        if enhanced_only and not is_enhanced(w): continue
        wid = w.get("id") or os.path.basename(wf).replace("world-","").replace(".json","")
        out.append((wid, w, wf))
    return out

def normalize_text(value):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(value or "").lower().replace("&", " and "))).strip()

def phrase_match(hay, needle):
    n = normalize_text(needle)
    return bool(n) and (" " + hay + " ").find(" " + n + " ") >= 0

def pack_for_world(world_id, packs_index, concept=None):
    """Mirror runtime pack matching: worldIds first, then concept/match phrase."""
    direct = packs_index.get(world_id)
    if direct:
        return direct
    c = normalize_text(concept)
    if not c:
        return None
    for d, matches in packs_index.get("__packs__", []):
        if any(phrase_match(c, m) for m in matches):
            return d
    return None

def load_audio_pack_meta():
    packs = {}
    if not os.path.exists(AUDIO):
        return packs
    for d in os.listdir(AUDIO):
        pj = os.path.join(AUDIO, d, "pack.json")
        if not os.path.exists(pj):
            continue
        try:
            with open(pj, encoding="utf-8") as f:
                packs[d] = json.load(f)
        except:
            continue
    return packs

def build_packs_index():
    idx = {}
    for d, p in load_audio_pack_meta().items():
        idx.setdefault("__packs__", []).append((d, p.get("match") or []))
        for w in p.get("worldIds") or []:
            idx[w] = d
    return idx

def audio_status(pack_dir):
    n = 0
    themes = set()
    for root, _, files in os.walk(os.path.join(AUDIO, pack_dir)):
        for f in files:
            if f.lower().endswith((".mp3",".wav",".flac",".ogg")):
                n += 1
                rel = os.path.relpath(root, os.path.join(AUDIO, pack_dir))
                if rel != ".":
                    themes.add(rel.split(os.sep)[0])
    return n, len(themes)

def portraits_status(world):
    if "_npcCount" in world:
        total = int(world.get("_npcCount") or 0)
        portraits = (world.get("images") or {}).get("portraits") or {}
        have = len([v for v in portraits.values() if v]) if isinstance(portraits, dict) else 0
        return (min(have, total), total)
    npcs = world.get("npcs") or []
    if not isinstance(npcs, list): return (0, 0)
    total = len(npcs)
    portraits = (world.get("images") or {}).get("portraits") or {}
    have = sum(1 for n in npcs if isinstance(n, dict) and n.get("id") and portraits.get(n["id"]))
    return (have, total)

def scenes_status(world):
    if "_locCount" in world:
        total = int(world.get("_locCount") or 0)
        scenes = (world.get("images") or {}).get("scenes") or {}
        have = len([v for v in scenes.values() if v]) if isinstance(scenes, dict) else 0
        return (min(have, total), total)
    locs = world.get("locations") or []
    if not isinstance(locs, list): return (0, 0)
    total = len(locs)
    scenes = (world.get("images") or {}).get("scenes") or {}
    have = sum(1 for l in locs if isinstance(l, dict) and l.get("id") and scenes.get(l["id"]))
    return (have, total)

def cover_status(world):
    img = world.get("images") or {}
    return bool(img.get("cover"))

def panel_backgrounds_status(world):
    panels = (world.get("images") or {}).get("panelBackgrounds") or {}
    if not isinstance(panels, dict):
        return False
    return bool(panels.get("geography") and panels.get("economy"))

def source_visual_refresh_needed(world):
    if "_hasSourceDocuments" in world:
        if not world.get("_hasSourceDocuments"):
            return False
        img = world.get("images") or {}
        return img.get("sourceVisualPromptVersion") != SOURCE_VISUAL_PROMPT_VERSION
    docs = world.get("sourceDocuments") or []
    if not isinstance(docs, list) or not docs:
        return False
    img = world.get("images") or {}
    return img.get("sourceVisualPromptVersion") != SOURCE_VISUAL_PROMPT_VERSION

def iter_json_values(value, key_name=""):
    if key_name in SKIP_MEDIA_SCAN_KEYS:
        return
    if isinstance(value, dict):
        for k, v in value.items():
            yield from iter_json_values(v, k)
    elif isinstance(value, list):
        for v in value:
            yield from iter_json_values(v)
    elif isinstance(value, str):
        if any(h in value for h in MEDIA_PATH_HINTS):
            yield value

def public_media_file_for_url(value):
    raw = str(value or "").strip().split("?", 1)[0].split("#", 1)[0]
    if not raw or raw.startswith(("http://", "https://", "data:")):
        return None
    rel = None
    if raw.startswith("/generated/"):
        rel = raw[1:]
    elif raw.startswith("generated/") or raw.startswith("./generated/"):
        rel = raw[2:] if raw.startswith("./") else raw
    elif raw.startswith("/public/generated/") or raw.startswith("public/generated/"):
        rel = raw[8:] if raw.startswith("/public/") else raw[7:]
    elif raw.startswith("/covers/"):
        rel = raw[1:]
    elif raw.startswith("covers/") or raw.startswith("./covers/"):
        rel = raw[2:] if raw.startswith("./") else raw
    elif raw.startswith("/public/covers/") or raw.startswith("public/covers/"):
        rel = raw[8:] if raw.startswith("/public/") else raw[7:]
    elif raw.startswith("/sounds/"):
        rel = raw[1:]
    elif raw.startswith("sounds/") or raw.startswith("./sounds/"):
        rel = raw[2:] if raw.startswith("./") else raw
    elif raw.startswith("/public/sounds/") or raw.startswith("public/sounds/"):
        rel = raw[8:] if raw.startswith("/public/") else raw[7:]
    elif raw.startswith("/audio/"):
        rel = raw[1:]
    elif raw.startswith("audio/") or raw.startswith("./audio/"):
        rel = raw[2:] if raw.startswith("./") else raw
    elif raw.startswith("/public/audio/") or raw.startswith("public/audio/"):
        rel = raw[8:] if raw.startswith("/public/") else raw[7:]
    if not rel:
        return None
    try:
        rel = urllib.parse.unquote(rel).replace("/", os.sep).replace("\\", os.sep)
    except:
        return None
    full = os.path.abspath(os.path.normpath(os.path.join(PUBLIC, rel)))
    public_root = os.path.abspath(PUBLIC)
    if full != public_root and full.startswith(public_root + os.sep):
        return full
    return None

def active_media_owner_ids(loaded_worlds=None):
    worlds, players = set(), set()
    if loaded_worlds is not None:
        for wid, _, _ in loaded_worlds:
            if isinstance(wid, str):
                worlds.add(wid)
    else:
        for wf in glob.glob(os.path.join(DATA, "world-*.json")):
            try:
                with open(wf, encoding="utf-8") as f:
                    w = json.load(f)
                if isinstance(w.get("id"), str):
                    worlds.add(w["id"])
            except:
                pass
    pf = os.path.join(DATA, "players.json")
    try:
        with open(pf, encoding="utf-8") as f:
            raw = json.load(f)
        plist = raw if isinstance(raw, list) else raw.get("players", [])
        if isinstance(plist, list):
            for p in plist:
                if isinstance(p, dict) and isinstance(p.get("id"), str):
                    players.add(p["id"])
    except:
        pass
    return worlds, players

def referenced_media_files(loaded_worlds=None):
    refs = set()
    if loaded_worlds is not None:
        for _, raw, _ in loaded_worlds:
            for value in raw.get("_mediaRefs") or []:
                found = public_media_file_for_url(value)
                if found:
                    refs.add(found)
            for value in iter_json_values(raw.get("images") or {}):
                found = public_media_file_for_url(value)
                if found:
                    refs.add(found)
    else:
        for jf in glob.glob(os.path.join(DATA, "*.json")):
            try:
                with open(jf, encoding="utf-8") as f:
                    raw = json.load(f)
                for value in iter_json_values(raw):
                    found = public_media_file_for_url(value)
                    if found:
                        refs.add(found)
            except:
                continue
    if loaded_worlds is not None:
        for jf in glob.glob(os.path.join(DATA, "*.json")):
            if os.path.basename(jf).startswith("world-"):
                continue
            try:
                with open(jf, encoding="utf-8") as f:
                    raw = json.load(f)
                for value in iter_json_values(raw):
                    found = public_media_file_for_url(value)
                    if found:
                        refs.add(found)
            except:
                continue
    for sf in FRONTEND_REFERENCE_FILES:
        if not os.path.exists(sf):
            continue
        try:
            text = open(sf, encoding="utf-8", errors="ignore").read()
        except:
            continue
        for match in MEDIA_REF_RX.findall(text):
            found = public_media_file_for_url(match)
            if found:
                refs.add(found)
    return refs

def active_audio_pack_dirs(enhanced_only=False, refs=None, loaded_worlds=None):
    packs = load_audio_pack_meta()
    packs_index = build_packs_index()
    active = set()
    for wid, w, _ in (loaded_worlds if loaded_worlds is not None else list_worlds(enhanced_only=enhanced_only)):
        pd = pack_for_world(wid, packs_index, w.get("concept"))
        if pd:
            active.add(pd)
    audio_root = os.path.abspath(AUDIO)
    for ref in (refs if refs is not None else referenced_media_files()):
        ref_abs = os.path.abspath(ref)
        if ref_abs.startswith(audio_root + os.sep):
            rel = os.path.relpath(ref_abs, audio_root)
            parts = rel.split(os.sep)
            if parts and parts[0]:
                active.add(parts[0])
    return ({pd for pd in active if pd in packs} | {pd for pd in PROTECTED_FALLBACK_AUDIO_PACKS if pd in packs})

def unused_audio_pack_dirs(enhanced_only=False, refs=None, loaded_worlds=None):
    active = active_audio_pack_dirs(enhanced_only=enhanced_only, refs=refs, loaded_worlds=loaded_worlds)
    out = []
    all_dirs = []
    if os.path.exists(AUDIO):
        all_dirs = [d for d in os.listdir(AUDIO) if os.path.isdir(os.path.join(AUDIO, d))]
    for pd in sorted(all_dirs):
        if pd in active:
            continue
        full = os.path.abspath(os.path.join(AUDIO, pd))
        out.append((full, os.path.join("audio", pd)))
    return out

def orphan_static_media_files(refs=None, loaded_worlds=None):
    refs = refs if refs is not None else referenced_media_files()
    world_ids, player_ids = active_media_owner_ids(loaded_worlds=loaded_worlds)
    out = []
    for root, label in STATIC_MEDIA_ROOTS:
        if not os.path.exists(root):
            continue
        for cur, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in {"_imgcache", ".git"}]
            for name in files:
                if not name.lower().endswith(MEDIA_EXTS):
                    continue
                full = os.path.abspath(os.path.join(cur, name))
                if full in refs:
                    continue
                rel = os.path.relpath(full, root)
                parts = rel.split(os.sep)
                if label == "generated" and parts:
                    if parts[0] in world_ids:
                        continue
                    if parts[0] == "players" and len(parts) > 1 and parts[1] in player_ids:
                        continue
                out.append((full, os.path.join(label, rel)))
    return sorted(out, key=lambda x: x[1].lower())

def orphan_media_files(enhanced_only=False, loaded_worlds=None):
    refs = referenced_media_files(loaded_worlds=loaded_worlds)
    return sorted(orphan_static_media_files(refs=refs, loaded_worlds=loaded_worlds) + unused_audio_pack_dirs(enhanced_only=enhanced_only, refs=refs, loaded_worlds=loaded_worlds), key=lambda x: x[1].lower())

def cleanup_counts(candidates):
    counts = {"generated": 0, "covers": 0, "sounds": 0, "audio": 0}
    for _, rel in candidates:
        key = rel.split(os.sep, 1)[0].replace("/", os.sep)
        if key in counts:
            counts[key] += 1
    return counts

def move_orphan_media_to_trash(dry_run=False, enhanced_only=False):
    candidates = orphan_media_files(enhanced_only=enhanced_only)
    if dry_run or not candidates:
        return {"candidates": len(candidates), "moved": 0, "trash_dir": None, "counts": cleanup_counts(candidates), "files": [rel for _, rel in candidates[:250]]}
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    trash_dir = os.path.join(MEDIA_TRASH, stamp)
    moved = []
    errors = []
    for full, rel in candidates:
        if not os.path.exists(full):
            continue
        dest = os.path.join(trash_dir, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        final = dest
        if os.path.exists(final):
            stem, ext = os.path.splitext(dest)
            i = 2
            while os.path.exists(final):
                final = f"{stem}-{i}{ext}"
                i += 1
        try:
            shutil.move(full, final)
            moved.append(rel)
        except Exception as e:
            msg = "media cleanup failed %s: %s" % (rel, e)
            errors.append(msg)
            log("  " + msg)
    return {"candidates": len(candidates), "moved": len(moved), "trash_dir": trash_dir if moved else None, "counts": cleanup_counts(candidates), "files": moved[:250], "errors": errors}

# ---------------- actions ----------------
def ensure_pack(world_id, enhanced_only=True):
    # auto-pack-worlds.py only creates packs for worlds with no existing binding
    # Running it is safe — it will skip already-bound worlds.
    cmd = [sys.executable, os.path.join(ROOT, "scripts", "auto-pack-worlds.py")]
    if not enhanced_only:
        cmd.append("--all-worlds")
    return run(cmd, timeout=120)

def enhance_bland():
    return run([sys.executable, os.path.join(ROOT, "scripts", "enhance-bland-packs.py")], timeout=600)

def fetch_pack(pack_dir, per=6):  # 2400s timeout - covers 8 themes * 6 files * 25s worst case
    return run([sys.executable, os.path.join(ROOT, "scripts", "fetch-sfx.py"), "--pack", pack_dir, "--per", str(per)], timeout=2400)

def bland_pack_dirs(enhanced_only=True):
    try:
        from _pack_themes import pack_is_bland
    except Exception as e:
        log("-- theme enhancement skipped: cannot load bland-pack detector (%s)" % e)
        return []
    loaded_worlds = list_worlds(enhanced_only=enhanced_only)
    active = active_audio_pack_dirs(enhanced_only=enhanced_only, refs=set(), loaded_worlds=loaded_worlds)
    out = []
    for pd in sorted(active):
        full = os.path.join(AUDIO, pd)
        if os.path.isdir(full) and pack_is_bland(pd):
            out.append(pd)
    return out

def fetch_panel_backgrounds(enhanced_only=True):
    cmd = [sys.executable, os.path.join(ROOT, "scripts", "fetch-duckduckgo-panel-backgrounds.py")]
    if not enhanced_only:
        cmd.append("--all-worlds")
    return run(cmd, timeout=1800)

def cast_rematch(world_id):
    status, body = http_post("%s/api/worlds/%s/cast-rematch" % (BASE_URL, world_id))
    if status == 200: return True
    log("  cast-rematch %s -> %s %s" % (world_id, status, body[:160]))
    return False

def regen_portraits(world_id):
    status, body = http_post("%s/api/worlds/%s/regen-portraits" % (BASE_URL, world_id))
    if status == 200: return True
    log("  regen-portraits %s -> %s %s" % (world_id, status, body[:160]))
    return False

# ---------------- main loop ----------------
def inventory_and_plan(dry_run=False, enhanced_only=True):
    packs_index = build_packs_index()
    worlds = list_worlds(enhanced_only=enhanced_only)
    cleanup_candidates = orphan_media_files(enhanced_only=enhanced_only, loaded_worlds=worlds)
    needs_pack = []
    needs_audio = []
    needs_cast = []
    needs_scenes = []
    needs_cover = []
    needs_panel_backgrounds = []
    npc_portrait_gaps = []  # (world_id, missing_count, total)
    scene_gaps = []  # (world_id, missing_count, total)
    pack_audio = {}
    for wid, w, _ in worlds:
        pd = pack_for_world(wid, packs_index, w.get("concept"))
        if not pd:
            needs_pack.append(wid)
        else:
            n, theme_count = audio_status(pd)
            pack_audio[pd] = (n, theme_count)
            if n < MIN_AUDIO_FILES or theme_count < MIN_AUDIO_THEMES:
                needs_audio.append((wid, pd, n, theme_count))
        npcs = w.get("npcs") or []
        if isinstance(npcs, list) and npcs:
            have, total = portraits_status(w)
            if have < total:
                npc_portrait_gaps.append((wid, total - have, total))
                needs_cast.append(wid)
        locs = w.get("locations") or []
        if isinstance(locs, list) and locs:
            shave, stotal = scenes_status(w)
            if shave < stotal or source_visual_refresh_needed(w):
                scene_gaps.append((wid, max(stotal - shave, 0), stotal))
                needs_scenes.append(wid)
        if not cover_status(w) or source_visual_refresh_needed(w):
            needs_cover.append(wid)
        if not panel_backgrounds_status(w):
            needs_panel_backgrounds.append(wid)
    return {
        "timestamp": datetime.now().isoformat(),
        "totals": {"worlds": len(worlds), "packs": len(packs_index.get("__packs__", [])), "packs_with_audio": sum(1 for files, themes in pack_audio.values() if files >= MIN_AUDIO_FILES and themes >= MIN_AUDIO_THEMES)},
        "needs_pack": needs_pack,
        "needs_audio": needs_audio,
        "needs_cast": needs_cast,
        "needs_scenes": needs_scenes,
        "needs_cover": needs_cover,
        "needs_panel_backgrounds": needs_panel_backgrounds,
        "needs_cleanup": [rel for _, rel in cleanup_candidates[:250]],
        "cleanup_total": len(cleanup_candidates),
        "cleanup_counts": cleanup_counts(cleanup_candidates),
        "npc_portrait_gaps": npc_portrait_gaps,
        "scene_gaps": scene_gaps,
        "scope": "enhanced" if enhanced_only else "all",
        "complete": not (needs_pack or needs_audio or needs_cast or needs_scenes or needs_cover or needs_panel_backgrounds or npc_portrait_gaps or scene_gaps or cleanup_candidates),
    }

def do_one_pass(dry_run=False, skip_photos=False, args_holder=None, enhanced_only=True):
    failures = []
    plan = inventory_and_plan(enhanced_only=enhanced_only)
    log("PLAN: %d worlds | need: pack=%d cast=%d scenes=%d audio=%d cover=%d panels=%d" % (
        plan["totals"]["worlds"], len(plan["needs_pack"]), len(plan["needs_cast"]),
        len(plan.get("needs_scenes", [])), len(plan["needs_audio"]), len(plan["needs_cover"]), len(plan.get("needs_panel_backgrounds", []))))
    if dry_run:
        plan["media_cleanup"] = move_orphan_media_to_trash(dry_run=True, enhanced_only=enhanced_only)
        return plan

    if getattr(args_holder, "cleanup_only", False):
        cleanup = move_orphan_media_to_trash(enhanced_only=enhanced_only)
        final = inventory_and_plan(enhanced_only=enhanced_only)
        final["media_cleanup"] = cleanup
        final["failures"] = failures
        final["blocked"] = False
        if cleanup["moved"]:
            log("-- media cleanup moved %d orphaned file(s) -> %s" % (cleanup["moved"], cleanup["trash_dir"]))
        else:
            log("-- media cleanup: nothing to move")
        return final

    # PRIORITY ORDER: NPC portraits + locations BEFORE audio.
    # Step 1: create missing packs (cheap setup for later)
    if plan["needs_pack"]:
        log("-- creating %d missing packs" % len(plan["needs_pack"]))
        if not ensure_pack(None, enhanced_only=enhanced_only):
            failures.append({"step": "pack", "message": "auto-pack-worlds.py failed"})
        plan = inventory_and_plan(enhanced_only=enhanced_only)
    # Step 2: DuckDuckGo panel backgrounds for geography/economy cards
    if plan.get("needs_panel_backgrounds"):
        log("-- duckduckgo panel backgrounds for %d worlds" % len(plan.get("needs_panel_backgrounds", [])))
        if not fetch_panel_backgrounds(enhanced_only=enhanced_only):
            failures.append({"step": "panel-backgrounds", "message": "fetch-duckduckgo-panel-backgrounds.py failed"})
        plan = inventory_and_plan(enhanced_only=enhanced_only)
    # Step 3: TMDB cast-rematch for worlds with NPC portrait gaps (free, fast)
    if not skip_photos:
        for wid in plan["needs_cast"][:50]:
            log("-- cast-rematch %s" % wid)
            if not cast_rematch(wid):
                failures.append({"step": "cast", "worldId": wid, "message": "cast-rematch failed"})
    # Step 4: AI image regen (portraits + scenes + cover via queueWorldImageGeneration)
    # Throttled: small batch per pass + sleep between calls to avoid OpenRouter 429s.
    if not skip_photos and not getattr(args_holder, "no_image_gen", False):
        time.sleep(8)  # let TMDB writes settle
        plan2 = inventory_and_plan(enhanced_only=enhanced_only)
        targets = list({t[0] for t in plan2["npc_portrait_gaps"][:50]} | {t[0] for t in plan2.get("scene_gaps", [])[:50]} | set(plan2.get("needs_cover", [])[:50]))
        batch_size = getattr(args_holder, "image_batch", 4)
        spacing = getattr(args_holder, "image_spacing_sec", 60)
        log("-- regen-images: %d worlds need work, processing %d this pass (spacing=%ds)" % (len(targets), min(batch_size, len(targets)), spacing))
        for i, wid in enumerate(targets[:batch_size]):
            log("   [%d/%d] regen-images %s" % (i+1, min(batch_size, len(targets)), wid))
            if not regen_portraits(wid):
                failures.append({"step": "images", "worldId": wid, "message": "regen-portraits failed"})
            if i < min(batch_size, len(targets)) - 1:
                time.sleep(spacing)  # back off between worlds to let server drain queue
    elif getattr(args_holder, "no_image_gen", False):
        log("-- AI image regen DISABLED (--no-image-gen)")
    # Step 5: enhance bland themes via LLM (Cerebras free)
    if not getattr(args_holder, "no_llm", False):
        bland = bland_pack_dirs(enhanced_only=enhanced_only)
        if bland:
            cap = min(max(1, int(args_holder.llm_max)), len(bland))
            log("-- enhancing %d bland active pack(s) via LLM cap=%d" % (len(bland), cap))
            if not run([sys.executable, os.path.join(ROOT, "scripts", "enhance-bland-packs.py"), "--packs", ",".join(bland[:cap]), "--limit", str(cap)], timeout=600):
                failures.append({"step": "llm", "message": "enhance-bland-packs.py failed"})
        else:
            log("-- theme enhancement skipped: no active bland packs")
    # Step 6: move orphaned generated media into trash (never delete in-place)
    if not getattr(args_holder, "no_cleanup", False):
        cleanup = move_orphan_media_to_trash(enhanced_only=enhanced_only)
        plan["media_cleanup"] = cleanup
        for item in cleanup.get("errors", []):
            failures.append({"step": "cleanup", "message": item})
        if cleanup["moved"]:
            log("-- media cleanup moved %d orphaned file(s) -> %s" % (cleanup["moved"], cleanup["trash_dir"]))
    else:
        log("-- media cleanup DISABLED (--no-cleanup)")
    # Step 7 (LAST): audio fetch
    audio_batch = max(0, int(getattr(args_holder, "audio_batch", DEFAULT_AUDIO_BATCH)))
    if len(plan["needs_audio"]) > audio_batch:
        log("-- audio fetch limited to %d/%d pack(s) this pass" % (audio_batch, len(plan["needs_audio"])))
    for entry in plan["needs_audio"][:audio_batch]:
        wid, pd, n = entry[0], entry[1], entry[2]
        theme_count = entry[3] if len(entry) > 3 else 0
        log("-- fetch %s (%d files, %d themes)" % (pd, n, theme_count))
        if not fetch_pack(pd):
            failures.append({"step": "audio", "worldId": wid, "pack": pd, "message": "fetch-sfx.py failed"})
    # Re-inventory after work
    final = inventory_and_plan(enhanced_only=enhanced_only)
    if "media_cleanup" in plan:
        final["media_cleanup"] = plan["media_cleanup"]
    final["failures"] = failures
    final["blocked"] = bool(failures)
    if failures:
        final["last_error"] = failures[0].get("message") or str(failures[0])
    return final

def write_state(plan):
    with open(STATE_FILE, "w", encoding="utf-8") as f: json.dump(plan, f, indent=2)
    log("state -> %s  complete=%s" % (STATE_FILE, plan["complete"]))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--idle-sec", type=int, default=300)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--skip-photos", action="store_true")
    ap.add_argument("--no-llm", action="store_true", help="disable LLM theme enhancement entirely")
    ap.add_argument("--all-worlds", action="store_true", help="include all worlds (default)")
    ap.add_argument("--enhanced-only", action="store_true", help="only include worlds with sourceDocuments")
    ap.add_argument("--llm-max", type=int, default=5, help="max LLM theme-enhancement calls per pass (cost cap)")
    ap.add_argument("--image-batch", type=int, default=2, help="max worlds to regen-images per pass (avoids OpenRouter 429s)")
    ap.add_argument("--image-spacing-sec", type=int, default=60, help="seconds between regen-images calls")
    ap.add_argument("--audio-batch", type=int, default=DEFAULT_AUDIO_BATCH, help="max audio packs to fetch per pass")
    ap.add_argument("--no-image-gen", action="store_true", help="skip AI portrait/scene regen entirely")
    ap.add_argument("--force", action="store_true", help="run even if orchestrator cron is disabled")
    ap.add_argument("--no-cleanup", action="store_true", help="skip moving orphaned generated media into trash")
    ap.add_argument("--cleanup-only", action="store_true", help="only move orphaned generated media into trash")
    args = ap.parse_args()
    enhanced_only = args.enhanced_only and not args.all_worlds

    if args.status:
        plan = inventory_and_plan(dry_run=True, enhanced_only=enhanced_only)
        write_state(plan)
        print(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in plan.items() if k != "timestamp"}, indent=2))
        return

    if not args.force and not cron_enabled():
        plan = inventory_and_plan(dry_run=True, enhanced_only=enhanced_only)
        plan["cronEnabled"] = False
        plan["skipped"] = True
        plan["reason"] = "cron-disabled"
        write_state(plan)
        log("CRON DISABLED - skipping pass (use --force to override)")
        return

    if not args.loop:
        plan = do_one_pass(dry_run=args.dry_run, skip_photos=args.skip_photos, args_holder=args, enhanced_only=enhanced_only)
        write_state(plan)
        return

    while True:
        plan = do_one_pass(skip_photos=args.skip_photos, args_holder=args, enhanced_only=enhanced_only)
        write_state(plan)
        if plan["complete"]:
            log("COMPLETE - nothing left to do.")
            return
        log("idle %ds before next pass" % args.idle_sec)
        time.sleep(args.idle_sec)

if __name__ == "__main__":
    main()






