#!/usr/bin/env node
/**
 * enhance-world.ts — double-pass enrichment for world descriptions and atmosphere.
 *
 * Reads an existing world-{id}.json, sends descriptive fields through an LLM
 * for richer, more cinematic rewrites, then writes the enhanced version back.
 *
 * Usage:
 *   npx tsx scripts/enhance-world.ts --world <id> [--provider gemini] [--model gemini-2.5-flash]
 */

import 'dotenv/config';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const { values } = parseArgs({
  options: {
    world:    { type: 'string' },
    provider: { type: 'string', default: 'gemini' },
    model:    { type: 'string' },
    'api-key':{ type: 'string' },
    verbose:  { type: 'boolean', default: false },
  },
  strict: true,
});

if (!values.world) {
  console.error('Usage: npx tsx scripts/enhance-world.ts --world <id> [--provider gemini]');
  process.exit(1);
}

const worldPath = join(REPO_ROOT, 'data', `world-${values.world}.json`);
if (!existsSync(worldPath)) {
  console.error(`World file not found: ${worldPath}`);
  process.exit(1);
}

const world = JSON.parse(readFileSync(worldPath, 'utf8'));

// ── LLM caller (Gemini only for now, easy to extend) ──
async function callLlm(system: string, user: string, maxTokens = 8000): Promise<string> {
  if (values.provider === 'gemini') return callGemini(system, user, maxTokens);
  throw new Error(`Provider ${values.provider} not supported in enhance script yet`);
}

async function callGemini(system: string, user: string, maxTokens: number): Promise<string> {
  const apiKey = values['api-key'] || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY required');
  const model = values.model || 'gemini-2.5-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.85,
          responseMimeType: 'application/json',
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data: any = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
}

function parseJsonSafe(raw: string): any {
  let text = raw.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  try { return JSON.parse(text); } catch {}
  const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (last > 0) try { return JSON.parse(text.slice(0, last + 1)); } catch {}
  throw new Error(`JSON parse failed: ${text.slice(0, 200)}`);
}

async function callJson(system: string, user: string, maxTokens = 8000): Promise<any> {
  const raw = await callLlm(system, user, maxTokens);
  return parseJsonSafe(raw);
}

