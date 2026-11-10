/** Phase 1.1 persistence contracts. Existing index.d.ts remains the independent v1 API. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
export type TaskStatus = ExecutionStatus;
export type SubmissionState = 'not_started' | 'dispatch_intent' | 'response_observed';
export type ResultIntegrity = 'partial' | 'observed_complete' | 'uncertain';
/** Records permit additional JSON fields so Executor can evolve without a persistence migration. */
export interface Task {
  [field: string]: JsonValue | undefined;
  taskId: string;
  cwd?: string;
  objective?: string;
  lifecycle?: 'open' | 'closed';
  status?: TaskStatus;
  latestExecutionId?: string | null;
  activeExecutionId?: string | null;
  unresolvedExecutionIds?: string[];
  duplicateExecutionRisk?: boolean;
  integrityAlerts?: JsonValue[];
  createdAt?: string;
  updatedAt?: string;
  revision?: number;
}
export interface CompletionEvidence {
  [field: string]: JsonValue;
  stopReason: 'end_turn' | 'cancelled' | 'local_not_submitted';
}
export interface Execution {
  [field: string]: JsonValue | undefined;
  executionId: string;
  taskId: string;
  status: ExecutionStatus;
  prompt?: string;
  submission?: SubmissionState;
  bindingId?: string | null;
  result?: JsonValue;
  resultIntegrity?: ResultIntegrity;
  completionEvidence?: CompletionEvidence | null;
  diagnostics?: JsonValue[];
  cancel?: { requestedAt: string | null; sentAt: string | null; confirmedAt: string | null; [field: string]: JsonValue };
  requestKey?: string;
  createdAt?: string;
  updatedAt?: string;
}
export interface SessionBinding {
  [field: string]: JsonValue | undefined;
  bindingId: string;
  taskId: string;
  sessionId?: string | null;
  cwd?: string;
  runtimeId?: string;
  availability?: 'closed' | 'active' | 'unknown';
  generation?: string;
}
/** Persisted idempotency entries are immutable and scoped to this Store directory. */
export interface RequestRecord {
  [field: string]: JsonValue | undefined;
  key: string;
  taskId: string;
  executionId?: string | null;
  inputHash?: string;
}
export interface EventInput {
  type: string;
  taskId: string;
  executionId?: string;
  /** Compact domain metadata only, never cumulative result snapshots; total event <= 4 KiB UTF-8. */
  data?: JsonValue;
}
export interface DomainEvent extends EventInput {
  eventId: string;
  sequence: number;
  revision: number;
  time: string;
}
export interface StoreSnapshot {
  version: 2;
  revision: number;
  sequence: number;
  tasks: Task[];
  executions: Execution[];
  bindings: SessionBinding[];
  requests: RequestRecord[];
  events: DomainEvent[];
}
export interface StoreChanges {
  /** Full-record replacements by ID; records are never deleted implicitly. */
  tasks?: Task[];
  executions?: Execution[];
  bindings?: SessionBinding[];
  requests?: RequestRecord[];
  events?: EventInput[];
  /** Required for admitting new work. Uses hard byte/event limits minus terminal reserves. */
  admission?: boolean;
}
export interface StoreLimits {
  /** Default 32 MiB, measured as serialized UTF-8 including trailing newline. */
  maxBytes?: number;
  /** Default 20,000. No automatic history pruning. */
  maxEvents?: number;
  /** Default 1,000. */
  maxTasks?: number;
  /** Default 5,000. */
  maxExecutions?: number;
  /** Default min(18 MiB, floor(maxBytes * 0.6)); permits eight 1 MiB outputs plus Task projections. */
  reserveBytes?: number;
  /** Default min(1024, floor(maxEvents / 10)). */
  reserveEvents?: number;
}
export interface StoreHealth {
  healthy: boolean;
  revision?: number;
  message?: string;
  code?: string;
}
/**
 * Implemented by packages/task-store-v2/index.mjs. All methods are synchronous.
 * Owns state-v2.json and store-v2.lock. open() refuses a legacy-only directory with
 * MIGRATION_REQUIRED; it never fabricates execution receipts. An incomplete migration marker
 * or destination migration lock causes MIGRATION_INCOMPLETE. Running or dispatch_intent
 * executions recover to unknown; queued/not_started executions remain queued. A terminal
 * execution whose binding is still active is marked unknown with recoveryRequired, never closed.
 * Snapshot and commit return detached JSON copies. Revision starts at 0; every successful
 * commit advances it once. Throws REVISION_CONFLICT, CAPACITY, VALIDATION,
 * IMMUTABLE_TERMINAL, STORE_LOCKED, STORE_CLOSED, STORE_CORRUPT or native I/O errors.
 * Terminal status, prompt, result, completionEvidence and resultIntegrity cannot change;
 * diagnostics/cancel timestamps may change. Completion requires observed_complete +
 * end_turn evidence and a result in the same transaction. Cancellation requires cancelled
 * or local_not_submitted evidence. Unknown/interrupted cannot carry a completion receipt.
 */
export interface ExecutionStore {
  open(): this;
  close(): void;
  snapshot(): StoreSnapshot;
  commit(expectedRevision: number, changes: StoreChanges): StoreSnapshot;
  healthCheck(): StoreHealth;
}
export interface CreateTaskInput { cwd: string; prompt: string; requestKey: string; taskId?: string; defer?: boolean; }
export interface StartExecutionInput { prompt: string; requestKey: string; acknowledgeUnknownExecutionIds?: string[]; }
/** A notification-integrity risk. Acknowledgement preserves the original alert. */
export interface IntegrityAlert {
  executionId: string;
  code: string;
  time?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  note?: string;
}
/** `cancelRequested` means a request was recorded; only `cancelConfirmed` means termination was observed. */
export interface CancelExecutionResult {
  execution: Execution;
  cancelRequested: boolean;
  cancelConfirmed: boolean;
}
export interface TaskExecutor {
  initialize(): Promise<void>; start(): Promise<void>; stop(): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; [field: string]: unknown }>;
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>; listTasks(): Promise<Task[]>;
  startExecution(taskId: string, input: StartExecutionInput): Promise<Execution>;
  dispatchQueued(executionId: string): Promise<Execution>;
  getExecution(executionId: string): Promise<Execution | null>; listExecutions(taskId?: string): Promise<Execution[]>;
  cancelExecution(executionId: string): Promise<CancelExecutionResult>; cancelTask(taskId: string): Promise<Task>;
  acknowledgeIntegrityAlerts(taskId: string, input: {acknowledgedBy: string; note?: string}): Promise<Task>;
  closeSession(taskId: string): Promise<Task>; closeTask(taskId: string): Promise<Task>;
  resumeTask(taskId: string, options?: {restoreContext?: boolean}): Promise<Task>;
  reconcileTask(taskId: string, options?: {restoreContext?: boolean}): Promise<Task>;
  getEvents(afterSequence?: number, limit?: number): Promise<DomainEvent[]>;
  subscribeEvents(listener: (event: DomainEvent) => void, options?: {afterSequence?: number}): () => void;
  waitForTask(taskId: string, timeoutMs?: number): Promise<Task>;
}
export interface AcpTransport {
  start(callbacks?: {onUpdate?: (notification: unknown) => void; onPermission?: (request: unknown) => unknown; onDisconnect?: (error: Error) => void}): Promise<unknown>;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>; stop(): Promise<void>;
  healthCheck(): {healthy: boolean; pid?: number | null};
}
/** Constructor shape for consumers loading the JavaScript implementation. */
export interface ExecutionStoreConstructor {
  new(directory: string, limits?: StoreLimits): ExecutionStore;
}
