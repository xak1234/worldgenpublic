/**
 * Cognitive Tick
 * 
 * The engine that runs between interactions. This is where the person LIVES.
 * Not during dialogue — that's just the visible surface. The tick is the
 * continuous internal experience that makes someone a someone.
 * 
 * Each tick, every NPC:
 * 1. PERCEIVES — where am I, who's here, what's my body doing
 * 2. FEELS — update affect based on perception + inertia
 * 3. PROCESSES — post-event processing if there's something unresolved
 * 4. THINKS — inner monologue generates thoughts
 * 5. UPDATES — theory of mind, self-concept, intentions shift
 * 6. DECIDES — what to do next (handled by agency.ts)
 */

import { llmJSON, llmText } from './llm.js';
import type { WorldDNA, WorldNPC, NPCLiveState } from './types.js';
import type {
  InnerLife, AffectVector, ProcessingType, AttachmentStyle,
  TheoryOfPlayer, PsychologicalWound,
} from './innerLife.js';
import { blendAffect, describeAffect } from './innerLife.js';

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/**
 * Theory-of-player scores are 0-100. Some models answer on a 0-1 scale (e.g. 0.8), which used to be
 * stored as 0.8/100 and silently disabled threat-driven defenses and interest-driven approaches.
 */
function percentScale(v: number): number {
  return clamp(v > 0 && v < 1 ? v * 100 : v, 0, 100);
}

// ── Post-Event Processing ───────────────────────────────────────────────────

export interface PEPResult {
  // The processed (possibly distorted) version of what happened
  processedMemory: string;
  distortionLevel: number;       // 0-1 how far from reality
  
  // Emotional aftermath
  affectShift: Partial<AffectVector>;
  
  // Updated beliefs
  updatedTheory: Partial<TheoryOfPlayer>;
  newIntentions: string[];       // what they plan for next interaction
  
  // Inner monologue output
  thoughts: string[];            // 1-3 thoughts generated during processing
  
  // Did a wound get triggered?
  woundTriggered: boolean;
  defenseActivated: string | null;
  
  // Self-concept impact (rare, only for significant interactions)
  selfConceptShift?: string;     // new "I am..." statement, or null
}

