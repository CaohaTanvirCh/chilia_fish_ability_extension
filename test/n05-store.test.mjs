import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ExecutionStore} from '../packages/task-store-v2/index.mjs';
import {TaskStore} from '../packages/task-store/index.mjs';
import {migrateV1} from '../scripts/migrate-v1.mjs';
import {DshAcpExecutor} from '../packages/dsh-acp-v2/index.mjs';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fish-n05-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function stateFile(dir) { return path.join(dir, 'state-v2.json'); }
function seed(dir) {
  const time = '2026-11-10T00:00:00.000Z';
  const store = new ExecutionStore(dir).open();
  store.commit(0, {
    admission: true,
    tasks: [{taskId: 't1', cwd: 'C:\\work', objective: 'p', lifecycle: 'open', status: 'unknown', latestExecutionId: 'e1', activeExecutionId: null, unresolvedExecutionIds: ['e1'], result: 'partial', sessionId: 's1', duplicateExecutionRisk: true, integrityAlerts: [], createdAt: time, updatedAt: time, revision: 1}],
    executions: [{executionId: 'e1', taskId: 't1', prompt: 'p', requestKey: 'r', status: 'unknown', submission: 'dispatch_intent', bindingId: 'b1', result: 'partial', resultIntegrity: 'uncertain', completionEvidence: null, cancel: {requestedAt: null, sentAt: null, confirmedAt: null}, diagnostics: [], createdAt: time, updatedAt: time}],
    bindings: [{bindingId: 'b1', taskId: 't1', sessionId: 's1', cwd: 'C:\\work', runtimeId: 'windows-acp', availability: 'unknown', recoveryRequired: true}],
    requests: [{key: 'r', taskId: 't1', executionId: 'e1', inputHash: 'h'}],
    events: [{type: 'seed', taskId: 't1', executionId: 'e1'}],
  });
  store.close();
}
function loadMutated(dir, mutate) {
  const state = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  mutate(state);
  writeFileSync(stateFile(dir), JSON.stringify(state));
  const store = new ExecutionStore(dir).open();
  return store;
}
function rejectsLoad(dir, mutate) {
  const state = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  mutate(state);
  writeFileSync(stateFile(dir), JSON.stringify(state));
  assert.throws(() => new ExecutionStore(dir).open(), {code: 'VALIDATION'});
}
function changeTask(state, patch) { state.tasks[0] = {...state.tasks[0], ...patch}; }
function changeExecution(state, patch) { state.executions[0] = {...state.executions[0], ...patch}; }
function addSecondTask(state) {
  state.tasks.push({taskId: 't2', cwd: 'C:\\work', lifecycle: 'open', status: 'unknown', latestExecutionId: 'e2', activeExecutionId: null, unresolvedExecutionIds: ['e2'], result: 'other', sessionId: null, duplicateExecutionRisk: true, integrityAlerts: [], createdAt: state.tasks[0].createdAt, updatedAt: state.tasks[0].updatedAt, revision: 1});
  state.executions.push({executionId: 'e2', taskId: 't2', prompt: 'x', requestKey: 'r2', status: 'unknown', submission: 'dispatch_intent', bindingId: null, result: 'other', resultIntegrity: 'uncertain', completionEvidence: null, cancel: {requestedAt: null, sentAt: null, confirmedAt: null}, diagnostics: [], createdAt: state.tasks[0].createdAt, updatedAt: state.tasks[0].updatedAt});
}

test('unknown execution requires unresolvedExecutionIds to be present and exact', t => {
  const a = fixture(t); seed(a); rejectsLoad(a, state => { delete state.tasks[0].unresolvedExecutionIds; });
  const b = fixture(t); seed(b); rejectsLoad(b, state => changeTask(state, {unresolvedExecutionIds: []}));
  const c = fixture(t); seed(c); const store = loadMutated(c, state => changeTask(state, {unresolvedExecutionIds: ['e1']})); assert.equal(store.snapshot().tasks[0].unresolvedExecutionIds[0], 'e1'); store.close();
});

