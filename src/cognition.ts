import { randomUUID } from 'crypto';
import type {
  BeliefContagionEvent,
  CounterfactualReplay,
  DefenseEpisode,
  GossipItem,
  IdentityStreamEntry,
  InternalBelief,
  MemoryDriftSnapshot,
  NPCMemory,
  NPCLiveState,
  ObjectiveEvent,
  RealityGapMetric,
  RuminationThread,
  TrajectoryPoint,
  WorldDNA,
  WorldNPC,
  WorldSession,
} from './types.js';
import type { PEPResult } from './cognitiveTick.js';
import type { AffectVector, TheoryOfPlayer } from './innerLife.js';
import { blendAffect } from './innerLife.js';

type EventInput = Omit<ObjectiveEvent, 'id' | 'createdAt' | 'targetIds' | 'tags'> & {
  targetIds?: string[];
  tags?: string[];
};

export interface CognitionDelta {
  objectiveEvent?: ObjectiveEvent;
  memoryId?: string;
  ruminationThreadId?: string;
  defenseEpisode?: DefenseEpisode;
  realityGapChange?: number;
  trajectoryPoint?: TrajectoryPoint;
}

export interface CognitionAdvanceSummary {
  cognitive: number;
  ruminationAdvances: number;
  memoryDrifts: number;
  defenseEpisodes: number;
  trajectoryPoints: number;
  contagionEvents: number;
  summary: Array<{ npc: string; event: string }>;
}

export function ensureCognitionState(session: WorldSession): void {
  session.objectiveEvents = session.objectiveEvents ?? [];
  session.contagionEvents = session.contagionEvents ?? [];

  for (const state of Object.values(session.npcStates ?? {})) {
    const il: any = state.innerLife;
    if (!il) continue;
    il.ruminationThreads = il.ruminationThreads ?? [];
    il.actorStream = il.actorStream ?? [];
    il.observerStream = il.observerStream ?? [];
    il.defenseHistory = il.defenseHistory ?? [];
    il.trajectory = il.trajectory ?? [];
    il.internalBeliefs = il.internalBeliefs ?? [];
    il.unresolved = il.unresolved ?? [];
    il.intentions = il.intentions ?? [];
    il.theoryOfPlayer = il.theoryOfPlayer ?? {
      perceivedIntent: 'unknown',
      perceivedCharacter: 'unknown',
      perceivedThreatLevel: 30,
      perceivedInterest: 0,
      predictions: [],
      lastUpdated: '',
      confidence: 0,
      wrongAbout: [],
    };
    il.selfAwareness = il.selfAwareness ?? {
      level: 40,
      knowsOwnTriggers: false,
      knowsOwnDefenses: false,
      canNameEmotions: true,
      distinguishesFeelingsFromFacts: false,
      processingType: 'moderate_rumination',
      openToChange: true,
      canAcceptCriticism: false,
      learnsFromMistakes: true,
    };
    il.loyaltyConflicts = il.loyaltyConflicts ?? [];

    for (const memory of state.memories ?? []) ensureMemoryProofFields(memory);
  }
}

export function recordObjectiveEvent(session: WorldSession, input: EventInput): ObjectiveEvent {
  ensureCognitionState(session);
  const event: ObjectiveEvent = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    targetIds: input.targetIds ?? [],
    tags: input.tags ?? [],
  };
  session.objectiveEvents!.push(event);
  if (session.objectiveEvents!.length > 500) session.objectiveEvents = session.objectiveEvents!.slice(-500);
  return event;
}

export function attachMemoryToObjectiveEvent(memory: NPCMemory, event: ObjectiveEvent): NPCMemory {
  memory.sourceEventId = event.id;
  memory.groundTruthSummary = event.summary;
  memory.currentReconstruction = memory.currentReconstruction ?? memory.summary;
  memory.driftHistory = memory.driftHistory ?? [];
  memory.biasTags = memory.biasTags ?? [];
  memory.realityGap = memory.realityGap ?? scoreTextGap(event.summary, memory.currentReconstruction);
  return memory;
}

