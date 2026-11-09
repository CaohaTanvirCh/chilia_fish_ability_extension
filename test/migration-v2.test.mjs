import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskStore } from '../packages/task-store/index.mjs';
import { ExecutionStore } from '../packages/task-store-v2/index.mjs';
import { migrateV1 } from '../scripts/migrate-v1.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fish-migration-v2-')); const source = join(root, 'source'), target = join(root, 'target'); mkdirSync(source);
  t.after(() => { assert.equal(resolve(root), root); assert.ok(root.startsWith(join(tmpdir(), 'fish-migration-v2-'))); rmSync(root, { recursive: true, force: true }); });
  return { root, source, target };
}
function legacy(source) {
  const store = new TaskStore(source).open();
  try {
    for (const status of ['completed', 'cancelled', 'running', 'queued']) store.create({ taskId: status, cwd: 'C:\\work', prompt: 'legacy prompt', status, sessionId: `session-${status}`, result: `output-${status}`, closed: status === 'cancelled' });
  } finally { store.close(); }
  return readFileSync(join(source, 'task-store.json'), 'utf8');
}

test('explicit migration preserves exact original backup and imports every outcome as uncertain', t => {
  const { source, target, root } = fixture(t); const raw = legacy(source);
  const result = migrateV1(source, target); assert.equal(result.tasks, 4);
  assert.equal(readFileSync(join(source, 'task-store.json'), 'utf8'), raw);
  assert.equal(readFileSync(join(target, 'legacy-v1-backup.json'), 'utf8'), raw);
  assert.deepEqual(readdirSync(source), ['task-store.json']); assert.deepEqual(readdirSync(root).sort(), ['source', 'target']);
  const store = new ExecutionStore(target).open();
  try {
    const state = store.snapshot(); assert.equal(state.executions.length, 4); assert.equal(state.requests.length, 0);
    for (const e of state.executions) { assert.equal(e.status, 'unknown'); assert.equal(e.resultIntegrity, 'uncertain'); assert.equal(e.completionEvidence, null); assert.equal(e.result, `output-${e.taskId}`); }
    assert.deepEqual(state.executions.map(e => e.legacyReportedStatus), ['completed', 'cancelled', 'running', 'queued']);
    assert.equal(state.tasks.find(t => t.taskId === 'cancelled').lifecycle, 'closed');
    assert.ok(state.tasks.every(t => t.duplicateExecutionRisk && t.activeExecutionId === null));
    assert.ok(state.bindings.every(b => b.availability === 'unknown'));
  } finally { store.close(); }
  assert.throws(() => migrateV1(source, target), /must not exist/); assert.equal(readFileSync(join(target, 'legacy-v1-backup.json'), 'utf8'), raw);
});

test('live source owner and preexisting destination guard prevent migration without touching source', t => {
  const { source, target } = fixture(t); legacy(source); const owner = new TaskStore(source).open(); const raw = readFileSync(join(source, 'task-store.json'), 'utf8');
  try { assert.throws(() => migrateV1(source, target), { code: 'EEXIST' }); assert.equal(existsSync(target), false); assert.ok(existsSync(join(source, 'task-store.lock'))); }
  finally { owner.close(); }
  writeFileSync(`${target}.migration.lock`, 'owned by another migration');
  assert.throws(() => migrateV1(source, target), { code: 'EEXIST' }); assert.equal(readFileSync(`${target}.migration.lock`, 'utf8'), 'owned by another migration');
  assert.equal(readFileSync(join(source, 'task-store.json'), 'utf8'), raw); assert.equal(existsSync(join(source, 'task-store.lock')), false);
});

test('malformed source cannot publish valid target and preserves marked staging and source bytes', t => {
  const { root, source, target } = fixture(t); const valid = JSON.parse(legacy(source)); valid.tasks[0].status = 'forged'; const raw = JSON.stringify(valid); writeFileSync(join(source, 'task-store.json'), raw);
  assert.throws(() => migrateV1(source, target)); assert.equal(existsSync(target), false); assert.equal(readFileSync(join(source, 'task-store.json'), 'utf8'), raw);
  const stagingName = readdirSync(root).find(name => name.startsWith('target.migration-')); assert.ok(stagingName);
  const staging = join(root, stagingName); assert.equal(readFileSync(join(staging, 'legacy-v1-backup.json'), 'utf8'), raw);
  const store = new ExecutionStore(staging); assert.throws(() => store.open(), { code: 'MIGRATION_INCOMPLETE' });
  assert.equal(existsSync(join(source, 'task-store.lock')), false); assert.equal(existsSync(`${target}.migration.lock`), false);
});

test('target is never overwritten, and incomplete markers fail closed even with valid state', t => {
  const { source, target } = fixture(t); legacy(source); mkdirSync(target); writeFileSync(join(target, 'keep.txt'), 'untouched');
  assert.throws(() => migrateV1(source, target), /must not exist/); assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'untouched');
  const store = new ExecutionStore(target).open(); store.close(); writeFileSync(join(target, 'MIGRATION_INCOMPLETE'), 'failed import');
  assert.throws(() => store.open(), { code: 'MIGRATION_INCOMPLETE' }); assert.equal(existsSync(join(target, 'store-v2.lock')), false);
});
