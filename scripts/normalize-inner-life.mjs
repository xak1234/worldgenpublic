#!/usr/bin/env node
/**
 * normalize-inner-life.mjs
 *
 * Walks every world-*.json AND session-*.json under data/ and coerces every expected-array
 * field to an array. Handles stale data from worlds/sessions built before innerLife
 * normalization was enforced.
 *
 * Coverage:
 *   world-*.json:
 *     npc.{selfConcept, values, woundTriggers, frequentedLocations, fears, traits, opinions, secrets, desires, coreConcerns, signature}
 *     npc.innerLife.* (if present)
 *   session-*.json:
 *     npcStates[npcId].innerLife.{selfConcept, values, unresolved, intentions, wounds,
 *       ruminationThreads, actorStream, observerStream, defenseHistory, trajectory,
 *       internalBeliefs, dreams, loyaltyConflicts}
 *     npcStates[npcId].innerLife.attachment.triggerPatterns
 *     npcStates[npcId].innerLife.theoryOfPlayer.{predictions, wrongAbout}
 *     npcStates[npcId].innerLife.wounds[].{triggerWords, triggerSituations}
 *
 * Usage:
 *   node scripts/normalize-inner-life.mjs [--dry-run] [--data-dir <path>]
 */

import { readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const dataIdx = argv.indexOf('--data-dir');
const DATA_DIR = dataIdx >= 0 ? argv[dataIdx + 1] : join(REPO_ROOT, 'data');

// Top-level NPC fields that the runtime expects to be arrays
const NPC_ARRAY_FIELDS = [
  'selfConcept', 'values', 'woundTriggers', 'frequentedLocations',
  'fears', 'traits', 'opinions', 'secrets', 'desires', 'coreConcerns',
];

// innerLife top-level array fields
const INNERLIFE_ARRAY_FIELDS = [
  'selfConcept', 'values', 'unresolved', 'intentions',
  'wounds', 'ruminationThreads', 'actorStream', 'observerStream',
  'defenseHistory', 'trajectory', 'internalBeliefs', 'dreams', 'loyaltyConflicts',
];

function asArray(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null);
  if (typeof v === 'string' && v.trim().length > 0) return [v];
  return [];
}

function normalizeInnerLife(il, stats) {
  if (!il || typeof il !== 'object') return il;
  for (const f of INNERLIFE_ARRAY_FIELDS) {
    if (!Array.isArray(il[f])) {
      stats.byField['innerLife.' + f] = (stats.byField['innerLife.' + f] || 0) + 1;
      il[f] = asArray(il[f]);
      stats.touchedFields++;
    }
  }
  if (Array.isArray(il.wounds)) {
    for (let i = 0; i < il.wounds.length; i++) {
      const w = il.wounds[i];
      if (!w || typeof w !== 'object') { il.wounds[i] = { triggerWords: [], triggerSituations: [] }; stats.touchedFields++; continue; }
      if (!Array.isArray(w.triggerWords))      { stats.byField['innerLife.wounds[].triggerWords']     = (stats.byField['innerLife.wounds[].triggerWords']     || 0) + 1; w.triggerWords      = asArray(w.triggerWords);      stats.touchedFields++; }
      if (!Array.isArray(w.triggerSituations)) { stats.byField['innerLife.wounds[].triggerSituations']= (stats.byField['innerLife.wounds[].triggerSituations']|| 0) + 1; w.triggerSituations = asArray(w.triggerSituations); stats.touchedFields++; }
    }
  }
  if (il.attachment && typeof il.attachment === 'object') {
    if (!Array.isArray(il.attachment.triggerPatterns)) {
      stats.byField['innerLife.attachment.triggerPatterns'] = (stats.byField['innerLife.attachment.triggerPatterns'] || 0) + 1;
      il.attachment.triggerPatterns = asArray(il.attachment.triggerPatterns);
      stats.touchedFields++;
    }
  }
  if (il.theoryOfPlayer && typeof il.theoryOfPlayer === 'object') {
    for (const f of ['predictions', 'wrongAbout']) {
      if (!Array.isArray(il.theoryOfPlayer[f])) {
        stats.byField['innerLife.theoryOfPlayer.' + f] = (stats.byField['innerLife.theoryOfPlayer.' + f] || 0) + 1;
        il.theoryOfPlayer[f] = asArray(il.theoryOfPlayer[f]);
        stats.touchedFields++;
      }
    }
  }
  return il;
}

