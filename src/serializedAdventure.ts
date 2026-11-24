import { randomUUID } from 'crypto';
import {
  WorldDNA,
  WorldSession,
  SerializedAdventure,
  SerializedAct,
  SerializedBeat,
  SerializedBeatEvaluation,
  SerializedTimedEvent,
  SerializedScoreEntry,
  SerializedAdventureResult,
  SerializedSpectrumTier,
  QuestMedal,
  QuestAchievement,
  ObjectiveEvent,
  TimelineEvent,
} from './types.js';
import { llmJSON } from './llm.js';
import { awardBeatXp, awardAdventureCompletionXp, checkMilestoneMedals, computeAdventurerRank, type AdventurerRank } from './adventurerProgression.js';
import { keywordStems, fuzzyOverlapCount } from './fuzzyMatch.js';

// ── Spectrum scoring ────────────────────────────────────────────────────────

export function spectrumTierLabel(score: number): SerializedSpectrumTier {
  if (score >= 0.9) return 'Legendary';
  if (score >= 0.7) return 'Heroic';
  if (score >= 0.5) return 'Standard';
  if (score >= 0.3) return 'Flawed';
  return 'Tragic';
}

export function calculateSpectrumScore(adventure: SerializedAdventure): number {
  const beats = adventure.acts.flatMap(act => act.beats);
  const totalWeight = beats.reduce((sum, beat) => sum + beat.weight, 0);
  if (totalWeight === 0) return 0;
  const earned = beats.reduce((sum, beat) => sum + (beat.evaluation?.scoreContribution ?? 0), 0);
  const timedAdjustment = adventure.timedEvents
    .filter(ev => ev.status === 'triggered' && ev.scoreImpact)
    .reduce((sum, ev) => sum + (ev.scoreImpact ?? 0), 0);
  return Math.max(0, Math.min(1, (earned / totalWeight) + timedAdjustment));
}

// ── Generation ──────────────────────────────────────────────────────────────

export interface SerializedAdventureGenerationOptions {
  focusTimelineEvent?: TimelineEvent;
  focusTimelineEvents?: TimelineEvent[];
}

function storyArcExcerptText(text: string | undefined | null, maxChars: number): string {
  const source = String(text ?? '').trim();
  if (!source || source.length <= maxChars) return source;
  const markerBudget = 900;
  const segment = Math.max(1000, Math.floor((maxChars - markerBudget) / 3));
  const middleStart = Math.max(0, Math.floor((source.length - segment) / 2));
  const tailStart = Math.max(0, source.length - segment);
  return [
    `[SOURCE EXCERPT: BEGINNING chars 1-${segment}]`,
    source.slice(0, segment),
    `[SOURCE EXCERPT: MIDDLE chars ${middleStart + 1}-${middleStart + segment}]`,
    source.slice(middleStart, middleStart + segment),
    `[SOURCE EXCERPT: ENDING / OUTCOME chars ${tailStart + 1}-${source.length}]`,
    source.slice(tailStart),
  ].join('\n\n').slice(0, maxChars);
}

