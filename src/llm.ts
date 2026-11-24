/**
 * Multi-provider LLM abstraction layer.
 * Supports: anthropic, cerebras, gemini, mistral, openai, relay, lmstudio
 * Automatic fallback chain on failure.
 */

import JSON5 from 'json5';
import { randomUUID } from 'crypto';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DATA_DIR } from './persist.js';

export type LLMProvider = 'anthropic' | 'cerebras' | 'gemini' | 'mistral' | 'openai' | 'relay' | 'lmstudio' | 'nvidia' | 'deepseek';

// ── Config ──────────────────────────────────────────────────────────────────

const PROVIDER = (process.env.LLM_PROVIDER ?? 'mistral') as LLMProvider;
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT ?? '60000', 10);
const MISTRAL_TIMEOUT_MS = parseInt(process.env.MISTRAL_TIMEOUT ?? '60000', 10);
const CEREBRAS_TIMEOUT_MS = parseInt(process.env.CEREBRAS_TIMEOUT ?? '60000', 10);
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT ?? '60000', 10);
const DEEPSEEK_TIMEOUT_MS = parseInt(process.env.DEEPSEEK_TIMEOUT ?? '60000', 10);
const ANTHROPIC_TIMEOUT_MS = parseInt(process.env.ANTHROPIC_TIMEOUT ?? '60000', 10);
const RELAY_TIMEOUT_MS = parseInt(process.env.RELAY_TIMEOUT ?? '30000', 10);
const LMSTUDIO_TIMEOUT_MS = parseInt(process.env.LMSTUDIO_TIMEOUT ?? '15000', 10);
const NVIDIA_TIMEOUT_MS = parseInt(process.env.NVIDIA_TIMEOUT ?? '180000', 10);
const DEFAULT_RELAY_MODEL = 'Qwen3.6-27B-Q4_K_M';
const FALLBACK_RELAY_MODELS = [DEFAULT_RELAY_MODEL, 'DeepSeek-V3.2', 'gemma-3-27b-it-qat'];
// Allowlist applied to the relay-gateway /api/models response.
// Families kept: deepseek, gemma, qwen, kimi, minimax.
// Rejects: coders, embeddings, vision, TTS, image-gen, distill clones, path leaks, sketch.
const RELAY_FAMILY_PATTERNS: RegExp[] = [
  /(^|[^a-z])deepseek/i,
  /(^|[^a-z])gemma/i,
  /(^|[^a-z])qwen/i,
  /(^|[^a-z])kimi/i,
  /(^|[^a-z])minimax/i,
];
const RELAY_REJECT_PATTERNS: RegExp[] = [
  /coder|codegemma/i,
  /embed|rerank|mmproj/i,
  /\bvl[-_]|[-_]vl[-_]|qwen3vl|qwen.*-vl-/i,
  /pixtral|llava|moondream|bakllava/i,
  /whisper|tts|voice[-_]|kokoro|chatterbox|silero|speech|fish-speech/i,
  /image|sdxl|stable[-_.]?diffusion|z[-_]image|dreamshaper|animagine|qwen-image/i,
  /distill|distil(?!l)/i,
  /exploit|\brce[-_]|nuclei|leak_model|publisher-observing/i,
  /^modelfile|^cachedir|\.gguf$/i,
  /^[a-z]:[\\\/]|^\//i,
  /^(hf\.co|koboldcpp|gag0|yolo0|google_|qwen_|unsloth_|opengvlab_|mlabonne_|ibm-granite_|arcee-ai_)/i,
  /^[0-9a-f]{24,}$/i,
];
function filterRelayModels(models: string[]): string[] {
  return models.filter(m => {
    if (typeof m !== 'string' || !m.trim()) return false;
    if (RELAY_REJECT_PATTERNS.some(rx => rx.test(m))) return false;
    return RELAY_FAMILY_PATTERNS.some(rx => rx.test(m));
  });
}
const RELAY_MODELS_CACHE_MS = 5 * 60 * 1000;
const RELAY_MODELS_TIMEOUT_MS = parseInt(process.env.RELAY_MODELS_TIMEOUT ?? '5000', 10);
const RELAY_ACTIVE_MODELS_CACHE_MS = parseInt(process.env.RELAY_ACTIVE_MODELS_CACHE_MS ?? '600000', 10);
const RELAY_MODEL_PROBE_TIMEOUT_MS = parseInt(process.env.RELAY_MODEL_PROBE_TIMEOUT ?? '20000', 10);
const RELAY_MODEL_PROBE_LIMIT = parseInt(process.env.RELAY_MODEL_PROBE_LIMIT ?? '12', 10);
const RELAY_MODEL_PROBE_MIN_SCORE = parseInt(process.env.RELAY_MODEL_PROBE_MIN_SCORE ?? '2', 10);
const LLM_PROVIDER_COOLDOWN_MS = parseInt(process.env.LLM_PROVIDER_COOLDOWN_MS ?? '120000', 10);
const LLM_DEBUG = process.env.LLM_DEBUG === '1' || process.env.LLM_DEBUG === 'true';
const CEREBRAS_DEFAULT_MODEL = 'gpt-oss-120b';
const CEREBRAS_MODEL_REPLACEMENTS: Record<string, string> = {
  'qwen-3-235b-a22b-instruct-2507': CEREBRAS_DEFAULT_MODEL,
  'llama3.1-8b': CEREBRAS_DEFAULT_MODEL,
};
let relayModelsCache: { models: string[]; expiresAt: number } | null = null;
let activeRelayModelsCache: { models: string[]; expiresAt: number } | null = null;
const loggedIncompatibleModels = new Set<string>();
const loggedCerebrasModelReplacements = new Set<string>();
const providerCooldownUntil = new Map<LLMProvider, number>();

export interface LLMRequest {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
  temperature?: number;
  provider?: string;
  jsonMode?: boolean;
  thinking?: boolean;
  timeoutMs?: number;
}

export interface LLMResponse {
  text: string;
  provider: LLMProvider;
  model: string;
  durationMs: number;
}

export interface LLMProviderInfo {
  id: LLMProvider;
  model: string;
  models: string[];
  available: boolean;
}

const PROVIDER_PREFERENCE_ORDER: LLMProvider[] = ['mistral', 'cerebras', 'gemini', 'openai', 'nvidia', 'lmstudio', 'anthropic', 'deepseek'];

function withTimeout(req: LLMRequest, defaultTimeoutMs: number): number {
  return Math.max(1, req.timeoutMs ?? defaultTimeoutMs);
}

// ── Provider detection ──────────────────────────────────────────────────────

