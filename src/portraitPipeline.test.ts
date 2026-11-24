import assert from 'node:assert';
import { parsePipelineResult, applyPipelineResult, withCacheBust, PIPELINE_RESULT_SENTINEL } from './portraitPipeline.js';

// --- parsePipelineResult ---
const stdout = [
  '[world] world-build_x.json',
  '[face] anchors=3/12 usable matches=3',
  PIPELINE_RESULT_SENTINEL + JSON.stringify({
    world: 'world-build_x.json', buildId: 'build_x', source: 'imdb', skipped: null,
    film: { tmdb: 1903, imdb: 'tt0259711', title: 'Vanilla Sky', year: '2001' },
    swaps_detail: [
      { npcId: 'npc_sofia', npcName: 'Sofia Serrano', character: 'Sofia Serrano', actor: 'Penélope Cruz', score: 0.51, w: 626, h: 731, crop: 'x/Sofia.jpg', applied: true },
      { npcId: 'npc_dry', npcName: 'Dry Run', character: 'Dry Run', actor: 'A', score: 0.4, w: 500, h: 500, crop: 'x/Dry.jpg', applied: false },
    ],
    skipped_swaps: [{ character: 'Brian Shelby', reason: 'below min-face-px gate' }],
  }),
].join('\n');

const parsed = parsePipelineResult(stdout);
assert.ok(parsed, 'should parse a result');
assert.strictEqual(parsed!.buildId, 'build_x');
assert.strictEqual(parsed!.swaps.length, 2);
assert.strictEqual(parsed!.skippedSwaps.length, 1);

assert.strictEqual(parsePipelineResult('no sentinel here'), null, 'no sentinel -> null');
assert.strictEqual(parsePipelineResult(PIPELINE_RESULT_SENTINEL + '{bad json'), null, 'bad json -> null');

// --- withCacheBust ---
assert.strictEqual(withCacheBust('/generated/x/a.jpg', 123), '/generated/x/a.jpg?v=123');
assert.strictEqual(withCacheBust('/generated/x/a.jpg?v=99', 123), '/generated/x/a.jpg?v=123', 'replaces existing v');

// --- applyPipelineResult ---
const world: any = {
  id: 'build_x',
  npcs: [{ id: 'npc_sofia', name: 'Sofia Serrano', images: { portrait: '/generated/build_x/sofia.jpg' } }],
  images: { portraits: { npc_sofia: '/generated/build_x/sofia.jpg' }, portraitSources: {} },
};
const { appliedNpcIds } = applyPipelineResult(world, parsed!, 777);
assert.deepStrictEqual(appliedNpcIds, ['npc_sofia'], 'only applied=true swaps are applied');
assert.strictEqual(world.images.portraitSources['npc_sofia'].kind, 'arcface');
assert.strictEqual(world.images.portraitSources['npc_sofia'].actor, 'Penélope Cruz');
assert.strictEqual(world.images.portraits['npc_sofia'], '/generated/build_x/sofia.jpg?v=777');
assert.strictEqual(world.npcs[0].images.portrait, '/generated/build_x/sofia.jpg?v=777');
assert.ok(!('npc_dry' in world.images.portraitSources), 'dry-run swap not applied');

console.log('portraitPipeline.test.ts: all assertions passed');
