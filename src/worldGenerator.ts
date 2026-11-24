/**
 * World Generator — builds a living simulation from a player's concept.
 * No quests, no objectives. Just a world with people living their lives.
 */

import { llmJSON } from './llm.js';
import type { WorldDNA, WorldLocation, WorldNPC, TimelineEvent, DailyRoutine } from './types.js';
import { generatePopulationBlueprint, type PopulationBlueprint } from './populationPlanner.js';
import { randomUUID } from 'crypto';

export type GenerationPhase =
  | 'foundation' | 'locations' | 'population' | 'npcs' | 'timeline' | 'narrative' | 'simulation' | 'complete';

export interface GenerationProgress {
  phase: GenerationPhase;
  message: string;
  percent: number;
}

export type ProgressCallback = (progress: GenerationProgress) => void;

type LegacyNPCRelationship = WorldNPC['relationships'][number] & {
  targetNpcId?: string;
  targetId?: string;
};

/**
 * Coerce an LLM response into an array of items.
 * Handles: bare arrays, `{ key: [...] }` wrappers under the listed candidate keys,
 * any other field that holds the first array value, and the single-object case
 * (LLM returns one item as `{...}` instead of `[{...}]`).
 */
function unwrapArray<T>(raw: any, candidateKeys: string[] = []): T[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'object') return [];
  for (const key of candidateKeys) {
    const v = raw[key];
    if (Array.isArray(v)) return v as T[];
  }
  for (const v of Object.values(raw)) {
    if (Array.isArray(v)) return v as T[];
  }
  // Single-object case: the LLM returned one item directly (e.g. `{name, age, ...}`)
  // instead of `[{name, age, ...}]`. Wrap it.
  return [raw as T];
}

function sanitizeNPC(raw: any, locations: WorldLocation[]): WorldNPC {
  const firstLoc = locations[0]?.id ?? 'unknown';
  const workLoc = locations.find(l => ['workplace', 'shop', 'market', 'office', 'factory', 'workshop'].includes(l.type))?.id ?? firstLoc;
  const routine: DailyRoutine = raw.dailyRoutine && typeof raw.dailyRoutine === 'object'
    ? {
        morning: raw.dailyRoutine.morning ?? 'starts the day',
        afternoon: raw.dailyRoutine.afternoon ?? 'goes about their work',
        evening: raw.dailyRoutine.evening ?? 'winds down',
        night: raw.dailyRoutine.night ?? 'sleeps',
        weekendDifference: raw.dailyRoutine.weekendDifference ?? 'same as weekdays',
      }
    : { morning: 'starts the day', afternoon: 'goes about their work', evening: 'winds down', night: 'sleeps', weekendDifference: 'same as weekdays' };

  return {
    id: raw.id ?? `npc_${randomUUID().slice(0, 8)}`,
    name: raw.name ?? 'Unknown',
    age: raw.age ?? 30,
    gender: raw.gender ?? 'unknown',
    occupation: raw.occupation ?? 'labourer',
    physicalDescription: raw.physicalDescription ?? 'unremarkable appearance',
    personality: raw.personality ?? 'reserved',
    voiceAnchor: raw.voiceAnchor ?? 'speaks plainly',
    speechPatterns: raw.speechPatterns ?? [],
    coreConcerns: raw.coreConcerns ?? ['getting by'],
    signature: raw.signature ?? '',
    traits: raw.traits ?? ['quiet'],
    secrets: raw.secrets ?? [],
    desires: raw.desires ?? [],
    fears: raw.fears ?? [],
    opinions: raw.opinions ?? {},
    backstory: raw.backstory ?? '',
    dailyRoutine: routine,
    homeLocationId: raw.homeLocationId ?? firstLoc,
    workLocationId: raw.workLocationId ?? workLoc,
    frequentedLocations: raw.frequentedLocations ?? [],
    socialClass: raw.socialClass ?? 'working',
    relationships: raw.relationships ?? [],
    baselineMood: raw.baselineMood ?? 'neutral',
    temperament: raw.temperament ?? 'steady',
    approachability: raw.approachability ?? 50,
    loyaltyThreshold: raw.loyaltyThreshold ?? 5,
    attachmentStyle: ['secure', 'anxious', 'avoidant', 'disorganised'].includes(raw.attachmentStyle) ? raw.attachmentStyle : 'secure',
    processingType: ['present', 'brief_reflection', 'moderate_rumination', 'heavy_rumination', 'suppression', 'dissociation'].includes(raw.processingType) ? raw.processingType : 'moderate_rumination',
    primaryDefense: raw.primaryDefense ?? 'rationalization',
    selfAwarenessLevel: typeof raw.selfAwarenessLevel === 'number' ? raw.selfAwarenessLevel : 50,
    coreWound: raw.coreWound ?? '',
    woundTriggers: raw.woundTriggers ?? [],
    woundSituations: raw.woundSituations ?? [],
    additionalWounds: Array.isArray(raw.additionalWounds)
      ? raw.additionalWounds
          .filter((w: any) => w && typeof w.description === 'string')
          .map((w: any) => ({
            description: w.description,
            triggerWords: Array.isArray(w.triggerWords) ? w.triggerWords : [],
            triggerSituations: Array.isArray(w.triggerSituations) ? w.triggerSituations : [],
          }))
          .slice(0, 2)
      : [],
    selfConcept: raw.selfConcept ?? [],
    values: raw.values ?? [],
  };
}

