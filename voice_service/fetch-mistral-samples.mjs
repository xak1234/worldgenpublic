#!/usr/bin/env node
// Downloads the reference recordings behind WorldGen's Mistral Voxtral NPC voices (tagged "worldgen";
// public-domain LibriVox readings) so the local Chatterbox service can clone the same voices.
//
//   node voice_service/fetch-mistral-samples.mjs [outDir]
//
// Uses the Mistral key from the environment (MISTRAL_API_KEY, else MISTRAL_API_PRO). Writes
// <outDir>/<voice name>.wav and <outDir>/voices.json ({ id, file, gender, age, mistralId }).
// Works while the Mistral account cannot synthesize speech: listing voices and samples is still allowed.
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const outDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'voices');
const envNames = ['MISTRAL_API_KEY', 'MISTRAL_API_PRO'];
const apiKey = envNames.map(n => process.env[n]?.trim()).find(Boolean);
if (!apiKey) { console.error(`Set one of ${envNames.join(' / ')}`); process.exit(1); }
const headers = { Authorization: `Bearer ${apiKey}` };

const list = await fetch('https://api.mistral.ai/v1/audio/voices?limit=100', { headers });
if (!list.ok) { console.error(`voice list failed: HTTP ${list.status}`); process.exit(1); }
const voices = ((await list.json()).items ?? []).filter(v => (v.tags ?? []).includes('worldgen'));
if (!voices.length) { console.error('no voices tagged "worldgen" on this account'); process.exit(1); }

mkdirSync(outDir, { recursive: true });
const manifest = [];
for (const v of voices) {
  const res = await fetch(`https://api.mistral.ai/v1/audio/voices/${v.id}/sample`, { headers });
  if (!res.ok || !/audio/.test(res.headers.get('content-type') ?? '')) {
    console.warn(`  skip ${v.name}: HTTP ${res.status}`);
    continue;
  }
  const file = `${v.name}.wav`;
  const audio = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(outDir, file), audio);
  const gender = String(v.gender ?? '').toLowerCase();
  manifest.push({ id: v.name, file, gender: gender === 'male' || gender === 'female' ? gender : 'neutral', age: Number(v.age) || null, mistralId: v.id });
  console.log(`  ${v.name.padEnd(16)} ${gender.padEnd(7)} ${String(v.age ?? '').padEnd(3)} ${(audio.length / 1024).toFixed(0)} KB`);
}
manifest.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(join(outDir, 'voices.json'), JSON.stringify({ voices: manifest }, null, 2) + '\n');
console.log(`${manifest.length} voices -> ${outDir}`);
