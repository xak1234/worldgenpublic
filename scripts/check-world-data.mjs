#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, join, normalize, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  options: {
    root: { type: 'string' },
    json: { type: 'boolean', default: false },
    'photos-only': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
const jsonMode = Boolean(values.json);
const photosOnly = Boolean(values['photos-only']);
const root = resolve(values.root || positionals[0] || join(scriptDir, '..'));
const dataDir = join(root, 'data');
const publicDir = join(root, 'public');
const generatedDir = join(publicDir, 'generated');

const errors = [];
const warnings = [];
const missingPhotos = [];
const referencedGeneratedFiles = new Set();
const integritySummary = {
  worldsChecked: 0,
  sessionsChecked: 0,
  playersChecked: 0,
  questStatesChecked: 0,
  medalsChecked: 0,
  achievementsChecked: 0,
};
const photoSummary = {
  expected: 0,
  found: 0,
  missing: 0,
  coverMissing: 0,
  npcMissing: 0,
  swimwearMissing: 0,
  locationMissing: 0,
  worlds: [],
};

function fail(message) {
  errors.push(message);
}

function warn(message, category = 'data') {
  if (photosOnly && category !== 'photo') return;
  warnings.push(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    fail(`${file}: invalid JSON (${err.message})`);
    return null;
  }
}

function dataFiles(prefix) {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter(file => file.startsWith(prefix) && file.endsWith('.json'))
    .sort();
}

function duplicateValues(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return Array.from(dupes);
}

function isBlankReference(value) {
  return /^(n\/a|none|null|unknown|no fixed|not applicable)$/i.test(String(value || '').trim());
}

function stripUrlNoise(value) {
  return String(value || '').split('#')[0].split('?')[0];
}

function safeName(value) {
  return String(value || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image';
}

function getGeneratedFileNames(worldId) {
  const dir = join(generatedDir, worldId);
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter(name => /\.(jpe?g|png|webp)$/i.test(name)));
}

function hasExistingAsset(files, prefix, id, name) {
  const stems = Array.from(new Set([id, name].map(safeName).filter(Boolean)));
  const exts = ['jpg', 'jpeg', 'png', 'webp'];
  for (const stem of stems) {
    for (const ext of exts) {
      if (files.has(`${prefix}-${stem}.${ext}`)) return true;
    }
  }
  return false;
}

function hasExistingSwimwearAsset(files, id, name) {
  const stems = Array.from(new Set([id, name].map(safeName).filter(Boolean)));
  const exts = ['jpg', 'jpeg', 'png', 'webp'];
  for (const stem of stems) {
    for (const ext of exts) {
      if (files.has(`npc-${stem}-swimwear.${ext}`)) return true;
    }
  }
  return false;
}

function hasCoverAsset(files) {
  return ['jpg', 'jpeg', 'png', 'webp'].some(ext => files.has(`cover.${ext}`));
}

