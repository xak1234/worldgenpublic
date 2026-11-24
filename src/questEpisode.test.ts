import assert from 'node:assert/strict';
import {
  abandonQuestEpisode,
  activateQuestEpisode,
  advanceQuestEpisode,
  describeQuestForDialogue,
  ensureQuestDiscoveryHook,
  getQuestStatus,
  refreshQuestPortalGates,
  travelQuestPortal,
} from './questEpisode.js';
import type { NPCLiveState, QuestDiscoveryHook, WorldDNA, WorldNPC, WorldSession } from './types.js';

function npc(id: string, name: string): WorldNPC {
  return {
    id,
    name,
    occupation: 'healer',
    relationships: [],
    approachability: 80,
    dailyRoutine: { morning: 'working', afternoon: 'working', evening: 'resting', night: 'sleeping', weekendDifference: 'same' },
    homeLocationId: 'home',
    workLocationId: 'square',
    frequentedLocations: ['square'],
    baselineMood: 'watchful',
  } as unknown as WorldNPC;
}

function world(id: string, concept: string): WorldDNA {
  const n = npc(`${id}-npc`, `${concept} Witness`);
  return {
    id,
    concept,
    createdAt: '1900-01-01T00:00:00.000Z',
    provider: 'test',
    geography: { region: concept, climate: 'wet' },
    economy: { blackMarket: '' },
    law: { corruption: 0 },
    locations: [
      { id: 'square', name: `${concept} Square`, type: 'square', description: '', connectedTo: ['gate'], regulars: [n.id] },
      { id: 'gate', name: `${concept} Gate`, type: 'gate', description: '', connectedTo: ['square'], regulars: [] },
    ],
    npcs: [n],
    timeline: [],
    npcSharedStates: {},
  } as unknown as WorldDNA;
}

function state(n: WorldNPC, worldId: string): NPCLiveState {
  return {
    npcId: n.id,
    worldId,
    currentLocationId: 'square',
    currentActivity: 'waiting',
    relationship: 'stranger',
    trustLevel: 50,
    familiarity: 0,
    warmth: 50,
    respect: 50,
    attraction: 0,
    fear: 0,
    mood: 'watchful',
    isAvailable: true,
    memories: [],
    totalInteractions: 0,
    lastInteractionDate: '1900-01-01',
    daysSinceLastSeen: 0,
    playerFacts: [],
    playerOpinion: '',
    gossipHeard: [],
    gossipShared: [],
    recentLifeEvents: [],
    currentWorry: '',
    currentGoal: '',
    activeGoals: [],
    promises: [],
    patternsNoticed: [],
    innerLife: {},
  } as unknown as NPCLiveState;
}

function hookFor(w: WorldDNA): QuestDiscoveryHook {
  const n = w.npcs[0];
  return {
    id: 'hook-1',
    status: 'available',
    templateId: 'plague-minor',
    type: 'plague',
    tier: 'Minor',
    title: 'A sickness has found a door',
    detail: 'Test hook',
    npcId: n.id,
    npcName: n.name,
    locationId: 'square',
    locationName: `${w.concept} Square`,
    createdAt: '1900-01-01T00:00:00.000Z',
    turnOffered: 0,
  };
}

function sessionFor(w: WorldDNA): WorldSession {
  return {
    id: 'session-1',
    worldId: w.id,
    playerName: 'Test Player',
    playerAge: 30,
    playerGender: 'unspecified',
    playerOccupation: 'traveller',
    playerBackstory: '',
    currentDate: '1900-01-01',
    currentTime: 9,
    currentLocationId: 'square',
    money: 0,
    isAlive: true,
    socialClass: 'newcomer',
    reputation: 'unknown',
    npcStates: Object.fromEntries(w.npcs.map(n => [n.id, state(n, w.id)])),
    visitedLocations: ['square'],
    dayCount: 1,
    significantEvents: [],
    communityMood: 'neutral',
    activeGossip: [],
    recentCommunityEvents: [],
    questHooks: [hookFor(w)],
    questEchoes: [],
  } as unknown as WorldSession;
}

