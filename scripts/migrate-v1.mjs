import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TaskStore } from '../packages/task-store/index.mjs';
import { ExecutionStore } from '../packages/task-store-v2/index.mjs';

/** Explicit offline import. Source bytes are read only while owning the public v1 lock filename. */
export function migrateV1(sourceDirectory, targetDirectory) {
  if (!sourceDirectory || !targetDirectory) throw new Error('Usage: node scripts/migrate-v1.mjs <v1-directory> <NEW-v2-directory>');
  const source = path.resolve(sourceDirectory), target = path.resolve(targetDirectory);
  if (source === target || target.startsWith(`${source}${path.sep}`)) throw new Error('Target must be a new directory outside source');
  if (existsSync(target)) throw new Error('Target must not exist; migration never overwrites');
  const token = randomUUID();
  const sourceLock = path.join(source, 'task-store.lock');
  const destinationLock = `${target}.migration.lock`;
  let sourceOwned = false, destinationOwned = false, staging;
  function claim(file) {
    const fd = openSync(file, 'wx');
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  function release(file) {
    const owner = JSON.parse(readFileSync(file, 'utf8'));
    if (owner.token !== token) throw new Error(`Migration lock ownership changed: ${file}`);
    unlinkSync(file);
  }
  try {
    claim(sourceLock); sourceOwned = true;
    mkdirSync(path.dirname(target), { recursive: true });
    claim(destinationLock); destinationOwned = true;
    if (existsSync(target)) throw new Error('Target appeared during migration; refusing overwrite');
    const raw = readFileSync(path.join(source, 'task-store.json'), 'utf8');
    const legacy = JSON.parse(raw);
    if (legacy.version !== 1) throw new Error('Expected v1');
    staging = `${target}.migration-${token}`;
    mkdirSync(staging);
    writeFileSync(path.join(staging, 'MIGRATION_INCOMPLETE'), JSON.stringify({ source, target, token }), { flag: 'wx' });
    writeFileSync(path.join(staging, 'legacy-v1-backup.json'), raw, { flag: 'wx' });
    // Public v1 validation operates only on a disposable copy; its recovery never touches source.
    const validatorDir = path.join(staging, 'legacy-validation');
    mkdirSync(validatorDir); writeFileSync(path.join(validatorDir, 'task-store.json'), raw, { flag: 'wx' });
    const validator = new TaskStore(validatorDir);
    try { validator.open(); } finally { validator.close(); }
    const tasks = [], executions = [], bindings = [], events = [];
    for (const old of legacy.tasks) {
      const executionId = `legacy-${old.taskId}`;
      const bindingId = old.sessionId ? `legacy-binding-${old.taskId}` : null;
      if (bindingId) bindings.push({ bindingId, taskId: old.taskId, sessionId: old.sessionId, cwd: old.cwd, runtimeId: 'legacy-unverified', availability: 'unknown' });
      executions.push({ executionId, taskId: old.taskId, status: 'unknown', submission: 'dispatch_intent', prompt: old.prompt, result: old.result, resultIntegrity: 'uncertain', completionEvidence: null, bindingId, diagnostics: [{ code: 'LEGACY_UNVERIFIED', message: 'v1 status is not a trustworthy execution receipt; see original backup' }], legacyReportedStatus: old.status, createdAt: old.createdAt, updatedAt: old.updatedAt });
      tasks.push({ taskId: old.taskId, cwd: old.cwd, objective: old.prompt, lifecycle: old.closed ? 'closed' : 'open', status: 'unknown', latestExecutionId: executionId, activeExecutionId: null, unresolvedExecutionIds: [executionId], duplicateExecutionRisk: true, integrityAlerts: [], result: old.result, sessionId: old.sessionId, createdAt: old.createdAt, updatedAt: old.updatedAt, revision: 1 });
      events.push({ type: 'legacy.imported', taskId: old.taskId, executionId, data: { legacyReportedStatus: old.status } });
    }
    // Build v2 state in a nested workspace; incomplete staging itself is never openable.
    const build = path.join(staging, 'build');
    const store = new ExecutionStore(build);
    try { store.open(); store.commit(0, { tasks, executions, bindings, events }); } finally { store.close(); }
    renameSync(path.join(build, 'state-v2.json'), path.join(staging, 'state-v2.json'));
    // Keep the marker until a complete state and raw backup are durable.
    for (const name of ['state-v2.json', 'legacy-v1-backup.json']) {
      const fd = openSync(path.join(staging, name), 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    // Exclusive mkdir is the destination claim; even an empty competing directory is never overwritten.
    mkdirSync(target);
    writeFileSync(path.join(target, 'MIGRATION_INCOMPLETE'), JSON.stringify({ source, target, token }), { flag: 'wx' });
    renameSync(path.join(staging, 'legacy-v1-backup.json'), path.join(target, 'legacy-v1-backup.json'));
    renameSync(path.join(staging, 'state-v2.json'), path.join(target, 'state-v2.json'));
    // The only recursive cleanup target is our verified, token-named staging directory.
    if (staging !== `${target}.migration-${token}` || path.dirname(staging) !== path.dirname(target)) throw new Error('Unexpected staging cleanup path');
    rmSync(staging, { recursive: true });
    unlinkSync(path.join(target, 'MIGRATION_INCOMPLETE'));
    return { version: 2, target, tasks: tasks.length, note: 'All legacy outcomes unverified; original events preserved in legacy-v1-backup.json' };
  } finally {
    if (destinationOwned) release(destinationLock);
    if (sourceOwned) release(sourceLock);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(migrateV1(process.argv[2], process.argv[3])));
}