function generatedFileForUrl(value) {
  const raw = stripUrlNoise(value).trim();
  if (!raw || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return null;

  let rel;
  if (raw.startsWith('/generated/')) rel = join('generated', raw.slice('/generated/'.length));
  else if (raw.startsWith('generated/')) rel = raw;
  else if (raw.startsWith('./generated/')) rel = raw.slice(2);
  else if (raw.startsWith('/public/generated/')) rel = raw.slice('/public/'.length);
  else if (raw.startsWith('public/generated/')) rel = raw.slice('public/'.length);
  else if (raw.startsWith('/covers/')) rel = raw.slice(1);
  else if (raw.startsWith('covers/')) rel = raw;
  else if (raw.startsWith('/public/covers/')) rel = raw.slice('/public/'.length);
  else if (raw.startsWith('public/covers/')) rel = raw.slice('public/'.length);
  else return null;

  try {
    rel = decodeURIComponent(rel);
  } catch {
    fail(`image URL is not valid URI-encoding: ${value}`);
    return null;
  }

  const full = resolve(publicDir, normalize(rel));
  const publicRoot = resolve(publicDir);
  if (full !== publicRoot && !full.startsWith(publicRoot + sep)) {
    fail(`image URL escapes public directory: ${value}`);
    return null;
  }
  return full;
}

function checkGeneratedUrl(owner, value) {
  const file = generatedFileForUrl(value);
  if (!file) return;
  referencedGeneratedFiles.add(resolve(file));
  if (!existsSync(file)) {
    fail(`${owner}: referenced generated image does not exist: ${value}`);
    return;
  }
  try {
    if (!statSync(file).isFile()) fail(`${owner}: generated image path is not a file: ${value}`);
  } catch (err) {
    fail(`${owner}: cannot stat generated image ${value} (${err.message})`);
  }
}

function hasUsableGeneratedReference(owner, value) {
  if (!value || isBlankReference(value)) return false;
  const file = generatedFileForUrl(value);
  if (!file) return /^https?:\/\//i.test(String(value)) || /^data:/i.test(String(value));
  referencedGeneratedFiles.add(resolve(file));
  if (!existsSync(file)) {
    fail(`${owner}: referenced generated image does not exist: ${value}`);
    return false;
  }
  return true;
}

function recordPhoto(owner, type, found, addressed = false) {
  photoSummary.expected += 1;
  if (found || addressed) {
    photoSummary.found += 1;
    return;
  }
  photoSummary.missing += 1;
  if (type === 'cover') photoSummary.coverMissing += 1;
  else if (type === 'npc') photoSummary.npcMissing += 1;
  else if (type === 'swimwear') photoSummary.swimwearMissing += 1;
  else if (type === 'location') photoSummary.locationMissing += 1;
  missingPhotos.push(owner);
  warn(`${owner}: missing generated photo`, 'photo');
}

function isAdultSwimwearNpc(npc) {
  const text = `${npc?.gender || ''} ${npc?.occupation || ''} ${npc?.physicalDescription || ''}`;
  return Number(npc?.age) >= 18
    && !/\b(child|teen|minor|schoolgirl|schoolboy)\b/i.test(text);
}

function checkPhotoCoverage(file, world, npcs, locations) {
  const files = getGeneratedFileNames(world.id);
  const before = photoSummary.missing;
  const adultSwimwearNpcCount = npcs.filter(npc => isObject(npc) && isAdultSwimwearNpc(npc)).length;
  const generationPending = world?.images?.status === 'generating';

  recordPhoto(`${file}: cover`, 'cover',
    hasUsableGeneratedReference(`${file}: images.cover`, world.images?.cover) || hasCoverAsset(files),
    generationPending);

  for (const npc of npcs) {
    if (!isObject(npc)) continue;
    const key = npc.id || npc.name;
    recordPhoto(`${file}: npc ${key}`, 'npc',
      hasUsableGeneratedReference(`${file}: images.portraits.${key}`, world.images?.portraits?.[key])
      || hasUsableGeneratedReference(`${file}: npcs.${key}.images.portrait`, npc.images?.portrait)
      || hasExistingAsset(files, 'npc', npc.id, npc.name),
      generationPending);
    if (isAdultSwimwearNpc(npc)) {
      recordPhoto(`${file}: npc ${key} swimwear`, 'swimwear',
        hasUsableGeneratedReference(`${file}: images.swimwearPortraits.${key}`, world.images?.swimwearPortraits?.[key])
        || hasUsableGeneratedReference(`${file}: npcs.${key}.images.swimwear`, npc.images?.swimwear)
        || hasExistingSwimwearAsset(files, npc.id, npc.name),
        generationPending);
    }
  }

  for (const loc of locations) {
    if (!isObject(loc)) continue;
    const key = loc.id || loc.name;
    recordPhoto(`${file}: location ${key}`, 'location',
      hasUsableGeneratedReference(`${file}: images.scenes.${key}`, world.images?.scenes?.[key])
      || hasUsableGeneratedReference(`${file}: locations.${key}.imageUrl`, loc.imageUrl || loc.photoUrl || loc.sceneUrl || loc.generatedImageUrl)
      || hasExistingAsset(files, 'loc', loc.id, loc.name),
      generationPending);
  }

  photoSummary.worlds.push({
    id: world.id,
    file,
    expected: 1 + npcs.filter(isObject).length + adultSwimwearNpcCount + locations.filter(isObject).length,
    missing: photoSummary.missing - before,
  });
}

function checkWorldImages(file, world, npcIds, locationIds) {
  const images = world.images;
  if (!isObject(images)) return;

  checkGeneratedUrl(`${file}: images.cover`, images.cover);

  if (isObject(images.portraits)) {
    for (const [key, value] of Object.entries(images.portraits)) {
      if (!npcIds.has(key)) warn(`${file}: images.portraits has no matching NPC id: ${key}`);
      checkGeneratedUrl(`${file}: images.portraits.${key}`, value);
    }
  }

  if (isObject(images.swimwearPortraits)) {
    for (const [key, value] of Object.entries(images.swimwearPortraits)) {
      if (!npcIds.has(key)) warn(`${file}: images.swimwearPortraits has no matching NPC id: ${key}`);
      checkGeneratedUrl(`${file}: images.swimwearPortraits.${key}`, value);
    }
  }

  if (isObject(images.scenes)) {
    for (const [key, value] of Object.entries(images.scenes)) {
      if (!locationIds.has(key)) warn(`${file}: images.scenes has no matching location id: ${key}`);
      checkGeneratedUrl(`${file}: images.scenes.${key}`, value);
    }
  }
}

function knownWorldRefs(worlds, quest) {
  const refs = new Set(worlds.keys());
  if (isObject(quest?.forkedWorlds)) {
    for (const id of Object.keys(quest.forkedWorlds)) refs.add(id);
  }
  if (isObject(quest?.forkedWorldData)) {
    for (const id of Object.keys(quest.forkedWorldData)) refs.add(id);
  }
  return refs;
}

function questWorldInfo(worlds, quest, worldId) {
  if (!worldId) return null;
  const base = worlds.get(worldId);
  if (base) return base;
  const forkWorld = quest?.forkedWorldData?.[worldId];
  if (isObject(forkWorld)) {
    return {
      id: worldId,
      file: `quest fork ${worldId}`,
      world: forkWorld,
      locationIds: new Set(asArray(forkWorld.locations).map(loc => loc?.id).filter(Boolean)),
      npcIds: new Set(asArray(forkWorld.npcs).map(npc => npc?.id).filter(Boolean)),
    };
  }
  const forkSummary = quest?.forkedWorlds?.[worldId];
  if (isObject(forkSummary)) {
    return {
      id: worldId,
      file: `quest fork summary ${worldId}`,
      world: forkSummary,
      locationIds: new Set(asArray(forkSummary.locationIds).filter(Boolean)),
      npcIds: new Set(asArray(forkSummary.npcIds).filter(Boolean)),
    };
  }
  return null;
}

function checkQuestRequirement(owner, req, worlds, quest) {
  if (!isObject(req)) {
    fail(`${owner}: quest requirement must be an object`);
    return;
  }
  if (!req.kind || typeof req.kind !== 'string') fail(`${owner}: quest requirement missing string kind`);
  if (['medal', 'achievement', 'quest_fact'].includes(req.kind) && (!req.id || typeof req.id !== 'string')) {
    fail(`${owner}: ${req.kind} requirement missing string id`);
  }
  if (req.kind === 'impossible_gift') {
    if (!req.npcId || typeof req.npcId !== 'string') fail(`${owner}: impossible_gift requirement missing npcId`);
    if (req.worldId && !knownWorldRefs(worlds, quest).has(req.worldId)) warn(`${owner}: impossible_gift requirement references missing worldId: ${req.worldId}`);
  }
}

function checkQuestFact(owner, fact, worlds, quest) {
  if (!isObject(fact)) {
    fail(`${owner}: quest fact must be an object`);
    return;
  }
  if (!fact.id || typeof fact.id !== 'string') fail(`${owner}: quest fact missing string id`);
  if (!fact.summary || typeof fact.summary !== 'string') warn(`${owner}: quest fact missing summary`);
  if (fact.worldId && !knownWorldRefs(worlds, quest).has(fact.worldId)) warn(`${owner}: quest fact references missing worldId: ${fact.worldId}`);
  if (fact.npcId && fact.worldId) {
    const info = questWorldInfo(worlds, quest, fact.worldId);
    if (info && !info.npcIds.has(fact.npcId)) warn(`${owner}: quest fact npcId not present in ${fact.worldId}: ${fact.npcId}`);
  }
}

function checkQuestRewardSet(owner, rewards) {
  if (!isObject(rewards)) return;
  for (const [kind, label] of [['medals', 'medal'], ['achievements', 'achievement']]) {
    asArray(rewards[kind]).forEach((item, index) => {
      const itemOwner = `${owner}.rewards.${kind}[${index}]`;
      if (!isObject(item)) {
        fail(`${itemOwner}: reward ${label} must be an object`);
        return;
      }
      if (!item.id || typeof item.id !== 'string') fail(`${itemOwner}: reward ${label} missing string id`);
      if (!item.name || typeof item.name !== 'string') warn(`${itemOwner}: reward ${label} missing name`);
    });
  }
}

function validateQuestState(owner, quest, worlds, sessions = new Map()) {
  if (!isObject(quest)) {
    fail(`${owner}: activeQuest must be an object`);
    return;
  }
  integritySummary.questStatesChecked += 1;
  const validTypes = new Set(['plague', 'war', 'existential']);
  const validTiers = new Set(['Minor', 'Standard', 'Major', 'Epic']);
  const validStatuses = new Set(['active', 'succeeded', 'failed', 'abandoned']);
  const validObjectiveStatuses = new Set(['locked', 'active', 'complete', 'failed']);
  if (!quest.id || typeof quest.id !== 'string') fail(`${owner}: quest missing string id`);
  if (!quest.timelineId || typeof quest.timelineId !== 'string') warn(`${owner}: quest missing timelineId`);
  if (!validTypes.has(quest.type)) fail(`${owner}: invalid quest type: ${quest.type}`);
  if (!validTiers.has(quest.tier)) fail(`${owner}: invalid quest tier: ${quest.tier}`);
  if (!validStatuses.has(quest.status)) fail(`${owner}: invalid quest status: ${quest.status}`);
  if (quest.ownerSessionId && sessions.size && !sessions.has(quest.ownerSessionId)) warn(`${owner}: ownerSessionId references missing session: ${quest.ownerSessionId}`);
  for (const sid of asArray(quest.participantSessionIds)) {
    if (sessions.size && !sessions.has(sid)) warn(`${owner}: participantSessionIds references missing session: ${sid}`);
  }

  const worldRefs = knownWorldRefs(worlds, quest);
  if (quest.currentWorldId && !worldRefs.has(quest.currentWorldId)) fail(`${owner}: currentWorldId references missing world/fork: ${quest.currentWorldId}`);
  const currentInfo = questWorldInfo(worlds, quest, quest.currentWorldId);
  if (quest.currentLocationId && currentInfo && !currentInfo.locationIds.has(quest.currentLocationId)) {
    fail(`${owner}: currentLocationId is not in currentWorldId ${quest.currentWorldId}: ${quest.currentLocationId}`);
  }

  if (isObject(quest.baseReturn)) {
    const info = questWorldInfo(worlds, quest, quest.baseReturn.worldId);
    if (!info) fail(`${owner}: baseReturn references missing worldId: ${quest.baseReturn.worldId}`);
    else if (quest.baseReturn.locationId && !info.locationIds.has(quest.baseReturn.locationId)) fail(`${owner}: baseReturn locationId missing in ${quest.baseReturn.worldId}: ${quest.baseReturn.locationId}`);
  } else {
    fail(`${owner}: missing baseReturn`);
  }

  for (const forkId of asArray(quest.forkedWorldIds)) {
    if (!worldRefs.has(forkId)) warn(`${owner}: forkedWorldIds references missing fork summary/data: ${forkId}`);
  }

  asArray(quest.portals).forEach((portal, index) => {
    const portalOwner = `${owner}.portals[${index}]`;
    if (!isObject(portal)) {
      fail(`${portalOwner}: portal must be an object`);
      return;
    }
    const fromInfo = questWorldInfo(worlds, quest, portal.fromWorldId);
    if (!fromInfo) fail(`${portalOwner}: fromWorldId references missing world/fork: ${portal.fromWorldId}`);
    else if (portal.locationId && !fromInfo.locationIds.has(portal.locationId)) fail(`${portalOwner}: locationId missing in ${portal.fromWorldId}: ${portal.locationId}`);
    for (const linked of asArray(portal.linkedWorldIds)) {
      if (!worldRefs.has(linked)) fail(`${portalOwner}: linkedWorldIds references missing world/fork: ${linked}`);
    }
  });

  asArray(quest.objectives).forEach((objective, index) => {
    const objOwner = `${owner}.objectives[${index}]`;
    if (!isObject(objective)) {
      fail(`${objOwner}: objective must be an object`);
      return;
    }
    if (!objective.id || typeof objective.id !== 'string') fail(`${objOwner}: missing string id`);
    if (!objective.title || typeof objective.title !== 'string') warn(`${objOwner}: missing title`);
    if (!validObjectiveStatuses.has(objective.status)) fail(`${objOwner}: invalid status: ${objective.status}`);
    const info = questWorldInfo(worlds, quest, objective.worldId);
    if (!info) fail(`${objOwner}: worldId references missing world/fork: ${objective.worldId}`);
    else {
      if (objective.locationId && !info.locationIds.has(objective.locationId)) fail(`${objOwner}: locationId missing in ${objective.worldId}: ${objective.locationId}`);
      if (objective.npcId && !info.npcIds.has(objective.npcId)) warn(`${objOwner}: npcId missing in ${objective.worldId}: ${objective.npcId}`);
    }
    asArray(objective.requiredItemIds).forEach(itemId => {
      if (!asArray(quest.inventory).some(item => item?.id === itemId)) fail(`${objOwner}: requiredItemIds references missing inventory item: ${itemId}`);
    });
    asArray(objective.requirements).forEach((req, reqIndex) => checkQuestRequirement(`${objOwner}.requirements[${reqIndex}]`, req, worlds, quest));
    asArray(objective.emitsFacts).forEach((fact, factIndex) => checkQuestFact(`${objOwner}.emitsFacts[${factIndex}]`, fact, worlds, quest));
  });

  asArray(quest.inventory).forEach((item, index) => {
    const itemOwner = `${owner}.inventory[${index}]`;
    if (!isObject(item)) {
      fail(`${itemOwner}: item must be an object`);
      return;
    }
    if (!item.id || typeof item.id !== 'string') fail(`${itemOwner}: item missing string id`);
    const info = questWorldInfo(worlds, quest, item.worldId);
    if (!info) fail(`${itemOwner}: worldId references missing world/fork: ${item.worldId}`);
    else {
      if (item.locationId && !info.locationIds.has(item.locationId)) fail(`${itemOwner}: locationId missing in ${item.worldId}: ${item.locationId}`);
      if (item.sourceType === 'npc' && item.sourceId && !info.npcIds.has(item.sourceId)) warn(`${itemOwner}: sourceId npc missing in ${item.worldId}: ${item.sourceId}`);
      if (item.sourceType === 'location' && item.sourceId && !info.locationIds.has(item.sourceId)) warn(`${itemOwner}: sourceId location missing in ${item.worldId}: ${item.sourceId}`);
    }
    if (item.requiredForObjectiveId && !asArray(quest.objectives).some(obj => obj?.id === item.requiredForObjectiveId)) {
      fail(`${itemOwner}: requiredForObjectiveId references missing objective: ${item.requiredForObjectiveId}`);
    }
  });

  asArray(quest.traps).forEach((trap, index) => {
    if (!isObject(trap)) fail(`${owner}.traps[${index}]: trap must be an object`);
    else if (!trap.id || typeof trap.id !== 'string') fail(`${owner}.traps[${index}]: trap missing string id`);
  });
  asArray(quest.requirements).forEach((req, index) => checkQuestRequirement(`${owner}.requirements[${index}]`, req, worlds, quest));
  asArray(quest.questFacts).forEach((fact, index) => checkQuestFact(`${owner}.questFacts[${index}]`, fact, worlds, quest));
  checkQuestRewardSet(owner, quest.rewards);
}

function validateWorld(file, world) {
  const prefix = `${file}:`;
  if (!isObject(world)) {
    fail(`${prefix} world JSON root must be an object`);
    return null;
  }

  const expectedId = basename(file).replace(/^world-/, '').replace(/\.json$/, '');
  if (!world.id || typeof world.id !== 'string') fail(`${prefix} missing string id`);
  else if (world.id !== expectedId) fail(`${prefix} id does not match filename (${world.id} != ${expectedId})`);
  if (!world.concept || typeof world.concept !== 'string') fail(`${prefix} missing string concept`);
  if (!Array.isArray(world.locations)) fail(`${prefix} locations must be an array`);
  if (!Array.isArray(world.npcs)) fail(`${prefix} npcs must be an array`);

  const locations = asArray(world.locations);
  const npcs = asArray(world.npcs);
  const locationIds = new Set(locations.map(loc => loc?.id).filter(Boolean));
  const npcIds = new Set(npcs.map(npc => npc?.id).filter(Boolean));

  for (const dupe of duplicateValues(locations.map(loc => loc?.id))) fail(`${prefix} duplicate location id: ${dupe}`);
  for (const dupe of duplicateValues(npcs.map(npc => npc?.id))) fail(`${prefix} duplicate NPC id: ${dupe}`);

  locations.forEach((loc, index) => {
    const owner = `${prefix} locations[${index}]`;
    if (!isObject(loc)) {
      fail(`${owner} must be an object`);
      return;
    }
    if (!loc.id || typeof loc.id !== 'string') fail(`${owner} missing string id`);
    if (!loc.name || typeof loc.name !== 'string') warn(`${owner} missing string name`);
    for (const target of asArray(loc.connectedTo)) {
      if (!locationIds.has(target)) warn(`${owner}.connectedTo references missing location: ${target}`);
    }
  });

  const sessionLikeNpcKeys = ['playerName', 'playerAge', 'playerGender', 'playerOccupation', 'playerBackstory', 'worldId', 'dayCount', 'npcStates'];
  npcs.forEach((npc, index) => {
    const owner = `${prefix} npcs[${index}]`;
    if (!isObject(npc)) {
      fail(`${owner} must be an object`);
      return;
    }
    if (!npc.id || typeof npc.id !== 'string') fail(`${owner} missing string id`);
    if (!npc.name || typeof npc.name !== 'string') warn(`${owner} missing string name`);
    const sessionKeys = sessionLikeNpcKeys.filter(key => key in npc);
    if (sessionKeys.length) fail(`${owner} looks like a session/player record; keys: ${sessionKeys.join(', ')}`);
    for (const field of ['homeLocationId', 'workLocationId']) {
      if (npc[field] && !isBlankReference(npc[field]) && !locationIds.has(npc[field])) {
        warn(`${owner}.${field} references missing location: ${npc[field]}`);
      }
    }
    for (const target of asArray(npc.frequentedLocations)) {
      if (!isBlankReference(target) && !locationIds.has(target)) {
        warn(`${owner}.frequentedLocations references missing location: ${target}`);
      }
    }
    if (isObject(npc.images)) {
      for (const [key, value] of Object.entries(npc.images)) {
        checkGeneratedUrl(`${owner}.images.${key}`, value);
      }
    }
  });

  checkWorldImages(file, world, npcIds, locationIds);
  checkPhotoCoverage(file, world, npcs, locations);
  return { id: world.id, file, world, locationIds, npcIds };
}

function validateSession(file, session, worlds) {
  const prefix = `${file}:`;
  if (!isObject(session)) {
    fail(`${prefix} session JSON root must be an object`);
    return null;
  }

  const expectedId = basename(file).replace(/^session-/, '').replace(/\.json$/, '');
  if (!session.id || typeof session.id !== 'string') fail(`${prefix} missing string id`);
  else if (session.id !== expectedId) fail(`${prefix} id does not match filename (${session.id} != ${expectedId})`);
  if (!session.worldId || typeof session.worldId !== 'string') {
    fail(`${prefix} missing string worldId`);
    return null;
  }

  const worldInfo = worlds.get(session.worldId);
  if (!worldInfo) {
    fail(`${prefix} references missing worldId: ${session.worldId}`);
    return null;
  }

  if (!session.playerName || typeof session.playerName !== 'string') warn(`${prefix} missing string playerName`);
  if (session.currentLocationId && !worldInfo.locationIds.has(session.currentLocationId)) {
    fail(`${prefix} currentLocationId references missing location: ${session.currentLocationId}`);
  }

  if (isObject(session.npcStates)) {
    for (const npcId of Object.keys(session.npcStates)) {
      if (!worldInfo.npcIds.has(npcId)) {
        if (npcId.startsWith('quest-')) {
          warn(`${prefix} npcStates contains stale quest NPC id: ${npcId}`);
        } else {
          fail(`${prefix} npcStates contains missing NPC id: ${npcId}`);
        }
      }
    }
  } else {
    warn(`${prefix} missing npcStates object`);
  }

  asArray(session.questHooks).forEach((hook, index) => {
    const owner = `${prefix} questHooks[${index}]`;
    if (!isObject(hook)) fail(`${owner}: hook must be an object`);
    else {
      if (!hook.id || typeof hook.id !== 'string') fail(`${owner}: missing string id`);
      if (hook.npcId && !worldInfo.npcIds.has(hook.npcId)) warn(`${owner}: npcId references missing NPC: ${hook.npcId}`);
      if (hook.locationId && !worldInfo.locationIds.has(hook.locationId)) fail(`${owner}: locationId references missing location: ${hook.locationId}`);
      asArray(hook.requirements).forEach((req, reqIndex) => checkQuestRequirement(`${owner}.requirements[${reqIndex}]`, req, worlds, session.activeQuest));
      checkQuestRewardSet(owner, hook.rewards);
    }
  });
  asArray(session.questEchoes).forEach((echo, index) => {
    const owner = `${prefix} questEchoes[${index}]`;
    if (!isObject(echo)) fail(`${owner}: echo must be an object`);
    else {
      if (!echo.id || typeof echo.id !== 'string') fail(`${owner}: missing string id`);
      if (!echo.questId || typeof echo.questId !== 'string') fail(`${owner}: missing questId`);
    }
  });
  return { id: session.id, file, session };
}

function checkAwardList(owner, value, kind) {
  const validTiers = new Set(['Minor', 'Standard', 'Major', 'Epic']);
  const validTypes = new Set(['plague', 'war', 'existential']);
  const list = asArray(value);
  for (const dupe of duplicateValues(list.map(item => item?.id))) warn(`${owner}: duplicate ${kind} id: ${dupe}`);
  list.forEach((item, index) => {
    if (kind === 'medal') integritySummary.medalsChecked += 1;
    if (kind === 'achievement') integritySummary.achievementsChecked += 1;
    const itemOwner = `${owner}[${index}]`;
    if (!isObject(item)) {
      fail(`${itemOwner}: ${kind} must be an object`);
      return;
    }
    if (!item.id || typeof item.id !== 'string') fail(`${itemOwner}: missing string id`);
    if (!item.name || typeof item.name !== 'string') warn(`${itemOwner}: missing string name`);
    if (!item.earnedAt || typeof item.earnedAt !== 'string') fail(`${itemOwner}: missing string earnedAt`);
    else if (Number.isNaN(Date.parse(item.earnedAt))) warn(`${itemOwner}: earnedAt is not parseable: ${item.earnedAt}`);
    if (kind === 'medal') {
      if (!validTiers.has(item.tier)) fail(`${itemOwner}: invalid medal tier: ${item.tier}`);
      if (item.questType && !validTypes.has(item.questType)) fail(`${itemOwner}: invalid questType: ${item.questType}`);
    }
    if (item.questId && typeof item.questId !== 'string') fail(`${itemOwner}: questId must be a string`);
  });
}

function validateGlobalPlayers(file, rawData, worlds) {
  const prefix = `${file}:`;
  const players = Array.isArray(rawData) ? rawData : (rawData?.players ?? rawData);
  if (!Array.isArray(players)) {
    fail(`${prefix} players JSON root must be an array (or { "players": [...] })`);
    return 0;
  }
  for (const dupe of duplicateValues(players.map(player => player?.id))) fail(`${prefix} duplicate global player id: ${dupe}`);
  players.forEach((player, index) => {
    const owner = `${prefix} players[${index}]`;
    if (!isObject(player)) {
      fail(`${owner} must be an object`);
      return;
    }
    if (!player.id || typeof player.id !== 'string') fail(`${owner}: missing string id`);
    if (!player.playerName || typeof player.playerName !== 'string') warn(`${owner}: missing playerName`);
    if (player.pin !== undefined && !/^\d{3}$/.test(String(player.pin))) fail(`${owner}: pin must be a 3 digit string`);
    checkAwardList(`${owner}.medals`, player.medals, 'medal');
    checkAwardList(`${owner}.achievements`, player.achievements, 'achievement');
    asArray(player.questFacts).forEach((fact, factIndex) => checkQuestFact(`${owner}.questFacts[${factIndex}]`, fact, worlds, player.activeQuest));
    if (player.activeQuest) validateQuestState(`${owner}.activeQuest`, player.activeQuest, worlds);
  });
  return players.length;
}

function listGeneratedFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (stat.isFile()) out.push(resolve(full));
    }
  }
  return out;
}

