import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForPublicReady } from './live/wallet-input.ts';

for (const stalled of ['read', 'pause']) test(`public readiness bounds a stalled ${stalled}`, async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const began = performance.now();
  const work = waitForPublicReady(
    async () => stalled === 'read' ? pending : ({ stage: 'state-observed', ready: false }),
    25, 'PUBLIC_WAIT_TIMEOUT', () => pending,
  );
  const observed = await Promise.race([
    work.then(() => 'unexpected-pass', e => e.message),
    new Promise(resolve => setTimeout(() => resolve('escaped-bound'), 150)),
  ]);
  release({ stage: 'state-observed', ready: false });
  await work.catch(() => {});
  assert.equal(observed, 'PUBLIC_WAIT_TIMEOUT');
  assert.ok(performance.now() - began < 500);
});

test('an expired read cannot resume polling or turn late readiness into success', async () => {
  let release, reads = 0, pauses = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const work = waitForPublicReady(async () => { reads++; return pending; }, 25, 'PUBLIC_WAIT_TIMEOUT', async () => { pauses++; });
  await assert.rejects(work, { message: 'PUBLIC_WAIT_TIMEOUT' });
  release({ stage: 'state-observed', ready: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.equal(pauses, 0);
});
