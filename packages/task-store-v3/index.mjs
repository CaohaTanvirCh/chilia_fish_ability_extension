import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/**
 * Internal transaction capability.
 *
 * This is deliberately not a generic `commit(changes)` method. It is exported
 * only so the foundation test suite and the future Store-internal
 * `commitAuthorized` implementation can exercise the same primitive without
 * adding a public write door. It must never be wired into Hub, an Executor, or
 * a command table.
 */
export const STORE_V3_INTERNAL_COMMIT = Symbol('store-v3.internal-commit');

const VERSION = 3;
const TOP_LEVEL = new Set([
  'version',
  'revision',
  'sequence',
  'authorizationRevision',
  'bootstrapState',
  'authorizationState',
  'principals',
  'workspaces',
  'workspaceMembers',
  'membershipRevisions',
  'membershipInvites',
  'delegations',
  'revocationFences',
  'tasks',
  'executions',
  'sessionBindings',
  'artifacts',
  'artifactReferences',
  'artifactGrants',
  'workspaceLeases',
  'requests',
  'events',
  'migrationRecords',
]);
const ID_COLLECTIONS = {
  principals: 'principalId',
  workspaces: 'workspaceId',
  membershipRevisions: 'membershipRevisionId',
  membershipInvites: 'inviteId',
  delegations: 'delegationId',
  revocationFences: 'fenceId',
  tasks: 'taskId',
  executions: 'executionId',
  sessionBindings: 'bindingId',
  artifacts: 'artifactId',
  artifactGrants: 'grantId',
  workspaceLeases: 'leaseId',
  requests: 'requestRecordId',
};
const PLAIN_COLLECTIONS = ['workspaceMembers', 'artifactReferences', 'migrationRecords'];
const BOOTSTRAP_FIELDS = new Set([
  'bootstrapPrincipalId',
  'workspaceId',
  'ownerPrincipalId',
  'rootFingerprint',
  'completedAt',
]);
const EVENT_FIELDS = new Set([
  'eventId',
  'sequence',
  'revision',
  'scope',
  'workspaceId',
  'type',
  'schemaVersion',
  'actorPrincipalId',
  'source',
  'taskId',
  'executionId',
  'artifactId',
  'correlationId',
  'causationId',
  'audience',
  'time',
  'data',
]);
const EVENT_SCOPES = new Set(['workspace', 'system']);
const EVENT_SOURCES = new Set(['user', 'agent', 'hub', 'executor', 'system']);
const EVENT_AUDIENCES = new Set(['tenant', 'admin', 'system']);
const EVENT_MAX_BYTES = 4096;
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EISDIR', 'EPERM', 'ENOTSUP', 'EBADF']);

function fault(code, message) {
  return Object.assign(new Error(message), { code });
}
function text(value, name, code = 'VALIDATION') {
  if (typeof value !== 'string' || !value.trim()) throw fault(code, `${name} must be a nonempty string`);
}
function optionalText(value, name, code = 'VALIDATION') {
  if (value == null) return null;
  text(value, name, code);
  return value;
}
function json(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object' || ancestors.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw fault('VALIDATION', 'Expected finite acyclic JSON');
  ancestors.add(value);
  for (const item of Object.values(value)) json(item, ancestors);
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw fault('VALIDATION', 'Sparse JSON array');
  ancestors.delete(value);
}
function record(value, code = 'VALIDATION') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fault(code, 'Expected a record');
  try {
    json(value);
  } catch (error) {
    throw fault(code, `Invalid JSON record: ${error.message}`);
  }
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw fault('STORE_LOCKED', 'Invalid lock owner; refusing recovery');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}
function initialState() {
  return {
    version: VERSION,
    revision: 0,
    sequence: 0,
    authorizationRevision: 0,
    bootstrapState: null,
    authorizationState: { authorizationRevision: 0 },
    principals: [],
    workspaces: [],
    workspaceMembers: [],
    membershipRevisions: [],
    membershipInvites: [],
    delegations: [],
    revocationFences: [],
    tasks: [],
    executions: [],
    sessionBindings: [],
    artifacts: [],
    artifactReferences: [],
    artifactGrants: [],
    workspaceLeases: [],
    requests: [],
    events: [],
    migrationRecords: [],
  };
}