export function applyPostEventCognition(
  session: WorldSession,
  npc: WorldNPC,
  state: NPCLiveState,
  memory: NPCMemory,
  event: ObjectiveEvent,
  pepResult: PEPResult,
  timeOfDay: string,
): CognitionDelta {
  ensureCognitionState(session);
  ensureMemoryProofFields(memory);

  const before = memory.currentReconstruction ?? memory.summary;
  memory.currentReconstruction = pepResult.processedMemory || before;
  memory.realityGap = clamp01(Math.max(
    pepResult.distortionLevel ?? 0,
    scoreTextGap(memory.groundTruthSummary ?? event.summary, memory.currentReconstruction),
  ));
  memory.biasTags = Array.from(new Set([
    ...(memory.biasTags ?? []),
    ...biasTagsFor(npc, state, pepResult.woundTriggered, pepResult.defenseActivated),
  ])).slice(-12);

  const drift = appendDrift(memory, {
    date: session.currentDate,
    timeOfDay,
    before,
    after: memory.currentReconstruction,
    distortionScore: memory.realityGap,
    biasSource: pepResult.defenseActivated || state.innerLife.selfAwareness.processingType,
    trigger: pepResult.woundTriggered ? 'wound activated' : 'post-interaction processing',
    tags: memory.biasTags,
  });

  state.innerLife.affect = blendAffect(state.innerLife.affect, normaliseAffectShift(pepResult.affectShift), 0.55);
  applyTheoryUpdate(state.innerLife.theoryOfPlayer, pepResult.updatedTheory, session.currentDate);

  const thread = createRuminationThread(session, state, memory, event, pepResult);
  appendIdentity(state, session.currentDate, timeOfDay, 'interaction', actorLine(npc, memory), observerLine(npc, state, memory), confidenceFromState(state));

  if (pepResult.thoughts.length > 0) state.innerLife.lastThought = pepResult.thoughts[pepResult.thoughts.length - 1];
  if (pepResult.newIntentions.length > 0) state.innerLife.intentions = pepResult.newIntentions.slice(0, 4);
  if (pepResult.selfConceptShift) state.innerLife.selfConcept = [...state.innerLife.selfConcept, pepResult.selfConceptShift].slice(-12);

  const defenseEpisode = maybeRecordDefense(session, npc, state, timeOfDay, event.id, pepResult.woundTriggered ? 'wound activated' : 'social pressure');
  const trajectoryPoint = appendTrajectory(session, state, timeOfDay);

  return {
    objectiveEvent: event,
    memoryId: memory.id,
    ruminationThreadId: thread?.id,
    defenseEpisode,
    realityGapChange: drift.distortionScore,
    trajectoryPoint,
  };
}

export function advanceAllCognition(
  session: WorldSession,
  world: WorldDNA,
  timeOfDay: string,
): CognitionAdvanceSummary {
  ensureCognitionState(session);
  const result: CognitionAdvanceSummary = {
    cognitive: 0,
    ruminationAdvances: 0,
    memoryDrifts: 0,
    defenseEpisodes: 0,
    trajectoryPoints: 0,
    contagionEvents: 0,
    summary: [],
  };

  for (const npc of world.npcs) {
    const state = session.npcStates[npc.id];
    if (!state?.innerLife) continue;

    const activeThreads = state.innerLife.ruminationThreads.filter(t => t.status === 'active');
    const shouldAdvance = activeThreads.length > 0 || state.innerLife.pepActive || state.totalInteractions > 0 || state.gossipHeard.length > 0;
    if (!shouldAdvance) continue;

    result.cognitive += 1;
    for (const thread of activeThreads.slice(0, 2)) {
      const memory = state.memories.find(m => m.id === thread.targetMemoryId);
      if (!memory) {
        thread.status = 'settled';
        continue;
      }
      const drift = advanceRuminationThread(session, npc, state, memory, thread, timeOfDay);
      if (drift) {
        result.ruminationAdvances += 1;
        result.memoryDrifts += 1;
        result.summary.push({ npc: npc.name, event: `memory drift ${Math.round(drift.distortionScore * 100)}%: ${drift.after}` });
      }
    }

    const defense = maybeRecordDefense(session, npc, state, timeOfDay, undefined, 'cognitive pressure');
    if (defense) {
      result.defenseEpisodes += 1;
      result.summary.push({ npc: npc.name, event: `defense: ${defense.defense} (${defense.behaviour})` });
    }
    const point = appendTrajectory(session, state, timeOfDay);
    if (point) result.trajectoryPoints += 1;
  }

  return result;
}