export function getEffectiveLLMProvider(requested?: string): LLMProvider {
  const preferred = (requested ?? PROVIDER) as LLMProvider;
  if (hasCredentials(preferred) && !isProviderOnCooldown(preferred)) return preferred;
  // A UI that remembers an unavailable provider (e.g. its 'mistral' default) gets the operator's
  // LLM_PROVIDER, not whichever provider happens to come first in the generic order.
  if (preferred !== PROVIDER && hasCredentials(PROVIDER) && !isProviderOnCooldown(PROVIDER)) return PROVIDER;

  return PROVIDER_PREFERENCE_ORDER.find(p => hasCredentials(p) && !isProviderOnCooldown(p))
    ?? PROVIDER_PREFERENCE_ORDER.find(hasCredentials)
    ?? preferred;
}

export function getDefaultModel(provider: LLMProvider): string {
  switch (provider) {
    case 'gemini': return process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    case 'mistral': return process.env.MISTRAL_MODEL ?? 'mistral-small-latest';
    case 'cerebras': return normalizeCerebrasModel(process.env.CEREBRAS_MODEL);
    case 'openai': return process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
    case 'deepseek': return process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash';
    case 'anthropic': return process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
    case 'relay': {
      const relayModel = process.env.RELAY_MODEL?.trim();
      return relayModel && isModelCompatible('relay', relayModel) && !isRelayAutoModel(relayModel) ? relayModel : 'relay';
    }
    case 'lmstudio': return process.env.LMSTUDIO_MODEL ?? 'local-model';
    case 'nvidia': return process.env.NVIDIA_MODEL ?? 'meta/llama-3.3-70b-instruct';
  }
}

function hasCredentials(provider: LLMProvider): boolean {
  // .trim() guard: an empty-but-set env var (e.g. `ANTHROPIC_API_KEY=` in .env when
  // a system-level user/machine env var leaks in) should be treated as no credential.
  // Without this, the .env override doesn't actually disable the provider.
  switch (provider) {
    case 'anthropic': return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    case 'cerebras': return Boolean(process.env.CEREBRAS_API_KEY?.trim());
    case 'gemini': return Boolean(process.env.GEMINI_API_KEY?.trim());
    case 'mistral': return Boolean(process.env.MISTRAL_API_KEY?.trim());
    case 'openai': return Boolean(openaiApiKey());
    case 'deepseek': return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
    case 'relay': return Boolean(getRelayKey());
    case 'lmstudio':
      // Only advertise lmstudio if the operator explicitly enables it,
      // or sets a non-default base URL. Otherwise the VPS will list it as
      // available and clicking it dead-ends at localhost:1234 with nothing listening.
      return process.env.LMSTUDIO_ENABLED === '1'
          || Boolean(process.env.LMSTUDIO_BASE_URL);
    case 'nvidia': return Boolean(process.env.NVIDIA_API_KEY?.trim());
  }
}

async function probeLmStudio(): Promise<boolean> {
  const baseUrl = (process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234').replace(/\/$/, '');
  try {
    const res = await fetchWithTimeout(`${baseUrl}/v1/models`, { method: 'GET' }, 1500);
    return res.ok;
  } catch { return false; }
}

export function availableProviders(): LLMProvider[] {
  const all: LLMProvider[] = ['mistral', 'cerebras', 'gemini', 'openai', 'nvidia', 'lmstudio', 'anthropic', 'deepseek'];
  return all.filter(p => hasCredentials(p));
}

export async function availableProviderInfo(): Promise<LLMProviderInfo[]> {
  const providers = availableProviders();
  const lmstudioOk = providers.includes('lmstudio') ? await probeLmStudio() : false;
  const infos = await Promise.all(providers.map(async provider => {
    let models: string[];
    if (provider === 'relay') {
      // Only expose relay models that actually answer a probe request. The relay
      // catalog can include stale names that fail later during live gameplay.
      try {
        const fetched = await getActiveRelayModels();
        models = fetched.length ? fetched : [];
      } catch {
        models = [];
      }
    } else {
      models = [getDefaultModel(provider)];
    }
    const model = provider === 'relay'
      ? (process.env.RELAY_MODEL && models.includes(process.env.RELAY_MODEL)
          ? process.env.RELAY_MODEL
          : (models.length ? chooseRelayModel(models) : 'relay'))
      : (models[0] ?? getDefaultModel(provider));
    const available = provider === 'lmstudio' ? lmstudioOk : provider === 'relay' ? models.length > 0 : true;
    return { id: provider, model, models, available };
  }));
  return infos;
}

// ── Shared utils ────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── SSE parser (Mistral, OpenAI, Relay streaming) ───────────────────────────

function parseSSEResponse(text: string): string {
  const lines = text.split('\n');
  let content = '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;
    try {
      const parsed = JSON5.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const chunk = parsed.choices?.[0]?.delta?.content;
      if (chunk) content += chunk;
    } catch { /* skip */ }
  }
  return content.trim();
}

function parseOpenAIResponse(data: any): string {
  const choice = data.choices?.[0];
  return (choice?.message?.content ?? choice?.text ?? '').trim();
}

function getRelayKey(): string | undefined {
  return process.env.RELAY_KEY || process.env.RELAY_API_KEY;
}

function getRelayBaseUrl(): string {
  return (process.env.RELAY_URL ?? process.env.RELAY_BASE_URL ?? 'https://relay-gateway.onrender.com').replace(/\/$/, '');
}

function relayHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'x-api-key': key,
    'Content-Type': 'application/json',
  };
}

function coerceModelList(data: any): string[] {
  const raw = Array.isArray(data) ? data
    : Array.isArray(data?.models) ? data.models
      : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.items) ? data.items
          : [];
  return Array.from(new Set(raw
    .map((item: any) => typeof item === 'string' ? item : item?.id ?? item?.name ?? item?.model)
    .filter((model: unknown): model is string => typeof model === 'string' && model.trim().length > 0)));
}

function isRelayAutoModel(model?: string): boolean {
  return !model || model === 'auto' || model === 'relay';
}

function modelName(model?: string): string {
  return (model ?? '').trim();
}

function normalizeCerebrasModel(model?: string): string {
  const name = modelName(model) || CEREBRAS_DEFAULT_MODEL;
  const replacement = CEREBRAS_MODEL_REPLACEMENTS[name.toLowerCase()];
  if (replacement && LLM_DEBUG && !loggedCerebrasModelReplacements.has(name)) {
    loggedCerebrasModelReplacements.add(name);
    console.warn(`[llm:cerebras] replacing unavailable model "${name}" with "${replacement}"`);
  }
  return replacement ?? name;
}

function isCerebrasModelNotFound(status: number, body: string): boolean {
  return (status === 400 || status === 404)
    && /(model_not_found|model[^.]{0,80}(does not exist|not found)|do not have access)/i.test(body);
}

