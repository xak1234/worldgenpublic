import { randomUUID } from 'crypto';
import type {
  DramaLead,
  QuestDifficulty,
  QuestAchievement,
  QuestDiscoveryHook,
  QuestEcho,
  QuestFact,
  QuestItem,
  QuestMedal,
  QuestObjective,
  QuestRequirement,
  QuestPortal,
  QuestSessionState,
  QuestTier,
  QuestTrap,
  QuestType,
  WorldDNA,
  WorldNPC,
  WorldSession,
} from './types.js';
import { fuzzyKeywordHit } from './fuzzyMatch.js';

export interface QuestAdvanceEvent {
  kind: 'dialogue' | 'movement' | 'wait' | 'tick' | 'action' | 'use_interactable';
  turnCost?: number;
  worldId?: string;
  locationId?: string;
  npcId?: string;
  summary?: string;
  interactableName?: string;
}

export function missingQuestRequirements(
  session: WorldSession,
  quest: QuestSessionState | undefined,
  requirements: QuestRequirement[] | undefined,
): string[] {
  if (!requirements?.length) return [];
  return requirements.filter(req => {
    if (req.kind === 'medal') return !(session.medals ?? []).some(m => m.id === req.id || m.id.startsWith(`${req.id}:`));
    if (req.kind === 'achievement') return !(session.achievements ?? []).some(a => a.id === req.id || a.id.startsWith(`${req.id}:`));
    if (req.kind === 'quest_fact') {
      const facts = [...(session.questFacts ?? []), ...(quest?.questFacts ?? [])];
      return !facts.some(f => f.id === req.id);
    }
    if (req.kind === 'weather') {
      const condition = compact(quest?.currentWeather?.condition ?? session.currentWeather?.condition).toLowerCase();
      return condition !== compact(req.condition).toLowerCase();
    }
    if (req.kind === 'player_state') {
      const haystack = [
        session.playerAppearance,
        session.playerDepartureStyle,
        ...(session.strangePossessions ?? []),
        ...(session.activeGodEffects ?? []).map(e => `${e.type} ${e.label}`),
      ].join(' ').toLowerCase();
      return req.state === 'invisible'
        ? !/\binvisible|unseen|vanish|vanished|hidden from sight\b/i.test(haystack)
        : !/\bcloak|cloaked|robe|hood|disguise|shrouded\b/i.test(haystack);
    }
    if (req.kind === 'impossible_gift') {
      const gifts = [
        ...(session.impossibleGiftsGiven ?? []).filter(g => g.npcId === req.npcId).map(g => g.gift),
        ...((session.npcStates?.[req.npcId]?.impossibleGiftsReceived ?? []).map(g => g.gift)),
      ];
      if (!gifts.length) return true;
      const pattern = compact(req.giftPattern).toLowerCase();
      if (!pattern) return false;
      return !gifts.some(gift => compact(gift).toLowerCase().includes(pattern));
    }
    return true;
  }).map(req => req.label ?? (
    req.kind === 'weather' ? `Weather: ${req.condition}` :
    req.kind === 'player_state' ? `Player state: ${req.state}` :
    req.kind === 'impossible_gift' ? `Impossible gift to ${req.npcId}` :
    req.id
  ));
}

export function questRequirementsSatisfied(
  session: WorldSession,
  quest: QuestSessionState | undefined,
  requirements: QuestRequirement[] | undefined,
): boolean {
  return missingQuestRequirements(session, quest, requirements).length === 0;
}

function portalGateRequirements(requirements: QuestRequirement[] | undefined): QuestRequirement[] | undefined {
  const gated = (requirements ?? []).filter(req => req.kind === 'weather' || req.kind === 'player_state');
  return gated.length ? gated : undefined;
}

function weatherGateClue(condition: string): string {
  const key = compact(condition).toLowerCase();
  if (key.includes('fog')) return 'the air hides edges and makes distance uncertain';
  if (key.includes('storm')) return 'the sky argues loudly enough to shake the threshold';
  if (key.includes('rain')) return 'water keeps falling until every footstep sounds borrowed';
  return 'the air matches the witness clue';
}

function playerStateGateClue(state: 'invisible' | 'cloaked'): string {
  return state === 'invisible'
    ? 'the threshold reacts to absence, not presence'
    : 'the threshold answers covered faces and borrowed silhouettes';
}

function requirementClue(req: QuestRequirement): { text: string; detail: string; refusal: string } | undefined {
  if (req.kind === 'weather') {
    const clue = weatherGateClue(req.condition);
    return {
      text: `The threshold is listening for when ${clue}.`,
      detail: `The air is wrong. Wait for or force weather where ${clue}.`,
      refusal: `The threshold hisses, but the air is wrong. It waits until ${clue}.`,
    };
  }
  if (req.kind === 'player_state') {
    const clue = playerStateGateClue(req.state);
    return {
      text: `The threshold is watching for a body changed by concealment: ${clue}.`,
      detail: req.state === 'invisible'
        ? 'You are still too visible to pass cleanly.'
        : 'Your face and outline are too exposed to pass cleanly.',
      refusal: req.state === 'invisible'
        ? 'The threshold notices you too clearly. It reacts to absence, not presence.'
        : 'The threshold rejects an uncovered face. It wants a covered or borrowed silhouette.',
    };
  }
  if (req.kind === 'impossible_gift') {
    const desired = req.hintText ?? req.requestText ?? (req.giftPattern ? `something impossible connected to ${req.giftPattern}` : 'an offering that should not exist');
    return {
      text: `Someone is waiting for ${desired}.`,
      detail: `An impossible offering is still missing: ${desired}.`,
      refusal: `Something waits for an offering that should not exist: ${desired}.`,
    };
  }
  return undefined;
}

function objectiveGateClue(objective: QuestObjective): { text: string; detail: string; refusal: string } | undefined {
  for (const req of objective.requirements ?? []) {
    const clue = requirementClue(req);
    if (clue) return clue;
  }
  return undefined;
}

function requirementCategory(req: QuestRequirement): string {
  if (req.kind === 'weather') return 'Weather threshold missing.';
  if (req.kind === 'player_state') return 'Threshold player state missing.';
  if (req.kind === 'impossible_gift') return 'Impossible offering missing.';
  if (req.kind === 'medal') return 'Medal requirement missing.';
  if (req.kind === 'achievement') return 'Achievement requirement missing.';
  if (req.kind === 'quest_fact') return 'Quest knowledge missing.';
  return 'Quest requirement missing.';
}

function blockedPortalMessage(quest: QuestSessionState, objective: QuestObjective | undefined, attemptKey: string): string {
  const difficulty = quest.difficulty ?? 'normal';
  const req = objective?.requirements?.[0];
  const clue = objective && objectiveGateClue(objective);
  const attempts = quest.blockedPortalAttempts?.[attemptKey] ?? 0;
  if (difficulty === 'easy') return clue?.refusal ?? (req ? requirementCategory(req) : 'That quest portal is unavailable at the moment.');
  if (difficulty === 'hard') return req ? requirementCategory(req) : 'That quest portal is unavailable at the moment.';
  if ((objective as any)?.clueDiscovered || quest.revealedPortalAnswers?.[attemptKey] || attempts >= 3) {
    return clue?.refusal ?? (req ? requirementCategory(req) : 'That quest portal is unavailable at the moment.');
  }
  return req ? requirementCategory(req) : 'That quest portal is unavailable at the moment.';
}

const TIER_WORLD_COUNT: Record<QuestTier, number> = {
  Minor: 2,
  Standard: 3,
  Major: 4,
  Epic: 5,
};

export function questRequiredWorldCount(tier: QuestTier): number {
  return TIER_WORLD_COUNT[tier];
}

const TIER_MIN_OBJECTIVES: Record<QuestTier, number> = {
  Minor: 3,
  Standard: 5,
  Major: 7,
  Epic: 9,
};

const URGENCY = [
  { stage: 1, limit: 0.25, label: 'Calm tension', text: 'The world is uneasy, but nobody has named the danger aloud.' },
  { stage: 2, limit: 0.5, label: 'Growing concern', text: 'The signs are harder to ignore, and people are starting to choose sides.' },
  { stage: 3, limit: 0.75, label: 'Crisis', text: 'Fear has moved from rumor into daily life.' },
  { stage: 4, limit: 0.9, label: 'Desperation', text: 'Every delay now costs someone something visible.' },
  { stage: 5, limit: 1, label: 'Final warning', text: 'The quest timeline is close to collapse.' },
];

type QuestTemplateDefinition = {
  namePrefix: string;
  hookTitle: string;
  hookDetail: (place: string) => string;
  clueNoun: string;
  finalTitle: string;
  finalNarrative: string;
  successEcho: (playerName: string, questName: string) => string;
  failureEcho: (playerName: string, questName: string) => string;
  development: (worldName: string, urgencyLabel: string) => string;
  trapDescriptions: Partial<Record<QuestTrap['type'], string>>;
  itemTemplates: (world: WorldDNA) => { name: string; description: string; sourceType: 'npc' | 'location'; triggerKeywords?: string[] }[];
};