if (!existsSync(dataDir)) {
  fail(`data directory does not exist: ${dataDir}`);
}

const worlds = new Map();
for (const file of dataFiles('world-')) {
  const full = join(dataDir, file);
  const info = validateWorld(file, readJson(full));
  if (info?.id) worlds.set(info.id, info);
}
integritySummary.worldsChecked = worlds.size;

const sessions = new Map();
if (!photosOnly) {
  for (const file of dataFiles('session-')) {
    const info = validateSession(file, readJson(join(dataDir, file)), worlds);
    if (info?.id) sessions.set(info.id, info);
  }
  integritySummary.sessionsChecked = sessions.size;

  for (const info of sessions.values()) {
    if (info.session?.activeQuest) validateQuestState(`${info.file}: activeQuest cross-session`, info.session.activeQuest, worlds, sessions);
  }

  const playersFile = join(dataDir, 'players.json');
  if (existsSync(playersFile)) {
    integritySummary.playersChecked = validateGlobalPlayers('players.json', readJson(playersFile), worlds);
  } else {
    warn('players.json is missing; no global player medals/achievements checked');
  }

  for (const generatedFile of listGeneratedFiles(generatedDir)) {
    if (generatedFile.includes(`${sep}_imgcache${sep}`)) continue;
    if (!referencedGeneratedFiles.has(generatedFile)) {
      warn(`unreferenced generated asset: ${generatedFile.slice(root.length + 1)}`);
    }
  }
}

