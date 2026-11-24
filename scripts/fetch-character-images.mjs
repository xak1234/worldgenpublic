import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.WORLDGEN_ROOT ? resolve(process.env.WORLDGEN_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.WORLDGEN_DATA_DIR ? resolve(ROOT, process.env.WORLDGEN_DATA_DIR) : join(ROOT, "data");
const dataDir = DATA_DIR;
const genDir = join(ROOT, "public", "generated");

const NSFW_HOSTS = [
  "rule34.xxx", "rule34.us", "e621.net", "e926.net", "gelbooru.com", "danbooru.donmai.us",
  "redtube.com", "pornhub.com", "xvideos.com", "xhamster.com", "youporn.com", "spankbang.com",
  "hentai-foundry.com", "hentaifoundry.com", "nhentai.net", "hentaihaven.org",
  "motherless.com", "erome.com", "thothub.tv", "camwhores.tv",
];
const SHADY_HINTS = ["rule34", "hentai", "porn", "xxx", "nsfw", "erotic"];

function classifyHost(url) {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase().replace(/^www\./, "");
    if (NSFW_HOSTS.some(h => host === h || host.endsWith("." + h))) return "nsfw";
    if (SHADY_HINTS.some(h => host.includes(h) || u.pathname.toLowerCase().includes(h))) return "nsfw";
    return "ok";
  } catch { return "ok"; }
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help")) {
  console.log("usage: node scripts/fetch-character-images.mjs <world-id-or-prefix> [options]");
  console.log("  --per <N>     candidates per NPC (default 5)");
  console.log("  --refresh     re-fetch even if candidates already exist");
  console.log("  --only <ids>  comma-separated NPC ids");
  process.exit(args.length ? 0 : 1);
}
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const worldArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--per" && args[i - 1] !== "--only");
const PER = parseInt(opt("--per") || "5");
const REFRESH = flag("--refresh");
const ONLY = (opt("--only") || "").split(",").filter(Boolean);

const files = readdirSync(dataDir).filter(f => f.startsWith("world-") && f.endsWith(".json"));
const worldFile = files.find(f => f.includes(worldArg));
if (!worldFile) { console.error(`no world matching "${worldArg}"`); process.exit(1); }
const world = JSON.parse(readFileSync(join(dataDir, worldFile), "utf8"));
const psrcs = world.images?.portraitSources || {};
const tmdbNpcs = Object.entries(psrcs).filter(([_, s]) => s?.kind === "tmdb");
if (!tmdbNpcs.length) { console.error("no tmdb-matched NPCs in this world"); process.exit(1); }

let filmTitle = world.concept || "";
let filmYear = null;
const sd = world.sourceDocuments?.slice(-1)[0];
if (sd?.title) {
  const ym = sd.title.match(/\b(19|20)\d{2}\b/);
  if (ym) filmYear = ym[0];
  const m = sd.title.match(/^([^-\(]+?)(?:\s+(?:Script|transcript|\d{4}|\(|-))/i);
  if (m) filmTitle = m[1].trim();
}
if (!filmYear && sd) {
  const ym = [sd.summary, sd.digest, sd.extractedText].filter(Boolean).join(" ").match(/\b(19|20)\d{2}\b/);
  if (ym) filmYear = ym[0];
}
const cy = filmTitle.match(/\b(19|20)\d{2}\b/);
if (cy && !filmYear) filmYear = cy[0];
filmTitle = filmTitle.replace(/\b(19|20)\d{2}\b/g, "").trim();

console.log(`world: ${world.id}`);
console.log(`film:  ${filmTitle}${filmYear ? ` (${filmYear})` : ""}`);
console.log(`tmdb NPCs to search: ${tmdbNpcs.length}${ONLY.length ? ` (filtered to ${ONLY.length})` : ""}`);
console.log("");

const candDir = join(genDir, world.id, "_candidates");
if (!existsSync(candDir)) mkdirSync(candDir, { recursive: true });

async function bingImageSearch(query, n = 5) {
  // Use Bing’s default moderate filter — it surfaces in-character shots first while still
  // returning enough results. NSFW results that slip through get flagged in the manifest.
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!r.ok) { console.error(`  bing http ${r.status}`); return []; }
  const html = await r.text();
  const results = [];
  const re = /class="iusc"[^>]+m="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null && results.length < n * 4) {
    const decoded = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");
    try {
      const p = JSON.parse(decoded);
      if (!p.murl) continue;
      results.push({ url: p.murl, source: p.purl || "", title: p.t || "", desc: p.desc || "" });
    } catch {}
  }
  return results;
}

