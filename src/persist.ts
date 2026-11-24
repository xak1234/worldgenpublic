/**
 * Persistence layer — saves worlds and sessions to disk as JSON.
 *
 * Sessions can be 3+ MB; the /talk handler can fire saveSession() multiple
 * times per turn. We therefore debounce session writes (coalesce calls within
 * SAVE_DEBOUNCE_MS into a single disk write) and use write-temp + atomic
 * rename so a crash mid-write can never leave a half-truncated session file.
 *
 * For graceful shutdown, call flushPendingSaves() before exiting.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync, renameSync, statSync, openSync, readSync, closeSync } from 'fs';
import { promises as fsp } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// WORLDGEN_DATA_DIR overrides the default repo-relative ./data path. Use this on shared
// hosts (Render etc.) to point at a persistent disk mount (e.g. /var/data) so world JSON
// survives redeploys instead of vanishing on each cold start.
const envDataDir = (process.env.WORLDGEN_DATA_DIR ?? '').trim();
export const DATA_DIR = envDataDir
  ? (envDataDir.startsWith('/') || /^[A-Za-z]:/.test(envDataDir) ? envDataDir : join(__dirname, '..', envDataDir))
  : join(__dirname, '..', 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (envDataDir) console.log(`[worldgen] WORLDGEN_DATA_DIR active -> ${DATA_DIR}`);

/** Reject IDs that could escape the data directory (path traversal). */
function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

const SAVE_DEBOUNCE_MS = parseInt(process.env.WORLDGEN_SAVE_DEBOUNCE_MS ?? '1000', 10);
const TMP_FILE_RE = /\.tmp\.\d+(\.\d+)?$/;
const TMP_STALE_MS = parseInt(process.env.WORLDGEN_TMP_STALE_MS ?? '60000', 10);
const SAVE_RETRY_DELAYS_MS = [40, 100, 250, 500, 1000, 2000];
const SAVE_LOG_THROTTLE_MS = parseInt(process.env.WORLDGEN_SAVE_LOG_THROTTLE_MS ?? '2000', 10);
const pendingSaves = new Map<string, { timer: NodeJS.Timeout; data: any }>();
const lastWorldSaveHashes = new Map<string, string>();
const lastWorldSaveLogAt = new Map<string, number>();
let pendingGlobalPlayersSave: { timer: NodeJS.Timeout; players: Map<string, any> } | undefined;

function purgeStaleTempFiles(): void {
  const now = Date.now();
  let removed = 0;
  for (const f of readdirSync(DATA_DIR)) {
    if (!TMP_FILE_RE.test(f)) continue;
    const file = join(DATA_DIR, f);
    try {
      const ageMs = now - statSync(file).mtimeMs;
      if (ageMs < TMP_STALE_MS) continue;
      unlinkSync(file);
      removed += 1;
    } catch (err) {
      console.warn('[persist] could not clean temp file', f, String(err).slice(0, 200));
    }
  }
  if (removed > 0) console.log(`[persist] cleaned ${removed} stale temp files`);
}

function readJsonFile(file: string): any {
  return JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
}

function isRetriableFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function renameSyncWithRetry(tmp: string, file: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      if (!isRetriableFsError(err) || attempt >= SAVE_RETRY_DELAYS_MS.length) throw err;
      console.warn(`[persist] file locked, blocking event loop for ${SAVE_RETRY_DELAYS_MS[attempt]}ms (attempt ${attempt + 1}): ${file}`);
      sleepSync(SAVE_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function renameWithRetry(tmp: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (!isRetriableFsError(err) || attempt >= SAVE_RETRY_DELAYS_MS.length) throw err;
      await sleep(SAVE_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmp, contents);
  await renameWithRetry(tmp, file);
}

export function saveWorld(world: any) {
  if (!isSafeId(world.id)) throw new Error(`Invalid world ID: ${world.id}`);
  // Worlds are saved much less often than sessions — keep this synchronous
  // for the call-site contract, but use atomic write-temp + rename.
  const file = join(DATA_DIR, `world-${world.id}.json`);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const contents = JSON.stringify(world, null, 2);
  const hash = createHash('sha256').update(contents).digest('hex');
  if (lastWorldSaveHashes.get(world.id) === hash) return;
  writeFileSync(tmp, contents);
  // renameSync is atomic on POSIX and on Windows for files on the same volume.
  renameSyncWithRetry(tmp, file);
  lastWorldSaveHashes.set(world.id, hash);
  const lastLogAt = lastWorldSaveLogAt.get(world.id) ?? 0;
  const now = Date.now();
  if (SAVE_LOG_THROTTLE_MS <= 0 || now - lastLogAt >= SAVE_LOG_THROTTLE_MS) {
    lastWorldSaveLogAt.set(world.id, now);
    console.log('[persist] saved world', world.id);
  }
}

export function saveSession(session: any) {
  if (!session?.id) return;
  if (!isSafeId(session.id)) throw new Error(`Invalid session ID: ${session.id}`);
  const existing = pendingSaves.get(session.id);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingSaves.delete(session.id);
    const file = join(DATA_DIR, `session-${session.id}.json`);
    writeAtomic(file, JSON.stringify(session, null, 2)).catch(err =>
      console.error('[persist] saveSession failed', session.id, err),
    );
  }, SAVE_DEBOUNCE_MS);
  // Don't keep the event loop alive on this timer alone.
  if (typeof timer.unref === 'function') timer.unref();
  pendingSaves.set(session.id, { timer, data: session });
}

export function saveGlobalPlayers(players: Map<string, any>) {
  if (pendingGlobalPlayersSave) clearTimeout(pendingGlobalPlayersSave.timer);
  const timer = setTimeout(() => {
    const current = pendingGlobalPlayersSave?.players ?? players;
    pendingGlobalPlayersSave = undefined;
    writeGlobalPlayers(current);
  }, SAVE_DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  pendingGlobalPlayersSave = { timer, players };
}

function writeGlobalPlayers(players: Map<string, any>) {
  const file = join(DATA_DIR, 'players.json');
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const data = { players: Array.from(players.values()) };
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSyncWithRetry(tmp, file);
  console.log('[persist] saved global players', players.size);
}

/** Force any debounced saves to disk now. Call this before process exit. */
export async function flushPendingSaves(): Promise<void> {
  if (pendingGlobalPlayersSave) {
    clearTimeout(pendingGlobalPlayersSave.timer);
    writeGlobalPlayers(pendingGlobalPlayersSave.players);
    pendingGlobalPlayersSave = undefined;
  }
  const items = Array.from(pendingSaves.values());
  for (const { timer } of items) clearTimeout(timer);
  pendingSaves.clear();
  await Promise.all(items.map(async ({ data }) => {
    const file = join(DATA_DIR, `session-${data.id}.json`);
    try { await writeAtomic(file, JSON.stringify(data, null, 2)); }
    catch (err) { console.error('[persist] flush failed', data.id, err); }
  }));
}

export function getBackupStatus(worldId: string, sessionId?: string) {
  if (!isSafeId(worldId)) throw new Error(`Invalid world ID: ${worldId}`);
  if (sessionId && !isSafeId(sessionId)) throw new Error(`Invalid session ID: ${sessionId}`);
  const worldFile = join(DATA_DIR, `world-${worldId}.json`);
  const sessionFile = sessionId ? join(DATA_DIR, `session-${sessionId}.json`) : null;
  const worldSaved = existsSync(worldFile);
  const sessionSaved = sessionFile ? existsSync(sessionFile) : false;
  const worldSize = worldSaved ? statSync(worldFile).size : 0;
  const sessionSize = sessionSaved && sessionFile ? statSync(sessionFile).size : 0;
  const pending = sessionId ? pendingSaves.has(sessionId) : false;
  return { worldSaved, sessionSaved, worldSize, sessionSize, dataDir: DATA_DIR, pending };
}

/** Lightweight catalogue row for worlds that exist on disk but are not fully loaded (RAM budget). */
export interface WorldListStub {
  id: string;
  concept: string;
  createdAt?: string;
  provider?: string;
  name?: string;
  title?: string;
  era?: any;
  geography?: any;
  npcCount: number;
  locationCount: number;
  populationSize?: number;
  populationType?: string;
  realWorldBased?: boolean;
  realWorldFacts?: string;
  sourceDocuments?: any[];
  images?: { cover?: string; portraits?: Record<string, string>; swimwearPortraits?: Record<string, string>; scenes?: Record<string, string> };
  questPool?: any[];
  timeline?: any[];
  worldQuestAdventures?: any[];
  serializedAdventures?: any[];
  /** Just enough of each NPC/location to check its images without loading the whole world. */
  imageSubjects?: { npcs: any[]; locations: any[]; cover: Record<string, string> };
  deferredLoad: true;
}

// Image fields the UI reads, in its lookup order (npcPhotoUrl / locationPhotoUrl in public/index.html).
export const NPC_PORTRAIT_FIELDS = ['photoUrl', 'imageUrl', 'portraitUrl', 'avatarUrl', 'generatedImageUrl', 'generatedPortraitUrl', 'thumbnailUrl'] as const;
export const LOC_SCENE_FIELDS = ['photoUrl', 'imageUrl', 'sceneUrl', 'generatedImageUrl', 'thumbnailUrl'] as const;
const WORLD_COVER_FIELDS = ['photoUrl', 'imageUrl', 'coverImageUrl', 'coverPhotoUrl', 'thumbnailUrl', 'heroImageUrl', 'generatedImageUrl', 'worldImageUrl'] as const;

function pickFields(source: any, fields: readonly string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const field of fields) if (source?.[field] !== undefined) out[field] = source[field];
  return out;
}