export async function runPostEventProcessing(
  npc: WorldNPC,
  innerLife: InnerLife,
  interactionSummary: string,
  playerMessage: string,
  npcReply: string,
  emotionalTone: string,
  trustDelta: number,
  world: WorldDNA,
  provider: string,
  model?: string,
): Promise<PEPResult | null> {
  // Check if this person even runs PEP
  const pt = innerLife.selfAwareness.processingType;
  
  if (pt === 'present') {
    // Grounded person — processes briefly and accurately, moves on
    return {
      processedMemory: interactionSummary,
      distortionLevel: 0,
      affectShift: trustDelta > 0 ? { joy: 0.1, trust: 0.05 } : trustDelta < 0 ? { sadness: 0.05 } : {},
      updatedTheory: {},
      newIntentions: [],
      thoughts: [`That was fine. ${trustDelta > 0 ? 'They seem decent.' : trustDelta < 0 ? 'Not sure about that.' : 'Nothing much to it.'}`],
      woundTriggered: false,
      defenseActivated: null,
    };
  }
  
  if (pt === 'dissociation') {
    // Doesn't process. Numb. The interaction barely registered.
    return {
      processedMemory: 'Something happened but the details are vague.',
      distortionLevel: 0.5,
      affectShift: {},
      updatedTheory: {},
      newIntentions: [],
      thoughts: [],
      woundTriggered: false,
      defenseActivated: null,
    };
  }

  // Check for wound triggers
  let woundTriggered = false;
  let triggeredWound: PsychologicalWound | null = null;
  for (const wound of innerLife.wounds) {
    const triggered = wound.triggerWords.some(tw => 
      playerMessage.toLowerCase().includes(tw.toLowerCase())
    ) || wound.triggerSituations.some(ts =>
      interactionSummary.toLowerCase().includes(ts.toLowerCase())
    );
    if (triggered) {
      woundTriggered = true;
      triggeredWound = wound;
      break;
    }
  }

  // Determine PEP intensity based on processing type and what happened
  const isSignificant = Math.abs(trustDelta) >= 2 || woundTriggered;
  
  if (pt === 'brief_reflection' && !isSignificant) {
    // Healthy person, nothing major happened — brief honest processing
    return {
      processedMemory: interactionSummary,
      distortionLevel: 0.05,
      affectShift: { anticipation: 0.1 },
      updatedTheory: {},
      newIntentions: [],
      thoughts: ['That was what it was. Nothing to dwell on.'],
      woundTriggered: false,
      defenseActivated: null,
    };
  }

  if (pt === 'suppression') {
    // Buries it. Appears fine. But the affect shifts underneath.
    const suppressedShift: Partial<AffectVector> = trustDelta < 0
      ? { resentment: 0.15, anger: 0.1 } // builds up silently
      : {};
    
    return {
      processedMemory: interactionSummary, // remembers facts, not feelings
      distortionLevel: 0.1,
      affectShift: suppressedShift,
      updatedTheory: {},
      newIntentions: [],
      thoughts: [],  // suppression produces no conscious thoughts
      woundTriggered,
      defenseActivated: woundTriggered ? innerLife.defenses.primary : null,
    };
  }

  // For moderate and heavy ruminators — this is where the LLM does the work
  try {
    const result = await llmJSON({
      provider,
      model,
      maxTokens: 768,
      temperature: 0.88,
      jsonMode: true,
      system: buildPEPSystem(npc, innerLife, world, pt, triggeredWound),
      user: buildPEPUser(npc, innerLife, interactionSummary, playerMessage, npcReply, emotionalTone, trustDelta),
    });

    // Validate and clamp all LLM-returned numeric values to documented ranges
    const rawDistortion = result.distortionLevel ?? (pt === 'heavy_rumination' ? 0.4 : 0.15);
    const rawAffectShift = result.affectShift ?? {};
    const clampedAffectShift: Partial<AffectVector> = {};
    for (const [key, value] of Object.entries(rawAffectShift)) {
      if (typeof value === 'number') {
        (clampedAffectShift as any)[key] = clamp(value, -0.3, 0.3);
      }
    }

    const rawTheory = result.updatedTheory ?? {};
    const clampedTheory: Partial<TheoryOfPlayer> = {
      ...(typeof rawTheory.perceivedIntent === 'string' ? { perceivedIntent: rawTheory.perceivedIntent } : {}),
      ...(typeof rawTheory.perceivedCharacter === 'string' ? { perceivedCharacter: rawTheory.perceivedCharacter } : {}),
      ...(typeof rawTheory.perceivedThreatLevel === 'number' ? { perceivedThreatLevel: percentScale(rawTheory.perceivedThreatLevel) } : {}),
      ...(typeof rawTheory.perceivedInterest === 'number' ? { perceivedInterest: percentScale(rawTheory.perceivedInterest) } : {}),
    };

    return {
      processedMemory: typeof result.processedMemory === 'string' ? result.processedMemory : interactionSummary,
      distortionLevel: clamp(rawDistortion, 0, 1),
      affectShift: clampedAffectShift,
      updatedTheory: clampedTheory,
      newIntentions: Array.isArray(result.newIntentions) ? result.newIntentions.filter((i: unknown) => typeof i === 'string').slice(0, 5) : [],
      thoughts: Array.isArray(result.thoughts) ? result.thoughts.filter((t: unknown) => typeof t === 'string').slice(0, 5) : [],
      woundTriggered,
      defenseActivated: typeof result.defenseActivated === 'string' ? result.defenseActivated : null,
      selfConceptShift: typeof result.selfConceptShift === 'string' ? result.selfConceptShift : undefined,
    };
  } catch (err) {
    console.error(`[pep:${npc.id}]`, err);
    // Deterministic fallback so a transient LLM failure does not silently skip
    // post-event processing for the ruminators that need it most. Without this,
    // a null return causes /talk to drop the entire PEP cycle (no rumination
    // thread, pepActive never set, no affect/theory update) for that interaction.
    const fallbackDistortion = pt === 'heavy_rumination' ? 0.4 : 0.2;
    const fallbackShift: Partial<AffectVector> = trustDelta < 0
      ? { resentment: 0.12, sadness: 0.08, anticipation: 0.1 }
      : trustDelta > 0
        ? { trust: 0.08, anticipation: 0.08 }
        : { anticipation: 0.06 };
    if (woundTriggered) {
      fallbackShift.fear = (fallbackShift.fear ?? 0) + 0.12;
      fallbackShift.shame = (fallbackShift.shame ?? 0) + 0.1;
    }
    return {
      processedMemory: interactionSummary,
      distortionLevel: fallbackDistortion,
      affectShift: fallbackShift,
      updatedTheory: {},
      newIntentions: [],
      thoughts: [woundTriggered
        ? 'Something about that hit a nerve. I keep coming back to it.'
        : `Still turning that conversation over.`],
      woundTriggered,
      defenseActivated: woundTriggered ? innerLife.defenses.primary : null,
    };
  }
}

