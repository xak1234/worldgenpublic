/**
 * NPC Social Engine
 * NPCs autonomously form, maintain, and break relationships with each other AND the player.
 * Friendships aren't guaranteed — they must be earned, and can be lost.
 */

import type { NPCLiveState, WorldNPC, GossipItem, SimulationTick, WorldDNA } from './types.js';
import { llmJSON, llmText } from './llm.js';

const INTERACTION_EVAL_TIMEOUT_MS = parseInt(process.env.INTERACTION_EVAL_TIMEOUT ?? '90000', 10);

const GOSSIP_BASE_CHANCE = 0.35;
const GOSSIP_SERIOUSNESS_WEIGHT = 0.11;

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

// ── Compatibility scoring ───────────────────────────────────────────────────
// NPCs evaluate each other (and the player) based on multiple factors.
// This runs between ticks to simulate offscreen social life.

export interface CompatibilityFactors {
  sharedClass: number;          // same social class = easier
  sharedLocation: number;       // see each other often = familiarity
  personalityMatch: number;     // complementary or clashing traits
  ageProximity: number;         // similar age = common ground
  sharedInterests: number;      // overlapping concerns/opinions
  historyWeight: number;        // past interactions compound
  gossipInfluence: number;      // what they've heard about the other
  moodAlignment: number;        // both in good/bad moods at the same time
}

export function calculateCompatibility(a: WorldNPC, b: WorldNPC): number {
  let score = 50; // neutral baseline

  // Social class — same class gives a boost, big gap creates friction
  if (a.socialClass === b.socialClass) score += 15;
  
  // Shared locations — people who frequent the same places bond naturally
  const sharedLocations = a.frequentedLocations.filter(l => 
    b.frequentedLocations.includes(l) || b.homeLocationId === l || b.workLocationId === l
  );
  score += Math.min(sharedLocations.length * 8, 20);

  // Age proximity — within 10 years gets a bonus
  const ageDiff = Math.abs(a.age - b.age);
  if (ageDiff <= 5) score += 10;
  else if (ageDiff <= 10) score += 5;
  else if (ageDiff > 25) score -= 5;

  // Personality clashes — some combinations just don't work
  const clashPairs = [
    ['aggressive', 'timid'], ['loud', 'reserved'], ['suspicious', 'open'],
    ['domineering', 'domineering'], ['volatile', 'anxious'],
  ];
  for (const [t1, t2] of clashPairs) {
    if (
      (a.traits.some(t => t.toLowerCase().includes(t1)) && b.traits.some(t => t.toLowerCase().includes(t2))) ||
      (a.traits.some(t => t.toLowerCase().includes(t2)) && b.traits.some(t => t.toLowerCase().includes(t1)))
    ) {
      score -= 15;
    }
  }

  // Complementary traits — some combinations click
  const bondPairs = [
    ['funny', 'warm'], ['loyal', 'honest'], ['generous', 'grateful'],
    ['protective', 'vulnerable'], ['curious', 'knowledgeable'],
  ];
  for (const [t1, t2] of bondPairs) {
    if (
      (a.traits.some(t => t.toLowerCase().includes(t1)) && b.traits.some(t => t.toLowerCase().includes(t2))) ||
      (a.traits.some(t => t.toLowerCase().includes(t2)) && b.traits.some(t => t.toLowerCase().includes(t1)))
    ) {
      score += 12;
    }
  }

  // Approachability — closed-off people are harder to befriend
  score += Math.floor((a.approachability + b.approachability) / 20) - 5;

  return Math.max(0, Math.min(100, score));
}

// ── Friendship decision engine ──────────────────────────────────────────────
// Each tick, NPCs evaluate their relationships and decide to:
// - Seek out someone they like
// - Avoid someone they don't
// - Gossip about someone
// - Change their opinion based on events

export interface SocialDecision {
  npcId: string;
  action: 'seek' | 'avoid' | 'gossip' | 'confront' | 'help' | 'ignore' | 'forgive' | 'resent';
  targetId: string;        // NPC or player
  reason: string;
  moodAfter: string;
}

