import assert from 'node:assert/strict';
import { createDefaultInnerLife } from './innerLife.js';
import type { NPCLiveState, WorldNPC } from './types.js';
import {
  inferInteractionKind,
  interpretPlayerInteraction,
  parsePlayerInteractionRequest,
  shouldApplyPlayerIntentInterpretation,
} from './playerIntent.js';

function npc(attachmentStyle: WorldNPC['attachmentStyle']): WorldNPC {
  return {
    id: 'npc-1',
    name: 'Test NPC',
    age: 34,
    gender: 'unspecified',
    occupation: 'printer',
    physicalDescription: 'watchful eyes',
    personality: 'careful',
    voiceAnchor: 'Speaks carefully.',
    speechPatterns: [],
    coreConcerns: ['being misread'],
    signature: 'quiet',
    traits: ['watchful'],
    secrets: [],
    desires: ['be understood'],
    fears: ['being controlled'],
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
    attachmentStyle,
    processingType: 'moderate_rumination',
    primaryDefense: 'withdrawal',
    selfAwarenessLevel: 40,
    coreWound: 'was shamed for needing help',
    woundTriggers: ['leave', 'pity'],
    selfConcept: ['I should not need anyone'],
    values: ['dignity'],
  };
}

function state(n: WorldNPC): NPCLiveState {
  return {
    npcId: n.id,
    worldId: 'world-1',
    relationship: 'acquaintance',
    trustLevel: 60,
    familiarity: 20,
    warmth: 55,
    respect: 50,
    attraction: 0,
    fear: 20,
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
    currentGoal: 'be understood',
    activeGoals: [],
    promises: [],
    patternsNoticed: [],
    innerLife: createDefaultInnerLife(n.attachmentStyle, n.processingType, n.primaryDefense as any),
  };
}

assert.equal(shouldApplyPlayerIntentInterpretation(false, true), false);
assert.equal(shouldApplyPlayerIntentInterpretation(true, true), true);
assert.equal(shouldApplyPlayerIntentInterpretation(true, false), false);
assert.equal(shouldApplyPlayerIntentInterpretation(true, undefined), false);
assert.equal(shouldApplyPlayerIntentInterpretation(false, false), false);

{
  const parsed = parsePlayerInteractionRequest({ npcId: 'npc-1', message: 'Hello there' });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.interaction?.declaredIntent, 'say');
  assert.equal(parsed.interaction?.kind, 'speech');
  assert.equal(parsed.interaction?.expression, 'Hello there');
  assert.equal(parsed.interaction?.message, 'Hello there');
}

{
  const parsed = parsePlayerInteractionRequest({ npcId: 'npc-1', expression: 'I listen quietly', declaredIntent: 'listen' });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.interaction?.message, 'I listen quietly');
  assert.equal(parsed.interaction?.expression, 'I listen quietly');
  assert.equal(parsed.interaction?.declaredIntent, 'listen');
  assert.equal(parsed.interaction?.kind, 'presence');
}

{
  const parsed = parsePlayerInteractionRequest({
    npcId: 'npc-1',
    expression: 'I will come back tomorrow.',
    declaredIntent: 'make_promise',
    kind: 'speech',
    enablePlayerIntentInterpretation: true,
  });
  assert.equal(shouldApplyPlayerIntentInterpretation(false, true), false);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.interaction?.declaredIntent, 'make_promise');
  assert.equal(parsed.interaction?.expression, 'I will come back tomorrow.');
  assert.equal(parsed.interaction?.kind, 'speech');
}

{
  const parsed = parsePlayerInteractionRequest({ npcId: 'npc-1', message: 'A normal sentence', declaredIntent: 'unknown', kind: 'unknown' });
  assert.equal(parsed.interaction?.declaredIntent, 'say');
  assert.equal(parsed.interaction?.kind, 'speech');
}

assert.equal(inferInteractionKind('stay_silent'), 'silence');
assert.equal(inferInteractionKind('listen'), 'presence');
assert.equal(inferInteractionKind('leave'), 'action');
assert.equal(inferInteractionKind('comfort'), 'speech');

{
  const n = npc('secure');
  const s = state(n);
  const parsed = parsePlayerInteractionRequest({ npcId: n.id, message: 'I am here with you.', declaredIntent: 'comfort' }).interaction!;
  const interpretation = interpretPlayerInteraction(parsed, n, s);
  assert.equal(interpretation.perceivedIntent, 'care');
}

{
  const n = npc('avoidant');
  const s = state(n);
  s.innerLife.affect.shame = 0.85;
  const parsed = parsePlayerInteractionRequest({ npcId: n.id, message: 'I am here with you.', declaredIntent: 'comfort' }).interaction!;
  const interpretation = interpretPlayerInteraction(parsed, n, s);
  assert.ok(
    ['pity', 'control', 'dismissal'].includes(interpretation.perceivedIntent),
    `expected pity/control/dismissal, got ${interpretation.perceivedIntent}`,
  );
}

{
  const n = npc('secure');
  const s = state(n);
  const comfort = interpretPlayerInteraction(
    parsePlayerInteractionRequest({ npcId: n.id, message: 'I am here with you.', declaredIntent: 'comfort' }).interaction!,
    n,
    s,
  );
  const confront = interpretPlayerInteraction(
    parsePlayerInteractionRequest({ npcId: n.id, message: 'That was wrong.', declaredIntent: 'confront' }).interaction!,
    n,
    s,
  );
  assert.ok(confront.pressure > comfort.pressure);
}

{
  const n = npc('anxious');
  const s = state(n);
  const say = interpretPlayerInteraction(
    parsePlayerInteractionRequest({ npcId: n.id, message: 'I will try.', declaredIntent: 'say' }).interaction!,
    n,
    s,
  );
  const promise = interpretPlayerInteraction(
    parsePlayerInteractionRequest({ npcId: n.id, message: 'I will come back tomorrow.', declaredIntent: 'make_promise' }).interaction!,
    n,
    s,
  );
  assert.ok(promise.promiseRisk > say.promiseRisk);
}

console.log('player intent checks passed');