const sessionCount = photosOnly ? 0 : dataFiles('session-').length;
const generatedFileCount = listGeneratedFiles(generatedDir).length;
const summary = `worlds=${worlds.size} sessions=${sessionCount} generatedFiles=${generatedFileCount} photos=${photoSummary.found}/${photoSummary.expected}`;

if (jsonMode) {
  console.log(JSON.stringify({
    ok: errors.length === 0,
    summary: {
      worlds: worlds.size,
      sessions: sessionCount,
      generatedFiles: generatedFileCount,
      errors: errors.length,
      warnings: warnings.length,
      photos: photoSummary,
      integrity: integritySummary,
      checks: [
        'world JSON shape',
        'session/world references',
        'generated image URLs and required photo coverage',
        'stale generated assets',
        'quest hooks, quests, portals, objectives, inventory, requirements, facts',
        'global player medals and achievements',
      ],
    },
    errors: errors.slice(0, 200),
    warnings: warnings.slice(0, 200),
    missingPhotos: missingPhotos.slice(0, 500),
  }, null, 2));
  process.exit(errors.length ? 1 : 0);
}

if (warnings.length) {
  for (const message of warnings.slice(0, 50)) console.warn(`[check:data] WARN ${message}`);
  if (warnings.length > 50) console.warn(`[check:data] WARN ... ${warnings.length - 50} more warnings`);
}

if (errors.length) {
  for (const message of errors.slice(0, 80)) console.error(`[check:data] ERROR ${message}`);
  if (errors.length > 80) console.error(`[check:data] ERROR ... ${errors.length - 80} more errors`);
  console.error(`[check:data] FAIL ${summary}; errors=${errors.length}; warnings=${warnings.length}`);
  process.exit(1);
}

console.log(`[check:data] OK ${summary}; warnings=${warnings.length}`);
