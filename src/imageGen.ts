/**
 * Image Generation via Pollinations.ai
 * Free, no API key, uses FLUX model.
 * Generates NPC portraits and location scenes from descriptions.
 */
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const POLLINATIONS_URL = 'https://image.pollinations.ai/prompt';
const IMAGE_GEN_PROVIDER = (process.env.IMAGE_GEN_PROVIDER || 'pollinations').toLowerCase();
const IMAGE_GEN_BASE_URL = process.env.IMAGE_GEN_BASE_URL || '';
const IMAGE_GEN_API_KEY = process.env.IMAGE_GEN_API_KEY || '';
const IMAGE_GEN_MODEL = process.env.IMAGE_GEN_MODEL || '';
// Per-task model overrides. Each falls back to IMAGE_GEN_MODEL if unset.
// Lets the same OpenRouter adapter route cover/portrait/scene to different
// models so you can pay for quality where it matters (cover) and use a fast
// cheap model elsewhere (scenes). All three slot into the same code path.
const IMAGE_GEN_MODEL_COVER = process.env.IMAGE_GEN_MODEL_COVER || IMAGE_GEN_MODEL;
const IMAGE_GEN_MODEL_PORTRAIT = process.env.IMAGE_GEN_MODEL_PORTRAIT || IMAGE_GEN_MODEL;
const IMAGE_GEN_MODEL_SCENE = process.env.IMAGE_GEN_MODEL_SCENE || IMAGE_GEN_MODEL;
// Pool every image-gen task (cover + portraits + scenes) into a single queue.
// If WORLDGEN_IMAGE_CONCURRENCY is unset, default to one lane per configured
// provider so the cascade can actually spread work instead of always using the
// first healthy provider.
const IMAGE_GEN_CONCURRENCY = Math.max(1, parseInt(process.env.WORLDGEN_IMAGE_CONCURRENCY ?? '1', 10) || 1);
const IMAGE_GEN_RETRY_COUNT = Math.max(0, parseInt(process.env.WORLDGEN_IMAGE_RETRY_COUNT ?? '3', 10) || 0);
const IMAGE_GEN_RETRY_DELAY_MS = Math.max(250, parseInt(process.env.WORLDGEN_IMAGE_RETRY_DELAY_MS ?? '5000', 10) || 5000);
const IMAGE_GEN_PER_IMAGE_TIMEOUT_MS = Math.max(5000, parseInt(process.env.WORLDGEN_IMAGE_TIMEOUT_MS ?? '60000', 10) || 60000);
const IMAGE_GEN_RATE_LIMIT_COOLDOWN_MS = Math.max(1000, parseInt(process.env.WORLDGEN_IMAGE_RATE_LIMIT_COOLDOWN_MS ?? '15000', 10) || 15000);
const IMAGE_GEN_BLOCKED_COOLDOWN_MS = Math.max(1000, parseInt(process.env.WORLDGEN_IMAGE_BLOCKED_COOLDOWN_MS ?? '86400000', 10) || 86400000);

// ── Multi-provider cascade with per-provider rate-limit tracking ──
// IMAGE_GEN_PROVIDERS env: comma-separated ordered list (e.g. "openai,pollinations,openrouter").
// Default = IMAGE_GEN_PROVIDER + pollinations fallback if POLLINATIONS_API_KEY is set.
// On 429/failure from one provider, cascade falls through to the next.
// .. Per-provider concurrency limits (each provider has its own slot pool) ..
// Defaults: Together=1 (tier-1 hard limit), Imagen=4, Pollinations=8, OpenRouter=4.
// Override per-provider via TOGETHER_CONCURRENCY / IMAGE_GEN_CONCURRENCY_OPENAI / etc.
const PROVIDER_DEFAULT_CONCURRENCY: Record<string, number> = {
  together: parseInt(process.env.TOGETHER_CONCURRENCY ?? '1', 10) || 1,
  fal: parseInt(process.env.FAL_CONCURRENCY ?? '2', 10) || 2,
  openai: parseInt(process.env.IMAGE_GEN_CONCURRENCY_OPENAI ?? '4', 10) || 4,
  pollinations: parseInt(process.env.IMAGE_GEN_CONCURRENCY_POLLINATIONS ?? '8', 10) || 8,
  openrouter: parseInt(process.env.IMAGE_GEN_CONCURRENCY_OPENROUTER ?? '4', 10) || 4,
};

class ProviderSemaphore {
  active = 0;
  waiting: Array<() => void> = [];
  constructor(public readonly limit: number) {}
  tryAcquire(): boolean {
    if (this.active < this.limit) { this.active++; return true; }
    return false;
  }
  async acquire(): Promise<void> {
    if (this.active < this.limit) { this.active++; return; }
    await new Promise<void>(resolve => this.waiting.push(resolve));
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }
}

const _providerSlots = new Map<string, ProviderSemaphore>();
function _slotsFor(provider: string): ProviderSemaphore {
  let s = _providerSlots.get(provider);
  if (!s) {
    const limit = PROVIDER_DEFAULT_CONCURRENCY[provider] ?? 4;
    s = new ProviderSemaphore(limit);
    _providerSlots.set(provider, s);
  }
  return s;
}
export function getImageGenSlotState(): { providers: Array<{ name: string; active: number; queued: number; limit: number }> } {
  const providers = IMAGE_GEN_PROVIDERS_CHAIN.map(name => {
    const s = _slotsFor(name);
    return { name, active: s.active, queued: s.waiting.length, limit: s.limit };
  });
  return { providers };
}

