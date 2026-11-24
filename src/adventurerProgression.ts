// ─────────────────────────────────────────────────────────────────────────────
// Adventurer Progression System
//
// 10-tier rank progression based on cumulative XP. Awards XP for beat completions,
// adventure completions, and milestone medals. Computes the current rank + glow
// colour for the HUD to display.
//
// Used by serializedAdventure.ts to grant rewards as the player progresses through
// world adventures. Rank is computed on demand from xp (cheap, no storage needed).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  WorldSession,
  WorldDNA,
  QuestMedal,
  QuestAchievement,
  SerializedBeat,
  SerializedAdventure,
} from './types.js';

export interface AdventurerRank {
  level: number;
  rank: string;
  xp: number;
  rankXp: number;
  nextRankXp: number;
  nextRank?: string;
  progress: number;
  color: string;
  glowColor: string;
  isMaxed: boolean;
  title: string;
}

// 10-tier progression. Each rank has a thematic colour + glow. XP curve is roughly
// quadratic toward the top so Quest Master feels earned (~120 beats / ~12 adventures).
const RANKS: { level: number; name: string; xp: number; color: string; glow: string; title: string }[] = [
  { level: 1,  name: 'Explorer',          xp: 0,     color: '#94a3b8', glow: 'rgba(148,163,184,.4)', title: 'a curious newcomer' },
  { level: 2,  name: 'Wanderer',          xp: 100,   color: '#67e8f9', glow: 'rgba(103,232,249,.5)', title: 'finding your way' },
  { level: 3,  name: 'Scout',             xp: 250,   color: '#86efac', glow: 'rgba(134,239,172,.5)', title: 'eyes sharpening' },
  { level: 4,  name: 'Tracker',           xp: 500,   color: '#fde047', glow: 'rgba(253,224,71,.55)', title: 'on the trail' },
  { level: 5,  name: 'Pathfinder',        xp: 1000,  color: '#fb923c', glow: 'rgba(251,146,60,.6)',  title: 'breaking new ground' },
  { level: 6,  name: 'Voyager',           xp: 2000,  color: '#f472b6', glow: 'rgba(244,114,182,.6)', title: 'crossing thresholds' },
  { level: 7,  name: 'Champion',          xp: 3500,  color: '#a78bfa', glow: 'rgba(167,139,250,.65)',title: 'the worlds know your name' },
  { level: 8,  name: 'Master Adventurer', xp: 5500,  color: '#f59e0b', glow: 'rgba(245,158,11,.7)',  title: 'forged through fire' },
  { level: 9,  name: 'Grandmaster',       xp: 8000,  color: '#ef4444', glow: 'rgba(239,68,68,.7)',   title: 'few stand at your peak' },
  { level: 10, name: 'Quest Master',      xp: 12000, color: '#fde68a', glow: 'rgba(253,230,138,.85)',title: 'master of the spectrum' },
];