function extractImageSubjects(w: any): WorldListStub['imageSubjects'] {
  return {
    npcs: (Array.isArray(w.npcs) ? w.npcs : []).map((n: any) => ({
      ...pickFields(n, ['id', 'name', 'age', 'gender', 'occupation', ...NPC_PORTRAIT_FIELDS]),
      physicalDescription: typeof n?.physicalDescription === 'string' ? n.physicalDescription.slice(0, 400) : n?.physicalDescription,
      images: n?.images ? pickFields(n.images, ['portrait', 'swimwear']) : undefined,
    })),
    locations: (Array.isArray(w.locations) ? w.locations : []).map((l: any) => pickFields(l, ['id', 'name', ...LOC_SCENE_FIELDS])),
    cover: pickFields(w, [...WORLD_COVER_FIELDS, 'portraits', 'npcPortraits', 'scenes', 'locationScenes', 'imageCache']),
  };
}

/** Worlds on disk that were not fully loaded at boot due to WORLDGEN_WORLD_LOAD_BUDGET_MB. */
export const worldStubs = new Map<string, WorldListStub>();

export function extractWorldListStub(w: any): WorldListStub | null {
  if (!w?.id || typeof w.id !== 'string') return null;
  const concept = String(w.concept ?? '').trim();
  return {
    id: w.id,
    concept: concept || w.id,
    createdAt: w.createdAt,
    provider: w.provider,
    name: w.name,
    title: w.title,
    era: w.era,
    geography: w.geography,
    npcCount: Array.isArray(w.npcs) ? w.npcs.length : 0,
    locationCount: Array.isArray(w.locations) ? w.locations.length : 0,
    populationSize: w.populationBlueprint?.totalPopulation,
    populationType: w.populationBlueprint?.communityType,
    realWorldBased: !!w.realWorldBased,
    realWorldFacts: w.realWorldFacts,
    sourceDocuments: w.sourceDocuments,
    images: w.images,
    questPool: w.questPool,
    timeline: w.timeline,
    worldQuestAdventures: w.worldQuestAdventures,
    serializedAdventures: w.serializedAdventures,
    imageSubjects: extractImageSubjects(w),
    deferredLoad: true,
  };
}