export function createBeliefContagion(
  session: WorldSession,
  fromNpcId: string,
  toNpcId: string,
  gossip: GossipItem,
  date: string,
  timeOfDay: string,
): BeliefContagionEvent | null {
  ensureCognitionState(session);
  const fromState = session.npcStates[fromNpcId];
  const toState = session.npcStates[toNpcId];
  if (!fromState?.innerLife || !toState?.innerLife) return null;

  const sourceBelief = latestBeliefText(fromState) || gossip.content;
  const transmitted = mutateBelief(sourceBelief, gossip.sentiment, (fromState.innerLife.pepDistortionLevel ?? 0) + averageRealityGap(fromState));
  const event: BeliefContagionEvent = {
    id: randomUUID(),
    date,
    timeOfDay,
    fromNpcId,
    toNpcId,
    sourceEventId: latestSourceEventId(fromState),
    originalBelief: sourceBelief,
    transmittedBelief: transmitted,
    mutation: transmitted === sourceBelief ? 'copied' : 'mutated by emotional retelling',
    sentiment: gossip.sentiment,
  };
  session.contagionEvents!.push(event);
  if (session.contagionEvents!.length > 100) session.contagionEvents = session.contagionEvents!.slice(-100);

  const belief: InternalBelief = {
    id: randomUUID(),
    sourceEventId: event.sourceEventId,
    sourceNpcId: fromNpcId,
    subject: session.playerName,
    belief: transmitted,
    confidence: clamp(15 + fromState.warmth / 6 + (gossip.sentiment === 'warning' ? 10 : 0), 0, 100),
    sentiment: gossip.sentiment,
    mutationCount: sourceBelief === transmitted ? 0 : 1,
    firstHeard: date,
    lastUpdated: date,
  };
  toState.innerLife.internalBeliefs.push(belief);
  toState.innerLife.internalBeliefs = toState.innerLife.internalBeliefs.slice(-15);
  appendIdentity(toState, date, timeOfDay, 'contagion', `I heard that ${transmitted}`, `I should not treat a rumour as proof, but it has weight.`, belief.confidence);
  appendTrajectory(session, toState, timeOfDay);
  return event;
}