function isModelCompatible(provider: LLMProvider, model?: string): boolean {
  const name = modelName(model);
  if (!name) return true;

  switch (provider) {
    case 'anthropic':
      return /^claude-/i.test(name);
    case 'gemini':
      return /^gemini-/i.test(name);
    case 'mistral':
      return /^(mistral|ministral|codestral|magistral|pixtral|open-mistral|open-mixtral)(-|$)/i.test(name);
    case 'cerebras':
      return /^(qwen|gpt-oss|zai|llama|deepseek|mistral)([0-9.\-_:]|$)/i.test(name);
    case 'openai':
      return /^(gpt-|o[134](?:-|$)|chatgpt-|text-|davinci|curie|babbage|ada)/i.test(name);
    case 'relay':
      return isRelayAutoModel(name) || filterRelayModels([name]).length === 1;
    case 'nvidia':
      return /^[a-z0-9_.-]+\/[a-z0-9_.-]+/i.test(name);
    case 'deepseek':
      return /^deepseek-/i.test(name);
    case 'lmstudio':
      return true;
  }
}

function requestForProvider(req: LLMRequest, provider: LLMProvider): LLMRequest {
  const model = modelName(req.model);
  if (!model) return { ...req, model: undefined };
  if (isModelCompatible(provider, model)) return model === req.model ? req : { ...req, model };
  const logKey = `${provider}:${model}`;
  if (LLM_DEBUG && !loggedIncompatibleModels.has(logKey)) {
    loggedIncompatibleModels.add(logKey);
    console.warn(`[llm:${provider}] ignoring incompatible model "${model}"`);
  }
  return { ...req, model: undefined };
}

function scoreRelayModel(model: string): number {
  const name = model.toLowerCase();
  let score = 0;

  if (/claude/.test(name)) score += 300;
  if (/opus/.test(name)) score += 700;
  if (/sonnet/.test(name)) score += 600;
  if (/gpt-5|gpt5|o3|o4/.test(name)) score += 850;
  if (/gpt-4\.1|gpt-4o|gpt4/.test(name)) score += 740;
  if (/gemini/.test(name) && /pro/.test(name)) score += 720;
  if (/mistral/.test(name) && /large/.test(name)) score += 680;
  if (/haiku/.test(name)) score += 200;
  if (/70b|405b/.test(name)) score += 500;

  if (/haiku|mini|small|flash|lite|8b|3b/.test(name)) score -= 60;
  if (/embedding|vision|image|tts|whisper|moderation/.test(name)) score -= 500;

  const version = name.match(/(?:^|[^0-9])([0-9])(?:[.\-_]?([0-9]))?/);
  if (version) score += Number(version[1]) * 10 + Number(version[2] ?? 0);

  return score;
}

function chooseRelayModel(models: string[]): string {
  return models
    .filter(model => !isRelayAutoModel(model))
    .sort((a, b) => scoreRelayModel(b) - scoreRelayModel(a) || a.localeCompare(b))[0]
    ?? DEFAULT_RELAY_MODEL;
}

export async function getRelayModels(): Promise<string[]> {
  if (relayModelsCache && relayModelsCache.expiresAt > Date.now()) return relayModelsCache.models;

  const key = getRelayKey();
  if (!key) return FALLBACK_RELAY_MODELS;
  const baseUrl = getRelayBaseUrl();
  const paths = ['/api/models', '/v1/models'];

  for (const path of paths) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}${path}`, {
        method: 'GET',
        headers: relayHeaders(key),
      }, RELAY_MODELS_TIMEOUT_MS);
      if (!res.ok) continue;
      const rawModels = coerceModelList(await res.json());
      const models = filterRelayModels(rawModels);
      if (models.length > 0) {
        const sorted = models.slice().sort((a, b) => scoreRelayModel(b) - scoreRelayModel(a) || a.localeCompare(b));
        relayModelsCache = { models: sorted, expiresAt: Date.now() + RELAY_MODELS_CACHE_MS };
        return sorted;
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        console.warn(`[relay:models:${path}]`, String(err).slice(0, 160));
      }
    }
  }

  relayModelsCache = { models: FALLBACK_RELAY_MODELS, expiresAt: Date.now() + RELAY_MODELS_CACHE_MS };
  return FALLBACK_RELAY_MODELS;
}

type RelayProbeResult = { model: string; ok: boolean; score: number; durationMs: number; reason?: string };

function extractJsonObject(text: string): any | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON5.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function relayProbeFailureReason(text: string): string {
  const value = text.slice(0, 500);
  if (!value.trim()) return 'empty response';
  if (/error|exception|traceback|invalid model|not found|unavailable|overloaded|rate limit/i.test(value)) return 'error-like response';
  if (isProviderLeak(value)) return 'persona leak';
  return 'invalid probe answer';
}

function scoreRelayProbeText(text: string): { score: number; reason?: string } {
  const trimmed = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
  if (!trimmed) return { score: 0, reason: 'empty response' };
  if (/error|exception|traceback|invalid model|not found|unavailable|overloaded|rate limit/i.test(trimmed.slice(0, 500))) {
    return { score: 0, reason: 'error-like response' };
  }
  if (isProviderLeak(trimmed)) return { score: 0, reason: 'persona leak' };

  let score = 1;
  const parsed = extractJsonObject(trimmed);
  if (!parsed) return { score, reason: 'non-json response' };
  score += 1;
  if (parsed.ok === true) score += 1;
  if (String(parsed.name ?? '').toLowerCase() === 'ada') score += 1;
  if (Number(parsed.sum) === 5) score += 1;
  if (String(parsed.intent ?? '').toLowerCase() === 'wait') score += 1;
  return { score };
}

async function relayProbeRequest(model: string, message: string, timeoutMs: number): Promise<{ text: string; durationMs: number }> {
  const key = getRelayKey();
  if (!key) throw new Error('RELAY_API_KEY required');
  const start = Date.now();
  const res = await fetchWithTimeout(`${getRelayBaseUrl()}/api/chat`, {
    method: 'POST',
    headers: relayHeaders(key),
    body: JSON.stringify({
      message,
      model,
      session: `worldgen-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error(`non-JSON ${ct}`);
  const data = await res.json();
  const text = typeof data.response === 'string' ? data.response : parseOpenAIResponse(data);
  return { text: text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim(), durationMs: Date.now() - start };
}

async function probeRelayModel(model: string): Promise<RelayProbeResult> {
  let score = 0;
  let durationMs = 0;
  try {
    const probe = await relayProbeRequest(
      model,
      'Return only compact JSON, no markdown: {"ok":true,"name":"Ada","sum":5,"intent":"wait"}',
      RELAY_MODEL_PROBE_TIMEOUT_MS,
    );
    durationMs += probe.durationMs;
    const scored = scoreRelayProbeText(probe.text);
    score += scored.score;
    if (score < RELAY_MODEL_PROBE_MIN_SCORE) {
      return { model, ok: false, score, durationMs, reason: scored.reason ?? relayProbeFailureReason(probe.text) };
    }
    if (durationMs <= RELAY_MODEL_PROBE_TIMEOUT_MS) score += 1;
    return { model, ok: score >= RELAY_MODEL_PROBE_MIN_SCORE, score, durationMs };
  } catch (err) {
    const reason = String(err).slice(0, 160);
    if (LLM_DEBUG) console.warn(`[relay:probe:${model}]`, reason);
    return { model, ok: false, score, durationMs, reason };
  }
}

