#!/usr/bin/env node
// Builds the double-click Windows package: <out>/WorldGen-Portable/ and a zip beside it.
//
//   npm run build && node scripts/build-portable.mjs [--out D:\some\dir] [--worlds id,id] [--no-zip] [--no-verify]
//
// --out defaults to ./release. Needs roughly 2.5x the package size free there (folder + zip + cache).
//
// Contents: dist/ + src/ + scripts/ (world builds spawn tsx), production node_modules, a Node 22
// runtime (runtime/node.exe, checked against nodejs.org's SHA-256 list), the static UI, and only the
// demo worlds listed in portable-template/demo-worlds.json with their images, cover and sound pack.
// No sessions, players, uploads or .env are copied; the launcher creates .env from .env.example.
// A demo world with any missing image is refused, and the finished package is booted and checked.
import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const OUT_PARENT = option('--out') ? resolve(option('--out')) : join(ROOT, 'release');
const OUT = join(OUT_PARENT, 'WorldGen-Portable');
const CACHE = join(OUT_PARENT, '.cache');
const TEMPLATE = join(ROOT, 'portable-template');
const demoIds = (option('--worlds') ?? JSON.parse(readFileSync(join(TEMPLATE, 'demo-worlds.json'), 'utf8')).worlds.join(','))
  .split(',').map(s => s.trim()).filter(Boolean);

// Windows' own tar.exe (bsdtar) reads and writes zip; a Git-for-Windows GNU tar on PATH does not.
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const log = msg => console.log(`[portable] ${msg}`);
const fail = msg => { console.error(`[portable] ERROR: ${msg}`); process.exit(1); };
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const copy = (from, to, filter) => { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true, filter }); };
const sizeOf = p => { const st = statSync(p); if (!st.isDirectory()) return st.size; return readdirSync(p).reduce((t, e) => t + sizeOf(join(p, e)), 0); };

if (!existsSync(join(ROOT, 'dist', 'index.js')) || !existsSync(join(ROOT, 'public', 'index.compiled.js'))) fail('run `npm run build` first');
if (!demoIds.length) fail('no demo worlds selected');

