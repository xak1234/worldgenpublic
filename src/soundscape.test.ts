import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchSounds, __test as freesoundTest } from './freesound.js';
import { buildLocalSoundscape, __test as localSoundscapeTest } from './localSoundscape.js';
import type { CurrentWeather, FreesoundResult, WorldLocation } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const AUDIO_ROOT = join(ROOT, 'public', 'audio');
const DATA_ROOT = join(ROOT, 'data');

function location(): WorldLocation {
  return {
    id: 'club-01',
    name: 'Sunset Rooftop',
    type: 'club',
    description: 'A rooftop venue above the city.',
    ambientDetail: 'Rain rattles loose signage while the bass leaks through the walls.',
    connectedTo: [],
    socialClass: 'mixed',
    openHours: 'all night',
    regulars: [],
    interactables: [],
    privacyLevel: 'public',
    capacity: 'crowded',
  };
}

function weather(overrides: Partial<CurrentWeather> = {}): CurrentWeather {
  return {
    condition: 'storm',
    intensity: 'heavy',
    temperatureC: 18,
    wind: 'gusting',
    visibility: 'poor',
    precipitation: 'rain',
    thunder: true,
    lightning: true,
    mood: 'tense',
    effects: [],
    changedAt: '2026-05-21T20:00:00.000Z',
    ...overrides,
  };
}

{
  const concept = `${'Event Horizon drifting over a black sea of memory. '.repeat(20)}Kevin & Perry afterparty`;
  const base = freesoundTest.buildSoundscapeContextHash(location(), weather(), 'night', 'crowded', concept, 'world-a');
  const weatherChanged = freesoundTest.buildSoundscapeContextHash(
    location(),
    weather({ precipitation: 'none', thunder: false, lightning: false, condition: 'clear', intensity: 'clear' }),
    'night',
    'crowded',
    concept,
    'world-a',
  );
  const timeChanged = freesoundTest.buildSoundscapeContextHash(location(), weather(), 'dawn', 'crowded', concept, 'world-a');
  const crowdChanged = freesoundTest.buildSoundscapeContextHash(location(), weather(), 'night', 'sparse', concept, 'world-a');
  const worldChanged = freesoundTest.buildSoundscapeContextHash(location(), weather(), 'night', 'crowded', `${concept} alt`, 'world-b');

  assert.notEqual(base, weatherChanged);
  assert.notEqual(base, timeChanged);
  assert.notEqual(base, crowdChanged);
  assert.notEqual(base, worldChanged);
}

{
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const calls: string[] = [];
  const sample: FreesoundResult = {
    id: 42,
    name: 'rain city',
    previews: {
      'preview-hq-mp3': 'https://example.com/hq.mp3',
      'preview-lq-mp3': 'https://example.com/lq.mp3',
    },
    duration: 8,
    tags: ['rain', 'city'],
  };

  try {
    freesoundTest.clearCaches();
    console.warn = () => {};
    let attempt = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, status: 500 } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [sample] }),
      } as Response;
    }) as typeof fetch;

    assert.deepEqual(await searchSounds('rain city ambience'), []);
    const second = await searchSounds('rain city ambience');
    assert.equal(second.length, 1);
    assert.equal(second[0]?.id, sample.id);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    freesoundTest.clearCaches();
  }
}

// Pack selection with a throwaway fixture pack, so a clean checkout (which ships no sound packs)
// still exercises the logic: world-id match, concept-phrase match, and no match.
{
  const createdAudioRoot = !existsSync(AUDIO_ROOT);
  const fixtureDir = join(AUDIO_ROOT, 'zz_test_fixture_pack');
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, 'pack.json'), JSON.stringify({
    name: 'zz_test_fixture_pack', dir: 'zz_test_fixture_pack',
    worldIds: ['fixture-world-0001'], match: ['lighthouse fog harbour'], base: { theme: 'base' },
  }));
  try {
    assert.equal(localSoundscapeTest.pickPackName('anything at all', 'fixture-world-0001'), 'zz_test_fixture_pack');
    assert.equal(localSoundscapeTest.pickPackName('A lighthouse fog harbour where secrets drift'), 'zz_test_fixture_pack');
    assert.equal(localSoundscapeTest.pickPackName('An escalating corporate scandal of Seattle elites'), null);
  } finally {
    rmSync(createdAudioRoot ? AUDIO_ROOT : fixtureDir, { recursive: true, force: true });
  }
}

// The remaining checks assert the specific film-world packs and worlds of a full local install.
// A clean checkout ships neither, so they run only where those packs are present.
const INSTALLED_PACKS = ['pete_tong', 'hellraiser', 'blade_runner', 'blade', 'pretty_woman', 'fifty_shades', 'war_of_the_worlds',
  'thelma_louise', 'fatal_attraction', 'sleeping_with_the_enemy', 'fifty_first_dates', 'addams_family', 'walk_the_line'];