export function getRealityGapMetric(state: NPCLiveState): RealityGapMetric {
  const gaps = (state.memories ?? []).map(m => m.realityGap ?? 0);
  return {
    npcId: state.npcId,
    averageGap: gaps.length ? round2(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0,
    maxGap: gaps.length ? round2(Math.max(...gaps)) : 0,
    distortedMemoryCount: gaps.filter(g => g > 0.35).length,
    lastUpdated: new Date().toISOString(),
  };
}

export function getActiveDefensePosture(state: NPCLiveState): string {
  const latest = state.innerLife?.defenseHistory?.slice(-1)[0];
  if (!latest) return '';
  if (latest.pressureScore < 55) return '';
  return `${latest.defense}: ${latest.behaviour}`;
}

// ── Feature 10: Loyalty Conflict Detection ─────────────────────────────────

export function detectLoyaltyConflicts(
  session: WorldSession,
  npc: WorldNPC,
  state: NPCLiveState,
  world: WorldDNA,
): void {
  if (!state.innerLife) return;
  state.innerLife.loyaltyConflicts = state.innerLife.loyaltyConflicts ?? [];

  // Find NPC pairs that this NPC cares about who are in conflict
  const strongRelationships = (Array.isArray(npc.relationships) ? npc.relationships : []).filter(r => r.strength > 50);
  if (strongRelationships.length < 2) return;

  for (let i = 0; i < strongRelationships.length; i++) {
    for (let j = i + 1; j < strongRelationships.length; j++) {
      const relA = strongRelationships[i];
      const relB = strongRelationships[j];
      const stateA = session.npcStates[relA.npcId];
      const stateB = session.npcStates[relB.npcId];
      if (!stateA || !stateB) continue;

      // Check if A and B have friction with each other
      const npcA = world.npcs.find(n => n.id === relA.npcId);
      const npcB = world.npcs.find(n => n.id === relB.npcId);
      if (!npcA || !npcB) continue;

      const aToBRel = (Array.isArray(npcA.relationships) ? npcA.relationships : []).find(r => r.npcId === relB.npcId);
      if (!aToBRel || aToBRel.strength > 30) continue; // no conflict if they're fine with each other

      // Check if conflict already tracked
      const existingConflict = state.innerLife.loyaltyConflicts.find(
        c => (c.npcIdA === relA.npcId && c.npcIdB === relB.npcId) || (c.npcIdA === relB.npcId && c.npcIdB === relA.npcId)
      );
      if (existingConflict) {
        // Update tension
        existingConflict.tension = Math.min(100, existingConflict.tension + 5);
        continue;
      }

      // New loyalty conflict detected
      state.innerLife.loyaltyConflicts.push({
        id: randomUUID(),
        npcIdA: relA.npcId,
        npcIdB: relB.npcId,
        description: `${npcA.name} and ${npcB.name} are at odds, and ${npc.name} cares about both`,
        tension: 30,
        startedDate: session.currentDate,
      });
    }
  }

  // Cap loyalty conflicts
  state.innerLife.loyaltyConflicts = state.innerLife.loyaltyConflicts.slice(-5);

  // Create rumination if tension is high
  for (const conflict of state.innerLife.loyaltyConflicts) {
    if (conflict.tension > 60 && !conflict.resolvedDate) {
      state.innerLife.unresolved = Array.from(new Set([
        ...state.innerLife.unresolved,
        `torn between ${world.npcs.find(n => n.id === conflict.npcIdA)?.name ?? 'someone'} and ${world.npcs.find(n => n.id === conflict.npcIdB)?.name ?? 'someone'}`,
      ])).slice(-8);
    }
  }
}

// ── Feature 11: Memory Comparison Between NPCs ─────────────────────────────

export function compareMemories(
  session: WorldSession,
  npcA: WorldNPC,
  stateA: NPCLiveState,
  npcB: WorldNPC,
  stateB: NPCLiveState,
): { hasConflict: boolean; conflictDescription?: string; sharedEventId?: string } {
  // Find memories that reference the same objective event
  const aEventIds = new Set(stateA.memories.filter(m => m.sourceEventId).map(m => m.sourceEventId!));
  const bEventIds = new Set(stateB.memories.filter(m => m.sourceEventId).map(m => m.sourceEventId!));

  const sharedEventIds = Array.from(aEventIds).filter(id => bEventIds.has(id));
  if (sharedEventIds.length === 0) return { hasConflict: false };

  // Compare reconstructions of shared events
  for (const eventId of sharedEventIds) {
    const memA = stateA.memories.find(m => m.sourceEventId === eventId);
    const memB = stateB.memories.find(m => m.sourceEventId === eventId);
    if (!memA || !memB) continue;

    const reconA = memA.currentReconstruction ?? memA.summary;
    const reconB = memB.currentReconstruction ?? memB.summary;

    const gapA = memA.realityGap ?? 0;
    const gapB = memB.realityGap ?? 0;

    // If both remember it very differently, there's a conflict
    if (gapA > 0.3 || gapB > 0.3) {
      const textDivergence = scoreTextDivergence(reconA, reconB);
      if (textDivergence > 0.4) {
        return {
          hasConflict: true,
          conflictDescription: `${npcA.name} remembers: "${reconA.slice(0, 100)}" but ${npcB.name} remembers: "${reconB.slice(0, 100)}"`,
          sharedEventId: eventId,
        };
      }
    }
  }

  return { hasConflict: false };
}

function scoreTextDivergence(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3));
  const setB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3));
  if (!setA.size && !setB.size) return 0;
  let overlap = 0;
  setA.forEach(word => { if (setB.has(word)) overlap += 1; });
  const union = new Set(Array.from(setA).concat(Array.from(setB))).size || 1;
  return Math.round((1 - overlap / union) * 100) / 100;
}

// ── Feature 2: Witness Memory Helper ────────────────────────────────────────

export function createWitnessMemory(
  session: WorldSession,
  witnessNpcId: string,
  actorName: string,
  targetName: string,
  interactionSummary: string,
  locationId: string,
  date: string,
  timeOfDay: string,
  objectiveEventId: string,
  /**
   * Optional NPC IDs of the actor and target. Only NPC IDs (not the player)
   * should be passed — these populate `othersPresent` and `witnessedParticipants`,
   * which are read elsewhere as NPC IDs (see `questEpisode.ts` ID remapper).
   * Leave `actorNpcId` undefined when the actor is the player.
   */
  actorNpcId?: string,
  targetNpcId?: string,
): void {
  const state = session.npcStates[witnessNpcId];
  if (!state) return;

  const participantIds = [actorNpcId, targetNpcId].filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );

  const memory: NPCMemory = {
    id: randomUUID(),
    npcId: witnessNpcId,
    worldId: session.worldId,
    inWorldDate: date,
    realTimestamp: new Date().toISOString(),
    summary: `Witnessed ${actorName} interact with ${targetName}.`,
    detail: interactionSummary.slice(0, 200),
    emotionalTone: 'observant',
    interactionKind: 'action',
    playerRevealed: [],
    npcRevealed: [],
    topicsCovered: ['witnessed interaction'],
    trustDelta: 0,
    significantMoment: false,
    npcThoughtAfter: `I saw what happened between ${actorName} and ${targetName}.`,
    sourceEventId: objectiveEventId,
    groundTruthSummary: interactionSummary.slice(0, 200),
    currentReconstruction: interactionSummary.slice(0, 200),
    driftHistory: [],
    biasTags: ['witness'],
    realityGap: 0,
    locationId,
    timeOfDay,
    othersPresent: participantIds,
    isWitnessed: true,
    witnessedParticipants: participantIds,
  };

  state.memories.push(memory);
  if (state.memories.length > 20) state.memories = state.memories.slice(-20);
}