const QUEST_TEMPLATES: Record<QuestType, QuestTemplateDefinition> = {
  plague: {
    namePrefix: 'The Withering of',
    hookTitle: 'A sickness has found a door',
    hookDetail: place => `An affliction tied to ${place}'s daily life is spreading faster than people can explain.`,
    clueNoun: 'the first symptom',
    finalTitle: 'Name the cure aloud',
    finalNarrative: 'Return with knowledge, not an object, and make people believe it.',
    successEcho: (playerName, questName) => `${playerName} named the cure for ${questName}; the forked timeline exhales and closes.`,
    failureEcho: (playerName, questName) => `${playerName} lost the cure for ${questName}; the forked timeline collapses into fevered rumor.`,
    development: (worldName, urgencyLabel) => `${worldName} reports new symptoms as the quest pressure reaches ${urgencyLabel.toLowerCase()}.`,
    trapDescriptions: {
      social: 'A respected voice insists the sick should be hidden for the greater good.',
      false_reward: 'A quick cure appears, but every detail around it is too clean.',
      deception: 'Witnesses repeat the same diagnosis as if rehearsed.',
      comfort: 'Someone offers safety if the investigation stops here.',
      loyalty: 'A useful ally asks you to spare a culprit who matters to them.',
      false_urgency: 'A staged emergency tries to drag you away from the real source.',
    },
    itemTemplates: (world) => {
      const place = compact(world.geography?.region ?? world.concept, 'this land');
      const food = world.culture?.food?.[0] ?? 'local remedy';
      return [
        { name: `${place} Fever Sample`, description: `A sealed vial containing the sickness as it first appeared in ${place}.`, sourceType: 'npc' as const, triggerKeywords: ['sample', 'vial', 'fever', 'sickness', 'give me', 'hand over', 'need proof'] },
        { name: `${place} Healer's Log`, description: `A journal documenting the first cases in ${place}, hidden by someone who wanted them forgotten.`, sourceType: 'location' as const },
        { name: `Contaminated ${titleCase(food)}`, description: `A common ${food} from ${place} that has been tainted at the source.`, sourceType: 'location' as const },
      ];
    },
  },
  war: {
    namePrefix: 'The Broken Peace of',
    hookTitle: 'A peace is about to break',
    hookDetail: place => `Someone is steering ${place} toward violence, and the first story you hear may be false.`,
    clueNoun: 'the hidden cause',
    finalTitle: 'Choose how the peace is made',
    finalNarrative: 'Force the true conflict into the open and decide who must yield.',
    successEcho: (playerName, questName) => `${playerName} forced the truth into daylight for ${questName}; the forked peace holds.`,
    failureEcho: (playerName, questName) => `${playerName} failed to stop ${questName}; the forked timeline breaks under chosen violence.`,
    development: (worldName, urgencyLabel) => `${worldName} hardens its factions as the quest pressure reaches ${urgencyLabel.toLowerCase()}.`,
    trapDescriptions: {
      social: 'A faction leader demands public loyalty before sharing the next truth.',
      false_reward: 'A treaty is offered that protects the guilty and punishes the exposed.',
      deception: 'A witness names the wrong enemy with rehearsed certainty.',
      comfort: 'Neutral ground promises quiet if everyone accepts the lie.',
      loyalty: 'An ally asks you to betray another world for a cleaner peace.',
      false_urgency: 'A false attack tries to force a rushed accusation.',
    },
    itemTemplates: (world) => {
      const place = compact(world.geography?.region ?? world.concept, 'this land');
      const enforcer = world.law?.enforcers ?? 'the authorities';
      return [
        { name: `${place} Sealed Orders`, description: `Instructions from ${enforcer} in ${place} that someone wants buried before the peace talks.`, sourceType: 'npc' as const, triggerKeywords: ['orders', 'letter', 'proof', 'evidence', 'show me', 'hand over', 'give me'] },
        { name: `${place} Treaty Seal`, description: `The original seal of a peace agreement for ${place} — snapped in half.`, sourceType: 'location' as const },
        { name: `${place} Spy's Cipher`, description: `A coded message from ${place} that names the real instigator.`, sourceType: 'location' as const },
      ];
    },
  },
  existential: {
    namePrefix: 'The Unraveling of',
    hookTitle: 'Reality is fraying at the edge',
    hookDetail: place => `Small impossibilities in ${place} are beginning to line up like warnings.`,
    clueNoun: 'the broken sign',
    finalTitle: 'Contain the source',
    finalNarrative: 'Act at the place where the timeline is weakest.',
    successEcho: (playerName, questName) => `${playerName} contained ${questName}; the forked impossibility folds shut.`,
    failureEcho: (playerName, questName) => `${playerName} failed to contain ${questName}; the forked timeline forgets how to remain whole.`,
    development: (worldName, urgencyLabel) => `${worldName} suffers new impossibilities as the quest pressure reaches ${urgencyLabel.toLowerCase()}.`,
    trapDescriptions: {
      social: 'People begin agreeing on a memory that never happened.',
      false_reward: 'A perfect answer appears in the wrong handwriting.',
      deception: 'A familiar face says something only the timeline should know.',
      comfort: 'A quiet room offers rest while the edges of reality loosen.',
      loyalty: 'Someone you trust asks you to leave one fork unsealed.',
      false_urgency: 'A spectacular impossibility distracts from a smaller true wound.',
    },
    itemTemplates: (world) => {
      const place = compact(world.geography?.region ?? world.concept, 'this land');
      const landmark = world.geography?.landmarks?.[0] ?? place;
      return [
        { name: `${place} Rift Fragment`, description: `A shard of solidified impossibility from ${place}, cold and humming.`, sourceType: 'npc' as const, triggerKeywords: ['fragment', 'shard', 'rift', 'piece', 'give me', 'hand over', 'take it'] },
        { name: `${landmark} Anchor Stone`, description: `A stone from near ${landmark} that stays in the same place regardless of what reality does around it.`, sourceType: 'location' as const },
        { name: `${place} Mirror Record`, description: `A reflective surface from ${place} that shows what was here before the timeline split.`, sourceType: 'location' as const },
      ];
    },
  },
};

function templateFor(type: QuestType): QuestTemplateDefinition {
  return QUEST_TEMPLATES[type] ?? QUEST_TEMPLATES.plague;
}

function defaultQuestRewards(type: QuestType, tier: QuestTier, questName: string, questId: string, difficulty: QuestDifficulty = 'normal'): {
  medals: Omit<QuestMedal, 'earnedAt'>[];
  achievements: Omit<QuestAchievement, 'earnedAt'>[];
} {
  const difficultyLabel = titleCase(difficulty);
  return {
    medals: [{
      id: `medal:${type}:${tier.toLowerCase()}:${questId}`,
      name: `${difficultyLabel} ${tier} ${titleCase(type)} Medal`,
      tier,
      questType: type,
      questId,
    }],
    achievements: [{
      id: `achievement:${type}:${questId}`,
      name: `First ${difficultyLabel} ${titleCase(type)} Resolution`,
      description: `Resolved a ${difficulty} ${type} quest.`,
      questId,
    }],
  };
}

function mergeQuestFacts(existing: QuestFact[] | undefined, incoming: QuestFact[]): QuestFact[] {
  const merged = new Map<string, QuestFact>();
  for (const fact of existing ?? []) merged.set(fact.id, fact);
  for (const fact of incoming) merged.set(fact.id, fact);
  return Array.from(merged.values());
}

function mergeById<T extends { id: string }>(existing: T[] | undefined, incoming: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of existing ?? []) merged.set(item.id, item);
  for (const item of incoming) merged.set(item.id, item);
  return Array.from(merged.values());
}

function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// NOTE: An identical compact() exists in drama.ts. Both copies are kept
// intentionally to avoid a circular dependency between questEpisode.ts and drama.ts.
function compact(text: string | undefined, fallback = ''): string {
  return String(text ?? fallback).replace(/\s+/g, ' ').trim();
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, c => c.toUpperCase());
}

function chooseQuestType(world: WorldDNA, session: WorldSession): QuestType {
  const haystack = [
    world.concept,
    world.geography?.climate,
    world.economy?.blackMarket,
    (world.law?.corruption != null && world.law.corruption > 0.5) ? 'corrupt' : '',
    session.activeGossip?.slice(-3).map(g => g.content).join(' '),
  ].join(' ').toLowerCase();
  if (/\bwar|faction|army|rebellion|strike|riot|violence|feud|law|corrupt/.test(haystack)) return 'war';
  if (/\bportal|reality|star|ancient|spirit|ghost|magic|dream|unravel|void/.test(haystack)) return 'existential';
  return 'plague';
}

function chooseQuestTier(world: WorldDNA, session: WorldSession, hookNpc?: WorldNPC): QuestTier {
  const complexity = (world.npcs?.length ?? 0) + (world.locations?.length ?? 0) + (world.timeline?.length ?? 0);
  const completed = (session.questEchoes ?? []).filter(e => e.status === 'succeeded').length;
  const hookSignal = `${hookNpc?.occupation ?? ''} ${hookNpc?.personality ?? ''}`.toLowerCase();
  if (completed >= 3 || /seer|oracle|prophet|ancient|mystic/.test(hookSignal) || complexity >= 55) return 'Epic';
  if (completed >= 1 || complexity >= 38) return 'Major';
  if (complexity >= 24) return 'Standard';
  return 'Minor';
}

function questName(type: QuestType, world: WorldDNA): string {
  const subject = compact(world.geography?.region ?? world.concept, 'the world');
  return `${templateFor(type).namePrefix} ${subject}`;
}

function hookTitle(type: QuestType): string {
  return templateFor(type).hookTitle;
}

function hookDetail(type: QuestType, world: WorldDNA): string {
  const place = compact(world.geography?.region, 'this place');
  return templateFor(type).hookDetail(place);
}

function isGlobalQuestOffer(session: WorldSession, force: boolean, roll: number): boolean {
  if (!session.globalPlayerId) return false;
  if (force) return true;
  return roll <= 8 || (session.medals?.length ?? 0) > 0 || (session.achievements?.length ?? 0) > 0;
}

function hookNpcScore(npc: WorldNPC, session: WorldSession): number {
  const here = session.npcStates[npc.id]?.currentLocationId === session.currentLocationId ? 20 : 0;
  const text = `${npc.occupation} ${npc.personality} ${npc.traits?.join(' ')} ${npc.coreConcerns?.join(' ')}`.toLowerCase();
  const role = /seer|oracle|prophet|mystic|traveller|traveler|wander|merchant|healer|doctor|scholar|priest|witch|sage|alchemist/.test(text) ? 45 : 0;
  const approach = Math.round((npc.approachability ?? 35) / 5);
  return here + role + approach;
}