export interface GenerationOptions {
  npcCount?: number;
  locationCount?: number;
}

export async function generateWorld(
  concept: string,
  provider: string,
  model?: string,
  onProgress?: ProgressCallback,
  options?: GenerationOptions,
): Promise<WorldDNA> {
  const worldId = randomUUID();

  // ── Phase 1: Foundation ───────────────────────────────────────────────
  onProgress?.({ phase: 'foundation', message: 'Establishing setting, culture, and social fabric…', percent: 0 });

  const foundation = await llmJSON({
    provider,
    model,
    maxTokens: 16000,
    temperature: 0.92,
    jsonMode: true,
    system: FOUNDATION_PROMPT,
    user: buildFoundationUser(concept),
  });

  // ── Phase 2: Locations ────────────────────────────────────────────────
  onProgress?.({ phase: 'locations', message: 'Building streets, buildings, and gathering places…', percent: 15 });

  const locationsRaw = await llmJSON({
    provider,
    model,
    maxTokens: (options?.locationCount ?? 10) > 15 ? 16384 : 6144,
    temperature: 0.85,
    jsonMode: true,
    system: buildLocationSystem(concept, foundation, options?.locationCount),
    user: LOCATION_USER,
  });
  const locations: WorldLocation[] = unwrapArray<WorldLocation>(locationsRaw, ['locations', 'data']);
  if (locations.length === 0) throw new Error('Location generation returned no locations');

  // ── Phase 3: Population Blueprint ──────────────────────────────────────
  onProgress?.({ phase: 'population', message: 'Deciding who lives here — demographics, classes, social fabric…', percent: 30 });

  if (!foundation.era || !foundation.geography) {
    throw new Error('Foundation generation returned invalid data: missing era or geography');
  }
  const blueprint: PopulationBlueprint = await generatePopulationBlueprint(
    concept,
    foundation.era.period ?? 'unknown era',
    foundation.geography.region ?? 'unknown region',
    foundation.culture ?? {},
    foundation.economy ?? {},
    provider,
    model,
    options?.npcCount,
  );

  // ── Phase 4: NPCs (driven by blueprint) — batched to avoid token limits ──
  const locationIndex = locations.map(l => `${l.id}: ${l.name} (${l.type})`).join(', ');

  const BATCH_SIZE = 5;
  const MAX_RETRIES = 2;
  const total = options?.npcCount ?? blueprint.totalPopulation ?? 15;
  const npcs: WorldNPC[] = [];
  onProgress?.({ phase: 'npcs', message: `Creating ${total} people with lives and routines…`, percent: 40 });

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batchCount = Math.min(BATCH_SIZE, total - i);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(total / BATCH_SIZE);
    onProgress?.({ phase: 'npcs', message: `Creating people ${i + 1}–${i + batchCount} of ${total}…`, percent: 40 + Math.round((i / total) * 20) });

    let batchSuccess = false;
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      try {
        const batchRaw = await llmJSON({
          provider,
          model,
          maxTokens: 6144,
          temperature: 0.82,
          jsonMode: true,
          system: buildNPCSystem(concept, foundation, locationIndex, blueprint),
          user: `${NPC_USER}\n\nGenerate EXACTLY ${batchCount} NPCs for batch ${batchNum} of ${totalBatches}. Already created (ID followed by name — use these EXACT IDs when referencing them in relationships): ${npcs.map(n => `${n.id} (${n.name})`).join(', ') || 'none'}. Do NOT repeat anyone already created. When this NPC has relationships with anyone above, set relationships[i].npcId to the EXACT id shown — do not invent a new id from the name.`,
        });
        const batchRawArr = unwrapArray<any>(batchRaw, ['npcs', 'characters', 'people']);
        if (batchRawArr.length === 0) {
          console.warn(`[worldgen] NPC batch ${batchNum}/${totalBatches} returned no people — retry ${retry + 1}/${MAX_RETRIES + 1}`);
          continue;
        }
        const batch = batchRawArr.filter((n: any) => n.name || n.id).map((n: any) => sanitizeNPC(n, locations));
        npcs.push(...batch);
        batchSuccess = true;
        break;
      } catch (err) {
        console.warn(`[worldgen] NPC batch ${batchNum}/${totalBatches} error (retry ${retry + 1}/${MAX_RETRIES + 1}):`, err);
      }
    }
    if (!batchSuccess) {
      console.warn(`[worldgen] NPC batch ${batchNum}/${totalBatches} failed after ${MAX_RETRIES + 1} attempts — skipping`);
    }
  }
  if (npcs.length === 0) throw new Error('NPC generation produced 0 people');
  console.log(`[worldgen] generated ${npcs.length} NPCs`);

  // ── Phase 4: Timeline ─────────────────────────────────────────────────
  onProgress?.({ phase: 'timeline', message: 'Generating community events and local history…', percent: 60 });

  const npcIndex = npcs.map(n => `${n.id}: ${n.name} (${n.occupation})`).join(', ');

  const timelineRaw = await llmJSON({
    provider,
    model,
    maxTokens: 8192,
    temperature: 0.85,
    jsonMode: true,
    system: buildTimelineSystem(concept, foundation, locationIndex, npcIndex),
    user: TIMELINE_USER,
  });
  const timeline: TimelineEvent[] = unwrapArray<TimelineEvent>(timelineRaw, ['timeline', 'events']);

  // ── Phase 5: Narrative voice ──────────────────────────────────────────
  onProgress?.({ phase: 'narrative', message: 'Calibrating narrative voice and atmosphere…', percent: 80 });

  const narrativeStyle = await llmJSON({
    provider,
    model,
    maxTokens: 4096,
    temperature: 0.9,
    jsonMode: true,
    system: buildNarrativeSystem(concept, foundation),
    user: NARRATIVE_USER,
  });

  // ── Phase 6: Simulation rules ─────────────────────────────────────────
  onProgress?.({ phase: 'simulation', message: 'Defining how the community works…', percent: 90 });

  const simulationRules = await llmJSON({
    provider,
    model,
    maxTokens: 2048,
    temperature: 0.8,
    jsonMode: true,
    system: `You define how a simulated community behaves. Setting: ${concept}. Era: ${foundation.era.period}. Culture: ${foundation.culture.language}.`,
    user: `Generate simulation rules:
{
  "gossipSpeed": number (0-1, how fast information travels),
  "communitySize": string ("tight-knit village" to "anonymous metropolis"),
  "socialMobility": string,
  "privacyLevel": string,
  "conflictStyle": string,
  "trustCulture": string (how easily strangers are accepted),
  "reputationMatters": boolean,
  "rumoursSpread": boolean
}`,
  });

  // ── Phase 7: Time of day system ───────────────────────────────────────
  const timeOfDay = await llmJSON({
    provider,
    model,
    maxTokens: 4096,
    temperature: 0.8,
    jsonMode: true,
    system: `Define how the world changes across the day. Setting: ${concept}. Era: ${foundation.era.period}.`,
    user: `Generate time periods:
{ "periods": [
  { "name": string, "hourStart": number, "hourEnd": number, "atmosphere": string, "npcActivity": string, "openLocations": string[] }
] }
Create 5-6 periods covering the full 24 hours. Each should feel different — dawn is different from midday is different from late night. Describe what the world FEELS like at each time, what people are doing, which types of places are open.`,
  });

  onProgress?.({ phase: 'complete', message: 'World ready.', percent: 100 });

  const repaired = validateAndRepairWorld(locations, npcs);
  const repairedTimeline = validateAndRepairTimeline(timeline, repaired.npcs, repaired.locations, repaired.report);

  return {
    id: worldId,
    concept,
    createdAt: new Date().toISOString(),
    provider,
    era: foundation.era,
    geography: foundation.geography,
    culture: foundation.culture,
    economy: foundation.economy,
    law: foundation.law,
    weather: foundation.weather,
    technology: foundation.technology,
    narrativeStyle,
    populationBlueprint: blueprint,
    locations: repaired.locations,
    npcs: repaired.npcs,
    timeline: repairedTimeline,
    simulationRules,
    timeOfDay,
  };
}

