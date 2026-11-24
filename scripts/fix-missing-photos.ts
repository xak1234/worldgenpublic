/**
 * Standalone photo generator — scans all worlds for missing NPC portraits
 * and location scene images, then generates them.
 *
 * Usage: npx tsx scripts/fix-missing-photos.ts [--world <id>] [--dry-run]
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  generateImage,
  buildPortraitPrompt,
  buildLocationPrompt,
  buildWorldPrompt,
  saveDataUrlImage,
} from '../src/imageGen.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const GENERATED_DIR = join(ROOT, 'public', 'generated');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const WORLD_FILTER = args.includes('--world') ? args[args.indexOf('--world') + 1] : null;

interface WorldFile {
  id: string;
  concept: string;
  era?: { period?: string };
  geography?: { region?: string; country?: string; terrain?: string };
  npcs: Array<{ id: string; name: string; age: number; gender: string; ethnicity?: string; physicalDescription?: string; occupation: string; personality: string }>;
  locations: Array<{ id: string; name: string; type: string; description?: string }>;
  images?: { cover?: string; portraits?: Record<string, string>; scenes?: Record<string, string> };
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

function findExistingAsset(files: Set<string>, prefix: string, id: string, name: string): string | null {
  const candidates = [
    `${prefix}-${safeName(id)}.jpg`,
    `${prefix}-${safeName(name)}.jpg`,
    `${prefix}-${safeName(id)}.png`,
    `${prefix}-${safeName(name)}.png`,
  ];
  for (const c of candidates) {
    if (files.has(c)) return c;
  }
  return null;
}

async function processWorld(world: WorldFile) {
  const era = world.era?.period || '';
  const region = world.geography?.region || world.geography?.country || '';
  const outputDir = join(GENERATED_DIR, world.id);
  const existingFiles = getExistingFiles(world.id);

  const missingNpcs = world.npcs.filter(npc => !findExistingAsset(existingFiles, 'npc', npc.id, npc.name));
  const missingLocs = world.locations.filter(loc => !findExistingAsset(existingFiles, 'loc', loc.id, loc.name));
  const hasCover = existingFiles.has('cover.jpg') || existingFiles.has('cover.png');

  const totalMissing = missingNpcs.length + missingLocs.length + (hasCover ? 0 : 1);
  if (totalMissing === 0) {
    console.log(`  All photos present (${world.npcs.length} NPCs, ${world.locations.length} locations, cover)`);
    return;
  }

  console.log(`  Missing: ${hasCover ? '' : '1 cover, '}${missingNpcs.length} NPC portraits, ${missingLocs.length} location scenes`);
  if (DRY_RUN) return;

  mkdirSync(outputDir, { recursive: true });
  let generated = 0;
  let failed = 0;

  // Cover
  if (!hasCover) {
    const prompt = buildWorldPrompt(world);
    process.stdout.write(`    [cover] Generating...`);
    const result = await generateImage(prompt, { width: 960, height: 420, seed: hashCode(world.id) });
    if (result.dataUrl) {
      saveDataUrlImage(result.dataUrl, join(outputDir, 'cover.jpg'));
      console.log(' done');
      generated++;
    } else {
      console.log(' FAILED' + (result.rateLimited ? ' (rate limited)' : ''));
      failed++;
    }
  }

  // NPC portraits
  for (const npc of missingNpcs) {
    const prompt = buildPortraitPrompt(npc, era, region);
    const fileName = `npc-${safeName(npc.id)}.jpg`;
    process.stdout.write(`    [npc] ${npc.name}...`);
    const result = await generateImage(prompt, { width: 512, height: 512, seed: hashCode(npc.id) });
    if (result.dataUrl) {
      saveDataUrlImage(result.dataUrl, join(outputDir, fileName));
      console.log(' done');
      generated++;
    } else {
      console.log(' FAILED' + (result.rateLimited ? ' (rate limited)' : ''));
      failed++;
      if (result.rateLimited) {
        console.log('    Rate limited — pausing 60s...');
        await sleep(60000);
      }
    }
  }

  // Location scenes
  for (const loc of missingLocs) {
    const prompt = buildLocationPrompt(loc, era, region);
    const fileName = `loc-${safeName(loc.id)}.jpg`;
    process.stdout.write(`    [loc] ${loc.name}...`);
    const result = await generateImage(prompt, { width: 800, height: 480, seed: hashCode(loc.id) });
    if (result.dataUrl) {
      saveDataUrlImage(result.dataUrl, join(outputDir, fileName));
      console.log(' done');
      generated++;
    } else {
      console.log(' FAILED' + (result.rateLimited ? ' (rate limited)' : ''));
      failed++;
      if (result.rateLimited) {
        console.log('    Rate limited — pausing 60s...');
        await sleep(60000);
      }
    }
  }

  console.log(`  Results: ${generated} generated, ${failed} failed`);
}

function hashCode(s: string): number {
  s = String(s || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 999999;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Photo Fix — scanning worlds for missing images...');
  if (DRY_RUN) console.log('(DRY RUN — no images will be generated)\n');

  const worlds = loadWorlds();
  if (worlds.length === 0) {
    console.log('No worlds found' + (WORLD_FILTER ? ` matching id "${WORLD_FILTER}"` : '') + '.');
    return;
  }

  console.log(`Found ${worlds.length} world(s)\n`);

  for (const world of worlds) {
    console.log(`[${world.id}] "${world.concept}"`);
    console.log(`  ${world.npcs.length} NPCs, ${world.locations.length} locations`);
    await processWorld(world);
    console.log('');
  }

  console.log('Done.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
