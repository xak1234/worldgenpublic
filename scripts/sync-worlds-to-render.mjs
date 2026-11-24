#!/usr/bin/env node
// Push local data/world-*.json files up to a Render (or any) WorldGen instance.
// Auth: requires WORLDGEN_API_KEY env var set both on the remote server AND here.
//
// Usage:
//   node scripts/sync-worlds-to-render.mjs                # uses defaults below
//   WORLDGEN_REMOTE=https://my-instance.onrender.com node scripts/sync-worlds-to-render.mjs
//   node scripts/sync-worlds-to-render.mjs --dry-run
//   node scripts/sync-worlds-to-render.mjs --only world-red_dwarf_world,world-foo
//
// On success prints { written, skipped, totalWorlds, dataDir }.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DATA_DIR  = join(REPO_ROOT, 'data');
const REMOTE    = process.env.WORLDGEN_REMOTE || 'https://worldgen-qxem.onrender.com';
const API_KEY   = process.env.WORLDGEN_API_KEY || '';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const onlyArg = process.argv.find(a => a.startsWith('--only='));
const onlyList = onlyArg ? onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean) : null;

if (!API_KEY) {
  console.error('ERROR: set WORLDGEN_API_KEY env var to the same value as the remote service');
  process.exit(2);
}

const files = readdirSync(DATA_DIR).filter(f => /^world-.*\.json$/.test(f));
if (!files.length) { console.error('no data/world-*.json files found'); process.exit(1); }

const worlds = [];
let totalBytes = 0;
for (const f of files) {
  const base = f.replace(/\.json$/, '');
  if (onlyList && !onlyList.includes(base) && !onlyList.includes(f)) continue;
  const full = join(DATA_DIR, f);
  const sz = statSync(full).size;
  totalBytes += sz;
  try {
    const json = JSON.parse(readFileSync(full, 'utf8'));
    if (!json?.id) { console.warn(`[skip] ${f} - no .id field`); continue; }
    worlds.push(json);
  } catch (e) {
    console.warn(`[skip] ${f} - parse error: ${e.message}`);
  }
}

console.log(`sync target : ${REMOTE}`);
console.log(`world count : ${worlds.length}`);
console.log(`raw payload : ${(totalBytes/1024/1024).toFixed(1)} MB`);
if (dryRun) { console.log('dry-run - not sending'); process.exit(0); }

const body = JSON.stringify({ worlds });
console.log(`compressed pre-network: ${(body.length/1024/1024).toFixed(1)} MB JSON`);

const t0 = Date.now();
let resp;
try {
  resp = await fetch(`${REMOTE}/api/admin/import-worlds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body,
  });
} catch (e) {
  console.error('request failed:', e.message);
  process.exit(1);
}
const text = await resp.text();
console.log(`HTTP ${resp.status} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
console.log(text.length > 4000 ? text.slice(0, 4000) + '...[' + (text.length-4000) + ' more chars]' : text);
if (!resp.ok) process.exit(1);
