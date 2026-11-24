import type { CurrentWeather, WorldDNA } from './types.js';

const CONDITIONS = [
  'clear', 'bright sun', 'pale sun', 'overcast', 'low cloud', 'mist', 'fog',
  'drizzle', 'steady rain', 'hard rain', 'downpour', 'hail', 'sleet', 'snow',
  'flurries', 'frost', 'humid heat', 'dry heat', 'gusting wind', 'thunderstorm',
  'sheet lightning', 'forked lightning', 'storm front',
];

const INTENSITIES: CurrentWeather['intensity'][] = ['clear', 'light', 'moderate', 'heavy', 'severe', 'violent'];

export function initialWeather(world: WorldDNA, date: string, hour: number): CurrentWeather {
  return buildWeather(world, date, hour, undefined, true);
}

export function advanceWeather(world: WorldDNA, current: CurrentWeather | undefined, date: string, hour: number, hoursAdvanced: number): CurrentWeather {
  const weather = current ?? initialWeather(world, date, hour);
  const lastChanged = parseChangedAt(weather.changedAt);
  const lastPeriod = lastChanged ? weatherPeriodKey(world, lastChanged.hour) : undefined;
  const nextPeriod = weatherPeriodKey(world, hour);
  if (lastPeriod === nextPeriod) return weather;
  return buildWeather(world, date, periodStartHour(world, hour), weather, false);
}

export function describeWeather(weather: CurrentWeather | undefined, world: WorldDNA): string {
  if (!weather) return world.weather.dominantWeather;
  const storm = weather.thunder || weather.lightning
    ? `, ${weather.thunder ? 'thunder' : ''}${weather.thunder && weather.lightning ? ' and ' : ''}${weather.lightning ? 'lightning' : ''}`
    : '';
  return `${weather.intensity} ${weather.condition}${storm}; ${weather.wind}; ${weather.visibility}; ${weather.temperatureC}C`;
}

export function weatherWorldEffects(weather: CurrentWeather | undefined): {
  scene: string;
  movement: string;
  npcReaction: string;
  feed: string;
  tags: string[];
} {
  if (!weather) return { scene: '', movement: '', npcReaction: '', feed: '', tags: [] };
  const condition = weather.condition.toLowerCase();
  const harsh = ['heavy', 'severe', 'violent'].includes(weather.intensity);
  const tags = ['weather', weather.condition, weather.intensity, weather.precipitation].filter(Boolean);
  if (/fog|mist/.test(condition) || /poor|whiteout|collapsing/.test(weather.visibility)) {
    return {
      scene: 'Edges soften; distant figures and exits are harder to read.',
      movement: harsh ? 'The poor visibility slows every crossing.' : 'The air makes the route feel uncertain.',
      npcReaction: 'The poor visibility makes people watch silhouettes before faces.',
      feed: 'Weather pressure: visibility is shaping movement and recognition.',
      tags,
    };
  }
  if (/rain|downpour|drizzle/.test(condition) || weather.precipitation === 'rain' || weather.precipitation === 'drizzle') {
    return {
      scene: 'Surfaces shine wetly, clothes darken at the shoulders, and doorways matter more.',
      movement: harsh ? 'Rain makes travel slower, colder, and more exposed.' : 'Rain follows every step indoors.',
      npcReaction: 'The rain makes people hurry, complain, and cluster under cover.',
      feed: 'Weather pressure: rain is pushing people toward shelter.',
      tags,
    };
  }
  if (/storm|thunder|lightning/.test(condition) || weather.thunder || weather.lightning) {
    return {
      scene: 'The air feels charged; light and sound keep interrupting the room.',
      movement: 'The storm makes every open route feel risky.',
      npcReaction: 'The storm has people raising voices, flinching, and checking the sky.',
      feed: 'Weather pressure: storm noise is changing how people act.',
      tags,
    };
  }
  if (/snow|sleet|frost|hail/.test(condition) || ['snow', 'sleet', 'hail'].includes(weather.precipitation)) {
    return {
      scene: 'Cold collects on surfaces and makes the world quieter, sharper, and less forgiving.',
      movement: harsh ? 'Cold and slick ground make travel slow and careful.' : 'The cold changes how long anyone wants to linger.',
      npcReaction: 'The cold makes people conserve warmth and shorten conversations outside.',
      feed: 'Weather pressure: cold is changing movement and patience.',
      tags,
    };
  }
  if (/heat|sun/.test(condition) || Number(weather.temperatureC) >= 28) {
    return {
      scene: 'Heat sits on the skin and turns shade into valuable territory.',
      movement: harsh ? 'The heat drains energy from every crossing.' : 'The warmth makes people slower and thirstier.',
      npcReaction: 'The heat frays patience and pulls people toward shade.',
      feed: 'Weather pressure: heat is affecting tempers and stamina.',
      tags,
    };
  }
  if (/wind|gust/.test(condition) || /gust|lashing|restless/.test(weather.wind)) {
    return {
      scene: 'Wind moves through loose things first: signs, coats, curtains, voices.',
      movement: harsh ? 'The wind fights exposed routes.' : 'The wind keeps tugging at clothes and sound.',
      npcReaction: 'The wind makes people turn their bodies away while speaking.',
      feed: 'Weather pressure: wind is making exposed places harder to read.',
      tags,
    };
  }
  return {
    scene: 'The weather is ordinary enough that people stop naming it, but it still colors the hour.',
    movement: '',
    npcReaction: '',
    feed: '',
    tags,
  };
}

