/**
 * Memory Engine
 * 
 * Memory is not a log. Memory is emotional, selective, biased, and decaying.
 * 
 * People remember:
 * - How you made them FEEL (emotional peak, not content)
 * - Betrayals and broken trust (near-permanent, burns hot)
 * - Kindness in crisis (strong but fades faster than betrayal)
 * - Promises made (tracked, recalled when broken)
 * - Secrets shared (creates intimacy debt — betraying a secret is devastating)
 * - First impressions (disproportionate weight, hard to shake)
 * - Repeated patterns (if you're always late, they notice)
 * 
 * People forget:
 * - Mundane exchanges (fast decay)
 * - Content of conversations (medium decay, feeling persists)
 * - Exact words (fast decay, gist remains)
 * - Old grievances IF enough positive interactions follow (slow healing)
 * 
 * People distort:
 * - Negative experiences grow worse in memory over time
 * - Positive experiences romanticise over time
 * - Gossip replaces firsthand memory if not refreshed
 * - People project their fears onto ambiguous memories
 */

import type { NPCMemory, NPCLiveState, WorldNPC } from './types.js';

// ── Memory Importance Scoring ───────────────────────────────────────────────
// Not all memories are equal. A betrayal at trust level 80 matters more
// than small talk at trust level 5.

export function scoreMemoryImportance(memory: NPCMemory, npcState: NPCLiveState): number {
  let score = 0;

  // Emotional intensity — strong feelings = strong memories
  const emotionalIntensity = getEmotionalIntensity(memory.emotionalTone);
  score += emotionalIntensity * 20;

  // Trust change — big trust shifts create lasting memories
  score += Math.abs(memory.trustDelta) * 8;

  // Secrets shared — creates intimacy, very memorable
  if (memory.playerRevealed.length > 0) score += memory.playerRevealed.length * 5;
  if (memory.npcRevealed.length > 0) score += memory.npcRevealed.length * 7; // they remember what THEY shared more

  // First interaction — disproportionately memorable
  if (npcState.totalInteractions <= 1) score += 25;
  // Second and third — still forming first impressions
  if (npcState.totalInteractions <= 3) score += 10;

  // Significant moments already flagged
  if (memory.significantMoment) score += 15;

  // Betrayal at high trust — devastating, near-permanent
  if (memory.trustDelta < -3 && npcState.trustLevel > 50) score += 30;

  // Kindness when vulnerable — deeply remembered
  if (memory.trustDelta > 2 && npcState.warmth < 30) score += 20;

  // Witnessed by others — social weight amplifies memory
  if (memory.othersPresent.length > 0) score += memory.othersPresent.length * 3;

  return Math.min(100, score);
}

// ── Memory Decay ────────────────────────────────────────────────────────────
// Memories fade over time, but emotional memories fade slower.
// Negative memories fade slowest. Mundane memories vanish quickly.

export interface DecayedMemory extends NPCMemory {
  currentVividness: number;      // 0-100, decays from importance score
  isDistorted: boolean;          // has the memory changed from what actually happened
  distortedVersion?: string;     // what the NPC now remembers (may differ from summary)
  emotionalResidue: string;      // the feeling that remains even when details fade
}

export function applyMemoryDecay(
  memory: NPCMemory,
  importance: number,
  daysSinceEvent: number,
  npcPersonality: string,
): DecayedMemory {
  // Base decay rate — mundane memories lose ~10% per day, significant ones ~2%
  const baseDecayRate = importance > 70 ? 0.02 : importance > 40 ? 0.05 : 0.10;
  
  // Personality affects decay — anxious people ruminate (slower decay on negative)
  // Cheerful people let things go (faster decay on negative, slower on positive)
  let personalityModifier = 1.0;
  const lp = npcPersonality.toLowerCase();
  if (lp.includes('anxious') || lp.includes('brooding') || lp.includes('neurotic')) {
    personalityModifier = memory.trustDelta < 0 ? 0.5 : 1.2; // negative sticks, positive fades
  }
  if (lp.includes('cheerful') || lp.includes('optimistic') || lp.includes('warm')) {
    personalityModifier = memory.trustDelta < 0 ? 1.5 : 0.7; // negative fades faster, positive sticks
  }

  const effectiveDecay = baseDecayRate * personalityModifier;
  const vividness = Math.max(5, importance * Math.pow(1 - effectiveDecay, daysSinceEvent));

  // Distortion — memories warp over time
  // Negative memories get worse, positive memories get rosier
  const isDistorted = daysSinceEvent > 7 && Math.random() < (daysSinceEvent / 100);
  
  // Emotional residue — the feeling that outlasts the details
  const residue = memory.trustDelta > 2 ? 'a warm feeling'
    : memory.trustDelta < -2 ? 'unease and distrust'
    : memory.trustDelta > 0 ? 'mild positive regard'
    : memory.trustDelta < 0 ? 'slight wariness'
    : 'nothing strong';

  return {
    ...memory,
    currentVividness: Math.round(vividness),
    isDistorted,
    distortedVersion: isDistorted ? distortMemory(memory, daysSinceEvent) : undefined,
    emotionalResidue: residue,
  };
}

