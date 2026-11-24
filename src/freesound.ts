import { llmText } from './llm.js';
import { buildLocalSoundscape } from './localSoundscape.js';
import { createHash } from 'node:crypto';
import type {
  FreesoundResult,
  SoundscapeLayer,
  SoundscapeManifest,
  SoundscapeTagSet,
  WorldLocation,
  CurrentWeather,
} from './types.js';

const SOMA_API = process.env.SOMA_API ?? '';
const FREESOUND_BASE = 'https://freesound.org/apiv2';
const FREESOUND_RATE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let freesoundDisabledUntil = 0;
let freesoundRateLimitWarned = false;

const FALLBACK_TAGS: Record<string, string> = {
  pub: 'tavern ambience',
  tavern: 'tavern ambience',
  bar: 'tavern ambience',
  inn: 'tavern ambience',
  market: 'outdoor market crowd',
  bazaar: 'outdoor market crowd',
  shop: 'shop interior ambient',
  home: 'quiet room tone interior',
  house: 'quiet room tone interior',
  flat: 'quiet room tone interior',
  workplace: 'workshop ambient',
  forge: 'blacksmith forge hammer',
  smithy: 'blacksmith forge hammer',
  church: 'church interior reverb',
  temple: 'church interior reverb',
  street: 'city street ambient',
  square: 'town square crowd ambient',
  plaza: 'town square crowd ambient',
  forest: 'forest birds ambient',
  woods: 'forest birds ambient',
  dock: 'harbor water boats',
  harbour: 'harbor water boats',
  harbor: 'harbor water boats',
  river: 'river flowing water',
  lake: 'lake water lapping',
  garden: 'garden birds wind',
  alley: 'quiet alley wind',
  default: 'outdoor ambient nature',
};

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class LRUCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  constructor(private maxSize: number, private ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.map.clear();
  }
}

const manifestCache = new LRUCache<SoundscapeManifest>(200, 30 * 60 * 1000);
const queryCache = new LRUCache<FreesoundResult[]>(500, 60 * 60 * 1000);

export function isSomaEnabled(): boolean {
  return SOMA_API.length > 0;
}

function isFreesoundRateLimited(): boolean {
  return Date.now() < freesoundDisabledUntil;
}

function noteFreesoundRateLimit(): void {
  freesoundDisabledUntil = Math.max(freesoundDisabledUntil, Date.now() + FREESOUND_RATE_LIMIT_COOLDOWN_MS);
  if (!freesoundRateLimitWarned) {
    freesoundRateLimitWarned = true;
    console.warn('[freesound] Daily request limit reached; using local audio fallback for 24 hours.');
  }
}

export async function searchSounds(query: string): Promise<FreesoundResult[]> {
  if (isFreesoundRateLimited()) return [];
  const cached = queryCache.get(query);
  if (cached) return cached;

  const params = new URLSearchParams({
    query,
    fields: 'id,name,previews,duration,tags',
    page_size: '5',
    filter: 'duration:[1 TO 30]',
  });

  const res = await fetch(`${FREESOUND_BASE}/search/text/?${params}`, {
    headers: { Authorization: `Token ${SOMA_API}` },
  });
  if (!res.ok) {
    if (res.status === 429) {
      noteFreesoundRateLimit();
    }
    console.warn(`Freesound API error: ${res.status}`);
    return [];
  }

  const data = await res.json() as { results?: FreesoundResult[] };
  const results = Array.isArray(data.results) ? data.results : [];
  queryCache.set(query, results);
  return results;
}

function getTimeBucket(hour: number): string {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h < 5) return 'night';
  if (h < 8) return 'dawn';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

function getCrowdBucket(npcCount: number): string {
  if (npcCount === 0) return 'empty';
  if (npcCount <= 2) return 'sparse';
  if (npcCount <= 5) return 'moderate';
  return 'crowded';
}

function isIndoor(locationType: string): boolean {
  const outdoor = ['street', 'square', 'plaza', 'dock', 'harbour', 'harbor', 'river', 'lake', 'forest', 'woods', 'garden', 'alley', 'field', 'farm', 'beach'];
  return !outdoor.includes(locationType.toLowerCase());
}

