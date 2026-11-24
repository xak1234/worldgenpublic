/**
 * WorldGen Server
 */

import 'dotenv/config';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve as pathResolve, posix as posixPath } from 'path';
import { spawn } from 'child_process';

// Force-honour empty values in .env. dotenv refuses to override existing process.env
// values, which means a system-level ANTHROPIC_API_KEY (User/Machine env) leaks through
// even when .env says `ANTHROPIC_API_KEY=`. Walk the .env file and explicitly delete any
// process.env entry that .env declares as empty.
(() => {
  try {
    const envPath = pathResolve(process.cwd(), '.env');
    if (!existsSync(envPath)) return;
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, key, raw] = m;
      const value = raw.trim();
      if (value === '' || value === '""' || value === "''") {
        delete process.env[key];
      }
    }
  } catch {
    /* non-fatal: best-effort env-override */
  }
})();
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { inflateSync } from 'zlib';
import { generateWorld, type GenerationProgress } from './worldGenerator.js';
import { generateDialogue, buildMemory } from './dialogue.js';
import { deriveVoiceProfile, extractSpokenTtsText, getVoiceConfig, isMistralTtsGuardrailError, selectVoxVoice, synthesizeSpeech, ttsAvailable } from './voice.js';
import { generateNarrative } from './narrative.js';
import { runSocialTick } from './socialEngine.js';
import { deriveResourceProfile } from './resourceEngine.js';
import { advanceWeather, controlledWeather, describeWeather, initialWeather, weatherWorldEffects } from './weatherEngine.js';
import { availableProviderInfo, availableProviders, llmJSON } from './llm.js';
import { detectPromise, detectPatterns } from './memory.js';
import { blendAffect, createDefaultInnerLife, normalizeInnerLife } from './innerLife.js';
import { runPostEventProcessing, runCognitiveTick, runDreamProcessing } from './cognitiveTick.js';
import { makeNPCDecision, simulateNPCConversation, simulateGroupConversation } from './agency.js';
import { deriveDramaLeads, summarizeInteractionConsequences, summarizeWorldAdvance } from './drama.js';
import { DATA_DIR, saveWorld, saveSession, saveGlobalPlayers, loadAllData, getBackupStatus, listSavedWorlds, deleteWorldFiles, deleteSessionFile, flushPendingSaves, worldStubs, ensureWorldLoaded, sessionStubs, ensureSessionLoaded, ensureSessionsLoadedWhere, quarantineSessionFile, worldFileExists, type SessionStub, type WorldListStub, NPC_PORTRAIT_FIELDS, LOC_SCENE_FIELDS } from './persist.js';
import { applyCastImagesToWorld } from './castLookup.js';
import { parsePipelineResult, applyPipelineResult, PIPELINE_RESULT_SENTINEL, type PipelineResult } from './portraitPipeline.js';
import { resolveCover } from './coverResolver.js';
import { buildSourceDigest } from './sourceDigest.js';
import { fuzzyContainsPhrase } from './fuzzyMatch.js';
import type { DramaLead, GlobalPlayerProfile, GossipItem, NPCMemory, PersistentNpcCharacterState, PersistentNpcSharedState, PersistentPlayerProfile, PlayerPresence, QuestAchievement, QuestDiscoveryHook, QuestEcho, QuestFact, QuestInvitation, QuestMedal, QuestParticipantLocation, QuestParticipantReturn, QuestRequirement, QuestSessionState, QuestTier, QuestType, SoundscapeManifest, WorldDNA, WorldQuestAdventure, WorldQuestSeed, WorldQuestSourceType, WorldQuestStep, WorldSession, WorldSourceDocument, NPCLiveState, WorldNPC, SerializedAdventure, SerializedAdventureJoinRequest } from './types.js';
import { generateImage, generateWorldImages, saveDataUrlImage, getImageGenProvidersState, getImageGenSlotState, imageGenerationDisabled } from './imageGen.js';
import { generateSoundscape, isSomaEnabled } from './freesound.js';
import { hasMatchingAudioPack } from './localSoundscape.js';
import { addDays, formatWorldDate, parseWorldDate } from './worldDate.js';
import {
  abandonQuestEpisode,
  activateQuestEpisode,
  advanceQuestEpisode,
  deriveQuestLeads,
  describeQuestForDialogue,
  ensureQuestDiscoveryHook,
  getQuestStatus,
  missingQuestRequirements,
  questRequiredWorldCount,
  refreshQuestPortalGates,
  travelQuestPortal,
} from './questEpisode.js';
import {
  interpretPlayerInteraction,
  parsePlayerInteractionRequest,
  shouldApplyPlayerIntentInterpretation,
} from './playerIntent.js';
import {
  generateSerializedAdventure,
  startSerializedAdventure,
  abandonSerializedAdventure,
  advanceSerializedAdventure as advanceSerializedAdventureHook,
  hasActiveSerializedAdventure,
  getActiveBeat,
  calculateSpectrumScore,
  spectrumTierLabel,
} from './serializedAdventure.js';
import {
  advanceAllCognition,
  applyPostEventCognition,
  attachMemoryToObjectiveEvent,
  createBeliefContagion,
  ensureCognitionState,
  getRealityGapMetric,
  recordObjectiveEvent,
  createWitnessMemory,
  detectLoyaltyConflicts,
  compareMemories,
} from './cognition.js';
import { randomUUID } from 'crypto';
import { createHash, timingSafeEqual } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import rateLimit from 'express-rate-limit';

const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3001', 'http://localhost:3002'];

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const app = express();
// Behind Render / nginx / Caddy every request arrives from the proxy's IP. Set
// TRUST_PROXY to the hop count (usually 1) so rate limits key on the real client.
const TRUST_PROXY = (process.env.TRUST_PROXY ?? '').trim();
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY === 'true' ? true : TRUST_PROXY);
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://image.pollinations.ai", "https://*.freesound.org"],
      mediaSrc: ["'self'", "data:", "blob:", "https://*.freesound.org"],
      connectSrc: ["'self'", "ws:", "wss:"],
      upgradeInsecureRequests: null,
    },
  },
}));
// Check the admin key before buffering a 100-256 MB body.
app.use('/api/worlds/source-upload', requireApiKey, express.json({ limit: '100mb' }));
app.use('/api/admin/import-worlds', requireApiKey, express.json({ limit: '256mb' }));
app.use(express.json({ limit: '2mb' }));
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const parseErr = err as { type?: string; status?: number; message?: string } | null;
  if (parseErr?.type === 'entity.parse.failed' || (err instanceof SyntaxError && parseErr?.status === 400)) {
    res.status(400).json({
      error: 'Invalid JSON request body',
      detail: parseErr?.message ?? 'Request body could not be parsed as JSON',
    });
    return;
  }
  next(err);
});

function isUnsafeProxyImageUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /(?:^|\/)api\/img(?:\?|$)|(?:^|\/)img\?p=/i.test(value);
}

function stripUnsafeProxyImageUrls(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === 'string') return isUnsafeProxyImageUrl(value) ? '' : value;
  if (!value || typeof value !== 'object') return value;
  const cached = seen.get(value);
  if (cached) return cached;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) copy[i] = stripUnsafeProxyImageUrls(value[i], seen);
    return copy;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = stripUnsafeProxyImageUrls(child, seen);
  }
  return copy;
}

app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = ((body: unknown) => json(stripUnsafeProxyImageUrls(body))) as typeof res.json;
  next();
});

const API_KEY = process.env.WORLDGEN_API_KEY;
if (IS_PRODUCTION && !API_KEY) {
  console.error('[worldgen] NODE_ENV=production requires WORLDGEN_API_KEY — refusing to start with an open admin API.');
  process.exit(1);
}
if (!API_KEY) console.warn('[worldgen] WORLDGEN_API_KEY is not set — admin and gameplay routes are unauthenticated (dev mode).');

function hasValidApiKey(req: express.Request): boolean {
  if (!API_KEY) return true;
  const provided = requestString(req.headers['x-api-key']);
  const a = Buffer.from(provided);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (hasValidApiKey(req)) return next();
  res.status(401).json({ error: 'Invalid or missing API key' });
}

// Gameplay routes: the admin key OR a signed-in player (id + PIN headers). Each route
// still runs requireSessionPlayerAuth to check the player owns the session.
function requirePlayerOrApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (hasValidApiKey(req)) return next();
  if (requireAnySignedInPlayer(req, res)) return next();
}

// Demo / shared-instance toggle: when DISABLE_DESTRUCTIVE_WRITES=true, every wired
// destructive route returns 403. Used for the public Render instance where friends
// test but should not be able to delete worlds, sessions, players, quests, or reset
// baselines. Read endpoints + build/talk endpoints are unaffected.
const WRITES_DISABLED = String(process.env.DISABLE_DESTRUCTIVE_WRITES ?? '').toLowerCase() === 'true';
function blockDestructiveWrites(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!WRITES_DISABLED) return next();
  res.status(403).json({ error: 'Destructive operations are disabled on this instance (demo/shared mode).' });
}
if (WRITES_DISABLED) console.log('[worldgen] DISABLE_DESTRUCTIVE_WRITES=true - delete/reset/baseline endpoints will 403');

function requestString(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

function requireSessionPlayerAuth(req: express.Request, res: express.Response, session: WorldSession): boolean {
  if (!session.globalPlayerId) return true;
  const playerId = requestString(req.headers['x-global-player-id'] ?? req.body?.globalPlayerId ?? req.query.globalPlayerId ?? req.query.playerId).trim();
  const pin = requestString(req.headers['x-global-player-pin'] ?? req.body?.pin ?? req.query.pin).trim();
  if (playerId !== session.globalPlayerId) {
    res.status(403).json({ error: 'This session belongs to a different signed-in character' });
    return false;
  }
  const player = globalPlayers.get(session.globalPlayerId);
  if (!verifyGlobalPlayerPin(player, pin, pinContext(req, res))) {
    res.status(403).json({ error: 'Character sign-in has expired or is invalid' });
    return false;
  }
  return true;
}

function skipGlobalRateLimit(req: express.Request): boolean {
  return (
    (req.method === 'POST' && /^\/worlds\/[^/]+\/sessions$/.test(req.path)) ||
    /^\/pack-builder\/(?:packs|status|run)$/.test(req.path) ||
    /^\/worlds\/[^/]+\/pack$/.test(req.path)
  );
}

const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipGlobalRateLimit,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many requests, slow down',
      detail: 'The local API rate limit was hit. Wait a minute and try again.',
    });
  },
});
const llmLimiter = rateLimit({ windowMs: 60_000, max: 15, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, slow down' } });
app.use('/api/', globalLimiter);

// ── Orchestrator activity tracker (live "what is the server doing right now") ──
type OrchActivityKind = 'cast-rematch' | 'regen-portraits' | 'images' | 'portraits-bulk' | 'arcface-portraits';
interface OrchActivityEvent {
  id: string;
  kind: OrchActivityKind;
  worldId: string;
  worldName: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: 'running' | 'ok' | 'error';
  detail?: string;
}
const _orchActivity: OrchActivityEvent[] = [];
const ORCH_ACTIVITY_LIMIT = 50;
function _orchWorldName(worldId: string): string {
  try {
    const w = worlds.get(worldId);
    const c = (w as any)?.concept;
    if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 80);
  } catch {}
  return worldId;
}
function _orchStart(kind: OrchActivityKind, worldId: string): OrchActivityEvent {
  const ev: OrchActivityEvent = {
    id: randomUUID(),
    kind,
    worldId,
    worldName: _orchWorldName(worldId),
    startedAt: Date.now(),
    status: 'running',
  };
  _orchActivity.unshift(ev);
  while (_orchActivity.length > ORCH_ACTIVITY_LIMIT) _orchActivity.pop();
  return ev;
}
function _orchEnd(ev: OrchActivityEvent, status: 'ok' | 'error', detail?: string) {
  ev.status = status;
  ev.endedAt = Date.now();
  ev.durationMs = ev.endedAt - ev.startedAt;
  if (detail) ev.detail = String(detail).slice(0, 240);
}
const _ORCH_ROUTES: { rx: RegExp; kind: OrchActivityKind }[] = [
  { rx: /^\/api\/worlds\/([^/?#]+)\/cast-rematch$/, kind: 'cast-rematch' },
  { rx: /^\/api\/worlds\/([^/?#]+)\/regen-portraits$/, kind: 'regen-portraits' },
  { rx: /^\/api\/worlds\/([^/?#]+)\/images$/, kind: 'images' },
  { rx: /^\/api\/worlds\/([^/?#]+)\/portraits\/bulk$/, kind: 'portraits-bulk' },
  { rx: /^\/api\/worlds\/([^/?#]+)\/portrait-pipeline$/, kind: 'arcface-portraits' },
];
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  let matched: { ev: OrchActivityEvent } | null = null;
  for (const { rx, kind } of _ORCH_ROUTES) {
    const m = rx.exec(req.path);
    if (m) { matched = { ev: _orchStart(kind, m[1]) }; break; }
  }
  if (!matched) return next();
  const ev = matched.ev;
  let settled = false;
  res.on('finish', () => {
    if (settled) return;
    settled = true;
    const ok = res.statusCode >= 200 && res.statusCode < 400;
    _orchEnd(ev, ok ? 'ok' : 'error', ok ? undefined : `HTTP ${res.statusCode}`);
  });
  res.on('close', () => {
    if (settled) return;
    settled = true;
    _orchEnd(ev, 'error', 'client disconnected');
  });
  next();
});

// Auth + stricter rate limit on destructive / LLM-calling POST routes.
// Registered via app.post/delete (exact match) — NOT app.use (prefix match) —
// so read-only GETs like /api/sessions/:id/full are never blocked.
// Admin-only: world building, media pipelines, uploads, maintenance. These spawn
// processes, fetch remote URLs, write files or spend LLM/image credits in bulk.
const authRoutes = [
  '/api/worlds/build',
  '/api/worlds',
  '/api/worlds/refresh',
  '/api/worlds/:id/world-quests/generate',
  '/api/worlds/:id/world-quests/source-documents',
  '/api/worlds/:id/world-quests/cleanup',
  '/api/worlds/:id/serialized-adventures/generate',
  '/api/worlds/source-fetch-url',
  '/api/worlds/source-upload',
  '/api/worlds/:id/npc/:npcId/portrait',
  '/api/worlds/:id/portraits/bulk',
  '/api/worlds/:id/npc/:npcId/portrait-url',
  '/api/worlds/:id/source-digest',
  '/api/worlds/:id/cast-rematch',
  '/api/worlds/:id/regen-portraits',
  '/api/worlds/:id/portrait-pipeline',
  '/api/worlds/:id/images',
  '/api/worlds/:id/rebuild-timeline',
  '/api/orchestrator/run',
  '/api/orchestrator/cron',
  '/api/pack-builder/run',
  '/api/backup/save',
  '/api/players/:playerId/quests/kill-all',
  '/api/quests/kill-all',
];
for (const p of authRoutes) app.post(p, requireApiKey as express.RequestHandler);
app.delete('/api/worlds/build/:jobId', requireApiKey as express.RequestHandler);
app.get('/api/worlds/check-data', requireApiKey as express.RequestHandler);
app.get('/api/worlds/refresh', requireApiKey as express.RequestHandler);
const playerRoutes = [
  '/api/sessions/:id/talk',
  '/api/sessions/:id/action',
  '/api/sessions/:id/move',
  '/api/sessions/:id/wait',
  '/api/sessions/:id/tick',
  '/api/sessions/:id/god',
  '/api/sessions/:id/quest/discover',
  '/api/sessions/:id/world-quests/fail',
  '/api/sessions/:id/world-quests/abandon',
  '/api/sessions/:id/world-quests/retry',
  '/api/sessions/:id/serialized-adventures/:adventureId/start',
  '/api/sessions/:id/serialized-adventures/evaluate',
  '/api/sessions/:id/serialized-adventures/abandon',
  '/api/tts',
];
for (const p of playerRoutes) app.post(p, requirePlayerOrApiKey as express.RequestHandler);
const destructiveRoutes: { method: 'delete' | 'post' | 'patch'; path: string }[] = [
  { method: 'delete', path: '/api/worlds/:id' },
  { method: 'delete', path: '/api/sessions/:sessionId' },
  { method: 'delete', path: '/api/players/:playerId' },
  { method: 'delete', path: '/api/worlds/:id/world-quests/:questId' },
  { method: 'delete', path: '/api/worlds/:id/serialized-adventures/:adventureId' },
  { method: 'delete', path: '/api/worlds/:worldId/quest-pool/:seedId' },
  { method: 'post',   path: '/api/worlds/:id/world-quests/cleanup' },
  { method: 'patch',  path: '/api/worlds/:id/world-quests/:questId' },
  { method: 'patch',  path: '/api/worlds/:id' },
  { method: 'post',   path: '/api/worlds/:id/reset' },
  { method: 'post',   path: '/api/worlds/:id/baseline' },
];
for (const r of destructiveRoutes) {
  app[r.method](r.path, blockDestructiveWrites as express.RequestHandler);
  app[r.method](r.path, requireApiKey as express.RequestHandler);
}
const llmRoutes = [
  '/api/worlds/build',
  '/api/worlds',
  '/api/sessions/:id/talk',
  '/api/sessions/:id/action',
  '/api/sessions/:id/move',
  '/api/sessions/:id/wait',
  '/api/sessions/:id/tick',
  '/api/worlds/:id/world-quests/generate',
  '/api/sessions/:id/world-quests/retry',
  '/api/worlds/:id/serialized-adventures/generate',
  '/api/sessions/:id/serialized-adventures/evaluate',
  '/api/tts',
];
for (const p of llmRoutes) app.post(p, llmLimiter);

const ALLOW_PLAYER_INTENT_INTERPRETATION =
  process.env.ALLOW_PLAYER_INTENT_INTERPRETATION === 'true' ||
  process.env.ALLOW_PLAYER_INTENT_INTERPRETATION === '1';
const ACTIVE_CHARACTER_WINDOW_MS = 15 * 60 * 1000;
const ACTIVE_CHARACTER_TOUCH_THROTTLE_MS = 60 * 1000;

// Serve frontend
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
// Debian/Ubuntu images ship python3 only; Windows installs ship python.
const PYTHON_BIN = (process.env.PYTHON_BIN || '').trim() || (process.platform === 'win32' ? 'python' : 'python3');
const PUBLIC_DIR = join(__dirname, '..', 'public');
const GENERATED_DIR = join(PUBLIC_DIR, 'generated');
app.use('/generated', express.static(GENERATED_DIR, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
// Pipeline working folders live under public/ but are not web assets: uploaded source
// scripts/PDFs, the ArcFace still cache and media trash must not be downloadable.
// Match on the decoded, normalised path: express.static decodes %XX and collapses '//'
// before reading the file, so a raw-path mount check alone is bypassable.
const PRIVATE_PUBLIC_DIRS = /^\/(?:uploads|imdb-cache|media-trash)(?:\/|$)/i;
app.use((req, res, next) => {
  let decoded: string;
  try { decoded = decodeURIComponent(req.path); } catch { res.status(400).end(); return; }
  const normalised = posixPath.normalize(decoded.replace(/\\/g, '/')).replace(/^\/+/, '/');
  if (PRIVATE_PUBLIC_DIRS.test(normalised)) { res.status(404).end(); return; }
  next();
});
app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  setHeaders(res, path) {
    if (/\.(?:html?|js|css)$/i.test(path)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      return;
    }
    if (/\.(?:png|jpe?g|webp|gif|mp3|pdf)$/i.test(path)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

// ── /api/img — Pollinations proxy with on-disk cache ───────────────────────
// All client-side image references go through here so that:
//   1. the sk_ Pollinations token never reaches the browser
//   2. repeat loads hit our disk cache instead of the upstream rate limit
//      (anonymous tier is 1 req/15s — would absolutely kill the observatory)
const IMG_CACHE_DIR = join(GENERATED_DIR, '_imgcache');
mkdirSync(IMG_CACHE_DIR, { recursive: true });
const inflightImgFetches = new Map<string, Promise<string>>();
const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');

// Safety net: image-proxy failures must never crash the server. Pollinations
// can return surprising statuses and AbortController timers can leak handles
// on Windows libuv. Log everything and stay alive.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err);
  // flushPendingSaves writes sessions asynchronously — wait for it (bounded) before exiting.
  const hardExit = setTimeout(() => process.exit(1), 3000);
  hardExit.unref();
  flushPendingSaves().catch(() => {}).finally(() => process.exit(1));
});

// Upstream concurrency cap. Even with a sk_ token, Pollinations bursts >~6
// simultaneous Flux requests return 402 Payment Required, so we gate the
// proxy with a simple semaphore. Tune via WORLDGEN_IMG_PROXY_CONCURRENCY.
const IMG_PROXY_CONCURRENCY = Math.max(1, parseInt(process.env.WORLDGEN_IMG_PROXY_CONCURRENCY ?? '3', 10) || 3);
let imgProxyActive = 0;
const imgProxyWaiters: Array<() => void> = [];
const imgProxyCooldowns = new Map<string, { until: number; status: number }>();
async function acquireImgSlot(): Promise<void> {
  if (imgProxyActive < IMG_PROXY_CONCURRENCY) { imgProxyActive += 1; return; }
  await new Promise<void>(resolve => imgProxyWaiters.push(resolve));
  imgProxyActive += 1;
}
function releaseImgSlot(): void {
  imgProxyActive -= 1;
  const next = imgProxyWaiters.shift();
  if (next) next();
}

/** Cache file name for an /api/img request; undefined when the request has no prompt. */
function imgProxyCacheFileName(query: Record<string, unknown>): string | undefined {
  const prompt = String(query.p ?? query.prompt ?? '').slice(0, 2000);
  if (!prompt) return undefined;
  const seed = String(query.seed ?? '0').slice(0, 16);
  const w = Math.max(64, Math.min(2048, parseInt(String(query.w ?? query.width ?? '512'), 10) || 512));
  const h = Math.max(64, Math.min(2048, parseInt(String(query.h ?? query.height ?? '512'), 10) || 512));
  const model = String(query.model ?? 'flux').replace(/[^a-z0-9._-]/gi, '').slice(0, 40) || 'flux';
  return `${createHash('sha256').update(`${prompt}|${seed}|${w}|${h}|${model}`).digest('hex').slice(0, 32)}.jpg`;
}

app.get('/api/img', async (req, res) => {
  try {
    const cacheFile = imgProxyCacheFileName(req.query as Record<string, unknown>);
    if (!cacheFile) { res.status(400).send('missing prompt'); return; }
    const cachePath = join(IMG_CACHE_DIR, cacheFile);
    const serveCached = () => {
      const buf = readFileSync(cachePath);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', String(buf.length));
      res.end(buf);
    };

    if (existsSync(cachePath) && statSync(cachePath).size > 100) {
      serveCached();
      return;
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', String(TRANSPARENT_PNG.length));
    res.end(TRANSPARENT_PNG);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/pollinations (402|429)/.test(message)) console.warn('[imgProxy]', message);
    else console.error('[imgProxy]', err);
    if (!res.headersSent) res.status(502).send('image fetch failed');
  }
});

// One-time scrub of legacy Pollinations URLs in saved world data. Old worlds
// have `https://image.pollinations.ai/prompt/...&token=sk_...` baked into
// npc.images.{portrait,keepsake,object} — that leaks the secret key on every
// response. Drop them; local /generated assets are attached separately.
function migrateLegacyImageUrls(): void {
  const POLL_RE = /^https:\/\/image\.pollinations\.ai\/prompt\/([^?]+)\?(.+)$/;
  const rewrite = (url: unknown): string | undefined => {
    if (typeof url !== 'string') return undefined;
    if (url.startsWith('/generated/')) return undefined;
    if (isUnsafeProxyImageUrl(url)) return '';
    const m = POLL_RE.exec(url);
    if (!m) return undefined;
    const promptEncoded = m[1];
    const params = new URLSearchParams(m[2]);
    const seed = params.get('seed') ?? '0';
    const width = params.get('width') ?? '512';
    const height = params.get('height') ?? '512';
    return '';
  };
  let touchedWorlds = 0;
  for (const world of worlds.values()) {
    let changed = false;
    for (const npc of (world.npcs ?? []) as any[]) {
      const imgs = npc.images;
      if (!imgs || typeof imgs !== 'object') continue;
      for (const key of ['portrait', 'keepsake', 'object'] as const) {
        const next = rewrite(imgs[key]);
        if (next !== undefined) { imgs[key] = next; changed = true; }
      }
    }
    if (changed) {
      touchedWorlds += 1;
      saveWorld(world);
    }
  }
  if (touchedWorlds > 0) console.log(`[imgProxy] migrated legacy Pollinations URLs in ${touchedWorlds} world(s)`);
}

// ── In-memory stores (replace with DB later) ────────────────────────────────

const worlds = new Map<string, WorldDNA>();
const sessions = new Map<string, WorldSession>();
const globalPlayers = new Map<string, GlobalPlayerProfile>();
const activeQuests = new Map<string, QuestSessionState>();
const MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER = 3;
const MAX_WORLD_QUEST_PLAYERS = 2;
loadAllData(worlds, sessions, globalPlayers);

// Lazy-load budget-deferred worlds when a route touches them by id.
app.use('/api/worlds/:id', (req, _res, next) => {
  ensureWorldLoaded(req.params.id, worlds);
  next();
});
app.use('/api/worlds/:worldId', (req, _res, next) => {
  ensureWorldLoaded(req.params.worldId, worlds);
  next();
});

// Sessions skipped at boot (size/budget caps) are indexed as stubs and loaded on first
// touch. A session's world may itself be deferred, so load that too.
// Same per-session setup the boot loader applies to every session it loads.
function hydrateLoadedSession(session: WorldSession): void {
  const world = worlds.get(session.worldId);
  if (world) ensureSessionNpcStateIntegrity(session, world);
  ensureCognitionState(session);
  ensureFeedState(session);
  session.questHooks = session.questHooks ?? [];
  session.questInvites = session.questInvites ?? [];
  session.questEchoes = session.questEchoes ?? [];
  if (session.globalPlayerId) copyGlobalProgressToSession(session, globalPlayers.get(session.globalPlayerId));
}

function ensureSessionAndWorldLoaded(sessionId: string): void {
  const wasLoaded = sessions.has(sessionId);
  const session = ensureSessionLoaded(sessionId, sessions, worlds);
  if (session?.worldId) ensureWorldLoaded(session.worldId, worlds);
  if (session && !wasLoaded) {
    hydrateLoadedSession(session);
    rebindLoadedQuestInstances();
  }
}

function loadSessionStubsWhere(predicate: (stub: SessionStub) => boolean): void {
  if (!sessionStubs.size) return;
  const ids = Array.from(sessionStubs.values()).filter(predicate).map(stub => stub.id);
  if (!ids.length) return;
  ensureSessionsLoadedWhere(stub => ids.includes(stub.id), sessions, worlds);
  for (const id of ids) {
    const session = sessions.get(id);
    if (session) hydrateLoadedSession(session);
  }
  rebindLoadedQuestInstances();
}

/** Loading a skipped session costs memory, so only its owner (id + PIN) or the admin
 *  may trigger it. Returns the verified player id, or '' when not verified. */
function verifiedRequesterId(req: express.Request, res: express.Response, expectedPlayerId?: string): string {
  const playerId = requestString(req.headers['x-global-player-id'] ?? req.body?.globalPlayerId ?? expectedPlayerId).trim();
  if (!playerId || (expectedPlayerId && playerId !== expectedPlayerId)) return '';
  const pin = requestString(req.headers['x-global-player-pin'] ?? req.body?.pin).trim();
  return verifyGlobalPlayerPin(globalPlayers.get(playerId), pin, pinContext(req, res)) ? playerId : '';
}

app.use('/api/sessions/:id', (req, res, next) => {
  const stub = sessionStubs.get(req.params.id);
  if (stub && (hasValidApiKey(req) || (stub.globalPlayerId && verifiedRequesterId(req, res, stub.globalPlayerId)))) {
    ensureSessionAndWorldLoaded(stub.id);
  } else {
    const session = sessions.get(req.params.id);
    if (session?.worldId) ensureWorldLoaded(session.worldId, worlds);
  }
  next();
});
// Resuming or listing a player's characters in a world must see their skipped sessions.
for (const p of ['/api/worlds/:worldId/sessions', '/api/worlds/:worldId/characters', '/api/worlds/:worldId/joinable-quests', '/api/worlds/:worldId/quest-pool']) {
  app.use(p, (req, res, next) => {
    if (!sessionStubs.size) return next();
    const worldId = req.params.worldId;
    if (API_KEY && hasValidApiKey(req)) {
      loadSessionStubsWhere(stub => stub.worldId === worldId);
    } else {
      const playerId = verifiedRequesterId(req, res);
      if (playerId) loadSessionStubsWhere(stub => stub.worldId === worldId && stub.globalPlayerId === playerId);
    }
    next();
  });
}
app.use('/api/players/:playerId', (req, res, next) => {
  if (!sessionStubs.size) return next();
  const playerId = req.params.playerId;
  if ((API_KEY && hasValidApiKey(req)) || verifiedRequesterId(req, res, playerId)) {
    loadSessionStubsWhere(stub => stub.globalPlayerId === playerId);
  }
  next();
});

// === Admin: bulk-import worlds onto a shared/Render instance =====================
// POST /api/admin/import-worlds  body = { worlds: [<world>, ...] }
// Writes each world JSON to DATA_DIR, then reloads in-memory state. Auth: WORLDGEN_API_KEY.
// Use with Option C (persistent disk) to populate worlds without committing them to git.
app.post('/api/admin/import-worlds', requireApiKey as express.RequestHandler, async (req, res) => {
  try {
    const body = req.body as { worlds?: any[] };
    if (!Array.isArray(body?.worlds)) return res.status(400).json({ error: 'expected { worlds: [...] }' });
    const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
    let written = 0;
    const skipped: { id?: string; reason: string }[] = [];
    for (const w of body.worlds) {
      if (!w || typeof w !== 'object') { skipped.push({ reason: 'not-object' }); continue; }
      const id = String((w as any).id || '');
      if (!SAFE_ID.test(id)) { skipped.push({ id, reason: 'unsafe-id' }); continue; }
      try {
        const tmpFile = join(DATA_DIR, `world-${id}.json.tmp`);
        const destFile = join(DATA_DIR, `world-${id}.json`);
        writeFileSync(tmpFile, JSON.stringify(w));
        renameSync(tmpFile, destFile);
        written++;
      } catch (e: any) {
        skipped.push({ id, reason: 'write-failed: ' + String(e?.message || e) });
      }
    }
    worlds.clear();
    sessions.clear();
    globalPlayers.clear();
    loadAllData(worlds, sessions, globalPlayers);
    res.json({ ok: true, written, skipped, totalWorlds: worlds.size, totalSessions: sessions.size, dataDir: DATA_DIR });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
// =============================================================================

function uniqueMergeArray<T>(a?: T[], b?: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...(a ?? []), ...(b ?? [])]) {
    const key = typeof item === 'object' && item ? JSON.stringify(item) : String(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function playerCompletenessScore(player: GlobalPlayerProfile): number {
  return [
    player.portraitUrl,
    player.photoUrl,
    player.imageUrl,
    player.avatarUrl,
    player.playerAppearance,
    player.playerBackstory,
    player.playerOccupation,
  ].filter(Boolean).length
    + (player.questHistory?.length ?? 0)
    + (player.achievements?.length ?? 0)
    + (player.medals?.length ?? 0);
}

function playerUpdatedAt(player: GlobalPlayerProfile): number {
  return Date.parse(player.updatedAt || player.lastActiveAt || player.createdAt || '') || 0;
}

function mergeDuplicatePlayerProfile(keep: GlobalPlayerProfile, incoming: GlobalPlayerProfile): GlobalPlayerProfile {
  const newer = playerUpdatedAt(incoming) >= playerUpdatedAt(keep) ? incoming : keep;
  const richer = playerCompletenessScore(incoming) > playerCompletenessScore(keep) ? incoming : keep;
  return {
    ...keep,
    ...newer,
    id: keep.id,
    pin: keep.pin || incoming.pin,
    source: keep.source || incoming.source,
    createdAt: playerUpdatedAt(keep) <= playerUpdatedAt(incoming) ? keep.createdAt : incoming.createdAt,
    updatedAt: new Date(Math.max(playerUpdatedAt(keep), playerUpdatedAt(incoming), Date.now())).toISOString(),
    lastActiveAt: new Date(Math.max(playerUpdatedAt(keep), playerUpdatedAt(incoming))).toISOString(),
    playerName: keep.playerName || incoming.playerName,
    playerAge: richer.playerAge ?? keep.playerAge,
    playerGender: richer.playerGender ?? keep.playerGender,
    playerOccupation: richer.playerOccupation || keep.playerOccupation || incoming.playerOccupation,
    playerBackstory: richer.playerBackstory || keep.playerBackstory || incoming.playerBackstory,
    playerAppearance: richer.playerAppearance || keep.playerAppearance || incoming.playerAppearance,
    photoUrl: keep.photoUrl || incoming.photoUrl,
    imageUrl: keep.imageUrl || incoming.imageUrl,
    avatarUrl: keep.avatarUrl || incoming.avatarUrl,
    portraitUrl: keep.portraitUrl || incoming.portraitUrl,
    strangePossessions: uniqueMergeArray(keep.strangePossessions, incoming.strangePossessions),
    medals: uniqueMergeArray(keep.medals, incoming.medals),
    achievements: uniqueMergeArray(keep.achievements, incoming.achievements),
    questFacts: uniqueMergeArray(keep.questFacts, incoming.questFacts),
    questHistory: uniqueMergeArray(keep.questHistory, incoming.questHistory),
  };
}

function compactDuplicateGlobalPlayers(): void {
  const byName = new Map<string, GlobalPlayerProfile>();
  const idRemap = new Map<string, string>();
  for (const player of globalPlayers.values()) {
    const key = String(player.playerName || '').trim().toLowerCase();
    if (!key) {
      byName.set(player.id, player);
      continue;
    }
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, player);
      continue;
    }
    const keep = playerCompletenessScore(player) > playerCompletenessScore(existing) || (playerCompletenessScore(player) === playerCompletenessScore(existing) && playerUpdatedAt(player) > playerUpdatedAt(existing)) ? player : existing;
    const drop = keep.id === player.id ? existing : player;
    console.warn('[players] Merging duplicate player profiles with name:', key);
    byName.set(key, mergeDuplicatePlayerProfile(keep, drop));
    idRemap.set(drop.id, keep.id);
  }
  if (!idRemap.size) return;
  globalPlayers.clear();
  for (const player of byName.values()) globalPlayers.set(player.id, player);
  let sessionUpdates = 0;
  for (const session of sessions.values()) {
    if (session.globalPlayerId && idRemap.has(session.globalPlayerId)) {
      session.globalPlayerId = idRemap.get(session.globalPlayerId)!;
      saveSession(session);
      sessionUpdates++;
    }
  }
  saveGlobalPlayers(globalPlayers);
  console.log(`[persist] compacted duplicate players ${idRemap.size} duplicate record(s) -> ${globalPlayers.size} unique name(s); remapped ${sessionUpdates} session(s)`);
}

compactDuplicateGlobalPlayers();

const WORLD_DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  red_dwarf_world: 'Red Dwarf',
  'f7999d65-4f62-414c-b5a8-6ac0f9808209': 'Back to the 80s',
  'd3b6370e-bc39-4efb-a2e1-8af79129209b': 'the lion witch and wardrobe',
  'd1137bf8-dc58-48b1-8666-8bd7d0d60432': 'cannical hollocaust',
  '56d34564-1a55-4d2c-a2eb-7bac2496be11': '1970s England Yorkshire Ripper',
  '4509d821-8d82-4734-afab-d1d650a302f7': '1970s Armey juvinile demale detention',
};

function applyWorldDisplayNameOverrides(): void {
  for (const [worldId, displayName] of Object.entries(WORLD_DISPLAY_NAME_OVERRIDES)) {
    const world = worlds.get(worldId) as any;
    if (!world) continue;
    let changed = false;
    for (const key of ['concept', 'name', 'title'] as const) {
      if (world[key] !== displayName) {
        world[key] = displayName;
        changed = true;
      }
    }
    for (const seed of world.questPool ?? []) {
      if (seed.worldName && seed.worldName !== displayName) {
        seed.worldName = displayName;
        changed = true;
      }
      if (typeof seed.title === 'string' && seed.title.includes(': ') && !seed.title.endsWith(`: ${displayName}`)) {
        seed.title = seed.title.replace(/: .+$/, `: ${displayName}`);
        changed = true;
      }
    }
    if (changed) saveWorld(world);
  }
}

applyWorldDisplayNameOverrides();
migrateLegacyImageUrls();
for (const session of sessions.values()) hydrateLoadedSession(session);
rebindLoadedQuestInstances();
enforceAllGlobalQuestLimits();
backfillWorldPersistenceFromSessions();
for (const world of worlds.values()) {
  const sourceAttached = attachKnownWorldQuestSourceDocuments(world);
  if (ensureWorldQuestPool(world) || sourceAttached) saveWorld(world);
}

async function reloadRuntimeDataFromDisk(): Promise<{ worlds: number; sessions: number; players: number; dataDir: string }> {
  await flushPendingSaves();
  worlds.clear();
  sessions.clear();
  globalPlayers.clear();
  loadAllData(worlds, sessions, globalPlayers);
  applyWorldDisplayNameOverrides();
  migrateLegacyImageUrls();
  for (const session of sessions.values()) hydrateLoadedSession(session);
  rebindLoadedQuestInstances();
  enforceAllGlobalQuestLimits();
  backfillWorldPersistenceFromSessions();
  for (const world of worlds.values()) {
    const sourceAttached = attachKnownWorldQuestSourceDocuments(world);
    if (ensureWorldQuestPool(world) || sourceAttached) saveWorld(world);
  }
  bumpWorldsListCache();
  return { worlds: worlds.size, sessions: sessions.size, players: globalPlayers.size, dataDir: DATA_DIR };
}

// Per-NPC serialisation. Concurrent /talk calls to the same NPC mutate the
// same innerLife / theoryOfPlayer / rumination state, so we queue them.
// The map is bounded by the number of distinct NPC IDs ever spoken to.
const npcLocks = new Map<string, Promise<unknown>>();
async function withNpcLock<T>(npcId: string, fn: () => Promise<T>): Promise<T> {
  const prev = npcLocks.get(npcId) ?? Promise.resolve();
  let result: T = undefined as unknown as T;
  let error: unknown;
  const next = prev.then(async () => {
    try { result = await fn(); }
    catch (e) { error = e; }
  });
  npcLocks.set(npcId, next);
  await next;
  // Clean up if this is still the latest in the chain
  if (npcLocks.get(npcId) === next) {
    npcLocks.delete(npcId);
  }
  if (error !== undefined) throw error;
  return result!;
}

function ensureFeedState(session: WorldSession): void {
  session.feedEvents = session.feedEvents ?? [];
}

function mergeDefined<T>(base: T, patch?: Partial<T> | Record<string, unknown> | null): T {
  if (!patch) return base;
  const target = base as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value !== undefined) (base as Record<string, unknown>)[key] = value;
  }
  return target as T;
}

function touchSession(session: WorldSession): void {
  session.lastActiveAt = new Date().toISOString();
}

function persistSessionOnly(session: WorldSession, options: { touch?: boolean } = {}): void {
  if (options.touch !== false) touchSession(session);
  syncGlobalPlayerFromSession(session);
  saveSession(session);
}

function refreshSessionActivity(session: WorldSession): void {
  const lastActiveAt = session.lastActiveAt ? Date.parse(session.lastActiveAt) : 0;
  if (!lastActiveAt || Number.isNaN(lastActiveAt) || (Date.now() - lastActiveAt) >= ACTIVE_CHARACTER_TOUCH_THROTTLE_MS) {
    persistSessionOnly(session);
  }
}

function appendFeedEvents(session: WorldSession, entries: Array<{ ty: string; x: string }>): void {
  ensureFeedState(session);
  const t = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  session.feedEvents!.push(...entries.map(entry => ({ t, ty: entry.ty, x: entry.x })));
  if (session.feedEvents!.length > 250) session.feedEvents = session.feedEvents!.slice(-250);
}

function suppressWeatherFeedForWorld(world: WorldDNA): boolean {
  const text = [
    world.id,
    (world as any).name,
    (world as any).title,
    world.concept,
    world.era?.period,
    world.geography?.region,
    world.geography?.country,
    world.geography?.climate,
    world.geography?.terrain,
    world.geography?.scale,
    typeof world.technology === 'string' ? world.technology : JSON.stringify(world.technology ?? ''),
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(alien|nostromo|andromeda|logan'?s run|spaceship|starship|spacecraft|space station|space|deep space|outer space|interstellar|galactic|orbital|orbit|off[- ]?world|colony|lunar|moon|mars|planet|asteroid|derelict|android|cyborg)\b/.test(text);
}

function applyWeatherPressure(session: WorldSession, world: WorldDNA, locationId: string, source: 'weather' | 'movement' | 'time'): string | undefined {
  const effects = weatherWorldEffects(session.currentWeather);
  if (!effects.scene && !effects.npcReaction && !effects.feed) return undefined;
  for (const npc of world.npcs) {
    const state = session.npcStates[npc.id];
    if (!state) continue;
    state.environmentalAwareness = state.environmentalAwareness ?? {
      knownScarcities: [],
      recentArrivals: [],
      recentDepartures: [],
      locationChanges: [],
      lastWeatherReaction: '',
    };
    state.environmentalAwareness.lastWeatherReaction = effects.npcReaction;
    if (state.currentLocationId === locationId && effects.scene) {
      state.environmentalAwareness.locationChanges = [
        effects.scene,
        ...(state.environmentalAwareness.locationChanges ?? []).filter(item => item !== effects.scene),
      ].slice(0, 6);
    }
  }
  const message = source === 'movement' ? effects.movement : effects.feed;
  if (message && !suppressWeatherFeedForWorld(world)) appendFeedEvents(session, [{ ty: 'event', x: message }]);
  return message;
}

function weatherTags(weather: WorldSession['currentWeather']): string[] {
  return Array.from(new Set(weatherWorldEffects(weather).tags));
}

function cloneData<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function normaliseProfileSegment(value: string | number | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildPlayerProfileKey(player: Pick<WorldSession, 'playerName' | 'playerAge' | 'playerGender' | 'playerOccupation' | 'playerBackstory'>): string {
  return [
    normaliseProfileSegment(player.playerName),
    normaliseProfileSegment(player.playerAge),
    normaliseProfileSegment(player.playerGender),
    normaliseProfileSegment(player.playerOccupation),
    normaliseProfileSegment(player.playerBackstory),
  ].join('|');
}

function getSessionPlayerProfileKey(session: WorldSession): string {
  session.playerProfileKey ??= buildPlayerProfileKey(session);
  return session.playerProfileKey;
}

function copyGlobalProgressToSession(session: WorldSession, player?: GlobalPlayerProfile): void {
  if (!player) return;
  enforceGlobalQuestLimit(player.id);
  session.globalPlayerId = player.id;
  session.medals = cloneData(player.medals ?? []);
  session.achievements = cloneData(player.achievements ?? []);
  session.questFacts = cloneData(player.questFacts ?? []);
  session.questEchoes = mergeById(player.questHistory, session.questEchoes);
  session.retryableQuests = mergeById(player.retryableQuests, session.retryableQuests);
  // Carry the player's adventurer XP into this session (max-merge so a higher session
  // value isn't clobbered if it raced ahead of the persisted player profile).
  session.adventurerXp = Math.max(session.adventurerXp ?? 0, player.adventurerXp ?? 0);
  if (player.activeQuest?.status === 'active') {
    const participantIds = new Set([player.activeQuest.ownerSessionId, ...(player.activeQuest.participantSessionIds ?? [])].filter(Boolean));
    if (participantIds.has(session.id) || session.activeQuest?.id === player.activeQuest.id) {
      const quest = canonicalQuestFor(cloneData(player.activeQuest), session);
      quest.participantSessionIds = Array.from(new Set([...(quest.participantSessionIds ?? []), session.id]));
      quest.participantReturns ??= {};
      quest.participantReturns[session.id] ??= questReturnForSession(session);
      activeQuests.set(quest.id, quest);
      session.activeQuest = quest;
    }
  }
  session.playerAppearance = player.playerAppearance ?? session.playerAppearance;
  session.photoUrl = player.photoUrl ?? session.photoUrl;
  session.imageUrl = player.imageUrl ?? session.imageUrl;
  session.avatarUrl = player.avatarUrl ?? session.avatarUrl;
  session.portraitUrl = player.portraitUrl ?? session.portraitUrl;
  session.playerDepartureStyle = player.playerDepartureStyle ?? session.playerDepartureStyle;
  session.strangePossessions = cloneData(player.strangePossessions ?? session.strangePossessions ?? []);
}

function mergeById<T extends { id: string }>(existing: T[] | undefined, incoming: T[] | undefined): T[] {
  const merged = new Map<string, T>();
  for (const item of existing ?? []) merged.set(item.id, item);
  for (const item of incoming ?? []) merged.set(item.id, item);
  return Array.from(merged.values());
}

function syncGlobalPlayerFromSession(session: WorldSession): GlobalPlayerProfile | undefined {
  if (!session.globalPlayerId) return undefined;
  enforceGlobalQuestLimit(session.globalPlayerId);
  const existing = globalPlayers.get(session.globalPlayerId);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const activeQuest = session.activeQuest?.status === 'active' && session.activeQuest.scope === 'global'
    ? cloneData(canonicalQuestFor(session.activeQuest, session))
    : existing.activeQuest?.status === 'active'
      ? existing.activeQuest
      : undefined;
  const comparableExisting = {
    ...existing,
    updatedAt: undefined,
    lastActiveAt: undefined,
  };
  const player: GlobalPlayerProfile = {
    ...existing,
    updatedAt: now,
    lastActiveAt: session.lastActiveAt,
    playerName: session.playerName,
    playerAge: session.playerAge,
    playerGender: session.playerGender,
    playerOccupation: session.playerOccupation,
    playerBackstory: session.playerBackstory,
    playerAppearance: session.playerAppearance,
    photoUrl: session.photoUrl ?? existing.photoUrl,
    imageUrl: session.imageUrl ?? existing.imageUrl,
    avatarUrl: session.avatarUrl ?? existing.avatarUrl,
    portraitUrl: session.portraitUrl ?? existing.portraitUrl,
    playerDepartureStyle: session.playerDepartureStyle,
    strangePossessions: cloneData(session.strangePossessions ?? []),
    medals: mergeById(existing.medals, session.medals),
    achievements: mergeById(existing.achievements, session.achievements),
    questFacts: mergeById(existing.questFacts, session.questFacts),
    questHistory: mergeById(existing.questHistory, session.questEchoes),
    retryableQuests: mergeById(existing.retryableQuests, session.retryableQuests),
    // Adventurer XP - max-merge so transient session progress is never lost
    adventurerXp: Math.max(existing.adventurerXp ?? 0, session.adventurerXp ?? 0),
    activeQuest,
  };
  const comparablePlayer = {
    ...player,
    updatedAt: undefined,
    lastActiveAt: undefined,
  };
  const sortedStringify = (o: any): string => JSON.stringify(o, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((r: any, k) => { r[k] = value[k]; return r; }, {});
    }
    return value;
  });
  if (sortedStringify(comparableExisting) === sortedStringify(comparablePlayer)) {
    copyGlobalProgressToSession(session, existing);
    return existing;
  }
  globalPlayers.set(player.id, player);
  copyGlobalProgressToSession(session, player);
  saveGlobalPlayers(globalPlayers);
  return player;
}

function clearGlobalActiveQuest(session: WorldSession, questId: string): void {
  if (!session.globalPlayerId) return;
  const player = globalPlayers.get(session.globalPlayerId);
  if (player?.activeQuest?.id === questId) {
    const next: GlobalPlayerProfile = { ...player, activeQuest: undefined, updatedAt: new Date().toISOString() };
    globalPlayers.set(next.id, next);
    saveGlobalPlayers(globalPlayers);
  }
  for (const other of sessions.values()) {
    if (other.globalPlayerId === session.globalPlayerId && other.activeQuest?.id === questId) {
      other.activeQuest = undefined;
      saveSession(other);
    }
  }
  activeQuests.delete(questId);
}

function activeGlobalQuestRecordsForPlayer(playerId: string): { quest: QuestSessionState; sessions: WorldSession[] }[] {
  const byQuest = new Map<string, { quest: QuestSessionState; sessions: WorldSession[] }>();
  const player = globalPlayers.get(playerId);
  if (player?.activeQuest?.status === 'active' && player.activeQuest.scope === 'global') {
    byQuest.set(player.activeQuest.id, { quest: player.activeQuest, sessions: [] });
  }
  for (const session of sessions.values()) {
    const quest = session.globalPlayerId === playerId && session.activeQuest?.status === 'active' && session.activeQuest.scope === 'global'
      ? session.activeQuest
      : undefined;
    if (!quest) continue;
    const existing = byQuest.get(quest.id);
    if (existing) {
      existing.sessions.push(session);
      existing.quest = canonicalQuestFor(quest, session);
    } else {
      byQuest.set(quest.id, { quest: canonicalQuestFor(quest, session), sessions: [session] });
    }
  }
  return Array.from(byQuest.values())
    .sort((a, b) => Date.parse(b.quest.startedAt || '') - Date.parse(a.quest.startedAt || ''));
}

function globalQuestLimitEcho(quest: QuestSessionState): QuestEcho {
  return {
    id: randomUUID(),
    questId: quest.id,
    questName: quest.name,
    status: 'abandoned',
    message: `Quest reset by ${MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER}-global-quest limit: ${quest.name}`,
    createdAt: new Date().toISOString(),
  };
}

function enforceGlobalQuestLimit(playerId: string): { kept: QuestSessionState[]; reset: QuestSessionState[] } {
  const records = activeGlobalQuestRecordsForPlayer(playerId);
  const kept = records.slice(0, MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER);
  const reset = records.slice(MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER);
  for (const record of reset) {
    const echo = globalQuestLimitEcho(record.quest);
    for (const session of record.sessions) {
      if (session.activeQuest?.id === record.quest.id) {
        appendQuestEcho(session, echo);
        storeRetryableQuest(session, record.quest, echo);
        recordQuestOutcomeNpcMemory(session, record.quest, echo);
        session.activeQuest = undefined;
        saveSession(session);
      }
    }
    activeQuests.delete(record.quest.id);
  }
  const player = globalPlayers.get(playerId);
  if (player) {
    const preferred = kept.find(record => record.quest.status === 'active')?.quest;
    const nextActiveQuest = preferred ? cloneData(preferred) : undefined;
    if (player.activeQuest?.id !== nextActiveQuest?.id || reset.length) {
      globalPlayers.set(player.id, { ...player, activeQuest: nextActiveQuest, updatedAt: new Date().toISOString() });
      saveGlobalPlayers(globalPlayers);
    }
  }
  return { kept: kept.map(record => record.quest), reset: reset.map(record => record.quest) };
}

function enforceAllGlobalQuestLimits(): void {
  for (const playerId of globalPlayers.keys()) enforceGlobalQuestLimit(playerId);
}

const DEFAULT_PLAYER_APPEARANCE = 'ordinary travelling clothes';
const DEFAULT_PLAYER_DEPARTURE_STYLE = 'leaves normally';

function visiblePlayerAppearance(value?: string): string {
  const text = String(value ?? '').trim();
  if (!text || /\b(invisible|unseen|cloak|cloaked|robe|hood|hooded|disguise|shrouded)\b/i.test(text)) return DEFAULT_PLAYER_APPEARANCE;
  return text.slice(0, 200);
}

function visiblePlayerDepartureStyle(value?: string): string {
  const text = String(value ?? '').trim();
  if (!text || /\b(vanish|vanishes|vanished|fade|fades|unseen|invisible|silently)\b/i.test(text)) return DEFAULT_PLAYER_DEPARTURE_STYLE;
  return text.slice(0, 200);
}

function ensureVisiblePlayerStart(session: WorldSession): void {
  session.playerAppearance = visiblePlayerAppearance(session.playerAppearance);
  session.playerDepartureStyle = visiblePlayerDepartureStyle(session.playerDepartureStyle);
}

function createGlobalPlayer(input: Partial<GlobalPlayerProfile>): GlobalPlayerProfile {
  const now = new Date().toISOString();
  const playerName = String(input.playerName || '').trim().slice(0, 100);
  if (!playerName) throw new Error('playerName is required');
  const pin = String((input as any).pin ?? '').trim();
  if (!/^\d{3}$/.test(pin)) throw new Error('3 digit pin is required');
  const player: GlobalPlayerProfile = {
    // Ids are public; never embed the PIN (legacy "pin123_" ids still resolve).
    id: `player_${randomUUID()}`,
    pin,
    source: input.source ?? 'manual',
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
    playerName,
    playerAge: Math.max(1, Math.min(200, Math.floor(Number(input.playerAge) || 25))),
    playerGender: String(input.playerGender || 'unknown').slice(0, 50),
    playerOccupation: String(input.playerOccupation || 'newcomer').slice(0, 200),
    playerBackstory: String(input.playerBackstory || 'You have just arrived.').slice(0, 1000),
    playerAppearance: visiblePlayerAppearance(input.playerAppearance),
    photoUrl: String((input as any).photoUrl ?? '').trim().slice(0, 500) || undefined,
    imageUrl: String((input as any).imageUrl ?? '').trim().slice(0, 500) || undefined,
    avatarUrl: String((input as any).avatarUrl ?? '').trim().slice(0, 500) || undefined,
    portraitUrl: String((input as any).portraitUrl ?? '').trim().slice(0, 500) || undefined,
    playerDepartureStyle: visiblePlayerDepartureStyle(input.playerDepartureStyle),
    strangePossessions: cloneData(input.strangePossessions ?? []),
    medals: cloneData(input.medals ?? []),
    achievements: cloneData(input.achievements ?? []),
    questFacts: cloneData(input.questFacts ?? []),
    questHistory: cloneData(input.questHistory ?? []),
  };
  globalPlayers.set(player.id, player);
  saveGlobalPlayers(globalPlayers);
  return player;
}

function findGlobalPlayerByName(name: string): GlobalPlayerProfile | undefined {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return undefined;
  return Array.from(globalPlayers.values()).find(player => String(player.playerName || '').trim().toLowerCase() === key);
}

function generatedUrlPathExists(value: unknown): boolean {
  const url = String(value ?? '').trim();
  const match = url.match(/^\/generated\/(.+)$/);
  if (!match) return Boolean(url);
  const rel = match[1].split(/[?#]/)[0] ?? '';
  if (!rel || rel.includes('..')) return false;
  return existsSync(join(GENERATED_DIR, ...rel.split('/').filter(Boolean)));
}

function hasPlayerPortrait(player: Pick<GlobalPlayerProfile, 'photoUrl' | 'imageUrl' | 'avatarUrl' | 'portraitUrl'>): boolean {
return [player.portraitUrl, player.photoUrl, player.imageUrl, player.avatarUrl].some(generatedUrlPathExists);
}

function existingPlayerPortraitUrl(player: GlobalPlayerProfile): string | undefined {
  for (const url of [player.portraitUrl, player.photoUrl, player.imageUrl, player.avatarUrl]) {
    if (generatedUrlPathExists(url)) return String(url);
  }
  const idUrl = `/generated/players/${safeAssetName(player.id)}/portrait.jpg`;
  if (existsSync(join(GENERATED_DIR, 'players', safeAssetName(player.id), 'portrait.jpg'))) return idUrl;
  const nameKey = safeAssetName(player.playerName);
  for (const other of globalPlayers.values()) {
    if (other.id === player.id || safeAssetName(other.playerName) !== nameKey) continue;
    for (const url of [other.portraitUrl, other.photoUrl, other.imageUrl, other.avatarUrl]) {
      if (generatedUrlPathExists(url)) return String(url);
    }
    const otherPath = join(GENERATED_DIR, 'players', safeAssetName(other.id), 'portrait.jpg');
    if (existsSync(otherPath)) return `/generated/players/${safeAssetName(other.id)}/portrait.jpg`;
  }
  return undefined;
}

function safeAssetName(value: string): string {
  return String(value || 'asset').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'asset';
}

function hashNumber(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  return Math.abs(h) % 999999;
}

function buildPlayerPortraitPrompt(player: GlobalPlayerProfile): string {
  const parts = [
    `A respectful head-and-shoulders character portrait of ${player.playerName}.`,
    `${player.playerAge}-year-old ${player.playerGender || 'person'}.`,
    player.playerOccupation ? `Occupation: ${player.playerOccupation}.` : '',
    player.playerAppearance ? `Appearance: ${player.playerAppearance}.` : '',
    player.playerBackstory ? `Background mood: ${player.playerBackstory.slice(0, 220)}.` : '',
    'Cinematic realistic portrait, face clearly visible, neutral background, natural lighting, no text, no watermark.',
  ].filter(Boolean);
  return parts.join(' ');
}

async function ensureGlobalPlayerPortrait(player: GlobalPlayerProfile): Promise<GlobalPlayerProfile> {
  const existingUrl = existingPlayerPortraitUrl(player);
  if (existingUrl) {
    if (player.portraitUrl === existingUrl) return player;
    const next = { ...player, portraitUrl: existingUrl, updatedAt: new Date().toISOString() };
    globalPlayers.set(next.id, next);
    saveGlobalPlayers(globalPlayers);
    return next;
  }
  const portraitDir = join(GENERATED_DIR, 'players', safeAssetName(player.id));
  const portraitPath = join(portraitDir, 'portrait.jpg');
  const portraitUrl = `/generated/players/${safeAssetName(player.id)}/portrait.jpg`;
  if (existsSync(portraitPath)) {
    const next = { ...player, portraitUrl, updatedAt: new Date().toISOString() };
    globalPlayers.set(next.id, next);
    saveGlobalPlayers(globalPlayers);
    return next;
  }
  try {
    console.log('[imageGen] player portrait:', player.playerName);
    const img = await generateImage(buildPlayerPortraitPrompt(player), {
      width: 512,
      height: 512,
      seed: hashNumber(player.id || player.playerName),
      timeoutMs: 45000,
    });
    if (!img.dataUrl || !saveDataUrlImage(img.dataUrl, portraitPath)) return player;
    const next = { ...player, portraitUrl, updatedAt: new Date().toISOString() };
    globalPlayers.set(next.id, next);
    saveGlobalPlayers(globalPlayers);
    return next;
  } catch (err) {
    console.warn('[imageGen] player portrait failed', player.id, String(err).slice(0, 200));
    return player;
  }
}

async function repairMissingGlobalPlayerPortraits(): Promise<void> {
  const missing = Array.from(globalPlayers.values()).filter(player => !hasPlayerPortrait(player));
  if (!missing.length) return;
  console.log(`[imageGen] repairing ${missing.length} missing player portrait(s)`);
  let repaired = 0;
  for (const player of missing) {
    const before = hasPlayerPortrait(player);
    const next = await ensureGlobalPlayerPortrait(player);
    if (!before && hasPlayerPortrait(next)) repaired++;
  }
  console.log(`[imageGen] repaired ${repaired}/${missing.length} missing player portrait(s)`);
}

function listVisibleGlobalPlayers(): GlobalPlayerProfile[] {
  enforceAllGlobalQuestLimits();
  const seen = new Set<string>();
  return Array.from(globalPlayers.values())
    .map(player => ({
      ...player,
      activeGlobalQuests: activeGlobalQuestRecordsForPlayer(player.id).slice(0, MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER).map(record => cloneData(record.quest)),
    } as any))
    .filter(player => player.source === 'manual' || (player.medals?.length ?? 0) > 0 || (player.achievements?.length ?? 0) > 0 || (player.questFacts?.length ?? 0) > 0 || (player.questHistory?.length ?? 0) > 0)
    .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))
    .filter(player => {
      const key = buildPlayerProfileKey(player as any);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function defaultWorldDate(world: WorldDNA): string {
  return formatWorldDate({ year: world.era.yearStart, month: 7, day: 15 });
}

const REAL_MS_PER_WORLD_MINUTE = 15_000;
const MAX_PASSIVE_CLOCK_MINUTES = 240;

function normaliseClockHour(value: unknown, fallback = 8): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return ((n % 24) + 24) % 24;
}

function normaliseClockMinute(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(59, n));
}

function defaultWorldStartHour(world: WorldDNA): number {
  const periods = world.timeOfDay?.periods ?? [];
  const preferred = periods.find(period => /morning|dawn|day|opening|start/i.test(period.name ?? ''));
  return normaliseClockHour(preferred?.hourStart, 8);
}

function ensureWorldClock(world: WorldDNA): void {
  world.currentDate ??= defaultWorldDate(world);
  world.currentTime = normaliseClockHour(world.currentTime, defaultWorldStartHour(world));
  world.currentMinute = normaliseClockMinute(world.currentMinute);
  const now = new Date().toISOString();
  world.clockStartedAt ??= now;
  world.lastClockSyncAt ??= world.clockStartedAt;
  world.currentWeather = cloneData(
    world.currentWeather ?? initialWeather(world, world.currentDate, world.currentTime),
  );
}

function advanceClockFields(target: { currentDate: string; currentTime: number; currentMinute?: number; dayCount?: number }, minutes: number): { days: number; hours: number } {
  const wholeMinutes = Math.max(0, Math.floor(minutes));
  if (wholeMinutes <= 0) return { days: 0, hours: 0 };
  const beforeHour = normaliseClockHour(target.currentTime, 0);
  const beforeMinute = normaliseClockMinute(target.currentMinute);
  const beforeTotalMinutes = beforeHour * 60 + beforeMinute;
  const totalMinutes = beforeTotalMinutes + wholeMinutes;
  const days = Math.floor(totalMinutes / 1440);
  const dayMinute = ((totalMinutes % 1440) + 1440) % 1440;
  target.currentTime = Math.floor(dayMinute / 60);
  target.currentMinute = dayMinute % 60;
  if (days > 0) {
    target.currentDate = addDays(target.currentDate, days);
    if (typeof target.dayCount === 'number') target.dayCount += days;
  }
  const hours = Math.floor(totalMinutes / 60) - Math.floor(beforeTotalMinutes / 60);
  return { days, hours };
}

function ageNpcRelationshipsForDays(session: WorldSession, world: WorldDNA, days: number): void {
  if (days <= 0) return;
  for (const npc of world.npcs) {
    const state = session.npcStates[npc.id];
    if (state?.lastInteractionDate) state.daysSinceLastSeen += days;
  }
}

function advanceSessionClock(session: WorldSession, world: WorldDNA, minutes: number): { days: number; hours: number } {
  session.currentTime = normaliseClockHour(session.currentTime, defaultWorldStartHour(world));
  session.currentMinute = normaliseClockMinute(session.currentMinute);
  const advanced = advanceClockFields(session, minutes);
  if (advanced.days > 0) ageNpcRelationshipsForDays(session, world, advanced.days);
  if (advanced.hours > 0 || advanced.days > 0) {
    session.currentWeather = advanceWeather(world, session.currentWeather, session.currentDate, session.currentTime, Math.max(1, advanced.hours));
  }
  const now = new Date().toISOString();
  session.clockStartedAt ??= now;
  session.lastClockSyncAt = now;
  return advanced;
}

function advanceWorldClockToNow(world: WorldDNA): number {
  ensureWorldClock(world);
  const last = Date.parse(world.lastClockSyncAt ?? world.clockStartedAt ?? '');
  const nowMs = Date.now();
  if (!Number.isFinite(last) || nowMs <= last) {
    world.lastClockSyncAt = new Date(nowMs).toISOString();
    return 0;
  }
  const rawMinutes = Math.floor((nowMs - last) / REAL_MS_PER_WORLD_MINUTE);
  if (rawMinutes <= 0) return 0;
  const minutes = Math.min(rawMinutes, MAX_PASSIVE_CLOCK_MINUTES);
  const advanced = advanceClockFields(world as any, minutes);
  if (advanced.hours > 0 || advanced.days > 0) {
    world.currentWeather = advanceWeather(world, world.currentWeather, world.currentDate!, world.currentTime!, Math.max(1, advanced.hours));
  }
  world.lastClockSyncAt = new Date(rawMinutes > MAX_PASSIVE_CLOCK_MINUTES ? nowMs : last + minutes * REAL_MS_PER_WORLD_MINUTE).toISOString();
  return minutes;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function deriveNpcObject(npc: any): string {
  if (npc.signatureObject) return npc.signatureObject;
  if (npc.prizedPossession) return npc.prizedPossession;
  if (npc.tools) return npc.tools;
  if (npc.hobby) return npc.hobby;
  const occ = (npc.occupation || '').toLowerCase();
  if (/pub|landlord|bar/.test(occ)) return 'a worn set of brass pub keys and a beer towel';
  if (/factory|production|worker/.test(occ)) return 'a pair of heavy work gloves and safety goggles';
  if (/shop|assistant|retail/.test(occ)) return 'a price label gun and shop apron';
  if (/teacher|school|education/.test(occ)) return 'a red marking pen and stack of exercise books';
  if (/child|student|pupil/.test(occ)) return 'a scuffed school bag with keyrings attached';
  if (/unemployed|jobseeker/.test(occ)) return 'a crumpled newspaper folded to the jobs page';
  if (/manager/.test(occ)) return 'a clipboard with rotas and a set of office keys';
  if (/police|officer|constab/.test(occ)) return 'a police radio and notebook';
  if (/nurse|doctor|medical/.test(occ)) return 'a stethoscope draped over a clipboard';
  if (/cook|chef|kitchen/.test(occ)) return 'a well-used kitchen knife and chopping board';
  if (/driver|taxi|bus/.test(occ)) return 'a set of car keys and a road atlas';
  if (/farm|agri/.test(occ)) return 'a pair of muddy wellingtons and a flat cap';
  if (/build|construct|plumb|electri/.test(occ)) return 'a toolbelt with hammer and tape measure';
  if (/music|band|sing/.test(occ)) return 'a battered guitar case';
  if (/fish/.test(occ)) return 'a tackle box and fishing rod';
  if (/mine|pit|coal/.test(occ)) return 'a dented miners lamp and hard hat';
  if (/clergy|vicar|priest|church/.test(occ)) return 'a worn bible and a set of church keys';
  if (/post|mail/.test(occ)) return 'a red post bag and bundle of letters';
  if (/hair|barber|salon/.test(occ)) return 'a pair of scissors and a comb';
  if (/mechan|garage/.test(occ)) return 'a socket wrench set covered in oil';
  if (/journal|report|writ/.test(occ)) return 'a reporters notebook and ballpoint pen';
  return 'a well-worn personal keepsake';
}

function cleanPromptField(s: string): string {
  return (s || '').replace(/[()'"‘’“”]/g, '').replace(/\s+/g, ' ').trim();
}

function isAdultSwimwearNpc(npc: Pick<WorldNPC, 'age' | 'gender' | 'occupation' | 'physicalDescription'>): boolean {
  return Number(npc.age) >= 18
    && !/\b(child|teen|minor|schoolgirl|schoolboy)\b/i.test(`${npc.gender} ${npc.occupation} ${npc.physicalDescription}`);
}

function swimwearPromptSubject(npc: Pick<WorldNPC, 'gender'>): { subject: string; clothing: string } {
  const isMale = /\b(male|man|boy)\b/i.test(String(npc.gender || ''));
  return isMale
    ? { subject: 'adult man', clothing: 'wearing fitted swim briefs or swim trunks' }
    : { subject: 'adult woman', clothing: 'wearing a very small bathing suit or string bikini' };
}

function ensureNpcImages(world: WorldDNA): boolean {
  let changed = false;
  const era = cleanPromptField(world.era?.period || '');
  const region = cleanPromptField(world.geography?.region || world.geography?.country || '');
  for (const npc of world.npcs || []) {
    const needsSwimwear = isAdultSwimwearNpc(npc) && !npc.images?.swimwear;
    if (npc.images?.portrait && npc.images?.keepsake && npc.images?.object && !needsSwimwear) continue;

    const imgs = npc.images || {} as any;

    for (const key of ['portrait', 'keepsake', 'object', 'swimwear'] as const) {
      if (isUnsafeProxyImageUrl(imgs[key])) {
        imgs[key] = '';
        changed = true;
      }
    }

    if (!imgs.portrait) {
      const localPortrait = (world as any).images?.portraits?.[npc.id];
      if (localPortrait) {
        imgs.portrait = localPortrait;
      }
    }

    if (isAdultSwimwearNpc(npc) && !imgs.swimwear) {
      const localSwimwear = (world as any).images?.swimwearPortraits?.[npc.id];
      if (localSwimwear) {
        imgs.swimwear = localSwimwear;
      }
    }

    const oldImgs = JSON.stringify(npc.images);
    npc.images = imgs;
    if (JSON.stringify(npc.images) !== oldImgs) changed = true;
  }
  return changed;
}

function syncSharedNpcStateIntoSession(session: WorldSession, world: WorldDNA): void {
  const validNpcIds = new Set(world.npcs.map(n => n.id));
  if (!world.npcSharedStates) {
    // Seed shared state from session — but ONLY for NPCs that exist in the
    // world. Without this filter, any orphan keys in session.npcStates (from
    // stale sessions, hallucinated IDs, or quest-fork remnants) would persist
    // forever in world.npcSharedStates and propagate back into every future
    // sync, creating sticky orphan state.
    world.npcSharedStates = Object.fromEntries(
      Object.entries(session.npcStates)
        .filter(([npcId]) => validNpcIds.has(npcId))
        .map(([npcId, state]) => [npcId, toPersistentNpcSharedState(state)])
    );
  }

  for (const [npcId, sharedState] of Object.entries(world.npcSharedStates ?? {})) {
    if (!validNpcIds.has(npcId)) continue;
    // A /talk turn holds this NPC's lock and is mutating its state object in place;
    // replacing it now would detach those writes. The next sync picks it up.
    if (npcLocks.has(npcId)) continue;
    const currentState = session.npcStates[npcId];
    if (!currentState) continue;
    session.npcStates[npcId] = mergeDefined(cloneData(currentState), cloneData(toHydratableNpcSharedState(sharedState as any)));
  }
}

function syncCharacterProfileIntoSession(session: WorldSession, world: WorldDNA): void {
  const profile = world.playerProfiles?.[getSessionPlayerProfileKey(session)];
  copyGlobalProgressToSession(session, session.globalPlayerId ? globalPlayers.get(session.globalPlayerId) : undefined);
  if (!profile) return;

  for (const [npcId, characterState] of Object.entries(profile.npcStates ?? {})) {
    if (npcLocks.has(npcId)) continue;
    const currentState = session.npcStates[npcId];
    if (!currentState) continue;
    session.npcStates[npcId] = mergeDefined(cloneData(currentState), cloneData(characterState));
  }

  if (!session.globalPlayerId) {
    session.playerAppearance = profile.playerAppearance ?? session.playerAppearance;
    session.playerDepartureStyle = profile.playerDepartureStyle ?? session.playerDepartureStyle;
    session.strangePossessions = cloneData(profile.strangePossessions ?? session.strangePossessions ?? []);
  }
  session.impossibleGiftsGiven = cloneData(profile.impossibleGiftsGiven ?? session.impossibleGiftsGiven ?? []);
  session.activeGodEffects = cloneData(profile.activeGodEffects ?? session.activeGodEffects ?? []);
  session.money = profile.money ?? session.money;
  session.isAlive = profile.isAlive ?? session.isAlive;
  session.socialClass = profile.socialClass ?? session.socialClass;
  session.reputation = profile.reputation ?? session.reputation;
  session.visitedLocations = cloneData(profile.visitedLocations ?? session.visitedLocations ?? []);
  session.dayCount = profile.dayCount ?? session.dayCount;
  session.significantEvents = cloneData(profile.significantEvents ?? session.significantEvents ?? []);
  session.objectiveEvents = cloneData(profile.objectiveEvents ?? session.objectiveEvents ?? []);
  session.playerVisitLog = cloneData(profile.playerVisitLog ?? session.playerVisitLog ?? []);
  session.lastActiveAt = profile.lastActiveAt ?? session.lastActiveAt;
}

function syncSessionFromWorld(session: WorldSession, world: WorldDNA): void {
  advanceWorldClockToNow(world);
  ensureWorldClock(world);
  syncSharedNpcStateIntoSession(session, world);
  syncCharacterProfileIntoSession(session, world);
  ensureSessionNpcStateIntegrity(session, world);
  session.currentDate = world.currentDate!;
  session.currentTime = world.currentTime!;
  session.currentMinute = world.currentMinute ?? 0;
  session.clockStartedAt = world.clockStartedAt;
  session.lastClockSyncAt = world.lastClockSyncAt;
  session.currentWeather = cloneData(world.currentWeather);
}

function compareWorldMoments(
  leftDate: string | undefined,
  leftTime: number | undefined,
  rightDate: string | undefined,
  rightTime: number | undefined,
): number {
  if (!leftDate && !rightDate) return 0;
  if (!leftDate) return -1;
  if (!rightDate) return 1;

  try {
    const left = parseWorldDate(leftDate);
    const right = parseWorldDate(rightDate);
    if (left.year !== right.year) return left.year > right.year ? 1 : -1;
    if (left.month !== right.month) return left.month > right.month ? 1 : -1;
    if (left.day !== right.day) return left.day > right.day ? 1 : -1;
  } catch {
    return 0;
  }

  const safeLeftTime = leftTime ?? 0;
  const safeRightTime = rightTime ?? 0;
  if (safeLeftTime === safeRightTime) return 0;
  return safeLeftTime > safeRightTime ? 1 : -1;
}

function isSessionSnapshotNewerThanProfile(session: WorldSession, profile: PersistentPlayerProfile): boolean {
  const snapshotComparison = compareWorldMoments(
    session.currentDate,
    session.currentTime,
    profile.currentDate,
    profile.currentTime,
  );
  if (snapshotComparison !== 0) return snapshotComparison > 0;
  return (session.dayCount ?? 0) > (profile.dayCount ?? 0);
}

function isSessionNewer(candidate: WorldSession, current?: WorldSession): boolean {
  if (!current) return true;
  const candidateDayCount = candidate.dayCount ?? 0;
  const currentDayCount = current.dayCount ?? 0;
  if (candidateDayCount !== currentDayCount) return candidateDayCount > currentDayCount;
  const candidateTime = candidate.currentTime ?? 0;
  const currentTime = current.currentTime ?? 0;
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return candidate.id > current.id;
}

function backfillWorldPersistenceFromSessions(): void {
  const latestWorldSessions = new Map<string, WorldSession>();
  const latestProfileSessions = new Map<string, Map<string, WorldSession>>();

  for (const session of sessions.values()) {
    const world = worlds.get(session.worldId);
    if (!world) continue;
    if (isSessionNewer(session, latestWorldSessions.get(session.worldId))) {
      latestWorldSessions.set(session.worldId, session);
    }
    const key = getSessionPlayerProfileKey(session);
    const perWorldProfiles = latestProfileSessions.get(session.worldId) ?? new Map<string, WorldSession>();
    if (isSessionNewer(session, perWorldProfiles.get(key))) {
      perWorldProfiles.set(key, session);
    }
    latestProfileSessions.set(session.worldId, perWorldProfiles);
  }

  for (const [worldId, world] of worlds) {
    let changed = false;
    const latestSession = latestWorldSessions.get(worldId);
    if (latestSession) {
      const latestSessionIsNewer = compareWorldMoments(
        latestSession.currentDate,
        latestSession.currentTime,
        world.currentDate,
        world.currentTime,
      ) > 0;
      if (world.currentDate === undefined || world.currentTime === undefined || world.currentWeather === undefined || latestSessionIsNewer) {
        syncWorldClockFromSession(world, latestSession);
        changed = true;
      }
      if (!world.npcSharedStates || latestSessionIsNewer) {
        world.npcSharedStates = Object.fromEntries(
          Object.entries(latestSession.npcStates).map(([npcId, state]) => [npcId, toPersistentNpcSharedState(state)])
        );
        changed = true;
      } else {
        for (const [npcId, state] of Object.entries(latestSession.npcStates)) {
          if (!world.npcSharedStates[npcId]) {
            world.npcSharedStates[npcId] = toPersistentNpcSharedState(state);
            changed = true;
          }
        }
      }
    } else {
      ensureWorldClock(world);
    }

    world.playerProfiles ??= {};
    for (const [key, session] of latestProfileSessions.get(worldId) ?? new Map<string, WorldSession>()) {
      const existingProfile = world.playerProfiles[key];
      if (!existingProfile || isSessionSnapshotNewerThanProfile(session, existingProfile)) {
        syncPlayerProfileFromSession(world, session);
        changed = true;
      }
    }

    if (changed) saveWorld(world);
  }
}

function syncWorldClockFromSession(world: WorldDNA, session: WorldSession): void {
  ensureWorldClock(world);
  world.currentDate = session.currentDate;
  world.currentTime = session.currentTime;
  world.currentMinute = session.currentMinute ?? 0;
  world.clockStartedAt = session.clockStartedAt ?? world.clockStartedAt;
  world.lastClockSyncAt = session.lastClockSyncAt ?? new Date().toISOString();
  world.currentWeather = cloneData(
    session.currentWeather ?? initialWeather(world, session.currentDate, session.currentTime),
  );
}

function toPersistentNpcSharedState(state: Pick<NPCLiveState, 'npcId' | 'worldId' | 'mood' | 'currentLocationId' | 'currentActivity' | 'isAvailable' | 'recentLifeEvents' | 'currentWorry' | 'currentGoal' | 'activeGoals' | 'environmentalAwareness' | 'bodyHabits' | 'emotionalContagionLog' | 'innerLife' | 'activeConversation'>): PersistentNpcSharedState {
  return {
    npcId: state.npcId,
    worldId: state.worldId,
    mood: state.mood,
    currentLocationId: state.currentLocationId,
    currentActivity: state.currentActivity,
    isAvailable: state.isAvailable,
    recentLifeEvents: cloneData(state.recentLifeEvents ?? []),
    currentWorry: state.currentWorry,
    currentGoal: state.currentGoal,
    activeGoals: cloneData(state.activeGoals ?? []),
    environmentalAwareness: cloneData(state.environmentalAwareness),
    bodyHabits: cloneData(state.bodyHabits),
    emotionalContagionLog: cloneData(state.emotionalContagionLog ?? []),
    innerLife: cloneData(state.innerLife),
    activeConversation: cloneData(state.activeConversation ?? []),
  };
}

function toHydratableNpcSharedState(sharedState: PersistentNpcSharedState): Partial<NPCLiveState> {
  const { innerLife: _innerLife, activeConversation: _activeConversation, ...hydratable } = toPersistentNpcSharedState(sharedState as any);
  return hydratable as Partial<NPCLiveState>;
}

function conversationHistoryFromState(state: Pick<NPCLiveState, 'conversationHistory' | 'memories'>): NPCMemory[] {
  if (state.conversationHistory?.length) return cloneData(state.conversationHistory);
  return cloneData((state.memories ?? []).filter(memory =>
    Boolean(memory.playerMessage || memory.npcReply || memory.interactionKind || memory.kind),
  ));
}

function toPersistentNpcCharacterState(state: Pick<NPCLiveState, 'npcId' | 'worldId' | 'mood' | 'currentLocationId' | 'currentActivity' | 'isAvailable' | 'relationship' | 'trustLevel' | 'familiarity' | 'warmth' | 'respect' | 'attraction' | 'fear' | 'memories' | 'conversationHistory' | 'totalInteractions' | 'lastInteractionDate' | 'daysSinceLastSeen' | 'playerFacts' | 'playerOpinion' | 'gossipHeard' | 'gossipShared' | 'recentLifeEvents' | 'currentWorry' | 'currentGoal' | 'activeGoals' | 'promises' | 'patternsNoticed' | 'playerVisitFrequency' | 'playerAvoidanceScore' | 'lastLocationsSeen' | 'environmentalAwareness' | 'bodyHabits' | 'pendingApproach' | 'npcRequests' | 'emotionalContagionLog' | 'activeConversation' | 'impossibleGiftsReceived' | 'innerLife'>): PersistentNpcCharacterState {
  return {
    npcId: state.npcId,
    worldId: state.worldId,
    mood: state.mood,
    currentLocationId: state.currentLocationId,
    currentActivity: state.currentActivity,
    isAvailable: state.isAvailable,
    relationship: state.relationship,
    trustLevel: state.trustLevel,
    familiarity: state.familiarity,
    warmth: state.warmth,
    respect: state.respect,
    attraction: state.attraction,
    fear: state.fear,
    memories: cloneData(state.memories ?? []),
    conversationHistory: conversationHistoryFromState(state),
    totalInteractions: state.totalInteractions,
    lastInteractionDate: state.lastInteractionDate,
    daysSinceLastSeen: state.daysSinceLastSeen,
    playerFacts: cloneData(state.playerFacts ?? []),
    playerOpinion: state.playerOpinion,
    gossipHeard: cloneData(state.gossipHeard ?? []),
    gossipShared: cloneData(state.gossipShared ?? []),
    recentLifeEvents: cloneData(state.recentLifeEvents ?? []),
    currentWorry: state.currentWorry,
    currentGoal: state.currentGoal,
    activeGoals: cloneData(state.activeGoals ?? []),
    promises: cloneData(state.promises ?? []),
    patternsNoticed: cloneData(state.patternsNoticed ?? []),
    playerVisitFrequency: state.playerVisitFrequency,
    playerAvoidanceScore: state.playerAvoidanceScore,
    lastLocationsSeen: cloneData(state.lastLocationsSeen ?? []),
    environmentalAwareness: cloneData(state.environmentalAwareness),
    bodyHabits: cloneData(state.bodyHabits),
    pendingApproach: cloneData(state.pendingApproach),
    npcRequests: cloneData(state.npcRequests ?? []),
    emotionalContagionLog: cloneData(state.emotionalContagionLog ?? []),
    activeConversation: cloneData(state.activeConversation ?? []),
    impossibleGiftsReceived: cloneData(state.impossibleGiftsReceived ?? []),
    innerLife: cloneData(state.innerLife),
  };
}

function createInitialInnerLife(npc: WorldNPC) {
  const il = createDefaultInnerLife(
    npc.attachmentStyle ?? 'secure',
    npc.processingType ?? 'moderate_rumination',
    (npc.primaryDefense ?? 'rationalization') as any,
    npc.selfAwarenessLevel,
  );
  const defenseTriggers = (npc.primaryDefense ?? 'rationalization') as any;
  if (npc.coreWound) {
    // Primary wound from coreWound, plus up to 2 secondary wounds (doc: 1-3 wounds).
    // triggerWords and triggerSituations are now distinct rather than aliased.
    il.wounds = [
      {
        description: npc.coreWound,
        age: Math.max(5, npc.age - 20),
        processed: false,
        triggerWords: npc.woundTriggers ?? [],
        triggerSituations: (npc.woundSituations?.length ? npc.woundSituations : npc.woundTriggers) ?? [],
        defenseTriggers,
        surfaceBehaviour: `Becomes ${npc.temperament} and uses ${npc.primaryDefense}`,
      },
      ...(npc.additionalWounds ?? []).slice(0, 2).map(w => ({
        description: w.description,
        age: Math.max(5, npc.age - 20),
        processed: false,
        triggerWords: w.triggerWords ?? [],
        triggerSituations: (w.triggerSituations?.length ? w.triggerSituations : w.triggerWords) ?? [],
        defenseTriggers,
        surfaceBehaviour: `Becomes ${npc.temperament} and uses ${npc.primaryDefense}`,
      })),
    ];
    il.attachment.coreWound = npc.coreWound;
    il.attachment.triggerPatterns = [
      ...(npc.woundTriggers ?? []),
      ...(npc.woundSituations ?? []),
    ];
  }
  il.selfConcept = npc.selfConcept ?? [];
  il.values = npc.values ?? [];
  il.selfNarrative = npc.backstory ?? '';
  return normalizeInnerLife(il);
}

function createInitialBodyHabits(npc: WorldNPC) {
  const seed = stableHash(npc.id || npc.name || 'npc');
  const anxious = /anxious|nervous|fear|wary|shy|ashamed|reserved|private/i.test([
    npc.temperament,
    npc.primaryDefense,
    npc.coreWound,
    ...(npc.fears ?? []),
    ...(npc.traits ?? []),
  ].filter(Boolean).join(' '));
  return {
    bladder: 10 + (seed % 18),
    bowel: 8 + ((seed >>> 3) % 22),
    regularity: 45 + ((seed >>> 5) % 45),
    privacyNeed: anxious ? 72 : 38 + ((seed >>> 7) % 40),
    shameSensitivity: anxious ? 68 : 22 + ((seed >>> 9) % 44),
    stressSensitivity: anxious ? 74 : 25 + ((seed >>> 11) % 50),
    avoidance: anxious ? 32 : 8 + ((seed >>> 13) % 25),
    recentEvents: [],
    toiletVisits: [],
    bowelMovements: [],
  };
}

function seedAverageBodyHabitEvents(session: WorldSession, npc: WorldNPC, state: NPCLiveState): void {
  state.bodyHabits ??= createInitialBodyHabits(npc);
  const body = state.bodyHabits;
  body.recentEvents ??= [];
  body.toiletVisits ??= [];
  body.bowelMovements ??= [];
  if (!body.toiletVisits.length) {
    const visit = {
      date: session.currentDate,
      timeOfDay: 'morning',
      locationId: state.currentLocationId || session.currentLocationId,
      reason: 'average daily routine',
      bladderBefore: Math.max(35, Math.round(body.bladder ?? 45)),
      bowelBefore: Math.max(30, Math.round(body.bowel ?? 40)),
      privacyStress: Math.round(privacyStressForBody(state)),
    };
    body.toiletVisits.push(visit);
    body.lastToiletAt = `${visit.date} ${visit.timeOfDay}`;
    body.lastNote = `${npc.name} has an average daily toilet routine recorded.`;
  }
  if (!body.bowelMovements.length) {
    const movement = {
      date: session.currentDate,
      timeOfDay: 'morning',
      locationId: state.currentLocationId || session.currentLocationId,
      reason: 'average daily routine',
      bowelBefore: Math.max(35, Math.round(body.bowel ?? 45)),
    };
    body.bowelMovements.push(movement);
    body.lastBowelAt = `${movement.date} ${movement.timeOfDay}`;
    body.lastNote = `${npc.name} has average toilet and bowel routines recorded.`;
  }
  body.recentEvents = Array.from(new Set([
    ...(body.recentEvents ?? []),
    `${npc.name} baseline body routine established from average daily habits.`,
  ])).slice(-20);
}

function createInitialNpcStates(world: WorldDNA, startLocationId: string): Record<string, NPCLiveState> {
  const validLocationIds = new Set(world.locations.map(location => location.id));
  const npcStates: Record<string, NPCLiveState> = {};

  const morningLocation = (npc: WorldNPC): string => {
    if (npc.workLocationId && validLocationIds.has(npc.workLocationId)) return npc.workLocationId;
    if (npc.homeLocationId && validLocationIds.has(npc.homeLocationId)) return npc.homeLocationId;
    return startLocationId;
  };

  for (const npc of world.npcs) {
    npcStates[npc.id] = {
      npcId: npc.id,
      worldId: world.id,
      relationship: 'stranger',
      trustLevel: 0,
      familiarity: 0,
      warmth: 50,
      respect: 50,
      attraction: 0,
      fear: 0,
      mood: npc.baselineMood,
      currentLocationId: morningLocation(npc),
      currentActivity: npc.dailyRoutine?.morning ?? 'going about their day',
      isAvailable: true,
      memories: [],
      conversationHistory: [],
      totalInteractions: 0,
      lastInteractionDate: '',
      daysSinceLastSeen: 0,
      playerFacts: [],
      playerOpinion: '',
      gossipHeard: [],
      gossipShared: [],
      recentLifeEvents: [],
      currentWorry: npc.coreConcerns?.[0] ?? '',
      currentGoal: npc.desires?.[0] ?? '',
      activeGoals: (npc.desires ?? []).slice(0, 2).map((desire, index) => ({
        id: `${npc.id}_goal_${index + 1}`,
        description: desire,
        motivation: npc.coreConcerns?.[index] ?? npc.backstory ?? 'personal reasons',
        type: 'personal' as const,
        progress: 0,
        startedDate: '',
        blockers: npc.fears?.slice(0, 2) ?? [],
        willingness: 70,
        secretGoal: false,
        dailyActions: [],
        locationPreferences: npc.frequentedLocations ?? [],
        avoidLocations: [],
        socialBehaviour: npc.temperament ?? 'ordinary',
      })),
      playerVisitFrequency: 0,
      playerAvoidanceScore: 0,
      lastLocationsSeen: [],
      environmentalAwareness: {
        knownScarcities: [],
        recentArrivals: [],
        recentDepartures: [],
        locationChanges: [],
        lastWeatherReaction: '',
      },
      bodyHabits: createInitialBodyHabits(npc),
      npcRequests: [],
      emotionalContagionLog: [],
      promises: [],
      patternsNoticed: [],
      innerLife: createInitialInnerLife(npc),
    };
  }

  return npcStates;
}

function ensureSessionNpcStateIntegrity(session: WorldSession, world: WorldDNA): void {
  const fallbackLocationId = session.currentLocationId || world.locations[0]?.id || '';
  const baseStates = createInitialNpcStates(world, fallbackLocationId);
  session.npcStates ??= {};

  for (const npc of world.npcs) {
    const baseState = cloneData(baseStates[npc.id]);
    const currentState = session.npcStates[npc.id];
    if (!currentState) {
      session.npcStates[npc.id] = baseState;
      continue;
    }

    const hydrated = mergeDefined(baseState, cloneData(currentState));
    hydrated.memories = currentState.memories ?? baseState.memories;
    hydrated.conversationHistory = conversationHistoryFromState(hydrated);
    hydrated.innerLife = normalizeInnerLife(currentState.innerLife ?? baseState.innerLife);
    hydrated.bodyHabits = mergeDefined(baseState.bodyHabits, cloneData(currentState.bodyHabits ?? {})) ?? createInitialBodyHabits(npc);
    hydrated.bodyHabits.recentEvents = currentState.bodyHabits?.recentEvents ?? [];
    hydrated.bodyHabits.toiletVisits = currentState.bodyHabits?.toiletVisits ?? [];
    hydrated.bodyHabits.bowelMovements = currentState.bodyHabits?.bowelMovements ?? [];
    seedAverageBodyHabitEvents(session, npc, hydrated);
    session.npcStates[npc.id] = hydrated;
  }
}

function buildSessionNpcStates(
  world: WorldDNA,
  startLocationId: string,
  savedProfile?: PersistentPlayerProfile,
): Record<string, NPCLiveState> {
  const baseStates = createInitialNpcStates(world, startLocationId);

  for (const [npcId, baseState] of Object.entries(baseStates)) {
    const sharedState = world.npcSharedStates?.[npcId]
      ? toHydratableNpcSharedState(world.npcSharedStates[npcId] as any)
      : undefined;
    const characterState = savedProfile?.npcStates?.[npcId]
      ? toPersistentNpcCharacterState(savedProfile.npcStates[npcId] as any)
      : undefined;

    const mergedState = mergeDefined(cloneData(baseState), cloneData(sharedState ?? {}));
    baseStates[npcId] = mergeDefined(mergedState, cloneData(characterState ?? {}));
  }

  return baseStates;
}

function syncPlayerProfileFromSession(world: WorldDNA, session: WorldSession): PersistentPlayerProfile {
  world.playerProfiles ??= {};
  const key = getSessionPlayerProfileKey(session);
  const existing = world.playerProfiles[key];
  const now = new Date().toISOString();
  const profile: PersistentPlayerProfile = {
    key,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastActiveAt: session.lastActiveAt,
    lastSessionId: session.id,
    playerName: session.playerName,
    playerAge: session.playerAge,
    playerGender: session.playerGender,
    playerOccupation: session.playerOccupation,
    playerBackstory: session.playerBackstory,
    playerAppearance: session.playerAppearance,
    photoUrl: session.photoUrl ?? existing?.photoUrl,
    imageUrl: session.imageUrl ?? existing?.imageUrl,
    avatarUrl: session.avatarUrl ?? existing?.avatarUrl,
    portraitUrl: session.portraitUrl ?? existing?.portraitUrl,
    playerDepartureStyle: session.playerDepartureStyle,
    strangePossessions: cloneData(session.strangePossessions ?? []),
    impossibleGiftsGiven: cloneData(session.impossibleGiftsGiven ?? []),
    activeGodEffects: cloneData(session.activeGodEffects ?? []),
    currentDate: session.currentDate,
    currentTime: session.currentTime,
    currentMinute: session.currentMinute ?? 0,
    currentLocationId: session.currentLocationId,
    currentWeather: cloneData(session.currentWeather),
    money: session.money,
    isAlive: session.isAlive,
    socialClass: session.socialClass,
    reputation: session.reputation,
    npcStates: Object.fromEntries(
      world.npcs
        .map(npc => [npc.id, session.npcStates[npc.id]] as const)
        .filter((entry): entry is readonly [string, NPCLiveState] => Boolean(entry[1]))
        .map(([npcId, state]) => [npcId, toPersistentNpcCharacterState(state)])
    ),
    visitedLocations: cloneData(session.visitedLocations),
    dayCount: session.dayCount,
    significantEvents: cloneData(session.significantEvents),
    objectiveEvents: cloneData(session.objectiveEvents ?? []).slice(-200),
    playerVisitLog: cloneData(session.playerVisitLog ?? []),
  };
  world.playerProfiles[key] = profile;
  return profile;
}

function mergeNpcSharedStates(world: WorldDNA, session: WorldSession): void {
  const existing = world.npcSharedStates ?? {};
  for (const npc of world.npcs) {
    const npcId = npc.id;
    const state = session.npcStates[npcId];
    if (!state) continue;
    const newShared = toPersistentNpcSharedState(state);
    const prev = existing[npcId];
    if (prev?.activeConversation?.length && newShared.activeConversation) {
      const existingTs = new Set(prev.activeConversation.map(e => e.timestamp + e.sessionId));
      const merged = [...prev.activeConversation];
      for (const ex of newShared.activeConversation) {
        if (!existingTs.has(ex.timestamp + ex.sessionId)) merged.push(ex);
      }
      merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      newShared.activeConversation = merged.slice(-30);
    }
    existing[npcId] = newShared;
  }
  world.npcSharedStates = existing;
}

function persistSessionState(session: WorldSession, options: { touch?: boolean } = {}): void {
  if (options.touch !== false) touchSession(session);
  syncGlobalPlayerFromSession(session);
  const world = worlds.get(session.worldId);
  if (world) {
    if (session.activeQuest?.status !== 'active') {
      syncWorldClockFromSession(world, session);
      mergeNpcSharedStates(world, session);
    }
    syncPlayerProfileFromSession(world, session);
    saveWorld(world);
  }
  saveSession(session);
}

function isCharacterSessionActive(session: WorldSession): boolean {
  if (!session.lastActiveAt) return false;
  const at = Date.parse(session.lastActiveAt);
  return !Number.isNaN(at) && (Date.now() - at) <= ACTIVE_CHARACTER_WINDOW_MS;
}

function playerPresenceDescription(session: WorldSession): string {
  const segments = [
    session.playerOccupation,
    session.playerAppearance,
    session.reputation && session.reputation !== 'unknown' ? `known as ${session.reputation}` : '',
  ].filter(Boolean);
  if (segments.length > 0) return segments.join(' • ');
  const backstory = session.playerBackstory?.trim();
  if (backstory) return backstory.slice(0, 180);
  return 'A traveller moving carefully through the world.';
}

function sessionPresenceRank(session: WorldSession): number {
  const activeBoost = isCharacterSessionActive(session) ? 1_000_000_000_000 : 0;
  const activeAt = session.lastActiveAt ? Date.parse(session.lastActiveAt) : 0;
  return activeBoost + (Number.isNaN(activeAt) ? 0 : activeAt);
}

function buildPlayerPresence(world: WorldDNA, session: WorldSession, viewer?: WorldSession): PlayerPresence {
  const currentLocationName = world.locations.find(location => location.id === session.currentLocationId)?.name;
  const isCurrentSession = viewer?.id === session.id;
  const isSameLocation = !!viewer && !isCurrentSession && viewer.currentLocationId === session.currentLocationId;
  const isActive = isCharacterSessionActive(session);

  return {
    sessionId: session.id,
    playerProfileKey: session.playerProfileKey,
    playerName: session.playerName,
    playerOccupation: session.playerOccupation,
    playerAppearance: session.playerAppearance,
    photoUrl: session.photoUrl,
    imageUrl: session.imageUrl,
    avatarUrl: session.avatarUrl,
    portraitUrl: session.portraitUrl,
    description: playerPresenceDescription(session),
    currentLocationId: session.currentLocationId,
    currentLocationName,
    currentDate: session.currentDate,
    currentTime: session.currentTime,
    dayCount: session.dayCount,
    isActive,
    isCurrentSession,
    isSameLocation,
    canCommunicate: isActive && isSameLocation,
  };
}

function listWorldPlayerPresences(world: WorldDNA, viewer?: WorldSession): PlayerPresence[] {
  const latestByCharacter = new Map<string, WorldSession>();
  const npcNames = new Set((world.npcs || []).map((n: any) => (n.name || '').toLowerCase()));
  const npcIds = new Set((world.npcs || []).map((n: any) => n.id));

  for (const candidate of sessions.values()) {
    if (candidate.worldId !== world.id) continue;
    if (npcNames.has((candidate.playerName || '').toLowerCase())) continue;
    if (npcIds.has(candidate.playerProfileKey)) continue;
    const key = candidate.playerProfileKey ?? candidate.id;
    const existing = latestByCharacter.get(key);
    if (!existing || sessionPresenceRank(candidate) > sessionPresenceRank(existing)) {
      latestByCharacter.set(key, candidate);
    }
  }

  return Array.from(latestByCharacter.values())
    .sort((left, right) => sessionPresenceRank(right) - sessionPresenceRank(left))
    .map(candidate => buildPlayerPresence(world, candidate, viewer));
}

function questLocationForSession(quest: QuestSessionState, session: WorldSession) {
  return quest.participantLocations?.[session.id] ?? {
    worldId: quest.currentWorldId,
    locationId: quest.currentLocationId,
  };
}

function connectedLocationIds(world: WorldDNA, locationId: string): string[] {
  const location = world.locations.find(l => l.id === locationId);
  const forward = Array.isArray(location?.connectedTo) ? location.connectedTo : [];
  const reverse = world.locations
    .filter(l => Array.isArray(l.connectedTo) && l.connectedTo.includes(locationId))
    .map(l => l.id);
  return Array.from(new Set([...forward, ...reverse])).filter(id => id !== locationId);
}

function connectedLocationsFor(world: WorldDNA, locationId: string) {
  const ids = new Set(connectedLocationIds(world, locationId));
  return world.locations.filter(location => ids.has(location.id));
}

function normaliseLocationName(name: unknown): string {
  return String(name ?? '').toLowerCase().replace(/['"`’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function ensureCubanMissileCrisisRoute(world: WorldDNA): boolean {
  const isCrisisWorld = normaliseLocationName(world.concept).includes('cuban missile crisis');
  if (!isCrisisWorld) return false;
  const dukes = world.locations.find(location => normaliseLocationName(location.name) === 'dukes trailer park');
  const jacks = world.locations.find(location => normaliseLocationName(location.name) === 'jacks diner');
  if (!dukes || !jacks) return false;
  let changed = false;
  dukes.connectedTo = Array.isArray(dukes.connectedTo) ? dukes.connectedTo : [];
  jacks.connectedTo = Array.isArray(jacks.connectedTo) ? jacks.connectedTo : [];
  if (!dukes.connectedTo.includes(jacks.id)) {
    dukes.connectedTo.push(jacks.id);
    changed = true;
  }
  if (!jacks.connectedTo.includes(dukes.id)) {
    jacks.connectedTo.push(dukes.id);
    changed = true;
  }
  return changed;
}

function buildQuestPlayerPresence(
  quest: QuestSessionState,
  world: WorldDNA,
  candidate: WorldSession,
  viewer?: WorldSession,
): PlayerPresence {
  const candidateLocation = questLocationForSession(quest, candidate);
  const viewerLocation = viewer ? questLocationForSession(quest, viewer) : undefined;
  const locationWorld = quest.forkedWorldData?.[candidateLocation.worldId] ?? world;
  const currentLocationName = locationWorld.locations.find(location => location.id === candidateLocation.locationId)?.name;
  const isActive = isCharacterSessionActive(candidate);
  const isCurrentSession = viewer?.id === candidate.id;
  const isSameLocation = !!viewerLocation
    && viewerLocation.worldId === candidateLocation.worldId
    && viewerLocation.locationId === candidateLocation.locationId;
  return {
    sessionId: candidate.id,
    playerProfileKey: candidate.playerProfileKey,
    playerName: candidate.playerName,
    playerOccupation: candidate.playerOccupation,
    playerAppearance: candidate.playerAppearance,
    photoUrl: candidate.photoUrl,
    imageUrl: candidate.imageUrl,
    avatarUrl: candidate.avatarUrl,
    portraitUrl: candidate.portraitUrl,
    description: playerPresenceDescription(candidate),
    currentLocationId: candidateLocation.locationId,
    currentLocationName,
    currentDate: quest.currentDate ?? candidate.currentDate,
    currentTime: quest.currentTime ?? candidate.currentTime,
    dayCount: quest.dayCount ?? candidate.dayCount,
    isActive,
    isCurrentSession,
    isSameLocation,
    canCommunicate: isActive && isSameLocation && !isCurrentSession,
  };
}

function listQuestPlayerPresences(quest: QuestSessionState, viewer: WorldSession, world: WorldDNA): PlayerPresence[] {
  const latestByCharacter = new Map<string, WorldSession>();
  const participantIds = new Set(quest.participantSessionIds ?? []);
  for (const sessionId of quest.participantSessionIds ?? []) {
    const candidate = sessions.get(sessionId);
    if (!candidate) continue;
    if (candidate.activeQuest?.id !== quest.id && sessionId !== viewer.id) continue;
    const key = candidate.playerProfileKey ?? candidate.id;
    const existing = latestByCharacter.get(key);
    if (!existing || sessionPresenceRank(candidate) > sessionPresenceRank(existing)) {
      latestByCharacter.set(key, candidate);
    }
  }
  const participantPresences = Array.from(latestByCharacter.values())
    .sort((left, right) => sessionPresenceRank(right) - sessionPresenceRank(left))
    .map(candidate => buildQuestPlayerPresence(quest, world, candidate, viewer));
  const baseWorld = worlds.get(viewer.worldId);
  const inviteePresences = baseWorld
    ? listWorldPlayerPresences(baseWorld, viewer)
      .filter(presence => !participantIds.has(presence.sessionId))
      .map(presence => ({
        ...presence,
        currentLocationName: presence.currentLocationName ? `${presence.currentLocationName} (base world)` : 'Base world',
        isSameLocation: false,
        canCommunicate: false,
      }))
    : [];
  return [...participantPresences, ...inviteePresences];
}

function maybeCreateQuestHook(world: WorldDNA, session: WorldSession, force = false) {
  return ensureQuestDiscoveryHook(world, session, worlds.values(), force);
}

function deriveSessionLeads(world: WorldDNA, session: WorldSession, limit = 6): DramaLead[] {
  const questLeads = deriveQuestLeads(session);
  const room = Math.max(0, limit - questLeads.length);
  return [...questLeads, ...deriveDramaLeads(world, session, room)]
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, limit);
}

type SessionRuntimeView = {
  baseWorld: WorldDNA;
  world: WorldDNA;
  locationId: string;
  inQuest: boolean;
};

function ensureNpcStatesForWorld(session: WorldSession, world: WorldDNA, locationId: string): void {
  const baseStates = createInitialNpcStates(world, locationId || world.locations[0]?.id || '');
  const validLocationIds = new Set(world.locations.map(location => location.id));
  const fallbackLocationId = locationId || world.locations[0]?.id || '';
  session.npcStates ??= {};
  for (const npc of world.npcs) {
    const baseState = cloneData(baseStates[npc.id]);
    const sharedState = cloneData(world.npcSharedStates?.[npc.id] ?? {});
    const currentState = session.npcStates[npc.id];
    if (!currentState) {
      session.npcStates[npc.id] = mergeDefined(baseState, sharedState);
      continue;
    }
    const hydrated = mergeDefined(mergeDefined(baseState, sharedState), cloneData(currentState));
    hydrated.memories = currentState.memories ?? baseState.memories;
    hydrated.conversationHistory = conversationHistoryFromState(hydrated);
    hydrated.innerLife = normalizeInnerLife(currentState.innerLife ?? baseState.innerLife);
    hydrated.bodyHabits = mergeDefined(baseState.bodyHabits, cloneData(currentState.bodyHabits ?? {})) ?? createInitialBodyHabits(npc);
    hydrated.bodyHabits.recentEvents = currentState.bodyHabits?.recentEvents ?? [];
    hydrated.bodyHabits.toiletVisits = currentState.bodyHabits?.toiletVisits ?? [];
    hydrated.bodyHabits.bowelMovements = currentState.bodyHabits?.bowelMovements ?? [];
    if (!validLocationIds.has(hydrated.currentLocationId)) hydrated.currentLocationId = fallbackLocationId;
    seedAverageBodyHabitEvents(session, npc, hydrated);
    session.npcStates[npc.id] = hydrated;
  }
}

function sessionRuntimeView(session: WorldSession, baseWorld: WorldDNA): SessionRuntimeView {
  const quest = session.activeQuest?.status === 'active'
    ? canonicalQuestFor(session.activeQuest, session)
    : session.activeQuest;
  if (quest?.status === 'active') {
    const participantLocation = quest.participantLocations?.[session.id];
    const activeWorldId = participantLocation?.worldId ?? quest.currentWorldId;
    const requestedLocationId = participantLocation?.locationId ?? quest.currentLocationId;
    const questWorld = quest.forkedWorldData?.[activeWorldId] ?? worlds.get(activeWorldId);
    if (questWorld && quest.forkedWorldIds.includes(questWorld.id)) {
      quest.currentDate = quest.currentDate ?? questWorld.currentDate ?? session.currentDate;
      quest.currentTime = quest.currentTime ?? questWorld.currentTime ?? session.currentTime;
      quest.dayCount = quest.dayCount ?? session.dayCount;
      quest.currentWeather = cloneData(quest.currentWeather ?? questWorld.currentWeather ?? session.currentWeather);
      questWorld.currentDate = quest.currentDate;
      questWorld.currentTime = quest.currentTime;
      if (quest.currentWeather) questWorld.currentWeather = cloneData(quest.currentWeather);
      session.currentDate = quest.currentDate;
      session.currentTime = quest.currentTime;
      session.dayCount = quest.dayCount;
      if (quest.currentWeather) session.currentWeather = cloneData(quest.currentWeather);
      const fallbackLocationId = questWorld.locations[0]?.id ?? session.currentLocationId;
      const locationId = questWorld.locations.some(location => location.id === requestedLocationId)
        ? requestedLocationId
        : fallbackLocationId;
      quest.participantLocations ??= {};
      quest.participantLocations[session.id] = { worldId: questWorld.id, locationId };
      quest.currentWorldId = questWorld.id;
      quest.currentLocationId = locationId;
      const fork = quest.forkedWorlds[questWorld.id];
      if (fork) {
        fork.currentLocationId = locationId;
        fork.currentLocationName = questWorld.locations.find(location => location.id === locationId)?.name ?? locationId;
        fork.visitedLocationIds = Array.from(new Set([...(fork.visitedLocationIds ?? []), locationId]));
      }
      ensureNpcStatesForWorld(session, questWorld, locationId);
      ensurePlayerLocationNpcPresence(session, questWorld, locationId, resolveTimeOfDay(questWorld, session.currentTime));
      return { baseWorld, world: questWorld, locationId, inQuest: true };
    }
  }
  ensureNpcStatesForWorld(session, baseWorld, session.currentLocationId);
  ensurePlayerLocationNpcPresence(session, baseWorld, session.currentLocationId, resolveTimeOfDay(baseWorld, session.currentTime));
  return { baseWorld, world: baseWorld, locationId: session.currentLocationId, inQuest: false };
}

function canonicalQuestFor(quest: QuestSessionState, session?: WorldSession): QuestSessionState {
  const existing = activeQuests.get(quest.id);
  if (existing) {
    if (session) session.activeQuest = existing;
    return existing;
  }
  activeQuests.set(quest.id, quest);
  if (session) session.activeQuest = quest;
  return quest;
}

function questParticipantIds(quest: QuestSessionState): Set<string> {
  const ids = new Set([quest.ownerSessionId, ...(quest.participantSessionIds ?? [])].filter(Boolean));
  for (const session of sessions.values()) {
    if (session.activeQuest?.id === quest.id) ids.add(session.id);
  }
  return ids;
}

function globalQuestEntryBlock(session: WorldSession): { blocked: boolean; quest?: QuestSessionState; message?: string } {
  const player = session.globalPlayerId ? globalPlayers.get(session.globalPlayerId) : undefined;
  const quest = player?.activeQuest?.status === 'active' ? player.activeQuest : undefined;
  if (!quest) return { blocked: false };
  const participantIds = new Set([quest.ownerSessionId, ...(quest.participantSessionIds ?? [])].filter(Boolean));
  if (session.activeQuest?.id === quest.id || participantIds.has(session.id)) return { blocked: false, quest };
  return {
    blocked: true,
    quest,
    message: 'Finish, leave, or abandon your active quest before entering another world.',
  };
}

function persistQuestParticipants(quest: QuestSessionState, options: { touch?: boolean } = { touch: false }): void {
  const canonical = canonicalQuestFor(quest);
  for (const sessionId of questParticipantIds(canonical)) {
    const participant = sessions.get(sessionId);
    if (!participant || participant.activeQuest?.status !== 'active') continue;
    participant.activeQuest = canonical;
    persistSessionOnly(participant, options);
  }
}

function rebindLoadedQuestInstances(): void {
  activeQuests.clear();
  const grouped = new Map<string, QuestSessionState[]>();
  for (const session of sessions.values()) {
    const quest = session.activeQuest;
    if (!quest || quest.status !== 'active') continue;
    grouped.set(quest.id, [...(grouped.get(quest.id) ?? []), quest]);
  }
  for (const [questId, copies] of grouped) {
    const ownerCopy = copies.find(copy => sessions.get(copy.ownerSessionId)?.activeQuest?.id === questId);
    const canonical = ownerCopy ?? copies[0];
    const participantIds = new Set(canonical.participantSessionIds ?? []);
    const participantReturns = { ...(canonical.participantReturns ?? {}) };
    const participantLocations = { ...(canonical.participantLocations ?? {}) };
    for (const copy of copies) {
      for (const id of copy.participantSessionIds ?? []) participantIds.add(id);
      Object.assign(participantReturns, copy.participantReturns ?? {});
      Object.assign(participantLocations, copy.participantLocations ?? {});
    }
    for (const session of sessions.values()) {
      if (session.activeQuest?.id !== questId) continue;
      participantIds.add(session.id);
      session.activeQuest = canonical;
    }
    canonical.participantSessionIds = Array.from(participantIds);
    canonical.participantReturns = participantReturns;
    canonical.participantLocations = participantLocations;
    activeQuests.set(questId, canonical);
  }
}

function questReturnForSession(session: WorldSession): QuestParticipantReturn {
  return {
    worldId: session.worldId,
    locationId: session.currentLocationId,
    currentDate: session.currentDate,
    currentTime: session.currentTime,
    dayCount: session.dayCount,
    currentWeather: cloneData(session.currentWeather),
  };
}

function attachParticipantToQuest(
  quest: QuestSessionState,
  targetSession: WorldSession,
  worldId = quest.currentWorldId,
  locationId = quest.currentLocationId,
): void {
  const canonical = canonicalQuestFor(quest);
  canonical.participantSessionIds = Array.from(new Set([...(canonical.participantSessionIds ?? []), targetSession.id]));
  canonical.participantReturns ??= {};
  canonical.participantReturns[targetSession.id] = canonical.participantReturns[targetSession.id] ?? questReturnForSession(targetSession);
  canonical.participantLocations ??= {};
  canonical.participantLocations[targetSession.id] = { worldId, locationId };
  targetSession.questHooks = targetSession.questHooks ?? [];
  targetSession.questInvites = targetSession.questInvites ?? [];
  targetSession.questEchoes = targetSession.questEchoes ?? [];
  targetSession.activeQuest = canonical;
  targetSession.currentDate = canonical.currentDate ?? targetSession.currentDate;
  targetSession.currentTime = canonical.currentTime ?? targetSession.currentTime;
  targetSession.dayCount = canonical.dayCount ?? targetSession.dayCount;
  if (canonical.currentWeather) targetSession.currentWeather = cloneData(canonical.currentWeather);
  appendFeedEvents(targetSession, [{ ty: 'quest', x: `Joined quest: ${canonical.name}` }]);
}

function restoreQuestParticipant(session: WorldSession, quest: QuestSessionState): void {
  const returnPoint = quest.participantReturns?.[session.id] ?? quest.baseReturn;
  session.worldId = returnPoint.worldId;
  session.currentLocationId = returnPoint.locationId;
  session.currentDate = returnPoint.currentDate;
  session.currentTime = returnPoint.currentTime;
  session.dayCount = returnPoint.dayCount;
  if (returnPoint.currentWeather) session.currentWeather = cloneData(returnPoint.currentWeather);
  session.activeQuest = undefined;
}

function appendQuestEcho(session: WorldSession, echo: QuestEcho): void {
  session.questEchoes = [...(session.questEchoes ?? []).filter(item => item.id !== echo.id), echo].slice(-20);
  if (!session.significantEvents.includes(echo.message)) {
    session.significantEvents.push(echo.message);
    session.significantEvents = session.significantEvents.slice(-20);
  }
  appendFeedEvents(session, [{ ty: 'quest', x: echo.message }]);
}

function applyQuestCompletionRewardsToParticipant(session: WorldSession, quest: QuestSessionState, echo: QuestEcho): void {
  if (echo.status !== 'succeeded' || !session.globalPlayerId) return;
  const earnedAt = echo.createdAt;
  const medals = quest.scope === 'global' ? (quest.rewards?.medals ?? []).map(medal => ({ ...medal, earnedAt })) : [];
  const achievements = (quest.rewards?.achievements ?? []).map(achievement => ({ ...achievement, earnedAt }));
  session.medals = mergeById(session.medals, medals);
  session.achievements = mergeById(session.achievements, achievements);
  session.questFacts = mergeById(session.questFacts, quest.questFacts ?? []);
  session.reputation = session.reputation === 'unknown' ? 'quest-proven' : session.reputation;
  session.money = Math.max(0, (session.money ?? 0) + 50 + quest.objectives.length * 10);
  session.strangePossessions = Array.from(new Set([...(session.strangePossessions ?? []), `${quest.name} medal-token`])).slice(-20);
  const candidateNpcIds = [quest.hookNpcId, ...Object.values(quest.npcIdMapsByForkWorldId ?? {}).map(map => Object.entries(map).find(([, forkId]) => forkId === quest.hookNpcId)?.[0]).filter(Boolean) as string[]];
  const npcId = candidateNpcIds.find(id => !!session.npcStates[id]);
  if (npcId && session.npcStates[npcId]) {
    const state = session.npcStates[npcId];
    state.trustLevel = Math.min(100, (state.trustLevel ?? 0) + 12);
    state.warmth = Math.min(100, (state.warmth ?? 0) + 8);
  }
}

function storeRetryableQuest(session: WorldSession, quest: QuestSessionState, echo: QuestEcho): void {
  if (!['failed', 'abandoned'].includes(echo.status)) return;
  session.retryableQuests = mergeById(session.retryableQuests, [cloneData(quest)]).slice(-10);
  if (session.globalPlayerId) {
    const player = globalPlayers.get(session.globalPlayerId);
    if (player) {
      globalPlayers.set(player.id, {
        ...player,
        retryableQuests: mergeById(player.retryableQuests, [cloneData(quest)]).slice(-10),
        updatedAt: new Date().toISOString(),
      });
      saveGlobalPlayers(globalPlayers);
    }
  }
}

function recordQuestOutcomeNpcMemory(session: WorldSession, quest: QuestSessionState, echo: QuestEcho): void {
  if (!['failed', 'abandoned'].includes(echo.status)) return;
  const state = session.npcStates[quest.hookNpcId];
  if (!state) return;
  const createdAt = echo.createdAt;
  const contentText = `${session.playerName} ${echo.status === 'failed' ? 'failed' : 'abandoned'} ${quest.name}.`;
  const hour = ((Math.floor(session.currentTime ?? 0) % 24) + 24) % 24;
  const timeOfDay = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
  state.memories = [
    ...(state.memories ?? []),
    {
      id: `quest:${echo.status}:${quest.id}:${createdAt}`,
      npcId: quest.hookNpcId,
      worldId: session.worldId,
      inWorldDate: session.currentDate,
      realTimestamp: new Date().toISOString(),
      summary: contentText,
      detail: '',
      emotionalTone: echo.status === 'failed' ? 'disappointed' : 'wary',
      playerRevealed: [],
      npcRevealed: [],
      topicsCovered: [],
      trustDelta: 0,
      significantMoment: false,
      npcThoughtAfter: '',
      locationId: session.currentLocationId ?? '',
      timeOfDay,
      othersPresent: [],
    },
  ].slice(-40);
}

function finalizeQuestResolution(quest: QuestSessionState, echo: QuestEcho): void {
  const canonical = canonicalQuestFor(quest);
  refreshQuestPoolsAfterResolution(canonical, echo.status);
  const participantIds = questParticipantIds(canonical);
  for (const sessionId of participantIds) {
    const participant = sessions.get(sessionId);
    if (!participant) continue;
    restoreQuestParticipant(participant, canonical);
    applyQuestCompletionRewardsToParticipant(participant, canonical, echo);
    storeRetryableQuest(participant, canonical, echo);
    appendQuestEcho(participant, echo);
    recordQuestOutcomeNpcMemory(participant, canonical, echo);
    persistSessionOnly(participant);
  }
  activeQuests.delete(canonical.id);
}

function handleQuestUpdate(update?: { quest?: QuestSessionState; echo?: QuestEcho }): void {
  if (!update?.quest) return;
  if (update.echo) finalizeQuestResolution(update.quest, update.echo);
  else persistQuestParticipants(update.quest);
}

function sanitiseWorld(world: WorldDNA): Omit<WorldDNA, 'playerProfiles' | 'npcSharedStates'> {
  const { playerProfiles, npcSharedStates, ...rest } = world;
  return rest;
}

function extractPdfTextBestEffort(absPath: string): string | undefined {
  try {
    const pdf = readFileSync(absPath);
    const text = pdf.toString('latin1');
    const chunks: string[] = [];
    const decode = (raw: string) => raw
      .replace(/\\([\\()])/g, '$1')
      .replace(/\\n/g, ' ')
      .replace(/\\r/g, ' ')
      .replace(/\\t/g, ' ');
    const collect = (stream: string) => {
      for (const m of stream.matchAll(/\(([^()]*(?:\\.[^()]*)*)\)\s*Tj/g)) chunks.push(decode(m[1]));
      for (const m of stream.matchAll(/\[((?:.|\n|\r)*?)\]\s*TJ/g)) {
        const parts = [...m[1].matchAll(/\(([^()]*(?:\\.[^()]*)*)\)/g)].map(part => decode(part[1]));
        if (parts.length) chunks.push(parts.join(''));
      }
    };
    for (const m of text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      const raw = Buffer.from(m[1], 'latin1');
      try { collect(inflateSync(raw).toString('latin1')); } catch { collect(m[1]); }
    }
    const out = chunks.join(' ').replace(/\s+/g, ' ').trim();
    return out.length > 80 ? out.slice(0, 60000) : undefined;
  } catch {
    return undefined;
  }
}

async function extractPdfTextRobust(absPath: string): Promise<string> {
  try {
    const mod: any = await import('pdf-parse/lib/pdf-parse.js');
    const pdfParse: any = mod?.default ?? mod;
    const parsed: any = await pdfParse(readFileSync(absPath));
    const txt = String(parsed?.text ?? '').split(/\s+/).join(' ').trim();
    if (txt.length > 80) return txt;
  } catch (err) {
    console.error('[worldgen:pdf:robust]', err instanceof Error ? err.message : String(err));
  }
  return extractPdfTextBestEffort(absPath) ?? '';
}

const SOURCE_DOCUMENT_INLINE_TEXT_LIMIT = 200_000;
const SOURCE_CORPUS_DOC_TEXT_LIMIT = 18_000;

function storyArcExcerptText(text: string | undefined | null, maxChars: number): string {
  const source = String(text ?? '').trim();
  if (!source || source.length <= maxChars) return source;
  const markerBudget = 900;
  const segment = Math.max(1000, Math.floor((maxChars - markerBudget) / 3));
  const middleStart = Math.max(0, Math.floor((source.length - segment) / 2));
  const tailStart = Math.max(0, source.length - segment);
  return [
    `[SOURCE EXCERPT: BEGINNING chars 1-${segment}]`,
    source.slice(0, segment),
    `[SOURCE EXCERPT: MIDDLE chars ${middleStart + 1}-${middleStart + segment}]`,
    source.slice(middleStart, middleStart + segment),
    `[SOURCE EXCERPT: ENDING / OUTCOME chars ${tailStart + 1}-${source.length}]`,
    source.slice(tailStart),
  ].join('\n\n').slice(0, maxChars);
}

function sourceDocumentInlineText(text: string | undefined | null): string | undefined {
  const retained = storyArcExcerptText(text, SOURCE_DOCUMENT_INLINE_TEXT_LIMIT);
  return retained || undefined;
}

function resolveProjectTextPath(relPath: string | undefined): string | undefined {
  if (!relPath || relPath.includes('..') || /^https?:\/\//i.test(relPath)) return undefined;
  const abs = pathResolve(join(REPO_ROOT, relPath.replace(/^\/+/, '')));
  return abs.startsWith(REPO_ROOT) ? abs : undefined;
}

function readSourceDocumentSidecar(doc: WorldSourceDocument): string {
  const candidates = [
    doc.textPath,
    doc.path?.endsWith('.txt') ? doc.path : doc.path ? `${doc.path}.txt` : undefined,
  ];
  for (const candidate of candidates) {
    const abs = resolveProjectTextPath(candidate);
    if (abs && existsSync(abs)) return readFileSync(abs, 'utf8');
  }
  return '';
}

function attachKnownWorldQuestSourceDocuments(world: WorldDNA): boolean {
  const knownSources = [
    {
      test: /lost\s+boys/i,
      file: 'lost.pdf',
      id: 'lost-boys-source-pdf',
      title: 'Lost Boys source PDF',
      sourceType: 'Film' as const,
      summary: 'User-provided Lost Boys source document for World Quest generation and source grounding.',
    },
    {
      test: /(fifty|50)\s+shades|christian\s+grey|anastasia\s+steele/i,
      file: 'shades.pdf',
      id: 'fifty-shades-source-pdf',
      title: 'Fifty Shades source PDF',
      sourceType: 'Book' as const,
      summary: 'User-provided Fifty Shades source document for World Quest generation and source grounding.',
    },
    {
      test: /blade(?!\s+runner)|vampire\s+badgrounds/i,
      file: 'blade.pdf',
      id: 'blade-source-pdf',
      title: 'Blade source PDF',
      sourceType: 'Film' as const,
      summary: 'User-provided Blade source document for World Quest generation and source grounding.',
    },
    {
      test: /alien\s+1979|nostromo|xenomorph/i,
      file: 'alien.pdf',
      id: 'alien-nostromo-source-pdf',
      title: 'Alien Nostromo source PDF',
      sourceType: 'Film' as const,
      summary: 'User-provided Alien/Nostromo source document for World Quest generation and source grounding.',
    },
    {
      test: /freddy|krueger|kruger|elm\s+street/i,
      file: 'freddy.pdf',
      id: 'freddy-krueger-source-pdf',
      title: 'Freddy Krueger source PDF',
      sourceType: 'Film' as const,
      summary: 'User-provided Freddy Krueger source document for World Quest generation and source grounding.',
    },
    {
      test: /area\s*51|roswell|nevada.*1947/i,
      file: 'roswell.pdf',
      id: 'roswell-area51-source-pdf',
      title: 'Roswell / Area 51 source PDF',
      sourceType: 'Film' as const,
      summary: 'User-provided Roswell/Area 51 source document for World Quest generation and source grounding.',
    },
  ];
  const matched = knownSources.filter(source => source.test.test(world.concept ?? '') && existsSync(join(REPO_ROOT, 'public', source.file)));
  if (!matched.length) return false;
  const docs = Array.isArray(world.sourceDocuments) ? world.sourceDocuments : [];
  const nextDocs = [...docs];
  let changed = false;
  for (const source of matched) {
    const path = `public/${source.file}`;
    const url = `/${source.file}`;
    if (nextDocs.some(doc => doc.id === source.id || doc.path === path || doc.url === url)) continue;
    nextDocs.push({
      id: source.id,
      title: source.title,
      type: 'pdf',
      sourceType: source.sourceType,
      path,
      url,
      summary: source.summary,
      extractedText: extractPdfTextBestEffort(join(REPO_ROOT, 'public', source.file)),
      addedAt: new Date().toISOString(),
    });
    changed = true;
  }
  if (!changed) return false;
  world.sourceDocuments = nextDocs;
  world.realWorldBased = true;
  return true;
}

function ensureWorldQuestPool(world: WorldDNA): boolean {
  const existing = Array.isArray(world.questPool) ? world.questPool : [];
  const valid = existing.filter(seed => seed?.id && seed.worldId === world.id);
  if (valid.length >= 4) {
    if (valid.length !== existing.length) {
      world.questPool = valid;
      return true;
    }
    return false;
  }
  const kinds: WorldQuestSeed['unlockRule']['kind'][] = ['meet_giver', 'enter_location', 'strange_possession', 'weather', 'complete_quest'];
  const titles = ['The Hidden Witness', 'The Wrong Gift', 'The Sealed Door', 'The Weather Sign', 'The Last Confirmation'];
  const createdAt = world.createdAt || new Date().toISOString();
  const seeds: WorldQuestSeed[] = [...valid];
  for (let i = seeds.length; i < 4; i += 1) {
    const npc = world.npcs?.length ? world.npcs[stableHash(`${world.id}:quest:npc:${i}`) % world.npcs.length] : undefined;
    const loc = world.locations?.length ? world.locations[stableHash(`${world.id}:quest:loc:${i}`) % world.locations.length] : undefined;
    const kind = kinds[stableHash(`${world.id}:quest:kind:${i}`) % kinds.length];
    const status: WorldQuestSeed['status'] = i === 0 ? 'available' : 'locked';
    const giver = npc?.name || 'a resident';
    const place = loc?.name || 'somewhere in this world';
    seeds.push({
      id: `seed-${world.id}-${i + 1}`,
      title: `${titles[i % titles.length]}: ${world.concept}`,
      teaser: status === 'available'
        ? `${giver} has a thread that can become a global quest.`
        : `A locked thread points toward ${place}.`,
      status,
      difficulty: i % 3 === 0 ? 'easy' : i % 3 === 1 ? 'normal' : 'hard',
      worldId: world.id,
      worldName: world.concept,
      giverNpcId: npc?.id,
      giverNpcName: npc?.name,
      locationId: loc?.id,
      locationName: loc?.name,
      unlockRule: {
        kind,
        label: kind === 'meet_giver' ? `Meet ${giver}`
          : kind === 'enter_location' ? `Enter ${place}`
          : kind === 'strange_possession' ? 'Carry a strange possession'
          : kind === 'weather' ? 'Wait for the right weather'
          : 'Complete another global quest',
      },
      createdAt,
    });
  }
  world.questPool = seeds.slice(0, 5);
  return true;
}

function refreshQuestPoolsAfterResolution(quest: QuestSessionState, status: QuestEcho['status']): void {
  const affected = new Set<string>([
    quest.baseReturn?.worldId,
    ...Object.values(quest.baseWorldIdsByForkId ?? {}),
    ...(quest.forkedWorldIds ?? []),
  ].filter(Boolean) as string[]);
  for (const worldId of affected) {
    const world = worlds.get(worldId) ?? Object.values(quest.forkedWorldData ?? {}).find(w => w.id === worldId);
    if (!world) continue;
    ensureWorldQuestPool(world);
    const pool = world.questPool ?? [];
    const sourceSeed = pool.find(seed => seed.id === quest.templateId || `pool-hook-${seed.id}` === quest.templateId || quest.templateId?.includes(seed.id));
    if (sourceSeed && status === 'succeeded') {
      sourceSeed.status = 'completed';
      sourceSeed.teaser = `${quest.name} was completed.`;
    }
    if (sourceSeed && status === 'failed') {
      sourceSeed.status = 'available';
      sourceSeed.teaser = `${quest.name} can be retried. ${quest.retryPenalty ?? ''}`.trim();
    }
    const locked = pool.find(seed => seed.status === 'locked');
    if (locked) {
      locked.status = 'available';
      locked.teaser = `${locked.giverNpcName ?? 'Someone'} is ready to turn this into a global quest.`;
    }
    if (worlds.has(world.id)) saveWorld(world);
  }
}

function describeWorldQuestSeedsForDialogue(world: WorldDNA, npcId: string, locationId: string): string {
  ensureWorldQuestPool(world);
  const relevant = (world.questPool ?? []).filter(seed =>
    seed.status !== 'completed'
    && (seed.status === 'available' || seed.giverNpcId === npcId || seed.locationId === locationId)
  ).slice(0, 3);
  if (!relevant.length) return '';
  return [
    'WORLD QUEST THREADS: NPCs may naturally hint at these without naming game mechanics.',
    ...relevant.map(seed => `${seed.status.toUpperCase()}: ${seed.title}. ${seed.teaser} Unlock hint: ${seed.unlockRule.label}.`),
  ].join('\n');
}

function describeActiveWorldQuestForDialogue(session: WorldSession, npcId: string, locationId: string): string {
  const quest = session.activeWorldQuest?.status === 'active' ? session.activeWorldQuest : undefined;
  if (!quest) return '';
  const relevant = quest.steps.filter(step =>
    step.status !== 'complete'
    && (step.npcIds?.includes(npcId) || step.locationIds?.includes(locationId))
  ).slice(0, 4);
  if (!relevant.length) return '';
  return [
    `ACTIVE WORLD QUEST: ${quest.title}. NPCs may give natural clue hints when relevant.`,
    ...relevant.map(step => `CLUE: ${step.title}. ${step.detail}${step.requiredProp ? ` Required item/prop: ${step.requiredProp}.` : ''}`),
  ].join('\n');
}

function isRealWorldQuestEligible(_world: WorldDNA): boolean {
  return true;
}

function inferWorldQuestSourceType(world: WorldDNA): WorldQuestSourceType {
  const docType = (world.sourceDocuments ?? []).find(doc => doc.sourceType)?.sourceType;
  if (docType) return docType;
  const hasProvidedSource = !!(world.realWorldBased || String(world.realWorldFacts ?? '').trim() || (world.sourceDocuments ?? []).length);
  if (!hasProvidedSource) return 'LLM';
  const text = `${world.concept} ${world.realWorldFacts ?? ''} ${world.era?.period ?? ''} ${(world.timeline ?? []).map(event => event.title).join(' ')}`.toLowerCase();
  if (/\b(film|movie|cinema|screenplay|episode|series)\b/.test(text)) return 'Film';
  if (/\b(book|novel|literature|chapter|author)\b/.test(text)) return 'Book';
  if (/\b(real event|true story|disaster|war|battle|crisis|assassination|titanic|chernobyl)\b/.test(text)) return 'Real Event';
  if (/\b(history|historical|ancient|medieval|victorian|edwardian|roman|tudor)\b/.test(text)) return 'History';
  return 'Story';
}

function inferAttachedSourceType(world: WorldDNA, sourceMeta: { pdfPath: string; title: string }): WorldQuestSourceType {
  const meta = `${sourceMeta.title} ${sourceMeta.pdfPath}`.toLowerCase();
  if (/\b(imsdb|screenplay|script|movie|film)\b/.test(meta)) return 'Film';
  return inferWorldQuestSourceType(world);
}

function inferSourceMetaKind(sourceMeta: { pdfPath: string; title: string }): WorldQuestSourceType {
  const meta = `${sourceMeta.title} ${sourceMeta.pdfPath}`.toLowerCase();
  if (/\b(imsdb|screenplay|script|movie|film|episode|series|tv)\b/.test(meta)) return 'Film';
  if (/\b(book|novel|literature|chapter|author)\b/.test(meta)) return 'Book';
  if (/\b(real event|true story|disaster|war|battle|crisis|assassination|titanic|chernobyl)\b/.test(meta)) return 'Real Event';
  if (/\b(history|historical|ancient|medieval|victorian|edwardian|roman|tudor)\b/.test(meta)) return 'History';
  return 'Story';
}

function worldQuestSourceCorpus(world: WorldDNA): string {
  const sourceDocumentCorpus = (world.sourceDocuments ?? []).flatMap(doc => [
    doc.title,
    doc.summary,
    doc.digest || storyArcExcerptText(doc.extractedText, SOURCE_CORPUS_DOC_TEXT_LIMIT),
  ]);
  return storyArcExcerptText([
    world.concept,
    ...sourceDocumentCorpus,
    world.realWorldFacts,
    world.era?.period,
    world.geography?.region,
    ...(world.era?.majorWorldEvents ?? []),
    ...(world.timeline ?? []).map(event => `${event.title ?? ''} ${event.description ?? ''}`),
  ].filter(Boolean).join(' ').replace(/\s+/g, ' '), 24_000);
}

function worldQuestSourceTerms(world: WorldDNA): string[] {
  const stop = new Set(['about', 'after', 'again', 'their', 'there', 'these', 'those', 'world', 'quest', 'story', 'known', 'complete', 'player', 'source', 'through', 'where', 'which']);
  const terms = worldQuestSourceCorpus(world).toLowerCase().match(/[a-z][a-z0-9'-]{4,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const term of terms) if (!stop.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([term]) => term).slice(0, 80);
}

function normaliseWorldQuestRequirementCount(value: any): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(3, Math.min(50, parsed)) : 25;
}

// Count the numbered beats in a source digest's PLOT section.
// Digest format (from sourceDigest.ts) emits PLOT beats as "1. <title>: ..." through "N+1. <ending>".
// This drives quest-start randomization and progression so successive adventures span different
// parts of the story instead of all starting at the opening.
function parseDigestBeats(digest?: string): number {
  if (!digest) return 0;
  const plotIdx = digest.search(/^\s*PLOT\b/im);
  if (plotIdx < 0) return 0;
  const after = digest.slice(plotIdx);
  const endIdx = after.search(/\n\s*(THEMES|TONE|ENDING\s*TYPE)\b/i);
  const plotBody = endIdx > 0 ? after.slice(0, endIdx) : after;
  const matches = plotBody.match(/^\s*\d+\.\s+/gm);
  return matches ? matches.length : 0;
}

// Extract the numbered PLOT beats (full text, in order) from a source digest's PLOT section.
// Mirrors parseDigestBeats but returns each beat's text rather than just the count, so the world
// timeline can be rebuilt to follow the source story faithfully from beginning to end.
function parseDigestPlotBeats(digest?: string): string[] {
  if (!digest) return [];
  const plotIdx = digest.search(/^\s*PLOT\b/im);
  if (plotIdx < 0) return [];
  let body = digest.slice(plotIdx);
  const endIdx = body.search(/\n\s*(THEMES|TONE|ENDING\s*TYPE)\b/i);
  if (endIdx > 0) body = body.slice(0, endIdx);
  body = body.replace(/^\s*PLOT[^\n]*\r?\n/i, ''); // drop the "PLOT (...):" header line
  const beats: string[] = [];
  let current = '';
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*\d+\.\s+/.test(line)) {
      if (current.trim()) beats.push(current.trim());
      current = line.replace(/^\s*\d+\.\s+/, '');
    } else if (current) {
      current += ' ' + line.trim();
    }
  }
  if (current.trim()) beats.push(current.trim());
  return beats.map(b => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function timelineDateForBeat(index: number, total: number, yearStart: number, yearEnd: number): string {
  const startYear = Number.isFinite(yearStart) ? Math.trunc(yearStart) : 2000;
  const endYear = Math.max(startYear, Number.isFinite(yearEnd) ? Math.trunc(yearEnd) : startYear);
  const start = new Date(Date.UTC(0, 0, 1));
  start.setUTCFullYear(startYear, 0, 1);
  const end = new Date(Date.UTC(0, 11, 31));
  end.setUTCFullYear(endYear, 11, 31);
  const ratio = total <= 1 ? 0 : index / (total - 1);
  const date = new Date(start.getTime() + Math.round((end.getTime() - start.getTime()) * ratio));
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Rebuild world.timeline so its events faithfully follow the source story's canonical PLOT beats
// in chronological order: one timeline event per beat, dates strictly increasing, real NPC/location
// IDs. The whole-story digest is generated from the FULL source text, so unlike the in-build
// timeline phase (which only sees a 60K excerpt and writes generic "local history") this captures
// the entire plot start-to-finish. Returns true when the timeline was replaced.
async function rebuildWorldTimelineFromDigest(
  world: WorldDNA,
  digest: string,
  provider: string | undefined,
  model: string | undefined,
  log: (m: string) => void,
): Promise<boolean> {
  const beats = parseDigestPlotBeats(digest);
  if (beats.length < 3) {
    log(`[timeline] digest has only ${beats.length} PLOT beats — keeping the generated timeline`);
    return false;
  }
  const npcIndex = (world.npcs ?? []).map(n => `${n.id} (${n.name})`).join('; ');
  const locIndex = (world.locations ?? []).map(l => `${l.id} (${l.name})`).join('; ');
  const yearStart = world.era?.yearStart ?? 2000;
  const yearEnd = Math.max(world.era?.yearEnd ?? yearStart, yearStart);
  const numbered = beats.map((b, i) => `${i + 1}. ${b}`).join('\n');
  let raw: any;
  try {
    raw = await llmJSON<any>({
      provider: provider || (world as any).provider,
      model,
      temperature: 0.4,
      // Scale the token budget with beat count so long sources (e.g. 40-70 beats) can emit one
      // event per beat instead of consolidating; ~300 tokens/event, floored at 8k, capped at 20k.
      maxTokens: Math.min(20000, Math.max(8000, beats.length * 300)),
      system: `You convert a story's canonical PLOT beats into a chronological world timeline. Produce EXACTLY one timeline event per plot beat, in the SAME order. Do not invent, merge, reorder, or skip beats. Each event must faithfully represent its beat using the real character and location names from the source. Return ONLY valid JSON.`,
      user: `The ${beats.length} canonical PLOT beats of the source story, in order (opening -> climax -> ending):\n\n${numbered}\n\nNPCs (use these EXACT ids; never invent ids): ${npcIndex || '(none)'}\nLocations (use these EXACT ids): ${locIndex || '(none)'}\n\nReturn { "timeline": [ ... ] } with EXACTLY ${beats.length} events, one per beat in beat order. Each event:\n{ "id": snake_case, "date": "YYYY-MM-DD" (strictly INCREASING across the array, all within ${yearStart}-${yearEnd}, preserving plot order), "title": names the beat, "description": 1-2 sentences faithful to the beat using real names, "type": "local"|"world"|"personal"|"seasonal"|"crisis", "locationId": a valid location id or "", "affectedNpcIds": valid npc ids involved in this beat, "moodShift": string, "publicKnowledge": boolean, "gossipVersion": string }\nThe FINAL event MUST be the story's actual ending/resolution.`,
    });
  } catch (e) {
    log(`[timeline] digest-driven rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  const arr: any[] = Array.isArray(raw?.timeline) ? raw.timeline : Array.isArray(raw) ? raw : [];
  if (arr.length !== beats.length) {
    log(`[timeline] WARNING requested ${beats.length} events but model returned ${arr.length}; preserving returned beat order`);
  }
  const events = arr.slice(0, beats.length);
  const validNpc = new Set((world.npcs ?? []).map(n => n.id));
  const validLoc = new Set((world.locations ?? []).map(l => l.id));
  const types = new Set(['local', 'world', 'personal', 'seasonal', 'crisis']);
  const cleaned = events.filter(ev => ev && typeof ev === 'object').map((ev: any, i: number) => ({
    id: String(ev.id || `plot_beat_${i + 1}`),
    date: timelineDateForBeat(i, events.length, yearStart, yearEnd),
    title: String(ev.title || `Beat ${i + 1}`),
    description: String(ev.description || ''),
    type: types.has(ev.type) ? ev.type : 'local',
    locationId: validLoc.has(ev.locationId) ? String(ev.locationId) : undefined,
    affectedNpcIds: Array.isArray(ev.affectedNpcIds) ? ev.affectedNpcIds.filter((x: any) => validNpc.has(x)) : [],
    moodShift: String(ev.moodShift || ''),
    publicKnowledge: ev.publicKnowledge !== false,
    gossipVersion: String(ev.gossipVersion || ''),
  }));
  if (cleaned.length < 3) {
    log(`[timeline] rebuild produced only ${cleaned.length} events — keeping the generated timeline`);
    return false;
  }
  const prev = (world.timeline ?? []).length;
  world.timeline = cleaned as any;
  saveWorld(world);
  log(`[timeline] rebuilt ${cleaned.length} chronological events from ${beats.length} digest PLOT beats (was ${prev}) — timeline now follows the source start to finish`);
  return true;
}

// Pull the entry names from a digest's CHARACTERS: or LOCATIONS: section (e.g. "David Stevens",
// "Edinburgh Tenement"). Tolerant of the "- Name (role): arc" and "- Name: desc" formats.
function parseDigestCanonicalNames(digest: string, section: 'CHARACTERS' | 'LOCATIONS'): string[] {
  const re = new RegExp(`${section}:\\s*([\\s\\S]*?)(?=\\n\\s*(?:CHARACTERS|LOCATIONS|PLOT|THEMES|TONE|ENDING)\\b)`, 'i');
  const m = digest.match(re);
  if (!m) return [];
  const names: string[] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^\s*-\s*([^():]{2,60}?)\s*(?:\([^)]*\))?\s*:/);
    if (mm) { const n = mm[1].trim(); if (n) names.push(n); }
  }
  return names;
}

// Build self-check: compare the freshly generated world against the source's canonical roster and
// record/flag fidelity (which lead characters & locations made it into the world). This is the
// app determining for itself whether the build faithfully represents the source, rather than
// trusting the generation blindly. Deterministic name-coverage check; result stored on the world.
function verifyBuildFidelity(world: WorldDNA, digest: string, log: (m: string) => void): void {
  const canonChars = parseDigestCanonicalNames(digest, 'CHARACTERS');
  const canonLocs = parseDigestCanonicalNames(digest, 'LOCATIONS');
  if (!canonChars.length && !canonLocs.length) { log('[fidelity] digest has no canonical roster to check against'); return; }
  const npcNames = (world.npcs ?? []).map(n => (n.name || '').toLowerCase());
  const locNames = (world.locations ?? []).map(l => (l.name || '').toLowerCase());
  const present = (canon: string, pool: string[]): boolean => {
    const c = canon.toLowerCase().trim();
    if (!c) return false;
    if (pool.some(p => p === c || p.includes(c) || c.includes(p))) return true;
    // token overlap: a multi-word canonical name counts as present if a distinctive token matches
    const tokens = c.split(/\s+/).filter(t => t.length >= 4);
    return tokens.some(t => pool.some(p => p.includes(t)));
  };
  const missingChars = canonChars.filter(n => !present(n, npcNames));
  const missingLocs = canonLocs.filter(n => !present(n, locNames));
  const charCov = canonChars.length ? Math.round(((canonChars.length - missingChars.length) / canonChars.length) * 100) : 100;
  const locCov = canonLocs.length ? Math.round(((canonLocs.length - missingLocs.length) / canonLocs.length) * 100) : 100;
  log(`[fidelity] canonical characters present ${canonChars.length - missingChars.length}/${canonChars.length} (${charCov}%); locations ${canonLocs.length - missingLocs.length}/${canonLocs.length} (${locCov}%)`);
  if (missingChars.length) log(`[fidelity] WARNING missing canonical characters: ${missingChars.slice(0, 12).join(', ')}`);
  if (missingLocs.length) log(`[fidelity] missing canonical locations: ${missingLocs.slice(0, 12).join(', ')}`);
  (world as any).buildFidelity = {
    characters: charCov,
    locations: locCov,
    missingCharacters: missingChars,
    missingLocations: missingLocs,
    checkedAt: new Date().toISOString(),
  };
  saveWorld(world);
}

// Pick a starting PLOT beat for the next world-quest adventure.
//   - First quest: random opening anywhere in the first half of the story
//   - Subsequent: advance past where the previous quest ended (with small jitter), wrapping
//     around to a fresh random opening once the whole story has been covered
// This makes successive adventures span DIFFERENT parts of the source rather than all
// starting at "Act 1: setup".
function pickAdventureStartBeat(world: WorldDNA, totalBeats: number, targetCount: number): { startBeat: number; endBeatHint: number; rationale: string } {
  if (totalBeats < 3) return { startBeat: 1, endBeatHint: Math.max(1, totalBeats), rationale: 'too few beats parsed - default to opening' };
  const w = world as any;
  const lastEnd = Math.max(0, Number(w.lastQuestEndBeat ?? 0));
  // Span: cover roughly 50-80% of the remaining beats - generous enough for ${targetCount} steps to anchor uniquely
  const span = Math.max(Math.floor(totalBeats * 0.5), Math.min(totalBeats, targetCount));
  const jitter = Math.floor(Math.random() * 3); // 0-2 beat random nudge
  let startBeat: number;
  let rationale: string;
  if (lastEnd > 0 && lastEnd < totalBeats - 1) {
    // Progression: pick up past where we left off
    startBeat = Math.min(totalBeats - 1, lastEnd + 1 + jitter);
    rationale = `progression: last quest reached beat ${lastEnd}; starting at ${startBeat} of ${totalBeats}`;
  } else {
    // Fresh start or full wrap: pick a random opening in the first 40% of the story
    const ceiling = Math.max(1, Math.floor(totalBeats * 0.4));
    startBeat = 1 + Math.floor(Math.random() * ceiling);
    rationale = lastEnd > 0
      ? `wrap-around: story fully covered (reached beat ${lastEnd}); new random opening at beat ${startBeat}`
      : `random opening: beat ${startBeat} of ${totalBeats}`;
  }
  const endBeatHint = Math.min(totalBeats, startBeat + span - 1);
  return { startBeat, endBeatHint, rationale };
}

type WorldQuestNpcRequirementMode = 'easy' | 'normal' | 'hard';

function normaliseWorldQuestNpcMode(value: any): WorldQuestNpcRequirementMode {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === 'easy' || mode === 'e') return 'easy';
  if (mode === 'diff' || mode === 'hard' || mode === 'difficult' || mode === 'd') return 'hard';
  return 'normal';
}

function worldQuestNpcRequired(index: number, mode: WorldQuestNpcRequirementMode): boolean {
  if (mode === 'easy') return index % 4 === 0;
  if (mode === 'hard') return index % 4 !== 2;
  return index % 2 === 0;
}

function worldQuestLocationItems(location: any): string[] {
  const raw = [
    location?.interactables,
    location?.notableFeatures,
    location?.features,
    location?.props,
    location?.objects,
    location?.landmarks,
  ];
  const items = raw.flatMap(value => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(/[,;|]/);
    if (typeof value === 'object') return Object.keys(value);
    return [String(value)];
  }).map(item => String(item).replace(/\s+/g, ' ').trim()).filter(Boolean);
  return Array.from(new Set(items));
}

function worldQuestAvailableItems(world: WorldDNA): { item: string; locationId?: string }[] {
  const items = (world.locations ?? []).flatMap(location => worldQuestLocationItems(location).map(item => ({ item, locationId: location.id })));
  if (items.length) return items;
  return (world.locations ?? []).map(location => ({ item: `${location.name} evidence`, locationId: location.id }));
}

function worldQuestItemExists(world: WorldDNA, text?: string): boolean {
  if (!text) return true;
  const needle = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!needle) return true;
  return worldQuestAvailableItems(world).some(({ item }) => {
    const hay = item.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return hay === needle || hay.includes(needle) || needle.includes(hay);
  });
}

function worldQuestFallbackItem(world: WorldDNA, index: number, preferredLocationId?: string): { item: string; locationId?: string } {
  const all = worldQuestAvailableItems(world);
  const local = preferredLocationId ? all.filter(entry => entry.locationId === preferredLocationId) : [];
  const pool = local.length ? local : all;
  return pool[index % Math.max(1, pool.length)] ?? { item: `${world.concept} evidence`, locationId: preferredLocationId };
}

function normaliseQuestEntityName(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\b(?:dr|mr|mrs|ms|miss|prof|professor|sir|lady|lord|captain|detective|officer)\.?\b/g, ' ')
    .replace(/'s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:the|a|an|this|that|their|your|his|her|our)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function questEntityMatchesKnownName(candidate: string, knownNames: string[]): boolean {
  const candidateName = normaliseQuestEntityName(candidate);
  if (!candidateName) return true;
  const candidateTokens = candidateName.split(' ').filter(token => token.length > 1);
  if (!candidateTokens.length) return true;
  return knownNames.some(name => {
    const knownName = normaliseQuestEntityName(name);
    if (!knownName) return false;
    if (knownName === candidateName) return true;
    const knownTokens = knownName.split(' ').filter(token => token.length > 1);
    if (!knownTokens.length) return false;
    const candidateInKnown = candidateTokens.every(token => knownTokens.includes(token));
    const knownInCandidate = knownTokens.every(token => candidateTokens.includes(token));
    return (candidateInKnown && candidateTokens.some(token => token.length >= 3))
      || (knownInCandidate && knownTokens.length >= 2);
  });
}

function worldQuestActionableNames(text: string): string[] {
  const nameWord = String.raw`[A-Z][A-Za-z'.-]*`;
  const nextNameWord = String.raw`(?!(?:at|in|near|around|about|on|with|from|for|and|or|to|the)\b)${nameWord}`;
  const pattern = new RegExp(String.raw`\b(?:[Tt]alk to|[Ss]peak with|[Aa]sk|[Qq]uestion|[Ii]nterview|[Pp]ersuade|[Cc]onvince|[Cc]onfront|[Mm]eet)\s+(${nameWord}(?:\s+${nextNameWord}){0,3})`, 'g');
  return Array.from(String(text ?? '').matchAll(pattern))
    .map(match => match[1]?.replace(/\s+/g, ' ').trim())
    .filter((name): name is string => !!name && !!normaliseQuestEntityName(name));
}

function worldQuestNpcConformanceIssues(quest: WorldQuestAdventure, world: WorldDNA): string[] {
  const npcIds = new Set((world.npcs ?? []).map(npc => npc.id));
  const npcNames = (world.npcs ?? []).map(npc => npc.name).filter(Boolean);
  const locationNames = (world.locations ?? []).map(location => location.name).filter(Boolean);
  const issues: string[] = [];
  for (const step of quest.steps ?? []) {
    const npcKind = ['talk_to_npc', 'find_witness', 'change_relationship'].includes(step.kind);
    const validNpcIds = (step.npcIds ?? []).filter(id => npcIds.has(id));
    if (npcKind && validNpcIds.length === 0) {
      issues.push(`"${step.title}" requires an NPC but has no valid npcId`);
    }
    for (const npcName of step.npcNames ?? []) {
      if (!questEntityMatchesKnownName(npcName, npcNames)) issues.push(`"${step.title}" names unknown NPC ${npcName}`);
    }
    for (const name of worldQuestActionableNames(`${step.title}. ${step.detail}`)) {
      const knownNpc = questEntityMatchesKnownName(name, npcNames);
      const knownPlace = questEntityMatchesKnownName(name, locationNames);
      if (!knownNpc && !knownPlace) issues.push(`"${step.title}" tells player to find unknown person ${name}`);
    }
  }
  return Array.from(new Set(issues)).slice(0, 8);
}

function serializedAdventureNpcConformanceIssues(adventure: SerializedAdventure, world: WorldDNA): string[] {
  const npcNames = (world.npcs ?? []).map(npc => npc.name).filter(Boolean);
  const locationNames = (world.locations ?? []).map(location => location.name).filter(Boolean);
  const issues: string[] = [];
  for (const beat of adventure.acts.flatMap(act => act.beats)) {
    for (const name of worldQuestActionableNames(`${beat.title}. ${beat.narrativeDescription}. ${beat.evaluationCriteria}`)) {
      const knownNpc = questEntityMatchesKnownName(name, npcNames);
      const knownPlace = questEntityMatchesKnownName(name, locationNames);
      if (!knownNpc && !knownPlace) issues.push(`"${beat.title}" tells player to find unknown person ${name}`);
    }
  }
  return Array.from(new Set(issues)).slice(0, 8);
}

async function generateConformingSerializedAdventure(world: WorldDNA, provider?: string, model?: string): Promise<{ adventure?: SerializedAdventure; issues: string[] }> {
  const corpus = worldQuestSourceCorpus(world);
  const terms = worldQuestSourceTerms(world);
  let lastIssues: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = await generateSerializedAdventure(world, corpus, terms, provider, model);
    const issues = serializedAdventureNpcConformanceIssues(candidate, world);
    if (!issues.length) return { adventure: candidate, issues: [] };
    lastIssues = issues;
  }
  return { issues: lastIssues };
}

function repairWorldQuestStep(step: WorldQuestStep, index: number, world: WorldDNA, sourceTerms: string[], npcMode: WorldQuestNpcRequirementMode): WorldQuestStep {
  const npc = (step.npcIds?.length ? world.npcs.find(item => item.id === step.npcIds?.[0]) : undefined)
    ?? world.npcs[index % Math.max(1, world.npcs.length)];
  const loc = (step.locationIds?.length ? world.locations.find(item => item.id === step.locationIds?.[0]) : undefined)
    ?? world.locations[index % Math.max(1, world.locations.length)];
  const term = sourceTerms[index % Math.max(1, sourceTerms.length)] ?? world.concept;
  const stepImpliesNpc = ['talk_to_npc', 'find_witness', 'change_relationship'].includes(step.kind);
  const hasValidNpc = !!step.npcIds?.some(id => world.npcs.some(item => item.id === id));
  const needsNpc = worldQuestNpcRequired(index, npcMode) || stepImpliesNpc;
  const fallbackItem = worldQuestFallbackItem(world, index, loc?.id);
  const requiredProp = worldQuestItemExists(world, step.requiredProp) ? step.requiredProp : fallbackItem.item;
  const interactable = worldQuestItemExists(world, step.interactable) ? step.interactable : (!needsNpc ? fallbackItem.item : step.interactable);
  const vague = /^(step|trace clue|discover|investigate|find out|learn truth|follow the world clue)/i.test(step.title)
    || step.detail.length < 55
    || /follow the world clue|discover the truth|look closer/i.test(step.detail);
  const npcIds = step.npcIds?.length ? step.npcIds : (needsNpc && npc ? [npc.id] : []);
  const locationIds = step.locationIds?.length ? step.locationIds : (loc ? [loc.id] : []);
  const rewriteNpcText = needsNpc && !!npc && (!hasValidNpc || stepImpliesNpc);
  return {
    ...step,
    npcIds,
    npcNames: npcIds.map(id => world.npcs.find(item => item.id === id)?.name).filter((name): name is string => !!name),
    locationIds,
    locationNames: locationIds.map(id => world.locations.find(item => item.id === id)?.name).filter((name): name is string => !!name),
    title: rewriteNpcText ? `Ask ${npc.name} about ${term}`.slice(0, 100) : vague ? `Confirm ${term} at ${loc?.name ?? world.concept}`.slice(0, 100) : step.title,
    detail: rewriteNpcText
      ? `Speak with ${npc.name}${loc ? ` at ${loc.name}` : ''} about the ${term} clue and push the conversation toward the known events of ${world.concept}.`
      : vague
      ? `Use ${term} as the source clue: ${needsNpc && npc ? `speak with ${npc.name}` : `investigate ${loc?.name ?? 'the right place'}`}${loc ? ` at ${loc.name}` : ''} and make the action fit the known events of ${world.concept}.`
      : step.detail,
    interactable,
    requiredProp: requiredProp || (index % 4 === 0 ? fallbackItem.item.slice(0, 120) : undefined),
  };
}

function validateWorldQuestAdventure(quest: WorldQuestAdventure, world: WorldDNA, requirementCount = 25, npcMode: WorldQuestNpcRequirementMode = 'normal'): { ok: boolean; repaired: WorldQuestAdventure; issues: string[] } {
  const targetCount = normaliseWorldQuestRequirementCount(requirementCount);
  const mode = normaliseWorldQuestNpcMode(npcMode);
  const sourceTerms = worldQuestSourceTerms(world);
  const fallback = fallbackWorldQuestAdventure(world, quest.retryOf, targetCount, mode);
  const steps = [...quest.steps.slice(0, targetCount)];
  while (steps.length < targetCount) steps.push(fallback.steps[steps.length]);
  const repairedSteps = steps.map((step, index) => repairWorldQuestStep(step, index, world, sourceTerms, mode));
  const sourceText = [quest.title, quest.premise, quest.historicalAnchor, quest.requiredOutcome, ...repairedSteps.flatMap(step => [step.title, step.detail, step.requiredProp])].filter(Boolean).join(' ').toLowerCase();
  const issues: string[] = [];
  if (quest.steps.length !== targetCount) issues.push(`expected ${targetCount} steps`);
  const minNpcSteps = mode === 'easy' ? 0 : mode === 'hard' ? Math.min(Math.ceil(targetCount * 0.55), world.npcs.length) : Math.min(Math.ceil(targetCount * 0.25), world.npcs.length);
  if (repairedSteps.filter(step => step.npcIds?.length).length < minNpcSteps) issues.push('too few npc-linked steps');
  if (repairedSteps.filter(step => step.locationIds?.length).length < Math.min(Math.ceil(targetCount * 0.4), world.locations.length)) issues.push('too few location-linked steps');
  if (repairedSteps.filter(step => step.requiredProp).length < Math.min(3, Math.ceil(targetCount * 0.25))) issues.push('too few prop/evidence steps');
  if (quest.steps.some(step => (step.requiredProp && !worldQuestItemExists(world, step.requiredProp)) || (step.interactable && !worldQuestItemExists(world, step.interactable)))) issues.push('repaired missing required items');
  const npcNameIssues = worldQuestNpcConformanceIssues({ ...quest, steps: repairedSteps }, world);
  if (npcNameIssues.length) issues.push(`npc-name conformance failed: ${npcNameIssues.join('; ')}`);
  const sourceHits = sourceTerms.slice(0, 30).filter(term => sourceText.includes(term)).length;
  if (sourceTerms.length && sourceHits < 4) issues.push('weak source grounding');
  const vagueCount = repairedSteps.filter(step => /discover the truth|follow the world clue|look closer|something important/i.test(`${step.title} ${step.detail}`)).length;
  if (vagueCount > 2) issues.push('too many vague steps');
  const repaired = {
    ...quest,
    difficulty: normaliseWorldQuestNpcMode((quest as any).difficulty ?? mode),
    steps: repairedSteps,
    involvedNpcIds: Array.from(new Set(repairedSteps.flatMap(step => step.npcIds ?? []))),
    involvedLocationIds: Array.from(new Set(repairedSteps.flatMap(step => step.locationIds ?? []))),
    replacementReason: issues.length ? `Validated/repaired: ${issues.join(', ')}` : quest.replacementReason,
  };
  return { ok: issues.length === 0, repaired, issues };
}

/**
 * Trim text to `max` chars, but prefer a sentence boundary in the last 30% of the budget.
 * Falls back to last whitespace (+ ellipsis) to avoid mid-word cuts.
 * Returns '' for null/undefined.
 */
function smartTrim(s: string | undefined | null, max: number): string {
  if (!s) return '';
  const str = String(s);
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const minBack = Math.floor(max * 0.7);
  const lastTerm = Math.max(
    cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '),
    cut.lastIndexOf('."'), cut.lastIndexOf('!"'), cut.lastIndexOf('?"'),
    cut.lastIndexOf('.\n'), cut.lastIndexOf('!\n'), cut.lastIndexOf('?\n')
  );
  if (lastTerm >= minBack) return cut.slice(0, lastTerm + 1).trimEnd();
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > minBack) return cut.slice(0, lastSpace).trimEnd() + '…';
  return cut.trimEnd();
}

function normaliseWorldQuestStep(raw: any, index: number, world: WorldDNA): WorldQuestStep {
  const npcIds: string[] = Array.isArray(raw?.npcIds) ? raw.npcIds.map(String).filter((id: string) => world.npcs.some(npc => npc.id === id)).slice(0, 4) : [];
  const locationIds: string[] = Array.isArray(raw?.locationIds) ? raw.locationIds.map(String).filter((id: string) => world.locations.some(location => location.id === id)).slice(0, 3) : [];
  const kinds: WorldQuestStep['kind'][] = ['talk_to_npc', 'find_witness', 'inspect_location', 'use_interactable', 'wait_or_weather', 'witness_event', 'change_relationship', 'action', 'choice'];
  const kind = kinds.includes(raw?.kind) ? raw.kind : index % 4 === 0 ? 'find_witness' : index % 3 === 0 ? 'inspect_location' : 'talk_to_npc';
  return {
    id: String(raw?.id || `wq-step-${index + 1}`),
    title: String(raw?.title || `Step ${index + 1}`).slice(0, 100),
    detail: smartTrim(raw?.detail || raw?.description || 'Follow the world clue.', 1200),
    kind,
    npcIds,
    npcNames: npcIds.map(id => world.npcs.find(npc => npc.id === id)?.name).filter((name): name is string => !!name),
    locationIds,
    locationNames: locationIds.map(id => world.locations.find(location => location.id === id)?.name).filter((name): name is string => !!name),
    interactable: typeof raw?.interactable === 'string' ? raw.interactable.slice(0, 120) : undefined,
    requiredProp: typeof raw?.requiredProp === 'string' ? raw.requiredProp.slice(0, 120) : typeof raw?.prop === 'string' ? raw.prop.slice(0, 120) : undefined,
    act: typeof raw?.act === 'string' ? raw.act.slice(0, 60) : index < 5 ? 'Act 1' : index < 11 ? 'Act 2' : 'Finale',
    status: 'active',
  };
}

function fallbackWorldQuestAdventure(world: WorldDNA, retryOf?: string, requirementCount = 25, npcMode: WorldQuestNpcRequirementMode = 'normal'): WorldQuestAdventure {
  const targetCount = normaliseWorldQuestRequirementCount(requirementCount);
  const mode = normaliseWorldQuestNpcMode(npcMode);
  attachKnownWorldQuestSourceDocuments(world);
  const npcs = (world.npcs ?? []).slice(0, Math.max(3, Math.min(8, world.npcs.length)));
  const locs = (world.locations ?? []).slice(0, Math.max(3, Math.min(8, world.locations.length)));
  const sourceTerms = worldQuestSourceTerms(world);
  const steps = Array.from({ length: targetCount }, (_, i) => {
    const npc = npcs[i % Math.max(1, npcs.length)];
    const loc = locs[i % Math.max(1, locs.length)];
    const term = sourceTerms[i % Math.max(1, sourceTerms.length)] ?? world.concept;
    const needsNpc = worldQuestNpcRequired(i, mode);
    const item = worldQuestFallbackItem(world, i, loc?.id).item;
    const kind: WorldQuestStep['kind'] = needsNpc ? (i % 2 === 0 ? 'find_witness' : 'talk_to_npc') : i % 4 === 0 ? 'use_interactable' : i % 4 === 1 ? 'inspect_location' : i % 4 === 2 ? 'action' : 'choice';
    return normaliseWorldQuestStep({
      id: `wq-step-${i + 1}`,
      title: i === targetCount - 1 ? `Settle the ${term} outcome` : `Trace ${term}`,
      detail: npc
        && needsNpc ? `Work with ${npc.name}${loc ? ` around ${loc.name}` : ''} on the ${term} clue near the opening of ${world.concept} and complete the known story logic without forcing contradictions.`
        : `Investigate ${loc?.name ?? world.concept} for the ${term} clue near the opening of the known story and complete the required local outcome.`,
      kind,
      npcIds: needsNpc && npc ? [npc.id] : [],
      locationIds: loc ? [loc.id] : [],
      interactable: !needsNpc ? item : undefined,
      requiredProp: i % 4 === 0 ? item : undefined,
    }, i, world);
  });
  const title = `World Quest: ${world.concept}`;
  const sourceType = inferWorldQuestSourceType(world);
  return {
    id: `world-quest-${world.id}-${Date.now()}`,
    worldId: world.id,
    title,
    status: 'available',
    difficulty: mode,
    sourceType,
    completionThreshold: 0.75,
    medalName: `${world.concept} Medal`,
    achievementId: `achievement:${world.id}:world-quest:${Date.now()}`,
    premise: `A session-only adventure rooted in ${world.concept}.`,
    historicalAnchor: world.realWorldFacts || smartTrim(worldQuestSourceCorpus(world), 2500) || (world.era?.majorWorldEvents ?? []).join('; ') || world.era?.period || world.concept,
    fictionalExtension: 'The player can act inside the story, but the quest only completes when their actions fit what is known to work in this world.',
    requiredOutcome: `Complete ${targetCount} requirements in any order and resolve the known story outcome.`,
    completionSummary: 'It worked out well.',
    involvedNpcIds: npcs.map(npc => npc.id),
    involvedLocationIds: locs.map(location => location.id),
    steps,
    createdAt: new Date().toISOString(),
    retryOf,
  };
}

async function generateWorldQuestAdventure(world: WorldDNA, provider?: string, model?: string, retryOf?: string, requirementCount = 25, npcMode: WorldQuestNpcRequirementMode = 'normal'): Promise<WorldQuestAdventure> {
  const targetCount = normaliseWorldQuestRequirementCount(requirementCount);
  const mode = normaliseWorldQuestNpcMode(npcMode);
  attachKnownWorldQuestSourceDocuments(world);
  // Pick a starting PLOT beat - randomizes opening + advances through the story across successive
  // quests. Falls back gracefully when no digest is present (older worlds, or digest gen failed).
  const lastDigest = [...(world.sourceDocuments ?? [])].reverse().find(d => (d.digest ?? '').length > 200)?.digest;
  const totalBeats = parseDigestBeats(lastDigest);
  const { startBeat, endBeatHint, rationale } = pickAdventureStartBeat(world, totalBeats, targetCount);
  const beatGuidance = totalBeats >= 3
    ? `The source digest has ${totalBeats} numbered PLOT beats. For THIS adventure, anchor your steps to beats ${startBeat} through ${endBeatHint} (${rationale}). Distribute the ${targetCount} steps roughly evenly across that beat range. The first step opens AT beat ${startBeat} (NOT beat 1 unless ${startBeat}===1). Tag each step's 'act' field with the beat number it anchors to, e.g., "Beat ${startBeat}" or "Beat ${Math.floor((startBeat + endBeatHint) / 2)}: midpoint".`
    : `The source has no parsed PLOT structure; distribute your ${targetCount} steps to span the full known story arc (opening, middle, climax, resolution) - do not concentrate all steps in the opening.`;
  const fallback = fallbackWorldQuestAdventure(world, retryOf, targetCount, mode);
  try {
    const raw = await llmJSON<any>({
      provider: provider || world.provider,
      model,
      temperature: 0.82,
      maxTokens: 6144,
      system: `Generate one World Quest adventure. It is sibling to global quests, only for this real/history/story/film/book world. Output JSON only. Include sourceType as one of History, Film, Book, Story, Real Event. Use exactly ${targetCount} visible requirements/steps. CRITICAL: the quest must SPAN A SPECIFIC RANGE OF STORY BEATS, not always the opening. ${beatGuidance} Steps may be completed in any order, but their detail must reference the specific scene/beat from the digest's PLOT section. NPC requirement difficulty is ${mode}: easy means NPCs are optional and most requirements can be location, prop, environment, evidence, or interactable based; normal means some NPC requirements but not most; hard means many NPC-linked requirements. Actionable people and places must come from the supplied npc/location ID lists. If a source character is not present as an NPC, treat that character as background and route the playable clue through a listed NPC or location instead. Never tell the player to find or talk to an unlisted person. At least some steps must require an item/prop from someone or somewhere via requiredProp. Required props and interactables must be selected from availableItems when possible. If the player does unrelated actions, the step should not complete.`,
      user: JSON.stringify({
      world: {
          id: world.id,
          concept: world.concept,
          era: world.era,
          geography: world.geography,
          culture: world.culture,
          timeline: world.timeline,
          sourceFacts: world.realWorldFacts,
          sourceCorpus: worldQuestSourceCorpus(world).slice(0, 12000),
          sourceTerms: worldQuestSourceTerms(world).slice(0, 40),
          availableItems: worldQuestAvailableItems(world).slice(0, 80),
          sourceDocuments: (world.sourceDocuments ?? []).map(doc => ({
            title: doc.title,
            type: doc.type,
            sourceType: doc.sourceType,
            url: doc.url,
            summary: doc.summary,
            // Prefer the structured whole-story digest over the opening-only extractedText
            // so quest steps can anchor to any beat in the story, not just the first scenes.
            digest: doc.digest,
            extractedText: doc.digest ? undefined : storyArcExcerptText(doc.extractedText, 10_000),
          })),
        },
        npcs: (world.npcs ?? []).map(npc => ({ id: npc.id, name: npc.name, occupation: npc.occupation, personality: npc.personality, backstory: npc.backstory })).slice(0, 20),
        locations: (world.locations ?? []).map(location => ({ id: location.id, name: location.name, description: location.description, interactables: (location as any).interactables })).slice(0, 16),
        requiredShape: {
          title: 'string',
          premise: 'string',
          historicalAnchor: 'string',
          fictionalExtension: 'string',
          requiredOutcome: 'string',
          sourceType: 'History|Film|Book|Story|Real Event|LLM',
          completionSummary: 'It worked out well.',
          consequences: ['string'],
          twoPlayer: 'boolean - true if this quest is narratively suited for two-player co-op, false if solo-only',
          requirements: targetCount,
          npcRequirementMode: mode,
          steps: [{ title: 'string', detail: 'specific story-beat-anchored action that references the digest PLOT section', kind: 'talk_to_npc|find_witness|inspect_location|use_interactable|wait_or_weather|witness_event|change_relationship|action|choice', npcIds: ['known npc ids optional'], locationIds: ['known location ids optional'], interactable: 'must match availableItems.item when present', requiredProp: 'must match availableItems.item when present', act: 'Act 1: setup | Act 2: rising | Act 2: midpoint | Act 3: climax | Act 3: resolution' }],
        },
      }),
    });
    const steps: WorldQuestStep[] = Array.isArray(raw?.steps) ? raw.steps.slice(0, targetCount).map((step: any, i: number) => normaliseWorldQuestStep(step, i, world)) : fallback.steps;
    while (steps.length < targetCount) steps.push(fallback.steps[steps.length]);
    const title = String(raw?.title || fallback.title).slice(0, 140);
    const involvedNpcIds: string[] = Array.from(new Set(steps.flatMap((step: WorldQuestStep) => step.npcIds ?? [])));
    const involvedLocationIds: string[] = Array.from(new Set(steps.flatMap((step: WorldQuestStep) => step.locationIds ?? [])));
    const quest: WorldQuestAdventure = {
      ...fallback,
      title,
      difficulty: mode,
      sourceType: ['History', 'Film', 'Book', 'Story', 'Real Event', 'LLM'].includes(String(raw?.sourceType)) ? raw.sourceType : fallback.sourceType,
      completionThreshold: 0.75,
      medalName: `${world.concept} Medal`,
      premise: smartTrim(raw?.premise || fallback.premise, 2000),
      historicalAnchor: smartTrim(raw?.historicalAnchor || fallback.historicalAnchor, 2500),
      fictionalExtension: smartTrim(raw?.fictionalExtension || fallback.fictionalExtension, 2000),
      requiredOutcome: smartTrim(raw?.requiredOutcome || fallback.requiredOutcome, 1500),
      completionSummary: smartTrim(raw?.completionSummary || fallback.completionSummary || 'It worked out well.', 1000),
      consequences: Array.isArray(raw?.consequences) ? raw.consequences.map(String).slice(0, 8) : fallback.consequences,
      twoPlayer: raw?.twoPlayer === true,
      involvedNpcIds: involvedNpcIds.length ? involvedNpcIds : fallback.involvedNpcIds,
      involvedLocationIds: involvedLocationIds.length ? involvedLocationIds : fallback.involvedLocationIds,
      steps,
    };
    const validation = validateWorldQuestAdventure(quest, world, targetCount, mode);
    return validation.ok ? quest : validation.repaired;
  } catch (err) {
    console.warn('[world-quest]', err);
    return fallback;
  }
}

async function generateConformingWorldQuestAdventure(world: WorldDNA, provider?: string, model?: string, retryOf?: string, requirementCount = 25, npcMode: WorldQuestNpcRequirementMode = 'normal'): Promise<WorldQuestAdventure> {
  const targetCount = normaliseWorldQuestRequirementCount(requirementCount);
  const mode = normaliseWorldQuestNpcMode(npcMode);
  let lastIssues: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = validateWorldQuestAdventure(
      await generateWorldQuestAdventure(world, provider, model, retryOf, targetCount, mode),
      world,
      targetCount,
      mode,
    ).repaired;
    const issues = worldQuestNpcConformanceIssues(candidate, world);
    if (!issues.length) return candidate;
    lastIssues = issues;
    retryOf = candidate.id;
  }
  const fallback = validateWorldQuestAdventure(fallbackWorldQuestAdventure(world, retryOf, targetCount, mode), world, targetCount, mode).repaired;
  fallback.replacementReason = `Generated fallback after NPC-name check failed: ${lastIssues.join('; ')}`;
  return fallback;
}

function activeWorldQuestBlock(session: WorldSession): boolean {
  return session.activeQuest?.status === 'active' || session.activeWorldQuest?.status === 'active' || hasActiveSerializedAdventure(session);
}

function activeWorldQuestForSessionFromWorld(session: WorldSession, world: WorldDNA): WorldQuestAdventure | undefined {
  const active = (world.worldQuestAdventures ?? []).find(quest =>
    quest.status === 'active'
    && (quest.sessionId === session.id || (quest.participantSessionIds ?? []).includes(session.id))
  );
  if (!active) {
    if (session.activeWorldQuest?.worldId === world.id) session.activeWorldQuest = undefined;
    return undefined;
  }
  cleanWorldQuestJoinRequests(active);
  session.activeWorldQuest = active;
  return active;
}

function worldQuestParticipantIds(quest: WorldQuestAdventure): string[] {
  return Array.from(new Set([quest.sessionId, ...(quest.participantSessionIds ?? [])].filter((id): id is string => !!id)));
}

function pruneWorldQuestParticipantIds(quest: WorldQuestAdventure): string[] {
  const liveIds = worldQuestParticipantIds(quest).filter(id => sessions.has(id));
  if (quest.sessionId && !sessions.has(quest.sessionId)) quest.sessionId = liveIds[0];
  if (!quest.sessionId && liveIds[0]) quest.sessionId = liveIds[0];
  quest.participantSessionIds = Array.from(new Set(liveIds));
  return worldQuestParticipantIds(quest).filter(id => sessions.has(id));
}

function worldQuestParticipantKeys(quest: WorldQuestAdventure): Set<string> {
  const keys = new Set<string>();
  for (const sessionId of pruneWorldQuestParticipantIds(quest)) {
    const participant = sessions.get(sessionId);
    if (participant) keys.add(participant.globalPlayerId || sessionId);
  }
  return keys;
}

function worldQuestCanAcceptParticipant(quest: WorldQuestAdventure, session: WorldSession): boolean {
  if (worldQuestParticipantIds(quest).includes(session.id)) return true;
  const keys = worldQuestParticipantKeys(quest);
  const key = session.globalPlayerId || session.id;
  return !keys.has(key) && keys.size < MAX_WORLD_QUEST_PLAYERS;
}

function worldQuestAllowsCoop(quest: WorldQuestAdventure): boolean {
  return quest.allowCoop === true || quest.twoPlayer === true;
}

function worldQuestParticipantSessionForPlayer(quest: WorldQuestAdventure, globalPlayerId: string): WorldSession | undefined {
  if (!globalPlayerId) return undefined;
  return worldQuestParticipantIds(quest)
    .map(id => sessions.get(id))
    .find((session): session is WorldSession => session?.globalPlayerId === globalPlayerId);
}

function activeWorldQuestSessionForPlayer(world: WorldDNA, globalPlayerId: string): WorldSession | undefined {
  for (const quest of world.worldQuestAdventures ?? []) {
    if (quest.status !== 'active') continue;
    const session = worldQuestParticipantSessionForPlayer(quest, globalPlayerId);
    if (session) {
      session.activeWorldQuest = quest;
      return session;
    }
  }
  return undefined;
}

function cleanWorldQuestJoinRequests(quest: WorldQuestAdventure): SerializedAdventureJoinRequest[] {
  const participantIds = new Set(worldQuestParticipantIds(quest));
  const now = Date.now();
  const requests = (quest.pendingJoinRequests ?? []).filter(request =>
    sessions.has(request.sessionId)
    && (request.status !== 'pending' || !participantIds.has(request.sessionId))
    && (request.status === 'pending' || now - Date.parse(request.respondedAt ?? request.requestedAt) < 5 * 60 * 1000),
  );
  quest.pendingJoinRequests = requests;
  return requests.filter(request => request.status === 'pending');
}

function serialisedAdventureParticipantIds(adventure: SerializedAdventure): string[] {
  return Array.from(new Set([adventure.sessionId, ...(adventure.participantSessionIds ?? [])].filter((id): id is string => !!id)));
}

function serialisedAdventurePartnerSession(adventure: SerializedAdventure, sessionId: string): WorldSession | undefined {
  return serialisedAdventureParticipantIds(adventure)
    .filter(id => id !== sessionId)
    .map(id => sessions.get(id))
    .find((session): session is WorldSession => !!session && session.activeSerializedAdventure?.id === adventure.id)
    ?? serialisedAdventureParticipantIds(adventure)
      .filter(id => id !== sessionId)
      .map(id => sessions.get(id))
      .find((session): session is WorldSession => !!session);
}

function setSessionLocation(session: WorldSession, locationId: string): void {
  session.currentLocationId = locationId;
  if (!session.visitedLocations.includes(locationId)) session.visitedLocations.push(locationId);
}

function serialisedAdventureCoopMode(adventure: SerializedAdventure, sessionId: string): 'join' | 'free' {
  return adventure.coopModeBySessionId?.[sessionId] === 'join' ? 'join' : 'free';
}

function setSerialisedAdventureCoopMode(adventure: SerializedAdventure, sessionId: string, mode: 'join' | 'free'): void {
  adventure.coopModeBySessionId ??= {};
  adventure.coopModeBySessionId[sessionId] = mode;
}

function cleanSerialisedAdventureJoinRequests(adventure: SerializedAdventure): SerializedAdventureJoinRequest[] {
  const participantIds = new Set(serialisedAdventureParticipantIds(adventure));
  const now = Date.now();
  const requests = (adventure.pendingJoinRequests ?? []).filter(request =>
    sessions.has(request.sessionId)
    && (request.status !== 'pending' || !participantIds.has(request.sessionId))
    && (request.status === 'pending' || now - Date.parse(request.respondedAt ?? request.requestedAt) < 5 * 60 * 1000),
  );
  adventure.pendingJoinRequests = requests;
  return requests.filter(request => request.status === 'pending');
}

function bindSerialisedAdventureParticipantSessions(adventure: SerializedAdventure, world: WorldDNA, persist = false): WorldSession[] {
  const bound: WorldSession[] = [];
  for (const participantId of serialisedAdventureParticipantIds(adventure)) {
    const participant = sessions.get(participantId);
    if (!participant || participant.worldId !== world.id) continue;
    participant.activeSerializedAdventure = adventure;
    bound.push(participant);
    if (persist) persistSessionState(participant);
  }
  cleanSerialisedAdventureJoinRequests(adventure);
  return bound;
}

function serialisedAdventureParticipantSessionForPlayer(world: WorldDNA, adventure: SerializedAdventure, globalPlayerId: string): WorldSession | undefined {
  if (!globalPlayerId) return undefined;
  return serialisedAdventureParticipantIds(adventure)
    .map(id => sessions.get(id))
    .find((session): session is WorldSession => !!session && session.worldId === world.id && session.globalPlayerId === globalPlayerId)
    ?? Array.from(sessions.values()).find(session =>
      session.worldId === world.id
      && session.globalPlayerId === globalPlayerId
      && session.activeSerializedAdventure?.id === adventure.id,
    );
}

function activeSerialisedAdventureSessionForPlayer(world: WorldDNA, globalPlayerId: string): { session: WorldSession; adventure: SerializedAdventure } | undefined {
  if (!globalPlayerId) return undefined;
  for (const adventure of world.serializedAdventures ?? []) {
    if (adventure.status !== 'active') continue;
    const session = serialisedAdventureParticipantSessionForPlayer(world, adventure, globalPlayerId);
    if (session) return { session, adventure };
  }
  return undefined;
}

function activeSerializedAdventureForSessionFromWorld(session: WorldSession, world: WorldDNA): SerializedAdventure | undefined {
  const bySessionId = (world.serializedAdventures ?? []).find(adventure =>
    adventure.status === 'active' && serialisedAdventureParticipantIds(adventure).includes(session.id),
  );
  if (bySessionId) {
    cleanSerialisedAdventureJoinRequests(bySessionId);
    session.activeSerializedAdventure = bySessionId;
    return bySessionId;
  }
  const byPlayer = session.globalPlayerId ? activeSerialisedAdventureSessionForPlayer(world, session.globalPlayerId) : undefined;
  if (byPlayer?.session.id === session.id) {
    cleanSerialisedAdventureJoinRequests(byPlayer.adventure);
    session.activeSerializedAdventure = byPlayer.adventure;
    return byPlayer.adventure;
  }
  if (session.activeSerializedAdventure?.worldId === world.id) session.activeSerializedAdventure = undefined;
  return undefined;
}

function resolveSerialisedAdventureBinding(session: WorldSession, world: WorldDNA): { session: WorldSession; adventure: SerializedAdventure } | undefined {
  const directId = session.activeSerializedAdventure?.id;
  if (directId) {
    const canonical = (world.serializedAdventures ?? []).find(adventure => adventure.id === directId && adventure.status === 'active');
    if (canonical) {
      session.activeSerializedAdventure = canonical;
      return { session, adventure: canonical };
    }
  }
  const bySessionId = (world.serializedAdventures ?? []).find(adventure =>
    adventure.status === 'active' && serialisedAdventureParticipantIds(adventure).includes(session.id),
  );
  if (bySessionId) {
    session.activeSerializedAdventure = bySessionId;
    return { session, adventure: bySessionId };
  }
  const byPlayer = session.globalPlayerId ? activeSerialisedAdventureSessionForPlayer(world, session.globalPlayerId) : undefined;
  if (byPlayer) {
    byPlayer.session.activeSerializedAdventure = byPlayer.adventure;
    return byPlayer;
  }
  if (session.activeSerializedAdventure?.worldId === world.id) session.activeSerializedAdventure = undefined;
  return undefined;
}

function abandonSerialisedAdventureRun(boundSession: WorldSession, world: WorldDNA): SerializedAdventure | undefined {
  const binding = resolveSerialisedAdventureBinding(boundSession, world);
  const adventure = binding?.adventure;
  const canonicalSession = binding?.session ?? boundSession;
  if (!adventure || adventure.status !== 'active') return undefined;
  canonicalSession.activeSerializedAdventure = adventure;
  const abandoned = abandonSerializedAdventure(canonicalSession);
  if (!abandoned) return undefined;
  const affectedSessionIds = new Set([
    canonicalSession.id,
    ...serialisedAdventureParticipantIds(abandoned),
    ...Array.from(sessions.values())
      .filter(session => session.worldId === world.id && session.activeSerializedAdventure?.id === abandoned.id)
      .map(session => session.id),
  ]);
  for (const participantId of affectedSessionIds) {
    const participant = sessions.get(participantId);
    if (!participant) continue;
    if (participant.id !== canonicalSession.id && participant.activeSerializedAdventure?.id === abandoned.id) {
      participant.activeSerializedAdventure = undefined;
      participant.significantEvents.push(`Abandoned Serialized Adventure: ${abandoned.title}`);
      participant.significantEvents = participant.significantEvents.slice(-20);
    }
    appendFeedEvents(participant, [{ ty: 'quest', x: `Abandoned Serialized Adventure: ${abandoned.title}` }]);
    persistSessionState(participant, { touch: participant.id === canonicalSession.id });
  }
  saveWorld(world);
  bumpWorldsListCache();
  return abandoned;
}

function closeWorldQuestRun(boundSession: WorldSession, quest: WorldQuestAdventure, mode: 'failed' | 'abandoned' = 'failed'): WorldQuestAdventure {
  const world = worlds.get(quest.worldId);
  const now = new Date().toISOString();
  const label = mode === 'abandoned' ? 'abandoned' : 'failed';
  quest.status = mode;
  quest.failedAt = now;
  if (mode === 'abandoned') quest.completionSummary = 'Abandoned by player.';
  quest.pendingJoinRequests = [];
  if (world) {
    const listed = (world.worldQuestAdventures ?? []).find(item => item.id === quest.id);
    if (listed) {
      listed.status = mode;
      listed.failedAt = now;
      if (mode === 'abandoned') listed.completionSummary = 'Abandoned by player.';
    }
    saveWorld(world);
    bumpWorldsListCache();
  }
  const closedQuest = cloneData(quest);
  const affectedSessionIds = new Set([boundSession.id, ...worldQuestParticipantIds(quest)]);
  for (const participantId of affectedSessionIds) {
    const participant = sessions.get(participantId);
    if (!participant) continue;
    if (participant.activeWorldQuest?.id === quest.id) participant.activeWorldQuest = undefined;
    participant.completedWorldQuests = [
      cloneData(closedQuest),
      ...(participant.completedWorldQuests ?? []).filter(item => item.id !== quest.id),
    ].slice(0, 12);
    appendFeedEvents(participant, [{ ty: 'quest', x: `World Quest ${label}: ${quest.title}` }]);
    persistSessionState(participant, { touch: participant.id === boundSession.id });
    if (participant.id !== boundSession.id) {
      pushCoopEvent(participant.id, {
        type: 'quest_completed',
        questId: quest.id,
        status: mode,
      });
    }
  }
  quest.guestSessionId = undefined;
  quest.guestCoopMode = undefined;
  quest.hostCoopMode = undefined;
  quest.pendingJoinRequests = [];
  return closedQuest;
}

function requirePlayerAuth(req: express.Request, res: express.Response, playerId: string): GlobalPlayerProfile | undefined {
  const player = globalPlayers.get(playerId);
  if (!player) { res.status(404).json({ error: 'Player not found' }); return undefined; }
  const requestedPlayerId = requestString(req.headers['x-global-player-id'] ?? req.body?.globalPlayerId ?? req.query.globalPlayerId ?? req.query.playerId).trim();
  const pin = requestString(req.headers['x-global-player-pin'] ?? req.body?.pin ?? req.query.pin).trim();
  if (requestedPlayerId && requestedPlayerId !== playerId) {
    res.status(403).json({ error: 'This request targets a different signed-in character' });
    return undefined;
  }
  if (!verifyGlobalPlayerPin(player, pin, pinContext(req, res))) {
    res.status(403).json({ error: 'Character sign-in has expired or is invalid' });
    return undefined;
  }
  return player;
}

function requireAnySignedInPlayer(req: express.Request, res: express.Response): GlobalPlayerProfile | undefined {
  const playerId = requestString(req.headers['x-global-player-id'] ?? req.body?.globalPlayerId ?? req.query.globalPlayerId ?? req.query.playerId).trim();
  if (!playerId) {
    res.status(403).json({ error: 'Sign in required' });
    return undefined;
  }
  return requirePlayerAuth(req, res, playerId);
}

function attachSessionToWorldQuest(session: WorldSession, world: WorldDNA, quest: WorldQuestAdventure): void {
  if (session.activeQuest?.status === 'active') throw new Error('Character is already in a quest');
  if (session.activeWorldQuest?.status === 'active' && session.activeWorldQuest.id !== quest.id) throw new Error('Character is already in another World Quest');
  if (!worldQuestCanAcceptParticipant(quest, session)) throw new Error(`World Quest already has ${MAX_WORLD_QUEST_PLAYERS} separate players`);
  quest.participantSessionIds = Array.from(new Set([...pruneWorldQuestParticipantIds(quest), session.id]));
  session.activeWorldQuest = quest;
  const hostSessionId = quest.hostSessionId;
  const isGuestJoin = quest.twoPlayer && !!hostSessionId && hostSessionId !== session.id;
  if (isGuestJoin) {
    quest.guestSessionId = session.id;
    quest.guestCoopMode = 'join';
    quest.hostCoopMode ??= 'free';
    const hostSession = sessions.get(hostSessionId);
    if (hostSession) session.currentLocationId = hostSession.currentLocationId;
  }
  const startLocationId = quest.involvedLocationIds.find(id => world.locations.some(location => location.id === id))
    ?? quest.steps.flatMap(step => step.locationIds ?? []).find(id => world.locations.some(location => location.id === id));
  if (!isGuestJoin && startLocationId && !world.locations.some(location => location.id === session.currentLocationId)) {
    session.currentLocationId = startLocationId;
  }
  if (startLocationId) session.visitedLocations = Array.from(new Set([...(session.visitedLocations ?? []), startLocationId]));
}

function normaliseQuestItem(text?: string): string {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sessionHasWorldQuestItem(session: WorldSession, quest: WorldQuestAdventure, item?: string): boolean {
  const needle = normaliseQuestItem(item);
  if (!needle) return true;
  return (session.worldQuestInventory ?? []).some(entry => {
    if (entry.questId !== quest.id) return false;
    const candidate = normaliseQuestItem(entry.item);
    if (candidate === needle || candidate.includes(needle) || needle.includes(candidate)) return true;
    // Tolerant fallback: partial words, misspellings, plural/stem matching.
    return fuzzyContainsPhrase(candidate, needle) || fuzzyContainsPhrase(needle, candidate);
  });
}

function rememberWorldQuestItem(session: WorldSession, quest: WorldQuestAdventure, item: string, locationId?: string): void {
  const clean = item.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!clean) return;
  const key = normaliseQuestItem(clean);
  const existing = session.worldQuestInventory ?? [];
  if (existing.some(entry => entry.questId === quest.id && normaliseQuestItem(entry.item) === key)) return;
  session.worldQuestInventory = [...existing, { questId: quest.id, item: clean, locationId, foundAt: new Date().toISOString() }].slice(-40);
}

const WORLD_QUEST_SIGNAL_STOP_WORDS = new Set([
  'about', 'after', 'again', 'around', 'before', 'being', 'check', 'clue', 'complete', 'confirm', 'could', 'find',
  'follow', 'from', 'have', 'into', 'investigate', 'known', 'look', 'make', 'near', 'opening', 'quest', 'right',
  'search', 'something', 'speak', 'step', 'story', 'that', 'their', 'there', 'this', 'trace', 'truth', 'use',
  'what', 'when', 'where', 'with', 'world',
]);

function worldQuestSignalWords(text?: string): string[] {
  return Array.from(new Set(
    normaliseQuestItem(text)
      .split(/\s+/)
      .map(word => word.replace(/s$/, ''))
      .filter(word => word.length >= 4 && !WORLD_QUEST_SIGNAL_STOP_WORDS.has(word)),
  ));
}

function worldQuestStepSignalWords(step: WorldQuestStep): string[] {
  return worldQuestSignalWords([step.requiredProp, step.interactable, step.title, step.detail, step.act].filter(Boolean).join(' ')).slice(0, 18);
}

function worldQuestWordOverlaps(actionWords: string[], stepWords: string[]): number {
  return stepWords.filter(stepWord => actionWords.some(actionWord => (
    actionWord === stepWord
    || (actionWord.length >= 5 && stepWord.includes(actionWord))
    || (stepWord.length >= 5 && actionWord.includes(stepWord))
  ))).length;
}

function worldQuestStepHasSpecificSignal(step: WorldQuestStep, text: string): boolean {
  if (step.requiredProp && worldQuestMatchText(text, step.requiredProp)) return true;
  if (step.interactable && worldQuestMatchText(text, step.interactable)) return true;
  const stepWords = worldQuestStepSignalWords(step);
  if (!stepWords.length) return false;
  const hits = worldQuestWordOverlaps(worldQuestSignalWords(text), stepWords);
  return hits >= Math.min(2, stepWords.length);
}

function cleanupWorldQuestState(world: WorldDNA, includeCompleted = false): { removed: number; detachedSessions: number } {
  const cleanupStatuses = new Set<WorldQuestAdventure['status']>(includeCompleted
    ? ['available', 'active', 'completed', 'failed', 'abandoned']
    : ['failed', 'abandoned']);
  const removedIds = new Set(
    (world.worldQuestAdventures ?? [])
      .filter(quest => cleanupStatuses.has(quest.status))
      .map(quest => quest.id),
  );
  for (const session of sessions.values()) {
    if (session.activeWorldQuest?.worldId === world.id && cleanupStatuses.has(session.activeWorldQuest.status)) removedIds.add(session.activeWorldQuest.id);
    for (const quest of session.completedWorldQuests ?? []) {
      if (quest.worldId === world.id && cleanupStatuses.has(quest.status)) removedIds.add(quest.id);
    }
  }
  const before = world.worldQuestAdventures?.length ?? 0;
  world.worldQuestAdventures = (world.worldQuestAdventures ?? []).filter(quest => !removedIds.has(quest.id));
  let detachedSessions = 0;
  for (const session of sessions.values()) {
    let changed = false;
    if (session.activeWorldQuest && removedIds.has(session.activeWorldQuest.id)) {
      session.activeWorldQuest = undefined;
      detachedSessions += 1;
      changed = true;
    }
    const oldCompleted = session.completedWorldQuests ?? [];
    const nextCompleted = oldCompleted.filter(quest => !removedIds.has(quest.id));
    if (nextCompleted.length !== oldCompleted.length) {
      session.completedWorldQuests = nextCompleted;
      changed = true;
    }
    if (changed) persistSessionState(session, { touch: false });
  }
  return { removed: before - (world.worldQuestAdventures?.length ?? 0), detachedSessions };
}

function removeWorldQuestState(world: WorldDNA, questId: string): { removed: number; detachedSessions: number } {
  const id = String(questId || '');
  if (!id) return { removed: 0, detachedSessions: 0 };
  const before = world.worldQuestAdventures?.length ?? 0;
  world.worldQuestAdventures = (world.worldQuestAdventures ?? []).filter(quest => quest.id !== id);
  let detachedSessions = 0;
  for (const session of sessions.values()) {
    let changed = false;
    if (session.activeWorldQuest?.id === id) {
      session.activeWorldQuest = undefined;
      detachedSessions += 1;
      changed = true;
    }
    const oldCompleted = session.completedWorldQuests ?? [];
    const nextCompleted = oldCompleted.filter(quest => quest.id !== id);
    if (nextCompleted.length !== oldCompleted.length) {
      session.completedWorldQuests = nextCompleted;
      changed = true;
    }
    if (changed) persistSessionState(session, { touch: false });
  }
  return { removed: before - (world.worldQuestAdventures?.length ?? 0), detachedSessions };
}

function advanceWorldQuest(session: WorldSession, event: { kind: 'dialogue' | 'action' | 'movement' | 'wait' | 'tick'; npcId?: string; locationId?: string; worldId: string; summary?: string; interactableName?: string }): { quest?: WorldQuestAdventure; completedStep?: WorldQuestStep; completed?: boolean; hint?: string } | undefined {
  const world = worlds.get(session.worldId);
  if (world) activeWorldQuestForSessionFromWorld(session, world);
  const quest = session.activeWorldQuest;
  if (!quest || quest.status !== 'active' || quest.worldId !== event.worldId) return undefined;
  const step = quest.steps.find(item => item.status !== 'complete' && worldQuestStepMatches(item, event, session, quest))
    ?? worldQuestFallbackStepForEvent(quest, event);
  if (!step) {
    const hint = worldQuestHintForEvent(quest, event);
    return hint ? { quest, hint } : undefined;
  }
  const text = `${event.summary ?? ''} ${event.interactableName ?? ''}`.toLowerCase();
  const isLocationSearch = /\b(look|look around|search|study|inspect|examine|investigate)\b/i.test(text);
  const propFoundByPresence = !!step.requiredProp && isLocationSearch && worldQuestMatchText(text, step.requiredProp) && (!step.locationIds?.length || (!!event.locationId && step.locationIds.includes(event.locationId)));
  const propAlreadyHeld = !!step.requiredProp && sessionHasWorldQuestItem(session, quest, step.requiredProp);
  if ((propFoundByPresence || propAlreadyHeld) && step.requiredProp) rememberWorldQuestItem(session, quest, step.requiredProp, event.locationId);
  step.status = 'complete';
  step.completedAt = new Date().toISOString();
  const totalSteps = Math.max(1, quest.steps.length);
  const required = Math.max(1, Math.min(totalSteps, Math.ceil(totalSteps * (quest.completionThreshold ?? 0.75))));
  const completedCount = quest.steps.filter(item => item.status === 'complete').length;
  const completed = completedCount >= required;
  if (completed) { completeWorldQuest(session, quest); scheduleWorldQuestRegeneration(session.worldId, 'world-quest-complete'); }
  for (const npcId of step.npcIds ?? []) {
    const state = session.npcStates[npcId];
    if (state) state.recentLifeEvents = [`World Quest step completed: ${step.title}`, ...(state.recentLifeEvents ?? [])].slice(0, 10);
  }
  appendFeedEvents(session, [{ ty: 'quest', x: completed ? `World Quest completed: ${quest.title}` : `World Quest step completed: ${step.title}` }]);
  if (!completed) {
    pushCoopEventToPartner(quest, session.id, {
      type: 'quest_step_complete',
      questId: quest.id,
      stepId: step.id,
      stepTitle: step.title,
      step: { ...step },
      completed,
      status: quest.status,
    });
  }
  return { quest, completedStep: step, completed };
}

function worldQuestHintForEvent(quest: WorldQuestAdventure, event: { npcId?: string; locationId?: string }): string | undefined {
  const candidates = quest.steps.filter(step => step.status !== 'complete');
  const near = candidates.find(step => event.npcId && step.npcIds?.includes(event.npcId))
    ?? candidates.find(step => event.locationId && step.locationIds?.includes(event.locationId))
    ?? candidates[0];
  if (!near) return undefined;
  if (near.requiredProp) return `Hint: find or use ${near.requiredProp}.`;
  return `Hint: ${near.detail}`;
}

function worldQuestFallbackStepForEvent(quest: WorldQuestAdventure, event: { kind: 'dialogue' | 'action' | 'movement' | 'wait' | 'tick'; npcId?: string; locationId?: string; summary?: string; interactableName?: string }): WorldQuestStep | undefined {
  const candidates = quest.steps.filter(step => step.status !== 'complete');
  if (!candidates.length) return undefined;
  if (event.kind === 'movement') return undefined;
  const text = `${event.summary ?? ''} ${event.interactableName ?? ''}`.toLowerCase();
  if (!text.trim()) return undefined;
  return candidates.find(step => {
    const locationOk = !step.locationIds?.length || (!!event.locationId && step.locationIds.includes(event.locationId));
    const npcOk = !step.npcIds?.length || (!!event.npcId && step.npcIds.includes(event.npcId));
    return locationOk && npcOk && worldQuestStepHasSpecificSignal(step, text);
  });
}

function worldQuestMatchText(haystack: string, needle?: string): boolean {
  if (!needle) return true;
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const hay = norm(haystack);
  const target = norm(needle);
  if (!target) return true;
  if (hay.includes(target) || target.includes(hay)) return true;
  const hayWords = new Set(hay.split(/\s+/).filter(Boolean).map(word => word.replace(/s$/, '')));
  const targetWords = target.split(/\s+/).filter(word => word.length > 2).map(word => word.replace(/s$/, ''));
  if (targetWords.length && targetWords.every(word => hayWords.has(word))) return true;
  // Tolerant fallback: accept partial words, misspellings, and stems.
  return fuzzyContainsPhrase(haystack, needle);
}

function worldQuestStepWaitTimeMatches(step: WorldQuestStep, session?: WorldSession): boolean {
  if (!session) return true;
  const text = `${step.title} ${step.detail} ${step.act ?? ''}`.toLowerCase();
  const hour = Number(session.currentTime ?? 0);
  if (/\b(dusk|sunset|twilight|evening|evening shift|golden hour)\b/.test(text)) return hour >= 17 && hour < 22;
  if (/\b(night|midnight|after dark)\b/.test(text)) return hour >= 22 || hour < 5;
  if (/\b(dawn|sunrise|early morning|morning)\b/.test(text)) return hour >= 5 && hour < 12;
  if (/\b(afternoon|midday|noon)\b/.test(text)) return hour >= 12 && hour < 17;
  return true;
}

function worldQuestStepMatches(step: WorldQuestStep, event: { kind: 'dialogue' | 'action' | 'movement' | 'wait' | 'tick'; npcId?: string; locationId?: string; summary?: string; interactableName?: string }, session?: WorldSession, quest?: WorldQuestAdventure): boolean {
  const locationOk = !step.locationIds?.length || (!!event.locationId && step.locationIds.includes(event.locationId));
  const npcOk = !step.npcIds?.length || (!!event.npcId && step.npcIds.includes(event.npcId));
  const text = `${event.summary ?? ''} ${event.interactableName ?? ''}`.toLowerCase();
  const isLocationSearch = /\b(look|look around|search|study|inspect|examine|investigate|check|read|open|take|collect|use)\b/i.test(text);
  const hasStepSignal = worldQuestStepHasSpecificSignal(step, text);
  const interactableOk = !step.interactable || worldQuestMatchText(text, step.interactable);
  const propOk = !step.requiredProp || worldQuestMatchText(text, step.requiredProp) || (!!session && !!quest && sessionHasWorldQuestItem(session, quest, step.requiredProp));
  const topicOk = hasStepSignal || (!!step.requiredProp && propOk) || (!!step.interactable && interactableOk);
  if (step.kind === 'wait_or_weather' || step.kind === 'witness_event') {
    if (!locationOk) return false;
    if (event.kind === 'wait' || event.kind === 'tick') return worldQuestStepWaitTimeMatches(step, session);
    return event.kind === 'action' && npcOk && interactableOk && propOk && topicOk;
  }
  return (step.kind === 'talk_to_npc' || step.kind === 'find_witness'
    ? (event.kind === 'dialogue' || event.kind === 'action') && npcOk && topicOk
    : step.kind === 'inspect_location' || step.kind === 'use_interactable'
      ? event.kind === 'action' && locationOk && isLocationSearch && interactableOk && topicOk
      : (event.kind === 'action' || event.kind === 'dialogue') && topicOk) && locationOk && npcOk && interactableOk && propOk;
}

function completeWorldQuest(session: WorldSession, quest: WorldQuestAdventure): void {
  const now = new Date().toISOString();
  quest.status = 'completed';
  quest.completedAt = now;
  quest.pendingJoinRequests = [];
  const medal: QuestMedal = { id: `world-medal:${quest.id}`, name: quest.medalName || quest.title, tier: 'Major', questType: 'existential', questId: quest.id, earnedAt: now };
  const achievement = { id: quest.achievementId, name: quest.title, description: quest.requiredOutcome, questId: quest.id, earnedAt: now };
  const completedQuest = cloneData(quest);
  const affectedSessionIds = new Set([session.id, ...worldQuestParticipantIds(quest)]);
  for (const participantId of affectedSessionIds) {
    const participant = sessions.get(participantId);
    if (!participant) continue;
    participant.medals = mergeById(participant.medals, [medal]);
    participant.worldQuestMedals = mergeById(participant.worldQuestMedals, [medal]);
    participant.achievements = mergeById(participant.achievements, [achievement]);
    participant.completedWorldQuests = mergeById(participant.completedWorldQuests, [completedQuest]);
    if (participant.activeWorldQuest?.id === quest.id) participant.activeWorldQuest = undefined;
    participant.significantEvents.push(`Completed World Quest: ${quest.title}. ${quest.completionSummary ?? 'It worked out well.'}`);
    if (participant.id !== session.id) {
      appendFeedEvents(participant, [{ ty: 'quest', x: `World Quest completed: ${quest.title}` }]);
      persistSessionState(participant, { touch: false });
      pushCoopEvent(participant.id, {
        type: 'quest_completed',
        questId: quest.id,
        status: 'completed',
        medalName: medal.name,
      });
    }
  }
  quest.guestSessionId = undefined;
  quest.guestCoopMode = undefined;
  quest.hostCoopMode = undefined;
  quest.pendingJoinRequests = [];
  bumpWorldsListCache();
}

function scheduleWorldQuestRegeneration(worldId: string | undefined, reason: string): void {
  if (!worldId) return;
  const world = worlds.get(worldId);
  if (!world) return;
  const blocking = (world.worldQuestAdventures ?? []).find(q => q.status === 'available' || q.status === 'active');
  if (blocking) return;
  void (async () => {
    try {
      attachKnownWorldQuestSourceDocuments(world);
      const fresh = await generateConformingWorldQuestAdventure(world);
      const stillBlocked = (world.worldQuestAdventures ?? []).find(q => q.status === 'available' || q.status === 'active');
      if (stillBlocked) return;
      fresh.status = 'available';
      fresh.startedAt = undefined;
      fresh.sessionId = undefined;
      fresh.participantSessionIds = [];
      world.worldQuestAdventures = [fresh, ...(world.worldQuestAdventures ?? []).filter(q => q.status === 'completed' || q.status === 'failed' || q.status === 'abandoned').slice(0, 8)];
      if (worlds.has(world.id)) {
        saveWorld(world);
        bumpWorldsListCache();
      }
      console.log(`[worldquest] auto-regenerated after ${reason} for ${world.id}: ${fresh.title}`);
    } catch (err) {
      console.warn(`[worldquest] auto-regen failed for ${worldId} after ${reason}:`, (err as Error)?.message ?? err);
    }
  })();
}

function createWorldSessionForGlobalPlayer(
  world: WorldDNA,
  globalPlayer: GlobalPlayerProfile,
  body: any = {},
  preferredLocationId?: string,
): { session: WorldSession; resources: ReturnType<typeof deriveResourceProfile> } {
  ensureWorldClock(world);
  const playerName = String(body.playerName || globalPlayer.playerName || '').trim().slice(0, 100);
  if (!playerName) throw new Error('global player is missing a playerName');
  const playerAge = Math.max(1, Math.min(200, Math.floor(Number(body.playerAge) || globalPlayer.playerAge || 25)));
  const playerGender = String(body.playerGender || globalPlayer.playerGender || 'unknown').slice(0, 50);
  const playerOccupation = String(body.playerOccupation || globalPlayer.playerOccupation || '').slice(0, 200);
  const playerBackstory = String(body.playerBackstory || globalPlayer.playerBackstory || '').slice(0, 1000);
  const startLocation = preferredLocationId && world.locations.some(location => location.id === preferredLocationId)
    ? world.locations.find(location => location.id === preferredLocationId)!
    : world.locations[0];
  const resources = deriveResourceProfile(world);
  const profileKey = buildPlayerProfileKey({
    playerName: globalPlayer.playerName ?? playerName,
    playerAge: globalPlayer.playerAge ?? playerAge,
    playerGender: globalPlayer.playerGender ?? playerGender,
    playerOccupation: globalPlayer.playerOccupation ?? playerOccupation,
    playerBackstory: globalPlayer.playerBackstory ?? playerBackstory,
  });
  const savedProfile = world.playerProfiles?.[profileKey];
  const npcStates = buildSessionNpcStates(world, startLocation.id, savedProfile);
  const defaultMoney = resources.scarcityLevel === 'abundant' ? world.economy.averageDailyWage * 30
    : resources.scarcityLevel === 'comfortable' ? world.economy.averageDailyWage * 14
    : resources.scarcityLevel === 'modest' ? world.economy.averageDailyWage * 7
    : resources.scarcityLevel === 'tight' ? world.economy.averageDailyWage * 3
    : world.economy.averageDailyWage;
  const savedLocationId = savedProfile?.currentLocationId;
  const hasSavedLocation = !!savedLocationId && world.locations.some(location => location.id === savedLocationId);
  const session: WorldSession = {
    id: randomUUID(),
    worldId: world.id,
    globalPlayerId: globalPlayer.id,
    playerProfileKey: profileKey,
    lastActiveAt: new Date().toISOString(),
    playerName: globalPlayer.playerName ?? playerName,
    playerAge: globalPlayer.playerAge ?? playerAge,
    playerGender: (globalPlayer.playerGender ?? playerGender) || 'unspecified',
    playerOccupation: globalPlayer.playerOccupation || playerOccupation || world.economy.jobs[0]?.title || 'newcomer',
    playerBackstory: globalPlayer.playerBackstory || playerBackstory || 'You have just arrived.',
    playerAppearance: visiblePlayerAppearance(globalPlayer.playerAppearance ?? savedProfile?.playerAppearance),
    photoUrl: globalPlayer.photoUrl ?? savedProfile?.photoUrl,
    imageUrl: globalPlayer.imageUrl ?? savedProfile?.imageUrl,
    avatarUrl: globalPlayer.avatarUrl ?? savedProfile?.avatarUrl,
    portraitUrl: globalPlayer.portraitUrl ?? savedProfile?.portraitUrl,
    playerDepartureStyle: visiblePlayerDepartureStyle(globalPlayer.playerDepartureStyle ?? savedProfile?.playerDepartureStyle),
    strangePossessions: cloneData(globalPlayer.strangePossessions ?? savedProfile?.strangePossessions ?? []),
    impossibleGiftsGiven: cloneData(savedProfile?.impossibleGiftsGiven ?? []),
    activeGodEffects: cloneData(savedProfile?.activeGodEffects ?? []),
    currentDate: world.currentDate!,
    currentTime: world.currentTime!,
    currentMinute: world.currentMinute ?? 0,
    clockStartedAt: world.clockStartedAt,
    lastClockSyncAt: world.lastClockSyncAt,
    currentLocationId: preferredLocationId && world.locations.some(location => location.id === preferredLocationId)
      ? preferredLocationId
      : hasSavedLocation ? savedLocationId! : startLocation.id,
    currentWeather: cloneData(world.currentWeather),
    money: savedProfile?.money ?? defaultMoney,
    isAlive: savedProfile?.isAlive ?? true,
    socialClass: savedProfile?.socialClass ?? 'newcomer',
    reputation: savedProfile?.reputation ?? 'unknown',
    npcStates,
    visitedLocations: cloneData(savedProfile?.visitedLocations ?? [startLocation.id]),
    dayCount: savedProfile?.dayCount ?? 1,
    significantEvents: cloneData(savedProfile?.significantEvents ?? []),
    objectiveEvents: cloneData(savedProfile?.objectiveEvents ?? []),
    questHooks: [],
    questEchoes: [],
    communityMood: 'neutral',
    activeGossip: [],
    contagionEvents: [],
    recentCommunityEvents: [],
    feedEvents: [],
    playerVisitLog: cloneData(savedProfile?.playerVisitLog ?? []),
    questInvites: [],
    medals: cloneData(globalPlayer.medals ?? []),
    achievements: cloneData(globalPlayer.achievements ?? []),
    questFacts: cloneData(globalPlayer.questFacts ?? []),
  };
  ensureCognitionState(session);
  ensureVisiblePlayerStart(session);
  ensureSessionWeather(session, world);
  if (!savedProfile && !preferredLocationId) {
    const locationCounts: Record<string, number> = {};
    for (const state of Object.values(npcStates)) {
      locationCounts[state.currentLocationId] = (locationCounts[state.currentLocationId] ?? 0) + 1;
    }
    const bestStart = Object.entries(locationCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? startLocation.id;
    session.currentLocationId = bestStart;
    session.visitedLocations = [bestStart];
  }
  sessions.set(session.id, session);
  return { session, resources };
}

function worldCoverImageUrl(w: WorldDNA): string | undefined {
  const anyWorld = w as any;
  return anyWorld.images?.cover
    ?? anyWorld.photoUrl
    ?? anyWorld.imageUrl
    ?? anyWorld.coverImageUrl
    ?? anyWorld.coverPhotoUrl
    ?? anyWorld.thumbnailUrl
    ?? anyWorld.heroImageUrl
    ?? anyWorld.generatedImageUrl
    ?? anyWorld.worldImageUrl;
}

function generatedAssetName(value: string | undefined): string {
  return String(value || 'image').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'image';
}

// mtime-keyed cache of directory listings (avoids a readdirSync per image per /api/worlds call)
const _dirListCache = new Map<string, { mtimeMs: number; checkedAt: number; files: Set<string> }>();
const _DIR_LIST_RECHECK_MS = 2000;
const NO_FILES: ReadonlySet<string> = new Set();

function cachedDirFiles(dir: string): ReadonlySet<string> {
  const recent = _dirListCache.get(dir);
  if (recent && Date.now() - recent.checkedAt < _DIR_LIST_RECHECK_MS) return recent.files;
  let st;
  try { st = statSync(dir); } catch { st = undefined; }
  if (!st?.isDirectory()) {
    _dirListCache.set(dir, { mtimeMs: -1, checkedAt: Date.now(), files: new Set() });
    return NO_FILES;
  }
  const hit = _dirListCache.get(dir);
  if (hit && hit.mtimeMs === st.mtimeMs) { hit.checkedAt = Date.now(); return hit.files; }
  const files = new Set(readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name));
  _dirListCache.set(dir, { mtimeMs: st.mtimeMs, checkedAt: Date.now(), files });
  return files;
}

/**
 * True when an image URL stored on a world will actually load. Local paths must exist under
 * public/ (or the image-proxy cache); remote and data: URLs cannot be checked and count as present.
 */
function imageUrlResolves(url: unknown): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  if (/^data:image\//i.test(url) || /^https?:\/\//i.test(url)) return true;
  if (!url.startsWith('/')) return false;
  if (url.startsWith('/api/img')) {
    const params = Object.fromEntries(new URL(url, 'http://local').searchParams);
    const file = imgProxyCacheFileName(params);
    return !!file && cachedDirFiles(IMG_CACHE_DIR).has(file);
  }
  let path: string;
  try { path = decodeURIComponent(url.split(/[?#]/)[0]); } catch { return false; }
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.some(p => p === '..' || p === '.')) return false;
  const file = parts.pop()!;
  return cachedDirFiles(join(PUBLIC_DIR, ...parts)).has(file);
}

const WORLD_IMAGE_EXTS = ['.jpg', '.png', '.webp', '.jpeg'];

/**
 * Finds an image for an NPC, swimwear portrait or location in public/generated/<worldId>/ under any
 * naming the pipelines have used: manual uploads, npc-/loc- generated files, TMDB cast photos saved
 * as <id>.jpg, and the pre-IMDB backups. Returns the public URL, or undefined when none exists.
 */
function findWorldImageFile(worldId: string, kind: 'npc' | 'swimwear' | 'loc', id: string | undefined, name: string | undefined): string | undefined {
  const bases = [...new Set([id, name].filter(Boolean).map(v => generatedAssetName(v)))];
  const stems = kind === 'npc'
    ? (b: string) => [`manual-${b}`, `npc-${b}`, b, `_pre_imdb_backup/${b}`]
    : kind === 'swimwear'
      ? (b: string) => [`manual-${b}-swimwear`, `npc-${b}-swimwear`]
      : (b: string) => [`manual-${b}`, `loc-${b}`, b];
  const root = join(GENERATED_DIR, worldId);
  for (const base of bases) {
    for (const stem of stems(base)) {
      const slash = stem.lastIndexOf('/');
      const sub = slash >= 0 ? stem.slice(0, slash) : '';
      const files = cachedDirFiles(sub ? join(root, sub) : root);
      for (const ext of WORLD_IMAGE_EXTS) {
        if (files.has(`${stem.slice(slash + 1)}${ext}`)) return `/generated/${worldId}/${stem}${ext}`;
      }
    }
  }
  return undefined;
}

function findWorldCoverFile(worldId: string): string | undefined {
  const genFiles = cachedDirFiles(join(GENERATED_DIR, worldId));
  const coverFiles = cachedDirFiles(join(PUBLIC_DIR, 'covers'));
  for (const ext of WORLD_IMAGE_EXTS) {
    if (genFiles.has(`manual-cover${ext}`)) return `/generated/${worldId}/manual-cover${ext}`;
  }
  for (const ext of WORLD_IMAGE_EXTS) {
    if (genFiles.has(`cover${ext}`)) return `/generated/${worldId}/cover${ext}`;
    if (coverFiles.has(`${worldId}${ext}`)) return `/covers/${worldId}${ext}`;
  }
  return undefined;
}

// short-TTL response cache for GET /api/worlds (lobby list). Invalidated on world/session save.
const _worldsListCache = new Map<string, { expiresAt: number; etag: string; body: string }>();
const _WORLDS_LIST_CACHE_TTL_MS = 2000;
function bumpWorldsListCache() { _worldsListCache.clear(); }

interface WorldSelectorIssue {
  level: 'error' | 'warning';
  file?: string;
  worldId?: string;
  worldName?: string;
  reason: string;
  detail?: string;
}

function worldSelectorNameForIssue(world: any): string {
  return String(world?.name || world?.title || world?.concept || world?.id || 'unknown world').slice(0, 120);
}

function inspectLoadedWorldForSelector(world: any): WorldSelectorIssue[] {
  const issues: WorldSelectorIssue[] = [];
  const worldId = typeof world?.id === 'string' ? world.id : undefined;
  const worldName = worldSelectorNameForIssue(world);
  if (!worldId) {
    issues.push({ level: 'error', worldName, reason: 'Missing world id', detail: 'Loaded world cannot be addressed by the selector.' });
  }
  if (!Array.isArray(world?.npcs)) {
    issues.push({ level: 'error', worldId, worldName, reason: 'NPC list missing or invalid', detail: 'world.npcs must be an array.' });
  }
  if (!Array.isArray(world?.locations)) {
    issues.push({ level: 'error', worldId, worldName, reason: 'Location list missing or invalid', detail: 'world.locations must be an array.' });
  }
  if (!world?.populationBlueprint || typeof world.populationBlueprint !== 'object') {
    issues.push({ level: 'warning', worldId, worldName, reason: 'Population blueprint missing', detail: 'Selector will show a blank population size.' });
  }
  if (!String(world?.concept ?? '').trim()) {
    issues.push({ level: 'warning', worldId, worldName, reason: 'Concept/header missing', detail: 'Selector has no stable display title for this world.' });
  }
  return issues;
}

function worldSelectorDiagnostics(): WorldSelectorIssue[] {
  const issues: WorldSelectorIssue[] = [];
  for (const world of worlds.values()) issues.push(...inspectLoadedWorldForSelector(world));

  let files: string[] = [];
  try {
    files = readdirSync(DATA_DIR).filter(f => f.startsWith('world-') && f.endsWith('.json') && !f.includes('.tmp.'));
  } catch (err) {
    issues.push({ level: 'error', reason: 'World data directory unreadable', detail: String(err).slice(0, 240) });
    return issues;
  }

  for (const file of files) {
    const fileId = file.slice('world-'.length, -'.json'.length);
    if (worlds.has(fileId) || worldStubs.has(fileId)) continue;
    const full = join(DATA_DIR, file);
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8').replace(/^\uFEFF/, ''));
      const embeddedId = typeof parsed?.id === 'string' ? parsed.id : '';
      if (!embeddedId) {
        issues.push({ level: 'error', file, reason: 'World file missing embedded id', detail: 'File is skipped because it cannot be keyed in memory.' });
      } else if (worlds.has(embeddedId) || worldStubs.has(embeddedId)) {
        if (!worlds.has(embeddedId) && fileId !== embeddedId) {
          issues.push({ level: 'warning', file, worldId: embeddedId, worldName: worldSelectorNameForIssue(parsed), reason: 'World filename does not match embedded id', detail: `Expected world-${embeddedId}.json.` });
        }
      } else {
        issues.push({ level: 'error', file, worldId: embeddedId, worldName: worldSelectorNameForIssue(parsed), reason: 'World file not loaded', detail: 'The file exists in data/ but is not present in the live world map. Restart or run /api/worlds/refresh.' });
      }
    } catch (err) {
      issues.push({ level: 'error', file, reason: 'World JSON unreadable', detail: String(err).slice(0, 240) });
    }
  }

  return issues;
}

interface WorldImageReport {
  complete: boolean;
  missing: { cover: number; portraits: number; swimwear: number; scenes: number };
}

type ImageSlot = { holder: Record<string, any>; prop: string };

function displayedImageSlot(owner: any, fields: readonly string[], maps: unknown[], key: string): ImageSlot | undefined {
  for (const field of fields) if (owner?.[field]) return { holder: owner, prop: field };
  for (const map of maps) {
    if (map && typeof map === 'object' && (map as any)[key]) return { holder: map as Record<string, any>, prop: key };
  }
  return undefined;
}

/**
 * Checks that every image the UI will show for a world actually exists on disk: the cover, one
 * portrait per NPC, a swimwear portrait per adult NPC, and one scene per location. A stored URL
 * that is missing or broken is repointed to a matching file in public/generated/<worldId>/ when
 * one exists. Status is only ever promoted to 'ready' here, never demoted, so an unchanged world
 * does not get re-queued for image generation.
 */
function repairWorldImages(world: any): { changed: boolean; report: WorldImageReport } {
  const missing = { cover: 0, portraits: 0, swimwear: 0, scenes: 0 };
  let changed = false;
  if (!world?.id) return { changed, report: { complete: false, missing: { cover: 1, portraits: 0, swimwear: 0, scenes: 0 } } };
  const images = world.images = world.images ?? {};
  images.portraits = images.portraits ?? {};
  images.swimwearPortraits = images.swimwearPortraits ?? {};
  images.scenes = images.scenes ?? {};

  if (!imageUrlResolves(worldCoverImageUrl(world))) {
    const found = findWorldCoverFile(world.id);
    if (found) { images.cover = found; changed = true; }
    else missing.cover++;
  }

  for (const npc of world.npcs ?? []) {
    const key = npc.id || npc.name;
    if (!key) continue;
    const slot = displayedImageSlot(npc, NPC_PORTRAIT_FIELDS, [world.portraits, world.npcPortraits, images.portraits, world.imageCache?.portraits], key);
    let portrait: string | undefined = slot ? slot.holder[slot.prop] : undefined;
    if (!imageUrlResolves(portrait)) {
      portrait = findWorldImageFile(world.id, 'npc', npc.id, npc.name);
      if (portrait) {
        if (slot) slot.holder[slot.prop] = portrait;
        else images.portraits[key] = portrait;
        changed = true;
      } else missing.portraits++;
    }
    if (portrait) {
      if (!images.portraits[key]) { images.portraits[key] = portrait; changed = true; }
      if (!npc.images?.portrait || npc.images.portrait.startsWith('/api/img') || !imageUrlResolves(npc.images.portrait)) {
        npc.images = npc.images ?? {};
        if (npc.images.portrait !== portrait) { npc.images.portrait = portrait; changed = true; }
      }
    }

    if (isAdultSwimwearNpc(npc)) {
      const stored = npc.images?.swimwear || images.swimwearPortraits[key];
      if (!imageUrlResolves(stored)) {
        const found = findWorldImageFile(world.id, 'swimwear', npc.id, npc.name);
        if (found) {
          images.swimwearPortraits[key] = found;
          npc.images = npc.images ?? {};
          npc.images.swimwear = found;
          changed = true;
        } else missing.swimwear++;
      }
    }
  }

  for (const loc of world.locations ?? []) {
    const key = loc.id || loc.name;
    if (!key) continue;
    const slot = displayedImageSlot(loc, LOC_SCENE_FIELDS, [world.scenes, world.locationScenes, images.scenes, world.imageCache?.scenes], key);
    if (imageUrlResolves(slot ? slot.holder[slot.prop] : undefined)) continue;
    const found = findWorldImageFile(world.id, 'loc', loc.id, loc.name);
    if (found) {
      if (slot) slot.holder[slot.prop] = found;
      else images.scenes[key] = found;
      changed = true;
    } else missing.scenes++;
  }

  const complete = !missing.cover && !missing.portraits && !missing.swimwear && !missing.scenes;
  if (complete && images.status !== 'ready') { images.status = 'ready'; changed = true; }
  else if (changed && !complete && images.status !== 'ready') images.status = 'partial';
  if (changed) images.generatedAt = new Date().toISOString();
  return { changed, report: { complete, missing } };
}

function attachLocalGeneratedImages(world: WorldDNA): boolean {
  return repairWorldImages(world).changed;
}

/** Image check for a budget-deferred world, using the NPC/location keys indexed at boot. */
function stubImageReport(stub: WorldListStub): WorldImageReport {
  const subjects = stub.imageSubjects;
  if (!subjects) return { complete: false, missing: { cover: 1, portraits: stub.npcCount, swimwear: 0, scenes: stub.locationCount } };
  const pseudo: any = { id: stub.id, images: stub.images, npcs: subjects.npcs, locations: subjects.locations, ...subjects.cover };
  const { report } = repairWorldImages(pseudo);
  stub.images = pseudo.images;
  return report;
}

function repairWorldReadModel(world: WorldDNA): boolean {
  let changed = false;
  if (attachKnownWorldQuestSourceDocuments(world)) changed = true;
  if (attachLocalGeneratedImages(world)) changed = true;
  if (ensureWorldQuestPool(world)) changed = true;
  return changed;
}

const SOURCE_VISUAL_PROMPT_VERSION = 'source-visual-v2';

function hasSourceVisuals(world: WorldDNA): boolean {
  const docs = (world as any).sourceDocuments;
  return Array.isArray(docs) && docs.length > 0;
}

function sourceVisualPromptNeedsRefresh(world: WorldDNA): boolean {
  return hasSourceVisuals(world) && (world as any).images?.sourceVisualPromptVersion !== SOURCE_VISUAL_PROMPT_VERSION;
}

function queueWorldImageGeneration(world: WorldDNA, force = false) {
  if (attachLocalGeneratedImages(world)) saveWorld(world);
  if (imageGenerationDisabled()) return;
  const img = (world as any).images;
  const status = img?.status;
  const refreshSourceVisuals = sourceVisualPromptNeedsRefresh(world);
  if (!force && status === 'ready' && !refreshSourceVisuals) return;
  const retryAt = img?.retryAt ? new Date(img.retryAt).getTime() : 0;
  if (!force && status === 'partial' && retryAt && retryAt > Date.now()) return;
  if (!force && status === 'generating') {
    const started = img?.generatedAt ? new Date(img.generatedAt).getTime() : 0;
    if (started && Date.now() - started < 10 * 60 * 1000) return;
  }
  void generateAndAttachWorldImages(world, { refreshSourceVisuals: force || refreshSourceVisuals });
}

async function generateAndAttachWorldImages(world: WorldDNA, opts: { refreshSourceVisuals?: boolean } = {}) {
  const imageWorld = world as any;
  const refreshSourceVisuals = Boolean(opts.refreshSourceVisuals && hasSourceVisuals(world));
  const existingCover = refreshSourceVisuals ? undefined : imageWorld.images?.cover as string | undefined;
  const existingPortraits = { ...(imageWorld.images?.portraits ?? {}) } as Record<string, string>;
  const existingSwimwearPortraits = { ...(imageWorld.images?.swimwearPortraits ?? {}) } as Record<string, string>;
  const existingScenes = refreshSourceVisuals ? {} : { ...(imageWorld.images?.scenes ?? {}) } as Record<string, string>;
  imageWorld.images = {
    ...(imageWorld.images ?? {}),
    status: 'generating',
    error: undefined,
    retryAt: undefined,
    generatedAt: new Date().toISOString(),
  };
  saveWorld(world);

  const applyImageUpdate = (update: { cover?: string; portraits?: Record<string, string>; swimwearPortraits?: Record<string, string>; scenes?: Record<string, string> }) => {
    // Respect portraitSources: never let AI-gen overwrite a TMDB-sourced portrait, even mid-run.
    // portraitSources is AUTHORITATIVE - if it says tmdb, the URL MUST point at the safe TMDB
    // filename. If currentPortraits has been corrupted (e.g., earlier clobbering wrote an
    // npc- prefix URL), force-restore the safe filename when the TMDB file is on disk.
    // This breaks the self-perpetuating clobber cycle where the corrupted URL kept passing the
    // "looks AI-ish" guard and letting the new AI URL through.
    const portraitSources = (imageWorld.images?.portraitSources ?? {}) as Record<string, { kind?: string }>;
    const currentPortraits = (imageWorld.images?.portraits ?? {}) as Record<string, string>;
    const sanitizedPortraits: Record<string, string> = {};
    if (update.portraits) {
      for (const [id, newUrl] of Object.entries(update.portraits)) {
        const srcKind = portraitSources[id]?.kind;
        if (srcKind === 'manual' || srcKind === 'arcface') {
          // Protected portrait - user upload (manual) or ArcFace pipeline crop.
          // Sacrosanct: never overwrite from AI image-gen. Existing URL is preserved.
          continue;
        }
        if (srcKind === 'tmdb') {
          // Force-restore the safe TMDB URL when the file is on disk, regardless of what
          // currentPortraits says (it may be corrupted from a prior clobber).
          const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
          const tmdbAbs = join(GENERATED_DIR, world.id, `${safe}.jpg`);
          const tmdbUrl = `/generated/${world.id}/${safe}.jpg`;
          if (existsSync(tmdbAbs)) {
            // TMDB file present; pin the URL to it and refuse the AI update entirely
            sanitizedPortraits[id] = tmdbUrl;
          }
          // else: TMDB download was never completed for this NPC; allow AI fallback
          else { sanitizedPortraits[id] = newUrl; }
          continue;
        }
        sanitizedPortraits[id] = newUrl;
      }
    }
    imageWorld.images = {
      ...(imageWorld.images ?? {}),
      status: 'generating',
      cover: update.cover ?? imageWorld.images?.cover,
      portraits: { ...(imageWorld.images?.portraits ?? {}), ...sanitizedPortraits },
      swimwearPortraits: { ...(imageWorld.images?.swimwearPortraits ?? {}), ...(update.swimwearPortraits ?? {}) },
      scenes: { ...(imageWorld.images?.scenes ?? {}), ...(update.scenes ?? {}) },
      generatedAt: new Date().toISOString(),
    };
    // Backfill npc.images.portrait with the freshly-saved local URL.
    // ensureNpcImages() may have populated npc.images.portrait with a raw
    // Pollinations URL before server-side bundling ran; once the local file
    // exists we want observatory/index pages to prefer it.
    if (sanitizedPortraits && Object.keys(sanitizedPortraits).length) {
      for (const [key, localUrl] of Object.entries(sanitizedPortraits)) {
        const npc = (world.npcs ?? []).find((n: any) => (n.id || n.name) === key);
        if (npc) {
          const imgs = (npc as any).images || {};
          imgs.portrait = localUrl;
          (npc as any).images = imgs;
        }
      }
    }
    if (update.swimwearPortraits) {
      for (const [key, localUrl] of Object.entries(update.swimwearPortraits)) {
        const npc = (world.npcs ?? []).find((n: any) => (n.id || n.name) === key);
        if (npc) {
          const imgs = (npc as any).images || {};
          imgs.swimwear = localUrl;
          (npc as any).images = imgs;
        }
      }
    }
    worlds.set(world.id, world);
    saveWorld(world);
  };

  try {
    const publicPrefix = `/generated/${world.id}`;
    const outputDir = join(__dirname, '..', 'public', 'generated', world.id);
    const pendingNpcs = (world.npcs ?? []).map((npc: any) => ({
      ...npc,
      id: npc.id || npc.name,
      name: npc.name || 'Unnamed',
      age: npc.age ?? 30,
      gender: npc.gender || 'person',
      occupation: npc.occupation || npc.role || 'resident',
      personality: npc.personality || npc.temperament || 'watchful',
    })).filter((npc: any) => !existingPortraits[npc.id] || (isAdultSwimwearNpc(npc) && !existingSwimwearPortraits[npc.id]));
    const pendingLocations = (world.locations ?? []).map((loc: any) => ({
      ...loc,
      id: loc.id || loc.name,
      name: loc.name || 'Unknown place',
      type: loc.type || 'place',
    })).filter((loc: any) => !existingScenes[loc.id]);
    const bundle = await generateWorldImages(
      world,
      pendingNpcs,
      pendingLocations,
      world.era?.period || '',
      world.geography?.region || world.geography?.country || '',
      { outputDir, publicPrefix, onUpdate: applyImageUpdate, skipCover: Boolean(existingCover) },
    );
    const mergedCover = bundle.cover ?? existingCover;
    // Re-read live world state so anything written during AI gen (notably cast-rematch
    // setting TMDB portraits) wins over the stale snapshot. Without this, a long-running
    // image-gen run silently clobbers cast-rematch updates at the final wholesale rewrite.
    const livePortraits = (imageWorld.images?.portraits ?? {}) as Record<string, string>;
    const liveSwimwearPortraits = (imageWorld.images?.swimwearPortraits ?? {}) as Record<string, string>;
    const liveScenes = (imageWorld.images?.scenes ?? {}) as Record<string, string>;
    const portraitSources = (imageWorld.images?.portraitSources ?? {}) as Record<string, { kind?: string }>;
    // Per-NPC merge: TMDB-sourced portraits are immutable — never overwrite from AI bundle.
    // For others, prefer live state (writes during run) over the start-of-run snapshot, and
    // prefer either over the AI bundle as a fallback.
    const mergedPortraits: Record<string, string> = { ...existingPortraits, ...bundle.portraits, ...livePortraits };
    for (const [id, src] of Object.entries(portraitSources)) {
      // Both tmdb and manual portraits are immutable - if live state has them, that wins over bundle.
      if ((src?.kind === 'tmdb' || src?.kind === 'manual') && livePortraits[id]) {
        mergedPortraits[id] = livePortraits[id];
      }
    }
    const mergedSwimwearPortraits = { ...existingSwimwearPortraits, ...bundle.swimwearPortraits, ...liveSwimwearPortraits };
    const mergedScenes = { ...existingScenes, ...bundle.scenes, ...liveScenes };
    const adultSwimwearNpcCount = (world.npcs ?? []).filter(isAdultSwimwearNpc).length;
    const complete = Boolean(mergedCover)
      && Object.keys(mergedPortraits).length >= (world.npcs ?? []).length
      && Object.keys(mergedSwimwearPortraits).length >= adultSwimwearNpcCount
      && Object.keys(mergedScenes).length >= (world.locations ?? []).length;
    imageWorld.images = {
      ...(imageWorld.images ?? {}),
      status: complete ? 'ready' : (mergedCover || Object.keys(mergedPortraits).length || Object.keys(mergedScenes).length ? 'partial' : 'failed'),
      cover: mergedCover,
      portraits: mergedPortraits,
      swimwearPortraits: mergedSwimwearPortraits,
      scenes: mergedScenes,
      sourceVisualPromptVersion: hasSourceVisuals(world) && complete ? SOURCE_VISUAL_PROMPT_VERSION : imageWorld.images?.sourceVisualPromptVersion,
      retryAt: complete || !bundle.retryAfterMs ? undefined : new Date(Date.now() + bundle.retryAfterMs).toISOString(),
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[imageGen:world]', err);
    imageWorld.images = {
      ...(imageWorld.images ?? {}),
      status: 'failed',
      error: String(err),
      generatedAt: new Date().toISOString(),
    };
  }

  worlds.set(world.id, world);
  saveWorld(world);
}

// ── Health ──────────────────────────────────────────────────────────────────

// Backup endpoints
app.get('/api/backup/status', (req, res) => {
  const { worldId, sessionId } = req.query as any;
  if (!worldId) { res.json({ saved: false }); return; }
  res.json(getBackupStatus(worldId, sessionId));
});

app.post('/api/backup/save', (req, res) => {
  const { worldId, sessionId } = req.body;
  const world = worlds.get(worldId);
  const session = sessionId ? sessions.get(sessionId) : null;
  if (world) saveWorld(world);
  if (session && world) {
    persistSessionState(session);
  }
  res.json({ saved: true, world: !!world, session: !!session });
});

app.get('/api/backup/list', (_req, res) => {
  res.json({ worlds: listSavedWorlds() });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', providers: availableProviders() });
});

// ── Providers info ──────────────────────────────────────────────────────────

app.get('/api/providers', async (_req, res) => {
  const providers = await availableProviderInfo();
  res.json({ providers });
});

app.get('/api/config/public', (_req, res) => {
  res.json({});
});

function withoutPin<T extends object>(player: T): Omit<T, 'pin'> {
  const { pin: _pin, ...safe } = player as T & { pin?: unknown };
  return safe;
}

app.get('/api/players', (_req, res) => {
  res.json({ players: listVisibleGlobalPlayers().map(withoutPin) });
});

// WORLDGEN_PUBLIC_SIGNUP=true lets anyone create a character on a keyed instance.
const PUBLIC_SIGNUP = String(process.env.WORLDGEN_PUBLIC_SIGNUP ?? '').toLowerCase() === 'true';
function requireSignupAccess(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (PUBLIC_SIGNUP) return next();
  requireApiKey(req, res, next);
}

app.post('/api/players', requireSignupAccess as express.RequestHandler, async (req, res) => {
  try {
    const existing = findGlobalPlayerByName(String(req.body?.playerName ?? ''));
    if (existing) {
      if (!verifyGlobalPlayerPin(existing, req.body?.pin, pinContext(req, res))) {
        res.status(409).json({ error: 'A player with this name already exists. Use the correct pin to sign in.' });
        return;
      }
      res.json({ player: withoutPin(existing), reused: true });
      return;
    }
    const player = createGlobalPlayer(req.body ?? {});
    res.json({ player: withoutPin(player) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Player creation failed' });
  }
});

app.post('/api/players/:playerId/sign-in', (req, res) => {
  const player = globalPlayers.get(String(req.params.playerId));
  if (!player) { res.status(404).json({ error: 'Player not found' }); return; }
  if (API_KEY && playerPinExposedById(player)) {
    res.status(403).json({ error: 'This character uses an old PIN that is visible in its id. Ask the admin to set a new PIN.', pinResetRequired: true });
    return;
  }
  if (!verifyGlobalPlayerPin(player, req.body?.pin, pinContext(req, res))) {
    res.status(403).json({ error: 'Character pin is incorrect' });
    return;
  }
  res.json({ player: withoutPin(player) });
});

app.post('/api/players/:playerId/quests/kill-all', (req, res) => {
  const playerId = String(req.params.playerId);
  const player = requirePlayerAuth(req, res, playerId);
  if (!player) return;
  const playerSessions = Array.from(sessions.values()).filter(session => session.globalPlayerId === playerId);
  const clearedQuestIds: string[] = [];
  const clearedWorldQuestIds: string[] = [];
  const clearedAdventureIds: string[] = [];
  const handledQuestIds = new Set<string>();
  const handledWorldQuestIds = new Set<string>();
  const handledAdventureIds = new Set<string>();

  for (const session of playerSessions) {
    const quest = session.activeQuest?.status === 'active' ? canonicalQuestFor(session.activeQuest, session) : undefined;
    if (!quest || handledQuestIds.has(quest.id)) continue;
    handledQuestIds.add(quest.id);
    if (quest.ownerSessionId === session.id || sessions.get(quest.ownerSessionId)?.globalPlayerId === playerId) {
      const abandonSession = sessions.get(quest.ownerSessionId) ?? session;
      const world = worlds.get(abandonSession.worldId);
      if (!world) continue;
      syncSessionFromWorld(abandonSession, world);
      const result = abandonQuestEpisode(abandonSession);
      if (!result.echo) continue;
      clearGlobalActiveQuest(abandonSession, quest.id);
      finalizeQuestResolution(quest, result.echo);
      clearedQuestIds.push(quest.id);
      continue;
    }
    const ownerSession = sessions.get(quest.ownerSessionId);
    const ownerQuest = canonicalQuestFor(ownerSession?.activeQuest?.id === quest.id ? ownerSession.activeQuest : quest);
    restoreQuestParticipant(session, ownerQuest);
    clearGlobalActiveQuest(session, ownerQuest.id);
    ownerQuest.participantSessionIds = ownerQuest.participantSessionIds.filter(id => id !== session.id);
    if (ownerQuest.participantReturns) delete ownerQuest.participantReturns[session.id];
    if (ownerQuest.participantLocations) delete ownerQuest.participantLocations[session.id];
    appendFeedEvents(session, [{ ty: 'quest', x: `Left quest: ${ownerQuest.name}` }]);
    if (ownerSession) {
      ownerSession.activeQuest = ownerQuest;
      appendFeedEvents(ownerSession, [{ ty: 'quest', x: `${session.playerName} left quest: ${ownerQuest.name}` }]);
    }
    persistQuestParticipants(ownerQuest);
    persistSessionOnly(session);
    clearedQuestIds.push(ownerQuest.id);
  }

  for (const world of worlds.values()) {
    const activeWorldQuest = activeWorldQuestSessionForPlayer(world, playerId);
    if (!activeWorldQuest?.activeWorldQuest || handledWorldQuestIds.has(activeWorldQuest.activeWorldQuest.id)) continue;
    handledWorldQuestIds.add(activeWorldQuest.activeWorldQuest.id);
    closeWorldQuestRun(activeWorldQuest, activeWorldQuest.activeWorldQuest, 'abandoned');
    clearedWorldQuestIds.push(activeWorldQuest.activeWorldQuest.id);
  }

  for (const world of worlds.values()) {
    const binding = activeSerialisedAdventureSessionForPlayer(world, playerId);
    if (!binding || handledAdventureIds.has(binding.adventure.id)) continue;
    handledAdventureIds.add(binding.adventure.id);
    if (abandonSerialisedAdventureRun(binding.session, world)) clearedAdventureIds.push(binding.adventure.id);
  }

  const refreshed = globalPlayers.get(player.id) ?? player;
  res.json({
    ok: true,
    player: refreshed,
    clearedQuestIds,
    clearedWorldQuestIds,
    clearedAdventureIds,
    clearedTotal: clearedQuestIds.length + clearedWorldQuestIds.length + clearedAdventureIds.length,
  });
});

app.post('/api/quests/kill-all', requireApiKey as express.RequestHandler, (req, res) => {
  const clearedQuestIds: string[] = [];
  const clearedWorldQuestIds: string[] = [];
  const clearedAdventureIds: string[] = [];
  const handledQuestIds = new Set<string>();
  const handledWorldQuestIds = new Set<string>();
  const handledAdventureIds = new Set<string>();

  for (const session of sessions.values()) {
    const quest = session.activeQuest?.status === 'active' ? canonicalQuestFor(session.activeQuest, session) : undefined;
    if (!quest || handledQuestIds.has(quest.id)) continue;
    handledQuestIds.add(quest.id);
    const abandonSession = sessions.get(quest.ownerSessionId) ?? session;
    const world = worlds.get(abandonSession.worldId);
    if (!world) continue;
    syncSessionFromWorld(abandonSession, world);
    const result = abandonQuestEpisode(abandonSession);
    if (!result.echo) continue;
    clearGlobalActiveQuest(abandonSession, quest.id);
    finalizeQuestResolution(quest, result.echo);
    clearedQuestIds.push(quest.id);
  }

  for (const world of worlds.values()) {
    for (const quest of world.worldQuestAdventures ?? []) {
      if (quest.status !== 'active' || handledWorldQuestIds.has(quest.id)) continue;
      handledWorldQuestIds.add(quest.id);
      const boundSession = worldQuestParticipantIds(quest)
        .map(id => sessions.get(id))
        .find((session): session is WorldSession => !!session)
        ?? Array.from(sessions.values()).find(session => session.activeWorldQuest?.id === quest.id);
      if (!boundSession) {
        quest.status = 'failed';
        quest.failedAt = new Date().toISOString();
        quest.completionSummary = 'Abandoned by kill all.';
        saveWorld(world);
      } else {
        closeWorldQuestRun(boundSession, quest, 'abandoned');
      }
      clearedWorldQuestIds.push(quest.id);
    }
  }

  for (const world of worlds.values()) {
    for (const adventure of world.serializedAdventures ?? []) {
      if (adventure.status !== 'active' || handledAdventureIds.has(adventure.id)) continue;
      handledAdventureIds.add(adventure.id);
      const boundSession = serialisedAdventureParticipantIds(adventure)
        .map(id => sessions.get(id))
        .find((session): session is WorldSession => !!session && session.worldId === world.id)
        ?? Array.from(sessions.values()).find(session => session.worldId === world.id && session.activeSerializedAdventure?.id === adventure.id);
      if (!boundSession) {
        adventure.status = 'abandoned';
        adventure.completedAt = new Date().toISOString();
        saveWorld(world);
      } else {
        abandonSerialisedAdventureRun(boundSession, world);
      }
      clearedAdventureIds.push(adventure.id);
    }
  }

  res.json({
    ok: true,
    clearedQuestIds,
    clearedWorldQuestIds,
    clearedAdventureIds,
    clearedTotal: clearedQuestIds.length + clearedWorldQuestIds.length + clearedAdventureIds.length,
  });
});

app.get('/api/players/:playerId', (req, res) => {
  const player = globalPlayers.get(String(req.params.playerId));
  if (!player) { res.status(404).json({ error: 'Player not found' }); return; }
  const { pin, ...safe } = player;
  res.json({ player: safe });
});

app.patch('/api/players/:playerId', (req, res) => {
  // The admin key, or the player themselves (id + current PIN), may edit a profile.
  if (!hasValidApiKey(req) && !requirePlayerAuth(req, res, String(req.params.playerId))) return;
  const existing = globalPlayers.get(String(req.params.playerId));
  if (!existing) { res.status(404).json({ error: 'Player not found' }); return; }
  const newPin = req.body?.newPin === undefined ? undefined : String(req.body.newPin).trim();
  if (newPin !== undefined && !/^\d{3}$/.test(newPin)) {
    res.status(400).json({ error: 'newPin must be exactly 3 digits' });
    return;
  }
  if (newPin !== undefined && /^pin(\d{3})_/i.exec(existing.id)?.[1] === newPin) {
    res.status(400).json({ error: 'newPin must differ from the PIN visible in this character id' });
    return;
  }
  const now = new Date().toISOString();
  const requestedDifficulty = String(req.body?.activeQuestDifficulty ?? '');
  const activeQuest = existing.activeQuest?.status === 'active' && ['easy', 'normal', 'hard'].includes(requestedDifficulty)
    ? { ...existing.activeQuest, difficulty: requestedDifficulty as 'easy' | 'normal' | 'hard' }
    : existing.activeQuest;
  const player: GlobalPlayerProfile = {
    ...existing,
    updatedAt: now,
    playerName: String(req.body?.playerName ?? existing.playerName).trim().slice(0, 100),
    playerAge: Math.max(1, Math.min(200, Math.floor(Number(req.body?.playerAge ?? existing.playerAge) || existing.playerAge))),
    playerGender: String(req.body?.playerGender ?? existing.playerGender).slice(0, 50),
    playerOccupation: String(req.body?.playerOccupation ?? existing.playerOccupation).slice(0, 200),
    playerBackstory: String(req.body?.playerBackstory ?? existing.playerBackstory).slice(0, 1000),
    playerAppearance: req.body?.playerAppearance ?? existing.playerAppearance,
    photoUrl: req.body?.photoUrl ?? existing.photoUrl,
    imageUrl: req.body?.imageUrl ?? existing.imageUrl,
    avatarUrl: req.body?.avatarUrl ?? existing.avatarUrl,
    portraitUrl: req.body?.portraitUrl ?? existing.portraitUrl,
    playerDepartureStyle: req.body?.playerDepartureStyle ?? existing.playerDepartureStyle,
    strangePossessions: cloneData(req.body?.strangePossessions ?? existing.strangePossessions ?? []),
    activeQuest,
    ...(newPin ? { pin: newPin } : {}),
  };
  globalPlayers.set(player.id, player);
  if (activeQuest?.status === 'active') {
    for (const session of sessions.values()) {
      if (session.globalPlayerId === player.id && session.activeQuest?.id === activeQuest.id) {
        session.activeQuest = cloneData(activeQuest);
        persistSessionOnly(session, { touch: false });
      }
    }
  }
  saveGlobalPlayers(globalPlayers);
  res.json({ player: withoutPin(player) });
});

app.delete('/api/players/:playerId', (req, res) => {
  const playerId = String(req.params.playerId);
  if (!globalPlayers.has(playerId)) { res.status(404).json({ error: 'Player not found' }); return; }
  globalPlayers.delete(playerId);
  let detachedSessions = 0;
  for (const session of sessions.values()) {
    if (session.globalPlayerId === playerId) {
      session.globalPlayerId = undefined;
      session.activeQuest = undefined;
      session.activeWorldQuest = undefined;
      detachedSessions += 1;
      persistSessionState(session, { touch: false });
    }
  }
  saveGlobalPlayers(globalPlayers);
  res.json({ ok: true, removed: 1, detachedSessions });
});

// ── Generate World ──────────────────────────────────────────────────────────

const HARDENED_WORLD_PROVIDERS = new Set(['anthropic', 'openai', 'openai-compat', 'ollama', 'deepseek', 'cerebras']);

function clampBuildInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normaliseGlobalPlayerPin(value: unknown): string {
  const text = String(value ?? '').trim();
  if (/^\d{3}$/.test(text)) return text;
  const embedded = /^pin(\d{3})_/i.exec(text);
  if (embedded) return embedded[1];
  const digits = text.replace(/\D/g, '');
  return digits.length === 3 ? digits : '';
}

function globalPlayerPin(player: GlobalPlayerProfile | undefined): string {
  if (!player) return '';
  return normaliseGlobalPlayerPin((player as any).pin) || normaliseGlobalPlayerPin(player.id);
}

// A 3-digit PIN has only 1000 values, so repeated misses lock the character out — per
// (character, client IP), so a stranger guessing cannot lock the owner out of their own device.
const PIN_MAX_FAILURES = 8;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;
const pinFailures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();

/** Who is asking: the client address (for lockout) and a per-request result cache, so a
 *  request that checks the same PIN twice (route gate + session check) counts one miss. */
interface PinCheckContext { client: string; cache?: Map<string, boolean> }

function pinContext(req: express.Request, res: express.Response): PinCheckContext {
  if (!res.locals.pinChecks) res.locals.pinChecks = new Map<string, boolean>();
  return { client: req.ip ?? req.socket.remoteAddress ?? '', cache: res.locals.pinChecks };
}

/** Client address for a WebSocket upgrade; mirrors Express's trust-proxy handling. */
function wsClientKey(req: import('http').IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - Math.min(forwarded.length, /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : 1)];
  }
  return req.socket.remoteAddress ?? '';
}

/** Legacy ids look like "pin123_<uuid>" and reveal the PIN. While the stored PIN still
 *  equals the one in the id, a keyed (deployed) instance refuses PIN sign-in until the
 *  player or admin sets a new PIN. */
function playerPinExposedById(player: GlobalPlayerProfile | undefined): boolean {
  if (!player) return false;
  const embedded = /^pin(\d{3})_/i.exec(player.id)?.[1];
  return !!embedded && embedded === globalPlayerPin(player);
}

function verifyGlobalPlayerPin(player: GlobalPlayerProfile | undefined, pinInput: unknown, ctx: PinCheckContext): boolean {
  const pin = globalPlayerPin(player);
  // Only an exact 3-digit PIN counts. Never derive the entered PIN from an id-shaped
  // string: player ids embed the PIN and are publicly listed.
  const raw = String(pinInput ?? '').trim();
  const entered = /^\d{3}$/.test(raw) ? raw : '';
  if (!pin) return !entered;
  if (API_KEY && playerPinExposedById(player)) return false;
  // No PIN supplied is "not signed in", not a guess — never counts toward lockout.
  if (!entered) return false;
  const cacheKey = `${player!.id}|${entered}`;
  const cached = ctx.cache?.get(cacheKey);
  if (cached !== undefined) return cached;
  const key = `${player!.id}|${ctx.client}`;
  const now = Date.now();
  const record = pinFailures.get(key);
  let ok = false;
  if (record && record.lockedUntil > now) {
    ok = false;
  } else if (entered === pin) {
    pinFailures.delete(key);
    ok = true;
  } else {
    const next = record && now - record.firstAt < PIN_LOCKOUT_MS ? record : { count: 0, firstAt: now, lockedUntil: 0 };
    next.count += 1;
    if (next.count >= PIN_MAX_FAILURES) {
      next.lockedUntil = now + PIN_LOCKOUT_MS;
      console.warn(`[auth] character ${player!.id} locked for ${ctx.client} for ${PIN_LOCKOUT_MS / 60000}m after ${next.count} wrong PINs`);
    }
    pinFailures.set(key, next);
  }
  ctx.cache?.set(cacheKey, ok);
  return ok;
}

function runHardenedWorldBuild(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const tsxCli = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const scriptPath = join(REPO_ROOT, 'scripts', 'build-world.ts');
    const child = spawn(process.execPath, [tsxCli, scriptPath, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `build-world exited ${code}`).slice(-4000)));
    });
  });
}

type BuildJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';
type BuildJob = {
  id: string;
  buildId: string;
  startedAt: string;
  status: BuildJobStatus;
  logs: string[];
  error?: string;
  world?: ReturnType<typeof sanitiseWorld>;
  resources?: ReturnType<typeof deriveResourceProfile>;
  child?: any;
};

const buildJobs = new Map<string, BuildJob>();
const BUILD_JOBS_MAX = 20;

function evictOldBuildJobs(): void {
  if (buildJobs.size <= BUILD_JOBS_MAX) return;
  const completed = Array.from(buildJobs.entries())
    .filter(([, j]) => j.status !== 'running')
    .sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt));
  while (buildJobs.size > BUILD_JOBS_MAX && completed.length) {
    buildJobs.delete(completed.shift()![0]);
  }
}

function appendBuildLog(job: BuildJob, chunk: string): void {
  for (const line of String(chunk).split(/\r?\n/)) {
    const clean = line.trimEnd();
    if (!clean) continue;
    job.logs.push(clean);
  }
  if (job.logs.length > 240) job.logs = job.logs.slice(-240);
}

function startHardenedWorldBuildJob(args: string[], buildId: string, sourceMeta?: { pdfPath: string; textPath: string; title: string }, sourceYear?: number): BuildJob {
  const tsxCli = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const scriptPath = join(REPO_ROOT, 'scripts', 'build-world.ts');
  const job: BuildJob = { id: `job_${randomUUID()}`, buildId, startedAt: new Date().toISOString(), status: 'running', logs: [] };
  buildJobs.set(job.id, job);
  evictOldBuildJobs();
  const stderrTag = `[build:${buildId.slice(0,8)}]`;
  const MAX_BUILD_RETRIES = Math.max(0, parseInt(process.env.WORLDGEN_BUILD_RETRY_COUNT ?? '3', 10) || 0);
  const BUILD_RETRY_DELAY_SECS = Math.max(1, parseInt(process.env.WORLDGEN_BUILD_RETRY_DELAY_SECS ?? '5', 10) || 5);
  let attempt = 0;
  // Holds the canonical digest generated BEFORE the build (digest-first flow) so the post-build
  // step can reuse it instead of regenerating, and so NPC/location generation is source-faithful.
  let preBuiltDigest: string | undefined;

  const trySpawn = () => {
    if (job.status === 'cancelled') return;
    attempt++;
    if (attempt === 1) {
      appendBuildLog(job, `Started hardened builder ${buildId}`);
    } else {
      appendBuildLog(job, `Retry attempt ${attempt}/${MAX_BUILD_RETRIES + 1} — restarting build-world.ts`);
    }
    const child = spawn(process.execPath, [tsxCli, scriptPath, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    job.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { appendBuildLog(job, chunk); process.stderr.write(`${stderrTag} ${chunk}`); });
    child.stderr.on('data', (chunk: string) => { appendBuildLog(job, chunk); process.stderr.write(`${stderrTag} ${chunk}`); });
    child.on('error', (err: Error) => {
      job.status = 'failed';
      job.error = err.message || String(err);
      appendBuildLog(job, `Builder failed to start: ${job.error}`);
    });
    child.on('close', (code: number | null) => {
      job.child = undefined;
      if (job.status === 'cancelled') return;
      if (code !== 0) {
        if (attempt <= MAX_BUILD_RETRIES) {
          appendBuildLog(job, `build-world exited ${code} — retrying in ${BUILD_RETRY_DELAY_SECS} seconds...`);
          let secsLeft = BUILD_RETRY_DELAY_SECS - 1;
          const tick = setInterval(() => {
            if (job.status === 'cancelled') { clearInterval(tick); return; }
            if (secsLeft > 0) {
              appendBuildLog(job, `Retrying in ${secsLeft}...`);
              secsLeft--;
            } else {
              clearInterval(tick);
              trySpawn();
            }
          }, 1000);
          return;
        }
        job.status = 'failed';
        job.error = `build-world exited ${code} after ${attempt} attempts`;
        appendBuildLog(job, job.error);
        return;
      }
      try {
        const worldPath = join(DATA_DIR, `world-${buildId}.json`);
        if (!existsSync(worldPath)) throw new Error(`Build completed but ${worldPath} was not written`);
        const world = JSON.parse(readFileSync(worldPath, 'utf8')) as WorldDNA;
        const resources = deriveResourceProfile(world);
        worlds.set(world.id, world);
        if (sourceMeta) {
          try {
            const absTxt = join(REPO_ROOT, sourceMeta.textPath.replace(/^\/+/, ''));
            const extracted = existsSync(absTxt) ? readFileSync(absTxt, 'utf8') : '';
            world.sourceDocuments = [...(world.sourceDocuments ?? []), {
              id: `source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              title: sourceMeta.title.slice(0, 120),
              type: /^https?:\/\//i.test(sourceMeta.pdfPath) ? 'url' : 'pdf',
              sourceType: inferAttachedSourceType(world, sourceMeta),
              path: sourceMeta.pdfPath,
              textPath: sourceMeta.textPath,
              summary: undefined,
              extractedText: sourceDocumentInlineText(extracted),
              addedAt: new Date().toISOString(),
            } as WorldSourceDocument];
            world.realWorldBased = true;
            appendBuildLog(job, `Attached source document: ${sourceMeta.title} (${extracted.length} chars)`);
          } catch (e) {
            appendBuildLog(job, `Source attach skipped: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        saveWorld(world);
        // Cast lookup (if source attached + TMDB key): prime world.images.portraits BEFORE image gen so AI skips matched NPCs.
        (async () => {
          if (process.env.TMDB_API_KEY) {
            const castTitle = world.concept || (sourceMeta?.title) || '';
            if (castTitle) {
              try {
                if (sourceYear) appendBuildLog(job, `[cast] using year hint: ${sourceYear}`);
                // Orchestrator step 1: resolve cover from source film/TV
                await resolveCover(world, castTitle, String(process.env.TMDB_API_KEY), GENERATED_DIR, (m) => appendBuildLog(job, m));
                // Orchestrator step 2: match cast & portraits
                await applyCastImagesToWorld(world, castTitle, String(process.env.TMDB_API_KEY), GENERATED_DIR, (m) => appendBuildLog(job, m), sourceYear);
                saveWorld(world);
              } catch (e) {
                appendBuildLog(job, `[cast] error: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
          // Whole-story digest from the FULL source text. Reads the .txt sidecar (capped at 200K at upload),
          // makes one DeepSeek call (~30-90s), attaches to the last sourceDocument so adventures/quests
          // can span the entire story arc instead of just the opening 12K-char slice.
          if (sourceMeta && (preBuiltDigest || process.env.DEEPSEEK_API_KEY)) {
            try {
              // Reuse the digest generated in the digest-first prep step; only generate here if the
              // pre-build step was skipped (e.g. it failed) so we still get a full-story digest.
              let digest = preBuiltDigest;
              if (!digest) {
                const absTxt = join(REPO_ROOT, sourceMeta.textPath.replace(/^\/+/, ''));
                if (existsSync(absTxt)) {
                  const fullText = readFileSync(absTxt, 'utf8');
                  appendBuildLog(job, `[digest] generating whole-story digest (${fullText.length} chars source)...`);
                  const t0 = Date.now();
                  digest = await buildSourceDigest(fullText, { sourceTitle: sourceMeta.title, sourceKind: String(inferWorldQuestSourceType(world) || 'Film') });
                  appendBuildLog(job, `[digest] done in ${Math.round((Date.now() - t0) / 1000)}s, ${digest.length} chars`);
                }
              }
              if (digest) {
                const docs = world.sourceDocuments ?? [];
                const lastDoc = docs[docs.length - 1];
                if (lastDoc) {
                  lastDoc.digest = digest;
                  lastDoc.digestGeneratedAt = new Date().toISOString();
                  saveWorld(world);
                }
                // Rebuild the world timeline from the digest's chronological PLOT beats so its events
                // faithfully track the source story start-to-finish.
                try {
                  await rebuildWorldTimelineFromDigest(world, digest, (world as any).provider, undefined, (m) => appendBuildLog(job, m));
                } catch (e) {
                  appendBuildLog(job, `[timeline] rebuild error: ${e instanceof Error ? e.message : String(e)}`);
                }
                // Self-check: compare the generated world against the canonical roster and flag drift
                // (missing lead characters / locations) so the app itself reports build fidelity.
                try {
                  verifyBuildFidelity(world, digest, (m) => appendBuildLog(job, m));
                } catch (e) {
                  appendBuildLog(job, `[fidelity] check error: ${e instanceof Error ? e.message : String(e)}`);
                }
              }
            } catch (e) {
              appendBuildLog(job, `[digest] error: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          queueWorldImageGeneration(world);
        })().catch(() => {});
        job.world = sanitiseWorld(world);
        job.resources = resources;
        job.status = 'completed';
        appendBuildLog(job, `Loaded world ${world.id}: ${world.concept}`);
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        appendBuildLog(job, `Final load failed: ${job.error}`);
      }
    });
  };

  // Digest-first: generate the canonical whole-story digest BEFORE the build and prepend it to the
  // raw source, so build-world's CANONICAL_ROSTER / CANONICAL_LOCATIONS parsing activates and NPCs +
  // locations come out VERBATIM from the source (David/Alex/Juliet, not invented names) instead of
  // being guessed from a 60K raw excerpt. Falls back to the raw source if no digest can be produced.
  // Runs async; the job is returned immediately as 'running' (logs stream the digest progress).
  const prepareThenSpawn = async () => {
    if (sourceMeta && process.env.DEEPSEEK_API_KEY) {
      try {
        const absTxt = join(REPO_ROOT, sourceMeta.textPath.replace(/^\/+/, ''));
        if (existsSync(absTxt)) {
          const fullText = readFileSync(absTxt, 'utf8');
          appendBuildLog(job, `[digest] building canonical digest before world generation (${fullText.length} chars source)...`);
          const t0 = Date.now();
          const digest = await buildSourceDigest(fullText, { sourceTitle: sourceMeta.title, sourceKind: String(inferSourceMetaKind(sourceMeta)) });
          preBuiltDigest = digest;
          // Prepend the digest (CHARACTERS/LOCATIONS/PLOT) ahead of the full text. build-world parses
          // the canonical sections from the head and still gets the full text for tone/dialogue.
          const combinedPath = `${absTxt}.canon.txt`;
          writeFileSync(combinedPath, `${digest}\n\n----- FULL SOURCE TEXT -----\n\n${fullText}`, 'utf8');
          const sfIdx = args.indexOf('--source-file');
          if (sfIdx >= 0 && sfIdx + 1 < args.length) args[sfIdx + 1] = combinedPath;
          else args.push('--source-file', combinedPath);
          appendBuildLog(job, `[digest] done in ${Math.round((Date.now() - t0) / 1000)}s, ${digest.length} chars — NPCs & locations will use the canonical roster`);
        }
      } catch (e) {
        appendBuildLog(job, `[digest] pre-build digest skipped (${e instanceof Error ? e.message : String(e)}) — building from raw source`);
      }
    }
    trySpawn();
  };
  prepareThenSpawn().catch((err) => {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    appendBuildLog(job, `Build preparation failed: ${job.error}`);
  });
  return job;
}

function runWorldDataCheck(photosOnly = false): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [join(REPO_ROOT, 'scripts', 'check-world-data.mjs'), '--root', REPO_ROOT, '--json'];
    if (photosOnly) args.push('--photos-only');
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function runOrchestratorStatusCheck(): Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean; error?: string }> {
  return new Promise(resolve => {
    const child = spawn(PYTHON_BIN, [join(REPO_ROOT, 'scripts', 'complete-all-media.py'), '--status'], {
      cwd: REPO_ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ code: null, stdout, stderr, timedOut: true, error: 'orchestrator status timed out' });
    }, 120000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => finish({ code: null, stdout, stderr, error: err instanceof Error ? err.message : String(err) }));
    child.on('close', code => finish({ code, stdout, stderr }));
  });
}

type OrchestratorRunState = {
  running: boolean;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  code?: number | null;
  args: string[];
  stdoutTail: string;
  stderrTail: string;
};

let orchestratorRunState: OrchestratorRunState | null = null;

function appendTail(current: string, chunk: string): string {
  return (current + chunk).slice(-4000);
}

function startOrchestratorPass(args: string[]): OrchestratorRunState {
  const existing = orchestratorRunState;
  if (existing?.running) return existing;
  const child = spawn(PYTHON_BIN, [join(REPO_ROOT, 'scripts', 'complete-all-media.py'), ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state: OrchestratorRunState = {
    running: true,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    args,
    stdoutTail: '',
    stderrTail: '',
  };
  orchestratorRunState = state;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { state.stdoutTail = appendTail(state.stdoutTail, chunk); });
  child.stderr.on('data', chunk => { state.stderrTail = appendTail(state.stderrTail, chunk); });
  child.on('error', err => {
    state.running = false;
    state.endedAt = new Date().toISOString();
    state.stderrTail = appendTail(state.stderrTail, err instanceof Error ? err.message : String(err));
  });
  child.on('close', code => {
    state.running = false;
    state.code = code;
    state.endedAt = new Date().toISOString();
  });
  return state;
}

type OrchestratorCronState = {
  enabled: boolean;
  updatedAt?: string;
  source: 'default' | 'user';
};

type OrchestratorProgressSummary = {
  timestamp: string | null;
  complete: boolean;
  totals: {
    worlds: number;
    packs: number;
    packsWithAudio: number;
  };
  needs: {
    pack: number;
    audio: number;
    cast: number;
    scenes: number;
    cover: number;
    panels: number;
    cleanup: number;
  };
  cleanupCounts: {
    generated: number;
    covers: number;
    sounds: number;
    audio: number;
  };
  scope?: string;
  remaining: number;
  skipped: boolean;
  reason?: string;
  blocked: boolean;
  lastError?: string;
  failures: Array<Record<string, unknown>>;
};

const ORCHESTRATOR_STATE_DIR = join(REPO_ROOT, 'state');
const ORCHESTRATOR_CRON_FILE = join(ORCHESTRATOR_STATE_DIR, 'orchestrator-cron.json');
const ORCHESTRATOR_PROGRESS_FILE = join(ORCHESTRATOR_STATE_DIR, 'media-progress.json');

function readOrchestratorCronState(): OrchestratorCronState {
  try {
    if (!existsSync(ORCHESTRATOR_CRON_FILE)) return { enabled: true, source: 'default' };
    const raw = JSON.parse(readFileSync(ORCHESTRATOR_CRON_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (isRecord(raw) && typeof raw.enabled === 'boolean') {
      return {
        enabled: raw.enabled,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
        source: 'user',
      };
    }
  } catch {}
  return { enabled: true, source: 'default' };
}

function writeOrchestratorCronState(enabled: boolean): OrchestratorCronState {
  const next: OrchestratorCronState = { enabled, updatedAt: new Date().toISOString(), source: 'user' };
  mkdirSync(ORCHESTRATOR_STATE_DIR, { recursive: true });
  writeFileSync(ORCHESTRATOR_CRON_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function readOrchestratorProgressSummary(): OrchestratorProgressSummary | null {
  try {
    if (!existsSync(ORCHESTRATOR_PROGRESS_FILE)) return null;
    const raw = JSON.parse(readFileSync(ORCHESTRATOR_PROGRESS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (!isRecord(raw)) return null;
    const totals = isRecord(raw.totals) ? raw.totals : {};
    const countList = (key: string) => Array.isArray(raw[key]) ? raw[key].length : 0;
    const cleanupCountsRaw = isRecord(raw.cleanup_counts) ? raw.cleanup_counts : {};
    const cleanupCounts = {
      generated: Number(cleanupCountsRaw.generated) || 0,
      covers: Number(cleanupCountsRaw.covers) || 0,
      sounds: Number(cleanupCountsRaw.sounds) || 0,
      audio: Number(cleanupCountsRaw.audio) || 0,
    };
    const cleanupRemaining = Number(raw.cleanup_total) || countList('needs_cleanup');
    const needs = {
      pack: countList('needs_pack'),
      audio: countList('needs_audio'),
      cast: countList('needs_cast'),
      scenes: countList('needs_scenes'),
      cover: countList('needs_cover'),
      panels: countList('needs_panel_backgrounds'),
      cleanup: cleanupRemaining,
    };
    const failures = Array.isArray(raw.failures) ? raw.failures.filter(isRecord).slice(0, 50) : [];
    return {
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : null,
      complete: !!raw.complete,
      totals: {
        worlds: Number(totals.worlds) || 0,
        packs: Number(totals.packs) || 0,
        packsWithAudio: Number((totals as Record<string, unknown>).packs_with_audio ?? totals.packsWithAudio) || 0,
      },
      needs,
      cleanupCounts,
      scope: typeof raw.scope === 'string' ? raw.scope : undefined,
      remaining: needs.pack + needs.audio + needs.cast + needs.scenes + needs.cover + needs.panels + needs.cleanup,
      skipped: !!raw.skipped,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
      blocked: !!raw.blocked || failures.length > 0,
      lastError: typeof raw.last_error === 'string' ? raw.last_error : undefined,
      failures,
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean)
    : [];
}

function ensureIsoString(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text && !Number.isNaN(Date.parse(text))) return new Date(text).toISOString();
  return new Date().toISOString();
}

function ensureNonEmptyString(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function ensureWorldDateString(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text) {
    try {
      return formatWorldDate(parseWorldDate(text));
    } catch {}
  }
  try {
    return formatWorldDate(parseWorldDate(fallback));
  } catch {}
  return '1900-07-15';
}

function ensureQuestTier(value: unknown): QuestTier {
  return value === 'Minor' || value === 'Standard' || value === 'Major' || value === 'Epic'
    ? value
    : 'Standard';
}

function ensureQuestType(value: unknown): QuestType {
  return value === 'plague' || value === 'war' || value === 'existential'
    ? value
    : 'existential';
}

function ensureQuestStatus(value: unknown): QuestSessionState['status'] {
  return value === 'active' || value === 'succeeded' || value === 'failed' || value === 'abandoned'
    ? value
    : 'active';
}

function ensureObjectiveStatus(value: unknown): 'locked' | 'active' | 'complete' | 'failed' {
  return value === 'locked' || value === 'active' || value === 'complete' || value === 'failed'
    ? value
    : 'locked';
}

function buildUniqueIntegrityId(seed: string, taken: Set<string>): string {
  const base = safeAssetName(seed || 'item').replace(/-/g, '_') || 'item';
  let candidate = base;
  let index = 2;
  while (!candidate || taken.has(candidate)) {
    candidate = `${base}_${index++}`;
  }
  taken.add(candidate);
  return candidate;
}

function generatedFileFromUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw || /^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return undefined;
  let rel = '';
  if (raw.startsWith('/generated/')) rel = raw.slice(1);
  else if (raw.startsWith('generated/')) rel = raw;
  else if (raw.startsWith('./generated/')) rel = raw.slice(2);
  else if (raw.startsWith('/public/generated/')) rel = raw.slice(1);
  else if (raw.startsWith('public/generated/')) rel = raw;
  else if (raw.startsWith('/covers/')) rel = raw.slice(1);
  else if (raw.startsWith('covers/')) rel = raw;
  else if (raw.startsWith('/public/covers/')) rel = raw.slice(1);
  else if (raw.startsWith('public/covers/')) rel = raw;
  else return undefined;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return undefined;
  }
  if (rel.startsWith('generated/')) return join(PUBLIC_DIR, rel);
  if (rel.startsWith('covers/')) return join(PUBLIC_DIR, rel);
  if (rel.startsWith('public/generated/')) return join(REPO_ROOT, rel);
  if (rel.startsWith('public/covers/')) return join(REPO_ROOT, rel);
  return undefined;
}

function normalizeIntegrityImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw || isUnsafeProxyImageUrl(raw)) return undefined;
  if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;
  const file = generatedFileFromUrl(raw);
  if (!file || !existsSync(file)) return undefined;
  try {
    if (!statSync(file).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const normalized = file.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  // Try /public/generated/ first, then /public/covers/ - we want the URL-form (e.g. /generated/.. or /covers/..)
  for (const marker of ['/public/generated/', '/public/covers/']) {
    const index = lower.indexOf(marker);
    if (index !== -1) return normalized.slice(index + '/public'.length);
  }
  return undefined;
}

function listGeneratedFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function collectReferencedGeneratedFiles(): Set<string> {
  const refs = new Set<string>();
  const add = (value: unknown) => {
    const file = generatedFileFromUrl(value);
    if (file) refs.add(file);
  };
  for (const world of worlds.values()) {
    const imageWorld = world as any;
    add(imageWorld.images?.cover);
    Object.values(imageWorld.images?.portraits ?? {}).forEach(add);
    Object.values(imageWorld.images?.swimwearPortraits ?? {}).forEach(add);
    Object.values(imageWorld.images?.scenes ?? {}).forEach(add);
    for (const npc of world.npcs ?? []) {
      add((npc as any)?.images?.portrait);
      add((npc as any)?.images?.swimwear);
    }
    for (const loc of world.locations ?? []) {
      add((loc as any)?.imageUrl);
      add((loc as any)?.photoUrl);
      add((loc as any)?.sceneUrl);
      add((loc as any)?.generatedImageUrl);
    }
  }
  for (const player of globalPlayers.values()) {
    add(player.portraitUrl);
    add(player.photoUrl);
    add(player.imageUrl);
    add(player.avatarUrl);
  }
  for (const session of sessions.values()) {
    add(session.portraitUrl);
    add(session.photoUrl);
    add(session.imageUrl);
    add(session.avatarUrl);
  }
  return refs;
}

function collectStaticGeneratedFiles(): Set<string> {
  const refs = new Set<string>();
  const exts = new Set(['.html', '.js', '.css']);
  const stack = [PUBLIC_DIR];
  const rx = /\/generated\/[^"'`\s)]+/g;
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (full === GENERATED_DIR) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const lowered = entry.name.toLowerCase();
      if (![...exts].some(ext => lowered.endsWith(ext))) continue;
      try {
        const text = readFileSync(full, 'utf-8');
        for (const match of text.matchAll(rx)) {
          const file = generatedFileFromUrl(match[0]);
          if (file) refs.add(file);
        }
      } catch {}
    }
  }
  return refs;
}

function normalizeQuestFactList(value: unknown, fallbackWorldId: string, fallbackNpcIds: Set<string>, worldNpcIdsById: Map<string, Set<string>>): QuestFact[] {
  const facts: QuestFact[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isRecord(raw)) continue;
    const worldId = typeof raw.worldId === 'string' && worlds.has(raw.worldId) ? raw.worldId : fallbackWorldId;
    const npcSet = worldNpcIdsById.get(worldId) ?? fallbackNpcIds;
    const fact: QuestFact = {
      id: buildUniqueIntegrityId(typeof raw.id === 'string' ? raw.id : 'fact', seen),
      kind: raw.kind === 'persuasion' || raw.kind === 'discovery' || raw.kind === 'choice' || raw.kind === 'world_state' ? raw.kind : 'discovery',
      summary: ensureNonEmptyString(raw.summary, typeof raw.id === 'string' ? raw.id : 'Recovered fact'),
      worldId,
      createdAt: ensureIsoString(raw.createdAt),
      createdAtTurn: typeof raw.createdAtTurn === 'number' && Number.isFinite(raw.createdAtTurn) ? raw.createdAtTurn : undefined,
    };
    if (typeof raw.npcId === 'string' && npcSet.has(raw.npcId)) fact.npcId = raw.npcId;
    facts.push(fact);
  }
  return facts;
}

function normalizeRewardList<T extends { id: string; name: string }>(
  value: unknown,
  kind: 'medal' | 'achievement',
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isRecord(raw)) continue;
    const id = buildUniqueIntegrityId(typeof raw.id === 'string' ? raw.id : kind, seen);
    const base = {
      id,
      name: ensureNonEmptyString(raw.name, id),
    } as T;
    if (kind === 'medal') {
      (base as any).tier = ensureQuestTier(raw.tier);
      if (raw.questType === 'plague' || raw.questType === 'war' || raw.questType === 'existential') (base as any).questType = raw.questType;
    }
    if (typeof raw.questId === 'string' && raw.questId.trim()) (base as any).questId = raw.questId.trim();
    (base as any).earnedAt = ensureIsoString((raw as any).earnedAt);
    out.push(base);
  }
  return out;
}

function normalizeQuestEchoList(value: unknown): QuestEcho[] {
  const out: QuestEcho[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isRecord(raw)) continue;
    out.push({
      id: buildUniqueIntegrityId(typeof raw.id === 'string' ? raw.id : 'echo', seen),
      questId: ensureNonEmptyString(raw.questId, typeof raw.id === 'string' ? raw.id : 'quest'),
      questName: ensureNonEmptyString(raw.questName, typeof raw.questId === 'string' ? raw.questId : 'Recovered Quest'),
      status: raw.status === 'succeeded' || raw.status === 'failed' || raw.status === 'abandoned' ? raw.status : 'failed',
      message: ensureNonEmptyString(raw.message, ensureNonEmptyString(raw.questName, 'Recovered quest outcome')),
      createdAt: ensureIsoString(raw.createdAt),
    });
  }
  return out;
}

function normalizeQuestRequirements(value: unknown, fallbackWorldId: string, fallbackNpcId: string | undefined, worldNpcIdsById: Map<string, Set<string>>): QuestRequirement[] {
  const out: QuestRequirement[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isRecord(raw) || typeof raw.kind !== 'string') continue;
    if (raw.kind === 'medal' || raw.kind === 'achievement' || raw.kind === 'quest_fact') {
      out.push({ kind: raw.kind, id: buildUniqueIntegrityId(typeof raw.id === 'string' ? raw.id : raw.kind, seen), ...(typeof raw.label === 'string' && raw.label.trim() ? { label: raw.label.trim() } : {}) });
      continue;
    }
    if (raw.kind === 'weather' && typeof raw.condition === 'string' && raw.condition.trim()) {
      out.push({ kind: 'weather', condition: raw.condition.trim(), ...(typeof raw.label === 'string' && raw.label.trim() ? { label: raw.label.trim() } : {}) });
      continue;
    }
    if (raw.kind === 'player_state' && (raw.state === 'invisible' || raw.state === 'cloaked')) {
      out.push({ kind: 'player_state', state: raw.state, ...(typeof raw.label === 'string' && raw.label.trim() ? { label: raw.label.trim() } : {}) });
      continue;
    }
    if (raw.kind === 'impossible_gift') {
      const worldId = typeof raw.worldId === 'string' && worlds.has(raw.worldId) ? raw.worldId : fallbackWorldId;
      const npcSet = worldNpcIdsById.get(worldId) ?? new Set<string>();
      const npcId = typeof raw.npcId === 'string' && npcSet.has(raw.npcId) ? raw.npcId : fallbackNpcId;
      if (!npcId) continue;
      out.push({
        kind: 'impossible_gift',
        npcId,
        ...(worldId ? { worldId } : {}),
        ...(typeof raw.giftPattern === 'string' && raw.giftPattern.trim() ? { giftPattern: raw.giftPattern.trim() } : {}),
        ...(typeof raw.label === 'string' && raw.label.trim() ? { label: raw.label.trim() } : {}),
        ...(typeof raw.requestText === 'string' && raw.requestText.trim() ? { requestText: raw.requestText.trim() } : {}),
        ...(typeof raw.hintText === 'string' && raw.hintText.trim() ? { hintText: raw.hintText.trim() } : {}),
      });
    }
  }
  return out;
}

function normalizeQuestState(
  rawQuest: unknown,
  baseWorldId: string,
  baseLocationId: string,
  ownerSessionId?: string,
  sessionIds?: Set<string>,
): QuestSessionState | undefined {
  if (!isRecord(rawQuest)) return undefined;
  const worldNpcIdsById = new Map<string, Set<string>>();
  const worldLocIdsById = new Map<string, Set<string>>();
  for (const [worldId, world] of worlds.entries()) {
    worldNpcIdsById.set(worldId, new Set((world.npcs ?? []).map(n => n.id)));
    worldLocIdsById.set(worldId, new Set((world.locations ?? []).map(l => l.id)));
  }
  const quest = cloneData(rawQuest) as any;
  const fallbackWorld = worlds.get(baseWorldId);
  const fallbackNpcIds = worldNpcIdsById.get(baseWorldId) ?? new Set<string>();
  const fallbackLocIds = worldLocIdsById.get(baseWorldId) ?? new Set<string>();
  if (!fallbackWorld || !fallbackLocIds.size) return undefined;
  ensureWorldClock(fallbackWorld);
  quest.id = ensureNonEmptyString(quest.id, `quest_${randomUUID().slice(0, 8)}`);
  quest.templateId = ensureNonEmptyString(quest.templateId, quest.id);
  quest.timelineId = ensureNonEmptyString(quest.timelineId, `timeline_${quest.id}`);
  quest.type = ensureQuestType(quest.type);
  quest.tier = ensureQuestTier(quest.tier);
  quest.status = ensureQuestStatus(quest.status);
  quest.name = ensureNonEmptyString(quest.name, quest.title || 'Recovered Quest');
  if (typeof quest.title !== 'string' || !quest.title.trim()) quest.title = quest.name;
  if (typeof quest.detail !== 'string') quest.detail = '';
  const knownWorldIds = new Set(worlds.keys());
  if (!knownWorldIds.has(quest.currentWorldId)) quest.currentWorldId = baseWorldId;
  const currentWorld = worlds.get(quest.currentWorldId) ?? fallbackWorld;
  ensureWorldClock(currentWorld);
  const currentLocIds = new Set((currentWorld?.locations ?? []).map(loc => loc.id));
  if (!currentLocIds.has(quest.currentLocationId)) quest.currentLocationId = currentLocIds.has(baseLocationId) ? baseLocationId : ((currentWorld?.locations ?? [])[0]?.id || baseLocationId);
  quest.currentDate = ensureWorldDateString(quest.currentDate, currentWorld.currentDate ?? defaultWorldDate(currentWorld));
  quest.currentTime = typeof quest.currentTime === 'number' && Number.isFinite(quest.currentTime) ? quest.currentTime : 12;
  quest.dayCount = typeof quest.dayCount === 'number' && Number.isFinite(quest.dayCount) ? quest.dayCount : 1;
  if (quest.currentWeather && !isRecord(quest.currentWeather)) delete quest.currentWeather;
  if (!isRecord(quest.baseReturn)) quest.baseReturn = {};
  if (!knownWorldIds.has(quest.baseReturn.worldId)) quest.baseReturn.worldId = baseWorldId;
  const baseReturnWorld = worlds.get(quest.baseReturn.worldId) ?? fallbackWorld;
  ensureWorldClock(baseReturnWorld);
  const baseReturnLocIds = new Set((baseReturnWorld?.locations ?? []).map(loc => loc.id));
  if (!baseReturnLocIds.has(quest.baseReturn.locationId)) quest.baseReturn.locationId = baseReturnLocIds.has(baseLocationId) ? baseLocationId : ((baseReturnWorld?.locations ?? [])[0]?.id || baseLocationId);
  quest.baseReturn.currentDate = ensureWorldDateString(quest.baseReturn.currentDate, quest.currentDate ?? baseReturnWorld.currentDate ?? defaultWorldDate(baseReturnWorld));
  quest.baseReturn.currentTime = typeof quest.baseReturn.currentTime === 'number' && Number.isFinite(quest.baseReturn.currentTime) ? quest.baseReturn.currentTime : 12;
  quest.baseReturn.dayCount = typeof quest.baseReturn.dayCount === 'number' && Number.isFinite(quest.baseReturn.dayCount) ? quest.baseReturn.dayCount : 1;
  if (quest.baseReturn.currentWeather && !isRecord(quest.baseReturn.currentWeather)) delete quest.baseReturn.currentWeather;
  quest.ownerSessionId = ownerSessionId && (!sessionIds || sessionIds.has(ownerSessionId))
    ? ownerSessionId
    : (typeof quest.ownerSessionId === 'string' && (!sessionIds || sessionIds.has(quest.ownerSessionId)) ? quest.ownerSessionId : ownerSessionId || '');
  quest.participantSessionIds = Array.from(new Set(asStringArray(quest.participantSessionIds).filter(id => !sessionIds || sessionIds.has(id))));
  if (quest.ownerSessionId && !quest.participantSessionIds.includes(quest.ownerSessionId)) quest.participantSessionIds.unshift(quest.ownerSessionId);
  const sanitizeParticipantReturn = (value: any): QuestParticipantReturn | undefined => {
    if (!isRecord(value)) return undefined;
    const worldId = typeof value.worldId === 'string' && knownWorldIds.has(value.worldId) ? value.worldId : quest.baseReturn.worldId;
    const world = worlds.get(worldId) ?? baseReturnWorld;
    ensureWorldClock(world);
    const locIds = new Set((world?.locations ?? []).map(loc => loc.id));
    const locationId = typeof value.locationId === 'string' && locIds.has(value.locationId)
      ? value.locationId
      : (locIds.has(quest.baseReturn.locationId) ? quest.baseReturn.locationId : ((world?.locations ?? [])[0]?.id || quest.baseReturn.locationId));
    if (!locationId) return undefined;
    return {
      worldId,
      locationId,
      currentDate: ensureWorldDateString(value.currentDate, world.currentDate ?? quest.baseReturn.currentDate),
      currentTime: typeof value.currentTime === 'number' && Number.isFinite(value.currentTime) ? value.currentTime : quest.baseReturn.currentTime,
      dayCount: typeof value.dayCount === 'number' && Number.isFinite(value.dayCount) ? value.dayCount : quest.baseReturn.dayCount,
      ...(isRecord(value.currentWeather) ? { currentWeather: cloneData(value.currentWeather as QuestParticipantReturn['currentWeather']) } : {}),
    };
  };
  const nextParticipantReturns: Record<string, QuestParticipantReturn> = {};
  for (const [participantId, value] of Object.entries(isRecord(quest.participantReturns) ? quest.participantReturns : {})) {
    if (sessionIds && !sessionIds.has(participantId)) continue;
    const sanitized = sanitizeParticipantReturn(value);
    if (sanitized) nextParticipantReturns[participantId] = sanitized;
  }
  quest.participantReturns = nextParticipantReturns;
  const nextParticipantLocations: Record<string, QuestParticipantLocation> = {};
  for (const [participantId, value] of Object.entries(isRecord(quest.participantLocations) ? quest.participantLocations : {})) {
    if (sessionIds && !sessionIds.has(participantId)) continue;
    if (!isRecord(value)) continue;
    const worldId = typeof value.worldId === 'string' && knownWorldIds.has(value.worldId) ? value.worldId : quest.currentWorldId;
    const locIds = worldLocIdsById.get(worldId) ?? fallbackLocIds;
    const locationId = typeof value.locationId === 'string' && locIds.has(value.locationId)
      ? value.locationId
      : (locIds.has(quest.currentLocationId) ? quest.currentLocationId : Array.from(locIds)[0]);
    if (!locationId) continue;
    nextParticipantLocations[participantId] = { worldId, locationId };
  }
  quest.participantLocations = nextParticipantLocations;
  quest.forkedWorldIds = asStringArray(quest.forkedWorldIds).filter(id => knownWorldIds.has(id) || isRecord(quest.forkedWorlds?.[id]) || isRecord(quest.forkedWorldData?.[id]));
  quest.portals = (Array.isArray(quest.portals) ? quest.portals : []).map((portal: any, index: number) => {
    if (!isRecord(portal)) return null;
    const fromWorldId = knownWorldIds.has(portal.fromWorldId) ? portal.fromWorldId : quest.currentWorldId;
    const locIds = worldLocIdsById.get(fromWorldId) ?? fallbackLocIds;
    const locationId = locIds.has(portal.locationId) ? portal.locationId : (locIds.has(quest.currentLocationId) ? quest.currentLocationId : Array.from(locIds)[0]);
    const linkedWorldIds = asStringArray(portal.linkedWorldIds).filter(id => knownWorldIds.has(id) || quest.forkedWorldIds.includes(id));
    if (!locationId) return null;
    return {
      ...portal,
      id: ensureNonEmptyString(portal.id, `portal_${index + 1}`),
      fromWorldId,
      fromWorldName: ensureNonEmptyString(portal.fromWorldName, worlds.get(fromWorldId)?.concept || fromWorldId),
      locationId,
      locationName: ensureNonEmptyString(portal.locationName, (worlds.get(fromWorldId)?.locations ?? []).find(loc => loc.id === locationId)?.name || locationId),
      linkedWorldIds,
      discovered: Boolean(portal.discovered),
    };
  }).filter(Boolean);
  const objectives = (Array.isArray(quest.objectives) ? quest.objectives : []).map((objective: any, index: number) => {
    if (!isRecord(objective)) return null;
    const worldId = knownWorldIds.has(objective.worldId) ? objective.worldId : quest.currentWorldId;
    const locIds = worldLocIdsById.get(worldId) ?? fallbackLocIds;
    const npcIds = worldNpcIdsById.get(worldId) ?? fallbackNpcIds;
    const locationId = typeof objective.locationId === 'string' && locIds.has(objective.locationId)
      ? objective.locationId
      : (locIds.has(quest.currentLocationId) ? quest.currentLocationId : undefined);
    const npcId = typeof objective.npcId === 'string' && npcIds.has(objective.npcId) ? objective.npcId : undefined;
    return {
      ...objective,
      id: ensureNonEmptyString(objective.id, `objective_${index + 1}`),
      title: ensureNonEmptyString(objective.title, `Objective ${index + 1}`),
      narrative: ensureNonEmptyString(objective.narrative, objective.title || `Objective ${index + 1}`),
      kind: typeof objective.kind === 'string' ? objective.kind : 'action',
      status: ensureObjectiveStatus(objective.status),
      worldId,
      ...(locationId ? { locationId, locationName: ensureNonEmptyString(objective.locationName, (worlds.get(worldId)?.locations ?? []).find(loc => loc.id === locationId)?.name || locationId) } : {}),
      ...(npcId ? { npcId, npcName: ensureNonEmptyString(objective.npcName, (worlds.get(worldId)?.npcs ?? []).find(npc => npc.id === npcId)?.name || npcId) } : {}),
      requirements: normalizeQuestRequirements(objective.requirements, worldId, npcId ?? quest.hookNpcId, worldNpcIdsById),
      emitsFacts: normalizeQuestFactList(objective.emitsFacts, worldId, npcIds, worldNpcIdsById).map(fact => {
        const { createdAt, createdAtTurn, ...rest } = fact;
        return rest;
      }),
    };
  }).filter(Boolean);
  quest.objectives = objectives;
  const objectiveIds = new Set(objectives.map((objective: any) => objective.id));
  quest.inventory = (Array.isArray(quest.inventory) ? quest.inventory : []).map((item: any, index: number) => {
    if (!isRecord(item)) return null;
    const worldId = knownWorldIds.has(item.worldId) ? item.worldId : quest.currentWorldId;
    const locIds = worldLocIdsById.get(worldId) ?? fallbackLocIds;
    const npcIds = worldNpcIdsById.get(worldId) ?? fallbackNpcIds;
    const locationId = typeof item.locationId === 'string' && locIds.has(item.locationId)
      ? item.locationId
      : (locIds.has(quest.currentLocationId) ? quest.currentLocationId : Array.from(locIds)[0]);
    if (!locationId) return null;
    const sourceType = item.sourceType === 'npc' || item.sourceType === 'location' ? item.sourceType : 'location';
    const sourceId = typeof item.sourceId === 'string' && ((sourceType === 'npc' && npcIds.has(item.sourceId)) || (sourceType === 'location' && locIds.has(item.sourceId)))
      ? item.sourceId
      : undefined;
    return {
      ...item,
      id: ensureNonEmptyString(item.id, `item_${index + 1}`),
      name: ensureNonEmptyString(item.name, `Recovered item ${index + 1}`),
      description: ensureNonEmptyString(item.description, item.name || `Recovered item ${index + 1}`),
      sourceType,
      ...(sourceId ? { sourceId, sourceName: ensureNonEmptyString(item.sourceName, sourceId) } : { sourceId: '', sourceName: ensureNonEmptyString(item.sourceName, 'Unknown') }),
      worldId,
      locationId,
      requiredForObjectiveId: typeof item.requiredForObjectiveId === 'string' && objectiveIds.has(item.requiredForObjectiveId) ? item.requiredForObjectiveId : undefined,
      collected: Boolean(item.collected),
      collectedAtTurn: typeof item.collectedAtTurn === 'number' && Number.isFinite(item.collectedAtTurn) ? item.collectedAtTurn : undefined,
      triggerKeywords: asStringArray(item.triggerKeywords),
    };
  }).filter(Boolean);
  const inventoryIds = new Set((quest.inventory as any[]).map(item => item.id));
  for (const objective of quest.objectives as any[]) {
    objective.requiredItemIds = asStringArray(objective.requiredItemIds).filter((itemId: string) => inventoryIds.has(itemId));
  }
  quest.traps = (Array.isArray(quest.traps) ? quest.traps : []).map((trap: any, index: number) => {
    if (!isRecord(trap)) return null;
    return {
      ...trap,
      id: ensureNonEmptyString(trap.id, `trap_${index + 1}`),
      type: typeof trap.type === 'string' ? trap.type : 'deception',
      stage: typeof trap.stage === 'number' && Number.isFinite(trap.stage) ? trap.stage : index + 1,
      description: ensureNonEmptyString(trap.description, `Recovered trap ${index + 1}`),
      active: trap.active !== false,
      sprung: Boolean(trap.sprung),
    };
  }).filter(Boolean);
  const hookNpcIds = worldNpcIdsById.get(quest.currentWorldId) ?? fallbackNpcIds;
  if (!hookNpcIds.has(quest.hookNpcId)) quest.hookNpcId = Array.from(hookNpcIds)[0] || '';
  quest.hookNpcName = ensureNonEmptyString(quest.hookNpcName, (worlds.get(quest.currentWorldId)?.npcs ?? []).find(npc => npc.id === quest.hookNpcId)?.name || quest.hookNpcId || 'Unknown');
  quest.requirements = normalizeQuestRequirements(quest.requirements, quest.currentWorldId, quest.hookNpcId, worldNpcIdsById);
  quest.questFacts = normalizeQuestFactList(quest.questFacts, quest.currentWorldId, hookNpcIds, worldNpcIdsById);
  if (isRecord(quest.rewards)) {
    quest.rewards = {
      medals: normalizeRewardList<Omit<QuestMedal, 'earnedAt'>>(quest.rewards.medals, 'medal').map(({ earnedAt, ...rest }: any) => rest),
      achievements: normalizeRewardList<Omit<QuestAchievement, 'earnedAt'>>(quest.rewards.achievements, 'achievement').map(({ earnedAt, ...rest }: any) => rest),
    };
  } else {
    quest.rewards = { medals: [], achievements: [] };
  }
  quest.log = Array.isArray(quest.log) ? quest.log.map((entry: unknown) => String(entry ?? '').trim()).filter(Boolean) : [];
  quest.turnCounter = typeof quest.turnCounter === 'number' && Number.isFinite(quest.turnCounter) ? quest.turnCounter : 0;
  quest.estimatedTurns = typeof quest.estimatedTurns === 'number' && Number.isFinite(quest.estimatedTurns) ? quest.estimatedTurns : Math.max(quest.turnCounter + 1, 1);
  quest.deadlineTurns = typeof quest.deadlineTurns === 'number' && Number.isFinite(quest.deadlineTurns) ? quest.deadlineTurns : Math.max(quest.estimatedTurns, quest.turnCounter + 1);
  quest.urgencyStage = typeof quest.urgencyStage === 'number' && Number.isFinite(quest.urgencyStage) ? quest.urgencyStage : 0;
  quest.urgencyLabel = ensureNonEmptyString(quest.urgencyLabel, 'Active');
  quest.urgencyNarrative = ensureNonEmptyString(quest.urgencyNarrative, quest.detail || quest.name);
  quest.startedAt = ensureIsoString(quest.startedAt);
  if (quest.completedAt) quest.completedAt = ensureIsoString(quest.completedAt);
  if (quest.lastAdvancedAt) quest.lastAdvancedAt = ensureIsoString(quest.lastAdvancedAt);
  return quest as QuestSessionState;
}

function repairDataFilesOnDisk(): { corruptFilesQuarantined: number; worldFilesRenamed: number; sessionFilesRenamed: number; playersFilesRewritten: number; } {
  let corruptFilesQuarantined = 0;
  let worldFilesRenamed = 0;
  let sessionFilesRenamed = 0;
  let playersFilesRewritten = 0;
  const quarantine = (file: string, suffix: string) => {
    const target = `${file}.${suffix}.${Date.now()}.bak`;
    renameSync(file, target);
    corruptFilesQuarantined++;
  };
  for (const name of readdirSync(DATA_DIR)) {
    if (!name.endsWith('.json')) continue;
    const file = join(DATA_DIR, name);
    if (name === 'players.json') {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
        const players = Array.isArray(raw) ? raw : raw?.players;
        if (!Array.isArray(players)) throw new Error('invalid players root');
      } catch {
        quarantine(file, 'corrupt');
        saveGlobalPlayers(globalPlayers);
        playersFilesRewritten++;
      }
      continue;
    }
    const isWorldFile = name.startsWith('world-');
    const isSessionFile = name.startsWith('session-');
    if (!isWorldFile && !isSessionFile) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
      const embeddedId = typeof raw?.id === 'string' ? raw.id.trim() : '';
      if (!embeddedId) {
        quarantine(file, 'invalid-id');
        continue;
      }
      const expectedId = name.replace(/^world-/, '').replace(/^session-/, '').replace(/\.json$/, '');
      if (embeddedId === expectedId) continue;
      const target = join(DATA_DIR, `${isWorldFile ? 'world' : 'session'}-${embeddedId}.json`);
      if (existsSync(target)) quarantine(file, 'duplicate');
      else {
        renameSync(file, target);
        if (isWorldFile) worldFilesRenamed++;
        else sessionFilesRenamed++;
      }
    } catch {
      quarantine(file, 'corrupt');
    }
  }
  if (!existsSync(join(DATA_DIR, 'players.json'))) {
    saveGlobalPlayers(globalPlayers);
    playersFilesRewritten++;
  }
  return { corruptFilesQuarantined, worldFilesRenamed, sessionFilesRenamed, playersFilesRewritten };
}

function repairIntegrityState(): {
  proxyFixed: number;
  staleLocationRefsCleaned: number;
  staleQuestHooksCleaned: number;
  imageGenerationQueued: number;
  worldDataRepaired: number;
  npcRelationshipsRepaired: number;
  duplicateIdsRepaired: number;
  orphanedSessionsRemoved: number;
  playersRepaired: number;
  questStatesRepaired: number;
  generatedAssetsPruned: number;
  staleImageMapEntriesCleaned: number;
  corruptFilesQuarantined: number;
  worldFilesRenamed: number;
  sessionFilesRenamed: number;
  playersFilesRewritten: number;
} {
  let proxyFixed = 0;
  let staleLocationRefsCleaned = 0;
  let staleQuestHooksCleaned = 0;
  let imageGenerationQueued = 0;
  let worldDataRepaired = 0;
  let npcRelationshipsRepaired = 0;
  let duplicateIdsRepaired = 0;
  let orphanedSessionsRemoved = 0;
  let playersRepaired = 0;
  let questStatesRepaired = 0;
  let generatedAssetsPruned = 0;
  let staleImageMapEntriesCleaned = 0;
  const disk = repairDataFilesOnDisk();
  const worldLocationRemaps = new Map<string, Map<string, string>>();
  const worldNpcRemaps = new Map<string, Map<string, string>>();
  for (const world of worlds.values()) {
    let changed = false;
    let imageQueuedForWorld = false;
    world.concept = ensureNonEmptyString(world.concept, world.id);
    const locations = (Array.isArray(world.locations) ? world.locations : []).filter(isRecord) as any[];
    const locTaken = new Set<string>();
    const locRemap = new Map<string, string>();
    for (let i = 0; i < locations.length; i++) {
      const loc = locations[i];
      const originalId = typeof loc.id === 'string' ? loc.id : '';
      const nextId = originalId && !locTaken.has(originalId) ? originalId : buildUniqueIntegrityId(originalId || loc.name || `location_${i + 1}`, locTaken);
      if (!originalId || originalId !== nextId) {
        if (originalId) locRemap.set(originalId, nextId);
        duplicateIdsRepaired++;
        changed = true;
      }
      loc.id = nextId;
      loc.name = ensureNonEmptyString(loc.name, nextId);
    }
    const locationIds = new Set(locations.map(loc => loc.id));
    for (const loc of locations) {
      const next = asStringArray(loc.connectedTo).map(id => locRemap.get(id) ?? id).filter(id => locationIds.has(id) && id !== loc.id);
      if (JSON.stringify(loc.connectedTo ?? []) !== JSON.stringify(next)) {
        staleLocationRefsCleaned += Math.max(0, asStringArray(loc.connectedTo).length - next.length);
        loc.connectedTo = Array.from(new Set(next));
        changed = true;
      }
      const imageUrl = normalizeIntegrityImageUrl(loc.imageUrl || loc.photoUrl || loc.sceneUrl || loc.generatedImageUrl);
      if ((loc.imageUrl || loc.photoUrl || loc.sceneUrl || loc.generatedImageUrl) && !imageUrl) {
        staleImageMapEntriesCleaned++;
        changed = true;
      }
      if (imageUrl) loc.imageUrl = imageUrl;
      else {
        delete loc.imageUrl;
        delete loc.photoUrl;
        delete loc.sceneUrl;
        delete loc.generatedImageUrl;
      }
    }
    world.locations = locations as any;
    const npcs = (Array.isArray(world.npcs) ? world.npcs : []).filter(isRecord) as any[];
    const npcTaken = new Set<string>();
    const npcRemap = new Map<string, string>();
    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i];
      const originalId = typeof npc.id === 'string' ? npc.id : '';
      const nextId = originalId && !npcTaken.has(originalId) ? originalId : buildUniqueIntegrityId(originalId || npc.name || `npc_${i + 1}`, npcTaken);
      if (!originalId || originalId !== nextId) {
        if (originalId) npcRemap.set(originalId, nextId);
        duplicateIdsRepaired++;
        changed = true;
      }
      npc.id = nextId;
      npc.name = ensureNonEmptyString(npc.name, nextId);
      for (const field of ['homeLocationId', 'workLocationId'] as const) {
        const raw = typeof npc[field] === 'string' ? (locRemap.get(npc[field]) ?? npc[field]) : '';
        if (raw && locationIds.has(raw)) npc[field] = raw;
        else if (npc[field]) {
          delete npc[field];
          staleLocationRefsCleaned++;
          changed = true;
        }
      }
      const frequented = asStringArray(npc.frequentedLocations).map(id => locRemap.get(id) ?? id).filter(id => locationIds.has(id));
      if (JSON.stringify(npc.frequentedLocations ?? []) !== JSON.stringify(frequented)) {
        staleLocationRefsCleaned += Math.max(0, asStringArray(npc.frequentedLocations).length - frequented.length);
        npc.frequentedLocations = Array.from(new Set(frequented));
        changed = true;
      }
      if (Array.isArray(npc.relationships)) {
        const before = npc.relationships.length;
        npc.relationships = npc.relationships.filter((rel: any) => isRecord(rel)).map((rel: any) => {
          if (typeof rel.targetId === 'string' && npcRemap.has(rel.targetId)) rel.targetId = npcRemap.get(rel.targetId);
          return rel;
        });
        if (npc.relationships.length !== before) {
          npcRelationshipsRepaired += before - npc.relationships.length;
          changed = true;
        }
      }
      npc.images = isRecord(npc.images) ? npc.images : {};
      const portrait = normalizeIntegrityImageUrl(npc.images.portrait);
      const swimwear = normalizeIntegrityImageUrl(npc.images.swimwear);
      if (npc.images.portrait && !portrait) {
        delete npc.images.portrait;
        proxyFixed++;
        changed = true;
      } else if (portrait && npc.images.portrait !== portrait) {
        npc.images.portrait = portrait;
        proxyFixed++;
        changed = true;
      }
      if (npc.images.swimwear && !swimwear) {
        delete npc.images.swimwear;
        proxyFixed++;
        changed = true;
      } else if (swimwear && npc.images.swimwear !== swimwear) {
        npc.images.swimwear = swimwear;
        proxyFixed++;
        changed = true;
      }
    }
    const npcIds = new Set(npcs.map(npc => npc.id));
    for (const npc of npcs) {
      if (Array.isArray(npc.relationships)) {
        const before = npc.relationships.length;
        npc.relationships = npc.relationships.filter((rel: any) => !rel?.targetId || npcIds.has(rel.targetId));
        if (npc.relationships.length !== before) {
          npcRelationshipsRepaired += before - npc.relationships.length;
          changed = true;
        }
      }
    }
    world.npcs = npcs as any;
    const imageWorld = world as any;
    imageWorld.images = isRecord(imageWorld.images) ? imageWorld.images : {};
    const cover = normalizeIntegrityImageUrl(imageWorld.images.cover);
    if (imageWorld.images.cover && !cover) {
      delete imageWorld.images.cover;
      changed = true;
      staleImageMapEntriesCleaned++;
    } else if (cover && imageWorld.images.cover !== cover) {
      imageWorld.images.cover = cover;
      changed = true;
      proxyFixed++;
    }
    const cleanImageMap = (source: any, validIds: Set<string>, remap: Map<string, string>) => {
      const next: Record<string, string> = {};
      for (const [key, rawValue] of Object.entries(isRecord(source) ? source : {})) {
        const mapped = remap.get(key) ?? key;
        const normalized = normalizeIntegrityImageUrl(rawValue);
        if (!validIds.has(mapped) || !normalized) {
          staleImageMapEntriesCleaned++;
          changed = true;
          continue;
        }
        next[mapped] = normalized;
      }
      return next;
    };
    imageWorld.images.portraits = cleanImageMap(imageWorld.images.portraits, npcIds, npcRemap);
    imageWorld.images.swimwearPortraits = cleanImageMap(imageWorld.images.swimwearPortraits, npcIds, npcRemap);
    imageWorld.images.scenes = cleanImageMap(imageWorld.images.scenes, locationIds, locRemap);
    if (isRecord(world.npcSharedStates)) {
      const nextShared: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(world.npcSharedStates as Record<string, unknown>)) {
        const mapped = npcRemap.get(key) ?? key;
        if (!npcIds.has(mapped)) {
          changed = true;
          continue;
        }
        nextShared[mapped] = value;
      }
      (world as any).npcSharedStates = nextShared;
    }
    if (repairWorldReadModel(world)) {
      worldDataRepaired++;
      changed = true;
    }
    if (attachLocalGeneratedImages(world)) changed = true;
    const portraitCount = Object.keys(imageWorld.images?.portraits ?? {}).length;
    const adultSwimwearNpcCount = (world.npcs ?? []).filter(isAdultSwimwearNpc).length;
    const swimwearCount = Object.keys(imageWorld.images?.swimwearPortraits ?? {}).length;
    const sceneCount = Object.keys(imageWorld.images?.scenes ?? {}).length;
    const needsImageGeneration = !worldCoverImageUrl(world)
      || portraitCount < (world.npcs ?? []).length
      || swimwearCount < adultSwimwearNpcCount
      || sceneCount < (world.locations ?? []).length
      || ['failed', 'partial', undefined].includes(imageWorld.images?.status);
    if (needsImageGeneration) {
      queueWorldImageGeneration(world, false);
      imageGenerationQueued++;
      imageQueuedForWorld = true;
      changed = true;
    }
    if (!imageQueuedForWorld && imageWorld.images?.status === 'failed') {
      imageWorld.images.status = 'partial';
      changed = true;
    }
    if (changed) saveWorld(world);
    worldLocationRemaps.set(world.id, locRemap);
    worldNpcRemaps.set(world.id, npcRemap);
  }
  const sessionIds = new Set(sessions.keys());
  // [WG-SESSIONS-GUARD] If the worlds map is empty we're almost certainly in a load
  // race or failed reload — every session would look "orphaned" and get deleted,
  // which has previously nuked active play state. Only prune orphaned sessions when
  // at least one world is actually loaded.
  const worldsLoadedForOrphanCheck = worlds.size > 0;
  for (const [sessionId, session] of Array.from(sessions.entries())) {
    if (!session.id) session.id = sessionId;
    const world = worlds.get(session.worldId);
    if (!world) {
      // A world missing from the in-memory map may simply be budget-deferred (a stub,
      // loaded on demand). Only a world with no file on disk makes a session an orphan,
      // and even then the file is quarantined to data/_orphaned/, never deleted.
      const worldExists = worldStubs.has(session.worldId) || worldFileExists(session.worldId);
      if (worldsLoadedForOrphanCheck && !worldExists) {
        sessions.delete(sessionId);
        quarantineSessionFile(sessionId);
        orphanedSessionsRemoved++;
      }
      continue;
    }
    let changed = false;
    const locRemap = worldLocationRemaps.get(world.id) ?? new Map<string, string>();
    const npcRemap = worldNpcRemaps.get(world.id) ?? new Map<string, string>();
    const worldLocIds = new Set((world.locations ?? []).map(loc => loc.id));
    const worldNpcIds = new Set((world.npcs ?? []).map(npc => npc.id));
    session.playerName = ensureNonEmptyString(session.playerName, session.id);
    const mappedLocation = locRemap.get(session.currentLocationId) ?? session.currentLocationId;
    if (!worldLocIds.has(mappedLocation)) {
      session.currentLocationId = (world.locations ?? [])[0]?.id || mappedLocation || '';
      changed = true;
    } else if (mappedLocation !== session.currentLocationId) {
      session.currentLocationId = mappedLocation;
      changed = true;
    }
    const beforeNpcStateKeys = Object.keys(session.npcStates ?? {}).length;
    ensureSessionNpcStateIntegrity(session, world);
    for (const key of Object.keys(session.npcStates ?? {})) {
      const mapped = npcRemap.get(key) ?? key;
      if (!worldNpcIds.has(mapped)) {
        delete session.npcStates[key];
        changed = true;
        continue;
      }
      if (mapped !== key) {
        session.npcStates[mapped] = session.npcStates[key];
        delete session.npcStates[key];
        changed = true;
      }
    }
    if (Object.keys(session.npcStates ?? {}).length !== beforeNpcStateKeys) changed = true;
    const hooks = (Array.isArray((session as any).questHooks) ? (session as any).questHooks : []).filter(isRecord).map((hook: any, index: number) => {
      const npcId = typeof hook.npcId === 'string' ? (npcRemap.get(hook.npcId) ?? hook.npcId) : undefined;
      const locationId = typeof hook.locationId === 'string' ? (locRemap.get(hook.locationId) ?? hook.locationId) : undefined;
      if (locationId && !worldLocIds.has(locationId)) {
        staleQuestHooksCleaned++;
        changed = true;
        return null;
      }
      if (npcId && !worldNpcIds.has(npcId)) {
        staleQuestHooksCleaned++;
        changed = true;
        return null;
      }
      return {
        ...hook,
        id: ensureNonEmptyString(hook.id, `hook_${index + 1}`),
        npcId,
        locationId,
        requirements: normalizeQuestRequirements(hook.requirements, world.id, npcId, new Map([[world.id, worldNpcIds]])),
        rewards: {
          medals: normalizeRewardList<Omit<QuestMedal, 'earnedAt'>>(hook.rewards?.medals, 'medal').map(({ earnedAt, ...rest }: any) => rest),
          achievements: normalizeRewardList<Omit<QuestAchievement, 'earnedAt'>>(hook.rewards?.achievements, 'achievement').map(({ earnedAt, ...rest }: any) => rest),
        },
      };
    }).filter(Boolean);
    if (JSON.stringify((session as any).questHooks ?? []) !== JSON.stringify(hooks)) {
      (session as any).questHooks = hooks;
      changed = true;
    }
    const questEchoes = normalizeQuestEchoList(session.questEchoes);
    if (JSON.stringify(session.questEchoes ?? []) !== JSON.stringify(questEchoes)) {
      session.questEchoes = questEchoes;
      changed = true;
    }
    const normalizedQuest = normalizeQuestState(session.activeQuest, world.id, session.currentLocationId, session.id, sessionIds);
    if (JSON.stringify(session.activeQuest ?? null) !== JSON.stringify(normalizedQuest ?? null)) {
      session.activeQuest = normalizedQuest;
      if (normalizedQuest) questStatesRepaired++;
      changed = true;
    }
    if (changed) saveSession(session);
  }
  for (const player of globalPlayers.values()) {
    let changed = false;
    player.playerName = ensureNonEmptyString(player.playerName, player.id);
    const normalPin = typeof player.pin === 'string' ? player.pin.replace(/\D/g, '').slice(-3) : '';
    const nextPin = normalPin.length === 3 ? normalPin : undefined;
    if (player.pin !== nextPin) {
      player.pin = nextPin;
      changed = true;
    }
    const medals = normalizeRewardList<QuestMedal>(player.medals, 'medal');
    const achievements = normalizeRewardList<QuestAchievement>(player.achievements, 'achievement');
    const questFacts = normalizeQuestFactList(player.questFacts, Array.from(worlds.keys())[0] || '', new Set<string>(), new Map(Array.from(worlds.entries()).map(([id, world]) => [id, new Set((world.npcs ?? []).map(npc => npc.id))])));
    const questHistory = normalizeQuestEchoList(player.questHistory);
    if (JSON.stringify(player.medals ?? []) !== JSON.stringify(medals)) { player.medals = medals; changed = true; }
    if (JSON.stringify(player.achievements ?? []) !== JSON.stringify(achievements)) { player.achievements = achievements; changed = true; }
    if (JSON.stringify(player.questFacts ?? []) !== JSON.stringify(questFacts)) { player.questFacts = questFacts; changed = true; }
    if (JSON.stringify(player.questHistory ?? []) !== JSON.stringify(questHistory)) { player.questHistory = questHistory; changed = true; }
    const firstWorld = Array.from(worlds.values())[0];
    if (firstWorld) {
      const normalizedQuest = normalizeQuestState(player.activeQuest, firstWorld.id, firstWorld.locations?.[0]?.id || '', undefined, undefined);
      if (JSON.stringify(player.activeQuest ?? null) !== JSON.stringify(normalizedQuest ?? null)) {
        player.activeQuest = normalizedQuest;
        if (normalizedQuest) questStatesRepaired++;
        changed = true;
      }
    }
    if (changed) playersRepaired++;
  }
  saveGlobalPlayers(globalPlayers);
  const referencedFiles = new Set<string>([
    ...collectReferencedGeneratedFiles(),
    ...collectStaticGeneratedFiles(),
  ]);
  // Defensive: never auto-prune player portraits via this loop. globalPlayers
  // can be incomplete at prune time (load races, mid-compaction state, partial
  // mutation) and pruning has twice nuked every active player. Player portraits
  // are tiny — leaving the occasional orphan from a deleted player is fine.
  // Explicit cleanup should happen in DELETE /api/players/:playerId.
  for (const generatedFile of listGeneratedFilesRecursive(GENERATED_DIR)) {
    if (generatedFile.includes(`\\_imgcache\\`) || generatedFile.includes(`/_imgcache/`)) continue;
    if (generatedFile.includes('\\players\\') || generatedFile.includes('/players/')) continue;
    if (referencedFiles.has(generatedFile)) continue;
    // [WG-IMAGES-IMMUTABLE] Skip any file under generated/<worldId>/ while the world still
    // exists. JSON pointers can be transiently missing (resets, mid-build, post-restore) and
    // pruning has deleted 45 cover.jpg files this way. Files only get pruned when the world
    // itself is gone.
    {
      const normalised = generatedFile.replace(/\\/g, '/');
      const inGenerated = normalised.indexOf('/generated/');
      if (inGenerated >= 0) {
        const tail = normalised.slice(inGenerated + '/generated/'.length);
        const worldId = tail.split('/')[0];
        if (worldId && (worlds.has(worldId) || worldStubs.has(worldId) || worldFileExists(worldId))) continue;
      }
    }
    try {
      unlinkSync(generatedFile);
      generatedAssetsPruned++;
    } catch {}
  }
  rebindLoadedQuestInstances();
  return {
    proxyFixed,
    staleLocationRefsCleaned,
    staleQuestHooksCleaned,
    imageGenerationQueued,
    worldDataRepaired,
    npcRelationshipsRepaired,
    duplicateIdsRepaired,
    orphanedSessionsRemoved,
    playersRepaired,
    questStatesRepaired,
    generatedAssetsPruned,
    staleImageMapEntriesCleaned,
    corruptFilesQuarantined: disk.corruptFilesQuarantined,
    worldFilesRenamed: disk.worldFilesRenamed,
    sessionFilesRenamed: disk.sessionFilesRenamed,
    playersFilesRewritten: disk.playersFilesRewritten,
  };
}

app.post('/api/worlds/build', async (req, res) => {
  const concept = String(req.body?.concept ?? '').trim();
  const provider = String(req.body?.provider ?? 'anthropic').trim();
  const model = String(req.body?.model ?? '').trim();
  if (!concept) {
    res.status(400).json({ error: 'concept is required' });
    return;
  }
  if (!HARDENED_WORLD_PROVIDERS.has(provider)) {
    res.status(400).json({ error: 'Unsupported build provider', detail: `${provider} is not supported by the hardened builder` });
    return;
  }

  const buildId = `build_${randomUUID()}`;
  const npcs = clampBuildInt(req.body?.npcs, 40, 1, 150);
  const batchSize = clampBuildInt(req.body?.batchSize, 2, 1, 8);
  const locations = clampBuildInt(req.body?.locations, 14, 3, 80);
  const timelineEvents = clampBuildInt(req.body?.timelineEvents, 8, 1, 40);
  const retries = clampBuildInt(req.body?.retries, 3, 1, 8);

  const args = [
    '--id', buildId,
    '--concept', concept,
    '--provider', provider,
    '--npcs', String(npcs),
    '--batch-size', String(batchSize),
    '--locations', String(locations),
    '--timeline-events', String(timelineEvents),
    '--retries', String(retries),
    '--output', DATA_DIR,
  ];
  if (model) args.push('--model', model);

  let sourceMeta: { pdfPath: string; textPath: string; title: string } | undefined;
  {
    const sp = typeof req.body?.sourcePath === 'string' ? req.body.sourcePath.slice(0, 240) : '';
    const stp = typeof req.body?.sourceTextPath === 'string' ? req.body.sourceTextPath.slice(0, 240) : '';
    const st = typeof req.body?.sourceTitle === 'string' ? req.body.sourceTitle.slice(0, 120) : '';
    if (stp && !stp.includes('..')) {
      const absTxt = pathResolve(join(REPO_ROOT, stp.replace(/^\/+/, '')));
      if (!absTxt.startsWith(REPO_ROOT)) {
        // skip - path escapes project root
      } else if (existsSync(absTxt)) {
        args.push('--source-file', absTxt);
        sourceMeta = { pdfPath: sp || stp.replace(/\.txt$/i, ''), textPath: stp, title: st || 'Source document' };
      }
    }
  }
  // Optional year hint for TMDB cast/cover lookup. Locks the search to the right film/show
  // when the title is ambiguous across a franchise (Hellraiser 1987 vs 2022, Blade Runner
  // 1982 vs 2049, Carrie 1976 vs 2013, etc.). Validated 1800-2200; outside range = ignored.
  const sourceYearRaw = Number(req.body?.sourceYear);
  const sourceYear: number | undefined = (Number.isFinite(sourceYearRaw) && sourceYearRaw > 1800 && sourceYearRaw < 2200)
    ? Math.floor(sourceYearRaw)
    : undefined;

  try {
    const job = startHardenedWorldBuildJob(args, buildId, sourceMeta, sourceYear);
    res.status(202).json({ jobId: job.id, buildId: job.buildId, status: job.status, logs: job.logs });
  } catch (err) {
    console.error('[worldgen:build:error]', err);
    res.status(500).json({ error: 'Hardened world build failed', detail: String(err) });
  }
});

app.get('/api/worlds/build/:jobId', (req, res) => {
  const job = buildJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Build job not found' }); return; }
  res.json({
    jobId: job.id,
    buildId: job.buildId,
    startedAt: job.startedAt,
    status: job.status,
    logs: job.logs.slice(-120),
    error: job.error,
    world: job.world,
    resources: job.resources,
  });
});

app.delete('/api/worlds/build/:jobId', (req, res) => {
  const job = buildJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Build job not found' }); return; }
  if (job.status === 'running') {
    job.status = 'cancelled';
    job.error = 'Build cancelled';
    appendBuildLog(job, 'Build cancelled by user.');
    try { job.child?.kill?.(); } catch {}
    job.child = undefined;
  }
  res.json({ jobId: job.id, status: job.status, logs: job.logs.slice(-120) });
});

// ── Set Baseline ──────────────────────────────────────────────────────────
app.post('/api/worlds/:id/baseline', (req, res) => {
  const id = String(req.params.id);
  if (!worlds.has(id)) { res.status(404).json({ error: 'World not found' }); return; }
  const liveFile = join(DATA_DIR, `world-${id}.json`);
  if (!existsSync(liveFile)) { res.status(404).json({ error: 'World file not found on disk' }); return; }
  const blDir = join(DATA_DIR, '.baselines');
  if (!existsSync(blDir)) mkdirSync(blDir, { recursive: true });
  const blFile = join(blDir, `${id}.json`);
  if (existsSync(blFile)) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(blDir, `${id}.prev-${stamp}.json`), readFileSync(blFile));
    } catch (err) { console.error('[worldgen:baseline:archive]', err); }
  }
  const raw = readFileSync(liveFile, 'utf-8');
  writeFileSync(blFile, raw);
  let w: any;
  try { w = JSON.parse(raw); } catch (e) {
    res.status(500).json({ error: 'Baseline file is corrupt', detail: 'JSON parse failed' }); return;
  }
  console.log(`[worldgen:baseline] set for ${id} ��� npcs=${w.npcs?.length??0} locs=${w.locations?.length??0}`);
  res.json({ ok: true, baseline: true, npcs: w.npcs?.length??0, locations: w.locations?.length??0, timeline: w.timeline?.length??0, factions: ((w as any).factions??[]).length });
});

// ── Restore Baseline ──────────────────────────────────────────────────────
app.post('/api/worlds/:id/reset', (req, res) => {
  const id = String(req.params.id);
  if (!worlds.has(id)) { res.status(404).json({ error: 'World not found' }); return; }
  const blFile = join(DATA_DIR, '.baselines', `${id}.json`);
  if (!existsSync(blFile)) {
    res.status(409).json({ error: 'No baseline set for this world', detail: 'Use "Set current state as baseline" first.' });
    return;
  }
  try {
    const live = join(DATA_DIR, `world-${id}.json`);
    if (existsSync(live)) {
      const bkDir = join(DATA_DIR, '_backups');
      if (!existsSync(bkDir)) mkdirSync(bkDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(bkDir, `world-${id}__pre-restore-${stamp}.json`), readFileSync(live));
    }
  } catch (err) { console.error('[worldgen:restore:backup]', err); }
  const raw = readFileSync(blFile, 'utf-8');
  let w: WorldDNA;
  try { w = JSON.parse(raw) as WorldDNA; } catch (e) {
    res.status(500).json({ error: 'Baseline file is corrupt', detail: 'JSON parse failed' }); return;
  }
  worlds.set(id, w);
  saveWorld(w);
  try { queueWorldImageGeneration(w); } catch {}
  console.log(`[worldgen:restore] baseline for ${id} — npcs=${w.npcs?.length??0} locs=${w.locations?.length??0}`);
  res.json({ ok: true, mode: 'baseline', restored: true, world: w, npcs: w.npcs?.length??0, locations: w.locations?.length??0, timeline: w.timeline?.length??0, factions: ((w as any).factions??[]).length });
});

app.get('/api/worlds/check-data', async (req, res) => {
  try {
    const repair = repairIntegrityState();
    await flushPendingSaves();
    const result = await runWorldDataCheck(req.query.photosOnly === '1' || req.query.photosOnly === 'true');
    const payload = JSON.parse(result.stdout);
    const repairs: string[] = [];
    if (repair.proxyFixed > 0) repairs.push(`Repaired ${repair.proxyFixed} broken or proxied image reference(s)`);
    if (repair.staleLocationRefsCleaned > 0) repairs.push(`Cleaned ${repair.staleLocationRefsCleaned} stale location reference(s)`);
    if (repair.staleQuestHooksCleaned > 0) repairs.push(`Cleaned ${repair.staleQuestHooksCleaned} broken quest hook reference(s)`);
    if (repair.imageGenerationQueued > 0) repairs.push(`Queued image generation for ${repair.imageGenerationQueued} world(s) with missing assets`);
    if (repair.worldDataRepaired > 0) repairs.push(`Repaired world read-model metadata for ${repair.worldDataRepaired} world(s)`);
    if (repair.npcRelationshipsRepaired > 0) repairs.push(`Removed ${repair.npcRelationshipsRepaired} invalid NPC relationship(s)`);
    if (repair.duplicateIdsRepaired > 0) repairs.push(`Repaired ${repair.duplicateIdsRepaired} duplicate or missing NPC/location ID reference(s)`);
    if (repair.orphanedSessionsRemoved > 0) repairs.push(`Removed ${repair.orphanedSessionsRemoved} orphaned session file(s)`);
    if (repair.playersRepaired > 0) repairs.push(`Normalized ${repair.playersRepaired} global player record(s)`);
    if (repair.questStatesRepaired > 0) repairs.push(`Sanitized ${repair.questStatesRepaired} quest state record(s)`);
    if (repair.generatedAssetsPruned > 0) repairs.push(`Deleted ${repair.generatedAssetsPruned} unreferenced generated asset(s)`);
    if (repair.staleImageMapEntriesCleaned > 0) repairs.push(`Removed ${repair.staleImageMapEntriesCleaned} stale image map entry/entries`);
    if (repair.corruptFilesQuarantined > 0) repairs.push(`Quarantined ${repair.corruptFilesQuarantined} corrupt or unreadable data file(s)`);
    if (repair.worldFilesRenamed > 0) repairs.push(`Renamed ${repair.worldFilesRenamed} misnamed world file(s) to match embedded IDs`);
    if (repair.sessionFilesRenamed > 0) repairs.push(`Renamed ${repair.sessionFilesRenamed} misnamed session file(s) to match embedded IDs`);
    if (repair.playersFilesRewritten > 0) repairs.push(`Rewrote ${repair.playersFilesRewritten} player data file(s) into canonical form`);

    payload.summary = payload.summary ?? {};
    payload.summary.proxyUrlsFixed = repair.proxyFixed;
    payload.summary.staleLocationRefsCleaned = repair.staleLocationRefsCleaned;
    payload.summary.staleQuestHooksCleaned = repair.staleQuestHooksCleaned;
    payload.summary.imageGenerationQueued = repair.imageGenerationQueued;
    payload.summary.worldDataRepaired = repair.worldDataRepaired;
    payload.summary.npcRelationshipsRepaired = repair.npcRelationshipsRepaired;
    payload.summary.duplicateIdsRepaired = repair.duplicateIdsRepaired;
    payload.summary.orphanedSessionsRemoved = repair.orphanedSessionsRemoved;
    payload.summary.playersRepaired = repair.playersRepaired;
    payload.summary.questStatesRepaired = repair.questStatesRepaired;
    payload.summary.generatedAssetsPruned = repair.generatedAssetsPruned;
    payload.summary.staleImageMapEntriesCleaned = repair.staleImageMapEntriesCleaned;
    payload.summary.corruptFilesQuarantined = repair.corruptFilesQuarantined;
    payload.summary.worldFilesRenamed = repair.worldFilesRenamed;
    payload.summary.sessionFilesRenamed = repair.sessionFilesRenamed;
    payload.summary.playersFilesRewritten = repair.playersFilesRewritten;
    payload.summary.totalRepairs = repair.proxyFixed + repair.staleLocationRefsCleaned + repair.staleQuestHooksCleaned + repair.imageGenerationQueued + repair.worldDataRepaired + repair.npcRelationshipsRepaired + repair.duplicateIdsRepaired + repair.orphanedSessionsRemoved + repair.playersRepaired + repair.questStatesRepaired + repair.generatedAssetsPruned + repair.staleImageMapEntriesCleaned + repair.corruptFilesQuarantined + repair.worldFilesRenamed + repair.sessionFilesRenamed + repair.playersFilesRewritten;
    payload.summary.healthStatus = (payload.errors?.length ?? 0) === 0
      ? ((payload.warnings?.length ?? 0) === 0 ? 'healthy' : 'warnings')
      : 'errors';
    payload.repairs = repairs;
    if (repairs.length > 0) {
      payload.warnings = payload.warnings ?? [];
      repairs.forEach(f => payload.warnings.unshift(f));
    }
    res.status(payload.ok ? 200 : 422).json(payload);
  } catch (err) {
    console.error('[worldgen:check-data:error]', err);
    res.status(500).json({ ok: false, error: 'World data check failed', detail: String(err) });
  }
});

app.get('/api/orchestrator/cron', (req, res) => {
  try {
    res.json({
      ok: true,
      cron: readOrchestratorCronState(),
      progress: readOrchestratorProgressSummary(),
    });
  } catch (err) {
    console.error('[worldgen:orchestrator:cron:get]', err);
    res.status(500).json({ ok: false, error: 'Failed to read orchestrator cron state', detail: String(err) });
  }
});

app.get('/api/orchestrator/status', async (req, res) => {
  try {
    const refreshEnabled = (req.query.refresh === '1' || req.query.refresh === 'true') && orchestratorRunState?.running !== true;
    const statusRefresh = refreshEnabled ? await runOrchestratorStatusCheck() : null;
    let raw: any = null;
    let mtimeMs = 0;
    if (existsSync(ORCHESTRATOR_PROGRESS_FILE)) {
      raw = JSON.parse(readFileSync(ORCHESTRATOR_PROGRESS_FILE, 'utf8').replace(/^\uFEFF/, ''));
      try { mtimeMs = statSync(ORCHESTRATOR_PROGRESS_FILE).mtimeMs; } catch {}
    }
    const cron = readOrchestratorCronState();
    const summary = readOrchestratorProgressSummary();
    const arr = (k: string) => Array.isArray(raw?.[k]) ? raw[k] : [];
    const now = Date.now();
    const ageMs = mtimeMs ? Math.max(0, now - mtimeMs) : null;
    const nameFor = (id: string): string => {
      const w = worlds.get(id);
      const concept = (w as any)?.concept;
      if (typeof concept === 'string' && concept.trim()) return concept.trim().slice(0, 80);
      return id;
    };
    const asId = (v: any): { id: string; name: string } => ({ id: String(v), name: nameFor(String(v)) });
    const audioTuple = (t: any) => Array.isArray(t)
      ? { id: String(t[0] ?? ''), name: nameFor(String(t[0] ?? '')), packKey: String(t[1] ?? ''), soundsCount: Number(t[2] ?? 0), themesCount: Number(t[3] ?? 0) }
      : { id: '', name: '', packKey: '', soundsCount: 0, themesCount: 0 };
    const gapTuple = (t: any) => Array.isArray(t)
      ? { id: String(t[0] ?? ''), name: nameFor(String(t[0] ?? '')), have: Number(t[1] ?? 0), total: Number(t[2] ?? 0) }
      : { id: '', name: '', have: 0, total: 0 };
    res.json({
      ok: true,
      cron,
      summary,
      statusRefresh: statusRefresh ? {
        ok: statusRefresh.code === 0,
        code: statusRefresh.code,
        timedOut: !!statusRefresh.timedOut,
        error: statusRefresh.error || (statusRefresh.code === 0 ? undefined : (statusRefresh.stderr || statusRefresh.stdout).slice(-500)),
      } : { ok: true, skipped: true, reason: orchestratorRunState?.running ? 'orchestrator-running' : 'refresh-disabled' },
      run: orchestratorRunState,
      isActive: orchestratorRunState?.running === true || (ageMs !== null && ageMs < 90000),
      activity: _orchActivity.slice(0, 30).map(ev => ({ id: ev.id, kind: ev.kind, worldId: ev.worldId, worldName: ev.worldName, status: ev.status, startedAt: ev.startedAt, endedAt: ev.endedAt, durationMs: ev.durationMs, detail: ev.detail, ageMs: Date.now() - ev.startedAt })),
      inFlight: _orchActivity.filter(ev => ev.status === 'running').map(ev => ({ id: ev.id, kind: ev.kind, worldId: ev.worldId, worldName: ev.worldName, ageMs: Date.now() - ev.startedAt })),
      imageProviders: getImageGenProvidersState(),
      imageSlots: getImageGenSlotState(),
      lastRunAgeMs: ageMs,
      lastRunAt: mtimeMs ? new Date(mtimeMs).toISOString() : null,
      queues: {
        needs_pack: arr('needs_pack').map(asId),
        needs_audio: arr('needs_audio').map(audioTuple),
        needs_cast: arr('needs_cast').map(asId),
        needs_scenes: arr('needs_scenes').map(asId),
        needs_cover: arr('needs_cover').map(asId),
        needs_panel_backgrounds: arr('needs_panel_backgrounds').map(asId),
        needs_cleanup: arr('needs_cleanup').map((value: any) => ({ path: String(value) })),
        npc_portrait_gaps: arr('npc_portrait_gaps').map(gapTuple),
        scene_gaps: arr('scene_gaps').map(gapTuple),
      },
    });
  } catch (err) {
    console.error('[worldgen:orchestrator:status]', err);
    res.status(500).json({ ok: false, error: 'Failed to read orchestrator status', detail: String(err) });
  }
});

app.post('/api/orchestrator/run', (req, res) => {
  try {
    if (orchestratorRunState?.running) {
      res.status(409).json({ ok: false, error: 'Orchestrator pass already running', run: orchestratorRunState });
      return;
    }
    const args: string[] = [];
    const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
      const n = Math.floor(Number(value));
      if (!Number.isFinite(n)) return fallback;
      return Math.max(min, Math.min(max, n));
    };
    if (req.body?.force === true) args.push('--force');
    if (req.body?.dryRun === true) args.push('--dry-run');
    if (req.body?.cleanupOnly === true) args.push('--cleanup-only');
    if (req.body?.skipPhotos === true) args.push('--skip-photos');
    if (req.body?.noImageGen === true) args.push('--no-image-gen');
    if (req.body?.noLlm === true) args.push('--no-llm');
    args.push('--llm-max', String(clampInt(req.body?.llmMax, 5, 0, 20)));
    args.push('--image-batch', String(clampInt(req.body?.imageBatch, 2, 0, 8)));
    args.push('--audio-batch', String(clampInt(req.body?.audioBatch, 2, 0, 8)));
    const run = startOrchestratorPass(args);
    res.json({ ok: true, run });
  } catch (err) {
    console.error('[worldgen:orchestrator:run]', err);
    res.status(500).json({ ok: false, error: 'Failed to start orchestrator pass', detail: String(err) });
  }
});

app.post('/api/orchestrator/cron', (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ ok: false, error: 'enabled boolean required' });
    return;
  }
  try {
    res.json({
      ok: true,
      cron: writeOrchestratorCronState(enabled),
      progress: readOrchestratorProgressSummary(),
    });
  } catch (err) {
    console.error('[worldgen:orchestrator:cron:set]', err);
    res.status(500).json({ ok: false, error: 'Failed to update orchestrator cron state', detail: String(err) });
  }
});

app.post('/api/worlds', async (req, res) => {
  const { concept, provider = 'mistral', model, npcCount, locationCount } = req.body;
  if (!concept?.trim()) {
    res.status(400).json({ error: 'concept is required' });
    return;
  }
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  try {
    const logs: GenerationProgress[] = [];
    const options = {
      ...(npcCount ? { npcCount: Math.max(1, Math.min(100, Math.floor(Number(npcCount)))) } : {}),
      ...(locationCount ? { locationCount: Math.max(1, Math.min(100, Math.floor(Number(locationCount)))) } : {}),
    };
    const world = await generateWorld(concept.trim(), provider, model, (progress) => {
      logs.push(progress);
      console.log(`[worldgen] ${progress.phase}: ${progress.message} (${progress.percent}%)`);
    }, options);
    if (clientGone) {
      console.warn('[worldgen] generation completed after client disconnected; discarding unsaved world', world.id);
      return;
    }

    // Derive resource profile
    const resources = deriveResourceProfile(world);
    ensureWorldQuestPool(world);

    worlds.set(world.id, world);
    saveWorld(world);
    bumpWorldsListCache();
    queueWorldImageGeneration(world);
    res.json({ world: sanitiseWorld(world), resources, logs });
  } catch (err) {
    console.error('[worldgen:error]', err);
    res.status(500).json({ error: 'World generation failed', detail: String(err) });
  }
});

// ── List Worlds ─────────────────────────────────────────────────────────────

app.get('/api/worlds', (req, res) => {
  const now = Date.now();
  const includeIncomplete = /^(1|true|yes)$/i.test(String(req.query.includeIncomplete ?? ''))
    || /^(1|true|yes)$/i.test(process.env.WORLDGEN_SHOW_INCOMPLETE_WORLDS ?? '');
  const cacheKey = includeIncomplete ? 'all' : 'complete';
  const cached = _worldsListCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', cached.etag);
    if (req.headers['if-none-match'] === cached.etag) { res.status(304).end(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(cached.body);
    return;
  }
  const sessionsByWorld = new Map<string, WorldSession[]>();
  for (const session of sessions.values()) {
    if (!session.globalPlayerId) continue;
    const items = sessionsByWorld.get(session.worldId) ?? [];
    items.push(session);
    sessionsByWorld.set(session.worldId, items);
  }
  const selectorIssues = worldSelectorDiagnostics();
  const list = Array.from(worlds.values()).flatMap(w => {
    const blocking = inspectLoadedWorldForSelector(w).filter(issue => issue.level === 'error');
    if (blocking.length > 0) return [];
    attachKnownWorldQuestSourceDocuments(w);
    const imageReport = repairWorldImages(w).report;
    ensureWorldQuestPool(w);
    const worldSessions = (sessionsByWorld.get(w.id) ?? [])
      .map((s: any) => {
        const activeWorldQuest = s.activeWorldQuest?.status === 'active' ? s.activeWorldQuest : activeWorldQuestForSessionFromWorld(s, w);
        const activeSerializedAdventure = s.activeSerializedAdventure?.status === 'active' ? activeSerializedAdventureForSessionFromWorld(s, w) : activeSerializedAdventureForSessionFromWorld(s, w);
        return ({
        id: s.id,
        globalPlayerId: s.globalPlayerId,
        playerName: s.playerName,
        playerOccupation: s.playerOccupation,
        dayCount: s.dayCount,
        currentDate: w.currentDate ?? s.currentDate,
        hasActiveQuest: s.activeQuest?.status === 'active',
        activeQuestTitle: s.activeQuest?.status === 'active' ? (s.activeQuest.title || s.activeQuest.name) : undefined,
        hasActiveWorldQuest: activeWorldQuest?.status === 'active',
        activeWorldQuestId: activeWorldQuest?.status === 'active' ? activeWorldQuest.id : undefined,
        activeWorldQuestTitle: activeWorldQuest?.status === 'active' ? activeWorldQuest.title : undefined,
        activeSerializedAdventure: activeSerializedAdventure?.status === 'active' ? { id: activeSerializedAdventure.id } : undefined,
        canStartWorldQuest: !activeWorldQuestBlock(s),
        lastActiveAt: s.lastActiveAt,
      })});
    return [{
      id: w.id,
      name: (w as any).name,
      title: (w as any).title,
      concept: w.concept,
      createdAt: w.createdAt,
      provider: w.provider,
      era: w.era,
      geography: w.geography,
      coverImageUrl: worldCoverImageUrl(w),
      locationCount: (w.locations ?? []).length,
      npcCount: (w.npcs ?? []).length,
      populationType: w.populationBlueprint?.communityType,
      populationSize: w.populationBlueprint?.totalPopulation,
      sessions: worldSessions,
      questPool: (w.questPool ?? []).map(seed => ({
        id: seed.id,
        worldId: seed.worldId,
        worldName: seed.worldName,
        title: seed.title,
        teaser: seed.teaser,
        status: seed.status,
        difficulty: seed.difficulty,
        giverNpcId: seed.giverNpcId,
        giverNpcName: seed.giverNpcName,
        locationId: seed.locationId,
        locationName: seed.locationName,
        unlockRule: seed.unlockRule,
      })),
      realWorldBased: !!w.realWorldBased,
      hasBaseline: existsSync(join(DATA_DIR, '.baselines', `${w.id}.json`)),
      audioPackApplied: hasMatchingAudioPack(w.id, w.concept),
      imagesComplete: imageReport.complete,
      imagesMissing: imageReport.missing,
      realWorldFacts: w.realWorldFacts ? String(w.realWorldFacts).slice(0, 240) : undefined,
      sourceDocuments: (w.sourceDocuments ?? []).map(doc => ({ title: doc.title, type: doc.type, sourceType: doc.sourceType })),
      timeline: (w.timeline ?? []).map(event => ({
        id: event.id,
        date: event.date,
        title: event.title,
        description: typeof event.description === 'string' ? event.description.slice(0, 360) : event.description,
        type: event.type,
      })),
      worldQuestEligible: isRealWorldQuestEligible(w),
      worldQuestAdventures: (w.worldQuestAdventures ?? []).map(quest => ({
        id: quest.id,
        worldId: quest.worldId,
        title: quest.title,
        status: quest.status,
        difficulty: quest.difficulty,
        sourceType: quest.sourceType,
        requiredOutcome: quest.requiredOutcome,
        completionSummary: quest.completionSummary,
        completionThreshold: quest.completionThreshold,
        sessionId: quest.sessionId,
        participantSessionIds: quest.participantSessionIds,
        allowCoop: quest.allowCoop,
        twoPlayer: quest.twoPlayer,
        hostSessionId: quest.hostSessionId,
        guestSessionId: quest.guestSessionId,
        guestCoopMode: quest.guestCoopMode,
        hostCoopMode: quest.hostCoopMode,
        pendingJoinRequests: cleanWorldQuestJoinRequests(quest),
        steps: (quest.steps ?? []).map(step => ({
          id: step.id,
          title: step.title,
          act: step.act,
          status: step.status,
          requiredProp: step.requiredProp,
        })),
      })),
      serializedAdventures: (w.serializedAdventures ?? []).map(adv => ({
        id: adv.id, worldId: adv.worldId, title: adv.title, status: adv.status,
        sourceType: adv.sourceType, logline: adv.logline, premise: adv.premise, spectrumScore: adv.spectrumScore,
        sessionId: adv.sessionId, participantSessionIds: adv.participantSessionIds, allowCoop: adv.allowCoop,
        acts: (adv.acts ?? []).map(act => ({
          id: act.id, number: act.number, title: act.title, status: act.status, summary: act.summary,
          beats: (act.beats ?? []).map((b: any) => ({
            id: b.id, actId: b.actId, title: b.title, status: b.status,
            narrativeDescription: b.narrativeDescription, evaluationCriteria: b.evaluationCriteria,
            kind: b.kind, weight: b.weight, npcIds: b.npcIds, locationIds: b.locationIds,
          })),
        })),
      })),
      }];
  });
  for (const stub of worldStubs.values()) {
    if (worlds.has(stub.id)) continue;
    const worldSessions = (sessionsByWorld.get(stub.id) ?? []).map((s: any) => {
      const activeWorldQuest = s.activeWorldQuest?.status === 'active' ? s.activeWorldQuest : undefined;
      const activeSerializedAdventure = s.activeSerializedAdventure?.status === 'active' ? s.activeSerializedAdventure : undefined;
      return ({
        id: s.id,
        globalPlayerId: s.globalPlayerId,
        playerName: s.playerName,
        playerOccupation: s.playerOccupation,
        dayCount: s.dayCount,
        currentDate: s.currentDate,
        hasActiveQuest: s.activeQuest?.status === 'active',
        activeQuestTitle: s.activeQuest?.status === 'active' ? (s.activeQuest.title || s.activeQuest.name) : undefined,
        hasActiveWorldQuest: activeWorldQuest?.status === 'active',
        activeWorldQuestId: activeWorldQuest?.status === 'active' ? activeWorldQuest.id : undefined,
        activeWorldQuestTitle: activeWorldQuest?.status === 'active' ? activeWorldQuest.title : undefined,
        activeSerializedAdventure: activeSerializedAdventure?.status === 'active' ? { id: activeSerializedAdventure.id } : undefined,
        canStartWorldQuest: !activeWorldQuestBlock(s),
        lastActiveAt: s.lastActiveAt,
      });
    });
    const stubReport = stubImageReport(stub);
    list.push({
      id: stub.id,
      name: stub.name,
      title: stub.title,
      concept: stub.concept,
      createdAt: stub.createdAt ?? '',
      provider: stub.provider ?? '',
      era: stub.era ?? { label: 'unknown' },
      geography: stub.geography,
      coverImageUrl: worldCoverImageUrl(stub as any),
      locationCount: stub.locationCount,
      npcCount: stub.npcCount,
      populationType: stub.populationType ?? '',
      populationSize: stub.populationSize ?? 0,
      sessions: worldSessions,
      questPool: (stub.questPool ?? []).map((seed: any) => ({
        id: seed.id,
        worldId: seed.worldId,
        worldName: seed.worldName,
        title: seed.title,
        teaser: seed.teaser,
        status: seed.status,
        difficulty: seed.difficulty,
        giverNpcId: seed.giverNpcId,
        giverNpcName: seed.giverNpcName,
        locationId: seed.locationId,
        locationName: seed.locationName,
        unlockRule: seed.unlockRule,
      })),
      realWorldBased: !!stub.realWorldBased,
      hasBaseline: existsSync(join(DATA_DIR, '.baselines', `${stub.id}.json`)),
      audioPackApplied: hasMatchingAudioPack(stub.id, stub.concept),
      imagesComplete: stubReport.complete,
      imagesMissing: stubReport.missing,
      realWorldFacts: stub.realWorldFacts ? String(stub.realWorldFacts).slice(0, 240) : undefined,
      sourceDocuments: (stub.sourceDocuments ?? []).map((doc: any) => ({ title: doc.title, type: doc.type, sourceType: doc.sourceType })),
      timeline: (stub.timeline ?? []).map((event: any) => ({
        id: event.id,
        date: event.date,
        title: event.title,
        description: typeof event.description === 'string' ? event.description.slice(0, 360) : event.description,
        type: event.type,
      })),
      worldQuestEligible: !!stub.realWorldBased || !!(stub.sourceDocuments ?? []).length,
      worldQuestAdventures: (stub.worldQuestAdventures ?? []).map((quest: any) => ({
        id: quest.id,
        worldId: quest.worldId,
        title: quest.title,
        status: quest.status,
        difficulty: quest.difficulty,
        sourceType: quest.sourceType,
        requiredOutcome: quest.requiredOutcome,
        completionSummary: quest.completionSummary,
        completionThreshold: quest.completionThreshold,
        sessionId: quest.sessionId,
        participantSessionIds: quest.participantSessionIds,
        allowCoop: quest.allowCoop,
        twoPlayer: quest.twoPlayer,
        hostSessionId: quest.hostSessionId,
        guestSessionId: quest.guestSessionId,
        guestCoopMode: quest.guestCoopMode,
        hostCoopMode: quest.hostCoopMode,
        pendingJoinRequests: cleanWorldQuestJoinRequests(quest),
        steps: (quest.steps ?? []).map((step: any) => ({
          id: step.id,
          title: step.title,
          act: step.act,
          status: step.status,
          requiredProp: step.requiredProp,
        })),
      })),
      serializedAdventures: (stub.serializedAdventures ?? []).map((adv: any) => ({
        id: adv.id, worldId: adv.worldId, title: adv.title, status: adv.status,
        sourceType: adv.sourceType, logline: adv.logline, premise: adv.premise, spectrumScore: adv.spectrumScore,
        sessionId: adv.sessionId, participantSessionIds: adv.participantSessionIds, allowCoop: adv.allowCoop,
        acts: (adv.acts ?? []).map((act: any) => ({
          id: act.id, number: act.number, title: act.title, status: act.status, summary: act.summary,
          beats: (act.beats ?? []).map((b: any) => ({
            id: b.id, actId: b.actId, title: b.title, status: b.status,
            narrativeDescription: b.narrativeDescription, evaluationCriteria: b.evaluationCriteria,
            kind: b.kind, weight: b.weight, npcIds: b.npcIds, locationIds: b.locationIds,
          })),
        })),
      })),
    } as (typeof list)[number]);
  }
  list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  // Only worlds whose every image loads are offered in the lobby; the rest stay on disk and are
  // still reachable by id. ?includeIncomplete=1 (or WORLDGEN_SHOW_INCOMPLETE_WORLDS=1) lists them.
  const incomplete = list.filter(w => !w.imagesComplete);
  const body = JSON.stringify({
    worlds: includeIncomplete ? list : list.filter(w => w.imagesComplete),
    hiddenIncomplete: includeIncomplete ? [] : incomplete.map(w => ({
      id: w.id, name: w.name || w.title || w.concept, missing: w.imagesMissing,
    })),
    incompleteCount: incomplete.length,
    issues: selectorIssues,
    selectorHealth: {
      errors: selectorIssues.filter(issue => issue.level === 'error').length,
      warnings: selectorIssues.filter(issue => issue.level === 'warning').length,
      deferred: worldStubs.size,
    },
  });
  const etag = 'W/"' + createHash('sha256').update(body).digest('hex').slice(0,16) + '"';
  _worldsListCache.set(cacheKey, { expiresAt: Date.now() + _WORLDS_LIST_CACHE_TTL_MS, etag, body });
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(body);
});

app.get('/api/worlds/refresh', async (_req, res) => {
  try {
    const counts = await reloadRuntimeDataFromDisk();
    res.json({ ok: true, ...counts });
  } catch (err) {
    console.error('[worldgen:worlds:refresh]', err);
    res.status(500).json({ ok: false, error: 'Failed to refresh worlds from disk', detail: String(err) });
  }
});

app.post('/api/worlds/refresh', async (_req, res) => {
  try {
    const counts = await reloadRuntimeDataFromDisk();
    res.json({ ok: true, ...counts });
  } catch (err) {
    console.error('[worldgen:worlds:refresh]', err);
    res.status(500).json({ ok: false, error: 'Failed to refresh worlds from disk', detail: String(err) });
  }
});

// ── Get World Detail ────────────────────────────────────────────────────────

app.get('/api/worlds/:id', (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  if (repairWorldReadModel(world)) saveWorld(world);
  // Do NOT queueWorldImageGeneration here. This is a read-only GET hit by the frontend
  // every time you open a world tile / switch worlds / poll, and was triggering simultaneous
  // image-gen runs across every world in the library - a thundering herd that overwhelmed
  // Imagen rate limits and clobbered TMDB-sourced portraits mid-run. Image generation
  // is now driven only from explicit triggers: build close handler, POST /api/worlds/:id/images,
  // and POST /api/worlds/check-data (which respects the stale-generating guard).
  res.json({ world: sanitiseWorld(world), resources: deriveResourceProfile(world) });
});

app.post('/api/worlds/:worldId/quest-pool/:seedId/begin', (req, res) => {
  const world = worlds.get(req.params.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  ensureWorldClock(world);
  ensureWorldQuestPool(world);
  const seed = (world.questPool ?? []).find(item => item.id === req.params.seedId);
  if (!seed) { res.status(404).json({ error: 'Quest seed not found' }); return; }
  if (seed.status !== 'available') { res.status(409).json({ error: 'Quest seed is not available', seed }); return; }
  const globalPlayerId = String(req.body?.globalPlayerId ?? '');
  const player = globalPlayers.get(globalPlayerId);
  if (!player) { res.status(404).json({ error: 'Global player not found' }); return; }
  if (!verifyGlobalPlayerPin(player, req.body?.pin, pinContext(req, res))) { res.status(403).json({ error: 'Character pin is incorrect' }); return; }

  const targetLocationId = seed.locationId && world.locations.some(location => location.id === seed.locationId)
    ? seed.locationId
    : world.locations[0]?.id;
  if (!targetLocationId) { res.status(409).json({ error: 'World has no locations for quest start' }); return; }
  let session = Array.from(sessions.values())
    .filter(s => s.worldId === world.id && s.globalPlayerId === player.id)
    .sort((a, b) => String(b.lastActiveAt ?? '').localeCompare(String(a.lastActiveAt ?? '')))[0];
  if (!session) {
    session = createWorldSessionForGlobalPlayer(world, player, req.body, targetLocationId).session;
  }
  if (session.activeQuest?.status === 'active') {
    res.status(409).json({ error: 'Character already has an active quest', sessionId: session.id, quest: session.activeQuest });
    return;
  }
  if (session.activeWorldQuest?.status === 'active') {
    res.status(409).json({ error: 'Unavailable', sessionId: session.id, quest: session.activeWorldQuest });
    return;
  }
  const existingActive = activeGlobalQuestRecordsForPlayer(player.id);
  if (existingActive.length >= MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER) {
    enforceGlobalQuestLimit(player.id);
    res.status(409).json({
      error: `Character already has ${MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER} active global quests. Finish, leave, or abandon one before taking another.`,
      activeGlobalQuests: existingActive.slice(0, MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER).map(record => ({ id: record.quest.id, name: record.quest.name, startedAt: record.quest.startedAt })),
    });
    return;
  }
  session.currentLocationId = targetLocationId;
  session.visitedLocations = Array.from(new Set([...(session.visitedLocations ?? []), targetLocationId]));

  const npc = seed.giverNpcId ? world.npcs.find(item => item.id === seed.giverNpcId) : world.npcs[0];
  const location = world.locations.find(item => item.id === targetLocationId) ?? world.locations[0];
  const questTypes: QuestType[] = ['plague', 'war', 'existential'];
  const questType = questTypes[stableHash(seed.id) % questTypes.length];
  const tier: QuestTier = seed.difficulty === 'easy' ? 'Minor' : seed.difficulty === 'hard' ? 'Major' : 'Standard';
  const hook: QuestDiscoveryHook = {
    id: `pool-hook-${seed.id}-${Date.now()}`,
    status: 'available',
    templateId: seed.id,
    type: questType,
    tier,
    scope: 'global',
    title: seed.title,
    detail: seed.teaser,
    npcId: npc?.id ?? seed.giverNpcId ?? 'unknown',
    npcName: npc?.name ?? seed.giverNpcName ?? 'Unknown giver',
    locationId: location.id,
    locationName: location.name,
    createdAt: new Date().toISOString(),
    turnOffered: session.dayCount ?? 1,
    rewards: {
      medals: [{ id: `medal:${seed.id}`, name: seed.title, tier, questType }],
      achievements: [{ id: `achievement:${seed.id}`, name: `Began ${seed.worldName}`, description: seed.teaser, questId: seed.id }],
    },
  };
  session.questHooks = [hook, ...(session.questHooks ?? []).filter(item => item.templateId !== seed.id)].slice(0, 12);
  const result = activateQuestEpisode({ world, session, allWorlds: worlds.values(), hookId: hook.id });
  if (result.error || !result.quest) {
    res.status(409).json({ error: result.error ?? 'Quest could not be activated', sessionId: session.id });
    return;
  }
  seed.status = 'active';
  seed.teaser = `Active with ${session.playerName}.`;
  enforceGlobalQuestLimit(player.id);
  saveWorld(world);
  persistSessionState(session);
  res.json({ session, quest: result.quest, seed });
});

app.patch('/api/worlds/:id', (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  let changed = false;
  if (req.body.displayLanguage !== undefined) {
    world.displayLanguage = req.body.displayLanguage ? String(req.body.displayLanguage).slice(0, 50) : undefined;
    changed = true;
  }
  if (req.body.realWorldBased !== undefined) {
    world.realWorldBased = !!req.body.realWorldBased;
    changed = true;
  }
  if (req.body.realWorldFacts !== undefined) {
    world.realWorldFacts = req.body.realWorldFacts ? String(req.body.realWorldFacts).slice(0, 5000) : undefined;
    changed = true;
  }
  if (Array.isArray(req.body.sourceDocuments)) {
    world.sourceDocuments = req.body.sourceDocuments.slice(0, 12).map((doc: any, index: number) => ({
      id: String(doc.id || `source-doc-${index + 1}`),
      title: String(doc.title || doc.name || `Source ${index + 1}`).slice(0, 160),
      type: ['pdf', 'text', 'url', 'image', 'other'].includes(String(doc.type)) ? doc.type : 'other',
      sourceType: ['History', 'Film', 'Book', 'Story', 'Real Event'].includes(String(doc.sourceType)) ? doc.sourceType : undefined,
      path: typeof doc.path === 'string' ? doc.path.slice(0, 300) : undefined,
      textPath: typeof doc.textPath === 'string' ? doc.textPath.slice(0, 300) : undefined,
      url: typeof doc.url === 'string' ? doc.url.slice(0, 300) : undefined,
      summary: typeof doc.summary === 'string' ? doc.summary.slice(0, 1000) : undefined,
      extractedText: typeof doc.extractedText === 'string' ? sourceDocumentInlineText(doc.extractedText) : undefined,
      digest: typeof doc.digest === 'string' ? doc.digest : undefined,
      digestGeneratedAt: typeof doc.digestGeneratedAt === 'string' ? doc.digestGeneratedAt : undefined,
      addedAt: typeof doc.addedAt === 'string' ? doc.addedAt : new Date().toISOString(),
    }));
    changed = true;
  }
  if (attachKnownWorldQuestSourceDocuments(world)) changed = true;
  if (changed) saveWorld(world);
  res.json({ ok: true, displayLanguage: world.displayLanguage, realWorldBased: world.realWorldBased, realWorldFacts: world.realWorldFacts, sourceDocuments: world.sourceDocuments ?? [], worldQuestEligible: isRealWorldQuestEligible(world) });
});

app.get('/api/worlds/:id/world-quests', (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  if (repairWorldReadModel(world)) saveWorld(world);
  if (!isRealWorldQuestEligible(world)) { res.status(409).json({ error: 'Unavailable', available: false, quests: [] }); return; }
  res.json({ available: true, quests: world.worldQuestAdventures ?? [], sourceDocuments: world.sourceDocuments ?? [] });
});

app.post('/api/worlds/:id/world-quests/cleanup', (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const includeCompleted = req.body?.includeCompleted === true;
  const result = cleanupWorldQuestState(world, includeCompleted);
  saveWorld(world);
  bumpWorldsListCache();
  res.json({ ok: true, ...result, worldQuestAdventures: world.worldQuestAdventures ?? [] });
});

app.patch('/api/worlds/:id/world-quests/:questId', (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const quest = (world.worldQuestAdventures ?? []).find(q => q.id === req.params.questId);
  if (!quest) { res.status(404).json({ error: 'World Quest not found' }); return; }
  if (req.body.allowCoop !== undefined) quest.allowCoop = req.body.allowCoop === true;
  saveWorld(world);
  bumpWorldsListCache();
  res.json({ ok: true, quest, worldQuestAdventures: world.worldQuestAdventures ?? [] });
});

app.delete('/api/worlds/:id/world-quests/:questId', (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const result = removeWorldQuestState(world, req.params.questId);
  saveWorld(world);
  bumpWorldsListCache();
  res.json({ ok: true, ...result, worldQuestAdventures: world.worldQuestAdventures ?? [] });
});

app.delete('/api/worlds/:worldId/quest-pool/:seedId', (req, res) => {
  const world = worlds.get(req.params.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const before = world.questPool?.length ?? 0;
  world.questPool = (world.questPool ?? []).filter(seed => seed.id !== req.params.seedId);
  saveWorld(world);
  res.json({ ok: true, removed: before - (world.questPool?.length ?? 0), questPool: world.questPool ?? [] });
});

app.post('/api/worlds/:id/world-quests/source-documents', (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const body = req.body ?? {};
  const type = ['pdf', 'text', 'url', 'image', 'other'].includes(body.type) ? body.type : (body.url ? 'url' : 'text');
  const sourceType: WorldQuestSourceType = ['History', 'Film', 'Book', 'Story', 'Real Event', 'LLM'].includes(body.sourceType) ? body.sourceType : inferWorldQuestSourceType(world);
  const path = typeof body.path === 'string' ? body.path.slice(0, 240) : undefined;
  const textPath = typeof body.textPath === 'string' ? body.textPath.slice(0, 240) : undefined;
  const absPath = path && !path.includes('..') ? join(REPO_ROOT, path.replace(/^\/+/, '')) : undefined;
  const extractedText = typeof body.extractedText === 'string'
    ? body.extractedText
    : (absPath && existsSync(absPath) ? extractPdfTextBestEffort(absPath) : undefined);
  const doc: WorldSourceDocument = {
    id: `source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(body.title || body.url || body.path || `${world.concept} source`).slice(0, 120),
    type,
    sourceType,
    path,
    textPath,
    url: typeof body.url === 'string' ? body.url.slice(0, 500) : undefined,
    summary: typeof body.summary === 'string' ? body.summary.slice(0, 5000) : undefined,
    extractedText: sourceDocumentInlineText(extractedText),
    addedAt: new Date().toISOString(),
  };
  world.sourceDocuments = [...(world.sourceDocuments ?? []), doc];
  world.realWorldBased = true;
  saveWorld(world);
  res.json({ ok: true, sourceDocuments: world.sourceDocuments, worldQuestEligible: isRealWorldQuestEligible(world) });
});

// Strip script-site / wikipedia-archive chrome that prefaces the actual story content.
// Pages from script-o-rama, IMSDb, and scriptslug all start with a banner like "Voila!
// Finally, the X script is here for all you quotes spouting fans...", then nav links,
// then the actual screenplay. The build LLM only sees the first 16K chars of SOURCE_TEXT,
// so if that 16K is mostly chrome the build invents generic characters instead of canonical
// ones. This walks past common banners and snaps to the first real script/story marker
// (FADE IN, INT./EXT., CHAPTER, or an all-caps character cue followed by dialogue).
function stripScriptSiteChrome(text: string): string {
  if (!text || text.length < 1500) return text;
  // Known chatty intros from script archive sites - cut everything before them is too risky,
  // so anchor on the FIRST occurrence of a real screenplay marker within the first 8K chars.
  const head = text.slice(0, 8000);
  const markers = [
    /\bFADE\s+IN[:.\s]/,                                  // most screenplays
    /\b(?:INT\.|EXT\.)\s+[A-Z]/,                          // scene heading
    /\bCHAPTER\s+(?:[IVX]+|ONE|TWO|THREE|\d+)\b/i,        // novel chapter
    /\bPROLOGUE\s*[.\n]/i,
    /\bACT\s+(?:ONE|TWO|I)\b/,                            // stage play / structured screenplay
  ];
  let bestIdx = -1;
  for (const re of markers) {
    const m = head.match(re);
    if (m && typeof m.index === 'number') {
      if (bestIdx === -1 || m.index < bestIdx) bestIdx = m.index;
    }
  }
  // If we found a marker after some chrome (>200 chars in), cut to it. Don't cut if the
  // marker is at the very start (no chrome to strip) or if no marker found (treat as
  // novel/article that doesn't follow screenplay conventions).
  if (bestIdx > 200) {
    return text.slice(bestIdx).trim();
  }
  // Also clip trailing site footers if present (common across archives).
  let out = text;
  const footerMarkers = [
    /\bDrew['\u2019]s\s+Script-?O-?Rama\b/i,
    /\bReturn to the script index\b/i,
    /\bBack to IMSDb Index\b/i,
    /\bSubmit\s*\|\s*Link to IMSDb\b/i,
    /\bIMSDb opening logo\b/i,
    /\bMovie Scripts\s*[>|]\s*[A-Z]/,
    /\bAll Rights Reserved\b/i,
  ];
  for (const re of footerMarkers) {
    const m = out.match(re);
    if (m && typeof m.index === 'number' && m.index > out.length * 0.5) {
      out = out.slice(0, m.index).trim();
    }
  }
  return out;
}

// ── Outbound fetch guard (SSRF) ──────────────────────────────────────────────
// User-supplied URLs must resolve only to public addresses. Every redirect hop is
// re-validated, and the body is streamed with a hard byte cap and a timeout.
class UnsafeUrlError extends Error {}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Expand any IPv6 text form (including a trailing dotted IPv4) to 8 hextets. */
function ipv6Hextets(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    text = text.slice(0, -dotted[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const missing = 8 - h.length - t.length;
  if (text.includes('::') ? missing < 0 : missing !== 0) return null;
  const parts = [...h, ...Array(text.includes('::') ? missing : 0).fill('0'), ...t].map(p => parseInt(p, 16));
  return parts.length === 8 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parts : null;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip.split('.').map(Number));
  const x = ipv6Hextets(ip);
  if (!x) return true; // unparseable → refuse
  const v4At = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zero = (from: number, to: number) => x.slice(from, to).every(n => n === 0);
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d)
  // all reach the embedded IPv4 address, so judge that address instead.
  if (zero(0, 5) && (x[5] === 0xffff || x[5] === 0)) return zero(0, 8) || (x[5] === 0 && zero(0, 7) && x[7] === 1) || isPrivateIPv4(v4At(x[6], x[7]));
  if (x[0] === 0x64 && x[1] === 0xff9b && zero(2, 6)) return isPrivateIPv4(v4At(x[6], x[7]));
  if (x[0] === 0x2002) return isPrivateIPv4(v4At(x[1], x[2])); // 6to4
  const first = x[0];
  return (first & 0xfe00) === 0xfc00 /* ULA */ || (first & 0xffc0) === 0xfe80 /* link-local */ || (first & 0xff00) === 0xff00 /* multicast */;
}

async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new UnsafeUrlError('Invalid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new UnsafeUrlError('Only http(s) URLs allowed');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await dnsLookup(host, { all: true }).catch(() => [])).map(a => a.address);
  if (!addresses.length) throw new UnsafeUrlError('Host could not be resolved');
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError('Internal/local hosts not allowed');
  return parsed;
}

async function fetchPublicUrl(raw: string, init: RequestInit, opts: { timeoutMs: number; maxBytes: number }): Promise<{ response: Response; body: Buffer }> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = raw;
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublicHttpUrl(url);
    const response = await fetch(url, { ...init, redirect: 'manual', signal });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > opts.maxBytes) throw new UnsafeUrlError(`Response too large (max ${opts.maxBytes} bytes)`);
    const chunks: Buffer[] = [];
    let total = 0;
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > opts.maxBytes) throw new UnsafeUrlError(`Response too large (max ${opts.maxBytes} bytes)`);
        chunks.push(Buffer.from(chunk));
      }
    }
    return { response, body: Buffer.concat(chunks) };
  }
  throw new UnsafeUrlError('Too many redirects');
}

app.post('/api/worlds/source-fetch-url', async (req, res) => {
  try {
    const url = String((req.body || {}).url || '').trim();
    let parsed: URL;
    try { parsed = await assertPublicHttpUrl(url); } catch (err) { res.status(400).json({ error: (err as Error).message }); return; }
    let fetched: { response: Response; body: Buffer };
    try {
      fetched = await fetchPublicUrl(url, { headers: { 'User-Agent': 'WorldGen/1.0 (source-fetcher)', 'Accept': 'text/html,application/xhtml+xml' } }, { timeoutMs: 30_000, maxBytes: 25 * 1024 * 1024 });
    } catch (err) {
      if (err instanceof UnsafeUrlError) { res.status(400).json({ error: err.message }); return; }
      throw err;
    }
    const upstream = fetched.response;
    if (!upstream.ok) { res.status(502).json({ error: `Source fetch failed: ${upstream.status} ${upstream.statusText}` }); return; }
    const html = fetched.body.toString('utf8');
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
      .replace(/<table[^>]+class="[^"]*(infobox|navbox|sidebar|metadata|ambox)[^"]*"[\s\S]*?<\/table>/gi, ' ')
      .replace(/<sup[^>]+class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&[a-z0-9#]+;/gi, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    // Strip script-site chrome: if the page looks like a screenplay (has FADE IN / INT. / EXT. /
    // CHAPTER markers) but is preceded by site intro chatter (script-o-rama, IMSDb, scriptslug
    // banners), cut everything before the first real screenplay/story marker so the build LLM
    // sees actual story content, not "Voila! Finally, the X script is here for all you fans...".
    text = stripScriptSiteChrome(text);
    let title = '';
    const tm = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (tm) title = tm[1].replace(/\s*[\-|]\s*Wikipedia.*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title) { const seg = parsed.pathname.split('/').filter(Boolean).pop() || 'Web source'; title = decodeURIComponent(seg).replace(/_/g, ' ').slice(0, 120); }
    const uploadsDir = join(PUBLIC_DIR, 'uploads');
    if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
    const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const slug = title.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_{2,}/g, '_').slice(0, 60) || 'web';
    const textRel = `uploads/${stamp}-${slug}.txt`;
    writeFileSync(join(PUBLIC_DIR, textRel), text, 'utf8');
    res.json({
      ok: true,
      pdfPath: url,
      textPath: `public/${textRel}`,
      title,
      textLen: text.length,
      preview: text.slice(0, 240),
      sourceUrl: url,
    });
  } catch (err) {
    console.error('[worldgen:source-fetch-url:error]', err);
    res.status(500).json({ error: 'Source fetch failed' });
  }
});

app.post('/api/worlds/source-upload', async (req, res) => {
  try {
    const body = req.body ?? {};
    const rawName = String(body.filename ?? 'source.pdf');
    const safe = rawName.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_{2,}/g, '_').slice(-80);
    if (!/\.pdf$/i.test(safe)) { res.status(400).json({ error: 'Only .pdf files are supported' }); return; }
    const b64 = String(body.dataBase64 ?? '').replace(/^data:[^,]*,/, '');
    if (!b64) { res.status(400).json({ error: 'dataBase64 is required' }); return; }
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || buf.length > 90 * 1024 * 1024) { res.status(400).json({ error: 'PDF missing or larger than 90MB' }); return; }
    const uploadsDir = join(PUBLIC_DIR, 'uploads');
    if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
    const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const pdfRel = `uploads/${stamp}-${safe}`;
    const pdfAbs = join(PUBLIC_DIR, pdfRel);
    writeFileSync(pdfAbs, buf);
    const text = await extractPdfTextRobust(pdfAbs);
    const textRel = `${pdfRel}.txt`;
    writeFileSync(join(PUBLIC_DIR, textRel), text, 'utf8');
    res.json({
      ok: true,
      pdfPath: `public/${pdfRel}`,
      textPath: `public/${textRel}`,
      title: safe.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 120) || 'Source document',
      textLen: text.length,
      preview: text.slice(0, 240),
    });
  } catch (err) {
    console.error('[worldgen:source-upload:error]', err);
    res.status(500).json({ error: 'Source upload failed', detail: String(err) });
  }
});

// ── Custom NPC Portrait Upload ─────────────────────────────────────────────
// Upload a user-supplied image for a specific NPC (e.g., film stills for canonical
// characters like Pinhead/Frank/Larry). Once uploaded, the portrait is marked
// kind:'manual' which makes it immutable - AI image gen will never overwrite it
// (same protection that protects TMDB headshots).
app.post('/api/worlds/:id/npc/:npcId/portrait', async (req, res) => {
  try {
    const world = worlds.get(req.params.id);
    if (!world) { res.status(404).json({ error: 'world not found' }); return; }
    const npcId = String(req.params.npcId);
    const npc = (world.npcs ?? []).find((n: any) => n.id === npcId);
    if (!npc) { res.status(404).json({ error: `npc '${npcId}' not found in world` }); return; }

    const body = req.body ?? {};
    const rawName = String(body.filename ?? 'portrait.jpg');
    const extMatch = rawName.match(/\.(jpg|jpeg|png|webp)$/i);
    if (!extMatch) { res.status(400).json({ error: 'Only .jpg/.jpeg/.png/.webp images are supported' }); return; }
    const ext = extMatch[1].toLowerCase() === 'jpeg' ? 'jpg' : extMatch[1].toLowerCase();
    const b64 = String(body.dataBase64 ?? '').replace(/^data:[^,]*,/, '');
    if (!b64) { res.status(400).json({ error: 'dataBase64 is required' }); return; }
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || buf.length > 12 * 1024 * 1024) { res.status(400).json({ error: 'Image missing or larger than 12MB' }); return; }

    // Save to public/generated/<worldId>/manual-<safeNpcId>.<ext>. Prefix prevents collision
    // with TMDB filenames (<safeNpcId>.jpg) and AI filenames (npc-<safeNpcId>.jpg).
    const safe = npcId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    const worldDir = join(GENERATED_DIR, world.id);
    if (!existsSync(worldDir)) mkdirSync(worldDir, { recursive: true });
    const destAbs = join(worldDir, `manual-${safe}.${ext}`);
    writeFileSync(destAbs, buf);
    const destUrl = `/generated/${world.id}/manual-${safe}.${ext}`;

    // Update world.images and portraitSources
    const w = world as any;
    w.images = w.images ?? {};
    w.images.portraits = w.images.portraits ?? {};
    w.images.portraitSources = w.images.portraitSources ?? {};
    w.images.portraits[npcId] = destUrl;
    w.images.portraitSources[npcId] = {
      kind: 'manual',
      uploadedAt: new Date().toISOString(),
      sizeBytes: buf.length,
    };
    // Also backfill npc.images.portrait so observatory/index pages pick it up.
    const imgs = (npc as any).images || {};
    imgs.portrait = destUrl;
    (npc as any).images = imgs;
    saveWorld(world);

    console.log(`[manual-portrait] world ${world.id} npc ${npcId}: ${buf.length} bytes -> manual-${safe}.${ext}`);
    res.json({
      ok: true,
      worldId: world.id,
      npcId,
      url: destUrl,
      sizeBytes: buf.length,
      kind: 'manual',
    });
  } catch (err) {
    console.error('[worldgen:manual-portrait:error]', err);
    res.status(500).json({ error: 'Portrait upload failed', detail: String(err) });
  }
});

// Bulk variant: accept multiple portraits at once. Body: { items: [{npcId, filename, dataBase64}, ...] }
// Returns per-item results. Useful when uploading a full canonical cast at once.
app.post('/api/worlds/:id/portraits/bulk', async (req, res) => {
  try {
    const world = worlds.get(req.params.id);
    if (!world) { res.status(404).json({ error: 'world not found' }); return; }
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) { res.status(400).json({ error: 'items array required' }); return; }
    if (items.length > 50) { res.status(400).json({ error: 'max 50 items per bulk upload' }); return; }
    const worldDir = join(GENERATED_DIR, world.id);
    if (!existsSync(worldDir)) mkdirSync(worldDir, { recursive: true });
    const w = world as any;
    w.images = w.images ?? {};
    w.images.portraits = w.images.portraits ?? {};
    w.images.portraitSources = w.images.portraitSources ?? {};
    const results: any[] = [];
    for (const item of items) {
      try {
        const npcId = String(item?.npcId ?? '');
        const npc = (world.npcs ?? []).find((n: any) => n.id === npcId);
        if (!npc) { results.push({ npcId, ok: false, error: 'npc not found' }); continue; }
        const rawName = String(item?.filename ?? 'portrait.jpg');
        const extMatch = rawName.match(/\.(jpg|jpeg|png|webp)$/i);
        if (!extMatch) { results.push({ npcId, ok: false, error: 'unsupported file type' }); continue; }
        const ext = extMatch[1].toLowerCase() === 'jpeg' ? 'jpg' : extMatch[1].toLowerCase();
        const b64 = String(item?.dataBase64 ?? '').replace(/^data:[^,]*,/, '');
        if (!b64) { results.push({ npcId, ok: false, error: 'no data' }); continue; }
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length || buf.length > 12 * 1024 * 1024) { results.push({ npcId, ok: false, error: 'size out of range' }); continue; }
        const safe = npcId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
        const destAbs = join(worldDir, `manual-${safe}.${ext}`);
        writeFileSync(destAbs, buf);
        const destUrl = `/generated/${world.id}/manual-${safe}.${ext}`;
        w.images.portraits[npcId] = destUrl;
        w.images.portraitSources[npcId] = { kind: 'manual', uploadedAt: new Date().toISOString(), sizeBytes: buf.length };
        const imgs = (npc as any).images || {};
        imgs.portrait = destUrl;
        (npc as any).images = imgs;
        results.push({ npcId, ok: true, url: destUrl, sizeBytes: buf.length });
      } catch (e) {
        results.push({ npcId: item?.npcId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    saveWorld(world);
    const okCount = results.filter(r => r.ok).length;
    console.log(`[manual-portrait:bulk] world ${world.id}: ${okCount}/${results.length} saved`);
    res.json({ ok: true, worldId: world.id, saved: okCount, total: results.length, results });
  } catch (err) {
    console.error('[worldgen:portraits-bulk:error]', err);
    res.status(500).json({ error: 'Bulk portrait upload failed', detail: String(err) });
  }
});

// Server-side fetch of an image from a URL (so the user can paste from moviestillsdb, Google
// images, IMDB, etc. without the download-then-upload dance). Saves to the same path as the
// file upload endpoint with kind:'manual' so it gets the same sacrosanct protection from
// AI image regen + TMDB cast-rematch.
app.post('/api/worlds/:id/npc/:npcId/portrait-url', async (req, res) => {
  try {
    const world = worlds.get(req.params.id);
    if (!world) { res.status(404).json({ error: 'world not found' }); return; }
    const npcId = String(req.params.npcId);
    const npc = (world.npcs ?? []).find((n: any) => n.id === npcId);
    if (!npc) { res.status(404).json({ error: 'npc not found' }); return; }
    const url = String(req.body?.url ?? '').trim();
    if (!url) { res.status(400).json({ error: 'url required' }); return; }
    if (!/^https?:\/\//i.test(url)) { res.status(400).json({ error: 'url must be http(s)' }); return; }
    // Fetch the image with a 15s timeout, public hosts only, 12MB cap.
    let fetched: { response: Response; body: Buffer };
    try {
      fetched = await fetchPublicUrl(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WorldGen/1.0; +http://localhost)',
          'Accept': 'image/*',
        },
      }, { timeoutMs: 15_000, maxBytes: 12 * 1024 * 1024 });
    } catch (err) {
      if (err instanceof UnsafeUrlError) { res.status(400).json({ error: err.message }); return; }
      throw err;
    }
    const upstream = fetched.response;
    if (!upstream.ok) { res.status(502).json({ error: `upstream returned ${upstream.status}` }); return; }
    const ctype = String(upstream.headers.get('content-type') || '').toLowerCase();
    if (!ctype.startsWith('image/')) { res.status(400).json({ error: `not an image (content-type=${ctype || 'none'})` }); return; }
    // Determine extension from content-type, fall back to URL path
    let ext = 'jpg';
    if (ctype.includes('png')) ext = 'png';
    else if (ctype.includes('webp')) ext = 'webp';
    else if (ctype.includes('jpeg') || ctype.includes('jpg')) ext = 'jpg';
    else {
      const urlExt = (url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i)?.[1] || '').toLowerCase();
      if (urlExt) ext = urlExt === 'jpeg' ? 'jpg' : urlExt;
    }
    const buf = fetched.body;
    if (!buf.length || buf.length > 12 * 1024 * 1024) { res.status(413).json({ error: 'image size out of range (max 12MB)' }); return; }
    const worldDir = join(GENERATED_DIR, world.id);
    if (!existsSync(worldDir)) mkdirSync(worldDir, { recursive: true });
    const safe = npcId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    const destAbs = join(worldDir, `manual-${safe}.${ext}`);
    writeFileSync(destAbs, buf);
    const destUrl = `/generated/${world.id}/manual-${safe}.${ext}`;
    const w = world as any;
    w.images = w.images ?? {};
    w.images.portraits = w.images.portraits ?? {};
    w.images.portraitSources = w.images.portraitSources ?? {};
    w.images.portraits[npcId] = destUrl;
    w.images.portraitSources[npcId] = {
      kind: 'manual',
      uploadedAt: new Date().toISOString(),
      sizeBytes: buf.length,
      sourceUrl: url,
    };
    const imgs = (npc as any).images || {};
    imgs.portrait = destUrl;
    (npc as any).images = imgs;
    saveWorld(world);
    console.log(`[manual-portrait-url] world ${world.id} npc ${npcId}: ${buf.length} bytes from ${url}`);
    res.json({ ok: true, worldId: world.id, npcId, url: destUrl, sizeBytes: buf.length, sourceUrl: url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[worldgen:portrait-url:error]', msg);
    if (msg.includes('aborted') || msg.includes('timeout')) { res.status(504).json({ error: 'image fetch timed out' }); return; }
    res.status(500).json({ error: 'Portrait URL fetch failed', detail: msg });
  }
});

app.post('/api/worlds/:id/source-digest', async (req, res) => {
  try {
    const world = worlds.get(req.params.id);
    if (!world) { res.status(404).json({ error: 'world not found' }); return; }
    if (!process.env.DEEPSEEK_API_KEY) { res.status(400).json({ error: 'DEEPSEEK_API_KEY not configured' }); return; }
    const docs = (world.sourceDocuments ?? []) as WorldSourceDocument[];
    if (docs.length === 0) { res.status(400).json({ error: 'world has no source documents' }); return; }
    const targetDocId = req.body?.docId as string | undefined;
    const targetDoc = targetDocId
      ? docs.find((d: any) => d.id === targetDocId)
      : [...docs].reverse().find((d: any) => (d.extractedText || '').length > 200 || !!readSourceDocumentSidecar(d));
    if (!targetDoc) { res.status(400).json({ error: 'no source document with usable text found' }); return; }
    let fullText = readSourceDocumentSidecar(targetDoc);
    if (!fullText && targetDoc.path) {
      const abs = resolveProjectTextPath(String(targetDoc.path));
      if (abs && existsSync(abs) && /\.pdf$/i.test(abs)) {
        try { fullText = await extractPdfTextRobust(abs); } catch { /* fall through */ }
      }
    }
    if (!fullText && targetDoc.extractedText) fullText = targetDoc.extractedText;
    if (!fullText || fullText.length < 200) {
      res.status(400).json({ error: 'no usable full text available for digest generation' });
      return;
    }
    console.log(`[digest] retro generating for world ${world.id} doc ${targetDoc.id} (${fullText.length} chars)`);
    const t0 = Date.now();
    const digest = await buildSourceDigest(fullText, { sourceTitle: targetDoc.title, sourceKind: String(targetDoc.sourceType || 'Film') });
    targetDoc.digest = digest;
    targetDoc.digestGeneratedAt = new Date().toISOString();
    saveWorld(world);
    const dt = Math.round((Date.now() - t0) / 1000);
    console.log(`[digest] world ${world.id} doc ${targetDoc.id}: ${digest.length} chars in ${dt}s`);
    res.json({
      ok: true,
      worldId: world.id,
      docId: targetDoc.id,
      sourceTitle: targetDoc.title,
      digestChars: digest.length,
      durationSec: dt,
      preview: digest.slice(0, 600),
    });
  } catch (e) {
    console.error('[digest] retro error:', e);
    res.status(500).json({ error: 'digest generation failed', detail: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/worlds/:id/cast-rematch', async (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const apiKey = String(process.env.TMDB_API_KEY || '');
  if (!apiKey) { res.status(400).json({ error: 'TMDB_API_KEY not configured' }); return; }
  const docs = (world.sourceDocuments || []) as any[];
  const bestDoc = [...docs].reverse().find(d => (d.extractedText || '').length > 200 || !!d.textPath) || docs[docs.length-1];
  const title = String(req.body?.title || bestDoc?.title || world.concept || '').trim();
  if (!title) { res.status(400).json({ error: 'No source title (provide req.body.title)' }); return; }
  const yearRaw = req.body?.year;
  const year = (typeof yearRaw === 'number' && yearRaw > 1800 && yearRaw < 2200) ? yearRaw
             : (typeof yearRaw === 'string' && /^\d{4}$/.test(yearRaw) && Number(yearRaw) > 1800 && Number(yearRaw) < 2200) ? Number(yearRaw)
             : undefined;
  try {
    const logs: string[] = [];
    // Orchestrator: resolve cover first, then cast
    await resolveCover(world, title, apiKey, GENERATED_DIR, (m) => logs.push(m));
    const result = await applyCastImagesToWorld(world, title, apiKey, GENERATED_DIR, (m) => logs.push(m), year);
    saveWorld(world);
    res.json({ ok: true, title, source: result.source, totalCast: result.cast.length, matched: result.matches.length, matches: result.matches, logs });
  } catch (e) {
    res.status(500).json({ error: 'Cast rematch failed', detail: e instanceof Error ? e.message : String(e) });
  }
});
app.post('/api/worlds/:id/regen-portraits', async (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const npcs = (world as any).npcs || [];
  const locs = (world as any).locations || [];
  const portraits = ((world as any).images && (world as any).images.portraits) || {};
  const scenes = ((world as any).images && (world as any).images.scenes) || {};
  const missing = Array.isArray(npcs) ? npcs.filter((n: any) => n && n.id && !portraits[n.id]) : [];
  const missingScenes = Array.isArray(locs) ? locs.filter((l: any) => l && l.id && !scenes[l.id]) : [];
  const missingCover = !((world as any).images && (world as any).images.cover);
  const refreshSourceVisuals = sourceVisualPromptNeedsRefresh(world);
  if (missing.length === 0 && missingScenes.length === 0 && !missingCover && !refreshSourceVisuals) {
    res.json({ ok: true, queued: 0, total: Array.isArray(npcs) ? npcs.length : 0, note: 'all images present' });
    return;
  }
  try {
    queueWorldImageGeneration(world);  // skips NPCs that already have portraits (existingPortraits guard)
    res.json({
      ok: true,
      queued: missing.length + missingScenes.length + (missingCover ? 1 : 0) + (refreshSourceVisuals ? 1 : 0),
      total: Array.isArray(npcs) ? npcs.length : 0,
      missingIds: missing.map((n: any) => n.id),
      missingSceneIds: missingScenes.map((l: any) => l.id),
      refreshSourceVisuals,
    });
  } catch (e) {
    res.status(500).json({ error: 'Portrait regen failed', detail: e instanceof Error ? e.message : String(e) });
  }
});

// ── ArcFace portrait pipeline (scripts/portrait_pipeline.py) ──
type PortraitPipelineRunState = {
  running: boolean;
  worldId: string;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  code?: number | null;
  args: string[];
  log: string;            // combined stdout+stderr tail
  result?: PipelineResult | null;
  resultLine?: string;   // the captured PIPELINE_RESULT_JSON= line (immune to log-tail truncation)
  appliedNpcIds?: string[];
  error?: string;
};
let portraitPipelineRunState: PortraitPipelineRunState | null = null;

// Candidate Python interpreters to probe, as argv prefixes ([exe, ...leadingArgs]).
// On some machines bare `python` resolves to an unrelated venv (e.g. an agent
// sandbox) that lacks the portrait deps, so we also try the Windows `py -3`
// launcher (which targets the system install) and an explicit env override.
function portraitPythonCandidates(): string[][] {
  const cands: string[][] = [];
  const override = String(process.env.PORTRAIT_PYTHON || process.env.PYTHON_BIN || '').trim();
  if (override) cands.push([override]);
  if (process.platform === 'win32') cands.push(['py', '-3']);
  cands.push(['python'], ['python3']);
  return cands;
}

// Run `portrait_pipeline.py --check` with a specific interpreter and parse the
// PIPELINE_CHECK_JSON sentinel. spawnError=true means the interpreter itself
// could not be launched (so we should fall through to the next candidate).
function runPortraitDepCheck(pythonArgv: string[]): Promise<{ ok: boolean; missing: string[]; spawnError?: boolean }> {
  return new Promise(resolve => {
    const [bin, ...prefix] = pythonArgv;
    const child = spawn(bin, [...prefix, join(REPO_ROOT, 'scripts', 'portrait_pipeline.py'), '--check'], {
      cwd: REPO_ROOT, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', c => { out += c; });
    child.on('error', () => resolve({ ok: false, missing: [], spawnError: true }));
    child.on('close', () => {
      const line = out.split(/\r?\n/).find(l => l.startsWith('PIPELINE_CHECK_JSON='));
      if (!line) { resolve({ ok: false, missing: [], spawnError: true }); return; }
      try {
        const j = JSON.parse(line.slice('PIPELINE_CHECK_JSON='.length));
        resolve({ ok: Boolean(j.ok), missing: Array.isArray(j.missing) ? j.missing : [] });
      } catch { resolve({ ok: false, missing: [], spawnError: true }); }
    });
  });
}

// Cached argv prefix of the first interpreter that reported all deps present.
let resolvedPortraitPython: string[] | null = null;

// Probe candidates and return the first interpreter whose deps are all importable.
// Returns argv=null with `missing` populated when an interpreter was found but is
// missing deps, or argv=null with missing=[] when no interpreter could be launched.
async function resolvePortraitPython(): Promise<{ argv: string[] | null; missing: string[]; tried: string[] }> {
  if (resolvedPortraitPython) return { argv: resolvedPortraitPython, missing: [], tried: [] };
  const tried: string[] = [];
  let bestMissing: string[] = [];
  for (const argv of portraitPythonCandidates()) {
    tried.push(argv.join(' '));
    const r = await runPortraitDepCheck(argv);
    if (r.spawnError) continue;                 // interpreter not launchable — try next
    if (r.ok) { resolvedPortraitPython = argv; return { argv, missing: [], tried }; }
    bestMissing = r.missing;                     // launchable but deps missing — remember
  }
  return { argv: null, missing: bestMissing, tried };
}

app.post('/api/worlds/:id/portrait-pipeline', async (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  if (portraitPipelineRunState?.running) {
    res.status(409).json({ error: 'Portrait pipeline already running', run: portraitPipelineRunState });
    return;
  }
  const concept = String((world as any).concept || '').trim();
  if (!concept) { res.status(400).json({ error: 'World has no concept to resolve a film from' }); return; }
  if (!String(process.env.TMDB_API_KEY || '').trim()) {
    res.status(400).json({ error: 'TMDB_API_KEY not configured for portrait pipeline' });
    return;
  }

  // Acquire the single-flight lock SYNCHRONOUSLY, before any await, so two
  // near-simultaneous POSTs can't both pass the running-check and spawn twice.
  const state: PortraitPipelineRunState = {
    running: true, worldId: String(world.id),
    startedAt: new Date().toISOString(), args: [], log: '', result: null,
  };
  portraitPipelineRunState = state;

  const py = await resolvePortraitPython();
  if (!py.argv) {
    state.running = false; state.endedAt = new Date().toISOString();
    const detail = py.missing.length
      ? `missing python deps: ${py.missing.join(', ')}`
      : `no python interpreter found (tried: ${py.tried.join(', ')})`;
    state.error = detail;
    res.status(400).json({
      error: py.missing.length
        ? 'Python dependencies missing for portrait pipeline'
        : 'No Python interpreter available for portrait pipeline',
      missing: py.missing, tried: py.tried,
      hint: 'Set PORTRAIT_PYTHON to a python.exe that has numpy, cv2, insightface, onnxruntime, playwright, requests, curl_cffi installed.',
    });
    return;
  }

  // DEFAULT_SOURCE: 'imdb' per FanCaps verification (2026-05-28) — IMDB produced
  // more usable, larger crops than FanCaps on the Vanilla Sky test world.
  const DEFAULT_SOURCE = 'imdb';
  const source = (req.body?.source === 'imdb' || req.body?.source === 'fancaps') ? req.body.source : DEFAULT_SOURCE;
  const args = ['--world', String(world.id), '--source', source, '--json', '--apply'];
  if (typeof req.body?.tmdb === 'number' && Number.isFinite(req.body.tmdb)) args.push('--tmdb', String(req.body.tmdb));
  if (typeof req.body?.thresh === 'number' && req.body.thresh > 0 && req.body.thresh < 1) args.push('--thresh', String(req.body.thresh));
  if (typeof req.body?.minFacePx === 'number' && req.body.minFacePx > 0) args.push('--min-face-px', String(req.body.minFacePx));
  if (typeof req.body?.castPortraits === 'number' && req.body.castPortraits > 0) args.push('--cast-portraits', String(Math.min(20, Math.floor(req.body.castPortraits))));
  state.args = args;

  const [pyBin, ...pyPrefix] = py.argv;
  const child = spawn(pyBin, [...pyPrefix, join(REPO_ROOT, 'scripts', 'portrait_pipeline.py'), ...args], {
    cwd: REPO_ROOT, env: { ...process.env, PYTHONUNBUFFERED: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.pid = child.pid;
  // Capture the PIPELINE_RESULT_JSON= sentinel line as it streams, independent of
  // the (truncated) display log, so a long result line is never clipped before parsing.
  let lineBuf = '';
  const append = (chunk: string) => {
    state.log = (state.log + chunk).slice(-8000);
    lineBuf += chunk;
    const lines = lineBuf.split(/\r?\n/);
    lineBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith(PIPELINE_RESULT_SENTINEL)) state.resultLine = line;
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', err => {
    state.running = false; state.endedAt = new Date().toISOString();
    state.error = err instanceof Error ? err.message : String(err);
  });
  child.on('close', code => {
    state.code = code;
    state.endedAt = new Date().toISOString();
    // The sentinel line may arrive without a trailing newline — check the buffer remainder too.
    if (!state.resultLine && lineBuf.startsWith(PIPELINE_RESULT_SENTINEL)) state.resultLine = lineBuf;
    try {
      if (code === 0) {
        const result = parsePipelineResult(state.resultLine || state.log);
        state.result = result;
        if (result && result.swaps.some(s => s.applied)) {
          const live = worlds.get(state.worldId);
          if (live) {
            const { appliedNpcIds } = applyPipelineResult(live as any, result, Date.now());
            state.appliedNpcIds = appliedNpcIds;
            if (appliedNpcIds.length) saveWorld(live);
          }
        } else if (result?.skipped) {
          state.error = `skipped: ${result.skipped}`;
        } else if (!result) {
          state.error = 'pipeline finished but its result could not be read';
        }
      } else {
        state.error = `pipeline exited ${code}`;
      }
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      state.running = false;
    }
  });

  res.json({ ok: true, worldId: world.id, source, args, run: { startedAt: state.startedAt, pid: state.pid } });
});

app.get('/api/worlds/:id/portrait-pipeline/status', (req, res) => {
  const s = portraitPipelineRunState;
  if (!s || s.worldId !== req.params.id) { res.json({ running: false, idle: true }); return; }
  res.json({
    running: s.running, worldId: s.worldId, startedAt: s.startedAt, endedAt: s.endedAt,
    exitCode: s.code ?? null, log: s.log, result: s.result ?? null,
    appliedNpcIds: s.appliedNpcIds ?? [], error: s.error ?? null,
  });
});

app.post('/api/worlds/:id/world-quests/generate', async (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  attachKnownWorldQuestSourceDocuments(world);
  if (req.body?.realWorldBased !== undefined) world.realWorldBased = !!req.body.realWorldBased;
  if (typeof req.body?.realWorldFacts === 'string') world.realWorldFacts = req.body.realWorldFacts.slice(0, 5000);
  if (!isRealWorldQuestEligible(world)) { res.status(409).json({ error: 'Unavailable' }); return; }
  const existingActive = (world.worldQuestAdventures ?? []).find(q => q.status === 'active');
  if (existingActive) {
    res.status(409).json({ error: 'World Quest is already active', quest: existingActive });
    return;
  }
  const existingAvailable = (world.worldQuestAdventures ?? []).find(q => q.status === 'available');
  if (existingAvailable && req.body?.replace !== true) {
    res.status(409).json({ error: 'Unavailable', quest: existingAvailable });
    return;
  }
  if (req.body?.replace === true) cleanupWorldQuestState(world, true);
  const requirementCount = normaliseWorldQuestRequirementCount(req.body?.requirementCount ?? req.body?.requirements ?? req.body?.steps);
  const npcRequirementMode = normaliseWorldQuestNpcMode(req.body?.npcRequirementMode ?? req.body?.npcMode ?? req.body?.difficulty);
  const quest = await generateConformingWorldQuestAdventure(world, req.body?.provider, req.body?.model, undefined, requirementCount, npcRequirementMode);
  world.worldQuestAdventures = [quest, ...(world.worldQuestAdventures ?? []).filter(item => item.status === 'completed' || item.status === 'failed' || item.status === 'abandoned').slice(0, 8)];
  saveWorld(world);
  bumpWorldsListCache();
  res.json({ quest, worldQuestAdventures: world.worldQuestAdventures, validation: quest.replacementReason });
});

app.post('/api/sessions/:id/world-quests/fail', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  const boundSession = (session.globalPlayerId && world ? activeWorldQuestSessionForPlayer(world, session.globalPlayerId) : undefined) ?? session;
  const quest = world ? activeWorldQuestForSessionFromWorld(boundSession, world) : boundSession.activeWorldQuest;
  if (!quest) { res.status(409).json({ error: 'No active World Quest' }); return; }
  const failedQuest = closeWorldQuestRun(boundSession, quest, 'failed');
  res.json({ session: boundSession, worldQuest: null, worldQuestUpdate: { failed: true, quest: failedQuest, hint: 'This World Quest failed. Retry will generate a fresh attempt.' }, quest: getQuestStatus(boundSession) });
});

app.post('/api/sessions/:id/world-quests/abandon', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const boundSession = (session.globalPlayerId ? activeWorldQuestSessionForPlayer(world, session.globalPlayerId) : undefined) ?? session;
  const quest = activeWorldQuestForSessionFromWorld(boundSession, world);
  if (!quest) { res.status(409).json({ error: 'No active World Quest' }); return; }
  const abandonedQuest = closeWorldQuestRun(boundSession, quest, 'abandoned');
  res.json({ session: boundSession, worldQuest: null, worldQuestUpdate: { failed: true, abandoned: true, quest: abandonedQuest, hint: 'This World Quest was abandoned.' }, quest: getQuestStatus(boundSession) });
});

app.post('/api/sessions/:id/world-quests/retry', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  if (session.activeWorldQuest?.status === 'failed' || session.activeWorldQuest?.status === 'abandoned') session.activeWorldQuest = undefined;
  const world = worlds.get(session.worldId);
  if (!world || !isRealWorldQuestEligible(world)) { res.status(409).json({ error: 'Unavailable' }); return; }
  activeWorldQuestForSessionFromWorld(session, world);
  if (activeWorldQuestBlock(session)) { res.status(409).json({ error: 'Unavailable' }); return; }
  const existingBlocking = (world.worldQuestAdventures ?? []).find(q => q.status === 'available' || q.status === 'active');
  if (existingBlocking) {
    res.status(409).json({ error: 'World Quest is already available or active', quest: existingBlocking });
    return;
  }
  const failed = [...(session.completedWorldQuests ?? []), ...(world.worldQuestAdventures ?? [])].find(q => q.status === 'failed' || q.status === 'abandoned');
  if (!failed) { res.status(404).json({ error: 'No failed or abandoned World Quest to retry' }); return; }
  const requirementCount = normaliseWorldQuestRequirementCount(req.body?.requirementCount ?? req.body?.requirements ?? req.body?.steps ?? failed?.steps?.length);
  const npcRequirementMode = normaliseWorldQuestNpcMode(req.body?.npcRequirementMode ?? req.body?.npcMode ?? req.body?.difficulty);
  const quest = await generateConformingWorldQuestAdventure(world, req.body?.provider, req.body?.model, failed?.id, requirementCount, npcRequirementMode);
  const now = new Date().toISOString();
  quest.status = 'active';
  quest.startedAt = now;
  quest.sessionId = session.id;
  quest.participantSessionIds = [session.id];
  quest.hostSessionId = session.id;
  quest.guestSessionId = undefined;
  quest.guestCoopMode = undefined;
  quest.allowCoop = true;
  quest.twoPlayer = true;
  quest.hostCoopMode = 'join';
  quest.pendingJoinRequests = [];
  quest.steps = quest.steps.map(step => ({ ...step, status: 'active', completedAt: undefined }));
  world.worldQuestAdventures = [quest, ...(world.worldQuestAdventures ?? []).filter(item => item.id !== failed.id && (item.status === 'completed' || item.status === 'failed' || item.status === 'abandoned')).slice(0, 8)];
  session.completedWorldQuests = (session.completedWorldQuests ?? []).filter(item => item.id !== failed?.id);
  attachSessionToWorldQuest(session, world, quest);
  appendFeedEvents(session, [{ ty: 'quest', x: `World Quest retry started: ${quest.title}` }]);
  saveWorld(world);
  bumpWorldsListCache();
  persistSessionState(session);
  res.json({ quest, worldQuest: quest, session, worldQuestAdventures: world.worldQuestAdventures, validation: quest.replacementReason });
});

app.post('/api/sessions/:id/world-quests/:questId/start', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  if (!isRealWorldQuestEligible(world)) { res.status(409).json({ error: 'Unavailable' }); return; }
  activeWorldQuestForSessionFromWorld(session, world);
  if (activeWorldQuestBlock(session)) {
    res.status(409).json({
      error: 'Unavailable',
      detail: session.activeWorldQuest?.status === 'active'
        ? `Character is already in World Quest: ${session.activeWorldQuest.title}`
        : `Character is already in quest: ${session.activeQuest?.title || session.activeQuest?.name || 'active quest'}`,
    });
    return;
  }
  let source = (world.worldQuestAdventures ?? []).find(q => q.id === req.params.questId);
  if (!source || source.status !== 'available') { res.status(404).json({ error: 'World Quest not available' }); return; }
  const preflightIssues = worldQuestNpcConformanceIssues(source, world);
  if (preflightIssues.length) {
    const oldSourceId = source.id;
    const requirementCount = normaliseWorldQuestRequirementCount(source.steps?.length);
    const npcRequirementMode = normaliseWorldQuestNpcMode(source.difficulty);
    const replacement = await generateConformingWorldQuestAdventure(world, req.body?.provider, req.body?.model, oldSourceId, requirementCount, npcRequirementMode);
    replacement.replacementReason = `Regenerated before start: ${preflightIssues.join('; ')}${replacement.replacementReason ? `; ${replacement.replacementReason}` : ''}`;
    world.worldQuestAdventures = [
      replacement,
      ...(world.worldQuestAdventures ?? []).filter(item => item.id !== oldSourceId && item.status !== 'available').slice(0, 8),
    ];
    source = replacement;
  }
  source.status = 'active';
  source.startedAt = new Date().toISOString();
  source.sessionId = session.id;
  source.participantSessionIds = [session.id];
  source.hostSessionId = session.id;
  source.guestSessionId = undefined;
  source.guestCoopMode = undefined;
  source.allowCoop = true;
  source.twoPlayer = true;
  source.hostCoopMode = 'join';
  source.pendingJoinRequests = [];
  source.steps = source.steps.map(step => ({ ...step, status: 'active', completedAt: undefined }));
  attachSessionToWorldQuest(session, world, source);
  appendFeedEvents(session, [{ ty: 'quest', x: `World Quest started: ${source.title}` }]);
  recordObjectiveEvent(session, {
    type: 'quest',
    date: session.currentDate,
    timeOfDay: resolveTimeOfDay(world, session.currentTime),
    locationId: session.currentLocationId,
    actorId: 'player',
    targetIds: source.involvedNpcIds,
    summary: `World Quest started: ${source.title}.`,
    detail: source.premise,
    tags: ['quest', 'world-quest', 'start'],
  });
  saveWorld(world);
  bumpWorldsListCache();
  persistSessionState(session);
  res.json({ worldQuest: source, session, quest: getQuestStatus(session) });
});

app.post('/api/sessions/:id/world-quests/:questId/join', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const quest = (world.worldQuestAdventures ?? []).find(q => q.id === req.params.questId && q.status === 'active');
  if (!quest) { res.status(404).json({ error: 'Active World Quest not found' }); return; }
  const existingParticipant = session.globalPlayerId
    ? worldQuestParticipantSessionForPlayer(quest, session.globalPlayerId)
    : undefined;
  if (existingParticipant) {
    activeWorldQuestForSessionFromWorld(existingParticipant, world);
    const player = session.globalPlayerId ? globalPlayers.get(session.globalPlayerId) : undefined;
    if (player) copyGlobalProgressToSession(existingParticipant, player);
    ensureVisiblePlayerStart(existingParticipant);
    persistSessionState(existingParticipant);
    res.json({ worldQuest: quest, session: existingParticipant, quest: getQuestStatus(existingParticipant), resumed: true });
    return;
  }
  if (!worldQuestAllowsCoop(quest)) {
    res.status(403).json({ error: 'Co-op is not enabled for this World Quest.' });
    return;
  }
  quest.allowCoop = true;
  quest.twoPlayer = true;
  quest.hostSessionId ??= quest.sessionId ?? worldQuestParticipantIds(quest)[0];
  try {
    attachSessionToWorldQuest(session, world, quest);
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'World Quest join blocked' });
    return;
  }
  appendFeedEvents(session, [{ ty: 'quest', x: `Joined World Quest: ${quest.title}` }]);
  quest.hostCoopMode = 'join';
  quest.guestCoopMode = quest.guestSessionId ? 'join' : quest.guestCoopMode;
  saveWorld(world);
  bumpWorldsListCache();
  persistSessionState(session);
  if (quest.twoPlayer && quest.hostSessionId && quest.hostSessionId !== session.id) {
    pushCoopEvent(quest.hostSessionId, {
      type: 'coop_player_joined',
      guestSessionId: session.id,
      guestName: session.playerName,
    });
  }
  res.json({ worldQuest: quest, session, quest: getQuestStatus(session) });
});

app.post('/api/sessions/:id/world-quests/:questId/request-join', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const quest = (world.worldQuestAdventures ?? []).find(q => q.id === req.params.questId && q.status === 'active');
  if (!quest) { res.status(404).json({ error: 'Active World Quest not found' }); return; }
  activeWorldQuestForSessionFromWorld(session, world);
  const existingParticipant = session.globalPlayerId ? worldQuestParticipantSessionForPlayer(quest, session.globalPlayerId) : undefined;
  if (existingParticipant) {
    activeWorldQuestForSessionFromWorld(existingParticipant, world);
    persistSessionState(existingParticipant);
    res.json({ status: 'accepted', worldQuest: quest, session: existingParticipant });
    return;
  }
  if (session.activeQuest?.status === 'active' || hasActiveSerializedAdventure(session) || (session.activeWorldQuest?.status === 'active' && session.activeWorldQuest.id !== quest.id)) {
    res.status(409).json({ error: 'Finish or abandon your active quest before joining this World Quest.' });
    return;
  }
  const participantIds = pruneWorldQuestParticipantIds(quest);
  if (participantIds.length >= MAX_WORLD_QUEST_PLAYERS) {
    res.status(409).json({ error: `World Quest already has ${MAX_WORLD_QUEST_PLAYERS} players` });
    return;
  }
  quest.allowCoop = true;
  quest.twoPlayer = true;
  quest.sessionId ??= participantIds[0];
  quest.hostSessionId ??= quest.sessionId ?? participantIds[0];
  quest.hostCoopMode ??= 'join';
  const pending = cleanWorldQuestJoinRequests(quest);
  let request = pending.find(item => item.sessionId === session.id);
  if (!request) {
    request = {
      id: randomUUID(),
      sessionId: session.id,
      playerName: session.playerName,
      requestedAt: new Date().toISOString(),
      status: 'pending',
    };
    quest.pendingJoinRequests = [...(quest.pendingJoinRequests ?? []), request];
  }
  saveWorld(world);
  bumpWorldsListCache();
  for (const participantId of worldQuestParticipantIds(quest)) {
    pushCoopEvent(participantId, {
      type: 'world_quest_join_request',
      questId: quest.id,
      requestId: request.id,
      sessionId: session.id,
      playerName: session.playerName,
    });
  }
  res.json({ status: 'pending', request, questId: quest.id });
});

app.get('/api/sessions/:id/world-quests/:questId/join-requests/:requestId', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const quest = (world.worldQuestAdventures ?? []).find(q => q.id === req.params.questId);
  if (!quest) { res.status(404).json({ error: 'World Quest not found' }); return; }
  const request = (quest.pendingJoinRequests ?? []).find(item => item.id === req.params.requestId);
  const participant = worldQuestParticipantIds(quest).includes(session.id);
  if (!request && participant) { res.json({ status: 'accepted', worldQuest: quest, session }); return; }
  if (!request || request.sessionId !== session.id) { res.status(404).json({ error: 'Join request not found' }); return; }
  res.json({ status: request.status, request, worldQuest: request.status === 'accepted' ? quest : undefined, session: request.status === 'accepted' ? session : undefined });
});

app.post('/api/sessions/:id/world-quests/:questId/join-requests/:requestId/respond', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const quest = (world.worldQuestAdventures ?? []).find(q => q.id === req.params.questId && q.status === 'active');
  if (!quest) { res.status(404).json({ error: 'Active World Quest not found' }); return; }
  if (!worldQuestParticipantIds(quest).includes(session.id)) {
    res.status(403).json({ error: 'Only current World Quest players can answer join requests' });
    return;
  }
  const request = (quest.pendingJoinRequests ?? []).find(item => item.id === req.params.requestId);
  if (!request || request.status !== 'pending') { res.status(404).json({ error: 'Pending join request not found' }); return; }
  const targetSession = sessions.get(request.sessionId);
  if (!targetSession || targetSession.worldId !== world.id) { res.status(404).json({ error: 'Requesting player session not found' }); return; }
  const accept = req.body?.accept === true;
  if (accept) {
    const participantIds = pruneWorldQuestParticipantIds(quest);
    if (!participantIds.includes(targetSession.id) && participantIds.length >= MAX_WORLD_QUEST_PLAYERS) {
      res.status(409).json({ error: `World Quest already has ${MAX_WORLD_QUEST_PLAYERS} players` });
      return;
    }
    request.status = 'accepted';
    request.respondedAt = new Date().toISOString();
    request.responderSessionId = session.id;
    quest.allowCoop = true;
    quest.twoPlayer = true;
    quest.sessionId ??= participantIds[0] ?? session.id;
    quest.hostSessionId ??= quest.sessionId ?? session.id;
    try {
      attachSessionToWorldQuest(targetSession, world, quest);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'World Quest join blocked' });
      return;
    }
    setSessionLocation(targetSession, session.currentLocationId);
    quest.hostCoopMode = 'join';
    quest.guestCoopMode = 'join';
    appendFeedEvents(targetSession, [{ ty: 'quest', x: `Joined World Quest: ${quest.title}` }]);
    for (const participantId of worldQuestParticipantIds(quest)) {
      if (participantId !== targetSession.id) {
        pushCoopEvent(participantId, {
          type: 'coop_player_joined',
          guestSessionId: targetSession.id,
          guestName: targetSession.playerName,
        });
      }
    }
    pushCoopEvent(targetSession.id, {
      type: 'world_quest_join_accepted',
      questId: quest.id,
      sessionId: targetSession.id,
      locationId: targetSession.currentLocationId,
    });
  } else {
    request.status = 'declined';
    request.respondedAt = new Date().toISOString();
    request.responderSessionId = session.id;
    pushCoopEvent(targetSession.id, {
      type: 'world_quest_join_declined',
      questId: quest.id,
      sessionId: targetSession.id,
    });
  }
  saveWorld(world);
  bumpWorldsListCache();
  persistSessionState(targetSession);
  persistSessionState(session);
  res.json({ status: request.status, request, worldQuest: quest, session: accept ? targetSession : undefined });
});

app.post('/api/sessions/:id/world-quest/coop-mode', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  activeWorldQuestForSessionFromWorld(session, world);
  const quest = session.activeWorldQuest;
  if (!quest || quest.status !== 'active' || !quest.twoPlayer || !quest.guestSessionId) {
    res.status(409).json({ error: 'Not in a 2P quest' });
    return;
  }
  const mode = String(req.body?.mode || '');
  if (mode !== 'join' && mode !== 'free') { res.status(400).json({ error: 'mode must be "join" or "free"' }); return; }
  const isHost = session.id === quest.hostSessionId;
  const isGuest = session.id === quest.guestSessionId;
  if (!isHost && !isGuest) { res.status(403).json({ error: 'Not a participant' }); return; }
  if (isHost) quest.hostCoopMode = mode;
  else quest.guestCoopMode = mode;
  if (mode === 'join') {
    const partnerId = isHost ? quest.guestSessionId : quest.hostSessionId;
    const partnerSession = partnerId ? sessions.get(partnerId) : undefined;
    if (partnerSession) setSessionLocation(session, partnerSession.currentLocationId);
  }
  saveWorld(world);
  bumpWorldsListCache();
  persistSessionState(session);
  pushCoopEventToPartner(quest, session.id, {
    type: 'coop_mode_change',
    sessionId: session.id,
    mode,
    locationId: session.currentLocationId,
  });
  res.json({ quest, session, mode });
});

app.post('/api/sessions/:id/world-quest/leave', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  activeWorldQuestForSessionFromWorld(session, world);
  const quest = session.activeWorldQuest;
  if (!quest || quest.status !== 'active' || !quest.twoPlayer) {
    res.status(409).json({ error: 'Not in a 2P quest' });
    return;
  }
  if (session.id !== quest.guestSessionId) {
    res.status(403).json({ error: 'Only the guest can leave. Host must abandon.' });
    return;
  }
  const hostId = quest.hostSessionId;
  quest.participantSessionIds = (quest.participantSessionIds ?? []).filter(id => id !== session.id);
  quest.guestSessionId = undefined;
  quest.guestCoopMode = undefined;
  quest.hostCoopMode = undefined;
  session.activeWorldQuest = undefined;
  appendFeedEvents(session, [{ ty: 'quest', x: `Left World Quest: ${quest.title}` }]);
  saveWorld(world);
  bumpWorldsListCache();
  persistSessionState(session);
  if (hostId) pushCoopEvent(hostId, { type: 'coop_player_left', sessionId: session.id });
  res.json({ left: true, session });
});

app.get('/api/worlds/:worldId/joinable-quests', (req, res) => {
  const world = worlds.get(req.params.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const joinable = (world.worldQuestAdventures ?? []).filter(q =>
    q.status === 'active'
    && worldQuestParticipantKeys(q).size < MAX_WORLD_QUEST_PLAYERS
  ).map(q => ({
    id: q.id,
    title: q.title,
    premise: q.premise,
    difficulty: q.difficulty,
    hostSessionId: q.hostSessionId,
    hostName: q.hostSessionId ? sessions.get(q.hostSessionId)?.playerName : undefined,
    stepsTotal: q.steps.length,
    stepsComplete: q.steps.filter(step => step.status === 'complete').length,
  }));
  res.json({ quests: joinable });
});

// ── Serialized Adventures ────────────────────────────────────────────────────

app.get('/api/worlds/:id/serialized-adventures', (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  res.json({ adventures: world.serializedAdventures ?? [], sourceDocuments: world.sourceDocuments ?? [] });
});

app.post('/api/worlds/:id/serialized-adventures/generate', (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  attachKnownWorldQuestSourceDocuments(world);
  const corpus = worldQuestSourceCorpus(world);
  const terms = worldQuestSourceTerms(world);
  void (async () => {
    try {
      const timelineEventIds = Array.isArray(req.body?.timelineEventIds)
        ? req.body.timelineEventIds.map((id: any) => String(id)).filter(Boolean)
        : [];
      if (!world.serializedAdventures) world.serializedAdventures = [];
      let generated: typeof world.serializedAdventures = [];
      if (timelineEventIds.length) {
        const byId = new Map((world.timeline ?? []).map(ev => [ev.id, ev]));
        const selected = timelineEventIds.map((id: string) => byId.get(id)).filter(Boolean);
        if (!selected.length) {
          res.status(400).json({ error: 'No matching timeline events found' });
          return;
        }
        if (selected.length !== timelineEventIds.length) {
          res.status(400).json({ error: 'One or more timeline events were not found' });
          return;
        }
        for (const event of selected) {
          generated.push(await generateSerializedAdventure(world, corpus, terms, req.body?.provider, req.body?.model, { focusTimelineEvent: event }));
        }
      } else {
        generated = [await generateSerializedAdventure(world, corpus, terms, req.body?.provider, req.body?.model)];
      }
      world.serializedAdventures.push(...generated);
      saveWorld(world);
      bumpWorldsListCache();
      res.json({ adventure: generated[0], generated, adventures: world.serializedAdventures, generatedFromTimeline: timelineEventIds.length > 0 });
    } catch (err) {
      console.warn('[serialized-adventure] generate error:', err);
      res.status(500).json({ error: 'Generation failed' });
    }
  })();
});

app.delete('/api/worlds/:id/serialized-adventures/:adventureId', (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const adventure = (world.serializedAdventures ?? []).find(a => a.id === req.params.adventureId);
  if (!adventure) { res.status(404).json({ error: 'Adventure not found' }); return; }
  world.serializedAdventures = (world.serializedAdventures ?? []).filter(a => a.id !== req.params.adventureId);
  for (const session of sessions.values()) {
    if (session.worldId !== world.id || session.activeSerializedAdventure?.id !== req.params.adventureId) continue;
    session.activeSerializedAdventure = undefined;
    persistSessionState(session);
  }
  saveWorld(world);
  bumpWorldsListCache();
  res.json({ ok: true, removedAdventureId: req.params.adventureId, adventures: world.serializedAdventures ?? [] });
});

app.post('/api/sessions/:id/serialized-adventures/:adventureId/start', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  let adventure = (world.serializedAdventures ?? []).find(a => a.id === req.params.adventureId);
  if (!adventure) { res.status(404).json({ error: 'Adventure not available' }); return; }
  if (req.body?.allowCoop === true && adventure.status !== 'active') adventure.allowCoop = true;
  const requestedAdventureId = adventure.id;
  const participantIds = new Set([adventure.sessionId, ...(adventure.participantSessionIds ?? [])].filter((id): id is string => !!id));
  const existingParticipant = session.globalPlayerId
    ? Array.from(sessions.values())
      .filter(candidate => candidate.worldId === world.id && candidate.globalPlayerId === session.globalPlayerId)
      .find(candidate => participantIds.has(candidate.id) || candidate.activeSerializedAdventure?.id === requestedAdventureId)
    : undefined;
  if (adventure.status === 'active' && existingParticipant) {
    existingParticipant.activeSerializedAdventure = adventure;
    const player = session.globalPlayerId ? globalPlayers.get(session.globalPlayerId) : undefined;
    if (player) copyGlobalProgressToSession(existingParticipant, player);
    ensureVisiblePlayerStart(existingParticipant);
    persistSessionState(existingParticipant);
    res.json({ adventure, session: existingParticipant, resumed: true });
    return;
  }
  // Resume in place: this exact adventure is already active and bound to (or was
  // started by) this session - re-bind, do NOT reset progress.
  if (adventure.status === 'active' &&
      (session.activeSerializedAdventure?.id === adventure.id || adventure.sessionId === session.id)) {
    session.activeSerializedAdventure = adventure;
    persistSessionState(session);
    res.json({ adventure, session, resumed: true });
    return;
  }
  // World-scoped exclusivity: an active World Quest or a different active
  // Serialized Adventure blocks a new start. A cross-world Global Quest does NOT.
  if (session.activeWorldQuest?.status === 'active' || hasActiveSerializedAdventure(session)) {
    res.status(409).json({ error: session.activeWorldQuest?.status === 'active'
      ? 'Finish or abandon your active World Quest before starting an Adventure.'
      : 'You are already in an Adventure. Finish or abandon it first.' });
    return;
  }
  if (adventure.status === 'active') {
    res.status(409).json({ error: 'This adventure is in progress in another session.' });
    return;
  }
  if (adventure.status === 'available' || ((adventure.status === 'abandoned' || adventure.status === 'completed') && req.body?.confirmRestart)) {
    const preflightIssues = serializedAdventureNpcConformanceIssues(adventure, world);
    if (preflightIssues.length) {
      const replacement = await generateConformingSerializedAdventure(world, req.body?.provider, req.body?.model);
      if (!replacement.adventure) {
        res.status(409).json({
          error: 'Adventure failed NPC-name preflight after regeneration.',
          detail: replacement.issues.join('; ') || preflightIssues.join('; '),
        });
        return;
      }
      replacement.adventure.allowCoop = adventure.allowCoop || req.body?.allowCoop === true;
      world.serializedAdventures = [
        replacement.adventure,
        ...(world.serializedAdventures ?? []).filter(item => item.id !== requestedAdventureId).slice(0, 12),
      ];
      adventure = replacement.adventure;
    }
  }
  if (adventure.status === 'abandoned' || adventure.status === 'completed') {
    // Co-op guard: only the original owner may wipe shared run state.
    const others = (adventure.participantSessionIds ?? []).filter(id => id !== session.id);
    if ((adventure.allowCoop || others.length > 0) && adventure.sessionId && adventure.sessionId !== session.id) {
      res.status(403).json({ error: 'Only the adventure owner can restart this co-op adventure.' });
      return;
    }
    if (!req.body?.confirmRestart) {
      const pct = Math.round((adventure.spectrumScore ?? 0) * 100);
      res.status(409).json({
        needsRestartConfirm: true,
        previousStatus: adventure.status,
        previousScore: adventure.spectrumScore ?? 0,
        previousTier: spectrumTierLabel(adventure.spectrumScore ?? 0),
        message: adventure.status === 'completed'
          ? `Replaying erases your previous result (${spectrumTierLabel(adventure.spectrumScore ?? 0)}, ${pct}%) and starts fresh from Act 1. Continue?`
          : 'Restart this abandoned adventure from the beginning?',
      });
      return;
    }
    adventure.participantSessionIds = [];
    startSerializedAdventure(session, adventure);
  } else if (adventure.status === 'available') {
    startSerializedAdventure(session, adventure);
  } else {
    res.status(404).json({ error: 'Adventure not available' });
    return;
  }
  if (adventure.allowCoop) {
    adventure.coopModeBySessionId = { [session.id]: 'join' };
  } else {
    adventure.coopModeBySessionId = undefined;
  }
  appendFeedEvents(session, [{ ty: 'quest', x: `Serialized Adventure started: ${adventure.title}` }]);
  recordObjectiveEvent(session, {
    type: 'quest',
    date: session.currentDate,
    timeOfDay: resolveTimeOfDay(world, session.currentTime),
    locationId: session.currentLocationId,
    actorId: 'player',
    targetIds: adventure.involvedNpcIds,
    summary: `Serialized Adventure started: ${adventure.title}.`,
    detail: adventure.premise,
    tags: ['quest', 'serialized-adventure', 'start'],
  });
  saveWorld(world);
  bumpWorldsListCache();
  persistSessionState(session);
  res.json({ adventure: session.activeSerializedAdventure, session });
});

app.post('/api/sessions/:id/serialized-adventures/:adventureId/join', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const adventure = (world.serializedAdventures ?? []).find(a => a.id === req.params.adventureId && a.status === 'active');
  if (!adventure) { res.status(404).json({ error: 'Active adventure not found' }); return; }
  if (!adventure.allowCoop) { res.status(403).json({ error: 'Co-op not enabled for this adventure' }); return; }
  const participantIds = serialisedAdventureParticipantIds(adventure);
  if (!participantIds.includes(session.id) && participantIds.length >= MAX_WORLD_QUEST_PLAYERS) {
    res.status(409).json({ error: `Adventure already has ${MAX_WORLD_QUEST_PLAYERS} players` });
    return;
  }
  if (!adventure.participantSessionIds) adventure.participantSessionIds = [];
  if (!adventure.participantSessionIds.includes(session.id)) adventure.participantSessionIds.push(session.id);
  adventure.allowCoop = true;
  const partnerSession = serialisedAdventurePartnerSession(adventure, session.id);
  if (partnerSession) {
    setSessionLocation(session, partnerSession.currentLocationId);
  }
  for (const participantId of serialisedAdventureParticipantIds(adventure)) {
    setSerialisedAdventureCoopMode(adventure, participantId, 'join');
  }
  session.activeSerializedAdventure = adventure;
  bindSerialisedAdventureParticipantSessions(adventure, world, true);
  appendFeedEvents(session, [{ ty: 'quest', x: `Joined Serialized Adventure: ${adventure.title}` }]);
  saveWorld(world);
  bumpWorldsListCache();
  persistSessionState(session);
  if (partnerSession) {
    pushCoopEvent(partnerSession.id, {
      type: 'coop_player_joined',
      guestSessionId: session.id,
      guestName: session.playerName,
    });
    pushCoopEvent(partnerSession.id, {
      type: 'coop_mode_change',
      sessionId: session.id,
      mode: 'join',
      locationId: session.currentLocationId,
    });
  }
  res.json({ adventure, session });
});

app.post('/api/sessions/:id/serialized-adventures/:adventureId/request-join', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const adventure = (world.serializedAdventures ?? []).find(a => a.id === req.params.adventureId && a.status === 'active');
  if (!adventure) { res.status(404).json({ error: 'Active adventure not found' }); return; }
  const participantIds = serialisedAdventureParticipantIds(adventure);
  if (participantIds.includes(session.id)) {
    session.activeSerializedAdventure = adventure;
    persistSessionState(session);
    res.json({ status: 'accepted', adventure, session });
    return;
  }
  if (participantIds.length >= MAX_WORLD_QUEST_PLAYERS) {
    res.status(409).json({ error: `Adventure already has ${MAX_WORLD_QUEST_PLAYERS} players` });
    return;
  }
  const pending = cleanSerialisedAdventureJoinRequests(adventure);
  let request = pending.find(item => item.sessionId === session.id);
  if (!request) {
    request = {
      id: randomUUID(),
      sessionId: session.id,
      playerName: session.playerName,
      requestedAt: new Date().toISOString(),
      status: 'pending',
    };
    adventure.pendingJoinRequests = [...(adventure.pendingJoinRequests ?? []), request];
  }
  saveWorld(world);
  bumpWorldsListCache();
  for (const participant of bindSerialisedAdventureParticipantSessions(adventure, world, true)) {
    pushCoopEvent(participant.id, {
      type: 'serialized_adventure_join_request',
      adventureId: adventure.id,
      requestId: request.id,
      sessionId: session.id,
      playerName: session.playerName,
    });
  }
  res.json({ status: 'pending', request, adventureId: adventure.id });
});

app.get('/api/sessions/:id/serialized-adventures/:adventureId/join-requests/:requestId', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const adventure = (world.serializedAdventures ?? []).find(a => a.id === req.params.adventureId);
  if (!adventure) { res.status(404).json({ error: 'Adventure not found' }); return; }
  const request = (adventure.pendingJoinRequests ?? []).find(item => item.id === req.params.requestId);
  const participant = serialisedAdventureParticipantIds(adventure).includes(session.id);
  if (!request && participant) { res.json({ status: 'accepted', adventure, session }); return; }
  if (!request || request.sessionId !== session.id) { res.status(404).json({ error: 'Join request not found' }); return; }
  res.json({ status: request.status, request, adventure: request.status === 'accepted' ? adventure : undefined, session: request.status === 'accepted' ? session : undefined });
});

app.post('/api/sessions/:id/serialized-adventures/:adventureId/join-requests/:requestId/respond', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const adventure = (world.serializedAdventures ?? []).find(a => a.id === req.params.adventureId && a.status === 'active');
  if (!adventure) { res.status(404).json({ error: 'Active adventure not found' }); return; }
  if (!serialisedAdventureParticipantIds(adventure).includes(session.id)) {
    res.status(403).json({ error: 'Only current adventure players can answer join requests' });
    return;
  }
  const request = (adventure.pendingJoinRequests ?? []).find(item => item.id === req.params.requestId);
  if (!request || request.status !== 'pending') { res.status(404).json({ error: 'Pending join request not found' }); return; }
  const targetSession = sessions.get(request.sessionId);
  if (!targetSession || targetSession.worldId !== world.id) { res.status(404).json({ error: 'Requesting player session not found' }); return; }
  const accept = req.body?.accept === true;
  if (accept) {
    const participantIds = serialisedAdventureParticipantIds(adventure);
    if (!participantIds.includes(targetSession.id) && participantIds.length >= MAX_WORLD_QUEST_PLAYERS) {
      res.status(409).json({ error: `Adventure already has ${MAX_WORLD_QUEST_PLAYERS} players` });
      return;
    }
    request.status = 'accepted';
    request.respondedAt = new Date().toISOString();
    request.responderSessionId = session.id;
    adventure.allowCoop = true;
    adventure.participantSessionIds = Array.from(new Set([...(adventure.participantSessionIds ?? []), targetSession.id]));
    setSessionLocation(targetSession, session.currentLocationId);
    for (const participantId of serialisedAdventureParticipantIds(adventure)) {
      setSerialisedAdventureCoopMode(adventure, participantId, 'join');
    }
    targetSession.activeSerializedAdventure = adventure;
    appendFeedEvents(targetSession, [{ ty: 'quest', x: `Joined Serialized Adventure: ${adventure.title}` }]);
    for (const participant of bindSerialisedAdventureParticipantSessions(adventure, world, true)) {
      if (participant.id !== targetSession.id) {
        pushCoopEvent(participant.id, {
          type: 'coop_player_joined',
          guestSessionId: targetSession.id,
          guestName: targetSession.playerName,
        });
      }
    }
    pushCoopEvent(targetSession.id, {
      type: 'serialized_adventure_join_accepted',
      adventureId: adventure.id,
      sessionId: targetSession.id,
      locationId: targetSession.currentLocationId,
    });
  } else {
    request.status = 'declined';
    request.respondedAt = new Date().toISOString();
    request.responderSessionId = session.id;
    pushCoopEvent(targetSession.id, {
      type: 'serialized_adventure_join_declined',
      adventureId: adventure.id,
      sessionId: targetSession.id,
    });
  }
  saveWorld(world);
  bumpWorldsListCache();
  persistSessionState(targetSession);
  persistSessionState(session);
  res.json({ status: request.status, request, adventure, session: accept ? targetSession : undefined });
});

app.post('/api/sessions/:id/serialized-adventure/follow', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const adventure = activeSerializedAdventureForSessionFromWorld(session, world);
  if (!adventure || adventure.status !== 'active' || !adventure.allowCoop) {
    res.status(409).json({ error: 'Not in a 2P Adventure' });
    return;
  }
  const partnerSession = serialisedAdventurePartnerSession(adventure, session.id);
  if (!partnerSession) {
    res.status(409).json({ error: 'No 2P partner is present yet' });
    return;
  }
  const mode = String(req.body?.mode || 'join');
  if (mode !== 'join' && mode !== 'free') { res.status(400).json({ error: 'mode must be "join" or "free"' }); return; }
  setSerialisedAdventureCoopMode(adventure, session.id, mode);
  if (mode === 'join') setSessionLocation(session, partnerSession.currentLocationId);
  saveWorld(world);
  persistSessionState(session);
  pushCoopEvent(partnerSession.id, {
    type: 'coop_mode_change',
    sessionId: session.id,
    mode,
    locationId: session.currentLocationId,
  });
  res.json({ adventure, session, mode, partnerName: partnerSession.playerName, locationId: session.currentLocationId });
});

app.get('/api/sessions/:id/serialized-adventures/status', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  const adventure = session.activeSerializedAdventure;
  if (!adventure) { res.json({ active: false }); return; }
  const activeBeat = getActiveBeat(adventure);
  res.json({
    active: true,
    adventure,
    spectrumScore: adventure.spectrumScore,
    tierLabel: spectrumTierLabel(adventure.spectrumScore),
    currentAct: adventure.acts.find(a => a.status === 'active'),
    activeBeat: activeBeat ? { id: activeBeat.id, title: activeBeat.title, hint: activeBeat.narrativeDescription } : undefined,
    turnCounter: adventure.turnCounter,
    interactionCounter: adventure.interactionCounter,
  });
});

app.post('/api/sessions/:id/serialized-adventures/evaluate', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const adventure = session.activeSerializedAdventure;
  if (!adventure || adventure.status !== 'active') { res.status(409).json({ error: 'No active adventure' }); return; }
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  try {
    const update = await advanceSerializedAdventureHook(session, world, { kind: 'action', locationId: session.currentLocationId, summary: 'Manual evaluation check' }, req.body?.provider, req.body?.model);
    persistSessionState(session);
    if (world.serializedAdventures) {
      saveWorld(world);
      bumpWorldsListCache();
    }
    res.json({ update, adventure: session.activeSerializedAdventure });
  } catch (err) {
    console.warn('[serialized-adventure] evaluate error:', err);
    res.status(500).json({ error: 'Evaluation failed' });
  }
});

app.post('/api/sessions/:id/serialized-adventures/abandon', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const binding = resolveSerialisedAdventureBinding(session, world);
  const abandoned = binding ? abandonSerialisedAdventureRun(binding.session, world) : undefined;
  if (!abandoned) { res.status(409).json({ error: 'No active adventure' }); return; }
  res.json({ abandoned, session: binding?.session ?? session });
});

app.get('/api/sessions/:id/serialized-adventures/results', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  res.json({ results: session.completedSerializedAdventures ?? [], medals: session.serializedAdventureMedals ?? [] });
});

// ── World Images ────────────────────────────────────────────────────────────

app.post('/api/worlds/:id/images', (req, res) => {
  const world = worlds.get(req.params.id);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  if (req.body?.clearCover) {
    const coverPath = join(GENERATED_DIR, world.id, 'cover.jpg');
    try { unlinkSync(coverPath); console.log(`[cover] cleared ${world.id} ${(world as any).concept}`); } catch {}
  }
  (world as any).images = {
    ...((world as any).images ?? {}),
    status: undefined,
    error: undefined,
    ...(req.body?.clearScenes ? { scenes: {} } : {}),
    ...(req.body?.clearPortraits ? { portraits: {}, swimwearPortraits: {} } : {}),
    ...(req.body?.clearCover ? { cover: undefined, coverSource: undefined, coverKind: undefined } : {}),
  };
  queueWorldImageGeneration(world);
  res.status(202).json({ ok: true, status: (world as any).images?.status ?? 'queued' });
});

app.delete('/api/worlds/:id', async (req, res) => {
  const worldId = String(req.params.id);
  const existed = worlds.has(worldId);

  const files = await deleteWorldFiles(worldId);
  if (!existed && !files.worldDeleted) {
    res.status(404).json({ error: 'World not found' });
    return;
  }

  worlds.delete(worldId);
  let sessionsDeleted = 0;
  for (const [id, session] of sessions) {
    if (session.worldId === worldId) {
      sessions.delete(id);
      sessionsDeleted += 1;
    }
  }

  res.json({
    deleted: true,
    worldId,
    sessionsDeleted: Math.max(sessionsDeleted, files.sessionsDeleted),
  });
});

// Rebuild a world's timeline from its source digest's chronological PLOT beats. Lets worlds built
// before digest-driven timelines existed (or any world whose timeline drifted) be upgraded so their
// events faithfully follow the source story start-to-finish. Requires a world built from a source
// document whose whole-story digest was extracted.
app.post('/api/worlds/:id/rebuild-timeline', async (req, res) => {
  const world = worlds.get(String(req.params.id));
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  attachKnownWorldQuestSourceDocuments(world);
  const digest = [...(world.sourceDocuments ?? [])].reverse().find(d => (d.digest ?? '').length > 200)?.digest;
  if (!digest) {
    res.status(400).json({ error: 'No source digest on this world. Timeline rebuild needs a world built from a source document with an extracted whole-story digest.' });
    return;
  }
  const before = (world.timeline ?? []).length;
  const logs: string[] = [];
  try {
    const rebuilt = await rebuildWorldTimelineFromDigest(world, digest, req.body?.provider || (world as any).provider, req.body?.model, (m) => logs.push(m));
    res.json({ ok: rebuilt, worldId: world.id, before, after: (world.timeline ?? []).length, logs });
  } catch (err) {
    res.status(500).json({ error: 'Timeline rebuild failed', detail: String(err), logs });
  }
});

// List sessions for a given world (so the UI can resume the latest one)
app.get('/api/worlds/:worldId/sessions', (req, res) => {
  const world = worlds.get(req.params.worldId);
  const seenGlobalPlayerIds = new Set<string>();
  const joinableWorldQuest = (world?.worldQuestAdventures ?? []).find(q => q.status === 'active');
  const list: any[] = Array.from(sessions.values())
    .filter((s: any) => s.worldId === req.params.worldId)
    .filter((s: any) => !!s.globalPlayerId)
    .sort((a: any, b: any) => String(b.lastActiveAt ?? '').localeCompare(String(a.lastActiveAt ?? '')))
    .filter((s: any) => {
      if (seenGlobalPlayerIds.has(s.globalPlayerId)) return false;
      seenGlobalPlayerIds.add(s.globalPlayerId);
      return true;
    })
    .map((s: any) => {
      const questBlock = globalQuestEntryBlock(s);
      const activeWorldQuest = world ? (s.activeWorldQuest?.status === 'active' ? s.activeWorldQuest : activeWorldQuestForSessionFromWorld(s, world)) : undefined;
      const canJoinWorldQuest = !!joinableWorldQuest && (
        (!!activeWorldQuest && activeWorldQuest.id === joinableWorldQuest.id)
        || (!activeWorldQuest && !s.activeQuest && !questBlock.blocked && worldQuestAllowsCoop(joinableWorldQuest) && worldQuestCanAcceptParticipant(joinableWorldQuest, s))
      );
      return {
        id: s.id,
        type: 'GLOBAL',
        globalPlayerId: s.globalPlayerId,
        playerProfileKey: s.playerProfileKey,
        playerName: s.playerName,
        playerAge: s.playerAge,
        playerGender: s.playerGender,
        playerOccupation: s.playerOccupation,
        playerAppearance: s.playerAppearance,
        currentDate: world?.currentDate ?? s.currentDate,
        currentTime: world?.currentTime ?? s.currentTime,
        dayCount: s.dayCount,
        currentLocationId: s.currentLocationId,
        lastActiveAt: s.lastActiveAt,
        hasActiveQuest: s.activeQuest?.status === 'active' || !!questBlock.quest,
        hasActiveWorldQuest: activeWorldQuest?.status === 'active',
        activeWorldQuestId: activeWorldQuest?.status === 'active' ? activeWorldQuest.id : undefined,
        activeWorldQuestTitle: activeWorldQuest?.status === 'active' ? activeWorldQuest.title : undefined,
        joinableWorldQuestId: canJoinWorldQuest ? joinableWorldQuest.id : undefined,
        joinableWorldQuestTitle: canJoinWorldQuest ? joinableWorldQuest.title : undefined,
        questLocked: questBlock.blocked,
        questLockMessage: questBlock.message,
        activeQuestName: questBlock.quest?.name,
      };
    });
  for (const player of listVisibleGlobalPlayers()) {
    if (seenGlobalPlayerIds.has(player.id)) continue;
    const canJoinActiveWorldQuest = !!joinableWorldQuest
      && worldQuestAllowsCoop(joinableWorldQuest)
      && player.activeQuest?.status !== 'active'
      && !worldQuestParticipantKeys(joinableWorldQuest).has(player.id)
      && worldQuestParticipantKeys(joinableWorldQuest).size < MAX_WORLD_QUEST_PLAYERS;
    list.push({
      id: `global:${player.id}`,
      type: 'GLOBAL',
      globalPlayerId: player.id,
      playerProfileKey: undefined,
      playerName: player.playerName,
      playerAge: player.playerAge,
      playerGender: player.playerGender,
      playerOccupation: player.playerOccupation,
      playerAppearance: player.playerAppearance,
      currentDate: world?.currentDate,
      currentTime: world?.currentTime,
      dayCount: undefined,
      currentLocationId: undefined,
      lastActiveAt: player.lastActiveAt,
      hasActiveQuest: player.activeQuest?.status === 'active',
      hasActiveWorldQuest: false,
      joinableWorldQuestId: canJoinActiveWorldQuest ? joinableWorldQuest.id : undefined,
      joinableWorldQuestTitle: canJoinActiveWorldQuest ? joinableWorldQuest.title : undefined,
      questLocked: player.activeQuest?.status === 'active',
      questLockMessage: player.activeQuest?.status === 'active' ? 'Finish, leave, or abandon your active quest before entering another world.' : undefined,
      activeQuestName: player.activeQuest?.name,
      needsSession: true,
    });
  }
  res.json({ sessions: list });
});

app.delete('/api/sessions/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);
  const deletedFile = deleteSessionFile(sessionId);

  if (!session && !deletedFile) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  if (session) sessions.delete(sessionId);

  res.json({ deleted: true, sessionId, worldId: session?.worldId ?? null });
});

app.get('/api/worlds/:worldId/characters', (req, res) => {
  const world = worlds.get(req.params.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }

  res.json({ characters: listWorldPlayerPresences(world) });
});

// ── Create Session (enter a world) ──────────────────────────────────────────

app.post('/api/worlds/:worldId/sessions', (req, res) => {
  const world = worlds.get(req.params.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  ensureWorldClock(world);

  const requestedGlobalPlayerId = typeof req.body.globalPlayerId === 'string' ? req.body.globalPlayerId : '';
  const requestedGlobalPlayer = requestedGlobalPlayerId ? globalPlayers.get(requestedGlobalPlayerId) : undefined;
  if (!requestedGlobalPlayerId) {
    res.status(400).json({ error: 'globalPlayerId is required' });
    return;
  }
  if (!requestedGlobalPlayer) {
    res.status(404).json({ error: 'Global player not found' });
    return;
  }
  if (!verifyGlobalPlayerPin(requestedGlobalPlayer, req.body.pin, pinContext(req, res))) {
    res.status(403).json({ error: 'Character pin is incorrect' });
    return;
  }
  if (requestedGlobalPlayer.activeQuest?.status === 'active') {
    res.status(409).json({
      error: 'Finish, leave, or abandon your active quest before entering another world.',
      quest: requestedGlobalPlayer.activeQuest,
    });
    return;
  }
  const allowQuestEntry = req.body.allowQuestEntry === true;
  const existingSession = (allowQuestEntry ? activeWorldQuestSessionForPlayer(world, requestedGlobalPlayer.id) : undefined) ?? Array.from(sessions.values())
    .filter(s => s.worldId === world.id && s.globalPlayerId === requestedGlobalPlayer.id)
    .filter(s => allowQuestEntry || !(s.activeWorldQuest?.status === 'active' || activeWorldQuestForSessionFromWorld(s, world)?.status === 'active'))
    .sort((a, b) => String(b.lastActiveAt ?? '').localeCompare(String(a.lastActiveAt ?? '')))[0];
  if (existingSession) {
    copyGlobalProgressToSession(existingSession, requestedGlobalPlayer);
    ensureVisiblePlayerStart(existingSession);
    persistSessionState(existingSession);
    res.json({ session: existingSession, resumed: true });
    return;
  }
  const playerName = String(req.body.playerName || requestedGlobalPlayer?.playerName || '').trim().slice(0, 100);
  if (!playerName) { res.status(400).json({ error: 'global player is missing a playerName' }); return; }
  const playerAge = Math.max(1, Math.min(200, Math.floor(Number(req.body.playerAge) || 25)));
  const playerGender = String(req.body.playerGender || 'unknown').slice(0, 50);
  const playerOccupation = String(req.body.playerOccupation || '').slice(0, 200);
  const playerBackstory = String(req.body.playerBackstory || '').slice(0, 1000);

  const startLocation = world.locations[0];
  const resources = deriveResourceProfile(world);
  const trimmedPlayerName = playerName;
  const resolvedPlayerAge = playerAge;
  const resolvedPlayerGender = playerGender || 'unspecified';
  const resolvedPlayerOccupation = playerOccupation || world.economy.jobs[0]?.title || 'newcomer';
  const resolvedPlayerBackstory = playerBackstory || 'You have just arrived.';
  const globalPlayer = requestedGlobalPlayer;
  const profileKey = buildPlayerProfileKey({
    playerName: globalPlayer?.playerName ?? trimmedPlayerName,
    playerAge: globalPlayer?.playerAge ?? resolvedPlayerAge,
    playerGender: globalPlayer?.playerGender ?? resolvedPlayerGender,
    playerOccupation: globalPlayer?.playerOccupation ?? resolvedPlayerOccupation,
    playerBackstory: globalPlayer?.playerBackstory ?? resolvedPlayerBackstory,
  });
  const savedProfile = world.playerProfiles?.[profileKey];
  const npcStates = buildSessionNpcStates(world, startLocation.id, savedProfile);
  const defaultMoney = resources.scarcityLevel === 'abundant' ? world.economy.averageDailyWage * 30
    : resources.scarcityLevel === 'comfortable' ? world.economy.averageDailyWage * 14
    : resources.scarcityLevel === 'modest' ? world.economy.averageDailyWage * 7
    : resources.scarcityLevel === 'tight' ? world.economy.averageDailyWage * 3
    : world.economy.averageDailyWage;
  const savedLocationId = savedProfile?.currentLocationId;
  const hasSavedLocation = !!savedLocationId && world.locations.some(location => location.id === savedLocationId);

  const session: WorldSession = {
    id: randomUUID(),
    worldId: world.id,
    globalPlayerId: globalPlayer?.id,
    playerProfileKey: profileKey,
    lastActiveAt: new Date().toISOString(),
    playerName: globalPlayer?.playerName ?? trimmedPlayerName,
    playerAge: globalPlayer?.playerAge ?? resolvedPlayerAge,
    playerGender: globalPlayer?.playerGender ?? resolvedPlayerGender,
    playerOccupation: globalPlayer?.playerOccupation || resolvedPlayerOccupation,
    playerBackstory: globalPlayer?.playerBackstory || resolvedPlayerBackstory,
    playerAppearance: visiblePlayerAppearance(globalPlayer?.playerAppearance ?? savedProfile?.playerAppearance),
    photoUrl: globalPlayer?.photoUrl ?? savedProfile?.photoUrl ?? (String(req.body?.photoUrl ?? '').trim().slice(0, 500) || undefined),
    imageUrl: globalPlayer?.imageUrl ?? savedProfile?.imageUrl ?? (String(req.body?.imageUrl ?? '').trim().slice(0, 500) || undefined),
    avatarUrl: globalPlayer?.avatarUrl ?? savedProfile?.avatarUrl ?? (String(req.body?.avatarUrl ?? '').trim().slice(0, 500) || undefined),
    portraitUrl: globalPlayer?.portraitUrl ?? savedProfile?.portraitUrl ?? (String(req.body?.portraitUrl ?? '').trim().slice(0, 500) || undefined),
    playerDepartureStyle: visiblePlayerDepartureStyle(globalPlayer?.playerDepartureStyle ?? savedProfile?.playerDepartureStyle),
    strangePossessions: cloneData(globalPlayer?.strangePossessions ?? savedProfile?.strangePossessions ?? []),
    impossibleGiftsGiven: cloneData(savedProfile?.impossibleGiftsGiven ?? []),
    activeGodEffects: cloneData(savedProfile?.activeGodEffects ?? []),
    currentDate: world.currentDate!,
    currentTime: world.currentTime!,
    currentMinute: world.currentMinute ?? 0,
    clockStartedAt: world.clockStartedAt,
    lastClockSyncAt: world.lastClockSyncAt,
    currentLocationId: hasSavedLocation ? savedLocationId! : startLocation.id,
    currentWeather: cloneData(world.currentWeather),
    money: savedProfile?.money ?? defaultMoney,
    isAlive: savedProfile?.isAlive ?? true,
    socialClass: savedProfile?.socialClass ?? 'newcomer',
    reputation: savedProfile?.reputation ?? 'unknown',
    npcStates,
    visitedLocations: cloneData(savedProfile?.visitedLocations ?? [startLocation.id]),
    dayCount: savedProfile?.dayCount ?? 1,
    significantEvents: cloneData(savedProfile?.significantEvents ?? []),
    objectiveEvents: cloneData(savedProfile?.objectiveEvents ?? []),
    questHooks: [],
    questEchoes: [],
    communityMood: 'neutral',
    activeGossip: [],
    contagionEvents: [],
    recentCommunityEvents: [],
    feedEvents: [],
    playerVisitLog: cloneData(savedProfile?.playerVisitLog ?? []),
    questInvites: [],
    medals: cloneData(globalPlayer?.medals ?? []),
    achievements: cloneData(globalPlayer?.achievements ?? []),
    questFacts: cloneData(globalPlayer?.questFacts ?? []),
  };
  ensureCognitionState(session);
  ensureVisiblePlayerStart(session);
  ensureSessionWeather(session, world);

  sessions.set(session.id, session);

  if (!savedProfile) {
    const locationCounts: Record<string, number> = {};
    for (const state of Object.values(npcStates)) {
      locationCounts[state.currentLocationId] = (locationCounts[state.currentLocationId] ?? 0) + 1;
    }
    const bestStart = Object.entries(locationCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? startLocation.id;
    session.currentLocationId = bestStart;
    session.visitedLocations = [bestStart];
  }

  persistSessionState(session);
  res.json({ session });
});

// ── Talk to NPC ─────────────────────────────────────────────────────────────

app.post('/api/sessions/:id/talk', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const baseWorld = worlds.get(session.worldId);
  if (!baseWorld) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, baseWorld);
  activeWorldQuestForSessionFromWorld(session, baseWorld);
  activeSerializedAdventureForSessionFromWorld(session, baseWorld);
  const view = sessionRuntimeView(session, baseWorld);
  const world = view.world;
  const currentLocationId = view.locationId;

  const voiceMode = req.body.voice === true;
  const voiceConfig = getVoiceConfig();
  const dialogueProvider = voiceMode && voiceConfig.available
    ? voiceConfig.provider
    : (req.body.provider ?? world.provider);
  const dialogueModel = voiceMode && voiceConfig.available
    ? voiceConfig.model
    : req.body.model;
  const provider = dialogueProvider;
  const model = dialogueModel;

  const parsedInteraction = parsePlayerInteractionRequest(req.body);
  if (!parsedInteraction.interaction) {
    res.status(400).json({ error: parsedInteraction.error ?? 'npcId and message required' });
    return;
  }
  const interaction = parsedInteraction.interaction;
  const { npcId } = interaction;
  const message = interaction.expression;
  const interactionKind = interaction.kind;
  const interactionText = interactionKind === 'speech'
    ? message
    : interactionKind === 'gesture'
      ? `[gesture] ${message}`
      : interactionKind === 'silence'
        ? `[silence] ${message || 'stands nearby in silence'}`
        : interactionKind === 'presence'
          ? `[presence] ${message || 'is simply present, watching'}`
          : `[action] ${message}`;

  const npc = world.npcs.find(n => n.id === npcId);
  if (!npc) { res.status(404).json({ error: 'NPC not found' }); return; }

  const initialNpcState = session.npcStates[npcId];
  if (!initialNpcState) { res.status(404).json({ error: 'NPC state not found' }); return; }
  // Re-bound inside the NPC lock: a concurrent request's world→session sync can replace
  // session.npcStates[npcId] while the dialogue LLM call is in flight.
  let npcState = initialNpcState;
  ensureCognitionState(session);

  const backendAllowsIntentInterpretation = ALLOW_PLAYER_INTENT_INTERPRETATION;
  const clientRequestedIntentInterpretation = req.body.enablePlayerIntentInterpretation === true;
  const intentInterpretationEnabled = shouldApplyPlayerIntentInterpretation(
    backendAllowsIntentInterpretation,
    clientRequestedIntentInterpretation,
  );
  const interpretation = intentInterpretationEnabled
    ? interpretPlayerInteraction(interaction, npc, npcState)
    : undefined;

  const timeOfDay = resolveTimeOfDay(world, session.currentTime);
  ensureCognitionState(session);
  ensureSessionWeather(session, baseWorld);
  const othersPresent = world.npcs
    .filter(n => n.id !== npcId && session.npcStates[n.id]?.currentLocationId === currentLocationId)
    .map(n => n.name);

  // Include active co-present players in the conversation context
  const coPlayers: string[] = [];
  if (view.inQuest && session.activeQuest) {
    for (const presence of listQuestPlayerPresences(session.activeQuest, session, world)) {
      if (presence.isCurrentSession || !presence.canCommunicate) continue;
      coPlayers.push(presence.playerName);
    }
  } else {
    for (const [sid, otherSession] of sessions) {
      if (sid === session.id) continue;
      if (otherSession.worldId !== session.worldId) continue;
      if (otherSession.currentLocationId !== currentLocationId) continue;
      if (!isCharacterSessionActive(otherSession)) continue;
      coPlayers.push(otherSession.playerName);
    }
  }
  // Also include players connected via WebSocket to this NPC's chat room
  const wsRoom = chatRooms.get(chatRoomKey(session.worldId, npcId));
  if (wsRoom) {
    for (const client of wsRoom) {
      if (client.sessionId === session.id) continue;
      if (client.worldId !== session.worldId) continue;
      const clientSession = sessions.get(client.sessionId);
      if (!clientSession || !isCharacterSessionActive(clientSession)) continue;
      if (!coPlayers.includes(client.playerName)) coPlayers.push(client.playerName);
    }
  }
  if (coPlayers.length) othersPresent.push(...coPlayers.map(n => `${n} (player)`));

  // Pull recent shared conversation exchanges into context
  // Wider window when multiple players are in the room (live group chat)
  const roomHasOthers = !!wsRoom && Array.from(wsRoom).some(client => {
    const clientSession = sessions.get(client.sessionId);
    return client.sessionId !== session.id &&
      client.worldId === session.worldId &&
      !!clientSession &&
      isCharacterSessionActive(clientSession);
  });
  const convWindowMs = roomHasOthers ? 600_000 : 120_000;
  const sharedConv = world.npcSharedStates?.[npcId]?.activeConversation ?? [];
  const recentExchanges = sharedConv
    .filter(e => roomHasOthers && e.sessionId !== session.id && Date.now() - Date.parse(e.timestamp) < convWindowMs)
    .slice(-10);
  const recentConvContext = recentExchanges.length
    ? recentExchanges.map(e => `${e.playerName}: ${e.message}\n${npc.name}: ${e.reply}`).join('\n')
    : '';

  // Pull THIS player's last few turns with this NPC — critical for continuity-of-attention.
  // Without this, the NPC reconstructs every turn from compressed memory and treats each
  // exchange as nearly-independent, which feels like "the NPC isn't really listening."
  const ownExchanges = sharedConv
    .filter(e => e.sessionId === session.id)
    .slice(-8);
  const currentSessionHistory = ownExchanges.length
    ? ownExchanges.map(e => `${e.playerName}: ${e.message}\n${npc.name}: ${e.reply}`).join('\n')
    : '';
  const pendingImpossibleGift = detectImpossibleGift(message, interactionKind);
  const pendingGiftGate = pendingImpossibleGift ? activeImpossibleGiftObjective(session, npcId) : null;
  let pendingGiftJudgement: GiftJudgement | null = null;
  if (pendingImpossibleGift && pendingGiftGate) {
    const attempts = (pendingGiftGate.objective.triedImpossibleGifts?.length ?? 0) + 1;
    pendingGiftJudgement = await judgeImpossibleGift({
      gift: pendingImpossibleGift,
      requirement: pendingGiftGate.requirement,
      world,
      npc,
      questName: pendingGiftGate.quest.name,
      attempts,
      provider,
      model,
    });
  }
  const giftDialogueContext = pendingImpossibleGift && pendingGiftJudgement
    ? `\n\nImpossible gift judgement: ${pendingGiftJudgement.accepted ? 'accepted' : 'rejected'}. NPC should react to this result. Feedback: ${pendingGiftJudgement.hint}`
    : '';

  try {
    const result = await generateDialogue({
      world,
      npc,
      npcState,
      playerName: session.playerName,
      playerMessage: `${message}${giftDialogueContext}`,
      interactionKind,
      playerPresentation: session.playerAppearance,
      playerStrangePossessions: session.strangePossessions ?? [],
      weather: describeWeather(session.currentWeather, baseWorld),
      currentLocationId,
      currentDate: session.currentDate,
      timeOfDay,
      provider,
      model,
      othersPresent,
      recentConversation: recentConvContext || undefined,
      currentSessionHistory: currentSessionHistory || undefined,
      questContext: [describeQuestForDialogue(session, npcId), describeActiveWorldQuestForDialogue(session, npcId, currentLocationId), describeWorldQuestSeedsForDialogue(world, npcId, currentLocationId)].filter(Boolean).join('\n'),
    });

    // Update NPC state — wrapped in a per-NPC lock so concurrent /talk calls
    // to the same NPC serialise all state mutations + PEP processing.
    const { prevRelationship, prevNpcSnapshot, objectiveEvent, memory, bystanderNpcs, impossibleGift, impossibleGiftEvent, impossibleGiftAccepted, impossibleGiftHint, playerTrouble, cognition, promiseDetected } = await withNpcLock(npcId, async () => {
    npcState = session.npcStates[npcId] ?? npcState;
    const prevRelationship = npcState.relationship;
    const prevNpcSnapshot = {
      relationship: npcState.relationship,
      trustLevel: npcState.trustLevel,
      warmth: npcState.warmth,
      fear: npcState.fear,
      totalInteractions: npcState.totalInteractions,
    };
    npcState.mood = result.moodAfter;
    npcState.relationship = result.newRelationship as any;
    npcState.trustLevel = clamp(npcState.trustLevel + result.trustDelta, 0, 100);
    npcState.warmth = clamp(npcState.warmth + result.warmthDelta, 0, 100);
    npcState.familiarity = clamp(npcState.familiarity + 2, 0, 100);
    npcState.totalInteractions += 1;
    npcState.lastInteractionDate = session.currentDate;
    npcState.daysSinceLastSeen = 0;
    npcState.playerOpinion = result.npcThought;

    const objectiveEvent = recordObjectiveEvent(session, {
      type: 'player_interaction',
      date: session.currentDate,
      timeOfDay,
      locationId: currentLocationId,
      actorId: 'player',
      targetIds: [npcId],
      summary: `${session.playerName} ${interactionKind === 'speech' ? 'said' : interactionKind === 'gesture' ? 'gestured' : 'did'}: ${message.slice(0, 220)}`,
      detail: `${session.playerName}: ${interactionText}\n${npc.name}: ${result.reply}`,
      tags: ['player', interactionKind, result.moodAfter, result.newRelationship].filter(Boolean),
      declaredIntent: interaction.declaredIntent,
      expression: interaction.expression,
      kind: interaction.kind,
      perceivedIntent: interpretation?.perceivedIntent,
      interpretationConfidence: interpretation?.confidence,
      interpretationDistortion: interpretation?.distortion,
      interpretationSummary: interpretation?.interpretationSummary,
      emotionalImpact: interpretation?.emotionalImpact,
    });

    // Store memory
    const memory = buildMemory(
      npcId, world.id, result, message,
      interactionKind,
      currentLocationId, session.currentDate, timeOfDay, othersPresent,
    );
    memory.declaredIntent = interaction.declaredIntent;
    memory.expression = interaction.expression;
    memory.kind = interaction.kind;
    if (interpretation) {
      memory.perceivedIntent = interpretation.perceivedIntent;
      memory.interpretationConfidence = interpretation.confidence;
      memory.interpretationDistortion = interpretation.distortion;
      memory.interpretationSummary = interpretation.interpretationSummary;
      memory.emotionalImpact = interpretation.emotionalImpact;
      npcState.innerLife.affect = blendAffect(npcState.innerLife.affect, interpretation.emotionalImpact as any, 0.25);
    }
    attachMemoryToObjectiveEvent(memory, objectiveEvent);
    npcState.conversationHistory = npcState.conversationHistory ?? [];
    npcState.conversationHistory.push(cloneData(memory));
    if (npcState.conversationHistory.length > 50) npcState.conversationHistory = npcState.conversationHistory.slice(-50);
    npcState.memories.push(memory);
    if (npcState.memories.length > 20) npcState.memories = npcState.memories.slice(-20);

    // Create witness memories for bystander NPCs
    const bystanderNpcs = world.npcs.filter(n =>
      n.id !== npcId &&
      session.npcStates[n.id]?.currentLocationId === currentLocationId
    );
    for (const bystander of bystanderNpcs) {
      createWitnessMemory(
        session,
        bystander.id,
        session.playerName,
        npc.name,
        `${session.playerName} ${interactionKind === 'speech' ? 'spoke with' : interactionKind === 'gesture' ? 'gestured at' : interactionKind === 'silence' ? 'stood silently near' : interactionKind === 'presence' ? 'lingered near' : 'interacted with'} ${npc.name}. ${result.memorySummary}`,
        currentLocationId,
        session.currentDate,
        timeOfDay,
        objectiveEvent.id,
        // actorNpcId omitted: actor is the player (no NPC id).
        undefined,
        // targetNpcId: the NPC the player is interacting with.
        npc.id,
      );
    }

    // Gossip propagation
    if (result.gossip) {
      session.activeGossip.push({
        fromNpcId: npcId,
        content: result.gossip,
        date: session.currentDate,
        sentiment: result.warmthDelta > 0 ? 'positive' : result.warmthDelta < 0 ? 'negative' : 'neutral',
        isTrue: true,
      });
    }

    const impossibleGift = pendingImpossibleGift;
    let impossibleGiftEvent: string | null = null;
    let impossibleGiftAccepted = false;
    let impossibleGiftHint = '';
    if (impossibleGift) {
      const giftGate = activeImpossibleGiftObjective(session, npcId);
      let judgement: GiftJudgement = { accepted: true, hint: `${npc.name} accepts the impossible gift.`, reason: 'non-gated impossible gift' };
      if (giftGate) {
        const attempts = (giftGate.objective.triedImpossibleGifts?.length ?? 0) + 1;
        judgement = pendingGiftJudgement ?? await judgeImpossibleGift({
          gift: impossibleGift,
          requirement: giftGate.requirement,
          world,
          npc,
          questName: giftGate.quest.name,
          attempts,
          provider,
          model,
        });
        const normalReveal = (giftGate.quest.difficulty ?? 'normal') === 'normal' && attempts >= 3;
        const hardReveal = giftGate.quest.difficulty === 'hard' && attempts >= 5;
        const exactHint = giftGate.requirement.hintText ?? giftGate.requirement.requestText ?? giftGate.requirement.giftPattern;
        if (!judgement.accepted && exactHint && (normalReveal || hardReveal)) {
          judgement.hint = `The gift needs to answer this: ${exactHint}.`;
          giftGate.objective.clueRevealedTarget = true;
        }
        giftGate.objective.triedImpossibleGifts = [...(giftGate.objective.triedImpossibleGifts ?? []), {
          gift: impossibleGift,
          accepted: judgement.accepted,
          hint: judgement.hint,
          judgedAt: new Date().toISOString(),
        }].slice(-8);
        giftGate.objective.lastGiftFeedback = judgement.hint;
        giftGate.objective.lastGiftAccepted = judgement.accepted;
        if (judgement.accepted) {
          const fact: QuestFact = {
            id: `fact:gift:${giftGate.quest.id}:${npcId}:${String(impossibleGift).replace(/\s+/g, ' ').trim().toLowerCase()}`,
            kind: 'discovery',
            worldId: world.id,
            npcId,
            summary: `${npc.name} accepted the impossible gift: ${impossibleGift}.`,
            createdAtTurn: giftGate.quest.turnCounter,
            createdAt: new Date().toISOString(),
          };
          giftGate.quest.questFacts = mergeById(giftGate.quest.questFacts, [fact]);
          if (session.globalPlayerId) session.questFacts = mergeById(session.questFacts, [fact]);
        }
      }
      impossibleGiftAccepted = judgement.accepted;
      impossibleGiftHint = judgement.hint;
      impossibleGiftEvent = `${session.playerName} offered ${npc.name} an impossible gift: ${impossibleGift}. ${judgement.hint}`;
      session.significantEvents.push(impossibleGiftEvent);
      if (session.significantEvents.length > 20) session.significantEvents = session.significantEvents.slice(-20);
      if (session.reputation === 'unknown') session.reputation = 'strange';
      if (impossibleGiftAccepted) {
        session.impossibleGiftsGiven = session.impossibleGiftsGiven ?? [];
        session.impossibleGiftsGiven.push({ npcId, gift: impossibleGift, date: session.currentDate });
        const giftKey = String(impossibleGift).replace(/\s+/g, ' ').trim().toLowerCase();
        session.strangePossessions = (session.strangePossessions ?? []).filter(item => String(item).replace(/\s+/g, ' ').trim().toLowerCase() !== giftKey);
      }
      npcState.impossibleGiftsReceived = npcState.impossibleGiftsReceived ?? [];
      npcState.impossibleGiftsReceived.push({ gift: impossibleGift, date: session.currentDate, accepted: impossibleGiftAccepted, hint: impossibleGiftHint });
      if (npcState.impossibleGiftsReceived.length > 20) npcState.impossibleGiftsReceived = npcState.impossibleGiftsReceived.slice(-20);
    }

    const playerTrouble = applyPlayerTroublemaking({
      world,
      session,
      sourceNpc: npc,
      sourceState: npcState,
      message,
      interactionKind,
      timeOfDay,
      bystanderNpcs,
      locationId: currentLocationId,
      objectiveEventId: objectiveEvent.id,
    });

    // Promise tracking
    const promiseDetected = detectPromise(message) ?? (intentInterpretationEnabled && interaction.declaredIntent === 'make_promise' ? message : null);
    if (interactionKind === 'speech' && promiseDetected) {
      npcState.promises = npcState.promises ?? [];
      npcState.promises.push({
        id: randomUUID(),
        madeByPlayer: true,
        description: promiseDetected,
        madeOnDate: session.currentDate,
        status: 'pending',
        importanceToNPC: clamp((npcState.trustLevel > 50 ? 60 : 30) + (interpretation ? Math.round(interpretation.promiseRisk * 20) : 0), 0, 100),
      });
    }

    // Pattern detection
    npcState.patternsNoticed = detectPatterns(npcState);

    // Track player visit for behavioral profiling
    session.playerVisitLog = session.playerVisitLog ?? [];
    session.playerVisitLog.push({
      locationId: currentLocationId,
      npcId: npcId,
      date: session.currentDate,
      timeOfDay,
      interactionCount: 1,
    });
    if (session.playerVisitLog.length > 200) session.playerVisitLog = session.playerVisitLog.slice(-200);

    // Update NPC visit frequency
    npcState.playerVisitFrequency = (npcState.playerVisitFrequency ?? 0) + 1;

    // Update avoidance scores for NPCs at this location that the player DIDN'T talk to
    for (const otherNpc of bystanderNpcs) {
      const otherState = session.npcStates[otherNpc.id];
      if (otherState && otherState.totalInteractions > 0) {
        // Player is here but chose to talk to someone else
        otherState.playerAvoidanceScore = Math.min(100, (otherState.playerAvoidanceScore ?? 0) + 3);
      }
    }
    // Decrease avoidance for the NPC they DID talk to
    npcState.playerAvoidanceScore = Math.max(0, (npcState.playerAvoidanceScore ?? 0) - 10);

    let cognition: any = {
      objectiveEvent,
      memoryId: memory.id,
      intentInterpretationEnabled,
    };

    // Post-event processing — awaited inline AND serialised per-NPC so the
    // cognition delta lands in this response, and concurrent /talk calls to
    // the same NPC can't clobber each other's affect / theory / rumination.
    const pepMemorySummary = interpretation
      ? `${memory.summary} ${interpretation.interpretationSummary}`
      : memory.summary;
    try {
      const pepResult = await runPostEventProcessing(
          npc, npcState.innerLife, pepMemorySummary, interactionText, result.reply,
          result.moodAfter, result.trustDelta, world, provider, model,
      );
      if (pepResult) {
        cognition = {
          ...cognition,
          pepCompleted: true,
          ...applyPostEventCognition(session, npc, npcState, memory, objectiveEvent, pepResult, timeOfDay),
        };
      }
    } catch (err) {
      console.error('[pep]', err);
      cognition.pepError = String(err).slice(0, 200);
    }

    // Append to shared conversation log so other players see this exchange
    npcState.activeConversation = npcState.activeConversation ?? [];
    npcState.activeConversation.push({
      playerName: session.playerName,
      sessionId: session.id,
      message: interactionText,
      reply: result.reply,
      kind: interactionKind,
      timestamp: new Date().toISOString(),
    });
    if (npcState.activeConversation.length > 30) npcState.activeConversation = npcState.activeConversation.slice(-30);

    return { prevRelationship, prevNpcSnapshot, objectiveEvent, memory, bystanderNpcs, impossibleGift, impossibleGiftEvent, impossibleGiftAccepted, impossibleGiftHint, playerTrouble, cognition, promiseDetected };
    }); // end withNpcLock

    // Generate moment image for significant effects
    const isSignificantMoment = Math.abs(result.trustDelta) >= 5 ||
      Math.abs(result.warmthDelta) >= 5 ||
      (result.newRelationship !== prevRelationship) ||
      result.willSeekOut || result.willAvoid || !!impossibleGift;
    let momentImage: { prompt: string; seed: number } | undefined;
    if (isSignificantMoment) {
      const era = world.era?.period ?? '';
      const region = world.geography?.region ?? '';
      const emotion = result.moodAfter || 'intense';
      const momentSeed = stableHash(`${npcId}:${session.id}:${npcState.totalInteractions}:${Date.now()}`) % 999999;
      momentImage = {
        prompt: `cinematic close-up portrait photograph, ${era}, ${region}, ${npc.name} a ${npc.occupation}, expression of ${emotion}, dramatic lighting, emotional moment, photorealistic, no text`,
        seed: momentSeed,
      };
    }

    const consequences = summarizeInteractionConsequences({
      world,
      npc,
      before: prevNpcSnapshot,
      after: npcState,
      result,
      interpretation,
      promiseDetected,
      impossibleGift,
      reputation: session.reputation,
    });
    consequences.push(...playerTrouble.consequences);
    const questUpdate = advanceQuestEpisode(session, {
      kind: 'dialogue',
      npcId,
      locationId: currentLocationId,
      worldId: world.id,
      summary: message,
    });
    handleQuestUpdate(questUpdate);
    const worldQuestUpdate = advanceWorldQuest(session, {
      kind: 'dialogue',
      npcId,
      locationId: currentLocationId,
      worldId: world.id,
      summary: message,
    });
    const serializedAdventureUpdate = await advanceSerializedAdventureHook(session, world, { kind: 'dialogue', npcId, locationId: currentLocationId, summary: message }, provider, model);
    const dramaLeads = deriveSessionLeads(world, session);

    // Broadcast via WebSocket to other players in the same NPC chat room
    broadcastToRoom(session.worldId, npcId, {
      type: 'chat',
      playerName: session.playerName,
      sessionId: session.id,
      message: interactionText,
      reply: result.reply,
      kind: interactionKind,
      npcName: npc.name,
      timestamp: new Date().toISOString(),
      npcState: {
        mood: npcState.mood,
        relationship: npcState.relationship,
        totalInteractions: npcState.totalInteractions,
        innerLife: npcState.innerLife ? {
          lastThought: npcState.innerLife.lastThought,
          affect: npcState.innerLife.affect,
          pepActive: npcState.innerLife.pepActive,
          pepTarget: npcState.innerLife.pepTarget,
          pepCycleCount: npcState.innerLife.pepCycleCount,
          intentions: npcState.innerLife.intentions,
          theoryOfPlayer: npcState.innerLife.theoryOfPlayer,
          defenses: npcState.innerLife.defenses,
        } : null,
        memories: (npcState.memories ?? []).slice(-1).map(m => ({ summary: m.summary, currentReconstruction: m.currentReconstruction })),
      },
      ...(impossibleGift ? { impossibleGift: { gift: impossibleGift, event: impossibleGiftEvent, accepted: impossibleGiftAccepted, hint: impossibleGiftHint, npcId, npcName: npc.name, date: session.currentDate } } : {}),
    }, session.id);

    persistSessionState(session);
    res.json({
      dialogue: result,
      npcState: sanitiseNpcState(npcState),
      session,
      cognition,
      consequences,
      dramaLeads,
      quest: getQuestStatus(session),
      questUpdate,
      worldQuestUpdate,
      serializedAdventureUpdate,
      impossibleGift: impossibleGift ? {
        gift: impossibleGift,
        event: impossibleGiftEvent,
        accepted: impossibleGiftAccepted,
        hint: impossibleGiftHint,
        npcId,
        npcName: npc.name,
        date: session.currentDate,
        timeOfDay,
      } : undefined,
      ...(voiceMode ? {
        voice: {
          profile: deriveVoiceProfile(npc),
          text: extractSpokenTtsText(result.reply),
          voiceId: await selectVoxVoice(deriveVoiceProfile(npc), npc.id || npc.name),
          provider: voiceConfig.provider,
          model: voiceConfig.model,
        },
      } : {}),
    });
  } catch (err) {
    console.error(`[talk:${npcId}]`, err);
    res.status(500).json({ error: 'Dialogue generation failed' });
  }
});

// ── Voice config ──────────────────────────────────────────────────────────

app.get('/api/voice/config', (_req, res) => {
  const config = getVoiceConfig();
  res.json(config);
});

app.get('/api/sessions/:id/npc/:npcId/voice', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const npc = world.npcs.find(n => n.id === req.params.npcId);
  if (!npc) { res.status(404).json({ error: 'NPC not found' }); return; }
  const voiceProfile = deriveVoiceProfile(npc);
  try {
    res.json({
      npcId: npc.id,
      name: npc.name,
      voiceProfile,
      voiceId: await selectVoxVoice(voiceProfile, npc.id || npc.name),
    });
  } catch (err: any) {
    res.status(503).json({ error: 'TTS voice unavailable', detail: String(err?.message ?? err).slice(0, 300) });
  }
});

app.post('/api/tts', async (req, res) => {
  const { text, npcId, sessionId } = req.body;
  if (!text || typeof text !== 'string') { res.status(400).json({ error: 'text required' }); return; }
  const spokenText = extractSpokenTtsText(text);
  if (!spokenText) { res.status(400).json({ error: 'no spoken dialogue found' }); return; }
  if (!ttsAvailable()) { res.json({ audio: null, format: 'browser', text: spokenText, fallback: 'browser' }); return; }

  try {
    let voiceId = await selectVoxVoice(
      { pitch: 1, rate: 1, gender: 'neutral', age: 'middle' },
      npcId || sessionId || 'fallback',
    );
    if (sessionId && npcId) {
      const session = sessions.get(sessionId);
      if (session) {
        const world = worlds.get(session.worldId);
        const npc = world?.npcs.find(n => n.id === npcId);
        if (npc) voiceId = await selectVoxVoice(deriveVoiceProfile(npc), npc.id || npc.name);
      }
    }
    const speech = await synthesizeSpeech(spokenText, voiceId);
    res.json({ audio: speech.audioData, format: speech.format, voiceId: speech.voiceId, text: spokenText });
  } catch (err: any) {
    if (isMistralTtsGuardrailError(err)) {
      console.warn('[tts] provider guardrail blocked speech; using browser fallback');
      res.json({ audio: null, format: 'browser', text: spokenText, fallback: 'browser', detail: 'tts_guardrail' });
      return;
    }
    console.error('[tts]', err);
    res.json({ audio: null, format: 'browser', text: spokenText, fallback: 'browser', detail: String(err?.message ?? err).slice(0, 300) });
  }
});

// ── Player presentation ────────────────────────────────────────────────────

app.post('/api/sessions/:id/player', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, world);

  const { appearance, possession, departureStyle, removeAppearance } = req.body;
  if (removeAppearance && !appearance) {
    console.log('[player] removeAppearance requested but no new appearance provided');
  }
  if (typeof appearance === 'string' && appearance.trim()) {
    session.playerAppearance = appearance.trim().slice(0, 200);
  }
  if (typeof departureStyle === 'string') {
    session.playerDepartureStyle = departureStyle.trim().slice(0, 200);
  }
  if (typeof possession === 'string' && possession.trim()) {
    session.strangePossessions = Array.from(new Set([...(session.strangePossessions ?? []), possession.trim().slice(0, 160)])).slice(-10);
  }
  refreshQuestPortalGates(session);

  persistSessionState(session);
  res.json({ session, quest: getQuestStatus(session) });
});

// ── Quest episodes ──────────────────────────────────────────────────────────

app.get('/api/sessions/:id/quest', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  res.json({ quest: getQuestStatus(session), questInvites: session.questInvites ?? [], session, dramaLeads: deriveSessionLeads(world, session) });
});

app.post('/api/sessions/:id/quest/discover', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, world);

  const hook = maybeCreateQuestHook(world, session, true);
  if (!hook) { res.status(400).json({ error: 'No quest NPC is available in this world' }); return; }
  recordObjectiveEvent(session, {
    type: 'quest',
    date: session.currentDate,
    timeOfDay: resolveTimeOfDay(world, session.currentTime),
    locationId: hook.locationId,
    actorId: hook.npcId,
    targetIds: [hook.npcId],
    summary: `Quest hook discovered: ${hook.title}.`,
    detail: hook.detail,
    tags: ['quest', 'discovery', hook.type, hook.tier],
  });

  persistSessionState(session);
  res.json({
    hook,
    requiredWorlds: questRequiredWorldCount(hook.tier),
    availableWorlds: worlds.size,
    quest: getQuestStatus(session),
    questInvites: session.questInvites ?? [],
    session,
    dramaLeads: deriveSessionLeads(world, session),
  });
});

app.post('/api/sessions/:id/quest/activate', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, world);
  const hookId = typeof req.body?.hookId === 'string' ? req.body.hookId : undefined;
  const activationHook = (session.questHooks ?? []).find(h => h.status === 'available' && (!hookId || h.id === hookId));
  if (session.activeWorldQuest?.status === 'active' || hasActiveSerializedAdventure(session)) {
    res.status(409).json({ error: 'Unavailable' });
    return;
  }
  if (session.globalPlayerId && activationHook?.scope === 'global') {
    const existingActive = activeGlobalQuestRecordsForPlayer(session.globalPlayerId)
      .filter(record => record.quest.id !== session.activeQuest?.id);
    if (existingActive.length >= MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER) {
      enforceGlobalQuestLimit(session.globalPlayerId);
      res.status(409).json({
        error: `Character already has ${MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER} active global quests. Finish, leave, or abandon one before taking another.`,
        activeGlobalQuests: existingActive.slice(0, MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER).map(record => ({ id: record.quest.id, name: record.quest.name, startedAt: record.quest.startedAt })),
      });
      return;
    }
  }

  const result = activateQuestEpisode({
    world,
    session,
    allWorlds: worlds.values(),
    hookId,
    difficulty: ['easy', 'normal', 'hard'].includes(String(req.body?.difficulty ?? ''))
      ? req.body.difficulty
      : undefined,
  });
  if (!result.quest) {
    const hookId = typeof req.body?.hookId === 'string' ? req.body.hookId : undefined;
    const hook = (session.questHooks ?? []).find(h => h.status === 'available' && (!hookId || h.id === hookId));
    const missingRequirements = missingQuestRequirements(session, undefined, hook?.requirements);
    res.status(400).json({ error: result.error ?? 'Quest activation failed', missingRequirements });
    return;
  }
  canonicalQuestFor(result.quest, session);
  if (session.globalPlayerId && result.quest.scope === 'global') {
    enforceGlobalQuestLimit(session.globalPlayerId);
  }
  recordObjectiveEvent(session, {
    type: 'quest',
    date: session.currentDate,
    timeOfDay: resolveTimeOfDay(world, session.currentTime),
    locationId: session.currentLocationId,
    actorId: 'player',
    targetIds: [result.quest.hookNpcId],
    summary: `Quest activated: ${result.quest.name}.`,
    detail: `${result.quest.name} forked ${result.quest.forkedWorldIds.length} world(s). Deadline: ${result.quest.deadlineTurns} turns.`,
    tags: ['quest', 'activation', result.quest.type, result.quest.tier],
  });

  persistSessionState(session);
  res.json({ quest: getQuestStatus(session), activeQuest: result.quest, questInvites: session.questInvites ?? [], session, dramaLeads: deriveSessionLeads(world, session) });
});

app.post('/api/sessions/:id/quest/travel', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, world);
  sessionRuntimeView(session, world);

  const result = travelQuestPortal(session, {
    worldId: typeof req.body?.worldId === 'string' ? req.body.worldId : undefined,
    portalId: typeof req.body?.portalId === 'string' ? req.body.portalId : undefined,
  });
  if (!result.quest || !result.destination) {
    if (result.quest) persistQuestParticipants(result.quest);
    res.status(400).json({ error: result.error ?? 'Quest portal travel failed', blocked: result.blocked, quest: getQuestStatus(session), session });
    return;
  }
  handleQuestUpdate(result.questUpdate);
  const participantLocation = session.activeQuest ? questLocationForSession(session.activeQuest, session) : undefined;
  const questWorld = participantLocation && session.activeQuest?.forkedWorldData?.[participantLocation.worldId]
    ? session.activeQuest.forkedWorldData[participantLocation.worldId]
    : world;
  const questLocationId = participantLocation?.locationId ?? session.currentLocationId;
  recordObjectiveEvent(session, {
    type: 'quest',
    date: session.currentDate,
    timeOfDay: resolveTimeOfDay(questWorld, session.currentTime),
    locationId: questLocationId,
    actorId: 'player',
    targetIds: [],
    summary: `Quest portal opened to ${result.destination.fromWorldName}.`,
    detail: `${result.quest.name}: ${result.destination.locationName} in ${result.destination.fromWorldName}. Base world position remains ${result.quest.baseReturn.locationId}.`,
    tags: ['quest', 'portal', result.destination.fromWorldId],
  });

  persistSessionState(session);
  res.json({
    destination: result.destination,
    quest: getQuestStatus(session),
    activeQuest: session.activeQuest,
    questUpdate: result.questUpdate,
    developments: result.developments ?? [],
    session,
    dramaLeads: deriveSessionLeads(questWorld, session),
  });
});

app.post('/api/sessions/:id/quest/abandon', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, world);

  const questBefore = session.activeQuest;
  const result = abandonQuestEpisode(session);
  if (!result.echo) { res.status(400).json({ error: result.error ?? 'Quest abandon failed' }); return; }
  if (questBefore) clearGlobalActiveQuest(session, questBefore.id);
  if (questBefore) finalizeQuestResolution(questBefore, result.echo);
  recordObjectiveEvent(session, {
    type: 'quest',
    date: session.currentDate,
    timeOfDay: resolveTimeOfDay(world, session.currentTime),
    locationId: session.currentLocationId,
    actorId: 'player',
    targetIds: [],
    summary: `Quest abandoned: ${result.echo.questName}.`,
    detail: result.echo.message,
    tags: ['quest', 'abandon'],
  });

  persistSessionState(session);
  res.json({ echo: result.echo, quest: getQuestStatus(session), questInvites: session.questInvites ?? [], session, dramaLeads: deriveSessionLeads(world, session) });
});

app.post('/api/sessions/:id/quest/invite', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const quest = session.activeQuest?.status === 'active' ? canonicalQuestFor(session.activeQuest, session) : undefined;
  if (!quest) { res.status(400).json({ error: 'No active quest to invite into' }); return; }
  if (!quest.participantSessionIds.includes(session.id)) { res.status(403).json({ error: 'Only quest participants can invite characters' }); return; }
  const targetSessionId = typeof req.body?.targetSessionId === 'string' ? req.body.targetSessionId : '';
  const targetSession = sessions.get(targetSessionId);
  if (!targetSession) { res.status(404).json({ error: 'Target session not found' }); return; }
  if (targetSession.id === session.id) { res.status(400).json({ error: 'Cannot invite yourself' }); return; }
  if (targetSession.activeQuest?.status === 'active') { res.status(400).json({ error: `${targetSession.playerName} is already in a quest` }); return; }
  if (quest.participantSessionIds.includes(targetSession.id)) { res.status(400).json({ error: `${targetSession.playerName} is already in this quest` }); return; }
  targetSession.questInvites = targetSession.questInvites ?? [];
  const existing = targetSession.questInvites.find(invite => invite.questId === quest.id && invite.status === 'pending');
  const invite: QuestInvitation = existing ?? {
    id: randomUUID(),
    questId: quest.id,
    questName: quest.name,
    ownerSessionId: quest.ownerSessionId,
    ownerName: sessions.get(quest.ownerSessionId)?.playerName ?? session.playerName,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  if (!existing) targetSession.questInvites.push(invite);
  targetSession.questInvites = targetSession.questInvites.slice(-10);
  appendFeedEvents(session, [{ ty: 'quest', x: `Quest invite sent to ${targetSession.playerName}: ${quest.name}` }]);
  appendFeedEvents(targetSession, [{ ty: 'quest', x: `${session.playerName} invited you to quest: ${quest.name}` }]);
  persistSessionOnly(session);
  persistSessionOnly(targetSession, { touch: false });
  res.json({ invite, quest: getQuestStatus(session), questInvites: session.questInvites ?? [], session, dramaLeads: deriveSessionLeads(world, session) });
});

app.post('/api/sessions/:id/quest/invite/respond', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  session.questInvites = session.questInvites ?? [];
  const inviteId = typeof req.body?.inviteId === 'string' ? req.body.inviteId : '';
  const invite = session.questInvites.find(item => item.id === inviteId && item.status === 'pending');
  if (!invite) { res.status(404).json({ error: 'Pending quest invite not found' }); return; }
  const accept = req.body?.accept !== false;
  if (!accept) {
    invite.status = 'declined';
    appendFeedEvents(session, [{ ty: 'quest', x: `Quest invite declined: ${invite.questName}` }]);
    persistSessionOnly(session);
    res.json({ invite, quest: getQuestStatus(session), questInvites: session.questInvites, session, dramaLeads: deriveSessionLeads(world, session) });
    return;
  }
  if (session.activeQuest?.status === 'active' || session.activeWorldQuest?.status === 'active') { res.status(400).json({ error: 'You are already in a quest' }); return; }
  const ownerSession = sessions.get(invite.ownerSessionId);
  const quest = ownerSession?.activeQuest ? canonicalQuestFor(ownerSession.activeQuest, ownerSession) : undefined;
  if (!ownerSession || !quest || quest.id !== invite.questId || quest.status !== 'active') {
    invite.status = 'expired';
    persistSessionOnly(session);
    res.status(400).json({ error: 'Quest invite has expired' });
    return;
  }
  if (session.globalPlayerId && quest.scope === 'global') {
    const existingActive = activeGlobalQuestRecordsForPlayer(session.globalPlayerId)
      .filter(record => record.quest.id !== quest.id);
    if (existingActive.length >= MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER) {
      enforceGlobalQuestLimit(session.globalPlayerId);
      res.status(409).json({
        error: `Character already has ${MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER} active global quests. Finish, leave, or abandon one before joining another.`,
        activeGlobalQuests: existingActive.slice(0, MAX_ACTIVE_GLOBAL_QUESTS_PER_PLAYER).map(record => ({ id: record.quest.id, name: record.quest.name, startedAt: record.quest.startedAt })),
      });
      return;
    }
  }
  const ownerLocation = quest.participantLocations?.[ownerSession.id] ?? {
    worldId: quest.currentWorldId,
    locationId: quest.currentLocationId,
  };
  invite.status = 'accepted';
  attachParticipantToQuest(quest, session, ownerLocation.worldId, ownerLocation.locationId);
  appendFeedEvents(ownerSession, [{ ty: 'quest', x: `${session.playerName} joined quest: ${quest.name}` }]);
  persistQuestParticipants(quest);
  persistSessionOnly(session);
  res.json({ invite, quest: getQuestStatus(session), activeQuest: quest, questInvites: session.questInvites, session, dramaLeads: deriveSessionLeads(world, session) });
});

app.post('/api/sessions/:id/quest/leave', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const quest = session.activeQuest;
  if (!quest || quest.status !== 'active') { res.status(400).json({ error: 'No active quest to leave' }); return; }
  if (quest.ownerSessionId === session.id) { res.status(400).json({ error: 'Quest owner must abandon the quest' }); return; }
  const ownerSession = sessions.get(quest.ownerSessionId);
  const ownerQuest = canonicalQuestFor(ownerSession?.activeQuest?.id === quest.id ? ownerSession.activeQuest : quest);
  const sameGlobalOwner = !!session.globalPlayerId && ownerSession?.globalPlayerId === session.globalPlayerId;
  if (sameGlobalOwner) {
    clearGlobalActiveQuest(session, ownerQuest.id);
    appendFeedEvents(session, [{ ty: 'quest', x: `Left quest: ${ownerQuest.name}` }]);
    persistSessionOnly(session);
    res.json({ left: true, quest: getQuestStatus(session), questInvites: session.questInvites ?? [], session, dramaLeads: deriveSessionLeads(world, session) });
    return;
  }
  restoreQuestParticipant(session, ownerQuest);
  clearGlobalActiveQuest(session, ownerQuest.id);
  ownerQuest.participantSessionIds = ownerQuest.participantSessionIds.filter(id => id !== session.id);
  if (ownerQuest.participantReturns) delete ownerQuest.participantReturns[session.id];
  if (ownerQuest.participantLocations) delete ownerQuest.participantLocations[session.id];
  appendFeedEvents(session, [{ ty: 'quest', x: `Left quest: ${ownerQuest.name}` }]);
  if (ownerSession) {
    ownerSession.activeQuest = ownerQuest;
    appendFeedEvents(ownerSession, [{ ty: 'quest', x: `${session.playerName} left quest: ${ownerQuest.name}` }]);
  }
  persistQuestParticipants(ownerQuest);
  persistSessionOnly(session);
  res.json({ left: true, quest: getQuestStatus(session), questInvites: session.questInvites ?? [], session, dramaLeads: deriveSessionLeads(world, session) });
});

app.post('/api/sessions/:id/message-character', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }

  const targetSessionId = String(req.body.targetSessionId ?? '');
  const message = String(req.body.message ?? '').trim();
  if (!targetSessionId) { res.status(400).json({ error: 'targetSessionId required' }); return; }
  if (!message) { res.status(400).json({ error: 'message required' }); return; }
  if (targetSessionId === session.id) { res.status(400).json({ error: 'Cannot message your own character' }); return; }

  const targetSession = sessions.get(targetSessionId);
  if (!targetSession) {
    res.status(404).json({ error: 'Character not found in this world' });
    return;
  }
  if (session.activeQuest?.status === 'active') {
    const quest = canonicalQuestFor(session.activeQuest, session);
    if (targetSession.activeQuest?.id !== quest.id) {
      res.status(404).json({ error: 'Character is not in this quest' });
      return;
    }
    targetSession.activeQuest = canonicalQuestFor(targetSession.activeQuest, targetSession);
    const here = questLocationForSession(quest, session);
    const there = questLocationForSession(quest, targetSession);
    if (here.worldId !== there.worldId || here.locationId !== there.locationId) {
      res.status(400).json({ error: 'Character is not at your quest location' });
      return;
    }
  } else if (targetSession.worldId !== session.worldId) {
    res.status(404).json({ error: 'Character not found in this world' });
    return;
  }
  if (!isCharacterSessionActive(targetSession)) {
    res.status(400).json({ error: 'Character is not currently active' });
    return;
  }

  syncSessionFromWorld(session, world);

  const clippedMessage = message.slice(0, 280);
  appendFeedEvents(session, [{ ty: 'npc_talk', x: `You tell ${targetSession.playerName}: ${clippedMessage}` }]);
  appendFeedEvents(targetSession, [{ ty: 'npc_talk', x: `${session.playerName} tells you: ${clippedMessage}` }]);
  session.significantEvents.push(`You spoke to ${targetSession.playerName}: ${clippedMessage}`);
  targetSession.significantEvents.push(`${session.playerName} spoke to you: ${clippedMessage}`);
  if (session.significantEvents.length > 20) session.significantEvents = session.significantEvents.slice(-20);
  if (targetSession.significantEvents.length > 20) targetSession.significantEvents = targetSession.significantEvents.slice(-20);

  persistSessionOnly(session);
  persistSessionOnly(targetSession, { touch: false });
  pushCoopEvent(targetSession.id, {
    type: 'direct_character_message',
    fromSessionId: session.id,
    fromName: session.playerName,
    message: clippedMessage,
  });
  const baseWorld = worlds.get(session.worldId) ?? world;
  const view = sessionRuntimeView(session, baseWorld);
  const playerPresences = view.inQuest && session.activeQuest
    ? listQuestPlayerPresences(session.activeQuest, session, view.world)
    : listWorldPlayerPresences(world, session);
  res.json({ delivered: true, session, playerPresences });
});

// ── Weather control ────────────────────────────────────────────────────────

app.post('/api/sessions/:id/weather', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const baseWorld = worlds.get(session.worldId);
  if (!baseWorld) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, baseWorld);
  activeWorldQuestForSessionFromWorld(session, baseWorld);
  activeSerializedAdventureForSessionFromWorld(session, baseWorld);
  const view = sessionRuntimeView(session, baseWorld);
  const world = view.world;
  const currentLocationId = view.locationId;

  const { condition, intensity, temperatureC, thunder, lightning, precipitation, wind, visibility, mood } = req.body;
  ensureCognitionState(session);
  session.currentWeather = controlledWeather(view.inQuest ? world : baseWorld, session.currentDate, session.currentTime, {
    condition,
    intensity,
    temperatureC: typeof temperatureC === 'number' ? temperatureC : Number.parseFloat(temperatureC),
    thunder,
    lightning,
    precipitation,
    wind,
    visibility,
    mood,
  });
  if (!view.inQuest) {
    baseWorld.currentWeather = cloneData(session.currentWeather);
  }
  if (session.activeQuest) {
    session.activeQuest.currentWeather = cloneData(session.currentWeather);
    if (view.inQuest) world.currentWeather = cloneData(session.currentWeather);
    refreshQuestPortalGates(session);
  }
  const weatherPressure = applyWeatherPressure(session, world, currentLocationId, 'weather');
  session.significantEvents.push(`Weather changed to ${describeWeather(session.currentWeather, baseWorld)}.`);
  if (weatherPressure) session.significantEvents.push(weatherPressure);
  if (session.significantEvents.length > 20) session.significantEvents = session.significantEvents.slice(-20);
  recordObjectiveEvent(session, {
    type: 'weather',
    date: session.currentDate,
    timeOfDay: resolveTimeOfDay(world, session.currentTime),
    locationId: currentLocationId,
    actorId: 'player',
    targetIds: npcsAtLocation(world, session, currentLocationId).map(n => n.id),
    summary: `Weather changed to ${describeWeather(session.currentWeather, baseWorld)}.`,
    detail: [weatherPressure, JSON.stringify(session.currentWeather)].filter(Boolean).join('\n'),
    tags: weatherTags(session.currentWeather),
  });

  if (!view.inQuest) saveWorld(baseWorld);
  persistSessionState(session);
  res.json({ session, weather: session.currentWeather, quest: getQuestStatus(session) });
});

// ── God controls ───────────────────────────────────────────────────────────

app.post('/api/sessions/:id/god', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const baseWorld = worlds.get(session.worldId);
  if (!baseWorld) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, baseWorld);
  activeWorldQuestForSessionFromWorld(session, baseWorld);
  activeSerializedAdventureForSessionFromWorld(session, baseWorld);
  const view = sessionRuntimeView(session, baseWorld);
  const world = view.world;
  const currentLocationId = view.locationId;

  const { effect, npcId, text, emotion = 'awe' } = req.body;
  ensureCognitionState(session);
  const targetIds = npcId ? [String(npcId)] : npcsAtLocation(world, session, currentLocationId).map(n => n.id);
  const label = applyGodEffect(session, world, String(effect ?? ''), targetIds, String(text ?? ''), String(emotion ?? 'awe'), currentLocationId);
  refreshQuestPortalGates(session);
  recordObjectiveEvent(session, {
    type: 'god_effect',
    date: session.currentDate,
    timeOfDay: resolveTimeOfDay(world, session.currentTime),
    locationId: currentLocationId,
    actorId: 'player',
    targetIds,
    summary: label,
    detail: String(text ?? label),
    tags: ['god_effect', String(effect ?? ''), String(emotion ?? '')],
  });
  const questUpdate = advanceQuestEpisode(session, {
    kind: 'action',
    locationId: currentLocationId,
    worldId: world.id,
    summary: label,
  });
  handleQuestUpdate(questUpdate);
  const worldQuestUpdate = advanceWorldQuest(session, { kind: 'action', locationId: currentLocationId, worldId: world.id, summary: label });
  const serializedAdventureUpdate = await advanceSerializedAdventureHook(session, world, { kind: 'action', locationId: currentLocationId, summary: label }, world.provider, req.body.model);
  persistSessionState(session);
  res.json({ session, effect: label, quest: getQuestStatus(session), questUpdate, worldQuestUpdate, serializedAdventureUpdate });
});

app.post('/api/sessions/:id/action', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const baseWorld = worlds.get(session.worldId);
  if (!baseWorld) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, baseWorld);
  activeWorldQuestForSessionFromWorld(session, baseWorld);
  activeSerializedAdventureForSessionFromWorld(session, baseWorld);
  const view = sessionRuntimeView(session, baseWorld);
  const world = view.world;
  const currentLocationId = view.locationId;

  const { action, text, provider = world.provider, model } = req.body;
  const actionText = String(action ?? text ?? '').replace(/\s+/g, ' ').trim();
  if (!actionText) { res.status(400).json({ error: 'Action text required' }); return; }

  const timeOfDay = resolveTimeOfDay(world, session.currentTime);
  const npcsPresent = world.npcs
    .filter(npc => session.npcStates[npc.id]?.currentLocationId === currentLocationId)
    .map(npc => {
      const state = session.npcStates[npc.id];
      return {
        name: npc.name,
        activity: state?.currentActivity ?? 'watching',
        relationship: state?.relationship ?? 'stranger',
      };
    });

  try {
    const narrative = await generateNarrative({
      world,
      playerName: session.playerName,
      playerOccupation: session.playerOccupation,
      playerAppearance: session.playerAppearance,
      locationId: currentLocationId,
      currentDate: session.currentDate,
      timeOfDay,
      action: actionText,
      weather: describeWeather(session.currentWeather, baseWorld),
      npcsPresent,
      provider,
      model,
    });
    const targetNpc = npcsAtLocation(world, session, currentLocationId).find(npc => {
      const name = npc.name.toLowerCase();
      const words = name.split(/\s+/).filter(word => word.length > 2);
      return actionText.toLowerCase().includes(name) || words.some(word => actionText.toLowerCase().includes(word));
    });
    const targetIds = npcsAtLocation(world, session, currentLocationId).map(npc => npc.id);
    const objectiveEvent = recordObjectiveEvent(session, {
      type: 'player_action',
      date: session.currentDate,
      timeOfDay,
      locationId: currentLocationId,
      actorId: 'player',
      targetIds,
      summary: `${session.playerName}: ${actionText}`,
      detail: narrative,
      tags: ['action', view.inQuest ? 'quest' : 'world'],
    });
    const currentLocationName = world.locations.find(l => l.id === currentLocationId)?.name ?? currentLocationId;
    for (const witnessId of targetIds) {
      noteNpcExperience(
        session,
        witnessId,
        `${session.playerName} acted at ${currentLocationName}: ${actionText}`,
        {
          thought: `${session.playerName} did something worth remembering: ${actionText}`,
          playerOpinion: session.npcStates[witnessId]?.playerOpinion || `${session.playerName} leaves an impression through their actions.`,
        },
      );
      addPlayerWitnessMemory(
        session,
        witnessId,
        `Saw ${session.playerName} act at ${currentLocationName}.`,
        `${session.playerName}: ${actionText}\n${narrative}`,
        objectiveEvent.id,
        currentLocationId,
        timeOfDay,
      );
    }
    appendFeedEvents(session, [{ ty: 'action', x: actionText }]);
    const isInspect = /^inspect\s+/i.test(actionText);
    const interactableName = isInspect ? actionText.replace(/^inspect\s+/i, '').trim() : undefined;
    const questUpdate = advanceQuestEpisode(session, {
      kind: 'action',
      npcId: targetNpc?.id,
      locationId: currentLocationId,
      worldId: world.id,
      summary: actionText,
      interactableName,
    });
    handleQuestUpdate(questUpdate);
    const worldQuestUpdate = advanceWorldQuest(session, {
      kind: 'action',
      npcId: targetNpc?.id,
      locationId: currentLocationId,
      worldId: world.id,
      summary: actionText,
      interactableName,
    });
    const serializedAdventureUpdate = await advanceSerializedAdventureHook(session, world, { kind: 'action', npcId: targetNpc?.id, locationId: currentLocationId, summary: actionText }, provider, model);
    persistSessionState(session);
    res.json({
      narrative,
      objectiveEvent,
      session,
      dramaLeads: deriveSessionLeads(world, session),
      quest: getQuestStatus(session),
      questUpdate,
      worldQuestUpdate,
      serializedAdventureUpdate,
    });
  } catch (err) {
    console.error('[action]', err);
    res.status(500).json({ error: 'Action failed' });
  }
});

// ── Move to location ────────────────────────────────────────────────────────

app.post('/api/sessions/:id/move', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const baseWorld = worlds.get(session.worldId);
  if (!baseWorld) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, baseWorld);
  activeWorldQuestForSessionFromWorld(session, baseWorld);
  const view = sessionRuntimeView(session, baseWorld);
  const world = view.world;
  const currentLocationId = view.locationId;

  const { locationId, provider = world.provider, model } = req.body;
  if (!locationId) { res.status(400).json({ error: 'locationId required' }); return; }
  const coopQuest = session.activeWorldQuest;

  const target = world.locations.find(l => l.id === locationId);
  if (!target) { res.status(404).json({ error: 'Location not found' }); return; }

  const current = world.locations.find(l => l.id === currentLocationId);
  const repairedCrisisRoute = ensureCubanMissileCrisisRoute(world);
  const currentConnections = connectedLocationIds(world, currentLocationId);
  if (current && !currentConnections.includes(locationId)) {
    res.status(400).json({ error: 'Location not connected to current location' });
    return;
  }

  const previousLocationId = currentLocationId;
  if (!view.inQuest) clearLeaveLocationGodEffects(session, previousLocationId);
  const departureWitnesses = world.npcs.filter(n => {
    return session.npcStates[n.id]?.currentLocationId === previousLocationId;
  });
  session.playerDepartureStyle = session.playerDepartureStyle ?? DEFAULT_PLAYER_DEPARTURE_STYLE;
  const vanishedOnDeparture = !view.inQuest && session.playerDepartureStyle === 'vanishes when leaving places';
  if (view.inQuest && session.activeQuest) {
    session.activeQuest.currentWorldId = world.id;
    session.activeQuest.currentLocationId = locationId;
    session.activeQuest.participantLocations ??= {};
    session.activeQuest.participantLocations[session.id] = { worldId: world.id, locationId };
    const fork = session.activeQuest.forkedWorlds[world.id];
    if (fork) {
      fork.currentLocationId = locationId;
      fork.currentLocationName = target.name;
      fork.visitedLocationIds = Array.from(new Set([...(fork.visitedLocationIds ?? []), locationId]));
    }
  } else {
    session.currentLocationId = locationId;
    const oldMoveTime = session.currentTime;
    session.currentTime = (session.currentTime + 1) % 24;
    session.currentMinute = 0;
    if (session.currentTime < oldMoveTime) {
      // Crossed midnight — advance date
      session.dayCount += 1;
      session.currentDate = addDays(session.currentDate, 1);
      for (const npc of world.npcs) {
        const state = session.npcStates[npc.id];
        if (state?.lastInteractionDate) state.daysSinceLastSeen += 1;
      }
    }
    session.currentWeather = advanceWeather(baseWorld, session.currentWeather, session.currentDate, session.currentTime, 1);
    if (!session.visitedLocations.includes(locationId)) session.visitedLocations.push(locationId);
  }
  if (repairedCrisisRoute) {
    if (view.inQuest) saveSession(session);
    else saveWorld(baseWorld);
  }

  const timeOfDay = resolveTimeOfDay(world, session.currentTime);
  if (!view.inQuest) syncNpcRoutinePresence(session, world, timeOfDay);
  const weatherPressure = applyWeatherPressure(session, world, locationId, 'movement');

  // Who's here?
  const arrivalWitnesses = world.npcs.filter(n => {
    return session.npcStates[n.id]?.currentLocationId === locationId;
  });
  const npcsHere = arrivalWitnesses.map(n => ({
    name: n.name,
    activity: session.npcStates[n.id]?.currentActivity ?? n.dailyRoutine.morning,
    relationship: session.npcStates[n.id]?.relationship ?? 'stranger',
  }));

  try {
    const [narrative, soundscape] = await Promise.all([
      generateNarrative({
        world,
        playerName: session.playerName,
        playerOccupation: session.playerOccupation,
        playerAppearance: session.playerAppearance,
        locationId,
        previousLocationId,
        currentDate: session.currentDate,
        timeOfDay,
        action: vanishedOnDeparture
          ? `vanished from ${current?.name ?? 'the previous place'} and appeared at ${target.name}`
          : ['arrived', weatherPressure].filter(Boolean).join('; '),
        weather: describeWeather(session.currentWeather, baseWorld),
        npcsPresent: npcsHere,
        provider,
        model,
      }),
      generateSoundscape(target, session.currentWeather, session.currentTime, npcsHere.length, provider, model, world.concept, world.id),
    ]);

    if (vanishedOnDeparture) {
      const event = `${session.playerName} vanished while leaving ${current?.name ?? 'somewhere'}.`;
      session.significantEvents.push(event);
      if (session.significantEvents.length > 20) session.significantEvents = session.significantEvents.slice(-20);
      session.strangePossessions = Array.from(new Set([...(session.strangePossessions ?? []), 'vanishes when leaving places'])).slice(-10);
      if (session.reputation === 'unknown' || session.reputation === 'strange') session.reputation = 'uncanny';
      if (departureWitnesses.length > 0) {
        session.activeGossip.push({
          fromNpcId: departureWitnesses[0].id,
          content: `${session.playerName} did not walk out. They were there, and then they were gone.`,
          date: session.currentDate,
          sentiment: 'warning',
          isTrue: true,
        });
      }
    }

    const objectiveEvent = recordObjectiveEvent(session, {
      type: 'movement',
      date: session.currentDate,
      timeOfDay,
      locationId,
      actorId: 'player',
      targetIds: Array.from(new Set([...departureWitnesses.map(n => n.id), ...arrivalWitnesses.map(n => n.id)])),
      summary: `${session.playerName} moved from ${current?.name ?? previousLocationId} to ${target.name}.`,
      detail: [narrative, weatherPressure].filter(Boolean).join('\n'),
      tags: view.inQuest ? Array.from(new Set(['quest', 'movement', ...weatherTags(session.currentWeather)])) : vanishedOnDeparture ? Array.from(new Set(['movement', 'vanished', 'witnessed', ...weatherTags(session.currentWeather)])) : Array.from(new Set(['movement', ...weatherTags(session.currentWeather)])),
    });
    for (const witness of departureWitnesses) {
      noteNpcExperience(
        session,
        witness.id,
        vanishedOnDeparture
          ? `${session.playerName} vanished while leaving ${current?.name ?? previousLocationId}.`
          : `${session.playerName} left ${current?.name ?? previousLocationId} for ${target.name}.`,
        {
          thought: vanishedOnDeparture
            ? `${session.playerName} was there, then gone.`
            : `${session.playerName} headed toward ${target.name}.`,
          currentWorry: vanishedOnDeparture ? `${session.playerName} can vanish when leaving places.` : undefined,
        },
      );
      addPlayerWitnessMemory(
        session,
        witness.id,
        vanishedOnDeparture ? `Saw ${session.playerName} vanish.` : `Saw ${session.playerName} leave ${current?.name ?? previousLocationId}.`,
        vanishedOnDeparture
          ? `${session.playerName} did not walk out. They were there, and then they were gone.`
          : `${session.playerName} left for ${target.name}.`,
        objectiveEvent.id,
        previousLocationId,
        timeOfDay,
        vanishedOnDeparture ? 'uncanny' : 'observant',
      );
    }
    for (const witness of arrivalWitnesses) {
      noteNpcExperience(
        session,
        witness.id,
        `${session.playerName} arrived at ${target.name}.`,
        { thought: `${session.playerName} arrived here.` },
      );
      addPlayerWitnessMemory(
        session,
        witness.id,
        `Saw ${session.playerName} arrive at ${target.name}.`,
        [narrative, weatherPressure].filter(Boolean).join('\n') || `${session.playerName} arrived at ${target.name}.`,
        objectiveEvent.id,
        locationId,
        timeOfDay,
      );
    }
    const questUpdate = advanceQuestEpisode(session, {
      kind: 'movement',
      locationId,
      worldId: world.id,
      summary: target.name,
    });
    handleQuestUpdate(questUpdate);
    const worldQuestUpdate = advanceWorldQuest(session, {
      kind: 'movement',
      locationId,
      worldId: world.id,
      summary: target.name,
    });
    const serializedAdventureUpdate = await advanceSerializedAdventureHook(session, world, { kind: 'movement', locationId, summary: target.name }, provider, model);
    const cognition = advanceAllCognition(session, world, timeOfDay);
    if (coopQuest?.twoPlayer && coopQuest.guestSessionId) {
      const isHost = session.id === coopQuest.hostSessionId;
      const isGuest = session.id === coopQuest.guestSessionId;
      const partnerId = isHost ? coopQuest.guestSessionId : coopQuest.hostSessionId;
      const partnerSession = partnerId ? sessions.get(partnerId) : undefined;
      const partnerMode = isHost ? coopQuest.guestCoopMode : coopQuest.hostCoopMode;
      const myMode = isHost ? coopQuest.hostCoopMode : coopQuest.guestCoopMode;
      if ((isHost || isGuest) && partnerMode === 'join' && partnerSession) {
        setSessionLocation(partnerSession, session.currentLocationId);
        persistSessionState(partnerSession, { touch: false });
        pushCoopEvent(partnerSession.id, {
          type: 'coop_location_sync',
          locationId: session.currentLocationId,
        });
      }
    }
    const coopAdventure = activeSerializedAdventureForSessionFromWorld(session, baseWorld);
    if (coopAdventure?.status === 'active' && coopAdventure.allowCoop) {
      const partnerSession = serialisedAdventurePartnerSession(coopAdventure, session.id);
      if (partnerSession) {
        const myMode = serialisedAdventureCoopMode(coopAdventure, session.id);
        const partnerMode = serialisedAdventureCoopMode(coopAdventure, partnerSession.id);
        if (partnerMode === 'join') {
          setSessionLocation(partnerSession, session.currentLocationId);
          persistSessionState(partnerSession, { touch: false });
          pushCoopEvent(partnerSession.id, {
            type: 'coop_location_sync',
            locationId: session.currentLocationId,
          });
        }
      }
    }

    persistSessionState(session);
    res.json({
      narrative,
      location: target,
      session,
      weather: session.currentWeather,
      soundscape: soundscape ?? undefined,
      departure: vanishedOnDeparture ? {
        style: 'vanished',
        from: current?.name ?? previousLocationId,
        witnesses: departureWitnesses.map(n => n.name),
      } : undefined,
      cognition: { objectiveEvent, ...cognition },
      timeOfDay,
      currentTime: session.currentTime,
      npcsPresent: npcsHere.map(n => n.name),
      dramaLeads: deriveSessionLeads(world, session),
      quest: getQuestStatus(session),
      questUpdate,
      worldQuestUpdate,
      serializedAdventureUpdate,
      npcDetails: world.npcs
        .filter(n => session.npcStates[n.id]?.currentLocationId === locationId)
        .map(n => ({
          id: n.id,
          name: n.name,
          occupation: n.occupation,
          relationship: session.npcStates[n.id]?.relationship ?? 'stranger',
          mood: session.npcStates[n.id]?.mood ?? n.baselineMood,
        })),
    });
  } catch (err) {
    console.error('[move]', err);
    res.status(500).json({ error: 'Narrative generation failed' });
  }
});

app.get('/api/sessions/:id/soundscape', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  const baseWorld = worlds.get(session.worldId);
  if (!baseWorld) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, baseWorld);
  const view = sessionRuntimeView(session, baseWorld);
  const world = view.world;
  const currentLocationId = view.locationId;

  const location = world.locations.find(l => l.id === currentLocationId);
  if (!location) { res.status(404).json({ error: 'Location not found' }); return; }

  const npcsHere = world.npcs.filter(n => session.npcStates[n.id]?.currentLocationId === currentLocationId);

  try {
    const soundscape = await generateSoundscape(
      location,
      session.currentWeather,
      session.currentTime,
      npcsHere.length,
      world.provider,
      undefined,
      world.concept,
      world.id,
    );
    res.json({ soundscape: soundscape ?? null });
  } catch (err) {
    console.error('[soundscape]', err);
    res.json({ soundscape: null });
  }
});

// ── Advance time (wait/sleep) ───────────────────────────────────────────────

app.post('/api/sessions/:id/wait', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const baseWorld = worlds.get(session.worldId);
  if (!baseWorld) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, baseWorld);
  const view = sessionRuntimeView(session, baseWorld);
  const world = view.world;
  const currentLocationId = view.locationId;

  const { hours = 1, provider = world.provider, model } = req.body;
  const advanceHours = Math.min(Math.max(1, hours), 12);

  advanceSessionClock(session, view.inQuest ? world : baseWorld, advanceHours * 60);
  if (view.inQuest && session.activeQuest) {
    session.activeQuest.currentDate = session.currentDate;
    session.activeQuest.currentTime = session.currentTime;
    session.activeQuest.currentMinute = session.currentMinute ?? 0;
    session.activeQuest.dayCount = session.dayCount;
    session.activeQuest.currentWeather = cloneData(session.currentWeather);
    world.currentDate = session.currentDate;
    world.currentTime = session.currentTime;
    world.currentMinute = session.currentMinute ?? 0;
    world.currentWeather = cloneData(session.currentWeather);
  }
  const weatherPressure = applyWeatherPressure(session, world, currentLocationId, 'time');

  const timeOfDay = resolveTimeOfDay(world, session.currentTime);
  if (!view.inQuest) syncNpcRoutinePresence(session, world, timeOfDay);

  try {
    const narrative = await generateNarrative({
      world,
      playerName: session.playerName,
      playerOccupation: session.playerOccupation,
      playerAppearance: session.playerAppearance,
      locationId: currentLocationId,
      currentDate: session.currentDate,
      timeOfDay,
      action: [advanceHours >= 6 ? 'slept and woke up' : 'waited', weatherPressure].filter(Boolean).join('; '),
      weather: describeWeather(session.currentWeather, baseWorld),
      npcsPresent: [],
      provider,
      model,
    });

    const waitLocation = world.locations.find(l => l.id === currentLocationId);
    if (!waitLocation) { res.status(404).json({ error: 'Current location not found' }); return; }
    const waitNpcsHere = world.npcs.filter(n => session.npcStates[n.id]?.currentLocationId === currentLocationId);
    const soundscape = await generateSoundscape(
      waitLocation,
      session.currentWeather,
      session.currentTime,
      waitNpcsHere.length,
      provider,
      model,
      world.concept,
      world.id,
    );

    const objectiveEvent = recordObjectiveEvent(session, {
      type: 'system',
      date: session.currentDate,
      timeOfDay,
      locationId: currentLocationId,
      actorId: 'system',
      targetIds: [],
      summary: `${session.playerName} ${advanceHours >= 6 ? 'slept' : 'waited'} for ${advanceHours} hour(s).`,
      detail: [narrative, weatherPressure].filter(Boolean).join('\n'),
      tags: Array.from(new Set(['time', advanceHours >= 6 ? 'sleep' : 'wait', ...weatherTags(session.currentWeather)])),
    });
    if (!view.inQuest) maybeCreateQuestHook(baseWorld, session);
    const questUpdate = advanceQuestEpisode(session, {
      kind: 'wait',
      turnCost: advanceHours,
      locationId: currentLocationId,
      worldId: world.id,
      summary: `${advanceHours} hour wait`,
    });
    handleQuestUpdate(questUpdate);
    const worldQuestUpdate = advanceWorldQuest(session, {
      kind: 'wait',
      locationId: currentLocationId,
      worldId: world.id,
      summary: `${advanceHours} hour wait`,
    });
    const serializedAdventureUpdate = await advanceSerializedAdventureHook(session, world, { kind: 'wait', locationId: currentLocationId, summary: `${advanceHours} hour wait` }, provider, model);
    const cognition = advanceAllCognition(session, world, timeOfDay);

    // Dream processing during sleep
    const dreamResults: Array<{npc: string; dream: string; tone: string}> = [];
    if (advanceHours >= 6) {
      // It's a sleep cycle — NPCs dream
      for (const npc of world.npcs) {
        const state = session.npcStates[npc.id];
        if (!state?.innerLife) continue;
        try {
          const dreamResult = await runDreamProcessing(npc, state, state.innerLife, world, session.currentDate, provider, model);
          if (dreamResult) {
            dreamResults.push({
              npc: npc.name,
              dream: dreamResult.dream.content,
              tone: dreamResult.dream.emotionalTone,
            });
          }
        } catch (err) {
          console.error(`[dream:${npc.id}]`, err);
        }
      }
    }

    if (dreamResults.length > 0) {
      appendFeedEvents(session, dreamResults.map(d => ({ ty: 'dream', x: `${d.npc} dreamed: ${d.dream}` })));
    }
    const bodyHabitFeed: Array<{ npc: string; detail: string }> = [];
    for (let step = 0; step < advanceHours; step += 1) {
      for (const npc of world.npcs) {
        const result = advanceNpcBodyHabits(session, world, npc, timeOfDay);
        if (!result.event) continue;
        bodyHabitFeed.push({ npc: npc.name, detail: result.event });
        recordObjectiveEvent(session, {
          type: 'life_event',
          date: session.currentDate,
          timeOfDay,
          locationId: session.npcStates[npc.id]?.currentLocationId ?? currentLocationId,
          actorId: npc.id,
          targetIds: [npc.id],
          summary: result.event,
          detail: result.event,
          tags: ['body_habit', result.bowel ? 'bowel_movement' : result.visit ? 'toilet_visit' : 'accident'],
        });
      }
    }
    const compressedBodyHabitFeed = compressBodyHabitFeed(bodyHabitFeed);
    if (compressedBodyHabitFeed.length) appendFeedEvents(session, compressedBodyHabitFeed.map(b => ({ ty: 'event', x: b.detail })));

    const recap = summarizeWorldAdvance(world, session, [
      `${session.playerName} ${advanceHours >= 6 ? 'slept' : 'waited'} for ${advanceHours} hour(s).`,
      ...cognition.summary.slice(0, 3).map(s => `${s.npc}: ${s.event}`),
      ...dreamResults.slice(0, 2).map(d => `${d.npc} dreamed in a ${d.tone} tone.`),
      ...compressedBodyHabitFeed.slice(0, 2).map(b => b.detail),
    ]);

    persistSessionState(session);
    res.json({ narrative, timeOfDay, currentTime: session.currentTime, currentMinute: session.currentMinute ?? 0, currentDate: session.currentDate, dayCount: session.dayCount, weather: session.currentWeather, soundscape: soundscape ?? undefined, session, cognition: { objectiveEvent, ...cognition }, dreams: dreamResults, bodyHabits: compressedBodyHabitFeed, recap, dramaLeads: deriveSessionLeads(world, session), quest: getQuestStatus(session), questUpdate, worldQuestUpdate, serializedAdventureUpdate });
  } catch (err) {
    console.error('[wait]', err);
    res.status(500).json({ error: 'Failed' });
  }
});

function privacyStressForBody(state: NPCLiveState): number {
  const affect: any = state.innerLife?.affect ?? {};
  const anxiety = Math.max(Number(affect.fear ?? 0), Number(affect.shame ?? 0), Number(affect.guilt ?? 0), Number(affect.disgust ?? 0));
  const avoidance = Number(state.bodyHabits?.avoidance ?? 0) / 100;
  const sensitivity = Number(state.bodyHabits?.stressSensitivity ?? 50) / 100;
  return clamp((anxiety * 65 + avoidance * 25 + sensitivity * 20), 0, 100);
}

function advanceNpcBodyHabits(session: WorldSession, world: WorldDNA, npc: WorldNPC, timeOfDay: string): { event?: string; visit?: boolean; bowel?: boolean } {
  const state = session.npcStates[npc.id];
  if (!state) return {};
  state.bodyHabits ??= createInitialBodyHabits(npc);
  const body = state.bodyHabits;
  body.recentEvents ??= [];
  body.toiletVisits ??= [];
  body.bowelMovements ??= [];
  const affect: any = state.innerLife?.affect ?? {};
  const stress = privacyStressForBody(state);
  const watched = world.npcs.some(other => other.id !== npc.id && session.npcStates[other.id]?.currentLocationId === state.currentLocationId);
  const socialPrivacyCost = watched ? body.privacyNeed / 9 : 0;
  const routineEase = /morning|evening|night/i.test(timeOfDay) ? body.regularity / 40 : 0;
  const fearPressure = Math.max(Number(affect.fear ?? 0), Number(affect.shame ?? 0), Number(affect.anxiety ?? 0)) * body.stressSensitivity / 85;
  body.bladder = clamp(body.bladder + 10 + fearPressure - routineEase, 0, 130);
  body.bowel = clamp(body.bowel + 6 + fearPressure * 0.45 - routineEase * 0.65, 0, 130);
  body.avoidance = clamp(body.avoidance + stress / 20 + socialPrivacyCost / 3 - routineEase, 0, 100);
  const bladderThreshold = 78 + socialPrivacyCost + body.avoidance / 5;
  const bowelThreshold = 84 + socialPrivacyCost + body.avoidance / 4;
  const needsBladder = body.bladder >= bladderThreshold;
  const needsBowel = body.bowel >= bowelThreshold;
  const timestamp = `${session.currentDate} ${timeOfDay}`;
  const accidentRisk = Math.max(body.bladder - 118, body.bowel - 122);
  if (accidentRisk > 0 && stress > 72) {
    const hadBowelAccident = body.bowel > 122;
    const note = `${npc.name} had an accident after holding in a toilet need under ${Math.round(stress)}% psychological pressure.`;
    const accidentVisit = {
      date: session.currentDate,
      timeOfDay,
      locationId: state.currentLocationId,
      reason: hadBowelAccident ? 'stress accident with bowel movement' : 'stress accident',
      bladderBefore: Math.round(body.bladder),
      bowelBefore: Math.round(body.bowel),
      privacyStress: Math.round(stress),
    };
    body.toiletVisits.push(accidentVisit);
    if (hadBowelAccident) {
      body.bowelMovements.push({
        date: session.currentDate,
        timeOfDay,
        locationId: state.currentLocationId,
        reason: 'stress accident with bowel movement',
        bowelBefore: accidentVisit.bowelBefore,
        psychologicalTrigger: 'fear/shame pressure',
      });
      body.lastBowelAt = timestamp;
    }
    body.lastAccidentAt = timestamp;
    body.lastToiletAt = timestamp;
    body.lastNote = note;
    body.bladder = Math.max(0, body.bladder - 70);
    if (body.bowel > 100) body.bowel = Math.max(0, body.bowel - 80);
    body.avoidance = clamp(body.avoidance + 18, 0, 100);
    body.recentEvents = [...body.recentEvents, note].slice(-20);
    state.recentLifeEvents = [...(state.recentLifeEvents ?? []), note].slice(-30);
    return { event: note, visit: true, bowel: hadBowelAccident };
  }
  if (!needsBladder && !needsBowel) return {};
  const reason = needsBowel ? (stress > 55 ? 'stress bowel movement' : 'regular bowel movement') : (stress > 55 ? 'nervous toilet visit' : 'toilet visit');
  const visit = {
    date: session.currentDate,
    timeOfDay,
    locationId: state.currentLocationId,
    reason,
    bladderBefore: Math.round(body.bladder),
    bowelBefore: Math.round(body.bowel),
    privacyStress: Math.round(stress),
  };
  body.toiletVisits.push(visit);
  body.lastToiletAt = timestamp;
  body.bladder = Math.max(0, body.bladder - 82);
  body.avoidance = clamp(body.avoidance - 18, 0, 100);
  let note = `${npc.name} made a toilet visit (${reason}, privacy pressure ${Math.round(stress)}%).`;
  let bowel = false;
  if (needsBowel) {
    bowel = true;
    body.bowelMovements.push({
      date: session.currentDate,
      timeOfDay,
      locationId: state.currentLocationId,
      reason,
      bowelBefore: visit.bowelBefore,
      psychologicalTrigger: stress > 55 ? 'fear/shame pressure' : undefined,
    });
    body.lastBowelAt = timestamp;
    body.bowel = Math.max(0, body.bowel - 88);
    note = `${npc.name} had a bowel movement (${reason}, privacy pressure ${Math.round(stress)}%).`;
  }
  body.lastNote = note;
  body.recentEvents = [...body.recentEvents, note].slice(-20);
  state.recentLifeEvents = [...(state.recentLifeEvents ?? []), note].slice(-30);
  return { event: note, visit: true, bowel };
}

function compressBodyHabitFeed(events: Array<{ npc: string; detail: string }>): Array<{ npc: string; detail: string }> {
  const grouped = new Map<string, { visits: number; bowels: number; accidents: number; latest: string }>();
  for (const event of events) {
    const current = grouped.get(event.npc) ?? { visits: 0, bowels: 0, accidents: 0, latest: event.detail };
    current.latest = event.detail;
    if (/accident/i.test(event.detail)) current.accidents += 1;
    else if (/bowel movement/i.test(event.detail)) current.bowels += 1;
    else current.visits += 1;
    grouped.set(event.npc, current);
  }
  return Array.from(grouped.entries()).map(([npc, counts]) => {
    const parts = [
      counts.visits ? `${counts.visits} toilet visit${counts.visits === 1 ? '' : 's'}` : '',
      counts.bowels ? `${counts.bowels} bowel movement${counts.bowels === 1 ? '' : 's'}` : '',
      counts.accidents ? `${counts.accidents} accident${counts.accidents === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return { npc, detail: parts.length ? `${npc}: ${parts.join(', ')}. Latest: ${counts.latest}` : counts.latest };
  });
}

// ── Simulation tick (run NPC social sim) ────────────────────────────────────

app.post('/api/sessions/:id/tick', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const baseWorld = worlds.get(session.worldId);
  if (!baseWorld) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, baseWorld);
  const view = sessionRuntimeView(session, baseWorld);
  const world = view.world;
  const currentLocationId = view.locationId;

  // Clear stale "overwhelmed" moods if no active desire effect
  const hasDesireEffect = (session.activeGodEffects ?? []).some(e => e.type === 'overwhelming_desire');
  if (!hasDesireEffect) {
    for (const state of Object.values(session.npcStates)) {
      if (state.mood === 'overwhelmed') state.mood = 'unsettled';
      const affect: any = state.innerLife?.affect;
      if (affect?.desire > 0.5) affect.desire = 0.2;
    }
  }

  const { provider = world.provider, model } = req.body;
  ensureCognitionState(session);
  ensureSessionWeather(session, baseWorld);
  const timeOfDay = resolveTimeOfDay(world, session.currentTime);

  try {
    const ticks = await runSocialTick(world, session.npcStates, session.currentDate, timeOfDay, provider, model, session.playerName, session.reputation);
    const contagionEvents = [];
    const socialEvents = [];
    const gossipFeed: Array<{npc: string; content: string}> = [];
    const pepFeed: Array<{npc: string; detail: string}> = [];
    const defenseFeed: Array<{npc: string; defense: string; behaviour: string}> = [];
    
    // Apply social ticks
    for (const tick of ticks) {
      const state = session.npcStates[tick.npcId];
      if (!state) continue;
      state.currentLocationId = tick.locationId;
      state.currentActivity = tick.activity;
      if (tick.moodChange) state.mood = tick.moodChange;
      if (tick.lifeEvent) {
        state.recentLifeEvents.push(tick.lifeEvent);
        socialEvents.push(recordObjectiveEvent(session, {
          type: 'life_event',
          date: session.currentDate,
          timeOfDay,
          locationId: tick.locationId,
          actorId: tick.npcId,
          targetIds: [tick.npcId],
          summary: tick.lifeEvent,
          detail: `${world.npcs.find(n => n.id === tick.npcId)?.name ?? tick.npcId}: ${tick.lifeEvent}`,
          tags: ['life_event', tick.moodChange ?? 'mood'],
        }));
      }
      if (tick.relationshipChanges) {
        for (const change of tick.relationshipChanges) {
          state.recentLifeEvents.push(`Felt ${change.delta >= 0 ? 'closer to' : 'more distant from'} ${world.npcs.find(n => n.id === change.npcId)?.name ?? change.npcId}: ${change.reason}.`);
        }
      }
      if (tick.gossipExchanged) {
        for (const g of tick.gossipExchanged) {
          const gossipNpcName = world.npcs.find(n => n.id === tick.npcId)?.name ?? tick.npcId;
          const seriousness = gossipSeriousness(g);
          const potentialHearers = world.npcs
            .filter(other => other.id !== tick.npcId)
            .filter(other => {
              const otherState = session.npcStates[other.id];
              return otherState && otherState.currentLocationId === tick.locationId && !hasHeardGossip(otherState, g);
            })
            .sort(() => Math.random() - 0.5);
          const hearerLimit = clamp(seriousness >= 4 ? 3 : seriousness >= 2 ? 2 : 1, 1, potentialHearers.length);
          const hearers = potentialHearers.slice(0, hearerLimit);
          gossipFeed.push({ npc: gossipNpcName, content: g.content });
          socialEvents.push(recordObjectiveEvent(session, {
            type: 'gossip',
            date: session.currentDate,
            timeOfDay,
            locationId: tick.locationId,
            actorId: tick.npcId,
            targetIds: hearers.map(other => other.id),
            summary: g.content,
            detail: `${tick.npcId} shared gossip: ${g.content}`,
            tags: ['gossip', g.sentiment],
          }));
          for (const other of hearers) {
            if (contagionEvents.length >= 2) break;
            const otherState = session.npcStates[other.id];
            if (!otherState || !addGossipToNpcState(otherState, g)) continue;
            const contagion = createBeliefContagion(session, tick.npcId, other.id, g, session.currentDate, timeOfDay);
            if (contagion) contagionEvents.push(contagion);
          }
        }
      }
    }

    const bodyHabitFeed: Array<{ npc: string; detail: string }> = [];
    for (const npc of world.npcs) {
      const result = advanceNpcBodyHabits(session, world, npc, timeOfDay);
      if (!result.event) continue;
      bodyHabitFeed.push({ npc: npc.name, detail: result.event });
      recordObjectiveEvent(session, {
        type: 'life_event',
        date: session.currentDate,
        timeOfDay,
        locationId: session.npcStates[npc.id]?.currentLocationId ?? currentLocationId,
        actorId: npc.id,
        targetIds: [npc.id],
        summary: result.event,
        detail: result.event,
        tags: ['body_habit', result.bowel ? 'bowel_movement' : result.visit ? 'toilet_visit' : 'accident'],
      });
    }

    // Wire the agency engine into active ticks for the NPCs most likely to act.
    const agencyDecisions = [];
    const agencyCandidates = world.npcs
      .filter(n => {
        const state = session.npcStates[n.id];
        return state?.innerLife && ((state.activeGoals?.length ?? 0) > 0 || state.innerLife.pepActive || state.recentLifeEvents.length > 0);
      })
      .sort((a, b) => (session.npcStates[b.id]?.innerLife?.pepCycleCount ?? 0) - (session.npcStates[a.id]?.innerLife?.pepCycleCount ?? 0))
      .slice(0, 6);
    for (const npc of agencyCandidates) {
      const state = session.npcStates[npc.id];
      try {
        const decision = await makeNPCDecision(npc, state, world, session.npcStates, session.currentDate, session.currentTime, provider, model);
        if (decision.locationId && world.locations.some(l => l.id === decision.locationId)) state.currentLocationId = decision.locationId;
        state.currentActivity = decision.action || state.currentActivity;
        state.isAvailable = decision.openToConversation;
        if (decision.reason) state.recentLifeEvents.push(`Decision: ${decision.reason}`);
        agencyDecisions.push({ npc: npc.name, decision });
      } catch (err) {
        console.error(`[agency:${npc.id}]`, err);
      }
    }

    // Let a small number of co-located NPCs talk, then persist the conversation as truth and memory.
    const conversations = [];
    const usedPairs = new Set<string>();
    for (const npc of world.npcs) {
      if (conversations.length >= 2) break;
      const state = session.npcStates[npc.id];
      if (!state) continue;
      const other = world.npcs.find(o => o.id !== npc.id && session.npcStates[o.id]?.currentLocationId === state.currentLocationId);
      if (!other) continue;
      const pairKey = [npc.id, other.id].sort().join(':');
      if (usedPairs.has(pairKey)) continue;
      usedPairs.add(pairKey);
      try {
        const conv = await simulateNPCConversation(
          npc, other, state, session.npcStates[other.id], world,
          state.gossipHeard.slice(-1)[0]?.content ?? null,
          state.currentLocationId,
          session.currentDate,
          state.currentLocationId === currentLocationId,
          provider,
          model,
        );
        const event = recordObjectiveEvent(session, {
          type: 'npc_conversation',
          date: session.currentDate,
          timeOfDay,
          locationId: state.currentLocationId,
          actorId: npc.id,
          targetIds: [npc.id, other.id],
          summary: conv.summary,
          detail: conv.emotionalOutcome,
          tags: ['npc_conversation', conv.relationshipShift > 0 ? 'bonding' : conv.relationshipShift < 0 ? 'friction' : 'neutral'],
        });
        addNpcConversationMemory(session, npc.id, other.id, other.name, conv.summary, conv.emotionalOutcome, event.id, state.currentLocationId, timeOfDay, conv.relationshipShift);
        addNpcConversationMemory(session, other.id, npc.id, npc.name, conv.summary, conv.emotionalOutcome, event.id, state.currentLocationId, timeOfDay, conv.relationshipShift);
        // Memory comparison — check if these NPCs have conflicting memories
        const memComparison = compareMemories(session, npc, state, other, session.npcStates[other.id]);
        if (memComparison.hasConflict) {
          recordObjectiveEvent(session, {
            type: 'npc_conversation',
            date: session.currentDate,
            timeOfDay,
            locationId: state.currentLocationId,
            actorId: npc.id,
            targetIds: [npc.id, other.id],
            summary: `Memory conflict: ${memComparison.conflictDescription}`,
            detail: memComparison.conflictDescription ?? '',
            tags: ['memory_conflict', 'npc_conversation'],
          });
          appendFeedEvents(session, [{ ty: 'memory_conflict', x: `${npc.name} & ${other.name}: conflicting memories — ${memComparison.conflictDescription?.slice(0, 120)}` }]);
        }
        if (conv.gossipGenerated) {
          const targetState = session.npcStates[other.id];
          targetState.gossipHeard.push(conv.gossipGenerated);
          gossipFeed.push({ npc: npc.name, content: conv.gossipGenerated.content ?? conv.gossipGenerated });
          if (contagionEvents.length < 3) {
            const contagion = createBeliefContagion(session, npc.id, other.id, conv.gossipGenerated, session.currentDate, timeOfDay);
            if (contagion) contagionEvents.push(contagion);
          }
        }
        conversations.push({ a: npc.name, b: other.name, fragment: conv.overheardFragment, summary: conv.summary });
      } catch (err) {
        console.error(`[npc-conv:${pairKey}]`, err);
      }
    }

    // Run cognitive tick for NPCs with active inner processing
    const cogResults: Array<{npc: string; thought?: string; seeking?: boolean; avoiding?: boolean}> = [];
    for (const npc of world.npcs) {
      const state = session.npcStates[npc.id];
      if (!state?.innerLife) continue;
      
      // Only run full cognitive tick for NPCs who have something to process
      const needsCognition = state.innerLife.pepActive || 
        state.totalInteractions > 0 || 
        state.recentLifeEvents.length > 0;
      
      if (!needsCognition) continue;

      try {
        const cogResult = await runCognitiveTick(npc, state, state.innerLife, world, session.currentDate, timeOfDay, provider, model);
        state.mood = cogResult.moodLabel;
        state.innerLife.affect = cogResult.affectAfter;
        if (cogResult.thoughts.length > 0) {
          state.innerLife.lastThought = cogResult.thoughts[cogResult.thoughts.length - 1];
        }
        // NPC-initiated contact (CONSCIOUSNESS.md 9.13): keep the tick's approach (reason, urgency,
        // LLM opening line) for the approach feed and the Observatory; drop it once they stop seeking.
        if (cogResult.pendingApproach) state.pendingApproach = cogResult.pendingApproach as NPCLiveState['pendingApproach'];
        else if (!cogResult.seekingPlayer || cogResult.avoidingPlayer) state.pendingApproach = undefined;
        if (state.innerLife.pepActive) {
          pepFeed.push({ npc: npc.name, detail: `ruminating about ${state.innerLife.pepTarget} (cycle ${state.innerLife.pepCycleCount})` });
        }
        cogResults.push({
          npc: npc.name,
          thought: cogResult.thoughts[0],
          seeking: cogResult.seekingPlayer,
          avoiding: cogResult.avoidingPlayer,
        });
      } catch (err) {
        console.error(`[cog:${npc.id}]`, err);
      }
    }
    const proofCognition = advanceAllCognition(session, world, timeOfDay);
    for (const s of proofCognition.summary) {
      if (s.event.startsWith('defense:')) {
        const parts = s.event.match(/^defense:\s*(\S+)\s*\((.+)\)$/);
        defenseFeed.push({ npc: s.npc, defense: parts?.[1] ?? 'unknown', behaviour: parts?.[2] ?? s.event });
      }
    }

    // Collect NPC approaches (NPCs seeking the player)
    const npcApproaches: Array<{npcId: string; npcName: string; approach: any}> = [];
    for (const npc of world.npcs) {
      const state = session.npcStates[npc.id];
      if (!state) continue;

      // Check cognitive tick results for pending approaches
      const cogResult = cogResults.find(c => c.npc === npc.name);
      if (cogResult?.seeking && state.currentLocationId === currentLocationId) {
        // NPC is at the same location and wants to talk
        const approach = state.pendingApproach ?? {
          reason: 'emotional_need',
          message: state.innerLife?.lastThought || 'wants to speak with you',
          urgency: 50,
          generatedAt: session.currentDate,
        };
        npcApproaches.push({
          npcId: npc.id,
          npcName: npc.name,
          approach,
        });
      }
    }

    // Run loyalty conflict detection for active NPCs
    for (const npc of agencyCandidates) {
      detectLoyaltyConflicts(session, npc, session.npcStates[npc.id], world);
    }

    // Group conversations (3-way) — happens occasionally when 3+ NPCs are co-located
    const groupConversations: Array<{participants: string[]; summary: string; fragment?: string}> = [];
    if (conversations.length < 2) {
      // Only try group conversations if we haven't had too many pair conversations
      const locationGroups: Record<string, WorldNPC[]> = {};
      for (const npc of world.npcs) {
        const state = session.npcStates[npc.id];
        if (!state) continue;
        const loc = state.currentLocationId;
        if (!locationGroups[loc]) locationGroups[loc] = [];
        locationGroups[loc].push(npc);
      }

      for (const [locId, npcsAtLoc] of Object.entries(locationGroups)) {
        if (groupConversations.length >= 1) break;
        if (npcsAtLoc.length >= 3 && Math.random() < 0.35) {
          // Pick 3 NPCs for group conversation
          const shuffled = npcsAtLoc.sort(() => Math.random() - 0.5).slice(0, 3) as [typeof npcsAtLoc[0], typeof npcsAtLoc[0], typeof npcsAtLoc[0]];
          const groupStates = shuffled.map(n => session.npcStates[n.id]) as [NPCLiveState, NPCLiveState, NPCLiveState];

          try {
            const groupConv = await simulateGroupConversation(
              shuffled,
              groupStates,
              world,
              session.activeGossip.slice(-1)[0]?.content ?? null,
              locId,
              session.currentDate,
              locId === currentLocationId,
              provider,
              model,
            );

            // Apply relationship shifts
            for (const [pairKey, shift] of Object.entries(groupConv.relationshipShifts)) {
              if (typeof shift !== 'number') continue;
              const [idA, idB] = pairKey.split(':');
              const stA = session.npcStates[idA];
              const stB = session.npcStates[idB];
              if (stA) stA.recentLifeEvents.push(`Group conversation: ${shift > 0 ? 'bonded with' : 'friction with'} others`);
              if (stB) stB.recentLifeEvents.push(`Group conversation: ${shift > 0 ? 'felt included' : 'felt tension'}`);
            }

            // Record as objective event
            recordObjectiveEvent(session, {
              type: 'npc_conversation',
              date: session.currentDate,
              timeOfDay,
              locationId: locId,
              actorId: shuffled[0].id,
              targetIds: shuffled.map(n => n.id),
              summary: groupConv.summary,
              detail: `Group: ${shuffled.map(n => n.name).join(', ')}`,
              tags: ['group_conversation', 'npc_conversation'],
            });

            groupConversations.push({
              participants: shuffled.map(n => n.name),
              summary: groupConv.summary,
              fragment: groupConv.overheardFragment,
            });

            if (groupConv.gossipGenerated) {
              gossipFeed.push({ npc: shuffled.map(n => n.name).join(' & '), content: groupConv.gossipGenerated.content });
            }
          } catch (err) {
            console.error(`[group-conv:${locId}]`, err);
          }
        }
      }
    }

    // Update environmental awareness for all NPCs
    for (const npc of world.npcs) {
      const state = session.npcStates[npc.id];
      if (!state) continue;
      state.environmentalAwareness = state.environmentalAwareness ?? {
        knownScarcities: [],
        recentArrivals: [],
        recentDepartures: [],
        locationChanges: [],
        lastWeatherReaction: '',
      };
      // Weather reaction
      if (session.currentWeather) {
        state.environmentalAwareness.lastWeatherReaction = weatherWorldEffects(session.currentWeather).npcReaction;
      }
      // Track the player as a "recent arrival" if they're new
      if (session.dayCount <= 3 && !state.environmentalAwareness.recentArrivals.includes(session.playerName)) {
        state.environmentalAwareness.recentArrivals.push(session.playerName);
      }
    }

    const approachFeed = npcApproaches.map(a => ({ ty: 'approach', x: `${a.npcName} wants to talk: ${a.approach.message}` }));

    const events = [
      ...ticks.filter(t => t.lifeEvent).map(t => ({ npc: world.npcs.find(n => n.id === t.npcId)?.name ?? t.npcId, event: t.lifeEvent!, severity: 'major' as const })),
      ...proofCognition.summary.map(s => ({ ...s, severity: (s.event.includes('defense') ? 'major' : 'minor') as 'major' | 'minor' })),
      ...conversations.map(c => ({ npc: `${c.a} & ${c.b}`, event: c.summary, severity: 'major' as const })),
    ];
    const thoughts = cogResults.filter(c => c.thought).map(c => ({ npc: c.npc, thought: c.thought! }));
    const summary = [
      ...ticks.filter(t => t.lifeEvent).map(t => ({ npc: t.npcId, event: t.lifeEvent! })),
      ...thoughts.map(c => ({ npc: c.npc, event: `thought: "${c.thought}"` })),
      ...proofCognition.summary,
      ...conversations.map(c => ({ npc: `${c.a} & ${c.b}`, event: c.summary })),
    ];

    const compressedBodyHabitFeed = compressBodyHabitFeed(bodyHabitFeed);
    appendFeedEvents(session, [
      ...events.map(e => ({ ty: 'event', x: `${e.npc}: ${e.event}` })),
      ...thoughts.map(t => ({ ty: 'thought', x: `${t.npc}: ${t.thought}` })),
      ...conversations.filter(c => c.fragment).map(c => ({ ty: 'npc_talk', x: `${c.a} & ${c.b}: "${c.fragment}"` })),
      ...groupConversations.filter(gc => gc.fragment).map(gc => ({ ty: 'group_talk', x: `${gc.participants.join(', ')}: "${gc.fragment}"` })),
      ...gossipFeed.map(g => ({ ty: 'gossip', x: `${g.npc}: ${g.content}` })),
      ...pepFeed.map(p => ({ ty: 'pep', x: `${p.npc}: ${p.detail}` })),
      ...defenseFeed.map(d => ({ ty: 'defense', x: `${d.npc}: ${d.defense} — ${d.behaviour}` })),
      ...compressedBodyHabitFeed.map(b => ({ ty: 'event', x: b.detail })),
      ...approachFeed,
      { ty: 'decide', x: `Tick: ${ticks.length} social, ${cogResults.length + proofCognition.cognitive} cognitive` },
    ]);
    if (!view.inQuest) maybeCreateQuestHook(baseWorld, session);
    const questUpdate = advanceQuestEpisode(session, {
      kind: 'tick',
      locationId: currentLocationId,
      worldId: world.id,
      summary: 'world tick',
    });
    handleQuestUpdate(questUpdate);
    const worldQuestUpdate = advanceWorldQuest(session, {
      kind: 'tick',
      locationId: currentLocationId,
      worldId: world.id,
      summary: 'world tick',
    });
    const serializedAdventureUpdate = await advanceSerializedAdventureHook(session, world, { kind: 'tick', locationId: currentLocationId, summary: 'world tick' });

    const recap = summarizeWorldAdvance(world, session, [
      ...events.slice(0, 3).map(e => `${e.npc}: ${e.event}`),
      ...thoughts.slice(0, 2).map(t => `${t.npc} is thinking about something new.`),
      ...gossipFeed.slice(0, 2).map(g => `Rumor: ${g.content}`),
      ...npcApproaches.slice(0, 2).map(a => `${a.npcName} wants to talk.`),
    ]);

    persistSessionState(session);
    res.json({
      ticks: ticks.length,
      cognitive: cogResults.length + proofCognition.cognitive,
      ruminationAdvances: proofCognition.ruminationAdvances,
      memoryDrifts: proofCognition.memoryDrifts,
      defenseEpisodes: proofCognition.defenseEpisodes,
      trajectoryPoints: proofCognition.trajectoryPoints,
      contagionEvents: contagionEvents.length,
      conversations,
      groupConversations,
      agencyDecisions,
      npcApproaches,
      gossip: gossipFeed,
      pep: pepFeed,
      defenses: defenseFeed,
      bodyHabits: compressedBodyHabitFeed,
      events,
      thoughts,
      summary,
      feedEvents: session.feedEvents,
      recap,
      dramaLeads: deriveSessionLeads(world, session),
      quest: getQuestStatus(session),
      questUpdate,
      worldQuestUpdate,
      serializedAdventureUpdate,
    });
  } catch (err) {
    console.error('[tick]', err);
    res.status(500).json({ error: 'Simulation tick failed' });
  }
});

// ── Session state ───────────────────────────────────────────────────────────

app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const questBlock = globalQuestEntryBlock(session);
  if (questBlock.blocked) {
    res.status(409).json({ error: questBlock.message, quest: questBlock.quest });
    return;
  }
  const baseWorld = worlds.get(session.worldId);
  if (!baseWorld) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, baseWorld);
  activeWorldQuestForSessionFromWorld(session, baseWorld);
  activeSerializedAdventureForSessionFromWorld(session, baseWorld);
  const view = sessionRuntimeView(session, baseWorld);
  const world = view.world;
  const currentLocationId = view.locationId;
  refreshSessionActivity(session);

  const timeOfDay = resolveTimeOfDay(world, session.currentTime);
  if (!view.inQuest) syncNpcRoutinePresence(session, world, timeOfDay);
  ensureSessionWeather(session, baseWorld);
  const location = world.locations.find(l => l.id === currentLocationId);
  const playerPresences = view.inQuest && session.activeQuest
    ? listQuestPlayerPresences(session.activeQuest, session, world)
    : listWorldPlayerPresences(world, session);

  res.json({
    session: {
      ...session,
      npcStates: Object.fromEntries(
        Object.entries(session.npcStates).map(([id, s]) => [id, sanitiseNpcState(s)])
      ),
    },
    dramaLeads: deriveSessionLeads(world, session),
    quest: getQuestStatus(session),
    view: { inQuest: view.inQuest, worldId: world.id, locationId: currentLocationId },
    location,
    timeOfDay,
    npcsHere: world.npcs
      .filter(n => session.npcStates[n.id]?.currentLocationId === currentLocationId)
      .map(n => ({
        id: n.id,
        name: n.name,
        occupation: n.occupation,
        relationship: session.npcStates[n.id]?.relationship ?? 'stranger',
        mood: session.npcStates[n.id]?.mood ?? n.baselineMood,
      })),
    playerPresences,
    playersHere: playerPresences.filter(presence => presence.canCommunicate),
    connectedLocations: connectedLocationsFor(world, currentLocationId),
  });
});

app.get('/api/sessions/:id/leads', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  const baseWorld = worlds.get(session.worldId);
  if (!baseWorld) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, baseWorld);
  const view = sessionRuntimeView(session, baseWorld);
  const world = view.world;
  const timeOfDay = resolveTimeOfDay(world, session.currentTime);
  ensureSessionWeather(session, baseWorld);
  if (!view.inQuest) syncNpcRoutinePresence(session, world, timeOfDay);
  res.json({ leads: deriveSessionLeads(world, session), quest: getQuestStatus(session), view: { inQuest: view.inQuest, worldId: world.id, locationId: view.locationId } });
});

// ── NPC keyword search ──────────────────────────────────────────────────────

app.get('/api/sessions/:id/search-npcs', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  const q = (req.query.q as string ?? '').toLowerCase().trim();
  if (!q) { res.json({ results: [] }); return; }

  const results: { npcId: string; npcName: string; field: string; text: string }[] = [];
  const addHit = (npcId: string, npcName: string, field: string, text: string) => {
    if (text && text.toLowerCase().includes(q)) {
      results.push({ npcId, npcName, field, text: text.length > 120 ? text.slice(0, 120) + '...' : text });
    }
  };

  for (const npc of world.npcs) {
    const state = session.npcStates[npc.id];
    if (!state) continue;
    const name = npc.name;
    addHit(npc.id, name, 'name', npc.name);
    addHit(npc.id, name, 'occupation', npc.occupation ?? '');
    addHit(npc.id, name, 'mood', state.mood ?? '');
    addHit(npc.id, name, 'activity', state.currentActivity ?? '');
    addHit(npc.id, name, 'worry', state.currentWorry ?? '');
    addHit(npc.id, name, 'goal', state.currentGoal ?? '');
    addHit(npc.id, name, 'opinion', state.playerOpinion ?? '');
    addHit(npc.id, name, 'relationship', state.relationship ?? '');
    for (const m of state.memories ?? []) {
      addHit(npc.id, name, 'memory', m.summary ?? '');
    }
    for (const f of state.playerFacts ?? []) {
      addHit(npc.id, name, 'fact', f);
    }
    for (const g of state.gossipHeard ?? []) {
      addHit(npc.id, name, 'gossip', g.content ?? '');
    }
    for (const e of state.recentLifeEvents ?? []) {
      addHit(npc.id, name, 'life event', e);
    }
    if (state.innerLife) {
      addHit(npc.id, name, 'inner thought', state.innerLife.lastThought ?? '');
      addHit(npc.id, name, 'inner narrative', state.innerLife.selfNarrative ?? '');
      for (const v of state.innerLife.values ?? []) addHit(npc.id, name, 'value', v);
    }
    for (const goal of state.activeGoals ?? []) {
      addHit(npc.id, name, 'active goal', goal.description ?? '');
    }
  }

  res.json({ results: results.slice(0, 50) });
});

// ── Global player search (across all worlds) ────────────────────────────────

const SEARCH_PROVIDER_MODELS: Record<string, { label: string; models: string[] }> = {
  mistral: { label: 'Mistral', models: ['mistral-small-latest', 'mistral-large-latest'] },
  nvidia: { label: 'NVIDIA', models: ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct'] },
  anthropic: { label: 'Claude', models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'] },
  openai: { label: 'OpenAI', models: ['gpt-4o-mini', 'gpt-4o'] },
  ollama: { label: 'Ollama', models: ['llama3', 'llama3.1', 'mistral'] },
};

app.get('/api/search-players', (req, res) => {
  const q = (req.query.q as string ?? '').toLowerCase().trim();
  if (!q) { res.json({ results: [] }); return; }

  const results: {
    type: 'player' | 'world';
    title: string;
    subtitle: string;
    badge: string;
    playerName: string;
    sessionId: string;
    worldId: string;
    worldConcept: string;
    occupation: string;
    location: string;
    isLive: boolean;
    lastActive: string | null;
  }[] = [];

  for (const world of worlds.values()) {
    const providerInfo = SEARCH_PROVIDER_MODELS[world.provider] ?? { label: world.provider, models: [] };
    const searchable = [
      world.concept,
      world.provider,
      providerInfo.label,
      ...providerInfo.models,
      world.era?.period,
      world.geography?.region,
      world.populationBlueprint?.communityType,
      world.realWorldFacts,
      ...(world.sourceDocuments ?? []).map(doc => doc.title),
    ].filter(Boolean).join(' ').toLowerCase();
    if (!searchable.includes(q)) continue;
    const modelHit = providerInfo.models.find(model => model.toLowerCase().includes(q));
    results.push({
      type: 'world',
      title: world.concept,
      subtitle: [
        providerInfo.label || world.provider,
        modelHit ? `model ${modelHit}` : undefined,
        world.geography?.region,
        `${world.npcs.length} NPCs`,
      ].filter(Boolean).join(' · '),
      badge: modelHit ? 'model' : providerInfo.label || world.provider,
      playerName: world.concept,
      sessionId: '',
      worldId: world.id,
      worldConcept: world.concept,
      occupation: modelHit ? modelHit : world.provider,
      location: world.geography?.region ?? '',
      isLive: false,
      lastActive: world.createdAt ?? null,
    });
  }

  const seen = new Set<string>();
  for (const [, session] of sessions) {
    const key = `${session.playerName}::${session.worldId}`;
    if (seen.has(key)) continue;
    const name = (session.playerName ?? '').toLowerCase();
    const occ = (session.playerOccupation ?? '').toLowerCase();
    if (!name.includes(q) && !occ.includes(q)) continue;
    seen.add(key);
    const world = worlds.get(session.worldId);
    const locationName = world?.locations.find(l => l.id === session.currentLocationId)?.name ?? '';
    results.push({
      type: 'player',
      title: session.playerName,
      subtitle: [world?.concept ?? '', locationName].filter(Boolean).join(' · '),
      badge: isCharacterSessionActive(session) ? 'online' : 'player',
      playerName: session.playerName,
      sessionId: session.id,
      worldId: session.worldId,
      worldConcept: world?.concept ?? '',
      occupation: session.playerOccupation ?? '',
      location: locationName,
      isLive: isCharacterSessionActive(session),
      lastActive: session.lastActiveAt ?? null,
    });
  }

  results.sort((a, b) => (b.isLive ? 1 : 0) - (a.isLive ? 1 : 0) || (a.type === 'world' ? -1 : 1));
  res.json({ results: results.slice(0, 50) });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function gossipSeriousness(gossip: Pick<GossipItem, 'content' | 'sentiment'>): number {
  let score = gossip.sentiment === 'warning' ? 3 : gossip.sentiment === 'negative' ? 2 : 1;
  if (/\b(affair|blackmail|secret|expose|caught|scandal|lie|lied|frame|accuse|blame|theft|stole|violence|pregnant|betray)\b/i.test(gossip.content)) {
    score += 2;
  }
  return clamp(score, 1, 5);
}

function hasHeardGossip(state: NPCLiveState, gossip: GossipItem): boolean {
  const content = gossip.content.trim().toLowerCase();
  return (state.gossipHeard ?? []).some(g => g.content.trim().toLowerCase() === content);
}

function addGossipToNpcState(state: NPCLiveState, gossip: GossipItem): boolean {
  if (hasHeardGossip(state, gossip)) return false;
  state.gossipHeard = state.gossipHeard ?? [];
  state.gossipHeard.push(gossip);
  if (state.gossipHeard.length > 30) state.gossipHeard = state.gossipHeard.slice(-30);
  return true;
}

function resolveTimeOfDay(world: WorldDNA, hour: number): string {
  const period = world.timeOfDay?.periods?.find(p =>
    p.hourStart <= p.hourEnd
      ? hour >= p.hourStart && hour < p.hourEnd
      : hour >= p.hourStart || hour < p.hourEnd
  );
  if (period?.name) return period.name;
  const safeHour = ((Math.floor(hour) % 24) + 24) % 24;
  if (safeHour < 5) return 'night';
  if (safeHour < 12) return 'morning';
  if (safeHour < 17) return 'afternoon';
  if (safeHour < 21) return 'evening';
  return 'night';
}

function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function findNpcByLooseName(world: WorldDNA, value: string): WorldNPC | undefined {
  const wanted = value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!wanted) return undefined;
  return world.npcs.find(n => n.name.toLowerCase() === wanted)
    ?? world.npcs.find(n => {
      const name = n.name.toLowerCase();
      return name.includes(wanted) || wanted.includes(name);
    });
}

type TroubleIntent = {
  kind: 'gossip' | 'accusation' | 'lie' | 'exposure' | 'trickery' | 'provocation' | 'affair';
  content: string;
  namedTarget?: string;
  isTrue: boolean;
};

function detectTroubleIntent(message: string): TroubleIntent | null {
  const text = message.trim();
  const patterns: Array<[RegExp, TroubleIntent['kind'], boolean]> = [
    [/^(?:spread gossip|start gossip|start a rumou?r|gossip)\s*:?\s*(.+)$/i, 'gossip', false],
    [/^(?:lie|make up a lie|tell a lie)\s*:?\s*(.+)$/i, 'lie', false],
    [/^(?:trick|con|set up|frame|blackmail)\s+(.+?)\s*:?\s*(.+)$/i, 'trickery', false],
    [/^(?:accuse|blame)\s+(.+?)\s+(?:of|for|about)\s+(.+)$/i, 'accusation', false],
    [/^(?:expose|reveal)\s+(.+?)\s+(?:secret|affair|lie)\s*:?\s*(.*)$/i, 'exposure', true],
    [/^(?:stir trouble|cause trouble|provoke|wind up)\s*:?\s*(.+)$/i, 'provocation', false],
    [/^(?:flirt with|make a pass at|hint at an affair with)\s+(.+)$/i, 'affair', false],
  ];

  for (const [regex, kind, isTrue] of patterns) {
    const match = text.match(regex);
    if (!match) continue;
    if (match.length >= 3) {
      return { kind, namedTarget: match[1].trim(), content: match[2].trim() || text, isTrue };
    }
    return { kind, content: match[1].trim(), isTrue };
  }
  return null;
}

function troubleLabel(kind: TroubleIntent['kind']): string {
  return kind === 'gossip' ? 'Gossip started'
    : kind === 'accusation' ? 'Accusation made'
      : kind === 'lie' ? 'Lie planted'
        : kind === 'exposure' ? 'Secret exposed'
          : kind === 'trickery' ? 'Trickery attempted'
            : kind === 'affair' ? 'Affair rumor stirred'
              : 'Trouble stirred';
}

function applyPlayerTroublemaking(args: {
  world: WorldDNA;
  session: WorldSession;
  sourceNpc: WorldNPC;
  sourceState: NPCLiveState;
  message: string;
  interactionKind: string;
  timeOfDay: string;
  bystanderNpcs: WorldNPC[];
  locationId: string;
  objectiveEventId: string;
}): { consequences: import('./types.js').ConsequenceSummary[] } {
  const detected = detectTroubleIntent(args.message);
  if (!detected || !['speech', 'action'].includes(args.interactionKind)) return { consequences: [] };

  const namedTarget = detected.namedTarget ? findNpcByLooseName(args.world, detected.namedTarget) : undefined;
  const targetNpc = namedTarget ?? args.sourceNpc;
  const content = detected.kind === 'affair'
    ? `${args.session.playerName} is stirring talk of an affair involving ${targetNpc.name}.`
    : detected.content;
  const sentiment = detected.kind === 'exposure' ? 'warning'
    : detected.kind === 'lie' || detected.kind === 'trickery' || detected.kind === 'accusation' ? 'negative'
      : 'curious';

  const gossip = {
    fromNpcId: args.sourceNpc.id,
    content,
    date: args.session.currentDate,
    sentiment,
    isTrue: detected.isTrue,
  } as const;
  const seriousness = gossipSeriousness(gossip);
  args.session.activeGossip.push(gossip);
  if (args.session.activeGossip.length > 30) args.session.activeGossip = args.session.activeGossip.slice(-30);

  const currentLocation = args.world.locations.find(l => l.id === args.locationId);
  const privacy = (currentLocation?.privacyLevel ?? '').toLowerCase();
  const privacyMultiplier = privacy.includes('private') ? 0.35
    : privacy.includes('secluded') ? 0.5
      : privacy.includes('public') ? 1.15
        : 0.8;
  const overhearChance = clamp((0.12 + seriousness * 0.11 + args.world.simulationRules.gossipSpeed * 0.25) * privacyMultiplier, 0.05, 0.85);
  const immediateHearerIds = new Set<string>([args.sourceNpc.id]);
  for (const bystander of args.bystanderNpcs) {
    if (Math.random() < overhearChance) immediateHearerIds.add(bystander.id);
  }

  for (const npcId of immediateHearerIds) {
    const state = args.session.npcStates[npcId];
    if (!state) continue;
    addGossipToNpcState(state, gossip);
    if (npcId === args.sourceNpc.id) {
      state.trustLevel = clamp(state.trustLevel - (detected.kind === 'exposure' ? 2 : 5), 0, 100);
      state.warmth = clamp(state.warmth - (detected.kind === 'affair' ? 3 : 6), 0, 100);
      state.fear = clamp(state.fear + (detected.kind === 'trickery' || detected.kind === 'lie' ? 8 : 4), 0, 100);
      state.playerOpinion = `${args.session.playerName} is willing to ${troubleLabel(detected.kind).toLowerCase()}.`;
    }
    if (npcId === targetNpc.id && targetNpc.id !== args.sourceNpc.id) {
      state.recentLifeEvents.push(`${args.session.playerName} stirred trouble about them: ${content}`);
      state.fear = clamp(state.fear + 6, 0, 100);
    }
  }

  const event = `${args.session.playerName}: ${troubleLabel(detected.kind)} - ${content}`;
  const affectedNpcIds = Array.from(new Set([targetNpc.id, ...immediateHearerIds]));
  args.session.significantEvents.push(event);
  if (args.session.significantEvents.length > 20) args.session.significantEvents = args.session.significantEvents.slice(-20);
  args.session.reputation = detected.kind === 'exposure' ? 'dangerously informed'
    : detected.kind === 'lie' || detected.kind === 'trickery' ? 'untrustworthy'
      : args.session.reputation === 'unknown' ? 'troublemaker' : args.session.reputation;

  recordObjectiveEvent(args.session, {
    type: 'gossip',
    date: args.session.currentDate,
    timeOfDay: args.timeOfDay,
    locationId: args.locationId,
    actorId: 'player',
    targetIds: affectedNpcIds,
    summary: event,
    detail: `${args.message}\nSeeded with: ${Array.from(immediateHearerIds).join(', ')}\nSource event: ${args.objectiveEventId}`,
    tags: ['player_trouble', detected.kind, `seriousness_${seriousness}`, detected.isTrue ? 'claimed_true' : 'possibly_false'],
  });

  appendFeedEvents(args.session, [{ ty: 'gossip', x: event }]);
  return {
    consequences: [
      {
        type: detected.kind === 'exposure' || detected.kind === 'affair' ? 'scandal' : detected.kind,
        label: troubleLabel(detected.kind),
        detail: content,
        severity: detected.kind === 'gossip' ? 'warning' : 'negative',
      },
      {
        type: 'reputation',
        label: 'Reputation risk',
        detail: `People may now see you as ${args.session.reputation}.`,
        severity: 'warning',
      },
    ],
  };
}

function routineActivityForTime(npc: { dailyRoutine: any }, timeOfDay: string): string | undefined {
  const t = timeOfDay.toLowerCase();
  if (t.includes('morning') || t.includes('dawn')) return npc.dailyRoutine?.morning;
  if (t.includes('afternoon') || t.includes('midday')) return npc.dailyRoutine?.afternoon ?? npc.dailyRoutine?.morning;
  if (t.includes('evening') || t.includes('dusk')) return npc.dailyRoutine?.evening ?? npc.dailyRoutine?.afternoon;
  if (t.includes('night')) return npc.dailyRoutine?.night ?? npc.dailyRoutine?.evening;
  return npc.dailyRoutine?.morning;
}

function resolveNPCLocationByTime(
  npc: { id?: string; homeLocationId: string; workLocationId: string; frequentedLocations?: string[]; dailyRoutine: any },
  timeOfDay: string,
  dayKey = '',
  allLocationIds?: string[],
): string {
  const t = timeOfDay.toLowerCase();
  const freq = npc.frequentedLocations ?? [];
  const roll = (salt: string) => (stableHash(`${npc.id ?? npc.homeLocationId}:${dayKey}:${t}:${salt}`) % 1000) / 1000;
  const workLoc = npc.workLocationId;
  const homeLoc = npc.homeLocationId;
  const spreadLoc = allLocationIds?.length ? allLocationIds[stableHash(npc.id ?? '') % allLocationIds.length] : undefined;
  if (t.includes('morning') || t.includes('dawn')) {
    const r = roll('morning');
    if (r > 0.6) return workLoc;
    if (r > 0.3) return spreadLoc ?? workLoc;
    return homeLoc;
  }
  if (t.includes('afternoon') || t.includes('midday')) {
    const r = roll('afternoon');
    if (r > 0.5) return workLoc;
    if (r > 0.25) return spreadLoc ?? (freq[0] ?? workLoc);
    return freq[0] ?? workLoc;
  }
  if (t.includes('evening') || t.includes('dusk')) return freq.length ? (freq[stableHash(`${npc.id ?? npc.homeLocationId}:${dayKey}:${t}:evening`) % freq.length] ?? homeLoc) : (spreadLoc ?? homeLoc);
  return spreadLoc ?? homeLoc;
}

function syncNpcRoutinePresence(session: WorldSession, world: WorldDNA, timeOfDay: string) {
  const locationIds = world.locations.map(l => l.id);
  for (const npc of world.npcs) {
    const state = session.npcStates[npc.id];
    if (!state) continue;
    state.currentLocationId = resolveNPCLocationByTime(npc, timeOfDay, session.currentDate, locationIds);
    state.currentActivity = routineActivityForTime(npc, timeOfDay) ?? state.currentActivity;
  }
  ensurePlayerLocationNpcPresence(session, world, session.currentLocationId, timeOfDay);
}

function ensurePlayerLocationNpcPresence(session: WorldSession, world: WorldDNA, locationId: string, timeOfDay: string): void {
  if (!locationId || !world.npcs.length || !world.locations.some(location => location.id === locationId)) return;
  const validLocationIds = new Set(world.locations.map(location => location.id));
  const fallbackLocationId = world.locations[0]?.id ?? locationId;
  for (const npc of world.npcs) {
    const state = session.npcStates[npc.id];
    if (state && !validLocationIds.has(state.currentLocationId)) state.currentLocationId = fallbackLocationId;
  }
  if (world.npcs.some(npc => session.npcStates[npc.id]?.currentLocationId === locationId)) return;
  const location = world.locations.find(item => item.id === locationId);
  const scored = world.npcs
    .map(npc => {
      const preferred = [npc.homeLocationId, npc.workLocationId, ...(npc.frequentedLocations ?? [])].includes(locationId);
      const typeFit = location?.type && String(npc.occupation ?? '').toLowerCase().includes(String(location.type).toLowerCase());
      return { npc, score: (preferred ? 20 : 0) + (typeFit ? 8 : 0) + (stableHash(`${npc.id}:${locationId}:${session.currentDate}`) % 7) };
    })
    .sort((a, b) => b.score - a.score);
  const chosen = scored[0]?.npc;
  if (!chosen) return;
  const state = session.npcStates[chosen.id];
  if (!state) return;
  state.currentLocationId = locationId;
  state.currentActivity = routineActivityForTime(chosen, timeOfDay) ?? `present at ${location?.name ?? 'this location'}`;
}

function ensureSessionWeather(session: WorldSession, world: WorldDNA) {
  session.currentWeather = session.currentWeather ?? initialWeather(world, session.currentDate, session.currentTime);
}

function npcsAtLocation(world: WorldDNA, session: WorldSession, locationId: string) {
  return world.npcs.filter(n => session.npcStates[n.id]?.currentLocationId === locationId);
}

function noteNpcExperience(
  session: WorldSession,
  npcId: string,
  text: string,
  options: { thought?: string; currentWorry?: string; currentGoal?: string; playerOpinion?: string } = {},
): void {
  const state = session.npcStates[npcId];
  if (!state) return;
  state.recentLifeEvents = [...(state.recentLifeEvents ?? []), text.slice(0, 240)].slice(-30);
  if (options.currentWorry) state.currentWorry = options.currentWorry;
  if (options.currentGoal) state.currentGoal = options.currentGoal;
  if (options.playerOpinion) state.playerOpinion = options.playerOpinion;
  if (options.thought && state.innerLife) state.innerLife.lastThought = options.thought.slice(0, 240);
}

function addPlayerWitnessMemory(
  session: WorldSession,
  witnessNpcId: string,
  summary: string,
  detail: string,
  sourceEventId: string,
  locationId: string,
  timeOfDay: string,
  tone = 'observant',
): void {
  const state = session.npcStates[witnessNpcId];
  if (!state) return;
  const clippedSummary = summary.slice(0, 200);
  const clippedDetail = smartTrim(detail, 1200);
  const memory: NPCMemory = {
    id: randomUUID(),
    npcId: witnessNpcId,
    worldId: state.worldId ?? session.worldId,
    inWorldDate: session.currentDate,
    realTimestamp: new Date().toISOString(),
    summary: clippedSummary,
    detail: clippedDetail,
    emotionalTone: tone,
    playerMessage: '[witnessed player action]',
    interactionKind: 'action',
    npcReply: '',
    playerRevealed: [],
    npcRevealed: [],
    topicsCovered: ['witnessed player action'],
    trustDelta: 0,
    significantMoment: tone !== 'observant',
    npcThoughtAfter: clippedDetail,
    sourceEventId,
    groundTruthSummary: clippedSummary,
    currentReconstruction: clippedSummary,
    driftHistory: [],
    biasTags: ['witness', 'player_action'],
    realityGap: 0,
    locationId,
    timeOfDay,
    othersPresent: [],
    isWitnessed: true,
    witnessedParticipants: [],
  };
  state.memories = [...(state.memories ?? []), memory].slice(-20);
}

function addGodMemory(session: WorldSession, npcId: string, summary: string, detail: string, tone = 'uncanny') {
  const state = session.npcStates[npcId];
  if (!state) return;
  state.memories.push({
    id: randomUUID(),
    npcId,
    worldId: state.worldId ?? session.worldId,
    inWorldDate: session.currentDate,
    realTimestamp: new Date().toISOString(),
    summary,
    detail,
    emotionalTone: tone,
    playerMessage: '[god effect]',
    interactionKind: 'action',
    npcReply: '',
    playerRevealed: ['impossible power'],
    npcRevealed: [],
    topicsCovered: ['miracle', 'supernatural control'],
    trustDelta: 0,
    significantMoment: true,
    npcThoughtAfter: detail,
    locationId: state.currentLocationId ?? session.currentLocationId,
    timeOfDay: String(session.currentTime),
    othersPresent: [],
  });
  if (state.memories.length > 20) state.memories = state.memories.slice(-20);
}

function addNpcConversationMemory(
  session: WorldSession,
  npcId: string,
  otherNpcId: string,
  otherNpcName: string,
  summary: string,
  detail: string,
  sourceEventId: string,
  locationId: string,
  timeOfDay: string,
  relationshipShift: number,
) {
  const state = session.npcStates[npcId];
  if (!state) return;
  // Guard against orphan otherNpcId — the value goes into memory.othersPresent
  // which is read elsewhere as an NPC ID array. If otherNpcId is not a known
  // NPC in this session, dropping the memory is preferable to persisting an
  // orphan reference that will surface later as a "no such NPC" 404.
  if (!session.npcStates[otherNpcId]) return;
  const otherName = otherNpcName || otherNpcId;
  const memory: NPCMemory = {
    id: randomUUID(),
    npcId,
    worldId: state.worldId ?? session.worldId,
    inWorldDate: session.currentDate,
    realTimestamp: new Date().toISOString(),
    summary,
    detail,
    emotionalTone: relationshipShift > 0 ? 'warmer' : relationshipShift < 0 ? 'tense' : 'neutral',
    playerMessage: `Overheard ${otherName} in conversation.`,
    interactionKind: 'speech',
    npcReply: '',
    playerRevealed: [],
    npcRevealed: [],
    topicsCovered: ['conversation nearby'],
    trustDelta: relationshipShift,
    significantMoment: Math.abs(relationshipShift) >= 3,
    npcThoughtAfter: detail,
    sourceEventId,
    groundTruthSummary: summary,
    currentReconstruction: summary,
    driftHistory: [],
    biasTags: ['conversation'],
    realityGap: 0,
    locationId,
    timeOfDay,
    othersPresent: [otherNpcId],
  };
  state.memories.push(memory);
  if (state.memories.length > 20) state.memories = state.memories.slice(-20);
}

function bendEmotion(state: NPCLiveState, emotion: string, amount: number) {
  const affect: any = state.innerLife?.affect;
  if (!affect) return;
  affect.valence = emotion === 'dread' || emotion === 'fear' || emotion === 'grief' ? -0.7 : emotion === 'desire' ? 0.55 : 0.7;
  affect.arousal = Math.max(affect.arousal ?? 0, emotion === 'calm' ? 0.15 : 0.92);
  affect.dominance = emotion === 'desire' ? 0.25 : affect.dominance ?? 0.5;
  if (emotion in affect) affect[emotion] = amount;
  if (emotion === 'dread') affect.fear = amount;
  if (emotion === 'devotion') { affect.trust = amount; affect.tenderness = Math.max(affect.tenderness ?? 0, 0.75); }
  if (emotion === 'grief') affect.sadness = amount;
  state.mood = emotion === 'desire' ? 'overwhelmed' : emotion;
}

function applyGodEffect(session: WorldSession, world: WorldDNA, effect: string, targetIds: string[], text: string, emotion: string, locationId = session.currentLocationId): string {
  const targets = targetIds.filter(id => session.npcStates[id]);
  session.activeGodEffects = session.activeGodEffects ?? [];
  const loc = world.locations.find(l => l.id === locationId)?.name ?? 'this place';
  let label = 'Nothing happened.';

  if (effect === 'overwhelming_desire') {
    for (const id of targets) {
      const state = session.npcStates[id];
      bendEmotion(state, 'desire', 1);
      state.attraction = clamp(state.attraction + 35, 0, 100);
      state.warmth = clamp(state.warmth + 15, 0, 100);
      state.currentGoal = `stay near ${session.playerName}`;
      state.playerOpinion = `${session.playerName} has become almost unbearably compelling until they leave.`;
      addGodMemory(session, id, `${session.playerName} filled the room with overwhelming desire.`, 'The feeling was not ordinary want; it arrived like weather inside the body.', 'desire');
    }
    session.activeGodEffects.push({ id: randomUUID(), type: effect, label: 'overwhelming desire', locationId, activeUntil: 'leave_location', startedAt: session.currentDate });
    label = `Overwhelming desire fills ${loc} until you leave.`;
  } else if (effect === 'emotion_room') {
    for (const id of targets) {
      bendEmotion(session.npcStates[id], emotion, 0.9);
      addGodMemory(session, id, `${session.playerName} changed the feeling of the room to ${emotion}.`, `The air itself seemed to become ${emotion}.`, emotion);
    }
    label = `The room is flooded with ${emotion}.`;
  } else if (effect === 'implant_dream') {
    for (const id of targets) {
      const dream = text || `${session.playerName} standing under impossible light`;
      const state = session.npcStates[id];
      state.recentLifeEvents.push(`Dreamed of ${dream}.`);
      state.innerLife.dreams = state.innerLife.dreams ?? [];
      state.innerLife.dreams.push({
        id: randomUUID(),
        date: session.currentDate,
        content: dream,
        emotionalTone: 'dreamlike',
        processedInsight: 'It felt private, but it did not feel self-made.',
        mentionedInDialogue: false,
      });
      state.innerLife.dreams = state.innerLife.dreams.slice(-10);
      state.innerLife.lastDreamDate = session.currentDate;
      state.innerLife.lastThought = `Why did I dream of ${dream}?`;
      addGodMemory(session, id, `Had an implanted dream of ${dream}.`, 'It felt private, but it did not feel self-made.', 'dreamlike');
    }
    label = 'Dream implanted.';
  } else if (effect === 'erase_memory') {
    for (const id of targets) {
      session.npcStates[id].memories = [];
      session.npcStates[id].playerOpinion = 'There is a blankness where certainty should be.';
      if (session.npcStates[id].innerLife) {
        session.npcStates[id].innerLife.lastThought = `I know ${session.playerName} matters, but the memory will not hold still.`;
      }
    }
    label = 'Memory erased.';
  } else if (effect === 'alter_memory') {
    for (const id of targets) {
      addGodMemory(session, id, text || `${session.playerName} has always belonged here.`, 'This memory feels old, though it was born just now.', 'uncanny');
      session.npcStates[id].playerOpinion = text || `${session.playerName} feels familiar, as if they were always here.`;
    }
    label = 'Memory altered.';
  } else if (effect === 'appear_behind') {
    session.playerAppearance = `${session.playerAppearance ?? 'ordinary'}; appears behind people without crossing the room`;
    for (const id of targets) {
      bendEmotion(session.npcStates[id], 'surprise', 0.95);
      addGodMemory(session, id, `${session.playerName} appeared behind them.`, 'No footstep. No door. Just presence.', 'shocked');
    }
    label = 'You appear behind them.';
  } else if (effect === 'unseen') {
    session.playerAppearance = 'unseen except by the chosen';
    session.strangePossessions = Array.from(new Set([...(session.strangePossessions ?? []), 'can become unseen']));
    label = 'You become unseen.';
  } else if (effect === 'conjure') {
    const thing = text || 'an impossible relic';
    session.strangePossessions = Array.from(new Set([...(session.strangePossessions ?? []), `conjured ${thing}`])).slice(-10);
    session.significantEvents.push(`${session.playerName} conjured ${thing} at ${loc}.`);
    label = `Conjured ${thing}.`;
  } else if (effect === 'reveal_secret') {
    for (const id of targets) {
      const npc = world.npcs.find(n => n.id === id);
      const secret = npc?.secrets?.[0] ?? 'a truth they did not want known';
      session.npcStates[id].currentWorry = `Their secret may be known: ${secret}`;
      bendEmotion(session.npcStates[id], 'fear', 0.75);
      addGodMemory(session, id, `${session.playerName} revealed a secret.`, secret, 'exposed');
    }
    label = 'Secrets revealed.';
  } else if (effect === 'bless') {
    for (const id of targets) {
      const state = session.npcStates[id];
      state.warmth = clamp(state.warmth + 20, 0, 100);
      bendEmotion(state, 'gratitude', 0.85);
      state.recentLifeEvents.push(`${session.playerName} marked them with good fortune.`);
    }
    label = 'Blessing given.';
  } else if (effect === 'curse') {
    for (const id of targets) {
      const state = session.npcStates[id];
      state.fear = clamp(state.fear + 30, 0, 100);
      bendEmotion(state, 'fear', 0.9);
      state.recentLifeEvents.push(`${session.playerName} marked them with misfortune.`);
    }
    label = 'Curse placed.';
  } else if (effect === 'reputation') {
    session.reputation = text || 'impossible stranger';
    label = `Reputation changed to ${session.reputation}.`;
  }

  session.significantEvents.push(label);
  if (session.significantEvents.length > 20) session.significantEvents = session.significantEvents.slice(-20);
  return label;
}

function clearLeaveLocationGodEffects(session: WorldSession, locationId: string) {
  const effects = session.activeGodEffects ?? [];
  const leaving = effects.filter(e => e.activeUntil === 'leave_location' && e.locationId === locationId);
  if (leaving.some(e => e.type === 'overwhelming_desire')) {
    for (const state of Object.values(session.npcStates)) {
      const affect: any = state.innerLife?.affect;
      if (affect?.desire) { affect.desire = 0; affect.arousal = Math.min(affect.arousal ?? 0.3, 0.4); }
      if (state.currentGoal?.includes(session.playerName)) state.currentGoal = state.currentWorry || 'recover composure';
      if (state.mood === 'overwhelmed') state.mood = 'unsettled';
    }
    session.significantEvents.push('The overwhelming desire faded when you left.');
  }
  session.activeGodEffects = effects.filter(e => !(e.activeUntil === 'leave_location' && e.locationId === locationId));
}

function detectImpossibleGift(message: string, kind: 'speech' | 'gesture' | 'action' | 'silence' | 'presence'): string | null {
  if (kind !== 'action') return null;
  const text = message.trim();
  if (!/(gift|give|offer|present|hand|produce|summon|conjure|impossible|magical|miracle|from nowhere|out of nothing)/i.test(text)) return null;
  if (!/(impossible|magical|miracle|glowing|enchanted|from nowhere|out of nothing|summon|conjure|appears|never-ending|eternal|living|golden|star|moon|memory|dream)/i.test(text)) return null;
  return text
    .replace(/^\s*(offer|give|present|hand|produce|summon|conjure)\s+(an?\s+)?(impossible|magical|miracle|enchanted)?\s*gift\s*:?\s*/i, '')
    .replace(/^\s*(an?\s+)?(impossible|magical|miracle|enchanted)\s*gift\s*:?\s*/i, '')
    .trim()
    .slice(0, 160) || text.slice(0, 160);
}

type GiftJudgement = { accepted: boolean; hint: string; reason: string };

function activeImpossibleGiftObjective(session: WorldSession, npcId: string) {
  const quest = session.activeQuest?.status === 'active' ? session.activeQuest : undefined;
  const objective = quest?.objectives.find(o => o.status === 'active' && o.requirements?.some(req => req.kind === 'impossible_gift' && req.npcId === npcId));
  const requirement = objective?.requirements?.find((req): req is Extract<QuestRequirement, { kind: 'impossible_gift' }> => req.kind === 'impossible_gift' && req.npcId === npcId);
  return requirement && objective && quest ? { quest, objective, requirement } : undefined;
}

function fallbackGiftJudgement(gift: string, requirement: Extract<QuestRequirement, { kind: 'impossible_gift' }>, world: WorldDNA, npc: WorldNPC, attempts: number): GiftJudgement {
  const text = String(gift || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const pattern = String(requirement.giftPattern ?? requirement.hintText ?? requirement.requestText ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const impossible = /\b(impossible|magical|miracle|star|moon|sun|memory|dream|future|past|thunder|storm|living|eternal|never-ending|ghost|shadow|time|world|sky|rain|snow|flame|singing|glowing)\b/i.test(text);
  const relevant = !pattern || pattern.split(/\W+/).filter((w: string) => w.length > 3).some((w: string) => text.includes(w));
  const accepted = impossible && relevant;
  const hint = accepted
    ? `${npc.name} accepts the impossible gift; the hidden clue opens.`
    : attempts >= 2
      ? `They need ${requirement.hintText ?? requirement.requestText ?? 'a gift that truly breaks this world and matters to the clue'}.`
      : `${npc.name} studies it, but it does not feel impossible enough for ${world.concept}.`;
  return { accepted, hint, reason: accepted ? 'fallback accepted impossible and relevant gift' : 'fallback rejected weak fit' };
}

async function judgeImpossibleGift(args: {
  gift: string;
  requirement: Extract<QuestRequirement, { kind: 'impossible_gift' }>;
  world: WorldDNA;
  npc: WorldNPC;
  questName: string;
  attempts: number;
  provider: string;
  model?: string;
}): Promise<GiftJudgement> {
  try {
    const result = await llmJSON<GiftJudgement>({
      provider: args.provider,
      model: args.model,
      temperature: 0.25,
      maxTokens: 420,
      system: 'Judge whether an impossible gift fits a quest gate. Accept strange, absurd, poetic gifts if they fit world impossibility, NPC emotional relevance, and quest clue relevance. Do not reject offensive, dark, or weird text just for style; judge in-world fit.',
      user: JSON.stringify({
        gift: args.gift,
        world: { concept: args.world.concept, era: args.world.era, culture: args.world.culture },
        npc: { name: args.npc.name, occupation: args.npc.occupation, personality: args.npc.personality, coreWound: args.npc.coreWound },
        questName: args.questName,
        requirement: args.requirement,
        attempts: args.attempts,
        returnShape: { accepted: 'boolean', hint: 'short in-world hint', reason: 'short judgement reason' },
      }),
    });
    return {
      accepted: !!result.accepted,
      hint: String(result.hint || (result.accepted ? `${args.npc.name} accepts the impossible gift.` : `${args.npc.name} hesitates; the gift is not right yet.`)).slice(0, 240),
      reason: String(result.reason || '').slice(0, 240),
    };
  } catch {
    return fallbackGiftJudgement(args.gift, args.requirement, args.world, args.npc, args.attempts);
  }
}

function sanitiseNpcState(state: NPCLiveState) {
  const bodyHabits = state.bodyHabits ? {
    ...state.bodyHabits,
    recentEvents: (state.bodyHabits.recentEvents ?? []).slice(-8),
    toiletVisits: (state.bodyHabits.toiletVisits ?? []).slice(-12),
    bowelMovements: (state.bodyHabits.bowelMovements ?? []).slice(-12),
  } : undefined;
  return {
    npcId: state.npcId,
    relationship: state.relationship,
    mood: state.mood,
    totalInteractions: state.totalInteractions,
    daysSinceLastSeen: state.daysSinceLastSeen,
    isAvailable: state.isAvailable,
    activeConversation: state.activeConversation ?? [],
    conversationHistory: conversationHistoryFromState(state),
    bodyHabits,
  };
}


// ── World full state (for Observatory) ──────────────────────────────────────

app.get('/api/sessions/:id/full', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const questBlock = globalQuestEntryBlock(session);
  if (questBlock.blocked) {
    res.status(409).json({ error: questBlock.message, quest: questBlock.quest });
    return;
  }
  const baseWorld = worlds.get(session.worldId);
  if (!baseWorld) { res.status(404).json({ error: 'World not found' }); return; }
  syncSessionFromWorld(session, baseWorld);
  activeWorldQuestForSessionFromWorld(session, baseWorld);
  activeSerializedAdventureForSessionFromWorld(session, baseWorld);
  const view = sessionRuntimeView(session, baseWorld);
  const world = view.world;
  const currentLocationId = view.locationId;
  refreshSessionActivity(session);
  const npcImagesChanged = ensureNpcImages(world);
  if (npcImagesChanged && !view.inQuest) saveWorld(world);

  const timeOfDay = resolveTimeOfDay(world, session.currentTime);
  ensureSessionWeather(session, baseWorld);
  if (!view.inQuest) syncNpcRoutinePresence(session, world, timeOfDay);
  const resources = deriveResourceProfile(world);
  const location = world.locations.find(l => l.id === currentLocationId);

  // Full NPC states including inner life for Observatory
  const npcFull = world.npcs.map(npc => {
    const state = session.npcStates[npc.id];
    return {
      ...npc,
      state: state ? {
        ...state,
        currentLocationId: state.currentLocationId ?? resolveNPCLocationByTime(npc, timeOfDay, undefined, world.locations?.map((l:any)=>l.id)),
      } : null,
    };
  });
  const npcsHere = npcFull
    .filter(n => n.state?.currentLocationId === currentLocationId)
    .map(n => ({
      id: n.id,
      name: n.name,
      occupation: n.occupation,
      relationship: n.state?.relationship ?? 'stranger',
      mood: n.state?.mood ?? n.baselineMood,
    }));
  let soundscape: SoundscapeManifest | null = null;
  if (location) {
    try {
      soundscape = await generateSoundscape(
        location,
        session.currentWeather,
        session.currentTime,
        npcsHere.length,
        world.provider,
        undefined,
        world.concept,
        world.id,
      );
    } catch (err) {
      console.error('[soundscape:full]', err);
    }
  }

  const npcStates = Object.fromEntries(
    Object.entries(session.npcStates).map(([id, state]) => [id, state])
  );
  const realityGapMetrics = Object.fromEntries(
    Object.entries(session.npcStates).map(([id, state]) => [id, getRealityGapMetric(state)])
  );
  const playerPresences = view.inQuest && session.activeQuest
    ? listQuestPlayerPresences(session.activeQuest, session, world)
    : listWorldPlayerPresences(world, session);

  res.json({
    world: {
      id: world.id,
      concept: world.concept,
      era: world.era,
      geography: world.geography,
      culture: world.culture,
      economy: world.economy,
      law: world.law,
      weather: world.weather,
      technology: world.technology,
      narrativeStyle: world.narrativeStyle,
      populationBlueprint: world.populationBlueprint,
      simulationRules: world.simulationRules,
      timeOfDay: world.timeOfDay,
      locations: world.locations,
      npcs: npcFull,
      timeline: world.timeline,
      displayLanguage: world.displayLanguage,
      images: world.images,
    },
    session: {
      ...session,
      npcStates,
    },
    objectiveEvents: session.objectiveEvents ?? [],
    contagionEvents: session.contagionEvents ?? [],
    realityGapMetrics,
    location,
    soundscape: soundscape ?? null,
    npcsHere,
    playerPresences,
    playersHere: playerPresences.filter(presence => presence.canCommunicate),
    connectedLocations: connectedLocationsFor(world, currentLocationId),
    npcs: npcFull,
    dramaLeads: deriveSessionLeads(world, session),
    quest: getQuestStatus(session),
    view: { inQuest: view.inQuest, worldId: world.id, locationId: currentLocationId },
    resources,
    timeOfDay,
  });
});

app.get('/api/sessions/:id/cognition/:npcId', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (!requireSessionPlayerAuth(req, res, session)) return;
  const world = worlds.get(session.worldId);
  if (!world) { res.status(404).json({ error: 'World not found' }); return; }
  ensureCognitionState(session);

  const npc = world.npcs.find(n => n.id === req.params.npcId);
  const state = session.npcStates[req.params.npcId];
  if (!npc || !state) { res.status(404).json({ error: 'NPC not found' }); return; }

  const sourceEventIds = new Set((state.memories ?? []).map(m => m.sourceEventId).filter(Boolean));
  res.json({
    npc,
    state,
    realityGap: getRealityGapMetric(state),
    objectiveEvents: (session.objectiveEvents ?? []).filter(e => sourceEventIds.has(e.id) || e.targetIds.includes(npc.id)),
    contagionEvents: (session.contagionEvents ?? []).filter(e => e.fromNpcId === npc.id || e.toNpcId === npc.id),
  });
});


// ===== Pack Builder (sound-pack pipeline for individual worlds) =====
type PackBuilderRunState = {
  running: boolean;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  code?: number | null;
  args: string[];
  pack?: string;
  worldId?: string;
  phases: number[];
  stdoutTail: string;
  stderrTail: string;
};

let packBuilderRunState: PackBuilderRunState | null = null;

function startPackBuilderPass(opts: { phases: number[]; pack?: string; worldId?: string }): PackBuilderRunState {
  const existing = packBuilderRunState;
  if (existing?.running) return existing;
  const args: string[] = [join(REPO_ROOT, 'scripts', 'build-world-packs.py')];
  args.push('--only', opts.phases.join(','));
  args.push('--workers', '4', '--min-themes', '3');
  if (opts.pack) args.push('--packs', opts.pack);
  const child = spawn(PYTHON_BIN, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state: PackBuilderRunState = {
    running: true,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    args,
    pack: opts.pack,
    worldId: opts.worldId,
    phases: opts.phases,
    stdoutTail: '',
    stderrTail: '',
  };
  packBuilderRunState = state;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { state.stdoutTail = appendTail(state.stdoutTail, chunk); });
  child.stderr.on('data', chunk => { state.stderrTail = appendTail(state.stderrTail, chunk); });
  child.on('error', err => {
    state.running = false;
    state.endedAt = new Date().toISOString();
    state.stderrTail = appendTail(state.stderrTail, err instanceof Error ? err.message : String(err));
  });
  child.on('close', code => {
    state.running = false;
    state.code = code;
    state.endedAt = new Date().toISOString();
  });
  return state;
}

const PACK_BUILDER_SKIP = new Set(['ambient', 'music', 'sfx', 'ui']);

function countAudioFiles(dir: string): number {
  let total = 0;
  try {
    const stack: string[] = [dir];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const ent of readdirSync(cur, { withFileTypes: true })) {
        const full = join(cur, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else {
          const ext = ent.name.toLowerCase().split('.').pop();
          if (ext && (ext === 'mp3' || ext === 'ogg' || ext === 'wav' || ext === 'flac')) total++;
        }
      }
    }
  } catch {}
  return total;
}

function findPacksForWorld(worldId: string): Array<{ dir: string; pack: any; audioCount: number }> {
  const audioRoot = join(REPO_ROOT, 'public', 'audio');
  const out: Array<{ dir: string; pack: any; audioCount: number }> = [];
  let entries: string[] = [];
  try { entries = readdirSync(audioRoot); } catch { return out; }
  for (const name of entries) {
    if (PACK_BUILDER_SKIP.has(name)) continue;
    const packPath = join(audioRoot, name, 'pack.json');
    if (!existsSync(packPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(packPath, 'utf8').replace(/^\uFEFF/, ''));
      const wids: string[] = Array.isArray(raw.worldIds) ? raw.worldIds : [];
      if (!wids.includes(worldId)) continue;
      const audioCount = countAudioFiles(join(audioRoot, name));
      out.push({ dir: name, pack: raw, audioCount });
    } catch {}
  }
  return out;
}

app.get('/api/worlds/:id/pack', (req, res) => {
  try {
    const found = findPacksForWorld(req.params.id);
    const packs = found.map(p => ({
      dir: p.dir,
      name: p.pack.name || p.dir,
      themesSource: p.pack.themesSource || 'unknown',
      audioCount: p.audioCount,
      themeCount: (() => {
        try {
          const tj = join(REPO_ROOT, 'public', 'audio', p.dir, '_themes.json');
          if (!existsSync(tj)) return 0;
          const t = JSON.parse(readFileSync(tj, 'utf8').replace(/^\uFEFF/, ''));
          return Object.keys(t || {}).length;
        } catch { return 0; }
      })(),
    }));
    res.json({ ok: true, packs });
  } catch (err) {
    console.error('[worldgen:pack-for-world]', err);
    res.status(500).json({ ok: false, error: 'Failed to read pack info', detail: String(err) });
  }
});

app.get('/api/pack-builder/packs', (req, res) => {
  try {
    const audioRoot = join(REPO_ROOT, 'public', 'audio');
    let entries: string[] = [];
    try { entries = readdirSync(audioRoot); } catch {}
    const packs: any[] = [];
    for (const name of entries) {
      if (PACK_BUILDER_SKIP.has(name)) continue;
      const packPath = join(audioRoot, name, 'pack.json');
      if (!existsSync(packPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(packPath, 'utf8').replace(/^\uFEFF/, ''));
        const tj = join(audioRoot, name, '_themes.json');
        let themeCount = 0;
        if (existsSync(tj)) {
          try { themeCount = Object.keys(JSON.parse(readFileSync(tj, 'utf8').replace(/^\uFEFF/, '')) || {}).length; } catch {}
        }
        packs.push({
          dir: name,
          name: raw.name || name,
          themesSource: raw.themesSource || 'unknown',
          worldIds: Array.isArray(raw.worldIds) ? raw.worldIds : [],
          audioCount: countAudioFiles(join(audioRoot, name)),
          themeCount,
        });
      } catch {}
    }
    packs.sort((a, b) => String(a.dir).localeCompare(String(b.dir)));
    res.json({ ok: true, packs });
  } catch (err) {
    console.error('[worldgen:pack-builder:list]', err);
    res.status(500).json({ ok: false, error: 'Failed to list packs', detail: String(err) });
  }
});

app.get('/api/pack-builder/status', (req, res) => {
  res.json({ ok: true, run: packBuilderRunState });
});

app.post('/api/pack-builder/run', (req, res) => {
  try {
    if (packBuilderRunState?.running) {
      res.status(409).json({ ok: false, error: 'Pack builder pass already running', run: packBuilderRunState });
      return;
    }
    const body = req.body || {};
    const phases: number[] = Array.isArray(body.phases)
      ? body.phases.map((n: any) => Math.floor(Number(n))).filter((n: number) => n === 1 || n === 2 || n === 3)
      : [];
    if (!phases.length) {
      res.status(400).json({ ok: false, error: 'phases must be a non-empty array containing 1, 2, or 3' });
      return;
    }
    const pack = typeof body.pack === 'string' && body.pack.trim() ? body.pack.trim() : undefined;
    if (pack && !/^[A-Za-z0-9._-]+$/.test(pack)) {
      res.status(400).json({ ok: false, error: 'pack must be a simple audio-pack directory name' });
      return;
    }
    const worldId = typeof body.worldId === 'string' && body.worldId.trim() ? body.worldId.trim() : undefined;
    const run = startPackBuilderPass({ phases, pack, worldId });
    res.json({ ok: true, run });
  } catch (err) {
    console.error('[worldgen:pack-builder:run]', err);
    res.status(500).json({ ok: false, error: 'Failed to start pack builder', detail: String(err) });
  }
});
// ===== end Pack Builder =====

// listen + ws + shutdown moved here so all routes register first
// ── Start ───────────────────────────────────────────────────────────────────

// Cap directories that grow without bound (debug dumps, build checkpoints, image cache).
// Keeps the newest `keep` entries; anything beyond that is removed.
function pruneDirKeepNewest(dir: string, keep: number): number {
  let removed = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .map(e => {
        const full = join(dir, e.name);
        try { return { full, isDir: e.isDirectory(), mtimeMs: statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter((e): e is { full: string; isDir: boolean; mtimeMs: number } => !!e)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const e of entries.slice(keep)) {
      try { rmSync(e.full, { recursive: e.isDir, force: true }); removed++; } catch {}
    }
  } catch {}
  return removed;
}

function pruneRuntimeClutter(): void {
  const keepN = (name: string, def: number) => Math.max(0, parseInt(process.env[name] ?? String(def), 10) || def);
  const pruned = {
    failedJson: pruneDirKeepNewest(join(DATA_DIR, 'failed-json'), keepN('WORLDGEN_KEEP_FAILED_JSON', 200)),
    dialogueDebug: pruneDirKeepNewest(join(DATA_DIR, 'dialogue-debug'), keepN('WORLDGEN_KEEP_DIALOGUE_DEBUG', 500)),
    buildCheckpoints: pruneDirKeepNewest(join(DATA_DIR, '.build-checkpoints'), keepN('WORLDGEN_KEEP_BUILD_CHECKPOINTS', 40)),
    imgCache: pruneDirKeepNewest(IMG_CACHE_DIR, keepN('WORLDGEN_KEEP_IMG_CACHE', 2000)),
  };
  const total = Object.values(pruned).reduce((a, b) => a + b, 0);
  if (total > 0) console.log('[worldgen] pruned runtime clutter', pruned);
}

const PORT = parseInt(process.env.PORT ?? '3002', 10);
const server = app.listen(PORT, () => {
  console.log(`[worldgen] listening on :${PORT}`);
  console.log(`[worldgen] providers: ${availableProviders().join(', ')}`);
  if (process.env.WORLDGEN_REPAIR_PLAYER_PORTRAITS === '1') {
    repairMissingGlobalPlayerPortraits().catch(err => {
      console.warn('[imageGen] player portrait startup repair failed', String(err).slice(0, 200));
    });
  }
  if (isSomaEnabled()) {
    console.log('[soma] Freesound ambient sounds enabled');
  } else {
    console.log('[soma] SOMA_API not set — Freesound ambient sounds disabled');
  }
  // [WG-STARTUP-REPAIR] Run the same integrity sweep that GET /api/worlds/check-data
  // uses, once on boot, so on-disk drift (stale refs, orphaned sessions, unreferenced
  // generated assets) is reconciled automatically instead of only when someone clicks
  // the maintenance button. Deferred + guarded so a failure can never block startup.
  setTimeout(() => {
    try {
      const repair = repairIntegrityState();
      console.log(`[worldgen] startup integrity sweep: orphanedSessions=${repair.orphanedSessionsRemoved} generatedAssetsPruned=${repair.generatedAssetsPruned} staleImageMapEntries=${repair.staleImageMapEntriesCleaned} corruptQuarantined=${repair.corruptFilesQuarantined} imageGenQueued=${repair.imageGenerationQueued}`);
    } catch (err) {
      console.warn('[worldgen] startup integrity sweep failed', String(err).slice(0, 200));
    }
    pruneRuntimeClutter();
  }, 2000);
});
server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[worldgen] Port ${PORT} in use — kill the old process and restart.`);
    process.exit(1);
  } else throw err;
});

// ── WebSocket for real-time multiplayer chat rooms ─────────────────────────────

const wss = new WebSocketServer({ server });

interface ChatRoomClient {
  ws: WebSocket;
  sessionId: string;
  playerName: string;
  npcId: string;
  worldId: string;
}

const chatRooms = new Map<string, Set<ChatRoomClient>>();
const coopSessions = new Map<string, WebSocket>();

function chatRoomKey(worldId: string, npcId: string): string {
  return `${worldId}:${npcId}`;
}

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || '';
  let sameOrigin = false;
  try { sameOrigin = !!origin && new URL(origin).host === req.headers.host; } catch {}
  if (origin && !sameOrigin && !ALLOWED_ORIGINS.includes(origin)) {
    ws.close(4003, 'Origin not allowed');
    return;
  }
  let client: ChatRoomClient | null = null;
  let registeredSessionId: string | null = null;
  // Skipped sessions load only for their owner (PIN checked against the stub's player).
  const wsLoadSessionIfOwner = (sessionId: string, pin: unknown, upgradeReq: typeof req) => {
    const stub = sessionStubs.get(sessionId);
    if (!stub?.globalPlayerId) return;
    if (verifyGlobalPlayerPin(globalPlayers.get(stub.globalPlayerId), pin, { client: wsClientKey(upgradeReq) })) {
      ensureSessionAndWorldLoaded(sessionId);
    }
  };

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'join') {
        const sessionId = String(msg.sessionId || '');
        const playerName = String(msg.playerName || '').slice(0, 100);
        const npcId = String(msg.npcId || '');
        if (!sessionId || !playerName || !npcId) return;
        wsLoadSessionIfOwner(sessionId, msg.pin, req);
        const session = sessions.get(sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session' }));
          return;
        }
        if (session.globalPlayerId) {
          const pin = String(msg.pin || '');
          const player = globalPlayers.get(session.globalPlayerId);
          if (!verifyGlobalPlayerPin(player, pin, { client: wsClientKey(req) })) {
            ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed' }));
            return;
          }
        }
        const sessionWorld = worlds.get(session.worldId);
        if (npcId && sessionWorld && !(sessionWorld.npcs || []).some(n => n.id === npcId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid npcId' }));
          return;
        }
        client = { ws, sessionId, playerName, npcId, worldId: session.worldId };
        const roomKey = chatRoomKey(session.worldId, npcId);
        if (!chatRooms.has(roomKey)) chatRooms.set(roomKey, new Set());
        chatRooms.get(roomKey)!.add(client);
        broadcastToRoom(session.worldId, npcId, { type: 'player_joined', playerName, sessionId }, sessionId);
        // Send current room participants to the joining client
        const participants = Array.from(chatRooms.get(roomKey)!)
          .filter(c => c.sessionId !== sessionId)
          .map(c => ({ playerName: c.playerName, sessionId: c.sessionId }));
        ws.send(JSON.stringify({ type: 'room_state', participants }));
      }
      if (msg.type === 'coop_register') {
        const sessionId = String(msg.sessionId || '');
        if (sessionId) wsLoadSessionIfOwner(sessionId, msg.pin, req);
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session' }));
          return;
        }
        if (session.globalPlayerId) {
          const pin = String(msg.pin || '');
          const player = globalPlayers.get(session.globalPlayerId);
          if (!verifyGlobalPlayerPin(player, pin, { client: wsClientKey(req) })) {
            ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed' }));
            return;
          }
        }
        coopSessions.set(sessionId, ws);
        registeredSessionId = sessionId;
      }
      if (msg.type === 'portal_echo') {
        const sessionId = registeredSessionId || String(msg.sessionId || '');
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) return;
        const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
        if (!text) return;
        const kind = String(msg.kind || 'Echo').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Echo';
        broadcastPortalEchoToSameLocation(session, {
          type: 'portal_echo',
          fromSessionId: session.id,
          fromName: session.playerName,
          kind,
          text,
          at: new Date().toISOString(),
        });
      }
      if (msg.type === 'coop_view_change') {
        const sessionId = registeredSessionId || String(msg.sessionId || '');
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) return;
        const view = String(msg.view || '').trim();
        if (!['world', 'community', 'street', 'portal'].includes(view)) return;
        const partner = coopViewSyncPartnerForSession(session);
        if (!partner) return;
        pushCoopEvent(partner.id, {
          type: 'coop_view_change',
          view,
          fromSessionId: session.id,
          fromName: session.playerName,
        });
      }
      if (msg.type === 'npc_chat_open') {
        const sessionId = registeredSessionId || String(msg.sessionId || '');
        const session = sessionId ? sessions.get(sessionId) : undefined;
        const npcId = String(msg.npcId || '');
        const world = session ? worlds.get(session.worldId) : undefined;
        if (!session || !world || !npcId || !(world.npcs || []).some(n => n.id === npcId)) return;
        const partner = coopPartnerForSession(session);
        if (!partner) return;
        pushCoopEvent(partner.id, {
          type: 'coop_npc_chat_open',
          npcId,
          fromSessionId: session.id,
          fromName: session.playerName,
        });
      }
      if (msg.type === 'npc_chat_close') {
        const sessionId = registeredSessionId || String(msg.sessionId || '');
        const session = sessionId ? sessions.get(sessionId) : undefined;
        const npcId = String(msg.npcId || '');
        const world = session ? worlds.get(session.worldId) : undefined;
        if (!session || !world || !npcId || !(world.npcs || []).some(n => n.id === npcId)) return;
        const partner = coopPartnerForSession(session);
        if (!partner) return;
        pushCoopEvent(partner.id, {
          type: 'coop_npc_chat_close',
          npcId,
          fromSessionId: session.id,
          fromName: session.playerName,
        });
      }
    } catch (e) { console.warn('[ws] Failed to parse message:', e); }
  });

  ws.on('close', () => {
    if (client) {
      const roomKey = chatRoomKey(client.worldId, client.npcId);
      const room = chatRooms.get(roomKey);
      if (room) {
        room.delete(client);
        if (room.size === 0) {
          chatRooms.delete(roomKey);
          const w = worlds.get(client.worldId);
          if (w?.npcSharedStates?.[client.npcId]) {
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            w.npcSharedStates[client.npcId].activeConversation =
              (w.npcSharedStates[client.npcId].activeConversation ?? [])
                .filter((e: any) => Date.parse(e.timestamp) > cutoff)
                .slice(-30);
            saveWorld(w);
          }
        } else {
          broadcastToRoom(client.worldId, client.npcId, { type: 'player_left', playerName: client.playerName, sessionId: client.sessionId }, client.sessionId);
        }
      }
    }
    for (const [sessionId, socket] of coopSessions.entries()) {
      if (socket === ws) coopSessions.delete(sessionId);
    }
    if (registeredSessionId && coopSessions.get(registeredSessionId) === ws) coopSessions.delete(registeredSessionId);
  });
});

function broadcastToRoom(worldId: string, npcId: string, message: object, excludeSessionId?: string) {
  const room = chatRooms.get(chatRoomKey(worldId, npcId));
  if (!room) return;
  const payload = JSON.stringify(message);
  for (const client of room) {
    if (excludeSessionId && client.sessionId === excludeSessionId) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

function pushCoopEvent(targetSessionId: string, event: { type: string; [key: string]: any }): void {
  const ws = coopSessions.get(targetSessionId);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
}

function broadcastPortalEchoToSameLocation(source: WorldSession, event: { type: string; [key: string]: any }): void {
  const sourceWorld = worlds.get(source.worldId);
  if (!sourceWorld) return;
  const sourceView = sessionRuntimeView(source, sourceWorld);
  for (const [targetSessionId, ws] of coopSessions.entries()) {
    if (targetSessionId === source.id || ws.readyState !== WebSocket.OPEN) continue;
    const target = sessions.get(targetSessionId);
    const targetWorld = target ? worlds.get(target.worldId) : undefined;
    if (!target || !targetWorld) continue;
    const targetView = sessionRuntimeView(target, targetWorld);
    if (targetView.world.id !== sourceView.world.id || targetView.locationId !== sourceView.locationId) continue;
    ws.send(JSON.stringify(event));
  }
}

function coopPartnerForSession(session: WorldSession): WorldSession | undefined {
  const world = worlds.get(session.worldId);
  if (!world) return undefined;
  activeWorldQuestForSessionFromWorld(session, world);
  const quest = session.activeWorldQuest;
  if (quest?.twoPlayer && quest.guestSessionId) {
    const isHost = session.id === quest.hostSessionId;
    const isGuest = session.id === quest.guestSessionId;
    const partnerId = isHost ? quest.guestSessionId : isGuest ? quest.hostSessionId : undefined;
    const partner = partnerId ? sessions.get(partnerId) : undefined;
    if (partner) return partner;
  }
  const adventure = activeSerializedAdventureForSessionFromWorld(session, world);
  if (adventure?.status === 'active' && adventure.allowCoop) {
    const partner = serialisedAdventurePartnerSession(adventure, session.id);
    if (partner) {
      return partner;
    }
  }
  return undefined;
}

function coopViewSyncPartnerForSession(session: WorldSession): WorldSession | undefined {
  const world = worlds.get(session.worldId);
  if (!world) return undefined;
  activeWorldQuestForSessionFromWorld(session, world);
  const quest = session.activeWorldQuest;
  if (quest?.twoPlayer && quest.guestSessionId) {
    const isHost = session.id === quest.hostSessionId;
    const isGuest = session.id === quest.guestSessionId;
    const partnerId = isHost ? quest.guestSessionId : isGuest ? quest.hostSessionId : undefined;
    const partner = partnerId ? sessions.get(partnerId) : undefined;
    const partnerMode = isHost ? quest.guestCoopMode : isGuest ? quest.hostCoopMode : undefined;
    if (partner && partnerMode === 'join') return partner;
  }
  const adventure = activeSerializedAdventureForSessionFromWorld(session, world);
  if (adventure?.status === 'active' && adventure.allowCoop) {
    const partner = serialisedAdventurePartnerSession(adventure, session.id);
    if (partner && serialisedAdventureCoopMode(adventure, partner.id) === 'join') return partner;
  }
  return undefined;
}

function pushCoopEventToPartner(quest: WorldQuestAdventure, actingSessionId: string, event: { type: string; [key: string]: any }): void {
  if (!quest.twoPlayer || !quest.guestSessionId) return;
  const partnerId = actingSessionId === quest.hostSessionId ? quest.guestSessionId : quest.hostSessionId;
  if (partnerId) pushCoopEvent(partnerId, event);
}

// Graceful shutdown: flush any debounced session writes before exit.
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worldgen] ${sig} received, flushing pending saves...`);
    try { await flushPendingSaves(); } catch (err) { console.error('[worldgen] flush error', err); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