// ── World validation & repair ─────────────────────────────────────────────
// LLMs frequently hallucinate IDs (NPCs that work at a location that doesn't
// exist, locations that connect to non-existent rooms, etc). This pass cleans
// up dangling refs, makes the location graph reciprocal+connected, and ensures
// every NPC's home/work/frequented locations resolve.

export interface WorldRepairReport {
  droppedLocations: number;
  danglingEdgesFixed: number;
  addedReciprocalEdges: number;
  componentsLinked: number;
  syntheticLocationsAdded: number;
  npcHomeRebound: number;
  npcWorkRebound: number;
  npcFrequentedDropped: number;
  relationshipsDropped: number;
  relationshipsRemapped: number;
  timelineNpcRefsRemapped: number;
  timelineNpcRefsDropped: number;
}

/**
 * Try to resolve an orphan NPC ID to a real NPC by:
 *   1. Slug-of-name match (LLM commonly slugifies the displayed name with nicknames),
 *   2. Token-subset match (every token of a real NPC's id appears in the orphan id).
 * Returns the real id, or null if no confident remap exists.
 */
export function remapOrphanNpcId(orphanId: string, npcs: WorldNPC[]): string | null {
  if (!orphanId) return null;
  const norm = (s: string) => s
    .toLowerCase()
    .replace(/['"`’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const orphanNorm = norm(orphanId);
  // 1. Slug-of-name match.
  for (const npc of npcs) {
    if (npc.name && norm(npc.name) === orphanNorm) return npc.id;
  }
  // 2. Token-subset match — pick highest-scoring (most tokens) unique winner.
  const orphanTokens = new Set(orphanNorm.split('_').filter(Boolean));
  let best: { id: string; score: number } | null = null;
  let tieAtBest = false;
  for (const npc of npcs) {
    const realTokens = npc.id.split('_').filter(Boolean);
    if (realTokens.length === 0) continue;
    if (!realTokens.every(t => orphanTokens.has(t))) continue;
    const score = realTokens.length;
    if (!best || score > best.score) { best = { id: npc.id, score }; tieAtBest = false; }
    else if (score === best.score) { tieAtBest = true; }
  }
  return best && !tieAtBest ? best.id : null;
}

export function validateAndRepairWorld(
  locations: WorldLocation[],
  npcs: WorldNPC[],
): { locations: WorldLocation[]; npcs: WorldNPC[]; report: WorldRepairReport } {
  const report: WorldRepairReport = {
    droppedLocations: 0, danglingEdgesFixed: 0, addedReciprocalEdges: 0,
    componentsLinked: 0, syntheticLocationsAdded: 0,
    npcHomeRebound: 0, npcWorkRebound: 0, npcFrequentedDropped: 0,
    relationshipsDropped: 0, relationshipsRemapped: 0,
    timelineNpcRefsRemapped: 0, timelineNpcRefsDropped: 0,
  };

  // 1. Drop locations with non-string or duplicate IDs.
  const seenIds = new Set<string>();
  const cleanLocs: WorldLocation[] = [];
  for (const loc of locations) {
    if (!loc || typeof loc.id !== 'string' || !loc.id || seenIds.has(loc.id)) {
      report.droppedLocations += 1;
      continue;
    }
    seenIds.add(loc.id);
    cleanLocs.push(loc);
  }

  // 2. Backstop: if the LLM gave us almost nothing, fabricate enough locations
  //    so the world is at least navigable. 3 is the minimum we'll tolerate.
  while (cleanLocs.length < 3) {
    const idx = cleanLocs.length;
    const synthetic: WorldLocation = {
      id: `_synthetic_${idx}`,
      name: ['the main street', 'the gathering place', 'the quiet corner'][idx] ?? `place_${idx}`,
      type: 'public',
      description: 'A generic gathering place. The world generator under-delivered on locations; this is a backstop.',
      ambientDetail: 'unremarkable',
      connectedTo: [],
      socialClass: 'mixed',
      openHours: 'always',
      regulars: [],
      interactables: [],
      privacyLevel: 'public',
      capacity: 'open',
    };
    cleanLocs.push(synthetic);
    seenIds.add(synthetic.id);
    report.syntheticLocationsAdded += 1;
  }

  // 3. Strip dangling edges and force reciprocity.
  for (const loc of cleanLocs) {
    const original = Array.isArray(loc.connectedTo) ? loc.connectedTo : [];
    const filtered = original.filter(t => typeof t === 'string' && seenIds.has(t) && t !== loc.id);
    report.danglingEdgesFixed += original.length - filtered.length;
    loc.connectedTo = Array.from(new Set(filtered));
  }
  for (const loc of cleanLocs) {
    for (const target of loc.connectedTo) {
      const other = cleanLocs.find(l => l.id === target);
      if (other && !other.connectedTo.includes(loc.id)) {
        other.connectedTo.push(loc.id);
        report.addedReciprocalEdges += 1;
      }
    }
  }

  // 4. Connected-component check. Link disconnected components to the largest
  //    one by adding bidirectional edges.
  const components = findConnectedComponents(cleanLocs);
  if (components.length > 1) {
    components.sort((a, b) => b.length - a.length);
    const hub = components[0][0];
    for (let i = 1; i < components.length; i++) {
      const bridge = components[i][0];
      const hubLoc = cleanLocs.find(l => l.id === hub)!;
      const bridgeLoc = cleanLocs.find(l => l.id === bridge)!;
      hubLoc.connectedTo.push(bridge);
      bridgeLoc.connectedTo.push(hub);
      report.componentsLinked += 1;
    }
  }

  // 5. NPCs: rebind hallucinated location IDs.
  const validLocIds = new Set(cleanLocs.map(l => l.id));
  const fallbackLoc = cleanLocs[0].id;
  const workSuitable = cleanLocs.find(l =>
    ['workplace', 'shop', 'market', 'office', 'factory', 'workshop', 'public'].includes(l.type)
  )?.id ?? fallbackLoc;
  const validNpcIds = new Set(npcs.map(n => n.id).filter(id => typeof id === 'string'));

  const cleanNpcs: WorldNPC[] = npcs.map(npc => {
    const fixed = { ...npc };
    if (!validLocIds.has(fixed.homeLocationId)) {
      fixed.homeLocationId = fallbackLoc;
      report.npcHomeRebound += 1;
    }
    if (!validLocIds.has(fixed.workLocationId)) {
      fixed.workLocationId = workSuitable;
      report.npcWorkRebound += 1;
    }
    const freqOrig = Array.isArray(fixed.frequentedLocations) ? fixed.frequentedLocations : [];
    const freqClean = freqOrig.filter(id => typeof id === 'string' && validLocIds.has(id));
    report.npcFrequentedDropped += freqOrig.length - freqClean.length;
    fixed.frequentedLocations = freqClean;

    if (Array.isArray(fixed.relationships)) {
      const before = fixed.relationships.length;
      const remapped: LegacyNPCRelationship[] = [];
      for (const r of fixed.relationships as LegacyNPCRelationship[]) {
        if (!r || typeof r !== 'object') continue;
        const tid: string | undefined = r.npcId ?? r.targetNpcId ?? r.targetId;
        if (!tid || typeof tid !== 'string') {
          remapped.push(r);
          continue;
        }
        if (validNpcIds.has(tid)) {
          // Normalise to canonical field name `npcId`.
          if (!r.npcId) r.npcId = tid;
          remapped.push(r);
          continue;
        }
        const resolved = remapOrphanNpcId(tid, npcs);
        if (resolved) {
          r.npcId = resolved;
          delete r.targetNpcId;
          delete r.targetId;
          remapped.push(r);
          report.relationshipsRemapped += 1;
        } else {
          report.relationshipsDropped += 1;
        }
      }
      fixed.relationships = remapped;
      // (legacy field retained for compatibility — old code path)
      void before;
    }
    return fixed;
  });

  // 6. Location.regulars often references NPC IDs — same treatment.
  for (const loc of cleanLocs) {
    if (Array.isArray(loc.regulars)) {
      loc.regulars = loc.regulars.filter(id => typeof id === 'string' && validNpcIds.has(id));
    }
  }

  console.log(
    `[worldgen:repair] dropped=${report.droppedLocations} edges_fixed=${report.danglingEdgesFixed} ` +
    `reciprocal_added=${report.addedReciprocalEdges} components_linked=${report.componentsLinked} ` +
    `synthetic_added=${report.syntheticLocationsAdded} npc_home=${report.npcHomeRebound} ` +
    `npc_work=${report.npcWorkRebound} freq_dropped=${report.npcFrequentedDropped} ` +
    `rel_dropped=${report.relationshipsDropped} rel_remapped=${report.relationshipsRemapped}`
  );

  return { locations: cleanLocs, npcs: cleanNpcs, report };
}

/**
 * Validate timeline events: each event has `affectedNpcIds: string[]`.
 * Remap orphan IDs where possible (typically the LLM slugifies names with
 * nicknames included — `gaz_the_shiv_riley` → real `gaz_riley`), drop the
 * unmappable ones. Mutates `report` and returns the repaired timeline array.
 * Also rebinds `event.locationId` to a fallback when it's not a known location.
 */
export function validateAndRepairTimeline<T extends {
  id?: string;
  locationId?: string;
  affectedNpcIds?: any;
  participants?: any;
}>(
  timeline: T[] | undefined,
  npcs: WorldNPC[],
  locations: WorldLocation[],
  report: WorldRepairReport,
): T[] {
  if (!Array.isArray(timeline)) return [];
  const validNpcIds = new Set(npcs.map(n => n.id));
  const validLocIds = new Set(locations.map(l => l.id));
  const fallbackLoc = locations[0]?.id;
  const repairList = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const id of raw) {
      if (typeof id !== 'string' || !id) continue;
      if (validNpcIds.has(id)) { out.push(id); continue; }
      const remapped = remapOrphanNpcId(id, npcs);
      if (remapped) { out.push(remapped); report.timelineNpcRefsRemapped += 1; }
      else { report.timelineNpcRefsDropped += 1; }
    }
    return Array.from(new Set(out));
  };
  const cleaned = timeline.map(ev => {
    const next: any = { ...ev };
    if ('affectedNpcIds' in ev) next.affectedNpcIds = repairList((ev as any).affectedNpcIds);
    if ('participants' in ev) next.participants = repairList((ev as any).participants);
    if (typeof next.locationId === 'string' && !validLocIds.has(next.locationId) && fallbackLoc) {
      next.locationId = fallbackLoc;
    }
    return next as T;
  });
  // Order events chronologically so the timeline always reads start -> finish regardless of the
  // order the LLM emitted them. ISO YYYY-MM-DD dates sort correctly as plain strings.
  cleaned.sort((a, b) => {
    const da = typeof (a as any).date === 'string' ? (a as any).date : '';
    const db = typeof (b as any).date === 'string' ? (b as any).date : '';
    return da.localeCompare(db);
  });
  console.log(
    `[worldgen:repair-timeline] events=${cleaned.length} ` +
    `npc_refs_remapped=${report.timelineNpcRefsRemapped} ` +
    `npc_refs_dropped=${report.timelineNpcRefsDropped}`
  );
  return cleaned;
}