export function computeAdventurerRank(xp: number): AdventurerRank {
  const safeXp = Math.max(0, Math.floor(xp || 0));
  let idx = 0;
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (safeXp >= RANKS[i].xp) { idx = i; break; }
  }
  const cur = RANKS[idx];
  const isMaxed = idx === RANKS.length - 1;
  const next = isMaxed ? cur : RANKS[idx + 1];
  const span = isMaxed ? 1 : (next.xp - cur.xp);
  const progress = isMaxed ? 1 : Math.min(1, (safeXp - cur.xp) / span);
  return {
    level: cur.level,
    rank: cur.name,
    xp: safeXp,
    rankXp: cur.xp,
    nextRankXp: next.xp,
    nextRank: isMaxed ? undefined : next.name,
    progress,
    color: cur.color,
    glowColor: cur.glow,
    isMaxed,
    title: cur.title,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// XP awards
// ─────────────────────────────────────────────────────────────────────────────

export function awardBeatXp(
  session: WorldSession,
  beat: SerializedBeat,
  quality: number,
  adventure: SerializedAdventure,
): { xpAwarded: number; newRank: AdventurerRank; rankedUp: boolean; previousLevel: number } {
  const previousLevel = computeAdventurerRank(session.adventurerXp ?? 0).level;
  // Base 50 + 0-50 from evaluation quality + 100 bonus for final-act beats
  const baseXp = 50;
  const qualityXp = Math.round(Math.max(0, Math.min(1, quality)) * 50);
  const acts = adventure.acts ?? [];
  const lastActIdx = acts.length - 1;
  const beatActIdx = acts.findIndex(a => (a.beats ?? []).some(b => b.id === beat.id));
  const isFinalActBeat = beatActIdx === lastActIdx && lastActIdx >= 0;
  const finalActBonus = isFinalActBeat ? 100 : 0;
  const xpAwarded = baseXp + qualityXp + finalActBonus;
  session.adventurerXp = (session.adventurerXp ?? 0) + xpAwarded;
  session.adventurerXpEarnedAt = new Date().toISOString();
  const newRank = computeAdventurerRank(session.adventurerXp);
  const rankedUp = newRank.level > previousLevel;
  return { xpAwarded, newRank, rankedUp, previousLevel };
}

export function awardAdventureCompletionXp(
  session: WorldSession,
  spectrumScore: number,
): { xpAwarded: number; newRank: AdventurerRank; rankedUp: boolean; previousLevel: number } {
  const previousLevel = computeAdventurerRank(session.adventurerXp ?? 0).level;
  const baseXp = 500;
  const scoreXp = Math.round(Math.max(0, Math.min(1, spectrumScore)) * 500);
  const xpAwarded = baseXp + scoreXp;
  session.adventurerXp = (session.adventurerXp ?? 0) + xpAwarded;
  session.adventurerXpEarnedAt = new Date().toISOString();
  const newRank = computeAdventurerRank(session.adventurerXp);
  const rankedUp = newRank.level > previousLevel;
  return { xpAwarded, newRank, rankedUp, previousLevel };
}

// ─────────────────────────────────────────────────────────────────────────────
// Milestone medals
// ─────────────────────────────────────────────────────────────────────────────

interface MilestoneMedalDef {
  id: string;
  name: string;
  tier: 'Minor' | 'Standard' | 'Major' | 'Epic';
  description: string;
  check: (ctx: MilestoneCtx) => boolean;
  xpBonus?: number;
}

interface MilestoneCtx {
  session: WorldSession;
  totalBeatsCompleted: number;
  totalAdventuresCompleted: number;
  highestSpectrumScore: number;
  uniqueWorldsAdventured: number;
  hasSourceGroundedCompletion: boolean;
}

const MILESTONE_MEDALS: MilestoneMedalDef[] = [
  { id: 'milestone:first-beat',          name: 'First Steps',           tier: 'Minor',    description: 'Completed your first adventure beat.',                                          check: c => c.totalBeatsCompleted >= 1,        xpBonus: 25 },
  { id: 'milestone:five-beats',          name: 'Beat Reader',           tier: 'Minor',    description: 'Completed 5 adventure beats.',                                                  check: c => c.totalBeatsCompleted >= 5,        xpBonus: 50 },
  { id: 'milestone:twenty-beats',        name: 'Storyweaver',           tier: 'Standard', description: 'Completed 20 adventure beats - you can feel the rhythm now.',                  check: c => c.totalBeatsCompleted >= 20,       xpBonus: 150 },
  { id: 'milestone:fifty-beats',         name: 'Through the Acts',      tier: 'Standard', description: 'Completed 50 adventure beats across many stories.',                            check: c => c.totalBeatsCompleted >= 50,       xpBonus: 300 },
  { id: 'milestone:hundred-beats',       name: 'The Spectrum Walker',   tier: 'Major',    description: 'Completed 100 adventure beats. Patterns reveal themselves now.',               check: c => c.totalBeatsCompleted >= 100,      xpBonus: 500 },
  { id: 'milestone:first-adventure',     name: 'Adventure Begun',       tier: 'Minor',    description: 'Completed your first full adventure end-to-end.',                              check: c => c.totalAdventuresCompleted >= 1,   xpBonus: 100 },
  { id: 'milestone:three-adventures',    name: 'Trilogy',               tier: 'Standard', description: 'Completed three full adventures.',                                              check: c => c.totalAdventuresCompleted >= 3,   xpBonus: 250 },
  { id: 'milestone:five-adventures',     name: 'Veteran Adventurer',    tier: 'Standard', description: 'Completed five full adventures.',                                               check: c => c.totalAdventuresCompleted >= 5,   xpBonus: 400 },
  { id: 'milestone:ten-adventures',      name: 'Mythkeeper',            tier: 'Major',    description: 'Completed ten full adventures. You carry the stories with you.',               check: c => c.totalAdventuresCompleted >= 10,  xpBonus: 800 },
  { id: 'milestone:twenty-adventures',   name: 'Eternal Returner',      tier: 'Epic',     description: 'Completed twenty adventures. Few will ever see all you have seen.',            check: c => c.totalAdventuresCompleted >= 20,  xpBonus: 1500 },
  { id: 'milestone:perfect-score',       name: 'Perfect Spectrum',      tier: 'Epic',     description: 'Completed an adventure with a spectrum score of 90% or higher.',               check: c => c.highestSpectrumScore >= 0.9,     xpBonus: 600 },
  { id: 'milestone:source-grounded',     name: 'Source Walker',         tier: 'Standard', description: 'Completed an adventure built from a real source (film, book, history).',      check: c => c.hasSourceGroundedCompletion,     xpBonus: 200 },
  { id: 'milestone:three-worlds',        name: 'Across the Veil',       tier: 'Minor',    description: 'Adventured in three different worlds.',                                         check: c => c.uniqueWorldsAdventured >= 3,     xpBonus: 100 },
  { id: 'milestone:five-worlds',         name: 'Many Skies',            tier: 'Standard', description: 'Adventured in five different worlds.',                                          check: c => c.uniqueWorldsAdventured >= 5,     xpBonus: 250 },
  { id: 'milestone:ten-worlds',          name: 'World Walker',          tier: 'Major',    description: 'Adventured in ten different worlds - few have such breadth.',                  check: c => c.uniqueWorldsAdventured >= 10,    xpBonus: 600 },
];

export function checkMilestoneMedals(session: WorldSession, world?: WorldDNA): {
  newMedals: QuestMedal[];
  newAchievements: QuestAchievement[];
  bonusXp: number;
} {
  const completed = session.completedSerializedAdventures ?? [];
  let totalBeatsCompleted = 0;
  for (const c of completed) totalBeatsCompleted += (c.scoreBreakdown ?? []).length;
  if (session.activeSerializedAdventure?.scoreBreakdown) {
    totalBeatsCompleted += session.activeSerializedAdventure.scoreBreakdown.length;
  }
  const totalAdventuresCompleted = completed.length;
  const highestSpectrumScore = completed.reduce((max, c) => Math.max(max, c.spectrumScore || 0), 0);
  const uniqueWorldsAdventured = new Set(completed.map(c => c.worldId).filter(Boolean)).size;
  const hasSourceGroundedCompletion = Boolean(world?.sourceDocuments?.length);

  const ctx: MilestoneCtx = {
    session,
    totalBeatsCompleted,
    totalAdventuresCompleted,
    highestSpectrumScore,
    uniqueWorldsAdventured,
    hasSourceGroundedCompletion,
  };

  const existing = new Set([...(session.medals ?? []).map(m => m.id), ...(session.achievements ?? []).map(a => a.id)]);
  const newMedals: QuestMedal[] = [];
  const newAchievements: QuestAchievement[] = [];
  let bonusXp = 0;
  const now = new Date().toISOString();
  for (const def of MILESTONE_MEDALS) {
    if (existing.has(def.id)) continue;
    if (!def.check(ctx)) continue;
    newMedals.push({ id: def.id, name: def.name, tier: def.tier, questType: 'existential', earnedAt: now });
    newAchievements.push({ id: def.id + ':ach', name: def.name, description: def.description, earnedAt: now });
    if (def.xpBonus) bonusXp += def.xpBonus;
  }

  if (newMedals.length) {
    session.medals = mergeUniqueById(session.medals, newMedals);
    session.achievements = mergeUniqueById(session.achievements, newAchievements);
  }
  if (bonusXp > 0) {
    session.adventurerXp = (session.adventurerXp ?? 0) + bonusXp;
    session.adventurerXpEarnedAt = now;
  }
  return { newMedals, newAchievements, bonusXp };
}

function mergeUniqueById<T extends { id: string }>(existing: T[] | undefined, incoming: T[]): T[] {
  const out = [...(existing ?? [])];
  const seen = new Set(out.map(x => x.id));
  for (const item of incoming) {
    if (!seen.has(item.id)) { out.push(item); seen.add(item.id); }
  }
  return out;
}
