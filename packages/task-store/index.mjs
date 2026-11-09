import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown']);
const MUTABLE = new Set(['sessionId', 'cwd', 'prompt', 'status', 'result', 'closed', 'error']);
const INPUT = new Set(['taskId', ...MUTABLE]);
const clone = value => JSON.parse(JSON.stringify(value));
function fault(code, message) { return Object.assign(new Error(message), { code }); }
function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
}
function json(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError('Expected a finite, acyclic JSON value');
  ancestors.add(value);
  for (const item of Object.values(value)) json(item, ancestors);
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new TypeError('Sparse arrays are not JSON values');
  ancestors.delete(value);
}
function validate(task) {
  text(task.taskId, 'taskId'); text(task.cwd, 'cwd'); text(task.prompt, 'prompt');
  if (task.sessionId !== null) text(task.sessionId, 'sessionId');
  if (!STATUSES.has(task.status)) throw new TypeError('Invalid task status');
  if (typeof task.closed !== 'boolean') throw new TypeError('closed must be boolean');
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof task[field] !== 'string' || !Number.isFinite(Date.parse(task[field]))) throw new TypeError(`Invalid ${field}`);
  }
  json(task.result); json(task.error);
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw fault('STORE_LOCKED', 'Invalid lock owner; refusing to remove lock');
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