export async function getActiveRelayModels(): Promise<string[]> {
  if (activeRelayModelsCache && activeRelayModelsCache.expiresAt > Date.now()) return activeRelayModelsCache.models;

  const listed = (await getRelayModels()).filter(model => !isRelayAutoModel(model));
  const envModel = modelName(process.env.RELAY_MODEL);
  const candidates = Array.from(new Set([
    ...(envModel && isModelCompatible('relay', envModel) && !isRelayAutoModel(envModel) ? [envModel] : []),
    ...listed,
  ])).slice(0, Math.max(1, RELAY_MODEL_PROBE_LIMIT));

  const active: string[] = [];
  const rejected: RelayProbeResult[] = [];
  const batchSize = 3;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(model => probeRelayModel(model)));
    for (const result of results) {
      if (result.ok) active.push(result.model);
      else rejected.push(result);
    }
  }

  const ranked = active.slice().sort((a, b) => scoreRelayModel(b) - scoreRelayModel(a) || a.localeCompare(b));
  activeRelayModelsCache = { models: ranked, expiresAt: Date.now() + RELAY_ACTIVE_MODELS_CACHE_MS };
  console.log(`[relay:probe] active ${ranked.length}/${candidates.length}${ranked.length ? `: ${ranked.join(', ')}` : ''}`);
  if (LLM_DEBUG && rejected.length) {
    for (const result of rejected) {
      console.warn(`[relay:probe:${result.model}] rejected: ${result.reason ?? 'score too low'} (score ${result.score}, ${result.durationMs}ms)`);
    }
  }
  return ranked;
}

// ── Anthropic ───────────────────────────────────────────────────────────────

async function anthropicChat(req: LLMRequest): Promise<LLMResponse> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY required');
  const model = req.model ?? getDefaultModel('anthropic');
  const start = Date.now();

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? 1024,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    }),
  }, withTimeout(req, ANTHROPIC_TIMEOUT_MS));

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json() as { content: Array<{ type: string; text?: string }> };
  const text = data.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Empty Anthropic response');
  return { text: text.trim(), provider: 'anthropic', model, durationMs: Date.now() - start };
}

// ── Gemini ───────────────────────────────────────────────────────────────────

async function geminiChat(req: LLMRequest): Promise<LLMResponse> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY required');
  const model = req.model ?? getDefaultModel('gemini');
  const start = Date.now();

  const body: any = {
    system_instruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.user }] }],
    generationConfig: {
      maxOutputTokens: Math.max(req.maxTokens ?? 1024, 64),
      temperature: req.temperature ?? 0.85,
    },
  };

  if (req.jsonMode) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  if (req.thinking === false) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) },
    withTimeout(req, GEMINI_TIMEOUT_MS),
  );

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response');
  return { text: text.trim(), provider: 'gemini', model, durationMs: Date.now() - start };
}

// ── Mistral ─────────────────────────────────────────────────────────────────

async function mistralChat(req: LLMRequest): Promise<LLMResponse> {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY required');
  const model = req.model ?? getDefaultModel('mistral');
  const start = Date.now();

  const body: any = {
    model,
    temperature: req.temperature ?? 0.95,
    max_tokens: req.maxTokens ?? 1024,
    stream: false,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  };
  if (req.jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, withTimeout(req, MISTRAL_TIMEOUT_MS));

  if (!res.ok) throw new Error(`Mistral ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = parseOpenAIResponse(data);
  if (!text) throw new Error('Empty Mistral response');
  return { text, provider: 'mistral', model, durationMs: Date.now() - start };
}

// ── Cerebras (OpenAI-compatible) ───────────────────────────────────────────

async function cerebrasChat(req: LLMRequest): Promise<LLMResponse> {
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) throw new Error('CEREBRAS_API_KEY required');
  const baseUrl = (process.env.CEREBRAS_BASE_URL ?? 'https://api.cerebras.ai').replace(/\/$/, '');
  const endpoint = `${baseUrl}${baseUrl.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  let model = normalizeCerebrasModel(req.model);
  const start = Date.now();

  const body: any = {
    model,
    temperature: req.temperature ?? 0.85,
    max_tokens: req.maxTokens ?? 1024,
    stream: false,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  };
  if (req.jsonMode) body.response_format = { type: 'json_object' };

  let res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }, withTimeout(req, CEREBRAS_TIMEOUT_MS));

  if (!res.ok) {
    const errBody = await res.text();
    if (model !== CEREBRAS_DEFAULT_MODEL && isCerebrasModelNotFound(res.status, errBody)) {
      console.warn(`[llm:cerebras] model "${model}" unavailable; retrying ${CEREBRAS_DEFAULT_MODEL}`);
      model = CEREBRAS_DEFAULT_MODEL;
      body.model = model;
      res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      }, withTimeout(req, CEREBRAS_TIMEOUT_MS));
    } else {
      throw new Error(`Cerebras ${res.status}: ${errBody}`);
    }
  }

  if (!res.ok) throw new Error(`Cerebras ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = parseOpenAIResponse(data).replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
  if (!text) throw new Error('Empty Cerebras response');
  return { text, provider: 'cerebras', model, durationMs: Date.now() - start };
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

/**
 * Key for the OpenAI-compatible endpoint. OPENAI_GATEWAY_API_KEY (the key for a gateway at
 * OPENAI_BASE_URL, e.g. OmniRoute) wins over OPENAI_API_KEY: dotenv never overrides a variable
 * already set machine-wide, so a system OPENAI_API_KEY would otherwise beat the one in .env.
 */
function openaiApiKey(): string | undefined {
  return process.env.OPENAI_GATEWAY_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || undefined;
}

/** OpenAI-compatible root (OpenAI, OmniRoute, LiteLLM...). Accepts OPENAI_BASE_URL with or without /v1. */
function openaiApiRoot(): string {
  const base = (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com').replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${base}/v1`;
}

