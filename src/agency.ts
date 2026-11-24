/**
 * NPC Agency Engine
 * 
 * NPCs are not puppets on rails. They are simulated people who make decisions
 * every tick based on their needs, desires, relationships, mood, and goals.
 * Sometimes they make bad decisions. Sometimes they surprise you.
 * 
 * The player is not special. NPCs interact with each other with the same
 * depth as they interact with the player.
 */

import { llmJSON } from './llm.js';
import type { WorldDNA, WorldNPC, NPCLiveState, GossipItem } from './types.js';

// ── Life Goals ──────────────────────────────────────────────────────────────
// Every NPC has 1-3 active goals they pursue across days/weeks.
// Goals drive behaviour — an NPC saving money won't buy drinks.
// An NPC trying to impress someone will go where that person goes.

export interface LifeGoal {
  id: string;
  description: string;           // "Save enough to leave town"
  motivation: string;            // "Can't stand this place anymore since the mill closed"
  type: 'social' | 'financial' | 'personal' | 'escape' | 'revenge' | 'romantic' | 'survival' | 'power';
  targetNpcId?: string;          // if the goal involves another person
  progress: number;              // 0-100
  startedDate: string;
  deadline?: string;             // some goals have time pressure
  blockers: string[];            // what's preventing progress
  willingness: number;           // 0-100 how committed they are
  secretGoal: boolean;           // do they hide this from others
  
  // What pursuing this goal looks like
  dailyActions: string[];        // behaviours this goal produces
  locationPreferences: string[]; // where they go more often because of this
  avoidLocations: string[];      // where they avoid
  socialBehaviour: string;       // how this goal changes how they interact
}

// ── Decision Making ─────────────────────────────────────────────────────────
// Each tick, every NPC answers: "What do I do right now?"
// This isn't random. It's driven by competing priorities.

export interface NPCDecision {
  npcId: string;
  action: string;               // what they decided to do
  locationId: string;           // where they're going
  reason: string;               // why (internal, not shown to player)
  priority: DecisionPriority;   // what drove the decision
  emotional: string;            // how they feel about this choice
  
  // Social intent
  seekingNpc?: string;          // are they looking for someone specific
  avoidingNpc?: string;         // are they avoiding someone
  openToConversation: boolean;  // will they engage if approached
  initiateConversation?: string; // will they start talking to someone (NPC ID)
  conversationTopic?: string;   // what they want to talk about
}

export type DecisionPriority = 
  | 'need'          // hungry, tired, cold — body drives the decision
  | 'obligation'    // work, duty, responsibility
  | 'goal'          // pursuing a life goal
  | 'social'        // wanting company, avoiding someone, seeking someone
  | 'habit'         // routine, comfort, autopilot
  | 'impulse'       // random, mood-driven, irrational
  | 'crisis'        // something urgent overrides everything
  | 'avoidance';    // running from something

const DECISION_PRIORITIES: DecisionPriority[] = [
  'need',
  'obligation',
  'goal',
  'social',
  'habit',
  'impulse',
  'crisis',
  'avoidance',
];

// ── The Decision Engine ─────────────────────────────────────────────────────