// ── Private Helpers ─────────────────────────────────────────────────────────

function createRuminationThread(
  session: WorldSession,
  state: NPCLiveState,
  memory: NPCMemory,
  event: ObjectiveEvent,
  pepResult: PEPResult,
): RuminationThread | null {
  if (state.innerLife.selfAwareness.processingType === 'present') return null;
  const existing = state.innerLife.ruminationThreads.find(t => t.targetMemoryId === memory.id && t.status === 'active');
  if (existing) return existing;

  const charge = clamp01(Math.max(Math.abs(memory.trustDelta) / 8, pepResult.distortionLevel ?? 0.1, pepResult.woundTriggered ? 0.75 : 0));
  const thread: RuminationThread = {
    id: randomUUID(),
    sourceEventId: event.id,
    targetMemoryId: memory.id,
    targetName: session.playerName,
    startedAt: session.currentDate,
    lastAdvancedAt: session.currentDate,
    emotionalCharge: charge,
    unresolvedQuestion: pepResult.thoughts[0] || `What did ${session.playerName} really mean?`,
    cycles: 1,
    status: state.innerLife.selfAwareness.processingType === 'suppression' ? 'suppressed' : 'active',
    counterfactuals: [],
  };
  state.innerLife.ruminationThreads.push(thread);
  state.innerLife.ruminationThreads = state.innerLife.ruminationThreads.slice(-20);
  state.innerLife.unresolved = Array.from(new Set([...state.innerLife.unresolved, thread.unresolvedQuestion])).slice(-8);
  state.innerLife.pepActive = thread.status === 'active';
  state.innerLife.pepTarget = session.playerName;
  state.innerLife.pepCycleCount = Math.max(state.innerLife.pepCycleCount, 1);
  return thread;
}

function advanceRuminationThread(
  session: WorldSession,
  npc: WorldNPC,
  state: NPCLiveState,
  memory: NPCMemory,
  thread: RuminationThread,
  timeOfDay: string,
): MemoryDriftSnapshot | null {
  ensureMemoryProofFields(memory);
  const before = memory.currentReconstruction ?? memory.summary;
  thread.cycles += 1;
  thread.lastAdvancedAt = session.currentDate;
  state.innerLife.pepCycleCount = Math.max(state.innerLife.pepCycleCount, thread.cycles);

  const cf = buildCounterfactual(session, npc, state, memory, thread);
  thread.counterfactuals.push(cf);
  thread.counterfactuals = thread.counterfactuals.slice(-12);

  const pressure = computePressure(state);
  const after = distortReconstruction(before, state, thread, pressure);
  const gap = clamp01(Math.max(memory.realityGap ?? 0, scoreTextGap(memory.groundTruthSummary ?? memory.summary, after), thread.emotionalCharge * 0.12 + thread.cycles * 0.018));
  const maxAllowedGap = thread.cycles < 4 ? 0.5 : thread.cycles < 7 ? 0.75 : 0.92;
  const cappedGap = Math.min(gap, maxAllowedGap);
  memory.currentReconstruction = after;
  memory.realityGap = cappedGap;
  memory.biasTags = Array.from(new Set([...(memory.biasTags ?? []), ...biasTagsFor(npc, state, false, undefined)])).slice(-12);
  state.innerLife.pepDistortionLevel = Math.max(state.innerLife.pepDistortionLevel ?? 0, cappedGap);

  const drift = appendDrift(memory, {
    date: session.currentDate,
    timeOfDay,
    before,
    after,
    distortionScore: cappedGap,
    biasSource: pressure > 70 ? 'high pressure rumination' : state.innerLife.selfAwareness.processingType,
    trigger: thread.unresolvedQuestion,
    tags: memory.biasTags,
  });

  appendIdentity(state, session.currentDate, timeOfDay, 'rumination', cf.whatTheyProbablyMeant, cf.whatThisSaysAboutMe, confidenceFromState(state));
  state.innerLife.lastThought = cf.whatThisSaysAboutMe;

  if (thread.cycles >= settleAfter(state)) {
    thread.status = 'settled';
    state.innerLife.unresolved = state.innerLife.unresolved.filter(u => u !== thread.unresolvedQuestion);
    state.innerLife.pepActive = state.innerLife.ruminationThreads.some(t => t.status === 'active');
  }
  return drift;
}

