import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../packages/task-store/index.mjs';
import { DshAcpExecutor } from '../packages/dsh-acp/index.mjs';

class FakeTransport {
  calls = []; count = 0; pending = new Map();
  async start(handlers) { this.handlers = handlers; return { agentCapabilities: { sessionCapabilities: this.caps ?? { resume: {}, close: {}, list: {} } } }; }
  async request(method, params) {
    this.calls.push([method, params]);
    if (method === 'session/new') return { sessionId: `s${++this.count}` };
    if (method === 'session/prompt') {
      if (this.fail) throw new Error('provider failed');
      if (this.hold) return new Promise(resolve => this.pending.set(params.sessionId, resolve));
      await this.handlers.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } });
      return { stopReason: 'end_turn' };
    }
    return {};
  }
  async notify(method, params) { this.calls.push([method, params]); if (!this.ignoreCancel) this.pending.get(params.sessionId)?.({ stopReason: 'cancelled' }); }
  async stop() { this.stopped = true; this.handlers?.onDisconnect(new Error('closed')); }
  healthCheck() { return { healthy: !this.stopped }; }
}
async function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-executor-test-'));
  const transport = new FakeTransport();
  const executor = new DshAcpExecutor({ transport, store: new TaskStore(dir), cancelTimeoutMs: 30, ...options });
  await executor.initialize();
  t.after(async () => { await executor.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { executor, transport };
}
const input = { cwd: 'C:\\work', prompt: 'hello' };
async function running(executor, taskId) { for (let i = 0; i < 50; i++) { if ((await executor.getTask(taskId)).status === 'running') return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('not running'); }

test('queues, persists output/events, closes and resumes without replay', async t => {
  const { executor, transport } = await setup(t);
  const seen = []; executor.subscribeEvents(event => seen.push(event));
  const task = await executor.createTask(input);
  assert.equal(task.status, 'queued');
  const result = await executor.waitForTask(task.taskId);
  assert.equal(result.status, 'completed'); assert.equal(result.result, 'answer');
  assert.ok(seen.some(event => event.type === 'task.output'));
  await executor.closeTask(task.taskId);
  assert.equal((await executor.getTask(task.taskId)).closed, true);
  await executor.resumeTask(task.taskId);
  assert.equal(transport.calls.filter(([method]) => method === 'session/prompt').length, 1);
  assert.equal((await executor.getTask(task.taskId)).closed, false);
  const replay = []; executor.subscribeEvents(event => replay.push(event), { afterSequence: 0 })();
  assert.deepEqual(replay.map(event => event.sequence), seen.map(event => event.sequence));
  assert.equal(transport.calls.some(([method]) => method === 'session/list'), false);
});
test('explicit continuation uses same session and denies permissions', async t => {
  const { executor, transport } = await setup(t);
  const task = await executor.createTask(input); await executor.waitForTask(task.taskId);
  await executor.resumeTask(task.taskId, { prompt: 'next' }); await executor.waitForTask(task.taskId);
  assert.equal(transport.calls.filter(([method]) => method === 'session/new').length, 1);
  assert.deepEqual(await transport.handlers.onPermission({}), { outcome: { outcome: 'cancelled' } });
});
test('cancel waits for prompt settlement and rejects overlapping resume', async t => {
  const { executor, transport } = await setup(t); transport.hold = true;
  const task = await executor.createTask(input); await running(executor, task.taskId);
  await assert.rejects(executor.resumeTask(task.taskId), /active operation/);
  assert.equal((await executor.cancelTask(task.taskId)).status, 'cancelled');
});
test('disconnect interrupts tasks even if transport promise never settles', async t => {
  const { executor, transport } = await setup(t); transport.hold = true;
  const task = await executor.createTask(input); await running(executor, task.taskId);
  transport.handlers.onDisconnect(new Error('lost'));
  assert.equal((await executor.waitForTask(task.taskId)).status, 'interrupted');
});
test('timeout cancels, and unresponsive cancellation stops transport', async t => {
  const { executor, transport } = await setup(t, { taskTimeoutMs: 10 }); transport.hold = true; transport.ignoreCancel = true;
  const task = await executor.createTask(input);
  const result = await executor.waitForTask(task.taskId, 1000);
  assert.ok(['failed', 'interrupted'].includes(result.status));
  // Prompt and cancellation timers may settle in either order, but stop must follow.
  await executor.cancelTask(task.taskId);
  assert.equal(transport.calls.some(([method]) => method === 'session/cancel'), true);
  assert.equal(transport.stopped, true);
});
test('provider errors fail task; unsupported restore rejects', async t => {
  const { executor, transport } = await setup(t); transport.fail = true; transport.caps = {};
  const task = await executor.createTask(input);
  assert.equal((await executor.waitForTask(task.taskId)).status, 'failed');
  await assert.rejects(executor.resumeTask(task.taskId), /does not support/);
  await assert.rejects(executor.createTask({ ...input, cwd: '/tmp' }), /Windows/);
});
test('stop races session admission without leaving running task', async t => {
  const { executor } = await setup(t);
  const task = await executor.createTask(input);
  await executor.stop();
  // A stopped executor cannot own live work.
  assert.equal(executor.operations.size, 0);
  assert.equal(executor.started, false);
});