function hasHeardGossip(state: NPCLiveState, gossip: GossipItem): boolean {
  const content = gossip.content.trim().toLowerCase();
  return (state.gossipHeard ?? []).some(g => g.content.trim().toLowerCase() === content);
}

function gossipSeriousness(gossip: Pick<GossipItem, 'content' | 'sentiment'>): number {
  let score = gossip.sentiment === 'warning' ? 3 : gossip.sentiment === 'negative' ? 2 : 1;
  if (/\b(affair|blackmail|secret|expose|caught|scandal|lie|lied|frame|accuse|blame|theft|stole|violence|pregnant|betray)\b/i.test(gossip.content)) {
    score += 2;
  }
  return Math.max(1, Math.min(5, score));
}

function describePlayerGossip(npc: WorldNPC, state: NPCLiveState, playerName: string, playerReputation: string): string {
  const subject = playerName?.trim() || 'the newcomer';
  if (state.playerOpinion?.trim()) return `${npc.name} said ${subject}: ${state.playerOpinion}`;
  if (state.fear > 55) return `${npc.name} warned people to be careful around ${subject}`;
  if (state.warmth < 30) return `${npc.name} said ${subject} has been rubbing people the wrong way`;
  if (state.warmth > 65) return `${npc.name} said ${subject} might be alright`;
  if (playerReputation && playerReputation !== 'unknown') return `${npc.name} mentioned that ${subject} has a reputation as ${playerReputation}`;
  return `${npc.name} mentioned ${subject}`;
}

