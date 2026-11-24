import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.WORLDGEN_ROOT ? resolve(process.env.WORLDGEN_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.WORLDGEN_DATA_DIR ? resolve(ROOT, process.env.WORLDGEN_DATA_DIR) : join(ROOT, "data");
const dataDir = DATA_DIR;
const outJson = join(ROOT, "scripts", "portrait-report.json");
const outHtml = join(ROOT, "public", "portrait-report.html");

const worlds = [];
for (const f of readdirSync(dataDir).filter(f => f.startsWith("world-") && f.endsWith(".json"))) {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, f), "utf8"));
    const portraits = j.images?.portraits || {};
    const psrcs = j.images?.portraitSources || {};
    const npcs = (j.npcs || []).map(n => {
      const id = String(n.id || "");
      const name = n.name || `${n.firstName || ""} ${n.lastName || ""}`.trim() || id;
      const src = psrcs[id] || {};
      return {
        id,
        name,
        portrait: portraits[id] || n.images?.portrait || null,
        kind: src.kind || (portraits[id] ? "ai" : "none"),
        character: src.character || null,
        actor: src.actor || null,
        score: src.score ?? null,
      };
    });
    worlds.push({
      id: j.id,
      concept: j.concept || "",
      cover: j.images?.cover || null,
      coverSource: j.images?.coverSource || null,
      npcCount: npcs.length,
      portraitCount: npcs.filter(n => n.portrait).length,
      tmdbCount: npcs.filter(n => n.kind === "tmdb").length,
      manualCount: npcs.filter(n => n.kind === "manual").length,
      aiCount: npcs.filter(n => n.kind === "ai").length,
      npcs,
    });
  } catch (e) {
    console.error(`[skip] ${f}: ${e.message}`);
  }
}

worlds.sort((a, b) => b.tmdbCount - a.tmdbCount || b.npcCount - a.npcCount);
writeFileSync(outJson, JSON.stringify(worlds, null, 2));
console.log(`json: ${outJson} (${worlds.length} worlds)`);

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const badge = k => {
  const colors = { tmdb: "#3b82f6", manual: "#a855f7", ai: "#10b981", none: "#ef4444" };
  return `<span class="badge" style="background:${colors[k]||"#666"}">${k}</span>`;
};

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>WorldGen Portrait Report</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0a0a0a; color:#e5e5e5; margin:0; padding:20px; }
  h1 { color:#fff; }
  .summary { background:#1a1a1a; padding:14px 20px; border-radius:8px; margin:12px 0 24px; display:flex; gap:30px; flex-wrap:wrap; }
  .summary div { font-size:14px; }
  .summary b { color:#fff; font-size:18px; display:block; }
  .world { background:#141414; border-radius:10px; padding:18px; margin:18px 0; border:1px solid #222; }
  .world h2 { margin:0 0 6px; color:#fff; font-size:18px; }
  .world .id { color:#666; font-size:11px; font-family: monospace; }
  .concept { background:#0a0a0a; padding:10px 14px; border-left:3px solid #3b82f6; margin:12px 0; font-size:13px; color:#bbb; max-height:120px; overflow-y:auto; }
  .stats { display:flex; gap:14px; font-size:12px; color:#888; margin-bottom:14px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:14px; }
  .npc { background:#0a0a0a; border-radius:6px; overflow:hidden; border:1px solid #222; }
  .npc img { width:100%; aspect-ratio:2/3; object-fit:cover; background:#222; display:block; }
  .npc .body { padding:8px 10px; }
  .npc .name { font-size:13px; color:#fff; font-weight:500; line-height:1.3; }
  .npc .meta { font-size:11px; color:#888; margin-top:4px; }
  .npc .meta i { color:#bbb; font-style:normal; }
  .badge { display:inline-block; font-size:10px; padding:2px 6px; border-radius:3px; color:#fff; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; }
  .no-img { width:100%; aspect-ratio:2/3; background:#1a1a1a; display:flex; align-items:center; justify-content:center; color:#444; font-size:11px; }
  .toc { background:#1a1a1a; padding:14px 20px; border-radius:8px; margin-bottom:24px; }
  .toc a { color:#3b82f6; text-decoration:none; margin-right:14px; font-size:12px; }
  .toc a:hover { color:#60a5fa; }
  details { background:#1a1a1a; padding:10px 14px; border-radius:6px; margin-bottom:18px; }
  summary { cursor:pointer; color:#888; font-size:13px; }
  details[open] summary { color:#fff; margin-bottom:10px; }
</style>
</head><body>
<h1>WorldGen Portrait Report</h1>
<div class="summary">
  <div><b>${worlds.length}</b>worlds</div>
  <div><b>${worlds.reduce((n,w)=>n+w.npcCount,0)}</b>NPCs</div>
  <div><b>${worlds.reduce((n,w)=>n+w.portraitCount,0)}</b>portraits</div>
  <div><b style="color:#3b82f6">${worlds.reduce((n,w)=>n+w.tmdbCount,0)}</b>tmdb</div>
  <div><b style="color:#a855f7">${worlds.reduce((n,w)=>n+w.manualCount,0)}</b>manual</div>
  <div><b style="color:#10b981">${worlds.reduce((n,w)=>n+w.aiCount,0)}</b>ai</div>
</div>
<details><summary>Jump to world (${worlds.length})</summary>
<div class="toc">${worlds.map(w => `<a href="#${w.id}">${esc((w.concept||w.id).slice(0,40))} (${w.npcCount})</a>`).join("")}</div>
</details>
${worlds.map(w => `
<div class="world" id="${w.id}">
  <h2>${esc((w.concept || w.id).slice(0, 120))}</h2>
  <div class="id">${w.id}</div>
  <div class="stats">
    <span>${w.npcCount} npcs</span>
    <span>${badge("tmdb")} ${w.tmdbCount}</span>
    <span>${badge("manual")} ${w.manualCount}</span>
    <span>${badge("ai")} ${w.aiCount}</span>
  </div>
  ${w.concept && w.concept.length > 120 ? `<div class="concept">${esc(w.concept)}</div>` : ""}
  <div class="grid">
    ${w.npcs.map(n => `
      <div class="npc">
        ${n.portrait ? `<img src="${esc(n.portrait)}" alt="${esc(n.name)}" loading="lazy">` : `<div class="no-img">no portrait</div>`}
        <div class="body">
          <div class="name">${esc(n.name)}</div>
          <div class="meta">
            ${badge(n.kind)}
            ${n.character ? `<br><i>as ${esc(n.character)}</i>` : ""}
            ${n.actor ? `<br>${esc(n.actor)}` : ""}
          </div>
        </div>
      </div>
    `).join("")}
  </div>
</div>
`).join("")}
</body></html>`;

writeFileSync(outHtml, html);
console.log(`html: ${outHtml}`);
console.log(`open: http://127.0.0.1:3002/portrait-report.html`);