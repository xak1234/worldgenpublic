#!/usr/bin/env python
"""
WorldGen portrait pipeline — resolve film -> harvest stills -> ArcFace match
-> crop -> swap NPC portraits (immutability-safe).

  python portrait_pipeline.py --world <build_id> [--apply]
        [--tmdb N] [--top 12] [--thresh 0.30] [--min-face-px 400]
        [--refresh] [--source imdb]

Dry-run by default. Nothing is overwritten without --apply.
Source is swappable (imdb now; fancaps planned) behind harvest_<source>().
"""
import argparse, json, os, re, sys, time, hashlib, glob, shutil
from pathlib import Path
# Heavy deps are imported lazily (guarded) so `--check` can report exactly which
# modules are missing instead of the module-level import crashing with a traceback
# before argparse even runs. The actual pipeline run is gated behind `--check` on
# the server, so by the time these are used they are guaranteed present.
try:
    import numpy as np, cv2, requests
    from playwright.sync_api import sync_playwright
except Exception:
    np = cv2 = requests = None
    sync_playwright = None

TMDB_KEY = os.environ.get("TMDB_API_KEY", "").strip()
TMDB_IMG = "https://image.tmdb.org/t/p/w500"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
WG = Path(os.environ.get("WORLDGEN_ROOT", Path(__file__).resolve().parent.parent)).resolve()
CACHE = WG / "public" / "imdb-cache" / "titles"
GEN = WG / "public" / "generated"
DATA = WG / "data"

def tmdb(path, **params):
    params["api_key"] = TMDB_KEY
    return requests.get(f"https://api.themoviedb.org/3{path}", params=params, timeout=30).json()

ROLE_TOKENS = {
    "agent", "captain", "chief", "colonel", "commander", "count", "deputy", "detective",
    "doctor", "dr", "father", "general", "governor", "inspector", "judge", "king",
    "lady", "lieutenant", "lord", "lt", "madame", "madam", "major", "miss", "mother",
    "mr", "mrs", "ms", "officer", "president", "prince", "princess", "professor",
    "queen", "reverend", "sergeant", "sheriff", "sir", "sister", "warden",
}

NAME_ALIASES = {
    "alex": ["alexander", "alexandra"], "andy": ["andrew"],
    "beth": ["elizabeth"], "betty": ["elizabeth"],
    "bill": ["william"], "billy": ["william"],
    "bob": ["robert"], "bobby": ["robert"],
    "charlie": ["charles"], "chuck": ["charles"],
    "dave": ["david"], "davy": ["david"],
    "dick": ["richard"],
    "ed": ["edward", "edmund", "edwin"], "eddie": ["edward", "edmund", "edwin"],
    "frank": ["francis", "franklin"], "fred": ["frederick"],
    "harry": ["harold", "henry"], "jack": ["john"],
    "jim": ["james"], "jimmy": ["james"],
    "joe": ["joseph"], "joey": ["joseph"],
    "johnny": ["john"],
    "kate": ["katherine", "catherine"], "kathy": ["katherine", "catherine"],
    "liz": ["elizabeth"],
    "maggie": ["margaret"], "meg": ["margaret"],
    "mike": ["michael"], "micky": ["michael"], "mick": ["michael"],
    "nick": ["nicholas"], "pat": ["patrick", "patricia"],
    "pete": ["peter"],
    "rob": ["robert"], "robbie": ["robert"],
    "sam": ["samuel", "samantha"],
    "steve": ["steven", "stephen"],
    "tom": ["thomas"], "tommy": ["thomas"],
    "tony": ["anthony"],
    "will": ["william"], "willy": ["william"],
}

def norm(s):
    s = str(s or "").lower()
    s = re.sub(r"^(mr|mrs|ms|miss|dr|sir|lord|lady|sr|jr)\.?\s+", "", s)
    s = re.sub(r"\s+(jr|sr|ii|iii|iv)\.?$", "", s)
    s = s.replace(chr(34), " ")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return [t for t in s.split() if t]

def equivalent_token(a, b):
    return b in NAME_ALIASES.get(a, []) or a in NAME_ALIASES.get(b, [])

def token_match(a, b):
    if not a or not b: return False
    if a == b or equivalent_token(a, b): return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    return 2 <= len(shorter) <= 4 and longer.startswith(shorter)

