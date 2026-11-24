export const PIPELINE_RESULT_SENTINEL = 'PIPELINE_RESULT_JSON=';

export interface PipelineSwap {
  npcId: string;
  npcName: string;
  character: string;
  actor: string;
  score: number;
  w: number;
  h: number;
  crop: string;
  targetUrl?: string;
  applied: boolean;
}

export interface PipelineCastPortrait {
  actor: string;
  character: string;
  order: number;
  imageUrl: string;
  source: string;
  tmdbPersonId?: number;
  profilePath?: string;
  applied: boolean;
}

export interface PipelineResult {
  world: string;
  buildId: string;
  source: string;
  skipped: string | null;
  film?: { tmdb: number; imdb: string; title: string; year: string; mediaType?: 'movie' | 'tv' };
  swaps: PipelineSwap[];
  castPortraits: PipelineCastPortrait[];
  skippedSwaps: { character: string; reason: string }[];
}

/** Extract and parse the PIPELINE_RESULT_JSON sentinel line from script stdout. */
export function parsePipelineResult(stdout: string): PipelineResult | null {
  const line = stdout.split(/\r?\n/).reverse().find(l => l.startsWith(PIPELINE_RESULT_SENTINEL));
  if (!line) return null;
  let raw: any;
  try {
    raw = JSON.parse(line.slice(PIPELINE_RESULT_SENTINEL.length));
  } catch {
    return null;
  }
  return {
    world: String(raw.world ?? ''),
    buildId: String(raw.buildId ?? ''),
    source: String(raw.source ?? ''),
    skipped: raw.skipped ?? null,
    film: raw.film,
    swaps: Array.isArray(raw.swaps_detail) ? raw.swaps_detail.map((s: any): PipelineSwap => ({
      npcId: String(s.npcId ?? ''),
      npcName: String(s.npcName ?? ''),
      character: String(s.character ?? ''),
      actor: String(s.actor ?? ''),
      score: Number(s.score ?? 0),
      w: Number(s.w ?? 0),
      h: Number(s.h ?? 0),
      crop: String(s.crop ?? ''),
      targetUrl: typeof s.targetUrl === 'string' ? s.targetUrl : undefined,
      applied: Boolean(s.applied),
    })) : [],
    castPortraits: Array.isArray(raw.cast_portraits) ? raw.cast_portraits.map((c: any): PipelineCastPortrait => ({
      actor: String(c.actor ?? ''),
      character: String(c.character ?? ''),
      order: Number(c.order ?? 0),
      imageUrl: String(c.imageUrl ?? ''),
      source: String(c.source ?? ''),
      tmdbPersonId: Number.isFinite(Number(c.tmdbPersonId)) ? Number(c.tmdbPersonId) : undefined,
      profilePath: typeof c.profilePath === 'string' ? c.profilePath : undefined,
      applied: Boolean(c.applied),
    })).filter((c: PipelineCastPortrait) => c.actor && c.imageUrl) : [],
    skippedSwaps: Array.isArray(raw.skipped_swaps) ? raw.skipped_swaps.map((s: any) => ({
      character: String(s.character ?? ''),
      reason: String(s.reason ?? ''),
    })) : [],
  };
}

/** Append/replace a ?v=<version> cache-bust on a portrait URL. */
export function withCacheBust(url: string, version: number): string {
  const base = url.replace(/([?&])v=\d+/i, '').replace(/[?&]$/, '');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}v=${version}`;
}

/**
 * Apply a pipeline result to a world object IN PLACE. For each applied swap,
 * mark portraitSources[npcId] as kind:'arcface', cache-bust the portrait URL,
 * and update the npc's images.portrait. Returns the npc ids that were applied.
 */
export function applyPipelineResult(world: any, result: PipelineResult, ranAt: number): { appliedNpcIds: string[] } {
  const appliedNpcIds: string[] = [];
  world.images = world.images ?? {};
  world.images.portraits = world.images.portraits ?? {};
  world.images.portraitSources = world.images.portraitSources ?? {};
  const npcsById = new Map<string, any>((world.npcs ?? []).map((n: any) => [String(n.id ?? ''), n]));

  const castPortraits = result.castPortraits
    .filter(c => c.applied && c.actor && c.imageUrl)
    .map(c => ({
      actor: c.actor,
      character: c.character,
      order: c.order,
      imageUrl: withCacheBust(c.imageUrl, ranAt),
      source: c.source,
      tmdbPersonId: c.tmdbPersonId,
      profilePath: c.profilePath,
    }));
  if (castPortraits.length) world.images.castPortraits = castPortraits;

  for (const swap of result.swaps) {
    if (!swap.applied || !swap.npcId) continue;
    const source = world.images.portraitSources[swap.npcId];
    if (source && source.kind === 'manual') continue;
    const npc = npcsById.get(swap.npcId);
    const currentUrl = world.images.portraits[swap.npcId] || npc?.images?.portrait || swap.targetUrl;
    if (!currentUrl) continue; // pipeline overwrote a file we can't locate in world state; skip
    const bustedUrl = withCacheBust(String(currentUrl), ranAt);
    world.images.portraits[swap.npcId] = bustedUrl;
    world.images.portraitSources[swap.npcId] = {
      kind: 'arcface',
      character: swap.character,
      actor: swap.actor,
      score: swap.score,
      w: swap.w,
      h: swap.h,
      source: result.source,
      ranAt: new Date(ranAt).toISOString(),
    };
    if (npc) {
      npc.images = npc.images ?? {};
      npc.images.portrait = bustedUrl;
    }
    appliedNpcIds.push(swap.npcId);
  }
  return { appliedNpcIds };
}
