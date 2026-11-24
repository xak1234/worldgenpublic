/**
 * Resource & Scarcity Engine
 * Some worlds hand you everything. Some make you fight for a meal.
 * The world concept determines the resource model.
 */

import type { WorldDNA } from './types.js';

// ── World Resource Profile ──────────────────────────────────────────────────

export interface ResourceProfile {
  scarcityLevel: ScarcityLevel;
  
  // Basic needs
  food: ResourceAvailability;
  shelter: ResourceAvailability;
  clothing: ResourceAvailability;
  healthcare: ResourceAvailability;
  
  // Social needs
  employment: ResourceAvailability;
  socialAccess: ResourceAvailability;      // can you enter places, join groups
  information: ResourceAvailability;       // news, gossip, knowledge
  safety: ResourceAvailability;
  
  // Advancement
  money: ResourceAvailability;
  education: ResourceAvailability;
  connections: ResourceAvailability;       // who you know
  reputation: ResourceAvailability;        // social standing
  
  // How resources are obtained
  acquisitionMethods: AcquisitionMethod[];
  
  // Welfare / support systems
  safetyNet: string;                       // what happens when you have nothing
  charity: string;                         // do people help each other
  institutions: string[];                  // churches, workhouses, shelters, etc
}

export type ScarcityLevel = 
  | 'abundant'         // post-scarcity, everything provided (utopian commune, wealthy district)
  | 'comfortable'      // most things available with moderate effort
  | 'modest'           // you work for what you get, but it's manageable
  | 'tight'            // paycheck to paycheck, one setback away from trouble
  | 'scarce'           // daily struggle, things are hard to come by
  | 'desperate'        // survival mode, nothing guaranteed
  | 'hostile';         // the world actively works against you

export interface ResourceAvailability {
  level: 'free' | 'easy' | 'available' | 'effort' | 'difficult' | 'scarce' | 'unavailable';
  description: string;           // what getting this actually looks like
  cost: number;                  // in world currency, 0 = free
  socialRequirement?: string;    // "must know someone", "must be local", "must have papers"
  classRestriction?: string;     // "working class only", "upper class privilege"
}

export interface AcquisitionMethod {
  name: string;                  // "work", "beg", "steal", "barter", "charm", "intimidate"
  description: string;
  risk: number;                  // 0-1
  socialCost: string;            // reputation impact
  availability: string;          // when/where this works
}

// ── Player Resource State ───────────────────────────────────────────────────

export interface PlayerResources {
  money: number;
  hasHome: boolean;
  homeQuality: 'none' | 'rough' | 'basic' | 'decent' | 'comfortable' | 'good';
  isEmployed: boolean;
  jobTitle?: string;
  jobPay?: number;
  
  // Needs tracking (0-100, 100 = fully met)
  hunger: number;
  warmth: number;
  rest: number;
  cleanliness: number;
  health: number;
  
  // Social capital
  reputation: number;            // -100 to 100
  knownBy: string[];             // NPC IDs who recognise you
  welcomeAt: string[];           // location IDs where you're accepted
  bannedFrom: string[];          // location IDs where you're not welcome
  
  // Possessions
  inventory: InventoryItem[];
}

export interface InventoryItem {
  id: string;
  name: string;
  type: 'clothing' | 'food' | 'tool' | 'document' | 'valuable' | 'personal' | 'key';
  description: string;
  value: number;
  condition: 'new' | 'good' | 'worn' | 'poor' | 'broken';
  socialSignal?: string;         // what carrying this says about you ("marks you as working class")
}

// ── Resource profile generation ─────────────────────────────────────────────

