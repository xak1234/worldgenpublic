/**
 * The Inner Life
 * 
 * The psychological substrate that makes each NPC a distinct kind of mind.
 * Not everyone processes the same way. Not everyone suffers the same way.
 * Some people are at war with themselves. Some are at peace.
 * The difference isn't personality — it's architecture.
 */

import type {
  DefenseEpisode,
  IdentityStreamEntry,
  InternalBelief,
  LoyaltyConflict,
  NPCDream,
  RuminationThread,
  TrajectoryPoint,
} from './types.js';

// ── Attachment Style ────────────────────────────────────────────────────────
// Determines HOW a person forms bonds. Not a preference — a pattern
// burned in early and running underneath everything.

export type AttachmentStyle = 'secure' | 'anxious' | 'avoidant' | 'disorganised';

export interface AttachmentProfile {
  style: AttachmentStyle;
  
  // How the style manifests in this specific person
  intimacyComfort: number;       // 0-100: how close can they let someone get
  abandonmentFear: number;       // 0-100: how much they dread being left
  trustBaseline: number;         // 0-100: starting trust before any evidence
  vulnerabilityThreshold: number; // interactions needed before they show weakness
  
  // Behavioural patterns
  pursueOrWithdraw: 'pursue' | 'withdraw' | 'oscillate';
  conflictResponse: string;      // "shuts down" / "escalates" / "seeks resolution" / "flees"
  
  // The wound underneath
  coreWound: string;             // "abandoned by father at 7" / "mother was unpredictable"
  triggerPatterns: string[];     // situations that activate the wound
}

// ── Self-Awareness ──────────────────────────────────────────────────────────
// How well a person understands their own inner workings.
// This determines whether PEP runs destructively or not.

export interface SelfAwareness {
  level: number;                 // 0-100
  
  // What they understand about themselves
  knowsOwnTriggers: boolean;
  knowsOwnDefenses: boolean;
  canNameEmotions: boolean;      // emotional literacy
  distinguishesFeelingsFromFacts: boolean;
  
  // Processing style
  processingType: ProcessingType;
  
  // Capacity for growth
  openToChange: boolean;
  canAcceptCriticism: boolean;
  learnsFromMistakes: boolean;
}

export type ProcessingType = 
  | 'present'          // grounded, processes in the moment, lets go. rare.
  | 'brief_reflection' // thinks about it, draws a conclusion, moves on. healthy.
  | 'moderate_rumination' // replays a few times, some distortion, eventually settles. most people.
  | 'heavy_rumination' // loops for days, significant distortion, affects mood and behaviour.
  | 'suppression'      // buries it. appears fine. it comes out sideways later.
  | 'dissociation';    // doesn't process at all. numb. disconnected.

// ── Affect Vector ───────────────────────────────────────────────────────────
// Emotions are not a single word. They are a multi-dimensional state
// that shifts continuously.

export interface AffectVector {
  // Core dimensions (Russell's circumplex model)
  valence: number;               // -1 to +1: bad ←→ good
  arousal: number;               // 0 to 1: calm ←→ activated
  dominance: number;             // 0 to 1: powerless ←→ in control
  
  // Specific emotions as intensities (0.0 to 1.0)
  anger: number;
  fear: number;
  sadness: number;
  joy: number;
  disgust: number;
  surprise: number;
  trust: number;
  anticipation: number;
  shame: number;
  guilt: number;
  loneliness: number;
  desire: number;
  pride: number;
  envy: number;
  contempt: number;
  tenderness: number;
  nostalgia: number;
  resentment: number;
  gratitude: number;
  relief: number;
  anxiety?: number;
}

export function createNeutralAffect(): AffectVector {
  return {
    valence: 0, arousal: 0.3, dominance: 0.5,
    anger: 0, fear: 0, sadness: 0, joy: 0.2, disgust: 0, surprise: 0,
    trust: 0.3, anticipation: 0.1, shame: 0, guilt: 0, loneliness: 0,
    desire: 0, pride: 0, envy: 0, contempt: 0, tenderness: 0,
    nostalgia: 0, resentment: 0, gratitude: 0, relief: 0, anxiety: 0,
  };
}