{
  const w = world('world-a', 'A');
  const session = sessionFor(w);
  const result = activateQuestEpisode({ world: w, session, allWorlds: [w], hookId: 'hook-1' });
  assert.equal(result.quest, undefined);
  assert.match(result.error ?? '', /require 2 existing worlds/i);
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  const result = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(result.quest);
  assert.equal(result.quest.forkedWorldIds.length, 2);
  assert.ok(result.quest.forkedWorldIds.every(id => id.startsWith(`quest-${result.quest!.timelineId}`)));
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  session.globalPlayerId = 'global-player-1';
  session.questHooks![0].scope = 'global';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  quest.currentLocationId = 'gate';
  quest.participantLocations![session.id] = { worldId: quest.currentWorldId, locationId: 'gate' };
  const destination = quest.portals.find(portal => portal.fromWorldId !== quest.currentWorldId)!;
  const travel = travelQuestPortal(session, { worldId: destination.fromWorldId });
  assert.match(travel.error ?? '', /Reach .* before using that quest portal/);
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  session.globalPlayerId = 'global-player-1';
  session.questHooks![0].scope = 'global';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  const currentPortal = quest.portals.find(portal => portal.fromWorldId === quest.currentWorldId)!;
  delete (currentPortal as Partial<typeof currentPortal>).linkedWorldIds;
  const destination = quest.portals.find(portal => portal.fromWorldId !== quest.currentWorldId)!;
  destination.discovered = true;
  const travel = travelQuestPortal(session, { worldId: destination.fromWorldId, portalId: destination.id });
  assert.equal(travel.error, undefined);
  assert.equal(travel.destination?.fromWorldId, destination.fromWorldId);
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  session.globalPlayerId = 'global-player-1';
  session.questHooks![0].scope = 'global';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  session.currentLocationId = 'gate';
  const result = abandonQuestEpisode(session);
  assert.ok(result.echo);
  assert.equal(session.currentLocationId, 'square');
  assert.equal(session.activeQuest, undefined);
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const session = sessionFor(a);
  session.questHooks![0].tier = 'Standard';
  session.questHooks![0].templateId = 'plague-standard';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c], hookId: 'hook-1' });
  assert.ok(quest);
  assert.ok(
    quest.objectives[1].kind === 'persuasion' || quest.objectives[1].kind === 'obtain_from_npc',
    `first middle objective should be persuasion or obtain_from_npc, got ${quest.objectives[1].kind}`,
  );
  assert.ok(
    quest.objectives.some(o => o.kind === 'obtain' || o.kind === 'obtain_from_npc' || o.kind === 'obtain_from_location'),
    'quest should have at least one obtain-type objective',
  );
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  const firstNpc = quest.objectives[0].npcId!;
  advanceQuestEpisode(session, { kind: 'dialogue', npcId: firstNpc, worldId: quest.currentWorldId, locationId: quest.currentLocationId, summary: 'warning heard' });
  const secondObj = quest.objectives[1];
  assert.equal(secondObj.status, 'active');
  const miss = advanceQuestEpisode(session, {
    kind: 'dialogue',
    npcId: secondObj.npcId,
    worldId: secondObj.worldId,
    locationId: secondObj.locationId,
    summary: 'hello',
  });
  assert.equal(miss.completedObjective, undefined);
  // Use keyword that works for both persuasion and obtain_from_npc objectives
  const hit = advanceQuestEpisode(session, {
    kind: 'dialogue',
    npcId: secondObj.npcId,
    worldId: secondObj.worldId,
    locationId: secondObj.locationId,
    summary: secondObj.kind === 'obtain_from_npc' ? 'please give me the sample, hand over the evidence' : 'please trust me and change your mind',
  });
  assert.equal(hit.completedObjective?.id, secondObj.id);
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  const later = quest.objectives[1];
  assert.ok(later.npcId);
  const update = advanceQuestEpisode(session, {
    kind: 'dialogue',
    npcId: later.npcId,
    worldId: later.worldId,
    locationId: later.locationId,
    summary: 'trying to skip ahead',
  });
  assert.equal(update.completedObjective, undefined);
  assert.equal(quest.objectives.filter(o => o.status === 'complete').length, 0);
  assert.equal(quest.objectives[0].status, 'active');
  assert.equal(later.status, 'locked');
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  const before = quest.turnCounter;
  const update = advanceQuestEpisode(session, { kind: 'wait', turnCost: 1, worldId: quest.currentWorldId, locationId: quest.currentLocationId, summary: 'wait' });
  assert.ok(update.sprungTrap);
  assert.ok(quest.turnCounter > before + 1);
}

