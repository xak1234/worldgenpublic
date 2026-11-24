import type {
  InteractionKind,
  NPCInteractionInterpretation,
  NPCLiveState,
  PerceivedIntent,
  PlayerInteraction,
  PlayerIntent,
  WorldNPC,
} from './types.js';
import { INTENT_PROFILES } from './types.js';

const PLAYER_INTENTS: PlayerIntent[] = [
  'say',
  'ask',
  'listen',
  'stay_silent',
  'comfort',
  'apologise',
  'confront',
  'reassure',
  'make_promise',
  'share_personal',
  'set_boundary',
  'leave',
];

const INTERACTION_KINDS: InteractionKind[] = ['speech', 'gesture', 'silence', 'presence', 'action'];

export interface ParsedPlayerInteraction {
  interaction?: PlayerInteraction;
  error?: string;
}

export interface InterpretationContext {
  defensePressure?: number;
  activeWounds?: string[];
}

export function shouldApplyPlayerIntentInterpretation(
  backendAllows: boolean,
  clientRequested: unknown,
): boolean {
  return backendAllows === true && clientRequested === true;
}

export function parsePlayerInteractionRequest(body: any): ParsedPlayerInteraction {
  const npcId = typeof body?.npcId === 'string' ? body.npcId : '';
  const messageValue = typeof body?.message === 'string' ? body.message : undefined;
  const expressionValue = typeof body?.expression === 'string' ? body.expression : undefined;
  const expression = (expressionValue ?? messageValue ?? '').trim();
  const message = (messageValue ?? expressionValue ?? '').trim();

  if (!npcId || !message) {
    return { error: 'npcId and message required' };
  }

  const declaredIntent = normaliseIntent(body?.declaredIntent);
  const kind = normaliseKind(body?.kind) ?? inferInteractionKind(declaredIntent);

  return {
    interaction: {
      npcId,
      message,
      expression,
      declaredIntent,
      kind,
    },
  };
}

export function inferInteractionKind(intent: PlayerIntent): InteractionKind {
  if (intent === 'stay_silent') return 'silence';
  if (intent === 'listen') return 'presence';
  if (intent === 'leave') return 'action';
  return 'speech';
}

