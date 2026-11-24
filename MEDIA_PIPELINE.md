# MEDIA_PIPELINE.md

**You are an AI agent (Claude Code, DeepSeek loop, future Claude session, etc.). Your job is to drive WorldGen audio + photo completion to done. Read this file, then run the orchestrator. Stop when state shows complete.**

## One-line task (FREE — Cerebras free tier + Freesound + TMDB, all free)

```
cd <repo> && python scripts/complete-all-media.py --loop
```

That is the whole job. By default the orchestrator uses Cerebras (Qwen3-235B, ~363ms/call, free tier) for bland-pack theme enhancement, falling back to DeepSeek (paid) only if Cerebras fails. To disable LLM entirely use `--no-llm`.

The orchestrator now does all of:
1. Auto-pack creation for unbound worlds
2. Cerebras (or DeepSeek) theme generation for bland packs
3. Audio fetch via Freesound API
4. TMDB cast portrait sync (cast-rematch endpoint)
5. AI NPC portrait regen for unmatched cast (regen-portraits endpoint, OpenRouter image cascade)
6. Re-inventory + repeat until complete

## What "done" means

`<repo>\state\media-progress.json` shows `"complete": true`. Equivalent: every list (`needs_pack`, `needs_audio`, `needs_cast`, `needs_cover`, `npc_portrait_gaps`) is empty.

## How to check progress

```
python scripts/complete-all-media.py --status
```

Returns a summary JSON. No work happens. Safe to run any time.

## What the orchestrator does, per pass

1. **Inventory** every world in `data/world-*.json` and every pack in `public/audio/`.
2. **Create missing packs** — `auto-pack-worlds.py` adds a pack per unbound world, with concept-derived themes (music subtheme for biopics).
3. **Enhance bland themes** — `enhance-bland-packs.py` uses DeepSeek to regenerate themes on packs that fell back to generic city_modern.
4. **Fetch audio** — `fetch-sfx.py --pack X` for every pack with < 6 files. Idempotent.
5. **Cast portraits** — POST `/api/worlds/{id}/cast-rematch` for every world whose NPCs lack portraits. Requires WorldGen server running on `localhost:3002` (override with `WORLDGEN_BASE_URL` env var).
6. **Report** — writes `state/media-progress.json` listing remaining gaps. NPC AI portrait gen + world cover gen are NOT auto-triggered here; gaps are reported only.

## Requirements before running

- `DEEPSEEK_API_KEY` in `.env` (already set) — for theme enhancement
- `SOMA_API` in `.env` (already set) — Freesound
- `TMDB_API_KEY` in `.env` (already set) — for cast portraits
- WorldGen server on `:3002` for cast-rematch (skip with `--skip-photos` if not running)

## Failure handling

- Network/API failures — logged to `%TEMP%\media-pipeline.log`, next pass retries automatically (idempotent).
- DeepSeek refusal or 0-result themes — dropped silently, pack falls back to whatever existed before.
- Long-running fetch on individual pack — 900s timeout per pack, skips and continues.
- Wedged session — just rerun. Everything is resumable.

## Manual operations the orchestrator does NOT do

- **AI cover gen** for worlds missing `world.images.cover` — server-side at build time. To force regenerate, hit the WorldGen build modal or write a `/api/worlds/:id/regen-cover` route.
- **Custom NPC AI portraits** beyond TMDB — handled at build time; retro endpoint not wired.
- **Source PDF uploads** — worlds without sourceDocuments need user action.

These appear in the state file as gaps but are not blockers for "complete".

## Quick commands

```
# one pass, see what would happen
python scripts/complete-all-media.py --dry-run

# one pass, do the work
python scripts/complete-all-media.py

# run until done
python scripts/complete-all-media.py --loop

# loop, audio-only (no server needed)
python scripts/complete-all-media.py --loop --skip-photos

# just check
python scripts/complete-all-media.py --status

# tail the log
Get-Content %TEMP%\media-pipeline.log -Wait -Tail 30
```

## State file schema

```json
{
  "timestamp": "2026-05-22T01:55:00",
  "totals": {"worlds": 60, "packs": 65, "packs_with_audio": 63},
  "needs_pack":   ["<world_id>", ...],          // worlds with no bound pack
  "needs_audio":  [["<world_id>", "<pack>", <count>], ...],  // packs under 6 files
  "needs_cast":   ["<world_id>", ...],          // worlds with unportraited NPCs
  "needs_cover":  ["<world_id>", ...],          // worlds missing images.cover
  "npc_portrait_gaps": [["<world_id>", <missing>, <total>], ...],
  "complete": false
}
```

## Background context (only if needed)

Packs live at `public/audio/<pack>/` with `pack.json` (binding via `worldIds[]`) + `_themes.json` (theme -> short Freesound query) + per-theme MP3 dirs.  Sound discovery is automatic via `localSoundscape.ts` — just creating the right files + binding the world is enough; the WorldGen runtime picks them up.



