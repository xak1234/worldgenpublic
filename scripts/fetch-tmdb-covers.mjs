#!/usr/bin/env node
/**
 * fetch-tmdb-covers.mjs
 *
 * Pulls cover artwork for every world (or one specific world) from TMDB and
 * stores it under public/covers/{worldId}.jpg.
 *
 * Usage:
 *   node scripts/fetch-tmdb-covers.mjs                    # all worlds, skip existing, skip manual
 *   node scripts/fetch-tmdb-covers.mjs --force            # overwrite existing covers
 *   node scripts/fetch-tmdb-covers.mjs --dry-run          # show what would be done
 *   node scripts/fetch-tmdb-covers.mjs --world <id>       # only one world
 *   node scripts/fetch-tmdb-covers.mjs --update-world     # write images.cover into world JSON
 *   node scripts/fetch-tmdb-covers.mjs --include-manual   # also retry worlds with coverSource=manual
 *
 * TMDB_API_KEY can come from .env (read directly) or process.env.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DATA_DIR = join(REPO_ROOT, 'data');
const COVERS_DIR = join(REPO_ROOT, 'public', 'covers');

const TMDB_API = 'https://api.themoviedb.org/3';
const BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';
const POSTER_BASE = 'https://image.tmdb.org/t/p/w780';

// ---- CLI ----
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argv = (f) => {
  const i = args.indexOf(f);
  return i >= 0 && i < args.length - 1 ? args[i + 1] : null;
};
const FORCE = has('--force');
const DRY_RUN = has('--dry-run');
const ONLY_WORLD = argv('--world');
const UPDATE_WORLD = has('--update-world');
const INCLUDE_MANUAL = has('--include-manual');
const CONCURRENCY = parseInt(argv('--concurrency') || '4', 10);

// ---- read TMDB key from env or .env ----
function loadApiKey() {
  if (process.env.TMDB_API_KEY) return process.env.TMDB_API_KEY;
  const envPath = join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return null;
  const env = readFileSync(envPath, 'utf8');
  const m = env.match(/^TMDB_API_KEY\s*=\s*([^\s#]+)/m);
  return m ? m[1].trim() : null;
}

const TMDB_API_KEY = loadApiKey();
if (!TMDB_API_KEY) {
  console.error('[fatal] TMDB_API_KEY not found (set in .env or environment)');
  process.exit(1);
}

// ---- Manual title overrides (typos, author suffixes, oddly-named files) ----
// Key = raw title (lowercase, trimmed). Value = clean title to search TMDB with.
const TITLE_OVERRIDES = {
  'hellraiserc': 'Hellraiser',
  'cannical hollocaust': 'Cannibal Holocaust',
  'i spit on your grave david maguire': 'I Spit on Your Grave',
  'fatal attraction hb gilmour': 'Fatal Attraction',
  '"dark star", short film script, by john carpenter & dan o\'bannon': 'Dark Star',
  'dark star, short film script, by john carpenter & dan o\'bannon': 'Dark Star',
  'natural born killers.pdf': 'Natural Born Killers',
  'hucow hostel sable collins': 'Hostel',
  'de antimaagd emmanuelle dutch edition arsan emmanuelle': 'Emmanuelle',
  'oceanofpdf.com de antimaagd emmanuelle dutch edition arsan emmanuelle': 'Emmanuelle',
};

function applyTitleOverride(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  return TITLE_OVERRIDES[key] ?? null;
}

// ---- title cleanup (extends src/castLookup.ts cleanSourceTitle) ----
function cleanSourceTitle(raw) {
  let s = String(raw ?? '');

  // Strip leading source markers: "OceanofPDF.com ", "Wikipedia: ", etc.
  s = s.replace(/^\s*(OceanofPDF\.com|Wikipedia|IMDB|IMSDB|ScriptOnScreen|InternetArchive|archive\.org)\s*[:\-]?\s*/i, '');

  // Strip file extensions: .pdf, .html, .txt, .epub, .doc, .docx, .mobi, .azw3
  s = s.replace(/\.(pdf|html?|txt|epub|docx?|mobi|azw3?|rtf)\s*$/i, '');

  // Replace hyphens/underscores between words (file-name style) with spaces
  // but keep dashes that look intentional (Mary-Anne)
  if (/[a-z]-[a-z]-[a-z]/i.test(s)) s = s.replace(/-/g, ' ');
  s = s.replace(/_+/g, ' ');

  // Decode common HTML entities (very basic)
  s = s.replace(/&#8211;|&ndash;/gi, '-')
       .replace(/&#8217;|&rsquo;/gi, "'")
       .replace(/&amp;/gi, '&')
       .replace(/&#\d+;/g, '');

  // Strip parenthetical/bracketed asides
  s = s.replace(/[\(\[].*?[\)\]]/g, '');

  // Strip everything after a separator that introduces meta-description
  s = s.replace(/\s*[\-\u2013\u2014:|]\s*(transcript|screenplay|script|source|factual|premise|based on|inspired by|the movie|the film|story|novel|book|wikipedia|extracted|description|short film|free download|borrow|streaming|internet archive|scripts on screen|by\s+\w+).*$/i, '');

  // Strip ", LastName, FirstName : ..." author tail patterns
  s = s.replace(/\s*[,:]\s*[A-Z][a-z]+\s*,\s*[A-Z][a-z]+.*$/, '');

  // Strip standalone trailing words like "source", "PDF"
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/\s+(source|pdf|script|screenplay|transcript|wikipedia|the\s+movie|movie|film|book|novel)\s*$/i, '')
      .replace(/\s*[\-\u2013\u2014:|]\s*(full\s*text|shooting\s*script|screenplay|script|transcript|dialogue\s*transcript|the\s*movie|film|movie|book|novel|wikipedia|source)\s*$/i, '');
  }

  // Strip trailing junk number like " 736", " 002"
  s = s.replace(/\s+\d{1,4}\s*$/, '');

  // Strip trailing year only if title still has content before it
  s = s.replace(/\s+\(?(19|20)\d{2}\)?\s*$/u, '');

  // Strip leading/trailing quotes
  s = s.replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, '');

  return s.replace(/\s+/g, ' ').trim();
}