/**
 * Isolated v3 foundation store.
 *
 * It owns only `state-v3.json` and `store-v3.lock` below its directory. It
 * never reads or rewrites v2 files and is not imported by the Hub or Executor.
 */
export class StoreV3 {
  #directory;
  #file;
  #lock;
  #token = null;
  #state = null;
  #failure = null;
  #faults;
  #inTransaction = false;
  #directorySyncSupported = null;

  constructor(directory, { faults = {} } = {}) {
    text(directory, 'directory');
    if (!faults || typeof faults !== 'object' || Array.isArray(faults)) throw new TypeError('faults must be an object');
    for (const [name, inject] of Object.entries(faults)) {
      if (typeof inject !== 'function') throw new TypeError(`fault ${name} must be a function`);
    }
    this.#directory = resolve(directory);
    this.#file = join(this.#directory, 'state-v3.json');
    this.#lock = join(this.#directory, 'store-v3.lock');
    // Keep the object by reference so tests can arm a fault after open().
    this.#faults = faults;
  }

  #fault(name) {
    const inject = this.#faults[name];
    if (inject === undefined) return;
    if (typeof inject !== 'function') throw fault('VALIDATION', `fault ${name} must be a function`);
    inject();
  }

  #claim() {
    const token = randomUUID();
    const acquire = () => {
      const fd = openSync(this.#lock, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ kind: 'store-v3', pid: process.pid, token, createdAt: new Date().toISOString() }));
        fsyncSync(fd);
      } catch (error) {
        try { closeSync(fd); } catch {}
        try { unlinkSync(this.#lock); } catch {}
        throw error;
      }
      try {
        closeSync(fd);
      } catch (error) {
        try { unlinkSync(this.#lock); } catch {}
        throw error;
      }
      this.#token = token;
    };
    try {
      acquire();
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const guard = `${this.#lock}.recovery`;
    let fd;
    try {
      fd = openSync(guard, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') throw fault('STORE_LOCKED', 'Store v3 ownership recovery is already in progress');
      throw error;
    }
    try {
      let raw;
      try {
        raw = readFileSync(this.#lock, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') {
          try { acquire(); } catch (acquireError) {
            if (acquireError.code === 'EEXIST') throw fault('STORE_LOCKED', 'Store v3 already has an owner');
            throw acquireError;
          }
          return;
        }
        throw fault('STORE_LOCKED', 'Unreadable lock; refusing removal');
      }
      let owner;
      try {
        owner = JSON.parse(raw);
      } catch {
        throw fault('STORE_LOCKED', 'Unreadable lock; refusing removal');
      }
      if (!owner || typeof owner !== 'object') throw fault('STORE_LOCKED', 'Invalid lock owner; refusing removal');
      if (alive(owner.pid)) throw fault('STORE_LOCKED', 'Store v3 already has a live owner');
      unlinkSync(this.#lock);
      try {
        acquire();
      } catch (error) {
        if (error.code === 'EEXIST') throw fault('STORE_LOCKED', 'Store v3 already has an owner');
        throw error;
      }
    } finally {
      try { closeSync(fd); } catch {}
      try { unlinkSync(guard); } catch {}
    }
  }

  #readState() {
    let raw;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'EISDIR') throw fault('STORE_CORRUPT', 'state-v3.json is not a regular file');
      throw fault('STORAGE_FAULT', `Cannot read state-v3.json: ${error.message}`);
    }
    let state;
    try {
      state = JSON.parse(raw);
    } catch (error) {
      throw fault('STORE_CORRUPT', `Invalid state-v3.json: ${error.message}`);
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw fault('STORE_CORRUPT', 'state-v3.json must be an object');
    if (state.version !== VERSION) throw fault('STORE_VERSION_UNSUPPORTED', `Unsupported v3 schema version: ${String(state.version)}`);
    this.#validate(state, 'STORE_CORRUPT');
    return state;
  }

  #validateBootstrap(bootstrap, code) {
    if (bootstrap === null) return;
    record(bootstrap, code);
    const keys = Object.keys(bootstrap);
    if (keys.length !== BOOTSTRAP_FIELDS.size || keys.some(key => !BOOTSTRAP_FIELDS.has(key))) throw fault(code, 'Invalid bootstrapState fields');
    for (const key of ['bootstrapPrincipalId', 'workspaceId', 'ownerPrincipalId', 'rootFingerprint']) text(bootstrap[key], `bootstrapState.${key}`, code);
    if (typeof bootstrap.completedAt !== 'string' || !Number.isFinite(Date.parse(bootstrap.completedAt))) throw fault(code, 'Invalid bootstrapState.completedAt');
  }

  #validateEvents(state, code) {
    if (!Array.isArray(state.events)) throw fault(code, 'events must be an array');
    if (state.events.length !== state.sequence) throw fault(code, 'event sequence does not match events length');
    const eventIds = new Set();
    for (const [index, event] of state.events.entries()) {
      record(event, code);
      const keys = Object.keys(event);
      if (keys.length !== EVENT_FIELDS.size || keys.some(key => !EVENT_FIELDS.has(key))) throw fault(code, 'Invalid event fields');
      text(event.eventId, 'eventId', code);
      if (eventIds.has(event.eventId)) throw fault(code, 'Duplicate eventId');
      eventIds.add(event.eventId);
      if (!Number.isSafeInteger(event.sequence) || event.sequence !== index + 1) throw fault(code, 'Invalid event sequence');
      if (!Number.isSafeInteger(event.revision) || event.revision < 1 || event.revision > state.revision) throw fault(code, 'Invalid event revision');
      if (!EVENT_SCOPES.has(event.scope)) throw fault(code, 'Invalid event scope');
      if (event.scope === 'system') {
        if (event.workspaceId !== null) throw fault(code, 'System event must not have workspaceId');
      } else {
        text(event.workspaceId, 'event.workspaceId', code);
      }
      text(event.type, 'event.type', code);
      if (!Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1) throw fault(code, 'Invalid event schemaVersion');
      if (!EVENT_SOURCES.has(event.source)) throw fault(code, 'Invalid event source');
      if (!EVENT_AUDIENCES.has(event.audience)) throw fault(code, 'Invalid event audience');
      for (const key of ['actorPrincipalId', 'taskId', 'executionId', 'artifactId', 'correlationId', 'causationId']) optionalText(event[key], `event.${key}`, code);
      if (typeof event.time !== 'string' || !Number.isFinite(Date.parse(event.time))) throw fault(code, 'Invalid event time');
      try {
        json(event.data);
      } catch (error) {
        throw fault(code, `Invalid event data: ${error.message}`);
      }
      if (Buffer.byteLength(JSON.stringify(event)) > EVENT_MAX_BYTES) throw fault(code, 'Event exceeds 4 KiB');
    }
  }

  #validate(state, code = 'VALIDATION') {
    record(state, code);
    const keys = Object.keys(state);
    if (keys.length !== TOP_LEVEL.size || keys.some(key => !TOP_LEVEL.has(key))) throw fault(code, 'Invalid top-level state fields');
    if (state.version !== VERSION) throw fault(code, 'Invalid state version');
    if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw fault(code, 'Invalid revision');
    if (!Number.isSafeInteger(state.sequence) || state.sequence < 0) throw fault(code, 'Invalid sequence');
    if (!Number.isSafeInteger(state.authorizationRevision) || state.authorizationRevision < 0) throw fault(code, 'Invalid authorizationRevision');
    this.#validateBootstrap(state.bootstrapState, code);
    record(state.authorizationState, code);
    const authKeys = Object.keys(state.authorizationState);
    if (authKeys.length !== 1 || authKeys[0] !== 'authorizationRevision') throw fault(code, 'Invalid authorizationState');
    if (!Number.isSafeInteger(state.authorizationState.authorizationRevision) || state.authorizationState.authorizationRevision < 0) throw fault(code, 'Invalid authorizationState.authorizationRevision');
    if (state.authorizationState.authorizationRevision !== state.authorizationRevision) throw fault(code, 'authorizationRevision projection mismatch');

    for (const [name, idField] of Object.entries(ID_COLLECTIONS)) {
      if (!Array.isArray(state[name])) throw fault(code, `${name} must be an array`);
      const ids = new Set();
      for (const item of state[name]) {
        record(item, code);
        text(item[idField], `${name}.${idField}`, code);
        if (ids.has(item[idField])) throw fault(code, `Duplicate ${idField}`);
        ids.add(item[idField]);
      }
    }
    for (const name of PLAIN_COLLECTIONS) {
      if (!Array.isArray(state[name])) throw fault(code, `${name} must be an array`);
      for (const item of state[name]) record(item, code);
    }
    for (const member of state.workspaceMembers) {
      text(member.workspaceId, 'workspaceMembers.workspaceId', code);
      text(member.principalId, 'workspaceMembers.principalId', code);
    }
    const memberKeys = new Set();
    for (const member of state.workspaceMembers) {
      const key = JSON.stringify([member.workspaceId, member.principalId]);
      if (memberKeys.has(key)) throw fault(code, 'Duplicate workspace membership');
      memberKeys.add(key);
    }
    this.#validateEvents(state, code);
  }

  #validateEventInput(input) {
    record(input);
    const keys = Object.keys(input);
    if (keys.some(key => !EVENT_FIELDS.has(key) || ['eventId', 'sequence', 'revision', 'time'].includes(key))) throw fault('VALIDATION', 'Invalid event input fields');
    if (!EVENT_SCOPES.has(input.scope)) throw fault('VALIDATION', 'Invalid event scope');
    if (input.scope === 'system') {
      if (input.workspaceId != null) throw fault('VALIDATION', 'System event must not have workspaceId');
    } else {
      text(input.workspaceId, 'event.workspaceId');
    }
    text(input.type, 'event.type');
    const schemaVersion = input.schemaVersion ?? 1;
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw fault('VALIDATION', 'Invalid event schemaVersion');
    if (!EVENT_SOURCES.has(input.source)) throw fault('VALIDATION', 'Invalid event source');
    if (!EVENT_AUDIENCES.has(input.audience)) throw fault('VALIDATION', 'Invalid event audience');
    for (const key of ['actorPrincipalId', 'taskId', 'executionId', 'artifactId', 'correlationId', 'causationId']) optionalText(input[key], `event.${key}`);
    try {
      json(input.data ?? null);
    } catch (error) {
      throw fault('VALIDATION', `Invalid event data: ${error.message}`);
    }
    if (Buffer.byteLength(JSON.stringify(input.data ?? null)) > EVENT_MAX_BYTES) throw fault('CAPACITY', 'Event exceeds 4 KiB');
    return { ...input, workspaceId: input.workspaceId ?? null, schemaVersion, data: input.data ?? null };
  }

  #appendEvent(state, input) {
    if (!Number.isSafeInteger(state.sequence) || state.sequence >= Number.MAX_SAFE_INTEGER) throw fault('SEQUENCE_EXHAUSTED', 'Event sequence exhausted');
    const event = {
      eventId: randomUUID(),
      sequence: state.sequence + 1,
      revision: state.revision,
      scope: input.scope,
      workspaceId: input.workspaceId ?? null,
      type: input.type,
      schemaVersion: input.schemaVersion ?? 1,
      actorPrincipalId: input.actorPrincipalId ?? null,
      source: input.source,
      taskId: input.taskId ?? null,
      executionId: input.executionId ?? null,
      artifactId: input.artifactId ?? null,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null,
      audience: input.audience,
      time: new Date().toISOString(),
      data: clone(input.data ?? null),
    };
    if (Buffer.byteLength(JSON.stringify(event)) > EVENT_MAX_BYTES) throw fault('CAPACITY', 'Event exceeds 4 KiB');
    state.sequence++;
    state.events.push(event);
  }

  #appendEvents(state, inputs) {
    if (inputs === undefined) return;
    if (!Array.isArray(inputs)) throw fault('VALIDATION', 'Transaction events must be an array');
    for (const input of inputs) {
      const validated = this.#validateEventInput(input);
      this.#appendEvent(state, validated);
    }
  }

  #syncDirectory() {
    // A fault here simulates a post-rename durability failure.
    this.#fault('syncDirectory');
    let fd;
    try {
      fd = openSync(this.#directory, 'r');
    } catch (error) {
      if (DIRECTORY_SYNC_UNSUPPORTED.has(error.code)) {
        this.#directorySyncSupported = false;
        return;
      }
      throw error;
    }
    try {
      try {
        fsyncSync(fd);
        this.#directorySyncSupported = true;
      } catch (error) {
        if (DIRECTORY_SYNC_UNSUPPORTED.has(error.code)) {
          this.#directorySyncSupported = false;
          return;
        }
        throw error;
      }
    } finally {
      // A close failure here is a post-rename durability failure, not a
      // pre-commit failure. Let it propagate to #persist.
      try { this.#fault('closeDirectory'); } finally { closeSync(fd); }
    }
  }

  #persist(state) {
    const temporary = `${this.#file}.${this.#token}.${randomUUID()}.tmp`;
    let fd;
    let renamed = false;
    try {
      this.#fault('beforeWrite');
      fd = openSync(temporary, 'wx');
      try {
        writeFileSync(fd, JSON.stringify(state) + '\n', 'utf8');
        this.#fault('afterWrite');
        this.#fault('syncTemp');
        fsyncSync(fd);
        this.#fault('afterSyncTemp');
        this.#fault('closeTemp');
        closeSync(fd);
        fd = undefined;
      } catch (error) {
        throw error;
      }
      this.#fault('beforeRename');
      this.#fault('rename');
      renameSync(temporary, this.#file);
      renamed = true;
      this.#fault('afterRename');
      this.#syncDirectory();
    } catch (error) {
      if (renamed) {
        const failure = fault('STORE_DURABILITY_UNCERTAIN', `Snapshot was renamed but durability could not be confirmed: ${error.message}`);
        failure.cause = error;
        this.#failure = failure;
        throw failure;
      }
      throw error;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
      if (existsSync(temporary)) {
        try { unlinkSync(temporary); } catch {}
      }
    }
  }

  open() {
    if (this.#state) {
      if (this.#failure) throw this.#failure;
      return this;
    }
    // A previous failed open/close may leave a failure recorded. A new open
    // must verify the disk instead of trusting old memory.
    this.#failure = null;
    this.#directorySyncSupported = null;
    mkdirSync(this.#directory, { recursive: true });
    try {
      this.#claim();
      const loaded = this.#readState();
      if (loaded) {
        this.#state = loaded;
        return this;
      }
      const state = initialState();
      this.#validate(state, 'VALIDATION');
      this.#persist(state);
      this.#state = state;
      return this;
    } catch (error) {
      try {
        this.close();
      } catch (closeError) {
        error.cleanupError = closeError;
      }
      throw error;
    }
  }

  #assertOpen() {
    if (this.#failure) {
      const error = fault('STORE_FAILED', 'Store is fail-closed after uncertain snapshot durability; reopen to verify the disk state');
      error.cause = this.#failure;
      throw error;
    }
    if (!this.#state) throw fault('STORE_CLOSED', 'Open the store before using it');
  }

  snapshot() {
    this.#assertOpen();
    return clone(this.#state);
  }

  /**
   * Internal transaction primitive. Not a public Hub/Executor API and not
   * `commitAuthorized`.
   *
   * `build(draft)` may mutate collection records in the cloned draft and
   * return an array of event inputs. Metadata (revision, sequence,
   * authorizationRevision, authorizationState, version, existing events) is
   * controlled by the store, not by the callback.
   */
  [STORE_V3_INTERNAL_COMMIT](expectedRevision, build) {
    this.#assertOpen();
    if (this.#inTransaction) throw fault('TRANSACTION_REENTRANT', 'Nested Store transactions are not allowed');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw fault('VALIDATION', 'expectedRevision must be a nonnegative safe integer');
    if (expectedRevision !== this.#state.revision) throw fault('REVISION_CONFLICT', 'Store revision changed');
    if (typeof build !== 'function') throw fault('VALIDATION', 'Transaction builder must be a function');
    this.#inTransaction = true;
    try {
      const before = this.#state;
      const draft = clone(before);
      const inputs = build(draft);
      if (this.#state !== before) throw fault('INVALID_TRANSACTION', 'Transaction cannot close or replace the Store');
      if (draft.version !== before.version
        || draft.revision !== before.revision
        || draft.sequence !== before.sequence
        || draft.authorizationRevision !== before.authorizationRevision
        || !isDeepStrictEqual(draft.authorizationState, before.authorizationState)
        || !isDeepStrictEqual(draft.events, before.events)) {
        throw fault('INVALID_TRANSACTION', 'Transaction callback cannot change store metadata, events, or authorization state');
      }
      if (before.revision >= Number.MAX_SAFE_INTEGER) throw fault('REVISION_EXHAUSTED', 'Store revision exhausted');
      draft.revision = before.revision + 1;
      this.#appendEvents(draft, inputs);
      this.#validate(draft, 'VALIDATION');
      this.#persist(draft);
      this.#state = draft;
      return clone(draft);
    } finally {
      this.#inTransaction = false;
    }
  }

  healthCheck() {
    if (!this.#state) return { healthy: false, code: 'STORE_CLOSED', message: 'Store is closed' };
    if (this.#failure) {
      return {
        healthy: false,
        code: 'STORE_DURABILITY_UNCERTAIN',
        message: this.#failure.message,
        revision: this.#state.revision,
        sequence: this.#state.sequence,
      };
    }
    try {
      const owner = JSON.parse(readFileSync(this.#lock, 'utf8'));
      if (!owner || owner.token !== this.#token) throw fault('STORE_LOCKED', 'Store lock ownership changed');
    } catch (error) {
      return { healthy: false, code: 'STORE_LOCKED', message: error.message, revision: this.#state.revision };
    }
    return {
      healthy: true,
      revision: this.#state.revision,
      sequence: this.#state.sequence,
      authorizationRevision: this.#state.authorizationRevision,
      directorySyncSupported: this.#directorySyncSupported,
    };
  }

  close() {
    if (this.#inTransaction) throw fault('TRANSACTION_ACTIVE', 'Cannot close the Store inside a transaction');
    if (!this.#token) {
      this.#state = null;
      return;
    }
    let raw;
    try {
      raw = readFileSync(this.#lock, 'utf8');
    } catch (error) {
      throw fault('STORE_LOCKED', `Cannot verify lock ownership before close: ${error.message}`);
    }
    let owner;
    try {
      owner = JSON.parse(raw);
    } catch {
      throw fault('STORE_LOCKED', 'Unreadable lock; refusing removal');
    }
    if (!owner || owner.token !== this.#token) throw fault('STORE_LOCKED', 'Store lock ownership changed; refusing removal');
    unlinkSync(this.#lock);
    this.#token = null;
    this.#state = null;
  }
}

export function createStoreV3(directory, options) {
  return new StoreV3(directory, options);
}

export default StoreV3;