export async function runSocialTick(
  world: WorldDNA,
  npcStates: Record<string, NPCLiveState>,
  currentDate: string,
  timeOfDay: string,
  provider: string,
  model?: string,
  playerName = 'the newcomer',
  playerReputation = 'unknown',
): Promise<SimulationTick[]> {
  const ticks: SimulationTick[] = [];

  // Pre-compute all NPC locations once at the start of the tick to avoid
  // non-deterministic results from repeated Math.random() calls in resolveNPCLocation.
  const npcLocations = new Map(world.npcs.map(n => [n.id, resolveNPCLocation(n, timeOfDay)]));

  // Accumulate emotional contagion deltas to prevent cascading amplification within a single tick.
  const contagionDeltas = new Map<string, Record<string, number>>();
  const contagionLogs = new Map<string, Array<{ fromNpcId: string; emotion: string; intensity: number; date: string; timeOfDay: string }>>();

  for (const npc of world.npcs) {
    const state = npcStates[npc.id];
    if (!state) continue;

    // Use pre-computed location for deterministic co-location checks
    const locationId = npcLocations.get(npc.id)!;
    const activity = resolveNPCActivity(npc, timeOfDay);

    // Find other NPCs at the same location
    const colocated = world.npcs.filter(other => {
      if (other.id === npc.id) return false;
      return npcLocations.get(other.id) === locationId;
    });

    // NPC-to-NPC interactions (offscreen)
    const npcInteractions: { npcId: string; delta: number; reason: string }[] = [];
    const gossipExchanged: GossipItem[] = [];

    for (const other of colocated) {
      const otherState = npcStates[other.id];
      if (!otherState) continue;

      // Existing relationship
      const existing = (Array.isArray(npc.relationships) ? npc.relationships : []).find(r => r.npcId === other.id);
      const compatibility = calculateCompatibility(npc, other);

      // Natural drift — people who see each other often slowly bond or friction builds
      if (compatibility > 65 && (!existing || existing.strength < 80)) {
        npcInteractions.push({
          npcId: other.id,
          delta: Math.random() > 0.5 ? 2 : 1,
          reason: 'natural familiarity',
        });
      } else if (compatibility < 35 && existing && existing.strength > 20) {
        npcInteractions.push({
          npcId: other.id,
          delta: Math.random() > 0.5 ? -2 : -1,
          reason: 'personality friction',
        });
      }

      // Gossip exchange — NPCs pass on what they know, with occasional fresh chatter.
      const gossipBefore = gossipExchanged.length;
      if (Math.random() < world.simulationRules.gossipSpeed) {
        const shareableGossip = (state.gossipHeard ?? []).filter(g => !hasHeardGossip(otherState, g));
        const weightedGossip = shareableGossip.flatMap(g => Array(gossipSeriousness(g)).fill(g));
        if (weightedGossip.length > 0 && Math.random() < GOSSIP_BASE_CHANCE + (Math.max(...shareableGossip.map(gossipSeriousness)) * GOSSIP_SERIOUSNESS_WEIGHT)) {
          const source = weightedGossip[Math.floor(Math.random() * weightedGossip.length)];
          gossipExchanged.push({
            ...source,
            fromNpcId: npc.id,
            date: currentDate,
            isTrue: Math.random() < 0.08 ? !source.isTrue : source.isTrue,
          });
        } else if (state.totalInteractions > 0 && Math.random() < 0.25) {
          const sentiment = state.warmth > 60 ? 'positive'
            : state.warmth < 30 ? 'negative'
            : 'neutral';
          gossipExchanged.push({
            fromNpcId: npc.id,
            content: describePlayerGossip(npc, state, playerName, playerReputation),
            date: currentDate,
            sentiment,
            isTrue: Math.random() > 0.15, // gossip is sometimes wrong
          });
        }
      }

      // Deliver only gossip generated during THIS conversation (not from prior co-located NPCs)
      for (let gi = gossipBefore; gi < gossipExchanged.length; gi++) {
        otherState.gossipHeard = otherState.gossipHeard ?? [];
        if (!hasHeardGossip(otherState, gossipExchanged[gi])) {
          otherState.gossipHeard.push(gossipExchanged[gi]);
        }
      }

      // Emotional contagion — NPCs catch moods from each other (deltas accumulated below)
      const otherAffect: any = otherState.innerLife?.affect;
      const selfAffect: any = state.innerLife?.affect;
      if (otherAffect && selfAffect) {
        const contagiousEmotions = ['fear', 'anger', 'joy', 'sadness', 'anxiety'];
        for (const emotion of contagiousEmotions) {
          const otherIntensity = otherAffect[emotion] ?? 0;
          if (otherIntensity > 0.5) {
            const spreadIntensity = otherIntensity * 0.3;
            const currentIntensity = selfAffect[emotion] ?? 0;
            if (spreadIntensity > currentIntensity) {
              // Accumulate delta instead of mutating in-place to prevent cascading amplification
              if (!contagionDeltas.has(npc.id)) {
                contagionDeltas.set(npc.id, {});
              }
              const deltas = contagionDeltas.get(npc.id)!;
              const deltaValue = spreadIntensity * 0.4;
              deltas[emotion] = Math.max(deltas[emotion] ?? 0, deltaValue);

              // Log the contagion
              if (!contagionLogs.has(npc.id)) {
                contagionLogs.set(npc.id, []);
              }
              contagionLogs.get(npc.id)!.push({
                fromNpcId: other.id,
                emotion,
                intensity: spreadIntensity,
                date: currentDate,
                timeOfDay,
              });
            }
          }
        }
      }
    }

    // Random life events — things happen to NPCs between interactions
    let lifeEvent: string | undefined;
    let moodChange: string | undefined;
    const eventRoll = Math.random();
    
    if (eventRoll < 0.05) {
      // Something significant happened
      lifeEvent = await generateLifeEvent(npc, world, provider, model);
      moodChange = eventRoll < 0.02 ? 'upset' : 'preoccupied';
    }

    ticks.push({
      npcId: npc.id,
      date: currentDate,
      timeOfDay,
      locationId,
      activity,
      moodChange,
      lifeEvent,
      gossipExchanged: gossipExchanged.length > 0 ? gossipExchanged : undefined,
      relationshipChanges: npcInteractions.length > 0 ? npcInteractions : undefined,
    });
  }

  // Apply all accumulated emotional contagion deltas after the full iteration
  for (const [npcId, deltas] of contagionDeltas) {
    const state = npcStates[npcId];
    const selfAffect: any = state?.innerLife?.affect;
    if (!selfAffect) continue;
    for (const [emotion, delta] of Object.entries(deltas)) {
      const current = selfAffect[emotion] ?? 0;
      selfAffect[emotion] = Math.min(1, current + delta);
    }
    // Append contagion log entries and trim
    const logs = contagionLogs.get(npcId) ?? [];
    if (logs.length > 0 && state) {
      state.emotionalContagionLog = state.emotionalContagionLog ?? [];
      state.emotionalContagionLog.push(...logs);
      if (state.emotionalContagionLog.length > 15) {
        state.emotionalContagionLog = state.emotionalContagionLog.slice(-15);
      }
    }
  }

  return ticks;
}

