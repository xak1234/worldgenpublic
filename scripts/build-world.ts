#!/usr/bin/env node
/**
 * build-world.ts — standalone, hardened world builder.
 *
 * What it is:
 *   A separate CLI pipeline that builds a complete WorldDNA file outside the
 *   running server. Each phase is retried with backoff and checkpointed to
 *   disk after success, so a crash mid-build can be resumed instead of
 *   restarted. After all phases complete, the world is run through the same
 *   validateAndRepairWorld + validateAndRepairTimeline functions the main
 *   generator uses, then written atomically to data/world-{id}.json so the
 *   running app picks it up automatically.
 *
 * What it isn't:
 *   This does NOT call generateWorld() in src/worldGenerator.ts because that
 *   function has a hardcoded 12-NPC cap and a single-shot phase pipeline with
 *   no resume capability. This script orchestrates the same phases
 *   independently with explicit, configurable scale.
 *
 * Usage:
 *   npx tsx scripts/build-world.ts --concept "1980s working-class Leeds estate" \
 *       --npcs 50 --batch-size 2 --locations 18 \
 *       --provider anthropic --model claude-opus-4-7
 *
 *   # Resume a crashed build:
 *   npx tsx scripts/build-world.ts --resume <buildId>
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  validateAndRepairWorld,
  validateAndRepairTimeline,
} from '../src/worldGenerator.js';
import type {
  WorldDNA, WorldLocation, WorldNPC, TimelineEvent,
  NarrativeStyle, SimulationRules, TimeOfDaySystem,
} from '../src/types.js';
import type { PopulationBlueprint } from '../src/populationPlanner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-4o',
  'openai-compat': 'gpt-4o',
  ollama: 'llama3',
  deepseek: 'deepseek-v4-flash',
  // Cerebras: OpenAI-compatible fast production endpoint.
  cerebras: 'gpt-oss-120b',
};
const VALID_PROVIDERS = new Set(Object.keys(PROVIDER_DEFAULT_MODELS));

// ────────────────────────────────────────────────────────────────────────────
// CLI args
// ────────────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    concept:           { type: 'string' },
    npcs:              { type: 'string', default: '40' },
    'batch-size':      { type: 'string', default: '2' },
    locations:         { type: 'string', default: '14' },
    'timeline-events': { type: 'string', default: '8' },
    provider:          { type: 'string', default: 'anthropic' },
    model:             { type: 'string' },
    'api-key':         { type: 'string' },
    'base-url':        { type: 'string' },
    output:            { type: 'string', default: join(REPO_ROOT, 'data') },
    id:                { type: 'string' },
    resume:            { type: 'string' },
    retries:           { type: 'string', default: '3' },
    verbose:           { type: 'boolean', default: false },
    help:              { type: 'boolean', default: false },
    'source-file':     { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(`build-world.ts — standalone hardened world builder

Required:
  --concept "<text>"     The world concept (skip when using --resume).

Scale:
  --npcs <N>             Total NPC count (default 40, no upper cap).
  --batch-size <N>       NPCs per LLM call (default 2; recommend 1-3).
  --locations <N>        Number of locations (default 14).
  --timeline-events <N>  Number of timeline events (default 8).

LLM:
  --provider anthropic|openai|openai-compat|gemini|ollama  (default anthropic)
  --model <name>                (default per provider: claude-opus-4-7, gpt-4o, gemini-2.5-flash, llama3)
  --api-key <key>               (else: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OLLAMA_API_KEY env)
  --base-url <url>              For openai-compat or ollama (e.g. http://host:11434).

Reliability:
  --retries <N>          Retries per phase (default 3).
  --resume <buildId>     Continue an aborted build from its last checkpoint.
  --id <buildId>         Explicit build/world id for a new build.

Output:
  --output <dir>         Where to write world-{id}.json (default: ../data).
  --verbose              Log full LLM responses on parse failures.
`);
  process.exit(0);
}

function parseIntStrict(v: string, name: string): number {
  if (!/^\d+$/.test(v)) {
    console.error(`Invalid --${name}: ${v}`);
    process.exit(1);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Invalid --${name}: ${v}`);
    process.exit(1);
  }
  return n;
}

const concept    = values.concept;
const buildId    = values.resume ?? values.id ?? randomUUID();
const provider   = values.provider!;
const npcCount   = parseIntStrict(values.npcs!, 'npcs');
const batchSize  = parseIntStrict(values['batch-size']!, 'batch-size');
const locCount   = parseIntStrict(values.locations!, 'locations');
const tlCount    = parseIntStrict(values['timeline-events']!, 'timeline-events');
const retryLimit = parseIntStrict(values.retries!, 'retries');
const outputDir  = resolve(values.output!);

const SOURCE_PROMPT_CHARS = 60_000;

function sourceStoryArcExcerpt(fullText: string, maxChars: number): { text: string; excerpted: boolean } {
  if (fullText.length <= maxChars) return { text: fullText, excerpted: false };
  const markerBudget = 900;
  const segment = Math.max(1000, Math.floor((maxChars - markerBudget) / 3));
  const middleStart = Math.max(0, Math.floor((fullText.length - segment) / 2));
  const tailStart = Math.max(0, fullText.length - segment);
  const text = [
    `[SOURCE EXCERPT: BEGINNING chars 1-${segment}]`,
    fullText.slice(0, segment),
    `[SOURCE EXCERPT: MIDDLE chars ${middleStart + 1}-${middleStart + segment}]`,
    fullText.slice(middleStart, middleStart + segment),
    `[SOURCE EXCERPT: ENDING / OUTCOME chars ${tailStart + 1}-${fullText.length}]`,
    fullText.slice(tailStart),
  ].join('\n\n');
  return { text: text.slice(0, maxChars), excerpted: true };
}

const SOURCE_LOAD = ((): { text: string; originalChars: number; excerpted: boolean } => {
  const sf = values['source-file'];
  if (!sf) return { text: '', originalChars: 0, excerpted: false };
  try {
    const raw = readFileSync(resolve(sf), 'utf8');
    const normalized = raw.split(/\s+/).join(' ').trim();
    const retained = sourceStoryArcExcerpt(normalized, SOURCE_PROMPT_CHARS);
    return { ...retained, originalChars: normalized.length };
  } catch { return { text: '', originalChars: 0, excerpted: false }; }
})();
const SOURCE_TEXT = SOURCE_LOAD.text;

// Parse a structured digest's CHARACTERS section into a canonical roster the NPC phase
// can use VERBATIM. Format (from src/sourceDigest.ts):
//   CHARACTERS:
//   - <full name> (<role/actor>): <one-paragraph arc>
//   - <full name> (<role>): <arc>
//   ...
//   LOCATIONS:
// Returns [] when the source isn't a structured digest (regular novel/script text).
interface CanonicalCharacter { name: string; role: string; arc: string; }
const CANONICAL_ROSTER: CanonicalCharacter[] = ((): CanonicalCharacter[] => {
  if (!SOURCE_TEXT) return [];
  const charsMatch = SOURCE_TEXT.match(/CHARACTERS:\s*([\s\S]*?)(?=\s+(?:LOCATIONS|PLOT|THEMES|TONE|ENDING)\s*:)/i);
  if (!charsMatch) return [];
  const block = charsMatch[1];
  const out: CanonicalCharacter[] = [];
  // Each entry: "- Name (role): arc" on one logical line. The whitespace-flattening in SOURCE_TEXT
  // collapses newlines, so we split on "- " (with a preceding space, to avoid mid-sentence dashes).
  const entries = block.split(/(?:^|\s)-\s+(?=[A-Z])/).map(s => s.trim()).filter(s => s.length > 8);
  for (const entry of entries) {
    const m = entry.match(/^([A-Z][^():]{1,60}?)\s*(?:\(([^)]+)\))?\s*:\s*(.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const role = (m[2] ?? '').trim();
    const arc = m[3].trim().slice(0, 600);
    if (name.length < 2 || name.length > 60) continue;
    out.push({ name, role, arc });
  }
  return out.slice(0, 40); // cap at 40 canonical characters; rest can be invented
})();

// Parse the digest's LOCATIONS: section into a canonical locations list.
// Format (from src/sourceDigest.ts):
//   LOCATIONS:
//   - <location name>: <one-sentence description grounded in actual scenes>
//   ...
//   PLOT (chronological...):
interface CanonicalLocation { name: string; description: string; }
const CANONICAL_LOCATIONS: CanonicalLocation[] = ((): CanonicalLocation[] => {
  if (!SOURCE_TEXT) return [];
  const locMatch = SOURCE_TEXT.match(/LOCATIONS:\s*([\s\S]*?)(?=\s+(?:PLOT|THEMES|TONE|ENDING|CHARACTERS)\s*:)/i);
  if (!locMatch) return [];
  const block = locMatch[1];
  const out: CanonicalLocation[] = [];
  const entries = block.split(/(?:^|\s)-\s+(?=[A-Z])/).map(s => s.trim()).filter(s => s.length > 8);
  for (const entry of entries) {
    const m = entry.match(/^([A-Z][^:]{1,80}?)\s*:\s*(.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const description = m[2].trim().slice(0, 400);
    if (name.length < 2 || name.length > 80) continue;
    out.push({ name, description });
  }
  return out.slice(0, 30); // cap at 30 canonical locations
})();

const SOURCE_DIRECTIVE = SOURCE_TEXT
  ? `

SOURCE MATERIAL (AUTHORITATIVE - this build's era, geography, factions, character names, locations, dates, events, slang and tone MUST come from this text VERBATIM. The LLM's prior knowledge or creative inclinations DO NOT override this source. Use the EXACT names that appear in the source - do NOT substitute, paraphrase, or invent variant names. Only invent content for structural gaps the source genuinely does not cover (e.g. minor walk-on NPCs when requested count exceeds source roster). Never contradict the source.):
"""
` + SOURCE_TEXT + `
"""`
  : '';
if (SOURCE_TEXT) {
  console.log(`[source] Source material loaded: ${SOURCE_TEXT.length}/${SOURCE_LOAD.originalChars} chars${SOURCE_LOAD.excerpted ? ' (beginning/middle/ending retained)' : ''} - grounding every LLM phase from this text`);
  if (CANONICAL_ROSTER.length > 0) {
    console.log(`[source] Canonical roster parsed: ${CANONICAL_ROSTER.length} characters (${CANONICAL_ROSTER.slice(0, 6).map(c => c.name).join(', ')}${CANONICAL_ROSTER.length > 6 ? `, +${CANONICAL_ROSTER.length - 6} more` : ''}) - NPCs will be drawn from this roster verbatim`);
  } else {
    console.log(`[source] No CHARACTERS: section parseable - NPC phase will rely on ambient SOURCE_DIRECTIVE only`);
  }
  if (CANONICAL_LOCATIONS.length > 0) {
    console.log(`[source] Canonical locations parsed: ${CANONICAL_LOCATIONS.length} places (${CANONICAL_LOCATIONS.slice(0, 5).map(l => l.name).join(', ')}${CANONICAL_LOCATIONS.length > 5 ? `, +${CANONICAL_LOCATIONS.length - 5} more` : ''}) - locations will be drawn from this list verbatim`);
  } else {
    console.log(`[source] No LOCATIONS: section parseable - locations phase will rely on ambient SOURCE_DIRECTIVE only`);
  }
} else if (values['source-file']) {
  console.log(`[source] WARN: --source-file ${values['source-file']} provided but extracted 0 chars (scanned PDF? bad path?) - falling back to pure LLM`);
}

if (!VALID_PROVIDERS.has(provider)) {
  console.error(`Unknown provider: ${provider} (use ${Array.from(VALID_PROVIDERS).join(', ')})`);
  process.exit(1);
}

if (!/^[a-zA-Z0-9_-]{1,128}$/.test(buildId)) {
  console.error(`Invalid build id: ${buildId}`);
  process.exit(1);
}

if (!values.resume && !concept) {
  console.error('Error: --concept is required (or use --resume <buildId>).');
  console.error('Run with --help for full options.');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────────
// LLM client — Anthropic native + OpenAI-compatible fallback
// ────────────────────────────────────────────────────────────────────────────
interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}

async function callLlm(req: LlmRequest): Promise<string> {
  if (SOURCE_DIRECTIVE) req = { ...req, system: req.system + SOURCE_DIRECTIVE };
  const provider = values.provider!;
  if (provider === 'anthropic') return callAnthropic(req);
  if (provider === 'openai' || provider === 'openai-compat') {
    return callOpenAi(req);
  }
  if (provider === 'ollama') {
    return callOllama(req);
  }
  if (provider === 'gemini') {
    return callGemini(req);
  }
  if (provider === 'deepseek') {
    return callDeepseek(req);
  }
  if (provider === 'cerebras') {
    return callCerebras(req);
  }
  throw new Error(`Unknown provider: ${provider} (use ${Array.from(VALID_PROVIDERS).join(', ')})`);
}

async function callDeepseek(req: LlmRequest): Promise<string> {
  const apiKey = values['api-key'] || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DeepSeek provider requires DEEPSEEK_API_KEY env var');
  const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '').replace(/\/v1$/i, '');
  const model = values.model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${errBody.slice(0, 600)}`);
  }
  const data: any = await res.json();
  const txt = String(data?.choices?.[0]?.message?.content ?? '');
  if (!txt.trim()) throw new Error('Empty DeepSeek response');
  return txt;
}

async function callCerebras(req: LlmRequest): Promise<string> {
  const apiKey = values['api-key'] || process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error('Cerebras provider requires CEREBRAS_API_KEY env var');
  const baseUrl = (process.env.CEREBRAS_BASE_URL ?? 'https://api.cerebras.ai').replace(/\/+$/, '');
  const model = values.model || process.env.CEREBRAS_MODEL || 'gpt-oss-120b';
  // Cerebras is OpenAI-compatible. Their inference is dramatically faster than
  // DeepSeek/Anthropic for the same context size, but its context window is smaller.
  // Long sources are reduced to beginning/middle/ending excerpts so endings are not lost.
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Cerebras API error ${res.status}: ${errBody.slice(0, 600)}`);
  }
  const data: any = await res.json();
  const txt = String(data?.choices?.[0]?.message?.content ?? '');
  if (!txt.trim()) throw new Error('Empty Cerebras response');
  return txt;
}

async function callAnthropic(req: LlmRequest): Promise<string> {
  const apiKey = values['api-key'] || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Anthropic provider requires --api-key or ANTHROPIC_API_KEY env var');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: values.model || 'claude-opus-4-7',
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errBody.slice(0, 800)}`);
  }
  const data: any = await res.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('');
}

async function callOpenAi(req: LlmRequest): Promise<string> {
  const baseUrl = values['base-url'] ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com';
  const apiKey  = values['api-key'] || process.env.OPENAI_API_KEY || 'none';
  const res = await fetch(`${baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: values.model || 'gpt-4o',
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user',   content: req.user },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI-compat ${res.status}: ${errBody.slice(0, 800)}`);
  }
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

// ────────────────────────────────────────────────────────────────────────────
// Text sanitization — replace problematic Unicode with safe ASCII equivalents
// so worlds never display diamonds/question marks in any environment.
// ────────────────────────────────────────────────────────────────────────────
function sanitizeText(s: string): string {
  return s
    .replace(/[‘’‚‹›]/g, "'")
    .replace(/[“”„«»]/g, '"')
    .replace(/[–—―]/g, '-')
    .replace(/…/g, '...')
    .replace(/™/g, 'TM')
    .replace(/©/g, '(c)')
    .replace(/®/g, '(R)')
    .replace(/°/g, ' degrees ')
    .replace(/ /g, ' ')
    .replace(/​/g, '')
    .replace(/[ - ]/g, ' ')
    .replace(/﻿/g, '');
}

function sanitizeDeep(obj: any): any {
  if (typeof obj === 'string') return sanitizeText(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeDeep);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) out[k] = sanitizeDeep(v);
    return out;
  }
  return obj;
}

// ────────────────────────────────────────────────────────────────────────────
// Hardened JSON parsing — handles markdown fences, trailing prose,
// truncation, unbalanced brackets, trailing commas, control chars.
// ────────────────────────────────────────────────────────────────────────────
function parseJsonHard(raw: string): any {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('LLM returned empty content');
  }
  let text = raw.trim();
  // Strip markdown fences (with or without language tag).
  text = text.replace(/^```(?:json|JSON)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  // Strip leading prose before the first { or [.
  const firstBrace = Math.min(
    ...['{', '['].map(c => { const i = text.indexOf(c); return i === -1 ? Infinity : i; })
  );
  if (Number.isFinite(firstBrace) && firstBrace > 0) text = text.slice(firstBrace);
  // 1. Clean parse.
  try { return JSON.parse(text); } catch {}
  // 2. Trim any trailing prose to the last balanced close.
  const lastClose = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (lastClose > 0) {
    const candidate = text.slice(0, lastClose + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  // 3. Strip trailing commas.
  const noTrailing = text.replace(/,(\s*[\}\]])/g, '$1');
  try { return JSON.parse(noTrailing); } catch {}
  // 4. Balance brackets and try again.
  const balanced = balanceBrackets(noTrailing);
  if (balanced !== noTrailing) {
    try { return JSON.parse(balanced); } catch {}
  }
  // 5. Strip control characters that break JSON (except newline/tab).
  const noControl = balanced.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  if (noControl !== balanced) {
    try { return JSON.parse(noControl); } catch {}
  }
  // 6. Try sanitizing Unicode before parse (smart quotes etc. inside strings).
  const sanitized = sanitizeText(noControl);
  try { return JSON.parse(sanitized); } catch {}
  // 7. Last resort: strip all non-ASCII and retry.
  const asciiOnly = noControl.replace(/[^\x20-\x7E\n\r\t]/g, '');
  try { return JSON.parse(asciiOnly); } catch {}
  if (values.verbose) {
    console.error('--- raw LLM response (parse failed) ---');
    console.error(raw.slice(0, 4000));
    console.error('--- end ---');
  }
  throw new Error(`Could not parse JSON. First 300 chars: ${text.slice(0, 300)}`);
}

function balanceBrackets(s: string): string {
  let openCurly = 0, openSquare = 0, inStr = false, esc = false;
  for (const c of s) {
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') openCurly++;
    else if (c === '}') openCurly--;
    else if (c === '[') openSquare++;
    else if (c === ']') openSquare--;
  }
  return s + ']'.repeat(Math.max(0, openSquare)) + '}'.repeat(Math.max(0, openCurly));
}

async function callJson<T = any>(req: LlmRequest): Promise<T> {
  const raw = await callLlm(req);
  const parsed = parseJsonHard(raw);
  return sanitizeDeep(parsed) as T;
}

function unwrapArray<T>(value: any, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    for (const k of keys) {
      if (Array.isArray(value[k])) return value[k] as T[];
    }
  }
  return [];
}

function shorten(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

// ────────────────────────────────────────────────────────────────────────────
// Phase runner — retries with backoff, logs timing.
// ────────────────────────────────────────────────────────────────────────────
async function runPhase<T>(name: string, fn: () => Promise<T>, extraRetries = 0): Promise<T> {
  const maxAttempts = retryLimit + extraRetries;
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = Date.now();
    try {
      const result = await fn();
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ✓ ${name} (${dt}s)`);
      return result;
    } catch (err: any) {
      lastErr = err;
      console.error(`  ✗ ${name} attempt ${attempt}/${maxAttempts}: ${shorten(err?.message ?? String(err))}`);
      if (attempt < maxAttempts) {
        const sleepMs = Math.min(2000 * attempt, 10000);
        console.log(`    backing off ${sleepMs / 1000}s...`);
        await new Promise(r => setTimeout(r, sleepMs));
      }
    }
  }
  throw new Error(`${name} failed after ${maxAttempts} attempts: ${shorten(lastErr?.message ?? 'unknown')}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Checkpoint store — saved after every successful phase / NPC batch so an
// aborted build can be resumed via --resume <buildId> without redoing work.
// ────────────────────────────────────────────────────────────────────────────
const CHECKPOINT_DIR = join(outputDir, '.build-checkpoints');
if (!existsSync(CHECKPOINT_DIR)) mkdirSync(CHECKPOINT_DIR, { recursive: true });
const CHECKPOINT_PATH = join(CHECKPOINT_DIR, `${buildId}.json`);

interface BuildState {
  buildId: string;
  concept: string;
  config: { npcCount: number; batchSize: number; locCount: number; tlCount: number };
  startedAt: string;
  provider: string;
  model: string;
  phases: {
    foundation?: any;
    locations?: WorldLocation[];
    blueprint?: PopulationBlueprint;
    npcs?: WorldNPC[];
    timeline?: TimelineEvent[];
    narrative?: NarrativeStyle;
    simRules?: SimulationRules;
    timeOfDay?: TimeOfDaySystem;
  };
}

function loadState(): BuildState {
  if (existsSync(CHECKPOINT_PATH)) {
    const s: BuildState = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
    if (values.resume && !s.concept) throw new Error(`Checkpoint ${buildId} is malformed`);
    return s;
  }
  if (values.resume) {
    throw new Error(`No checkpoint found for buildId ${buildId} (looked at ${CHECKPOINT_PATH})`);
  }
  return {
    buildId,
    concept: concept!,
    config: { npcCount, batchSize, locCount, tlCount },
    startedAt: new Date().toISOString(),
    provider: values.provider!,
    model: values.model || PROVIDER_DEFAULT_MODELS[values.provider!] || PROVIDER_DEFAULT_MODELS.anthropic,
    phases: {},
  };
}

function saveState(state: BuildState): void {
  const tmp = `${CHECKPOINT_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, CHECKPOINT_PATH);
}

// ════════════════════════════════════════════════════════════════════════════
// PHASES
// ════════════════════════════════════════════════════════════════════════════

// ── Foundation: era, geography, culture, economy, law, weather, technology ──
const FOUNDATION_SYSTEM = `You are a world-building writer. Build a coherent, specific setting from the concept the user gives. Use period-correct slang and details. Avoid generic fantasy tropes unless the concept asks for them. Return ONLY a single valid JSON object — no prose, no markdown fences, no explanations.`;

function foundationUserPrompt(c: string): string {
  return `Concept: "${c}"

Return JSON with EXACTLY this shape:
{
  "era": { "period": string, "yearStart": number, "yearEnd": number, "dateFormat": string, "majorWorldEvents": string[] },
  "geography": { "region": string, "country": string, "climate": string, "terrain": string, "scale": "neighbourhood"|"city"|"region", "landmarks": string[] },
  "culture": {
    "language": string, "dialect": string,
    "slang": { "<word>": "<meaning>" },
    "greetings": string[],
    "socialClasses": [{ "name": string, "description": string, "occupations": string[], "typicalLocations": string[], "mannerisms": string }],
    "religion": string, "customs": string[], "taboos": string[],
    "music": string, "food": string[], "entertainment": string[],
    "genderRoles": string, "socialNorms": string[]
  },
  "economy": {
    "currency": string, "symbol": string, "averageDailyWage": number,
    "prices": { "<item>": number },
    "jobs": [{ "title": string, "pay": number, "hours": string, "socialClass": string, "description": string }],
    "blackMarket": string
  },
  "law": { "system": string, "enforcers": string, "corruption": number, "vices": string[], "consequences": string },
  "weather": {
    "seasons": [{ "name": string, "months": string, "tone": string, "averageTemp": string, "commonWeather": string }],
    "dominantWeather": string
  },
  "technology": { "level": string, "transport": string[], "communication": string[], "energy": string, "weapons": string, "medicine": string, "limitations": string[] }
}

Make every field specific and grounded in the concept. socialClasses: 3-5 entries. seasons: 4 entries (matching the climate). slang: 6-12 entries. prices: 8-15 everyday items.`;
}

async function runFoundation(state: BuildState): Promise<void> {
  if (state.phases.foundation) return;
  const result = await runPhase('foundation', () => callJson({
    system: FOUNDATION_SYSTEM,
    user: foundationUserPrompt(state.concept),
    maxTokens: 8000,
    temperature: 0.85,
  }));
  state.phases.foundation = result;
  saveState(state);
}

// ── Locations ──
async function runLocations(state: BuildState): Promise<void> {
  if (state.phases.locations && state.phases.locations.length > 0) return;
  const f = state.phases.foundation;
  const count = state.config.locCount;
  // Same fix pattern as NPCs: when a canonical locations list is parsed from the digest,
  // switch from INVENTION ("you are designing") to POPULATION ("use the canonical list verbatim").
  const sys = CANONICAL_LOCATIONS.length > 0
    ? `You are POPULATING a world with locations drawn from a canonical list. The list is the AUTHORITATIVE set of places for this world. You MUST use the canonical location NAMES VERBATIM (do not anglicise, shorten, swap words, or substitute). Connect them with connectedTo edges that make spatial sense. Only invent additional walk-on locations if the requested count exceeds the canonical list size. Return ONLY valid JSON.`
    : `You are designing a network of locations for the world the user describes. Each location should have a distinct purpose, mood, and clientele. Connections should make spatial sense. Return ONLY valid JSON.`;

  const canonicalLocationsBlock = CANONICAL_LOCATIONS.length > 0
    ? `\n\nCANONICAL LOCATIONS (use these names VERBATIM as the first ${CANONICAL_LOCATIONS.length} locations. Pick a sensible 'type' for each, write description+ambientDetail from the canonical description below):\n` +
      CANONICAL_LOCATIONS.map((l, i) => `${i + 1}. ${l.name} - ${l.description}`).join('\n') +
      (count > CANONICAL_LOCATIONS.length ? `\n\nThis world needs ${count} locations total; after using all ${CANONICAL_LOCATIONS.length} canonical entries above (verbatim names), invent ${count - CANONICAL_LOCATIONS.length} additional walk-on places that fit the era/region.` : '')
    : '';

  const user = `Concept: "${state.concept}"
Era: ${f.era.period} (${f.era.yearStart}-${f.era.yearEnd})
Region: ${f.geography.region}, ${f.geography.country}
Scale: ${f.geography.scale}
Social classes: ${f.culture.socialClasses.map((s: any) => s.name).join(', ')}${canonicalLocationsBlock}

Generate ${count} locations as a JSON array. Return:
{ "locations": [
  {
    "id": "snake_case_id",
    "name": string,
    "type": string,
    "description": string,
    "ambientDetail": string,
    "connectedTo": string[],
    "socialClass": string,
    "openHours": string,
    "regulars": [],
    "interactables": string[],
    "privacyLevel": "public"|"semi-private"|"private",
    "capacity": string
  }
] }

Rules:
- IDs are short snake_case unique tokens (e.g. "kings_arms_pub", "armley_market", "main_st_alley").
- connectedTo must reference other location IDs you generate in the same response — do NOT invent IDs that aren't in the list.
- regulars stays as [] in this phase (NPCs are added later).
- Mix scales: some big public spaces (markets, pubs, parks), some smaller intimate ones (flats, back rooms).
- Mix privacy levels: at least 2 private, at least 4 public.
- The graph should be connected (every location reachable from any other via connectedTo).`;

  const result = await runPhase('locations', () => callJson({
    system: sys, user, maxTokens: 16000, temperature: 0.8,
  }), 2);
  const locations = unwrapArray<WorldLocation>(result, ['locations', 'data']).slice(0, count);
  if (locations.length === 0) throw new Error('Location phase returned no locations');
  state.phases.locations = locations;
  saveState(state);
}

// ── Population blueprint ──
async function runBlueprint(state: BuildState): Promise<void> {
  if (state.phases.blueprint) return;
  const f = state.phases.foundation;
  const count = state.config.npcCount;
  const sys = `You design population demographics for a world. Return ONLY valid JSON.`;
  const user = `Concept: "${state.concept}"
Era: ${f.era.period}, Region: ${f.geography.region}, Scale: ${f.geography.scale}
Social classes already defined: ${JSON.stringify(f.culture.socialClasses.map((s: any) => ({ name: s.name, occupations: s.occupations })))}

We will generate ${count} NPCs against this blueprint. Return:
{
  "totalPopulation": ${count},
  "populationDensity": "isolated"|"sparse"|"village"|"town"|"urban"|"dense_urban",
  "communityType": string,
  "ageDistribution": [{ "range": string, "label": string, "percentage": number, "count": number, "socialRole": string }],
  "genderBalance": { "male": number, "female": number, "other": number, "notes": string },
  "ethnicComposition": [{ "name": string, "percentage": number, "context": string }],
  "classDistribution": [{ "className": string, "percentage": number, "count": number }],
  "familyStructures": string[],
  "socialCohesion": number,
  "outsiderFrequency": string,
  "newcomerReception": string,
  "occupationCategories": [{ "category": string, "percentage": number, "examples": string[] }],
  "unemploymentRate": number,
  "powerStructure": string,
  "influentialRoles": string[],
  "personalitySpread": { "introvertedPct": number, "extrovertedPct": number, "warmPct": number, "coldPct": number, "openPct": number, "guardedPct": number },
  "requiredArchetypes": string[],
  "averageRelationshipsPerPerson": number,
  "romancePresent": boolean,
  "rivalriesPresent": boolean,
  "secretsPerPerson": number,
  "reasoning": string
}

Rules:
- count fields across ageDistribution and classDistribution should sum to ~${count}.
- percentage fields within each list should sum to ~100.
- socialCohesion: 0-100. unemploymentRate: 0-1.
- Make the choices specific to the concept — don't return generic numbers.`;

  const result = await runPhase('blueprint', () => callJson({
    system: sys, user, maxTokens: 8000, temperature: 0.7,
  }), 3);
  state.phases.blueprint = result as PopulationBlueprint;
  saveState(state);
}

// ── NPCs (the big batch loop) ──
async function runNpcs(state: BuildState): Promise<void> {
  state.phases.npcs ??= [];
  const f = state.phases.foundation;
  const locations = state.phases.locations!;
  const blueprint = state.phases.blueprint!;
  const count = state.config.npcCount;
  const batchLimit = state.config.batchSize;
  // When a canonical roster is parsed from the source digest, the NPC phase is POPULATION
  // (fill the world with the known cast), not INVENTION. This switch was the bug: previously
  // the system prompt told the LLM to "create people" even when canonical characters existed
  // in the source — yielding generic Marvin Crell instead of Larry Cotton on Hellraiser etc.
  const sys = CANONICAL_ROSTER.length > 0
    ? `You are POPULATING a world with NPCs drawn from a canonical roster. The roster is the AUTHORITATIVE cast for this world. You MUST use the canonical NAMES VERBATIM (do not anglicise, shorten, swap surnames, or substitute). Each canonical NPC needs full fleshed-out detail (personality, voice, secrets, inner life) consistent with the arc described. Do NOT invent NEW names while canonical entries remain unused. Only invent additional walk-on NPCs if the requested count exceeds the canonical roster size. Return ONLY valid JSON.`
    : `You are creating people for a world. Each NPC must feel real — a specific person with their own voice, secrets, and inner life. Avoid stock fantasy archetypes. Return ONLY valid JSON.`;

  const locationIndex = locations.map(l => `${l.id}: ${l.name} (${l.type})`).join(', ');
  // Pre-format the canonical roster block once; we'll inject it into every batch's user prompt.
  const canonicalRosterBlock = CANONICAL_ROSTER.length > 0
    ? `\n\nCANONICAL ROSTER (use these names VERBATIM as the first ${CANONICAL_ROSTER.length} NPCs, in order. Each one needs full character fleshing-out from the arc summary):\n` +
      CANONICAL_ROSTER.map((c, i) => `${i + 1}. ${c.name}${c.role ? ` [${c.role}]` : ''} - ARC: ${c.arc}`).join('\n')
    : '';

  while (state.phases.npcs.length < count) {
    const remaining = count - state.phases.npcs.length;
    const thisBatchCount = Math.min(batchLimit, remaining);
    const i0 = state.phases.npcs.length;
    const phaseLabel = `npcs ${i0 + 1}-${i0 + thisBatchCount} / ${count}`;

    const existingForPrompt = state.phases.npcs.map(n => `${n.id} (${n.name}, ${n.occupation})`).join('; ') || 'none yet';

    // Determine which canonical entries are still unused (by name match against already-created NPCs).
    const usedCanonicalNames = new Set(state.phases.npcs.map(n => (n.name || '').toLowerCase().trim()));
    const remainingCanonical = CANONICAL_ROSTER.filter(c => !usedCanonicalNames.has(c.name.toLowerCase().trim()));
    const canonicalBatchBlock = remainingCanonical.length > 0
      ? `\n\nFROM THE CANONICAL ROSTER, ${remainingCanonical.length} entries are STILL UNUSED:\n` +
        remainingCanonical.slice(0, Math.max(thisBatchCount, 6)).map((c, i) => `${i + 1}. ${c.name}${c.role ? ` [${c.role}]` : ''} - ${c.arc.slice(0, 280)}`).join('\n') +
        `\n\nThis batch of ${thisBatchCount} NPCs MUST use the FIRST ${Math.min(thisBatchCount, remainingCanonical.length)} unused canonical entries above (verbatim names). If thisBatchCount > remaining canonical, fill the rest as walk-on locals.`
      : (CANONICAL_ROSTER.length > 0 ? `\n\nThe canonical roster is exhausted (${CANONICAL_ROSTER.length} canonical NPCs already created). Invent ${thisBatchCount} additional walk-on locals for this batch.` : '');

    const user = `Concept: "${state.concept}"
Era: ${f.era.period}, Culture: ${f.culture.dialect || f.culture.language}
Locations available (use these EXACT ids in homeLocationId / workLocationId / frequentedLocations): ${locationIndex}
Community: ${blueprint.communityType}; cohesion ${blueprint.socialCohesion}/100; ${blueprint.romancePresent ? 'romance present' : 'no romance threads'}; ${blueprint.rivalriesPresent ? 'rivalries present' : 'minimal rivalry'}
Already created (use these EXACT ids in relationships[].npcId — do NOT slugify their names): ${existingForPrompt}${canonicalBatchBlock}

Generate EXACTLY ${thisBatchCount} ${remainingCanonical.length > 0 ? 'NPCs from the canonical roster above (verbatim names) plus any walk-on overflow' : 'new NPCs'}. Do NOT repeat anyone above. Return:
{ "npcs": [
  {
    "id": "snake_case_id",
    "name": string,
    "age": number,
    "gender": string,
    "occupation": string,
    "physicalDescription": string,
    "personality": string,
    "voiceAnchor": string,
    "speechPatterns": string[],
    "coreConcerns": string[],
    "signature": string,
    "traits": string[],
    "secrets": string[],
    "desires": string[],
    "fears": string[],
    "opinions": { "<topic>": "<view>" },
    "backstory": string,
    "dailyRoutine": { "morning": string, "afternoon": string, "evening": string, "night": string, "weekendDifference": string },
    "homeLocationId": string,
    "workLocationId": string,
    "frequentedLocations": string[],
    "socialClass": string,
    "relationships": [{ "npcId": string, "type": string, "description": string, "strength": number }],
    "baselineMood": string,
    "temperament": string,
    "approachability": number,
    "loyaltyThreshold": number,
    "attachmentStyle": "secure"|"anxious"|"avoidant"|"disorganised",
    "processingType": "present"|"brief_reflection"|"moderate_rumination"|"heavy_rumination"|"suppression"|"dissociation",
    "primaryDefense": string,
    "selfAwarenessLevel": number,
    "coreWound": string,
    "woundTriggers": string[],
    "selfConcept": string[],
    "values": string[]
  }
] }

CRITICAL ID rules:
- relationships[].npcId MUST be one of the existing ids listed above. Never invent ids from names.
- homeLocationId / workLocationId / each frequentedLocations entry MUST be one of the location ids listed above.
- This NPC's own id is whatever you choose — short snake_case, unique, distinct from any existing id.`;

    const result = await runPhase(phaseLabel, () => callJson({
      system: sys, user, maxTokens: 16000, temperature: 0.82,
    }));
    const batch = unwrapArray<WorldNPC>(result, ['npcs', 'characters', 'people'])
      .filter(n => n && (n.name || n.id))
      .slice(0, thisBatchCount);
    if (batch.length === 0) {
      throw new Error(`Batch ${phaseLabel} returned no usable NPCs`);
    }
    // De-dupe ids against existing.
    const existingIds = new Set(state.phases.npcs.map(n => n.id));
    for (const n of batch) {
      if (!n.id || existingIds.has(n.id)) {
        n.id = `${(n.name || 'npc').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'npc'}_${Math.random().toString(36).slice(2, 6)}`;
      }
      existingIds.add(n.id);
      state.phases.npcs.push(n);
    }
    saveState(state);
  }
}

// ── Timeline ──
async function runTimeline(state: BuildState): Promise<void> {
  if (state.phases.timeline && state.phases.timeline.length > 0) return;
  const f = state.phases.foundation;
  const npcs = state.phases.npcs!;
  const locations = state.phases.locations!;
  const count = state.config.tlCount;
  const sys = `You are writing recent local history for the world. Each timeline event should reference real NPCs and locations from the lists provided. Return ONLY valid JSON.`;
  const npcIndex = npcs.map(n => `${n.id} (${n.name})`).join('; ');
  const locIndex = locations.map(l => `${l.id} (${l.name})`).join('; ');
  const user = `Concept: "${state.concept}"
Era: ${f.era.period} (${f.era.yearStart}-${f.era.yearEnd})
NPCs (use these EXACT ids — never invent ids from names): ${npcIndex}
Locations (use these EXACT ids): ${locIndex}

Generate ${count} timeline events as a JSON array:
{ "timeline": [
  {
    "id": "snake_case_id",
    "date": "YYYY-MM-DD",
    "title": string,
    "description": string,
    "type": "local"|"world"|"personal"|"seasonal"|"crisis",
    "locationId": string,
    "affectedNpcIds": string[],
    "moodShift": string,
    "publicKnowledge": boolean,
    "gossipVersion": string
  }
] }

Rules:
- affectedNpcIds entries MUST be valid NPC ids from the list above.
- locationId MUST be a valid location id from the list above.
- Dates must be within the era yearStart-yearEnd. Spread them out.
- Mix scales: at least 2 personal, at least 2 local, optionally 1-2 world or crisis events.
- gossipVersion is how the rumour mill talks about it (may distort the truth).`;

  const result = await runPhase('timeline', () => callJson({
    system: sys, user, maxTokens: 6000, temperature: 0.85,
  }));
  state.phases.timeline = unwrapArray<TimelineEvent>(result, ['timeline', 'events']).slice(0, count);
  saveState(state);
}

// ── Narrative style ──
async function runNarrative(state: BuildState): Promise<void> {
  if (state.phases.narrative) return;
  const f = state.phases.foundation;
  const sys = `You define the narrative voice that the simulation should adopt when describing this world. Return ONLY valid JSON.`;
  const user = `Concept: "${state.concept}"
Era: ${f.era.period}, Culture: ${f.culture.dialect || f.culture.language}

Return:
{
  "voice": string,
  "tense": "second"|"first"|"third",
  "toneKeywords": string[],
  "literaryInfluences": string[],
  "sampleParagraph": string,
  "forbiddenWords": string[],
  "sensoryPalette": string[]
}
toneKeywords: 5-8 short adjectives. literaryInfluences: 2-4 authors / works that capture the mood. forbiddenWords: overused generic words to avoid. sensoryPalette: recurring concrete sensory details.`;
  const result = await runPhase('narrative', () => callJson({
    system: sys, user, maxTokens: 4000, temperature: 0.7,
  }));
  state.phases.narrative = result as NarrativeStyle;
  saveState(state);
}

// ── Simulation rules ──
async function runSimRules(state: BuildState): Promise<void> {
  if (state.phases.simRules) return;
  const sys = `You define behavioural rules for how this world's simulation should play out. Return ONLY valid JSON.`;
  const user = `Concept: "${state.concept}"

Return:
{
  "gossipSpeed": number,
  "communitySize": string,
  "socialMobility": string,
  "privacyLevel": string,
  "conflictStyle": string,
  "trustCulture": string,
  "reputationMatters": boolean,
  "rumoursSpread": boolean
}
gossipSpeed: 0-1. The string fields describe behaviour qualitatively. reputationMatters and rumoursSpread should reflect the concept.`;
  const result = await runPhase('simRules', () => callJson({
    system: sys, user, maxTokens: 2000, temperature: 0.6,
  }));
  state.phases.simRules = result as SimulationRules;
  saveState(state);
}

// ── Time-of-day system ──
async function runTimeOfDay(state: BuildState): Promise<void> {
  if (state.phases.timeOfDay) return;
  const f = state.phases.foundation;
  const locations = state.phases.locations!;
  const sys = `Define how the world feels across the day. Return ONLY valid JSON.`;
  const user = `Concept: "${state.concept}". Era: ${f.era.period}.
Available location ids: ${locations.map(l => l.id).join(', ')}

Return:
{ "periods": [
  { "name": string, "hourStart": number, "hourEnd": number, "atmosphere": string, "npcActivity": string, "openLocations": string[] }
] }
5-6 periods covering the full 24 hours (e.g. dawn 5-7, morning 7-12, afternoon 12-17, evening 17-22, night 22-5). openLocations: subset of the location ids above that are open during that period.`;
  const result = await runPhase('timeOfDay', () => callJson({
    system: sys, user, maxTokens: 8000, temperature: 0.7,
  }), 3);
  state.phases.timeOfDay = result as TimeOfDaySystem;
  saveState(state);
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR
// ════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const state = loadState();

  if (values.resume) {
    // Only inherit provider/model from checkpoint when CLI did NOT pass them explicitly.
    const cliProvider = process.argv.some(a => a === '--provider' || a.startsWith('--provider='));
    const cliModel    = process.argv.some(a => a === '--model'    || a.startsWith('--model='));
    if (!cliProvider && state.provider) (values as any).provider = state.provider;
    if (!cliModel && state.model)       (values as any).model    = state.model;
  }

  console.log(`\n══ Build ${state.buildId} ══`);
  console.log(`Concept: ${state.concept}`);
  console.log(`Provider: ${state.provider} / ${state.model}`);
  console.log(`Scale: ${state.config.npcCount} NPCs, ${state.config.locCount} locations, ${state.config.tlCount} timeline events`);
  console.log(`Checkpoint: ${CHECKPOINT_PATH}`);
  if (values.resume) console.log(`(resuming — phases already done: ${Object.keys(state.phases).filter(k => state.phases[k as keyof typeof state.phases]).join(', ') || 'none'})`);
  console.log();

  const phases = [
    { name: 'Foundation', fn: () => runFoundation(state), pct: 0 },
    { name: 'Locations', fn: () => runLocations(state), pct: 15 },
    { name: 'Blueprint', fn: () => runBlueprint(state), pct: 30 },
    { name: 'NPCs', fn: () => runNpcs(state), pct: 40 },
    { name: 'Timeline', fn: () => runTimeline(state), pct: 65 },
    { name: 'Narrative', fn: () => runNarrative(state), pct: 75 },
    { name: 'SimRules', fn: () => runSimRules(state), pct: 85 },
    { name: 'TimeOfDay', fn: () => runTimeOfDay(state), pct: 92 },
  ];
  for (const phase of phases) {
    console.log(`\n[${phase.pct}%] Starting ${phase.name}...`);
    await phase.fn();
    console.log(`[${phase.pct}%] ${phase.name} complete.`);
  }

  // ── Final assembly ──
  console.log('\nAssembling world...');
  const f = state.phases.foundation;
  const dna: WorldDNA = {
    id: state.buildId,
    concept: state.concept,
    createdAt: state.startedAt,
    provider: state.provider,
    era: f.era,
    geography: f.geography,
    culture: f.culture,
    economy: f.economy,
    law: f.law,
    weather: f.weather,
    technology: f.technology,
    narrativeStyle: state.phases.narrative!,
    populationBlueprint: state.phases.blueprint!,
    locations: state.phases.locations!,
    npcs: state.phases.npcs!,
    timeline: state.phases.timeline!,
    simulationRules: state.phases.simRules!,
    timeOfDay: state.phases.timeOfDay!,
  };

  // ── Validation pass — uses the same repair functions as the main app ──
  console.log('Running validateAndRepairWorld...');
  const repaired = validateAndRepairWorld(dna.locations, dna.npcs);
  console.log('Running validateAndRepairTimeline...');
  const repairedTimeline = validateAndRepairTimeline(
    dna.timeline, repaired.npcs, repaired.locations, repaired.report,
  );
  dna.locations = repaired.locations;
  dna.npcs = repaired.npcs;
  dna.timeline = repairedTimeline;

  // ── Final sanitization pass — strip all problematic Unicode ──
  console.log('[98%] Sanitizing text (removing problematic Unicode)...');
  const cleanDna = sanitizeDeep(dna);

  // ── Atomic write ──
  console.log('[100%] Writing world file...');
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, `world-${cleanDna.id}.json`);
  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cleanDna, null, 2));
  renameSync(tmpPath, outPath);

  console.log(`\n✓ World written: ${outPath}`);
  console.log(`  ${cleanDna.npcs.length} NPCs, ${cleanDna.locations.length} locations, ${cleanDna.timeline.length} timeline events`);
  console.log(`  Repair report: ${JSON.stringify(repaired.report)}`);
  console.log(`\nBuild complete. Restart the WorldGen server (or call /api/worlds/refresh) to load it.`);
}

main().catch(err => {
  console.error('\n╳ FATAL:', err.message);
  if (err.stack && values.verbose) console.error(err.stack);
  console.error(`\nCheckpoint preserved at ${CHECKPOINT_PATH}`);
  console.error(`Resume with:  npx tsx scripts/build-world.ts --resume ${buildId}`);
  process.exit(1);
});


// Ollama-compatible provider (uses /api/chat).
async function callOllama(req: LlmRequest): Promise<string> {
  const baseUrl = values['base-url'] ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
  const apiKey  = values['api-key'] || process.env.OLLAMA_API_KEY;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: values.model || 'llama3',
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: req.system },
        { role: 'user',   content: req.user },
      ],
      options: { temperature: req.temperature, num_predict: req.maxTokens },
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Ollama ${res.status}: ${errBody.slice(0, 800)}`);
  }
  const data: any = await res.json();
  return data?.message?.content ?? '';
}

async function callGemini(req: LlmRequest): Promise<string> {
  const apiKey = values['api-key'] || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini provider requires --api-key or GEMINI_API_KEY env var');
  const model = values.model || 'gemini-2.5-flash';
  const body: any = {
    system_instruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.user }] }],
    generationConfig: {
      maxOutputTokens: req.maxTokens,
      temperature: req.temperature,
      responseMimeType: 'application/json',
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errBody.slice(0, 800)}`);
  }
  const data: any = await res.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Empty Gemini response');
  return content.trim();
}
