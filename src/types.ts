import type { PopulationBlueprint } from './populationPlanner.js';
import type { InnerLife } from './innerLife.js';

// Re-export locally defined types that were in memory.ts to avoid circular deps
export interface LifeGoal {
  id: string;
  description: string;
  motivation: string;
  type: 'social' | 'financial' | 'personal' | 'escape' | 'revenge' | 'romantic' | 'survival' | 'power';
  targetNpcId?: string;
  progress: number;
  startedDate: string;
  deadline?: string;
  blockers: string[];
  willingness: number;
  secretGoal: boolean;
  dailyActions: string[];
  locationPreferences: string[];
  avoidLocations: string[];
  socialBehaviour: string;
}

export interface NPCPromise {
  id: string;
  madeByPlayer: boolean;
  description: string;
  madeOnDate: string;
  deadline?: string;
  status: 'pending' | 'kept' | 'broken' | 'forgotten';
  importanceToNPC: number;
}

/**
 * World Simulation Types
 * A life simulator — NPCs live their own lives, you're just another person in the world.
 * No quests, no objectives, no win conditions. Just existence.
 */

// ── World DNA ───────────────────────────────────────────────────────────────

export interface WorldDNA {
  id: string;
  concept: string;
  createdAt: string;
  provider: string;
  images?: WorldImageBundle;
  currentDate?: string;
  currentTime?: number;
  currentMinute?: number;
  clockStartedAt?: string;
  lastClockSyncAt?: string;
  currentWeather?: CurrentWeather;
  questPool?: WorldQuestSeed[];
  realWorldBased?: boolean;
  realWorldFacts?: string;
  sourceDocuments?: WorldSourceDocument[];
  worldQuestAdventures?: WorldQuestAdventure[];
  serializedAdventures?: SerializedAdventure[];
  npcSharedStates?: Record<string, PersistentNpcSharedState>;
  playerProfiles?: Record<string, PersistentPlayerProfile>;
  displayLanguage?: string;

  // Setting
  era: WorldEra;
  geography: WorldGeography;
  culture: WorldCulture;

  // Systems
  economy: WorldEconomy;
  law: WorldLaw;
  weather: WeatherSystem;
  technology: TechnologyLevel;

  // Atmosphere
  narrativeStyle: NarrativeStyle;

  // Population
  populationBlueprint: PopulationBlueprint;

  // Content
  locations: WorldLocation[];
  npcs: WorldNPC[];
  timeline: TimelineEvent[];

  // Simulation
  simulationRules: SimulationRules;
  timeOfDay: TimeOfDaySystem;
}

export interface WorldImageBundle {
  status?: 'generating' | 'ready' | 'partial' | 'failed';
  cover?: string;
  portraits?: Record<string, string>;
  castPortraits?: WorldCastPortrait[];
  swimwearPortraits?: Record<string, string>;
  scenes?: Record<string, string>;
  panelBackgrounds?: Partial<Record<'geography' | 'economy', string>>;
  panelBackgroundSources?: Record<string, { kind: 'duckduckgo'; query: string; sourceUrl?: string; fetchedAt: string }>;
  generatedAt?: string;
  error?: string;
}

export interface WorldCastPortrait {
  actor: string;
  character: string;
  order?: number;
  imageUrl: string;
  source?: string;
  tmdbPersonId?: number;
  profilePath?: string;
}

// ── Era ─────────────────────────────────────────────────────────────────────

export interface WorldEra {
  period: string;
  yearStart: number;
  yearEnd: number;
  dateFormat: string;
  majorWorldEvents: string[];
}

// ── Geography ───────────────────────────────────────────────────────────────

export interface WorldGeography {
  region: string;
  country: string;
  climate: string;
  terrain: string;
  scale: 'neighbourhood' | 'city' | 'region';
  landmarks: string[];
}

// ── Culture ─────────────────────────────────────────────────────────────────

export interface WorldCulture {
  language: string;
  dialect: string;
  slang: Record<string, string>;      // word -> meaning
  greetings: string[];                 // how people say hello here
  socialClasses: SocialClass[];
  religion: string;
  customs: string[];
  taboos: string[];
  music: string;
  food: string[];
  entertainment: string[];
  genderRoles: string;
  socialNorms: string[];               // unwritten rules everyone follows
}

export interface SocialClass {
  name: string;
  description: string;
  occupations: string[];
  typicalLocations: string[];
  mannerisms: string;                  // how people of this class behave
}

// ── Economy ─────────────────────────────────────────────────────────────────

export interface WorldEconomy {
  currency: string;
  symbol: string;
  averageDailyWage: number;
  prices: Record<string, number>;      // "pint of beer": 0.15, "bus fare": 0.05
  jobs: JobType[];
  blackMarket: string;
}

export interface JobType {
  title: string;
  pay: number;
  hours: string;
  socialClass: string;
  description: string;
}

// ── Law ─────────────────────────────────────────────────────────────────────

export interface WorldLaw {
  system: string;
  enforcers: string;
  corruption: number;
  vices: string[];                     // things that are illegal but common
  consequences: string;
}

// ── Weather ─────────────────────────────────────────────────────────────────

export interface WeatherSystem {
  seasons: SeasonDescription[];
  dominantWeather: string;
}

export interface CurrentWeather {
  condition: string;
  intensity: 'clear' | 'light' | 'moderate' | 'heavy' | 'severe' | 'violent';
  temperatureC: number;
  wind: string;
  visibility: string;
  precipitation: 'none' | 'mist' | 'drizzle' | 'rain' | 'hail' | 'sleet' | 'snow';
  thunder: boolean;
  lightning: boolean;
  mood: string;
  effects: string[];
  changedAt: string;
}

export interface GodEffect {
  id: string;
  type: string;
  label: string;
  locationId?: string;
  targetNpcId?: string;
  activeUntil: 'leave_location' | 'instant';
  startedAt: string;
}

// ── Player Interaction Intent Layer ────────────────────────────────────────

export type InteractionKind = 'speech' | 'gesture' | 'silence' | 'presence' | 'action';

export type PlayerIntent =
  | 'say'
  | 'ask'
  | 'listen'
  | 'stay_silent'
  | 'comfort'
  | 'apologise'
  | 'confront'
  | 'reassure'
  | 'make_promise'
  | 'share_personal'
  | 'set_boundary'
  | 'leave';

export type PerceivedIntent =
  | 'care'
  | 'judgment'
  | 'pity'
  | 'flirtation'
  | 'threat'
  | 'abandonment'
  | 'respect'
  | 'dismissal'
  | 'control'
  | 'honesty'
  | 'avoidance'
  | 'curiosity'
  | 'rejection'
  | 'repair'
  | 'pressure';