function chooseHookNpc(world: WorldDNA, session: WorldSession): WorldNPC | undefined {
  return [...(world.npcs ?? [])]
    .sort((a, b) => hookNpcScore(b, session) - hookNpcScore(a, session))
    [0];
}

function locationName(world: WorldDNA, locationId: string): string {
  return world.locations.find(l => l.id === locationId)?.name ?? locationId;
}

function validLocationId(world: WorldDNA, locationId: string | undefined): locationId is string {
  return !!locationId && world.locations.some(location => location.id === locationId);
}

function npcQuestLocation(world: WorldDNA, session: WorldSession, npc: WorldNPC | undefined, index: number, preferredLocationId?: string): string {
  if (!npc) return locationAt(world, session, index);
  const regularLocationId = world.locations.find(location => location.regulars?.includes(npc.id))?.id;
  const candidates = [
    preferredLocationId,
    regularLocationId,
    npc.workLocationId,
    npc.homeLocationId,
    ...(npc.frequentedLocations ?? []),
    locationAt(world, session, index),
  ];
  return candidates.find(locationId => validLocationId(world, locationId)) ?? locationAt(world, session, index);
}

function npcAt(world: WorldDNA, session: WorldSession, index: number): WorldNPC | undefined {
  const npcs = world.npcs ?? [];
  if (!npcs.length) return undefined;
  const seed = stableHash(`${session.id}:${world.id}:${index}`);
  return npcs[seed % npcs.length];
}

function locationAt(world: WorldDNA, session: WorldSession, index: number): string {
  const locations = world.locations ?? [];
  if (!locations.length) return session.currentLocationId;
  const seed = stableHash(`${session.id}:${world.id}:loc:${index}`);
  return locations[seed % locations.length].id;
}

function cloneData<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

type QuestForkBuild = {
  sourceWorldId: string;
  world: WorldDNA;
  npcIdMap: Record<string, string>;
};

function forkWorldForQuest(source: WorldDNA, timelineId: string, index: number): QuestForkBuild {
  const world = cloneData(source);
  const sourceWorldId = source.id;
  world.id = `quest-${timelineId}-${index}-${source.id}`;
  world.playerProfiles = {};

  const npcIdMap = Object.fromEntries((world.npcs ?? []).map(npc => [npc.id, `quest-${timelineId}-${index}-${npc.id}`]));
  const remapNpcId = (id: string) => npcIdMap[id] ?? id;

  world.npcs = (world.npcs ?? []).map(npc => ({
    ...npc,
    id: remapNpcId(npc.id),
    relationships: (Array.isArray(npc.relationships) ? npc.relationships : []).map(rel => ({
      ...rel,
      npcId: remapNpcId(rel.npcId),
    })),
  }));
  world.locations = (world.locations ?? []).map(location => ({
    ...location,
    regulars: (location.regulars ?? []).map(remapNpcId),
  }));

  if (world.images?.portraits) {
    world.images.portraits = Object.fromEntries(
      Object.entries(world.images.portraits).map(([npcId, image]) => [remapNpcId(npcId), image])
    );
  }

  world.npcSharedStates = Object.fromEntries(
    Object.entries(world.npcSharedStates ?? {}).map(([npcId, state]) => {
      const forkState = cloneData(state);
      forkState.npcId = remapNpcId(forkState.npcId ?? npcId);
      forkState.worldId = world.id;
      return [remapNpcId(npcId), forkState];
    })
  );

  return { sourceWorldId, world, npcIdMap };
}

function remapNpcRefsInValue(value: unknown, npcIdMap: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map(item => remapNpcRefsInValue(item, npcIdMap));
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'npcId' || key === 'fromNpcId' || key === 'targetNpcId') && typeof item === 'string') {
      next[key] = npcIdMap[item] ?? item;
    } else if ((key === 'othersPresent' || key === 'witnessedParticipants' || key === 'targetIds') && Array.isArray(item)) {
      next[key] = item.map(id => typeof id === 'string' ? (npcIdMap[id] ?? id) : id);
    } else {
      next[key] = remapNpcRefsInValue(item, npcIdMap);
    }
  }
  return next;
}

function seedForkNpcStates(session: WorldSession, builds: QuestForkBuild[]): void {
  for (const build of builds) {
    for (const [sourceNpcId, forkNpcId] of Object.entries(build.npcIdMap)) {
      const sourceState = session.npcStates[sourceNpcId];
      if (!sourceState) continue;
      const forkState = remapNpcRefsInValue(cloneData(sourceState), build.npcIdMap) as typeof sourceState;
      forkState.npcId = forkNpcId;
      forkState.worldId = build.world.id;
      if (!build.world.locations.some(location => location.id === forkState.currentLocationId)) {
        forkState.currentLocationId = build.world.locations[0]?.id ?? forkState.currentLocationId;
      }
      session.npcStates[forkNpcId] = forkState;
    }
  }
}

export function ensureQuestDiscoveryHook(
  world: WorldDNA,
  session: WorldSession,
  allWorlds: Iterable<WorldDNA>,
  force = false,
): QuestDiscoveryHook | undefined {
  if (session.activeQuest?.status === 'active') return undefined;
  session.questHooks = (session.questHooks ?? []).filter(h => h.status !== 'expired').slice(-4);
  const existing = session.questHooks.find(h => h.status === 'available');
  if (existing) return existing;

  const hookNpc = chooseHookNpc(world, session);
  if (!hookNpc) return undefined;
  const roll = stableHash(`${session.id}:${session.currentDate}:${session.currentTime}:${session.dayCount}:${session.currentLocationId}`) % 100;
  if (!force && roll > 17) return undefined;

  const globalOffer = isGlobalQuestOffer(session, force, roll);
  const type = chooseQuestType(world, session);
  const baseTier = chooseQuestTier(world, session, hookNpc);
  const tier = globalOffer && baseTier === 'Minor' ? 'Standard' : baseTier;
  const locationId = session.npcStates[hookNpc.id]?.currentLocationId ?? session.currentLocationId;
  const worldsArray = Array.from(allWorlds);
  const availableWorldCount = worldsArray.length;
  const requiredWorldCount = questRequiredWorldCount(tier);
  const worldRequirement = availableWorldCount < requiredWorldCount
    ? `${tier} quests require ${requiredWorldCount} existing worlds; only ${availableWorldCount} are known, so this cannot be accepted yet.`
    : `It will fork ${requiredWorldCount} existing worlds.`;
  const hook: QuestDiscoveryHook = {
    id: randomUUID(),
    status: 'available',
    templateId: `${type}-${tier.toLowerCase()}`,
    type,
    tier,
    scope: globalOffer ? 'global' : 'local',
    title: globalOffer ? `Global thread: ${hookTitle(type)}` : hookTitle(type),
    detail: `${globalOffer ? 'A global quest thread answers to your persistent character, not this world alone. ' : ''}${hookDetail(type, world)} ${worldRequirement}`,
    npcId: hookNpc.id,
    npcName: hookNpc.name,
    locationId,
    locationName: locationName(world, locationId),
    createdAt: new Date().toISOString(),
    turnOffered: session.dayCount * 24 + session.currentTime,
  };
  session.questHooks.push(hook);
  return hook;
}

function forkSummary(world: WorldDNA, session: WorldSession, currentLocationId?: string): QuestSessionState['forkedWorlds'][string] {
  const resolvedLocationId = currentLocationId && world.locations.some(l => l.id === currentLocationId)
    ? currentLocationId
    : locationAt(world, session, 40);
  return {
    worldId: world.id,
    concept: world.concept,
    currentLocationId: resolvedLocationId,
    currentLocationName: locationName(world, resolvedLocationId),
    visitedLocationIds: [resolvedLocationId],
    locationIds: (world.locations ?? []).map(l => l.id),
    npcIds: (world.npcs ?? []).map(n => n.id),
    forkedAtDate: session.currentDate,
    forkedAtTime: session.currentTime,
    developments: [],
    lastVisitedDevelopmentIndex: 0,
  };
}

