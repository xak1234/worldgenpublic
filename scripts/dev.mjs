// Cross-platform `npm run dev`: tsx watch with a large heap for the dev server.
// (The old `set NODE_OPTIONS=... &&` form only worked in cmd.exe.)
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const heapMb = process.env.WORLDGEN_DEV_HEAP_MB || '8192';
const ignored = ['./data', './public', './release', './.playwright-mcp', './generated', './node_modules'];

const child = spawn(process.execPath, [
  join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  'watch',
  ...ignored.flatMap(dir => ['--ignore', dir]),
  'src/index.ts',
], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${heapMb}`.trim() },
});
child.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
