import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const main = fileURLToPath(new URL('../apps/companion-hub/main.mjs', import.meta.url));

function startHub(dir, config) {
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({enabled: true, cwd: dir, ...config}));
  const child = spawn(process.execPath, [main, configPath], {stdio: ['pipe', 'pipe', 'pipe']});
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  return {child, output: () => out, error: () => err};
}

test('spawned Hub retries executor.stop after the first cleanup failure in the same instance', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fish-hub-stop-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const fake = path.join(dir, 'fake-executor.mjs');
  writeFileSync(fake, `
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
export async function createExecutor({config}) {
  const log = join(config.cwd, 'stops.log');
  let calls = 0;
  return {
    async initialize() {}, async start() {},
    async healthCheck() { return {healthy: true}; },
    subscribeEvents() { return () => {}; },
    async stop() { calls++; appendFileSync(log, calls + '\\n'); if (calls === 1) throw Object.assign(new Error('first stop failed'), {code: 'EIO'}); },
    async listTasks() { return []; }, async getTask() { return null; }, async getEvents() { return []; },
    async createTask() { throw new Error('not used'); }, async startExecution() { throw new Error('not used'); },
    async dispatchQueued() { throw new Error('not used'); }, async getExecution() { return null; },
    async listExecutions() { return []; }, async resumeTask() { throw new Error('not used'); },
    async reconcileTask() { throw new Error('not used'); }, async cancelTask() { throw new Error('not used'); },
    async cancelExecution() { throw new Error('not used'); }, async acknowledgeIntegrityAlerts() { throw new Error('not used'); },
    async closeSession() { throw new Error('not used'); }, async closeTask() { throw new Error('not used'); },
  };
}
`);
  const {child, output, error} = startHub(dir, {executorModule: './fake-executor.mjs'});
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hub ready timeout: ' + error())), 5000);
    const poll = setInterval(() => {
      if (output().includes('"type":"ready"')) { clearInterval(poll); clearTimeout(timer); resolve(); }
    }, 10);
    child.once('exit', code => { clearInterval(poll); clearTimeout(timer); reject(new Error('Hub exited early: ' + code + ' ' + error())); });
  });
  await ready;
  child.stdin.end('{"id":"stop-1","method":"stop","args":[]}\n');
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, error());
  const stops = readFileSync(path.join(dir, 'stops.log'), 'utf8').trim().split('\n');
  assert.deepEqual(stops, ['1', '2']);
  assert.match(output(), /first stop failed/);
});
