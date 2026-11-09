import { normalizeWorkspace } from '../windows-paths/index.mjs';

const activeStatuses = new Set(['queued', 'running']);
function promptText(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt must be non-empty text');
}
function bounded(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Operation timed out')), ms); })]).finally(() => clearTimeout(timer));
}

/** Durable local task registry over the public ACP stdio protocol. */
export class DshAcpExecutor {
  constructor({ transport, store, taskTimeoutMs = 300000, cancelTimeoutMs = 5000 }) {
    if (!transport || !store) throw new Error('transport and store are required');
    if (![taskTimeoutMs, cancelTimeoutMs].every(value => Number.isFinite(value) && value > 0)) throw new Error('timeouts must be positive');
    Object.assign(this, { transport, store, taskTimeoutMs, cancelTimeoutMs });
    this.listeners = new Set();
    this.operations = new Map();
    this.owned = new Set();
    this.started = false;
    this.stopping = false;
    this.initialized = false;
  }
  async initialize() {
    if (this.initialized) return;
    if (this.stopping) throw new Error('Executor stopped');
    this.store.open();
    this.initialized = true;
    for (const task of this.store.list()) if (activeStatuses.has(task.status)) this.change(task.taskId, { status: 'interrupted', error: 'Executor restarted before task completion' });
  }
  async start() {
    if (this.stopping) throw new Error('Executor is stopping');
    if (this.started) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.initialize();
      this.initialization = await this.transport.start({
        onUpdate: params => this.onUpdate(params),
        onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        onDisconnect: error => this.disconnected(error),
      });
      if (!this.stopping) this.started = true;
    })();
    try { await this.starting; } finally { this.starting = null; }
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      try { await this.starting; } catch {}
      for (const operation of this.operations.values()) operation.interrupted = true;
      try { await this.transport.stop(); }
      finally {
        this.disconnected(new Error('Executor stopped'));
        await Promise.allSettled([...this.operations.values()].map(operation => operation.done));
        this.started = false;
        this.store.close();
        this.initialized = false;
      }
    })();
    return this.stopPromise;
  }
  async healthCheck() { return this.stopping ? { healthy: false, message: 'Executor stopped' } : this.transport.healthCheck(); }
  requireTask(id) { const task = this.store.get(id); if (!task) throw new Error(`Unknown task: ${id}`); return task; }
  change(id, patch, type = 'task.updated') {
    const task = this.store.update(id, patch, type);
    const events = this.store.events(this.lastSequence ?? 0);
    for (const event of events) this.emit(event);
    return task;
  }
  emit(event) {
    this.lastSequence = Math.max(this.lastSequence ?? 0, event.sequence);
    for (const listener of this.listeners) { try { listener(event); } catch {} }
  }
  subscribeEvents(listener, options = {}) {
    const after = typeof options === 'number' ? options : options.afterSequence;
    if (after !== undefined) for (const event of this.store.events(after)) listener(event);
    this.listeners.add(listener);
    // Existing events are replayed only when explicitly requested.
    this.lastSequence = this.store.events().at(-1)?.sequence ?? 0;
    return () => this.listeners.delete(listener);
  }
  async getTask(id) { await this.initialize(); return this.store.get(id); }
  async listTasks() { await this.initialize(); return this.store.list(); }
  async createTask(input) {
    const cwd = normalizeWorkspace(input.cwd); promptText(input.prompt);
    if (input.sessionId) throw new Error('Use resumeTask for an existing session');
    await this.start();
    if (this.stopping || !this.started) throw new Error('Executor is unavailable');
    const task = this.store.create({ ...(input.taskId === undefined ? {} : { taskId: input.taskId }), cwd, prompt: input.prompt, status: 'queued', result: '', error: null, closed: false });
    for (const event of this.store.events(this.lastSequence ?? 0)) this.emit(event);
    this.launch(task.taskId, false, task.prompt);
    return task;
  }
  capability(name) {
    if (!this.initialization?.agentCapabilities?.sessionCapabilities?.[name]) throw new Error(`ACP server does not support session/${name}`);
  }
  launch(id, resume, prompt) {
    if (this.operations.has(id)) throw new Error('Task already has an active operation');
    const operation = { cancelled: false, interrupted: false };
    operation.abort = new Promise((_, reject) => { operation.reject = reject; });
    operation.abort.catch(() => {});
    operation.request = (method, params, ms) => bounded(Promise.race([this.transport.request(method, params, ms), operation.abort]), ms);
    this.operations.set(id, operation);
    operation.done = Promise.resolve().then(() => this.execute(id, operation, resume, prompt)).finally(() => this.operations.delete(id));
    return operation.done;
  }
  async execute(id, operation, resume, prompt) {
    let timer;
    try {
      let task = this.requireTask(id);
      if (operation.interrupted || this.stopping) throw new Error('Executor stopped');
      if (!this.owned.has(task.sessionId)) {
        if (resume) {
          this.capability('resume');
          await operation.request('session/resume', { sessionId: task.sessionId, cwd: task.cwd, mcpServers: [] }, this.cancelTimeoutMs);
        } else {
          const response = await operation.request('session/new', { cwd: task.cwd, mcpServers: [] }, this.cancelTimeoutMs);
          if (!response || typeof response.sessionId !== 'string') throw new Error('Invalid session/new response');
          task = this.change(id, { sessionId: response.sessionId });
        }
        this.owned.add(task.sessionId);
      }
      if (operation.interrupted || this.stopping) throw new Error('Executor stopped');
      if (operation.cancelled) { this.change(id, { status: 'cancelled' }); return; }
      if (prompt === undefined) { this.change(id, { closed: false, error: null }); return; }
      this.change(id, { status: 'running', result: '', error: null, closed: false });
      timer = setTimeout(() => { operation.timedOut = true; void this.cancelTask(id).catch(() => {}); }, this.taskTimeoutMs);
      const response = await operation.request('session/prompt', { sessionId: task.sessionId, prompt: [{ type: 'text', text: prompt }] }, this.taskTimeoutMs + this.cancelTimeoutMs);
      if (operation.interrupted || this.stopping) throw new Error('ACP transport disconnected');
      const status = operation.timedOut ? 'failed' : operation.cancelled || response.stopReason === 'cancelled' ? 'cancelled' : response.stopReason === 'end_turn' ? 'completed' : 'failed';
      this.change(id, { status, error: operation.timedOut ? 'Task timed out' : status === 'failed' ? `ACP stop reason: ${response.stopReason}` : null });
    } catch (error) {
      if (operation.timedOut && !operation.interrupted && !this.stopping) {
        operation.interrupted = true;
        try { await this.transport.stop(); } finally { this.disconnected(new Error('Task timeout forced transport shutdown')); }
      }
      this.change(id, { status: operation.timedOut ? 'failed' : operation.interrupted || this.stopping ? 'interrupted' : operation.cancelled ? 'cancelled' : 'failed', error: operation.timedOut ? 'Task timed out' : String(error?.message ?? error) });
    } finally { clearTimeout(timer); }
  }
  onUpdate({ sessionId, update }) {
    const task = this.store.list().find(task => task.sessionId === sessionId);
    if (!task || !this.operations.has(task.taskId) || this.stopping) return;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') this.change(task.taskId, { result: String(task.result ?? '') + update.content.text }, 'task.output');
  }
  disconnected(error) {
    this.started = false;
    this.owned.clear();
    for (const [id, operation] of this.operations) {
      operation.interrupted = true;
      operation.reject(new Error('ACP transport disconnected'));
      if (this.initialized) this.change(id, { status: 'interrupted', error: String(error?.message ?? error ?? 'ACP transport disconnected') });
    }
  }
  async resumeTask(id, options = {}) {
    await this.start();
    const task = this.requireTask(id);
    if (!task.sessionId) throw new Error('Task has no persisted ACP session');
    if (this.operations.has(id)) throw new Error('Task already has an active operation');
    this.capability('resume');
    const prompt = typeof options === 'string' ? options : options.prompt;
    if (prompt !== undefined) promptText(prompt);
    if (prompt !== undefined) this.change(id, { status: 'queued', prompt, result: '', error: null });
    const done = this.launch(id, true, prompt);
    if (prompt === undefined) await done;
    return this.requireTask(id);
  }
  async cancelTask(id) {
    this.requireTask(id);
    const operation = this.operations.get(id);
    if (!operation) return this.requireTask(id);
    operation.cancelled = true;
    const task = this.requireTask(id);
    try {
      if (task.sessionId && this.owned.has(task.sessionId)) await bounded(Promise.resolve(this.transport.notify('session/cancel', { sessionId: task.sessionId })), this.cancelTimeoutMs);
      await bounded(operation.done, this.cancelTimeoutMs);
    } catch {
      operation.interrupted = true;
      await this.transport.stop();
      this.disconnected(new Error('Cancellation did not settle; transport stopped'));
    }
    return this.requireTask(id);
  }
  async closeTask(id) {
    await this.start();
    this.capability('close');
    const task = this.requireTask(id);
    if (this.operations.has(id)) await this.cancelTask(id);
    if (task.sessionId && this.owned.has(task.sessionId)) {
      await this.transport.request('session/close', { sessionId: task.sessionId }, this.cancelTimeoutMs);
      this.owned.delete(task.sessionId);
    }
    return this.change(id, { closed: true });
  }
  async waitForTask(id, timeoutMs = this.taskTimeoutMs + this.cancelTimeoutMs * 2) {
    this.requireTask(id);
    const operation = this.operations.get(id);
    if (operation) await bounded(operation.done, timeoutMs);
    return this.requireTask(id);
  }
}