function _resolveProviderChain(): string[] {
  const raw = (process.env.IMAGE_GEN_PROVIDERS || '').trim();
  if (raw) return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const chain: string[] = [];
  if (process.env.TOGETHER_API_KEY) chain.push('together');
  if (process.env.FAL_API_KEY) chain.push('fal');
  if (IMAGE_GEN_PROVIDER) chain.push(IMAGE_GEN_PROVIDER);
  if (process.env.POLLINATIONS_API_KEY && !chain.includes('pollinations')) chain.push('pollinations');
  return chain.length ? chain : ['pollinations'];
}
const IMAGE_GEN_PROVIDERS_CHAIN = _resolveProviderChain();
const IMAGE_GEN_EFFECTIVE_CONCURRENCY = process.env.WORLDGEN_IMAGE_CONCURRENCY
  ? IMAGE_GEN_CONCURRENCY
  : Math.max(IMAGE_GEN_CONCURRENCY, IMAGE_GEN_PROVIDERS_CHAIN.length);

interface ProviderRLState { until: number; hits: number; lastHitAt: number; lastError?: string }
const _providerRateLimits = new Map<string, ProviderRLState>();
function _noteProviderRateLimit(provider: string, retryAfterMs?: number, detail?: string) {
  const now = Date.now();
  // Trust server's retry-after when present; only fall back to default when missing.
  const cooldown = (retryAfterMs && retryAfterMs > 0) ? retryAfterMs : IMAGE_GEN_RATE_LIMIT_COOLDOWN_MS;
  const cur = _providerRateLimits.get(provider) ?? { until: 0, hits: 0, lastHitAt: 0 };
  cur.until = Math.max(cur.until, now + cooldown);
  cur.hits++;
  cur.lastHitAt = now;
  if (detail) cur.lastError = detail.slice(0, 200);
  _providerRateLimits.set(provider, cur);
}
function _isProviderRateLimited(provider: string): boolean {
  const s = _providerRateLimits.get(provider);
  return !!s && s.until > Date.now();
}
export interface ProviderState {
  name: string;
  isRateLimited: boolean;
  cooldownRemainingMs: number;
  hits: number;
  lastHitAt: number;
  lastError?: string;
  inChain: boolean;
  position: number;
}
export function getImageGenProvidersState(): { chain: string[]; providers: ProviderState[] } {
  const now = Date.now();
  const all = new Set<string>([...IMAGE_GEN_PROVIDERS_CHAIN, ..._providerRateLimits.keys()]);
  const providers: ProviderState[] = Array.from(all).map(name => {
    const s = _providerRateLimits.get(name);
    const idx = IMAGE_GEN_PROVIDERS_CHAIN.indexOf(name);
    return {
      name,
      isRateLimited: !!s && s.until > now,
      cooldownRemainingMs: s ? Math.max(0, s.until - now) : 0,
      hits: s?.hits ?? 0,
      lastHitAt: s?.lastHitAt ?? 0,
      lastError: s?.lastError,
      inChain: idx >= 0,
      position: idx,
    };
  });
  providers.sort((a, b) => (a.position >= 0 ? a.position : 99) - (b.position >= 0 ? b.position : 99));
  return { chain: IMAGE_GEN_PROVIDERS_CHAIN, providers };
}

type GeneratedBundle = { cover?: string; portraits: Record<string, string>; swimwearPortraits: Record<string, string>; scenes: Record<string, string>; complete: boolean; retryAfterMs?: number };
type GeneratedAssetUpdate = Partial<GeneratedBundle>;
type GenerateImageResult = { dataUrl: string | null; rateLimited: boolean; blocked?: boolean; retryAfterMs?: number };
type ImageSourceDocument = { title?: string; summary?: string; digest?: string; extractedText?: string };
type ImageWorldContext = {
  id?: string;
  concept: string;
  era?: { period?: string };
  geography?: { region?: string; country?: string; terrain?: string };
  realWorldFacts?: string;
  sourceDocuments?: ImageSourceDocument[];
};
type ImageLocationContext = { id?: string; name: string; type: string; description?: string };

export function buildPortraitPrompt(npc: {
  name: string;
  age: number;
  gender: string;
  ethnicity?: string;
  physicalDescription?: string;
  occupation: string;
  personality: string;
}, era: string, region: string): string {
  const parts = [
    'portrait photograph',
    era,
    region,
    `${npc.gender}, age ${npc.age}`,
    npc.ethnicity || '',
    npc.physicalDescription || '',
    npc.occupation,
    npc.personality + ' expression',
    'head and shoulders, natural lighting, candid, photorealistic, atmospheric, no text',
  ].filter(Boolean);
  return parts.join(', ');
}

function isAdultSwimwearNpc(npc: { age: number; gender: string }): boolean {
  return Number(npc.age) >= 18 && !/\b(child|minor|schoolboy)\b/i.test(String(npc.gender || ''));
}

export function buildSwimwearPortraitPrompt(npc: {
  name: string;
  age: number;
  gender: string;
  ethnicity?: string;
  physicalDescription?: string;
  occupation: string;
  personality: string;
}, era: string, region: string): string {
  const gender = /\b(male|man|boy)\b/i.test(String(npc.gender || '')) ? 'adult man' : 'female';
  const swimwear = gender === 'adult man' ? 'wearing tight low-cut swim briefs' : 'wearing a tiny string bikini or revealing micro swimsuit';
  const parts = [
    `glamour swimsuit portrait of an ${gender}`,
    era,
    region,
    `age ${npc.age}`,
    npc.ethnicity || '',
    npc.physicalDescription || '',
    npc.occupation,
    npc.personality + ' expression, alluring confident pose',
    `${swimwear}, luxury poolside or tropical beach at golden hour, full body, cinematic lighting, photorealistic, no text`,
  ].filter(Boolean);
  return parts.join(', ');
}

function isWarOfTheWorlds(world: ImageWorldContext): boolean {
  const text = [
    world.concept,
    ...(world.sourceDocuments ?? []).flatMap(doc => [doc.title, doc.summary, doc.digest, doc.extractedText]),
  ].join(' ');
  return /\bwar of the worlds\b|tripod|fighting machine|red weed|heat[- ]?ray/i.test(text);
}