// ── 1. Demo worlds must load every image ──────────────────────────────────────
// Mirrors the server's lobby check (repairWorldImages): cover, portrait per NPC, swimwear per
// adult NPC, scene per location, found by stored URL or by the generated-file naming conventions.
const slug = v => String(v || 'image').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'image';
const EXTS = ['.jpg', '.png', '.webp', '.jpeg'];
const publicFileExists = url => {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('/api/')) return /^https?:|^data:image\//.test(String(url));
  const clean = decodeURIComponent(url.split(/[?#]/)[0]);
  return !clean.split('/').includes('..') && existsSync(join(ROOT, 'public', clean));
};
const findFile = (worldId, kind, ent) => {
  const bases = [...new Set([ent.id, ent.name].filter(Boolean).map(slug))];
  const stems = b => kind === 'npc' ? [`manual-${b}`, `npc-${b}`, b, `_pre_imdb_backup/${b}`]
    : kind === 'swimwear' ? [`manual-${b}-swimwear`, `npc-${b}-swimwear`] : [`manual-${b}`, `loc-${b}`, b];
  for (const b of bases) for (const s of stems(b)) for (const e of EXTS) {
    if (existsSync(join(ROOT, 'public', 'generated', worldId, `${s}${e}`))) return true;
  }
  return false;
};
const isAdultSwimwear = n => Number(n.age) >= 18 && !/\b(child|teen|minor|schoolgirl|schoolboy)\b/i.test(`${n.gender} ${n.occupation} ${n.physicalDescription}`);
const NPC_FIELDS = ['photoUrl', 'imageUrl', 'portraitUrl', 'avatarUrl', 'generatedImageUrl', 'generatedPortraitUrl', 'thumbnailUrl'];
const LOC_FIELDS = ['photoUrl', 'imageUrl', 'sceneUrl', 'generatedImageUrl', 'thumbnailUrl'];
const COVER_FIELDS = ['photoUrl', 'imageUrl', 'coverImageUrl', 'coverPhotoUrl', 'thumbnailUrl', 'heroImageUrl', 'generatedImageUrl', 'worldImageUrl'];

function missingImages(w) {
  const img = w.images ?? {};
  const missing = [];
  const cover = img.cover ?? COVER_FIELDS.map(f => w[f]).find(Boolean);
  if (!publicFileExists(cover)
    && !EXTS.some(e => existsSync(join(ROOT, 'public', 'generated', w.id, `cover${e}`)) || existsSync(join(ROOT, 'public', 'covers', `${w.id}${e}`)))) missing.push('cover');
  for (const n of w.npcs ?? []) {
    const key = n.id || n.name;
    const stored = NPC_FIELDS.map(f => n[f]).find(Boolean) ?? w.portraits?.[key] ?? w.npcPortraits?.[key] ?? img.portraits?.[key] ?? w.imageCache?.portraits?.[key];
    if (!publicFileExists(stored) && !findFile(w.id, 'npc', n)) missing.push(`portrait:${n.name}`);
    if (isAdultSwimwear(n) && !publicFileExists(n.images?.swimwear || img.swimwearPortraits?.[key]) && !findFile(w.id, 'swimwear', n)) missing.push(`swimwear:${n.name}`);
  }
  for (const l of w.locations ?? []) {
    const key = l.id || l.name;
    const stored = LOC_FIELDS.map(f => l[f]).find(Boolean) ?? w.scenes?.[key] ?? w.locationScenes?.[key] ?? img.scenes?.[key] ?? w.imageCache?.scenes?.[key];
    if (!publicFileExists(stored) && !findFile(w.id, 'loc', l)) missing.push(`scene:${l.name}`);
  }
  return missing;
}

const demoWorlds = demoIds.map(id => {
  const file = join(ROOT, 'data', `world-${id}.json`);
  if (!existsSync(file)) fail(`world ${id} not found in data/`);
  const world = readJson(file);
  const missing = missingImages(world);
  if (missing.length) fail(`${world.name || world.concept} (${id}) is incomplete: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` +${missing.length - 8} more` : ''}`);
  return { id, file, world, name: String(world.name || world.title || world.concept).slice(0, 80) };
});
log(`demo worlds: ${demoWorlds.map(w => w.name).join(' | ')}`);

// Sound pack per world: the pack whose pack.json lists the world id, else the best concept match.
const audioRoot = join(ROOT, 'public', 'audio');
const packs = existsSync(audioRoot) ? readdirSync(audioRoot).flatMap(dir => {
  const pj = join(audioRoot, dir, 'pack.json');
  if (!existsSync(pj)) return [];
  try { const p = readJson(pj); return [{ dir: p.dir || dir, folder: dir, worldIds: p.worldIds ?? [], name: p.name ?? dir }]; } catch { return []; }
}) : [];
const normal = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
for (const w of demoWorlds) {
  const byId = packs.find(p => p.worldIds.includes(w.id));
  const byConcept = packs.find(p => normal(w.world.concept).startsWith(normal(p.folder)) || normal(p.folder).startsWith(normal(w.world.concept).slice(0, 40)));
  w.pack = byId ?? byConcept;
  log(`  ${w.name}: sound pack ${w.pack ? w.pack.folder : '(none: genre fallback only)'}`);
}

// ── 2. Fresh output folder ────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// App code. src/ and scripts/ are needed at runtime: world builds spawn `tsx scripts/build-world.ts`.
// seeds/ is left out on purpose: on boot the server copies every seeds/data world into the data dir
// (a hosting feature), which would add ~50 image-less worlds to the package.
const skipJunk = src => !/(\.bak[^/\\]*|\.log|\.err|__pycache__|_current-batch\.txt)$/i.test(src);
for (const p of ['dist', 'src', 'scripts']) copy(join(ROOT, p), join(OUT, p), skipJunk);
for (const f of ['package.json', 'package-lock.json', 'tsconfig.json', '.env.example']) copyFileSync(join(ROOT, f), join(OUT, f));

// Static UI: everything in public/ except per-world media and caches, which are added per demo world.
const PUBLIC_SKIP = new Set(['generated', 'uploads', 'audio', 'covers', 'imdb-cache', 'media-trash']);
for (const entry of readdirSync(join(ROOT, 'public'))) {
  if (PUBLIC_SKIP.has(entry)) continue;
  copy(join(ROOT, 'public', entry), join(OUT, 'public', entry), skipJunk);
}
for (const d of ['generated', 'uploads', 'audio', 'covers']) mkdirSync(join(OUT, 'public', d), { recursive: true });

// Demo world data + media.
mkdirSync(join(OUT, 'data'), { recursive: true });
for (const w of demoWorlds) {
  copyFileSync(w.file, join(OUT, 'data', `world-${w.id}.json`));
  const baseline = join(ROOT, 'data', '.baselines', `${w.id}.json`);
  if (existsSync(baseline)) copy(baseline, join(OUT, 'data', '.baselines', `${w.id}.json`));
  copy(join(ROOT, 'public', 'generated', w.id), join(OUT, 'public', 'generated', w.id));
  for (const e of EXTS) {
    const cover = join(ROOT, 'public', 'covers', `${w.id}${e}`);
    if (existsSync(cover)) copyFileSync(cover, join(OUT, 'public', 'covers', `${w.id}${e}`));
  }
  if (w.pack) copy(join(audioRoot, w.pack.folder), join(OUT, 'public', 'audio', w.pack.folder));
}

// Launcher, settings shortcut, readme.
for (const f of ['Start WorldGen.bat', 'Edit Settings.bat', 'README - How to Run.txt']) copyFileSync(join(TEMPLATE, f), join(OUT, f));
writeFileSync(join(OUT, 'DEMO-WORLDS.txt'), `Demo worlds included in this package:\r\n\r\n${demoWorlds.map(w => `- ${w.name}`).join('\r\n')}\r\n`);

// ── 3. Production dependencies ───────────────────────────────────────────────
log('installing production dependencies (npm ci --omit=dev)');
const npm = spawnSync('npm ci --omit=dev --no-audit --no-fund --ignore-scripts', { cwd: OUT, stdio: 'inherit', shell: true });
if (npm.status !== 0) fail('npm ci failed');

// ── 4. Node runtime (Windows x64, latest 22.x LTS, SHA-256 verified) ───────────
async function fetchNodeRuntime() {
  mkdirSync(CACHE, { recursive: true });
  const base = 'https://nodejs.org/dist/latest-v22.x/';
  const sums = await (await fetch(`${base}SHASUMS256.txt`)).text();
  const line = sums.split('\n').find(l => /node-v22\.\d+\.\d+-win-x64\.zip$/.test(l.trim()));
  if (!line) fail('could not find the Node 22 win-x64 zip in SHASUMS256.txt');
  const [expected, zipName] = line.trim().split(/\s+/);
  const zipPath = join(CACHE, zipName);
  if (!existsSync(zipPath) || createHash('sha256').update(readFileSync(zipPath)).digest('hex') !== expected) {
    log(`downloading ${zipName}`);
    const res = await fetch(`${base}${zipName}`);
    if (!res.ok) fail(`download failed: HTTP ${res.status}`);
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  if (actual !== expected) fail(`${zipName} checksum mismatch`);
  const folder = zipName.replace(/\.zip$/, '');
  const extractDir = join(CACHE, folder);
  if (!existsSync(join(extractDir, 'node.exe'))) {
    const tar = spawnSync(TAR, ['-xf', zipPath, '-C', CACHE, `${folder}/node.exe`, `${folder}/LICENSE`], { stdio: 'inherit' });
    if (tar.status !== 0) fail('could not extract node.exe');
  }
  mkdirSync(join(OUT, 'runtime'), { recursive: true });
  copyFileSync(join(extractDir, 'node.exe'), join(OUT, 'runtime', 'node.exe'));
  copyFileSync(join(extractDir, 'LICENSE'), join(OUT, 'runtime', 'NODE-LICENSE.txt'));
  log(`runtime: ${folder}`);
}
await fetchNodeRuntime();

// ── 5. Boot the package and check it ──────────────────────────────────────────
async function verify() {
  const PORT = 3097;
  const env = { ...process.env, PORT: String(PORT), WORLDGEN_DATA_DIR: '', WORLDGEN_API_KEY: '', NODE_ENV: '', WORLDGEN_DISABLE_IMAGE_GEN: '1' };
  const server = spawn(join(OUT, 'runtime', 'node.exe'), ['dist/index.js'], { cwd: OUT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', d => { output += d; });
  server.stderr.on('data', d => { output += d; });
  const get = async path => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json();
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { await get('/health'); up = true; } catch { await new Promise(r => setTimeout(r, 500)); } }
    if (!up) fail(`packaged server did not start:\n${output.slice(-2000)}`);
    await new Promise(r => setTimeout(r, 3000)); // startup integrity sweep
    const list = await get('/api/worlds');
    const shown = new Set(list.worlds.map(w => w.id));
    const problems = [];
    for (const w of demoWorlds) {
      const row = list.worlds.find(x => x.id === w.id);
      if (!row) { problems.push(`${w.name} not listed`); continue; }
      if (!row.audioPackApplied) problems.push(`${w.name} has no sound pack`);
      const full = await get(`/api/worlds/${w.id}`);
      const world = full.world ?? full;
      const urls = [row.coverImageUrl, ...Object.values(world.images?.portraits ?? {}), ...Object.values(world.images?.scenes ?? {})].filter(u => typeof u === 'string' && u.startsWith('/'));
      for (const url of urls) {
        const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method: 'HEAD' });
        if (!res.ok) problems.push(`${w.name}: ${url} -> HTTP ${res.status}`);
      }
      log(`  verified ${w.name}: listed, ${urls.length} images served${row.audioPackApplied ? ', sound pack on' : ''}`);
    }
    if (shown.size !== demoWorlds.length) problems.push(`lobby shows ${shown.size} worlds, expected ${demoWorlds.length}`);
    if (list.incompleteCount) problems.push(`${list.incompleteCount} incomplete world(s) in the package`);
    const worldFiles = readdirSync(join(OUT, 'data')).filter(f => f.startsWith('world-'));
    if (worldFiles.length !== demoWorlds.length) problems.push(`data/ holds ${worldFiles.length} world files after boot, expected ${demoWorlds.length}`);
    if (problems.length) fail(`package check failed:\n  ${problems.join('\n  ')}`);
  } finally {
    server.kill();
  }
  // The check boots against the package's own data dir: reset data/ and public/generated/ to exactly
  // the demo set so nothing the boot wrote (sessions, repaired JSON, caches) ships.
  const keepData = new Set([...demoWorlds.map(w => `world-${w.id}.json`), '.baselines']);
  for (const f of readdirSync(join(OUT, 'data'))) {
    if (!keepData.has(f)) rmSync(join(OUT, 'data', f), { recursive: true, force: true });
  }
  for (const w of demoWorlds) copyFileSync(w.file, join(OUT, 'data', `world-${w.id}.json`));
  const keepGenerated = new Set(demoWorlds.map(w => w.id));
  for (const d of readdirSync(join(OUT, 'public', 'generated'))) {
    if (!keepGenerated.has(d)) rmSync(join(OUT, 'public', 'generated', d), { recursive: true, force: true });
  }
  rmSync(join(OUT, 'state'), { recursive: true, force: true });
}
if (!flag('--no-verify')) { log('booting the package to verify it'); await verify(); }

// ── 6. Zip ──────────────────────────────────────────────────────────────────────
log(`package folder: ${OUT} (${(sizeOf(OUT) / 1e6).toFixed(0)} MB)`);
if (!flag('--no-zip')) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const zip = join(OUT_PARENT, `WorldGen-Portable-${stamp}.zip`);
  rmSync(zip, { force: true });
  const tar = spawnSync(TAR, ['-a', '-c', '-f', zip, '-C', OUT_PARENT, 'WorldGen-Portable'], { stdio: 'inherit' });
  if (tar.status !== 0) fail('zip failed');
  log(`zip: ${zip} (${(statSync(zip).size / 1e6).toFixed(0)} MB)`);
}
