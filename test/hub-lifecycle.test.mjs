import test from 'node:test';
import assert from 'node:assert/strict';
import {createStopController} from '../apps/companion-hub/lifecycle.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; };

test('hub lifecycle shares concurrent stop and retries after a rejected cleanup', async () => {
  let calls = 0, stopped = 0;
  const first = deferred();
  const controller = createStopController({
    onStop: () => { stopped++; },
    cleanup: async () => {
      calls++;
      if (calls === 1) return first.promise;
      return {ok: true};
    },
  });
  const a = controller.stop();
  const b = controller.stop();
  assert.equal(a, b);
  assert.equal(controller.stopping, true);
  assert.equal(stopped, 1);
  first.reject(Object.assign(new Error('shutdown timeout'), {code: 'SHUTDOWN_TIMEOUT'}));
  await assert.rejects(a, {code: 'SHUTDOWN_TIMEOUT'});
  const retry = controller.stop();
  assert.notEqual(retry, a);
  assert.deepEqual(await retry, {ok: true});
  assert.equal(calls, 2);
  assert.equal(controller.stopping, true);
  assert.equal(controller.stop(), retry);
});

test('hub lifecycle does not repeat a successful cleanup', async () => {
  let calls = 0;
  const controller = createStopController({cleanup: async () => { calls++; return {ok: true}; }});
  const first = controller.stop();
  assert.deepEqual(await first, {ok: true});
  assert.equal(controller.stop(), first);
  assert.equal(calls, 1);
});