function warOfTheWorldsVisualCue(location?: ImageLocationContext): string {
  const loc = [location?.id, location?.name, location?.type, location?.description].join(' ').toLowerCase();
  const base = 'source-faithful War of the Worlds imagery, towering three-legged alien fighting machines / tripods visible as the central threat, heat-ray devastation, EMP storm aftermath, red alien weed, no actor likenesses';
  if (/\b(dock|cargo|harbor|ferry|water|river)\b/.test(loc)) {
    return `${base}, tripod striding over harbor cranes and ferry wreckage, black smoke over the waterfront`;
  }
  if (/\b(basement|cellar|flat|apartment|stairs|house|backyard|driveway)\b/.test(loc)) {
    return `${base}, claustrophobic survivor refuge, alien probe or tentacle silhouettes, red weed creeping through walls`;
  }
  if (/\b(garden|park|playground|industrial|lot)\b/.test(loc)) {
    return `${base}, red weed choking ordinary spaces, distant tripod silhouettes on the horizon`;
  }
  if (/\b(street|intersection|avenue|alley|church|auto|bus|police|school)\b/.test(loc)) {
    return `${base}, cracked streets, abandoned vehicles, ash, tripod emerging among buildings`;
  }
  return base;
}

function sourceVisualCue(world?: ImageWorldContext, location?: ImageLocationContext): string {
  if (!world || !(world.sourceDocuments?.length || world.realWorldFacts)) return '';
  if (isWarOfTheWorlds(world)) return warOfTheWorldsVisualCue(location);

  const raw = [
    world.realWorldFacts,
    ...(world.sourceDocuments ?? []).flatMap(doc => [doc.summary, doc.digest, doc.extractedText]),
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const anchors = raw
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => /\b(city|battle|ship|machine|monster|creature|alien|robot|weapon|vehicle|storm|ruin|temple|castle|forest|desert|ocean|fire|explosion|attack|chase)\b/i.test(sentence))
    .slice(0, 2)
    .map(sentence => sentence.slice(0, 180));
  return anchors.length ? `source-faithful visual anchors: ${anchors.join('; ')}` : 'source-faithful visual design, include iconic source elements where appropriate, not generic architecture';
}

export function buildLocationPrompt(location: ImageLocationContext, era: string, region: string, timeOfDay?: string, world?: ImageWorldContext): string {
  const parts = [
    location.type,
    location.description || location.name,
    sourceVisualCue(world, location),
    'wide establishing shot',
    timeOfDay || 'daylight',
    era,
    region,
    'no people, atmospheric, cinematic, environmental photography, photorealistic, no text, not a generic placeholder',
  ].filter(Boolean);
  return parts.join(', ');
}

export function buildWorldPrompt(world: ImageWorldContext): string {
  const parts = [
    'wide cinematic establishing shot',
    world.era?.period || '',
    world.geography?.region || world.geography?.country || '',
    world.geography?.terrain || '',
    world.concept,
    sourceVisualCue(world),
    'atmospheric, awe inspiring, environmental photography, photorealistic, no people, no text, not a generic placeholder',
  ].filter(Boolean);
  return parts.join(', ');
}

// Returns a same-origin proxy URL that the browser fetches. The server-side
// /api/img endpoint adds the sk_ Pollinations token, caches, and serves.
// Never embed the token in URLs that ship to the client.
export function getImageUrl(prompt: string, opts?: { width?: number; height?: number; seed?: number }): string {
  const w = opts?.width ?? 512;
  const h = opts?.height ?? 512;
  const seed = opts?.seed ?? Math.floor(Math.random() * 999999);
  return `/api/img?p=${encodeURIComponent(prompt)}&seed=${seed}&w=${w}&h=${h}`;
}

// Server-side fetch URL builder. Includes the sk_ token. Internal only.
function buildPollinationsFetchUrl(prompt: string, opts?: { width?: number; height?: number; seed?: number }): string {
  const w = opts?.width ?? 512;
  const h = opts?.height ?? 512;
  const seed = opts?.seed ?? Math.floor(Math.random() * 999999);
  const encoded = encodeURIComponent(prompt);
  const token = process.env.POLLINATIONS_API_KEY || '';
  const tokenParam = token ? `&token=${token}` : '';
  return `${POLLINATIONS_URL}/${encoded}?seed=${seed}&width=${w}&height=${h}&nologo=true&nofeed=true&model=flux${tokenParam}`;
}

