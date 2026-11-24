import 'dotenv/config';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildLocationPrompt, generateImage, saveDataUrlImage } from '../src/imageGen.js';

const WORLD_ID = '38ea276b-7d44-452e-a452-b32b8175c2da';
const WIDTH = Number(process.env.ALIEN_LOC_HIRES_WIDTH || 3200);
const HEIGHT = Number(process.env.ALIEN_LOC_HIRES_HEIGHT || 1920);
const CONCURRENCY = Math.max(1, Number(process.env.ALIEN_LOC_HIRES_CONCURRENCY || 2));
const TIMEOUT_MS = Math.max(30000, Number(process.env.ALIEN_LOC_HIRES_TIMEOUT_MS || 240000));

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function safeName(s: string): string {
  return String(s || 'image').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'image';
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await worker(items[idx], idx);
    }
  }));
}

const only = argValue('--only');
const limit = Number(argValue('--limit') || 0);
const worldPath = join('data', `world-${WORLD_ID}.json`);
const outDir = join('public', 'generated', WORLD_ID);
const world = JSON.parse(readFileSync(worldPath, 'utf8'));
const era = world.era?.period || world.era?.label || '';
const region = world.geography?.region || world.geography?.country || world.geography?.terrain || 'LV-426 frontier colony';
const backupDir = join(outDir, `_pre-hires-${new Date().toISOString().replace(/[:.]/g, '-')}`);

let locations = world.locations || [];
if (only) locations = locations.filter((loc: any) => loc.id === only || safeName(loc.id || loc.name) === only);
if (limit > 0) locations = locations.slice(0, limit);
if (!locations.length) throw new Error(`No matching locations for ${only || 'world'}`);

mkdirSync(backupDir, { recursive: true });
const results: Array<Record<string, unknown>> = [];
console.log(`[hires] ${world.concept}: ${locations.length} location image(s), ${WIDTH}x${HEIGHT}, concurrency ${CONCURRENCY}`);

await runWithConcurrency(locations, CONCURRENCY, async (loc: any, idx) => {
  const key = loc.id || loc.name;
  const fileName = `loc-${safeName(key)}.jpg`;
  const filePath = join(outDir, fileName);
  if (existsSync(filePath)) copyFileSync(filePath, join(backupDir, fileName));
  const basePrompt = buildLocationPrompt(loc, era, region, undefined, world);
  const prompt = [
    basePrompt,
    'ultra high resolution production still',
    'high detail industrial surfaces',
    'sharp focus, deep texture, cinematic horror atmosphere',
    'no people, no actors, no faces, no readable text, no logos, no watermark',
  ].join(', ');
  console.log(`[hires] ${idx + 1}/${locations.length} ${loc.name}`);
  const img = await generateImage(prompt, {
    width: WIDTH,
    height: HEIGHT,
    seed: Math.abs(hashCode(`${WORLD_ID}:${key}:hires`)),
    timeoutMs: TIMEOUT_MS,
    model: process.env.IMAGE_GEN_MODEL_SCENE || process.env.IMAGE_GEN_MODEL || undefined,
  });
  if (!img.dataUrl) {
    results.push({ id: key, ok: false, rateLimited: img.rateLimited, blocked: img.blocked });
    console.warn(`[hires] failed ${loc.name}`);
    return;
  }
  const ok = saveDataUrlImage(img.dataUrl, filePath);
  results.push({ id: key, ok, file: filePath, width: WIDTH, height: HEIGHT });
});

const manifestPath = join(backupDir, 'hires-results.json');
writeFileSync(manifestPath, JSON.stringify({ worldId: WORLD_ID, width: WIDTH, height: HEIGHT, backupDir, results }, null, 2));
const failed = results.filter(r => !r.ok);
console.log(`[hires] complete: ${results.length - failed.length}/${results.length} saved`);
if (failed.length) {
  console.log(`[hires] failed ids: ${failed.map(r => r.id).join(', ')}`);
  process.exitCode = 1;
}
console.log(`[hires] backups/results: ${backupDir}`);

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 999999;
}