function joinList(v: unknown, sep: string): string {
  if (Array.isArray(v)) return v.filter(x => x != null).map(String).join(sep);
  if (typeof v === 'string') return v;
  return '';
}

function buildPEPSystem(
  npc: WorldNPC,
  innerLife: InnerLife,
  world: WorldDNA,
  processingType: ProcessingType,
  triggeredWound: PsychologicalWound | null,
): string {
  const attachment = innerLife.attachment;
  const defenses = innerLife.defenses;
  
  return `You are simulating the INNER PROCESSING of ${npc.name} after a social interaction. This is not dialogue — this is what happens in their mind when they are alone afterwards. Walking home. Lying in bed. Sitting in the dark.

CHARACTER: ${npc.personality}, ${npc.temperament}
ATTACHMENT STYLE: ${attachment.style}
- Intimacy comfort: ${attachment.intimacyComfort}/100
- Abandonment fear: ${attachment.abandonmentFear}/100  
- Trust baseline: ${attachment.trustBaseline}/100
- When threatened: ${attachment.conflictResponse}

SELF-CONCEPT: ${joinList(innerLife.selfConcept, '; ') || 'not yet formed'}
VALUES: ${joinList(innerLife.values, ', ') || 'unclear'}

PROCESSING TYPE: ${processingType}
${processingType === 'moderate_rumination' ? 'This person replays interactions a few times. Some distortion occurs. They eventually settle but it colours their mood for hours.' : ''}
${processingType === 'heavy_rumination' ? 'This person LOOPS. The interaction gets worse each time they replay it. Small things become big things. They catastrophise. It affects their sleep, their mood, their next interaction. Negative events are amplified significantly. Positive events are questioned ("did they really mean that?").' : ''}

PRIMARY DEFENSE: ${defenses.primary} — fires automatically when threat exceeds ${defenses.activationThreshold}/100
SELF-AWARENESS: ${innerLife.selfAwareness.level}/100
${!innerLife.selfAwareness.distinguishesFeelingsFromFacts ? 'This person confuses how they FEEL about something with what actually HAPPENED.' : ''}

${triggeredWound ? `*** A WOUND HAS BEEN ACTIVATED ***
"${triggeredWound.description}" — this happened when they were ${triggeredWound.age}. It was triggered by something in this interaction. The defense mechanism "${triggeredWound.defenseTriggers}" is now firing. The player will see: "${triggeredWound.surfaceBehaviour}". But underneath, the wound is raw.` : ''}

CURRENT EMOTIONAL STATE: ${describeAffect(innerLife.affect)}
UNRESOLVED ISSUES: ${joinList(innerLife.unresolved, '; ') || 'none'}

IMPORTANT: This is the person's PRIVATE inner experience. It is biased. It is often irrational. It is real to them. Do not correct their distortions — generate them authentically. A heavy ruminator will catastrophise. An avoidant will minimise. A secure person will be balanced. Match the processing type precisely.`;
}

function buildPEPUser(
  npc: WorldNPC,
  innerLife: InnerLife,
  summary: string,
  playerMessage: string,
  npcReply: string,
  tone: string,
  trustDelta: number,
): string {
  return `WHAT HAPPENED:
${summary}

The other person said: "${playerMessage}"
${npc.name} replied: "${npcReply}"
Emotional tone of the exchange: ${tone}
Trust change: ${trustDelta > 0 ? `+${trustDelta} (positive)` : trustDelta < 0 ? `${trustDelta} (negative)` : '0 (neutral)'}

Current theory of this person: ${innerLife.theoryOfPlayer.perceivedCharacter || 'unknown'}
Times they've met: ${innerLife.pepCycleCount || 'first time or early'}

Now ${npc.name} is alone. The interaction is over. Process it.

Return:
{
  "processedMemory": string (how ${npc.name} NOW remembers the interaction — may differ from what actually happened),
  "distortionLevel": number (0-1, how far from reality their memory has drifted),
  "affectShift": { emotion: intensity_change } (which emotions shifted and by how much, -0.3 to +0.3),
  "updatedTheory": { 
    "perceivedIntent": string or null,
    "perceivedCharacter": string or null, 
    "perceivedThreatLevel": number or null (0-100: 0 harmless, 30 normal wariness of a stranger, 70+ a real threat),
    "perceivedInterest": number or null (0-100: how much ${npc.name} wants this person around; above 50 means they would seek them out)
  },
  "newIntentions": string[] (what they plan to do/say next time, 0-2 items),
  "thoughts": string[] (1-3 actual thoughts in their voice — what goes through their mind as they process this. raw, honest, possibly irrational),
  "defenseActivated": string or null (which defense mechanism fired, if any),
  "selfConceptShift": string or null (only if this interaction challenged who they think they are)
}`;
}