export interface IntentProfile {
  intent: PlayerIntent;
  defaultKind: InteractionKind;
  likelyPerceived: PerceivedIntent[];
  warmth: number;
  pressure: number;
  promiseRisk: number;
  ambiguity: number;
  summary: string;
}

export interface PlayerInteraction {
  npcId: string;
  message: string;
  expression: string;
  declaredIntent: PlayerIntent;
  kind: InteractionKind;
}

export interface NPCInteractionInterpretation {
  declaredIntent: PlayerIntent;
  kind: InteractionKind;
  expression: string;
  perceivedIntent: PerceivedIntent;
  alternativePerceptions: PerceivedIntent[];
  confidence: number;
  distortion: number;
  pressure: number;
  promiseRisk: number;
  interpretationSummary: string;
  emotionalImpact: Partial<Record<'trust' | 'warmth' | 'fear' | 'shame' | 'resentment' | 'loneliness' | 'valence' | 'arousal', number>>;
}

export const INTENT_PROFILES: Record<PlayerIntent, IntentProfile> = {
  say: { intent: 'say', defaultKind: 'speech', likelyPerceived: ['honesty', 'curiosity'], warmth: 0.05, pressure: 0.1, promiseRisk: 0, ambiguity: 0.35, summary: 'ordinary speech' },
  ask: { intent: 'ask', defaultKind: 'speech', likelyPerceived: ['curiosity', 'respect', 'pressure'], warmth: 0.05, pressure: 0.25, promiseRisk: 0, ambiguity: 0.3, summary: 'asking for information or attention' },
  listen: { intent: 'listen', defaultKind: 'presence', likelyPerceived: ['respect', 'care', 'curiosity'], warmth: 0.18, pressure: 0.05, promiseRisk: 0, ambiguity: 0.25, summary: 'making room for the NPC to speak' },
  stay_silent: { intent: 'stay_silent', defaultKind: 'silence', likelyPerceived: ['avoidance', 'dismissal', 'respect'], warmth: -0.05, pressure: 0.2, promiseRisk: 0, ambiguity: 0.65, summary: 'remaining silent' },
  comfort: { intent: 'comfort', defaultKind: 'speech', likelyPerceived: ['care', 'pity', 'repair'], warmth: 0.3, pressure: 0.15, promiseRisk: 0, ambiguity: 0.28, summary: 'offering comfort' },
  apologise: { intent: 'apologise', defaultKind: 'speech', likelyPerceived: ['repair', 'honesty', 'respect'], warmth: 0.22, pressure: 0.1, promiseRisk: 0, ambiguity: 0.18, summary: 'trying to repair harm' },
  confront: { intent: 'confront', defaultKind: 'speech', likelyPerceived: ['judgment', 'threat', 'pressure'], warmth: -0.18, pressure: 0.65, promiseRisk: 0, ambiguity: 0.2, summary: 'directly challenging the NPC' },
  reassure: { intent: 'reassure', defaultKind: 'speech', likelyPerceived: ['care', 'repair', 'honesty'], warmth: 0.24, pressure: 0.12, promiseRisk: 0.1, ambiguity: 0.22, summary: 'trying to reduce fear or uncertainty' },
  make_promise: { intent: 'make_promise', defaultKind: 'speech', likelyPerceived: ['care', 'honesty', 'control'], warmth: 0.16, pressure: 0.22, promiseRisk: 0.8, ambiguity: 0.26, summary: 'making a commitment' },
  share_personal: { intent: 'share_personal', defaultKind: 'speech', likelyPerceived: ['honesty', 'care', 'flirtation'], warmth: 0.24, pressure: 0.18, promiseRisk: 0, ambiguity: 0.32, summary: 'revealing something personal' },
  set_boundary: { intent: 'set_boundary', defaultKind: 'speech', likelyPerceived: ['respect', 'rejection', 'control'], warmth: -0.04, pressure: 0.4, promiseRisk: 0, ambiguity: 0.28, summary: 'setting a boundary' },
  leave: { intent: 'leave', defaultKind: 'action', likelyPerceived: ['abandonment', 'rejection', 'avoidance'], warmth: -0.2, pressure: 0.35, promiseRisk: 0, ambiguity: 0.35, summary: 'ending or leaving the interaction' },
};

// ── Cognition Proof Layer ──────────────────────────────────────────────────

export interface ObjectiveEvent {
  id: string;
  type: 'player_interaction' | 'player_action' | 'npc_conversation' | 'gossip' | 'god_effect' | 'movement' | 'weather' | 'life_event' | 'system' | 'quest';
  date: string;
  timeOfDay: string;
  locationId?: string;
  actorId?: string;
  targetIds: string[];
  summary: string;
  detail: string;
  tags: string[];
  createdAt: string;
  declaredIntent?: PlayerIntent;
  expression?: string;
  kind?: InteractionKind;
  perceivedIntent?: PerceivedIntent;
  interpretationConfidence?: number;
  interpretationDistortion?: number;
  interpretationSummary?: string;
  emotionalImpact?: NPCInteractionInterpretation['emotionalImpact'];
}

export interface MemoryDriftSnapshot {
  cycle: number;
  date: string;
  timeOfDay: string;
  before: string;
  after: string;
  distortionScore: number;
  biasSource: string;
  trigger: string;
  tags: string[];
}

export interface CounterfactualReplay {
  cycle: number;
  date: string;
  whatHappened: string;
  whatIShouldHaveSaid: string;
  whatTheyProbablyMeant: string;
  whatThisSaysAboutMe: string;
}

export interface RuminationThread {
  id: string;
  sourceEventId: string;
  targetMemoryId: string;
  targetName: string;
  startedAt: string;
  lastAdvancedAt: string;
  emotionalCharge: number;
  unresolvedQuestion: string;
  cycles: number;
  status: 'active' | 'settled' | 'suppressed';
  counterfactuals: CounterfactualReplay[];
}

export interface DefenseEpisode {
  id: string;
  date: string;
  timeOfDay: string;
  sourceEventId?: string;
  pressureScore: number;
  pressureInputs: Record<string, number>;
  defense: string;
  behaviour: string;
  trigger: string;
}

export interface IdentityStreamEntry {
  id: string;
  date: string;
  timeOfDay: string;
  text: string;
  source: 'interaction' | 'rumination' | 'tick' | 'contagion' | 'god_effect';
  confidence: number;
}

