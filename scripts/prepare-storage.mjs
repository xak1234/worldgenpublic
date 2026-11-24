#!/usr/bin/env node
// Copy this checkout's runtime state into a deployment volume layout:
//
//   <dest>/data/       worlds, sessions, players.json, baselines
//   <dest>/generated/  public/generated (portraits, covers, scenes)
//   <dest>/uploads/    public/uploads (source scripts / PDFs)
//   <dest>/state/      state/ (orchestrator flags)
//   <dest>/audio/      public/audio (only with --with-audio; ~15 GB)
//
// Debug dumps, archives, build checkpoints, backups and temp files are left behind.
// Existing files in <dest> are kept unless --overwrite is given, so re-running against a
// live volume never replaces newer players.json / sessions with this checkout's copies.
//
//   node scripts/prepare-storage.mjs ./storage [--with-audio] [--overwrite] [--dry-run]
import { cpSync, existsSync, mkdirSync, statSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const root = process.env.WORLDGEN_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const destArg = args.find(a => !a.startsWith('--'));
if (!destArg) {
  console.error('usage: node scripts/prepare-storage.mjs <dest> [--with-audio] [--dry-run]');
  process.exit(1);
}
const dest = resolve(destArg);
const withAudio = args.includes('--with-audio');
const dryRun = args.includes('--dry-run');
const overwrite = args.includes('--overwrite');
const dataDir = process.env.WORLDGEN_DATA_DIR ? resolve(root, process.env.WORLDGEN_DATA_DIR) : join(root, 'data');

const SKIP_DATA_DIRS = new Set(['archive', 'dialogue-debug', 'failed-json', '.build-checkpoints', '_backups', '_orphaned']);
const SKIP_FILE = /\.(bak|tmp|py|js|log)$|\.bak\.|\.tmp\.\d+|\.precastfix\.bak$/i;

const plan = [
  { from: dataDir, to: join(dest, 'data'), filter: (src) => {
    const rel = relative(dataDir, src);
    if (!rel) return true;
    if (SKIP_DATA_DIRS.has(rel.split(sep)[0])) return false;
    return statSync(src).isDirectory() || !SKIP_FILE.test(basename(src));
  } },
  { from: join(root, 'public', 'generated'), to: join(dest, 'generated'), filter: () => true },
  { from: join(root, 'public', 'uploads'), to: join(dest, 'uploads'), filter: () => true },
  { from: join(root, 'state'), to: join(dest, 'state'), filter: () => true },
  ...(withAudio ? [{ from: join(root, 'public', 'audio'), to: join(dest, 'audio'), filter: () => true }] : []),
];

for (const { from, to, filter } of plan) {
  if (!existsSync(from)) {
    console.log(`skip  ${relative(root, from)} (missing)`);
    continue;
  }
  console.log(`${dryRun ? 'would copy' : 'copy'}  ${from} -> ${to}`);
  if (dryRun) continue;
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, filter, force: overwrite, errorOnExist: false, preserveTimestamps: true });
}
console.log(dryRun ? 'dry run complete' : `storage ready at ${dest}`);
