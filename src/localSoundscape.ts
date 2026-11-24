import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SoundscapeManifest, SoundscapeLayer, WorldLocation, CurrentWeather } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIO_ROOT = join(HERE, '..', 'public', 'audio');

interface KwRule { kw: string[]; theme: string; }
interface LayerRule { default: string; byKeyword?: KwRule[]; }
interface Pack {
  name: string; dir: string;
  worldIds?: string[]; match?: string[];
  volumes?: { base?: number; detail?: number; weather?: number; crowd?: number; music?: number };
  base: LayerRule; detail?: LayerRule;
  weatherTheme?: string; crowdTheme?: string; musicTheme?: string;
}

interface ThemeSource {
  packDir: string;
  theme: string;
  query: string;
  files: string[];
}

const packCache = new Map<string, { mtimeMs: number; pack: Pack }>();
const themeQueryCache = new Map<string, { mtimeMs: number; queries: Record<string, string> }>();
let globalThemeSourceCache: ThemeSource[] | null = null;

const THEME_STOPWORDS = new Set([
  'a', 'an', 'and', 'ambience', 'ambient', 'ambience', 'ambients', 'background', 'cinematic',
  'deep', 'distant', 'drone', 'effect', 'effects', 'emergency', 'hum', 'interior', 'low',
  'noise', 'room', 'sound', 'sounds', 'the', 'tone',
]);

const TOKEN_ALIASES: Record<string, string[]> = {
  alien: ['space', 'spaceship', 'scifi', 'tripod', 'probe', 'invasion', 'dread'],
  apartment: ['suite', 'flat', 'interior', 'home', 'house', 'hotel'],
  basement: ['cellar', 'bunker', 'underground', 'hideout'],
  bar: ['club', 'pub', 'lounge', 'restaurant', 'party', 'crowd'],
  campus: ['college', 'school', 'berkeley', 'students'],
  cargo: ['dock', 'harbor', 'industrial', 'crane', 'chains'],
  city: ['street', 'urban', 'traffic', 'manhattan', 'night'],
  crowd: ['bar', 'club', 'market', 'party', 'street', 'panic'],
  danger: ['tension', 'dread', 'panic', 'alarm', 'sirens'],
  dock: ['cargo', 'harbor', 'ferry', 'waterfront', 'river', 'boat'],
  electrical: ['emp', 'storm', 'thunder', 'crackle', 'transformer', 'alarm'],
  emergency: ['panic', 'alarm', 'sirens', 'evacuation', 'chaos'],
  field: ['forest', 'moor', 'outdoor', 'wind', 'grass'],
  harbor: ['dock', 'cargo', 'ferry', 'waterfront', 'river'],
  highway: ['road', 'traffic', 'car', 'street', 'drive'],
  home: ['house', 'apartment', 'suburban', 'residence', 'suite'],
  horn: ['alarm', 'klaxon', 'siren', 'beep'],
  hotel: ['suite', 'apartment', 'room', 'lobby'],
  house: ['home', 'apartment', 'suburban', 'residence', 'quiet'],
  invasion: ['alien', 'tripod', 'panic', 'war', 'emergency'],
  medical: ['hospital', 'beep', 'corridor'],
  office: ['corporate', 'phones', 'boardroom'],
  panic: ['crowd', 'alarm', 'sirens', 'emergency', 'chaos'],
  pool: ['water', 'underwater', 'swimming', 'bubbles'],
  probe: ['camera', 'servo', 'mechanical', 'search', 'alien'],
  rain: ['storm', 'thunder', 'water', 'window'],
  road: ['highway', 'traffic', 'car', 'drive', 'street'],
  space: ['alien', 'spaceship', 'engine', 'airlock', 'alarm', 'scifi'],
  storm: ['rain', 'thunder', 'wind', 'electrical', 'emp'],
  street: ['city', 'urban', 'traffic', 'crowd'],
  suburban: ['home', 'house', 'neighborhood', 'street', 'quiet'],
  suite: ['apartment', 'hotel', 'room', 'luxury'],
  tension: ['dread', 'drone', 'panic', 'uneasy', 'obsessive'],
  traffic: ['road', 'highway', 'street', 'city', 'car'],
  tripod: ['alien', 'horn', 'invasion', 'machine', 'alarm'],
  underwater: ['pool', 'water', 'bubbles', 'breathing'],
  war: ['battlefield', 'barrage', 'bomb', 'artillery', 'panic'],
  water: ['river', 'ocean', 'dock', 'ferry', 'pool'],
  wind: ['storm', 'field', 'forest', 'outdoor', 'howl'],
};