// OpenAI-compatible image generation.
// If IMAGE_GEN_BASE_URL points at a concrete endpoint such as /api/image, use it as-is.
// Otherwise treat it as an API root and append /v1/images/generations.
async function generateImageOpenAI(prompt: string, opts?: { width?: number; height?: number; seed?: number; timeoutMs?: number; model?: string }): Promise<GenerateImageResult> {
  const baseUrl = IMAGE_GEN_BASE_URL.replace(/\/+$/, '');
  if (/openrouter\.ai\/api(?:\/v1)?$/i.test(baseUrl)) {
    return generateImageOpenRouter(prompt, opts);
  }
  const endpoint = /\/(?:api\/images?\/generate|v1\/images\/generations)$/i.test(baseUrl)
    ? baseUrl
    : `${baseUrl}/v1/images/generations`;
  const timeout = opts?.timeoutMs ?? 90000;
  const w = opts?.width ?? 512;
  const h = opts?.height ?? 512;
  let sawRateLimit = false;

  for (let attempt = 0; attempt <= IMAGE_GEN_RETRY_COUNT; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (IMAGE_GEN_API_KEY) {
        headers['authorization'] = `Bearer ${IMAGE_GEN_API_KEY}`;
        headers['x-api-key'] = IMAGE_GEN_API_KEY;
      }
      const body: Record<string, unknown> = {
        prompt,
        size: `${w}x${h}`,
        n: 1,
        response_format: 'b64_json',
      };
      if (IMAGE_GEN_MODEL || opts?.model) body.model = opts?.model ?? IMAGE_GEN_MODEL;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        if (res.status === 429 || res.status === 402) {
          sawRateLimit = true;
          const retryDelay = parseRetryDelayMs(res.headers) ?? (IMAGE_GEN_RETRY_DELAY_MS * (attempt + 1));
          console.warn(`[imageGen:openai] HTTP 429 for prompt: ${prompt.slice(0, 60)}${attempt < IMAGE_GEN_RETRY_COUNT ? `; retrying in ${retryDelay}ms` : ''}`);
          if (attempt < IMAGE_GEN_RETRY_COUNT) { await sleep(retryDelay); continue; }
          return { dataUrl: null, rateLimited: true, retryAfterMs: retryDelay };
        }
        if (res.status >= 500 && attempt < IMAGE_GEN_RETRY_COUNT) {
          const retryDelay = IMAGE_GEN_RETRY_DELAY_MS * (attempt + 1);
          console.warn(`[imageGen:openai] HTTP ${res.status} for prompt: ${prompt.slice(0, 60)}; retrying in ${retryDelay}ms`);
          await sleep(retryDelay);
          continue;
        }
        const responseText = await res.text().catch(() => '');
        if (res.status === 400 && /moderated|safety|policy/i.test(responseText)) {
          console.warn(`[imageGen:openai] blocked prompt: ${prompt.slice(0, 90)}`);
          return { dataUrl: null, rateLimited: false, blocked: true };
        }
        console.error(`[imageGen:openai] HTTP ${res.status} for prompt: ${prompt.slice(0, 60)}; ${responseText.slice(0, 200)}`);
        return { dataUrl: null, rateLimited: sawRateLimit };
      }

      const data: any = await res.json();
      const item = data?.data?.[0];
      if (item?.b64_json) {
        const sizeKB = (item.b64_json.length * 0.75 / 1024).toFixed(0);
        console.log(`[imageGen:openai] Generated ${sizeKB}KB image`);
        return { dataUrl: `data:image/png;base64,${item.b64_json}`, rateLimited: sawRateLimit };
      }
      if (item?.url) {
        const imgRes = await fetch(item.url);
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          const mime = imgRes.headers.get('content-type') || 'image/png';
          console.log(`[imageGen:openai] Generated ${(buffer.length / 1024).toFixed(0)}KB image (via url)`);
          return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, rateLimited: sawRateLimit };
        }
      }
      console.error(`[imageGen:openai] No image data in response for prompt: ${prompt.slice(0, 60)}`);
      return { dataUrl: null, rateLimited: sawRateLimit };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        const retryDelay = IMAGE_GEN_RETRY_DELAY_MS * (attempt + 1);
        console.error(`[imageGen:openai] Timeout after ${timeout}ms${attempt < IMAGE_GEN_RETRY_COUNT ? `; retrying in ${retryDelay}ms` : ''}`);
        if (attempt < IMAGE_GEN_RETRY_COUNT) { await sleep(retryDelay); continue; }
      } else {
        console.error(`[imageGen:openai] Error:`, err.message);
      }
      return { dataUrl: null, rateLimited: sawRateLimit };
    }
  }
  return { dataUrl: null, rateLimited: sawRateLimit };
}

async function generateImageOpenRouter(prompt: string, opts?: { width?: number; height?: number; seed?: number; timeoutMs?: number; model?: string }): Promise<GenerateImageResult> {
  const endpoint = `${IMAGE_GEN_BASE_URL.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1/chat/completions`;
  const timeout = opts?.timeoutMs ?? 90000;
  let sawRateLimit = false;

  for (let attempt = 0; attempt <= IMAGE_GEN_RETRY_COUNT; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (IMAGE_GEN_API_KEY) headers.authorization = `Bearer ${IMAGE_GEN_API_KEY}`;
      const effectiveModel = opts?.model ?? IMAGE_GEN_MODEL;
      const body: Record<string, unknown> = {
        model: effectiveModel,
        messages: [{ role: 'user', content: prompt }],
        modalities: effectiveModel.toLowerCase().includes('gemini') ? ['image', 'text'] : ['image'],
        stream: false,
        max_tokens: 1024,
        image_config: { aspect_ratio: aspectRatioFor(opts?.width ?? 512, opts?.height ?? 512) },
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        if (res.status === 429 || res.status === 402) {
          sawRateLimit = true;
          const retryDelay = parseRetryDelayMs(res.headers) ?? (IMAGE_GEN_RETRY_DELAY_MS * (attempt + 1));
          console.warn(`[imageGen:openrouter] HTTP 429 for prompt: ${prompt.slice(0, 60)}${attempt < IMAGE_GEN_RETRY_COUNT ? `; retrying in ${retryDelay}ms` : ''}`);
          if (attempt < IMAGE_GEN_RETRY_COUNT) { await sleep(retryDelay); continue; }
          return { dataUrl: null, rateLimited: true, retryAfterMs: retryDelay };
        }
        if (res.status >= 500 && attempt < IMAGE_GEN_RETRY_COUNT) {
          const retryDelay = IMAGE_GEN_RETRY_DELAY_MS * (attempt + 1);
          console.warn(`[imageGen:openrouter] HTTP ${res.status} for prompt: ${prompt.slice(0, 60)}; retrying in ${retryDelay}ms`);
          await sleep(retryDelay);
          continue;
        }
        const body = await res.text().catch(() => '');
        if (res.status === 400 && /moderated|safety|policy/i.test(body)) {
          console.warn(`[imageGen:openrouter] blocked prompt: ${prompt.slice(0, 90)}`);
          return { dataUrl: null, rateLimited: false, blocked: true };
        }
        console.error(`[imageGen:openrouter] HTTP ${res.status} for prompt: ${prompt.slice(0, 60)}; ${body.slice(0, 200)}`);
        return { dataUrl: null, rateLimited: sawRateLimit };
      }

      const data: any = await res.json();
      const image = data?.choices?.[0]?.message?.images?.[0];
      const dataUrl = image?.image_url?.url ?? image?.imageUrl?.url;
      if (typeof dataUrl === 'string' && /^data:image\//i.test(dataUrl)) {
        console.log(`[imageGen:openrouter] Generated ${(dataUrl.length * 0.75 / 1024).toFixed(0)}KB image`);
        return { dataUrl, rateLimited: sawRateLimit };
      }
      console.error(`[imageGen:openrouter] No image data in response for prompt: ${prompt.slice(0, 60)}`);
      return { dataUrl: null, rateLimited: sawRateLimit };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        const retryDelay = IMAGE_GEN_RETRY_DELAY_MS * (attempt + 1);
        console.error(`[imageGen:openrouter] Timeout after ${timeout}ms${attempt < IMAGE_GEN_RETRY_COUNT ? `; retrying in ${retryDelay}ms` : ''}`);
        if (attempt < IMAGE_GEN_RETRY_COUNT) { await sleep(retryDelay); continue; }
      } else {
        console.error(`[imageGen:openrouter] Error:`, err.message);
      }
      return { dataUrl: null, rateLimited: sawRateLimit };
    }
  }
  return { dataUrl: null, rateLimited: sawRateLimit };
}