function normalizeHashPart(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buildContextHash(
  location: WorldLocation,
  weather: CurrentWeather | undefined,
  timeBucket: string,
  crowdBucket: string,
  extraContext: Array<unknown> = [],
): string {
  const parts = [
    location.id,
    location.name,
    location.type,
    location.ambientDetail,
    weather?.condition ?? 'clear',
    weather?.intensity ?? 'clear',
    weather?.precipitation ?? 'none',
    weather?.wind ?? '',
    weather?.thunder ? 'thunder' : '',
    weather?.lightning ? 'lightning' : '',
    timeBucket,
    crowdBucket,
    ...extraContext,
  ];
  return createHash('sha1')
    .update(parts.map(normalizeHashPart).join('\u001f'))
    .digest('hex');
}

function buildSoundscapeContextHash(
  location: WorldLocation,
  weather: CurrentWeather | undefined,
  timeBucket: string,
  crowdBucket: string,
  worldConcept?: string,
  worldId?: string,
): string {
  return buildContextHash(location, weather, timeBucket, crowdBucket, [worldId ?? '', worldConcept ?? '']);
}

function sanitizeQuery(raw: string): string {
  return String(raw).replace(/[^\w\s\-.,()]/g, '').trim().slice(0, 100);
}

function uniqueQueries(queries: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of queries) {
    const query = sanitizeQuery(raw ?? '');
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out;
}

function seededPick<T>(items: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return items[((h >>> 0) % items.length)];
}

async function generateSoundscapeTags(
  location: WorldLocation,
  weather: CurrentWeather | undefined,
  timeBucket: string,
  crowdBucket: string,
  provider: string,
  model?: string,
  worldConcept?: string,
): Promise<SoundscapeTagSet> {
  const indoor = isIndoor(location.type);
  const weatherCondition = weather?.condition ?? 'clear';
  const weatherIntensity = weather?.intensity ?? 'clear';
  const precipitation = weather?.precipitation ?? 'none';

  const system = `You are a sound designer. Given a location, weather, time, and crowd level, output Freesound search queries for an ambient soundscape.
Return 3-4 layers as JSON. Each layer has: type (base|detail|weather|crowd), query (Freesound search string), volume (0.0-1.0).

Rules:
- "base": always present — the core ambient identity of the place
- "detail": a characteristic secondary sound (omit if location is featureless)
- "weather": only if precipitation, wind, or thunder is active; reflect indoor vs outdoor
- "crowd": only if crowd is moderate or crowded; omit for empty/sparse
- For INDOOR locations: focus on interior sounds (room tone, furniture, hearth, voices, clinking, creaking floors). NEVER use birds, insects, wildlife, or nature sounds for indoor spaces.
- For OUTDOOR locations: nature sounds are fine but keep them secondary to the location's identity (a market's crowd matters more than distant birds).
- Match the GENRE/ERA of the world setting. Sci-fi worlds need electronic hums, synth drones, futuristic machinery, cyberpunk ambience. Horror worlds need eerie drones, creaking, unsettling tones, distant screams, ominous wind. Historical worlds need period-appropriate sounds.
- Keep volumes low (0.2-0.5) for a subtle ambient bed, not overpowering.

Return ONLY valid JSON: {"layers":[...]}`;

  const user = `Location: ${location.name} (${location.type}) — ${location.ambientDetail}
${worldConcept ? `World setting: ${worldConcept}` : ''}
Weather: ${weatherCondition}, ${weatherIntensity}, precipitation: ${precipitation}
Time: ${timeBucket}
Crowd: ${crowdBucket}
Indoor/Outdoor: ${indoor ? 'indoor' : 'outdoor'}`;

  const attempt = async (temp: number, tokens: number): Promise<SoundscapeTagSet | null> => {
    const raw = await llmText({ system, user, maxTokens: tokens, temperature: temp, provider, model, thinking: false });
    // Strip <think> blocks (reasoning models emit these before JSON) — both complete and truncated
    let stripped = raw.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
    // Handle truncated <think> with no closing tag: drop everything from <think> onward if no JSON after it
    const thinkIdx = stripped.indexOf('<think>');
    if (thinkIdx !== -1) {
      const afterThink = stripped.slice(thinkIdx + 7);
      if (!afterThink.includes('{') && !afterThink.includes('[')) {
        stripped = stripped.slice(0, thinkIdx).trim();
      } else {
        // JSON follows the truncated think block — drop the <think> tag only
        stripped = stripped.slice(0, thinkIdx) + afterThink;
      }
    }
    stripped = stripped.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const layers = parsed?.layers ?? (Array.isArray(parsed) ? parsed : null);
      if (!layers || !Array.isArray(layers)) return null;

      const validated = layers
        .filter((l: any) => l.type && l.query)
        .map((l: any) => ({
          type: l.type as SoundscapeTagSet['layers'][0]['type'],
          query: sanitizeQuery(l.query),
          volume: typeof l.volume === 'number' ? Math.max(0, Math.min(1, l.volume)) : 0.4,
        }))
        .filter(l => l.query.length > 0);

      return validated.length > 0 ? { layers: validated } : null;
    } catch { return null; }
  };

  try {
    const result = await attempt(0.3, 600) ?? await attempt(0.5, 1024);
    if (result) return result;
  } catch (err) {
    console.error('[freesound] LLM tag generation error:', err);
  }

  console.warn('[freesound] LLM tag generation failed, using fallback');
  return buildFallbackTags(location, weather, crowdBucket, worldConcept);
}