function buildObjectives(type: QuestType, tier: QuestTier, worlds: WorldDNA[], session: WorldSession, hook: QuestDiscoveryHook, items?: QuestItem[]): QuestObjective[] {
  const objectives: QuestObjective[] = [];
  const currentWorld = worlds[0];
  const targetCount = TIER_MIN_OBJECTIVES[tier];
  const template = templateFor(type);
  const socialObjective = (npc: WorldNPC | undefined, index: number, itemForIndex?: QuestItem): Pick<QuestObjective, 'title' | 'narrative' | 'kind' | 'requiredItemIds' | 'interactableName'> => {
    if (itemForIndex) {
      if (itemForIndex.sourceType === 'npc' && npc) {
        return {
          title: `Obtain ${itemForIndex.name} from ${npc.name}`,
          narrative: `${npc.name} has the ${itemForIndex.name}. ${itemForIndex.description} Use the right words to convince them to hand it over.`,
          kind: 'obtain_from_npc',
          requiredItemIds: [itemForIndex.id],
        };
      }
      return {
        title: `Find ${itemForIndex.name}`,
        narrative: `The ${itemForIndex.name} is hidden somewhere in this world. ${itemForIndex.description} Search the area carefully.`,
        kind: 'obtain_from_location',
        requiredItemIds: [itemForIndex.id],
      };
    }
    if (!npc) {
      return {
        title: `Search ${locationName(worlds[index % worlds.length] ?? currentWorld, locationAt(worlds[index % worlds.length] ?? currentWorld, session, index))}`,
        narrative: `Look for ${template.clueNoun}. Expect the obvious answer to be incomplete.`,
        kind: 'action',
      };
    }
    const mode = index % 4;
    if (mode === 1) {
      return {
        title: `Persuade ${npc.name}`,
        narrative: `${npc.name} is blocking the next truth. Change their mind, earn their trust, or convince them to help.`,
        kind: 'persuasion',
      };
    }
    if (mode === 2) {
      return {
        title: `Get what ${npc.name} is holding back`,
        narrative: `${npc.name} has something needed for the trail: a name, object, permission, or admission. Ask for it directly or bargain for it.`,
        kind: 'obtain',
      };
    }
    if (mode === 3) {
      const itemTemplates = template.itemTemplates(worlds[index % worlds.length] ?? currentWorld);
      const tmplItem = itemTemplates[index % itemTemplates.length];
      const interactableName = tmplItem ? tmplItem.name : 'something important';
      return {
        title: `Examine ${interactableName}`,
        narrative: `${npc.name} mentioned something about ${interactableName}. ${tmplItem ? tmplItem.description : 'Look around the area and inspect it closely.'}`,
        kind: 'use_interactable',
        interactableName: interactableName,
      };
    }
    return {
      title: `Question ${npc.name}`,
      narrative: `Look for ${template.clueNoun} in ${worlds[index % worlds.length]?.concept ?? currentWorld.concept}. Expect at least one confident lie.`,
      kind: 'dialogue',
    };
  };

  objectives.push({
    id: randomUUID(),
    title: `Hear ${hook.npcName}'s warning`,
    narrative: 'Find out what the mysterious warning is really asking of you.',
    kind: 'dialogue',
    worldId: currentWorld.id,
    npcId: hook.npcId,
    npcName: hook.npcName,
    locationId: hook.locationId,
    locationName: hook.locationName,
    status: 'active',
  });

  for (let i = 1; i < targetCount - 1; i++) {
    const world = worlds[i % worlds.length];
    const itemForThisObj = items?.[i - 1];
    const itemNpc = itemForThisObj?.sourceType === 'npc'
      ? world.npcs.find(n => n.id === itemForThisObj.sourceId)
      : undefined;
    const npc = itemNpc ?? npcAt(world, session, i);
    const locId = itemForThisObj
      ? itemForThisObj.locationId
      : npc ? npcQuestLocation(world, session, npc, i) : locationAt(world, session, i);
    const social = socialObjective(npc, i, itemForThisObj);
    if (itemForThisObj && itemForThisObj.sourceType === 'npc' && social.kind === 'obtain_from_location') {
      const fallbackLoc = world.locations?.[0];
      itemForThisObj.sourceType = 'location';
      itemForThisObj.sourceId = fallbackLoc?.id ?? itemForThisObj.locationId;
      itemForThisObj.sourceName = fallbackLoc?.name ?? 'somewhere nearby';
      itemForThisObj.triggerKeywords = undefined;
    }
    objectives.push({
      id: randomUUID(),
      title: social.title,
      narrative: social.narrative,
      kind: social.kind,
      requiredItemIds: social.requiredItemIds,
      worldId: world.id,
      npcId: itemForThisObj?.sourceType === 'npc' ? (itemForThisObj.sourceId ?? npc?.id) : npc?.id,
      npcName: itemForThisObj?.sourceType === 'npc' ? (itemForThisObj.sourceName ?? npc?.name) : npc?.name,
      locationId: locId,
      locationName: locationName(world, locId),
      interactableName: social.interactableName,
      status: 'locked',
    });
  }

  const finalWorld = currentWorld;
  const finalLocId = hook.locationId;
  objectives.push({
    id: randomUUID(),
    title: `Confirm the chain with ${hook.npcName}`,
    narrative: `${template.finalNarrative} Return to the first witness and let them confirm what the chain now means.`,
    kind: 'dialogue',
    worldId: finalWorld.id,
    npcId: hook.npcId,
    npcName: hook.npcName,
    locationId: finalLocId,
    locationName: locationName(finalWorld, finalLocId),
    status: 'locked',
  });

  if (hook.scope === 'global') {
    const gate = objectives.find((objective, index) => index > 0 && objective.npcId);
    if (gate?.npcId) {
      const npcName = gate.npcName ?? 'the quest witness';
      const giftHint = `a gift that could not exist in ${worlds.find(w => w.id === gate.worldId)?.concept ?? 'this world'}`;
      gate.title = `Give ${npcName} an impossible gift`;
      gate.narrative = `${npcName} will not say the useful part aloud until shown something that breaks this world's rules. Their feelings and internal dialogue carry the clue; the answer should not be obvious at first glance.`;
      gate.requirements = [
        ...(gate.requirements ?? []),
        {
          kind: 'impossible_gift',
          npcId: gate.npcId,
          worldId: gate.worldId,
          label: `Impossible gift to ${npcName}`,
          hintText: giftHint,
        },
      ];
      gate.emitsFacts = [
        ...(gate.emitsFacts ?? []),
        {
          id: `fact:impossible-gift:${gate.worldId}:${gate.npcId}`,
          kind: 'discovery',
          worldId: gate.worldId,
          npcId: gate.npcId,
          summary: `${npcName} accepted an impossible gift and revealed a global clue.`,
        },
      ];
    }
    const weatherGate = objectives.find((objective, index) => index > 1 && objective !== gate && !objective.requirements?.some(req => req.kind === 'weather'));
    if (weatherGate) {
      const condition = ['fog', 'rain', 'storm'][stableHash(`${weatherGate.id}:weather`) % 3];
      weatherGate.title = `${titleCase(condition)} threshold: ${weatherGate.title}`;
      weatherGate.narrative = `${weatherGate.narrative} The portal will not settle until ${weatherGateClue(condition)}.`;
      weatherGate.requirements = [
        ...(weatherGate.requirements ?? []),
        { kind: 'weather', condition, label: `${titleCase(condition)} weather` },
      ];
    }
    const playerStateGate = objectives.find((objective, index) => index > 1 && objective !== gate && objective !== weatherGate && !objective.requirements?.some(req => req.kind === 'player_state'));
    if (playerStateGate) {
      const state = stableHash(`${playerStateGate.id}:player-state`) % 2 === 0 ? 'invisible' : 'cloaked';
      playerStateGate.title = `${state === 'invisible' ? 'Unseen' : 'Cloaked'} threshold: ${playerStateGate.title}`;
      playerStateGate.narrative = `${playerStateGate.narrative} This part of the trail only reacts when ${playerStateGateClue(state)}.`;
      playerStateGate.requirements = [
        ...(playerStateGate.requirements ?? []),
        { kind: 'player_state', state, label: state === 'invisible' ? 'Invisible' : 'Cloaked' },
      ];
    }
  }

  annotateClueChain(objectives, hook);
  return objectives;
}

function clueActionText(objective: QuestObjective): string {
  if (objective.kind === 'dialogue') return `Talk to ${objective.npcName ?? 'the witness'}`;
  if (objective.kind === 'persuasion') return `Persuade ${objective.npcName ?? 'the witness'}`;
  if (objective.kind === 'obtain' || objective.kind === 'obtain_from_npc') return `Get the clue from ${objective.npcName ?? 'the holder'}`;
  if (objective.kind === 'obtain_from_location') return `Search ${objective.locationName ?? 'the marked place'}`;
  if (objective.kind === 'use_interactable') return `Inspect ${objective.interactableName ?? 'the clue object'}`;
  return `Investigate ${objective.locationName ?? 'the marked place'}`;
}

function annotateClueChain(objectives: QuestObjective[], hook: QuestDiscoveryHook): void {
  objectives.forEach((objective, index) => {
    const isFirst = index === 0;
    const isLast = index === objectives.length - 1;
    const isGate = !!objective.requirements?.length;
    objective.clueRole = isFirst ? 'giver' : isLast ? 'confirmation' : isGate ? 'gate' : objective.kind === 'obtain_from_location' || objective.kind === 'use_interactable' || objective.kind === 'action' ? 'location' : 'action';
    objective.clueLabel = objective.clueRole === 'giver' ? 'Quest giver clue'
      : objective.clueRole === 'location' ? 'Location clue'
      : objective.clueRole === 'gate' ? 'Threshold clue'
      : objective.clueRole === 'confirmation' ? 'Final confirmation'
      : 'Action clue';
    objective.clueActionText = clueActionText(objective);
    if (isFirst) {
      objective.clueText ??= `${hook.npcName} starts the chain.`;
      objective.clueDetail ??= `The first answer belongs to ${hook.npcName} at ${hook.locationName}.`;
    }
  });
}

function buildPortals(worlds: WorldDNA[], session: WorldSession): QuestPortal[] {
  const ids = worlds.map(w => w.id);
  return worlds.map((world, index) => {
    const locId = index === 0 ? session.currentLocationId : locationAt(world, session, index + 30);
    return {
      id: randomUUID(),
      fromWorldId: world.id,
      fromWorldName: world.concept,
      locationId: locId,
      locationName: locationName(world, locId),
      linkedWorldIds: ids.filter(id => id !== world.id),
      discovered: index === 0,
    };
  });
}

function buildTraps(type: QuestType, tier: QuestTier): QuestTrap[] {
  const types: QuestTrap['type'][] = ['social', 'false_reward', 'deception', 'comfort', 'loyalty', 'false_urgency'];
  const count = tier === 'Minor' ? 2 : tier === 'Standard' ? 3 : tier === 'Major' ? 5 : 6;
  const template = templateFor(type);
  return Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    type: types[i % types.length],
    stage: Math.min(5, i + 1),
    description: template.trapDescriptions[types[i % types.length]] ?? `${titleCase(types[i % types.length].replace(/_/g, ' '))} pressure enters the quest timeline.`,
    active: i === 0,
    sprung: false,
    turnPenalty: 2 + Math.floor(i / 2),
  }));
}