{
  // Type-check: QuestItem and inventory exist on QuestSessionState
  const item: import('./types.js').QuestItem = {
    id: 'item-1',
    name: 'Cursed Amulet',
    description: 'A dark pendant that hums with trapped energy.',
    sourceType: 'npc',
    sourceId: 'npc-seer',
    sourceName: 'The Seer',
    worldId: 'world-a',
    locationId: 'square',
    triggerKeywords: ['amulet', 'pendant', 'give me'],
    collected: false,
    requiredForObjectiveId: 'obj-1',
  };
  assert.equal(item.sourceType, 'npc');
  assert.equal(item.collected, false);
}

{
  // Verify quest activation produces items in inventory
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const session = sessionFor(a);
  session.questHooks![0].tier = 'Standard';
  session.questHooks![0].templateId = 'plague-standard';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c], hookId: 'hook-1' });
  assert.ok(quest);
  assert.ok(quest.inventory, 'quest should have inventory');
  assert.ok(quest.inventory.length > 0, 'Standard quest should have at least one item');
  assert.ok(quest.inventory.every(item => !item.collected), 'all items should start uncollected');
  const hasNpcItem = quest.inventory.some(item => item.sourceType === 'npc');
  const hasLocItem = quest.inventory.some(item => item.sourceType === 'location');
  assert.ok(hasNpcItem || hasLocItem, 'quest should have at least one obtainable item');
}

{
  // Verify obtain_from_npc and obtain_from_location objectives appear
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const d = world('world-d', 'D');
  const session = sessionFor(a);
  session.questHooks![0].tier = 'Major';
  session.questHooks![0].templateId = 'plague-major';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c, d], hookId: 'hook-1' });
  assert.ok(quest);
  const npcObtain = quest.objectives.filter(o => o.kind === 'obtain_from_npc');
  const locObtain = quest.objectives.filter(o => o.kind === 'obtain_from_location');
  assert.ok(npcObtain.length >= 1, 'Major quest should have at least one obtain_from_npc objective');
  assert.ok(locObtain.length >= 1, 'Major quest should have at least one obtain_from_location objective');
  for (const obj of [...npcObtain, ...locObtain]) {
    assert.ok(obj.requiredItemIds && obj.requiredItemIds.length > 0, `objective "${obj.title}" should have requiredItemIds`);
  }
}

{
  // NPC item collection via keyword in dialogue
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const session = sessionFor(a);
  session.questHooks![0].tier = 'Standard';
  session.questHooks![0].templateId = 'plague-standard';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c], hookId: 'hook-1' });
  assert.ok(quest);
  // Complete first objective (dialogue with hook NPC)
  const firstNpc = quest.objectives[0].npcId!;
  advanceQuestEpisode(session, { kind: 'dialogue', npcId: firstNpc, worldId: quest.currentWorldId, locationId: quest.currentLocationId, summary: 'warning heard' });

  // Find the first obtain_from_npc objective
  const npcObtainObj = quest.objectives.find(o => o.kind === 'obtain_from_npc' && o.status === 'active');
  assert.ok(npcObtainObj, 'Standard plague quest should produce an active obtain_from_npc objective');
  {
    const itemId = npcObtainObj.requiredItemIds![0];
    const item = quest.inventory.find(i => i.id === itemId)!;
    assert.ok(item, 'item should exist in inventory');
    assert.equal(item.collected, false);

    // Dialogue without keywords should NOT complete
    const miss = advanceQuestEpisode(session, {
      kind: 'dialogue',
      npcId: npcObtainObj.npcId,
      worldId: npcObtainObj.worldId,
      locationId: npcObtainObj.locationId,
      summary: 'hello there',
    });
    assert.equal(miss.completedObjective, undefined);
    assert.equal(item.collected, false);

    // Dialogue WITH trigger keyword should complete and collect item
    const hit = advanceQuestEpisode(session, {
      kind: 'dialogue',
      npcId: npcObtainObj.npcId,
      worldId: npcObtainObj.worldId,
      locationId: npcObtainObj.locationId,
      summary: 'I need the fever sample, please give me the vial',
    });
    assert.equal(hit.completedObjective?.id, npcObtainObj.id);
    assert.equal(item.collected, true);
    assert.ok(item.collectedAtTurn! > 0);
  }
}

{
  // Quest dialogue context should include item handoff instructions for the relevant NPC
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const session = sessionFor(a);
  session.questHooks![0].tier = 'Standard';
  session.questHooks![0].templateId = 'plague-standard';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c], hookId: 'hook-1' });
  assert.ok(quest);
  const npcItem = quest.inventory.find(i => i.sourceType === 'npc');
  assert.ok(npcItem, 'Standard plague quest should have an NPC-sourced item');
  const context = describeQuestForDialogue(session, npcItem.sourceId);
  assert.ok(context, 'dialogue context should exist');
  assert.ok(context!.includes(npcItem.name), `dialogue context should mention item "${npcItem.name}"`);
  assert.ok(context!.includes('words like'), 'dialogue context should include keyword hint for NPC');
}

