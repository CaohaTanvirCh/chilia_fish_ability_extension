import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown', 'interrupted']);
const ACTIVE = new Set(['queued', 'running']);
const SUBMISSIONS = new Set(['not_started', 'dispatch_intent', 'response_observed']);
const LIFECYCLES = new Set(['open', 'closed']);
const AVAILABILITIES = new Set(['closed', 'active', 'unknown']);
const IMMUTABLE = ['taskId', 'bindingId', 'status', 'prompt', 'result', 'completionEvidence', 'resultIntegrity'];
const COLLECTIONS = { tasks: 'taskId', executions: 'executionId', bindings: 'bindingId', requests: 'key' };
const DEFAULTS = { maxBytes: 32 * 1024 * 1024, maxEvents: 20000, maxTasks: 1000, maxExecutions: 5000 };
const clone = value => JSON.parse(JSON.stringify(value));
const fault = (code, message) => Object.assign(new Error(message), { code });
const text = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw fault('VALIDATION', `${name} must be a nonempty string`); };
function json(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object' || ancestors.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw fault('VALIDATION', 'Expected finite acyclic JSON');
  ancestors.add(value);
  for (const item of Object.values(value)) json(item, ancestors);
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw fault('VALIDATION', 'Sparse JSON array');
  ancestors.delete(value);
}
function record(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('VALIDATION', 'Expected a record'); json(value); }
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw fault('STORE_LOCKED', 'Invalid lock owner; refusing recovery');
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function evidence(execution) {
  const receipt = execution.completionEvidence;
  if (execution.status === 'completed' && (receipt?.stopReason !== 'end_turn' || execution.resultIntegrity !== 'observed_complete' || !Object.hasOwn(execution, 'result'))) throw fault('VALIDATION', 'Completed execution requires result and observed_complete end_turn evidence');
  if (execution.status === 'cancelled' && !['cancelled', 'local_not_submitted'].includes(receipt?.stopReason)) throw fault('VALIDATION', 'Cancelled execution requires cancellation evidence');
  if (!['completed', 'cancelled'].includes(execution.status) && receipt != null) throw fault('VALIDATION', 'Nonterminal or uncertain execution cannot have completion evidence');
  if (execution.status !== 'completed' && execution.resultIntegrity === 'observed_complete') throw fault('VALIDATION', 'Only completed results can be observed_complete');
}
function projection(state, task) {
  const attempts = state.executions.filter(item => item.taskId === task.taskId);
  const active = attempts.find(item => ACTIVE.has(item.status));
  const unresolved = attempts.filter(item => ['unknown', 'interrupted'].includes(item.status)).map(item => item.executionId);
  const openAlerts = (task.integrityAlerts ?? []).filter(alert => !alert?.acknowledgedAt);
  const latest = attempts.find(item => item.executionId === task.latestExecutionId) ?? attempts.at(-1);
  return { active, unresolved, openAlerts, latest, status: unresolved.length || openAlerts.length ? 'unknown' : active?.status ?? latest?.status ?? task.status };
}