// ── The Full Cognitive Tick ─────────────────────────────────────────────────
// Runs for each NPC between player interactions. This is the heartbeat.

export interface CognitiveTickResult {
  npcId: string;

  // Updated inner state
  affectAfter: AffectVector;
  moodLabel: string;

  // What they thought about
  thoughts: string[];

  // PEP results (if processing)
  pepResult?: PEPResult;

  // Updated intentions
  intentions: string[];

  // What they're going to do
  seekingPlayer: boolean;
  avoidingPlayer: boolean;

  // Something to say if they see the player
  openingLine?: string;          // prepared remark, if they've been thinking

  // NPC-initiated contact
  pendingApproach?: { reason: string; message: string; urgency: number; generatedAt: string; openingLine?: string };
}

// NOTE: Mutates innerLife in-place (pepCycleCount, pepDistortionLevel, pepActive)
export async function runCognitiveTick(
  npc: WorldNPC,
  state: NPCLiveState,
  innerLife: InnerLife,
  world: WorldDNA,
  currentDate: string,
  timeOfDay: string,
  provider: string,
  model?: string,
): Promise<CognitiveTickResult> {
  let affectAfter = { ...innerLife.affect };
  const thoughts: string[] = [];
  let pepResult: PEPResult | undefined;
  
  // ── 1. Natural affect decay toward baseline ──
  // Emotions fade toward neutral over time. Strong emotions fade slower.
  affectAfter = decayAffect(affectAfter, 0.05);
  
  // ── 2. Time-of-day effect ──
  if (timeOfDay.toLowerCase().includes('night')) {
    // Night amplifies loneliness and anxiety
    if (innerLife.attachment.style === 'anxious') {
      affectAfter = blendAffect(affectAfter, { loneliness: 0.3, anxiety: 0.15 }, 0.3);
    }
    // Night is when rumination peaks
    if (innerLife.selfAwareness.processingType === 'heavy_rumination' && innerLife.unresolved.length > 0) {
      affectAfter = blendAffect(affectAfter, { sadness: 0.1, anticipation: 0.15 } as any, 0.3);
    }
  }
  
  // ── 3. Post-event processing (if there's something unresolved) ──
  // The INITIAL PEP cycle runs immediately after the interaction (in /talk).
  // During a tick, the rumination CONTINUES for ruminators until it settles.
  if (innerLife.pepActive && innerLife.unresolved.length > 0) {
    const ptTick = innerLife.selfAwareness.processingType;
    if (ptTick === 'heavy_rumination') {
      innerLife.pepCycleCount += 1;
      innerLife.pepDistortionLevel = Math.min(1, innerLife.pepDistortionLevel + 0.03);
      thoughts.push(`Still thinking about ${innerLife.pepTarget}. It's getting worse in their head.`);
      affectAfter = blendAffect(affectAfter, { anxiety: 0.1, resentment: 0.05 }, 0.4);
    } else if (ptTick === 'moderate_rumination') {
      innerLife.pepCycleCount += 1;
      innerLife.pepDistortionLevel = Math.min(1, innerLife.pepDistortionLevel + 0.015);
      thoughts.push(`Still turning over what happened with ${innerLife.pepTarget}.`);
      affectAfter = blendAffect(affectAfter, { anticipation: 0.06 }, 0.3);
    }

    // Each processing type settles on its own timeline (moderate settles sooner).
    const settleAt = ptTick === 'heavy_rumination' ? 8 : 4;
    if ((ptTick === 'heavy_rumination' || ptTick === 'moderate_rumination') && innerLife.pepCycleCount > settleAt) {
      innerLife.pepActive = false;
      innerLife.pepCycleCount = 0;
      innerLife.pepDistortionLevel = Math.max(0, innerLife.pepDistortionLevel - 0.2);
    }
  }
  
  // ── 4. Generate a thought ──
  // Not every tick produces a thought. But quiet moments do.
  if (Math.random() < 0.6 || innerLife.unresolved.length > 0) {
    try {
      const thought = await llmText({
        provider,
        model,
        maxTokens: 80,
        temperature: 0.95,
        system: `Generate one private thought for ${npc.name} (${npc.personality}, ${npc.temperament}). Current emotion: ${describeAffect(affectAfter)}. Current worry: ${state.currentWorry}. Time: ${timeOfDay}. They are ${state.currentActivity}. ${innerLife.unresolved.length > 0 ? `Unresolved: ${innerLife.unresolved[0]}` : 'Nothing particular on their mind.'} One sentence, their voice, raw and honest. Not dialogue — internal.`,
        user: 'What crosses their mind right now?',
      });
      thoughts.push(thought);
    } catch {
      // Thought generation is non-critical
    }
  }
  
  // ── 5. Update seeking/avoiding behaviour ──
  const seekingPlayer = innerLife.theoryOfPlayer.perceivedInterest > 50 && 
    affectAfter.trust > 0.4 && 
    innerLife.attachment.style !== 'avoidant';
  
  const avoidingPlayer = (
    affectAfter.fear > 0.4 ||
    affectAfter.shame > 0.5 ||
    (innerLife.attachment.style === 'avoidant' && affectAfter.trust > 0.6) // avoidants pull away when getting close
  );

  // ── 6. Generate opening line if seeking player ──
  let openingLine: string | undefined;
  if (seekingPlayer && !avoidingPlayer && state.totalInteractions > 0) {
    try {
      openingLine = await llmText({
        provider,
        model,
        maxTokens: 60,
        temperature: 0.9,
        system: `Generate one opening line that ${npc.name} (${npc.personality}) would say when approaching ${state.innerLife.theoryOfPlayer.perceivedCharacter !== 'unknown' ? 'someone they see as ' + state.innerLife.theoryOfPlayer.perceivedCharacter : 'someone they know'}. They are ${state.mood}. ${innerLife.intentions.length > 0 ? `They want to: ${innerLife.intentions[0]}` : ''} ${innerLife.lastThought ? `Last thought: "${innerLife.lastThought}"` : ''} One line of speech, in their voice. No quotation marks. Do not address them by name or invent a name for them.`,
        user: 'What do they say when they find the person?',
      });
    } catch {
      // Non-critical
    }
  }

  // Build pending approach if seeking
  const pendingApproach = seekingPlayer && !avoidingPlayer ? {
    reason: (innerLife.pepActive ? 'emotional_need' : innerLife.intentions.length > 0 ? 'request' : state.gossipHeard.length > 0 ? 'gossip' : 'emotional_need') as 'urgent_news' | 'gossip' | 'warning' | 'request' | 'emotional_need' | 'gift' | 'confrontation',
    message: innerLife.intentions[0] || innerLife.lastThought || 'wants to talk',
    urgency: Math.min(100, Math.round(50 + (innerLife.pepCycleCount ?? 0) * 5 + (affectAfter.fear > 0.3 ? 20 : 0) + (affectAfter.anger > 0.3 ? 15 : 0))),
    generatedAt: currentDate,
    openingLine,
  } : undefined;

  const moodLabel = describeAffect(affectAfter);

  return {
    npcId: npc.id,
    affectAfter,
    moodLabel,
    thoughts,
    pepResult,
    intentions: innerLife.intentions,
    seekingPlayer,
    avoidingPlayer,
    openingLine,
    pendingApproach,
  };
}

