import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { WorldDNA } from './types.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_STILL_BASE = 'https://image.tmdb.org/t/p/w780';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';
const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w780';

export interface CastMember {
  id: number;
  character: string;
  actor: string;
  profileUrl: string | null;
  order: number;
}

export interface CastLookupOutcome {
  source: { id: number; title: string; year: string; kind: 'movie' | 'tv' } | null;
  cast: CastMember[];
  matches: { npcId: string; npcName: string; character: string; actor: string; score: number }[];
}

function norm(s: string): string {
  return String(s ?? '').toLowerCase()
    .replace(/^(mr|mrs|ms|miss|dr|sir|lord|lady|sr|jr)\.?\s+/i, '')
    .replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return norm(s).split(' ').filter(Boolean);
}

const ROLE_TOKENS = new Set([
  'agent', 'captain', 'chief', 'colonel', 'commander', 'count', 'deputy', 'detective',
  'doctor', 'dr', 'father', 'general', 'governor', 'inspector', 'judge', 'king',
  'lady', 'lieutenant', 'lord', 'lt', 'madame', 'madam', 'major', 'miss', 'mother',
  'mr', 'mrs', 'ms', 'officer', 'president', 'prince', 'princess', 'professor',
  'queen', 'reverend', 'sergeant', 'sheriff', 'sir', 'sister', 'warden',
]);

const NAME_ALIASES: Record<string, string[]> = {
  alex: ['alexander', 'alexandra'],
  andy: ['andrew'],
  beth: ['elizabeth'],
  betty: ['elizabeth'],
  bill: ['william'],
  billy: ['william'],
  bob: ['robert'],
  bobby: ['robert'],
  charlie: ['charles'],
  chuck: ['charles'],
  dave: ['david'],
  davy: ['david'],
  dick: ['richard'],
  ed: ['edward', 'edmund', 'edwin'],
  eddie: ['edward', 'edmund', 'edwin'],
  frank: ['francis', 'franklin'],
  fred: ['frederick'],
  harry: ['harold', 'henry'],
  jack: ['john'],
  jim: ['james'],
  jimmy: ['james'],
  joe: ['joseph'],
  joey: ['joseph'],
  johnny: ['john'],
  kate: ['katherine', 'catherine'],
  kathy: ['katherine', 'catherine'],
  liz: ['elizabeth'],
  maggie: ['margaret'],
  meg: ['margaret'],
  mike: ['michael'],
  micky: ['michael'],
  mick: ['michael'],
  nick: ['nicholas'],
  pat: ['patrick', 'patricia'],
  pete: ['peter'],
  rob: ['robert'],
  robbie: ['robert'],
  sam: ['samuel', 'samantha'],
  steve: ['steven', 'stephen'],
  tom: ['thomas'],
  tommy: ['thomas'],
  tony: ['anthony'],
  will: ['william'],
  willy: ['william'],
};

function equivalentToken(a: string, b: string): boolean {
  return (NAME_ALIASES[a]?.includes(b) ?? false) || (NAME_ALIASES[b]?.includes(a) ?? false);
}

function tokenMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (equivalentToken(a, b)) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  // Diminutive prefix only when shorter is <=4 chars (Ed/Tom/Cam/Will/Tony);
  // prevents Steve(5) being matched to Stevens(7) as a nickname.
  if (shorter.length >= 2 && shorter.length <= 4 && longer.startsWith(shorter)) return true;
  return false;
}

function identityTokens(name: string): string[] {
  return tokens(name)
    .filter(t => !ROLE_TOKENS.has(t))
    .filter(t => !/^(voice|cameo|uncredited|archive|footage|himself|herself)$/.test(t));
}

function tokenSetSubset(shorter: string[], longer: string[]): boolean {
  return shorter.length > 0 && shorter.every(t => longer.some(u => tokenMatch(t, u)));
}

function scoreNames(npcName: string, character: string): number {
  const a = identityTokens(npcName);
  const b = identityTokens(character);
  if (!a.length || !b.length) return 0;
  if (norm(npcName) === norm(character)) return 1.0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (tokenSetSubset(shorter, longer)) return shorter.length === longer.length ? 1.0 : 0.92;
  const aLast = a[a.length - 1];
  const bLast = b[b.length - 1];
  const aFirst = a[0];
  const bFirst = b[0];
  const lastMatch = tokenMatch(aLast, bLast);
  const firstMatch = tokenMatch(aFirst, bFirst);
  if (lastMatch && firstMatch) return 0.95;
  // Surname-only is unsafe when both sides have conflicting forenames:
  // Fester Addams must not resolve to Gomez Addams just because the family name matches.
  if (lastMatch && (a.length === 1 || b.length === 1) && aLast.length >= 4 && bLast.length >= 4) return 0.85;
  // Single-name cast char (e.g. 'Elliott', 'Mary') against multi-token NPC (e.g. 'Elliott Taylor')
  if (firstMatch && (a.length === 1 || b.length === 1) && Math.min(aFirst.length, bFirst.length) >= 4) return 0.85;
  if (firstMatch && a.length === 1 && b.length === 1 && aFirst.length >= 4) return 0.8;
  let overlap = 0;
  for (const t of a) for (const u of b) if (tokenMatch(t, u)) { overlap++; break; }
  if (overlap >= 2) return 0.75;
  return 0;
}