async function openaiChat(req: LLMRequest): Promise<LLMResponse> {
  const key = openaiApiKey();
  if (!key) throw new Error('OPENAI_GATEWAY_API_KEY or OPENAI_API_KEY required');
  const model = req.model ?? getDefaultModel('openai');
  const start = Date.now();

  const body: any = {
    model,
    temperature: req.temperature ?? 0.85,
    max_tokens: req.maxTokens ?? 1024,
    stream: false,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  };
  if (req.jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout(`${openaiApiRoot()}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, withTimeout(req, OPENAI_TIMEOUT_MS));

  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = parseOpenAIResponse(data);
  if (!text) throw new Error('Empty OpenAI response');
  return { text, provider: 'openai', model, durationMs: Date.now() - start };
}

// ── DeepSeek ────────────────────────────────────────────────────────────────
// OpenAI-compatible. Same DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL as the script digests.

async function deepseekChat(req: LLMRequest): Promise<LLMResponse> {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error('DEEPSEEK_API_KEY required');
  const model = req.model ?? getDefaultModel('deepseek');
  const base = (process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/+$/, '').replace(/\/v1$/i, '');
  const start = Date.now();
  // The flash/pro models think before answering by default, and on a game-sized budget the thinking
  // can use every token and leave an empty reply (finish_reason "length"). Game calls want the
  // answer, so thinking is off unless DEEPSEEK_THINKING=enabled.
  const thinking = /^(1|true|yes|on|enabled)$/i.test(process.env.DEEPSEEK_THINKING ?? '');

  const send = async (withThinking: boolean) => {
    const body: any = {
      model,
      temperature: req.temperature ?? 0.85,
      max_tokens: withThinking ? Math.max(req.maxTokens ?? 1024, 1024) : (req.maxTokens ?? 1024),
      stream: false,
      thinking: { type: withThinking ? 'enabled' : 'disabled' },
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    };
    if (req.jsonMode) body.response_format = { type: 'json_object' };
    const res = await fetchWithTimeout(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, withTimeout(req, DEEPSEEK_TIMEOUT_MS));
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      text: parseOpenAIResponse(data).replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim(),
      finish: data?.choices?.[0]?.finish_reason as string | undefined,
    };
  };

  let result = await send(thinking);
  // Thinking used the whole budget: ask again without it rather than fail the call.
  if (!result.text && thinking && result.finish === 'length') result = await send(false);
  if (!result.text) throw new Error(`Empty DeepSeek response (finish_reason ${result.finish ?? 'unknown'})`);
  return { text: result.text, provider: 'deepseek', model, durationMs: Date.now() - start };
}

// ── Relay Gateway ───────────────────────────────────────────────────────────

async function relayChat(req: LLMRequest): Promise<LLMResponse> {
  const key = getRelayKey();
  if (!key) throw new Error('RELAY_API_KEY required');
  const baseUrl = getRelayBaseUrl();
  const envRelayModel = modelName(process.env.RELAY_MODEL);
  const reqRelayModel = modelName(req.model);
  const relayModel = envRelayModel && isModelCompatible('relay', envRelayModel) && !isRelayAutoModel(envRelayModel)
    ? envRelayModel
    : reqRelayModel && isModelCompatible('relay', reqRelayModel) && !isRelayAutoModel(reqRelayModel)
      ? reqRelayModel
      : chooseRelayModel(await getRelayModels());
  const start = Date.now();

  // Relay-gateway's /api/chat expects a flattened single-message format,
  // not OpenAI's role-separated messages array. Combine system + user.
  const flatMessage = req.system
    ? `${req.system}\n\n---\n\n${req.user}`
    : req.user;

  const body: any = {
    message: flatMessage,
    model: relayModel,
    session: `worldgen-${Date.now()}`,
  };

  const res = await fetchWithTimeout(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: relayHeaders(key),
    body: JSON.stringify(body),
  }, withTimeout(req, RELAY_TIMEOUT_MS));

  if (!res.ok) throw new Error(`Relay ${res.status}: ${await res.text()}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const preview = (await res.text()).slice(0, 200);
    throw new Error(`Relay returned non-JSON (${ct}): ${preview}`);
  }
  const data = await res.json();
  let text = typeof data.response === 'string' ? data.response : parseOpenAIResponse(data);
  // Strip <think>...</think> blocks that reasoning backends (Qwen3.6, deepseek-r1, etc.)
  // emit unconditionally — sometimes empty, sometimes with real reasoning content.
  // parseLLMJSON skips past them anyway, but plain-text consumers (NPC dialogue,
  // descriptions) need them removed.
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
  if (!text) throw new Error('Empty Relay response');
  return { text, provider: 'relay', model: data.model || relayModel, durationMs: Date.now() - start };
}

// ── LM Studio (local) ──────────────────────────────────────────────────────

async function lmstudioChat(req: LLMRequest): Promise<LLMResponse> {
  const baseUrl = (process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234').replace(/\/$/, '');
  const model = req.model ?? getDefaultModel('lmstudio');
  const start = Date.now();

  const res = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: req.temperature ?? 0.75,
      max_tokens: req.maxTokens ?? 1024,
      stream: false,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }),
  }, withTimeout(req, LMSTUDIO_TIMEOUT_MS));

  if (!res.ok) throw new Error(`LM Studio ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = parseOpenAIResponse(data);
  if (!text) throw new Error('Empty LM Studio response');
  return { text, provider: 'lmstudio', model, durationMs: Date.now() - start };
}

// ── NVIDIA NIM (OpenAI-compatible) ─────────────────────────────────────────

async function nvidiaChat(req: LLMRequest): Promise<LLMResponse> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('NVIDIA_API_KEY required');
  const baseUrl = (process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com').replace(/\/$/, '');
  const model = req.model ?? getDefaultModel('nvidia');
  const start = Date.now();

  const body: any = {
    model,
    temperature: req.temperature ?? 0.85,
    max_tokens: req.maxTokens ?? 1024,
    stream: false,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  };
  // NVIDIA NIM honours the OpenAI-style response_format for compatible models.
  if (req.jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }, withTimeout(req, NVIDIA_TIMEOUT_MS));

  if (!res.ok) throw new Error(`NVIDIA ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = parseOpenAIResponse(data);
  if (!text) throw new Error('Empty NVIDIA response');
  return { text, provider: 'nvidia', model, durationMs: Date.now() - start };
}

// ── Main entry point + fallback chain ───────────────────────────────────────

const PROVIDER_FNS: Record<LLMProvider, (req: LLMRequest) => Promise<LLMResponse>> = {
  anthropic: anthropicChat,
  cerebras: cerebrasChat,
  gemini: geminiChat,
  mistral: mistralChat,
  openai: openaiChat,
  relay: relayChat,
  lmstudio: lmstudioChat,
  nvidia: nvidiaChat,
  deepseek: deepseekChat,
};

function isProviderLeak(text: string): boolean {
  return /\bI'm Kiro\b/i.test(text)
    || /\bI am Kiro\b/i.test(text)
    || /\bAI assistant and IDE\b/i.test(text)
    || /\bcoding partner\b/i.test(text)
    || /\bdevelopment work are you looking to tackle\b/i.test(text)
    || /\bcoding or development project\b/i.test(text)
    || /\bI can help you write code, debug issues\b/i.test(text)
    || /\bsystem administration\b/i.test(text);
}

