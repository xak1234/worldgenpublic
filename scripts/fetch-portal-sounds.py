"""
fetch-portal-sounds.py
Downloads one canonical typing/keyboard sound per world genre from Freesound,
saved to public/sounds/<genre>typing.mp3 for the portal HUD audio.

Usage:  python scripts/fetch-portal-sounds.py
Requires SOMA_API env var (Freesound API key).
"""
import os, sys, json, urllib.parse, urllib.request, io

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOUNDS_DIR = os.path.join(REPO_ROOT, 'public', 'sounds')
API_KEY = os.environ.get('SOMA_API') or open(os.path.join(REPO_ROOT, '.env'), 'r', encoding='utf-8').read().split('SOMA_API=', 1)[1].splitlines()[0].strip()

# Each entry: target filename + a list of fallback queries (most specific first).
# Search loop tries each until one returns a usable result.
GENRES = [
    {
        'file': 'horrortyping.mp3',
        'queries': ['typewriter slow', 'typewriter spooky', 'typewriter old', 'creaky typewriter'],
        'desc':  'horror worlds - slow typewriter with reverb',
    },
    {
        'file': 'vintagetyping.mp3',
        'queries': ['vintage typewriter', 'old typewriter', 'typewriter typing', 'typewriter bell'],
        'desc':  'gothic / Victorian / Addams - classic typewriter with bell',
    },
    {
        'file': 'fantasytyping.mp3',
        'queries': ['quill writing', 'quill scratch', 'ink writing', 'feather scratch paper', 'magic chime'],
        'desc':  'fantasy worlds - quill on parchment',
    },
    {
        'file': 'moderntyping.mp3',
        'queries': ['keyboard typing', 'mechanical keyboard', 'computer typing'],
        'desc':  'modern / default - keyboard tap',
    },
    {
        'file': 'noirtyping.mp3',
        'queries': ['typewriter heavy', 'typewriter old mechanical', 'typewriter loud', 'typewriter'],
        'desc':  'film noir / 1940s detective - heavy typewriter',
    },
]

def search_freesound(query):
    """Return the highest-rated short typing-style result for a query."""
    filter_val = 'duration:[1.0 TO 8.0] license:("Creative Commons 0" OR "Attribution")'
    params = {
        'query':     query,
        'filter':    filter_val,
        'sort':      'rating_desc',
        'fields':    'id,name,previews,duration,license,username',
        'page_size': '10',
        'token':     API_KEY,
    }
    url = 'https://freesound.org/apiv2/search/text/?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode('utf-8'))
    results = data.get('results', [])
    if not results:
        return None
    # Prefer 1-5s items; skip if all are too long
    for hit in results:
        if 1.0 <= hit.get('duration', 0) <= 5.0:
            return hit
    return results[0]


def search_with_fallbacks(queries):
    """Try each query in order; return first usable hit."""
    for q in queries:
        try:
            hit = search_freesound(q)
            if hit:
                return q, hit
        except Exception as e:
            print(f"    query '{q}' failed: {e}")
    return None, None


def download_preview(hit, dest_path):
    """Download the HQ preview MP3."""
    previews = hit.get('previews', {})
    src = previews.get('preview-hq-mp3') or previews.get('preview-lq-mp3')
    if not src:
        return False
    with urllib.request.urlopen(src, timeout=30) as r:
        data = r.read()
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with open(dest_path, 'wb') as f:
        f.write(data)
    return True


def main():
    print(f'Target dir: {SOUNDS_DIR}')
    os.makedirs(SOUNDS_DIR, exist_ok=True)
    results = []
    for g in GENRES:
        dest = os.path.join(SOUNDS_DIR, g['file'])
        if os.path.exists(dest):
            print(f"  SKIP {g['file']} - already exists")
            results.append({'file': g['file'], 'status': 'skip'})
            continue
        print(f"  {g['file']} ({g['desc']})")
        used_q, hit = search_with_fallbacks(g['queries'])
        if not hit:
            print(f"    NO RESULTS for any of: {g['queries']}")
            results.append({'file': g['file'], 'status': 'no_results'})
            continue
        print(f"    Query: '{used_q}' -> {hit['name']} ({hit['duration']:.1f}s, by {hit['username']})")
        try:
            if download_preview(hit, dest):
                kb = os.path.getsize(dest) // 1024
                print(f"    Saved: {g['file']} ({kb} KB, license={hit['license']})")
                results.append({'file': g['file'], 'status': 'ok', 'name': hit['name'], 'source_id': hit['id'], 'kb': kb, 'license': hit['license']})
            else:
                print(f"    No preview URL on result")
                results.append({'file': g['file'], 'status': 'no_preview'})
        except Exception as e:
            print(f"    ERROR downloading: {e}")
            results.append({'file': g['file'], 'status': 'error', 'detail': str(e)})
    print()
    ok = sum(1 for r in results if r['status']=='ok')
    skp = sum(1 for r in results if r['status']=='skip')
    print(f"Done. {ok} new files, {skp} skipped, {len(results)-ok-skp} failed.")
    return results


if __name__ == '__main__':
    main()