function buildItems(
  type: QuestType,
  tier: QuestTier,
  worlds: WorldDNA[],
  session: WorldSession,
): QuestItem[] {
  const template = templateFor(type);
  const itemCount = tier === 'Minor' ? 1 : tier === 'Standard' ? 2 : tier === 'Major' ? 3 : 4;

  return Array.from({ length: itemCount }, (_, i) => {
    const world = worlds[(i + 1) % worlds.length];
    const tmpl = template.itemTemplates(world)[i];
    if (!tmpl) return undefined;
    const isNpc = tmpl.sourceType === 'npc';
    const npc = isNpc ? npcAt(world, session, i + 10) : undefined;
    const locId = npc
      ? npcQuestLocation(world, session, npc, i + 20)
      : locationAt(world, session, i + 20);

    return {
      id: randomUUID(),
      name: tmpl.name,
      description: tmpl.description,
      sourceType: tmpl.sourceType,
      sourceId: isNpc ? (npc?.id ?? locId) : locId,
      sourceName: isNpc ? (npc?.name ?? locationName(world, locId)) : locationName(world, locId),
      worldId: world.id,
      locationId: locId,
      triggerKeywords: tmpl.triggerKeywords,
      collected: false,
    };
  }).filter((item) => item !== undefined) as QuestItem[];
}

export function activateQuestEpisode(args: {
  world: WorldDNA;
  session: WorldSession;
  allWorlds: Iterable<WorldDNA>;
  hookId?: string;
  difficulty?: QuestDifficulty;
}): { quest?: QuestSessionState; error?: string } {
  if (args.session.activeQuest?.status === 'active') return { error: 'A quest is already active' };
  const worldsArray = Array.from(args.allWorlds);
  const hook = (args.session.questHooks ?? []).find(h => h.status === 'available' && (!args.hookId || h.id === args.hookId))
    ?? ensureQuestDiscoveryHook(args.world, args.session, worldsArray, true);
  if (!hook) return { error: 'No quest hook is available' };
  const missing = missingQuestRequirements(args.session, undefined, hook.requirements);
  if (missing.length) return { error: `Quest requirements not met: ${missing.join(', ')}` };

  const worldList = [args.world, ...worldsArray.filter(w => w.id !== args.world.id)];
  const requiredWorlds = questRequiredWorldCount(hook.tier);
  if (worldList.length < requiredWorlds) {
    return { error: `${hook.tier} quests require ${requiredWorlds} existing worlds; only ${worldList.length} available.` };
  }
  const selectedWorlds = worldList.slice(0, requiredWorlds);
  const timelineId = randomUUID();
  const forkBuilds = selectedWorlds.map((world, index) => forkWorldForQuest(world, timelineId, index));
  const questWorlds = forkBuilds.map(build => build.world);
  const hookNpcId = forkBuilds[0]?.npcIdMap[hook.npcId] ?? hook.npcId;
  const hookNpc = questWorlds[0]?.npcs.find(npc => npc.id === hookNpcId);
  const hookLocationId = npcQuestLocation(questWorlds[0] ?? args.world, args.session, hookNpc, 0, hook.locationId);
  const forkedHook = { ...hook, npcId: hookNpcId, locationId: hookLocationId, locationName: locationName(questWorlds[0] ?? args.world, hookLocationId) };
  const items = buildItems(hook.type, hook.tier, questWorlds, args.session);
  const objectives = buildObjectives(hook.type, hook.tier, questWorlds, args.session, forkedHook, items);
  seedForkNpcStates(args.session, forkBuilds);
  for (const item of items) {
    const matchingObj = objectives.find(o => o.requiredItemIds?.includes(item.id));
    if (matchingObj) item.requiredForObjectiveId = matchingObj.id;
  }
  const transitions = Math.max(0, questWorlds.length - 1);
  const npcInteractions = objectives.filter(o => o.kind === 'dialogue').length;
  const estimatedTurns = Math.max(12, objectives.length * 5 + transitions * 4 + npcInteractions * 3);
  const deadlineTurns = Math.ceil(estimatedTurns * 1.5);
  hook.status = 'accepted';

  const name = questName(hook.type, args.world);
  const scope = hook.scope ?? 'local';
  const requestedDifficulty = args.difficulty ?? 'normal';
  const rewards = scope === 'global'
    ? (hook.rewards ?? defaultQuestRewards(hook.type, hook.tier, name, timelineId, requestedDifficulty))
    : cloneData(hook.rewards ?? defaultQuestRewards(hook.type, hook.tier, name, timelineId, requestedDifficulty));
  const quest: QuestSessionState = {
    id: randomUUID(),
    timelineId,
    templateId: hook.templateId,
    type: hook.type,
    tier: hook.tier,
    scope,
    title: hook.title,
    detail: hook.detail,
    name,
    status: 'active',
    difficulty: requestedDifficulty,
    blockedPortalAttempts: {},
    revealedPortalAnswers: {},
    ownerSessionId: args.session.id,
    participantSessionIds: [args.session.id],
    hookNpcId,
    hookNpcName: hook.npcName,
    startedAt: new Date().toISOString(),
    baseReturn: {
      worldId: args.session.worldId,
      locationId: args.session.currentLocationId,
      currentDate: args.session.currentDate,
      currentTime: args.session.currentTime,
      dayCount: args.session.dayCount,
      currentWeather: cloneData(args.session.currentWeather),
    },
    participantReturns: {
      [args.session.id]: {
        worldId: args.session.worldId,
        locationId: args.session.currentLocationId,
        currentDate: args.session.currentDate,
        currentTime: args.session.currentTime,
        dayCount: args.session.dayCount,
        currentWeather: cloneData(args.session.currentWeather),
      },
    },
    participantLocations: {
      [args.session.id]: {
        worldId: questWorlds[0]?.id ?? args.world.id,
        locationId: args.session.currentLocationId,
      },
    },
    currentWorldId: questWorlds[0]?.id ?? args.world.id,
    currentLocationId: args.session.currentLocationId,
    currentDate: questWorlds[0]?.currentDate ?? args.session.currentDate,
    currentTime: questWorlds[0]?.currentTime ?? args.session.currentTime,
    dayCount: args.session.dayCount,
    currentWeather: cloneData(questWorlds[0]?.currentWeather ?? args.session.currentWeather),
    forkedWorldIds: questWorlds.map(w => w.id),
    forkedWorlds: Object.fromEntries(questWorlds.map((w, index) => [
      w.id,
      forkSummary(w, args.session, index === 0 ? args.session.currentLocationId : undefined),
    ])),
    forkedWorldData: Object.fromEntries(questWorlds.map(w => [w.id, w])),
    baseWorldIdsByForkId: Object.fromEntries(forkBuilds.map(build => [build.world.id, build.sourceWorldId])),
    npcIdMapsByForkWorldId: Object.fromEntries(forkBuilds.map(build => [build.world.id, build.npcIdMap])),
    portals: buildPortals(questWorlds, args.session),
    objectives,
    turnCounter: 0,
    estimatedTurns,
    deadlineTurns,
    urgencyStage: 1,
    urgencyLabel: URGENCY[0].label,
    urgencyNarrative: URGENCY[0].text,
     traps: buildTraps(hook.type, hook.tier),
     inventory: items,
     requirements: cloneData(hook.requirements ?? []),
     rewards: cloneData(rewards),
     questFacts: [],
     successEcho: templateFor(hook.type).successEcho(args.session.playerName, name),
    failureEcho: templateFor(hook.type).failureEcho(args.session.playerName, name),
    log: [
      `Accepted from ${hook.npcName} at ${hook.locationName}.`,
      ...(scope === 'global' ? ['Global quest: medals can be earned when this thread is completed.'] : []),
    ],
  };

  args.session.activeQuest = quest;
  args.session.significantEvents.push(`Quest accepted: ${name}.`);
  args.session.significantEvents = args.session.significantEvents.slice(-20);
  addQuestFeed(args.session, `Quest accepted: ${name}`);
  return { quest };
}

function activeObjective(quest: QuestSessionState): QuestObjective | undefined {
  return quest.objectives.find(o => o.status === 'active');
}

function unlockNextObjective(quest: QuestSessionState): QuestObjective | undefined {
  const next = quest.objectives.find(o => o.status === 'locked');
  if (next) next.status = 'active';
  return next;
}

function revealPortalForObjective(quest: QuestSessionState, objective: QuestObjective | undefined, session?: WorldSession): QuestPortal | undefined {
  if (!objective?.worldId) return undefined;
  const gatedRequirements = portalGateRequirements(objective.requirements);
  if (gatedRequirements && session && !questRequirementsSatisfied(session, quest, gatedRequirements)) return undefined;
  const portal = quest.portals.find(p => p.fromWorldId === objective.worldId);
  if (!portal || portal.discovered) return undefined;
  portal.discovered = true;
  quest.log.push(`Portal opened: ${portal.fromWorldName} at ${portal.locationName}.`);
  quest.log = quest.log.slice(-20);
  return portal;
}

export function refreshQuestPortalGates(session: WorldSession): QuestPortal[] {
  const quest = session.activeQuest;
  if (!quest || quest.status !== 'active') return [];
  const opened: QuestPortal[] = [];
  for (const objective of quest.objectives.filter(o => o.status === 'active')) {
    const portal = revealPortalForObjective(quest, objective, session);
    if (portal) {
      opened.push(portal);
      addQuestFeed(session, `Portal opened: ${portal.fromWorldName} at ${portal.locationName}.`);
    }
  }
  return opened;
}