function appendDrift(memory: NPCMemory, input: Omit<MemoryDriftSnapshot, 'cycle'>): MemoryDriftSnapshot {
  const drift: MemoryDriftSnapshot = {
    cycle: (memory.driftHistory?.length ?? 0) + 1,
    ...input,
    distortionScore: round2(input.distortionScore),
  };
  memory.driftHistory = [...(memory.driftHistory ?? []), drift].slice(-30);
  return drift;
}

function maybeRecordDefense(
  session: WorldSession,
  npc: WorldNPC,
  state: NPCLiveState,
  timeOfDay: string,
  sourceEventId: string | undefined,
  trigger: string,
): DefenseEpisode | undefined {
  const pressureInputs = pressureInputsFor(state);
  const pressureScore = computePressure(state);
  if (pressureScore < 35) return undefined;
  const recent = state.innerLife.defenseHistory.slice(-1)[0];
  if (recent && recent.date === session.currentDate && recent.defense === selectDefense(npc, state, pressureScore)) return undefined;

  const defense = selectDefense(npc, state, pressureScore);
  const episode: DefenseEpisode = {
    id: randomUUID(),
    date: session.currentDate,
    timeOfDay,
    sourceEventId,
    pressureScore,
    pressureInputs,
    defense,
    behaviour: defenseBehaviour(defense, pressureScore),
    trigger,
  };
  state.innerLife.defenseHistory.push(episode);
  state.innerLife.defenseHistory = state.innerLife.defenseHistory.slice(-30);
  return episode;
}

function appendTrajectory(session: WorldSession, state: NPCLiveState, timeOfDay: string): TrajectoryPoint {
  const point: TrajectoryPoint = {
    date: session.currentDate,
    timeOfDay,
    confidence: round2(confidenceFromState(state) / 100),
    defensiveness: round2(computePressure(state) / 100),
    trust: round2((state.trustLevel ?? 0) / 100),
    fear: round2((state.fear ?? 0) / 100),
    realityGap: round2(averageRealityGap(state)),
    distortion: round2(state.innerLife.pepDistortionLevel ?? 0),
    ruminationLoad: round2(activeRuminationLoad(state)),
    identityConflict: round2(identityConflict(state)),
  };
  state.innerLife.trajectory.push(point);
  state.innerLife.trajectory = state.innerLife.trajectory.slice(-120);
  return point;
}

function appendIdentity(
  state: NPCLiveState,
  date: string,
  timeOfDay: string,
  source: IdentityStreamEntry['source'],
  actor: string,
  observer: string,
  confidence: number,
): void {
  state.innerLife.actorStream.push({ id: randomUUID(), date, timeOfDay, text: actor, source, confidence });
  state.innerLife.observerStream.push({ id: randomUUID(), date, timeOfDay, text: observer, source, confidence: clamp(100 - confidence + computePressure(state) / 3, 0, 100) });
  state.innerLife.actorStream = state.innerLife.actorStream.slice(-50);
  state.innerLife.observerStream = state.innerLife.observerStream.slice(-50);
}

function ensureMemoryProofFields(memory: NPCMemory): void {
  memory.groundTruthSummary = memory.groundTruthSummary ?? memory.summary;
  memory.currentReconstruction = memory.currentReconstruction ?? memory.summary;
  memory.driftHistory = memory.driftHistory ?? [];
  memory.biasTags = memory.biasTags ?? [];
  memory.realityGap = memory.realityGap ?? scoreTextGap(memory.groundTruthSummary, memory.currentReconstruction);
}

function applyTheoryUpdate(theory: TheoryOfPlayer, update: Partial<TheoryOfPlayer>, date: string): void {
  if (!update) return;
  if (update.perceivedIntent) theory.perceivedIntent = update.perceivedIntent;
  if (update.perceivedCharacter) theory.perceivedCharacter = update.perceivedCharacter;
  if (typeof update.perceivedThreatLevel === 'number') theory.perceivedThreatLevel = clamp(update.perceivedThreatLevel, 0, 100);
  if (typeof update.perceivedInterest === 'number') theory.perceivedInterest = clamp(update.perceivedInterest, 0, 100);
  if (Array.isArray(update.predictions)) theory.predictions = update.predictions.slice(-6);
  theory.confidence = clamp((theory.confidence ?? 0) + 12, 0, 100);
  theory.lastUpdated = date;
}