function findConnectedComponents(locs: WorldLocation[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const l of locs) adj.set(l.id, l.connectedTo.slice());
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const l of locs) {
    if (seen.has(l.id)) continue;
    const stack = [l.id];
    const component: string[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      component.push(cur);
      for (const n of adj.get(cur) ?? []) if (!seen.has(n)) stack.push(n);
    }
    components.push(component);
  }
  return components;
}

// ── Prompt builders ─────────────────────────────────────────────────────────

const FOUNDATION_PROMPT = `You build living, breathing worlds for a life simulation. Not a game — a simulation of LIFE in a specific time and place. There are no quests, no objectives, no win conditions. Just people existing in a community, going about their days, forming relationships, keeping secrets, spreading gossip.

Your job is to create the cultural and social fabric of a place so detailed that someone could drop into it and feel like they've moved to a real town. The dialect, the food, the customs, the unwritten social rules, the class tensions, the entertainment, the way people greet each other — all of it must feel specific and authentic.

Key principles:
- This is a LIFE SIMULATOR, not a game. People eat, work, sleep, talk, argue, love, gossip, drink.
- Every world must be genuinely unique — not a template with names changed.
- Social dynamics matter more than plot. WHO talks to whom, WHY they don't like each other, WHAT happened ten years ago that everyone still whispers about.
- The economy must ground everything. What people earn dictates where they live, where they drink, who they know.
- Dialect and slang must be SPECIFIC. Not "they have accents" but the actual words and phrases people use.
- Include the mundane. What's on the radio. What people eat for breakfast. What the pub smells like.

Return valid JSON with every field populated.`;

