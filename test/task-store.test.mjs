import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TaskStore, createTaskStore } from '../packages/task-store/index.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fish-task-store-test-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    assert.equal(resolve(directory), directory);
    assert.ok(directory.startsWith(join(tmpdir(), 'fish-task-store-test-')));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store() { const store = new TaskStore(directory); stores.push(store); return store; } };
}
const input = { cwd: 'C:\\work', prompt: 'Run a task' };

test('persists task snapshots and durable ordered events across reopen', t => {
  const f = fixture(t); const store = f.store();
  assert.equal(store.open(), store); assert.equal(store.open(), store);
  const task = store.create({ ...input, taskId: 'task-1' });
  assert.equal(task.sessionId, null); assert.equal(task.error, null); assert.equal(task.result, null);
  assert.equal(task.closed, false); assert.equal(task.status, 'queued');
  store.update(task.taskId, { status: 'running', sessionId: 'session-1' }, 'task.started');
  const finished = store.update(task.taskId, { status: 'completed', result: { answer: 42 }, closed: true }, 'task.completed');
  const events = store.events();
  assert.deepEqual(events.map(e => e.sequence), [1, 2, 3]);
  assert.deepEqual(events.map(e => e.type), ['task.created', 'task.started', 'task.completed']);
  assert.equal(new Set(events.map(e => e.eventId)).size, 3);
  assert.deepEqual(events[2].payload, finished);
  assert.equal(events[0].payload.status, 'queued');
  assert.deepEqual(store.events(1), events.slice(1));
  store.close(); store.close(); store.open();
  assert.deepEqual(store.get(task.taskId), finished);
  assert.deepEqual(store.list(), [finished]); assert.deepEqual(store.events(), events);
  assert.equal(store.get('absent'), null);
  assert.deepEqual(readdirSync(f.directory).sort(), ['task-store.json', 'task-store.lock']);
});

test('recovers queued/running once and never resubmits, preserving terminal states', t => {
  const f = fixture(t); const store = f.store().open();
  const statuses = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'];
  for (const status of statuses) store.create({ ...input, taskId: status, status });
  store.close(); store.open();
  assert.deepEqual(store.list().map(task => task.status), ['interrupted', 'interrupted', ...statuses.slice(2)]);
  assert.deepEqual(store.events(7).map(e => [e.taskId, e.type, e.sequence]), [['queued', 'task.interrupted', 8], ['running', 'task.interrupted', 9]]);
  store.close(); store.open(); assert.equal(store.events().length, 9);
});

test('rejects simultaneous owners and safely reopens after release', t => {
  const f = fixture(t); const first = f.store().open(); const second = f.store();
  assert.throws(() => second.open(), { code: 'STORE_LOCKED' });
  first.create({ ...input, status: 'completed' });
  second.close(); // A rejected contender must not remove the owner's lock.
  assert.throws(() => second.open(), { code: 'STORE_LOCKED' });
  first.close(); second.open(); assert.equal(second.list().length, 1);
});

test('reclaims a dead process lock and recovers its last committed task', t => {
  const f = fixture(t);
  const moduleUrl = new URL('../packages/task-store/index.mjs', import.meta.url).href;
  const source = `import { TaskStore } from ${JSON.stringify(moduleUrl)}; const s = new TaskStore(${JSON.stringify(f.directory)}).open(); s.create(${JSON.stringify({ ...input, taskId: 'crashed', status: 'running' })}); process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { stdio: 'inherit' });
  assert.equal(child.error, undefined); assert.equal(child.status, 0);
  const store = f.store().open();
  assert.equal(store.get('crashed').status, 'interrupted');
  assert.equal(store.events(1)[0].type, 'task.interrupted');
});

test('task IDs cannot collide or escape directory and returned data is detached', t => {
  const f = fixture(t); const store = f.store().open();
  const task = store.create({ ...input, taskId: '../outside', status: 'completed', result: { nested: [1] } });
  assert.throws(() => store.create({ ...input, taskId: '../outside' }), { code: 'TASK_EXISTS' });
  task.result.nested.push(2);
  store.get(task.taskId).result.nested.push(3);
  store.list()[0].result.nested.push(4);
  store.events()[0].payload.result.nested.push(5);
  assert.deepEqual(store.get(task.taskId).result, { nested: [1] });
  assert.equal(store.events().length, 1);
  assert.deepEqual(readdirSync(f.directory).sort(), ['task-store.json', 'task-store.lock']);
});

test('validates mutations before writing and rejects immutable fields', t => {
  const f = fixture(t); const store = f.store();
  assert.throws(() => store.list(), { code: 'STORE_CLOSED' }); store.open();
  const task = store.create({ ...input, taskId: undefined });
  assert.match(task.taskId, /^[0-9a-f-]{36}$/);
  const before = readFileSync(join(f.directory, 'task-store.json'), 'utf8');
  for (const patch of [{ status: 'invented' }, { taskId: 'new-id' }, { createdAt: 'yesterday' }, { result: NaN }, { closed: 'yes' }, { error: undefined }, { result: new Date() }]) assert.throws(() => store.update(task.taskId, patch), TypeError);
  const circular = {}; circular.self = circular;
  assert.throws(() => store.update(task.taskId, { result: circular }), TypeError);
  assert.throws(() => store.update('absent', { closed: true }), { code: 'TASK_NOT_FOUND' });
  assert.throws(() => store.events(-1), TypeError);
  assert.equal(readFileSync(join(f.directory, 'task-store.json'), 'utf8'), before);
  assert.equal(store.events().length, 1);
});

test('failed atomic replacement does not publish in-memory mutations', t => {
  const f = fixture(t); const store = f.store().open();
  const task = store.create({ ...input, status: 'completed' });
  const file = join(f.directory, 'task-store.json');
  assert.equal(resolve(file), join(f.directory, 'task-store.json'));
  rmSync(file); mkdirSync(file);
  assert.throws(() => store.update(task.taskId, { result: 'not committed' }));
  assert.equal(store.get(task.taskId).result, null); assert.equal(store.events().length, 1);
  assert.equal(readdirSync(f.directory).filter(name => name.endsWith('.tmp')).length, 0);
});

test('corrupt persistence fails closed, releases lock, and leaves unrelated files intact', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'notes.txt'), 'unrelated');
  writeFileSync(join(f.directory, 'task-store.json'), '{broken');
  const store = f.store(); assert.throws(() => store.open(), SyntaxError);
  assert.equal(readFileSync(join(f.directory, 'task-store.json'), 'utf8'), '{broken');
  assert.equal(readFileSync(join(f.directory, 'notes.txt'), 'utf8'), 'unrelated');
  assert.ok(!readdirSync(f.directory).includes('task-store.lock'));
  writeFileSync(join(f.directory, 'task-store.json'), JSON.stringify({ version: 1, sequence: 1, tasks: [], events: [] }));
  assert.throws(() => store.open(), { code: 'STORE_CORRUPT' });
});

test('unreadable lock is preserved and factory creates closed store', t => {
  const f = fixture(t); writeFileSync(join(f.directory, 'task-store.lock'), 'partial-lock');
  const store = createTaskStore(f.directory);
  assert.throws(() => store.open(), { code: 'STORE_LOCKED' });
  assert.equal(readFileSync(join(f.directory, 'task-store.lock'), 'utf8'), 'partial-lock');
  assert.throws(() => store.get('x'), { code: 'STORE_CLOSED' });
});