export interface TrajectoryPoint {
  date: string;
  timeOfDay: string;
  confidence: number;
  defensiveness: number;
  trust: number;
  fear: number;
  realityGap: number;
  distortion: number;
  ruminationLoad: number;
  identityConflict: number;
}

export interface InternalBelief {
  id: string;
  sourceEventId?: string;
  sourceNpcId?: string;
  subject: string;
  belief: string;
  confidence: number;
  sentiment: 'positive' | 'negative' | 'neutral' | 'curious' | 'warning';
  mutationCount: number;
  firstHeard: string;
  lastUpdated: string;
}

export interface BeliefContagionEvent {
  id: string;
  date: string;
  timeOfDay: string;
  fromNpcId: string;
  toNpcId: string;
  sourceEventId?: string;
  originalBelief: string;
  transmittedBelief: string;
  mutation: string;
  sentiment: 'positive' | 'negative' | 'neutral' | 'curious' | 'warning';
}

export interface RealityGapMetric {
  npcId: string;
  averageGap: number;
  maxGap: number;
  distortedMemoryCount: number;
  lastUpdated: string;
}

export interface SeasonDescription {
  name: string;
  months: number[];
  weather: string;
  atmosphere: string;
  npcBehaviourShift: string;           // how people act differently
}

// ── Technology ──────────────────────────────────────────────────────────────

export interface TechnologyLevel {
  era: string;
  transport: string[];
  communication: string[];
  lighting: string;
  media: string[];
  domesticLife: string;                // what home life looks like
}

// ── Time of Day ─────────────────────────────────────────────────────────────

export interface TimeOfDaySystem {
  periods: TimePeriod[];
}

export interface TimePeriod {
  name: string;                        // "early morning", "afternoon", "late night"
  hourStart: number;
  hourEnd: number;
  atmosphere: string;                  // what the world feels like
  npcActivity: string;                 // what people are generally doing
  openLocations: string[];             // which location types are active
}

// ── Narrative Style ─────────────────────────────────────────────────────────

export interface NarrativeStyle {
  voice: string;
  tense: 'second' | 'first' | 'third';
  toneKeywords: string[];
  literaryInfluences: string[];
  sampleParagraph: string;
  forbiddenWords: string[];
  sensoryPalette: string[];            // recurring sensory details
}

// ── Locations ───────────────────────────────────────────────────────────────

export interface WorldLocation {
  id: string;
  name: string;
  type: string;
  description: string;
  ambientDetail: string;
  connectedTo: string[];
  socialClass: string;
  openHours: string;                   // "always", "6am-11pm", "evenings only"
  regulars: string[];                  // NPC IDs who frequent this place
  interactables: string[];
  privacyLevel: 'public' | 'semi-private' | 'private';
  capacity: string;                    // "crowded pub", "quiet alley", "empty flat"
}

// ── Soundscape (Freesound ambient audio) ──────────────────────────────────

export interface FreesoundResult {
  id: number;
  name: string;
  previews: {
    'preview-hq-mp3': string;
    'preview-lq-mp3': string;
  };
  duration: number;
  tags: string[];
}

export interface SoundscapeLayer {
type: 'base' | 'detail' | 'weather' | 'crowd' | 'music';
soundUrl: string;
volume: number;
loop: boolean;
repeatDelayMs?: number;
freesoundId: number;
query?: string;
soundName?: string;
tags?: string[];
}

export interface SoundscapeManifest {
layers: SoundscapeLayer[];
contextHash: string;
locationId?: string;
locationName?: string;
weather?: string;
timeBucket?: string;
crowdBucket?: string;
}

export interface SoundscapeTagSet {
  layers: Array<{
    type: 'base' | 'detail' | 'weather' | 'crowd';
    query: string;
    volume: number;
  }>;
}

// ── NPCs ────────────────────────────────────────────────────────────────────

export interface WorldNPCWound {
  description: string;           // the formative painful experience
  triggerWords?: string[];      // words/topics that activate it
  triggerSituations?: string[]; // situations that activate it
}

export interface WorldNPC {
  id: string;
  name: string;
  age: number;
  gender: string;
  occupation: string;
  physicalDescription: string;
  personality: string;

  // Voice — how they actually speak
  voiceAnchor: string;
  speechPatterns: string[];
  coreConcerns: string[];
  signature: string;

  // Inner life
  traits: string[];
  secrets: string[];
  desires: string[];
  fears: string[];
  opinions: Record<string, string>;    // topic -> what they think
  backstory: string;
  dailyRoutine: DailyRoutine;

  // World position
  homeLocationId: string;
  workLocationId: string;
  frequentedLocations: string[];
  socialClass: string;

  // Relationships with other NPCs
  relationships: NPCRelationship[];
  
  // Emotional baseline
  baselineMood: string;
  temperament: string;                 // how they react under pressure
  approachability: number;             // 0-100 how easy to start talking to
  loyaltyThreshold: number;            // how many good interactions before they trust
  
  // Psychological architecture
  attachmentStyle: 'secure' | 'anxious' | 'avoidant' | 'disorganised';
  processingType: 'present' | 'brief_reflection' | 'moderate_rumination' | 'heavy_rumination' | 'suppression' | 'dissociation';
  primaryDefense: string;
  selfAwarenessLevel: number;          // 0-100
  coreWound: string;                   // formative painful experience
  woundTriggers: string[];             // words/topics that activate the wound
  woundSituations?: string[];          // situations (not words) that activate the wound
  additionalWounds?: WorldNPCWound[];  // 0-2 secondary wounds (doc: 1-3 wounds total)
  selfConcept: string[];               // "I am..." beliefs
  values: string[];                    // what matters most

  // Miscellaneous optional fields accessed by frontend/backend
  signatureObject?: string;
  prizedPossession?: string;
  hobby?: string;
  tools?: string[];

  // Personal images associated with this NPC
  images?: NPCImages;

  // TTS voice profile for spoken dialogue
  voiceProfile?: VoiceProfile;
}

export interface NPCImages {
  portrait?: string;       // main profile photo
  swimwear?: string;       // adult-only alternate swimwear photo
  keepsake?: string;       // personal keepsake photo they carry
  object?: string;         // signature object/possession photo
}

export interface VoiceProfile {
  pitch: number;        // 0.5–2.0 (1.0 = normal)
  rate: number;         // 0.5–2.0 (1.0 = normal)
  voiceName?: string;   // Web Speech API voice name hint
  gender: 'male' | 'female' | 'neutral';
  age: 'young' | 'middle' | 'old';
  accent?: string;      // e.g. "cockney", "rural", "formal"
  timbre?: string;      // e.g. "gravelly", "breathy", "clear", "nasal"
}