function buildFoundationUser(concept: string): string {
  return `Concept: "${concept}"

Generate the complete world foundation. Return JSON:
{
  "era": { "period": string, "yearStart": number, "yearEnd": number, "dateFormat": string, "majorWorldEvents": string[] },
  "geography": { "region": string, "country": string, "climate": string, "terrain": string, "scale": "neighbourhood"|"city"|"region", "landmarks": string[] },
  "culture": {
    "language": string,
    "dialect": string (describe the SPECIFIC way people talk — cadence, dropped letters, vocabulary),
    "slang": { "word": "meaning" } (10-15 era/region-specific slang terms),
    "greetings": string[] (5+ ways people say hello in this world),
    "socialClasses": [{ "name": string, "description": string, "occupations": string[], "typicalLocations": string[], "mannerisms": string }],
    "religion": string,
    "customs": string[] (5+ daily life customs),
    "taboos": string[] (things people don't discuss openly),
    "music": string,
    "food": string[] (5+ specific dishes/meals),
    "entertainment": string[] (what people do for fun),
    "genderRoles": string,
    "socialNorms": string[] (5+ unwritten rules)
  },
  "economy": {
    "currency": string,
    "symbol": string,
    "averageDailyWage": number,
    "prices": { "item": price } (10+ everyday items with prices),
    "jobs": [{ "title": string, "pay": number, "hours": string, "socialClass": string, "description": string }],
    "blackMarket": string
  },
  "law": { "system": string, "enforcers": string, "corruption": number, "vices": string[], "consequences": string },
  "weather": { "seasons": [{ "name": string, "months": number[], "weather": string, "atmosphere": string, "npcBehaviourShift": string }], "dominantWeather": string },
  "technology": { "era": string, "transport": string[], "communication": string[], "lighting": string, "media": string[], "domesticLife": string }
}`;
}

