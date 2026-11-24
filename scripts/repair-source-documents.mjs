import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apply = process.argv.includes('--apply');
const DATA_DIR = 'data';
const SOURCE_DIRS = ['public/uploads', 'docs/books', 'scripts/sources'];
const MAX_INLINE_CHARS = 200_000;
const MANUAL_SIDECARS = [
  { match: /\bblade runner\b|\bdo androids dream\b/i, path: 'docs/books/bladebadlands.extracted.txt' },
  { match: /\broswell\b|\barea 51\b/i, path: 'docs/books/area51roswell.extracted.txt' },
  { match: /\bsalem'?s lot\b/i, path: 'public/uploads/1779654949265-a9832a77-Salem_s_Lot_Script_-_transcript_from_the_screenplay_and_or_S.txt' },
  { match: /\bfrankenstein\b/i, path: 'docs/books/Frankenstein.extracted.txt' },
  { match: /\bback to the 80s\b/i, path: 'docs/books/back-to-the-80s.brief.txt' },
];

const norm = value => String(value || '').toLowerCase().replace(/\.txt$/i, '').replace(/[^a-z0-9]+/g, '');
const isUrl = value => /^https?:\/\//i.test(String(value || ''));

function trimSourceFooter(text) {
  let out = String(text || '').trim();
  const markers = [
    'User Comments Back to IMSDb Index',
    'Back to IMSDb Index | Submit | Link to IMSDb',
    'Drew\'s Script-O-Rama',
    'Return to the script index',
  ];
  for (const marker of markers) {
    const idx = out.indexOf(marker);
    if (idx > out.length * 0.5) out = out.slice(0, idx).trim();
  }
  return out;
}

function sourceInlineText(text) {
  const source = trimSourceFooter(text);
  if (source.length <= MAX_INLINE_CHARS) return source;
  const markerBudget = 900;
  const segment = Math.max(1000, Math.floor((MAX_INLINE_CHARS - markerBudget) / 3));
  const middleStart = Math.max(0, Math.floor((source.length - segment) / 2));
  const tailStart = Math.max(0, source.length - segment);
  return [
    `[SOURCE EXCERPT: BEGINNING chars 1-${segment}]`,
    source.slice(0, segment),
    `[SOURCE EXCERPT: MIDDLE chars ${middleStart + 1}-${middleStart + segment}]`,
    source.slice(middleStart, middleStart + segment),
    `[SOURCE EXCERPT: ENDING / OUTCOME chars ${tailStart + 1}-${source.length}]`,
    source.slice(tailStart),
  ].join('\n\n').slice(0, MAX_INLINE_CHARS);
}

function sourceTypeFor(doc, world) {
  if (doc.sourceType && doc.sourceType !== 'LLM') return doc.sourceType;
  const text = `${doc.title || ''} ${doc.path || ''} ${doc.url || ''} ${world.concept || ''}`.toLowerCase();
  if (/\b(imsdb|screenplay|script|movie|film)\b/.test(text)) return 'Film';
  if (/\b(book|novel|literature|chapter|author)\b/.test(text)) return 'Book';
  if (/\b(real event|true story|disaster|war|battle|crisis|assassination|titanic|chernobyl)\b/.test(text)) return 'Real Event';
  if (/\b(history|historical|ancient|medieval|victorian|edwardian|roman|tudor)\b/.test(text)) return 'History';
  return doc.sourceType || 'Story';
}

function titleKeys(doc, world) {
  const raw = [
    doc.textPath,
    doc.title,
    doc.path,
    doc.url,
    String(doc.title || '').replace(/\.(html|pdf)$/i, ''),
  ];
  return raw.map(norm).filter(key => key.length >= 6);
}

function tokens(value) {
  const stop = new Set([
    'script', 'transcript', 'screenplay', 'movie', 'film', 'source', 'world', 'extracted',
    'factual', 'premise', 'from', 'with', 'and', 'the', 'com', 'html', 'pdf', 'txt',
    'oceanofpdf', 'borrow', 'streaming', 'internet', 'archive', 'free', 'download',
  ]);
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [])]
    .filter(token => !stop.has(token));
}

const sourceFiles = SOURCE_DIRS.flatMap(dir => existsSync(dir)
  ? readdirSync(dir).filter(file => file.toLowerCase().endsWith('.txt')).map(file => join(dir, file).replace(/\\/g, '/'))
  : []);

function findSidecar(doc, world) {
  const direct = [doc.textPath, doc.path?.endsWith('.txt') ? doc.path : doc.path ? `${doc.path}.txt` : undefined]
    .filter(Boolean)
    .map(value => String(value).replace(/^\/+/, ''))
    .find(value => existsSync(value));
  if (direct) return direct;

  const manualText = `${doc.title || ''} ${doc.path || ''} ${doc.url || ''} ${world.concept || ''}`;
  const manual = MANUAL_SIDECARS.find(item => item.match.test(manualText) && existsSync(item.path));
  if (manual) return manual.path;

  if (/\b(lore brief|factual premise)\b/i.test(String(doc.title || ''))) return '';

  const keys = titleKeys(doc, world);
  for (const file of sourceFiles) {
    const fileKey = norm(file);
    if (keys.some(key => fileKey.includes(key) || key.includes(fileKey))) return file;
  }

  const docTokens = tokens(doc.title || doc.path || doc.url);
  let best = { file: '', score: 0 };
  if (docTokens.length) {
    for (const file of sourceFiles) {
      const fileTokens = tokens(file);
      const score = docTokens.filter(token => fileTokens.includes(token)).length;
      if (score > best.score) best = { file, score };
    }
    if (best.score >= Math.min(2, docTokens.length)) {
      return best.file;
    }
    for (const token of docTokens.filter(item => item.length >= 5)) {
      const matches = sourceFiles.filter(file => tokens(file).includes(token));
      if (matches.length === 1) return matches[0];
    }
  }
  return '';
}

const report = { scannedWorlds: 0, sourceDocs: 0, repaired: [], alreadyFull: [], unresolved: [] };
for (const file of readdirSync(DATA_DIR).filter(name => name.startsWith('world') && name.endsWith('.json'))) {
  const worldPath = join(DATA_DIR, file);
  let world;
  try { world = JSON.parse(readFileSync(worldPath, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
  report.scannedWorlds++;
  let changed = false;
  for (const doc of world.sourceDocuments || []) {
    report.sourceDocs++;
    const current = String(doc.extractedText || '');
    const sidecar = findSidecar(doc, world);
    if (!sidecar) {
      if (current && current.length <= 60_000) {
        report.unresolved.push({ world: world.concept || world.id, file, title: doc.title, len: current.length });
      }
      continue;
    }
    const full = sourceInlineText(readFileSync(sidecar, 'utf8'));
    if (full.length <= current.length && current.includes(full.slice(-120))) {
      report.alreadyFull.push({ world: world.concept || world.id, title: doc.title, len: current.length });
      continue;
    }
    if (full.length > current.length || !current.includes(full.slice(-120))) {
      doc.textPath = sidecar;
      doc.extractedText = full;
      if (isUrl(doc.path)) doc.type = 'url';
      doc.sourceType = sourceTypeFor(doc, world);
      changed = true;
      report.repaired.push({ world: world.concept || world.id, file, title: doc.title, from: current.length, to: full.length, textPath: sidecar });
    }
  }
  if (changed && apply) writeFileSync(worldPath, `${JSON.stringify(world, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({ apply, ...report }, null, 2));
