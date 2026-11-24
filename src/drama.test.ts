import assert from 'node:assert/strict';
import { createDefaultInnerLife } from './innerLife.js';
import { deriveDramaLeads, summarizeInteractionConsequences } from './drama.js';
import type { NPCLiveState, WorldDNA, WorldNPC, WorldSession } from './types.js';

function npc(id: string, name: string): WorldNPC {
  return {
    id,
    name,
    age: 35,
    gender: 'unspecified',
    occupation: 'shopkeeper',
    physicalDescription: 'tired eyes',
    personality: 'guarded',
    voiceAnchor: 'Plain spoken.',
    speechPatterns: [],
    coreConcerns: ['being respected'],
    signature: 'watchful',
    traits: ['practical'],
    secrets: [],
    desires: ['keep the shop afloat'],
    fears: ['public shame'],
    opinions: {},
    backstory: 'A steady local.',
    dailyRoutine: { morning: 'working', afternoon: 'working', evening: 'at the pub', night: 'home', weekendDifference: 'rests' },
    homeLocationId: 'home',
    workLocationId: 'shop',
    frequentedLocations: ['shop'],
    socialClass: 'working',
    relationships: [],
    baselineMood: 'guarded',
    temperament: 'careful',
    approachability: 60,
    loyaltyThreshold: 5,
    attachmentStyle: 'anxious',
    processingType: 'moderate_rumination',
    primaryDefense: 'withdrawal',
    selfAwarenessLevel: 40,
    coreWound: 'was abandoned',
    woundTriggers: ['leave'],
    selfConcept: ['I am on my own'],
    values: ['honesty'],
  };
}

function state(n: WorldNPC): NPCLiveState {
  return {
    npcId: n.id,
    worldId: 'world-1',
    relationship: 'wary',
    trustLevel: 20,
    familiarity: 10,
    warmth: 35,
    respect: 50,
    attraction: 0,
    fear: 70,
    mood: 'guarded',
    currentLocationId: 'shop',
    currentActivity: 'counting money behind the counter',
    isAvailable: true,
    memories: [],
    totalInteractions: 1,
    lastInteractionDate: '1900-01-01',
    daysSinceLastSeen: 0,
    playerFacts: [],
    playerOpinion: 'Not sure whether to trust you.',
    gossipHeard: [],
    gossipShared: [],
    recentLifeEvents: [],
    currentWorry: 'being humiliated',
    currentGoal: 'keep control',
    activeGoals: [{
      id: 'goal-1',
      description: 'Find out who has been spreading rumors',
      motivation: 'self-protection',
      type: 'social',
      progress: 10,
      startedDate: '1900-01-01',
      blockers: [],
      willingness: 80,
      secretGoal: false,
      dailyActions: [],
      locationPreferences: ['shop'],
      avoidLocations: [],
      socialBehaviour: 'watchful',
    }],
    promises: [{
      id: 'promise-1',
      madeByPlayer: true,
      description: 'You said you would return with the missing ledger.',
      madeOnDate: '1900-01-01',
      status: 'pending',
      importanceToNPC: 80,
    }],
    patternsNoticed: [],
    innerLife: createDefaultInnerLife(n.attachmentStyle, n.processingType, n.primaryDefense as any),
  };
}