export function controlledWeather(
  world: WorldDNA,
  date: string,
  hour: number,
  input: Partial<CurrentWeather> & { condition?: string; temperatureC?: number },
): CurrentWeather {
  const rng = seededRandom(`${world.id}:${date}:${hour}:controlled:${input.condition ?? 'weather'}`);
  const condition = typeof input.condition === 'string' && input.condition.trim()
    ? input.condition.trim().slice(0, 60)
    : 'clear';
  const intensity = INTENSITIES.includes(input.intensity as CurrentWeather['intensity'])
    ? input.intensity as CurrentWeather['intensity']
    : chooseIntensity(rng, condition, /storm|thunder|lightning/.test(condition));
  const thunder = typeof input.thunder === 'boolean' ? input.thunder : /thunder|storm/.test(condition);
  const lightning = typeof input.lightning === 'boolean' ? input.lightning : /lightning|thunder|storm/.test(condition);
  const precipitation = input.precipitation ?? choosePrecipitation(condition);

  return {
    condition,
    intensity,
    temperatureC: Number.isFinite(input.temperatureC) ? Math.round(input.temperatureC as number) : chooseTemperature(rng, getMonth(date), {
      cold: /snow|sleet|frost|ice/.test(condition),
      hot: /heat|sun|humid/.test(condition),
    }, intensity),
    wind: input.wind || chooseWind(rng, /wind|storm|thunder|lightning/.test(condition), intensity),
    visibility: input.visibility || chooseVisibility(condition, intensity),
    precipitation,
    thunder,
    lightning,
    mood: input.mood || chooseMood(condition, intensity, thunder, lightning),
    effects: input.effects?.length ? input.effects.slice(0, 4) : chooseEffects(condition, intensity, thunder, lightning),
    changedAt: `${date} ${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`,
  };
}