function buildLocationSystem(concept: string, foundation: any, locationCount?: number): string {
  const count = locationCount ?? 10;
  const countRange = locationCount ? `exactly ${count}` : '8-10';
  return `You are building locations for a life simulation. Setting: ${concept}. Era: ${foundation.era.period}. Region: ${foundation.geography.region}. Climate: ${foundation.geography.climate}. Social classes: ${foundation.culture.socialClasses?.map((c: any) => c.name).join(', ')}.

These are REAL PLACES where people live, work, drink, shop, and exist. Not game levels. Each location has a character — a smell, a sound, a feeling. Some are warm and welcoming. Some are hostile to outsiders. Some are dead quiet at noon and alive at midnight.

Create ${countRange} interconnected locations. Mix: homes, workplaces, pubs/bars, shops, streets, parks, churches, stations, alleys, community spaces. Every location connects to at least 2 others. Include places for every social class. Keep every string concise so the JSON completes.`;
}

const LOCATION_USER = `Generate locations as a JSON array. Each:
{
  "id": string (snake_case),
  "name": string (era and place appropriate),
  "type": string,
  "description": string (1 vivid sentence — what you SEE, HEAR, SMELL),
  "ambientDetail": string (one short sensory snapshot),
  "connectedTo": string[] (IDs of adjacent locations, min 2),
  "socialClass": string,
  "openHours": string ("always", "6am-11pm", "evenings only", etc),
  "regulars": [] (leave empty, NPCs assigned later),
  "interactables": string[] (3-4 things you can examine, use, or notice),
  "privacyLevel": "public"|"semi-private"|"private",
  "capacity": string ("crowded", "a few people", "empty", "varies by time")
}`;