function extractYearHint(raw) {
  const m = String(raw ?? '').match(/(?:^|\D)(19|20)(\d{2})(?:\D|$)/);
  if (!m) return null;
  const y = parseInt(m[1] + m[2], 10);
  return y >= 1900 && y <= 2099 ? y : null;
}

// ---- TMDB calls ----
async function searchTMDB(title, year) {
  const q = encodeURIComponent(title);
  const yearMovie = year ? `&year=${year}` : '';
  const yearTV = year ? `&first_air_date_year=${year}` : '';
  const movieUrl = `${TMDB_API}/search/movie?api_key=${TMDB_API_KEY}&query=${q}${yearMovie}`;
  const tvUrl = `${TMDB_API}/search/tv?api_key=${TMDB_API_KEY}&query=${q}${yearTV}`;

  const [mRes, tRes] = await Promise.all([
    fetch(movieUrl).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(tvUrl).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  const movie = mRes?.results?.[0];
  const tv = tRes?.results?.[0];

  // Prefer whichever has a backdrop; fall back to movie
  if (movie?.backdrop_path) return { kind: 'movie', ...movie };
  if (tv?.backdrop_path) return { kind: 'tv', ...tv };
  if (movie) return { kind: 'movie', ...movie };
  if (tv) return { kind: 'tv', ...tv };
  return null;
}

async function downloadImage(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return buf.length;
}

// ---- world processing ----
function pickTitle(world) {
  const src = world.sourceDocuments?.[0]?.title;
  if (src && src.trim()) return src;
  return world.concept || '';
}

async function processWorld(worldFile) {
  const raw = readFileSync(worldFile, 'utf8');
  let world;
  try {
    world = JSON.parse(raw);
  } catch (e) {
    return { id: worldFile, status: 'parse_error', message: e.message };
  }

  const id = world.id;
  if (!id) return { id: worldFile, status: 'no_id' };

  // Filter
  if (ONLY_WORLD && id !== ONLY_WORLD) return { id, status: 'skipped_filter' };
  const coverSource = world.images?.coverSource;
  if (!INCLUDE_MANUAL && coverSource === 'manual') {
    return { id, status: 'skipped_manual' };
  }

  const dest = join(COVERS_DIR, `${id}.jpg`);
  const coverExists = existsSync(dest);

  // If cover already exists, optionally just update the world JSON pointer and bail.
  if (coverExists && !FORCE) {
    if (UPDATE_WORLD) {
      const targetPath = `/covers/${id}.jpg`;
      if (world.images?.cover !== targetPath || world.images?.coverSource !== 'tmdb') {
        world.images = world.images || {};
        world.images.cover = targetPath;
        world.images.coverSource = world.images.coverSource || 'tmdb';
        if (!world.images.coverKind) world.images.coverKind = 'backdrop';
        if (!DRY_RUN) writeFileSync(worldFile, JSON.stringify(world, null, 2), 'utf8');
        return { id, status: 'updated_json_only', dest };
      }
    }
    return { id, status: 'skipped_exists', dest };
  }

  const rawTitle = pickTitle(world);
  if (!rawTitle) return { id, status: 'no_title' };

  // Manual override beats cleanup. Try raw form first, then cleaned form.
  const cleanedFromRegex = cleanSourceTitle(rawTitle);
  const overrideTitle = applyTitleOverride(rawTitle) ?? applyTitleOverride(cleanedFromRegex);
  const cleaned = overrideTitle ?? cleanedFromRegex;
  const year = overrideTitle ? null : extractYearHint(rawTitle);
  if (!cleaned) return { id, status: 'empty_cleaned_title', rawTitle };

  if (DRY_RUN) {
    return { id, status: 'dry_run', rawTitle, cleaned, year, override: !!overrideTitle };
  }

  // Search TMDB
  const hit = await searchTMDB(cleaned, year);
  if (!hit) return { id, status: 'no_tmdb_match', cleaned };
  if (!hit.backdrop_path && !hit.poster_path) {
    return { id, status: 'no_artwork', cleaned, tmdbId: hit.id };
  }

  // Pick backdrop > poster
  const useBackdrop = Boolean(hit.backdrop_path);
  const url = useBackdrop
    ? `${BACKDROP_BASE}${hit.backdrop_path}`
    : `${POSTER_BASE}${hit.poster_path}`;

  try {
    const bytes = await downloadImage(url, dest);

    // Optionally update world JSON
    if (UPDATE_WORLD) {
      world.images = world.images || {};
      world.images.cover = `/covers/${id}.jpg`;
      world.images.coverSource = 'tmdb';
      world.images.coverKind = useBackdrop ? 'backdrop' : 'poster';
      writeFileSync(worldFile, JSON.stringify(world, null, 2), 'utf8');
    }

    return {
      id, status: 'ok',
      cleaned,
      tmdbId: hit.id,
      kind: hit.kind,
      coverKind: useBackdrop ? 'backdrop' : 'poster',
      title: hit.title || hit.name,
      bytes,
      url,
    };
  } catch (e) {
    return { id, status: 'download_failed', cleaned, url, message: e.message };
  }
}

// ---- concurrency-limited runner ----
async function runPool(items, fn, n) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---- main ----
async function main() {
  if (!existsSync(COVERS_DIR)) mkdirSync(COVERS_DIR, { recursive: true });

  const worldFiles = readdirSync(DATA_DIR)
    .filter(f => /^world-.*\.json$/.test(f))
    .map(f => join(DATA_DIR, f));

  console.log(`[tmdb-covers] ${worldFiles.length} world file(s) found`);
  console.log(`[tmdb-covers] flags: force=${FORCE} dryRun=${DRY_RUN} updateWorld=${UPDATE_WORLD} includeManual=${INCLUDE_MANUAL} concurrency=${CONCURRENCY}${ONLY_WORLD ? ` only=${ONLY_WORLD}` : ''}`);

  const results = await runPool(worldFiles, async (wf, idx) => {
    const r = await processWorld(wf);
    const tag = `[${idx + 1}/${worldFiles.length}]`;
    if (r.status === 'ok') {
      console.log(`${tag} ✓ ${r.id.slice(0, 8)}  ${r.coverKind}  ${r.kind}  "${r.title}"  (${(r.bytes / 1024).toFixed(0)} KB)`);
    } else if (r.status === 'dry_run') {
      console.log(`${tag} ~ ${r.id.slice(0, 8)}  would search: "${r.cleaned}"${r.year ? ` (${r.year})` : ''}`);
    } else if (r.status === 'skipped_exists') {
      console.log(`${tag} - ${r.id.slice(0, 8)}  already exists (use --force to overwrite)`);
    } else if (r.status === 'updated_json_only') {
      console.log(`${tag} ↻ ${r.id.slice(0, 8)}  cover exists, updated world JSON pointer`);
    } else if (r.status === 'skipped_manual') {
      console.log(`${tag} - ${r.id.slice(0, 8)}  manual cover (use --include-manual to retry)`);
    } else if (r.status === 'skipped_filter') {
      // silent
    } else if (r.status === 'no_tmdb_match') {
      console.log(`${tag} ✗ ${r.id.slice(0, 8)}  no TMDB match for "${r.cleaned}"`);
    } else if (r.status === 'no_artwork') {
      console.log(`${tag} ✗ ${r.id.slice(0, 8)}  TMDB ${r.tmdbId} has no artwork`);
    } else if (r.status === 'download_failed') {
      console.log(`${tag} ✗ ${r.id.slice(0, 8)}  download failed: ${r.message}`);
    } else if (r.status === 'no_title') {
      console.log(`${tag} ✗ ${r.id.slice(0, 8)}  no title available`);
    } else if (r.status === 'empty_cleaned_title') {
      console.log(`${tag} ✗ ${r.id.slice(0, 8)}  title cleaned to empty: "${r.rawTitle}"`);
    } else if (r.status === 'parse_error') {
      console.log(`${tag} ✗ parse error in ${wf}: ${r.message}`);
    } else {
      console.log(`${tag} ? ${r.id?.slice(0, 8) || wf}  ${r.status}`);
    }
    return r;
  }, CONCURRENCY);

  // Summary
  const tally = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log('\n[tmdb-covers] summary:');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${v}`);
  }
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