export function deriveResourceProfile(world: WorldDNA): ResourceProfile {
  // The scarcity level emerges from the world's economy, era, and social structure
  const avgWage = world.economy.averageDailyWage;
  const prices = world.economy.prices;
  let corruption = world.law?.corruption ?? 0;
  if (corruption > 1) corruption = corruption > 10 ? corruption / 100 : corruption / 10; // normalize to 0-1

  // Calculate affordability ratio
  const essentialCosts = Object.entries(prices)
    .filter(([item]) => isEssential(item))
    .reduce((sum, [, cost]) => sum + (cost as number), 0);
  
  const affordabilityRatio = essentialCosts > 0 ? avgWage / essentialCosts : 5;
  
  let scarcityLevel: ScarcityLevel;
  if (affordabilityRatio > 4) scarcityLevel = 'abundant';
  else if (affordabilityRatio > 2.5) scarcityLevel = 'comfortable';
  else if (affordabilityRatio > 1.5) scarcityLevel = 'modest';
  else if (affordabilityRatio > 1) scarcityLevel = 'tight';
  else if (affordabilityRatio > 0.6) scarcityLevel = 'scarce';
  else if (affordabilityRatio > 0.3) scarcityLevel = 'desperate';
  else scarcityLevel = 'hostile';
  
  // Adjust for corruption — high corruption makes everything harder
  if (corruption > 0.7 && scarcityLevel !== 'hostile') {
    const levels: ScarcityLevel[] = ['abundant', 'comfortable', 'modest', 'tight', 'scarce', 'desperate', 'hostile'];
    const idx = levels.indexOf(scarcityLevel);
    scarcityLevel = levels[Math.min(idx + 1, levels.length - 1)];
  }

  return {
    scarcityLevel,
    food: buildResourceAvailability('food', scarcityLevel, world),
    shelter: buildResourceAvailability('shelter', scarcityLevel, world),
    clothing: buildResourceAvailability('clothing', scarcityLevel, world),
    healthcare: buildResourceAvailability('healthcare', scarcityLevel, world),
    employment: buildResourceAvailability('employment', scarcityLevel, world),
    socialAccess: buildResourceAvailability('socialAccess', scarcityLevel, world),
    information: buildResourceAvailability('information', scarcityLevel, world),
    safety: buildResourceAvailability('safety', scarcityLevel, world),
    money: buildResourceAvailability('money', scarcityLevel, world),
    education: buildResourceAvailability('education', scarcityLevel, world),
    connections: buildResourceAvailability('connections', scarcityLevel, world),
    reputation: buildResourceAvailability('reputation', scarcityLevel, world),
    acquisitionMethods: buildAcquisitionMethods(scarcityLevel, world),
    safetyNet: deriveSafetyNet(scarcityLevel, world),
    charity: deriveCharity(world),
    institutions: deriveInstitutions(world),
  };
}

// ── Need decay ──────────────────────────────────────────────────────────────
// Needs drop over time. How fast depends on the world's scarcity.

export interface NeedDecayRates {
  hunger: number;       // points lost per game-hour
  warmth: number;
  rest: number;
  cleanliness: number;
  health: number;
}

export function getNeedDecayRates(scarcity: ScarcityLevel, weather: string): NeedDecayRates {
  const base: NeedDecayRates = {
    hunger: 2,
    warmth: 1,
    rest: 1.5,
    cleanliness: 0.5,
    health: 0.2,
  };

  // Harsher worlds = faster decay
  const multipliers: Record<ScarcityLevel, number> = {
    abundant: 0.5,
    comfortable: 0.7,
    modest: 1.0,
    tight: 1.2,
    scarce: 1.5,
    desperate: 2.0,
    hostile: 2.5,
  };
  
  const mult = multipliers[scarcity];
  
  // Weather affects warmth decay
  const coldWeather = weather.toLowerCase().includes('cold') || 
    weather.toLowerCase().includes('rain') || 
    weather.toLowerCase().includes('snow') ||
    weather.toLowerCase().includes('frost');
  
  return {
    hunger: base.hunger * mult,
    warmth: base.warmth * mult * (coldWeather ? 1.8 : 1),
    rest: base.rest * mult,
    cleanliness: base.cleanliness * mult,
    health: base.health * mult,
  };
}

// ── Consequences of unmet needs ─────────────────────────────────────────────

export interface NeedConsequence {
  need: string;
  threshold: number;        // below this level, consequence kicks in
  effect: string;            // narrative description
  socialImpact: string;      // how NPCs react
  mechanicalImpact: string;  // what changes gameplay-wise
}

