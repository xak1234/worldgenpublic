#!/usr/bin/env python3
# auto-pack-worlds.py - generate sound packs for unbound worlds + add music themes to existing music packs.
# Usage: python auto-pack-worlds.py [--limit N] [--music-only] [--dry-run] [--all-worlds]
import os, sys, json, re, glob, argparse
sys.path.insert(0, os.path.dirname(__file__))
from _pack_themes import llm_themes, validate_themes, getenv

ROOT = os.path.abspath(os.environ.get("WORLDGEN_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_dd = os.environ.get("WORLDGEN_DATA_DIR")
DATA = os.path.abspath(os.path.join(ROOT, _dd)) if _dd else os.path.join(ROOT, "data")
AUDIO = os.path.join(ROOT, "public", "audio")

# Curated bank of verified-working Freesound short queries by category
BANK = {
    "horror":       {"horror_drone": "horror drone tension", "haunted_house": "haunted house ambience", "creepy_basement": "basement creaking", "distant_screams": "distant scream echo"},
    "slasher":      {"slasher_stab": "knife stab impact", "chase_breath": "running breath panic", "forest_night": "forest night insects"},
    "scifi":        {"spaceship_hum": "spaceship engine hum", "computer_beep": "computer beep console", "airlock": "airlock door pressure", "deep_space": "deep space drone"},
    "alien":        {"alien_hiss": "alien growl creature", "corridor_drip": "dark corridor drip", "distress_beacon": "warning alarm pulse"},
    "war":          {"battlefield": "battlefield gunfire distant", "radio_chatter": "military radio chatter", "trench_wind": "trench wind ambience", "bomb_distant": "distant explosion bomb"},
    "vintage":      {"old_radio": "vintage radio static", "reel_to_reel": "reel tape machine", "phonograph": "vinyl record crackle"},
    "city_modern":  {"city_street": "city street traffic", "office": "office ambience", "subway": "subway train station", "apartment": "apartment interior"},
    "rural":        {"farmhouse": "farmhouse interior wood", "countryside": "countryside birds wind", "barn": "barn ambience hay"},
    "desert":       {"desert_wind": "desert wind dry", "sandstorm": "sandstorm distant", "empty_road": "empty desert road"},
    "forest":       {"forest_day": "forest birds day", "forest_night": "forest night insects", "river_stream": "river stream water"},
    "ocean":        {"ocean_waves": "ocean waves beach", "boat_creak": "boat creak rope", "seagulls": "seagulls coast"},
    "prison":       {"cell_block": "prison cell metal", "prison_yard": "prison yard crowd", "steel_door": "steel door slam"},
    "crime":        {"police_radio": "police radio chatter", "sirens": "police siren chase", "interrogation": "interrogation room"},
    "romance":      {"cafe_chat": "cafe chatter quiet", "piano_lounge": "piano lounge bar", "fireplace": "fireplace crackle"},
    "medieval":     {"castle_hall": "castle hall echo", "medieval_tavern": "medieval tavern crowd", "sword_clash": "sword clash metal"},
    "vampire":      {"crypt": "crypt drip echo", "thunder_storm": "thunder storm rain", "organ_dark": "church organ dark"},
    "club":         {"club_floor": "dance club crowd", "bass_thump": "club bass thump", "vip_lounge": "lounge bar ambience"},
    "hospital":     {"hospital_hall": "hospital corridor footsteps", "ward": "hospital ward beep", "emergency": "emergency room"},
    "casino":       {"slot_machines": "casino slot machines", "poker_room": "poker chips shuffle", "vegas_strip": "las vegas strip ambience"},
}

# Music genre queries (verified working)
MUSIC = {
    "country":      [("country_session", "blues guitar slide"), ("folk_song", "folk acoustic guitar"), ("rockabilly", "rockabilly guitar")],
    "pop":          [("pop_ballad", "female vocal pop"), ("piano_pop", "pop piano ballad"), ("synth_80s", "synth pop 80s")],
    "electronic":   [("house_set", "techno electronic loop"), ("synth_groove", "synth pop 80s")],
    "rock":         [("rock_riff", "rock guitar riff"), ("blues_rock", "blues guitar slide")],
    "hawaiian":     [("ukulele_song", "ukulele acoustic"), ("folk_island", "folk acoustic guitar")],
    "classical":    [("orchestra", "orchestra strings"), ("piano_solo", "piano solo melody")],
}

KEYWORD_TO_CATEGORY = [
    (("horror","haunt","demon","ghost","freddy","krueger","hellraiser","frankenstein","cannical","holocaust"), "horror"),
    (("slasher","killer","ripper","manson"), "slasher"),
    (("space","starship","andromeda","saturn","mars","alien planet","starcraft","startrek","star trek","nostromo","3000","3200","2099","2200","logans run"), "scifi"),
    (("alien","nostromo","xenomorph"), "alien"),
    (("war","vietnam","trench","cold war","ww1","ww2","world war","escobar","cocaine wars"), "war"),
    (("1940s","1950s","1960s","1970s","1980s","1985","vintage","old"), "vintage"),
    (("city","manhattan","york","london","village","thrybergh","rotherham","yorkshire"), "city_modern"),
    (("village","farm","countryside","rural"), "rural"),
    (("desert","area 51","nevada"), "desert"),
    (("forest","woods","wardrobe","narnia","lion"), "forest"),
    (("ocean","sea","island","harbor"), "ocean"),
    (("prison","juvinile","juvenile","detention","armey","armley","offenders"), "prison"),
    (("crime","police","ripper","hostel","red room"), "crime"),
    (("romance","love","emmanuelle","harem","sex worker","red room","hucow"), "romance"),
    (("medieval","castle","hunchback","notre dame","witch","salem"), "medieval"),
    (("vampire","dracula","crypt"), "vampire"),
    (("club","dance","ibiza","summer of love","back to the 80s"), "club"),
    (("casino","vegas","hangover","gambling"), "casino"),
    (("hospital","medical","clinic"), "hospital"),
    (("shining","overlook","kubrick hotel"), "horror"),
    (("exorcist","possession","dybbuk","demonic"), "horror"),
    (("the thing","carpenter thing","antarctic","polar station"), "alien"),
    (("body snatchers","pod people","invasion"), "alien"),
    (("dark star","silent running","derelict ship","botanical greenhouse"), "scifi"),
    (("texas chainsaw","hills have eyes","hitcher","i spit"), "slasher"),
    (("trainspotting","junkie","heroin","glasgow","edinburgh"), "city_modern"),
]

MUSIC_TRIGGERS = [
    (("country","cash","folsom","walk the line","willie","hank"), "country"),
    (("pop","madonna","gaga","britney","taylor swift","diva"), "pop"),
    (("electronic","pete tong","ibiza","dj","rave","techno","house"), "electronic"),
    (("rock","led zeppelin","queen","stones"), "rock"),
    (("hawaii","hawaiian","island","ukulele","first dates"), "hawaiian"),
    (("orchestra","classical","symphony"), "classical"),
]

def slug(s):
    s = re.sub(r"[^a-zA-Z0-9]+", "_", s.lower()).strip("_")
    return s[:40] or "world"

def normalize_text(value):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(value or "").lower().replace("&", " and "))).strip()