function expandedTokens(value: string | undefined): string[] {
  const base = normalizeText(value).split(' ').filter(token => token && !THEME_STOPWORDS.has(token));
  const out = new Set<string>();
  for (const token of base) {
    out.add(token);
    for (const alias of TOKEN_ALIASES[token] ?? []) out.add(alias);
  }
  return [...out];
}

function themeScore(targetText: string, theme: string, query: string, preferredTheme?: string | null): number {
  const target = expandedTokens(targetText);
  const candidate = new Set<string>(expandedTokens(`${theme} ${query}`));
  let score = preferredTheme && theme === preferredTheme ? 20 : 0;
  for (const token of target) {
    if (!candidate.has(token)) continue;
    score += token.length >= 8 ? 5 : token.length >= 5 ? 3 : 2;
  }
  if (preferredTheme && normalizeText(theme).includes(normalizeText(preferredTheme))) score += 6;
  return score;
}

function normalizeText(value: string | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadPacks(): Pack[] {
  const out: Pack[] = [];
  if (!existsSync(AUDIO_ROOT)) return out;
  for (const entry of readdirSync(AUDIO_ROOT)) {
    const pj = join(AUDIO_ROOT, entry, 'pack.json');
    if (!existsSync(pj)) continue;
    try {
      const m = statSync(pj).mtimeMs;
      const cached = packCache.get(pj);
      if (cached && cached.mtimeMs === m) { out.push(cached.pack); continue; }
      const pack = JSON.parse(readFileSync(pj, 'utf-8')) as Pack;
      if (!pack.dir) pack.dir = entry;
      packCache.set(pj, { mtimeMs: m, pack });
      out.push(pack);
    } catch { /* ignore malformed pack */ }
  }
  return out;
}

function loadThemeQueries(packDir: string): Record<string, string> {
  const file = join(AUDIO_ROOT, packDir, '_themes.json');
  if (!existsSync(file)) return {};
  try {
    const m = statSync(file).mtimeMs;
    const cached = themeQueryCache.get(file);
    if (cached && cached.mtimeMs === m) return cached.queries;
    const queries = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
    themeQueryCache.set(file, { mtimeMs: m, queries });
    globalThemeSourceCache = null;
    return queries;
  } catch {
    return {};
  }
}

function normalizedPhraseMatch(hay: string, needle: string | undefined): boolean {
  const normalizedNeedle = normalizeText(needle);
  if (!normalizedNeedle) return false;
  const paddedHay = ` ${hay} `;
  return paddedHay.includes(` ${normalizedNeedle} `);
}

function includesNormalized(hay: string, needle: string | undefined): boolean {
  return normalizedPhraseMatch(hay, needle);
}

function bestConceptMatchLength(pack: Pack, concept: string): number {
  let best = 0;
  for (const raw of pack.match ?? []) {
    const normalized = normalizeText(raw);
    if (!normalized || !normalizedPhraseMatch(concept, normalized)) continue;
    if (normalized.length > best) best = normalized.length;
  }
  return best;
}

function genreFallbackPackNames(concept: string): string[] {
  const sciFi = /\b(sci fi|scifi|science fiction|space|starship|spaceship|alien|android|robot|cyberpunk|future|futuristic|colony|mars|lunar|orbital)\b/.test(concept);
  const horror = /\b(horror|haunted|nightmare|demonic|demon|possession|possessed|exorcism|ghost|occult|slasher|chainsaw|vampire|zombie|monster|creature|gothic|body horror|cosmic horror)\b/.test(concept);
  const out: string[] = [];

  if (sciFi && horror) out.push('event_horizon', 'alien_1979_the_nostromo_rescue_signal', 'alien_planet_2099_earths_last_remaining');
  if (/\b(alien|xenomorph|nostromo|distress signal|creature)\b/.test(concept)) out.push('alien_1979_the_nostromo_rescue_signal', 'alien_planet_2099_earths_last_remaining');
  if (/\b(cyberpunk|replicant|android|neon|megacity|dystopian|blade runner)\b/.test(concept)) out.push('blade_runner');
  if (sciFi) out.push('year_3000_humans_live_on_stsrships', 'red_dwarf', 'alien_planet_2099_earths_last_remaining', 'blade_runner');

  if (/\b(possession|possessed|exorcism|exorcist|demonic|demon|priest|dybbuk)\b/.test(concept)) out.push('the_exorcist', 'the_possession', 'hellraiser');
  if (/\b(vampire|dracula|gothic|castle|crypt)\b/.test(concept)) out.push('dracula', 'lost_boys');
  if (/\b(slasher|chainsaw|leatherface|butcher|rural horror|desert horror|mutant)\b/.test(concept)) out.push('texas_chainsaw_massacre', 'the_hills_have_eyes');
  if (/\b(haunted hotel|hotel horror|isolation|snowbound|overlook)\b/.test(concept)) out.push('the_shining', 'phantasm');
  if (horror) out.push('hellraiser', 'phantasm', 'event_horizon', 'dracula');

  return [...new Set(out)];
}

function pickPack(worldConcept?: string, worldId?: string): Pack | null {
  const packs = loadPacks();
  const concept = normalizeText(worldConcept);
  const wid = String(worldId ?? '');
  let best: { pack: Pack; priority: number; specificity: number } | null = null;
  for (const p of packs) {
    const priority = wid && p.worldIds?.includes(wid) ? 2 : concept ? 1 : 0;
    const specificity = priority === 2 ? wid.length : bestConceptMatchLength(p, concept);
    if (priority === 0 || specificity === 0) continue;
    if (
      !best
      || priority > best.priority
      || (priority === best.priority && specificity > best.specificity)
      || (priority === best.priority && specificity === best.specificity && p.name.localeCompare(best.pack.name) < 0)
    ) {
      best = { pack: p, priority, specificity };
    }
  }
  if (best) return best.pack;
  for (const fallback of genreFallbackPackNames(concept)) {
    const pack = packs.find(p => p.name === fallback || p.dir === fallback);
    if (pack) return pack;
  }
  return null;
}

export function hasMatchingAudioPack(worldId?: string, concept?: string): boolean {
  return pickPack(concept, worldId) !== null;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function listMp3(packDir: string, theme: string): string[] {
  const dir = join(AUDIO_ROOT, packDir, theme);
  if (!existsSync(dir)) return [];
  try { return readdirSync(dir).filter(f => f.toLowerCase().endsWith('.mp3')).sort(); }
  catch { return []; }
}

function themesWithFiles(packDir: string): string[] {
  const root = join(AUDIO_ROOT, packDir);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter(e => { try { return statSync(join(root, e)).isDirectory(); } catch { return false; } })
      .filter(e => listMp3(packDir, e).length > 0)
      .sort();
  } catch { return []; }
}

function themeSource(packDir: string, theme: string): ThemeSource | null {
  const files = listMp3(packDir, theme);
  if (files.length === 0) return null;
  return {
    packDir,
    theme,
    query: loadThemeQueries(packDir)[theme] ?? theme,
    files,
  };
}

function allThemeSources(): ThemeSource[] {
  if (globalThemeSourceCache) return globalThemeSourceCache;
  const out: ThemeSource[] = [];
  for (const pack of loadPacks()) {
    const queries = loadThemeQueries(pack.dir);
    const seen = new Set<string>();
    for (const theme of Object.keys(queries)) {
      seen.add(theme);
      const source = themeSource(pack.dir, theme);
      if (source) out.push(source);
    }
    for (const theme of themesWithFiles(pack.dir)) {
      if (seen.has(theme)) continue;
      const source = themeSource(pack.dir, theme);
      if (source) out.push(source);
    }
  }
  globalThemeSourceCache = out;
  return out;
}

function bestSource(
  requestedTheme: string | null | undefined,
  targetText: string,
  candidates: ThemeSource[],
): ThemeSource | null {
  let best: { source: ThemeSource; score: number } | null = null;
  for (const candidate of candidates) {
    const score = themeScore(targetText, candidate.theme, candidate.query, requestedTheme);
    if (score <= 0) continue;
    if (
      !best
      || score > best.score
      || (score === best.score && candidate.files.length > best.source.files.length)
      || (score === best.score && candidate.files.length === best.source.files.length
        && `${candidate.packDir}/${candidate.theme}`.localeCompare(`${best.source.packDir}/${best.source.theme}`) < 0)
    ) {
      best = { source: candidate, score };
    }
  }
  return best?.source ?? null;
}

function resolveThemeSource(packDir: string, requestedTheme: string | null | undefined, targetText: string): ThemeSource | null {
  if (requestedTheme) {
    const exact = themeSource(packDir, requestedTheme);
    if (exact) return exact;
  }
  const queries = loadThemeQueries(packDir);
  const localCandidates = Object.keys(queries)
    .filter(theme => requestedTheme === 'theme_song' || theme !== 'theme_song')
    .map(theme => themeSource(packDir, theme))
    .filter((source): source is ThemeSource => !!source);
  const localBest = bestSource(requestedTheme, targetText, localCandidates);
  if (localBest) return localBest;
  const globalCandidates = allThemeSources().filter(source => source.packDir !== packDir && (requestedTheme === 'theme_song' || source.theme !== 'theme_song'));
  if (requestedTheme) {
    const exactGlobal = globalCandidates
      .filter(source => source.theme === requestedTheme)
      .sort((a, b) => b.files.length - a.files.length || `${a.packDir}/${a.theme}`.localeCompare(`${b.packDir}/${b.theme}`))[0];
    if (exactGlobal) return exactGlobal;
  }
  return bestSource(requestedTheme, targetText, globalCandidates);
}

function matchTheme(rule: LayerRule | undefined, hay: string): string | null {
  if (!rule) return null;
  for (const r of (rule.byKeyword ?? [])) {
    if (r.kw.some(k => includesNormalized(hay, k))) return r.theme;
  }
  return rule.default ?? null;
}

function fsId(name: string): number {
  const m = name.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function urlFor(packDir: string, theme: string, file: string): string {
  return '/audio/' + [packDir, theme, file].map(encodeURIComponent).join('/');
}

export interface LocalSoundscapeArgs {
  location: WorldLocation;
  weather: CurrentWeather | undefined;
  contextHash: string;
  timeBucket: string;
  crowdBucket: string;
  weatherCondition: string;
  worldConcept?: string;
  worldId?: string;
}

export function buildLocalSoundscape(a: LocalSoundscapeArgs): SoundscapeManifest | null {
  const pack = pickPack(a.worldConcept, a.worldId);
  if (!pack) return null;
  const hay = normalizeText(a.location.type + ' ' + a.location.name + ' ' + (a.location.ambientDetail ?? ''));
  const vol = pack.volumes ?? {};
  const usedFiles = new Set<string>();
  const layers: SoundscapeLayer[] = [];

  const addLayer = (type: SoundscapeLayer['type'], source: ThemeSource | null, volume: number, options: { loop?: boolean; repeatDelayMs?: number } = {}): void => {
    if (!source || source.files.length === 0) return;
    let file = source.files[hash(a.contextHash + ':' + type + ':' + source.packDir + ':' + source.theme) % source.files.length];
    const fileKey = `${source.packDir}/${source.theme}/${file}`;
    if (usedFiles.has(fileKey)) {
      const alt = source.files.find(f => !usedFiles.has(`${source.packDir}/${source.theme}/${f}`));
      if (!alt) return;
      file = alt;
    }
    usedFiles.add(`${source.packDir}/${source.theme}/${file}`);
    layers.push({
      type,
      soundUrl: urlFor(source.packDir, source.theme, file),
      volume: Math.max(0, Math.min(1, volume)),
      loop: options.loop ?? true,
      repeatDelayMs: options.repeatDelayMs,
      freesoundId: fsId(file),
      query: 'local:' + source.theme,
      soundName: file,
      tags: [pack.name, source.theme, source.packDir],
    });
  };

  const baseTheme = matchTheme(pack.base, hay) ?? pack.base.default;
  const baseHint = [hay, loadThemeQueries(pack.dir)[baseTheme ?? ''] ?? '', baseTheme ?? ''].join(' ');
  const baseSource = resolveThemeSource(pack.dir, baseTheme, baseHint);
  addLayer('base', baseSource, vol.base ?? 0.5);

  const detailTheme = matchTheme(pack.detail, hay) ?? pack.detail?.default;
  const detailHint = [hay, loadThemeQueries(pack.dir)[detailTheme ?? ''] ?? '', detailTheme ?? '', a.location.description].join(' ');
  const detailSource = resolveThemeSource(pack.dir, detailTheme, detailHint);
  addLayer('detail', detailSource, vol.detail ?? 0.32);

  if (pack.musicTheme) {
    const musicSource = resolveThemeSource(pack.dir, pack.musicTheme, loadThemeQueries(pack.dir)[pack.musicTheme] ?? pack.musicTheme);
    addLayer('music', musicSource, vol.music ?? 0.28, { loop: false, repeatDelayMs: 180000 });
  }

  if (layers.length < 2) {
    const fallbackSource = bestSource(
      detailTheme,
      `${hay} ${a.worldConcept ?? ''} ${detailHint}`,
      allThemeSources().filter(source => source.files.some(file => !usedFiles.has(`${source.packDir}/${source.theme}/${file}`))),
    );
    addLayer('detail', fallbackSource, vol.detail ?? 0.32);
  }

  if (a.weather && a.weather.precipitation && a.weather.precipitation !== 'none' && pack.weatherTheme) {
    const weatherSource = resolveThemeSource(pack.dir, pack.weatherTheme, `${hay} ${loadThemeQueries(pack.dir)[pack.weatherTheme] ?? pack.weatherTheme}`);
    addLayer('weather', weatherSource, vol.weather ?? 0.3);
  }
  if ((a.crowdBucket === 'moderate' || a.crowdBucket === 'crowded') && pack.crowdTheme) {
    const crowdSource = resolveThemeSource(pack.dir, pack.crowdTheme, `${hay} ${loadThemeQueries(pack.dir)[pack.crowdTheme] ?? pack.crowdTheme}`);
    addLayer('crowd', crowdSource, vol.crowd ?? 0.22);
  }
  if (layers.length === 0) return null;
  return {
    layers,
    contextHash: a.contextHash,
    locationId: a.location.id,
    locationName: a.location.name,
    weather: a.weatherCondition,
    timeBucket: a.timeBucket,
    crowdBucket: a.crowdBucket,
  };
}

export const __test = {
  pickPackName(worldConcept?: string, worldId?: string): string | null {
    return pickPack(worldConcept, worldId)?.name ?? null;
  },
  clearCaches(): void {
    packCache.clear();
    themeQueryCache.clear();
    globalThemeSourceCache = null;
  },
};