test('Store commit also rejects a Task projection that omits unresolvedExecutionIds', t => {
  const dir = fixture(t); seed(dir); const store = new ExecutionStore(dir).open();
  try {
    const state = store.snapshot(); const task = {...state.tasks[0]}; delete task.unresolvedExecutionIds;
    assert.throws(() => store.commit(state.revision, {tasks: [task]}), {code: 'VALIDATION'});
    assert.deepEqual(store.snapshot(), state);
  } finally { store.close(); }
});

test('all required Task projection fields cannot be omitted when executions exist', t => {
  for (const key of ['status', 'latestExecutionId', 'activeExecutionId', 'unresolvedExecutionIds', 'sessionId', 'result', 'duplicateExecutionRisk', 'integrityAlerts']) {
    const dir = fixture(t); seed(dir); rejectsLoad(dir, state => { delete state.tasks[0][key]; });
  }
});

test('Executor refuses a task projection missing unresolvedExecutionIds instead of treating it as empty', async t => {
  const dir = fixture(t); seed(dir); const store = new ExecutionStore(dir).open(); const snapshot = store.snapshot(); store.close();
  delete snapshot.tasks[0].unresolvedExecutionIds;
  let commits = 0, transports = 0;
  const fake = {open() { return this; }, close() {}, snapshot() { return structuredClone(snapshot); }, healthCheck() { return {healthy: true}; }, commit() { commits++; throw new Error('must not commit'); }};
  const x = new DshAcpExecutor({store: fake, transportFactory: () => { transports++; throw new Error('must not launch'); }});
  await x.start();
  try { await assert.rejects(x.startExecution('t1', {requestKey: 'new', prompt: 'next'}), {code: 'INVALID_TASK_PROJECTION'}); assert.equal(commits, 0); assert.equal(transports, 0); }
  finally { await x.stop(); }
});

test('correct unresolved history is loadable but startExecution still requires explicit acknowledgement', async t => {
  const dir = fixture(t); seed(dir);
  const x = new DshAcpExecutor({store: new ExecutionStore(dir), transportFactory: () => { throw new Error('must not launch'); }});
  await x.start();
  try { await assert.rejects(x.startExecution('t1', {requestKey: 'new', prompt: 'next'}), {code: 'UNKNOWN_EXECUTION'}); }
  finally { await x.stop(); }
});

test('explicit acknowledgement retains the original unknown execution and duplicate risk', async t => {
  const dir = fixture(t); seed(dir);
  class FakeTransport {
    async start() { return {agentCapabilities: {sessionCapabilities: {resume: {}, close: {}}}}; }
    async request(method) { if (method === 'session/new') return {sessionId: 'new-session'}; if (method === 'session/prompt') return {stopReason: 'end_turn'}; return {}; }
    async notify() {}
    async stop() {}
  }
  const x = new DshAcpExecutor({store: new ExecutionStore(dir), transportFactory: () => new FakeTransport(), sessionOperationTimeoutMs: 1000, cancelTimeoutMs: 100});
  await x.start();
  try {
    const next = await x.startExecution('t1', {requestKey: 'ack-unknown', prompt: 'next', acknowledgeUnknownExecutionIds: ['e1']});
    await x.waitForTask('t1');
    assert.equal((await x.getExecution('e1')).status, 'unknown');
    assert.ok(await x.getExecution(next.executionId));
    const task = await x.getTask('t1');
    assert.deepEqual(task.unresolvedExecutionIds, ['e1']);
    assert.equal(task.duplicateExecutionRisk, true);
  } finally { await x.stop(); }
});

test('a closed binding cannot hide an unresolved unknown execution from context restore', async t => {
  const dir = fixture(t); seed(dir);
  const store = new ExecutionStore(dir).open(); const state = store.snapshot(); const binding = state.bindings[0];
  store.commit(state.revision, {bindings: [{...binding, availability: 'closed', recoveryRequired: false}]}); store.close();
  const x = new DshAcpExecutor({store: new ExecutionStore(dir), transportFactory: () => { throw new Error('must not launch'); }});
  await x.start();
  try { await assert.rejects(x.resumeTask('t1'), {code: 'UNKNOWN_EXECUTION'}); }
  finally { await x.stop(); }
});