export async function generateSerializedAdventure(
  world: WorldDNA,
  sourceCorpus: string,
  sourceTerms: string[],
  provider?: string,
  model?: string,
  options: SerializedAdventureGenerationOptions = {},
): Promise<SerializedAdventure> {
  const fallback = fallbackSerializedAdventure(world);
  const focusTimelineEvents = [
    ...(options.focusTimelineEvent ? [options.focusTimelineEvent] : []),
    ...(options.focusTimelineEvents ?? []),
  ].filter(Boolean);
  const focusedTimelineCorpus = focusTimelineEvents.map(ev =>
    `${ev.date} — ${ev.title} (${ev.type}): ${ev.description}`
  ).join('\n');
  const timelineFocusInstruction = focusTimelineEvents.length
    ? `\n\nTIMELINE FOCUS MODE: Generate this adventure from ONLY the selected timeline event(s). The adventure must be a complete playable quest built around those event(s), not the whole world arc. Title, logline, acts, beats, timed events, NPCs, and locations must clearly reflect the selected timeline event date/title/description.`
    : '';
  try {
    const raw = await llmJSON<any>({
      provider: provider || world.provider,
      model,
      temperature: 0.62,
      maxTokens: 4096,
      system: `Generate a Serialized Adventure — a cinematic, act-structured quest for a life simulator world. The adventure should feel like a film or novel grounded in the world's source material.

Structure: 3 to 5 acts (use 3 for a short concept, 4-5 when the source has a long or complex narrative arc). Each act has 2-4 narrative beats. Beats describe WHAT SHOULD HAPPEN narratively, not specific game commands. The player approaches each beat through free-form conversation, exploration, and action.

FULL ARC GROUNDING: When the source material contains a complete narrative (a story with beginning, middle, and end - e.g. a film script, novel, real event), structure your acts to span the source's FULL story arc end-to-end. Act 1 establishes the source's premise and inciting incident. The middle act(s) cover the major complications and rising action. The FINAL act MUST deliver the source's actual climax AND resolution. Completing all acts must deliver the source's actual ending - not a generic conclusion. A player progressing through every beat should re-live the source's entire plot from setup to resolution. Do NOT stop the adventure halfway through the source story.

Beat kinds: story_beat (narrative progression), choice_point (player must decide), climax (high-stakes moment), revelation (truth uncovered), confrontation (direct conflict).

Beat weights: Each beat has a weight (0.0-1.0) reflecting its narrative importance. All weights across the adventure should sum to approximately 1.0.

Timed events: Include 2-5 timed events that create urgency. Use triggerType "time" for clock-based events (triggerTime = hour 0-23, triggerDayOffset = days from start), "turns" for turn-pressure (triggerCount = number of wait/tick events), or "interactions" for interaction-pressure (triggerCount = number of talk/action/move events).

Output JSON only. Ground everything in the source material — use real character names, locations, and plot points from the source.

CRITICAL - no generic filler. Every beat title, narrativeDescription, and evaluationCriteria MUST name specific characters, locations, objects, or events from the source. Actionable people/places must come from the supplied NPC/location ID lists. If a source character or place is not in those lists, treat them as background context and cast the playable clue onto one listed NPC or location instead. NEVER tell the player to find, question, confront, or meet a person/location that is not in the supplied roster. NEVER write generic beats such as "meet the characters", "explore the world", "learn about the setting", "gather information", or "establish the situation". Bad: "Meet the key characters and learn about the world." Good: "Confront Van Helsing at the asylum about Lucy's condition and force him to admit what he suspects." Every evaluationCriteria must name the specific listed people to speak to or the specific listed place/act required so it can be checked objectively against an event log.${timelineFocusInstruction}`,
      user: JSON.stringify({
        world: {
          id: world.id,
          concept: world.concept,
          era: world.era,
          geography: world.geography,
          culture: world.culture,
          timeline: focusTimelineEvents.length ? focusTimelineEvents : world.timeline,
          selectedTimelineEvents: focusTimelineEvents.map(ev => ({
            id: ev.id,
            date: ev.date,
            title: ev.title,
            type: ev.type,
            description: ev.description,
            locationId: ev.locationId,
            affectedNpcIds: ev.affectedNpcIds,
            moodShift: ev.moodShift,
            publicKnowledge: ev.publicKnowledge,
            gossipVersion: ev.gossipVersion,
          })),
          sourceFacts: world.realWorldFacts,
          sourceCorpus: storyArcExcerptText(focusTimelineEvents.length ? `${focusedTimelineCorpus}\n\n${sourceCorpus}` : sourceCorpus, 18_000),
          sourceTerms: sourceTerms.slice(0, 40),
          sourceDocuments: (world.sourceDocuments ?? []).map(doc => ({
            title: doc.title,
            sourceType: doc.sourceType,
            summary: doc.summary,
            digest: doc.digest,
            extractedText: doc.digest ? undefined : storyArcExcerptText(doc.extractedText, 10_000),
          })),
        },
        npcs: (world.npcs ?? []).map(npc => ({
          id: npc.id, name: npc.name, occupation: npc.occupation,
          personality: npc.personality, backstory: npc.backstory,
        })).slice(0, 20),
        locations: (world.locations ?? []).map(loc => ({
          id: loc.id, name: loc.name, description: loc.description,
        })).slice(0, 16),
        requiredShape: {
          title: 'string (max 120 chars)',
          logline: 'string (1-2 sentences, max 200 chars)',
          premise: 'string (full paragraph, max 600 chars)',
          canonicalArc: 'string (the ideal story path, max 800 chars)',
          thematicCore: 'string (central question/theme, max 200 chars)',
          sourceType: 'History|Film|Book|Story|Real Event|LLM',
          acts: [/* 3 to 5 act objects, ordered, covering the full source arc end-to-end */ {
            number: 'integer 1-5',
            title: 'string (max 80 chars)',
            summary: 'string (max 300 chars)',
            beats: [{
              title: 'string (max 100 chars)',
              narrativeDescription: 'what needs to happen narratively (max 400 chars)',
              evaluationCriteria: 'specific observable actions/conversations the LLM should look for (max 400 chars)',
              kind: 'story_beat|choice_point|climax|revelation|confrontation',
              weight: 'number 0.0-1.0',
              npcIds: ['known npc ids, optional'],
              locationIds: ['known location ids, optional'],
            }],
          }],
          timedEvents: [{
            title: 'string',
            description: 'string',
            triggerType: 'time|turns|interactions',
            triggerTime: 'optional hour 0-23',
            triggerDayOffset: 'optional integer days from adventure start',
            triggerCount: 'optional integer count',
            effect: 'escalation|deadline|reveal|environmental',
            narrativeText: 'what happens when this triggers (max 300 chars)',
            scoreImpact: 'optional number -0.1 to 0.1',
          }],
        },
      }),
    });

    const acts = parseActs(raw?.acts, world);
    const timedEvents = parseTimedEvents(raw?.timedEvents);
    const allBeats = acts.flatMap(a => a.beats);
    const involvedNpcIds = Array.from(new Set(allBeats.flatMap(b => b.npcIds ?? [])));
    const involvedLocationIds = Array.from(new Set(allBeats.flatMap(b => b.locationIds ?? [])));

    const adventure: SerializedAdventure = {
      id: `sa-${world.id}-${focusTimelineEvents[0]?.id ? `${focusTimelineEvents[0].id}-` : ''}${Date.now()}-${randomUUID().slice(0, 8)}`,
      worldId: world.id,
      title: String(raw?.title || focusTimelineEvents[0]?.title || fallback.title).slice(0, 120),
      status: 'available',
      sourceType: ['History', 'Film', 'Book', 'Story', 'Real Event', 'LLM'].includes(String(raw?.sourceType)) ? raw.sourceType : fallback.sourceType,
      logline: String(raw?.logline || fallback.logline).slice(0, 200),
      premise: String(raw?.premise || fallback.premise).slice(0, 600),
      canonicalArc: String(raw?.canonicalArc || fallback.canonicalArc).slice(0, 800),
      thematicCore: String(raw?.thematicCore || fallback.thematicCore).slice(0, 200),
      acts,
      timedEvents,
      involvedNpcIds: involvedNpcIds.length ? involvedNpcIds : fallback.involvedNpcIds,
      involvedLocationIds: involvedLocationIds.length ? involvedLocationIds : fallback.involvedLocationIds,
      spectrumScore: 0,
      scoreBreakdown: [],
      createdAt: new Date().toISOString(),
      sourceTimelineEventIds: focusTimelineEvents.map(ev => ev.id).filter(Boolean),
      turnCounter: 0,
      interactionCounter: 0,
    };

    const validated = validateSerializedAdventure(adventure, world);
    return validated.ok ? adventure : validated.repaired;
  } catch (err) {
    console.warn('[serialized-adventure] generation failed:', err);
    fallback.sourceTimelineEventIds = focusTimelineEvents.map(ev => ev.id).filter(Boolean);
    return fallback;
  }
}