{
  // Location item: wrong location does NOT complete, right location DOES
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const d = world('world-d', 'D');
  const session = sessionFor(a);
  session.questHooks![0].tier = 'Major';
  session.questHooks![0].templateId = 'plague-major';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c, d], hookId: 'hook-1' });
  assert.ok(quest);
  const locObtainObj = quest.objectives.find(o => o.kind === 'obtain_from_location');
  assert.ok(locObtainObj, 'Major plague quest should have an obtain_from_location objective');
  // Unlock it by completing all prior objectives
  for (const obj of quest.objectives) {
    if (obj.id === locObtainObj.id) break;
    if (obj.status === 'active' || obj.status === 'locked') {
      obj.status = 'complete';
      obj.completedAtTurn = quest.turnCounter;
    }
  }
  locObtainObj.status = 'active';
  const itemId = locObtainObj.requiredItemIds![0];
  const item = quest.inventory.find(i => i.id === itemId)!;
  assert.ok(item, 'location item should exist in inventory');
  // Wrong location should NOT complete
  const miss = advanceQuestEpisode(session, {
    kind: 'action',
    worldId: locObtainObj.worldId,
    locationId: 'wrong-location',
    summary: 'search the area carefully',
  });
  assert.equal(miss.completedObjective, undefined, 'wrong location should not complete objective');
  assert.equal(item.collected, false, 'item should remain uncollected');
  // Right location with search action should complete and collect
  const hit = advanceQuestEpisode(session, {
    kind: 'action',
    worldId: locObtainObj.worldId,
    locationId: locObtainObj.locationId,
    summary: 'search the area carefully',
  });
  assert.equal(hit.completedObjective?.id, locObtainObj.id, 'right location should complete objective');
  assert.equal(item.collected, true, 'item should be collected');
}

{
  // End-to-end: complete a quest that includes item objectives
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const session = sessionFor(a);
  session.questHooks![0].tier = 'Standard';
  session.questHooks![0].templateId = 'war-standard';
  session.questHooks![0].type = 'war';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c], hookId: 'hook-1' });
  assert.ok(quest);
  assert.ok(quest.inventory.length > 0, 'war quest should have items');

  // Complete all objectives sequentially
  for (const obj of quest.objectives) {
    if (obj.status !== 'active' && obj.status !== 'locked') continue;
    if (obj.status === 'locked') obj.status = 'active';

    if (obj.kind === 'obtain_from_npc') {
      const item = quest.inventory.find(i => obj.requiredItemIds?.includes(i.id))!;
      const keyword = item.triggerKeywords?.[0] ?? 'give me';
      advanceQuestEpisode(session, {
        kind: 'dialogue',
        npcId: obj.npcId,
        worldId: obj.worldId,
        locationId: obj.locationId,
        summary: `I need the ${keyword}`,
      });
    } else if (obj.kind === 'obtain_from_location') {
      advanceQuestEpisode(session, {
        kind: 'action',
        worldId: obj.worldId,
        locationId: obj.locationId,
        summary: 'search the area thoroughly',
      });
    } else if (obj.kind === 'dialogue') {
      advanceQuestEpisode(session, {
        kind: 'dialogue',
        npcId: obj.npcId,
        worldId: obj.worldId,
        locationId: obj.locationId,
        summary: 'tell me everything',
      });
    } else if (obj.kind === 'persuasion') {
      advanceQuestEpisode(session, {
        kind: 'dialogue',
        npcId: obj.npcId,
        worldId: obj.worldId,
        locationId: obj.locationId,
        summary: 'please trust me and change your mind',
      });
    } else if (obj.kind === 'obtain') {
      advanceQuestEpisode(session, {
        kind: 'dialogue',
        npcId: obj.npcId,
        worldId: obj.worldId,
        locationId: obj.locationId,
        summary: 'give me the proof',
      });
    } else {
      advanceQuestEpisode(session, {
        kind: 'action',
        worldId: obj.worldId,
        locationId: obj.locationId,
        summary: obj.kind === 'use_interactable' ? `inspect and use ${obj.interactableName}` : 'confront the truth and choose',
      });
    }
  }

  // All items should be collected
  const uncollected = quest.inventory.filter(i => !i.collected);
  assert.equal(uncollected.length, 0, 'all quest items should be collected after completing item objectives');
  // Quest should be resolved
  assert.ok(quest.status === 'succeeded' || quest.status === 'failed', 'quest should have resolved');
}