function updateUrgency(quest: QuestSessionState): boolean {
  const ratio = quest.deadlineTurns > 0 ? quest.turnCounter / quest.deadlineTurns : 0;
  const next = URGENCY.find(stage => ratio <= stage.limit) ?? URGENCY[URGENCY.length - 1];
  if (next.stage === quest.urgencyStage) return false;
  quest.urgencyStage = next.stage;
  quest.urgencyLabel = next.label;
  quest.urgencyNarrative = next.text;
  for (const trap of quest.traps) {
    if (trap.stage <= next.stage) trap.active = true;
  }
  quest.log.push(`Urgency: ${next.label}.`);
  quest.log = quest.log.slice(-20);
  return true;
}

function addQuestDevelopment(quest: QuestSessionState, worldId: string, text: string): void {
  const fork = quest.forkedWorlds[worldId];
  if (!fork) return;
  fork.developments = [...(fork.developments ?? []), text].slice(-12);
}

function advanceQuestBackground(
  quest: QuestSessionState,
  event: QuestAdvanceEvent,
  completedObjective?: QuestObjective,
): string[] {
  const currentWorldId = event.worldId ?? quest.currentWorldId;
  const candidates = quest.forkedWorldIds.filter(worldId => worldId !== currentWorldId);
  if (!candidates.length) return [];
  const shouldAdvance = event.kind === 'wait'
    || event.kind === 'tick'
    || quest.urgencyStage >= 3
    || quest.turnCounter % 4 === 0
    || !!completedObjective;
  if (!shouldAdvance) return [];

  const limit = quest.tier === 'Minor' ? 1 : quest.tier === 'Standard' ? 2 : 3;
  const start = stableHash(`${quest.id}:${quest.turnCounter}:${event.kind}:${event.summary ?? ''}`) % candidates.length;
  const developments: string[] = [];
  for (let i = 0; i < Math.min(limit, candidates.length); i++) {
    const worldId = candidates[(start + i) % candidates.length];
    const worldName = quest.forkedWorlds[worldId]?.concept ?? worldId;
    const text = completedObjective
      ? `${worldName} reacts to "${completedObjective.title}" before the portal can carry the full story.`
      : templateFor(quest.type).development(worldName, quest.urgencyLabel);
    addQuestDevelopment(quest, worldId, text);
    developments.push(text);
  }
  return developments;
}

function springQuestTrap(
  quest: QuestSessionState,
  event: QuestAdvanceEvent,
  completedObjective?: QuestObjective,
): QuestTrap | undefined {
  if (completedObjective) return undefined;
  if (event.kind === 'dialogue' || event.kind === 'movement') return undefined;
  const trap = quest.traps.find(item => item.active && !item.sprung && item.stage <= quest.urgencyStage);
  if (!trap) return undefined;
  trap.sprung = true;
  trap.sprungAtTurn = quest.turnCounter;
  const penalty = Math.max(1, Math.min(6, Math.round(trap.turnPenalty ?? 2)));
  trap.consequence = trap.consequence ?? `${titleCase(trap.type.replace(/_/g, ' '))} pressure costs ${penalty} turn(s).`;
  quest.turnCounter += penalty;
  quest.log.push(`Trap sprung: ${trap.description}`);
  quest.log = quest.log.slice(-20);
  return trap;
}

function eventCompletesObjective(objective: QuestObjective, event: QuestAdvanceEvent, quest?: QuestSessionState): boolean {
  if (objective.worldId && event.worldId && objective.worldId !== event.worldId) return false;
  if (objective.locationId && event.locationId && objective.locationId !== event.locationId) return false;
  const impossibleGiftRequirement = objective.requirements?.find(req => req.kind === 'impossible_gift');
  if (impossibleGiftRequirement) {
    if (event.kind !== 'dialogue' && event.kind !== 'action') return false;
    const targetNpcId = objective.npcId ?? impossibleGiftRequirement.npcId;
    return !targetNpcId || targetNpcId === event.npcId || impossibleGiftRequirement.npcId === event.npcId;
  }
  if (objective.kind === 'dialogue') return event.kind === 'dialogue' && (!objective.npcId || objective.npcId === event.npcId);
  if (objective.kind === 'persuasion') {
    if (event.kind !== 'dialogue' || (objective.npcId && objective.npcId !== event.npcId)) return false;
    return /\b(persuade|convince|reconsider|change your mind|trust me|believe me|help me|please|listen|understand|promise|swear|reason with|appeal)\b/i.test(compact(event.summary));
  }
  if (objective.kind === 'obtain') {
    if (objective.npcId && objective.npcId !== event.npcId) return false;
    if (event.kind !== 'dialogue' && event.kind !== 'action') return false;
    return /\b(give|hand over|provide|bring|offer|trade|bargain|ask for|request|need|get|take|borrow|show me|tell me|admit|confess|permission|key|name|proof|evidence|document|token|medicine|cure)\b/i.test(compact(event.summary));
  }
  if (objective.kind === 'obtain_from_npc') {
    if (event.kind !== 'dialogue' || (objective.npcId && objective.npcId !== event.npcId)) return false;
    if (!objective.requiredItemIds?.length || !quest) return false;
    const item = quest.inventory.find(i => objective.requiredItemIds!.includes(i.id) && !i.collected);
    if (!item || !item.triggerKeywords?.length) return false;
    const haystack = compact(event.summary).toLowerCase();
    return fuzzyKeywordHit(haystack, item.triggerKeywords);
  }
  if (objective.kind === 'obtain_from_location') {
    if (objective.locationId && event.locationId && objective.locationId !== event.locationId) return false;
    if (event.kind !== 'action') return false;
    const haystack = compact(event.summary).toLowerCase();
    return /\b(search|find|look|investigate|discover|uncover|dig|examine|explore|pick up|grab|collect|retrieve)\b/.test(haystack);
  }
  if (objective.kind === 'travel') return event.kind === 'movement' && (!objective.locationId || objective.locationId === event.locationId);
  if (objective.kind === 'use_interactable') {
    if (objective.locationId && event.locationId && objective.locationId !== event.locationId) return false;
    if (event.kind !== 'action' && event.kind !== 'use_interactable') return false;
    const haystack = compact(event.summary).toLowerCase();
    if (!/\b(inspect|examine|check|look at|use|interact with|open|press|pull|activate)\b/.test(haystack)) return false;
    if (objective.interactableName) {
      return haystack.includes(objective.interactableName.toLowerCase());
    }
    return true;
  }
  if (objective.kind === 'action' || objective.kind === 'choice') {
    if (objective.locationId && objective.locationId !== event.locationId) return false;
    if (event.kind === 'action') return true;
    const haystack = compact(event.summary).toLowerCase();
    return objective.locationId === event.locationId && /\b(confront|expose|cure|ritual|seal|contain|choose|search|investigate|administer|broker)\b/.test(haystack);
  }
  return false;
}

function maybeRecordClueAttempt(session: WorldSession, quest: QuestSessionState, objective: QuestObjective | undefined, event: QuestAdvanceEvent, completed: boolean): void {
  if (!objective || completed) return;
  const summary = compact(event.summary).toLowerCase();
  const wrongNpc = event.kind === 'dialogue' && !!objective.npcId && !!event.npcId && objective.npcId !== event.npcId;
  const searchLike = event.kind === 'action' && /\b(search|inspect|investigate|look|examine|study)\b/.test(summary);
  const wrongLocation = searchLike && !!objective.locationId && !!event.locationId && objective.locationId !== event.locationId;
  if (!wrongNpc && !wrongLocation) return;
  objective.clueAttemptCount = (objective.clueAttemptCount ?? 0) + 1;
  const direct = quest.difficulty === 'easy' || ((quest.difficulty ?? 'normal') === 'normal' && objective.clueAttemptCount >= 3);
  if (direct) objective.clueRevealedTarget = true;
  const target = objective.npcName || objective.locationName || objective.clueActionText || objective.title;
  const redirect = direct
    ? `Quest clue target revealed: ${target}.`
    : wrongNpc
      ? `${session.playerName} asks the wrong person; they point back toward ${objective.locationName ?? objective.npcName ?? 'the quest trail'}.`
      : `${session.playerName} searches the wrong place; the clue still points toward ${objective.locationName ?? objective.npcName ?? 'the quest trail'}.`;
  quest.log.push(redirect);
  quest.log = quest.log.slice(-20);
  addQuestFeed(session, redirect);
}

function discoverObjectiveClue(session: WorldSession, quest: QuestSessionState, objective: QuestObjective | undefined, event: QuestAdvanceEvent): boolean {
  if (!objective || objective.clueDiscovered || event.kind !== 'dialogue') return false;
  if (objective.npcId && objective.npcId !== event.npcId) return false;
  const clue = objectiveGateClue(objective);
  if (!clue) return false;
  objective.clueDiscovered = true;
  objective.clueDiscoveredAtTurn = quest.turnCounter;
  objective.clueText = clue.text;
  objective.clueDetail = clue.detail;
  if (quest.blockedPortalAttempts) delete quest.blockedPortalAttempts[objective.id];
  if (quest.revealedPortalAnswers) delete quest.revealedPortalAnswers[objective.id];
  quest.log.push(`Clue heard: ${clue.text}`);
  quest.log = quest.log.slice(-20);
  addQuestFeed(session, `Clue heard: ${clue.text}`);
  return true;
}

