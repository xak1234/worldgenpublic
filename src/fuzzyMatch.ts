/**
 * Fuzzy matching for quest / adventure keyword detection.
 *
 * Goal: accept partial words, common misspellings, and pluralisation so that
 * a player typing "amlet" or "the tunnels" still triggers a beat whose
 * keyword is "amulet" or "tunnel". Existing matching across questEpisode,
 * serializedAdventure, and worldQuest paths uses raw `includes()` and exact
 * Set membership; this module provides a drop-in tolerant alternative.
 *
 * The matcher is intentionally cheap (length-scaled Levenshtein) — no
 * external dependency, no LLM. For "same meaning" / synonym matching the
 * adventure pipeline already has an LLM beat evaluator; fuzzy matching here
 * just lets the LLM be invoked more readily.
 */

const STOPWORDS = new Set([
  'the','a','an','and','or','but','to','of','in','on','at','for','with','from','by','as',
  'is','are','was','were','be','been','being','this','that','these','those','it','its',
  'their','his','her','my','your','our','if','then','so','not','no','yes','do','did','done',
  'has','have','had','will','would','should','could','can','may','might','about','into',
  'over','under','up','down','out','off','than','too','very',
]);

/** Lowercase, strip punctuation (keep apostrophes and hyphens), collapse whitespace. */
export function normalizeText(text: string | null | undefined): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9'\-\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Crude stem: strip common English suffixes when result stays >= 3 chars. */
export function stemWord(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  // Longest suffixes first.
  const suffixes = ['ying', 'ied', 'ing', 'ies', 'ers', 'ier', 'est', 'ed', 'es', 'er', 's'];
  for (const sfx of suffixes) {
    if (w.length - sfx.length >= 3 && w.endsWith(sfx)) {
      return w.slice(0, -sfx.length);
    }
  }
  return w;
}

/** Tokenise into stemmed content words >= 3 chars, dropping stopwords. */
export function keywordStems(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const w of normalizeText(text).split(/\s+/)) {
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    out.push(stemWord(w));
  }
  return out;
}

/** Levenshtein edit distance. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

/** True if a and b are the same word modulo stemming and small edit distance. */
export function fuzzyWordMatch(a: string, b: string): boolean {
  const sa = stemWord(a), sb = stemWord(b);
  if (sa === sb) return true;
  // Prefix containment for partial-word matches (e.g. "frag" in "fragment").
  if (sa.length >= 4 && sb.length >= 4 && (sa.includes(sb) || sb.includes(sa))) return true;
  // Edit distance: tolerance grows with word length.
  // Length 3-4: must be exact (after stemming).
  // Length 5-7: 1 edit allowed.
  // Length 8+:  2 edits allowed.
  const len = Math.max(sa.length, sb.length);
  const tol = len >= 8 ? 2 : len >= 5 ? 1 : 0;
  if (tol === 0) return false;
  return editDistance(sa, sb) <= tol;
}

/** Count fuzzy keyword overlaps between text and a key set. */
export function fuzzyOverlapCount(text: string | null | undefined, keys: Iterable<string>): number {
  const stems = keywordStems(text);
  if (!stems.length) return 0;
  let n = 0;
  for (const k of keys) {
    const ks = stemWord(String(k).toLowerCase());
    if (stems.some(s => fuzzyWordMatch(s, ks))) n++;
  }
  return n;
}

/**
 * Does `haystack` contain `needle` (loosely)?
 *
 * Multi-word needles: every token must be present somewhere in the haystack
 * (short tokens by exact match, longer tokens by fuzzy stem match).
 * Single-word needles fall through to a fuzzy word search.
 */
export function fuzzyContainsPhrase(haystack: string | null | undefined, needle: string | null | undefined): boolean {
  const normH = normalizeText(haystack);
  const normN = normalizeText(needle);
  if (!normN) return true;
  if (!normH) return false;
  // Fast path: direct substring match preserves multi-word phrasing.
  if (normH.includes(normN)) return true;
  const hayTokens = normH.split(/\s+/).filter(Boolean);
  const hayStems = hayTokens.filter(t => t.length >= 3 && !STOPWORDS.has(t)).map(stemWord);
  const ndTokens = normN.split(/\s+/).filter(Boolean);
  if (!ndTokens.length) return false;
  return ndTokens.every(nt => {
    if (nt.length < 3) return hayTokens.includes(nt); // short word -> exact
    const ns = stemWord(nt);
    return hayStems.some(hs => fuzzyWordMatch(hs, ns));
  });
}

/** True if any of the provided keywords (any of which may be multi-word) fuzzy-hits the haystack. */
export function fuzzyKeywordHit(haystack: string | null | undefined, keywords: readonly string[] | null | undefined): boolean {
  if (!keywords?.length) return false;
  for (const kw of keywords) {
    if (kw && fuzzyContainsPhrase(haystack, kw)) return true;
  }
  return false;
}