// ── Location resolution based on routine ────────────────────────────────────

function resolveNPCLocation(npc: WorldNPC, timeOfDay: string): string {
  const period = timeOfDay.toLowerCase();
  
  if (period.includes('morning') || period.includes('dawn')) {
    // Morning: at home or heading to work
    return Math.random() > 0.3 ? npc.workLocationId : npc.homeLocationId;
  }
  const freq = npc.frequentedLocations ?? [];
  if (period.includes('afternoon') || period.includes('midday')) {
    // Afternoon: at work or frequent spot
    return Math.random() > 0.4 ? npc.workLocationId
      : freq.length ? (freq[Math.floor(Math.random() * freq.length)] ?? npc.workLocationId) : npc.workLocationId;
  }
  if (period.includes('evening') || period.includes('dusk')) {
    // Evening: pub, social spot, or home
    return freq.length ? (freq[Math.floor(Math.random() * freq.length)] ?? npc.homeLocationId) : npc.homeLocationId;
  }
  // Night: home
  return npc.homeLocationId;
}

function resolveNPCActivity(npc: WorldNPC, timeOfDay: string): string {
  const period = timeOfDay.toLowerCase();
  if (period.includes('morning')) return npc.dailyRoutine.morning;
  if (period.includes('afternoon')) return npc.dailyRoutine.afternoon;
  if (period.includes('evening')) return npc.dailyRoutine.evening;
  return npc.dailyRoutine.night;
}

// ── Life event generation ───────────────────────────────────────────────────

async function generateLifeEvent(npc: WorldNPC, world: WorldDNA, provider: string, model?: string): Promise<string> {
  try {
    return await llmText({
      provider,
      model,
      maxTokens: 100,
      temperature: 0.95,
      system: `Generate a brief life event (1 sentence) for ${npc.name}, a ${npc.age}-year-old ${npc.occupation} in ${world.geography.region}, ${world.era.period}. Something mundane but real — not dramatic. The kind of thing that changes someone's mood for a day or two. Examples: got bad news from a relative, had an argument with a neighbour, found out rent is going up, received a compliment that stuck with them, burnt dinner and it annoyed them for hours.`,
      user: `Traits: ${npc.traits.join(', ')}. Current concerns: ${npc.coreConcerns.join(', ')}. Generate one life event.`,
    });
  } catch {
    return 'had an unremarkable but slightly tiring day';
  }
}

// ── Player interaction evaluation ───────────────────────────────────────────
// When the player talks to an NPC, the NPC evaluates the interaction
// and updates their internal state. This is the "should I friend this person" logic.

export interface InteractionEvaluation {
  trustDelta: number;         // -10 to +10
  warmthDelta: number;
  respectDelta: number;
  familiarityDelta: number;
  attractionDelta: number;
  fearDelta: number;
  newRelationship: string;    // relationship level after this interaction
  npcThought: string;         // what the NPC privately thinks after
  willSeekOut: boolean;       // will the NPC look for the player next time
  willAvoid: boolean;         // will the NPC avoid the player
  willGossip: boolean;        // will the NPC tell others about this
  gossipContent?: string;     // what they'd say
}