function parseActs(rawActs: any, world: WorldDNA): SerializedAct[] {
  if (!Array.isArray(rawActs) || rawActs.length < 2) return fallbackSerializedAdventure(world).acts;

  const npcIds = new Set((world.npcs ?? []).map(n => n.id));
  const locIds = new Set((world.locations ?? []).map(l => l.id));

  return rawActs.slice(0, 5).map((rawAct: any, actIdx: number) => {
    const actId = `act-${actIdx + 1}`;
    const rawBeats = Array.isArray(rawAct?.beats) ? rawAct.beats.slice(0, 4) : [];
    const beats: SerializedBeat[] = rawBeats.map((rawBeat: any, beatIdx: number) => ({
      id: `${actId}-beat-${beatIdx + 1}`,
      actId,
      title: String(rawBeat?.title || `Beat ${beatIdx + 1}`).slice(0, 100),
      narrativeDescription: String(rawBeat?.narrativeDescription || 'Progress the story.').slice(0, 400),
      evaluationCriteria: String(rawBeat?.evaluationCriteria || 'Player takes action relevant to the story.').slice(0, 400),
      kind: ['story_beat', 'choice_point', 'climax', 'revelation', 'confrontation'].includes(rawBeat?.kind) ? rawBeat.kind : 'story_beat',
      status: actIdx === 0 && beatIdx === 0 ? 'active' as const : 'locked' as const,
      npcIds: Array.isArray(rawBeat?.npcIds) ? rawBeat.npcIds.filter((id: string) => npcIds.has(id)) : [],
      locationIds: Array.isArray(rawBeat?.locationIds) ? rawBeat.locationIds.filter((id: string) => locIds.has(id)) : [],
      weight: typeof rawBeat?.weight === 'number' ? Math.max(0.01, Math.min(0.5, rawBeat.weight)) : 0.1,
    }));

    if (beats.length < 2) {
      while (beats.length < 2) {
        beats.push({
          id: `${actId}-beat-${beats.length + 1}`,
          actId,
          title: `Story progression ${beats.length + 1}`,
          narrativeDescription: 'Continue engaging with the world and its characters.',
          evaluationCriteria: 'Player interacts meaningfully with NPCs or explores locations.',
          kind: 'story_beat',
          status: 'locked',
          weight: 0.08,
        });
      }
    }

    return {
      id: actId,
      number: actIdx + 1,
      title: String(rawAct?.title || `Act ${actIdx + 1}`).slice(0, 80),
      summary: String(rawAct?.summary || `The story continues.`).slice(0, 300),
      status: actIdx === 0 ? 'active' as const : 'locked' as const,
      beats,
    };
  });
}

