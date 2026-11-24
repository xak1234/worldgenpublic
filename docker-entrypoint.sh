#!/bin/sh
# Lays out the persistent volume and points the app's runtime folders at it, then
# drops root and starts the server.
#
# Volume layout ($WORLDGEN_STORAGE, default /srv/worldgen):
#   data/       worlds, sessions, players.json, debug dumps   -> /app/data (WORLDGEN_DATA_DIR)
#   generated/  portraits, covers, scenes, image cache        -> /app/public/generated
#   uploads/    source scripts / PDFs for script-based worlds -> /app/public/uploads
#   state/      media orchestrator flags                      -> /app/state
#   logs/       Python pipeline logs                          (WORLDGEN_LOG_DIR)
#   audio/      sound packs (optional; pack.json + mp3s)      -> /app/public/audio
set -e

STORAGE="${WORLDGEN_STORAGE:-/srv/worldgen}"
mkdir -p "$STORAGE/data" "$STORAGE/generated" "$STORAGE/uploads" "$STORAGE/state" "$STORAGE/logs"

link_dir() { # link_dir <volume dir> <app path>
  rm -rf "$2"
  ln -s "$1" "$2"
}
# /app/data too: offline scripts (check-world-data, media orchestrator) assume <repo>/data.
link_dir "$STORAGE/data" /app/data
link_dir "$STORAGE/generated" /app/public/generated
link_dir "$STORAGE/uploads" /app/public/uploads
link_dir "$STORAGE/state" /app/state
# Sound packs are optional and large. Without them the image's pack manifests stay in
# place and soundscapes fall back to Freesound (SOMA_API) or silence.
if [ -d "$STORAGE/audio" ] && [ -n "$(ls -A "$STORAGE/audio" 2>/dev/null)" ]; then
  link_dir "$STORAGE/audio" /app/public/audio
fi

export WORLDGEN_DATA_DIR="${WORLDGEN_DATA_DIR:-$STORAGE/data}"
export WORLDGEN_LOG_DIR="${WORLDGEN_LOG_DIR:-$STORAGE/logs}"

# Heap limit for the server process only (NODE_OPTIONS would also hand it to every
# world-build child process).
if [ "$1" = "node" ]; then
  shift
  set -- node "--max-old-space-size=${WORLDGEN_HEAP_MB:-2048}" "$@"
fi

if [ "$(id -u)" = "0" ]; then
  # Only touch what is not already owned by node; a full chown -R of a large volume
  # would slow every start.
  find "$STORAGE" ! -user node -exec chown -h node:node {} + 2>/dev/null || true
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
