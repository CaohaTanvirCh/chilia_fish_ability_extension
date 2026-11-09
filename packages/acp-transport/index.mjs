import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

async function settledWithin(promise, ms) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}

export class AcpTransport {
  constructor(config) {
    for (const name of ['timeoutMs', 'startupTimeoutMs', 'shutdownTimeoutMs', 'killTimeoutMs']) {
      if (config[name] !== undefined && (!Number.isFinite(config[name]) || config[name] <= 0 || config[name] > 2147483647)) throw new TypeError(`${name} must be a positive timer duration`);
    }
    this.config = config; this.child = null; this.connection = null; this.stopping = false;
    this.generation = null; this.starting = null; this.stopPromise = null;
  }
  start(callbacks = {}) {
    if (this.stopPromise) return Promise.reject(Object.assign(new Error('ACP transport is stopping'), { code: 'STOPPING' }));
    if (this.starting) return this.starting;
    this.stopping = false;
    const operation = this.startGeneration(callbacks);
    this.starting = operation;
    operation.finally(() => { if (this.starting === operation) this.starting = null; }).catch(() => {});
    return operation;
  }
  async startGeneration({ onUpdate = () => {}, onPermission = () => {}, onDisconnect = () => {} }) {
    if (this.generation?.cleanup) await this.generation.cleanup;
    if (this.connection && !this.connection.signal.aborted) return this.initialized;
    if (this.generation) await this.stopGeneration(this.generation);
    if (this.stopping) throw Object.assign(new Error('ACP transport is stopping'), { code: 'STOPPING' });
    const child = spawn(this.config.command, this.config.args ?? [], { cwd: this.config.cwd, env: { ...process.env, ...this.config.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const generation = { child, stopping: false, cleanup: null, connection: null };
    this.generation = generation; this.child = child;
    generation.exit = new Promise(resolve => child.once('close', (code, signal) => { generation.exited = true; resolve({ code, signal }); }));
    this.exit = generation.exit;
    child.stderr.on('data', data => this.config.onStderr?.(data.toString()));
    child.stdin.on('error', () => {});
    const failed = new Promise((_, reject) => child.once('error', reject));
    try {
      const connection = client({ name: 'fish-ability-extensions', version: '0.1.0' })
        .onNotification(methods.client.session.update, async ctx => {
          if (this.generation === generation && !generation.stopping) return onUpdate(ctx.params);
        })
        .onRequest(methods.client.session.requestPermission, async ctx => {
          if (this.generation === generation && !generation.stopping) await onPermission(ctx.params);
          const deny = ctx.params.options?.find(option => option.kind === 'reject_once');
          return { outcome: deny ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' } };
        })
        .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
      this.connection = generation.connection = connection;
      generation.disconnect = error => {
        if (this.generation !== generation || generation.stopping || generation.notified) return;
        generation.notified = true;
        try { onDisconnect(error); } catch {}
      };
      connection.closed.then(() => {
        generation.disconnect(new Error('ACP connection closed'));
        // Keep ownership until the old child has actually exited, even if stdout closes first.
        return this.stopGeneration(generation);
      }).catch(() => {});
      this.initialized = await Promise.race([
        this.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }, this.config.startupTimeoutMs ?? 30000), failed,
      ]);
      return this.initialized;
    } catch (error) {
      try { await this.stopGeneration(generation); } catch (cleanupError) { error.cleanupError = cleanupError; }
      throw error;
    }
  }
  async request(method, params, timeoutMs = this.config.timeoutMs ?? 30000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new TypeError('timeoutMs must be a positive timer duration no greater than 2147483647');
    const generation = this.generation;
    if (!generation?.connection || generation.connection.signal.aborted) throw new Error('ACP transport not connected');
    let timer;
    let timedOut = false;
    try {
      return await Promise.race([generation.connection.agent.request(method, params), new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(Object.assign(new Error(`ACP request timed out: ${method}`), { code: 'TIMEOUT' })); }, timeoutMs);
      })]);
    } catch (error) {
      if (timedOut) {
        generation.disconnect(error);
        // Closing also rejects/removes SDK pending requests; racing alone would retain them.
        try { await this.stopGeneration(generation); } catch (cleanupError) { error.cleanupError = cleanupError; }
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
  async notify(method, params) {
    if (!this.connection || this.connection.signal.aborted) throw new Error('ACP transport not connected');
    return this.connection.agent.notify(method, params);
  }
  healthCheck() { return { healthy: !!this.connection && !this.connection.signal.aborted, pid: this.child?.pid ?? null }; }
  stopGeneration(generation) {
    if (generation.cleanup) return generation.cleanup;
    generation.stopping = true;
    const cleanup = this.cleanupGeneration(generation);
    generation.cleanup = cleanup;
    cleanup.catch(() => { if (generation.cleanup === cleanup) generation.cleanup = null; });
    return cleanup;
  }
  async cleanupGeneration(generation) {
    const { child } = generation;
    const grace = this.config.shutdownTimeoutMs ?? 3000;
    const force = this.config.killTimeoutMs ?? 3000;
    generation.connection?.close();
    child.stdin.end();
    if (!await settledWithin(generation.exit, grace)) {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(`${process.env.SystemRoot}\\System32\\taskkill.exe`, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        const killed = new Promise(resolve => { killer.once('error', resolve); killer.once('close', resolve); });
        if (!await settledWithin(killed, force)) killer.kill();
      }
      if (!generation.exited) { try { child.kill('SIGKILL'); } catch {} }
      if (!await settledWithin(generation.exit, force)) {
        // Preserve generation/child ownership so a later stop can retry; never spawn over it.
        throw Object.assign(new Error('ACP child did not exit within shutdown deadline'), { code: 'SHUTDOWN_TIMEOUT' });
      }
    }
    if (this.generation === generation) {
      this.generation = null; this.child = null; this.connection = null; this.initialized = undefined;
    }
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const starting = this.starting;
    const operation = (async () => {
      // Stop the current generation first to interrupt a pending handshake. A start
      // waiting on old cleanup observes stopping before it can spawn a replacement.
      if (this.generation) await this.stopGeneration(this.generation);
      if (starting) { try { await starting; } catch {} }
      if (this.generation) await this.stopGeneration(this.generation);
    })();
    this.stopPromise = operation;
    operation.finally(() => { if (this.stopPromise === operation) this.stopPromise = null; }).catch(() => {});
    return operation;
  }
}