function fallbackBaseQuery(location: WorldLocation): string {
  const locType = location.type.toLowerCase();
  return FALLBACK_TAGS[locType] ?? FALLBACK_TAGS.default;
}

function genreBaseQuery(worldConcept?: string): string | undefined {
  const text = String(worldConcept ?? '').toLowerCase();
  if (/space|starship|alien|planet|mars|robot|android|sci-fi|cyberpunk|future|terminal|neon/.test(text)) return 'sci fi ambient hum machinery';
  if (/horror|nightmare|zombie|vampire|gothic|haunted|kruger|freddy/.test(text)) return 'dark horror ambience drone';
  if (/cocaine|cartel|narco|mafia|crime|gangster|prison|detention/.test(text)) return 'urban night ambience distant siren';
  if (/\bwar\b|military|soldier|battle|invasion|wwii|ww2/.test(text)) return 'military base ambience distant vehicles';
  if (/medieval|fantasy|magic|witch|tavern|kingdom/.test(text)) return 'medieval village ambience';
  return undefined;
}

function buildFallbackTags(
  location: WorldLocation,
  weather: CurrentWeather | undefined,
  crowdBucket: string,
  worldConcept?: string,
): SoundscapeTagSet {
  const baseQuery = genreBaseQuery(worldConcept) ?? fallbackBaseQuery(location);

  const layers: SoundscapeTagSet['layers'] = [
    { type: 'base', query: baseQuery, volume: 0.5 },
  ];

  if (weather && weather.precipitation !== 'none') {
    const indoor = isIndoor(location.type);
    layers.push({
      type: 'weather',
      query: indoor ? `${weather.precipitation} on roof muffled` : `${weather.precipitation} outdoor ambient`,
      volume: 0.3,
    });
  }

  if (crowdBucket === 'moderate' || crowdBucket === 'crowded') {
    layers.push({ type: 'crowd', query: 'crowd murmur people talking', volume: 0.3 });
  }

  return { layers };
}

function withRequiredFallbackLayers(
  tagSet: SoundscapeTagSet,
  location: WorldLocation,
  weather: CurrentWeather | undefined,
  crowdBucket: string,
  worldConcept?: string,
): SoundscapeTagSet {
  const fallback = buildFallbackTags(location, weather, crowdBucket, worldConcept);
  const layers = [...tagSet.layers];
  const hasBase = layers.some(l => l.type === 'base');
  if (!hasBase) layers.unshift(fallback.layers[0]);

  for (const fallbackLayer of fallback.layers) {
    if (fallbackLayer.type === 'base') continue;
    const hasType = layers.some(l => l.type === fallbackLayer.type);
    if (!hasType) layers.push(fallbackLayer);
  }

  return { layers };
}

function layerFallbackQueries(
  tag: SoundscapeTagSet['layers'][0],
  location: WorldLocation,
  weather: CurrentWeather | undefined,
  worldConcept?: string,
): string[] {
  const indoor = isIndoor(location.type);
  const baseQuery = fallbackBaseQuery(location);
  const locType = location.type.toLowerCase();
  const ambientDetail = sanitizeQuery(location.ambientDetail);

  if (tag.type === 'base') {
    return uniqueQueries([
      tag.query,
      genreBaseQuery(worldConcept),
      baseQuery,
      indoor ? 'quiet room tone interior' : 'outdoor ambient',
      indoor ? 'interior ambience' : 'field recording ambience',
    ]);
  }

  if (tag.type === 'detail') {
    return uniqueQueries([
      tag.query,
      ambientDetail,
      genreBaseQuery(worldConcept),
      `${locType} ambience`,
      baseQuery,
      indoor ? 'interior ambience' : 'outdoor ambience',
    ]);
  }

  if (tag.type === 'weather') {
    const precipitation = weather?.precipitation && weather.precipitation !== 'none' ? weather.precipitation : undefined;
    return uniqueQueries([
      tag.query,
      genreBaseQuery(worldConcept),
      precipitation ? (indoor ? `${precipitation} on roof` : `${precipitation} ambience`) : undefined,
      weather?.condition,
      weather?.thunder ? 'distant thunder' : undefined,
      indoor ? 'rain on window' : 'wind ambience',
    ]);
  }

  if (tag.type === 'crowd') {
    return uniqueQueries([
      tag.query,
      genreBaseQuery(worldConcept),
      'crowd murmur',
      'people talking ambience',
      indoor ? 'indoor crowd ambience' : 'outdoor crowd ambience',
    ]);
  }

  return uniqueQueries([tag.query, baseQuery]);
}