/** Synchronous single-owner v2 persistence. Upserts replace whole records. No automatic migration or dispatch. */
export class ExecutionStore {
  #directory; #file; #lock; #token = null; #state = null; #limits;
  constructor(directory, limits = {}) {
    text(directory, 'directory'); record(limits);
    this.#directory = resolve(directory); this.#file = join(this.#directory, 'state-v2.json'); this.#lock = join(this.#directory, 'store-v2.lock');
    this.#limits = { ...DEFAULTS, ...limits };
    for (const key of Object.keys(this.#limits)) {
      if (![...Object.keys(DEFAULTS), 'reserveBytes', 'reserveEvents'].includes(key) || !Number.isSafeInteger(this.#limits[key]) || this.#limits[key] < 0 || (key in DEFAULTS && this.#limits[key] === 0)) throw fault('VALIDATION', `Invalid limit ${key}`);
    }
    // Eight admitted executions can each add 1 MiB output plus Task result projections.
    this.#limits.reserveBytes ??= Math.min(18 * 1024 * 1024, Math.floor(this.#limits.maxBytes * 0.6));
    this.#limits.reserveEvents ??= Math.min(1024, Math.floor(this.#limits.maxEvents / 10));
    if (this.#limits.reserveBytes >= this.#limits.maxBytes || this.#limits.reserveEvents >= this.#limits.maxEvents) throw fault('VALIDATION', 'Reserve must be below hard limit');
  }
  #claim() {
    const token = randomUUID();
    const acquire = () => {
      const fd = openSync(this.#lock, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); }
      catch (error) { closeSync(fd); unlinkSync(this.#lock); throw error; }
      closeSync(fd); this.#token = token;
    };
    try { acquire(); return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const guard = `${this.#lock}.recovery`;
    let fd;
    try { fd = openSync(guard, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw fault('STORE_LOCKED', 'Ownership recovery in progress'); throw error; }
    try {
      let owner;
      try { owner = JSON.parse(readFileSync(this.#lock, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw fault('STORE_LOCKED', 'Unreadable lock; refusing removal'); }
      if (owner && alive(owner.pid)) throw fault('STORE_LOCKED', 'Execution store already has a live owner');
      if (owner) unlinkSync(this.#lock);
      try { acquire(); } catch (error) { if (error.code === 'EEXIST') throw fault('STORE_LOCKED', 'Execution store already owned'); throw error; }
    } finally { closeSync(fd); unlinkSync(guard); }
  }
  open() {
    if (this.#state) return this;
    mkdirSync(this.#directory, { recursive: true }); this.#claim();
    try {
      if (existsSync(join(this.#directory, 'MIGRATION_INCOMPLETE')) || existsSync(`${this.#directory}.migration.lock`)) throw fault('MIGRATION_INCOMPLETE', 'Explicit migration has not completed; refusing partial store');
      let state;
      try { state = JSON.parse(readFileSync(this.#file, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (existsSync(join(this.#directory, 'task-store.json'))) throw fault('MIGRATION_REQUIRED', 'Legacy task-store.json requires explicit migration');
        state = { version: 2, revision: 0, sequence: 0, tasks: [], executions: [], bindings: [], requests: [], events: [] };
      }
      this.#validate(state); this.#capacity(state, false);
      const next = clone(state); const changed = [];
      for (const execution of next.executions) {
        if (execution.status !== 'running' && execution.submission !== 'dispatch_intent') continue;
        if (TERMINAL.has(execution.status)) continue;
        execution.status = 'unknown'; execution.resultIntegrity = 'uncertain'; execution.completionEvidence = null;
        execution.updatedAt = new Date().toISOString();
        execution.diagnostics = [...(execution.diagnostics ?? []).slice(-31), { code: 'RESTART_UNKNOWN', message: 'Execution may have been submitted before store restart; no automatic resend.' }];
        const binding = next.bindings.find(item => item.bindingId === execution.bindingId);
        if (binding) binding.availability = 'unknown';
        changed.push(execution);
      }
      // A terminal execution can still have an active binding when the process
      // died between committing the result and confirming session cleanup. Never
      // claim closed; mark it unknown and expose a reconcile requirement.
      for (const execution of next.executions) {
        if (!TERMINAL.has(execution.status) || execution.bindingId == null) continue;
        const binding = next.bindings.find(item => item.bindingId === execution.bindingId);
        if (!binding || binding.availability !== 'active') continue;
        binding.availability = 'unknown'; binding.recoveryRequired = true;
        execution.updatedAt = new Date().toISOString();
        execution.diagnostics = [...(execution.diagnostics ?? []).slice(-31), {
          code: 'TERMINAL_SESSION_UNSETTLED',
          message: 'Execution is terminal but its Session cleanup was not confirmed; use reconcileTask/closeSession before a new execution.',
        }];
        changed.push(execution);
      }
      if (changed.length) {
        next.revision++; this.#safeCounter(next.revision);
        for (const task of next.tasks) {
          const view = projection(next, task);
          task.status = view.status; task.activeExecutionId = view.active?.executionId ?? null;
          task.latestExecutionId = view.latest?.executionId ?? null; task.unresolvedExecutionIds = view.unresolved;
          task.duplicateExecutionRisk = view.unresolved.length > 0 || task.duplicateExecutionRisk === true;
          task.updatedAt = new Date().toISOString();
        }
        // One compact recovery event keeps startup bounded even with many interrupted attempts.
        this.#append(next, { type: 'store.recovered', taskId: changed[0].taskId, data: { count: changed.length, code: 'RESTART_UNKNOWN' } });
      }
      this.#validate(next); this.#capacity(next, false); this.#persist(next); this.#state = next; return this;
    } catch (error) { this.close(); throw error; }
  }
  #safeCounter(value) { if (!Number.isSafeInteger(value) || value < 0) throw fault('SEQUENCE_EXHAUSTED', 'Revision or sequence exhausted'); }
  #validate(state) {
    record(state);
    if (state.version !== 2) throw fault('STORE_CORRUPT', 'Expected v2 state');
    this.#safeCounter(state.revision); this.#safeCounter(state.sequence);
    const maps = {};
    for (const [collection, id] of Object.entries(COLLECTIONS)) {
      if (!Array.isArray(state[collection])) throw fault('STORE_CORRUPT', `Invalid ${collection}`);
      maps[collection] = new Map();
      for (const item of state[collection]) { record(item); text(item[id], id); if (maps[collection].has(item[id])) throw fault('VALIDATION', `Duplicate ${id}`); maps[collection].set(item[id], item); }
    }
    const owner = new Map();
    for (const binding of state.bindings) {
      if (!maps.tasks.has(binding.taskId)) throw fault('VALIDATION', 'Binding references missing task');
      if (binding.availability != null && !AVAILABILITIES.has(binding.availability)) throw fault('VALIDATION', 'Invalid binding availability');
      if (binding.sessionId != null) { text(binding.sessionId, 'sessionId'); if (owner.has(binding.sessionId) && owner.get(binding.sessionId) !== binding.taskId) throw fault('VALIDATION', 'Session belongs to another task'); owner.set(binding.sessionId, binding.taskId); }
    }
    const activeTasks = new Set(); const activeSessions = new Set();
    for (const execution of state.executions) {
      if (!maps.tasks.has(execution.taskId) || !STATUSES.has(execution.status)) throw fault('VALIDATION', 'Invalid execution task/status');
      if (execution.submission != null && !SUBMISSIONS.has(execution.submission)) throw fault('VALIDATION', 'Invalid execution submission');
      const binding = execution.bindingId == null ? null : maps.bindings.get(execution.bindingId);
      if (execution.bindingId != null && (!binding || binding.taskId !== execution.taskId)) throw fault('VALIDATION', 'Execution binding ownership mismatch');
      evidence(execution);
      if (execution.diagnostics != null && (!Array.isArray(execution.diagnostics) || execution.diagnostics.length > 32 || execution.diagnostics.some(item => Buffer.byteLength(JSON.stringify(item)) > 1024))) throw fault('CAPACITY', 'Execution diagnostics exceed bounded quarantine');
      if (ACTIVE.has(execution.status)) {
        if (activeTasks.has(execution.taskId)) throw fault('VALIDATION', 'Multiple active executions for task'); activeTasks.add(execution.taskId);
        const sessionId = binding?.sessionId ?? execution.sessionId;
        if (sessionId) { if (activeSessions.has(sessionId)) throw fault('VALIDATION', 'Multiple active executions for session'); activeSessions.add(sessionId); }
      }
    }
    for (const task of state.tasks) {
      if (task.status != null && !STATUSES.has(task.status)) throw fault('VALIDATION', 'Invalid task status');
      if (task.lifecycle != null && !LIFECYCLES.has(task.lifecycle)) throw fault('VALIDATION', 'Invalid task lifecycle');
      if (task.duplicateExecutionRisk != null && typeof task.duplicateExecutionRisk !== 'boolean') throw fault('VALIDATION', 'Invalid duplicateExecutionRisk');
      if (task.integrityAlerts != null) {
        if (!Array.isArray(task.integrityAlerts)) throw fault('VALIDATION', 'integrityAlerts must be an array');
        for (const alert of task.integrityAlerts) {
          record(alert);
          if (!alert || typeof alert.code !== 'string' || !alert.code) throw fault('VALIDATION', 'Invalid integrity alert');
          if (alert.acknowledgedAt != null && typeof alert.acknowledgedAt !== 'string') throw fault('VALIDATION', 'Invalid integrity acknowledgement');
        }
      }
      for (const key of ['latestExecutionId', 'activeExecutionId']) if (task[key] != null && maps.executions.get(task[key])?.taskId !== task.taskId) throw fault('VALIDATION', `Invalid ${key}`);
      const view = projection(state, task);
      const attempts = state.executions.filter(item => item.taskId === task.taskId);
      if (Object.hasOwn(task, 'activeExecutionId') && task.activeExecutionId !== (view.active?.executionId ?? null)) throw fault('VALIDATION', 'Incorrect active execution projection');
      if (state.executions.some(item => item.taskId === task.taskId) && task.status != null && task.status !== view.status) throw fault('VALIDATION', 'Incorrect task status projection');
      if (task.unresolvedExecutionIds != null && (!Array.isArray(task.unresolvedExecutionIds) || !isDeepStrictEqual([...task.unresolvedExecutionIds].sort(), [...view.unresolved].sort()))) throw fault('VALIDATION', 'Incorrect unresolved execution projection');
      if (attempts.length) {
        const latest = attempts.at(-1);
        if (task.latestExecutionId !== latest.executionId) throw fault('VALIDATION', 'latestExecutionId does not point to the latest execution');
        if (!isDeepStrictEqual(task.result, latest.result)) throw fault('VALIDATION', 'Task result does not match latest execution result');
        const latestBinding = latest.bindingId == null ? null : maps.bindings.get(latest.bindingId);
        const sessionId = latestBinding?.sessionId ?? null;
        if ((task.sessionId ?? null) !== sessionId) throw fault('VALIDATION', 'Task session does not match latest execution binding');
      } else if (task.latestExecutionId != null) throw fault('VALIDATION', 'latestExecutionId references no execution');
      if (view.unresolved.length && task.duplicateExecutionRisk !== true) throw fault('VALIDATION', 'duplicateExecutionRisk must be true for unresolved executions');
      if (task.integrityAlerts?.length && task.duplicateExecutionRisk !== true) throw fault('VALIDATION', 'duplicateExecutionRisk must be true for integrity alerts');
    }
    for (const request of state.requests) {
      if (!maps.tasks.has(request.taskId) || (request.executionId != null && maps.executions.get(request.executionId)?.taskId !== request.taskId)) throw fault('VALIDATION', 'Invalid request ownership');
    }
    if (!Array.isArray(state.events)) throw fault('STORE_CORRUPT', 'Invalid events');
    let previous = 0; const eventIds = new Set();
    for (const event of state.events) {
      text(event.type, 'event type'); text(event.eventId, 'eventId');
      if (!Number.isSafeInteger(event.sequence) || event.sequence !== previous + 1 || eventIds.has(event.eventId) || !Number.isSafeInteger(event.revision) || event.revision > state.revision || event.revision < 1 || !Number.isFinite(Date.parse(event.time)) || !maps.tasks.has(event.taskId) || (event.executionId != null && maps.executions.get(event.executionId)?.taskId !== event.taskId)) throw fault('VALIDATION', 'Invalid event identity/sequence/reference');
      if (Buffer.byteLength(JSON.stringify(event)) > 4096 || Object.hasOwn(event, 'payload')) throw fault('CAPACITY', 'Events must be compact domain metadata');
      previous = event.sequence; eventIds.add(event.eventId);
    }
    if (state.sequence !== previous) throw fault('STORE_CORRUPT', 'Invalid final event sequence');
  }
  #capacity(state, admission) {
    const limits = this.#limits;
    if (state.tasks.length > limits.maxTasks || state.executions.length > limits.maxExecutions || state.events.length > limits.maxEvents - (admission ? limits.reserveEvents : 0) || Buffer.byteLength(JSON.stringify(state) + '\n') > limits.maxBytes - (admission ? limits.reserveBytes : 0)) throw fault('CAPACITY', admission ? 'Admission high water mark reached; terminal reserve retained' : 'Store hard capacity reached');
  }
  #persist(state) {
    const temporary = `${this.#file}.${this.#token}.${randomUUID()}.tmp`; let fd;
    try {
      fd = openSync(temporary, 'wx'); writeFileSync(fd, JSON.stringify(state) + '\n', 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.#file);
      // Windows does not expose a portable directory fsync. On platforms supporting it,
      // flush rename metadata; unsupported directory handles are explicitly tolerated.
      let directoryFd;
      try { directoryFd = openSync(this.#directory, 'r'); fsyncSync(directoryFd); }
      catch (error) { if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error; }
      finally { if (directoryFd !== undefined) closeSync(directoryFd); }
    } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); }
  }
  #assertOpen() { if (!this.#state) throw fault('STORE_CLOSED', 'Open execution store first'); }
  #append(state, event) {
    record(event);
    for (const key of Object.keys(event)) if (!['type', 'taskId', 'executionId', 'data'].includes(key)) throw fault('VALIDATION', `Unknown event input field ${key}`);
    this.#safeCounter(state.sequence + 1);
    state.events.push({ ...clone(event), sequence: ++state.sequence, eventId: randomUUID(), time: new Date().toISOString(), revision: state.revision });
  }
  snapshot() { this.#assertOpen(); return clone(this.#state); }
  /** admission:true is mandatory for new work: it preserves byte/event headroom for terminal/fault commits. */
  commit(expectedRevision, changes) {
    this.#assertOpen();
    if (expectedRevision !== this.#state.revision) throw fault('REVISION_CONFLICT', 'Store revision changed');
    record(changes);
    for (const key of Object.keys(changes)) if (![...Object.keys(COLLECTIONS), 'events', 'admission'].includes(key)) throw fault('VALIDATION', `Unknown changes field ${key}`);
    if (changes.admission != null && typeof changes.admission !== 'boolean') throw fault('VALIDATION', 'admission must be boolean');
    const next = clone(this.#state); next.revision++; this.#safeCounter(next.revision);
    for (const [collection, id] of Object.entries(COLLECTIONS)) {
      if (changes[collection] === undefined) continue;
      if (!Array.isArray(changes[collection])) throw fault('VALIDATION', `${collection} must be an array`);
      const seen = new Set();
      for (const item of changes[collection]) {
        record(item); text(item[id], id); if (seen.has(item[id])) throw fault('VALIDATION', `Duplicate upsert ${id}`); seen.add(item[id]);
        const index = next[collection].findIndex(old => old[id] === item[id]);
        const old = next[collection][index];
        if (old && ['executions', 'bindings', 'requests'].includes(collection) && old.taskId !== item.taskId) throw fault('VALIDATION', 'Record ownership is immutable');
        if (collection === 'bindings' && old && (old.sessionId !== item.sessionId || old.cwd !== item.cwd)) throw fault('VALIDATION', 'Binding session identity is immutable');
        if (collection === 'requests' && old && !isDeepStrictEqual(old, item)) throw fault('VALIDATION', 'Idempotency request is immutable');
        if (collection === 'executions' && old && TERMINAL.has(old.status)) for (const field of IMMUTABLE) if (!isDeepStrictEqual(old[field], item[field])) throw fault('IMMUTABLE_TERMINAL', `Terminal execution ${field} is immutable`);
        if (index < 0) next[collection].push(clone(item)); else next[collection][index] = clone(item);
      }
    }
    if (changes.events !== undefined && !Array.isArray(changes.events)) throw fault('VALIDATION', 'events must be an array');
    for (const event of changes.events ?? []) this.#append(next, event);
    this.#validate(next); this.#capacity(next, changes.admission === true); this.#persist(next); this.#state = next;
    return this.snapshot();
  }
  healthCheck() {
    if (!this.#state) return { healthy: false, message: 'Execution store closed', code: 'STORE_CLOSED' };
    try { const owner = JSON.parse(readFileSync(this.#lock, 'utf8')); if (owner.token !== this.#token) throw fault('STORE_LOCKED', 'Store lock ownership changed'); return { healthy: true, revision: this.#state.revision }; }
    catch (error) { return { healthy: false, code: error.code ?? 'STORAGE_FAULT', message: error.message }; }
  }
  close() {
    if (this.#token) {
      const owner = JSON.parse(readFileSync(this.#lock, 'utf8'));
      if (owner.token !== this.#token) throw fault('STORE_LOCKED', 'Store lock ownership changed');
      unlinkSync(this.#lock); this.#token = null;
    }
    this.#state = null;
  }
}
export function createExecutionStore(directory, limits) { return new ExecutionStore(directory, limits); }
export default ExecutionStore;