function buildWeather(world: WorldDNA, date: string, hour: number, previous?: CurrentWeather, initial = false): CurrentWeather {
  const month = getMonth(date);
  const season = world.weather.seasons.find(s => s.months.includes(month));
  const climate = `${world.geography.climate} ${world.weather.dominantWeather} ${season?.weather ?? ''}`.toLowerCase();
  const rng = seededRandom(`${world.id}:${date}:${hour}:${previous?.condition ?? 'start'}`);

  const stormy = /storm|thunder|monsoon|cyclone|hurricane|typhoon|tempest|squall/.test(climate);
  const wet = stormy || /rain|wet|drizzle|mist|fog|humid|maritime|coastal|monsoon/.test(climate);
  const cold = /cold|snow|sleet|frost|ice|arctic|alpine|winter/.test(climate) || [12, 1, 2].includes(month);
  const hot = /hot|desert|tropical|humid|summer|arid/.test(climate) || [6, 7, 8].includes(month);
  const windy = /wind|coast|moor|plain|storm|exposed/.test(climate);

  const changeChance = initial ? 1 : stormy ? 0.55 : wet ? 0.38 : 0.22;
  const keepPrevious = previous && rng() > changeChance;
  const condition = keepPrevious ? previous.condition : chooseCondition(rng, { stormy, wet, cold, hot, windy });
  const intensity = chooseIntensity(rng, condition, stormy);
  const precipitation = choosePrecipitation(condition);
  const lightning = /lightning|thunderstorm|storm front/.test(condition) || (stormy && ['heavy', 'severe', 'violent'].includes(intensity) && rng() > 0.45);
  const thunder = /thunder|storm/.test(condition) || (lightning && rng() > 0.25);

  return {
    condition,
    intensity,
    temperatureC: chooseTemperature(rng, month, { cold, hot }, intensity),
    wind: chooseWind(rng, windy || stormy, intensity),
    visibility: chooseVisibility(condition, intensity),
    precipitation,
    thunder,
    lightning,
    mood: chooseMood(condition, intensity, thunder, lightning, season?.atmosphere),
    effects: chooseEffects(condition, intensity, thunder, lightning, season?.npcBehaviourShift),
    changedAt: `${date} ${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`,
  };
}

function chooseCondition(rng: () => number, flags: { stormy: boolean; wet: boolean; cold: boolean; hot: boolean; windy: boolean }): string {
  const pool = ['clear', 'pale sun', 'overcast', 'low cloud'];
  if (flags.wet) pool.push('mist', 'fog', 'drizzle', 'steady rain', 'hard rain', 'downpour');
  if (flags.cold) pool.push('frost', 'sleet', 'snow', 'flurries');
  if (flags.hot) pool.push('bright sun', 'humid heat', 'dry heat');
  if (flags.windy) pool.push('gusting wind', 'storm front');
  if (flags.stormy) pool.push('thunderstorm', 'sheet lightning', 'forked lightning', 'hail');
  return pool[Math.floor(rng() * pool.length)] ?? CONDITIONS[0];
}

function chooseIntensity(rng: () => number, condition: string, stormy: boolean): CurrentWeather['intensity'] {
  if (condition === 'clear' || condition.includes('sun')) return rng() > 0.75 ? 'moderate' : 'light';
  if (/thunder|lightning|storm|downpour|hail/.test(condition)) return INTENSITIES[3 + Math.floor(rng() * (stormy ? 3 : 2))] ?? 'heavy';
  if (/fog|rain|snow|wind/.test(condition)) return INTENSITIES[1 + Math.floor(rng() * 4)] ?? 'moderate';
  return INTENSITIES[Math.floor(rng() * 3)] ?? 'light';
}

function choosePrecipitation(condition: string): CurrentWeather['precipitation'] {
  if (/mist|fog/.test(condition)) return 'mist';
  if (/drizzle/.test(condition)) return 'drizzle';
  if (/rain|downpour|thunder|storm|lightning/.test(condition)) return 'rain';
  if (/hail/.test(condition)) return 'hail';
  if (/sleet/.test(condition)) return 'sleet';
  if (/snow|flurries/.test(condition)) return 'snow';
  return 'none';
}

function chooseTemperature(rng: () => number, month: number, flags: { cold: boolean; hot: boolean }, intensity: string): number {
  const seasonal = [12, 1, 2].includes(month) ? 3 : [3, 4, 5].includes(month) ? 11 : [6, 7, 8].includes(month) ? 20 : 12;
  const climateShift = flags.cold ? -8 : flags.hot ? 10 : 0;
  const stormShift = ['heavy', 'severe', 'violent'].includes(intensity) ? -2 : 0;
  return Math.round(seasonal + climateShift + stormShift + (rng() * 8 - 4));
}