def identity_tokens(name):
    return [
        t for t in norm(name)
        if t not in ROLE_TOKENS and not re.match(r"^(voice|cameo|uncredited|archive|footage|himself|herself)$", t)
    ]

def token_set_subset(shorter, longer):
    return bool(shorter) and all(any(token_match(t, u) for u in longer) for t in shorter)

def name_score(a, b):
    ta, tb = identity_tokens(a), identity_tokens(b)
    if not ta or not tb: return 0.0
    if " ".join(norm(a)) == " ".join(norm(b)): return 1.0
    shorter, longer = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    if token_set_subset(shorter, longer):
        return 1.0 if len(shorter) == len(longer) else 0.92
    a_first, b_first = ta[0], tb[0]
    a_last, b_last = ta[-1], tb[-1]
    first_match, last_match = token_match(a_first, b_first), token_match(a_last, b_last)
    if first_match and last_match: return 0.95
    if last_match and (len(ta) == 1 or len(tb) == 1) and len(a_last) >= 4 and len(b_last) >= 4:
        return 0.85
    if first_match and (len(ta) == 1 or len(tb) == 1) and min(len(a_first), len(b_first)) >= 4:
        return 0.85
    if first_match and len(ta) == 1 and len(tb) == 1 and len(a_first) >= 4:
        return 0.8
    overlap = 0
    for t in ta:
        if any(token_match(t, u) for u in tb):
            overlap += 1
    return 0.75 if overlap >= 2 else 0.0

def safe_file_stem(value, fallback="image"):
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "")).strip("._-")
    return (s[:90] or fallback)

def extract_year(*texts):
    for text in texts:
        m = re.search(r"\b(19|20)\d{2}\b", str(text or ""))
        if m: return int(m.group(0))
    return None