async function retryCall(label: string, fn: () => Promise<any>, retries = 3): Promise<any> {
  for (let i = 1; i <= retries; i++) {
    try {
      const result = await fn();
      console.log(`  ✓ ${label}`);
      return result;
    } catch (err: any) {
      console.error(`  ✗ ${label} attempt ${i}/${retries}: ${err.message?.slice(0, 200)}`);
      if (i < retries) await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  console.error(`  ⚠ ${label} failed all retries, keeping original`);
  return null;
}

// ── Enhancement prompts ──

const ENHANCE_SYSTEM = `You are a cinematic writer enhancing descriptions for a world set in "${world.concept}".
Location: ${world.geography?.region}, ${world.geography?.country}. Era: ${world.era?.period}.

Your job: take existing descriptions and rewrite them to be RICHER, more ATMOSPHERIC, and more SENSORY.
Think Joel Schumacher's visual style — neon-drenched boardwalks, fog rolling off the Pacific, the smell of
salt and motorcycle exhaust, saxophone riffs drifting from speakers, leather jackets and sunglasses after dark.

Rules:
- Keep the same factual content and meaning — don't change what a place IS or who a person IS
- Add sensory details: sounds, smells, textures, lighting, temperature
- Add emotional atmosphere: what it FEELS like to be there or near this person
- Keep descriptions punchy — vivid but not purple prose. 2-4 sentences max per field
- Match the 1987 California coastal vibe: sun-bleached, slightly dangerous, rock-and-roll
- Return ONLY valid JSON matching the exact schema requested`;

// ── Pass 1: Enhance locations ──
async function enhanceLocations(): Promise<void> {
  console.log('\n── Pass 1: Enhancing locations ──');
  const batchSize = 5;
  for (let i = 0; i < world.locations.length; i += batchSize) {
    const batch = world.locations.slice(i, i + batchSize);
    const label = `locations ${i + 1}-${Math.min(i + batchSize, world.locations.length)}`;

    const result = await retryCall(label, () => callJson(
      ENHANCE_SYSTEM,
      `Enhance these location descriptions. For each location, rewrite "description" and "ambientDetail" to be more vivid and atmospheric.

Input locations:
${JSON.stringify(batch.map((l: any) => ({ id: l.id, name: l.name, type: l.type, description: l.description, ambientDetail: l.ambientDetail })), null, 2)}

Return JSON: { "locations": [ { "id": "<same id>", "description": "<enhanced>", "ambientDetail": "<enhanced>" } ] }`,
      8000
    ));

    if (result?.locations) {
      for (const enhanced of result.locations) {
        const loc = world.locations.find((l: any) => l.id === enhanced.id);
        if (loc) {
          if (enhanced.description) loc.description = enhanced.description;
          if (enhanced.ambientDetail) loc.ambientDetail = enhanced.ambientDetail;
        }
      }
    }
  }
}

// ── Pass 2: Enhance NPCs ──
async function enhanceNpcs(): Promise<void> {
  console.log('\n── Pass 2: Enhancing NPCs ──');
  const batchSize = 3;
  for (let i = 0; i < world.npcs.length; i += batchSize) {
    const batch = world.npcs.slice(i, i + batchSize);
    const label = `npcs ${i + 1}-${Math.min(i + batchSize, world.npcs.length)}`;

    const result = await retryCall(label, () => callJson(
      ENHANCE_SYSTEM,
      `Enhance these NPC descriptions. For each NPC, rewrite "physicalDescription", "personality", "backstory", and "voiceAnchor" to be more vivid, cinematic, and emotionally resonant. Make each person feel like they belong in a gritty 1987 California beach town.

Input NPCs:
${JSON.stringify(batch.map((n: any) => ({
  id: n.id, name: n.name, age: n.age, occupation: n.occupation,
  physicalDescription: n.physicalDescription, personality: n.personality,
  backstory: n.backstory, voiceAnchor: n.voiceAnchor, baselineMood: n.baselineMood,
  socialClass: n.socialClass
})), null, 2)}

Return JSON: { "npcs": [ { "id": "<same id>", "physicalDescription": "<enhanced>", "personality": "<enhanced>", "backstory": "<enhanced>", "voiceAnchor": "<enhanced>" } ] }`,
      12000
    ));

    if (result?.npcs) {
      for (const enhanced of result.npcs) {
        const npc = world.npcs.find((n: any) => n.id === enhanced.id);
        if (npc) {
          if (enhanced.physicalDescription) npc.physicalDescription = enhanced.physicalDescription;
          if (enhanced.personality) npc.personality = enhanced.personality;
          if (enhanced.backstory) npc.backstory = enhanced.backstory;
          if (enhanced.voiceAnchor) npc.voiceAnchor = enhanced.voiceAnchor;
        }
      }
    }
  }
}

// ── Pass 3: Enhance timeline events ──
async function enhanceTimeline(): Promise<void> {
  console.log('\n── Pass 3: Enhancing timeline ──');
  const result = await retryCall('timeline events', () => callJson(
    ENHANCE_SYSTEM,
    `Enhance these timeline event descriptions. Rewrite "description" and "gossipVersion" to be more vivid, dramatic, and atmospheric. The gossip versions should sound like actual rumors people whisper — colorful, distorted, conspiratorial.

Input events:
${JSON.stringify(world.timeline.map((t: any) => ({
  id: t.id, title: t.title, description: t.description,
  gossipVersion: t.gossipVersion, type: t.type, moodShift: t.moodShift
})), null, 2)}

Return JSON: { "timeline": [ { "id": "<same id>", "description": "<enhanced>", "gossipVersion": "<enhanced>", "moodShift": "<enhanced>" } ] }`,
    8000
  ));

  if (result?.timeline) {
    for (const enhanced of result.timeline) {
      const event = world.timeline.find((t: any) => t.id === enhanced.id);
      if (event) {
        if (enhanced.description) event.description = enhanced.description;
        if (enhanced.gossipVersion) event.gossipVersion = enhanced.gossipVersion;
        if (enhanced.moodShift) event.moodShift = enhanced.moodShift;
      }
    }
  }
}

// ── Pass 4: Enhance narrative style ──
async function enhanceNarrative(): Promise<void> {
  console.log('\n── Pass 4: Enhancing narrative style ──');
  const result = await retryCall('narrative style', () => callJson(
    ENHANCE_SYSTEM,
    `Enhance the world's narrative style. Rewrite the "sampleParagraph" to be a stunning, cinematic piece that captures the feel of this world. Expand "sensoryPalette" with more vivid, specific sensory details. Make the "voice" description more evocative.

Current narrative style:
${JSON.stringify(world.narrativeStyle, null, 2)}

Return JSON with the same shape:
{
  "voice": "<enhanced>",
  "tense": "${world.narrativeStyle?.tense || 'second'}",
  "toneKeywords": [<keep or improve>],
  "literaryInfluences": [<keep or improve>],
  "sampleParagraph": "<rewritten, cinematic, 3-5 sentences>",
  "forbiddenWords": [<keep or improve>],
  "sensoryPalette": [<expanded to 10-15 vivid sensory details>]
}`,
    6000
  ));

  if (result) {
    if (result.voice) world.narrativeStyle.voice = result.voice;
    if (result.sampleParagraph) world.narrativeStyle.sampleParagraph = result.sampleParagraph;
    if (result.sensoryPalette?.length) world.narrativeStyle.sensoryPalette = result.sensoryPalette;
    if (result.toneKeywords?.length) world.narrativeStyle.toneKeywords = result.toneKeywords;
    if (result.forbiddenWords?.length) world.narrativeStyle.forbiddenWords = result.forbiddenWords;
  }
}

// ── Pass 5: Enhance weather/seasons atmosphere ──
async function enhanceWeather(): Promise<void> {
  console.log('\n── Pass 5: Enhancing weather atmosphere ──');
  const result = await retryCall('weather/seasons', () => callJson(
    ENHANCE_SYSTEM,
    `Enhance the weather/season descriptions. Make "tone" and "commonWeather" more atmospheric and cinematic for a 1987 California coastal town.

Current weather:
${JSON.stringify(world.weather, null, 2)}

Return JSON: { "seasons": [ { "name": "<same>", "tone": "<enhanced>", "commonWeather": "<enhanced>" } ], "dominantWeather": "<enhanced>" }`,
    4000
  ));

  if (result?.seasons) {
    for (const enhanced of result.seasons) {
      const season = world.weather.seasons.find((s: any) => s.name === enhanced.name);
      if (season) {
        if (enhanced.tone) season.tone = enhanced.tone;
        if (enhanced.commonWeather) season.commonWeather = enhanced.commonWeather;
      }
    }
    if (result.dominantWeather) world.weather.dominantWeather = result.dominantWeather;
  }
}

// ── Pass 6: Enhance time-of-day atmosphere ──
async function enhanceTimeOfDay(): Promise<void> {
  console.log('\n── Pass 6: Enhancing time-of-day atmosphere ──');
  const result = await retryCall('time-of-day', () => callJson(
    ENHANCE_SYSTEM,
    `Enhance the time-of-day period descriptions. Make "atmosphere" and "npcActivity" more vivid and cinematic.

Current time-of-day:
${JSON.stringify(world.timeOfDay, null, 2)}

Return JSON: { "periods": [ { "name": "<same>", "atmosphere": "<enhanced>", "npcActivity": "<enhanced>" } ] }`,
    4000
  ));

  if (result?.periods) {
    for (const enhanced of result.periods) {
      const period = world.timeOfDay?.periods?.find((p: any) => p.name === enhanced.name);
      if (period) {
        if (enhanced.atmosphere) period.atmosphere = enhanced.atmosphere;
        if (enhanced.npcActivity) period.npcActivity = enhanced.npcActivity;
      }
    }
  }
}

// ── Main ──
async function main(): Promise<void> {
  console.log(`\n══ Enhancing world: ${world.concept} (${values.world}) ══`);
  console.log(`Provider: ${values.provider} / ${values.model || 'gemini-2.5-flash'}`);
  console.log(`NPCs: ${world.npcs.length}, Locations: ${world.locations.length}, Timeline: ${world.timeline.length}`);

  await enhanceLocations();
  await enhanceNpcs();
  await enhanceTimeline();
  await enhanceNarrative();
  await enhanceWeather();
  await enhanceTimeOfDay();

  // Atomic write back
  const tmpPath = `${worldPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(world, null, 2));
  renameSync(tmpPath, worldPath);

  console.log(`\n✓ Enhanced world written to ${worldPath}`);
  console.log(`  All descriptions, atmospheres, and feelings have been enriched.`);
}

main().catch(err => {
  console.error('\n╳ FATAL:', err.message);
  process.exit(1);
});