async function downloadImage(url, dest, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.bing.com/",
      },
    });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("image/")) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 4000) return null;
    if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    return { bytes: buf.length, ct };
  } catch { return null; } finally { clearTimeout(tid); }
}

const manifest = {};
let okCount = 0, emptyCount = 0, nsfwTotal = 0;
for (const [npcId, src] of tmdbNpcs) {
  if (ONLY.length && !ONLY.includes(npcId)) continue;
  const npc = world.npcs?.find(n => String(n.id) === npcId);
  const charName = src.character || npc?.name || npcId;
  const npcDir = join(candDir, npcId);
  const npcManifest = join(npcDir, "manifest.json");
  if (!REFRESH && existsSync(npcManifest)) {
    console.log(`[${npcId}] skip (existing)`);
    manifest[npcId] = JSON.parse(readFileSync(npcManifest, "utf8"));
    continue;
  }
  const actorName = src.actor || "";
  const filmBit = `"${filmTitle}"${filmYear ? ` ${filmYear}` : ""}`;
  const query = actorName
    ? `"${actorName}" "${charName}" ${filmBit} character film still`
    : `"${charName}" ${filmBit} character film still`;
  console.log(`[${npcId}] "${charName}" -> ${query}`);
  let raw = [];
  try { raw = await bingImageSearch(query, PER + 4); } catch (e) { console.error(`  err: ${e.message}`); }
  if (!raw.length) {
    console.log(`  no results`);
    emptyCount++;
    manifest[npcId] = { character: charName, candidates: [] };
    writeFileSync(npcManifest, JSON.stringify(manifest[npcId], null, 2));
    continue;
  }
  const saved = [];
  let nsfwHere = 0;
  for (let i = 0; i < raw.length && saved.length < PER; i++) {
    const cand = raw[i];
    const tag = classifyHost(cand.url) === "nsfw" || classifyHost(cand.source) === "nsfw" ? "nsfw" : "ok";
    const extM = cand.url.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i);
    const ext = (extM?.[1] || "jpg").toLowerCase();
    const safeExt = ext === "jpeg" ? "jpg" : ext;
    const file = join(npcDir, `${saved.length}.${safeExt}`);
    const dl = await downloadImage(cand.url, file);
    if (!dl) continue;
    if (tag === "nsfw") nsfwHere++;
    saved.push({
      idx: saved.length,
      file: `_candidates/${npcId}/${saved.length}.${safeExt}`,
      url: cand.url,
      source: cand.source,
      title: (cand.title || "").slice(0, 100),
      flag: tag,
      bytes: dl.bytes,
    });
  }
  nsfwTotal += nsfwHere;
  manifest[npcId] = { character: charName, candidates: saved };
  writeFileSync(npcManifest, JSON.stringify(manifest[npcId], null, 2));
  console.log(`  saved ${saved.length}/${PER}${nsfwHere ? `  (${nsfwHere} flagged nsfw)` : ""}`);
  if (saved.length) okCount++; else emptyCount++;
  await new Promise(r => setTimeout(r, 1200));
}

writeFileSync(join(candDir, "manifest.json"), JSON.stringify({
  world: world.id, film: filmTitle, year: filmYear,
  fetchedAt: new Date().toISOString(), npcs: manifest,
}, null, 2));
console.log("");
console.log(`done: ${okCount} with candidates, ${emptyCount} empty, ${nsfwTotal} flagged nsfw (not deleted)`);