/** Synchronous, single-owner store. Only task-store.* files in directory are owned. */
export class TaskStore {
  #directory; #file; #lock; #token = null; #state = null;
  constructor(directory) {
    text(directory, 'directory');
    this.#directory = resolve(directory);
    this.#file = join(this.#directory, 'task-store.json');
    this.#lock = join(this.#directory, 'task-store.lock');
  }
  #claim() {
    const token = randomUUID();
    const acquire = () => {
      const fd = openSync(this.#lock, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); }
      catch (error) { closeSync(fd); unlinkSync(this.#lock); throw error; }
      closeSync(fd);
      this.#token = token;
    };
    try { acquire(); return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Serialize stale-lock reclamation and recheck the current owner inside the guard.
    const guard = `${this.#lock}.recovery`;
    let fd;
    try { fd = openSync(guard, 'wx'); } catch (error) {
      if (error.code === 'EEXIST') throw fault('STORE_LOCKED', 'Store ownership recovery already in progress');
      throw error;
    }
    try {
      let owner;
      try { owner = JSON.parse(readFileSync(this.#lock, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw fault('STORE_LOCKED', 'Unreadable lock; refusing to remove it'); }
      if (owner && alive(owner.pid)) throw fault('STORE_LOCKED', 'Task store already has a live owner');
      if (owner) unlinkSync(this.#lock);
      try { acquire(); } catch (error) {
        if (error.code === 'EEXIST') throw fault('STORE_LOCKED', 'Task store already has an owner');
        throw error;
      }
    } finally { closeSync(fd); unlinkSync(guard); }
  }
  open() {
    if (this.#state) return this;
    mkdirSync(this.#directory, { recursive: true });
    this.#claim();
    try {
      let state;
      try { state = JSON.parse(readFileSync(this.#file, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = { version: 1, sequence: 0, tasks: [], events: [] };
      }
      this.#validateState(state);
      const next = clone(state);
      for (const task of next.tasks) {
        if (task.status === 'queued' || task.status === 'running') {
          task.status = 'interrupted';
          task.updatedAt = new Date().toISOString();
          this.#event(next, task, 'task.interrupted');
        }
      }
      // Task transitions and their events commit together in one atomic replacement.
      this.#persist(next);
      this.#state = next;
      return this;
    } catch (error) { this.close(); throw error; }
  }
  #validateState(state) {
    if (state?.version !== 1 || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Array.isArray(state.tasks) || !Array.isArray(state.events)) throw fault('STORE_CORRUPT', 'Invalid task store envelope');
    const ids = new Set();
    for (const task of state.tasks) { validate(task); if (ids.has(task.taskId)) throw fault('STORE_CORRUPT', 'Duplicate task ID'); ids.add(task.taskId); }
    const eventIds = new Set();
    for (const [index, event] of state.events.entries()) {
      if (event.sequence !== index + 1 || !ids.has(event.taskId) || event.payload?.taskId !== event.taskId || eventIds.has(event.eventId)) throw fault('STORE_CORRUPT', 'Invalid task event sequence or identity');
      text(event.eventId, 'eventId'); text(event.type, 'event type');
      if (typeof event.time !== 'string' || !Number.isFinite(Date.parse(event.time))) throw fault('STORE_CORRUPT', 'Invalid event time');
      validate(event.payload); eventIds.add(event.eventId);
    }
    if (state.sequence !== state.events.length) throw fault('STORE_CORRUPT', 'Invalid final sequence');
  }
  #assertOpen() {
    if (!this.#state) throw fault('STORE_CLOSED', 'Open the task store before using it');
  }
  #persist(state) {
    const temporary = `${this.#file}.${this.#token}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, 'wx');
      writeFileSync(fd, JSON.stringify(state, null, 2) + '\n', 'utf8');
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.#file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  #event(state, task, type) {
    if (state.sequence >= Number.MAX_SAFE_INTEGER) throw fault('SEQUENCE_EXHAUSTED', 'Event sequence exhausted');
    state.events.push({ sequence: ++state.sequence, eventId: randomUUID(), taskId: task.taskId, type, time: task.updatedAt, payload: clone(task) });
  }
  close() {
    if (this.#token) {
      const owner = JSON.parse(readFileSync(this.#lock, 'utf8'));
      if (owner.token !== this.#token) throw fault('STORE_LOCKED', 'Store lock ownership changed');
      unlinkSync(this.#lock);
      this.#token = null;
    }
    this.#state = null;
  }
  create(input) {
    this.#assertOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input must be an object');
    for (const key of Object.keys(input)) if (!INPUT.has(key)) throw new TypeError(`Unknown task input field: ${key}`);
    const now = new Date().toISOString();
    const task = { sessionId: null, status: 'queued', result: null, closed: false, error: null, ...input, taskId: input.taskId === undefined ? randomUUID() : input.taskId, createdAt: now, updatedAt: now };
    validate(task);
    if (this.#state.tasks.some(item => item.taskId === task.taskId)) throw fault('TASK_EXISTS', `Task already exists: ${task.taskId}`);
    const next = clone(this.#state);
    next.tasks.push(clone(task)); this.#event(next, task, 'task.created');
    this.#persist(next); this.#state = next;
    return clone(task);
  }
  get(id) { this.#assertOpen(); return clone(this.#state.tasks.find(task => task.taskId === id) ?? null); }
  list() { this.#assertOpen(); return clone(this.#state.tasks); }
  update(id, patch, eventType = 'task.updated') {
    this.#assertOpen(); text(eventType, 'eventType');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('patch must be an object');
    for (const key of Object.keys(patch)) if (!MUTABLE.has(key)) throw new TypeError(`Immutable or unknown task field: ${key}`);
    const next = clone(this.#state);
    const index = next.tasks.findIndex(task => task.taskId === id);
    if (index < 0) throw fault('TASK_NOT_FOUND', `Task not found: ${id}`);
    const task = { ...next.tasks[index], ...patch, updatedAt: new Date().toISOString() };
    validate(task); next.tasks[index] = clone(task); this.#event(next, task, eventType);
    this.#persist(next); this.#state = next;
    return clone(task);
  }
  events(afterSequence = 0) {
    this.#assertOpen();
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TypeError('afterSequence must be a nonnegative safe integer');
    return clone(this.#state.events.filter(event => event.sequence > afterSequence));
  }
}
export function createTaskStore(directory) { return new TaskStore(directory); }
export default TaskStore;