export interface DailyRoutine {
  morning: string;
  afternoon: string;
  evening: string;
  night: string;
  weekendDifference: string;
}

export interface NPCRelationship {
  npcId: string;
  type: string;
  description: string;
  strength: number;                    // 0-100
}

// ── Timeline Events ─────────────────────────────────────────────────────────

export interface TimelineEvent {
  id: string;
  date: string;
  title: string;
  description: string;
  type: 'local' | 'world' | 'personal' | 'seasonal' | 'crisis';
  locationId?: string;
  affectedNpcIds: string[];
  moodShift: string;                   // how the community mood changes
  publicKnowledge: boolean;
  gossipVersion: string;               // how people talk about it (may differ from truth)
}

// ── Simulation Rules ────────────────────────────────────────────────────────

export interface SimulationRules {
  gossipSpeed: number;                 // 0-1 how fast info spreads
  communitySize: string;               // "everyone knows everyone" vs "anonymous city"
  socialMobility: string;              // can you change class?
  privacyLevel: string;                // how much do people mind their business
  conflictStyle: string;               // "passive aggressive", "direct", "violent"
  trustCulture: string;                // how easily people trust strangers
  reputationMatters: boolean;
  rumoursSpread: boolean;
}

// ── NPC Memory System ───────────────────────────────────────────────────────

export interface NPCMemory {
  id: string;
  npcId: string;
  worldId: string;
  inWorldDate: string;
  realTimestamp: string;

  // What happened
  summary: string;
  detail: string;                      // slightly longer for important moments
  emotionalTone: string;
  playerMessage?: string;
  interactionKind?: InteractionKind;
  declaredIntent?: PlayerIntent;
  expression?: string;
  kind?: InteractionKind;
  perceivedIntent?: PerceivedIntent;
  interpretationConfidence?: number;
  interpretationDistortion?: number;
  interpretationSummary?: string;
  emotionalImpact?: NPCInteractionInterpretation['emotionalImpact'];
  npcReply?: string;
  
  // What was exchanged
  playerRevealed: string[];
  npcRevealed: string[];
  topicsCovered: string[];
  
  // Impact
  trustDelta: number;
  significantMoment: boolean;          // NPC will bring this up again
  npcThoughtAfter: string;            // what the NPC thought privately after

  // Verifiable cognition proof
  sourceEventId?: string;
  groundTruthSummary?: string;
  currentReconstruction?: string;
  driftHistory?: MemoryDriftSnapshot[];
  biasTags?: string[];
  realityGap?: number;

  // Witnessing
  isWitnessed?: boolean;            // this NPC witnessed someone else's interaction
  witnessedParticipants?: string[]; // who was involved in what they saw

  // Context
  locationId: string;
  timeOfDay: string;
  othersPresent: string[];             // other NPCs who saw this interaction
}

export interface NPCLiveState {
  npcId: string;
  worldId: string;

  // Relationship with player
  relationship: RelationshipLevel;
  trustLevel: number;                  // 0-100
  familiarity: number;                 // 0-100, how well they know you
  warmth: number;                      // 0-100, how they feel about you
  respect: number;                     // 0-100
  attraction: number;                  // 0-100
  fear: number;                        // 0-100

  // Current state
  mood: string;
  currentLocationId: string;
  currentActivity: string;
  isAvailable: boolean;                // are they free to talk
  
  // Memory
  memories: NPCMemory[];
  conversationHistory?: NPCMemory[];
  totalInteractions: number;
  lastInteractionDate: string;
  daysSinceLastSeen: number;
  
  // What they know about you
  playerFacts: string[];               // things they know about the player
  playerOpinion: string;               // their current summary opinion
  
  // Gossip
  gossipHeard: GossipItem[];
  gossipShared: GossipItem[];          // what they've told others about you
  
  // Offscreen life
  recentLifeEvents: string[];
  currentWorry: string;
  currentGoal: string;
  
  // Agency
  activeGoals: LifeGoal[];          // 1-3 ongoing life goals driving behaviour
  promises: NPCPromise[];           // tracked promises made by/to the player
  patternsNoticed: string[];        // behavioural patterns the NPC has spotted
  
  // Player behavioral profiling
  playerVisitFrequency?: number;    // how many times the player has visited this NPC
  playerAvoidanceScore?: number;    // 0-100, higher = player seems to avoid this NPC
  lastLocationsSeen?: string[];     // last 5 locations player was seen at (from gossip/witness)

  // Environmental awareness
  environmentalAwareness?: EnvironmentalAwareness;

  // Body routines influenced by psychological state
  bodyHabits?: BodyHabitState;

  // NPC-initiated contact
  pendingApproach?: NPCApproach;

  // Promise/favor economy
  npcRequests?: NPCRequest[];

  // Emotional contagion
  emotionalContagionLog?: EmotionalContagionEntry[];

  // Shared multi-player conversation log
  activeConversation?: SharedConversationExchange[];

  // Impossible gifts received from the player
  impossibleGiftsReceived?: { gift: string; date: string; accepted?: boolean; hint?: string }[];

  // The inner world — the part nobody sees
  innerLife: InnerLife;
}

export type RelationshipLevel =
  | 'stranger'          // never met
  | 'face'              // seen around, no conversation
  | 'nodding'           // brief exchanges, knows your name
  | 'acquaintance'      // had real conversations
  | 'friendly'          // genuinely likes you
  | 'friend'            // trusts you, seeks you out
  | 'close_friend'      // confides in you
  | 'intimate'          // deep personal bond
  | 'hostile'           // actively dislikes you
  | 'wary';             // doesn't trust you

export interface GossipItem {
  fromNpcId: string;
  content: string;
  date: string;
  sentiment: 'positive' | 'negative' | 'neutral' | 'curious' | 'warning';
  isTrue: boolean;                     // gossip can be wrong
}

export interface SharedConversationExchange {
  playerName: string;
  sessionId: string;
  message: string;
  reply: string;
  kind: string;
  timestamp: string;
}

export interface PersistentNpcSharedState {
  npcId: string;
  worldId: string;
  mood: string;
  currentLocationId: string;
  currentActivity: string;
  isAvailable: boolean;
  recentLifeEvents: string[];
  currentWorry: string;
  currentGoal: string;
  activeGoals: LifeGoal[];
  environmentalAwareness?: EnvironmentalAwareness;
  bodyHabits?: BodyHabitState;
  emotionalContagionLog?: EmotionalContagionEntry[];
  innerLife: InnerLife;
  activeConversation?: SharedConversationExchange[];
}

