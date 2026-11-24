import assert from 'node:assert/strict';
import { createDefaultInnerLife } from './innerLife.js';
import type { NPCMemory, NPCLiveState, WorldDNA, WorldNPC, WorldSession } from './types.js';
import {
  advanceAllCognition,
  applyPostEventCognition,
  attachMemoryToObjectiveEvent,
  createBeliefContagion,
  ensureCognitionState,
  recordObjectiveEvent,
} from './cognition.js';

function npc(id: string): WorldNPC {
  return {
    id,
    name: id === 'npc-a' ? 'Ada Vale' : 'Bryn Vale',
    age: 34,
    gender: 'unspecified',
    occupation: 'printer',
    physicalDescription: 'watchful eyes',
    personality: 'anxious',
    voiceAnchor: 'Speaks carefully.',
    speechPatterns: [],
    coreConcerns: ['being misread'],
    signature: 'quiet',
    traits: ['anxious', 'loyal'],
    secrets: [],
    desires: ['be trusted'],
    fears: ['abandonment'],
    opinions: {},
    backstory: 'A careful life.',
    dailyRoutine: { morning: 'work', afternoon: 'work', evening: 'walk', night: 'home', weekendDifference: 'rests' },
    homeLocationId: 'home',
    workLocationId: 'shop',
    frequentedLocations: ['square'],
    socialClass: 'working',
    relationships: [],
    baselineMood: 'guarded',
    temperament: 'watchful',
    approachability: 50,
    loyaltyThreshold: 5,
    attachmentStyle: 'anxious',
    processingType: 'heavy_rumination',
    primaryDefense: 'rationalization',
    selfAwarenessLevel: 30,
    coreWound: 'was left without explanation',
    woundTriggers: ['leave', 'forgot'],
    selfConcept: ['I am easy to leave'],
    values: ['loyalty'],
  };
}

function state(n: WorldNPC): NPCLiveState {
  return {
    npcId: n.id,
    worldId: 'world-1',
    relationship: 'stranger',
    trustLevel: 10,
    familiarity: 0,
    warmth: 40,
    respect: 50,
    attraction: 0,
    fear: 65,
    mood: 'guarded',
    currentLocationId: 'shop',
    currentActivity: 'working',
    isAvailable: true,
    memories: [],
    totalInteractions: 1,
    lastInteractionDate: '1900-01-01',
    daysSinceLastSeen: 0,
    playerFacts: [],
    playerOpinion: '',
    gossipHeard: [],
    gossipShared: [],
    recentLifeEvents: [],
    currentWorry: 'being misread',
    currentGoal: 'be trusted',
    activeGoals: [],
    promises: [],
    patternsNoticed: [],
    innerLife: createDefaultInnerLife(n.attachmentStyle, n.processingType, n.primaryDefense as any),
  };
}

function world(a: WorldNPC, b: WorldNPC): WorldDNA {
  return {
    id: 'world-1',
    concept: 'test world',
    createdAt: new Date().toISOString(),
    provider: 'test',
    era: { period: '1900', yearStart: 1900, yearEnd: 1901, dateFormat: 'yyyy-mm-dd', majorWorldEvents: [] },
    geography: { region: 'Testshire', country: 'Testland', climate: 'mild', terrain: 'town', scale: 'city', landmarks: [] },
    culture: { language: 'English', dialect: 'plain', slang: {}, greetings: [], socialClasses: [], religion: 'none', customs: [], taboos: [], music: '', food: [], entertainment: [], genderRoles: '', socialNorms: [] },
    economy: { currency: 'coin', symbol: '$', averageDailyWage: 1, prices: {}, jobs: [], blackMarket: '' },
    law: { system: '', enforcers: '', corruption: 0, vices: [], consequences: '' },
    weather: { seasons: [], dominantWeather: 'clear' },
    technology: { era: 'simple', transport: [], communication: [], lighting: '', media: [], domesticLife: '' },
    narrativeStyle: { voice: '', tense: 'second', toneKeywords: [], literaryInfluences: [], sampleParagraph: '', forbiddenWords: [], sensoryPalette: [] },
    populationBlueprint: {} as any,
    locations: [{ id: 'shop', name: 'Print Shop', type: 'work', description: '', ambientDetail: '', connectedTo: [], socialClass: '', openHours: 'always', regulars: [], interactables: [], privacyLevel: 'public', capacity: '' }],
    npcs: [a, b],
    timeline: [],
    simulationRules: { gossipSpeed: 1, communitySize: '', socialMobility: '', privacyLevel: '', conflictStyle: '', trustCulture: '', reputationMatters: true, rumoursSpread: true },
    timeOfDay: { periods: [{ name: 'morning', hourStart: 0, hourEnd: 24, atmosphere: '', npcActivity: '', openLocations: [] }] },
  };
}

