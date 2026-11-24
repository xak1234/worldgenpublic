/**
 * generate-photo-manifest.mjs
 * Scans all world-*.json files, checks existing generated images,
 * and writes photo-fix-full-manifest.json for every missing image.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const GENERATED_DIR = join(ROOT, 'public', 'generated');
const OUTPUT_FILE = join(ROOT, 'photo-fix-full-manifest.json');
const API_KEY = 'sk_rNCKHWitg8DFWP7lQtJKrH7KnDiB270Z';
const POLLINATIONS_URL = 'https://image.pollinations.ai/prompt';

// ---- helpers ---------------------------------------------------------------

function hashCode(s) {
  s = String(s || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 999999;
}

function safeName(s) {
  return String(s || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image';
}

function buildWorldPrompt(world) {
  const parts = [
    'wide cinematic establishing shot',
    world.era?.period || '',
    world.geography?.region || world.geography?.country || '',
    world.geography?.terrain || '',
    world.concept,
    'atmospheric, awe inspiring, environmental photography, photorealistic, no people, no text',
  ].filter(Boolean);
  return parts.join(', ');
}

function buildPortraitPrompt(npc, era, region) {
  const parts = [
    'portrait photograph',
    era,
    region,
    `${npc.gender}, age ${npc.age}`,
    npc.physicalDescription || '',
    npc.occupation,
    npc.personality + ' expression',
    'head and shoulders, natural lighting, candid, photorealistic, atmospheric, no text',
  ].filter(Boolean);
  return parts.join(', ');
}

function buildLocationPrompt(location, era, region) {
  const parts = [
    'wide establishing shot',
    era,
    region,
    location.type,
    location.description || location.name,
    'daylight',
    'no people, atmospheric, cinematic, environmental photography, photorealistic, no text',
  ].filter(Boolean);
  return parts.join(', ');
}

function getImageUrl(prompt, { width, height, seed }) {
  const encoded = encodeURIComponent(prompt);
  return `${POLLINATIONS_URL}/${encoded}?seed=${seed}&width=${width}&height=${height}&nologo=true&nofeed=true&model=flux&token=${API_KEY}`;
}

function getExistingFiles(worldId) {
  const dir = join(GENERATED_DIR, worldId);
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter(f => /\.(jpg|png|webp)$/i.test(f)));
}

function findExistingAsset(files, prefix, id, name) {
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

// ---- main ------------------------------------------------------------------

const worldFiles = readdirSync(DATA_DIR)
  .filter(f => f.startsWith('world-') && f.endsWith('.json'))
  .sort();

console.log(`Found ${worldFiles.length} world files`);

const images = [];

for (const file of worldFiles) {
  let world;
  try {
    world = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    console.warn(`  Skipping ${file}: ${e.message}`);
    continue;
  }

  const era = world.era?.period || '';
  const region = world.geography?.region || world.geography?.country || '';
  const existing = getExistingFiles(world.id);

  console.log(`\n[${world.id}] "${world.concept}"`);
  console.log(`  ${world.npcs?.length ?? 0} NPCs, ${world.locations?.length ?? 0} locations`);
  console.log(`  Existing files: ${existing.size}`);

  // Cover
  const hasCover = existing.has('cover.jpg') || existing.has('cover.png');
  if (!hasCover) {
    const prompt = buildWorldPrompt(world);
    const seed = hashCode(world.id);
    const width = 960, height = 420;
    const url = getImageUrl(prompt, { width, height, seed });
    images.push({
      worldId: world.id,
      worldName: world.concept,
      type: 'cover',
      entityId: world.id,
      entityName: world.concept,
      prompt,
      url,
      outputPath: `public/generated/${world.id}/cover.jpg`,
      width,
      height,
      seed,
    });
    console.log(`  MISSING: cover`);
  } else {
    console.log(`  OK: cover`);
  }

  // NPC portraits
  for (const npc of (world.npcs || [])) {
    const exists = findExistingAsset(existing, 'npc', npc.id, npc.name);
    if (!exists) {
      const prompt = buildPortraitPrompt(npc, era, region);
      const seed = hashCode(npc.id);
      const width = 512, height = 512;
      const url = getImageUrl(prompt, { width, height, seed });
      const fileName = `npc-${safeName(npc.id)}.jpg`;
      images.push({
        worldId: world.id,
        worldName: world.concept,
        type: 'npc',
        entityId: npc.id,
        entityName: npc.name,
        prompt,
        url,
        outputPath: `public/generated/${world.id}/${fileName}`,
        width,
        height,
        seed,
      });
      console.log(`  MISSING npc: ${npc.name} (${npc.id})`);
    }
  }

  // Location scenes
  for (const loc of (world.locations || [])) {
    const exists = findExistingAsset(existing, 'loc', loc.id, loc.name);
    if (!exists) {
      const prompt = buildLocationPrompt(loc, era, region);
      const seed = hashCode(loc.id);
      const width = 800, height = 480;
      const url = getImageUrl(prompt, { width, height, seed });
      const fileName = `loc-${safeName(loc.id)}.jpg`;
      images.push({
        worldId: world.id,
        worldName: world.concept,
        type: 'location',
        entityId: loc.id,
        entityName: loc.name,
        prompt,
        url,
        outputPath: `public/generated/${world.id}/${fileName}`,
        width,
        height,
        seed,
      });
      console.log(`  MISSING loc: ${loc.name} (${loc.id})`);
    }
  }
}

const manifest = {
  totalImages: images.length,
  provider: 'pollinations',
  apiKey: API_KEY,
  images,
};

writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\nWrote ${images.length} missing images to ${OUTPUT_FILE}`);
