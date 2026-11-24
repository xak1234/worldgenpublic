import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { WorldDNA } from './types';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';
const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w780';

interface TMDBSource {
  id: number;
  title: string;
  kind: 'movie' | 'tv';
  year: number;
  backdropPath?: string;
  posterPath?: string;
}

async function downloadImage(url: string, dest: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    if (!r.ok) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    return true;
  } catch {
    return false;
  }
}

async function fetchTMDBFilm(
  title: string,
  apiKey: string,
  year?: number
): Promise<TMDBSource | null> {
  const q = encodeURIComponent(title);
  const movieUrl = `${TMDB_API_BASE}/search/movie?api_key=${apiKey}&query=${q}${year ? `&year=${year}` : ''}`;
  const tvUrl = `${TMDB_API_BASE}/search/tv?api_key=${apiKey}&query=${q}${year ? `&first_air_date_year=${year}` : ''}`;

  try {
    const [mRes, tRes] = await Promise.all([fetch(movieUrl), fetch(tvUrl)]);
    const mData = (await mRes.json()) as any;
    const tData = (await tRes.json()) as any;

    const mResult = mData.results?.[0];
    const tResult = tData.results?.[0];

    // Prefer movie if both exist
    const best = mResult || tResult;
    if (!best) return null;

    return {
      id: best.id,
      title: best.title || best.name,
      kind: mResult ? 'movie' : 'tv',
      year: new Date(best.release_date || best.first_air_date).getFullYear(),
      backdropPath: best.backdrop_path,
      posterPath: best.poster_path,
    };
  } catch {
    return null;
  }
}

export async function resolveCover(
  world: WorldDNA,
  sourceTitle: string | null,
  apiKey: string | null,
  generatedDir: string,
  log: (msg: string) => void = () => {},
  force = false,
): Promise<boolean> {
  const w = world as any;
  w.images = w.images ?? {};

  // Manual covers are sacred
  if (w.images.coverSource === 'manual') {
    log('[cover] manual cover preserved');
    return false;
  }

  // [WG-IMAGES-IMMUTABLE] Never overwrite an existing cover unless explicitly forced.
  // This protects both /covers/<id>.jpg (committed) and /generated/<id>/cover.jpg
  // (build-time output). Use POST /api/worlds/:id/images { clearCover: true } to reset first.
  if (!force && w.images.cover) {
    log(`[cover] preserved (images.cover already set: ${w.images.cover})`);
    return false;
  }

  // If no source or no API key, skip TMDB lookup
  if (!sourceTitle || !apiKey) {
    log('[cover] no source title or API key - skipping TMDB cover');
    return false;
  }

  // Lookup film on TMDB
  const source = await fetchTMDBFilm(sourceTitle, apiKey);
  if (!source) {
    log(`[cover] TMDB: no match for "${sourceTitle}"`);
    return false;
  }

  // Has TMDB match but no backdrop/poster
  if (!source.backdropPath && !source.posterPath) {
    log('[cover] TMDB match found but no artwork available');
    return false;
  }

  // Download the image
  const useBackdrop = Boolean(source.backdropPath);
  const imagePath = useBackdrop ? source.backdropPath : source.posterPath;
  const url = useBackdrop ? `${TMDB_BACKDROP_BASE}${imagePath}` : `${TMDB_POSTER_BASE}${imagePath}`;
  const dest = join(generatedDir, world.id, 'cover.jpg');

  // [WG-IMAGES-IMMUTABLE] Even if images.cover isn't set, don't clobber a file on disk.
  if (!force && existsSync(dest)) {
    log('[cover] preserved (cover.jpg already on disk for ' + world.id + ')');
    return false;
  }

  const ok = await downloadImage(url, dest);
  if (!ok) {
    log(`[cover] TMDB image download failed: ${url}`);
    return false;
  }

  // Update world
  w.images.cover = `/generated/${world.id}/cover.jpg`;
  w.images.coverSource = 'tmdb';
  w.images.coverKind = useBackdrop ? 'backdrop' : 'poster';
  log(`[cover] TMDB ${source.kind}/${source.year} ${w.images.coverKind} set as cover`);
  return true;
}