function worldAndSession(): { world: WorldDNA; session: WorldSession; npc: WorldNPC; state: NPCLiveState } {
  const n = npc('npc-1', 'Ada Vale');
  const s = state(n);
  const world: WorldDNA = {
    id: 'world-1',
    concept: 'A tense market town',
    createdAt: '1900-01-01T00:00:00.000Z',
    provider: 'test',
    era: { period: 'Edwardian', yearStart: 1900, yearEnd: 1910, dateFormat: 'YYYY-MM-DD', majorWorldEvents: [] },
    geography: { region: 'North', country: 'England', climate: 'wet', terrain: 'town', scale: 'neighbourhood', landmarks: [] },
    culture: { language: 'English', dialect: 'local', slang: {}, greetings: [], socialClasses: [], religion: '', customs: [], taboos: [], music: '', food: [], entertainment: [], genderRoles: '', socialNorms: [] },
    economy: { currency: 'pound', symbol: '£', averageDailyWage: 1, prices: {}, jobs: [], blackMarket: '' },
    law: { system: 'local', enforcers: 'constables', corruption: 10, vices: [], consequences: '' },
    weather: { seasons: [], dominantWeather: 'rain' },
    technology: { era: 'early modern', transport: [], communication: [], lighting: '', media: [], domesticLife: '' },
    narrativeStyle: { voice: 'plain', tense: 'second', toneKeywords: [], literaryInfluences: [], sampleParagraph: '', forbiddenWords: [], sensoryPalette: [] },
    populationBlueprint: {
      totalPopulation: 100,
      populationDensity: 'town',
      communityType: 'market town',
      ageDistribution: [],
      genderBalance: { male: 50, female: 50, other: 0, reasoning: '' },
      ethnicComposition: [],
      classDistribution: [],
      familyStructures: [],
      socialCohesion: 60,
      outsiderFrequency: 'rare',
      newcomerReception: 'wary',
      occupationCategories: [],
      unemploymentRate: 0.1,
      powerStructure: 'class-stratified',
      influentialRoles: [],
      personalitySpread: { warmToHostile: 'mixed', trustLevel: 'low', humorPresent: true, darknessLevel: 'medium', volatility: 'medium', requiredPersonalities: [] },
      requiredArchetypes: [],
      averageRelationshipsPerPerson: 2,
      romancePresent: true,
      rivalriesPresent: true,
      secretsPerPerson: 1,
      reasoning: '',
    },
    locations: [{ id: 'shop', name: 'Ada Shop', type: 'shop', description: 'A cramped shop.', ambientDetail: 'Coins scrape on the counter.', connectedTo: [], socialClass: 'working', openHours: 'always', regulars: ['npc-1'], interactables: ['ledger'], privacyLevel: 'public', capacity: 'tight' }],
    npcs: [n],
    timeline: [],
    simulationRules: { gossipSpeed: 0.8, communitySize: 'small', socialMobility: 'low', privacyLevel: 'low', conflictStyle: 'indirect', trustCulture: 'earned', reputationMatters: true, rumoursSpread: true },
    timeOfDay: { periods: [{ name: 'morning', hourStart: 6, hourEnd: 12, atmosphere: '', npcActivity: '', openLocations: [] }] },
  };
  const session: WorldSession = {
    id: 'session-1',
    worldId: world.id,
    playerName: 'Sam',
    playerAge: 30,
    playerGender: 'unspecified',
    playerOccupation: 'traveller',
    playerBackstory: '',
    currentDate: '1900-01-01',
    currentTime: 9,
    currentLocationId: 'shop',
    money: 1,
    isAlive: true,
    socialClass: 'newcomer',
    reputation: 'unknown',
    npcStates: { [n.id]: s },
    visitedLocations: ['shop'],
    dayCount: 1,
    significantEvents: [],
    communityMood: 'neutral',
    activeGossip: [{ fromNpcId: n.id, content: 'The ledger went missing after closing.', date: '1900-01-01', sentiment: 'warning', isTrue: true }],
    recentCommunityEvents: [],
  };
  return { world, session, npc: n, state: s };
}

{
  const { world, session } = worldAndSession();
  const leads = deriveDramaLeads(world, session);
  assert.ok(leads.some(lead => lead.type === 'promise'));
  assert.ok(leads.some(lead => lead.type === 'rumor'));
  assert.ok(leads.some(lead => lead.type === 'tension'));
}

{
  const { world, session } = worldAndSession();
  world.npcs[0].secrets = ['Ada is hiding an affair with a married supplier.'];
  world.npcs[0].relationships = [{ npcId: 'npc-2', type: 'rival', description: 'They had a public row over stolen takings.', strength: 15 }];
  session.activeGossip.push({ fromNpcId: 'npc-1', content: 'Ada lied about where the missing ledger went.', date: '1900-01-01', sentiment: 'warning', isTrue: false });
  const leads = deriveDramaLeads(world, session, 10);
  assert.ok(leads.some(lead => lead.type === 'affair'));
  assert.ok(leads.some(lead => lead.type === 'lie'));
  assert.ok(leads.some(lead => lead.type === 'argument'));
}

{
  const { world, npc, state } = worldAndSession();
  const consequences = summarizeInteractionConsequences({
    world,
    npc,
    before: { relationship: 'stranger', trustLevel: 10, warmth: 30, fear: 70, totalInteractions: 0 },
    after: { ...state, relationship: 'acquaintance', trustLevel: 18, warmth: 26 },
    result: { trustDelta: 8, warmthDelta: -4, newRelationship: 'acquaintance', gossip: 'Ada says you pushed too hard.' },
    promiseDetected: 'You promised to come back.',
    impossibleGift: null,
  });
  assert.ok(consequences.some(item => item.type === 'relationship'));
  assert.ok(consequences.some(item => item.type === 'promise'));
  assert.ok(consequences.some(item => item.type === 'gossip'));
}

console.log('drama checks passed');
