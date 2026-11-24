# Promote a world's CURRENT state to its reset baseline.
# Usage: python scripts/set-world-baseline.py <worldId>
#   e.g. python scripts/set-world-baseline.py build_0cd846bd-19e6-4b4c-96b5-de1fccd1c3d5
import json, os, sys, shutil
from datetime import datetime

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
wid = sys.argv[1] if len(sys.argv) > 1 else sys.exit("usage: set-world-baseline.py <worldId>")

live = os.path.join(DATA, f"world-{wid}.json")
if not os.path.isfile(live):
    sys.exit(f"World not found: {live}")

bdir = os.path.join(DATA, ".baselines")
os.makedirs(bdir, exist_ok=True)
baseline = os.path.join(bdir, f"{wid}.json")

# keep any previous baseline, timestamped
if os.path.isfile(baseline):
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(baseline, os.path.join(bdir, f"{wid}.prev-{ts}.json"))

w = json.load(open(live, encoding="utf-8"))
with open(baseline + ".tmp", "w", encoding="utf-8", newline="\n") as f:
    json.dump(w, f, ensure_ascii=False, indent=2)
json.load(open(baseline + ".tmp", encoding="utf-8"))      # round-trip check
os.replace(baseline + ".tmp", baseline)

print("Baseline set:", baseline)
print(f"  npcs={len(w.get('npcs',[]))} locs={len(w.get('locations',[]))} "
      f"timeline={len(w.get('timeline',[]))} factions={len(w.get('factions') or [])}")
print("Reset will now restore THIS state for", wid)