const a = npc('npc-a');
const b = npc('npc-b');
const session: WorldSession = {
  id: 'session-1',
  worldId: 'world-1',
  playerName: 'Player',
  playerAge: 30,
  playerGender: 'unspecified',
  playerOccupation: 'tester',
  playerBackstory: '',
  currentDate: '1900-01-01',
  currentTime: 10,
  currentLocationId: 'shop',
  money: 0,
  isAlive: true,
  socialClass: '',
  reputation: 'unknown',
  npcStates: { [a.id]: state(a), [b.id]: state(b) },
  visitedLocations: [],
  dayCount: 1,
  significantEvents: [],
  communityMood: 'neutral',
  activeGossip: [],
  recentCommunityEvents: [],
};
ensureCognitionState(session);

const event = recordObjectiveEvent(session, {
  type: 'player_interaction',
  date: session.currentDate,
  timeOfDay: 'morning',
  actorId: 'player',
  targetIds: [a.id],
  summary: 'Player promised to come back.',
  detail: 'Player said they would come back tomorrow.',
  tags: ['promise'],
});

const memory: NPCMemory = {
  id: 'memory-1',
  npcId: a.id,
  worldId: 'world-1',
  inWorldDate: session.currentDate,
  realTimestamp: new Date().toISOString(),
  summary: 'Player promised to come back.',
  detail: 'A promise was made.',
  emotionalTone: 'anxious',
  playerMessage: 'I will come back tomorrow',
  interactionKind: 'speech',
  npcReply: 'Will you?',
  playerRevealed: [],
  npcRevealed: [],
  topicsCovered: ['promise'],
  trustDelta: -3,
  significantMoment: true,
  npcThoughtAfter: 'They might leave.',
  locationId: 'shop',
  timeOfDay: 'morning',
  othersPresent: [],
};
attachMemoryToObjectiveEvent(memory, event);
session.npcStates[a.id].memories.push(memory);

const delta = applyPostEventCognition(session, a, session.npcStates[a.id], memory, event, {
  processedMemory: 'Player promised to come back, but it already feels uncertain.',
  distortionLevel: 0.42,
  affectShift: { fear: 0.7, shame: 0.4 } as any,
  updatedTheory: { perceivedThreatLevel: 70, perceivedCharacter: 'kind but possibly unreliable' },
  newIntentions: ['Ask if they meant it.'],
  thoughts: ['People say they will come back before they leave.'],
  woundTriggered: true,
  defenseActivated: 'rationalization',
}, 'morning');

assert.equal(memory.groundTruthSummary, 'Player promised to come back.');
assert.notEqual(memory.currentReconstruction, memory.groundTruthSummary);
assert.ok((memory.driftHistory?.length ?? 0) >= 1);
assert.ok(delta.defenseEpisode);
assert.ok(session.npcStates[a.id].innerLife.actorStream.length > 0);
assert.ok(session.npcStates[a.id].innerLife.observerStream.length > 0);

const beforeCycles = session.npcStates[a.id].innerLife.ruminationThreads[0].cycles;
const summary = advanceAllCognition(session, world(a, b), 'morning');
assert.ok(summary.memoryDrifts >= 1);
assert.ok(session.npcStates[a.id].innerLife.ruminationThreads[0].cycles > beforeCycles);
assert.ok((memory.driftHistory?.length ?? 0) >= 2);
assert.ok(session.npcStates[a.id].innerLife.trajectory.length > 0);

const contagion = createBeliefContagion(session, a.id, b.id, {
  fromNpcId: a.id,
  content: 'Player may not keep promises.',
  date: session.currentDate,
  sentiment: 'warning',
  isTrue: true,
}, session.currentDate, 'morning');
assert.ok(contagion);
assert.ok(session.npcStates[b.id].innerLife.internalBeliefs.length > 0);
assert.notEqual(contagion!.transmittedBelief.length, 0);

console.log('cognition proof checks passed');

// ─── cycle-gated maxAllowedGap tests ──────────────────────────────────────────

