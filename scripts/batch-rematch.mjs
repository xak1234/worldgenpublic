import { readdirSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.WORLDGEN_ROOT ? resolve(process.env.WORLDGEN_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.WORLDGEN_DATA_DIR ? resolve(ROOT, process.env.WORLDGEN_DATA_DIR) : join(ROOT, "data");
const dataDir = DATA_DIR;
const baseUrl = "http://127.0.0.1:3002";

const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const APPLY = flag("--apply");
const WORLD = opt("--world");
const TITLE_OVERRIDE = opt("--title");
const YEAR_OVERRIDE = opt("--year");
const INCLUDE_MATCHED = flag("--include-matched");

if (flag("--help")) {
  console.log("usage: node scripts/batch-rematch.mjs [options]");
  console.log("  --world <id-or-prefix>   target one world (dry-run by default)");
  console.log("  --apply                  actually POST to cast-rematch (default is dry-run)");
  console.log("  --title \"...\"            override extracted title (use with --world)");
  console.log("  --year <yyyy>            override extracted year (use with --world)");
  console.log("  --include-matched        include worlds that already have TMDB matches");
  console.log("");
  console.log("examples:");
  console.log("  node scripts/batch-rematch.mjs                          dry-run all untouched");
  console.log("  node scripts/batch-rematch.mjs --world build_a00baf21   dry-run one (Dracula)");
  console.log("  node scripts/batch-rematch.mjs --world build_a00baf21 --apply");
  console.log("  node scripts/batch-rematch.mjs --world 225ae84d --title Blade --year 1998 --apply");
  process.exit(0);
}

function extractTitleAndYear(concept) {
  let s = (concept || "").trim();
  if (!s) return { title: "", year: null };
  let year = null;
  const ym = s.match(/\b(1[89]\d{2}|20\d{2}|21\d{2})\b/);
  if (ym) year = parseInt(ym[1]);
  let title = s
    .replace(/\b(1[89]\d{2}|20\d{2}|21\d{2})\b/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ");
  title = title.split(/\s+(?:where|with|featuring|starring|based on|aka)\s+/i)[0];
  title = title.split(/\s*[,:|\u2013\u2014]\s*/)[0];
  title = title.replace(/\s+(film|movie|book|novel|story|saga|world|worlds|universe|series|tv|show|vol\.?\s*\d*)$/gi, "");
  title = title.replace(/\s+/g, " ").trim();
  return { title, year };
}

function loadCandidates() {
  const files = readdirSync(dataDir).filter(f => f.startsWith("world-") && f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(dataDir, f), "utf8"));
      const sources = j.images?.portraitSources ? Object.values(j.images.portraitSources) : [];
      const tmdb = sources.filter(s => s?.kind === "tmdb").length;
      const { title, year } = extractTitleAndYear(j.concept);
      out.push({
        id: j.id,
        concept: j.concept || "",
        npcs: (j.npcs || []).length,
        currentTmdb: tmdb,
        title,
        year,
      });
    } catch (e) {
      console.error(`[skip] ${f}: ${e.message}`);
    }
  }
  return out;
}

const all = loadCandidates();
let targets = all;
if (WORLD) {
  targets = all.filter(c => c.id === WORLD || c.id.startsWith(WORLD));
  if (!targets.length) {
    console.error(`no world matches "${WORLD}"`);
    process.exit(1);
  }
} else if (!INCLUDE_MATCHED) {
  targets = targets.filter(c => c.currentTmdb === 0);
}

console.log(`mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`targets: ${targets.length}`);
console.log("");

const stats = { matched: 0, noMatch: 0, skipped: 0, errors: 0, totalActors: 0 };

for (const t of targets) {
  const useTitle = (WORLD && TITLE_OVERRIDE) ? TITLE_OVERRIDE : t.title;
  const useYear  = (WORLD && YEAR_OVERRIDE)  ? parseInt(YEAR_OVERRIDE) : t.year;
  console.log(`[${t.id}]`);
  console.log(`  concept: ${t.concept}`);
  console.log(`  -> title: ${useTitle || "(empty)"}    year: ${useYear ?? "(none)"}    npcs: ${t.npcs}    currentTmdb: ${t.currentTmdb}`);

  if (!useTitle) {
    console.log(`  SKIP: no usable title extracted`);
    stats.skipped++;
    console.log("");
    continue;
  }
  if (!APPLY) {
    console.log(`  DRY: would POST cast-rematch`);
    console.log("");
    continue;
  }
  try {
    const body = { title: useTitle };
    if (useYear) body.year = useYear;
    const r = await fetch(`${baseUrl}/api/worlds/${t.id}/cast-rematch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      console.log(`  ERROR: ${j.error || r.statusText}`);
      stats.errors++;
    } else if (!j.source) {
      console.log(`  NO MATCH on TMDB`);
      stats.noMatch++;
    } else {
      console.log(`  MATCH: ${j.matched}/${t.npcs} npcs -> ${j.source.title} (${j.source.year}, ${j.source.kind})`);
      if (j.matches?.length) {
        const sample = j.matches.slice(0, 3).map(m => `${m.npcName}->${m.actor}`).join(", ");
        console.log(`    ${sample}${j.matches.length > 3 ? `, +${j.matches.length - 3} more` : ""}`);
      }
      stats.matched++;
      stats.totalActors += j.matched || 0;
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    stats.errors++;
  }
  console.log("");
}

if (APPLY) {
  console.log("=== SUMMARY ===");
  console.log(`matched:    ${stats.matched} worlds`);
  console.log(`no_match:   ${stats.noMatch} worlds`);
  console.log(`skipped:    ${stats.skipped} worlds`);
  console.log(`errors:     ${stats.errors} worlds`);
  console.log(`new actors: ${stats.totalActors}`);
}