function ensureArray(val: any): any[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') return [val];
  if (val && typeof val === 'object') return Object.values(val);
  return [];
}

function buildNPCSystem(concept: string, foundation: any, locationIndex: string, blueprint: PopulationBlueprint): string {
  const ageBreakdown = ensureArray(blueprint.ageDistribution).map((a: any) => `${a.count} ${a.label} (${a.range}): ${a.socialRole}`).join('\n  ');
  const ethnicBreakdown = ensureArray(blueprint.ethnicComposition).map((e: any) => `${e.count} ${e.name}: ${e.socialPosition}`).join('\n  ');
  const classBreakdown = ensureArray(blueprint.classDistribution).map((c: any) => `${c.count} ${c.className} (power: ${c.power}/100)`).join('\n  ');
  const occupations = ensureArray(blueprint.occupationCategories).map((o: any) => `${o.category}: ${ensureArray(o.examples).join(', ')} (${o.count} people)`).join('\n  ');
  const personalities = blueprint.personalitySpread ?? {} as any;

  return `You are creating REAL PEOPLE for a life simulation. Setting: ${concept}. Era: ${foundation.era.period}. Dialect: ${foundation.culture.dialect}.
Community type: ${blueprint.communityType}. Population density: ${blueprint.populationDensity}. Social cohesion: ${blueprint.socialCohesion}/100.
Newcomers are treated: ${blueprint.newcomerReception}. Power structure: ${blueprint.powerStructure}.

POPULATION BLUEPRINT — follow this exactly:
  Total people to create: ${blueprint.totalPopulation}
  
  Age distribution:
  ${ageBreakdown}
  
  Gender: ${blueprint.genderBalance.male}% male, ${blueprint.genderBalance.female}% female${blueprint.genderBalance.other > 0 ? `, ${blueprint.genderBalance.other}% other` : ''} — ${blueprint.genderBalance.reasoning}
  
  Ethnic composition:
  ${ethnicBreakdown}
  
  Class spread:
  ${classBreakdown}
  
  Occupations:
  ${occupations}
  Unemployment: ${(Number(blueprint.unemploymentRate ?? 0) * 100).toFixed(0)}%
  
  Family structures: ${ensureArray(blueprint.familyStructures).join(', ')}

  Personality spread: ${personalities.warmToHostile ?? 'mixed'}. Trust: ${personalities.trustLevel ?? 'varies'}. Humour: ${personalities.humorPresent ? 'present' : 'rare'}. Darkness: ${personalities.darknessLevel ?? 'moderate'}. Volatility: ${personalities.volatility ?? 'moderate'}.
  Required personalities: ${ensureArray(personalities.requiredPersonalities).join(', ')}

  Required archetypes (MUST be represented): ${ensureArray(blueprint.requiredArchetypes).join(', ')}

  Relationships: average ${blueprint.averageRelationshipsPerPerson ?? 3} per person. Romance: ${blueprint.romancePresent ? 'yes' : 'no'}. Rivalries: ${blueprint.rivalriesPresent ? 'yes' : 'no'}. Secrets: ~${blueprint.secretsPerPerson ?? 1} per person.

  Influential roles: ${ensureArray(blueprint.influentialRoles).join(', ')}

These are not game NPCs. They are simulated human beings with inner lives, daily routines, private thoughts, and the full range of human complexity. They have opinions about each other, secrets they keep from everyone, things they want but can't have.

Keep JSON compact. Prefer short phrases and one-sentence fields. Do not include long paragraphs.

CRITICAL — VOICE ANCHORS:
Each person's voiceAnchor must capture exactly HOW they speak — rhythm, vocabulary, verbal habits, what they avoid saying, how they handle silence. Keep it to one compact sentence.

CRITICAL — DAILY ROUTINES:
Every NPC has a routine. Where they are in the morning, afternoon, evening, night. This drives the simulation — the player meets whoever is at their location at the current time.

CRITICAL — RELATIONSHIPS:
NPCs know each other. They have history. Create a web of relationships — warm, tense, complicated. For this compact generation pass, include 0-1 relationships per NPC.

CRITICAL — FOLLOW THE BLUEPRINT:
The whole generated population should match the blueprint across all batches. Generate only the number of NPCs requested by the user message for the current batch. Do not generate the whole population in one response. Match the age, gender, ethnic, and class distributions as closely as possible across the final set. Hit every required archetype over the full population. The population planner decided these numbers for a reason — this is what makes this specific world feel real.

Available locations: ${locationIndex}`;
}