// ── Dream Processing ────────────────────────────────────────────────────────
// Dreams happen at night. They are not literal. They are symbolic, strange,
// emotionally resonant. They mix real memories with impossible imagery.

export interface DreamResult {
  npcId: string;
  dream: {
    id: string;
    date: string;
    content: string;
    sourceRuminationId?: string;
    sourceMemoryId?: string;
    emotionalTone: string;
    processedInsight?: string;
    mentionedInDialogue: boolean;
  };
}

export async function runDreamProcessing(
  npc: WorldNPC,
  state: NPCLiveState,
  innerLife: InnerLife,
  world: WorldDNA,
  currentDate: string,
  provider: string,
  model?: string,
): Promise<DreamResult | null> {
  // Only dream if there's unresolved material
  const activeThreads = innerLife.ruminationThreads?.filter(t => t.status === 'active') ?? [];
  const recentMemories = state.memories.slice(-3);
  if (activeThreads.length === 0 && recentMemories.length === 0 && innerLife.unresolved.length === 0) return null;

  // Don't dream every night
  if (innerLife.lastDreamDate === currentDate) return null;
  if (Math.random() > 0.6) return null;  // 60% chance of dreaming when there's material

  const dreamSource = activeThreads[0];
  const sourceMemory = dreamSource
    ? state.memories.find(m => m.id === dreamSource.targetMemoryId)
    : recentMemories[recentMemories.length - 1];

  try {
    const result = await llmJSON({
      provider,
      model,
      maxTokens: 256,
      temperature: 0.98,  // Dreams are surreal
      jsonMode: true,
      system: `Generate a dream for ${npc.name} (${npc.personality}, ${npc.temperament}). Dreams are NOT literal. They are symbolic, strange, emotionally resonant. They mix real memories with impossible imagery. A dream about abandonment might involve a door that won't open. A dream about trust might involve water. Keep it 2-3 sentences, vivid and specific to this person's psychology.

CURRENT EMOTIONAL STATE: ${describeAffect(innerLife.affect)}
UNRESOLVED: ${innerLife.unresolved.slice(0, 3).join('; ') || 'nothing specific'}
${dreamSource ? `RUMINATING ABOUT: ${dreamSource.unresolvedQuestion} (${dreamSource.cycles} cycles)` : ''}
${sourceMemory ? `RECENT MEMORY: ${sourceMemory.currentReconstruction ?? sourceMemory.summary}` : ''}
WOUNDS: ${innerLife.wounds.map(w => w.description).join('; ') || 'none known'}`,
      user: `Generate a dream. Return: { "content": string (the dream, 2-3 sentences), "emotionalTone": string (one word), "processedInsight": string or null (what the dream might help them understand, 1 sentence, or null if the dream is just distressing) }`,
    });

    const { randomUUID } = await import('crypto');
    const dream = {
      id: randomUUID(),
      date: currentDate,
      content: result.content ?? 'A dream that slipped away upon waking.',
      sourceRuminationId: dreamSource?.id,
      sourceMemoryId: sourceMemory?.id,
      emotionalTone: result.emotionalTone ?? 'strange',
      processedInsight: result.processedInsight ?? undefined,
      mentionedInDialogue: false,
    };

    innerLife.dreams = innerLife.dreams ?? [];
    innerLife.dreams.push(dream);
    innerLife.dreams = innerLife.dreams.slice(-10);
    innerLife.lastDreamDate = currentDate;

    // Dreams can shift affect slightly
    if (dream.emotionalTone === 'peaceful' || dream.processedInsight) {
      innerLife.affect = blendAffect(innerLife.affect, { relief: 0.1, sadness: -0.05 } as any, 0.2);
    } else {
      innerLife.affect = blendAffect(innerLife.affect, { anxiety: 0.1, sadness: 0.05 }, 0.15);
    }

    // If dream provided insight, it can help settle a rumination thread
    if (dream.processedInsight && dreamSource && dreamSource.status === 'active') {
      dreamSource.emotionalCharge = Math.max(0, dreamSource.emotionalCharge - 0.15);
    }

    return { npcId: npc.id, dream };
  } catch (err) {
    console.error(`[dream:${npc.id}]`, err);
    return null;
  }
}