// Fetch image as base64 data URL (Pollinations provider)
// Together AI — fast FLUX schnell on OpenAI-compatible /v1/images/generations endpoint.
// Env: TOGETHER_API_KEY (required), TOGETHER_IMAGE_MODEL (default FLUX.1-schnell-Free), TOGETHER_IMAGE_STEPS (default 4).
const TOGETHER_API_URL = 'https://api.together.xyz/v1/images/generations';
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY || '';
const TOGETHER_IMAGE_MODEL = process.env.TOGETHER_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell-Free';
const TOGETHER_IMAGE_STEPS = Math.max(1, parseInt(process.env.TOGETHER_IMAGE_STEPS ?? '4', 10) || 4);
async function generateImageTogether(prompt: string, opts?: { width?: number; height?: number; seed?: number; timeoutMs?: number; model?: string }): Promise<GenerateImageResult> {
  if (!TOGETHER_API_KEY) return { dataUrl: null, rateLimited: false };
  const timeout = opts?.timeoutMs ?? 30000;
  // FLUX dimensions must be multiples of 16; round down.
  const w = Math.max(256, Math.min(1440, Math.floor((opts?.width ?? 512) / 16) * 16));
  const h = Math.max(256, Math.min(1440, Math.floor((opts?.height ?? 512) / 16) * 16));
  let sawRateLimit = false;
  const localRetries = 1; // cascade handles further fallback
  for (let attempt = 0; attempt <= localRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const body = {
        // Ignore opts.model — it's namespaced for IMAGE_GEN_PROVIDER (e.g. Google Imagen names); Together has its own model registry.
        model: TOGETHER_IMAGE_MODEL,
        prompt,
        width: w,
        height: h,
        steps: TOGETHER_IMAGE_STEPS,
        n: 1,
        response_format: 'b64_json',
      };
      const res = await fetch(TOGETHER_API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOGETHER_API_KEY}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status === 429 || res.status === 402) {
          sawRateLimit = true;
          const retryDelay = parseRetryDelayMs(res.headers) ?? IMAGE_GEN_RETRY_DELAY_MS;
          console.warn(`[imageGen:together] HTTP 429 for prompt: ${prompt.slice(0, 60)}${attempt < localRetries ? `; retrying in ${retryDelay}ms` : ''}`);
          if (attempt < localRetries) { await sleep(retryDelay); continue; }
          return { dataUrl: null, rateLimited: true, retryAfterMs: retryDelay };
        }
        const responseText = await res.text().catch(() => '');
        if (res.status === 400 && /moderated|safety|policy|nsfw|content/i.test(responseText)) {
          console.warn(`[imageGen:together] blocked prompt: ${prompt.slice(0, 90)}`);
          return { dataUrl: null, rateLimited: false, blocked: true };
        }
        if (res.status >= 500 && attempt < localRetries) {
          await sleep(IMAGE_GEN_RETRY_DELAY_MS);
          continue;
        }
        console.error(`[imageGen:together] HTTP ${res.status}: ${responseText.slice(0, 200)}`);
        return { dataUrl: null, rateLimited: sawRateLimit };
      }
      const data: any = await res.json();
      const item = data?.data?.[0];
      if (item?.b64_json) {
        const sizeKB = (item.b64_json.length * 0.75 / 1024).toFixed(0);
        console.log(`[imageGen:together] Generated ${sizeKB}KB image (FLUX schnell)`);
        return { dataUrl: `data:image/png;base64,${item.b64_json}`, rateLimited: false };
      }
      if (item?.url) {
        const imgRes = await fetch(item.url);
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          const mime = imgRes.headers.get('content-type') || 'image/png';
          console.log(`[imageGen:together] Generated ${(buffer.length / 1024).toFixed(0)}KB image (via url)`);
          return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, rateLimited: false };
        }
      }
      console.error(`[imageGen:together] No image data in response for prompt: ${prompt.slice(0, 60)}`);
      return { dataUrl: null, rateLimited: sawRateLimit };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.error(`[imageGen:together] Timeout after ${timeout}ms`);
        if (attempt < localRetries) { await sleep(IMAGE_GEN_RETRY_DELAY_MS); continue; }
      } else {
        console.error(`[imageGen:together] Error:`, err.message);
      }
      return { dataUrl: null, rateLimited: sawRateLimit };
    }
  }
  return { dataUrl: null, rateLimited: sawRateLimit };
}


