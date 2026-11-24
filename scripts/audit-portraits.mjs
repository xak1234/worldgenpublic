import { readdirSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.WORLDGEN_ROOT ? resolve(process.env.WORLDGEN_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.WORLDGEN_DATA_DIR ? resolve(ROOT, process.env.WORLDGEN_DATA_DIR) : join(ROOT, "data");
const dataDir = process.argv[2] || DATA_DIR;
const rows = [];
const files = readdirSync(dataDir).filter(f => f.startsWith("world-") && f.endsWith(".json"));
for (const f of files) {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, f), "utf8"));
    const npcs = (j.npcs || []).length;
    const portraits = j.images?.portraits ? Object.keys(j.images.portraits).length : 0;
    const sources = j.images?.portraitSources ? Object.values(j.images.portraitSources) : [];
    const tmdb = sources.filter(s => s?.kind === "tmdb").length;
    const stills = sources.filter(s => s?.imageType === "still").length;
    const manual = sources.filter(s => s?.kind === "manual").length;
    const ai = Math.max(0, portraits - tmdb - manual);
    const missing = Math.max(0, npcs - portraits);
    let concept = (j.concept || "").replace(/\s+/g, " ").trim();
    if (concept.length > 32) concept = concept.slice(0, 30) + "..";
    rows.push({
      id: j.id.slice(0, 26),
      concept,
      npcs,
      pic: portraits,
      miss: missing,
      tmdb,
      still: stills,
      ai,
      man: manual,
    });
  } catch (e) {
    console.error(`[skip] ${f}: ${e.message}`);
  }
}
rows.sort((a, b) => b.tmdb - a.tmdb || b.npcs - a.npcs);

const pad = (s, n, right = false) => {
  s = String(s);
  if (s.length >= n) return s.slice(0, n);
  return right ? s.padStart(n) : s.padEnd(n);
};

const header = `${pad("id", 26)}  ${pad("concept", 32)}  ${pad("npcs", 4, true)}  ${pad("pic", 4, true)}  ${pad("miss", 4, true)}  ${pad("tmdb", 4, true)}  ${pad("still", 5, true)}  ${pad("ai", 4, true)}  ${pad("man", 4, true)}`;
console.log(header);
console.log("-".repeat(header.length));
for (const r of rows) {
  console.log(`${pad(r.id, 26)}  ${pad(r.concept, 32)}  ${pad(r.npcs, 4, true)}  ${pad(r.pic, 4, true)}  ${pad(r.miss, 4, true)}  ${pad(r.tmdb, 4, true)}  ${pad(r.still, 5, true)}  ${pad(r.ai, 4, true)}  ${pad(r.man, 4, true)}`);
}

const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
console.log("");
console.log("TOTALS");
console.log("------");
console.log(`worlds:          ${rows.length}`);
console.log(`npcs:            ${sum("npcs")}`);
console.log(`portraits:       ${sum("pic")}`);
console.log(`missing:         ${sum("miss")}`);
console.log(`tmdb_matched:    ${sum("tmdb")}`);
console.log(`in_char_stills:  ${sum("still")}`);
console.log(`ai_generated:    ${sum("ai")}`);
console.log(`manual_upload:   ${sum("man")}`);
console.log(`worlds_no_tmdb:  ${rows.filter(r => r.tmdb === 0).length}`);
console.log(`worlds_partial:  ${rows.filter(r => r.tmdb > 0 && r.miss > 0).length}`);