const missingPacks = INSTALLED_PACKS.filter(name => !existsSync(join(AUDIO_ROOT, name, 'pack.json')));
if (missingPacks.length) {
  console.log(`soundscape: skipped installed-pack checks (packs not present: ${missingPacks.length}/${INSTALLED_PACKS.length})`);
  console.log('soundscape checks passed');
  process.exit(0);
}

assert.equal(localSoundscapeTest.pickPackName('Kevin & Perry Go Large', 'build_9753e2d9-5d1a-4567-8eaf-eb1a2f9ef844'), 'pete_tong');
assert.equal(localSoundscapeTest.pickPackName('Clive Bakers Hellraiser Vol1', 'build_aa96db74-f484-4806-a897-3a5d99c55601'), 'hellraiser');
assert.equal(localSoundscapeTest.pickPackName('Blade Runner 2300, Us or them'), 'blade_runner');
assert.equal(localSoundscapeTest.pickPackName('Blade Runner 2300, Us or them', '225ae84d-0c01-4140-8386-9cf0eed391b0'), 'blade');
assert.equal(localSoundscapeTest.pickPackName('Pretty Woman', 'build_02149dec-a237-4145-9e74-adae3398abc5'), 'pretty_woman');
assert.equal(localSoundscapeTest.pickPackName('Fifty Shades of Grey World 2015', '499e6152-106d-4b9e-9a47-394fd9726015'), 'fifty_shades');
assert.equal(localSoundscapeTest.pickPackName('War of the Worlds', 'build_46764b1c-1ea5-4d0e-91e6-02347764b9ee'), 'war_of_the_worlds');
assert.equal(localSoundscapeTest.pickPackName('Thelma & Louise', 'build_177104f7-bf90-41fd-a637-ba863204c54c'), 'thelma_louise');
assert.equal(localSoundscapeTest.pickPackName('Fatal Attraction', 'build_a822c5b7-2e54-4cff-8fc0-8f9ab3fd24c7'), 'fatal_attraction');
assert.equal(localSoundscapeTest.pickPackName('Sleeping with the Enemy', 'build_1d7b70ef-baa0-4847-a66b-f760ff3e34a2'), 'sleeping_with_the_enemy');
assert.equal(localSoundscapeTest.pickPackName('50 First Dates', 'build_81ba2423-caf7-481e-8c92-003ec19f7d83'), 'fifty_first_dates');
assert.equal(localSoundscapeTest.pickPackName('An escalating corporate scandal of Seattle elites'), null);

{
  const manifest = buildLocalSoundscape({
    location: {
      ...location(),
      id: 'office-01',
      name: "Edward Lewis's Office",
      type: 'corporate office',
      ambientDetail: 'A private executive office high above the city.',
    },
    weather: weather({ precipitation: 'none', thunder: false, lightning: false, condition: 'clear', intensity: 'clear' }),
    contextHash: 'pretty-office',
    timeBucket: 'afternoon',
    crowdBucket: 'sparse',
    weatherCondition: 'clear',
    worldConcept: 'Pretty Woman',
    worldId: 'build_02149dec-a237-4145-9e74-adae3398abc5',
  });
  assert.ok(manifest);
  const layerThemes = new Set((manifest?.layers ?? []).flatMap(layer => layer.tags?.slice(1, 2) ?? []));
  assert.ok(layerThemes.has('luxury_suite'));
  assert.ok(!layerThemes.has('crowd_glamour'));
}

{
  const manifest = buildLocalSoundscape({
    location: {
      ...location(),
      id: 'bar-01',
      name: 'The Salty Siren Dive Bar',
      type: 'Grungy Neighborhood Bar',
      ambientDetail: 'Sticky floors, neon beer signs, and whispered gossip in dark corners.',
    },
    weather: weather(),
    contextHash: 'fifty-bar',
    timeBucket: 'night',
    crowdBucket: 'crowded',
    weatherCondition: 'storm',
    worldConcept: 'Fifty Shades of Grey World 2015',
    worldId: '499e6152-106d-4b9e-9a47-394fd9726015',
  });
  assert.ok(manifest);
  const layerThemes = new Set((manifest?.layers ?? []).flatMap(layer => layer.tags?.slice(1, 2) ?? []));
  assert.ok(layerThemes.has('private_club'));
  assert.ok(!layerThemes.has('corporate_glass'));
}

{
  const manifest = buildLocalSoundscape({
    location: {
      ...location(),
      id: 'penthouse-01',
      name: 'Escala Penthouse',
      type: 'Luxury Residence',
      ambientDetail: 'A sealed glass aerie above Seattle with expensive quiet and modern art.',
    },
    weather: weather({ precipitation: 'none', thunder: false, lightning: false, condition: 'clear', intensity: 'clear' }),
    contextHash: 'escala-home',
    timeBucket: 'evening',
    crowdBucket: 'moderate',
    weatherCondition: 'clear',
    worldConcept: 'Fifty Shades of Grey World 2015',
    worldId: '499e6152-106d-4b9e-9a47-394fd9726015',
  });
  assert.ok(manifest);
  const urls = manifest?.layers.map(layer => layer.soundUrl) ?? [];
  assert.equal(new Set(urls).size, urls.length);
}

