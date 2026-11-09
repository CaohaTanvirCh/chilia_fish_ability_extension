// Fault injection uses a real Node child process and simulated ACP, never real DSH.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExecutionStore } from '../../packages/task-store-v2/index.mjs';
import { DshAcpExecutor } from '../../packages/dsh-acp-v2/index.mjs';

const [directory, mode] = process.argv.slice(2);
const log = value => appendFileSync(join(directory, 'transport.log'), `${value}\n`);
const input = { cwd: 'C:\\work', prompt: 'crash fixture', requestKey: 'original-request' };
class SimulatedAcp {
  async start(handlers = {}) { this.handlers = handlers; return { agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } }; }
  async request(method, params) {
    if (method === 'session/new') return { sessionId: 'simulated-session' };
    if (method === 'session/prompt') {
      log('prompt'); this.sessionId = params.sessionId;
      this.handlers.onUpdate?.({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'observed answer' } } });
      if (['cancel-kill', 'runtime-death'].includes(mode)) {
        process.send?.({ ready: 'prompt' });
        return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
      }
      return { stopReason: 'end_turn' };
    }
    return {};
  }
  async notify(method) {
    if (method === 'session/cancel') { log('cancel'); process.send?.({ ready: 'cancel' }); return new Promise(() => {}); }
  }
  async stop() { this.reject?.(new Error('simulated process stopped')); }
  healthCheck() { return { healthy: true }; }
}
const hooks = {};
for (const hook of ['afterCreate', 'beforePrompt', 'beforeTerminalCommit', 'afterTerminalCommit']) hooks[hook] = () => { if (mode === hook) process.exit(73); };
const executor = new DshAcpExecutor({ store: new ExecutionStore(directory), transportFactory: () => new SimulatedAcp(), hooks, taskTimeoutMs: 30000, cancelTimeoutMs: 30000 });
await executor.start();
if (mode === 'replay') {
  const before = executor.state(); const task = await executor.createTask(input);
  log(`replay:${task.taskId}`);
  if (before.executions.length !== executor.state().executions.length) throw new Error('Replay created another execution');
  await executor.stop();
} else {
  process.on('message', message => {
    if (message === 'cancel') { const task = executor.state().tasks[0]; void executor.cancelExecution(task.latestExecutionId); }
    if (message === 'disconnect') { for (const op of executor.operations.values()) op.transport.handlers.onDisconnect(new Error('simulated runtime death')); }
  });
  const task = await executor.createTask(input);
  await executor.waitForTask(task.taskId);
  if (mode === 'runtime-death') { await executor.stop(); process.exit(0); }
  await executor.stop();
}