function assertUsableResponse(res: LLMResponse): LLMResponse {
  if (isProviderLeak(res.text)) {
    throw new Error(`Provider persona leak from ${res.provider}/${res.model}`);
  }
  return res;
}

function isProviderOnCooldown(provider: LLMProvider): boolean {
  return (providerCooldownUntil.get(provider) ?? 0) > Date.now();
}

function noteProviderFailure(provider: LLMProvider, err: unknown): void {
  if (!isTransientLLMFailure(err) || LLM_PROVIDER_COOLDOWN_MS <= 0) return;
  providerCooldownUntil.set(provider, Date.now() + LLM_PROVIDER_COOLDOWN_MS);
}

function isTransientLLMFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timed out after \d+ms/i.test(msg)
    || /\b(429|500|502|503|504)\b/.test(msg)
    || /\b(rate.?limit|temporarily unavailable|service unavailable|internal_server_error)\b/i.test(msg);
}

function logLLMFailure(label: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (isTransientLLMFailure(err)) {
    console.warn(`${label} ${msg}`);
    return;
  }
  console.error(label, err);
}

// Mistral remains primary; Cerebras is first alternate for failed generation.
// Relay follows because it owns its own model catalog.
// DeepSeek is last so a key kept only for script digests is not used for dialogue unless all else fails.
const FALLBACK_ORDER: LLMProvider[] = ['mistral', 'cerebras', 'relay', 'gemini', 'openai', 'anthropic', 'nvidia', 'deepseek'];

async function fallbackChat(req: LLMRequest, attempted: string[]): Promise<LLMResponse> {
  const fallbackReq = { ...req, model: undefined };
  for (const provider of FALLBACK_ORDER) {
    if (attempted.includes(provider) || !hasCredentials(provider) || isProviderOnCooldown(provider)) continue;
    try {
      console.log(`[llm:fallback] trying ${provider}...`);
      return assertUsableResponse(await PROVIDER_FNS[provider](requestForProvider(fallbackReq, provider)));
    } catch (err) {
      logLLMFailure(`[llm:fallback:${provider}]`, err);
      noteProviderFailure(provider, err);
    }
  }
  throw new Error(`All LLM providers failed (tried: ${attempted.join(', ')})`);
}

/**
 * Send a chat completion request to the configured (or specified) LLM provider.
 * Falls back through other available providers on failure.
 */
export async function llmChat(req: LLMRequest): Promise<LLMResponse> {
  const provider = getEffectiveLLMProvider(req.provider);
  const fn = PROVIDER_FNS[provider];
  if (!fn) throw new Error(`Unknown provider: ${provider}`);

  try {
    return assertUsableResponse(await fn(requestForProvider(req, provider)));
  } catch (err) {
    logLLMFailure(`[llm:${provider}]`, err);
    noteProviderFailure(provider, err);
    if (provider === 'lmstudio') throw err; // no fallback for local models
    return fallbackChat(req, [provider]);
  }
}

/**
 * Convenience: send a request and get just the text back.
 */
export async function llmText(req: LLMRequest): Promise<string> {
  const res = await llmChat(req);
  return res.text;
}

async function parseJSONWithProviderFallback<T>(req: LLMRequest, attemptedProviders: LLMProvider[], lastErr: unknown): Promise<T> {
  const attempted = Array.from(new Set(attemptedProviders));
  let parseErr = lastErr;

  while (attempted.length < FALLBACK_ORDER.length) {
    let fallback: LLMResponse;
    try {
      fallback = await fallbackChat(req, attempted);
    } catch (fallbackErr) {
      console.error('[llmJSON] Provider fallback unavailable:', String(fallbackErr).slice(0, 160));
      throw parseErr;
    }

    attempted.push(fallback.provider);
    try {
      return parseLLMJSON<T>(fallback.text);
    } catch (err) {
      parseErr = err;
      console.error(`[llmJSON] ${fallback.provider} fallback parse failed:`, String(err).slice(0, 160));
      console.error('[llmJSON] Fallback response tail:', fallback.text.slice(-300));
    }
  }

  throw parseErr;
}

/**
 * Convenience: send a request expecting JSON back, parsed.
 * Includes robust cleaning for LLM output quirks.
 */
export async function llmJSON<T = any>(req: LLMRequest): Promise<T> {
  const jsonSuffix = '\n\nIMPORTANT: Output ONLY the JSON object. No reasoning, no explanation, no <think> tags. Start your response with { and end with }.';
  const primaryProvider = getEffectiveLLMProvider(req.provider);
  const res = await llmChat({ ...req, jsonMode: true, system: (req.system || '') + jsonSuffix });
  try {
    return parseLLMJSON<T>(res.text);
  } catch (firstErr) {
    console.error('[llmJSON] Parse failed:', String(firstErr).slice(0, 160));
    console.error('[llmJSON] Response tail:', res.text.slice(-300));

    const retryReq = {
      ...req,
      jsonMode: true,
      temperature: Math.min(req.temperature ?? 0.7, 0.35),
      maxTokens: Math.min(Math.max((req.maxTokens ?? 1024) * 2, 4096), 20000),
      system: `${req.system}\n\nReturn ONLY complete valid JSON. No <think> tags, no markdown fences, no comments, no explanations, no trailing prose. Start with { or [ and end with } or ]. Keep every string under 160 characters so the JSON does not get cut off.`,
      user: `${req.user}\n\nYour previous response was not parseable JSON (${String(firstErr).slice(0, 120)}). Regenerate the full response as complete valid JSON only. Do NOT wrap in <think> tags or include any reasoning.`,
    };
    const retry = await llmChat(retryReq);

    try {
      return parseLLMJSON<T>(retry.text);
    } catch (retryErr) {
      console.error('[llmJSON] Retry parse failed:', String(retryErr).slice(0, 160));
      console.error('[llmJSON] Retry response tail:', retry.text.slice(-300));
      return parseJSONWithProviderFallback<T>(retryReq, [primaryProvider, res.provider, retry.provider], retryErr);
    }
  }
}

// Extract `line:col` from a JSON5 error message (e.g. "JSON5: invalid character ']' at 292:39").
function extractErrPos(err: unknown): { line: number; col: number } | null {
  const m = /at (\d+):(\d+)/.exec(String(err));
  if (!m) return null;
  return { line: parseInt(m[1], 10), col: parseInt(m[2], 10) };
}

function lineColToOffset(s: string, line: number, col: number): number {
  let curLine = 1;
  let curCol = 1;
  for (let i = 0; i < s.length; i++) {
    if (curLine === line && curCol === col) return i;
    if (s[i] === '\n') { curLine++; curCol = 1; }
    else curCol++;
  }
  return s.length;
}