{
  const manifest = buildLocalSoundscape({
    location: {
      ...location(),
      id: 'campus-01',
      name: 'Berkeley Campus Walkway',
      type: 'college campus',
      ambientDetail: 'Students drift past the fountain while distant traffic hangs over the afternoon heat.',
    },
    weather: weather({ precipitation: 'none', thunder: false, lightning: false, condition: 'clear', intensity: 'clear' }),
    contextHash: 'graduate-campus',
    timeBucket: 'afternoon',
    crowdBucket: 'moderate',
    weatherCondition: 'clear',
    worldConcept: 'The Graduate',
    worldId: 'build_b664e151-621f-4ec7-a0ac-6cbcbfca1db6',
  });
  assert.ok(manifest);
  const urls = manifest?.layers.map(layer => layer.soundUrl) ?? [];
  assert.ok(urls.length > 0);
  assert.ok(urls.some(url => !url.includes('/audio/the_graduate/')), 'expected cross-pack fallback audio for The Graduate');
}

{
  const manifest = buildLocalSoundscape({
    location: {
      ...location(),
      id: 'suburb-01',
      name: 'Bayonne Neighborhood Street',
      type: 'suburban street',
      ambientDetail: 'Emergency sirens ripple over stalled traffic while terrified families run for cover.',
    },
    weather: weather(),
    contextHash: 'wotw-suburb',
    timeBucket: 'night',
    crowdBucket: 'crowded',
    weatherCondition: 'storm',
    worldConcept: 'War of the Worlds',
    worldId: 'build_46764b1c-1ea5-4d0e-91e6-02347764b9ee',
  });
  assert.ok(manifest);
  const urls = manifest?.layers.map(layer => layer.soundUrl) ?? [];
  assert.ok(urls.length >= 2, 'expected multiple layers for War of the Worlds');
}

{
  const warWorld = JSON.parse(readFileSync(join(DATA_ROOT, 'world-build_46764b1c-1ea5-4d0e-91e6-02347764b9ee.json'), 'utf-8')) as { concept: string; id: string; locations: WorldLocation[] };
  const manifest = buildLocalSoundscape({
    location: warWorld.locations.find(loc => loc.id === 'cargo_dock') ?? warWorld.locations[0],
    weather: weather({ precipitation: 'none', thunder: false, lightning: false, condition: 'clear', intensity: 'clear' }),
    contextHash: 'wotw-cargo-dock',
    timeBucket: 'night',
    crowdBucket: 'sparse',
    weatherCondition: 'clear',
    worldConcept: warWorld.concept,
    worldId: warWorld.id,
  });
  const urls = manifest?.layers.map(layer => layer.soundUrl) ?? [];
  assert.ok(urls.length >= 2, 'expected sparse War of the Worlds pack to borrow fallback ambience');
}

for (const [concept, worldId, file] of [
  ['The Addams Family', 'build_70dfb0ea-7a20-4cc9-af80-b71dad55b9eb', '/audio/addams_family/theme_song/addams.mp3'],
  ['Walk The Line', 'build_2bc07ced-65b3-4f94-a64a-42ef94f38fbe', '/audio/walk_the_line/theme_song/walk.mp3'],
  ['War of the Worlds', 'build_46764b1c-1ea5-4d0e-91e6-02347764b9ee', '/audio/war_of_the_worlds/theme_song/war.mp3'],
] as const) {
  const manifest = buildLocalSoundscape({
    location: location(),
    weather: weather({ precipitation: 'none', thunder: false, lightning: false, condition: 'clear', intensity: 'clear' }),
    contextHash: `${concept}-theme-track`,
    timeBucket: 'night',
    crowdBucket: 'sparse',
    weatherCondition: 'clear',
    worldConcept: concept,
    worldId,
  });
  assert.ok(manifest?.layers.some(layer => layer.type === 'music' && layer.soundUrl === file), `expected ${file}`);
}

for (const entry of readdirSync(AUDIO_ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packPath = join(AUDIO_ROOT, entry.name, 'pack.json');
  if (!existsSync(packPath)) continue;
  const pack = JSON.parse(readFileSync(packPath, 'utf-8')) as { name: string; worldIds?: string[] };
  for (const worldId of pack.worldIds ?? []) {
    assert.ok(
      existsSync(join(DATA_ROOT, `world-${worldId}.json`)),
      `${pack.name} references missing worldId ${worldId}`,
    );
  }
}

console.log('soundscape checks passed');
