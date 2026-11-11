import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoreV3, STORE_V3_INTERNAL_COMMIT } from '../packages/task-store-v3/index.mjs';

const INTERNAL = STORE_V3_INTERNAL_COMMIT;
const crashFixture = fileURLToPath(new URL('./fixtures/store-v3-crash.mjs', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-store-v3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    stateFile: join(dir, 'state-v3.json'),
    lockFile: join(dir, 'store-v3.lock'),
    make(options) { return new StoreV3(dir, options); },
  };
}
function event(overrides = {}) {
  return {
    scope: 'system',
    workspaceId: null,
    type: 'foundation.test',
    schemaVersion: 1,
    source: 'system',
    audience: 'system',
    actorPrincipalId: null,
    taskId: null,
    executionId: null,
    artifactId: null,
    correlationId: null,
    causationId: null,
    data: { ok: true },
    ...overrides,
  };
}
function addTask(draft, taskId = 'task-1') {
  draft.tasks.push({ taskId });
  return [event({ data: { taskId } })];
}
function readState(dir) {
  return JSON.parse(readFileSync(join(dir, 'state-v3.json'), 'utf8'));
}
function writeState(dir, state) {
  writeFileSync(join(dir, 'state-v3.json'), JSON.stringify(state) + '\n', 'utf8');
}
function tempFiles(dir) {
  return readdirSync(dir).filter(name => name.endsWith('.tmp'));
}
function child(dir, mode) {
  return spawnSync(process.execPath, [crashFixture, dir, mode], { encoding: 'utf8', timeout: 15000 });
}

test('v3 initializes a complete isolated snapshot', t => {
  const f = fixture(t);
  const store = f.make().open();
  const state = store.snapshot();
  assert.equal(state.version, 3);
  assert.equal(state.revision, 0);
  assert.equal(state.sequence, 0);
  assert.equal(state.authorizationRevision, 0);
  assert.deepEqual(state.authorizationState, { authorizationRevision: 0 });
  assert.equal(state.bootstrapState, null);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.events.length, 0);
  for (const name of [
    'principals', 'workspaces', 'workspaceMembers', 'membershipRevisions', 'membershipInvites',
    'delegations', 'revocationFences', 'tasks', 'executions', 'sessionBindings', 'artifacts',
    'artifactReferences', 'artifactGrants', 'workspaceLeases', 'requests', 'events', 'migrationRecords',
  ]) assert.deepEqual(state[name], [], name);
  assert.equal(typeof store.commit, 'undefined');
  assert.equal(typeof store.commitAuthorized, 'undefined');
  assert.equal(typeof store[INTERNAL], 'function');
  assert.ok(existsSync(f.stateFile));
  assert.ok(existsSync(f.lockFile));
  assert.equal(existsSync(join(f.dir, 'state-v2.json')), false);
  const health = store.healthCheck();
  assert.equal(health.healthy, true);
  assert.equal(health.revision, 0);
  assert.equal(health.sequence, 0);
  assert.equal(typeof health.directorySyncSupported, 'boolean');
  if (process.platform === 'win32') assert.equal(health.directorySyncSupported, false);
  store.close();
  assert.throws(() => store.snapshot(), { code: 'STORE_CLOSED' });
});

test('commit persists the whole snapshot and survives reopen', t => {
  const f = fixture(t);
  const store = f.make().open();
  const committed = store[INTERNAL](0, draft => {
    draft.tasks.push({ taskId: 'task-1', objective: 'persist me' });
    return [event({ data: { taskId: 'task-1' } })];
  });
  assert.equal(committed.revision, 1);
  assert.equal(committed.sequence, 1);
  assert.deepEqual(committed.tasks, [{ taskId: 'task-1', objective: 'persist me' }]);
  assert.equal(committed.events.length, 1);
  assert.equal(committed.events[0].sequence, 1);
  assert.equal(committed.events[0].revision, 1);
  assert.equal(committed.events[0].scope, 'system');
  assert.equal(committed.events[0].workspaceId, null);
  assert.equal(committed.authorizationRevision, 0);
  store.close();

  const reopened = f.make().open();
  assert.deepEqual(reopened.snapshot(), committed);
  reopened.close();
});

