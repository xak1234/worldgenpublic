import "dotenv/config";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
if (!args.length || args.includes("--help")) {
  console.log("usage: node scripts/fetch-source.mjs <title> [year]");
  console.log("  --no-script    skip IMSDB script fetch");
  console.log("  --no-digest    skip DeepSeek digest pass (output raw text only)");
  console.log("  --out <path>   override output path");
  process.exit(args.length ? 0 : 1);
}
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const skipScript = flag("--no-script");
const skipDigest = flag("--no-digest");
const outOverride = opt("--out");
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
const title = positional[0];
const year = positional[1] ? parseInt(positional[1]) : null;
const UA = "WorldGen-FetchSource/1.0";

async function wikiExtract(p) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&titles=${encodeURIComponent(p)}&format=json&redirects=1`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const j = await r.json();
  const pages = Object.values(j.query?.pages || {});
  const page = pages[0];
  if (!page || page.missing || !page.extract || page.extract.length < 800) return null;
  if (/may refer to:/i.test(page.extract.slice(0, 300))) return null;
  return { title: page.title, text: page.extract };
}

async function fetchWiki(title, year) {
  const variations = [];
  if (year) variations.push(`${title} (${year} film)`, `${title} (${year} miniseries)`, `${title} (${year})`);
  variations.push(`${title} (film)`, `${title} (miniseries)`, title);
  if (title.toLowerCase().startsWith("the ")) {
    const s = title.slice(4);
    variations.push(year ? `${s} (${year} film)` : `${s} (film)`, s);
  }
  for (const v of variations) {
    const hit = await wikiExtract(v);
    if (hit) { console.error(`[wiki] ${hit.title}`); return { ...hit, url: `https://en.wikipedia.org/wiki/${v.replace(/ /g, "_")}` }; }
  }
  return null;
}

async function fetchIMSDB(title) {
  const slugs = [
    title.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9\-,]/g, ""),
    title.toLowerCase().startsWith("the ") ? `${title.slice(4).replace(/\s+/g, "-")},-The` : null,
  ].filter(Boolean);
  for (const s of slugs) {
    const url = `https://imsdb.com/scripts/${s}.html`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const html = await r.text();
      const m = html.match(/<pre[^>]*>([\s\S]+?)<\/pre>/i);
      if (!m) continue;
      const text = m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\r/g, "").trim();
      if (text.length < 3000) continue;
      console.error(`[imsdb] ${url} (${text.length} chars)`);
      return { url, text };
    } catch {}
  }
  return null;
}

async function buildDigest(rawText, title, year) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY missing in .env");
  const SYSTEM = `You are a story-analysis assistant. Read the provided source material (script, screenplay, novel, transcript, or article) and produce a STRUCTURED CANONICAL DIGEST of the ENTIRE story, beginning to end. Return ONLY structured plain text in the exact format requested \u2014 no markdown headers, no commentary outside the structure.`;
  const sourceTitle = `${title}${year ? ` (${year})` : ""}`;
  const userPrompt = `Source title: ${sourceTitle}\nSource kind: Film/Article\n\n----- BEGIN SOURCE -----\n${rawText}\n----- END SOURCE -----\n\nProduce a structured canonical digest in this exact format (target ~6000-8000 chars total):\n\nCHARACTERS:\n- <full name> (<role / actor if known>): <one-paragraph arc \u2014 who they are, key relationships, what happens to them, do they live or die, how their story resolves>\n- ...\n\nLOCATIONS:\n- <location name>: <one-sentence description grounded in the actual scenes from this source>\n- ...\n\nPLOT (chronological, ALL major beats in order \u2014 opening through climax through ending):\n1. <scene title>: <2-3 sentence summary>\n2. ...\nN. <climax title>: <climactic moment>\nN+1. <ending title>: <how it actually ends, including any twists or resolution>\n\nTHEMES: <2-3 sentence statement>\nTONE: <2-3 adjectives>\nENDING TYPE: <tragic / triumphant / bittersweet / open / cyclical / ambiguous>\n\nCRITICAL: Use the EXACT names that appear in the source. Cover the FULL arc from opening to ending. Do NOT invent content not present in the source.`;
  console.error(`[digest] calling DeepSeek v4-flash on ${rawText.length} chars...`);
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 8000,
      temperature: 0.3,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const j = await res.json();
  const digest = String(j?.choices?.[0]?.message?.content ?? "").trim();
  if (!digest) throw new Error("empty digest");
  return digest;
}

const wiki = await fetchWiki(title, year);
const script = skipScript ? null : await fetchIMSDB(title);
if (!wiki && !script) { console.error(`no source for "${title}"`); process.exit(2); }

let raw = "";
if (wiki) raw += `WIKIPEDIA: ${wiki.title}\n\n${wiki.text.trim()}\n\n`;
if (script) raw += `SCRIPT (${script.url}):\n\n${script.text}\n`;

let output;
if (skipDigest) {
  output = `# ${title}${year ? ` (${year})` : ""}\n\n${raw}`;
  if (output.length > 14000) output = output.slice(0, 14000) + "\n\n[truncated]\n";
} else {
  output = await buildDigest(raw, title, year);
}

const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const ROOT = process.env.WORLDGEN_ROOT ? resolve(process.env.WORLDGEN_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(ROOT, "scripts", "sources");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = outOverride || join(outDir, `${slug}${year ? `-${year}` : ""}${skipDigest ? "" : "-digest"}.txt`);
writeFileSync(outPath, output, "utf8");
console.log(outPath);
console.log(`wrote ${output.length} chars (wiki:${!!wiki} script:${!!script} digest:${!skipDigest})`);
if (!skipDigest) {
  const charsMatch = output.match(/CHARACTERS:\s*([\s\S]*?)(?=\n\s*(?:LOCATIONS|PLOT|THEMES|TONE|ENDING)\s*:)/i);
  if (charsMatch) {
    const names = (charsMatch[1].match(/^-\s+([^(:\n]+)/gm) || []).map(s => s.replace(/^-\s+/, "").trim());
    console.log(`canonical roster (${names.length}): ${names.slice(0, 10).join(", ")}${names.length > 10 ? `, +${names.length - 10}` : ""}`);
  }
}