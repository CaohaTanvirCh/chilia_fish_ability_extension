/** Shared Phase 0/1 contracts. All timestamps are ISO 8601 strings. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
export interface Task {
  taskId: string;
  sessionId: string | null;
  cwd: string;
  prompt: string;
  status: TaskStatus;
  result: JsonValue;
  createdAt: string;
  updatedAt: string;
  closed: boolean;
  error: JsonValue;
}
export interface CreateTaskInput {
  taskId?: string;
  cwd: string;
  prompt: string;
}
/** Internal persistence input; executor callers cannot inject execution state. */
export interface StoreCreateTaskInput extends CreateTaskInput {
  sessionId?: string | null;
  status?: TaskStatus;
  result?: JsonValue;
  closed?: boolean;
  error?: JsonValue;
}
export type TaskPatch = Partial<Pick<Task, 'sessionId' | 'cwd' | 'prompt' | 'status' | 'result' | 'closed' | 'error'>>;
export interface TaskEvent {
  /** Strictly increasing durable sequence, starting at 1. */
  sequence: number;
  eventId: string;
  taskId: string;
  type: string;
  time: string;
  /** Snapshot of the task after the mutation. */
  payload: Task;
}
export interface HealthCheckResult {
  healthy: boolean;
  message?: string;
  details?: JsonValue;
}
export type TaskEventListener = (event: TaskEvent) => void;
export type Unsubscribe = () => void;
/** Lifecycle and commands are asynchronous; subscriptions are registered synchronously. */
export interface TaskExecutor {
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<HealthCheckResult>;
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  listTasks(): Promise<Task[]>;
  resumeTask(taskId: string, options?: { prompt?: string }): Promise<Task>;
  cancelTask(taskId: string): Promise<Task>;
  closeTask(taskId: string): Promise<Task>;
  subscribeEvents(listener: TaskEventListener, options?: { afterSequence?: number }): Unsubscribe;
}
/** Optional convenience extension for waiting on the current local operation. */
export interface AwaitableTaskExecutor extends TaskExecutor {
  waitForTask(taskId: string, timeoutMs?: number): Promise<Task>;
}
/** Implemented by packages/task-store/index.mjs. Returned objects are detached copies. */
export interface TaskStore {
  open(): this;
  close(): void;
  create(input: StoreCreateTaskInput): Task;
  get(taskId: string): Task | null;
  list(): Task[];
  update(taskId: string, patch: TaskPatch, eventType?: string): Task;
  events(afterSequence?: number): TaskEvent[];
}
