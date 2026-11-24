#!/usr/bin/env python3
# build-world-packs.py - end-to-end soundscape pipeline orchestrator.
#
# Runs in order:
#   Phase 1: scripts/auto-pack-worlds.py   (create pack.json + _themes.json for new worlds)
#   Phase 2: scripts/enhance-bland-packs.py (LLM-regen any bland themes)
#   Phase 3: scripts/fetch-sfx-parallel.py  (download MP3s for packs missing audio)
#
# All phases are idempotent. Single combined log at $WORLDGEN_LOG_DIR/build_world_packs.log (default <root>/logs).
# Usage:
#   python scripts/build-world-packs.py              # full pipeline
#   python scripts/build-world-packs.py --skip 1     # skip phase 1
#   python scripts/build-world-packs.py --only 3     # only phase 3
#   python scripts/build-world-packs.py --packs the_thing,the_shining   # restrict phase 3 to specific packs
#   python scripts/build-world-packs.py --min-files 8  # phase 3: only refetch packs with < N files
import os, sys, json, subprocess, time, argparse, glob, io

ROOT = os.path.abspath(os.environ.get("WORLDGEN_ROOT") or os.path.dirname(os.path.dirname(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts")
AUDIO = os.path.join(ROOT, "public", "audio")
LOG_DIR = os.path.abspath(os.path.join(ROOT, os.environ.get("WORLDGEN_LOG_DIR") or "logs"))
LOG_PATH = os.path.join(LOG_DIR, "build_world_packs.log")
PY = sys.executable

# packs that are infra, not world soundscapes
SKIP_DIRS = {"ambient", "music", "sfx", "ui"}

def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")

class Tee:
    def __init__(self, *files): self.files = files
    def write(self, s):
        for f in self.files:
            try: f.write(s); f.flush()
            except Exception: pass
    def flush(self):
        for f in self.files:
            try: f.flush()
            except Exception: pass

def header(log, title):
    bar = "=" * 60
    log.write("\n%s\n%s  %s\n%s\n" % (bar, now(), title, bar))

def run_phase(log, label, cmd):
    header(log, label)
    log.write("$ " + " ".join(cmd) + "\n")
    t0 = time.time()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    assert p.stdout is not None
    for line in p.stdout:
        log.write(line)
    rc = p.wait()
    log.write("\n[%s] exit=%d duration=%.1fs\n" % (label, rc, time.time() - t0))
    return rc

def pack_audio_status(pack_dir):
    files = 0
    themes = set()
    root_dir = os.path.join(AUDIO, pack_dir)
    for root, _, names in os.walk(root_dir):
        for fn in names:
            if fn.lower().endswith((".mp3", ".ogg", ".wav", ".flac")):
                files += 1
                rel = os.path.relpath(root, root_dir)
                if rel != ".":
                    themes.add(rel.split(os.sep)[0])
    return files, len(themes)

def packs_needing_audio(min_files, min_themes, restrict=None):
    """Return pack dirs that have themes/pack.json but are below file or theme coverage thresholds."""
    out = []
    for pd in sorted(os.listdir(AUDIO)):
        if pd in SKIP_DIRS: continue
        p = os.path.join(AUDIO, pd)
        if not os.path.isdir(p): continue
        if restrict and pd not in restrict: continue
        themes_path = os.path.join(p, "_themes.json")
        pack_path = os.path.join(p, "pack.json")
        if not (os.path.exists(themes_path) and os.path.exists(pack_path)): continue
        files, themes = pack_audio_status(pd)
        if files < min_files or themes < min_themes:
            out.append((pd, files, themes))
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip", type=str, default="", help="comma-separated phases to skip (1,2,3)")
    ap.add_argument("--only", type=str, default="", help="run only these phases (overrides --skip)")
    ap.add_argument("--packs", type=str, default="", help="phase 3 restrict to comma-separated packs")
    ap.add_argument("--min-files", type=int, default=6, help="phase 3: refetch packs with fewer audio files than this")
    ap.add_argument("--min-themes", type=int, default=3, help="phase 3: refetch packs covering fewer themes than this")
    ap.add_argument("--per", type=int, default=6, help="fetch-sfx --per")
    ap.add_argument("--workers", type=int, default=4, help="fetch-sfx-parallel --workers")
    ap.add_argument("--limit-phase1", type=int, default=999, help="auto-pack --limit")
    ap.add_argument("--all-worlds", action="store_true", help="pass --all-worlds to phase 1")
    ap.add_argument("--dry-run", action="store_true", help="plan only, do not execute")
    args = ap.parse_args()

    if args.only:
        phases = set(int(x) for x in args.only.split(",") if x.strip())
    else:
        skip = set(int(x) for x in args.skip.split(",") if x.strip())
        phases = {1, 2, 3} - skip

    restrict = set(p.strip() for p in args.packs.split(",") if p.strip()) if args.packs else None

    if args.dry_run:
        print("DRY RUN -- phases:", sorted(phases))
        if 3 in phases:
            need = packs_needing_audio(args.min_files, args.min_themes, restrict)
            print("Phase 3 would fetch %d packs (files<%d or themes<%d):" % (len(need), args.min_files, args.min_themes))
            for pd, files, themes in need: print("  %-40s %d files, %d themes" % (pd, files, themes))
        return 0

    log_file = None
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        log_file = io.open(LOG_PATH, "w", encoding="utf-8")
        log = Tee(log_file, sys.stdout)
    except OSError:
        log = Tee(sys.stdout)
    log.write("=== build-world-packs START %s ===\n" % now())
    log.write("phases: %s\n" % sorted(phases))

    if 1 in phases:
        cmd = [PY, "-u", os.path.join(SCRIPTS, "auto-pack-worlds.py"), "--limit", str(args.limit_phase1)]
        if args.all_worlds: cmd.append("--all-worlds")
        rc = run_phase(log, "PHASE 1: auto-pack-worlds", cmd)
        if rc != 0: log.write("WARNING: phase 1 exited %d, continuing\n" % rc)

    if 2 in phases:
        cmd = [PY, "-u", os.path.join(SCRIPTS, "enhance-bland-packs.py")]
        if restrict:
            cmd.extend(["--packs", ",".join(sorted(restrict))])
        rc = run_phase(log, "PHASE 2: enhance-bland-packs", cmd)
        if rc != 0: log.write("WARNING: phase 2 exited %d, continuing\n" % rc)

    if 3 in phases:
        need = packs_needing_audio(args.min_files, args.min_themes, restrict)
        header(log, "PHASE 3: fetch-sfx-parallel")
        log.write("%d packs need audio (files<%d or themes<%d):\n" % (len(need), args.min_files, args.min_themes))
        for pd, files, themes in need: log.write("  %-40s %d files, %d themes\n" % (pd, files, themes))
        if need:
            names = ",".join(pd for pd, _, _ in need)
            cmd = [PY, "-u", os.path.join(SCRIPTS, "fetch-sfx-parallel.py"),
                   "--packs", names, "--per", str(args.per), "--workers", str(args.workers)]
            rc = run_phase(log, "PHASE 3 RUN", cmd)
            if rc != 0: log.write("WARNING: phase 3 exited %d\n" % rc)
        else:
            log.write("no packs need fetching, skipping phase 3 run\n")

    log.write("\n=== build-world-packs DONE %s ===\n" % now())
    if log_file: log_file.close()
    return 0

if __name__ == "__main__":
    sys.exit(main())
