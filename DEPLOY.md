# Deploying WorldGen

WorldGen runs as **one Node process with one persistent volume**. All worlds, sessions
and players are held in memory and written to JSON files on that volume, so never run
more than one instance against the same data.

## What runs where

| Piece | Where it lives | Notes |
|---|---|---|
| Server | Docker image (`Dockerfile`) | `dist/` + `src/` + `scripts/` (world builds spawn `tsx scripts/build-world.ts`) |
| Worlds, sessions, `players.json` | `$WORLDGEN_STORAGE/data` | `WORLDGEN_DATA_DIR` |
| Generated images | `$WORLDGEN_STORAGE/generated` | symlinked to `public/generated` |
| Uploaded scripts / PDFs | `$WORLDGEN_STORAGE/uploads` | symlinked to `public/uploads`, not publicly served |
| Orchestrator flags | `$WORLDGEN_STORAGE/state` | symlinked to `state/` |
| Sound packs (optional, ~15 GB) | `$WORLDGEN_STORAGE/audio` | symlinked to `public/audio` when present |
| Python pipelines (optional) | image built with `WITH_PYTHON=1` | portrait ArcFace, sound packs, media orchestrator |

`docker-entrypoint.sh` creates the layout and the symlinks on every start.

## Required configuration

- `WORLDGEN_API_KEY`: the admin key. The server refuses to start in production without it.
  Enter it once in the hub (it prompts on the first 401) to build worlds and run pipelines.
- At least one LLM key: `MISTRAL_API_KEY`, `CEREBRAS_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `NVIDIA_API_KEY` or the relay.
- For building worlds from scripts: `DEEPSEEK_API_KEY` (digest) and `TMDB_API_KEY` (cast + covers).
- `CORS_ORIGINS`: any extra origins. The site's own origin is always allowed for WebSockets.
- `TRUST_PROXY=1` only when a reverse proxy (Render, nginx, Caddy) sits in front; `render.yaml` sets it.
  Without a proxy, leave it unset or clients can spoof their IP past the rate limits.

See `.env.example` for every variable.

### Who can do what

| Caller | Can |
|---|---|
| Admin key (`x-api-key`) | Everything: build/import worlds, uploads, image + portrait pipelines, deletes, kill-all |
| Signed-in player (id + PIN headers) | Play their own sessions: talk, act, move, wait, tick, quests, adventures, TTS |
| Anyone | Read worlds and the public player list (no PINs); create a character only if `WORLDGEN_PUBLIC_SIGNUP=true` |

Eight wrong PINs from one client lock that character for that client for 15 minutes (requests
without a PIN never count). New player ids no longer contain the PIN. Legacy `pin123_…` ids
reveal their PIN, so on a keyed instance they cannot sign in until the admin sets a new one:
`PATCH /api/players/:id` with the `x-api-key` header and body `{ "newPin": "456" }`.

## Option A: Docker Compose (VPS or home server)

```sh
cp .env.example .env                          # add WORLDGEN_API_KEY and your LLM keys
node scripts/prepare-storage.mjs ./storage    # copy existing worlds/sessions/images (add --with-audio for packs)
docker compose up -d --build
curl http://localhost:3002/health
```

Put a TLS proxy (Caddy, nginx, Cloudflare Tunnel) in front of port 3002.

## Option B: Render

`render.yaml` defines a Docker web service with a 20 GB disk at `/srv/worldgen`. A service with a
disk always runs as a single instance, which is what this app needs.

1. Create the Blueprint from the repo. Render generates `WORLDGEN_API_KEY`; fill in the `sync: false` keys.
2. Use at least the **standard** plan (2 GB). 512 MB is not enough for the world library.
3. Load worlds onto the disk. Export `WORLDGEN_REMOTE` (the site URL) and `WORLDGEN_API_KEY`
   (the generated admin key) in your shell, then run:
   ```sh
   node scripts/sync-worlds-to-render.mjs
   ```
   Sessions, players and images can be copied with Render's SSH/`scp` into `/srv/worldgen`
   using the layout produced by `prepare-storage.mjs`.

## Memory and loading

- `WORLDGEN_HEAP_MB` (default 2048) sets the Node heap. Size the host at heap + 512 MB.
- `WORLDGEN_WORLD_LOAD_BUDGET_MB=0` loads every world at boot (the image default).
- Sessions over `WORLDGEN_MAX_SESSION_FILE_MB`, or past `WORLDGEN_SESSION_LOAD_BUDGET_MB`, are indexed at
  boot and loaded the first time they are used.
- On startup the server keeps only the newest N entries in `failed-json`, `dialogue-debug`,
  `.build-checkpoints` and the image-proxy cache (`WORLDGEN_KEEP_*`).
- The integrity sweep never deletes sessions. A session whose world file is gone moves to
  `data/_orphaned/`.

## Verify a build

```sh
npm test               # unit checks
npm run test:deploy    # boots the server on a temp data dir and checks auth, SSRF, persistence
docker build -t worldgen .
# keys are passed through from your shell environment
docker run --rm -p 3002:3002 -e WORLDGEN_API_KEY -e MISTRAL_API_KEY -v "$PWD/storage:/srv/worldgen" worldgen
```

## Limits that remain

- Single instance only (in-memory state, whole-file JSON writes). Scaling out needs a database.
- Every player action rewrites the whole world file synchronously; very large worlds slow the event loop.
- Sessions in a quest embed full copies of 2–5 forked worlds, so they can grow to 20 MB+.
