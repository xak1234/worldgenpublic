/**
 * Batch photo generator using Google Gemini API (free tier via AI Studio)
 *
 * Setup:
 *   1. Get a free API key from https://aistudio.google.com → "Get API Key"
 *   2. Set it: set GEMINI_API_KEY=your-key-here
 *
 * Usage:
 *   npx tsx scripts/fix-missing-photos-gemini.ts [--world <id>] [--dry-run] [--concurrency 3]
 *
 * Free tier: 15 requests/min, 2000/day — enough for all 521 images in ~35 min
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const GENERATED_DIR = join(ROOT, 'public', 'generated');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const WORLD_FILTER = args.includes('--world') ? args[args.indexOf('--world') + 1] : null;
const CONCURRENCY = Math.max(1, Math.min(5, parseInt(args.includes('--concurrency') ? args[args.indexOf('--concurrency') + 1] : '2') || 2));
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-image';
const RATE_LIMIT_RPM = parseInt(process.env.GEMINI_RPM || '14');

if (!GEMINI_API_KEY && !DRY_RUN) {
  console.error('ERROR: Set GEMINI_API_KEY environment variable.');
  console.error('  Get a free key at: https://aistudio.google.com');
  console.error('  Then: set GEMINI_API_KEY=your-key-here');
  process.exit(1);
}

interface WorldFile {
  id: string;
  concept: string;
  era?: { period?: string };
  geography?: { region?: string; country?: string; terrain?: string };
  npcs: Array<{ id: string; name: string; age: number; gender: string; ethnicity?: string; physicalDescription?: string; occupation: string; personality: string }>;
  locations: Array<{ id: string; name: string; type: string; description?: string }>;
}

interface ImageTask {
  worldId: string;
  worldName: string;
  type: 'cover' | 'npc' | 'location';
  entityId: string;
  entityName: string;
  prompt: string;
  outputPath: string;
  width: number;
  height: number;
}

function loadWorlds(): WorldFile[] {
  if (!existsSync(DATA_DIR)) { console.error('No data/ directory found.'); process.exit(1); }
  const files = readdirSync(DATA_DIR).filter(f => f.startsWith('world-') && f.endsWith('.json'));
  const worlds: WorldFile[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(DATA_DIR, file), 'utf8');
      const w = JSON.parse(raw) as WorldFile;
      if (WORLD_FILTER && w.id !== WORLD_FILTER) continue;
      worlds.push(w);
    } catch (e) {
      console.warn(`  Skipping ${file}: ${(e as Error).message}`);
    }
  }
  return worlds;
}

function getExistingFiles(worldId: string): Set<string> {
  const dir = join(GENERATED_DIR, worldId);
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter(f => /\.(jpg|png|webp)$/i.test(f)));
}

function safeName(s: string): string {
  return String(s || 'image').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'image';
}

function findExisting(files: Set<string>, prefix: string, id: string, name: string): boolean {
  const candidates = [
    `${prefix}-${safeName(id)}.jpg`, `${prefix}-${safeName(name)}.jpg`,
    `${prefix}-${safeName(id)}.png`, `${prefix}-${safeName(name)}.png`,
  ];
  return candidates.some(c => files.has(c));
}

function buildPortraitPrompt(npc: WorldFile['npcs'][0], era: string, region: string): string {
  return ['portrait photograph', era, region, `${npc.gender}, age ${npc.age}`,
    npc.physicalDescription || '', npc.occupation, npc.personality + ' expression',
    'head and shoulders, natural lighting, candid, photorealistic, atmospheric, no text',
  ].filter(Boolean).join(', ');
}

function buildLocationPrompt(loc: WorldFile['locations'][0], era: string, region: string): string {
  return ['wide establishing shot', era, region, loc.type, loc.description || loc.name,
    'daylight', 'no people, atmospheric, cinematic, environmental photography, photorealistic, no text',
  ].filter(Boolean).join(', ');
}

function buildWorldPrompt(world: WorldFile): string {
  return ['wide cinematic establishing shot', world.era?.period || '',
    world.geography?.region || world.geography?.country || '', world.geography?.terrain || '',
    world.concept, 'atmospheric, awe inspiring, environmental photography, photorealistic, no people, no text',
  ].filter(Boolean).join(', ');
}

function buildTaskList(worlds: WorldFile[]): ImageTask[] {
  const tasks: ImageTask[] = [];
  for (const world of worlds) {
    const era = world.era?.period || '';
    const region = world.geography?.region || world.geography?.country || '';
    const existing = getExistingFiles(world.id);
    const outDir = `public/generated/${world.id}`;

    if (!existing.has('cover.jpg') && !existing.has('cover.png')) {
      tasks.push({
        worldId: world.id, worldName: world.concept, type: 'cover',
        entityId: world.id, entityName: world.concept,
        prompt: buildWorldPrompt(world),
        outputPath: join(outDir, 'cover.jpg'), width: 960, height: 420,
      });
    }

    for (const npc of world.npcs) {
      if (!findExisting(existing, 'npc', npc.id, npc.name)) {
        tasks.push({
          worldId: world.id, worldName: world.concept, type: 'npc',
          entityId: npc.id, entityName: npc.name,
          prompt: buildPortraitPrompt(npc, era, region),
          outputPath: join(outDir, `npc-${safeName(npc.id)}.jpg`), width: 512, height: 512,
        });
      }
    }

    for (const loc of world.locations) {
      if (!findExisting(existing, 'loc', loc.id, loc.name)) {
        tasks.push({
          worldId: world.id, worldName: world.concept, type: 'location',
          entityId: loc.id, entityName: loc.name,
          prompt: buildLocationPrompt(loc, era, region),
          outputPath: join(outDir, `loc-${safeName(loc.id)}.jpg`), width: 800, height: 480,
        });
      }
    }
  }
  return tasks;
}

function aspectRatio(width: number, height: number): string {
  const ratio = width / height;
  if (ratio > 2) return '21:9';
  if (ratio > 1.6) return '16:9';
  if (ratio > 1.3) return '4:3';
  if (ratio > 1.1) return '3:2';
  if (ratio > 0.9) return '1:1';
  if (ratio > 0.7) return '3:4';
  return '9:16';
}

async function generateWithGemini(task: ImageTask): Promise<{ data: Buffer; mimeType: string } | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts: [{ text: `Generate this image: ${task.prompt}` }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429) {
        const wait = Math.min(120000, (attempt + 1) * 30000);
        console.warn(`    Rate limited, waiting ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }

      if (res.status === 503 || res.status >= 500) {
        const wait = (attempt + 1) * 10000;
        console.warn(`    Server error ${res.status}, retrying in ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`    HTTP ${res.status}: ${errBody.slice(0, 200)}`);
        return null;
      }

      const data: any = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts;
      if (!parts) {
        console.error(`    No parts in response`);
        return null;
      }

      for (const part of parts) {
        if (part.inlineData?.data) {
          return {
            data: Buffer.from(part.inlineData.data, 'base64'),
            mimeType: part.inlineData.mimeType || 'image/png',
          };
        }
      }

      console.error(`    No image data in response (got text only)`);
      return null;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.error(`    Timeout (120s)`);
      } else {
        console.error(`    Error: ${err.message}`);
      }
      if (attempt < 2) {
        await sleep(5000);
        continue;
      }
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let requestTimestamps: number[] = [];

async function rateLimitWait() {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < 60000);
  if (requestTimestamps.length >= RATE_LIMIT_RPM) {
    const oldest = requestTimestamps[0];
    const waitMs = 60000 - (now - oldest) + 500;
    if (waitMs > 0) {
      process.stdout.write(`  [rate limit] waiting ${(waitMs / 1000).toFixed(1)}s...`);
      await sleep(waitMs);
      console.log(' resumed');
    }
  }
  requestTimestamps.push(Date.now());
}

async function processTask(task: ImageTask, index: number, total: number): Promise<boolean> {
  const label = task.type === 'cover' ? 'cover' : `${task.type}: ${task.entityName}`;
  process.stdout.write(`  [${index + 1}/${total}] ${task.worldName.slice(0, 25)} > ${label}...`);

  await rateLimitWait();

  const result = await generateWithGemini(task);
  if (!result) {
    console.log(' FAILED');
    return false;
  }

  const fullPath = join(ROOT, task.outputPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, result.data);
  console.log(` done (${(result.data.length / 1024).toFixed(0)}KB)`);
  return true;
}

async function runWithConcurrency(tasks: ImageTask[], limit: number): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  let nextIndex = 0;
  const total = tasks.length;

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= tasks.length) return;
      const ok = await processTask(tasks[idx], idx, total);
      if (ok) success++;
      else failed++;
    }
  }));

  return { success, failed };
}

async function main() {
  console.log('Photo Fix (Gemini) — scanning worlds for missing images...');
  console.log(`Model: ${GEMINI_MODEL} | Concurrency: ${CONCURRENCY} | Rate limit: ${RATE_LIMIT_RPM}/min`);
  if (DRY_RUN) console.log('(DRY RUN — no images will be generated)\n');

  const worlds = loadWorlds();
  if (worlds.length === 0) {
    console.log('No worlds found' + (WORLD_FILTER ? ` matching "${WORLD_FILTER}"` : '') + '.');
    return;
  }

  const tasks = buildTaskList(worlds);
  console.log(`\nFound ${worlds.length} world(s), ${tasks.length} missing images`);
  console.log(`  Covers: ${tasks.filter(t => t.type === 'cover').length}`);
  console.log(`  NPC portraits: ${tasks.filter(t => t.type === 'npc').length}`);
  console.log(`  Location scenes: ${tasks.filter(t => t.type === 'location').length}`);
  console.log(`\nEstimated time: ~${Math.ceil(tasks.length / RATE_LIMIT_RPM)} minutes\n`);

  if (DRY_RUN) return;

  const startTime = Date.now();
  const { success, failed } = await runWithConcurrency(tasks, CONCURRENCY);
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log(`\n=== COMPLETE ===`);
  console.log(`  Generated: ${success}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Time: ${elapsed} minutes`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