test('revision and global event sequence are strictly increasing and detached', t => {
  const f = fixture(t);
  const store = f.make().open();
  const first = store[INTERNAL](0, draft => {
    draft.tasks.push({ taskId: 'task-1' });
    return [event({ data: { n: 1 } }), event({ data: { n: 2 } })];
  });
  assert.equal(first.revision, 1);
  assert.equal(first.sequence, 2);
  const second = store[INTERNAL](1, draft => {
    draft.tasks.push({ taskId: 'task-2' });
    return [event({ data: { n: 3 } })];
  });
  assert.equal(second.revision, 2);
  assert.deepEqual(second.events.map(e => e.sequence), [1, 2, 3]);
  assert.deepEqual(second.events.map(e => e.revision), [1, 1, 2]);
  assert.equal(second.authorizationRevision, 0);

  const detached = store.snapshot();
  detached.tasks[0].taskId = 'tampered';
  detached.events[0].type = 'tampered';
  assert.equal(store.snapshot().tasks[0].taskId, 'task-1');
  assert.equal(store.snapshot().events[0].type, 'foundation.test');
  store.close();
});

test('stale expectedRevision is rejected without changing disk or memory', t => {
  const f = fixture(t);
  const store = f.make().open();
  store[INTERNAL](0, draft => addTask(draft));
  const before = store.snapshot();
  const bytes = readFileSync(f.stateFile, 'utf8');
  assert.throws(() => store[INTERNAL](0, draft => addTask(draft, 'task-2')), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(store.snapshot(), before);
  assert.equal(readFileSync(f.stateFile, 'utf8'), bytes);
  const next = store[INTERNAL](1, draft => addTask(draft, 'task-2'));
  assert.equal(next.revision, 2);
  assert.equal(next.sequence, 2);
  store.close();
});

test('invalid JSON values are rejected before persistence', t => {
  const f = fixture(t);
  const store = f.make().open();
  assert.throws(() => store[INTERNAL](0, draft => {
    draft.tasks.push({ taskId: 'bad', value: undefined });
    return [];
  }), { code: 'VALIDATION' });
  assert.throws(() => store[INTERNAL](0, draft => {
    draft.tasks.push({ taskId: 'cycle', loop: draft });
    return [];
  }), { code: 'VALIDATION' });
  assert.throws(() => store[INTERNAL](0, draft => {
    draft.tasks.push({ taskId: 'function', value: () => {} });
    return [];
  }), { code: 'VALIDATION' });
  assert.equal(store.snapshot().revision, 0);
  assert.equal(store.snapshot().tasks.length, 0);
  store.close();
});

test('a transaction cannot change store metadata or existing events', t => {
  const f = fixture(t);
  const store = f.make().open();
  for (const mutate of [
    draft => { draft.revision = 99; },
    draft => { draft.sequence = 99; },
    draft => { draft.authorizationRevision = 1; },
    draft => { draft.authorizationState.authorizationRevision = 1; },
    draft => { draft.events.push(event()); },
  ]) {
    assert.throws(() => store[INTERNAL](0, draft => { mutate(draft); return []; }), { code: 'INVALID_TRANSACTION' });
  }
  assert.equal(store.snapshot().revision, 0);
  store.close();
});

test('event input schema and 4 KiB limit are enforced', t => {
  const f = fixture(t);
  const store = f.make().open();
  for (const bad of [
    event({ type: '' }),
    event({ scope: 'global' }),
    event({ workspaceId: 'ws-1' }),
    event({ scope: 'workspace' }),
    event({ source: 'somebody' }),
    event({ audience: 'public' }),
    event({ schemaVersion: 0 }),
    event({ eventId: 'not-allowed' }),
  ]) {
    assert.throws(() => store[INTERNAL](0, () => [bad]), { code: 'VALIDATION' });
  }
  assert.throws(() => store[INTERNAL](0, () => [event({ data: { text: 'x'.repeat(5000) } })]), { code: 'CAPACITY' });
  assert.throws(() => store[INTERNAL](0, () => [event({ type: 'x'.repeat(5000) })]), { code: 'CAPACITY' });
  assert.equal(store.snapshot().revision, 0);
  assert.equal(store.snapshot().sequence, 0);
  store.close();
});

test('workspace-scoped events persist with their workspace id', t => {
  const f = fixture(t);
  const store = f.make().open();
  const state = store[INTERNAL](0, draft => {
    draft.workspaces.push({ workspaceId: 'workspace-1' });
    return [event({ scope: 'workspace', workspaceId: 'workspace-1' })];
  });
  assert.equal(state.events[0].scope, 'workspace');
  assert.equal(state.events[0].workspaceId, 'workspace-1');
  store.close();
  const reopened = f.make().open();
  assert.equal(reopened.snapshot().events[0].workspaceId, 'workspace-1');
  reopened.close();
});

test('collection identity and membership uniqueness are enforced', t => {
  const f = fixture(t);
  const store = f.make().open();
  assert.throws(() => store[INTERNAL](0, draft => {
    draft.tasks.push({ taskId: 'same' }, { taskId: 'same' });
    return [];
  }), { code: 'VALIDATION' });
  assert.throws(() => store[INTERNAL](0, draft => {
    draft.workspaceMembers.push({ workspaceId: 'workspace-1' });
    return [];
  }), { code: 'VALIDATION' });
  assert.throws(() => store[INTERNAL](0, draft => {
    draft.workspaceMembers.push(
      { workspaceId: 'workspace-1', principalId: 'principal-1' },
      { workspaceId: 'workspace-1', principalId: 'principal-1' },
    );
    return [];
  }), { code: 'VALIDATION' });
  assert.equal(store.snapshot().revision, 0);
  store.close();
});

test('second owner is rejected and normal close releases the lock', t => {
  const f = fixture(t);
  const first = f.make().open();
  const second = f.make();
  assert.throws(() => second.open(), { code: 'STORE_LOCKED' });
  assert.ok(existsSync(f.lockFile));
  first.close();
  assert.equal(existsSync(f.lockFile), false);
  second.open();
  assert.equal(second.snapshot().revision, 0);
  second.close();
});

test('live and unreadable locks are preserved', t => {
  const live = fixture(t);
  writeFileSync(live.lockFile, JSON.stringify({ pid: process.pid, token: 'foreign' }));
  assert.throws(() => live.make().open(), { code: 'STORE_LOCKED' });
  assert.equal(JSON.parse(readFileSync(live.lockFile, 'utf8')).token, 'foreign');

  const unreadable = fixture(t);
  writeFileSync(unreadable.lockFile, '{partial');
  assert.throws(() => unreadable.make().open(), { code: 'STORE_LOCKED' });
  assert.equal(readFileSync(unreadable.lockFile, 'utf8'), '{partial');
});

test('a store cannot remove a lock it no longer owns', t => {
  const f = fixture(t);
  const store = f.make().open();
  const lock = JSON.parse(readFileSync(f.lockFile, 'utf8'));
  writeFileSync(f.lockFile, JSON.stringify({ ...lock, token: 'foreign' }));
  assert.throws(() => store.close(), { code: 'STORE_LOCKED' });
  assert.ok(existsSync(f.lockFile));
});

test('a dead process lock is reclaimed conservatively', t => {
  const f = fixture(t);
  const result = child(f.dir, 'open-only');
  assert.equal(result.status, 42, result.stderr);
  assert.ok(existsSync(f.lockFile));
  const store = f.make().open();
  assert.equal(store.snapshot().revision, 0);
  assert.equal(store.healthCheck().healthy, true);
  store.close();
});

test('a process exit after commit leaves a recoverable committed snapshot', t => {
  const f = fixture(t);
  const result = child(f.dir, 'after-commit');
  assert.equal(result.status, 42, result.stderr);
  const store = f.make().open();
  const state = store.snapshot();
  assert.equal(state.revision, 1);
  assert.equal(state.sequence, 1);
  assert.equal(state.tasks[0].taskId, 'crash-task');
  store.close();
});

test('a corrupt snapshot is rejected and the lock is released', t => {
  const f = fixture(t);
  f.make().open().close();
  writeFileSync(f.stateFile, '{not json');
  assert.throws(() => f.make().open(), { code: 'STORE_CORRUPT' });
  assert.equal(existsSync(f.lockFile), false);
});

test('unsupported schema version is rejected and the lock is released', t => {
  const f = fixture(t);
  f.make().open().close();
  const state = readState(f.dir);
  state.version = 4;
  writeState(f.dir, state);
  assert.throws(() => f.make().open(), { code: 'STORE_VERSION_UNSUPPORTED' });
  assert.equal(existsSync(f.lockFile), false);
});

test('missing collections, invalid revision, and invalid sequence fail closed', t => {
  const cases = [
    { name: 'missing tasks', mutate: state => { delete state.tasks; } },
    { name: 'bad revision', mutate: state => { state.revision = -1; } },
    { name: 'bad sequence', mutate: state => { state.sequence = 1; } },
    { name: 'auth projection mismatch', mutate: state => { state.authorizationState.authorizationRevision = 1; } },
  ];
  for (const item of cases) {
    const f = fixture(t);
    f.make().open().close();
    const state = readState(f.dir);
    item.mutate(state);
    writeState(f.dir, state);
    assert.throws(() => f.make().open(), { code: 'STORE_CORRUPT' }, item.name);
    assert.equal(existsSync(f.lockFile), false, item.name);
  }
});

test('event sequence corruption on disk is rejected', t => {
  const f = fixture(t);
  const store = f.make().open();
  store[INTERNAL](0, draft => addTask(draft));
  store.close();
  const state = readState(f.dir);
  state.events[0].sequence = 2;
  writeState(f.dir, state);
  assert.throws(() => f.make().open(), { code: 'STORE_CORRUPT' });
});

test('residual temporary files are never treated as authoritative', t => {
  const f = fixture(t);
  const store = f.make().open();
  store[INTERNAL](0, draft => addTask(draft));
  store.close();
  const before = readFileSync(f.stateFile, 'utf8');
  writeFileSync(join(f.dir, 'state-v3.json.dead.tmp'), '{"version":99}');
  const reopened = f.make().open();
  assert.equal(reopened.snapshot().revision, 1);
  assert.equal(reopened.snapshot().tasks[0].taskId, 'task-1');
  assert.equal(readFileSync(f.stateFile, 'utf8'), before);
  reopened.close();
});

test('v3 coexistence does not read or rewrite v2 files', t => {
  const f = fixture(t);
  const v2State = join(f.dir, 'state-v2.json');
  const v2Lock = join(f.dir, 'store-v2.lock');
  writeFileSync(v2State, '{"version":2,"revision":7}\n');
  writeFileSync(v2Lock, '{"pid":1,"token":"v2"}\n');
  const beforeState = readFileSync(v2State, 'utf8');
  const beforeLock = readFileSync(v2Lock, 'utf8');
  const store = f.make().open();
  assert.equal(store.snapshot().revision, 0);
  assert.equal(readFileSync(v2State, 'utf8'), beforeState);
  assert.equal(readFileSync(v2Lock, 'utf8'), beforeLock);
  store.close();
});

test('pre-rename faults preserve the old snapshot and clean temporary files', t => {
  const faults = {};
  const f = fixture(t);
  const store = f.make({ faults }).open();
  const before = readFileSync(f.stateFile, 'utf8');
  for (const name of ['beforeWrite', 'afterWrite', 'syncTemp', 'closeTemp', 'beforeRename', 'rename']) {
    faults[name] = () => { throw Object.assign(new Error(`injected ${name}`), { code: 'EIO' }); };
    assert.throws(() => store[INTERNAL](0, draft => addTask(draft, `fault-${name}`)), /injected/);
    assert.equal(store.snapshot().revision, 0);
    assert.equal(readFileSync(f.stateFile, 'utf8'), before);
    assert.deepEqual(tempFiles(f.dir), []);
    delete faults[name];
  }
  store[INTERNAL](0, draft => addTask(draft, 'after-faults'));
  assert.equal(store.snapshot().revision, 1);
  store.close();
});

test('post-rename faults fail closed and reopen verifies the new disk state', t => {
  for (const name of ['afterRename', 'syncDirectory', 'closeDirectory']) {
    const faults = {};
    const f = fixture(t);
    const store = f.make({ faults }).open();
    faults[name] = () => { throw Object.assign(new Error(`injected ${name}`), { code: 'EIO' }); };
    assert.throws(() => store[INTERNAL](0, draft => addTask(draft, 'durable-task')), { code: 'STORE_DURABILITY_UNCERTAIN' });
    assert.throws(() => store.snapshot(), { code: 'STORE_FAILED' });
    const health = store.healthCheck();
    assert.equal(health.healthy, false);
    assert.equal(health.code, 'STORE_DURABILITY_UNCERTAIN');
    assert.throws(() => store[INTERNAL](1, draft => addTask(draft, 'must-not-write')), { code: 'STORE_FAILED' });
    const disk = readState(f.dir);
    assert.equal(disk.revision, 1);
    assert.equal(disk.tasks[0].taskId, 'durable-task');
    store.close();
    const reopened = f.make().open();
    assert.equal(reopened.snapshot().revision, 1);
    assert.equal(reopened.snapshot().tasks[0].taskId, 'durable-task');
    reopened.close();
  }
});

test('initial snapshot write failure releases the lock and does not invent state', t => {
  const faults = { beforeWrite: () => { throw Object.assign(new Error('injected initial failure'), { code: 'EIO' }); } };
  const f = fixture(t);
  assert.throws(() => f.make({ faults }).open(), /injected initial failure/);
  assert.equal(existsSync(f.stateFile), false);
  assert.equal(existsSync(f.lockFile), false);
});

test('initial post-rename failure fails closed but leaves a verifiable snapshot', t => {
  const faults = { afterRename: () => { throw Object.assign(new Error('injected initial rename failure'), { code: 'EIO' }); } };
  const f = fixture(t);
  assert.throws(() => f.make({ faults }).open(), { code: 'STORE_DURABILITY_UNCERTAIN' });
  assert.equal(existsSync(f.lockFile), false);
  assert.equal(readState(f.dir).revision, 0);
  const reopened = f.make().open();
  assert.equal(reopened.snapshot().revision, 0);
  reopened.close();
});

test('a fail-closed instance can be closed and reopened against the disk', t => {
  const faults = {};
  const f = fixture(t);
  const store = f.make({ faults }).open();
  faults.afterRename = () => { throw Object.assign(new Error('injected durability failure'), { code: 'EIO' }); };
  assert.throws(() => store[INTERNAL](0, draft => addTask(draft, 'reopen-task')), { code: 'STORE_DURABILITY_UNCERTAIN' });
  assert.throws(() => store.open(), { code: 'STORE_DURABILITY_UNCERTAIN' });
  store.close();
  store.open();
  assert.equal(store.snapshot().revision, 1);
  assert.equal(store.snapshot().tasks[0].taskId, 'reopen-task');
  store.close();
});

test('undefined or non-function transaction builders are rejected', t => {
  const f = fixture(t);
  const store = f.make().open();
  assert.throws(() => store[INTERNAL](0, null), { code: 'VALIDATION' });
  assert.throws(() => store[INTERNAL](-1, () => []), { code: 'VALIDATION' });
  assert.throws(() => store[INTERNAL](0, () => { throw new Error('builder failed'); }), /builder failed/);
  assert.throws(() => store[INTERNAL](0, () => { store.close(); return []; }), { code: 'TRANSACTION_ACTIVE' });
  assert.equal(store.snapshot().revision, 0);
  store.close();
});