// Emotional inertia — blend current state with new input
export function blendAffect(current: AffectVector, stimulus: Partial<AffectVector>, weight: number): AffectVector {
  const result = { ...current };
  for (const [key, value] of Object.entries(stimulus)) {
    if (typeof value === 'number' && key in result) {
      const k = key as keyof AffectVector;
      result[k] = (current[k] ?? 0) * (1 - weight) + value * weight;
    }
  }
  return result;
}

// Summarise affect for LLM context (not the full vector — the human-readable version)
export function describeAffect(affect: AffectVector): string {
  const dominant: string[] = [];
  const entries = Object.entries(affect).filter(([k]) => 
    !['valence', 'arousal', 'dominance'].includes(k)
  ) as [string, number][];
  
  for (const [emotion, intensity] of entries) {
    if (intensity > 0.6) dominant.push(`strongly ${emotion}`);
    else if (intensity > 0.35) dominant.push(emotion);
  }
  
  if (dominant.length === 0) {
    if (affect.valence > 0.3) return 'quietly content';
    if (affect.valence < -0.3) return 'uneasy but not sure why';
    return 'neutral, unremarkable';
  }
  
  return dominant.join(', ');
}

// ── Defense Mechanisms ──────────────────────────────────────────────────────
// Unconscious. The NPC doesn't choose these. They fire automatically
// when the internal state is threatened.

export type DefenseMechanism = 
  | 'denial'            // refusing to acknowledge what happened
  | 'projection'        // seeing your own flaws in someone else
  | 'rationalization'   // inventing acceptable reasons for unacceptable feelings
  | 'displacement'      // redirecting emotion onto a safer target
  | 'reaction_formation' // acting the opposite of what you feel
  | 'regression'        // reverting to childlike behaviour under stress
  | 'intellectualization' // turning feelings into abstract analysis
  | 'sublimation'       // channeling difficult feelings into productive activity
  | 'humour'            // deflecting with comedy
  | 'withdrawal'        // physically or emotionally leaving
  | 'minimising'        // downplaying the significance of what happened
  | 'guardedness'       // answering carefully, withholding, narrowing trust
  | 'none';             // rare — genuinely processing without defence

export interface DefenseProfile {
  primary: DefenseMechanism;     // their go-to defence
  secondary: DefenseMechanism;   // what they use when the primary fails
  maturity: 'immature' | 'neurotic' | 'mature'; // Vaillant's hierarchy
  
  // When do defences activate?
  activationThreshold: number;   // 0-100: how much threat before they fire
  // Low = defences fire at the slightest discomfort
  // High = can tolerate significant discomfort before defending
}

// ── Wounds ──────────────────────────────────────────────────────────────────
// Things that happened that left a mark. Not visible. Not discussed
// unless trust is very high. But they drive everything.

export interface PsychologicalWound {
  description: string;           // "was abandoned by their mother at age 9"
  age: number;                   // when it happened
  processed: boolean;            // have they worked through it? (usually no)
  triggerWords: string[];        // words/topics that activate this wound
  triggerSituations: string[];   // "being ignored" / "someone leaving without saying goodbye"
  defenseTriggers: DefenseMechanism; // which defence fires when this wound is activated
  surfaceBehaviour: string;      // what the player SEES when this activates
}

// ── Theory of Mind ──────────────────────────────────────────────────────────
// What the NPC THINKS the player is thinking. Always incomplete.
// Often wrong. Updated after every interaction.

export interface TheoryOfPlayer {
  perceivedIntent: string;       // "I think they want friendship" / "they want something from me"
  perceivedCharacter: string;    // "kind but guarded" / "charming but unreliable"
  perceivedThreatLevel: number;  // 0-100
  perceivedInterest: number;     // 0-100 how interested the player seems in them
  predictions: string[];         // "they'll probably come back tomorrow" / "I don't think I'll see them again"
  lastUpdated: string;           // in-world date
  confidence: number;            // 0-100 how sure they are about their read
  wrongAbout: string[];          // things they believe about the player that are incorrect (invisible to player)
}