def clean_source_title(raw):
    s = str(raw or "")
    s = re.sub(r"\.(pdf|txt|html?)$", "", s, flags=re.I)
    s = re.sub(r"^_?OceanofPDF(?:\.com)?[_\s-]*", "", s, flags=re.I)
    s = s.replace("_", " ")
    s = re.sub(r"\s*[-:|]\s*(full text|shooting script|screenplay|script|transcript|dialogue transcript|movie script|film|movie|book|novel|wikipedia).*$", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def world_film_hints(world):
    hints = []
    for doc in reversed(world.get("sourceDocuments") or []):
        title = clean_source_title(doc.get("title") or doc.get("path") or doc.get("url") or "")
        year = extract_year(doc.get("title"), doc.get("summary"), doc.get("digest"), doc.get("extractedText"))
        if title: hints.append((title, year))
    concept = clean_source_title(world.get("concept") or "")
    cy = extract_year(concept)
    if concept: hints.append((re.sub(r"\b(19|20)\d{2}\b", "", concept).strip() or concept, cy))
    seen, out = set(), []
    for title, year in hints:
        key = (title.lower(), year)
        if key not in seen:
            seen.add(key); out.append((title, year))
    return out

# ---------- film + cast resolution ----------
def resolve_film(concept, tmdb_override=None, year_hint=None):
    if tmdb_override:
        mid, media_type = tmdb_override, "movie"
    else:
        # try full concept, then strip trailing context, then progressively shorter prefixes
        attempts = [concept]
        # strip trailing ", subtitle" or ". subtitle" or " - subtitle"
        stripped = re.sub(r"\s*[,;.\-]\s*.*$", "", concept).strip()
        if stripped and stripped != concept: attempts.append(stripped)
        words = stripped.split() if stripped else concept.split()
        for n in (5, 4, 3, 2):
            if len(words) > n: attempts.append(" ".join(words[:n]))
        seen, ordered = set(), []
        for a in attempts:
            if a and a.lower() not in seen:
                seen.add(a.lower()); ordered.append(a)
        mid, media_type = None, "movie"
        for q in ordered:
            res = []
            for mt in ("movie", "tv"):
                params = {"query": q}
                if year_hint:
                    params["year" if mt == "movie" else "first_air_date_year"] = year_hint
                for r in tmdb(f"/search/{mt}", **params).get("results", []):
                    r["_media_type"] = mt
                    res.append(r)
            if not res and year_hint:
                for mt in ("movie", "tv"):
                    for r in tmdb(f"/search/{mt}", query=q).get("results", []):
                        r["_media_type"] = mt
                        res.append(r)
            if not res:
                continue
            def score_hit(r):
                title = r.get("title") or r.get("name") or ""
                ry = extract_year(r.get("release_date"), r.get("first_air_date"))
                score = name_score(q, title) * 4 + min(float(r.get("popularity") or 0), 200.0) / 200.0
                if year_hint and ry:
                    diff = abs(int(ry) - int(year_hint))
                    score += 2.0 if diff == 0 else (0.75 if diff == 1 else -1.25)
                return score
            best = sorted(res, key=score_hit, reverse=True)[0]
            mid, media_type = best["id"], best.get("_media_type") or "movie"
            break
        if not mid:
            raise RuntimeError(f"no TMDB movie for concept {concept!r}")
    ext = tmdb(f"/{media_type}/{mid}/external_ids")
    det = tmdb(f"/{media_type}/{mid}")
    title = det.get("title") or det.get("name")
    year = (det.get("release_date") or det.get("first_air_date") or "")[:4]
    return mid, ext.get("imdb_id"), title, year, media_type

def resolve_film_from_world(world, tmdb_override=None):
    if tmdb_override:
        return resolve_film(world.get("concept") or "", tmdb_override)
    errors = []
    for title, year in world_film_hints(world):
        try:
            return resolve_film(title, None, year)
        except Exception as e:
            errors.append(f"{title} ({year or 'no year'}): {e}")
    raise RuntimeError("; ".join(errors) or f"no TMDB movie for concept {world.get('concept')!r}")

def resolve_cast(mid, top, media_type="movie"):
    cr = tmdb(f"/{media_type}/{mid}/credits").get("cast", [])
    cr = sorted(cr, key=lambda c: c.get("order", 9999))[:top]
    out = []
    for c in cr:
        out.append({
            "tmdb_person_id": c["id"], "actor": c["name"],
            "character": c["character"], "order": c.get("order"),
            "profile_path": c.get("profile_path"),
        })
    return out

# ---------- source: IMDB ----------
def harvest_imdb(imdb_id, outdir, refresh=False, title=None, year=None):
    stills_dir = outdir / "stills"; stills_dir.mkdir(parents=True, exist_ok=True)
    if not refresh and any(stills_dir.glob("*.jpg")):
        return sorted(stills_dir.glob("*.jpg"))
    url = f"https://www.imdb.com/title/{imdb_id}/mediaindex/"
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        pg = b.new_context(user_agent=UA, viewport={"width":1920,"height":1080}, locale="en-US").new_page()
        pg.goto(url, wait_until="domcontentloaded", timeout=60000)
        try: pg.wait_for_selector("script#__NEXT_DATA__", timeout=15000)
        except Exception: pass
        html = pg.content(); b.close()
    found = set()
    for m in re.finditer(r'(https://m\.media-amazon\.com/images/[^\s"\\]+?\.(?:jpg|jpeg|png))', html):
        found.add(re.sub(r"\._V1_[^.]+\.", "._V1_.", m.group(1)))
    s = requests.Session(); s.headers.update({"User-Agent": UA})
    saved = []
    for i, u in enumerate(sorted(found), 1):
        try:
            r = s.get(u, timeout=30)
            if r.status_code != 200: continue
            fp = stills_dir / f"{i:03d}.jpg"; fp.write_bytes(r.content); saved.append(fp)
        except Exception: continue
        time.sleep(0.3)
    return saved

# ---------- source: FanCaps ----------
_FANCAPS_INDEX = None
def _load_fancaps_index():
    global _FANCAPS_INDEX
    if _FANCAPS_INDEX is None:
        p = WG/"public"/"imdb-cache"/"_fancaps_index.json"
        if not p.exists():
            raise RuntimeError("fancaps index missing — run scripts/index_fancaps.py first")
        _FANCAPS_INDEX = json.loads(p.read_text(encoding="utf-8"))
    return _FANCAPS_INDEX

def _fancaps_lookup(title, year):
    """Return movieid for (title, year), with year disambiguation."""
    if not title: return None
    idx = _load_fancaps_index()
    t_norm = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
    cands = []
    for mid, rec in idx.items():
        r_norm = re.sub(r"[^a-z0-9]+", " ", (rec["title"] or "").lower()).strip()
        if r_norm == t_norm:
            ry = rec.get("year")
            ydiff = abs((ry or 0) - (int(year) if year else 0)) if (ry and year) else 99
            cands.append((ydiff, mid, rec))
    if not cands: return None
    cands.sort(key=lambda c: c[0])    # closest year wins
    return cands[0][1]

def harvest_fancaps(imdb_id, outdir, refresh=False, title=None, year=None):
    stills_dir = outdir/"stills"; stills_dir.mkdir(parents=True, exist_ok=True)
    if not refresh and any(stills_dir.glob("*.jpg")):
        return sorted(stills_dir.glob("*.jpg"))
    from curl_cffi import requests as crq
    mid = _fancaps_lookup(title, year)
    if not mid:
        print(f"      fancaps: no movieid for {title!r} ({year}) — falling back to IMDB")
        return harvest_imdb(imdb_id, outdir, refresh=refresh)
    print(f"      fancaps movieid={mid}")
    # paginate pages 1..N
    all_ids = []
    page = 1
    while True:
        url = f"https://fancaps.net/movies/MovieImages.php?movieid={mid}&page={page}"
        r = crq.get(url, impersonate="chrome120", timeout=30)
        if r.status_code != 200: break
        ids = list(dict.fromkeys(re.findall(r"mvt\.fancaps\.net/(\d+)\.jpg", r.text)))
        if not ids: break
        new = [i for i in ids if i not in all_ids]
        if not new: break
        all_ids.extend(new)
        # is there a "next" page?
        pages = set(int(p) for p in re.findall(rf'movieid={mid}[^"\']*?page=(\d+)', r.text))
        if not pages or max(pages) <= page: break
        page += 1
        time.sleep(0.4)
    print(f"      fancaps pages={page} ids={len(all_ids)}")
    # download full-res
    saved = []
    for i, fid in enumerate(all_ids, 1):
        try:
            full = f"https://cdni.fancaps.net/file/fancaps-movieimages/{fid}.jpg"
            r = crq.get(full, impersonate="chrome120", timeout=30)
            if r.status_code != 200: continue
            fp = stills_dir/f"fc_{fid}.jpg"; fp.write_bytes(r.content); saved.append(fp)
        except Exception: continue
        time.sleep(0.15)
    return saved

SOURCES = {"imdb": harvest_imdb, "fancaps": harvest_fancaps}

# ---------- face matching ----------
def cos(a, b): return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

def build_app():
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    return app

def biggest(faces):
    return max(faces, key=lambda f:(f.bbox[2]-f.bbox[0])*(f.bbox[3]-f.bbox[1]))

def match_and_crop(cast, stills, outdir, app, thresh, min_face_px):
    adir = outdir/"anchors"; adir.mkdir(exist_ok=True)
    cdir = outdir/"crops";   cdir.mkdir(exist_ok=True)
    # anchors from TMDB headshots
    anchors = {}
    for c in cast:
        if not c.get("profile_path"): continue
        ap_img = adir/f"{c['tmdb_person_id']}.jpg"
        ap_emb = adir/f"{c['tmdb_person_id']}.npy"
        if ap_emb.exists():
            try:
                anchors[c["tmdb_person_id"]] = {"emb": np.load(ap_emb), **c}
                continue
            except Exception:
                pass  # corrupt cache - fall through to recompute
        if not ap_img.exists():
            try: ap_img.write_bytes(requests.get(TMDB_IMG+c["profile_path"], timeout=30).content)
            except Exception: continue
        img = cv2.imread(str(ap_img))
        if img is None: continue
        fs = app.get(img)
        if not fs: continue
        emb = biggest(fs).embedding
        try: np.save(ap_emb, emb)
        except Exception: pass
        anchors[c["tmdb_person_id"]] = {"emb": emb, **c}
    # gallery faces
    gallery = []
    for s in stills:
        img = cv2.imread(str(s))
        if img is None: continue
        for f in app.get(img):
            gallery.append((s, img, f))
    # per-character best match, gated on score AND crop size
    results = []
    for pid, a in anchors.items():
        scored = sorted(((cos(a["emb"], g[2].embedding), g) for g in gallery), key=lambda x:-x[0])
        chosen = None
        for score, (s, img, f) in scored:
            if score < thresh: break
            x1,y1,x2,y2 = [int(v) for v in f.bbox]
            pad = int((x2-x1)*0.4); h,w = img.shape[:2]
            x1,y1 = max(0,x1-pad),max(0,y1-pad); x2,y2 = min(w,x2+pad),min(h,y2+pad)
            cw, ch = x2-x1, y2-y1
            if min(cw,ch) < min_face_px:    # min-px gate: skip too-small, try next candidate
                continue
            cropfile = cdir/(safe_file_stem(a["character"], str(pid))+".jpg")
            cv2.imwrite(str(cropfile), img[y1:y2, x1:x2])
            chosen = {"character":a["character"],"actor":a["actor"],"score":round(score,3),
                      "crop":str(cropfile),"w":cw,"h":ch,"still":s.name}
            break
        results.append({"character":a["character"],"actor":a["actor"],
                        "matched":chosen is not None, "detail":chosen,
                        "best_below_gate": (not chosen)})
    return anchors, results

def build_top_cast_portraits(world, cast, crop_results, apply, limit):
    build_id = str(world.get("id") or "world").strip() or "world"
    by_character = {str(r.get("character") or ""): r for r in crop_results}
    out = []
    for idx, c in enumerate(cast[:max(0, limit)]):
        actor = c.get("actor") or ""
        character = c.get("character") or ""
        person_id = c.get("tmdb_person_id")
        source_path = None
        source_kind = "tmdb-profile"
        matched = by_character.get(character)
        if matched and matched.get("matched") and matched.get("detail", {}).get("crop"):
            source_path = Path(matched["detail"]["crop"])
            source_kind = "imdb-arcface-crop"
        safe = f"{idx+1:02d}_{safe_file_stem(actor or character or person_id, 'cast')}.jpg"
        target = GEN / build_id / "cast" / safe
        image_url = f"/generated/{build_id}/cast/{safe}"
        applied = False
        if apply:
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                if source_path and source_path.exists():
                    shutil.copy2(source_path, target)
                    applied = True
                elif c.get("profile_path"):
                    r = requests.get(TMDB_IMG + c["profile_path"], timeout=30)
                    if r.status_code == 200 and r.content:
                        target.write_bytes(r.content)
                        applied = True
            except Exception as e:
                print(f"  [CAST-SKIP] {actor} ({character}) image write failed: {e}")
        else:
            applied = bool(source_path or c.get("profile_path"))
        out.append({
            "actor": actor,
            "character": character,
            "order": int(c.get("order") or idx),
            "tmdbPersonId": person_id,
            "profilePath": c.get("profile_path"),
            "source": source_kind,
            "imageUrl": image_url,
            "applied": applied,
        })
    return out

# ---------- world apply ----------
def load_world(world_arg):
    p = Path(world_arg)
    if p.is_file():
        fp = p
    else:
        cands = glob.glob(str(DATA/f"world-*{world_arg}*.json"))
        if not cands: raise RuntimeError(f"no world file for {world_arg}")
        fp = Path(cands[0])
    return fp, json.loads(fp.read_text(encoding="utf-8"))

def npc_portrait_path(npc):
    imgs = npc.get("images") or {}
    p = imgs.get("portrait")
    if not p: return None
    p = re.split(r"[?#]", str(p), 1)[0]
    return (WG/"public"/p.lstrip("/\\")).resolve()

def plan_and_apply(world, crops_by_char, apply, min_face_px):
    npcs = world.get("npcs", [])
    portrait_sources = ((world.get("images") or {}).get("portraitSources") or {})
    plan = []
    claimed_npcs = set()
    build_id = str(world.get("id") or "world").strip() or "world"
    for r in crops_by_char:
        if not r["matched"]: 
            plan.append((r["character"], None, "no usable match (absent or below gate)")); continue
        # fuzzy match character -> npc
        best = max(npcs, key=lambda n: name_score(r["character"], n.get("name","")), default=None)
        sc = name_score(r["character"], best.get("name","")) if best else 0
        if not best or sc < 0.34:
            plan.append((r["character"], None, f"no NPC name match (best={sc:.2f})")); continue
        npc_id = str(best.get("id") or "")
        protected_kind = (portrait_sources.get(npc_id) or {}).get("kind")
        if protected_kind == "manual" or npc_id in claimed_npcs:
            plan.append((r["character"], best.get("name"), "protected or already claimed portrait")); continue
        tgt = npc_portrait_path(best)
        if not tgt:
            safe = safe_file_stem(npc_id or best.get("name", ""), hashlib.sha1(best.get("name","npc").encode()).hexdigest()[:10])[:80]
            tgt = GEN / build_id / f"{safe}.jpg"
            target_url = f"/generated/{build_id}/{safe}.jpg"
        else:
            try:
                rel = tgt.relative_to(WG / "public")
                target_url = "/" + str(rel).replace("\\", "/")
            except Exception:
                target_url = None
        claimed_npcs.add(npc_id)
        plan.append((r["character"], best.get("name"), {
            "target": tgt, "crop": r["detail"]["crop"],
            "targetUrl": target_url,
            "npcId": npc_id, "npc": best.get("name"),
            "actor": r["detail"]["actor"], "score": r["detail"]["score"],
            "w": r["detail"]["w"], "h": r["detail"]["h"],
            "wh": f'{r["detail"]["w"]}x{r["detail"]["h"]}',
        }))
    # execute
    applied = 0
    for char, npcname, info in plan:
        if isinstance(info, dict):
            if apply:
                bk = info["target"].parent/"_pre_imdb_backup"; bk.mkdir(parents=True, exist_ok=True)
                if not (bk/info["target"].name).exists():
                    if info["target"].exists():
                        shutil.copy2(info["target"], bk/info["target"].name)
                info["target"].parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(info["crop"], info["target"])
                applied += 1
    return plan, applied


# ---------- per-world runner (callable from main or batch) ----------
def run_world(world_arg, args, app):
    fp, world = load_world(world_arg)
    concept = (world.get("concept") or "").strip()
    summary = {"world": fp.name, "concept": concept, "skipped": None,
               "matches": 0, "applied": 0, "swaps": [], "rw": bool(world.get("realWorldBased")),
               "swaps_detail": [], "skipped_swaps": [], "cast_portraits": [],
               "film": None, "source": args.source, "buildId": world.get("id") or fp.stem.replace("world-", "")}
    print(f"\n[world] {fp.name}")
    print(f"[world] concept={concept!r}  npcs={len(world.get('npcs',[]))}  rw={summary['rw']}")

    if not concept:
        summary["skipped"] = "no concept"; print(f"  SKIP: {summary['skipped']}"); return summary
    if args.rw_only and not summary["rw"]:
        summary["skipped"] = "not realWorldBased"; print(f"  SKIP: {summary['skipped']}"); return summary

    try:
        mid, imdb_id, title, year, media_type = resolve_film_from_world(world, args.tmdb)
    except Exception as e:
        summary["skipped"] = f"film resolve failed: {e}"; print(f"  SKIP: {summary['skipped']}"); return summary
    if not imdb_id:
        summary["skipped"] = "no IMDB id for resolved film"; print(f"  SKIP: {summary['skipped']}"); return summary
    print(f"[film]  {title} ({year})  {media_type} tmdb={mid} imdb={imdb_id}")

    cast = resolve_cast(mid, args.top, media_type)

    # OVERLAP GUARD: at least N TMDB characters must fuzzy-match an NPC name
    npcs = world.get("npcs", [])
    overlap = 0
    for c in cast:
        best = max((name_score(c["character"], n.get("name","")) for n in npcs), default=0)
        if best >= 0.34: overlap += 1
    run_npc_swaps = True
    if overlap < args.min_overlap:
        run_npc_swaps = False
        print(f"  WARN: name overlap low ({overlap} < {args.min_overlap}) — exporting top cast only")
    print(f"[cast]  top {len(cast)} resolved (overlap={overlap} NPCs)")

    outdir = CACHE/imdb_id
    stills = SOURCES[args.source](imdb_id, outdir, refresh=args.refresh, title=title, year=year)
    print(f"[{args.source}] {len(stills)} stills")

    anchors, results = match_and_crop(cast, stills, outdir, app, args.thresh, args.min_face_px)
    nmatch = sum(1 for r in results if r["matched"])
    summary["matches"] = nmatch
    print(f"[face]  anchors={len(anchors)}/{len(cast)}  usable matches={nmatch} (min-px={args.min_face_px})")

    cast_portraits = build_top_cast_portraits(world, cast, results, args.apply, args.cast_portraits)
    summary["cast_portraits"] = cast_portraits
    for c in cast_portraits:
        if c.get("applied"):
            print(f"  [CAST] {c['actor']} as {c['character']} -> {c['imageUrl']}")

    if run_npc_swaps:
        plan, applied = plan_and_apply(world, results, args.apply, args.min_face_px)
        summary["applied"] = applied
        for char, npcname, info in plan:
            if isinstance(info, dict):
                summary["swaps"].append(f"{char} -> {info['npc']} ({info['wh']})")
                summary["swaps_detail"].append({
                    "npcId": info["npcId"], "npcName": info["npc"], "character": char,
                    "actor": info["actor"], "score": info["score"],
                    "w": info["w"], "h": info["h"], "crop": info["crop"],
                    "targetUrl": info.get("targetUrl"),
                    "applied": bool(args.apply),
                })
                mark = "WROTE" if args.apply else "would"
                print(f"  [{mark}] {char:22s} -> {info['npc']:24s} {info['wh']}")
            else:
                summary["skipped_swaps"].append({"character": char, "reason": str(info)})
    else:
        summary["skipped_swaps"].append({"character": "*", "reason": f"NPC swaps skipped: name overlap {overlap} < {args.min_overlap}"})
    summary["film"] = {"tmdb": mid, "imdb": imdb_id, "title": title, "year": year, "mediaType": media_type}
    return summary

def list_worlds():
    return sorted(glob.glob(str(DATA/"world-*.json")))

def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=False)
    g.add_argument("--world", help="build id (or substring of world filename)")
    g.add_argument("--batch", action="store_true", help="iterate ALL world files")
    ap.add_argument("--rw-only", action="store_true", dest="rw_only", help="batch: only realWorldBased worlds")
    ap.add_argument("--min-overlap", type=int, default=1, dest="min_overlap",
                    help="min TMDB characters that must match an NPC name to proceed (default 1)")
    ap.add_argument("--tmdb", type=int, default=None)
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument("--cast-portraits", type=int, default=3, dest="cast_portraits",
                    help="export top-billed cast portraits separately from NPC fuzzy matching (default 3)")
    ap.add_argument("--thresh", type=float, default=0.45)
    ap.add_argument("--min-face-px", type=int, default=420, dest="min_face_px")
    ap.add_argument("--source", default="imdb", choices=list(SOURCES))
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true", dest="emit_json",
                    help="emit a PIPELINE_RESULT_JSON sentinel line for machine parsing")
    ap.add_argument("--limit", type=int, default=None, help="batch: cap number of worlds processed")
    ap.add_argument("--check", action="store_true",
                    help="report importable deps as JSON and exit (no model load)")
    args = ap.parse_args()

    if args.check:
        missing = []
        for mod in ("numpy", "cv2", "requests", "playwright",
                    "insightface", "onnxruntime", "curl_cffi"):
            try:
                __import__(mod)
            except Exception:
                missing.append(mod)
        print("PIPELINE_CHECK_JSON=" + json.dumps({"ok": not missing, "missing": missing}))
        return
    if not args.world and not args.batch:
        ap.error("one of --world or --batch is required")

    if not os.environ.get("TMDB_API_KEY", "").strip():
        ap.error("TMDB_API_KEY is required")
    print("[init]  loading face model (one-time)...")
    app = build_app()

    if args.world:
        summary = run_world(args.world, args, app)
        if args.emit_json:
            print("PIPELINE_RESULT_JSON=" + json.dumps(summary, default=str))
        return

    # batch
    worlds = list_worlds()
    if args.limit: worlds = worlds[:args.limit]
    print(f"[batch] {len(worlds)} world files")
    summaries = []
    for w in worlds:
        try:
            summaries.append(run_world(w, args, app))
        except Exception as e:
            print(f"  ERROR on {Path(w).name}: {e}")
        time.sleep(1.5)   # IMDB politeness between worlds

    print("\n" + "="*70)
    print(f"BATCH SUMMARY ({'APPLIED' if args.apply else 'DRY-RUN'})")
    print("="*70)
    ran = [s for s in summaries if not s["skipped"]]
    skipped = [s for s in summaries if s["skipped"]]
    print(f"ran: {len(ran)} worlds  |  skipped: {len(skipped)}  |  total swaps {'written' if args.apply else 'planned'}: {sum(s['applied' if args.apply else 'matches'] for s in ran)}")
    print(f"\nSwaps per world:")
    for s in ran:
        n = s["applied"] if args.apply else s["matches"]
        if n:
            print(f"  {n:2d}  {s['concept'][:60]}")
    print(f"\nSkip reasons:")
    skip_groups = {}
    for s in skipped: skip_groups.setdefault(s["skipped"].split(":")[0],[]).append(s["concept"][:50])
    for reason, items in skip_groups.items():
        print(f"  [{len(items):2d}] {reason}")
        for it in items[:3]: print(f"        - {it}")
        if len(items)>3: print(f"        ... and {len(items)-3} more")

if __name__ == "__main__":
    main()