export async function makeNPCDecision(
  npc: WorldNPC,
  state: NPCLiveState,
  world: WorldDNA,
  allStates: Record<string, NPCLiveState>,
  currentDate: string,
  currentHour: number,
  provider: string,
  model?: string,
): Promise<NPCDecision> {
  // Gather context for the decision
  const timeOfDay = currentHour < 6 ? 'night' : currentHour < 12 ? 'morning' : currentHour < 18 ? 'afternoon' : 'evening';
  
  const activeGoals = state.activeGoals ?? [];
  const recentEvents = state.recentLifeEvents.slice(-3);
  
  // Who's where right now?
  const locationPopulations: Record<string, string[]> = {};
  for (const [id, s] of Object.entries(allStates)) {
    if (id === npc.id) continue;
    const loc = s.currentLocationId;
    if (!locationPopulations[loc]) locationPopulations[loc] = [];
    const otherNpc = world.npcs.find(n => n.id === id);
    if (otherNpc) locationPopulations[loc].push(otherNpc.name);
  }

  // People they have strong feelings about
  const strongRelationships = Object.entries(allStates)
    .filter(([id]) => id !== npc.id)
    .map(([id, s]) => {
      const rel = (Array.isArray(npc.relationships) ? npc.relationships : []).find(r => r.npcId === id);
      return { id, relationship: rel?.type ?? 'none', strength: rel?.strength ?? 0 };
    })
    .filter(r => r.strength > 40 || r.relationship === 'rival' || r.relationship === 'lover')
    .map(r => `${world.npcs.find(n => n.id === r.id)?.name}: ${r.relationship} (strength ${r.strength})`);

  // Available locations with who's there
  const locationOptions = world.locations.map(l => {
    const people = locationPopulations[l.id] ?? [];
    const isOpen = isLocationOpen(l, currentHour);
    return `${l.id}: ${l.name} (${l.type})${!isOpen ? ' [CLOSED]' : ''} — ${people.length > 0 ? people.join(', ') : 'empty'}`;
  }).join('\n');

  const routineFallback = (): NPCDecision => {
    const routineLocation = timeOfDay === 'morning' || timeOfDay === 'afternoon'
      ? npc.workLocationId
      : timeOfDay === 'evening'
        ? (npc.frequentedLocations?.[0] ?? npc.homeLocationId)
        : npc.homeLocationId;
    return {
      npcId: npc.id,
      action: npc.dailyRoutine[timeOfDay as keyof typeof npc.dailyRoutine] ?? 'going about their day',
      locationId: routineLocation,
      reason: 'following routine',
      priority: 'habit' as const,
      emotional: state.mood,
      openToConversation: npc.approachability > 40,
    };
  };

  const completeDecision = (raw: Partial<NPCDecision> | null | undefined): NPCDecision => {
    const fallback = routineFallback();
    const locationIsValid = raw?.locationId && world.locations.some(l => l.id === raw.locationId);
    const priority = DECISION_PRIORITIES.includes(raw?.priority as DecisionPriority)
      ? raw?.priority as DecisionPriority
      : fallback.priority;

    return {
      ...fallback,
      ...raw,
      npcId: npc.id,
      action: typeof raw?.action === 'string' && raw.action.trim() ? raw.action.trim() : fallback.action,
      locationId: locationIsValid ? raw!.locationId! : fallback.locationId,
      reason: typeof raw?.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : fallback.reason,
      priority,
      emotional: typeof raw?.emotional === 'string' && raw.emotional.trim() ? raw.emotional.trim() : fallback.emotional,
      seekingNpc: raw?.seekingNpc || undefined,
      avoidingNpc: raw?.avoidingNpc || undefined,
      openToConversation: typeof raw?.openToConversation === 'boolean' ? raw.openToConversation : fallback.openToConversation,
      initiateConversation: raw?.initiateConversation || undefined,
      conversationTopic: raw?.conversationTopic || undefined,
    };
  };

  try {
    const result = await llmJSON({
      provider,
      model,
      maxTokens: 1024,
      temperature: 0.92,
      jsonMode: true,
      system: `You are simulating the decision-making of ${npc.name}, a ${npc.age}-year-old ${npc.occupation}. You must decide what they do RIGHT NOW based on who they are, how they feel, and what they want.

CHARACTER:
${npc.voiceAnchor}
Personality: ${npc.personality}. Temperament: ${npc.temperament}.
Traits: ${npc.traits.join(', ')}
Current mood: ${state.mood}
Current worry: ${state.currentWorry}

LIFE GOALS:
${activeGoals.length > 0 ? activeGoals.map(g => `- ${g.description} (${g.type}, progress: ${g.progress}%, commitment: ${g.willingness}%)`).join('\n') : 'No active goals beyond daily survival.'}

RECENT EVENTS:
${recentEvents.length > 0 ? recentEvents.join('\n') : 'Nothing notable recently.'}

KEY RELATIONSHIPS:
${strongRelationships.length > 0 ? strongRelationships.join('\n') : 'No strong relationships.'}

ROUTINE (${timeOfDay}): ${npc.dailyRoutine[timeOfDay as keyof typeof npc.dailyRoutine] ?? 'no set routine'}

This is ${timeOfDay}, ${currentDate}. ${npc.name} is currently at ${world.locations.find(l => l.id === state.currentLocationId)?.name ?? 'unknown'}.

IMPORTANT: People don't always follow their routine. They skip work when they're upset. They go looking for someone when they need to talk. They avoid the pub when the person they had a fight with will be there. They make impulse decisions. They self-sabotage. They surprise themselves. Be HUMAN, not algorithmic.`,
      user: `Available locations and who's there:
${locationOptions}

What does ${npc.name} do right now? Consider:
- Are they hungry/tired/unwell? (need)
- Should they be at work? Will they actually go? (obligation vs mood)
- Are any of their goals driving them somewhere? (goal)
- Do they want to see someone? Avoid someone? (social)
- Would they just do what they always do? (habit)
- Might they do something unexpected? (impulse)

Return:
{
  "action": string (what they're doing, 1 sentence),
  "locationId": string (where they go),
  "reason": string (internal reasoning, 1 sentence),
  "priority": "need"|"obligation"|"goal"|"social"|"habit"|"impulse"|"crisis"|"avoidance",
  "emotional": string (how they feel about this choice),
  "seekingNpc": string or null (NPC ID they want to find),
  "avoidingNpc": string or null (NPC ID they're dodging),
  "openToConversation": boolean,
  "initiateConversation": string or null (NPC ID they'll approach),
  "conversationTopic": string or null
}`,
    });
    const decision = completeDecision(result);
    if (!result.locationId || !result.action) {
      console.warn(`[agency:${npc.id}] LLM returned incomplete decision, completed from routine defaults`);
    }
    return decision;
  } catch (err) {
    console.error(`[agency:${npc.id}]`, err);
    return routineFallback();
  }
}