// Surgical repair: when JSON5 reports a specific offending character, remove just that
// character and retry. Handles stray `]`, `}`, `,`, mismatched punctuation, etc.
function surgicalRepair<T>(input: string, maxAttempts = 80): { ok: true; value: T } | { ok: false; err: unknown; text: string } {
  let cur = input;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return { ok: true, value: JSON5.parse(cur) as T }; }
    catch (e) {
      lastErr = e;
      const pos = extractErrPos(e);
      if (!pos) break;
      const offset = lineColToOffset(cur, pos.line, pos.col);
      if (offset >= cur.length) break;
      // Drop the offending character.
      cur = cur.slice(0, offset) + cur.slice(offset + 1);
    }
  }
  return { ok: false, err: lastErr, text: cur };
}

const __llmFile = fileURLToPath(import.meta.url);
const __llmDir = dirname(__llmFile);
const FAILED_DUMP_DIR = join(DATA_DIR, 'failed-json');
const DEBUG_LLM_JSON = process.env.DEBUG_LLM_JSON === '1';

function dumpFailedPayload(raw: string, label: string): string | null {
  try {
    if (!existsSync(FAILED_DUMP_DIR)) mkdirSync(FAILED_DUMP_DIR, { recursive: true });
    const file = join(FAILED_DUMP_DIR, `${Date.now()}-${label}.txt`);
    writeFileSync(file, raw);
    return file;
  } catch { return null; }
}

function firstJSONStart(s: string): number {
  const firstBrace = s.indexOf('{');
  const firstBracket = s.indexOf('[');
  if (firstBrace === -1) return firstBracket;
  if (firstBracket === -1) return firstBrace;
  return Math.min(firstBrace, firstBracket);
}

function lineAt(s: string, offset: number): string {
  const start = Math.max(0, s.lastIndexOf('\n', Math.max(0, offset - 1)) + 1);
  const end = s.indexOf('\n', offset);
  return s.slice(start, end === -1 ? s.length : end);
}

function describeSyntaxContext(text: string, err: unknown): string {
  const pos = extractErrPos(err);
  if (!pos) return `parser=${String(err).slice(0, 180)}`;
  const offset = lineColToOffset(text, pos.line, pos.col);
  const found = offset < text.length ? JSON.stringify(text[offset]) : '<eof>';
  const line = lineAt(text, offset);
  const pointer = `${' '.repeat(Math.max(0, pos.col - 1))}^`;
  return `parser=${String(err).slice(0, 180)}; offending=${found}; line=${pos.line}; col=${pos.col}\n${line}\n${pointer}`;
}

function describeLLMJSONFailure(raw: string, err: unknown, repairedText: string): string {
  const trimmed = raw.trim();
  const rawStart = firstJSONStart(trimmed);
  const reasons: string[] = [];
  if (!trimmed) reasons.push('empty response');
  if (/^```(?:json)?\s*$/i.test(trimmed)) reasons.push('unterminated markdown fence with no JSON body');
  if (/^```/i.test(trimmed) && !/```\s*$/i.test(trimmed.replace(/^```(?:json)?\s*/i, ''))) reasons.push('unterminated markdown fence');
  if (rawStart === -1 && trimmed) reasons.push('no JSON object/array opener found; response is prose or a fragment');
  if (rawStart > 0) reasons.push(`non-JSON prefix before first JSON opener (${rawStart} chars)`);
  if (trimmed && /[*_]{2}[^*_]+[*_]{2}:/.test(trimmed)) reasons.push('markdown dialogue/prose detected outside JSON');
  const context = describeSyntaxContext(repairedText || trimmed, err);
  return `${reasons.length ? reasons.join('; ') : 'JSON-like response could not be repaired'}; rawLength=${raw.length}; cleanedLength=${repairedText.length}\n${context}`;
}

function stripThinkBlocks(text: string): string {
  // Remove complete <think>...</think> blocks (including multiline).
  // Reasoning models (DeepSeek, Qwen, etc.) emit these before JSON output.
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  // Remove truncated <think> blocks with no closing tag (response cut off mid-thinking).
  // Look ahead: if <think> is followed by prose with no JSON opener and no </think>, drop it all.
  const thinkOpen = /<think>/gi;
  let m: RegExpExecArray | null;
  while ((m = thinkOpen.exec(text)) !== null) {
    const afterTag = text.slice(m.index + 7);
    const closeIdx = afterTag.indexOf('</think>');
    if (closeIdx !== -1) continue; // has closing tag, already handled above
    // No closing tag — check if there's any JSON opener after the <think>
    const afterThink = afterTag;
    const jsonBrace = afterThink.indexOf('{');
    const jsonBracket = afterThink.indexOf('[');
    const jsonStart = jsonBrace === -1 ? jsonBracket : jsonBracket === -1 ? jsonBrace : Math.min(jsonBrace, jsonBracket);
    if (jsonStart === -1) {
      // No JSON at all — the entire response is thinking. Discard everything from <think> on.
      text = text.slice(0, m.index).trim();
      break;
    }
    // JSON follows the truncated thinking block — drop the <think> and prose before the JSON.
    text = text.slice(0, m.index) + afterThink.slice(jsonStart);
    break;
  }
  return text;
}