def phrase_match(hay, needle):
    n = normalize_text(needle)
    return bool(n) and (" " + hay + " ").find(" " + n + " ") >= 0

def pack_matches_world(pack, world_id, concept):
    if world_id and world_id in (pack.get("worldIds") or []):
        return True
    c = normalize_text(concept)
    return bool(c) and any(phrase_match(c, m) for m in (pack.get("match") or []))

def pack_is_runtime_usable(pack):
    return bool(pack.get("dir") and pack.get("base") and (pack.get("worldIds") or pack.get("match")))

def categorize(concept):
    cl = concept.lower()
    cats = []
    for keywords, cat in KEYWORD_TO_CATEGORY:
        if any(k in cl for k in keywords):
            cats.append(cat)
    if cats:
        return cats[:3], False
    return ["city_modern"], True  # fell back -> caller should try LLM

def music_genre(concept):
    cl = concept.lower()
    for keywords, genre in MUSIC_TRIGGERS:
        if any(k in cl for k in keywords):
            return genre
    return None

def build_themes(concept, cats, music):
    themes = {}
    for cat in cats:
        for k, v in BANK[cat].items():
            themes[k] = v
    if music:
        for k, v in MUSIC[music]:
            themes[k] = v
    return themes

def build_pack(name, world_id, concept, themes, themes_source="bank"):
    return {
        "name": name,
        "dir": name,
        "worldIds": [world_id] if world_id else [],
        "match": [concept.lower().strip(), slug(concept).replace("_", " ")],
        "volumes": {"base": 0.42, "detail": 0.30, "weather": 0.22, "crowd": 0.22},
        "base": {"default": list(themes.keys())[0], "byKeyword": []},
        "detail": {"default": list(themes.keys())[-1], "byKeyword": []},
        "themesSource": themes_source,
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=999)
    ap.add_argument("--music-only", action="store_true", help="only add music themes to existing music packs")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--all-worlds", action="store_true", help="include standard worlds without sourceDocuments")
    ap.add_argument("--no-llm", action="store_true", help="disable LLM fallback for unmatched concepts")
    args = ap.parse_args()

    existing_pack_dirs = {d for d in os.listdir(AUDIO) if os.path.isdir(os.path.join(AUDIO, d))}
    existing_packs = {}
    bound_worlds = set()
    for pd in existing_pack_dirs:
        pj = os.path.join(AUDIO, pd, "pack.json")
        if not os.path.exists(pj): continue
        with open(pj, encoding="utf-8") as f: p = json.load(f)
        existing_packs[pd] = p
        for w in p.get("worldIds", []) or []:
            bound_worlds.add(w)

    # Phase A: music-only mode -- inject music themes into existing music packs
    if args.music_only:
        for pd in existing_pack_dirs:
            pj = os.path.join(AUDIO, pd, "pack.json")
            tj = os.path.join(AUDIO, pd, "_themes.json")
            if not os.path.exists(pj) or not os.path.exists(tj): continue
            with open(pj, encoding="utf-8") as f: p = json.load(f)
            concept_text = " ".join([str(x) for x in (p.get("match") or [])])
            mg = music_genre(concept_text + " " + pd)
            if not mg: continue
            with open(tj, encoding="utf-8") as f: th = json.load(f)
            added = []
            for tname, tquery in MUSIC[mg]:
                if tname not in th:
                    th[tname] = tquery
                    added.append(tname)
            if added:
                print("  %-25s + %s themes: %s" % (pd, mg, ", ".join(added)))
                if not args.dry_run:
                    with open(tj, "w", encoding="utf-8") as f: json.dump(th, f, indent=2)
        return

    # Phase B: full orphan mode -- generate packs for unbound worlds
    new_packs = []
    count = 0
    for wf in sorted(glob.glob(os.path.join(DATA, "world-*.json"))):
        if count >= args.limit: break
        try:
            with open(wf, encoding="utf-8") as f: w = json.load(f)
        except: continue
        wid = w.get("id") or os.path.basename(wf).replace("world-","").replace(".json","")
        sd = w.get("sourceDocuments") or []
        if not args.all_worlds and not (isinstance(sd, list) and len(sd) > 0): continue
        concept = w.get("concept") if isinstance(w.get("concept"), str) else ""
        if not concept.strip(): continue
        name = slug(concept)
        if any(pack_matches_world(p, wid, concept) and pack_is_runtime_usable(p) for p in existing_packs.values()):
            continue
        if name in existing_pack_dirs and pack_is_runtime_usable(existing_packs.get(name, {})):
            continue
        cats, fell_back = categorize(concept)
        mg = music_genre(concept)
        themes = build_themes(concept, cats, mg)
        themes_source = "bank"
        if fell_back and not args.no_llm:
            cb = getenv("CEREBRAS_API_KEY"); ds = getenv("DEEPSEEK_API_KEY")
            fs = getenv("SOMA_API") or getenv("FREESOUND_API_KEY")
            if (cb or ds) and fs:
                print("  [%s] no keyword match -> LLM" % name)
                llm = llm_themes(concept, cb_key=cb, ds_key=ds, verbose=True)
                if llm:
                    valid = validate_themes(llm, fs)
                    if len(valid) >= 4:
                        themes = valid
                        if mg:
                            for k, v in MUSIC[mg]:
                                themes.setdefault(k, v)
                        themes_source = "llm"
                        print("    -> kept %d LLM themes" % len(themes))
                    else:
                        print("    -> too few valid (%d); keeping bank fallback" % len(valid))
                        themes_source = "bank-fallback"
                else:
                    print("    -> LLM produced nothing; keeping bank fallback")
                    themes_source = "bank-fallback"
            else:
                themes_source = "bank-fallback"
        elif fell_back:
            themes_source = "bank-fallback"
        legacy = existing_packs.get(name, {})
        pack = {**legacy, **build_pack(name, wid, concept, themes, themes_source=themes_source)}
        new_packs.append((name, wid, concept[:50], cats, mg, themes))
        count += 1
        if not args.dry_run:
            d = os.path.join(AUDIO, name)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "_themes.json"), "w", encoding="utf-8") as f: json.dump(themes, f, indent=2)
            with open(os.path.join(d, "pack.json"), "w", encoding="utf-8") as f: json.dump(pack, f, indent=2)

    print("\n=== created %d packs %s===" % (len(new_packs), "(DRY RUN) " if args.dry_run else ""))
    for name, wid, concept, cats, mg, themes in new_packs:
        music_note = " +music=%s" % mg if mg else ""
        print("  %-30s cats=%s%s themes=%d  concept=%s" % (name, "+".join(cats), music_note, len(themes), concept))
    print("\nnext: python scripts/fetch-sfx-parallel.py --packs %s --per 6 --workers 12" % ",".join(n for n,_,_,_,_,_ in new_packs))

if __name__ == "__main__":
    main()