export async function evaluateInteraction(
  npc: WorldNPC,
  npcState: NPCLiveState,
  playerInteraction: string,
  npcReply: string,
  world: WorldDNA,
  provider: string,
  model?: string,
): Promise<InteractionEvaluation> {
  // Sanitize player input: length-limit and strip null bytes
  const safeInteraction = (playerInteraction ?? '').slice(0, 800).replace(/\0/g, '');

  const raw = await llmJSON({
    provider,
    model,
    maxTokens: 2048,
    temperature: 0.8,
    jsonMode: true,
    thinking: false,
    timeoutMs: INTERACTION_EVAL_TIMEOUT_MS,
    system: `You are evaluating how ${npc.name} feels after an interaction with a newcomer. ${npc.name} is ${npc.personality}, ${npc.temperament} under pressure, approachability ${npc.approachability}/100. They need ${npc.loyaltyThreshold} positive interactions before trusting someone. They've had ${npcState.totalInteractions} interactions so far. Current trust: ${npcState.trustLevel}/100. Current warmth: ${npcState.warmth}/100.

${npc.voiceAnchor}

IMPORTANT: People don't become friends instantly. Trust builds slowly through repeated positive interactions. One good conversation moves the needle a little. One bad one can undo several good ones. ${npc.name} judges based on: did the person seem genuine? Did they listen? Did they share something real? Did they push too hard? Were they respectful of boundaries?

Impossible or magical-seeming acts should matter. They may increase awe, fear, curiosity, reverence, suspicion, gossip, or avoidance depending on who ${npc.name} is and what this world believes.

Gossip culture: ${world.simulationRules.trustCulture}. Reputation matters: ${world.simulationRules.reputationMatters}.`,
    user: `What the newcomer did or said: ${safeInteraction}
${npc.name}'s response: "${npcReply}"
Interaction #${npcState.totalInteractions + 1}. Current relationship: ${npcState.relationship}.

Evaluate this interaction. Return:
{
  "trustDelta": number (-10 to +10, usually -2 to +3),
  "warmthDelta": number (-10 to +10),
  "respectDelta": number (-10 to +10),
  "familiarityDelta": number (always +1 to +5, you always get to know someone a bit more),
  "attractionDelta": number (-5 to +5),
  "fearDelta": number (-5 to +5),
  "newRelationship": string (stranger/face/nodding/acquaintance/friendly/friend/close_friend/intimate/hostile/wary),
  "npcThought": string (what ${npc.name} privately thinks after this — 1 sentence, in their voice),
  "willSeekOut": boolean,
  "willAvoid": boolean,
  "willGossip": boolean,
  "gossipContent": string or null
}`,
  });

  // Validate and clamp all LLM-returned values to documented ranges
  const validRelationships = ['stranger', 'face', 'nodding', 'acquaintance', 'friendly', 'friend', 'close_friend', 'intimate', 'hostile', 'wary'];
  return {
    trustDelta: clamp(raw.trustDelta ?? 0, -10, 10),
    warmthDelta: clamp(raw.warmthDelta ?? 0, -10, 10),
    respectDelta: clamp(raw.respectDelta ?? 0, -10, 10),
    familiarityDelta: clamp(raw.familiarityDelta ?? 1, 1, 5),
    attractionDelta: clamp(raw.attractionDelta ?? 0, -5, 5),
    fearDelta: clamp(raw.fearDelta ?? 0, -5, 5),
    newRelationship: validRelationships.includes(raw.newRelationship) ? raw.newRelationship : npcState.relationship ?? 'stranger',
    npcThought: typeof raw.npcThought === 'string' ? raw.npcThought : '',
    willSeekOut: Boolean(raw.willSeekOut),
    willAvoid: Boolean(raw.willAvoid),
    willGossip: Boolean(raw.willGossip),
    gossipContent: typeof raw.gossipContent === 'string' ? raw.gossipContent : undefined,
  };
}