/** Load a world JSON from disk into the live map (on-demand for budget-deferred worlds). */
export function ensureWorldLoaded(worldId: string, worlds: Map<string, any>): any | null {
  const existing = worlds.get(worldId);
  if (existing) return existing;
  if (!isSafeId(worldId)) return null;
  const file = join(DATA_DIR, `world-${worldId}.json`);
  if (!existsSync(file)) return null;
  try {
    const w = readJsonFile(file);
    if (!w?.id) return null;
    worlds.set(w.id, w);
    worldStubs.delete(w.id);
    return w;
  } catch (err) {
    console.error('[persist] ensureWorldLoaded failed', worldId, String(err).slice(0, 200));
    return null;
  }
}

// Starter-world seed dir. On Render/free tier where DATA_DIR is ephemeral, this
// guarantees the deployed instance has a baseline catalogue of worlds even after
// container restarts. Worlds committed under seeds/data/ ship in the git build
// and are copied into DATA_DIR on startup if not already present (idempotent).
const SEEDS_DIR = join(__dirname, '..', 'seeds', 'data');

function seedFromSeeds(): void {
  if (!existsSync(SEEDS_DIR)) return;
  let seeded = 0;
  let skipped = 0;
  try {
    const seedFiles = readdirSync(SEEDS_DIR);
    for (const f of seedFiles) {
      if (!f.startsWith('world-') || !f.endsWith('.json')) continue;
      const dest = join(DATA_DIR, f);
      if (existsSync(dest)) { skipped += 1; continue; }
      try {
        writeFileSync(dest, readFileSync(join(SEEDS_DIR, f)));
        seeded += 1;
      } catch (err) {
        console.warn('[persist] seed copy failed for', f, String(err).slice(0, 200));
      }
    }
    if (seeded > 0) {
      console.log(`[persist] seeded ${seeded} worlds from seeds/data/ (${skipped} already present)`);
    }
  } catch (err) {
    console.warn('[persist] seedFromSeeds failed', String(err).slice(0, 200));
  }
}

/**
 * Boot-time session loading is budgeted. Local trees often ship multi-GB of
 * session-*.json (20MB+ each); parsing all of them OOMs Node's default ~400MB
 * heap — classic Render free/starter failure:
 *   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 *
 * Env knobs:
 *   WORLDGEN_LOAD_SESSIONS=0|1     master switch (default 1)
 *   WORLDGEN_MAX_SESSION_FILE_MB   skip any single session larger than this (default 4)
 *   WORLDGEN_SESSION_LOAD_BUDGET_MB total disk bytes to load, newest first (default 48)
 */
function sessionLoadConfig(): { enabled: boolean; maxFileBytes: number; budgetBytes: number } {
  const enabled = (process.env.WORLDGEN_LOAD_SESSIONS ?? '1').trim() !== '0';
  const maxFileMb = Number(process.env.WORLDGEN_MAX_SESSION_FILE_MB ?? '4');
  const budgetMb = Number(process.env.WORLDGEN_SESSION_LOAD_BUDGET_MB ?? '48');
  return {
    enabled,
    maxFileBytes: (Number.isFinite(maxFileMb) && maxFileMb > 0 ? maxFileMb : 4) * 1024 * 1024,
    budgetBytes: (Number.isFinite(budgetMb) && budgetMb > 0 ? budgetMb : 48) * 1024 * 1024,
  };
}

/**
 * World load budget — worlds are loaded newest-first by mtime, subject to an
 * on-disk byte budget. Tune via env:
 *   WORLDGEN_WORLD_LOAD_BUDGET_MB  max total on-disk MB to load (default 32)
 *                                   set to 0 to load all worlds (no budget)
 */
function worldLoadConfig(): { budgetBytes: number; unlimited: boolean } {
  const budgetMb = Number(process.env.WORLDGEN_WORLD_LOAD_BUDGET_MB ?? '32');
  if (budgetMb === 0) return { budgetBytes: 0, unlimited: true };
  return {
    budgetBytes: (Number.isFinite(budgetMb) && budgetMb > 0 ? budgetMb : 32) * 1024 * 1024,
    unlimited: false,
  };
}