// ── Affect Decay ────────────────────────────────────────────────────────────
// All emotions drift toward zero over time. Positive emotions decay faster
// than negative ones (negativity bias in memory).

function decayAffect(affect: AffectVector, rate: number): AffectVector {
  const result = { ...affect };
  const slowDecay = ['resentment', 'shame', 'guilt', 'fear', 'contempt', 'anxiety']; // negative sticks
  const fastDecay = ['joy', 'surprise', 'relief', 'gratitude', 'desire']; // positive/transient fades
  
  for (const [key, value] of Object.entries(result)) {
    if (['valence', 'arousal', 'dominance'].includes(key)) continue;
    if (typeof value !== 'number') continue;
    
    const k = key as keyof AffectVector;
    const decayRate = slowDecay.includes(key) ? rate * 0.5 
      : fastDecay.includes(key) ? rate * 2 
      : rate;
    
    result[k] = Math.max(0, value - decayRate) as any;
  }
  
  // Valence drifts toward 0
  result.valence = result.valence * (1 - rate);
  // Arousal drifts toward 0.3 (resting state)
  result.arousal = result.arousal + (0.3 - result.arousal) * rate;
  // Dominance drifts toward 0.5 (neutral baseline)
  result.dominance = result.dominance + (0.5 - result.dominance) * rate;

  return result;
}
