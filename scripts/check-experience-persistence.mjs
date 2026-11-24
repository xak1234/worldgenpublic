import { readFileSync } from 'fs';

const indexSource = readFileSync('src/index.ts', 'utf8');
const typesSource = readFileSync('src/types.ts', 'utf8');

const reducerStart = indexSource.indexOf('function toPersistentNpcCharacterState');
const reducerEnd = indexSource.indexOf('function createInitialInnerLife', reducerStart);
const reducer = reducerStart >= 0 && reducerEnd > reducerStart ? indexSource.slice(reducerStart, reducerEnd) : '';

const typeStart = typesSource.indexOf('export interface PersistentNpcCharacterState');
const typeEnd = typesSource.indexOf('export interface PersistentPlayerProfile', typeStart);
const persistentType = typeStart >= 0 && typeEnd > typeStart ? typesSource.slice(typeStart, typeEnd) : '';

const requiredFields = [
  'mood',
  'currentLocationId',
  'currentActivity',
  'isAvailable',
  'recentLifeEvents',
  'currentWorry',
  'currentGoal',
  'activeGoals',
  'environmentalAwareness',
  'emotionalContagionLog',
  'activeConversation',
  'innerLife',
  'memories',
  'playerOpinion',
  'patternsNoticed',
  'impossibleGiftsReceived',
];

const missingType = requiredFields.filter(field => !new RegExp(`\\b${field}\\??:`).test(persistentType));
const missingReducer = requiredFields.filter(field => !new RegExp(`\\b${field}:`).test(reducer));

function routeBody(path) {
  const marker = `app.post('${path}'`;
  const start = indexSource.indexOf(marker);
  if (start < 0) return '';
  const next = indexSource.indexOf('\napp.', start + marker.length);
  return next > start ? indexSource.slice(start, next) : indexSource.slice(start);
}

function functionBody(name) {
  const marker = `function ${name}`;
  const start = indexSource.indexOf(marker);
  if (start < 0) return '';
  const next = indexSource.indexOf('\nfunction ', start + marker.length);
  return next > start ? indexSource.slice(start, next) : indexSource.slice(start);
}

const scopedChecks = [
  ['player action witnesses', routeBody('/api/sessions/:id/action'), ['noteNpcExperience', 'addPlayerWitnessMemory', 'persistSessionState']],
  ['movement witnesses', routeBody('/api/sessions/:id/move'), ['noteNpcExperience', 'addPlayerWitnessMemory', 'persistSessionState']],
  ['shared merge', functionBody('mergeNpcSharedStates'), ['toPersistentNpcSharedState']],
  ['profile sync', functionBody('syncPlayerProfileFromSession'), ['toPersistentNpcCharacterState']],
  ['quest-safe profile persistence', functionBody('persistSessionState'), ['session.activeQuest?.status', 'syncPlayerProfileFromSession', 'saveWorld']],
];
const missingRoutes = scopedChecks
  .filter(([, scope, needles]) => !scope || needles.some(needle => !scope.includes(needle)))
  .map(([name]) => name);

if (missingType.length || missingReducer.length || missingRoutes.length) {
  if (missingType.length) console.error(`PersistentNpcCharacterState missing fields: ${missingType.join(', ')}`);
  if (missingReducer.length) console.error(`toPersistentNpcCharacterState missing fields: ${missingReducer.join(', ')}`);
  if (missingRoutes.length) console.error(`Experience route checks failed: ${missingRoutes.join(', ')}`);
  process.exit(1);
}

console.log(`Experience persistence check passed: ${requiredFields.length} fields and ${scopedChecks.length} scoped guards audited.`);