function parseTimedEvents(rawEvents: any): SerializedTimedEvent[] {
  if (!Array.isArray(rawEvents)) return [];
  return rawEvents.slice(0, 5).map((raw: any, idx: number) => ({
    id: `timed-${idx + 1}`,
    title: String(raw?.title || `Event ${idx + 1}`).slice(0, 100),
    description: String(raw?.description || '').slice(0, 300),
    triggerType: ['time', 'turns', 'interactions'].includes(raw?.triggerType) ? raw.triggerType : 'interactions',
    triggerTime: typeof raw?.triggerTime === 'number' ? Math.max(0, Math.min(23, Math.floor(raw.triggerTime))) : undefined,
    triggerDate: typeof raw?.triggerDate === 'string' ? raw.triggerDate : undefined,
    triggerDayOffset: typeof raw?.triggerDayOffset === 'number' ? Math.max(0, Math.floor(raw.triggerDayOffset)) : undefined,
    triggerCount: typeof raw?.triggerCount === 'number' ? Math.max(1, Math.floor(raw.triggerCount)) : undefined,
    effect: ['escalation', 'deadline', 'reveal', 'environmental'].includes(raw?.effect) ? raw.effect : 'escalation',
    narrativeText: String(raw?.narrativeText || 'Something shifts in the world.').slice(0, 300),
    scoreImpact: typeof raw?.scoreImpact === 'number' ? Math.max(-0.1, Math.min(0.1, raw.scoreImpact)) : undefined,
    status: 'pending' as const,
    unlocksActId: typeof raw?.unlocksActId === 'string' ? raw.unlocksActId : undefined,
    unlocksBeatId: typeof raw?.unlocksBeatId === 'string' ? raw.unlocksBeatId : undefined,
  }));
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateSerializedAdventure(adventure: SerializedAdventure, world: WorldDNA): { ok: boolean; repaired: SerializedAdventure } {
  const issues: string[] = [];
  const repaired = JSON.parse(JSON.stringify(adventure)) as SerializedAdventure;

  if (repaired.acts.length < 2) {
    issues.push(`Only ${repaired.acts.length} acts, need at least 2`);
    const fb = fallbackSerializedAdventure(world);
    repaired.acts = fb.acts;
  }

  const allBeats = repaired.acts.flatMap(a => a.beats);
  if (allBeats.length < 4) {
    issues.push(`Only ${allBeats.length} beats total, need at least 4`);
  }

  const totalWeight = allBeats.reduce((s, b) => s + b.weight, 0);
  if (totalWeight < 0.5 || totalWeight > 1.5) {
    const factor = 1 / totalWeight;
    for (const beat of allBeats) beat.weight = Math.round(beat.weight * factor * 1000) / 1000;
    issues.push(`Weights summed to ${totalWeight.toFixed(2)}, normalized to 1.0`);
  }

  // Ensure first act is active and first beat within it is active
  if (repaired.acts[0]) {
    repaired.acts[0].status = 'active';
    if (repaired.acts[0].beats[0]) repaired.acts[0].beats[0].status = 'active';
  }
  for (let i = 1; i < repaired.acts.length; i++) repaired.acts[i].status = 'locked';

  if (issues.length) repaired.title = repaired.title || `Adventure: ${world.concept}`;
  return { ok: issues.length === 0, repaired };
}

function fallbackSerializedAdventure(world: WorldDNA): SerializedAdventure {
  const npcs = (world.npcs ?? []).slice(0, 6);
  const locs = (world.locations ?? []).slice(0, 4);

  const acts: SerializedAct[] = [
    {
      id: 'act-1', number: 1, title: 'The Beginning', summary: 'Discover the world and its inhabitants.',
      status: 'active',
      beats: [
        { id: 'act-1-beat-1', actId: 'act-1', title: 'First Contact', narrativeDescription: 'Meet the key characters and learn about the world.', evaluationCriteria: 'Player has spoken to at least one major NPC and visited a key location.', kind: 'story_beat', status: 'active', weight: 0.15, npcIds: npcs.slice(0, 2).map(n => n.id), locationIds: locs.slice(0, 1).map(l => l.id) },
        { id: 'act-1-beat-2', actId: 'act-1', title: 'The Hook', narrativeDescription: 'Uncover the central conflict or mystery.', evaluationCriteria: 'Player has learned about the main conflict through conversation or exploration.', kind: 'revelation', status: 'locked', weight: 0.15, npcIds: npcs.slice(1, 3).map(n => n.id), locationIds: locs.slice(0, 2).map(l => l.id) },
      ],
    },
    {
      id: 'act-2', number: 2, title: 'The Struggle', summary: 'Face the challenges and make crucial decisions.',
      status: 'locked',
      beats: [
        { id: 'act-2-beat-1', actId: 'act-2', title: 'Rising Tension', narrativeDescription: 'The situation intensifies and allies are tested.', evaluationCriteria: 'Player has navigated a difficult situation or confrontation.', kind: 'confrontation', status: 'locked', weight: 0.2, npcIds: npcs.slice(2, 4).map(n => n.id), locationIds: locs.slice(1, 3).map(l => l.id) },
        { id: 'act-2-beat-2', actId: 'act-2', title: 'The Choice', narrativeDescription: 'A pivotal decision that shapes the outcome.', evaluationCriteria: 'Player has made a significant choice affecting the story direction.', kind: 'choice_point', status: 'locked', weight: 0.2, npcIds: npcs.slice(0, 3).map(n => n.id) },
      ],
    },
    {
      id: 'act-3', number: 3, title: 'The Resolution', summary: 'Bring the story to its conclusion.',
      status: 'locked',
      beats: [
        { id: 'act-3-beat-1', actId: 'act-3', title: 'The Climax', narrativeDescription: 'The final confrontation or culminating moment.', evaluationCriteria: 'Player faces the central challenge head-on.', kind: 'climax', status: 'locked', weight: 0.2, npcIds: npcs.slice(0, 4).map(n => n.id), locationIds: locs.slice(0, 2).map(l => l.id) },
        { id: 'act-3-beat-2', actId: 'act-3', title: 'Aftermath', narrativeDescription: 'The consequences of your journey become clear.', evaluationCriteria: 'Player has seen the results of their actions reflected in the world.', kind: 'story_beat', status: 'locked', weight: 0.1, npcIds: npcs.slice(0, 2).map(n => n.id) },
      ],
    },
  ];

  return {
    id: `sa-${world.id}-${Date.now()}`,
    worldId: world.id,
    title: `Adventure: ${world.concept}`,
    status: 'available',
    sourceType: 'LLM',
    logline: `An adventure set in ${world.concept}.`,
    premise: `Explore the world of ${world.concept} and shape its story through your choices.`,
    canonicalArc: `Begin by discovering the world, face its central conflict, and determine the outcome.`,
    thematicCore: `What will you make of this world?`,
    acts,
    timedEvents: [],
    involvedNpcIds: npcs.map(n => n.id),
    involvedLocationIds: locs.map(l => l.id),
    spectrumScore: 0,
    scoreBreakdown: [],
    createdAt: new Date().toISOString(),
    turnCounter: 0,
    interactionCounter: 0,
  };
}

// ── Beat evaluation ─────────────────────────────────────────────────────────

export function getActiveBeat(adventure: SerializedAdventure): SerializedBeat | undefined {
  const activeAct = adventure.acts.find(a => a.status === 'active');
  if (!activeAct) return undefined;
  return activeAct.beats.find(b => b.status === 'active');
}

// Fuzzy keyword matching: see src/fuzzyMatch.ts. Tolerates partial words,
// misspellings, plurals and word-stems so a player typing 'tunnels' or 'amlet'
// can still trigger the same beat as the keyword 'tunnel' or 'amulet'.
function saKeywords(text: string | undefined): Set<string> {
  return new Set(keywordStems(text));
}
function saOverlap(text: string | undefined, keys: Set<string>): number {
  if (!text || keys.size === 0) return 0;
  return fuzzyOverlapCount(text, keys);
}

export function shouldEvaluateBeat(adventure: SerializedAdventure, eventKind: string, eventNpcId?: string, eventLocationId?: string, eventSummary?: string): boolean {
  const beat = getActiveBeat(adventure);
  if (!beat) return false;

  if (eventNpcId && beat.npcIds?.includes(eventNpcId)) return true;
  if (eventLocationId && beat.locationIds?.includes(eventLocationId)) return true;

  const beatKeys = new Set<string>([...saKeywords(beat.evaluationCriteria), ...saKeywords(beat.narrativeDescription), ...saKeywords(beat.title)]);
  if (saOverlap(eventSummary, beatKeys) >= 2) return true;

  const since = adventure.interactionCounter - (beat.activatedAtInteraction ?? 0);
  if (since >= 6 && adventure.interactionCounter % 3 === 0) return true;

  if (adventure.interactionCounter > 0 && adventure.interactionCounter % 4 === 0) return true;

  return false;
}

export async function evaluateSerializedBeat(
  adventure: SerializedAdventure,
  beat: SerializedBeat,
  session: WorldSession,
  world: WorldDNA,
  provider?: string,
  model?: string,
): Promise<SerializedBeatEvaluation> {
  const recentEvents = (session.objectiveEvents ?? []).slice(-50);
  const involvedNpcConversations = extractRelevantConversations(session, world, beat.npcIds ?? []);

  try {
    const raw = await llmJSON<any>({
      provider: provider || world.provider,
      model,
      temperature: 0.4,
      maxTokens: 1024,
      system: `You are evaluating whether a player's actions in a life simulator match a narrative story beat. You have access to the objective event log (what actually happened) and conversation records. Evaluate ONLY based on what happened, not what should have happened. Be fair but narratively generous — a player who achieves the spirit of the beat through unexpected means should score well. A quality of 0.0 means the player did nothing relevant, 1.0 means they perfectly achieved the beat's intent. Output JSON only.`,
      user: JSON.stringify({
        beat: {
          title: beat.title,
          narrativeDescription: beat.narrativeDescription,
          evaluationCriteria: beat.evaluationCriteria,
          kind: beat.kind,
        },
        adventureContext: {
          title: adventure.title,
          canonicalArc: adventure.canonicalArc,
          thematicCore: adventure.thematicCore,
          currentAct: adventure.acts.find(a => a.status === 'active')?.title,
        },
        recentEvents: recentEvents.map(ev => ({
          type: ev.type,
          summary: ev.summary,
          detail: ev.detail,
          timeOfDay: ev.timeOfDay,
          tags: ev.tags,
        })),
        recentConversations: involvedNpcConversations.slice(0, 20),
        worldState: {
          time: session.currentTime,
          date: session.currentDate,
          location: session.currentLocationId,
          weather: session.currentWeather?.condition,
        },
        requiredShape: {
          matched: 'boolean',
          confidence: 'number 0.0-1.0',
          quality: 'number 0.0-1.0',
          summary: 'string (what the player actually did, max 300 chars)',
          narrativeBridge: 'string (how this connects to the next story beat, max 200 chars)',
        },
      }),
    });

    return {
      matched: !!raw?.matched,
      confidence: clampNum(raw?.confidence, 0, 1, 0.5),
      quality: clampNum(raw?.quality, 0, 1, 0),
      scoreContribution: beat.weight * clampNum(raw?.quality, 0, 1, 0),
      summary: String(raw?.summary || 'The player took action.').slice(0, 300),
      narrativeBridge: String(raw?.narrativeBridge || 'The story continues.').slice(0, 200),
      evaluatedAt: new Date().toISOString(),
      relevantEventIds: recentEvents.slice(-10).map(ev => ev.id),
    };
  } catch (err) {
    console.warn('[serialized-adventure] beat evaluation failed:', err);
    return {
      matched: false,
      confidence: 0.3,
      quality: 0.2,
      scoreContribution: beat.weight * 0.2,
      summary: 'Evaluation could not be completed; partial credit awarded.',
      narrativeBridge: 'The story continues despite uncertainty.',
      evaluatedAt: new Date().toISOString(),
      relevantEventIds: [],
    };
  }
}

function extractRelevantConversations(session: WorldSession, world: WorldDNA, npcIds: string[]): Array<{ npcId: string; npcName: string; exchanges: string[] }> {
  const results: Array<{ npcId: string; npcName: string; exchanges: string[] }> = [];
  for (const npcId of npcIds) {
    const state: any = session.npcStates[npcId];
    if (!state) continue;
    const npcName = world.npcs?.find(n => n.id === npcId)?.name ?? npcId;
    const rawHist = state.conversationHistory ?? state.dialogueHistory ?? state.history ?? state.exchanges ?? [];
    const history: any[] = Array.isArray(rawHist) ? rawHist : [];
    const recent = history.slice(-6).map((entry: any) => {
      if (typeof entry === 'string') return entry;
      if (!entry || typeof entry !== 'object') return String(entry);
      if (entry.player !== undefined && entry.npc !== undefined) return `player: ${entry.player} | ${npcName}: ${entry.npc}`;
      const speaker = entry.speaker ?? entry.role ?? entry.from ?? 'unknown';
      const text = entry.text ?? entry.message ?? entry.content ?? entry.q ?? entry.a ?? entry.reply ?? '';
      return `${speaker}: ${typeof text === 'string' ? text : JSON.stringify(text)}`;
    });
    if (recent.length) results.push({ npcId, npcName, exchanges: recent });
  }
  return results;
}

// ── Timed event processing ──────────────────────────────────────────────────

export function processSerializedTimedEvents(
  adventure: SerializedAdventure,
  session: WorldSession,
): SerializedTimedEvent[] {
  const triggered: SerializedTimedEvent[] = [];
  const startDate = adventure.startedAt ? new Date(adventure.startedAt) : new Date();

  for (const event of adventure.timedEvents) {
    if (event.status !== 'pending') continue;

    let shouldTrigger = false;

    if (event.triggerType === 'time') {
      const timeMatch = event.triggerTime === undefined || session.currentTime >= event.triggerTime;
      if (event.triggerDayOffset !== undefined) {
        const currentDate = new Date(session.currentDate);
        const daysSinceStart = Math.floor((currentDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
        shouldTrigger = daysSinceStart >= event.triggerDayOffset && timeMatch;
      } else {
        shouldTrigger = timeMatch;
      }
    } else if (event.triggerType === 'turns') {
      shouldTrigger = event.triggerCount !== undefined && adventure.turnCounter >= event.triggerCount;
    } else if (event.triggerType === 'interactions') {
      shouldTrigger = event.triggerCount !== undefined && adventure.interactionCounter >= event.triggerCount;
    }

    if (shouldTrigger) {
      event.status = 'triggered';
      event.triggeredAt = new Date().toISOString();
      triggered.push(event);

      if (event.scoreImpact) {
        adventure.spectrumScore = Math.max(0, Math.min(1, adventure.spectrumScore + event.scoreImpact));
      }

      if (event.unlocksActId) {
        const act = adventure.acts.find(a => a.id === event.unlocksActId);
        if (act && act.status === 'locked') {
          act.status = 'active';
          const firstBeat = act.beats.find(b => b.status === 'locked');
          if (firstBeat) firstBeat.status = 'active';
        }
      }

      if (event.unlocksBeatId) {
        for (const act of adventure.acts) {
          const beat = act.beats.find(b => b.id === event.unlocksBeatId);
          if (beat && beat.status === 'locked') { beat.status = 'active'; break; }
        }
      }
    }
  }

  return triggered;
}

// ── Act advancement ─────────────────────────────────────────────────────────

export function advanceSerializedAct(adventure: SerializedAdventure): { actCompleted?: SerializedAct; adventureComplete: boolean } {
  const activeAct = adventure.acts.find(a => a.status === 'active');
  if (!activeAct) return { adventureComplete: false };

  const allDone = activeAct.beats.every(b => b.status === 'completed' || b.status === 'missed');
  if (!allDone) {
    const currentBeat = activeAct.beats.find(b => b.status === 'active');
    if (!currentBeat) {
      const nextLocked = activeAct.beats.find(b => b.status === 'locked');
      if (nextLocked) { nextLocked.status = 'active'; nextLocked.activatedAtInteraction = adventure.interactionCounter; }
    }
    return { adventureComplete: false };
  }

  activeAct.status = 'completed';
  activeAct.completedAt = new Date().toISOString();

  const nextAct = adventure.acts.find(a => a.status === 'locked');
  if (nextAct) {
    nextAct.status = 'active';
    const firstBeat = nextAct.beats.find(b => b.status === 'locked');
    if (firstBeat) { firstBeat.status = 'active'; firstBeat.activatedAtInteraction = adventure.interactionCounter; }
    return { actCompleted: activeAct, adventureComplete: false };
  }

  return { actCompleted: activeAct, adventureComplete: true };
}

// ── Completion & epilogue ───────────────────────────────────────────────────

export async function completeSerializedAdventure(
  session: WorldSession,
  adventure: SerializedAdventure,
  world: WorldDNA,
  provider?: string,
  model?: string,
): Promise<SerializedAdventureResult> {
  const finalScore = calculateSpectrumScore(adventure);
  adventure.spectrumScore = finalScore;
  const tier = spectrumTierLabel(finalScore);

  const beatSummaries = adventure.acts.flatMap(act =>
    act.beats.filter(b => b.evaluation).map(b => ({
      act: act.title,
      beat: b.title,
      quality: b.evaluation!.quality,
      summary: b.evaluation!.summary,
    }))
  );

  let epilogue: string;
  try {
    const raw = await llmJSON<any>({
      provider: provider || world.provider,
      model,
      temperature: 0.85,
      maxTokens: 2048,
      system: `Write a cinematic epilogue for a completed adventure in a life simulator. The player scored ${finalScore.toFixed(2)} on a spectrum where 1.0 is the ideal canonical ending (${tier} tier). Write a rich, emotionally resonant conclusion (200-400 words) that reflects what ACTUALLY happened based on the beat summaries, not what should have happened. If the score is low, the ending should feel tragic or bittersweet. If high, triumphant or deeply satisfying. Reference specific things the player did. Output JSON with a single "epilogue" field.`,
      user: JSON.stringify({
        adventure: { title: adventure.title, canonicalArc: adventure.canonicalArc, thematicCore: adventure.thematicCore },
        score: finalScore,
        tier,
        beatSummaries,
        worldConcept: world.concept,
      }),
    });
    epilogue = String(raw?.epilogue || `The adventure concludes. Your journey through ${world.concept} earned a ${tier} outcome.`);
  } catch {
    epilogue = `The adventure concludes. Your journey through ${world.concept} earned a ${tier} outcome with a score of ${Math.round(finalScore * 100)}%.`;
  }

  adventure.status = 'completed';
  adventure.completedAt = new Date().toISOString();
  adventure.epilogue = epilogue;

  const now = new Date().toISOString();
  const medal: QuestMedal = {
    id: `sa-medal:${adventure.id}`,
    name: adventure.medalName || `${adventure.title} — ${tier}`,
    tier: finalScore >= 0.7 ? 'Major' : finalScore >= 0.5 ? 'Standard' : 'Minor',
    questType: 'existential',
    questId: adventure.id,
    earnedAt: now,
  };
  const achievement: QuestAchievement = {
    id: adventure.achievementId || `sa-ach:${adventure.id}`,
    name: `${adventure.title} (${tier})`,
    description: `Completed with a spectrum score of ${Math.round(finalScore * 100)}%`,
    questId: adventure.id,
    earnedAt: now,
  };

  session.medals = mergeByIdLocal(session.medals, [medal]);
  session.serializedAdventureMedals = mergeByIdLocal(session.serializedAdventureMedals, [medal]);
  session.achievements = mergeByIdLocal(session.achievements, [achievement]);

  const result: SerializedAdventureResult = {
    adventureId: adventure.id,
    worldId: adventure.worldId,
    title: adventure.title,
    spectrumScore: finalScore,
    tierLabel: tier,
    epilogue,
    scoreBreakdown: adventure.scoreBreakdown,
    medal,
    achievement,
    completedAt: now,
  };

  if (!session.completedSerializedAdventures) session.completedSerializedAdventures = [];
  session.completedSerializedAdventures.push(result);
  session.activeSerializedAdventure = undefined;

  session.significantEvents.push(`Completed Serialized Adventure: ${adventure.title} — ${tier} (${Math.round(finalScore * 100)}%)`);

  // Adventurer progression: huge XP burst for completing an adventure, plus a check
  // for any milestone medals newly unlocked by this completion (count-based ones like
  // Mythkeeper at 10 adventures will fire here).
  awardAdventureCompletionXp(session, finalScore);
  checkMilestoneMedals(session);

  return result;
}

// ── Main integration hook ───────────────────────────────────────────────────

export interface SerializedAdventureUpdate {
  triggered?: SerializedTimedEvent[];
  completedBeat?: SerializedBeat;
  missedBeat?: SerializedBeat;
  actCompleted?: SerializedAct;
  adventureComplete?: boolean;
  result?: SerializedAdventureResult;
  spectrumScore: number;
  activeBeatHint?: string;
  narration?: string[];
}

export async function advanceSerializedAdventure(
  session: WorldSession,
  world: WorldDNA,
  event: { kind: 'dialogue' | 'action' | 'movement' | 'wait' | 'tick'; npcId?: string; locationId?: string; summary?: string },
  provider?: string,
  model?: string,
): Promise<SerializedAdventureUpdate | undefined> {
  const adventure = session.activeSerializedAdventure;
  if (!adventure || adventure.status !== 'active') return undefined;

  if (event.kind === 'dialogue' || event.kind === 'action' || event.kind === 'movement') {
    adventure.interactionCounter++;
  }
  if (event.kind === 'wait' || event.kind === 'tick') {
    adventure.turnCounter++;
  }

  const narration: string[] = [];
  const triggered = processSerializedTimedEvents(adventure, session);
  for (const ev of triggered) {
    narration.push(`\u23f3 ${ev.title}${ev.narrativeText ? ' \u2014 ' + ev.narrativeText : ''}`);
  }

  const shouldEval = shouldEvaluateBeat(adventure, event.kind, event.npcId, event.locationId, event.summary);
  let completedBeat: SerializedBeat | undefined;
  let missedBeat: SerializedBeat | undefined;

  if (shouldEval) {
    const beat = getActiveBeat(adventure);
    if (beat) {
      const evaluation = await evaluateSerializedBeat(adventure, beat, session, world, provider, model);
      beat.evaluation = evaluation;

      if (evaluation.matched && evaluation.quality >= 0.3) {
        beat.status = 'completed';
        beat.completedAt = new Date().toISOString();
        completedBeat = beat;

        adventure.scoreBreakdown.push({
          beatId: beat.id,
          beatTitle: beat.title,
          score: evaluation.scoreContribution,
          maxScore: beat.weight,
          reason: evaluation.summary,
          timestamp: new Date().toISOString(),
        });

        adventure.spectrumScore = calculateSpectrumScore(adventure);

        // Adventurer progression: grant XP, then check for new milestone medals.
        // If the player ranks up, surface a celebratory narration line.
        const xpResult = awardBeatXp(session, beat, evaluation.quality, adventure);
        adventure.beatXpAwarded = (adventure.beatXpAwarded ?? 0) + xpResult.xpAwarded;
        const milestone = checkMilestoneMedals(session, world);
        if (milestone.bonusXp > 0) adventure.beatXpAwarded = (adventure.beatXpAwarded ?? 0) + milestone.bonusXp;
        narration.push(`\u2726 ${evaluation.summary}`);
        narration.push(`\u2728 +${xpResult.xpAwarded} XP - ${xpResult.newRank.rank} (${xpResult.newRank.xp}/${xpResult.newRank.nextRankXp})`);
        if (xpResult.rankedUp) {
          narration.push(`\u2605 RANK UP! You are now ${xpResult.newRank.rank} - ${xpResult.newRank.title}.`);
        }
        for (const m of milestone.newMedals) {
          narration.push(`\u2691 New medal: ${m.name} (${m.tier})`);
        }
        if (milestone.bonusXp > 0) {
          narration.push(`\u2606 +${milestone.bonusXp} bonus XP from milestones`);
        }
        if (evaluation.narrativeBridge) narration.push(`\u2192 ${evaluation.narrativeBridge}`);
      }
    }
  }

  if (!completedBeat) {
    const stuck = getActiveBeat(adventure);
    if (stuck) {
      const since = adventure.interactionCounter - (stuck.activatedAtInteraction ?? 0);
      const deadlineHit = triggered.some(ev => ev.effect === 'deadline');
      if (since >= 16 || (deadlineHit && since >= 6)) {
        stuck.status = 'missed';
        stuck.completedAt = new Date().toISOString();
        stuck.missedReason = deadlineHit ? 'A deadline passed before this moment could resolve.' : 'The player moved on without resolving this beat.';
        missedBeat = stuck;
        adventure.scoreBreakdown.push({
          beatId: stuck.id,
          beatTitle: stuck.title,
          score: 0,
          maxScore: stuck.weight,
          reason: stuck.missedReason,
          timestamp: new Date().toISOString(),
        });
        adventure.spectrumScore = calculateSpectrumScore(adventure);
        narration.push(`\u2727 The moment passed \u2014 "${stuck.title}" went unfulfilled. ${stuck.missedReason}`);
      }
    }
  }

  const { actCompleted, adventureComplete } = (completedBeat || missedBeat) ? advanceSerializedAct(adventure) : { actCompleted: undefined as SerializedAct | undefined, adventureComplete: false };

  if (actCompleted && !adventureComplete) {
    const nextAct = adventure.acts.find(a => a.status === 'active');
    narration.push(`\u2501\u2501 Act complete: ${actCompleted.title} \u2501\u2501`);
    if (nextAct) narration.push(`\u25b8 ${nextAct.title}${nextAct.summary ? ' \u2014 ' + nextAct.summary : ''}`);
  }

  let result: SerializedAdventureResult | undefined;
  if (adventureComplete) {
    result = await completeSerializedAdventure(session, adventure, world, provider, model);
    narration.push(`\u2605 Adventure complete \u2014 ${result.tierLabel} (${Math.round(result.spectrumScore * 100)}%)`);
    if (result.epilogue) narration.push(result.epilogue);
  }

  const activeBeat = getActiveBeat(adventure);
  if (activeBeat && (completedBeat || missedBeat || actCompleted) && !adventureComplete) {
    narration.push(`\u2756 Now: ${activeBeat.narrativeDescription}`);
  }

  return {
    triggered: triggered.length ? triggered : undefined,
    completedBeat,
    missedBeat,
    actCompleted,
    adventureComplete,
    result,
    spectrumScore: adventure.spectrumScore,
    activeBeatHint: activeBeat ? activeBeat.narrativeDescription : undefined,
    narration: narration.length ? narration : undefined,
  };
}

// ── Start / abandon ─────────────────────────────────────────────────────────

export function startSerializedAdventure(session: WorldSession, adventure: SerializedAdventure): void {
  // Full clean reset: safe no-op for a fresh adventure, true blank slate for a replay.
  adventure.status = 'active';
  adventure.startedAt = new Date().toISOString();
  adventure.completedAt = undefined;
  adventure.epilogue = undefined;
  adventure.sessionId = session.id;
  adventure.turnCounter = 0;
  adventure.interactionCounter = 0;
  adventure.spectrumScore = 0;
  adventure.scoreBreakdown = [];
  adventure.beatXpAwarded = 0;

  adventure.acts.forEach((act, ai) => {
    act.status = ai === 0 ? 'active' : 'locked';
    act.completedAt = undefined;
    act.beats.forEach((beat, bi) => {
      beat.status = (ai === 0 && bi === 0) ? 'active' : 'locked';
      beat.evaluation = undefined;
      beat.completedAt = undefined;
      beat.missedReason = undefined;
      beat.activatedAtInteraction = (ai === 0 && bi === 0) ? 0 : undefined;
    });
  });

  (adventure.timedEvents ?? []).forEach(ev => {
    ev.status = 'pending';
    ev.triggeredAt = undefined;
  });

  session.activeSerializedAdventure = adventure;
}

export function abandonSerializedAdventure(session: WorldSession): SerializedAdventure | undefined {
  const adventure = session.activeSerializedAdventure;
  if (!adventure) return undefined;
  adventure.status = 'abandoned';
  adventure.completedAt = new Date().toISOString();
  const revokeXp = adventure.beatXpAwarded ?? 0;
  if (revokeXp > 0) {
    session.adventurerXp = Math.max(0, (session.adventurerXp ?? 0) - revokeXp);
  }
  session.activeSerializedAdventure = undefined;
  session.significantEvents.push(`Abandoned Serialized Adventure: ${adventure.title}`);
  return adventure;
}

export function hasActiveSerializedAdventure(session: WorldSession): boolean {
  return session.activeSerializedAdventure?.status === 'active';
}

// ── Utilities ───────────────────────────────────────────────────────────────

function clampNum(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function mergeByIdLocal<T extends { id: string }>(existing: T[] | undefined, incoming: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of existing ?? []) merged.set(item.id, item);
  for (const item of incoming) merged.set(item.id, item);
  return Array.from(merged.values());
}