export function cleanSourceTitle(raw: string): string {
  return String(raw ?? '')
    .replace(/[\(\[].*?[\)\]]/g, '')
    .replace(/[_]+/g, ' ')
    // strip common source-doc suffixes that tank TMDB queries
    .replace(/\s*[\-\u2013\u2014:|]\s*(full\s*text|shooting\s*script|screenplay|script|transcript|dialogue\s*transcript|the\s*movie|film|movie|book|novel|wikipedia)\s*$/i, '')
    .replace(/\s*[\-\u2013\u2014:|]\s*(full\s*text|shooting\s*script|screenplay|script|transcript|dialogue\s*transcript|the\s*movie|film|movie|book|novel|wikipedia)\s*$/i, '')
    // strip trailing year hint when it's the only thing left like "Title 1985"
    // (keep title; year alone is acceptable but TMDB ranks better without it)
    .replace(/\s+\(?(19|20)\d{2}\)?\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchTmdb(kind: 'movie' | 'tv', query: string, apiKey: string, year?: number): Promise<any | null> {
  try {
    // Year hint locks the search to a specific release year - critical for franchises
    // (Hellraiser 1987 vs 2022 remake, Blade Runner 1982 vs 2049, etc.).
    let url = `${TMDB_BASE}/search/${kind}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(query)}`;
    if (year && year > 1800 && year < 2200) {
      url += kind === 'movie' ? `&year=${year}` : `&first_air_date_year=${year}`;
    }
    const r = await fetch(url);
    if (!r.ok) return null;
    const j: any = await r.json();
    return (j.results || [])[0] || null;
  } catch { return null; }
}

async function fetchCredits(kind: 'movie' | 'tv', id: number | string, apiKey: string): Promise<CastMember[]> {
  try {
    const r = await fetch(`${TMDB_BASE}/${kind}/${id}/credits?api_key=${encodeURIComponent(apiKey)}`);
    if (!r.ok) return [];
    const j: any = await r.json();
    return (j.cast || []).map((c: any, i: number): CastMember => ({
      id: Number(c.id) || 0,
      character: String(c.character || ''),
      actor: String(c.name || ''),
      profileUrl: c.profile_path ? `${TMDB_IMG_BASE}${c.profile_path}` : null,
      order: typeof c.order === 'number' ? c.order : i,
    }));
  } catch { return []; }
}

async function searchTmdbBest(kind: 'movie' | 'tv', query: string, apiKey: string, year?: number): Promise<any | null> {
  const candidates: any[] = [];
  const r1 = await searchTmdb(kind, query, apiKey, year);
  if (r1) candidates.push(r1);
  // For short uppercase titles (ET, AI, RV, ...), also try period-separated (E.T., A.I.)
  const lettersOnly = query.replace(/[^A-Za-z]/g, '');
  if (lettersOnly.length >= 2 && lettersOnly.length <= 4 && lettersOnly === lettersOnly.toUpperCase()) {
    const dotted = lettersOnly.split('').join('.') + '.';
    const r2 = await searchTmdb(kind, dotted, apiKey, year);
    if (r2 && r2.id !== r1?.id) candidates.push(r2);
  }
  candidates.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  return candidates[0] || null;
}

export async function fetchTMDBCast(rawTitle: string, apiKey: string, year?: number): Promise<{ source: CastLookupOutcome['source']; cast: CastMember[] } | null> {
  const q = cleanSourceTitle(rawTitle);
  if (!q) return null;
  let hit = await searchTmdbBest('movie', q, apiKey, year);
  let kind: 'movie' | 'tv' = 'movie';
  if (!hit) {
    hit = await searchTmdbBest('tv', q, apiKey, year);
    kind = 'tv';
  }
  if (!hit) return null;
  const cast = await fetchCredits(kind, hit.id, apiKey);
  return {
    source: {
      id: hit.id,
      title: hit.title || hit.name || '',
      year: String(hit.release_date || hit.first_air_date || '').slice(0, 4),
      kind,
      backdropPath: hit.backdrop_path || null,
      posterPath: hit.poster_path || null,
    } as any,
    cast,
  };
}

/**
 * Find an in-character still of `personId` from a specific `mediaId`.
 * Uses TMDB's tagged_images endpoint. Returns null on failure or empty result
 * so callers can fall back to the clean profile shot.
 */
async function fetchActorInMediaStill(
  personId: number,
  mediaId: number,
  mediaType: 'movie' | 'tv',
  apiKey: string,
): Promise<{ file_path: string; aspect_ratio: number; vote_average: number; image_type: string } | null> {
  if (!personId || !mediaId || !apiKey) return null;
  type TaggedImage = {
    file_path: string;
    aspect_ratio: number;
    width: number;
    height: number;
    vote_average: number;
    vote_count: number;
    image_type: 'backdrop' | 'poster' | 'profile';
    media: { id: number; media_type: 'movie' | 'tv' };
  };
  const all: TaggedImage[] = [];
  try {
    for (let page = 1; page <= 3; page++) {
      const r = await fetch(`${TMDB_BASE}/person/${personId}/tagged_images?api_key=${encodeURIComponent(apiKey)}&page=${page}`);
      if (!r.ok) break;
      const j: any = await r.json();
      const results: TaggedImage[] = j.results || [];
      all.push(...results);
      if (page >= (j.total_pages ?? 1)) break;
    }
  } catch { return null; }
  const matches = all
    .filter(i => i.media?.id === mediaId && i.media?.media_type === mediaType)
    .filter(i => {
      if (!i.file_path) return false;
      if (i.image_type === 'profile') return true;
      const ratio = Number(i.aspect_ratio || (i.width && i.height ? i.width / i.height : 0));
      return ratio > 0.45 && ratio < 1.35;
    })
    .sort((a, b) => {
      const score = (i: TaggedImage) =>
        (i.image_type === 'profile' ? 10 : i.image_type === 'poster' ? 6 : 0) +
        (Number(i.height || 0) >= 900 ? 2 : 0) +
        (i.vote_average ?? 0) +
        Math.min(i.vote_count ?? 0, 20) / 20;
      return score(b) - score(a);
    });
  if (!matches.length) return null;
  const top = matches[0];
  return {
    file_path: top.file_path,
    aspect_ratio: top.aspect_ratio,
    vote_average: top.vote_average ?? 0,
    image_type: top.image_type,
  };
}

async function downloadImage(url: string, dest: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    if (!r.ok) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    return true;
  } catch { return false; }
}

// Cover image resolution moved to orchestrator (coverResolver.ts)

export async function applyCastImagesToWorld(
  world: WorldDNA,
  rawTitle: string,
  apiKey: string,
  generatedDir: string,
  log: (msg: string) => void = () => {},
  year?: number
): Promise<CastLookupOutcome> {
  const out: CastLookupOutcome = { source: null, cast: [], matches: [] };
  if (!apiKey) { log(`[cast] skipped - no TMDB_API_KEY`); return out; }
  const lookup = await fetchTMDBCast(rawTitle, apiKey, year);
  if (!lookup || !lookup.source) { log(`[cast] TMDB: no match for "${cleanSourceTitle(rawTitle)}"${year ? ` (year=${year})` : ''}`); return out; }
  out.source = lookup.source;
  out.cast = lookup.cast;
  log(`[cast] TMDB matched: ${lookup.source.title} (${lookup.source.year}, ${lookup.source.kind}) - ${lookup.cast.length} cast`);

  const usable = lookup.cast.filter(c =>
    c.character &&
    c.profileUrl &&
    !/(uncredited|himself|herself|various|narrator)/i.test(c.character)
  );

  const w = world as any;
  w.images = w.images ?? {};
  w.images.portraits = w.images.portraits ?? {};
  w.images.portraitSources = w.images.portraitSources ?? {};

  // Snapshot the existing portraitSources BEFORE wiping. Manual portraits are sacrosanct -
  // cast-rematch must never overwrite Pinhead-the-user-uploaded with Doug-Bradley-headshot.
  const existingSources = (w.images?.portraitSources ?? {}) as Record<string, { kind?: string }>;
  // Wipe prior TMDB portraits before re-matching. Without this, switching source films
  // (Hellraiser 1987 -> 2022 reboot) leaves orphan portraits from the previous cast mixed
  // in with the new one - a Doug Bradley face stuck on the world after a Jamie Clayton match.
  // Only TMDB-sourced portraits are wiped before re-matching. 'manual' (user
  // uploads) and 'arcface' (ArcFace pipeline crops) are protected and survive a
  // rematch — they are never deleted here.
  let wipedTmdb = 0;
  for (const npcId of Object.keys(existingSources)) {
    if (existingSources[npcId]?.kind === 'tmdb') {
      delete w.images.portraits[npcId];
      delete w.images.portraitSources[npcId];
      wipedTmdb++;
    }
  }
  for (const npc of (world.npcs || [])) {
    const npcAny = npc as any;
    const nid = String(npcAny.id || '');
    if (nid && existingSources[nid]?.kind === 'tmdb' && npcAny.images?.portrait) {
      delete npcAny.images.portrait;
    }
  }
  if (wipedTmdb > 0) log(`[cast] wiped ${wipedTmdb} stale TMDB portrait(s) before re-matching`);

  const candidates: { npc: any; member: CastMember; score: number }[] = [];
  for (const npc of (world.npcs || [])) {
    const npcAny = npc as any;
    const npcName = npcAny.name || `${npcAny.firstName || ''} ${npcAny.lastName || ''}`.trim();
    if (!npcName) continue;
    for (const c of usable) {
      const s = scoreNames(npcName, c.character);
      if (s >= 0.7) candidates.push({ npc, member: c, score: s });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const claimedNpcs = new Set<string>();
  const usedActors = new Set<string>();
  // Dedup by normalized character name too - prevents two NPCs both getting Pinhead
  // assigned different actor credits (sequel/reboot cast bleed within one cast list).
  const claimedCharacters = new Set<string>();
  let stillCount = 0;
  let profileCount = 0;
  for (const cand of candidates) {
    const npcId = String(cand.npc.id || '');
    if (!npcId || claimedNpcs.has(npcId)) continue;
    if (existingSources[npcId]?.kind === 'manual' || existingSources[npcId]?.kind === 'arcface') {
      log(`[cast] skipping ${npcId} - protected portrait (kind:${existingSources[npcId]?.kind})`);
      claimedNpcs.add(npcId);
      continue;
    }
    const actorKey = cand.member.actor + '|' + cand.member.character;
    if (usedActors.has(actorKey)) continue;
    const charKey = norm(cand.member.character);
    if (charKey && claimedCharacters.has(charKey)) continue;

    let imageUrl = cand.member.profileUrl!;
    let imageType: 'still' | 'profile' = 'profile';
    let aspectRatio: number | undefined;
    let imageVote: number | undefined;
    const still = (lookup.source && cand.member.id)
      ? await fetchActorInMediaStill(cand.member.id, lookup.source.id, lookup.source.kind, apiKey)
      : null;
    if (still) {
      imageUrl = `${TMDB_STILL_BASE}${still.file_path}`;
      imageType = 'still';
      aspectRatio = still.aspect_ratio;
      imageVote = still.vote_average;
    }

    const safe = npcId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || `npc_${Math.random().toString(36).slice(2, 8)}`;
    const dest = join(generatedDir, world.id, `${safe}.jpg`);
    const ok = await downloadImage(imageUrl, dest);
    if (!ok) continue;
    const url = `/generated/${world.id}/${safe}.jpg`;
    w.images.portraits[npcId] = url;
    w.images.portraitSources[npcId] = {
      kind: 'tmdb',
      character: cand.member.character,
      actor: cand.member.actor,
      score: cand.score,
      imageType,
      ...(aspectRatio !== undefined ? { aspectRatio } : {}),
      ...(imageVote !== undefined ? { imageVote } : {}),
    };
    cand.npc.images = cand.npc.images ?? {};
    cand.npc.images.portrait = url;
    out.matches.push({
      npcId,
      npcName: cand.npc.name || '',
      character: cand.member.character,
      actor: cand.member.actor,
      score: cand.score,
    });
    claimedNpcs.add(npcId);
    usedActors.add(actorKey);
    if (charKey) claimedCharacters.add(charKey);
    if (imageType === 'still') stillCount++; else profileCount++;
  }

  const total = (world.npcs || []).length;
  log(`[cast] matched ${out.matches.length}/${total} NPCs to TMDB cast (${stillCount} in-character stills, ${profileCount} profile fallbacks)`);
  if (out.matches.length) {
    const head = out.matches.slice(0, 6).map(m => `${m.npcName}->${m.actor}`).join(', ');
    log(`[cast]   ${head}${out.matches.length > 6 ? `, +${out.matches.length - 6} more` : ''}`);
  }
  if (out.matches.length > 0 && out.matches.length < total) {
    w.images.status = 'partial';
  }

  // Set the world cover from TMDB backdrop/poster (overwrites only AI/empty covers, never manual)
  try {
    // Cover resolution now handled by orchestrator (coverResolver.ts)
  } catch (e: any) {
    log(`[cover] error: ${e?.message || String(e)}`);
  }

  return out;
}
