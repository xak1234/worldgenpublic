/**
 * Population Planner
 * The world concept determines everything: how many people, what variety,
 * age distribution, gender balance, ethnic mix, class spread, social density.
 * A rural hamlet and a city district are fundamentally different simulations.
 */

import { llmJSON } from './llm.js';

// ── Population Blueprint ────────────────────────────────────────────────────
// Generated BEFORE individual NPCs — this shapes the entire community.

export interface PopulationBlueprint {
  // Scale
  totalPopulation: number;           // how many NPCs to generate
  populationDensity: 'isolated' | 'sparse' | 'village' | 'town' | 'urban' | 'dense_urban';
  communityType: string;             // "tight-knit mining village", "anonymous city district"
  
  // Demographics
  ageDistribution: AgeGroup[];
  genderBalance: GenderBalance;
  ethnicComposition: EthnicGroup[];
  classDistribution: ClassSpread[];
  
  // Social fabric
  familyStructures: string[];        // "nuclear families", "extended clans", "lodgers", "single workers"
  socialCohesion: number;            // 0-100: how connected is the community
  outsiderFrequency: string;         // how often strangers appear
  newcomerReception: string;         // how newcomers are treated
  
  // Occupation spread
  occupationCategories: OccupationCategory[];
  unemploymentRate: number;          // 0-1
  
  // Power dynamics
  powerStructure: string;            // "flat", "patriarchal", "matriarchal", "class-stratified", "gang-controlled"
  influentialRoles: string[];        // "publican", "priest", "foreman", "landlord"
  
  // Variety and personality
  personalitySpread: PersonalitySpread;
  requiredArchetypes: string[];      // roles that MUST exist: "gossip", "loner", "newcomer", "authority figure"
  
  // Relationship density
  averageRelationshipsPerPerson: number;
  romancePresent: boolean;
  rivalriesPresent: boolean;
  secretsPerPerson: number;          // average
  
  // Reasoning
  reasoning: string;                 // why these choices for this concept
}

export interface AgeGroup {
  range: string;                     // "18-25", "26-40", etc
  label: string;                     // "young adults", "middle-aged"
  percentage: number;                // 0-100
  count: number;                     // actual number of NPCs in this range
  socialRole: string;                // what this age group does in this community
}

export interface GenderBalance {
  male: number;                      // percentage
  female: number;
  other: number;
  reasoning: string;                 // "mining town = male-heavy workforce"
}

export interface EthnicGroup {
  name: string;
  percentage: number;
  count: number;
  socialPosition: string;            // how this group is positioned in the community
  tensions: string;                  // any friction with other groups
}

export interface ClassSpread {
  className: string;
  percentage: number;
  count: number;
  power: number;                     // 0-100 relative power
  locations: string[];               // where this class lives/works
}

export interface OccupationCategory {
  category: string;                  // "manual labour", "trade", "service", "criminal"
  examples: string[];                // specific jobs
  count: number;
  payRange: string;
  socialStatus: string;
}

export interface PersonalitySpread {
  warmToHostile: string;             // "mostly warm, few hostile" — the community's general temperament
  trustLevel: string;                // "suspicious of outsiders" / "welcoming"
  humorPresent: boolean;
  darknessLevel: string;             // how much darkness exists under the surface
  volatility: string;                // how likely people are to blow up
  requiredPersonalities: string[];   // specific personality types that MUST be represented
}

// ── Generate the blueprint ──────────────────────────────────────────────────