export interface PersistentNpcCharacterState {
  npcId: string;
  worldId: string;
  mood?: string;
  currentLocationId?: string;
  currentActivity?: string;
  isAvailable?: boolean;
  relationship: RelationshipLevel;
  trustLevel: number;
  familiarity: number;
  warmth: number;
  respect: number;
  attraction: number;
  fear: number;
  memories: NPCMemory[];
  conversationHistory?: NPCMemory[];
  totalInteractions: number;
  lastInteractionDate: string;
  daysSinceLastSeen: number;
  playerFacts: string[];
  playerOpinion: string;
  gossipHeard: GossipItem[];
  gossipShared: GossipItem[];
  recentLifeEvents?: string[];
  currentWorry?: string;
  currentGoal?: string;
  activeGoals?: LifeGoal[];
  promises: NPCPromise[];
  patternsNoticed: string[];
  playerVisitFrequency?: number;
  playerAvoidanceScore?: number;
  lastLocationsSeen?: string[];
  pendingApproach?: NPCApproach;
  npcRequests?: NPCRequest[];
  environmentalAwareness?: EnvironmentalAwareness;
  bodyHabits?: BodyHabitState;
  emotionalContagionLog?: EmotionalContagionEntry[];
  activeConversation?: SharedConversationExchange[];
  impossibleGiftsReceived?: { gift: string; date: string; accepted?: boolean; hint?: string }[];
  innerLife?: InnerLife;
}

export interface WorldSourceDocument {
  id: string;
  title: string;
  type: 'pdf' | 'text' | 'url' | 'image' | 'other';
  sourceType?: WorldQuestSourceType;
  path?: string;
  textPath?: string;
  url?: string;
  summary?: string;
  extractedText?: string;
  // Whole-story structured digest (CHARACTERS / LOCATIONS / PLOT / THEMES / TONE / ENDING).
  // Generated once from retained source text via DeepSeek; preferred over
  // extractedText for adventure-gen so quests can span the entire story arc, not just the opening.
  digest?: string;
  digestGeneratedAt?: string;
  addedAt: string;
}

export interface WorldQuestSeed {
  id: string;
  title: string;
  teaser: string;
  status: 'locked' | 'available' | 'active' | 'completed';
  difficulty: QuestDifficulty;
  worldId: string;
  worldName: string;
  giverNpcId?: string;
  giverNpcName?: string;
  locationId?: string;
  locationName?: string;
  unlockRule: {
    kind: 'meet_giver' | 'enter_location' | 'strange_possession' | 'weather' | 'complete_quest';
    label: string;
  };
  createdAt: string;
}

export interface WorldQuestStep {
  id: string;
  title: string;
  detail: string;
  kind: 'talk_to_npc' | 'find_witness' | 'inspect_location' | 'use_interactable' | 'wait_or_weather' | 'witness_event' | 'change_relationship' | 'action' | 'choice';
  npcIds?: string[];
  npcNames?: string[];
  locationIds?: string[];
  locationNames?: string[];
  interactable?: string;
  requiredProp?: string;
  act?: string;
  status: 'pending' | 'active' | 'complete' | 'failed';
  completedAt?: string;
}

export type WorldQuestSourceType = 'History' | 'Film' | 'Book' | 'Story' | 'Real Event' | 'LLM';

export interface WorldQuestAdventure {
  id: string;
  worldId: string;
  title: string;
  status: 'available' | 'active' | 'completed' | 'failed' | 'abandoned';
  difficulty?: 'easy' | 'normal' | 'hard';
  sourceType?: WorldQuestSourceType;
  completionThreshold?: number;
  medalName: string;
  achievementId: string;
  premise: string;
  historicalAnchor: string;
  fictionalExtension: string;
  requiredOutcome: string;
  completionSummary?: string;
  involvedNpcIds: string[];
  involvedLocationIds: string[];
  steps: WorldQuestStep[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  retryOf?: string;
  sessionId?: string;
  participantSessionIds?: string[];
  allowCoop?: boolean;
  twoPlayer?: boolean;
  hostSessionId?: string;
  guestSessionId?: string;
  guestCoopMode?: 'join' | 'free';
  hostCoopMode?: 'join' | 'free';
  pendingJoinRequests?: SerializedAdventureJoinRequest[];
  consequences?: string[];
  replacementReason?: string;
}

// ── Serialized Adventures (4th-tier quest system for enhanced worlds) ────────

export type SerializedAdventureStatus = 'available' | 'active' | 'completed' | 'abandoned';
export type SerializedBeatKind = 'story_beat' | 'choice_point' | 'climax' | 'revelation' | 'confrontation';
export type SerializedBeatStatus = 'locked' | 'active' | 'evaluating' | 'completed' | 'missed';
export type SerializedActStatus = 'locked' | 'active' | 'completed';
export type SerializedTimedEventTrigger = 'time' | 'turns' | 'interactions';
export type SerializedTimedEventEffect = 'escalation' | 'deadline' | 'reveal' | 'environmental';
export type SerializedSpectrumTier = 'Legendary' | 'Heroic' | 'Standard' | 'Flawed' | 'Tragic';

export interface SerializedAdventure {
  id: string;
  worldId: string;
  title: string;
  status: SerializedAdventureStatus;
  sourceType?: WorldQuestSourceType;

  // Narrative spine
  logline: string;
  premise: string;
  canonicalArc: string;
  thematicCore: string;

  // Structure
  acts: SerializedAct[];
  timedEvents: SerializedTimedEvent[];

  // Involvement
  involvedNpcIds: string[];
  involvedLocationIds: string[];

  // Scoring
  spectrumScore: number;
  scoreBreakdown: SerializedScoreEntry[];

  // Completion
  epilogue?: string;
  medalName?: string;
  achievementId?: string;

  // Metadata
  createdAt: string;
  sourceTimelineEventIds?: string[];
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  participantSessionIds?: string[];
  allowCoop?: boolean;
  coopModeBySessionId?: Record<string, 'join' | 'free'>;
  pendingJoinRequests?: SerializedAdventureJoinRequest[];