function parseLLMJSON<T = any>(raw: string): T {
  let text = raw;

  // Strip <think> blocks BEFORE any other processing — reasoning models emit these
  // and they can consume the entire token budget, leaving no JSON.
  text = stripThinkBlocks(text);

  // Strip common reasoning-model meta-commentary that wraps or replaces JSON output
  text = text.replace(/^[\s\S]*?(?=[\[{])/s, (match) => {
    // Only strip if there's actual JSON ahead; preserve if the match is the whole string
    return match.length < text.length ? '' : match;
  });

  // PATCH: extract JSON from code fence first (handles prose-wrapped responses where
  // the model writes preamble + markdown + ```json {...} ``` block at the end)
  const __fenceMatch = text.match(/```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n\s*```/);
  if (__fenceMatch) { text = __fenceMatch[1].trim(); }
  // Strip markdown fences (full-string fenced case)
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Find the actual JSON object/array
  let firstBrace = text.indexOf('{');
  let firstBracket = text.indexOf('[');
  let start = firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);
  if (start === -1) {
    // Last resort: the LLM produced YAML-like key: value reasoning instead of JSON.
    // Try to wrap it into a JSON object by extracting quoted-key or bare-key lines.
    const kvLines = text.match(/^\s*-?\s*"?(\w[\w ]*)"?\s*:\s*(.+)/gm);
    if (kvLines && kvLines.length >= 2) {
      const pairs: string[] = [];
      for (const line of kvLines) {
        const m = line.match(/^\s*-?\s*"?(\w[\w ]*)"?\s*:\s*(.+)/);
        if (!m) continue;
        const key = m[1].trim();
        let val = m[2].trim().replace(/,\s*$/, '');
        // Wrap bare values that aren't already JSON primitives
        if (!/^(".*"|true|false|null|-?\d+(\.\d+)?|\[.*\]|\{.*\})$/i.test(val)) {
          val = JSON.stringify(val);
        }
        pairs.push(`${JSON.stringify(key)}: ${val}`);
      }
      if (pairs.length >= 2) {
        const synthetic = `{${pairs.join(', ')}}`;
        if (DEBUG_LLM_JSON) console.warn(`[llmJSON] No JSON opener found; built synthetic object from ${pairs.length} key-value pairs`);
        text = synthetic;
        firstBrace = 0;
        firstBracket = -1;
        start = 0;
      }
    }
    if (start === -1) {
      const cleanedLen = text.replace(/\s/g, '').length;
      if (DEBUG_LLM_JSON) console.warn(`[llmJSON] Syntax detail: no JSON object/array opener found; response is prose or a fragment; rawLength=${raw.length}; cleanedLength=${cleanedLen}`);
      throw new SyntaxError(`No JSON object or array found in LLM response (${raw.length} chars of prose/reasoning)`);
    }
  }
  if (start > 0) text = text.slice(start);

  // Find matching end
  const opener = text[0];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0; let inString = false; let escape = false; let end = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === opener) depth++;
    if (c === closer) { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  text = text.slice(0, end);

  // Fix trailing commas before } or ]
  text = text.replace(/,\s*([\]}])/g, '$1');

  // Remove JS-style comments
  text = text.replace(/\/\/.*$/gm, '');
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');

  // Remove control characters except whitespace
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  // Escape bare newlines/carriage-returns inside JSON strings — a common LLM output issue
  text = escapeBareNewlines(text);

  try {
    return JSON5.parse(text) as T;
  } catch (firstErr) {
    if (DEBUG_LLM_JSON) console.warn('[llmJSON] Parse failed at:', String(firstErr).slice(0, 120));

    // Strip LLM annotation patterns that break JSON
    let cleaned = text
      .replace(/:\s*(\d+(?:\.\d+)?)\s*\([^)]*\)/g, ': $1')
      .replace(/:\s*(\d+(?:\.\d+)?)\s*[–—][^,}\]"\n]*/g, ': $1')
      .replace(/,\s*\([^)]*\)/g, '')
      .replace(/\/\/[^\n"]*/g, '');

    try {
      return JSON5.parse(cleaned) as T;
    } catch (secondErr) {
      // Surgical repair: drop the exact offending character JSON5 points at, retry.
      // This handles stray `]`, `}`, etc. that the LLM occasionally emits mid-document.
      if (DEBUG_LLM_JSON) console.warn('[llmJSON] Attempting surgical repair...', String(secondErr).slice(0, 120));
      const surg = surgicalRepair<T>(cleaned);
      if (surg.ok) {
        if (DEBUG_LLM_JSON) console.log('[llmJSON] Surgical repair succeeded');
        return surg.value;
      }
      const failedSurg = surg as { ok: false; err: unknown; text: string };

      // Truncation repair: close all unclosed brackets/braces
      if (DEBUG_LLM_JSON) console.warn('[llmJSON] Attempting truncation repair...');
      let working = failedSurg.text;
      let opens = 0, arrs = 0, inStr2 = false, esc2 = false, stringStart = -1;
      for (let i = 0; i < working.length; i++) {
        const ch = working[i];
        if (esc2) { esc2 = false; continue; }
        if (ch === '\\') { esc2 = true; continue; }
        if (ch === '"') {
          inStr2 = !inStr2;
          stringStart = inStr2 ? i : -1;
          continue;
        }
        if (inStr2) continue;
        if (ch === '{') opens++;
        if (ch === '}') opens--;
        if (ch === '[') arrs++;
        if (ch === ']') arrs--;
      }

      // If generation stopped inside a string value, remove that half-written property.
      if (inStr2 && stringStart > -1) {
        const propStart = Math.max(
          working.lastIndexOf(',', stringStart),
          working.lastIndexOf('{', stringStart),
          working.lastIndexOf('[', stringStart),
        );
        if (propStart > -1) {
          working = working.slice(0, working[propStart] === ',' ? propStart : propStart + 1);
        }
      }

      // Remove trailing incomplete key/value
      working = working.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"{}[\]]*$/s, '');
      working = working.replace(/,\s*$/s, '');

      const bracketStack: string[] = [];
      inStr2 = false; esc2 = false;
      for (const ch of working) {
        if (esc2) { esc2 = false; continue; }
        if (ch === '\\') { esc2 = true; continue; }
        if (ch === '"') { inStr2 = !inStr2; continue; }
        if (inStr2) continue;
        if (ch === '{' || ch === '[') bracketStack.push(ch);
        if (ch === '}' || ch === ']') bracketStack.pop();
      }

      // Close open brackets in reverse nesting order
      while (bracketStack.length > 0) {
        const opener = bracketStack.pop()!;
        working += opener === '{' ? '}' : ']';
      }
      working = working.replace(/,\s*([\]}])/g, '$1');

      try {
        const result = JSON5.parse(working) as T;
        if (DEBUG_LLM_JSON) console.log('[llmJSON] Truncation repair succeeded');
        return result;
      } catch {
        // Final attempt: surgical pass over the truncation-repaired text.
        const finalSurg = surgicalRepair<T>(working);
        if (finalSurg.ok) {
          if (DEBUG_LLM_JSON) console.log('[llmJSON] Surgical-after-truncation repair succeeded');
          return finalSurg.value;
        }
        const failedFinalSurg = finalSurg as { ok: false; err: unknown; text: string };
        const dumped = dumpFailedPayload(raw, 'parseLLMJSON');
        console.error('[llmJSON] All repairs failed. Last 200:', failedFinalSurg.text.slice(-200));
        console.error('[llmJSON] Syntax detail:', describeLLMJSONFailure(raw, failedFinalSurg.err, failedFinalSurg.text));
        if (dumped) console.error('[llmJSON] Raw payload dumped to', dumped);
        throw failedFinalSurg.err;
      }
    }
  }
}


// Walks the raw LLM JSON text and replaces literal \n / \r inside string literals
// with their escaped equivalents. Properly tracks escape sequences so \" is not
// mistaken for a string boundary.
function escapeBareNewlines(src: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of src) {
    if (esc) { esc = false; out += ch; continue; }
    if (ch === '\\') { esc = true; out += ch; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && ch === '\n') { out += '\\n'; continue; }
    if (inStr && ch === '\r') { out += '\\r'; continue; }
    out += ch;
  }
  return out;
}