async function findSoundForLayer(
  tag: SoundscapeTagSet['layers'][0],
  location: WorldLocation,
  weather: CurrentWeather | undefined,
  contextHash: string,
  excludeIds: Set<number>,
  worldConcept?: string,
): Promise<SoundscapeLayer | null> {
  const queries = layerFallbackQueries(tag, location, weather, worldConcept);

  for (const query of queries) {
    if (isFreesoundRateLimited()) break;
    try {
      const results = await searchSounds(query);
      const candidates = results.filter(sound => sound.previews?.['preview-hq-mp3'] || sound.previews?.['preview-lq-mp3']).slice(0, 3);
      if (candidates.length === 0) continue;

      const freshCandidates = candidates.filter(sound => !excludeIds.has(sound.id));
      const pickFrom = freshCandidates.length > 0 ? freshCandidates : candidates;
      const sound = seededPick(pickFrom, `${contextHash}:${tag.type}:${query}`);
      const soundUrl = sound.previews?.['preview-hq-mp3'] ?? sound.previews?.['preview-lq-mp3'];
      if (!soundUrl) continue;

      return {
        type: tag.type,
        soundUrl,
        volume: Math.max(0, Math.min(1, tag.volume)),
        loop: true,
        freesoundId: sound.id,
        query,
        soundName: sound.name,
        tags: sound.tags,
      };
    } catch (err) {
      console.error(`[freesound] Search failed for "${query}":`, err);
    }
  }

  console.warn(`[freesound] No usable preview found for ${tag.type} layer at ${location.name}: ${queries.join(' | ')}`);
  return null;
}

export async function generateSoundscape(
  location: WorldLocation,
  weather: CurrentWeather | undefined,
  currentTime: number,
  npcsPresent: number,
  provider: string,
  model?: string,
  worldConcept?: string,
  worldId?: string,
): Promise<SoundscapeManifest | null> {

  const timeBucket = getTimeBucket(currentTime);
  const crowdBucket = getCrowdBucket(npcsPresent);
  const weatherCondition = weather?.condition ?? 'clear';
  const contextHash = buildSoundscapeContextHash(location, weather, timeBucket, crowdBucket, worldConcept, worldId);

  const cached = manifestCache.get(contextHash);
  if (cached) return cached;

  // Local audio pack: deterministic, no Freesound/LLM dependency, always plays.
  try {
    const local = buildLocalSoundscape({ location, weather, contextHash, timeBucket, crowdBucket, weatherCondition, worldConcept, worldId });
    if (local && local.layers.length > 0) { manifestCache.set(contextHash, local); return local; }
  } catch (err) { console.error('[localsound] failed:', err); }
  if (!isSomaEnabled()) return null;
  if (isFreesoundRateLimited()) return null;
  try {
    const tagSet = withRequiredFallbackLayers(
      await generateSoundscapeTags(location, weather, timeBucket, crowdBucket, provider, model, worldConcept),
      location,
      weather,
      crowdBucket,
      worldConcept,
    );

    const usedSoundIds = new Set<number>();
    const layers: SoundscapeLayer[] = [];
    for (const tag of tagSet.layers) {
      const layer = await findSoundForLayer(tag, location, weather, contextHash, usedSoundIds, worldConcept);
      if (!layer) continue;
      layers.push(layer);
      usedSoundIds.add(layer.freesoundId);
    }

    if (layers.length === 0) return null;

    const manifest: SoundscapeManifest = {
      layers,
      contextHash,
      locationId: location.id,
      locationName: location.name,
      weather: weatherCondition,
      timeBucket,
      crowdBucket,
    };
    manifestCache.set(contextHash, manifest);
    return manifest;
  } catch (err) {
    console.error('[freesound] Soundscape generation failed:', err);
    return null;
  }
}

export const __test = {
  buildContextHash,
  buildSoundscapeContextHash,
  clearCaches(): void {
    manifestCache.clear();
    queryCache.clear();
    freesoundDisabledUntil = 0;
    freesoundRateLimitWarned = false;
  },
};
