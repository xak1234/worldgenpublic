import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
const ROOT = process.env.WORLDGEN_ROOT ? resolve(process.env.WORLDGEN_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const j = JSON.parse(readFileSync(join(ROOT, "scripts", "portrait-report.json"), "utf8"));
const KEEPERS = [];
const DELETE_CANDIDATES = [];
const ORIGINALS = [];

// A real-film concept looks like a film title (short, mostly capitalized words, no year-prefix narrative)
// A fan-fic concept has extra story framing: year prefix, "world", "where", trailing scenario etc.
const isFanFicTitle = c => /^(19|20|21)\d{2}\s|\bworld\b|\bwhere\b|\b(2026|2099|2300|3000|3200)\b|hostel|harem|stsr|ships|world\b|cheese|robots|wars\b/i.test(c);
const isShortFilmName = c => c && c.length < 50;

for (const w of j) {
  const c = (w.concept || "").trim();
  if (w.tmdbCount > 0) {
    // Has actor portraits applied — cast matched
    KEEPERS.push({ id: w.id, concept: c, npcs: w.npcCount, tmdb: w.tmdbCount });
    continue;
  }
  // No tmdb matches. Was it a real film name though?
  if (!c) { ORIGINALS.push({ id: w.id, concept: "(empty)", npcs: w.npcCount }); continue; }
  if (isFanFicTitle(c) || !isShortFilmName(c)) {
    ORIGINALS.push({ id: w.id, concept: c.slice(0,70), npcs: w.npcCount });
  } else {
    // Looks like a real film name but no NPC matches — broken film world
    DELETE_CANDIDATES.push({ id: w.id, concept: c, npcs: w.npcCount });
  }
}

const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0,n) : s.padEnd(n); };
const show = (title, rows) => {
  console.log(`\n=== ${title} (${rows.length}) ===`);
  for (const r of rows) console.log(`  ${pad(r.id, 40)}  ${pad(r.npcs, 4)}  ${r.concept}`);
};

show("KEEPERS — real film with matching cast", KEEPERS);
show("DELETE CANDIDATES — film name but NPCs do not match canonical cast", DELETE_CANDIDATES);
show("ORIGINALS — fan-fic / original concepts (no real film to match)", ORIGINALS);

console.log("");
console.log(`KEEPERS:           ${KEEPERS.length}`);
console.log(`DELETE CANDIDATES: ${DELETE_CANDIDATES.length}`);
console.log(`ORIGINALS:         ${ORIGINALS.length}`);