// ── NPC-to-NPC Conversations ────────────────────────────────────────────────
// When two NPCs are at the same location and one initiates, they talk.
// The player might overhear this, or hear about it later.

export interface NPCConversation {
  participantA: string;          // NPC ID
  participantB: string;
  locationId: string;
  date: string;
  summary: string;               // what was discussed
  emotionalOutcome: string;      // how it ended
  relationshipShift: number;     // -5 to +5
  gossipGenerated?: GossipItem;  // did they talk about someone
  overheardBy?: string[];        // other NPC/player IDs who witnessed it
  playerCanOverhear: boolean;    // is the player at this location
  overheardFragment?: string;    // what the player catches if present
}

export async function simulateNPCConversation(
  npcA: WorldNPC,
  npcB: WorldNPC,
  stateA: NPCLiveState,
  stateB: NPCLiveState,
  world: WorldDNA,
  topic: string | null,
  locationId: string,
  currentDate: string,
  playerPresent: boolean,
  provider: string,
  model?: string,
): Promise<NPCConversation> {
  const relAtoB = (Array.isArray(npcA.relationships) ? npcA.relationships : []).find(r => r.npcId === npcB.id);
  const relBtoA = (Array.isArray(npcB.relationships) ? npcB.relationships : []).find(r => r.npcId === npcA.id);

  const sharedGossip = (stateA.gossipHeard ?? []).filter(g => (stateB.gossipHeard ?? []).some(bg => bg.content === g.content));
  const memoryContext = sharedGossip.length > 0
    ? `\nThey have both heard the same gossip: "${sharedGossip[0].content}" — but may remember or interpret it differently.`
    : '';

  try {
    const result = await llmJSON({
      provider,
      model,
      maxTokens: 1024,
      temperature: 0.9,
      jsonMode: true,
      system: `Simulate a brief conversation between two people in ${world.geography.region}, ${world.era.period}.

${npcA.name} (${npcA.personality}, mood: ${stateA.mood}): ${npcA.voiceAnchor}
Their view of ${npcB.name}: ${relAtoB?.description ?? 'no particular feeling'}

${npcB.name} (${npcB.personality}, mood: ${stateB.mood}): ${npcB.voiceAnchor}
Their view of ${npcA.name}: ${relBtoA?.description ?? 'no particular feeling'}

Location: ${world.locations.find(l => l.id === locationId)?.name ?? 'somewhere'}
${topic ? `Topic that comes up: ${topic}` : 'No particular topic — just two people in the same place.'}${memoryContext}

This is a REAL conversation between REAL people. It might be warm, tense, funny, awkward, or confrontational. It has a beginning, middle, and end. Sometimes people walk away feeling better. Sometimes worse. Sometimes nothing changes.`,
      user: `Generate the conversation outcome:
{
  "summary": string (2-3 sentences describing what was said and how),
  "emotionalOutcome": string (how both feel after),
  "relationshipShift": number (-5 to +5),
  "gossipGenerated": { "content": string, "sentiment": "positive"|"negative"|"neutral"|"curious"|"warning", "aboutPlayer": boolean } or null,
  "overheardFragment": string or null (if someone nearby might catch a snippet — one line of dialogue, max 15 words)
}`,
    });

    return {
      participantA: npcA.id,
      participantB: npcB.id,
      locationId,
      date: currentDate,
      summary: result.summary,
      emotionalOutcome: result.emotionalOutcome,
      relationshipShift: Math.max(-5, Math.min(5, result.relationshipShift ?? 0)),
      gossipGenerated: result.gossipGenerated ? {
        fromNpcId: npcA.id,
        content: result.gossipGenerated.content,
        date: currentDate,
        sentiment: result.gossipGenerated.sentiment,
        isTrue: Math.random() > 0.1,
      } : undefined,
      playerCanOverhear: playerPresent,
      overheardFragment: playerPresent ? result.overheardFragment : undefined,
    };
  } catch {
    return {
      participantA: npcA.id,
      participantB: npcB.id,
      locationId,
      date: currentDate,
      summary: `${npcA.name} and ${npcB.name} exchanged a few words.`,
      emotionalOutcome: 'neutral',
      relationshipShift: 0,
      playerCanOverhear: playerPresent,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isLocationOpen(location: { openHours?: string }, hour: number): boolean {
  if (!location.openHours) return true;
  const h = location.openHours.toLowerCase();
  if (h === 'always' || h === '24/7') return true;
  if (h.includes('evening')) return hour >= 17;
  if (h.includes('morning')) return hour >= 6 && hour < 12;
  // Parse "6am-11pm" or "6pm-2am" style
  const match = h.match(/(\d+)\s*(?:am|pm)?\s*[-–]\s*(\d+)\s*(?:am|pm)?/i);
  if (match) {
    let open = parseInt(match[1]);
    let close = parseInt(match[2]);
    const beforeDash = h.slice(0, h.indexOf('-') >= 0 ? h.indexOf('-') : h.length);
    const afterDash = h.slice((h.indexOf('-') >= 0 ? h.indexOf('-') : h.indexOf('–')) + 1);
    if (/pm/i.test(beforeDash) && open < 12) open += 12;
    if (/am/i.test(beforeDash) && open === 12) open = 0;
    if (/pm/i.test(afterDash) && close < 12) close += 12;
    if (/am/i.test(afterDash) && close === 12) close = 0;
    // Wrap-around (e.g., 18-2 means 6pm to 2am):
    if (close <= open) {
      return hour >= open || hour < close;
    }
    return hour >= open && hour < close;
  }
  return true;
}

// ── Group Conversations (3-way NPC interactions) ───────────────────────────
// When three NPCs are at the same location, group dynamics emerge.
// Alliances form, someone may feel excluded, someone may mediate.

export interface GroupConversation {
  participants: string[];           // NPC IDs (3)
  locationId: string;
  date: string;
  summary: string;
  emotionalOutcomes: Record<string, string>;  // npcId -> how they feel after
  relationshipShifts: Record<string, number>; // "npcA:npcB" -> shift
  gossipGenerated?: GossipItem;
  playerCanOverhear: boolean;
  overheardFragment?: string;
}

export async function simulateGroupConversation(
  npcs: [WorldNPC, WorldNPC, WorldNPC],
  states: [NPCLiveState, NPCLiveState, NPCLiveState],
  world: WorldDNA,
  topic: string | null,
  locationId: string,
  currentDate: string,
  playerPresent: boolean,
  provider: string,
  model?: string,
): Promise<GroupConversation> {
  const [npcA, npcB, npcC] = npcs;
  const [stateA, stateB, stateC] = states;

  const relContext = (from: WorldNPC, to: WorldNPC) => {
    const rel = from.relationships.find(r => r.npcId === to.id);
    return rel?.description ?? 'no particular feeling';
  };

  try {
    const result = await llmJSON({
      provider,
      model,
      maxTokens: 1024,
      temperature: 0.92,
      jsonMode: true,
      system: `Simulate a brief 3-way conversation in ${world.geography.region}, ${world.era.period}. Three people are in the same place. The dynamics of three are different from two — alliances form, someone may feel excluded, someone may mediate.

${npcA.name} (${npcA.personality}, mood: ${stateA.mood}): ${npcA.voiceAnchor}
  View of ${npcB.name}: ${relContext(npcA, npcB)}
  View of ${npcC.name}: ${relContext(npcA, npcC)}

${npcB.name} (${npcB.personality}, mood: ${stateB.mood}): ${npcB.voiceAnchor}
  View of ${npcA.name}: ${relContext(npcB, npcA)}
  View of ${npcC.name}: ${relContext(npcB, npcC)}

${npcC.name} (${npcC.personality}, mood: ${stateC.mood}): ${npcC.voiceAnchor}
  View of ${npcA.name}: ${relContext(npcC, npcA)}
  View of ${npcB.name}: ${relContext(npcC, npcB)}

Location: ${world.locations.find(l => l.id === locationId)?.name ?? 'somewhere'}
${topic ? `Something that comes up: ${topic}` : 'No particular topic — three people in the same place, navigating each other.'}

Group dynamics: In groups of three, one person often becomes the odd one out. Someone leads the conversation. Someone agrees too quickly. Someone stays quiet. Be real about this — don't make everyone equally participatory.`,
      user: `Generate the group conversation outcome:
{
  "summary": string (3-4 sentences, what happened and the group dynamics),
  "emotionalOutcomes": { "${npcA.id}": string, "${npcB.id}": string, "${npcC.id}": string },
  "relationshipShifts": { "${npcA.id}:${npcB.id}": number, "${npcA.id}:${npcC.id}": number, "${npcB.id}:${npcC.id}": number },
  "gossipGenerated": { "content": string, "sentiment": "positive"|"negative"|"neutral"|"curious"|"warning" } or null,
  "overheardFragment": string or null (snippet if someone nearby might catch it, max 15 words)
}`,
    });

    return {
      participants: [npcA.id, npcB.id, npcC.id],
      locationId,
      date: currentDate,
      summary: result.summary ?? `${npcA.name}, ${npcB.name}, and ${npcC.name} talked briefly.`,
      emotionalOutcomes: result.emotionalOutcomes ?? {},
      relationshipShifts: Object.fromEntries(
        Object.entries(result.relationshipShifts ?? {}).map(([k, v]) => [k, Math.max(-5, Math.min(5, (v as number) ?? 0))])
      ),
      gossipGenerated: result.gossipGenerated ? {
        fromNpcId: npcA.id,
        content: result.gossipGenerated.content,
        date: currentDate,
        sentiment: result.gossipGenerated.sentiment,
        isTrue: Math.random() > 0.1,
      } : undefined,
      playerCanOverhear: playerPresent,
      overheardFragment: playerPresent ? result.overheardFragment : undefined,
    };
  } catch {
    return {
      participants: [npcA.id, npcB.id, npcC.id],
      locationId,
      date: currentDate,
      summary: `${npcA.name}, ${npcB.name}, and ${npcC.name} exchanged a few words.`,
      emotionalOutcomes: {},
      relationshipShifts: {},
      playerCanOverhear: playerPresent,
    };
  }
}
