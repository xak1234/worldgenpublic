/**
 * Narrative Engine
 * Generates atmospheric text when the player moves, waits, or time passes.
 * Uses the world's narrative style and sensory palette.
 */

import { llmText } from './llm.js';
import type { WorldDNA, NPCLiveState } from './types.js';

export interface NarrativeRequest {
  world: WorldDNA;
  playerName: string;
  playerOccupation: string;
  playerAppearance?: string;
  locationId: string;
  previousLocationId?: string;
  currentDate: string;
  timeOfDay: string;
  action: string;              // "arrived", "waited", "woke up", "entered"
  weather?: string;
  npcsPresent: { name: string; activity: string; relationship: string }[];
  playerNeeds?: { hunger: number; warmth: number; rest: number };
  recentEvent?: string;
  provider: string;
  model?: string;
}

export async function generateNarrative(req: NarrativeRequest): Promise<string> {
  const {
    world, playerName, playerOccupation, playerAppearance, locationId, previousLocationId,
    currentDate, timeOfDay, action, weather, npcsPresent, playerNeeds,
    recentEvent, provider, model,
  } = req;

  const location = world.locations.find(l => l.id === locationId);
  if (!location) return `You find yourself somewhere unfamiliar.`;

  const prevLocation = previousLocationId
    ? world.locations.find(l => l.id === previousLocationId)
    : null;

  const style = world.narrativeStyle ?? {} as Partial<typeof world.narrativeStyle>;
  const npcLines = npcsPresent.length > 0
    ? npcsPresent.map(n => `${n.name} is here, ${n.activity}. Your relationship: ${n.relationship}.`).join('\n')
    : 'Nobody else is around.';

  const needsLine = playerNeeds
    ? `Player physical state: hunger ${playerNeeds.hunger}/100, warmth ${playerNeeds.warmth}/100, rest ${playerNeeds.rest}/100.${playerNeeds.hunger < 30 ? ' They are hungry.' : ''}${playerNeeds.warmth < 30 ? ' They are cold.' : ''}${playerNeeds.rest < 20 ? ' They are exhausted.' : ''}`
    : '';

  const system = `You are a literary narrator for a life simulation set in ${world.geography.region}, ${world.era.period}.

VOICE: ${style.voice ?? 'evocative and grounded'}
TENSE: ${style.tense ?? 'second'} person
TONE: ${(style.toneKeywords ?? []).join(', ')}
INFLUENCES: ${(style.literaryInfluences ?? []).join(', ')}
SENSORY PALETTE: ${(style.sensoryPalette ?? []).join(', ')}
FORBIDDEN WORDS (never use): ${(style.forbiddenWords ?? []).join(', ')}

EXAMPLE OF YOUR VOICE:
${style.sampleParagraph ?? ''}

Rules:
- Write 2-3 short paragraphs. Terse, evocative, grounded.
- Focus on sensory detail specific to THIS location and THIS time of day.
- If NPCs are present, weave them in naturally — what they're doing, how they react to the player's arrival.
- If the action says the player vanished or appeared, treat it as visibly uncanny and let nearby people notice without over-explaining it.
- If the player is hungry/cold/tired, let it show through physical sensation, not stats.
- If a community event recently happened, let it hang in the air.
- Never use game vocabulary. No stats, menus, health bars. Stay inside the world.
- Do not summarise — dramatise the present moment.
- The dialect and vocabulary must match: ${world.culture?.dialect ?? 'natural'}
${world.displayLanguage ? `- LANGUAGE REQUIREMENT: Write ALL narration in ${world.displayLanguage}. You may use occasional local words for flavor, but the text must be readable in ${world.displayLanguage}.` : ''}`;

  const user = `Player: ${playerName}, ${playerOccupation}${playerAppearance ? `, ${playerAppearance}` : ''}
Action: ${action}
Location: ${location.name} (${location.type}) — ${location.description}
Ambient: ${location.ambientDetail}
${prevLocation ? `Coming from: ${prevLocation.name}` : 'Starting here.'}
Time: ${timeOfDay}, ${currentDate}
Weather: ${weather ?? world.weather.dominantWeather}
People present:
${npcLines}
${needsLine}
${recentEvent ? `Recent community event: ${recentEvent}` : ''}

Write the narrative now.`;

  try {
    return await llmText({
      system,
      user,
      maxTokens: 320,
      temperature: 0.85,
      provider,
      model,
    });
  } catch (err) {
    console.error('[narrative]', err);
    return buildFallbackNarrative(location, timeOfDay, action);
  }
}

function buildFallbackNarrative(
  location: { name: string; ambientDetail: string },
  timeOfDay: string,
  action: string,
): string {
  return `You ${action} at ${location.name}. ${location.ambientDetail} The ${timeOfDay.toLowerCase()} settles around you, ordinary and unremarkable, the world going about its business whether you are here or not.`;
}
