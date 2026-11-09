import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { ExecutionStore } from '../packages/task-store-v2/index.mjs';

const fixtureScript = fileURLToPath(new URL('./fixtures/crash-v2.mjs', import.meta.url));
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-v2-crash-'));
  t.after(() => { assert.equal(resolve(dir), dir); assert.ok(dir.startsWith(join(tmpdir(), 'fish-v2-crash-'))); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function child(dir, mode) {
  const result = spawnSync(process.execPath, [fixtureScript, dir, mode], { stdio: 'inherit', timeout: 15000 });
  assert.equal(result.error, undefined); return result.status;
}
function reopen(dir) { const store = new ExecutionStore(dir).open(); try { return store.snapshot(); } finally { store.close(); } }
function prompts(dir) {
  try { return readFileSync(join(dir, 'transport.log'), 'utf8').split('\n').filter(line => line === 'prompt').length; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

for (const hook of ['afterCreate', 'beforePrompt', 'beforeTerminalCommit', 'afterTerminalCommit']) {
  test(`real Node exit at ${hook}: durable state and key replay, simulated ACP`, t => {
    const dir = directory(t); assert.equal(child(dir, hook), 73);
    const before = reopen(dir); const e = before.executions[0];
    assert.equal(before.tasks.length, 1); assert.equal(before.requests.length, 1);
    if (hook === 'afterCreate') { assert.equal(e.status, 'queued'); assert.equal(e.submission, 'not_started'); assert.equal(prompts(dir), 0); }
    else if (hook === 'afterTerminalCommit') { assert.equal(e.status, 'completed'); assert.equal(e.result, 'observed answer'); assert.equal(e.completionEvidence.stopReason, 'end_turn'); assert.equal(e.resultIntegrity, 'observed_complete'); }
    else { assert.equal(e.status, 'unknown'); assert.equal(e.completionEvidence, null); assert.equal(e.resultIntegrity, 'uncertain'); assert.equal(before.tasks[0].activeExecutionId, null); assert.deepEqual(before.tasks[0].unresolvedExecutionIds, [e.executionId]); }
    if (hook === 'beforePrompt') assert.equal(prompts(dir), 0);
    if (hook === 'beforeTerminalCommit') { assert.equal(prompts(dir), 1); assert.equal(e.result, 'observed answer'); }
    const promptCount = prompts(dir); assert.equal(child(dir, 'replay'), 0);
    const after = reopen(dir); assert.equal(prompts(dir), promptCount); assert.deepEqual(after.executions, before.executions); assert.deepEqual(after.requests, before.requests);
  });
}

test('kill executor child during cancellation leaves unknown without fabricated cancellation receipt (simulated ACP)', { timeout: 15000 }, async t => {
  const dir = directory(t); const proc = spawn(process.execPath, [fixtureScript, dir, 'cancel-kill'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill(); });
  const exited = once(proc, 'exit');
  const [prompt] = await once(proc, 'message'); assert.equal(prompt.ready, 'prompt');
  const cancelMessage = once(proc, 'message'); proc.send('cancel'); const [cancel] = await cancelMessage; assert.equal(cancel.ready, 'cancel');
  proc.kill(); await exited;
  const state = reopen(dir); const e = state.executions[0];
  assert.equal(e.status, 'unknown'); assert.equal(e.completionEvidence, null); assert.ok(e.cancel.requestedAt); assert.equal(e.cancel.confirmedAt, null); assert.equal(prompts(dir), 1);
});

test('runtime disconnect in real executor child persists unknown and partial output (simulated ACP)', { timeout: 15000 }, async t => {
  const dir = directory(t); const proc = spawn(process.execPath, [fixtureScript, dir, 'runtime-death'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill(); });
  const exited = once(proc, 'exit'); const [ready] = await once(proc, 'message'); assert.equal(ready.ready, 'prompt'); proc.send('disconnect');
  const [code] = await exited; assert.equal(code, 0); const e = reopen(dir).executions[0];
  assert.equal(e.status, 'unknown'); assert.equal(e.result, 'observed answer'); assert.equal(e.completionEvidence, null); assert.equal(prompts(dir), 1);
});