export function interpretPlayerInteraction(
  interaction: PlayerInteraction,
  npc: WorldNPC,
  relationship?: NPCLiveState,
  context: InterpretationContext = {},
): NPCInteractionInterpretation {
  const profile = INTENT_PROFILES[interaction.declaredIntent] ?? INTENT_PROFILES.say;
  const affect = relationship?.innerLife?.affect;
  const shame = affect?.shame ?? 0;
  const resentment = affect?.resentment ?? 0;
  const loneliness = affect?.loneliness ?? 0;
  const fearAffect = affect?.fear ?? 0;
  const trust = relationship?.trustLevel ?? npc.selfAwarenessLevel ?? 30;
  const warmth = relationship?.warmth ?? 40;
  const fear = relationship?.fear ?? 30;
  const defensePressure = context.defensePressure ?? currentDefensePressure(relationship);
  const activeWounds = context.activeWounds ?? activeWoundsFor(interaction.expression, npc);

  const scores = new Map<PerceivedIntent, number>();
  for (const perceived of profile.likelyPerceived) {
    addScore(scores, perceived, 1);
  }

  let pressure = profile.pressure + defensePressure * 0.25;
  let distortion = profile.ambiguity;
  let promiseRisk = profile.promiseRisk;
  let confidence = 0.55;

  if (trust >= 60) {
    addScore(scores, 'care', 0.3);
    addScore(scores, 'honesty', 0.2);
    distortion -= 0.08;
    confidence += 0.1;
  } else if (trust <= 25) {
    addScore(scores, 'threat', 0.22);
    addScore(scores, 'control', 0.16);
    distortion += 0.12;
    confidence -= 0.04;
  }

  if (warmth >= 60) {
    addScore(scores, 'care', 0.2);
    addScore(scores, 'respect', 0.12);
  } else if (warmth <= 25) {
    addScore(scores, 'judgment', 0.18);
    addScore(scores, 'dismissal', 0.14);
  }

  if (fear >= 60 || fearAffect > 0.45) {
    addScore(scores, 'threat', 0.28);
    pressure += 0.15;
    distortion += 0.08;
  }

  if (npc.attachmentStyle === 'secure') {
    addScore(scores, 'care', interaction.declaredIntent === 'comfort' ? 0.55 : 0.15);
    addScore(scores, 'repair', interaction.declaredIntent === 'apologise' ? 0.45 : 0.1);
    distortion -= 0.08;
    confidence += 0.08;
  }

  if (npc.attachmentStyle === 'avoidant') {
    if (interaction.declaredIntent === 'comfort' || interaction.declaredIntent === 'share_personal') {
      addScore(scores, 'pity', shame > 0.55 ? 0.75 : 0.35);
      addScore(scores, 'control', 0.35);
      pressure += 0.18;
      distortion += 0.13;
    }
    if (interaction.declaredIntent === 'leave' || interaction.declaredIntent === 'set_boundary') {
      addScore(scores, 'respect', 0.3);
      addScore(scores, 'rejection', 0.2);
    }
  }

  if (npc.attachmentStyle === 'anxious') {
    if (interaction.declaredIntent === 'leave' || interaction.declaredIntent === 'stay_silent') {
      addScore(scores, 'abandonment', 0.7);
      pressure += 0.2;
      distortion += 0.16;
    }
    if (interaction.declaredIntent === 'reassure' || interaction.declaredIntent === 'make_promise') {
      addScore(scores, 'care', 0.25);
      promiseRisk += 0.1;
    }
  }

  if (npc.attachmentStyle === 'disorganised') {
    addScore(scores, 'threat', 0.15);
    addScore(scores, 'care', 0.15);
    pressure += 0.12;
    distortion += 0.12;
  }

  if (shame > 0.55) {
    addScore(scores, 'pity', 0.4);
    addScore(scores, 'judgment', 0.22);
    distortion += 0.1;
  }

  if (resentment > 0.45) {
    addScore(scores, 'control', 0.2);
    addScore(scores, 'pressure', 0.25);
    pressure += 0.12;
  }

  if (loneliness > 0.55 && ['comfort', 'listen', 'reassure'].includes(interaction.declaredIntent)) {
    addScore(scores, 'care', 0.24);
    distortion -= 0.04;
  }

  if (activeWounds.length > 0) {
    addScore(scores, woundIntent(interaction), 0.35);
    pressure += 0.16;
    distortion += 0.14;
  }

  if (interaction.declaredIntent === 'confront') {
    pressure += 0.35;
    addScore(scores, 'pressure', 0.35);
  }

  if (interaction.declaredIntent === 'make_promise') {
    promiseRisk += 0.2;
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const perceivedIntent = ranked[0]?.[0] ?? profile.likelyPerceived[0] ?? 'honesty';
  const alternativePerceptions = ranked.slice(1, 4).map(([intent]) => intent);

  distortion = clamp01(distortion);
  pressure = clamp01(pressure);
  promiseRisk = clamp01(promiseRisk);
  confidence = clamp01(confidence + (ranked[0]?.[1] ?? 1) * 0.05 - distortion * 0.18);

  return {
    declaredIntent: interaction.declaredIntent,
    kind: interaction.kind,
    expression: interaction.expression,
    perceivedIntent,
    alternativePerceptions,
    confidence: round2(confidence),
    distortion: round2(distortion),
    pressure: round2(pressure),
    promiseRisk: round2(promiseRisk),
    interpretationSummary: summaryFor(interaction, perceivedIntent, pressure, distortion),
    emotionalImpact: emotionalImpactFor(perceivedIntent, profile.warmth, pressure, promiseRisk),
  };
}

function normaliseIntent(value: unknown): PlayerIntent {
  return typeof value === 'string' && PLAYER_INTENTS.includes(value as PlayerIntent)
    ? value as PlayerIntent
    : 'say';
}

function normaliseKind(value: unknown): InteractionKind | undefined {
  return typeof value === 'string' && INTERACTION_KINDS.includes(value as InteractionKind)
    ? value as InteractionKind
    : undefined;
}

function currentDefensePressure(state?: NPCLiveState): number {
  const latest = state?.innerLife?.defenseHistory?.slice(-1)[0];
  return clamp01((latest?.pressureScore ?? 0) / 100);
}

function activeWoundsFor(expression: string, npc: WorldNPC): string[] {
  const lower = expression.toLowerCase();
  return (npc.woundTriggers ?? []).filter(trigger => lower.includes(trigger.toLowerCase()));
}

function woundIntent(interaction: PlayerInteraction): PerceivedIntent {
  if (interaction.declaredIntent === 'leave') return 'abandonment';
  if (interaction.declaredIntent === 'set_boundary') return 'rejection';
  if (interaction.declaredIntent === 'confront') return 'threat';
  return 'pressure';
}

function emotionalImpactFor(
  perceivedIntent: PerceivedIntent,
  warmth: number,
  pressure: number,
  promiseRisk: number,
): NPCInteractionInterpretation['emotionalImpact'] {
  const impact: NPCInteractionInterpretation['emotionalImpact'] = {
    warmth: round2(warmth),
    arousal: round2(pressure * 0.3),
  };

  if (['care', 'respect', 'honesty', 'repair', 'curiosity'].includes(perceivedIntent)) {
    impact.trust = round2(0.08 + Math.max(0, warmth) * 0.25);
    impact.valence = round2(0.08 + Math.max(0, warmth) * 0.2);
  }

  if (['threat', 'control', 'judgment', 'pressure'].includes(perceivedIntent)) {
    impact.fear = round2(0.08 + pressure * 0.35);
    impact.resentment = round2(pressure * 0.25);
    impact.valence = round2(-0.08 - pressure * 0.18);
  }

  if (['pity', 'dismissal', 'rejection', 'abandonment', 'avoidance'].includes(perceivedIntent)) {
    impact.shame = round2(0.08 + pressure * 0.22);
    impact.loneliness = round2(0.06 + pressure * 0.18);
    impact.valence = round2(-0.08 - pressure * 0.15);
  }

  if (promiseRisk > 0.5) {
    impact.trust = round2((impact.trust ?? 0) + 0.05);
    impact.fear = round2((impact.fear ?? 0) + promiseRisk * 0.12);
  }

  return impact;
}

function summaryFor(
  interaction: PlayerInteraction,
  perceivedIntent: PerceivedIntent,
  pressure: number,
  distortion: number,
): string {
  return `${interaction.declaredIntent} was read as ${perceivedIntent}; pressure ${round2(pressure)}, distortion ${round2(distortion)}.`;
}

function addScore(scores: Map<PerceivedIntent, number>, intent: PerceivedIntent, value: number): void {
  scores.set(intent, (scores.get(intent) ?? 0) + value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