function normaliseAffectShift(shift: Partial<AffectVector>): Partial<AffectVector> {
  const out: any = {};
  for (const [key, value] of Object.entries(shift ?? {})) {
    if (typeof value === 'number') out[key] = Math.max(-1, Math.min(1, Math.abs(value) > 1 ? value / 100 : value));
  }
  return out;
}

function pressureInputsFor(state: NPCLiveState): Record<string, number> {
  const affect: any = state.innerLife.affect ?? {};
  return {
    fear: clamp(state.fear ?? 0, 0, 100),
    threat: clamp(state.innerLife.theoryOfPlayer?.perceivedThreatLevel ?? 0, 0, 100),
    shame: clamp01(affect.shame ?? 0) * 100,
    anger: clamp01(affect.anger ?? 0) * 100,
    resentment: clamp01(affect.resentment ?? 0) * 100,
    rumination: activeRuminationLoad(state) * 100,
    identityConflict: identityConflict(state) * 100,
    realityGap: averageRealityGap(state) * 100,
  };
}

function computePressure(state: NPCLiveState): number {
  const p = pressureInputsFor(state);
  return Math.round(clamp(
    p.fear * 0.15 + p.threat * 0.18 + p.shame * 0.12 + p.anger * 0.1 + p.resentment * 0.12 +
    p.rumination * 0.15 + p.identityConflict * 0.1 + p.realityGap * 0.08,
    0,
    100,
  ));
}

function selectDefense(npc: WorldNPC, state: NPCLiveState, pressure: number): string {
  if (pressure > 78 && state.innerLife.attachment.style === 'avoidant') return 'withdrawal';
  if (pressure > 72 && (state.innerLife.affect as any).shame > 0.4) return 'projection';
  if (pressure > 65 && state.innerLife.selfAwareness.level < 35) return 'rationalization';
  if (pressure > 55 && npc.primaryDefense) return npc.primaryDefense;
  return pressure > 50 ? 'minimising' : 'guardedness';
}

function defenseBehaviour(defense: string, pressure: number): string {
  const intense = pressure > 70;
  switch (defense) {
    case 'withdrawal': return intense ? 'avoids contact and gives clipped replies' : 'creates distance before answering';
    case 'projection': return 'attributes their own fear or anger to the other person';
    case 'rationalization': return 'explains away the feeling as practical judgment';
    case 'humour': return 'turns discomfort into jokes or deflection';
    case 'denial': return 'refuses to acknowledge the emotional charge';
    case 'reaction_formation': return 'acts warmer than they feel';
    default: return intense ? 'redirects the topic and narrows trust' : 'answers carefully and withholds detail';
  }
}

function buildCounterfactual(
  session: WorldSession,
  npc: WorldNPC,
  state: NPCLiveState,
  memory: NPCMemory,
  thread: RuminationThread,
): CounterfactualReplay {
  const cycle = thread.cycles;
  const wary = computePressure(state) > 55;
  return {
    cycle,
    date: session.currentDate,
    whatHappened: memory.currentReconstruction ?? memory.summary,
    whatIShouldHaveSaid: wary ? 'I should have given less away.' : 'I could have asked what they meant instead of guessing.',
    whatTheyProbablyMeant: wary
      ? `${session.playerName} may have been testing me more than they admitted.`
      : `${session.playerName} may simply have been trying to be understood.`,
    whatThisSaysAboutMe: wary
      ? `${npc.name} thinks: I let this get under my skin because it found an old bruise.`
      : `${npc.name} thinks: I am still deciding what kind of person they are.`,
  };
}

function distortReconstruction(before: string, state: NPCLiveState, thread: RuminationThread, pressure: number): string {
  const base = before.replace(/\s+/g, ' ').trim();
  if (state.innerLife.selfAwareness.processingType === 'brief_reflection' && pressure < 50) return base;
  if (state.innerLife.selfAwareness.processingType === 'suppression') return `${base} They tell themself it did not matter.`;
  if (state.innerLife.attachment.style === 'anxious') return `${base} The uncertain parts now feel like signs they may be rejected.`;
  if (state.innerLife.attachment.style === 'avoidant') return `${base} The closeness of it now feels like pressure.`;
  if (pressure > 70) return `${base} In memory, the threat feels sharper than the words alone prove.`;
  if (thread.cycles > 3) return `${base} The details are starting to arrange themselves around the feeling it left.`;
  return `${base} The feeling of it lingers more than the facts.`;
}