  // Counters
  turnCounter: number;
  interactionCounter: number;
  beatXpAwarded?: number;
}

export interface SerializedAdventureJoinRequest {
  id: string;
  sessionId: string;
  playerName: string;
  requestedAt: string;
  status: 'pending' | 'accepted' | 'declined';
  respondedAt?: string;
  responderSessionId?: string;
}

export interface SerializedAct {
  id: string;
  number: number;
  title: string;
  summary: string;
  status: SerializedActStatus;
  beats: SerializedBeat[];
  activationCondition?: string;
  completedAt?: string;
}

export interface SerializedBeat {
  id: string;
  actId: string;
  title: string;
  narrativeDescription: string;
  evaluationCriteria: string;
  kind: SerializedBeatKind;
  status: SerializedBeatStatus;
  evaluation?: SerializedBeatEvaluation;
  npcIds?: string[];
  locationIds?: string[];
  weight: number;
  completedAt?: string;
  activatedAtInteraction?: number;
  missedReason?: string;
}

export interface SerializedBeatEvaluation {
  matched: boolean;
  confidence: number;
  quality: number;
  scoreContribution: number;
  summary: string;
  narrativeBridge: string;
  evaluatedAt: string;
  relevantEventIds: string[];
}

export interface SerializedTimedEvent {
  id: string;
  title: string;
  description: string;
  triggerType: SerializedTimedEventTrigger;
  triggerTime?: number;
  triggerDate?: string;
  triggerDayOffset?: number;
  triggerCount?: number;
  effect: SerializedTimedEventEffect;
  narrativeText: string;
  scoreImpact?: number;
  status: 'pending' | 'triggered' | 'expired';
  triggeredAt?: string;
  unlocksActId?: string;
  unlocksBeatId?: string;
}

export interface SerializedScoreEntry {
  beatId: string;
  beatTitle: string;
  score: number;
  maxScore: number;
  reason: string;
  timestamp: string;
}

export interface SerializedAdventureResult {
  adventureId: string;
  worldId: string;
  title: string;
  spectrumScore: number;
  tierLabel: SerializedSpectrumTier;
  epilogue: string;
  scoreBreakdown: SerializedScoreEntry[];
  medal: QuestMedal;
  achievement: QuestAchievement;
  completedAt: string;
}

export interface PersistentPlayerProfile {
  key: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  lastSessionId: string;
  playerName: string;
  playerAge: number;
  playerGender: string;
  playerOccupation: string;
  playerBackstory: string;
  playerAppearance?: string;
  photoUrl?: string;
  imageUrl?: string;
  avatarUrl?: string;
  portraitUrl?: string;
  playerDepartureStyle?: string;
  strangePossessions?: string[];
  impossibleGiftsGiven?: { npcId: string; gift: string; date: string }[];
  activeGodEffects?: GodEffect[];
  currentDate: string;
  currentTime: number;
  currentMinute?: number;
  currentLocationId: string;
  currentWeather?: CurrentWeather;
  money: number;
  isAlive: boolean;
  socialClass: string;
  reputation: string;
  npcStates: Record<string, PersistentNpcCharacterState>;
  visitedLocations: string[];
  dayCount: number;
  significantEvents: string[];
  objectiveEvents?: ObjectiveEvent[];
  playerVisitLog?: PlayerVisitEntry[];
}

export interface QuestMedal {
  id: string;
  name: string;
  tier: QuestTier;
  questType?: QuestType;
  questId?: string;
  earnedAt: string;
}

export interface QuestAchievement {
  id: string;
  name: string;
  description?: string;
  questId?: string;
  earnedAt: string;
}

export interface QuestFact {
  id: string;
  kind: 'persuasion' | 'discovery' | 'choice' | 'world_state';
  worldId?: string;
  npcId?: string;
  summary: string;
  createdAtTurn?: number;
  createdAt?: string;
}

export type QuestRequirement =
  | { kind: 'medal'; id: string; label?: string }
  | { kind: 'achievement'; id: string; label?: string }
  | { kind: 'quest_fact'; id: string; label?: string }
  | { kind: 'weather'; condition: string; label?: string }
  | { kind: 'player_state'; state: 'invisible' | 'cloaked'; label?: string }
  | { kind: 'impossible_gift'; npcId: string; worldId?: string; giftPattern?: string; label?: string; requestText?: string; hintText?: string };

export type QuestDifficulty = 'easy' | 'normal' | 'hard';

export interface GlobalPlayerProfile {
  id: string;
  pin?: string;
  source?: 'manual' | 'migration';
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  playerName: string;
  playerAge: number;
  playerGender: string;
  playerOccupation: string;
  playerBackstory: string;
  playerAppearance?: string;
  photoUrl?: string;
  imageUrl?: string;
  avatarUrl?: string;
  portraitUrl?: string;
  playerDepartureStyle?: string;
  strangePossessions?: string[];
  medals?: QuestMedal[];
  achievements?: QuestAchievement[];
  questFacts?: QuestFact[];
  questHistory?: QuestEcho[];
  activeQuest?: QuestSessionState;
  retryableQuests?: QuestSessionState[];
  // Adventurer progression - cumulative XP across all sessions. Rank is derived from XP
  // via src/adventurerProgression.ts (Explorer → Quest Master, 10 tiers).
  adventurerXp?: number;
}

export interface PlayerPresence {
  sessionId: string;
  playerProfileKey?: string;
  playerName: string;
  playerOccupation: string;
  playerAppearance?: string;
  photoUrl?: string;
  imageUrl?: string;
  avatarUrl?: string;
  portraitUrl?: string;
  description: string;
  currentLocationId: string;
  currentLocationName?: string;
  currentDate: string;
  currentTime: number;
  currentMinute?: number;
  dayCount: number;
  isActive: boolean;
  isCurrentSession: boolean;
  isSameLocation: boolean;
  canCommunicate: boolean;
}

// ── Quest Episodes ──────────────────────────────────────────────────────────

export type QuestType = 'plague' | 'war' | 'existential';
export type QuestTier = 'Minor' | 'Standard' | 'Major' | 'Epic';
export type QuestStatus = 'available' | 'active' | 'succeeded' | 'failed' | 'abandoned';
export type QuestObjectiveStatus = 'locked' | 'active' | 'complete' | 'failed';
export type QuestScope = 'local' | 'global';

export interface QuestDiscoveryHook {
  id: string;
  status: 'available' | 'accepted' | 'expired';
  templateId: string;
  type: QuestType;
  tier: QuestTier;
  scope?: QuestScope;
  title: string;
  detail: string;
  npcId: string;
  npcName: string;
  locationId: string;
  locationName: string;
  createdAt: string;
  turnOffered: number;
  requirements?: QuestRequirement[];
  rewards?: {
    medals?: Omit<QuestMedal, 'earnedAt'>[];
    achievements?: Omit<QuestAchievement, 'earnedAt'>[];
  };
}

export interface QuestObjective {
  id: string;
  title: string;
  narrative: string;
  kind: 'dialogue' | 'travel' | 'action' | 'choice' | 'persuasion' | 'obtain' | 'obtain_from_npc' | 'obtain_from_location' | 'use_interactable';
  worldId: string;
  npcId?: string;
  npcName?: string;
  locationId?: string;
  locationName?: string;
  status: QuestObjectiveStatus;
  completedAtTurn?: number;
  clueDiscovered?: boolean;
  clueDiscoveredAtTurn?: number;
  clueText?: string;
  clueDetail?: string;
  clueRole?: 'giver' | 'location' | 'gate' | 'confirmation' | 'action';
  clueLabel?: string;
  clueActionText?: string;
  clueAttemptCount?: number;
  clueRevealedTarget?: boolean;
  triedImpossibleGifts?: { gift: string; accepted: boolean; hint: string; judgedAt: string }[];
  lastGiftFeedback?: string;
  lastGiftAccepted?: boolean;
  requiredItemIds?: string[];
  interactableName?: string;
  requirements?: QuestRequirement[];
  emitsFacts?: Omit<QuestFact, 'createdAt' | 'createdAtTurn'>[];
}

export interface QuestPortal {
  id: string;
  fromWorldId: string;
  fromWorldName: string;
  locationId: string;
  locationName: string;
  linkedWorldIds: string[];
  discovered: boolean;
}

export interface QuestTrap {
  id: string;
  type: 'social' | 'false_reward' | 'deception' | 'comfort' | 'loyalty' | 'false_urgency';
  stage: number;
  description: string;
  active: boolean;
  sprung: boolean;
  sprungAtTurn?: number;
  consequence?: string;
  turnPenalty?: number;
}

export interface QuestItem {
  id: string;
  name: string;
  description: string;
  sourceType: 'npc' | 'location';
  sourceId: string;
  sourceName: string;
  worldId: string;
  locationId: string;
  triggerKeywords?: string[];
  collected: boolean;
  collectedAtTurn?: number;
  requiredForObjectiveId?: string;
}

export interface QuestForkWorldSummary {
  worldId: string;
  concept: string;
  currentLocationId: string;
  currentLocationName: string;
  visitedLocationIds: string[];
  locationIds: string[];
  npcIds: string[];
  forkedAtDate: string;
  forkedAtTime: number;
  developments?: string[];
  lastVisitedDevelopmentIndex?: number;
}

export interface QuestParticipantReturn {
  worldId: string;
  locationId: string;
  currentDate: string;
  currentTime: number;
  currentMinute?: number;
  dayCount: number;
  currentWeather?: CurrentWeather;
}

export interface QuestParticipantLocation {
  worldId: string;
  locationId: string;
}

export interface QuestInvitation {
  id: string;
  questId: string;
  questName: string;
  ownerSessionId: string;
  ownerName: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  createdAt: string;
}

export interface QuestSessionState {
  id: string;
  timelineId: string;
  templateId: string;
  type: QuestType;
  tier: QuestTier;
  scope?: QuestScope;
  title?: string;
  detail?: string;
  name: string;
  status: Exclude<QuestStatus, 'available'>;
  difficulty?: QuestDifficulty;
  blockedPortalAttempts?: Record<string, number>;
  revealedPortalAnswers?: Record<string, boolean>;
  retryAvailableAt?: string;
  retryPenalty?: string;
  ownerSessionId: string;
  participantSessionIds: string[];
  hookNpcId: string;
  hookNpcName: string;
  startedAt: string;
  completedAt?: string;
  lastAdvancedAt?: string;
  baseReturn: QuestParticipantReturn;
  participantReturns?: Record<string, QuestParticipantReturn>;
  participantLocations?: Record<string, QuestParticipantLocation>;
  currentWorldId: string;
  currentLocationId: string;
  currentDate?: string;
  currentTime?: number;
  currentMinute?: number;
  dayCount?: number;
  currentWeather?: CurrentWeather;
  forkedWorldIds: string[];
  forkedWorlds: Record<string, QuestForkWorldSummary>;
  forkedWorldData?: Record<string, WorldDNA>;
  baseWorldIdsByForkId?: Record<string, string>;
  npcIdMapsByForkWorldId?: Record<string, Record<string, string>>;
  portals: QuestPortal[];
  objectives: QuestObjective[];
  turnCounter: number;
  estimatedTurns: number;
  deadlineTurns: number;
  urgencyStage: number;
  urgencyLabel: string;
  urgencyNarrative: string;
  traps: QuestTrap[];
  inventory: QuestItem[];
  successEcho: string;
  failureEcho: string;
  resolutionEcho?: string;
  requirements?: QuestRequirement[];
  rewards?: {
    medals?: Omit<QuestMedal, 'earnedAt'>[];
    achievements?: Omit<QuestAchievement, 'earnedAt'>[];
  };
  questFacts?: QuestFact[];
  log: string[];
}

export interface QuestEcho {
  id: string;
  questId: string;
  questName: string;
  status: 'succeeded' | 'failed' | 'abandoned';
  message: string;
  createdAt: string;
}

// ── World Session (player's save) ───────────────────────────────────────────

export interface WorldSession {
  id: string;
  worldId: string;
  globalPlayerId?: string;
  playerProfileKey?: string;
  lastActiveAt?: string;
  playerName: string;
  playerAge: number;
  playerGender: string;
  playerOccupation: string;
  playerBackstory: string;
  playerAppearance?: string;
  photoUrl?: string;
  imageUrl?: string;
  avatarUrl?: string;
  portraitUrl?: string;
  playerDepartureStyle?: string;
  strangePossessions?: string[];
  impossibleGiftsGiven?: { npcId: string; gift: string; date: string }[];
  activeGodEffects?: GodEffect[];
  