// ── The Complete Inner Life ─────────────────────────────────────────────────
// Everything a person carries inside that the world never sees directly.

export interface InnerLife {
  attachment: AttachmentProfile;
  selfAwareness: SelfAwareness;
  affect: AffectVector;
  defenses: DefenseProfile;
  wounds: PsychologicalWound[];
  theoryOfPlayer: TheoryOfPlayer;
  
  // Self-concept
  selfConcept: string[];         // "I am..." statements: "I am a hard worker", "I am unlovable"
  selfNarrative: string;         // the story they tell about their life
  values: string[];              // what matters most: "loyalty", "independence", "honesty"
  
  // Current inner monologue
  lastThought: string;           // most recent internal thought
  unresolved: string[];          // things they haven't processed yet
  intentions: string[];          // what they plan to do next time they see the player
  
  // PEP state
  pepActive: boolean;            // are they currently ruminating about an interaction?
  pepTarget: string;             // who are they thinking about?
  pepCycleCount: number;         // how many times have they replayed it?
  pepDistortionLevel: number;    // 0-1: how far has the memory drifted from reality?

  // Inspectable cognition proof
  ruminationThreads: RuminationThread[];
  actorStream: IdentityStreamEntry[];
  observerStream: IdentityStreamEntry[];
  defenseHistory: DefenseEpisode[];
  trajectory: TrajectoryPoint[];
  internalBeliefs: InternalBelief[];

  // Dream system
  dreams?: NPCDream[];
  lastDreamDate?: string;

  // Conflicting loyalties
  loyaltyConflicts?: LoyaltyConflict[];
}

export function createDefaultInnerLife(
  attachment: AttachmentStyle,
  processingType: ProcessingType,
  primaryDefense: DefenseMechanism,
  selfAwarenessLevel?: number,
): InnerLife {
  const profiles: Record<AttachmentStyle, Partial<AttachmentProfile>> = {
    secure: { intimacyComfort: 80, abandonmentFear: 15, trustBaseline: 60, vulnerabilityThreshold: 3, pursueOrWithdraw: 'pursue', conflictResponse: 'seeks resolution' },
    anxious: { intimacyComfort: 90, abandonmentFear: 85, trustBaseline: 40, vulnerabilityThreshold: 1, pursueOrWithdraw: 'pursue', conflictResponse: 'escalates' },
    avoidant: { intimacyComfort: 30, abandonmentFear: 20, trustBaseline: 25, vulnerabilityThreshold: 12, pursueOrWithdraw: 'withdraw', conflictResponse: 'shuts down' },
    disorganised: { intimacyComfort: 50, abandonmentFear: 70, trustBaseline: 20, vulnerabilityThreshold: 6, pursueOrWithdraw: 'oscillate', conflictResponse: 'flees' },
  };

  // Explicit per-character self-awareness wins; otherwise fall back to a
  // processing-type heuristic. The level then modulates the sub-flags so the
  // authored selfAwarenessLevel actually drives runtime cognition.
  const awareness = typeof selfAwarenessLevel === 'number'
    ? Math.max(0, Math.min(100, selfAwarenessLevel))
    : (processingType === 'present' ? 85 : processingType === 'brief_reflection' ? 65 : processingType === 'suppression' ? 20 : 40);

  return {
    attachment: { style: attachment, coreWound: '', triggerPatterns: [], ...profiles[attachment] } as AttachmentProfile,
    selfAwareness: {
      level: awareness,
      knowsOwnTriggers: awareness >= 60 || processingType === 'present' || processingType === 'brief_reflection',
      knowsOwnDefenses: awareness >= 70 || processingType === 'present',
      canNameEmotions: awareness >= 60 || (processingType !== 'suppression' && processingType !== 'dissociation'),
      distinguishesFeelingsFromFacts: awareness >= 70 || processingType === 'present',
      processingType,
      openToChange: awareness >= 55 || processingType !== 'suppression',
      canAcceptCriticism: awareness >= 65 || processingType === 'present' || processingType === 'brief_reflection',
      learnsFromMistakes: awareness >= 50 || processingType !== 'dissociation',
    },
    affect: createNeutralAffect(),
    defenses: {
      primary: primaryDefense,
      secondary: primaryDefense === 'humour' ? 'withdrawal' : 'rationalization',
      maturity: ['sublimation', 'humour', 'none'].includes(primaryDefense) ? 'mature' : ['intellectualization', 'rationalization', 'reaction_formation'].includes(primaryDefense) ? 'neurotic' : 'immature',
      activationThreshold: processingType === 'present' ? 80 : processingType === 'suppression' ? 15 : 45,
    },
    wounds: [],
    theoryOfPlayer: {
      perceivedIntent: 'unknown',
      perceivedCharacter: 'unknown',
      perceivedThreatLevel: 30,
      perceivedInterest: 0,
      predictions: [],
      lastUpdated: '',
      confidence: 0,
      wrongAbout: [],
    },
    selfConcept: [],
    selfNarrative: '',
    values: [],
    lastThought: '',
    unresolved: [],
    intentions: [],
    pepActive: false,
    pepTarget: '',
    pepCycleCount: 0,
    pepDistortionLevel: 0,
    ruminationThreads: [],
    actorStream: [],
    observerStream: [],
    defenseHistory: [],
    trajectory: [],
    internalBeliefs: [],
    dreams: [],
    lastDreamDate: '',
    loyaltyConflicts: [],
  };
}

