import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ExecutionStore } from '../packages/task-store-v2/index.mjs';

function fixture(t, limits) {
  const directory = mkdtempSync(join(tmpdir(), 'fish-store-v2-')); const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    assert.equal(resolve(directory), directory); assert.ok(directory.startsWith(join(tmpdir(), 'fish-store-v2-')));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store() { const store = new ExecutionStore(directory, limits); stores.push(store); return store; } };
}
function seed(store, status = 'running') {
  const execution = { executionId: 'e1', taskId: 't1', status, prompt: 'hello', submission: status === 'running' ? 'dispatch_intent' : 'not_started', bindingId: 'b1', result: '', resultIntegrity: 'partial', completionEvidence: null, diagnostics: [] };
  return store.commit(store.snapshot().revision, { admission: true, tasks: [{ taskId: 't1', status, activeExecutionId: 'e1', latestExecutionId: 'e1', unresolvedExecutionIds: [], result: '', sessionId: 's1', duplicateExecutionRisk: false, integrityAlerts: [] }], executions: [execution], bindings: [{ bindingId: 'b1', taskId: 't1', sessionId: 's1', availability: 'active' }], requests: [{ key: 'r1', taskId: 't1', executionId: 'e1', inputHash: 'hash' }], events: [{ type: 'execution.created', taskId: 't1', executionId: 'e1' }] });
}
function finish(state, status = 'completed') {
  return { tasks: [{ ...state.tasks[0], status, activeExecutionId: null, result: 'answer' }], executions: [{ ...state.executions[0], status, submission: 'response_observed', result: 'answer', resultIntegrity: status === 'completed' ? 'observed_complete' : 'partial', completionEvidence: { stopReason: status === 'completed' ? 'end_turn' : 'cancelled' } }], bindings: [{ ...state.bindings[0], availability: 'closed' }], events: [{ type: `execution.${status}`, taskId: 't1', executionId: 'e1', data: { status } }] };
}

test('atomic terminal result/evidence/task/events persist together and snapshots are detached', t => {
  const f = fixture(t); const store = f.store().open(); assert.equal(store.open(), store);
  assert.deepEqual(store.snapshot(), { version: 2, revision: 0, sequence: 0, tasks: [], executions: [], bindings: [], requests: [], events: [] });
  const running = seed(store); const done = store.commit(running.revision, finish(running));
  assert.equal(done.revision, 2); assert.equal(done.sequence, 2); assert.equal(done.events[1].revision, 2); assert.equal(done.events[1].payload, undefined);
  done.executions[0].result = 'tampered'; assert.equal(store.snapshot().executions[0].result, 'answer');
  const durable = store.snapshot(); store.close(); store.open(); assert.deepEqual(store.snapshot(), durable);
  assert.deepEqual(readdirSync(f.directory).sort(), ['state-v2.json', 'store-v2.lock']);
  assert.equal(store.healthCheck().healthy, true);
});

