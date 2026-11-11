import { StoreV3, STORE_V3_INTERNAL_COMMIT } from '../../packages/task-store-v3/index.mjs';

const [directory, mode] = process.argv.slice(2);
const store = new StoreV3(directory);
store.open();

if (mode === 'after-commit') {
  store[STORE_V3_INTERNAL_COMMIT](store.snapshot().revision, draft => {
    draft.tasks.push({ taskId: 'crash-task' });
    return [{
      scope: 'system',
      workspaceId: null,
      type: 'crash.committed',
      schemaVersion: 1,
      source: 'system',
      audience: 'system',
      data: { mode },
    }];
  });
}

// Deliberately do not close: the process exit leaves a stale lock for recovery.
process.exit(42);