{
  // Abandoning quest clears items with the rest of quest state
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const session = sessionFor(a);
  session.questHooks![0].tier = 'Standard';
  session.questHooks![0].templateId = 'plague-standard';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c], hookId: 'hook-1' });
  assert.ok(quest);
  assert.ok(quest.inventory.length > 0);
  const result = abandonQuestEpisode(session);
  assert.ok(result.echo);
  assert.equal(session.activeQuest, undefined, 'quest should be cleared after abandonment');
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  session.globalPlayerId = 'global-player-1';
  session.questHooks![0].scope = 'global';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  for (const obj of quest.objectives) {
    if (obj.status === 'locked') obj.status = 'active';
    for (const req of obj.requirements ?? []) {
      if (req.kind === 'impossible_gift') {
        session.impossibleGiftsGiven = [...(session.impossibleGiftsGiven ?? []), { npcId: req.npcId, gift: 'a sunrise folded into glass', date: session.currentDate }];
      }
      if (req.kind === 'weather') {
        quest.currentWeather = { ...(session.currentWeather ?? {}), condition: req.condition } as typeof quest.currentWeather;
        session.currentWeather = { ...(session.currentWeather ?? quest.currentWeather), condition: req.condition } as typeof session.currentWeather;
      }
      if (req.kind === 'player_state') {
        session.playerAppearance = req.state === 'invisible' ? 'invisible, unseen by all' : 'wearing a dark robe';
      }
    }
    const event = obj.kind === 'dialogue' || obj.kind === 'persuasion' || obj.kind === 'obtain' || obj.kind === 'obtain_from_npc'
      ? { kind: 'dialogue' as const, npcId: obj.npcId, worldId: obj.worldId, locationId: obj.locationId, summary: obj.kind === 'persuasion' ? 'please trust me' : 'give me the proof' }
      : { kind: 'action' as const, worldId: obj.worldId, locationId: obj.locationId, summary: 'search confront cure contain choose' };
    advanceQuestEpisode(session, event);
  }
  assert.equal(quest.status, 'succeeded');
  assert.ok(session.medals?.some(m => m.id.startsWith('medal:plague:minor:')));
  assert.ok(session.achievements?.some(a => a.id.startsWith('achievement:plague:')));
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const session = sessionFor(a);
  session.globalPlayerId = 'global-player-1';
  session.questHooks = [];
  const hook = ensureQuestDiscoveryHook(a, session, [a, b, c], true);
  assert.ok(hook);
  assert.equal(hook.scope, 'global');
  assert.equal(hook.tier, 'Standard');
  assert.match(hook.title, /Global thread/);
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c], hookId: hook.id });
  assert.ok(quest);
  assert.equal(quest.scope, 'global');
  assert.equal(quest.title, hook.title);
  assert.equal(quest.detail, hook.detail);
  assert.ok(quest.log.some(line => /Global quest: medals/i.test(line)));
  const hiddenPortal = quest.portals.find(p => p.discovered === false);
  assert.ok(hiddenPortal);
  assert.match(travelQuestPortal(session, { portalId: hiddenPortal.id }).error ?? '', /unavailable|threshold|offering/i);
  const gated = quest.objectives.find(obj => obj.requirements?.some(req => req.kind === 'impossible_gift'));
  assert.ok(quest.objectives.some(obj => obj.requirements?.some(req => req.kind === 'weather')));
  assert.ok(quest.objectives.some(obj => obj.requirements?.some(req => req.kind === 'player_state')));
  assert.ok(gated);
  assert.match(gated.title, /impossible gift/i);
  const first = quest.objectives[0];
  advanceQuestEpisode(session, { kind: 'dialogue', npcId: first.npcId, worldId: first.worldId, locationId: first.locationId, summary: 'warning heard' });
  assert.equal(gated.status, 'active');
  const gatedPortal = quest.portals.find(p => p.fromWorldId === gated.worldId);
  assert.equal(gatedPortal?.discovered, true);
  const miss = advanceQuestEpisode(session, { kind: 'dialogue', npcId: gated.npcId, worldId: gated.worldId, locationId: gated.locationId, summary: gated.kind === 'persuasion' ? 'please trust me' : 'give me the proof' });
  assert.equal(miss.completedObjective, undefined);
  const req = gated.requirements!.find(item => item.kind === 'impossible_gift')!;
  session.impossibleGiftsGiven = [{ npcId: req.npcId, gift: 'a sunrise folded into glass', date: session.currentDate }];
  const hit = advanceQuestEpisode(session, { kind: 'dialogue', npcId: gated.npcId, worldId: gated.worldId, locationId: gated.locationId, summary: 'offered impossible gift' });
  assert.equal(hit.completedObjective?.id, gated.id);
  const next = quest.objectives.find(obj => obj.status === 'active');
  if (next?.worldId && !next.requirements?.some(item => item.kind === 'weather' || item.kind === 'player_state')) {
    assert.equal(quest.portals.find(p => p.fromWorldId === next.worldId)?.discovered, true);
  }
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  session.globalPlayerId = 'global-player-1';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  for (const obj of quest.objectives) {
    if (obj.status === 'locked') obj.status = 'active';
    const event = obj.kind === 'dialogue' || obj.kind === 'persuasion' || obj.kind === 'obtain' || obj.kind === 'obtain_from_npc'
      ? { kind: 'dialogue' as const, npcId: obj.npcId, worldId: obj.worldId, locationId: obj.locationId, summary: obj.kind === 'persuasion' ? 'please trust me' : 'give me the proof' }
      : { kind: 'action' as const, worldId: obj.worldId, locationId: obj.locationId, summary: 'search confront cure contain choose' };
    advanceQuestEpisode(session, event);
  }
  assert.equal(quest.status, 'succeeded');
  assert.equal(session.medals?.length ?? 0, 0, 'global player should not earn medals from local quests');
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const session = sessionFor(a);
  session.globalPlayerId = 'global-player-1';
  session.questHooks = [];
  session.currentWeather = { condition: 'clear', intensity: 'clear', precipitation: 'none', temperatureC: 18, wind: 'still', visibility: 'clear', thunder: false, lightning: false, mood: 'calm', effects: [], changedAt: '1900-01-01T09:00:00.000Z' };
  const hook = ensureQuestDiscoveryHook(a, session, [a, b, c], true);
  assert.ok(hook);
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c], hookId: hook.id });
  assert.ok(quest);
  const weatherObj = quest.objectives.find(obj => obj.requirements?.some(req => req.kind === 'weather'));
  assert.ok(weatherObj);
  quest.objectives.forEach(obj => { obj.status = obj.id === weatherObj.id ? 'active' : 'locked'; });
  const portal = quest.portals.find(p => p.fromWorldId === weatherObj.worldId);
  assert.ok(portal);
  portal.discovered = false;
  assert.match(travelQuestPortal(session, { portalId: portal.id }).error ?? '', /air is wrong|threshold/i);
  assert.equal(refreshQuestPortalGates(session).length, 0);
  const req = weatherObj.requirements!.find(item => item.kind === 'weather')!;
  const gatedWeather = { ...session.currentWeather, condition: req.condition };
  quest.currentWeather = gatedWeather;
  session.currentWeather = gatedWeather;
  assert.equal(refreshQuestPortalGates(session)[0]?.id, portal.id);
  assert.equal(portal.discovered, true);
  portal.discovered = false;
  advanceQuestEpisode(session, { kind: 'dialogue', npcId: weatherObj.npcId, worldId: weatherObj.worldId, locationId: weatherObj.locationId, summary: 'what does the threshold want?' });
  assert.equal(weatherObj.clueDiscovered, true);
  assert.ok(weatherObj.clueText);
  portal.discovered = true;
  assert.ok(describeQuestForDialogue(session, weatherObj.npcId)?.includes('sensitive to weather'));
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const session = sessionFor(a);
  session.globalPlayerId = 'global-player-1';
  session.questHooks = [];
  const hook = ensureQuestDiscoveryHook(a, session, [a, b, c], true);
  assert.ok(hook);
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c], hookId: hook.id });
  assert.ok(quest);
  const stateObj = quest.objectives.find(obj => obj.requirements?.some(req => req.kind === 'player_state'));
  assert.ok(stateObj);
  quest.objectives.forEach(obj => { obj.status = obj.id === stateObj.id ? 'active' : 'locked'; });
  const portal = quest.portals.find(p => p.fromWorldId === stateObj.worldId);
  assert.ok(portal);
  portal.discovered = false;
  assert.match(travelQuestPortal(session, { portalId: portal.id }).error ?? '', /threshold|visible|uncovered|silhouette/i);
  assert.equal(refreshQuestPortalGates(session).length, 0);
  const req = stateObj.requirements!.find(item => item.kind === 'player_state')!;
  session.playerAppearance = req.state === 'invisible' ? 'invisible, unseen by all' : 'wearing a dark robe';
  assert.equal(refreshQuestPortalGates(session)[0]?.id, portal.id);
  assert.equal(portal.discovered, true);
  assert.ok(describeQuestForDialogue(session, stateObj.npcId)?.includes("sensitive to the player's state"));
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  for (const obj of quest.objectives) {
    if (obj.status === 'locked') obj.status = 'active';
    const event = obj.kind === 'dialogue' || obj.kind === 'persuasion' || obj.kind === 'obtain' || obj.kind === 'obtain_from_npc'
      ? { kind: 'dialogue' as const, npcId: obj.npcId, worldId: obj.worldId, locationId: obj.locationId, summary: obj.kind === 'persuasion' ? 'please trust me' : 'give me the proof' }
      : { kind: 'action' as const, worldId: obj.worldId, locationId: obj.locationId, summary: 'search confront cure contain choose' };
    advanceQuestEpisode(session, event);
  }
  assert.equal(quest.status, 'succeeded');
  assert.equal(session.medals?.length ?? 0, 0, 'local sessions should not earn global medals');
  assert.equal(session.achievements?.length ?? 0, 0, 'local sessions should not earn global achievements');
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  session.globalPlayerId = 'global-player-1';
  session.questHooks![0].requirements = [{ kind: 'medal', id: 'medal:plague:minor', label: 'Minor Plague Medal' }];
  const blocked = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.equal(blocked.quest, undefined);
  assert.match(blocked.error ?? '', /requirements not met/i);
  const status = getQuestStatus(session);
  assert.equal(status.hooks.length, 0);
  assert.equal(status.lockedHooks[0].missingRequirements[0], 'Minor Plague Medal');
  session.medals = [{ id: 'medal:plague:minor', name: 'Minor Plague Medal', tier: 'Minor', questType: 'plague', earnedAt: '1900-01-01T00:00:00.000Z' }];
  const allowed = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(allowed.quest);
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  session.currentWeather = { condition: 'rain', intensity: 'moderate', precipitation: 'rain', temperatureC: 12, wind: 'still', visibility: 'clear', thunder: false, lightning: false, mood: 'wet', effects: [], changedAt: '1900-01-01T09:00:00.000Z' };
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  const obj = quest.objectives[0];
  obj.requirements = [{ kind: 'weather', condition: 'fog', label: 'Fog' }];
  const miss = advanceQuestEpisode(session, { kind: 'dialogue', npcId: obj.npcId, worldId: obj.worldId, locationId: obj.locationId, summary: 'warning heard' });
  assert.equal(miss.completedObjective, undefined);
  quest.currentWeather = { ...session.currentWeather, condition: 'fog' };
  const hit = advanceQuestEpisode(session, { kind: 'dialogue', npcId: obj.npcId, worldId: obj.worldId, locationId: obj.locationId, summary: 'warning heard' });
  assert.equal(hit.completedObjective?.id, obj.id);
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  session.globalPlayerId = 'global-player-1';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  const obj = quest.objectives[0];
  obj.requirements = [{ kind: 'player_state', state: 'invisible', label: 'Invisible' }];
  const miss = advanceQuestEpisode(session, { kind: 'dialogue', npcId: obj.npcId, worldId: obj.worldId, locationId: obj.locationId, summary: 'warning heard' });
  assert.equal(miss.completedObjective, undefined);
  session.playerAppearance = 'invisible, unseen by all';
  const hit = advanceQuestEpisode(session, { kind: 'dialogue', npcId: obj.npcId, worldId: obj.worldId, locationId: obj.locationId, summary: 'warning heard' });
  assert.equal(hit.completedObjective?.id, obj.id);
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  session.globalPlayerId = 'global-player-1';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  const first = quest.objectives[0];
  const second = quest.objectives[1];
  first.emitsFacts = [{ id: 'fact:convinced-witness', kind: 'persuasion', worldId: first.worldId, npcId: first.npcId, summary: 'The witness accepts the claim.' }];
  second.requirements = [{ kind: 'quest_fact', id: 'fact:convinced-witness', label: 'Witness convinced in another world' }];
  advanceQuestEpisode(session, { kind: 'dialogue', npcId: first.npcId, worldId: first.worldId, locationId: first.locationId, summary: 'warning heard' });
  assert.ok(session.questFacts?.some(f => f.id === 'fact:convinced-witness'));
  assert.equal(second.status, 'active');
  const hit = advanceQuestEpisode(session, { kind: 'dialogue', npcId: second.npcId, worldId: second.worldId, locationId: second.locationId, summary: second.kind === 'persuasion' ? 'please trust me' : 'give me the proof' });
  assert.equal(hit.completedObjective?.id, second.id);
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  const obj = quest.objectives[0];
  const npcId = obj.npcId!;
  obj.requirements = [{ kind: 'impossible_gift', npcId, label: 'Impossible gift', hintText: 'a gift that could not exist normally' }];
  const miss = advanceQuestEpisode(session, { kind: 'dialogue', npcId, worldId: obj.worldId, locationId: obj.locationId, summary: 'warning heard' });
  assert.equal(miss.completedObjective, undefined);
  session.impossibleGiftsGiven = [{ npcId: 'someone-else', gift: 'a moonlit key', date: session.currentDate }];
  const wrongNpc = advanceQuestEpisode(session, { kind: 'dialogue', npcId, worldId: obj.worldId, locationId: obj.locationId, summary: 'warning heard' });
  assert.equal(wrongNpc.completedObjective, undefined);
  session.impossibleGiftsGiven.push({ npcId, gift: 'a moonlit key', date: session.currentDate });
  const hit = advanceQuestEpisode(session, { kind: 'dialogue', npcId, worldId: obj.worldId, locationId: obj.locationId, summary: 'warning heard' });
  assert.equal(hit.completedObjective?.id, obj.id);
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  const obj = quest.objectives[0];
  const npcId = obj.npcId!;
  obj.requirements = [{ kind: 'impossible_gift', npcId, giftPattern: 'star', label: 'Star gift' }];
  session.npcStates[npcId].impossibleGiftsReceived = [{ gift: 'a moonlit key', date: session.currentDate }];
  const wrongGift = advanceQuestEpisode(session, { kind: 'dialogue', npcId, worldId: obj.worldId, locationId: obj.locationId, summary: 'warning heard' });
  assert.equal(wrongGift.completedObjective, undefined);
  session.npcStates[npcId].impossibleGiftsReceived.push({ gift: 'a star folded into paper', date: session.currentDate });
  const hit = advanceQuestEpisode(session, { kind: 'dialogue', npcId, worldId: obj.worldId, locationId: obj.locationId, summary: 'warning heard' });
  assert.equal(hit.completedObjective?.id, obj.id);
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const session = sessionFor(a);
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b], hookId: 'hook-1' });
  assert.ok(quest);
  const obj = quest.objectives[0];
  const npcId = obj.npcId!;
  obj.requirements = [{ kind: 'impossible_gift', npcId, giftPattern: 'mirror', hintText: 'a reflection that remembers' }];
  const context = describeQuestForDialogue(session, npcId);
  assert.ok(context?.includes('impossible gift requirement'));
  assert.ok(context?.includes('reflection that remembers'));
}