test('invalid terminal receipts, revisions, and references leave disk and memory untouched', t => {
  const f = fixture(t); const store = f.store().open(); const before = seed(store); const file = join(f.directory, 'state-v2.json'); const bytes = readFileSync(file, 'utf8');
  const invalid = [
    { ...finish(before), executions: [{ ...finish(before).executions[0], completionEvidence: null }] },
    { ...finish(before), executions: [{ ...finish(before).executions[0], resultIntegrity: 'uncertain' }] },
    { ...finish(before, 'cancelled'), executions: [{ ...finish(before, 'cancelled').executions[0], completionEvidence: { stopReason: 'end_turn' } }] },
    { executions: [{ ...before.executions[0], completionEvidence: { stopReason: 'end_turn' } }] },
    { requests: [{ key: 'other', taskId: 'absent' }] },
    { events: [{ type: 'bad', taskId: 'absent' }] },
    { bindings: [{ bindingId: 'b2', taskId: 'absent', sessionId: 's1' }] },
    { executions: [{ ...before.executions[0], executionId: 'e2' }] },
    { tasks: [{ ...before.tasks[0], activeExecutionId: null }] },
    { events: [{ type: 'large', taskId: 't1', data: 'x'.repeat(4096) }] },
  ];
  for (const changes of invalid) assert.throws(() => store.commit(before.revision, changes));
  assert.throws(() => store.commit(0, {}), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(store.snapshot(), before); assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('semantic projection rejects inconsistent result, pointer, and enum snapshots', t => {
  const f = fixture(t); const store = f.store().open(); const state = seed(store);
  assert.throws(() => store.commit(state.revision, { tasks: [{ ...state.tasks[0], result: 'tampered' }] }), { code: 'VALIDATION' });
  assert.throws(() => store.commit(state.revision, { tasks: [{ ...state.tasks[0], latestExecutionId: 'absent' }] }), { code: 'VALIDATION' });
  assert.throws(() => store.commit(state.revision, { executions: [{ ...state.executions[0], executionId: 'e2', status: 'failed', submission: 'response_observed', result: 'x' }], tasks: [{ ...state.tasks[0], activeExecutionId: null, latestExecutionId: 'e1' }] }), { code: 'VALIDATION' });
  assert.throws(() => store.commit(state.revision, { bindings: [{ ...state.bindings[0], availability: 'open' }] }), { code: 'VALIDATION' });
  assert.throws(() => store.commit(state.revision, { executions: [{ ...state.executions[0], submission: 'invented' }] }), { code: 'VALIDATION' });
  assert.throws(() => store.commit(state.revision, { tasks: [{ ...state.tasks[0], duplicateExecutionRisk: true, integrityAlerts: [{ code: 'LATE', acknowledgedAt: null }] }] }), { code: 'VALIDATION' });
  assert.equal(store.snapshot().revision, state.revision);
});

test('terminal facts and ownership are immutable while diagnostics and cancellation timestamps may evolve', t => {
  const f = fixture(t); const store = f.store().open(); const running = seed(store); const done = store.commit(running.revision, finish(running));
  for (const patch of [{ status: 'unknown' }, { prompt: 'another' }, { result: 'other' }, { resultIntegrity: 'partial' }, { completionEvidence: { stopReason: 'cancelled' } }]) assert.throws(() => store.commit(done.revision, { executions: [{ ...done.executions[0], ...patch }] }), { code: 'IMMUTABLE_TERMINAL' });
  const updated = store.commit(done.revision, { executions: [{ ...done.executions[0], diagnostics: [{ code: 'LATE_NOTIFICATION' }], cancel: { requestedAt: null, sentAt: 'later', confirmedAt: null } }] });
  assert.equal(updated.executions[0].result, 'answer');
  assert.throws(() => store.commit(updated.revision, { requests: [{ ...updated.requests[0], inputHash: 'changed' }] }), { code: 'VALIDATION' });
  assert.throws(() => store.commit(updated.revision, { tasks: [{ taskId: 't2' }], bindings: [{ ...updated.bindings[0], taskId: 't2' }] }), { code: 'VALIDATION' });
});

test('restart marks possibly submitted executions unknown, preserves queued not_started and terminal receipts', t => {
  const f = fixture(t); const store = f.store().open(); const state = seed(store);
  store.commit(state.revision, {
    tasks: [{ taskId: 'queued', status: 'queued', activeExecutionId: 'eq', latestExecutionId: 'eq', unresolvedExecutionIds: [], result: '', sessionId: null, duplicateExecutionRisk: false, integrityAlerts: [] }, { taskId: 'intent', status: 'queued', activeExecutionId: 'ei', latestExecutionId: 'ei', unresolvedExecutionIds: [], result: '', sessionId: null, duplicateExecutionRisk: false, integrityAlerts: [] }, { taskId: 'done', status: 'cancelled', latestExecutionId: 'ed', activeExecutionId: null, unresolvedExecutionIds: [], result: '', sessionId: null, duplicateExecutionRisk: false, integrityAlerts: [] }],
    executions: [{ executionId: 'eq', taskId: 'queued', status: 'queued', submission: 'not_started', result: '' }, { executionId: 'ei', taskId: 'intent', status: 'queued', submission: 'dispatch_intent', result: '' }, { executionId: 'ed', taskId: 'done', status: 'cancelled', completionEvidence: { stopReason: 'local_not_submitted' }, result: '' }],
  });
  store.close(); store.open(); const recovered = store.snapshot();
  assert.deepEqual(recovered.executions.map(e => e.status), ['unknown', 'queued', 'unknown', 'cancelled']);
  assert.equal(recovered.executions[0].result, ''); assert.equal(recovered.executions[0].diagnostics[0].code, 'RESTART_UNKNOWN');
  assert.equal(recovered.tasks[0].activeExecutionId, null); assert.deepEqual(recovered.tasks[0].unresolvedExecutionIds, ['e1']);
  assert.equal(recovered.bindings[0].availability, 'unknown'); assert.equal(recovered.events.at(-1).type, 'store.recovered');
  store.close(); store.open(); assert.deepEqual(store.snapshot(), recovered);
});

test('session ownership, active execution exclusion, and receipt corruption fail closed', t => {
  const f = fixture(t); const store = f.store().open(); const state = seed(store);
  assert.throws(() => store.commit(state.revision, { tasks: [{ taskId: 't2' }], bindings: [{ bindingId: 'b2', taskId: 't2', sessionId: 's1' }] }), { code: 'VALIDATION' });
  assert.throws(() => store.commit(state.revision, { tasks: [{ taskId: 't2' }], executions: [{ executionId: 'e2', taskId: 't2', status: 'running', bindingId: 'b1' }] }), { code: 'VALIDATION' });
  store.close(); const broken = { ...state, executions: [{ ...state.executions[0], status: 'interrupted', completionEvidence: { stopReason: 'end_turn' } }] };
  writeFileSync(join(f.directory, 'state-v2.json'), JSON.stringify(broken)); assert.throws(() => store.open()); assert.ok(!readdirSync(f.directory).includes('store-v2.lock'));
});

test('single owner, dead PID recovery, unreadable lock preservation, and explicit legacy migration', t => {
  const f = fixture(t); const first = f.store().open(); const second = f.store(); assert.throws(() => second.open(), { code: 'STORE_LOCKED' }); second.close(); assert.equal(first.healthCheck().healthy, true); first.close(); second.open(); second.close();
  const moduleUrl = new URL('../packages/task-store-v2/index.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {ExecutionStore} from ${JSON.stringify(moduleUrl)}; new ExecutionStore(${JSON.stringify(f.directory)}).open(); process.exit(0);`], { stdio: 'inherit' });
  assert.equal(child.error, undefined); assert.equal(child.status, 0); first.open(); first.close();
  writeFileSync(join(f.directory, 'store-v2.lock'), '{partial'); assert.throws(() => first.open(), { code: 'STORE_LOCKED' }); assert.equal(readFileSync(join(f.directory, 'store-v2.lock'), 'utf8'), '{partial');
  const legacy = fixture(t); writeFileSync(join(legacy.directory, 'task-store.json'), JSON.stringify({ version: 1, tasks: [] })); assert.throws(() => legacy.store().open(), { code: 'MIGRATION_REQUIRED' }); assert.deepEqual(readdirSync(legacy.directory), ['task-store.json']);
});

test('admission reserves terminal byte/event capacity and hard caps reject atomically', t => {
  const f = fixture(t, { maxBytes: 8192, reserveBytes: 2048, maxEvents: 3, reserveEvents: 2, maxTasks: 1, maxExecutions: 1 }); const store = f.store().open(); const state = seed(store);
  assert.throws(() => store.commit(state.revision, { admission: true, events: [{ type: 'admit', taskId: 't1' }] }), { code: 'CAPACITY' });
  assert.throws(() => store.commit(state.revision, { tasks: [{ taskId: 'extra' }] }), { code: 'CAPACITY' });
  const large = '中'.repeat(2100);
  assert.throws(() => store.commit(state.revision, { admission: true, tasks: [{ ...state.tasks[0], result: large }], executions: [{ ...state.executions[0], result: large }] }), { code: 'CAPACITY' });
  const done = store.commit(state.revision, finish(state)); assert.equal(done.executions[0].status, 'completed');
  assert.throws(() => store.commit(done.revision, { tasks: [{ ...done.tasks[0], extra: '中'.repeat(3000) }] }), { code: 'CAPACITY' }); assert.equal(store.snapshot().revision, done.revision);
});

test('failed rename preserves published state and cleans temporary files', t => {
  const f = fixture(t); const store = f.store().open(); const state = seed(store); const file = join(f.directory, 'state-v2.json');
  assert.equal(resolve(file), join(f.directory, 'state-v2.json')); rmSync(file); mkdirSync(file);
  assert.throws(() => store.commit(state.revision, finish(state))); assert.deepEqual(store.snapshot(), state); assert.equal(readdirSync(f.directory).filter(name => name.endsWith('.tmp')).length, 0);
});