  // Current state
  currentDate: string;
  currentTime: number;                 // hour 0-23
  currentMinute?: number;              // minute 0-59
  clockStartedAt?: string;             // real timestamp anchoring the in-world clock
  lastClockSyncAt?: string;            // real timestamp last converted into world minutes
  currentLocationId: string;
  currentWeather?: CurrentWeather;
  money: number;
  isAlive: boolean;
  
  // Player's own life
  socialClass: string;
  reputation: string;                  // community perception
  
  // Player behavioral profiling
  playerVisitLog?: PlayerVisitEntry[];

  // NPC states
  npcStates: Record<string, NPCLiveState>;
  
  // History
  visitedLocations: string[];
  dayCount: number;
  significantEvents: string[];         // things that happened to the player
  feedEvents?: SessionFeedEvent[];     // Observatory feed entries shown between loads
  objectiveEvents?: ObjectiveEvent[];
  questHooks?: QuestDiscoveryHook[];
  questInvites?: QuestInvitation[];
  activeQuest?: QuestSessionState;
  activeWorldQuest?: WorldQuestAdventure;
  completedWorldQuests?: WorldQuestAdventure[];
  worldQuestInventory?: { questId: string; item: string; locationId?: string; foundAt: string }[];
  worldQuestMedals?: QuestMedal[];
  questEchoes?: QuestEcho[];
  retryableQuests?: QuestSessionState[];
  medals?: QuestMedal[];
  achievements?: QuestAchievement[];
  questFacts?: QuestFact[];

