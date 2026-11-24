#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : process.cwd());
const dataDir = join(root, 'data');
const observatoryPath = join(root, 'public', 'observatory.html');
const expectedTabs = ['psych', 'affect', 'attach', 'aware', 'wounds', 'defense', 'rel', 'mem', 'truth', 'rum', 'traj', 'identity', 'contagion', 'conv', 'goals', 'npcrel', 'dreams', 'body', 'loyalty', 'observe', 'raw'];
const errors = [];
const warnings = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function hasConversationRecords(st) {
  return arr(st.conversationHistory).length > 0
    || arr(st.activeConversation).length > 0
    || arr(st.memories).some(m => m && (m.playerMessage || m.npcReply || m.kind === 'conversation' || m.type === 'conversation' || arr(m.lines).length || arr(m.exchanges).length));
}

function hasTab(tab, npc, st, session) {
  const il = st.innerLife || {};
  const af = il.affect || {};
  const env = st.environmentalAwareness || {};
  const hasEnv = arr(env.knownScarcities).length || arr(env.recentArrivals).length || arr(env.recentDepartures).length || arr(env.locationChanges).length || env.lastWeatherReaction;
  if (tab === 'raw') return true;
  if (tab === 'psych') return !!(npc.attachmentStyle || npc.processingType || npc.primaryDefense || npc.selfAwarenessLevel || npc.coreWound || arr(npc.woundTriggers).length || arr(npc.selfConcept).length || arr(npc.values).length || st.currentWorry || st.currentGoal || st.playerOpinion || il.pepActive || arr(il.dreams).length || arr(il.intentions).length);
  if (tab === 'affect') return !!il.affect || ['valence', 'arousal', 'dominance'].some(k => Math.abs(af[k] || 0) >= 0.03) || ['anger', 'fear', 'sadness', 'joy', 'loneliness', 'desire', 'trust', 'shame', 'guilt', 'pride', 'resentment', 'nostalgia', 'contempt', 'gratitude', 'anticipation', 'tenderness', 'relief', 'envy', 'surprise', 'disgust'].some(k => (af[k] || 0) >= 0.03);
  if (tab === 'rel') return !!(st.relationship || (st.totalInteractions || 0) > 0 || (st.trustLevel || st.trust || 0) > 0 || (st.warmth || 0) > 0 || (il.theoryOfPlayer && Object.keys(il.theoryOfPlayer).length) || arr(st.gossipHeard).length || st.pendingApproach || (st.playerVisitFrequency || 0) > 0 || st.playerOpinion);
  if (tab === 'mem') return arr(st.memories).length > 0;
  if (tab === 'truth') return arr(st.memories).length > 0;
  if (tab === 'rum') return arr(il.ruminationThreads).length > 0;
  if (tab === 'traj') return arr(il.trajectory).length > 0;
  if (tab === 'identity') return arr(il.actorStream).length > 0 || arr(il.observerStream).length > 0;
  if (tab === 'contagion') return arr(il.internalBeliefs).length > 0 || arr(session.contagionEvents).some(e => e.fromNpcId === npc.id || e.toNpcId === npc.id);
  if (tab === 'conv') return hasConversationRecords(st);
  if (tab === 'goals') return arr(st.activeGoals).length > 0 || st.currentGoal || st.currentWorry || arr(npc.desires).length > 0;
  if (tab === 'npcrel') return arr(npc.relationships).length > 0;
  if (tab === 'dreams') return arr(il.dreams).length > 0;
  if (tab === 'body') return !!(st.bodyHabits && (arr(st.bodyHabits.toiletVisits).length || arr(st.bodyHabits.bowelMovements).length || arr(st.bodyHabits.recentEvents).length || st.bodyHabits.lastNote));
  if (tab === 'loyalty') return arr(il.loyaltyConflicts).length > 0 || arr(st.emotionalContagionLog).length > 0;
  if (tab === 'observe') return (st.playerVisitFrequency || 0) > 0 || (st.playerAvoidanceScore || 0) > 0 || arr(st.lastLocationsSeen).length > 0 || arr(st.patternsNoticed).length > 0 || arr(st.memories).some(m => m?.isWitnessed) || arr(st.npcRequests).length > 0 || st.pendingApproach || arr(st.recentLifeEvents).length > 0 || arr(st.impossibleGiftsReceived).length > 0 || hasEnv;
  return false;
}

const obs = readFileSync(observatoryPath, 'utf8');
const tabLiteralMatch = obs.match(/\[\['psych','Psychology'[\s\S]+?\]\.forEach\(function\(t\)/);
const tabIds = tabLiteralMatch ? Array.from(tabLiteralMatch[0].matchAll(/\['([^']+)'/g)).map(m => m[1]) : [];
if (tabIds.join('|') !== expectedTabs.join('|')) errors.push(`observatory tab list mismatch: ${tabIds.join(', ') || '(none)'}`);
for (const tab of expectedTabs) {
  if (!obs.includes(`DTAB==='${tab}'`)) errors.push(`missing render branch for tab: ${tab}`);
  if (!obs.includes(`tabId==='${tab}'`)) errors.push(`missing availability branch for tab: ${tab}`);
}

const worlds = new Map();
for (const file of readdirSync(dataDir).filter(f => /^world-.+\.json$/i.test(f))) {
  const world = readJson(join(dataDir, file));
  worlds.set(world.id, world);
}

let checkedStates = 0;
for (const file of readdirSync(dataDir).filter(f => /^session-.+\.json$/i.test(f))) {
  const session = readJson(join(dataDir, file));
  const world = worlds.get(session.worldId);
  if (!world) {
    warnings.push(`${file}: missing world ${session.worldId}`);
    continue;
  }
  const npcById = new Map(arr(world.npcs).map(n => [n.id, n]));
  for (const [npcId, st] of Object.entries(session.npcStates || {})) {
    const npc = npcById.get(npcId);
    if (!npc) continue;
    checkedStates++;
    if (st.currentWorry && !hasTab('goals', npc, st, session)) errors.push(`${file}: ${npcId} currentWorry hidden from Goals`);
    if (st.playerOpinion && !hasTab('psych', npc, st, session)) errors.push(`${file}: ${npcId} playerOpinion hidden from Psychology`);
    if (arr(st.recentLifeEvents).length && !hasTab('observe', npc, st, session)) errors.push(`${file}: ${npcId} recentLifeEvents hidden from Observations`);
    if (arr(st.impossibleGiftsReceived).length && !hasTab('observe', npc, st, session)) errors.push(`${file}: ${npcId} impossibleGiftsReceived hidden from Observations`);
    if (st.innerLife?.affect && !hasTab('affect', npc, st, session)) errors.push(`${file}: ${npcId} affect hidden from Affect`);
    if (hasConversationRecords(st) && !hasTab('conv', npc, st, session)) errors.push(`${file}: ${npcId} conversation records hidden from Conversations`);
  }
}

const result = { checkedStates, tabs: expectedTabs.length, errors, warnings };
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`NPC state wiring: ${checkedStates} NPC states checked, ${expectedTabs.length} tabs audited`);
  for (const warning of warnings) console.warn(`WARN ${warning}`);
  for (const error of errors) console.error(`ERROR ${error}`);
}
process.exit(errors.length ? 1 : 0);