function normalizeNpcTopLevel(npc, stats) {
  if (!npc || typeof npc !== 'object') return false;
  let touched = false;
  for (const f of NPC_ARRAY_FIELDS) {
    if (!Array.isArray(npc[f])) {
      stats.byField['npc.' + f] = (stats.byField['npc.' + f] || 0) + 1;
      npc[f] = asArray(npc[f]);
      stats.touchedFields++;
      touched = true;
    }
  }
  if (npc.innerLife) {
    const before = stats.touchedFields;
    normalizeInnerLife(npc.innerLife, stats);
    if (stats.touchedFields > before) touched = true;
  }
  return touched;
}

function processFile(path, stats) {
  let raw, world;
  try { raw = readFileSync(path, 'utf8'); world = JSON.parse(raw); }
  catch (e) { stats.errors.push(path + ': ' + e.message); return false; }

  const fileStats = { touchedFields: 0, touchedNpcs: 0, byField: {} };

  const isSession = basename(path).startsWith('session-');

  if (isSession) {
    if (world.npcStates && typeof world.npcStates === 'object') {
      for (const npcId of Object.keys(world.npcStates)) {
        const ns = world.npcStates[npcId];
        if (!ns) continue;
        const before = fileStats.touchedFields;
        if (ns.innerLife) normalizeInnerLife(ns.innerLife, fileStats);
        if (fileStats.touchedFields > before) fileStats.touchedNpcs++;
      }
    }
  } else {
    // world-*.json
    if (Array.isArray(world.npcs)) {
      for (const npc of world.npcs) {
        const before = fileStats.touchedFields;
        normalizeNpcTopLevel(npc, fileStats);
        if (fileStats.touchedFields > before) fileStats.touchedNpcs++;
      }
    }
    // older worlds also stored sessions inline at world.sessions[]
    if (Array.isArray(world.sessions)) {
      for (const session of world.sessions) {
        if (!session || !session.npcStates) continue;
        for (const npcId of Object.keys(session.npcStates)) {
          const ns = session.npcStates[npcId];
          if (!ns) continue;
          const before = fileStats.touchedFields;
          if (ns.innerLife) normalizeInnerLife(ns.innerLife, fileStats);
          if (fileStats.touchedFields > before) fileStats.touchedNpcs++;
        }
      }
    }
  }

  if (fileStats.touchedFields > 0) {
    stats.filesChanged++;
    stats.totalNpcsTouched += fileStats.touchedNpcs;
    stats.totalFieldsTouched += fileStats.touchedFields;
    for (const f of Object.keys(fileStats.byField)) stats.byField[f] = (stats.byField[f] || 0) + fileStats.byField[f];
    console.log(`  ${basename(path)}: ${fileStats.touchedNpcs} npc(s), ${fileStats.touchedFields} field(s) fixed`);
    if (!DRY) {
      const backupPath = path + '.bak';
      if (!existsSync(backupPath)) copyFileSync(path, backupPath);
      writeFileSync(path, JSON.stringify(world, null, 2));
    }
    return true;
  }
  return false;
}

console.log(`normalize-inner-life ${DRY ? '(DRY RUN) ' : ''}- scanning ${DATA_DIR}`);

const stats = { filesScanned: 0, filesChanged: 0, totalNpcsTouched: 0, totalFieldsTouched: 0, byField: {}, errors: [] };

const allFiles = readdirSync(DATA_DIR).filter(f =>
  (f.startsWith('world-') || f.startsWith('session-')) &&
  f.endsWith('.json') &&
  !f.endsWith('.bak')
);

for (const f of allFiles) {
  const fpath = join(DATA_DIR, f);
  if (!statSync(fpath).isFile()) continue;
  stats.filesScanned++;
  processFile(fpath, stats);
}

console.log('');
console.log('=== Summary ===');
console.log(`  files scanned:  ${stats.filesScanned}`);
console.log(`  files changed:  ${stats.filesChanged}`);
console.log(`  NPCs touched:   ${stats.totalNpcsTouched}`);
console.log(`  fields fixed:   ${stats.totalFieldsTouched}`);
console.log(`  breakdown:`);
const sorted = Object.entries(stats.byField).sort((a,b) => b[1] - a[1]);
for (const [k, v] of sorted) console.log(`    ${k.padEnd(48)} ${v}`);
if (stats.errors.length) {
  console.log(`  errors:         ${stats.errors.length}`);
  for (const e of stats.errors) console.log('    - ' + e);
}
if (!DRY && stats.filesChanged > 0) {
  console.log('  backups:        .bak files written alongside modified originals');
}