/** Load one session from disk by id (on-demand). Returns null if missing/corrupt/unsafe. */
export function loadSessionById(sessionId: string): any | null {
  if (!isSafeId(sessionId)) return null;
  const file = join(DATA_DIR, `session-${sessionId}.json`);
  if (!existsSync(file)) return null;
  try {
    const s = readJsonFile(file);
    return s?.id ? s : null;
  } catch (err) {
    console.error('[persist] loadSessionById failed', sessionId, String(err).slice(0, 200));
    return null;
  }
}

/** Catalogue row for sessions on disk that were not loaded at boot (size/budget caps). */
export interface SessionStub {
  id: string;
  worldId?: string;
  globalPlayerId?: string;
}

/** Sessions on disk that were skipped at boot; loaded on demand via ensureSessionLoaded. */
export const sessionStubs = new Map<string, SessionStub>();

// Sessions are written with JSON.stringify(session, null, 2), so top-level keys sit at
// exactly two spaces of indent and id/worldId/globalPlayerId are written first. Reading
// the head of the file avoids parsing 20MB+ sessions just to index them.
function readSessionStub(file: string): SessionStub | null {
  let head = '';
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf-8', 0, n).replace(/^﻿/, '');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const field = (key: string) => new RegExp(`^  "${key}": "([^"]*)"`, 'm').exec(head)?.[1];
  // Files not written by saveSession (other formatting) still get indexed by filename.
  const id = field('id') ?? /session-([A-Za-z0-9_-]+)\.json$/.exec(file)?.[1];
  if (!id || !isSafeId(id)) return null;
  return { id, worldId: field('worldId'), globalPlayerId: field('globalPlayerId') };
}

/** Load a boot-skipped session (and its world) into the live maps. */
export function ensureSessionLoaded(sessionId: string, sessions: Map<string, any>, worlds?: Map<string, any>): any | null {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  if (!sessionStubs.has(sessionId)) return null;
  const s = loadSessionById(sessionId);
  if (!s) return null;
  sessions.set(s.id, s);
  sessionStubs.delete(s.id);
  if (worlds && s.worldId) ensureWorldLoaded(s.worldId, worlds);
  return s;
}

/** Load every boot-skipped session matching the predicate (e.g. all sessions of a world). */
export function ensureSessionsLoadedWhere(predicate: (stub: SessionStub) => boolean, sessions: Map<string, any>, worlds?: Map<string, any>): number {
  let loaded = 0;
  for (const stub of Array.from(sessionStubs.values())) {
    if (predicate(stub) && ensureSessionLoaded(stub.id, sessions, worlds)) loaded += 1;
  }
  return loaded;
}