test('invalid resultIntegrity and integrity alert references fail closed', t => {
  const a = fixture(t); seed(a); rejectsLoad(a, state => changeExecution(state, {resultIntegrity: 'invented'}));
  const b = fixture(t); seed(b); rejectsLoad(b, state => changeTask(state, {integrityAlerts: [{executionId: 'missing', code: 'LATE'}]}));
  const c = fixture(t); seed(c); rejectsLoad(c, state => { addSecondTask(state); changeTask(state, {integrityAlerts: [{executionId: 'e2', code: 'LATE'}]}); });
  const d = fixture(t); seed(d); rejectsLoad(d, state => changeTask(state, {integrityAlerts: [{executionId: 'e1', code: 'LATE', acknowledgedAt: 'not-a-time', acknowledgedBy: 'x'}]}));
});

test('active and latest pointers cannot be missing, cross-task, or point at the wrong execution', t => {
  const a = fixture(t); seed(a); rejectsLoad(a, state => { delete state.tasks[0].activeExecutionId; });
  const b = fixture(t); seed(b); rejectsLoad(b, state => { delete state.tasks[0].latestExecutionId; });
  const c = fixture(t); seed(c); rejectsLoad(c, state => changeTask(state, {latestExecutionId: 'absent'}));
  const d = fixture(t); seed(d); rejectsLoad(d, state => changeTask(state, {activeExecutionId: 'absent'}));
  const e = fixture(t); seed(e); rejectsLoad(e, state => { addSecondTask(state); changeTask(state, {activeExecutionId: 'e2'}); });
  const f = fixture(t); seed(f); rejectsLoad(f, state => { addSecondTask(state); changeTask(state, {latestExecutionId: 'e2'}); });
  const g = fixture(t); seed(g); rejectsLoad(g, state => changeTask(state, {unresolvedExecutionIds: ['ghost']}));
  const h = fixture(t); seed(h); rejectsLoad(h, state => { addSecondTask(state); changeTask(state, {unresolvedExecutionIds: ['e1', 'e2']}); });
  const i = fixture(t); seed(i); rejectsLoad(i, state => changeTask(state, {unresolvedExecutionIds: ['e1', 'e1']}));
});

test('normal completed, failed, and cancelled snapshots remain loadable', t => {
  for (const variant of ['completed', 'failed', 'cancelled']) {
    const dir = fixture(t); seed(dir);
    const store = loadMutated(dir, state => {
      const result = variant === 'completed' ? 'done' : variant === 'failed' ? 'partial' : '';
      const evidence = variant === 'completed' ? {stopReason: 'end_turn'} : variant === 'cancelled' ? {stopReason: 'cancelled'} : null;
      changeTask(state, {status: variant, activeExecutionId: null, unresolvedExecutionIds: [], result, duplicateExecutionRisk: false});
      changeExecution(state, {status: variant, result, resultIntegrity: variant === 'completed' ? 'observed_complete' : 'partial', completionEvidence: evidence});
      state.bindings[0].availability = 'closed'; state.bindings[0].recoveryRequired = false;
    });
    assert.equal(store.snapshot().tasks[0].status, variant); store.close();
  }
});

test('v1 to v2 migration remains loadable under strict projection rules', t => {
  const parent = fixture(t); const source = path.join(parent, 'v1'); const target = path.join(parent, 'v2');
  const old = new TaskStore(source).open(); old.create({taskId: 'legacy', cwd: 'C:\\work', prompt: 'legacy', status: 'completed', result: 'ok'}); old.close();
  migrateV1(source, target);
  const store = new ExecutionStore(target).open();
  try { assert.equal(store.snapshot().tasks[0].taskId, 'legacy'); assert.equal(store.snapshot().tasks[0].status, 'unknown'); } finally { store.close(); }
});