const NPC_USER = `Generate NPCs as a JSON array. Each object:
{
  "id": string (snake_case),
  "name": string,
  "age": number,
  "gender": string,
  "occupation": string,
  "physicalDescription": string (1 sentence),
  "personality": string (one word),
  "voiceAnchor": string (1 sentence: how they speak, verbal tics),
  "speechPatterns": string[] (2 phrases),
  "coreConcerns": string[] (2 items),
  "signature": string,
  "traits": string[] (3 traits),
  "secrets": string[] (1 item),
  "desires": string[] (1 item),
  "fears": string[] (1 item),
  "opinions": { "topic": "opinion" } (2 topics),
  "backstory": string (1 sentence),
  "dailyRoutine": { "morning": string, "afternoon": string, "evening": string, "night": string },
  "homeLocationId": string,
  "workLocationId": string,
  "frequentedLocations": string[],
  "socialClass": string,
  "relationships": [{ "npcId": string, "type": string, "description": string, "strength": number }] (0-1 items),
  "baselineMood": string,
  "temperament": string,
  "approachability": number,
  "attachmentStyle": "secure"|"anxious"|"avoidant"|"disorganised",
  "processingType": "present"|"brief_reflection"|"moderate_rumination"|"heavy_rumination"|"suppression"|"dissociation" (how they replay events afterwards; most people = moderate_rumination, anxious/brooding = heavy_rumination, avoidant = suppression, grounded = present/brief_reflection),
  "primaryDefense": string,
  "selfAwarenessLevel": number (0-100: how well they understand their own inner workings),
  "coreWound": string,
  "woundTriggers": string[] (1-2 words/topics that activate the wound),
  "woundSituations": string[] (1-2 situations that activate the wound, e.g. "being ignored", "someone leaving without saying goodbye"),
  "additionalWounds": [{ "description": string, "triggerWords": string[], "triggerSituations": string[] }] (0-2 secondary wounds),
  "selfConcept": string[] (2 "I am..." beliefs, e.g. "I am a hard worker", "I am unlovable"),
  "values": string[] (2 items)
}`;

function buildTimelineSystem(concept: string, foundation: any, locationIndex: string, npcIndex: string): string {
  return `Create community events for a life simulation. Setting: ${concept}. Era: ${foundation.era.period}. These are things that HAPPEN — not plot points, just life. A shop closing down. A wedding. A scandal. A storm. An accident. A festival. Someone leaving town. A birth. A death. An argument that everyone takes sides on.

The events should feel organic to the setting — things that would actually happen here. Some are public knowledge, some are whispered. Some affect the whole community, some are personal. They should span the game timeline and create a sense of time passing and the world changing.

NPCs: ${npcIndex}
Locations: ${locationIndex}

Create 8-10 concise events, sorted by date.`;
}

const TIMELINE_USER = `Generate timeline as a JSON array:
{
  "id": string (snake_case),
  "date": string (YYYY-MM-DD),
  "title": string,
  "description": string (1 sentence, era-appropriate language),
  "type": "local"|"world"|"personal"|"seasonal"|"crisis",
  "locationId": string or null,
  "affectedNpcIds": string[],
  "moodShift": string (how community mood changes),
  "publicKnowledge": boolean,
  "gossipVersion": string (how people TALK about it — may differ from truth)
}`;

function buildNarrativeSystem(concept: string, foundation: any): string {
  return `Define the narrative voice for a life simulation. Setting: ${concept}. Era: ${foundation.era.period}. Region: ${foundation.geography.region}. Climate: ${foundation.geography.climate}. Dialect: ${foundation.culture.dialect}.

This voice narrates everything — movement between locations, atmosphere, what the player sees and hears and smells. It must feel like a novel set in this exact time and place. Not generic. Not game-like. Literary, specific, grounded in sensory detail.`;
}

const NARRATIVE_USER = `Generate narrative style as JSON:
{
  "voice": string (genre label),
  "tense": "second"|"first"|"third",
  "toneKeywords": string[] (5-7 words),
  "literaryInfluences": string[] (3-5 authors/works),
  "sampleParagraph": string (write 3 sentences in this exact voice showing atmosphere and place),
  "forbiddenWords": string[] (words that break the voice — modern slang, anachronisms, game terms),
  "sensoryPalette": string[] (5-8 sensory details unique to this world)
}`;