export function loadAllData(worlds: Map<string, any>, sessions: Map<string, any>, players?: Map<string, any>) {
  worldStubs.clear();
  sessionStubs.clear();
  let files: string[];
  try {
    purgeStaleTempFiles();
    seedFromSeeds();
    files = readdirSync(DATA_DIR);
  } catch (e) {
    console.warn('[persist] data dir not readable on first run', e);
    return;
  }

  const worldCfg = worldLoadConfig();
  const sessionCfg = sessionLoadConfig();
  let corrupt = 0;
  let worldsSkippedBudget = 0;
  let worldBytesLoaded = 0;
  let sessionsSkippedLarge = 0;
  let sessionsSkippedBudget = 0;
  let sessionsSkippedDisabled = 0;
  let sessionBytesLoaded = 0;

  // Load players first (small), then worlds under a budget (newest first).
  // Worlds on disk are ~120 MB across 98 files — parsed into JS objects that
  // explodes to 600+ MB RSS, blowing up free-tier Render containers.  Budget
  // caps total on-disk bytes loaded so the process stays within its RAM limit.
  for (const f of files) {
    if (f.endsWith('.tmp') || TMP_FILE_RE.test(f)) continue;
    try {
      if (players && f === 'players.json') {
        const data = readJsonFile(join(DATA_DIR, f));
        for (const player of data.players ?? []) {
          if (player?.id) players.set(player.id, player);
        }
      }
    } catch (err) {
      corrupt += 1;
      console.error('[persist] could not load', f, '— skipping', String(err).slice(0, 200));
    }
  }

  // Worlds: collect stat info, sort newest-first, load under budget
  const worldFiles = files
    .filter(f => f.startsWith('world-') && f.endsWith('.json') && !TMP_FILE_RE.test(f))
    .map(f => {
      const file = join(DATA_DIR, f);
      try {
        const st = statSync(file);
        return { f, file, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { f: string; file: string; size: number; mtimeMs: number } => !!x)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { f, file, size } of worldFiles) {
    if (!worldCfg.unlimited && worldBytesLoaded + size > worldCfg.budgetBytes) {
      worldsSkippedBudget += 1;
      try {
        const stub = extractWorldListStub(readJsonFile(file));
        if (stub) worldStubs.set(stub.id, stub);
      } catch (err) {
        corrupt += 1;
        console.error('[persist] could not index', f, '— skipping', String(err).slice(0, 200));
      }
      continue;
    }
    try {
      const w = readJsonFile(file);
      if (w?.id) {
        worlds.set(w.id, w);
        worldBytesLoaded += size;
      }
    } catch (err) {
      corrupt += 1;
      console.error('[persist] could not load', f, '— skipping', String(err).slice(0, 200));
    }
  }

  const indexSkippedSession = (file: string) => {
    const stub = readSessionStub(file);
    if (stub) sessionStubs.set(stub.id, stub);
  };
  if (!sessionCfg.enabled) {
    const skipped = files.filter(f => f.startsWith('session-') && f.endsWith('.json') && !TMP_FILE_RE.test(f));
    sessionsSkippedDisabled = skipped.length;
    for (const f of skipped) indexSkippedSession(join(DATA_DIR, f));
  } else {
    const sessionFiles = files
      .filter(f => f.startsWith('session-') && f.endsWith('.json') && !TMP_FILE_RE.test(f))
      .map(f => {
        const file = join(DATA_DIR, f);
        try {
          const st = statSync(file);
          return { f, file, size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { f: string; file: string; size: number; mtimeMs: number } => !!x)
      // Newest first so recent play stays in memory under the budget.
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const { f, file, size } of sessionFiles) {
      if (size > sessionCfg.maxFileBytes) {
        sessionsSkippedLarge += 1;
        indexSkippedSession(file);
        continue;
      }
      if (sessionBytesLoaded + size > sessionCfg.budgetBytes) {
        sessionsSkippedBudget += 1;
        indexSkippedSession(file);
        continue;
      }
      try {
        const s = readJsonFile(file);
        if (s?.id) {
          sessions.set(s.id, s);
          sessionBytesLoaded += size;
        }
      } catch (err) {
        corrupt += 1;
        console.error('[persist] could not load', f, '— skipping', String(err).slice(0, 200));
      }
    }
  }

  const skipParts: string[] = [];
  if (worldsSkippedBudget > 0) skipParts.push(`${worldsSkippedBudget} worlds deferred (${worldStubs.size} indexed for selector, load on open)`);
  if (sessionsSkippedDisabled > 0) skipParts.push(`${sessionsSkippedDisabled} sessions skipped (WORLDGEN_LOAD_SESSIONS=0)`);
  if (sessionsSkippedLarge > 0) skipParts.push(`${sessionsSkippedLarge} sessions >${(sessionCfg.maxFileBytes / 1024 / 1024).toFixed(0)}MB skipped`);
  if (sessionsSkippedBudget > 0) skipParts.push(`${sessionsSkippedBudget} sessions over ${(sessionCfg.budgetBytes / 1024 / 1024).toFixed(0)}MB budget skipped`);
  if (corrupt > 0) skipParts.push(`${corrupt} corrupt files skipped`);

  console.log(
    `[persist] loaded ${worlds.size} worlds` +
    (worldBytesLoaded > 0 ? ` (${(worldBytesLoaded / 1024 / 1024).toFixed(1)}MB world files)` : '') +
    `, ${sessions.size} sessions` +
    (sessionBytesLoaded > 0 ? ` (${(sessionBytesLoaded / 1024 / 1024).toFixed(1)}MB session files)` : '') +
    (players ? `, ${players.size} players` : '') +
    (skipParts.length ? ` — ${skipParts.join('; ')}` : ''),
  );
}

export function listSavedWorlds(): Array<{id: string, file: string, size: number}> {
  try {
    return readdirSync(DATA_DIR)
      .filter(f => f.startsWith('world-') && f.endsWith('.json'))
      .map(f => ({
        id: f.replace('world-', '').replace('.json', ''),
        file: f,
        size: statSync(join(DATA_DIR, f)).size,
      }));
  } catch { return []; }
}

export async function deleteWorldFiles(worldId: string): Promise<{ worldDeleted: boolean; sessionsDeleted: number }> {
  if (!isSafeId(worldId)) throw new Error(`Invalid world ID: ${worldId}`);
  const worldFile = join(DATA_DIR, `world-${worldId}.json`);
  const generatedDir = join(__dirname, '..', 'public', 'generated', worldId);
  let worldDeleted = false;
  let sessionsDeleted = 0;

  if (existsSync(worldFile)) {
    await fsp.unlink(worldFile);
    worldDeleted = true;
  }
  if (existsSync(generatedDir)) {
    await fsp.rm(generatedDir, { recursive: true, force: true });
  }

  try {
    const files = await fsp.readdir(DATA_DIR);
    const results = await Promise.allSettled(files.map(async (f) => {
      if (!f.startsWith('session-') || !f.endsWith('.json')) return;
      const sessionFile = join(DATA_DIR, f);
      const raw = await fsp.readFile(sessionFile, 'utf-8');
      let session: any;
      try { session = JSON.parse(raw.replace(/^﻿/, '')); } catch { return; }
      if (session.worldId === worldId) {
        await fsp.unlink(sessionFile);
        sessionsDeleted += 1;
      }
    }));
    for (const r of results) {
      if (r.status === 'rejected') console.error('[persist] session delete failed:', r.reason);
    }
  } catch (err) {
    console.error('[persist] failed deleting sessions for world', worldId, err);
  }

  worldStubs.delete(worldId);
  return { worldDeleted, sessionsDeleted };
}

export function deleteSessionFile(sessionId: string): boolean {
  if (!isSafeId(sessionId)) throw new Error(`Invalid session ID: ${sessionId}`);
  const pending = pendingSaves.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSaves.delete(sessionId);
  }

  const sessionFile = join(DATA_DIR, `session-${sessionId}.json`);
  sessionStubs.delete(sessionId);
  if (!existsSync(sessionFile)) return false;

  unlinkSync(sessionFile);
  return true;
}

/**
 * Move a session file into DATA_DIR/_orphaned/ instead of deleting it. Used by the
 * automatic integrity sweep, which must never destroy play state on a heuristic.
 */
export function quarantineSessionFile(sessionId: string): boolean {
  if (!isSafeId(sessionId)) throw new Error(`Invalid session ID: ${sessionId}`);
  const pending = pendingSaves.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSaves.delete(sessionId);
  }
  sessionStubs.delete(sessionId);
  const sessionFile = join(DATA_DIR, `session-${sessionId}.json`);
  if (!existsSync(sessionFile)) return false;
  const dir = join(DATA_DIR, '_orphaned');
  mkdirSync(dir, { recursive: true });
  renameSyncWithRetry(sessionFile, join(dir, `session-${sessionId}.json`));
  return true;
}

/** True when a world file exists on disk, whether or not it is loaded in memory. */
export function worldFileExists(worldId: string): boolean {
  return isSafeId(worldId) && existsSync(join(DATA_DIR, `world-${worldId}.json`));
}