function actorLine(npc: WorldNPC, memory: NPCMemory): string {
  return `${npc.name} acts from the memory: ${memory.currentReconstruction ?? memory.summary}`;
}

function observerLine(npc: WorldNPC, state: NPCLiveState, memory: NPCMemory): string {
  const gap = memory.realityGap ?? 0;
  if (gap > 0.45) return `${npc.name}'s observer notices the story may be drifting, but the feeling keeps winning.`;
  if (computePressure(state) > 60) return `${npc.name}'s observer thinks the reaction is bigger than the event.`;
  return `${npc.name}'s observer keeps the event mostly in proportion.`;
}

function confidenceFromState(state: NPCLiveState): number {
  return clamp(55 + (state.trustLevel ?? 0) * 0.2 - computePressure(state) * 0.35, 5, 95);
}

function settleAfter(state: NPCLiveState): number {
  switch (state.innerLife.selfAwareness.processingType) {
    case 'brief_reflection': return 2;
    case 'moderate_rumination': return 4;
    case 'heavy_rumination': return 8;
    case 'suppression': return 1;
    case 'dissociation': return 2;
    default: return 5;
  }
}

function activeRuminationLoad(state: NPCLiveState): number {
  const active = state.innerLife.ruminationThreads?.filter(t => t.status === 'active') ?? [];
  if (!active.length) return 0;
  return clamp01(active.reduce((sum, t) => sum + t.emotionalCharge + t.cycles * 0.08, 0) / Math.max(1, active.length));
}

function identityConflict(state: NPCLiveState): number {
  const actor = state.innerLife.actorStream?.slice(-1)[0];
  const observer = state.innerLife.observerStream?.slice(-1)[0];
  if (!actor || !observer) return 0;
  const confidenceGap = Math.abs((actor.confidence ?? 50) - (observer.confidence ?? 50)) / 100;
  const critique = /(wrong|should|fool|weak|afraid|drifting|bigger|winning|proof)/i.test(observer.text) ? 0.35 : 0;
  return clamp01(confidenceGap + critique);
}

function averageRealityGap(state: NPCLiveState): number {
  const gaps = (state.memories ?? []).map(m => m.realityGap ?? 0);
  return gaps.length ? clamp01(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
}

function scoreTextGap(truth: string, recalled: string): number {
  const truthWords = wordSet(truth);
  const recalledWords = wordSet(recalled);
  if (!truthWords.size && !recalledWords.size) return 0;
  let overlap = 0;
  for (const word of truthWords) if (recalledWords.has(word)) overlap += 1;
  const union = new Set([...truthWords, ...recalledWords]).size || 1;
  return round2(clamp01(1 - overlap / union));
}

function wordSet(text: string): Set<string> {
  return new Set(String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3));
}

function biasTagsFor(npc: WorldNPC, state: NPCLiveState, woundTriggered: boolean, defense?: string | null): string[] {
  return [
    state.innerLife.attachment.style,
    state.innerLife.selfAwareness.processingType,
    woundTriggered ? 'wound' : '',
    defense || npc.primaryDefense || '',
  ].filter(Boolean);
}

function latestBeliefText(state: NPCLiveState): string {
  const belief = state.innerLife.internalBeliefs?.slice(-1)[0]?.belief;
  if (belief) return belief;
  const memory = state.memories?.slice(-1)[0];
  return memory?.currentReconstruction ?? memory?.summary ?? '';
}

function latestSourceEventId(state: NPCLiveState): string | undefined {
  return state.memories?.slice().reverse().find(m => m.sourceEventId)?.sourceEventId;
}

function mutateBelief(text: string, sentiment: BeliefContagionEvent['sentiment'], distortion: number): string {
  if (distortion < 0.4 && sentiment !== 'warning') return text;
  if (sentiment === 'positive') return `${text} People are making it sound almost hopeful.`;
  if (sentiment === 'warning' || sentiment === 'negative') return `${text} By the time it is retold, it sounds more dangerous.`;
  if (sentiment === 'curious') return `${text} Nobody seems sure what it means.`;
  return `${text} The details are already blurring in the retelling.`;
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