export async function generatePopulationBlueprint(
  concept: string,
  era: string,
  geography: string,
  culture: any,
  economy: any,
  provider: string,
  model?: string,
  npcCount?: number,
): Promise<PopulationBlueprint> {
  const populationGuidance = npcCount
    ? `The user has requested exactly ${npcCount} NPCs. Set totalPopulation to ${npcCount}.`
    : 'A tiny rural village might have 6-10 people who all know each other\'s business. A city district might have 20-30 where anonymity is possible. A prison has a fixed population. A commune has shared everything. A frontier town has mostly young men. A Victorian household has servants and masters. Let the concept drive every decision.';
  const totalPopulationHint = npcCount ? `number (must be ${npcCount})` : 'number (6-12, based on concept)';
  return llmJSON({
    provider,
    model,
    maxTokens: 8192,
    temperature: 0.85,
    jsonMode: true,
    system: PLANNER_SYSTEM,
    user: `World concept: "${concept}"
Era: ${era}
Region: ${geography}
Language/dialect: ${culture.language} / ${culture.dialect}
Social classes: ${culture.socialClasses?.map((c: any) => c.name).join(', ') || 'not yet defined'}
Average daily wage: ${economy.averageDailyWage} ${economy.currency}
Known jobs: ${economy.jobs?.map((j: any) => j.title).join(', ') || 'not yet defined'}

Based on this concept, decide EVERYTHING about the population. How many people should exist in this simulation? What does the community look like? Who lives here? What's the age spread, the gender balance, the ethnic mix, the class structure? How connected are people? How do they treat outsiders?

${populationGuidance}

Return the full PopulationBlueprint as JSON:
{
  "totalPopulation": ${totalPopulationHint},
  "populationDensity": "isolated"|"sparse"|"village"|"town"|"urban"|"dense_urban",
  "communityType": string,
  "ageDistribution": [{ "range": string, "label": string, "percentage": number, "count": number, "socialRole": string }],
  "genderBalance": { "male": number, "female": number, "other": number, "reasoning": string },
  "ethnicComposition": [{ "name": string, "percentage": number, "count": number, "socialPosition": string, "tensions": string }],
  "classDistribution": [{ "className": string, "percentage": number, "count": number, "power": number, "locations": string[] }],
  "familyStructures": string[],
  "socialCohesion": number (0-100),
  "outsiderFrequency": string,
  "newcomerReception": string,
  "occupationCategories": [{ "category": string, "examples": string[], "count": number, "payRange": string, "socialStatus": string }],
  "unemploymentRate": number (0-1),
  "powerStructure": string,
  "influentialRoles": string[],
  "personalitySpread": {
    "warmToHostile": string,
    "trustLevel": string,
    "humorPresent": boolean,
    "darknessLevel": string,
    "volatility": string,
    "requiredPersonalities": string[]
  },
  "requiredArchetypes": string[],
  "averageRelationshipsPerPerson": number,
  "romancePresent": boolean,
  "rivalriesPresent": boolean,
  "secretsPerPerson": number,
  "reasoning": string (2-3 sentences explaining why these population choices fit this specific concept)
}`,
  });
}

const PLANNER_SYSTEM = `You are a population architect for life simulations. Your job is to decide the SIZE, COMPOSITION, and SOCIAL FABRIC of a community based on a world concept. You don't create individual people yet — you create the blueprint that determines what KIND of people will exist and HOW MANY.

Your decisions must be grounded in reality:
- A 1970s Yorkshire mining village: 8-12 people, mostly working class, male-heavy workforce, tight-knit, suspicious of outsiders, everyone related or connected through the pit
- 1920s Chicago South Side: 25-30 people, ethnically diverse, class-stratified, some anonymity possible, gang influence, high volatility
- Victorian servant household: 10-15 people, extreme class divide (3-4 upstairs, rest below stairs), rigid hierarchy, intimate proximity with social distance
- Medieval plague village: 6-10 people, survivors, mixed ages skewing older (young died), communal grief, religious fervour, suspicion
- 1980s Miami: 20-25 people, Latino/Anglo/Caribbean mix, wealth extremes, drug economy blurring class lines, high mobility
- Cold War Berlin: 15-20 people, divided loyalties, paranoia, informers, age spread with war survivors and post-war youth
- A commune: 12-18 people, intentionally egalitarian, shared resources, mixed backgrounds, ideological unity with personal friction

Key principles:
- Population size must match the setting's scale and intimacy level
- The demographic breakdown must feel historically and culturally accurate
- Required archetypes ensure the simulation has social dynamics (gossip, conflict, authority, vulnerability, humour, danger)
- Every community needs at least one person the player can easily talk to and one who's hard to reach
- Secrets and rivalries create depth — even "nice" communities have undercurrents
- The reasoning field should explain WHY these specific choices create the best simulation for this concept`;