export function advanceQuestEpisode(session: WorldSession, event: QuestAdvanceEvent): {
  quest?: QuestSessionState;
  echo?: QuestEcho;
  completedObjective?: QuestObjective;
  urgencyChanged?: boolean;
  sprungTrap?: QuestTrap;
  developments?: string[];
} {
  const quest = session.activeQuest;
  if (!quest || quest.status !== 'active') return {};
  quest.turnCounter += Math.max(1, Math.min(12, Math.round(event.turnCost ?? 1)));
  quest.lastAdvancedAt = new Date().toISOString();
  let urgencyChanged = updateUrgency(quest);
  let completedObjective: QuestObjective | undefined;

  const objective = activeObjective(quest);
  discoverObjectiveClue(session, quest, objective, event);
  const objectiveCompleted = !!objective && questRequirementsSatisfied(session, quest, objective.requirements) && eventCompletesObjective(objective, event, quest);
  maybeRecordClueAttempt(session, quest, objective, event, objectiveCompleted);
  if (objective && objectiveCompleted) {
    objective.status = 'complete';
    objective.completedAtTurn = quest.turnCounter;
    completedObjective = objective;
    quest.log.push(`Completed: ${objective.title}.`);
    for (const factTemplate of objective.emitsFacts ?? []) {
      const fact: QuestFact = {
        ...factTemplate,
        createdAtTurn: quest.turnCounter,
        createdAt: new Date().toISOString(),
      };
      quest.questFacts = mergeQuestFacts(quest.questFacts, [fact]);
      if (session.globalPlayerId) session.questFacts = mergeQuestFacts(session.questFacts, [fact]);
      quest.log.push(`Learned: ${fact.summary}.`);
    }
    const nextObjective = unlockNextObjective(quest);
    const openedPortal = revealPortalForObjective(quest, nextObjective, session);
    if (openedPortal) addQuestFeed(session, `Portal opened: ${openedPortal.fromWorldName} at ${openedPortal.locationName}.`);
  }

  if (completedObjective && (completedObjective.kind === 'obtain_from_npc' || completedObjective.kind === 'obtain_from_location')) {
    for (const itemId of completedObjective.requiredItemIds ?? []) {
      const item = quest.inventory.find(i => i.id === itemId);
      if (item && !item.collected) {
        item.collected = true;
        item.collectedAtTurn = quest.turnCounter;
        quest.log.push(`Collected: ${item.name}.`);
        addQuestFeed(session, `${quest.name}: obtained ${item.name}.`);
      }
    }
  }

  refreshQuestPortalGates(session);

  let sprungTrap: QuestTrap | undefined;
  if (!quest.objectives.every(o => o.status === 'complete')) {
    sprungTrap = springQuestTrap(quest, event, completedObjective);
    if (sprungTrap) urgencyChanged = updateUrgency(quest) || urgencyChanged;
  }
  const developments = advanceQuestBackground(quest, event, completedObjective);

  if (quest.objectives.every(o => o.status === 'complete')) {
    const echo = resolveQuestEpisode(session, 'succeeded');
    return { quest, echo, completedObjective, urgencyChanged, sprungTrap, developments };
  }

  if (quest.turnCounter >= quest.deadlineTurns) {
    const echo = resolveQuestEpisode(session, 'failed');
    return { quest, echo, completedObjective, urgencyChanged, sprungTrap, developments };
  }

  if (urgencyChanged) addQuestFeed(session, `${quest.name}: ${quest.urgencyLabel}`);
  if (sprungTrap) addQuestFeed(session, `${quest.name}: ${sprungTrap.consequence ?? sprungTrap.description}`);
  if (developments.length) addQuestFeed(session, developments.slice(-2).join(' '));
  return { quest, completedObjective, urgencyChanged, sprungTrap, developments };
}

function addQuestFeed(session: WorldSession, message: string): void {
  session.feedEvents = session.feedEvents ?? [];
  session.feedEvents.push({ t: new Date().toISOString(), ty: 'quest', x: message });
  session.feedEvents = session.feedEvents.slice(-250);
}

function cleanupForkedNpcStates(session: WorldSession, quest: QuestSessionState): void {
  const npcMaps = quest.npcIdMapsByForkWorldId;
  if (!npcMaps) return;
  for (const npcIdMap of Object.values(npcMaps)) {
    for (const forkNpcId of Object.values(npcIdMap)) {
      delete session.npcStates[forkNpcId];
    }
  }
}

function resolveQuestEpisode(session: WorldSession, status: 'succeeded' | 'failed' | 'abandoned'): QuestEcho | undefined {
  const quest = session.activeQuest;
  if (!quest) return undefined;
  const returnPoint = quest.participantReturns?.[session.id] ?? quest.baseReturn;
  let echo: QuestEcho | undefined;
  try {
    quest.status = status;
    quest.completedAt = new Date().toISOString();
    quest.resolutionEcho = status === 'succeeded' ? quest.successEcho : quest.failureEcho;
    if (status === 'succeeded') {
      const cluePath = quest.objectives
        .filter(o => o.status === 'complete')
        .map(o => o.clueActionText ?? o.title)
        .filter(Boolean)
        .join(' -> ');
      if (cluePath) quest.resolutionEcho = `${quest.resolutionEcho} Clue path: ${cluePath}.`;
    }
    if (status === 'abandoned') quest.resolutionEcho = `${session.playerName} abandoned ${quest.name}; the forked timeline is discarded.`;
    if (status === 'succeeded' && session.globalPlayerId) {
      const earnedAt = quest.completedAt;
      const medals = quest.scope === 'global' ? (quest.rewards?.medals ?? []).map(medal => ({ ...medal, earnedAt })) : [];
      const achievements = (quest.rewards?.achievements ?? []).map(achievement => ({ ...achievement, earnedAt }));
      session.medals = mergeById(session.medals, medals);
      session.achievements = mergeById(session.achievements, achievements);
      session.questFacts = mergeQuestFacts(session.questFacts, quest.questFacts ?? []);
    }
    if (status === 'failed') {
      quest.retryAvailableAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      quest.retryPenalty = 'NPCs remember the failed attempt; retry is allowed with colder reactions.';
      session.reputation = session.reputation === 'unknown' ? 'unreliable' : session.reputation;
    }

    echo = {
      id: randomUUID(),
      questId: quest.id,
      questName: quest.name,
      status,
      message: quest.resolutionEcho,
      createdAt: quest.completedAt,
    };
    session.questEchoes = [...(session.questEchoes ?? []), echo].slice(-20);
    session.significantEvents.push(echo.message);
    session.significantEvents = session.significantEvents.slice(-20);
    addQuestFeed(session, echo.message);
  } catch (err) {
    console.warn('[quest] resolveQuestEpisode error:', err);
    if (!echo) {
      echo = {
        id: randomUUID(),
        questId: quest.id,
        questName: quest.name,
        status,
        message: quest.resolutionEcho ?? `${quest.name} resolved with errors.`,
        createdAt: new Date().toISOString(),
      };
    }
  }
  session.worldId = returnPoint.worldId;
  session.currentLocationId = returnPoint.locationId;
  session.currentDate = returnPoint.currentDate;
  session.currentTime = returnPoint.currentTime;
  session.dayCount = returnPoint.dayCount;
  try { if (returnPoint.currentWeather) session.currentWeather = cloneData(returnPoint.currentWeather); } catch { /* keep current weather if clone fails */ }
  cleanupForkedNpcStates(session, quest);
  session.activeQuest = undefined;
  return echo;
}

export function travelQuestPortal(session: WorldSession, args: {
  worldId?: string;
  portalId?: string;
}): {
  quest?: QuestSessionState;
  error?: string;
  questUpdate?: ReturnType<typeof advanceQuestEpisode>;
  destination?: QuestPortal;
  developments?: string[];
  blocked?: { message: string; attempts: number; difficulty: string; exactRevealed: boolean; portalId?: string };
} {
  const quest = session.activeQuest;
  if (!quest || quest.status !== 'active') return { error: 'No active quest' };

  const participant = quest.participantLocations?.[session.id] ?? {
    worldId: quest.currentWorldId,
    locationId: quest.currentLocationId,
  };
  const currentPortal = quest.portals.find(p => p.fromWorldId === participant.worldId);
  if (!currentPortal) return { error: 'No quest portal is open in this forked world' };
  if (participant.locationId !== currentPortal.locationId) return { error: `Reach ${currentPortal.locationName} before using that quest portal` };
  const destination = args.portalId
    ? quest.portals.find(p => p.id === args.portalId)
    : args.worldId
      ? quest.portals.find(p => p.fromWorldId === args.worldId)
      : undefined;
  if (!destination) return { error: 'Quest destination not found' };
  if (destination.discovered === false) {
    const gatedObjective = quest.objectives.find(o => o.status === 'active' && o.worldId === destination.fromWorldId)
      ?? quest.objectives.find(o => o.worldId === destination.fromWorldId && o.status !== 'complete');
    const attemptKey = gatedObjective?.id ?? destination.id;
    quest.blockedPortalAttempts ??= {};
    const previousAttempts = quest.blockedPortalAttempts[attemptKey] ?? 0;
    quest.blockedPortalAttempts[attemptKey] = previousAttempts + 1;
    quest.revealedPortalAnswers ??= {};
    if (quest.difficulty === 'normal' && quest.blockedPortalAttempts[attemptKey] >= 3) quest.revealedPortalAnswers[attemptKey] = true;
    const message = blockedPortalMessage(quest, gatedObjective, attemptKey);
    addQuestFeed(session, message);
    return {
      quest,
      error: message,
      blocked: {
        message,
        attempts: quest.blockedPortalAttempts[attemptKey],
        difficulty: quest.difficulty ?? 'normal',
        exactRevealed: !!quest.revealedPortalAnswers[attemptKey] || quest.difficulty === 'easy' || !!(gatedObjective as any)?.clueDiscovered,
        portalId: destination.id,
      },
    };
  }
  if (destination.fromWorldId === participant.worldId) return { error: 'Already in that quest world' };
  const linkedWorldIds = currentPortal.linkedWorldIds?.length
    ? currentPortal.linkedWorldIds
    : quest.portals.map(p => p.fromWorldId).filter(id => id !== currentPortal.fromWorldId);
  if (!linkedWorldIds.includes(destination.fromWorldId)) return { error: 'That quest world is not linked from here' };

  const previous = quest.forkedWorlds[participant.worldId];
  if (previous) {
    previous.currentLocationId = participant.locationId;
    previous.visitedLocationIds = Array.from(new Set([...(previous.visitedLocationIds ?? []), participant.locationId]));
  }

  destination.discovered = true;
  quest.participantLocations ??= {};
  quest.participantLocations[session.id] = {
    worldId: destination.fromWorldId,
    locationId: destination.locationId,
  };
  quest.currentWorldId = destination.fromWorldId;
  quest.currentLocationId = destination.locationId;
  const targetWorld = quest.forkedWorldData?.[destination.fromWorldId];
  if (targetWorld) {
    targetWorld.currentDate = targetWorld.currentDate ?? quest.currentDate;
    targetWorld.currentTime = targetWorld.currentTime ?? quest.currentTime;
    if (!targetWorld.currentWeather && quest.currentWeather) targetWorld.currentWeather = cloneData(quest.currentWeather);
    quest.currentDate = targetWorld.currentDate;
    quest.currentTime = targetWorld.currentTime;
    quest.currentWeather = cloneData(targetWorld.currentWeather ?? quest.currentWeather);
  }
  if (quest.currentDate) session.currentDate = quest.currentDate;
  if (quest.currentTime !== undefined) session.currentTime = quest.currentTime;
  if (quest.dayCount !== undefined) session.dayCount = quest.dayCount;
  if (quest.currentWeather) session.currentWeather = cloneData(quest.currentWeather);
  const target = quest.forkedWorlds[destination.fromWorldId];
  const developments = target?.developments?.slice(target.lastVisitedDevelopmentIndex ?? 0) ?? [];
  if (target) {
    target.currentLocationId = destination.locationId;
    target.currentLocationName = destination.locationName;
    target.visitedLocationIds = Array.from(new Set([...(target.visitedLocationIds ?? []), destination.locationId]));
    target.lastVisitedDevelopmentIndex = target.developments?.length ?? 0;
  }
  quest.log.push(`Portal: ${currentPortal.fromWorldName} -> ${destination.fromWorldName}.`);
  quest.log = quest.log.slice(-20);
  addQuestFeed(session, `${quest.name}: portal opened to ${destination.fromWorldName}.`);
  if (developments.length) addQuestFeed(session, `${destination.fromWorldName}: ${developments.slice(-2).join(' ')}`);

  const questUpdate = advanceQuestEpisode(session, {
    kind: 'movement',
    turnCost: 2,
    worldId: destination.fromWorldId,
    locationId: destination.locationId,
    summary: `portal to ${destination.fromWorldName}`,
  });
  return { quest, questUpdate, destination, developments };
}