function distortMemory(memory: NPCMemory, daysSince: number): string {
  // Negative distortion — things seem worse than they were
  if (memory.trustDelta < 0) {
    return `${memory.summary} — and it felt worse than it probably was.`;
  }
  // Positive distortion — romanticised
  if (memory.trustDelta > 1 && daysSince > 14) {
    return `${memory.summary} — one of the better moments, looking back.`;
  }
  // Neutral — details blur
  return `Something about ${memory.topicsCovered[0] ?? 'a conversation'}, but the details are hazy.`;
}

// ── Memory Recall ───────────────────────────────────────────────────────────
// When an NPC is about to talk to the player, they recall relevant memories.
// This isn't "retrieve all" — it's selective, biased, emotional.

export function recallMemories(
  state: NPCLiveState,
  npc: WorldNPC,
  currentContext: {
    locationId: string;
    timeOfDay: string;
    playerMessage?: string;
    daysSinceLastSeen: number;
  },
): DecayedMemory[] {
  if (state.memories.length === 0) return [];

  const nowMs = Date.now();

  return state.memories
    .map(mem => {
      const importance = scoreMemoryImportance(mem, state);
      // Compute per-memory age from realTimestamp when available, fall back to daysSinceLastSeen
      let daysSince = currentContext.daysSinceLastSeen;
      if (mem.realTimestamp) {
        const memTime = new Date(mem.realTimestamp).getTime();
        if (!Number.isNaN(memTime)) {
          daysSince = Math.max(0, Math.floor((nowMs - memTime) / (1000 * 60 * 60 * 24)));
        }
      }
      return applyMemoryDecay(mem, importance, daysSince, npc.personality);
    })
    // Only recall vivid enough memories
    .filter(m => m.currentVividness > 15)
    // Prioritise by relevance to current context
    .sort((a, b) => {
      // Same location triggers location-specific memories
      const aLocationBonus = a.locationId === currentContext.locationId ? 20 : 0;
      const bLocationBonus = b.locationId === currentContext.locationId ? 20 : 0;
      
      // Significant moments always surface
      const aSignificant = a.significantMoment ? 30 : 0;
      const bSignificant = b.significantMoment ? 30 : 0;

      // Topic match — if the player mentions something discussed before
      const aTopicMatch = currentContext.playerMessage && a.topicsCovered.some(t => 
        currentContext.playerMessage!.toLowerCase().includes(t)
      ) ? 25 : 0;
      const bTopicMatch = currentContext.playerMessage && b.topicsCovered.some(t => 
        currentContext.playerMessage!.toLowerCase().includes(t)
      ) ? 25 : 0;

      const aTotal = a.currentVividness + aLocationBonus + aSignificant + aTopicMatch;
      const bTotal = b.currentVividness + bLocationBonus + bSignificant + bTopicMatch;
      return bTotal - aTotal;
    })
    // Only take the top memories — people don't recall everything
    .slice(0, 5);
}

// ── Promise Tracking ────────────────────────────────────────────────────────
// "I'll help you with that" or "I'll come back tomorrow" — NPCs track these.
// Breaking a promise is remembered. Keeping one builds trust.

// Promise interface removed — use NPCPromise from types.ts instead
// (the local `Promise` shadowed the global Promise constructor).