  // Serialized adventures
  activeSerializedAdventure?: SerializedAdventure;
  completedSerializedAdventures?: SerializedAdventureResult[];
  serializedAdventureMedals?: QuestMedal[];
  // Adventurer progression (player XP + rank). XP is granted on beat / adventure / milestone
  // completion by src/adventurerProgression.ts. Rank is a computed property derived from XP.
  adventurerXp?: number;
  adventurerXpEarnedAt?: string; // last time XP was awarded - used by HUD to animate toast

  // Community state
  communityMood: string;
  activeGossip: GossipItem[];
  contagionEvents?: BeliefContagionEvent[];
  recentCommunityEvents: string[];
}

export interface SessionFeedEvent {
  t: string;
  ty: string;
  x: string;
}

export interface DramaLead {
  id: string;
  type: 'promise' | 'approach' | 'rumor' | 'scandal' | 'affair' | 'argument' | 'lie' | 'trickery' | 'tension' | 'goal' | 'opportunity' | 'place' | 'explore' | 'quest';
  title: string;
  detail: string;
  urgency: number;
  tone: 'warm' | 'tense' | 'mysterious' | 'practical' | 'danger';
  npcId?: string;
  npcName?: string;
  locationId?: string;
  locationName?: string;
  actionLabel: string;
  command: string;
}

export interface ConsequenceSummary {
  type: 'relationship' | 'trust' | 'warmth' | 'promise' | 'gossip' | 'scandal' | 'accusation' | 'lie' | 'trickery' | 'provocation' | 'interpretation' | 'memory' | 'reputation' | 'gift';
  label: string;
  detail: string;
  severity: 'positive' | 'negative' | 'neutral' | 'warning';
}

export interface WorldAdvanceRecap {
  title: string;
  bullets: string[];
  leads: DramaLead[];
}

// ── NPC Simulation Tick ─────────────────────────────────────────────────────
// What happens to NPCs between player interactions

export interface SimulationTick {
  npcId: string;
  date: string;
  timeOfDay: string;
  
  // Where are they now
  locationId: string;
  activity: string;
  
  // What happened to them
  moodChange?: string;
  lifeEvent?: string;
  gossipExchanged?: GossipItem[];
  relationshipChanges?: { npcId: string; delta: number; reason: string }[];
  
  // New thoughts
  newConcern?: string;
  newGoal?: string;
  opinionShifts?: Record<string, string>;
}

// ── Player Behavioral Profiling ────────────────────────────────────────────

export interface PlayerVisitEntry {
  locationId: string;
  npcId?: string;       // NPC talked to, if any
  date: string;
  timeOfDay: string;
  interactionCount: number;  // how many talks at this location in this visit
}

// ── Environmental Awareness ────────────────────────────────────────────────

export interface EnvironmentalAwareness {
  knownScarcities: string[];           // resources NPC knows are scarce
  recentArrivals: string[];            // new people NPC has noticed
  recentDepartures: string[];          // people who left
  locationChanges: string[];           // physical changes to locations noticed
  lastWeatherReaction: string;         // how weather is affecting their behavior
}

export interface BodyHabitState {
  bladder: number;
  bowel: number;
  regularity: number;
  privacyNeed: number;
  shameSensitivity: number;
  stressSensitivity: number;
  avoidance: number;
  lastToiletAt?: string;
  lastBowelAt?: string;
  lastAccidentAt?: string;
  lastNote?: string;
  recentEvents?: string[];
  toiletVisits?: { date: string; timeOfDay: string; locationId: string; reason: string; bladderBefore: number; bowelBefore: number; privacyStress: number }[];
  bowelMovements?: { date: string; timeOfDay: string; locationId: string; reason: string; bowelBefore: number; psychologicalTrigger?: string }[];
}

// ── NPC-Initiated Contact ──────────────────────────────────────────────────

export interface NPCApproach {
  reason: 'urgent_news' | 'gossip' | 'warning' | 'request' | 'emotional_need' | 'gift' | 'confrontation';
  message: string;           // what they want to say/do
  urgency: number;           // 0-100
  generatedAt: string;       // date when this was generated
  openingLine?: string;      // prepared opening line
}

// ── Promise/Favor Economy ──────────────────────────────────────────────────

export interface NPCRequest {
  id: string;
  description: string;       // what the NPC is asking for
  reason: string;            // why they need it
  madeOnDate: string;
  status: 'pending' | 'fulfilled' | 'refused' | 'expired';
  importanceToNPC: number;   // 0-100
  trustRequiredToAsk: number; // minimum trust level needed before NPC will ask
  reciprocalOffer?: string;  // what NPC offers in return
}

// ── Emotional Contagion ────────────────────────────────────────────────────

export interface EmotionalContagionEntry {
  fromNpcId: string;
  emotion: string;
  intensity: number;        // 0-1
  date: string;
  timeOfDay: string;
}

// ── Dream System ───────────────────────────────────────────────────────────

export interface NPCDream {
  id: string;
  date: string;
  content: string;              // what happened in the dream
  sourceRuminationId?: string;  // which rumination thread inspired it
  sourceMemoryId?: string;      // which memory it connects to
  emotionalTone: string;
  processedInsight?: string;    // what the NPC "learned" from the dream
  mentionedInDialogue: boolean; // has the NPC brought this up yet
}

// ── Conflicting Loyalties ──────────────────────────────────────────────────

export interface LoyaltyConflict {
  id: string;
  npcIdA: string;              // person A they care about
  npcIdB: string;              // person B they care about
  description: string;         // nature of the conflict
  tension: number;             // 0-100
  sideChosen?: string;         // npcId if they've picked a side
  startedDate: string;
  resolvedDate?: string;
}
