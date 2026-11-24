#!/usr/bin/env node
// Deployment smoke test: boots dist/index.js against a throwaway data dir and checks the
// security + persistence guarantees the deploy relies on. Run after `npm run build`.
//
//   node scripts/smoke-deploy.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seeds = join(root, 'seeds', 'data');
const dataDir = mkdtempSync(join(tmpdir(), 'worldgen-smoke-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const API_KEY = 'smoke-admin-key';
const BASE = `http://127.0.0.1:${PORT}`;

// Two seed worlds: A is newest and fits the load budget; B is older and gets deferred.
const seedWorlds = readdirSync(seeds).filter(f => f.startsWith('world-')).map(f => ({ f, size: statSync(join(seeds, f)).size })).sort((a, b) => a.size - b.size);
const [worldA, worldB] = seedWorlds;
for (const { f } of [worldA, worldB]) copyFileSync(join(seeds, f), join(dataDir, f));
const future = new Date(Date.now() + 3600_000);
utimesSync(join(dataDir, worldA.f), future, future);
const worldBId = worldB.f.replace(/^world-|\.json$/g, '');

const legacyPlayer = { id: 'pin123_00000000-0000-4000-8000-000000000001', pin: '123', source: 'manual', playerName: 'Smoke', playerAge: 30, playerGender: 'unknown', playerOccupation: 'tester', playerBackstory: 'x', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), medals: [{ id: 'm' }] };
// Second player (new-style id) who never calls a /api/players/:id route, so the only
// thing that can load their boot-skipped session is the per-session owner check.
const player2 = { ...legacyPlayer, id: 'player_00000000-0000-4000-8000-000000000002', pin: '789', playerName: 'Smoke Two' };
writeFileSync(join(dataDir, 'players.json'), JSON.stringify({ players: [legacyPlayer, player2] }, null, 2));
const sessionId = '00000000-0000-4000-8000-0000000000aa';
writeFileSync(join(dataDir, `session-${sessionId}.json`), JSON.stringify({ id: sessionId, worldId: worldBId, globalPlayerId: legacyPlayer.id, playerName: 'Smoke', npcStates: {} }, null, 2));
// Over the per-file cap, so it is skipped at boot and indexed as a stub.
const bigSessionId = '00000000-0000-4000-8000-0000000000bb';
writeFileSync(join(dataDir, `session-${bigSessionId}.json`), JSON.stringify({ id: bigSessionId, worldId: worldBId, globalPlayerId: player2.id, playerName: 'Smoke Two', npcStates: {}, padding: 'x'.repeat(4096) }, null, 2));

const budgetMb = ((worldA.size + 1024) / 1024 / 1024).toFixed(4);
const env = { ...process.env, PORT: String(PORT), WORLDGEN_DATA_DIR: dataDir, WORLDGEN_API_KEY: API_KEY, WORLDGEN_WORLD_LOAD_BUDGET_MB: budgetMb, WORLDGEN_MAX_SESSION_FILE_MB: '0.002', NODE_ENV: '', CORS_ORIGINS: '' };

// Production without an admin key must refuse to boot.
const refused = spawnSync(process.execPath, ['dist/index.js'], { cwd: root, env: { ...env, NODE_ENV: 'production', WORLDGEN_API_KEY: '' }, timeout: 60_000, encoding: 'utf8' });
assert.equal(refused.status, 1, `production boot without WORLDGEN_API_KEY must exit 1 (got ${refused.status}${refused.signal ? ', ' + refused.signal : ''})`);
assert.match(refused.stderr, /requires WORLDGEN_API_KEY/);
console.log('✓ production refuses to start without WORLDGEN_API_KEY');

const server = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

const get = (path, headers = {}) => fetch(BASE + path, { headers });
const post = (path, body, headers = {}) => fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
const player = { 'x-global-player-id': legacyPlayer.id, 'x-global-player-pin': '456' };
const admin = { 'x-api-key': API_KEY };
// A file in the real public/uploads so the static-bypass probes would get 200 if they worked.
const probeFile = join(root, 'public', 'uploads', '_smoke-probe.txt');
mkdirSync(dirname(probeFile), { recursive: true });
writeFileSync(probeFile, 'secret');

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await get('/health')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  assert.ok((await get('/health')).ok, 'server did not become healthy');
  await new Promise(r => setTimeout(r, 4000)); // let the startup integrity sweep run

  assert.match(log, /worlds deferred/, 'fixture did not defer any world — the sweep regression is not being exercised');
  assert.match(log, /startup integrity sweep: orphanedSessions=0/, 'startup sweep did not run or removed sessions');
  assert.ok(existsSync(join(dataDir, `session-${sessionId}.json`)), 'startup sweep removed a session whose world is merely deferred');
  console.log('✓ session for a budget-deferred world survives the startup sweep');

  const list = await (await get('/api/players')).json();
  assert.ok(list.players.length >= 1 && list.players.every(p => !('pin' in p)), 'GET /api/players leaks pin');
  console.log('✓ player list hides PINs');

  assert.equal((await post(`/api/players/${legacyPlayer.id}/sign-in`, { pin: legacyPlayer.id })).status, 403, 'player id accepted as PIN');
  const exposed = await post(`/api/players/${legacyPlayer.id}/sign-in`, { pin: '123' });
  assert.equal(exposed.status, 403, 'legacy PIN visible in the id still signs in');
  assert.equal((await exposed.json()).pinResetRequired, true);
  const patch = await fetch(`${BASE}/api/players/${legacyPlayer.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...admin }, body: JSON.stringify({ newPin: '456' }) });
  assert.equal(patch.status, 200, 'admin PIN reset failed');
  assert.ok(!('pin' in (await patch.json()).player));
  const signIn = await post(`/api/players/${legacyPlayer.id}/sign-in`, { pin: '456' });
  assert.equal(signIn.status, 200);
  assert.ok(!('pin' in (await signIn.json()).player));
  console.log('✓ id-as-PIN and id-exposed legacy PIN rejected; admin reset works; sign-in never echoes the PIN');

  for (let i = 0; i < 10; i++) await post(`/api/players/${legacyPlayer.id}/sign-in`, {});
  assert.equal((await post(`/api/players/${legacyPlayer.id}/sign-in`, { pin: '456' })).status, 200, 'missing PINs counted toward lockout');
  console.log('✓ requests without a PIN do not count toward lockout');

  assert.equal((await post('/api/orchestrator/run', {})).status, 401, 'orchestrator run open without key');
  assert.equal((await post('/api/worlds/source-upload', {})).status, 401, 'source upload open without key');
  assert.equal((await post(`/api/sessions/${sessionId}/talk`, {})).status, 403, 'talk open without player auth');
  assert.equal((await get(`/api/sessions/${sessionId}/cognition/x`)).status, 403, 'cognition readable without auth');
  console.log('✓ admin routes need the key; gameplay and psyche routes need the player PIN');

  const ssrf = await post('/api/worlds/source-fetch-url', { url: 'http://127.0.0.1:1/' }, admin);
  assert.equal(ssrf.status, 400, 'loopback URL fetch not blocked');
  const ssrfDns = await post('/api/worlds/source-fetch-url', { url: 'http://localhost:1/' }, admin);
  assert.equal(ssrfDns.status, 400, 'localhost (DNS) URL fetch not blocked');
  for (const host of ['[::ffff:127.0.0.1]', '[::ffff:169.254.169.254]', '[::7f00:1]', '[64:ff9b::7f00:1]', '[::1]', '[fd00::1]']) {
    const r = await post('/api/worlds/source-fetch-url', { url: `http://${host}:1/` }, admin);
    assert.equal(r.status, 400, `${host} not blocked`);
  }
  console.log('✓ source-fetch-url refuses internal hosts, including IPv4-mapped / NAT64 IPv6 forms');

  for (const p of ['/uploads/_smoke-probe.txt', '/%75ploads/_smoke-probe.txt', '//uploads/_smoke-probe.txt', '/uploads%2f_smoke-probe.txt', '/UPLOADS/_smoke-probe.txt']) {
    assert.equal((await get(p)).status, 404, `${p} served`);
  }
  console.log('✓ uploads folder is not publicly served (encoded / doubled-slash paths too)');

  const sess = await get(`/api/sessions/${sessionId}/quest`, player);
  assert.notEqual(sess.status, 404, 'session of a deferred world not lazy-loaded');
  console.log(`✓ session of a deferred world loads its world on demand (GET quest -> ${sess.status})`);

  assert.equal((await get(`/api/sessions/${bigSessionId}/quest`)).status, 404, 'stub session loaded for an anonymous caller');
  assert.equal((await get(`/api/sessions/${bigSessionId}/quest`, player)).status, 404, 'stub session loaded for a different player');
  const bigSess = await get(`/api/sessions/${bigSessionId}/quest`, { 'x-global-player-id': player2.id, 'x-global-player-pin': '789' });
  assert.notEqual(bigSess.status, 404, 'boot-skipped session not lazy-loaded for its owner');
  console.log(`✓ boot-skipped session loads only for its owner (GET quest -> ${bigSess.status})`);

  for (let i = 0; i < 8; i++) await post(`/api/players/${legacyPlayer.id}/sign-in`, { pin: '999' });
  assert.equal((await post(`/api/players/${legacyPlayer.id}/sign-in`, { pin: '456' })).status, 403, 'no lockout after repeated wrong PINs');
  console.log('✓ repeated wrong PINs lock the character for that client');

  console.log('\nsmoke-deploy: all checks passed');
} catch (err) {
  console.error('\nsmoke-deploy FAILED:', err.message);
  console.error('--- server log tail ---\n' + log.split('\n').slice(-40).join('\n'));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1500));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(probeFile, { force: true });
}