export function abandonQuestEpisode(session: WorldSession): { echo?: QuestEcho; error?: string } {
  if (!session.activeQuest || session.activeQuest.status !== 'active') return { error: 'No active quest to abandon' };
  return { echo: resolveQuestEpisode(session, 'abandoned') };
}

export function getQuestStatus(session: WorldSession) {
  const availableHooks: QuestDiscoveryHook[] = [];
  const lockedHooks: Array<QuestDiscoveryHook & { missingRequirements: string[] }> = [];
  for (const hook of (session.questHooks ?? []).filter(h => h.status === 'available')) {
    const missing = missingQuestRequirements(session, session.activeQuest, hook.requirements);
    if (missing.length) lockedHooks.push({ ...hook, missingRequirements: missing });
    else availableHooks.push(hook);
  }
  return {
    activeQuest: session.activeQuest ?? null,
    portals: session.activeQuest?.status === 'active' ? session.activeQuest.portals : [],
    hooks: availableHooks,
    lockedHooks,
    invites: session.questInvites ?? [],
    echoes: session.questEchoes ?? [],
    medals: session.medals ?? [],
    achievements: session.achievements ?? [],
    questFacts: session.questFacts ?? [],
  };
}

export function deriveQuestLeads(session: WorldSession): DramaLead[] {
  const active = session.activeQuest;
  if (active?.status === 'active') {
    const objective = activeObjective(active);
    const participant = active.participantLocations?.[session.id];
    const currentWorldId = participant?.worldId ?? active.currentWorldId;
    return [{
      id: `quest:${active.id}`,
      type: 'quest',
      tone: active.urgencyStage >= 4 ? 'danger' : active.urgencyStage >= 3 ? 'tense' : 'mysterious',
      title: active.name,
      detail: `${objective?.narrative ?? active.urgencyNarrative} ${active.urgencyLabel}. Current fork: ${active.forkedWorlds[currentWorldId]?.concept ?? currentWorldId}.`,
      urgency: Math.min(100, 60 + active.urgencyStage * 8),
      npcId: objective?.npcId,
      npcName: objective?.npcName,
      locationId: objective?.locationId,
      locationName: objective?.locationName,
      actionLabel: objective?.npcName && objective.kind === 'persuasion' ? `Persuade ${objective.npcName}`
        : objective?.npcName && objective.kind === 'obtain' ? `Ask ${objective.npcName}`
          : objective?.npcName && objective.kind === 'obtain_from_npc' ? `Get item from ${objective.npcName}`
            : objective?.kind === 'obtain_from_location' ? `Search ${objective.locationName ?? 'the area'}`
              : objective?.kind === 'dialogue' && objective.npcName ? `Find ${objective.npcName}`
                : 'Quest status',
      command: objective?.npcName && (objective.kind === 'dialogue' || objective.kind === 'persuasion' || objective.kind === 'obtain' || objective.kind === 'obtain_from_npc') ? `talk to ${objective.npcName}` : objective?.kind === 'obtain_from_location' ? 'search' : 'quest portals',
    }];
  }

  const hook = (session.questHooks ?? []).find(h => h.status === 'available' && questRequirementsSatisfied(session, session.activeQuest, h.requirements));
  if (!hook) return [];
  return [{
    id: `quest-hook:${hook.id}`,
    type: 'quest',
    tone: 'mysterious',
    title: hook.title,
    detail: hook.detail,
    urgency: 82,
    npcId: hook.npcId,
    npcName: hook.npcName,
    locationId: hook.locationId,
    locationName: hook.locationName,
    actionLabel: 'Accept quest',
    command: 'accept quest',
  }];
}

export function describeQuestForDialogue(session: WorldSession, npcId?: string): string | undefined {
  const quest = session.activeQuest;
  if (!quest || quest.status !== 'active') return undefined;
  const objective = activeObjective(quest);
  const participant = quest.participantLocations?.[session.id];
  const currentWorldId = participant?.worldId ?? quest.currentWorldId;
  const currentLocationId = participant?.locationId ?? quest.currentLocationId;
  const personal = npcId && (objective?.npcId === npcId || quest.hookNpcId === npcId)
    ? 'This person is directly entangled in the current quest objective.'
    : 'This person may know rumors, lies, or distractions, but should not magically know hidden quest truth unless their role supports it.';
  const npcItems = quest.inventory.filter(
    i => i.sourceType === 'npc' && i.sourceId === npcId && !i.collected
  );
  const itemContext = npcItems.length
    ? npcItems.map(item =>
      `This NPC possesses "${item.name}" (${item.description}). They should give it to the player ONLY if the player asks for it using words like: ${(item.triggerKeywords ?? []).join(', ')}. Until then, the NPC knows they have it but does not volunteer it freely. When handing it over, describe the moment with weight — this is a quest item.`
    ).join('\n')
    : '';
  const giftRequirements = (objective?.requirements ?? []).filter(
    req => req.kind === 'impossible_gift' && req.npcId === npcId
  ) as Extract<QuestRequirement, { kind: 'impossible_gift' }>[];
  const giftContext = giftRequirements.length
    ? giftRequirements.map(req => {
      const desired = req.hintText ?? req.requestText ?? (req.giftPattern ? `something impossible connected to "${req.giftPattern}"` : 'an impossible gift');
      return `This NPC is quest-bound to an impossible gift requirement. They want ${desired}. They should not name the quest system or say "requirement"; instead let longing, fear, envy, awe, or hesitation leak through their words and inner feelings. If the player gives a fitting impossible gift, react as if a hidden door in the situation has opened.`;
    }).join('\n')
    : '';
  const gateRequirements = (objective?.requirements ?? []).filter(
    req => req.kind === 'weather' || req.kind === 'player_state'
  ) as Extract<QuestRequirement, { kind: 'weather' | 'player_state' }>[];
  const gateContext = gateRequirements.length
    ? gateRequirements.map(req => {
      if (req.kind === 'weather') {
        return `The current quest threshold is sensitive to weather. Do not say the exact weather word unless the player has clearly earned it; instead let the NPC notice that ${weatherGateClue(req.condition)}.`;
      }
      return `The current quest threshold is sensitive to the player's state. Do not say the mechanic directly; instead let the NPC's words, unease, or inner feelings imply that ${playerStateGateClue(req.state)}.`;
    }).join('\n')
    : '';
  return [
    `ACTIVE QUEST: ${quest.name} (${quest.type}, ${quest.tier}).`,
    `Urgency: ${quest.urgencyLabel}. ${quest.urgencyNarrative}`,
    `Current quest fork: ${quest.forkedWorlds[currentWorldId]?.concept ?? currentWorldId} at ${quest.forkedWorlds[currentWorldId]?.currentLocationName ?? currentLocationId}.`,
    objective ? `Current objective: ${objective.title}. ${objective.narrative}` : '',
    objective?.clueDiscovered && objective.clueText ? `The player has discovered this gate clue: ${objective.clueText}` : '',
    `Turns used: ${quest.turnCounter}/${quest.deadlineTurns}.`,
    personal,
    itemContext,
    giftContext,
    gateContext,
    'NPCs may mislead, tempt, stall, or pressure the player if that fits their motives. Do not expose the quest system as a game mechanic.',
  ].filter(Boolean).join('\n');
}
