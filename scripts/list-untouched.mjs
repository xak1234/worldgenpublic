import { readdirSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.WORLDGEN_ROOT ? resolve(process.env.WORLDGEN_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.WORLDGEN_DATA_DIR ? resolve(ROOT, process.env.WORLDGEN_DATA_DIR) : join(ROOT, "data");
const dataDir = DATA_DIR;
const rows = [];
for (const f of readdirSync(dataDir).filter(f => f.startsWith("world-") && f.endsWith(".json"))) {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, f), "utf8"));
    const npcs = (j.npcs || []).length;
    const sources = j.images?.portraitSources ? Object.values(j.images.portraitSources) : [];
    const tmdb = sources.filter(s => s?.kind === "tmdb").length;
    if (tmdb > 0) continue;
    const concept = (j.concept || "").replace(/\s+/g, " ").trim();
    rows.push({ id: j.id, concept, npcs, file: f, size: Math.round(j ? readFileSync(join(dataDir,f)).length/1024 : 0) });
  } catch (e) {}
}
rows.sort((a, b) => b.npcs - a.npcs);
const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s.padEnd(n); };
console.log(`${pad("id", 38)} ${pad("npcs", 5)} ${pad("kb", 5)} concept`);
console.log("-".repeat(120));
for (const r of rows) console.log(`${pad(r.id, 38)} ${pad(r.npcs, 5)} ${pad(r.size, 5)} ${r.concept.slice(0,70)}`);
console.log("");
console.log(`worlds with zero TMDB matches: ${rows.length}`);
console.log(`total NPCs across them:        ${rows.reduce((n,r) => n+r.npcs, 0)}`);