export function detectPromise(playerMessage: string): string | null {
  const promisePatterns = [
    /i('ll| will) (help|come back|bring|get|find|do|fix|see|meet|visit)/i,
    /i promise/i,
    /you have my word/i,
    /count on (me|it)/i,
    /i('ll| will) be (there|back|here)/i,
    /tomorrow i('ll| will)/i,
    /next time i('ll| will)/i,
    /leave it (with|to) me/i,
  ];
  
  for (const pattern of promisePatterns) {
    const match = playerMessage.match(pattern);
    if (match) return playerMessage;
  }
  return null;
}

// ── Emotional Intensity ─────────────────────────────────────────────────────

function getEmotionalIntensity(tone: string): number {
  const high = ['hostile', 'distressed', 'furious', 'heartbroken', 'terrified', 'ecstatic', 'intimate'];
  const medium = ['anxious', 'warm', 'melancholy', 'irritable', 'grateful', 'playful', 'guarded'];
  const low = ['neutral', 'friendly', 'tired', 'bored', 'cheerful'];
  
  if (high.some(h => tone.toLowerCase().includes(h))) return 5;
  if (medium.some(m => tone.toLowerCase().includes(m))) return 3;
  return 1;
}

// ── First Impression Lock ───────────────────────────────────────────────────
// First impressions are disproportionately sticky.
// It takes 5+ positive interactions to undo a bad first impression.
// It takes 1 bad interaction to undo a good first impression.

export function getFirstImpressionWeight(state: NPCLiveState): number {
  if (state.memories.length === 0) return 0;
  
  const firstMemory = state.memories[0];
  const firstTrustDelta = firstMemory.trustDelta;
  
  // Bad first impression — high negative weight that decays VERY slowly
  if (firstTrustDelta < -1) {
    const positiveInteractionsSince = state.memories.filter(m => m.trustDelta > 0).length;
    // Takes ~5 positive interactions to halve the weight of a bad first impression
    return Math.max(0, (-firstTrustDelta * 10) - (positiveInteractionsSince * 2));
  }
  
  // Good first impression — moderate positive weight but fragile
  if (firstTrustDelta > 1) {
    const negativeInteractionsSince = state.memories.filter(m => m.trustDelta < -1).length;
    // One bad interaction can wipe it
    if (negativeInteractionsSince > 0) return 0;
    return firstTrustDelta * 5;
  }
  
  return 0;
}

// ── Pattern Detection ───────────────────────────────────────────────────────
// NPCs notice if the player always does the same thing.
// "You always come here at night." "Every time we talk, you ask about money."

export function detectPatterns(state: NPCLiveState): string[] {
  const patterns: string[] = [];
  const memories = state.memories.filter(m =>
    !(m.biasTags ?? []).some(tag => tag === 'npc_conversation' || tag === 'conversation')
    && !/^\[?npc conversation\b/i.test(m.playerMessage ?? '')
    && !/^Overheard .+ in conversation\./i.test(m.playerMessage ?? '')
  );
  if (memories.length < 3) return patterns;

  // Time pattern — always visiting at the same time
  const times = memories.map(m => m.timeOfDay);
  const timeFreq: Record<string, number> = {};
  times.forEach(t => { timeFreq[t] = (timeFreq[t] ?? 0) + 1; });
  const dominantTime = Object.entries(timeFreq).sort((a, b) => b[1] - a[1])[0];
  if (dominantTime && dominantTime[1] >= 3) {
    patterns.push(`always comes around in the ${dominantTime[0]}`);
  }

  // Location pattern — always meeting at the same place
  const locs = memories.map(m => m.locationId);
  const locFreq: Record<string, number> = {};
  locs.forEach(l => { locFreq[l] = (locFreq[l] ?? 0) + 1; });
  const dominantLoc = Object.entries(locFreq).sort((a, b) => b[1] - a[1])[0];
  if (dominantLoc && dominantLoc[1] >= 3) {
    patterns.push(`always seems to be at the same place`);
  }

  // Topic pattern — always talking about the same thing
  const topics = memories.flatMap(m => m.topicsCovered).filter(t => !/^(npc conversation|conversation nearby|witnessed interaction)$/i.test(t));
  const topicFreq: Record<string, number> = {};
  topics.forEach(t => { topicFreq[t] = (topicFreq[t] ?? 0) + 1; });
  const dominantTopic = Object.entries(topicFreq).sort((a, b) => b[1] - a[1])[0];
  if (dominantTopic && dominantTopic[1] >= 3) {
    patterns.push(`keeps bringing up ${dominantTopic[0]}`);
  }

  // Trust trajectory — getting warmer or colder over time
  if (memories.length >= 4) {
    const recentTrust = memories.slice(-3).reduce((s, m) => s + m.trustDelta, 0);
    const earlierTrust = memories.slice(0, 3).reduce((s, m) => s + m.trustDelta, 0);
    if (recentTrust > earlierTrust + 3) patterns.push('has been growing on me lately');
    if (recentTrust < earlierTrust - 3) patterns.push('something has shifted — I trust them less now');
  }

  // Visit frequency pattern — how often player comes to this NPC
  if (state.playerVisitFrequency !== undefined && state.playerVisitFrequency > 5) {
    patterns.push('comes to see me regularly');
  }

  // Avoidance pattern
  if (state.playerAvoidanceScore !== undefined && state.playerAvoidanceScore > 50) {
    patterns.push('seems to avoid me — I see them around but they rarely come here');
  }

  // Interaction kind patterns — do they always talk, or sometimes just stand there?
  const kinds = memories.map(m => m.interactionKind).filter(Boolean);
  const kindFreq: Record<string, number> = {};
  kinds.forEach(k => { kindFreq[k!] = (kindFreq[k!] ?? 0) + 1; });
  if (kindFreq['silence'] >= 2 || kindFreq['presence'] >= 2) {
    patterns.push('sometimes just stands near me without speaking — unsettling or comforting depending on the relationship');
  }
  if (kindFreq['gesture'] >= 3) {
    patterns.push('communicates through gestures more than words');
  }

  return patterns;
}