// ── Defensive normalizer ───────────────────────────────────────────────
// Coerces every expected-array field to an array. Tolerates null/undefined/string/anything.
// Use whenever InnerLife is read from untrusted sources (LLM output, saved world JSON).
function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v.filter((x) => x != null) as T[];
  if (typeof v === 'string' && v.trim().length > 0) return [v as unknown as T];
  return [];
}

export function normalizeInnerLife(il: any): InnerLife {
  const out: any = il && typeof il === 'object' ? { ...il } : {};

  // top-level string arrays
  out.selfConcept = asArray<string>(out.selfConcept);
  out.values      = asArray<string>(out.values);
  out.unresolved  = asArray<string>(out.unresolved);
  out.intentions  = asArray<string>(out.intentions);

  // typed-record arrays (runtime-grown)
  out.wounds            = asArray(out.wounds);
  out.ruminationThreads = asArray(out.ruminationThreads);
  out.actorStream       = asArray(out.actorStream);
  out.observerStream    = asArray(out.observerStream);
  out.defenseHistory    = asArray(out.defenseHistory);
  out.trajectory        = asArray(out.trajectory);
  out.internalBeliefs   = asArray(out.internalBeliefs);
  out.dreams            = asArray(out.dreams);
  out.loyaltyConflicts  = asArray(out.loyaltyConflicts);

  // nested arrays within wounds
  out.wounds = out.wounds.map((w: any) => ({
    ...(w && typeof w === 'object' ? w : {}),
    triggerWords:     asArray<string>(w && w.triggerWords),
    triggerSituations:asArray<string>(w && w.triggerSituations),
  }));

  // attachment.triggerPatterns
  if (!out.attachment || typeof out.attachment !== 'object') out.attachment = {};
  out.attachment = { ...out.attachment, triggerPatterns: asArray<string>(out.attachment.triggerPatterns) };

  // theoryOfPlayer arrays
  if (!out.theoryOfPlayer || typeof out.theoryOfPlayer !== 'object') out.theoryOfPlayer = {};
  out.theoryOfPlayer = {
    ...out.theoryOfPlayer,
    predictions: asArray<string>(out.theoryOfPlayer.predictions),
    wrongAbout:  asArray<string>(out.theoryOfPlayer.wrongAbout),
  };

  return out as InnerLife;
}