export function getNeedConsequences(): NeedConsequence[] {
  return [
    { need: 'hunger', threshold: 30, effect: 'Your stomach aches. Concentration slips.', socialImpact: 'People notice you look drawn.', mechanicalImpact: 'NPC interactions feel more desperate; some NPCs offer food.' },
    { need: 'hunger', threshold: 10, effect: 'Weakness sets in. The world narrows to one need.', socialImpact: 'Strangers avoid you. Friends worry.', mechanicalImpact: 'Movement slows. Some locations refuse entry.' },
    { need: 'warmth', threshold: 30, effect: 'Cold seeps into your bones. Shivering is constant.', socialImpact: 'People pity or avoid.', mechanicalImpact: 'Health decays faster.' },
    { need: 'rest', threshold: 20, effect: 'Exhaustion blurs everything. Conversations drift.', socialImpact: 'People think you seem ill.', mechanicalImpact: 'NPC dialogue quality drops — you mishear things.' },
    { need: 'cleanliness', threshold: 25, effect: 'You smell it yourself now.', socialImpact: 'Upper-class NPCs refuse to talk. Others keep distance.', mechanicalImpact: 'Social access restricted. Some locations bar entry.' },
    { need: 'health', threshold: 30, effect: 'Something is wrong. Pain or weakness dogs every step.', socialImpact: 'Kind NPCs urge you to rest or see someone.', mechanicalImpact: 'All activities take longer. Need decay accelerates.' },
  ];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isEssential(item: string): boolean {
  const essentials = ['bread', 'food', 'meal', 'rent', 'room', 'lodging', 'beer', 'milk', 'coal', 'wood', 'candle'];
  return essentials.some(e => item.toLowerCase().includes(e));
}

function buildResourceAvailability(
  resource: string, 
  scarcity: ScarcityLevel, 
  world: WorldDNA
): ResourceAvailability {
  const levelMap: Record<ScarcityLevel, string> = {
    abundant: 'free',
    comfortable: 'easy',
    modest: 'available',
    tight: 'effort',
    scarce: 'difficult',
    desperate: 'scarce',
    hostile: 'unavailable',
  };
  
  // Some resources are harder to get than others regardless of scarcity
  const hardResources = ['healthcare', 'education', 'connections'];
  const level = hardResources.includes(resource)
    ? shiftLevel(levelMap[scarcity] as any, 1)
    : levelMap[scarcity];

  return {
    level: level as any,
    description: `${resource} in ${world.geography.region} during ${world.era.period}`,
    cost: 0,
  };
}

function shiftLevel(level: string, shift: number): string {
  const levels = ['free', 'easy', 'available', 'effort', 'difficult', 'scarce', 'unavailable'];
  const idx = levels.indexOf(level);
  if (idx === -1) return level;
  return levels[Math.min(idx + shift, levels.length - 1)];
}

function buildAcquisitionMethods(scarcity: ScarcityLevel, world: WorldDNA): AcquisitionMethod[] {
  const methods: AcquisitionMethod[] = [
    { name: 'work', description: 'Earn through honest labour', risk: 0, socialCost: 'none', availability: 'requires employment' },
    { name: 'barter', description: 'Trade goods or favours', risk: 0.1, socialCost: 'depends on what you trade', availability: 'anywhere social' },
    { name: 'charm', description: 'Talk your way into things', risk: 0.2, socialCost: 'reputation risk if seen through', availability: 'social situations' },
    { name: 'beg', description: 'Ask for help directly', risk: 0.1, socialCost: 'reputation drops significantly', availability: 'public spaces' },
    { name: 'steal', description: 'Take what isn\'t yours', risk: 0.7, socialCost: 'severe if caught', availability: 'anywhere with opportunity' },
    { name: 'hustle', description: 'Work the grey economy', risk: 0.4, socialCost: 'mixed — respected by some, despised by others', availability: 'underground contacts needed' },
  ];
  
  // Scarcer worlds unlock more desperate methods
  if (scarcity === 'abundant' || scarcity === 'comfortable') {
    return methods.slice(0, 3);
  }
  if (scarcity === 'desperate' || scarcity === 'hostile') {
    methods.push({ 
      name: 'intimidate', 
      description: 'Use fear to take what you need', 
      risk: 0.8, 
      socialCost: 'feared and avoided — some NPCs will never speak to you again', 
      availability: 'against weaker individuals' 
    });
  }
  
  return methods;
}

function deriveSafetyNet(scarcity: ScarcityLevel, world: WorldDNA): string {
  if (scarcity === 'abundant') return 'The community provides. Nobody goes without.';
  if (scarcity === 'comfortable') return 'There are systems in place — nobody starves if they know where to look.';
  if (scarcity === 'modest') return 'You can get help, but you have to ask, and asking costs dignity.';
  if (scarcity === 'tight') return 'The safety net has holes. Fall through and you\'re on your own.';
  if (scarcity === 'scarce') return 'There is no safety net. There is only what you can scrape together and who owes you a favour.';
  return 'Nothing. You survive or you don\'t.';
}

function deriveCharity(world: WorldDNA): string {
  if (world.culture.religion && world.culture.religion !== 'none') {
    return `The ${world.culture.religion.split(' ')[0]} community sometimes helps, but charity comes with obligations and judgment.`;
  }
  return 'Individual kindness exists but is unreliable. Don\'t count on it.';
}

function deriveInstitutions(world: WorldDNA): string[] {
  const institutions: string[] = [];
  const era = world.era.period.toLowerCase();
  
  if (era.includes('victorian') || era.includes('19th') || era.includes('1800')) {
    institutions.push('workhouse', 'parish relief', 'charitable hospital');
  } else if (era.includes('20th') || era.includes('1900') || (/\b19\d{2}\b/.test(era) && !era.includes('19th'))) {
    institutions.push('social services', 'council housing office', 'job centre');
  } else if (era.includes('medieval') || era.includes('renaissance')) {
    institutions.push('church alms', 'guild hall', 'monastery');
  }
  
  if (world.culture.religion && world.culture.religion !== 'none') {
    institutions.push('church/temple', 'religious charity');
  }
  
  return institutions.length > 0 ? institutions : ['none — you are on your own'];
}