function makeCycleGateSession(seedCycles: number): { session: WorldSession; world: WorldDNA; mem: NPCMemory } {
  const npcA = npc('npc-a');
  const npcB = npc('npc-b');
  const st = state(npcA);
  const sess: WorldSession = {
    id: 'cg-session-' + seedCycles,
    worldId: 'world-1',
    playerName: 'Player',
    playerAge: 30,
    playerGender: 'unspecified',
    playerOccupation: 'tester',
    playerBackstory: '',
    currentDate: '1900-01-01',
    currentTime: 10,
    currentLocationId: 'shop',
    money: 0,
    isAlive: true,
    socialClass: '',
    reputation: 'unknown',
    npcStates: { [npcA.id]: st, [npcB.id]: state(npcB) },
    visitedLocations: [],
    dayCount: 1,
    significantEvents: [],
    communityMood: 'neutral',
    activeGossip: [],
    recentCommunityEvents: [],
  };
  ensureCognitionState(sess);

  const mem: NPCMemory = {
    id: 'cg-mem-' + seedCycles,
    npcId: npcA.id,
    worldId: 'world-1',
    inWorldDate: sess.currentDate,
    realTimestamp: new Date().toISOString(),
    summary: 'Player made a promise.',
    detail: 'A promise was made.',
    emotionalTone: 'anxious',
    playerMessage: 'I will return.',
    interactionKind: 'speech',
    npcReply: 'Will you?',
    playerRevealed: [],
    npcRevealed: [],
    topicsCovered: ['promise'],
    trustDelta: -8,
    significantMoment: true,
    npcThoughtAfter: 'They might leave.',
    locationId: 'shop',
    timeOfDay: 'morning',
    othersPresent: [],
    groundTruthSummary: 'Player made a promise.',
    currentReconstruction: 'Player made a vague and possibly hollow promise.',
    driftHistory: [],
    biasTags: [],
    realityGap: 0.95,
  };
  sess.npcStates[npcA.id].memories.push(mem);

  const thread: import('./types.js').RuminationThread = {
    id: 'cg-thread-' + seedCycles,
    sourceEventId: 'ev-cg-' + seedCycles,
    targetMemoryId: mem.id,
    targetName: 'Player',
    startedAt: sess.currentDate,
    lastAdvancedAt: sess.currentDate,
    emotionalCharge: 1.0,
    unresolvedQuestion: 'What did Player really mean?',
    cycles: seedCycles,
    status: 'active',
    counterfactuals: [],
  };
  sess.npcStates[npcA.id].innerLife.ruminationThreads.push(thread);
  sess.npcStates[npcA.id].innerLife.pepActive = true;
  sess.npcStates[npcA.id].innerLife.pepTarget = 'Player';

  return { session: sess, world: world(npcA, npcB), mem };
}

// Test 1: early cycles (post-increment = 2) cap distortion at 0.5
{
  const { session: sess, world: w, mem } = makeCycleGateSession(1);
  advanceAllCognition(sess, w, 'morning');
  assert.ok(
    (mem.realityGap ?? 0) <= 0.5,
    `Early cycles: expected realityGap <= 0.5, got ${mem.realityGap}`,
  );
  console.log(`early-cycles cap: realityGap = ${mem.realityGap} (expected <= 0.5) ✓`);
}

// Test 2: mid cycles (post-increment = 5) cap distortion at 0.75
{
  const { session: sess, world: w, mem } = makeCycleGateSession(4);
  advanceAllCognition(sess, w, 'morning');
  assert.ok(
    (mem.realityGap ?? 0) <= 0.75,
    `Mid cycles: expected realityGap <= 0.75, got ${mem.realityGap}`,
  );
  console.log(`mid-cycles cap: realityGap = ${mem.realityGap} (expected <= 0.75) ✓`);
}

// Test 3: late cycles (post-increment = 8) allow up to 0.92
{
  const { session: sess, world: w, mem } = makeCycleGateSession(7);
  advanceAllCognition(sess, w, 'morning');
  assert.ok(
    (mem.realityGap ?? 0) <= 0.92,
    `Late cycles: expected realityGap <= 0.92, got ${mem.realityGap}`,
  );
  console.log(`late-cycles cap: realityGap = ${mem.realityGap} (expected <= 0.92) ✓`);
}

console.log('cycle-gate maxAllowedGap checks passed');