{
  const a = world('world-a', 'A');
  const b = world('world-b', 'B');
  const c = world('world-c', 'C');
  const session = sessionFor(a);
  session.questHooks![0].tier = 'Standard';
  session.questHooks![0].templateId = 'plague-standard';
  const { quest } = activateQuestEpisode({ world: a, session, allWorlds: [a, b, c], hookId: 'hook-1' });
  assert.ok(quest);
  for (const obj of quest.objectives.filter(o => o.npcId && ['dialogue', 'persuasion', 'obtain', 'obtain_from_npc'].includes(o.kind))) {
    const questWorld = quest.forkedWorldData?.[obj.worldId];
    assert.ok(questWorld, `objective world ${obj.worldId} should exist`);
    const targetNpc = questWorld.npcs.find(n => n.id === obj.npcId);
    assert.ok(targetNpc, `objective NPC ${obj.npcId} should exist in ${obj.worldId}`);
    const targetLocation = questWorld.locations.find(l => l.id === obj.locationId);
    assert.ok(targetLocation, `objective location ${obj.locationId} should exist in ${obj.worldId}`);
    const npcLocations = new Set([targetNpc.homeLocationId, targetNpc.workLocationId, ...(targetNpc.frequentedLocations ?? [])]);
    assert.ok(
      targetLocation.regulars?.includes(targetNpc.id) || npcLocations.has(targetLocation.id),
      `${targetNpc.name} should be locatable at objective location ${targetLocation.name}`,
    );
  }
}

console.log('quest episode checks passed');