// FAL.ai — FLUX schnell via fal.run REST API.
// Env: FAL_API_KEY (required), FAL_IMAGE_MODEL (default fal-ai/flux/schnell).
const FAL_API_KEY = process.env.FAL_API_KEY || '';
const FAL_IMAGE_MODEL = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell';
async function generateImageFal(prompt: string, opts?: { width?: number; height?: number; seed?: number; timeoutMs?: number; model?: string }): Promise<GenerateImageResult> {
  if (!FAL_API_KEY) return { dataUrl: null, rateLimited: false };
  const timeout = opts?.timeoutMs ?? 30000;
  const w = Math.max(256, Math.min(1440, Math.floor((opts?.width ?? 512) / 16) * 16));
  const h = Math.max(256, Math.min(1440, Math.floor((opts?.height ?? 512) / 16) * 16));
  let sawRateLimit = false;
  const localRetries = 1;
  for (let attempt = 0; attempt <= localRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const model = FAL_IMAGE_MODEL;
      const body = { prompt, image_size: { width: w, height: h }, num_images: 1, num_inference_steps: 4 };
      const res = await fetch(`https://fal.run/${model}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Key ${FAL_API_KEY}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status === 429) {
          sawRateLimit = true;
          const retryDelay = parseRetryDelayMs(res.headers) ?? IMAGE_GEN_RETRY_DELAY_MS;
          console.warn(`[imageGen:fal] HTTP 429 for prompt: ${prompt.slice(0, 60)}${attempt < localRetries ? `; retrying in ${retryDelay}ms` : ''}`);
          if (attempt < localRetries) { await sleep(retryDelay); continue; }
          return { dataUrl: null, rateLimited: true, retryAfterMs: retryDelay };
        }
        const responseText = await res.text().catch(() => '');
        if (res.status === 400 && /moderated|safety|policy|nsfw|content/i.test(responseText)) {
          console.warn(`[imageGen:fal] blocked prompt: ${prompt.slice(0, 90)}`);
          return { dataUrl: null, rateLimited: false, blocked: true };
        }
        console.error(`[imageGen:fal] HTTP ${res.status}: ${responseText.slice(0, 200)}`);
        return { dataUrl: null, rateLimited: sawRateLimit };
      }
      const data: any = await res.json();
      const img = data?.images?.[0];
      if (img?.url) {
        const imgRes = await fetch(img.url);
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          const mime = imgRes.headers.get('content-type') || img.content_type || 'image/jpeg';
          console.log(`[imageGen:fal] Generated ${(buffer.length / 1024).toFixed(0)}KB image (FLUX schnell)`);
          return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, rateLimited: false };
        }
      }
      console.error(`[imageGen:fal] No image data in response for prompt: ${prompt.slice(0, 60)}`);
      return { dataUrl: null, rateLimited: sawRateLimit };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.error(`[imageGen:fal] Timeout after ${timeout}ms`);
        if (attempt < localRetries) { await sleep(IMAGE_GEN_RETRY_DELAY_MS); continue; }
      } else {
        console.error(`[imageGen:fal] Error:`, err.message);
      }
      return { dataUrl: null, rateLimited: sawRateLimit };
    }
  }
  return { dataUrl: null, rateLimited: sawRateLimit };
}
async function generateImagePollinations(prompt: string, opts?: { width?: number; height?: number; seed?: number; timeoutMs?: number; model?: string }): Promise<GenerateImageResult> {
  const url = buildPollinationsFetchUrl(prompt, opts);
  const timeout = opts?.timeoutMs ?? 60000;
  let sawRateLimit = false;

  for (let attempt = 0; attempt <= IMAGE_GEN_RETRY_COUNT; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        if (res.status === 429 || res.status === 402) {
          sawRateLimit = true;
          const retryDelay = parseRetryDelayMs(res.headers) ?? (IMAGE_GEN_RETRY_DELAY_MS * (attempt + 1));
          console.warn(`[imageGen] HTTP 429 for prompt: ${prompt.slice(0, 60)}${attempt < IMAGE_GEN_RETRY_COUNT ? `; retrying in ${retryDelay}ms` : ''}`);
          if (attempt < IMAGE_GEN_RETRY_COUNT) {
            await sleep(retryDelay);
            continue;
          }
          return { dataUrl: null, rateLimited: true };
        }

        if (res.status >= 500 && attempt < IMAGE_GEN_RETRY_COUNT) {
          const retryDelay = IMAGE_GEN_RETRY_DELAY_MS * (attempt + 1);
          console.warn(`[imageGen] HTTP ${res.status} for prompt: ${prompt.slice(0, 60)}; retrying in ${retryDelay}ms`);
          await sleep(retryDelay);
          continue;
        }

        console.error(`[imageGen] HTTP ${res.status} for prompt: ${prompt.slice(0, 60)}`);
        return { dataUrl: null, rateLimited: sawRateLimit };
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const base64 = buffer.toString('base64');
      const mime = res.headers.get('content-type') || 'image/jpeg';
      console.log(`[imageGen] Generated ${(buffer.length / 1024).toFixed(0)}KB image`);
      return { dataUrl: `data:${mime};base64,${base64}`, rateLimited: sawRateLimit };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        const retryDelay = IMAGE_GEN_RETRY_DELAY_MS * (attempt + 1);
        console.error(`[imageGen] Timeout after ${timeout}ms${attempt < IMAGE_GEN_RETRY_COUNT ? `; retrying in ${retryDelay}ms` : ''}`);
        if (attempt < IMAGE_GEN_RETRY_COUNT) {
          await sleep(retryDelay);
          continue;
        }
      } else {
        console.error(`[imageGen] Error:`, err.message);
      }
      return { dataUrl: null, rateLimited: sawRateLimit };
    }
  }

  return { dataUrl: null, rateLimited: sawRateLimit };
}

// Route to the configured provider chain — try each in order, fall through on 429 or null result.
/** WORLDGEN_DISABLE_IMAGE_GEN=1 stops every new image request; existing files keep being served. */
export function imageGenerationDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.WORLDGEN_DISABLE_IMAGE_GEN ?? '');
}

export async function generateImage(prompt: string, opts?: { width?: number; height?: number; seed?: number; timeoutMs?: number; model?: string }): Promise<GenerateImageResult> {
  if (imageGenerationDisabled()) throw new Error('Image generation is disabled (WORLDGEN_DISABLE_IMAGE_GEN)');
  let sawAnyRateLimit = false;
  let blocked = false;
  const callProvider = async (provider: string): Promise<GenerateImageResult> => {
    if (provider === 'pollinations') return generateImagePollinations(prompt, opts);
    if (provider === 'together') return generateImageTogether(prompt, opts);
    if (provider === 'fal') return generateImageFal(prompt, opts);
    if (provider === 'openrouter') return generateImageOpenRouter(prompt, opts);
    if (provider === 'openai' && IMAGE_GEN_BASE_URL) return generateImageOpenAI(prompt, opts);
    return { dataUrl: null, rateLimited: false };
  };
  // Phase 1: non-blocking cascade — try each provider that has a free slot, in order.
  for (const provider of IMAGE_GEN_PROVIDERS_CHAIN) {
    if (_isProviderRateLimited(provider)) { sawAnyRateLimit = true; continue; }
    const sem = _slotsFor(provider);
    if (!sem.tryAcquire()) continue;  // provider busy — fall through to next
    let result: GenerateImageResult;
    try {
      result = await callProvider(provider);
    } catch (err) {
      console.warn(`[imageGen] provider ${provider} threw — ${(err as Error)?.message?.slice(0, 200) ?? err}`);
      sem.release();
      continue;
    }
    sem.release();
    if (result.dataUrl) return result;
    if (result.rateLimited) { sawAnyRateLimit = true; _noteProviderRateLimit(provider, result.retryAfterMs); console.warn(`[imageGen] provider ${provider} rate-limited — cascading to next`); }
    if (result.blocked) blocked = true;
  }
  // Phase 2: every provider was either rate-limited or busy. Wait on the first non-RL provider's queue.
  for (const provider of IMAGE_GEN_PROVIDERS_CHAIN) {
    if (_isProviderRateLimited(provider)) continue;
    const sem = _slotsFor(provider);
    await sem.acquire();
    let result: GenerateImageResult;
    try {
      result = await callProvider(provider);
    } catch (err) {
      console.warn(`[imageGen] provider ${provider} threw (phase 2) — ${(err as Error)?.message?.slice(0, 200) ?? err}`);
      sem.release();
      continue;
    }
    sem.release();
    if (result.dataUrl) return result;
    if (result.rateLimited) { sawAnyRateLimit = true; _noteProviderRateLimit(provider, result.retryAfterMs); }
    if (result.blocked) blocked = true;
  }
  return { dataUrl: null, rateLimited: sawAnyRateLimit, blocked };
}

export function saveDataUrlImage(dataUrl: string, filePath: string): boolean {
  const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(dataUrl);
  if (!match) return false;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.from(match[1], 'base64'));
  return true;
}

// Generate all portraits for a world (async, non-blocking)
export async function generateWorldImages(
  world: ImageWorldContext & { id: string },
  npcs: Array<{ id: string; name: string; age: number; gender: string; ethnicity?: string; physicalDescription?: string; occupation: string; personality: string }>,
  locations: Array<{ id: string; name: string; type: string; description?: string }>,
  era: string,
  region: string,
  opts?: { outputDir?: string; publicPrefix?: string; onUpdate?: (update: GeneratedAssetUpdate) => void; skipCover?: boolean },
): Promise<GeneratedBundle> {
  const portraits: Record<string, string> = {};
  const swimwearPortraits: Record<string, string> = {};
  const scenes: Record<string, string> = {};
  const outputDir = opts?.outputDir;
  const publicPrefix = opts?.publicPrefix;
  const onUpdate = opts?.onUpdate;
  let rateLimited = false;
  let blocked = false;

  const persist = (name: string, dataUrl: string): string => {
    if (!outputDir || !publicPrefix) return dataUrl;
    const fileName = `${name}.jpg`;
    const filePath = join(outputDir, fileName);
    return saveDataUrlImage(dataUrl, filePath) ? `${publicPrefix}/${fileName}` : dataUrl;
  };

  let cover: string | undefined;

  // Skip-existing helper: build expected filepath, check if on disk already.
  // Caller can pass opts.regenerate=true to force regeneration of everything.
  const regenerate = Boolean((opts as any)?.regenerate);
  const existingPath = (name: string): string | null => {
    if (!outputDir || !publicPrefix) return null;
    const fp = join(outputDir, name + '.jpg');
    return existsSync(fp) ? publicPrefix + '/' + name + '.jpg' : null;
  };
  // Pre-populate maps with files that already exist on disk so the completion
  // check works correctly and onUpdate hydrates immediately.
  if (!regenerate) {
    if (existingPath('cover')) { cover = existingPath('cover')!; onUpdate?.({ cover }); }
    for (const npc of npcs) {
      const key = npc.id || npc.name;
      const p = existingPath(`npc-${safeName(key)}`);
      if (p) { portraits[key] = p; onUpdate?.({ portraits: { [key]: p } }); }
      if (isAdultSwimwearNpc(npc)) {
        const sp = existingPath(`npc-${safeName(key)}-swimwear`);
        if (sp) { swimwearPortraits[key] = sp; onUpdate?.({ swimwearPortraits: { [key]: sp } } as GeneratedAssetUpdate); }
      }
    }
    for (const loc of locations) {
      const key = loc.id || loc.name;
      const p = existingPath(`loc-${safeName(key)}`);
      if (p) { scenes[key] = p; onUpdate?.({ scenes: { [key]: p } }); }
    }
  }

  // Pool every image into a single parallel queue. With a Pollinations sk_
  // token there's no upstream rate limit, so the three-phase sequential
  // structure (cover -> portraits -> scenes) was leaving most of the budget
  // on the table. One pool of width IMAGE_GEN_CONCURRENCY is dramatically
  // faster end-to-end.
  type Task =
    | { kind: 'cover' }
    | { kind: 'portrait'; npc: typeof npcs[number] }
    | { kind: 'swimwear'; npc: typeof npcs[number] }
    | { kind: 'scene'; loc: typeof locations[number] };

  const tasks: Task[] = [];
  if (!opts?.skipCover && !cover) tasks.push({ kind: 'cover' });
  for (const npc of npcs) {
    const key = npc.id || npc.name;
    if (!portraits[key]) tasks.push({ kind: 'portrait', npc });
    if (isAdultSwimwearNpc(npc) && !swimwearPortraits[key]) tasks.push({ kind: 'swimwear', npc });
  }
  for (const loc of locations) {
    const key = loc.id || loc.name;
    if (!scenes[key]) tasks.push({ kind: 'scene', loc });
  }
  console.log(`[imageGen] world ${world.id} ${world.concept}: ${tasks.length} new tasks (skipped ${(npcs.length + locations.length + 1) - tasks.length} existing)`);

  await runWithConcurrency(tasks, IMAGE_GEN_EFFECTIVE_CONCURRENCY, async (task) => {
    if (task.kind === 'cover') {
      const prompt = buildWorldPrompt(world);
      console.log(`[imageGen] cover (${IMAGE_GEN_MODEL_COVER || 'default'}): ${world.concept}`);
      const img = await generateImage(prompt, { width: 960, height: 420, seed: hashCode(world.id || world.concept), timeoutMs: IMAGE_GEN_PER_IMAGE_TIMEOUT_MS, model: IMAGE_GEN_MODEL_COVER || undefined });
      rateLimited ||= img.rateLimited;
      blocked ||= Boolean(img.blocked);
      if (img.dataUrl) {
        cover = persist('cover', img.dataUrl);
        onUpdate?.({ cover });
      }
      return;
    }
    if (task.kind === 'portrait') {
      const npc = task.npc;
      const prompt = buildPortraitPrompt(npc, era, region);
      const key = npc.id || npc.name;
      console.log(`[imageGen] portrait (${IMAGE_GEN_MODEL_PORTRAIT || 'default'}): ${npc.name}`);
      const img = await generateImage(prompt, { width: 512, height: 512, seed: hashCode(key), timeoutMs: IMAGE_GEN_PER_IMAGE_TIMEOUT_MS, model: IMAGE_GEN_MODEL_PORTRAIT || undefined });
      rateLimited ||= img.rateLimited;
      blocked ||= Boolean(img.blocked);
      if (!img.dataUrl) return;
      const saved = persist(`npc-${safeName(key)}`, img.dataUrl);
      portraits[key] = saved;
      onUpdate?.({ portraits: { [key]: saved } });
      return;
    }
    if (task.kind === 'swimwear') {
      const npc = task.npc;
      const prompt = buildSwimwearPortraitPrompt(npc, era, region);
      const key = npc.id || npc.name;
      console.log(`[imageGen] swimwear (${IMAGE_GEN_MODEL_PORTRAIT || 'default'}): ${npc.name}`);
      const img = await generateImage(prompt, { width: 512, height: 768, seed: (hashCode(key) + 4242) % 999999, timeoutMs: IMAGE_GEN_PER_IMAGE_TIMEOUT_MS, model: IMAGE_GEN_MODEL_PORTRAIT || undefined });
      rateLimited ||= img.rateLimited;
      blocked ||= Boolean(img.blocked);
      if (!img.dataUrl) return;
      const saved = persist(`npc-${safeName(key)}-swimwear`, img.dataUrl);
      swimwearPortraits[key] = saved;
      onUpdate?.({ swimwearPortraits: { [key]: saved } } as GeneratedAssetUpdate);
      return;
    }
    // scene
    const loc = task.loc;
    const prompt = buildLocationPrompt(loc, era, region, undefined, world);
    const key = loc.id || loc.name;
    console.log(`[imageGen] scene (${IMAGE_GEN_MODEL_SCENE || 'default'}): ${loc.name}`);
    const img = await generateImage(prompt, { width: 800, height: 480, seed: hashCode(key), timeoutMs: IMAGE_GEN_PER_IMAGE_TIMEOUT_MS, model: IMAGE_GEN_MODEL_SCENE || undefined });
    rateLimited ||= img.rateLimited;
    blocked ||= Boolean(img.blocked);
    if (!img.dataUrl) return;
    const saved = persist(`loc-${safeName(key)}`, img.dataUrl);
    scenes[key] = saved;
    onUpdate?.({ scenes: { [key]: saved } });
  });

  const complete = (opts?.skipCover || Boolean(cover))
    && Object.keys(portraits).length === npcs.length
    && Object.keys(scenes).length === locations.length;

  return {
    cover,
    portraits,
    swimwearPortraits,
    scenes,
    complete,
    retryAfterMs: complete ? undefined : (blocked ? IMAGE_GEN_BLOCKED_COOLDOWN_MS : rateLimited ? IMAGE_GEN_RATE_LIMIT_COOLDOWN_MS : IMAGE_GEN_RETRY_DELAY_MS * 4),
  };
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      await worker(items[current], current);
    }
  }));
}

// Deterministic seed from string
function hashCode(s: string): number {
  s = String(s || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 999999;
}

function safeName(s: string): string {
  return String(s || 'image').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'image';
}

function parseRetryDelayMs(headers: Headers): number | null {
  // Try standard 'retry-after' first (seconds or HTTP date).
  const ra = retryAfterToMs(headers.get('retry-after'));
  if (ra !== null && ra > 0) return ra;
  // Together / OpenAI-style: 'x-ratelimit-reset' in seconds-to-reset.
  const reset = headers.get('x-ratelimit-reset') ?? headers.get('x-ratelimit-reset-requests');
  if (reset) {
    const s = Number(reset);
    if (Number.isFinite(s)) return Math.max(250, s * 1000);
  }
  return null;
}
function retryAfterToMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

function aspectRatioFor(width: number, height: number): string {
  const ratio = width / height;
  const options = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
  return options
    .map(value => {
      const [w, h] = value.split(':').map(Number);
      return { value, delta: Math.abs(ratio - (w / h)) };
    })
    .sort((a, b) => a.delta - b.delta)[0]?.value ?? '1:1';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