function chooseWind(rng: () => number, windy: boolean, intensity: string): string {
  if (['severe', 'violent'].includes(intensity)) return rng() > 0.5 ? 'violent gusts' : 'wind lashing through the streets';
  if (windy || intensity === 'heavy') return rng() > 0.5 ? 'strong gusts' : 'restless wind';
  if (intensity === 'clear') return 'still air';
  return rng() > 0.5 ? 'light breeze' : 'barely moving air';
}

function chooseVisibility(condition: string, intensity: string): string {
  if (/fog|mist/.test(condition)) return ['heavy', 'severe', 'violent'].includes(intensity) ? 'near whiteout visibility' : 'poor visibility';
  if (/downpour|snow|hail|storm/.test(condition)) return ['severe', 'violent'].includes(intensity) ? 'visibility collapsing' : 'reduced visibility';
  return 'clear visibility';
}

function chooseMood(condition: string, intensity: string, thunder: boolean, lightning: boolean, seasonAtmosphere?: string): string {
  if (thunder || lightning) return 'charged and unnerving';
  if (['severe', 'violent'].includes(intensity)) return 'hostile and exposed';
  if (/rain|drizzle|fog|mist/.test(condition)) return 'muted and damp';
  if (/snow|frost/.test(condition)) return 'hushed and brittle';
  if (/heat|sun/.test(condition)) return 'bright and tiring';
  return seasonAtmosphere ?? 'ordinary';
}

function chooseEffects(condition: string, intensity: string, thunder: boolean, lightning: boolean, npcShift?: string): string[] {
  const effects: string[] = [];
  if (thunder) effects.push('thunder makes people flinch or raise their voices');
  if (lightning) effects.push('lightning draws eyes to windows and doorways');
  if (/rain|downpour|drizzle/.test(condition)) effects.push('people hurry indoors and arrive wet');
  if (/fog|mist/.test(condition)) effects.push('distant figures are hard to recognise');
  if (/snow|sleet|frost/.test(condition)) effects.push('cold changes how long people linger outside');
  if (/heat|sun/.test(condition)) effects.push('tempers tire faster in the heat');
  if (['severe', 'violent'].includes(intensity)) effects.push('travel feels risky');
  if (npcShift) effects.push(npcShift);
  return effects.slice(0, 4);
}

function getMonth(date: string): number {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? 7 : parsed.getUTCMonth() + 1;
}

function parseChangedAt(changedAt?: string): { hour: number } | undefined {
  const match = String(changedAt ?? '').match(/^(\S+)\s+(\d{1,2}):/);
  if (!match) return undefined;
  return { hour: normalizeHour(Number(match[2])) };
}

function weatherPeriodKey(world: WorldDNA, hour: number): string {
  return periodName(world, hour);
}

function periodName(world: WorldDNA, hour: number): string {
  const safeHour = normalizeHour(hour);
  for (const period of world.timeOfDay?.periods ?? []) {
    const start = normalizeHour(period.hourStart);
    const end = normalizeHour(period.hourEnd);
    const inPeriod = start < end
      ? safeHour >= start && safeHour < end
      : safeHour >= start || safeHour < end;
    if (inPeriod && period.name) return period.name;
  }
  if (safeHour < 5) return 'night';
  if (safeHour < 12) return 'morning';
  if (safeHour < 17) return 'afternoon';
  if (safeHour < 21) return 'evening';
  return 'night';
}

function periodStartHour(world: WorldDNA, hour: number): number {
  const safeHour = normalizeHour(hour);
  for (const period of world.timeOfDay?.periods ?? []) {
    const start = normalizeHour(period.hourStart);
    const end = normalizeHour(period.hourEnd);
    const inPeriod = start < end
      ? safeHour >= start && safeHour < end
      : safeHour >= start || safeHour < end;
    if (inPeriod) return start;
  }
  if (safeHour < 5) return 0;
  if (safeHour < 12) return 5;
  if (safeHour < 17) return 12;
  if (safeHour < 21) return 17;
  return 21;
}

function normalizeHour(hour: number): number {
  return ((Math.floor(Number.isFinite(hour) ? hour : 0) % 24) + 24) % 24;
}

function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
