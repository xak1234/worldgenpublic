# WorldGen — single-instance container.
# All runtime state lives on one volume mounted at /srv/worldgen (see docker-entrypoint.sh).
#
#   docker build -t worldgen .
#   docker build -t worldgen --build-arg WITH_PYTHON=1 .   # + Python media/portrait pipelines

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts/precompile-public-html.mjs ./scripts/
COPY public/index.html ./public/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG WITH_PYTHON=0
WORKDIR /app

# Optional Python stack for the orchestrator / sound-pack / ArcFace portrait pipelines.
# Core play (worlds, NPC dialogue, quests) never needs it.
COPY scripts/requirements.txt /tmp/requirements.txt
# Shared location so the unprivileged runtime user can read the browsers.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN if [ "$WITH_PYTHON" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv libgl1 libglib2.0-0 \
      && python3 -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
      && /opt/py/bin/python -m playwright install --with-deps chromium \
      && rm -rf /var/lib/apt/lists/*; \
    fi
ENV PATH="/opt/py/bin:${PATH}"

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public/index.compiled.js ./public/index.compiled.js
COPY package.json ./
# tsx runs scripts/build-world.ts (which imports src/*.ts) for world builds.
COPY src ./src
COPY scripts ./scripts
COPY seeds ./seeds
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Strip CRLF in case the build context was checked out on Windows (core.autocrlf).
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3002 \
    WORLDGEN_STORAGE=/srv/worldgen \
    WORLDGEN_DATA_DIR=/srv/worldgen/data \
    WORLDGEN_WORLD_LOAD_BUDGET_MB=0 \
    WORLDGEN_HEAP_MB=2048
# TRUST_PROXY is deliberately not set here: only set it (usually 1) when a reverse proxy
# sits in front, otherwise clients could spoof X-Forwarded-For past the rate limits.
VOLUME ["/srv/worldgen"]
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
