import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { waitForPublicReady } from './live/wallet-input.ts';
import { readPublicSync } from './live/public-sync.ts';

test('advancing sync can outlast the initial deadline without implying readiness', async t => {
  let now = 0, reads = 0, extensions = 0;
  t.mock.method(Date, 'now', () => now);
  await waitForPublicReady(async () => ({ stage: 'state-observed', ready: ++reads === 6,
    progress: { fraction: Math.min(1, reads / 5) } }), 100, 'INACTIVE',
  async () => { now += 60; }, () => { extensions++; });
  assert.equal(now, 300);
  assert.equal(reads, 6); // Reaching ratio 1 on read 5 was not readiness.
  assert.equal(extensions, 5);
});

for (const values of [[0.8, 0.8, 0.8], [0.8, 0.1, 0.2], [0.8, NaN, Infinity]]) {
  test(`stale, restarted or invalid progress cannot extend the inactivity deadline: ${values}`, async t => {
    let now = 0, reads = 0, extensions = 0;
    t.mock.method(Date, 'now', () => now);
    await assert.rejects(waitForPublicReady(async () => ({ stage: 'state-observed', ready: false,
      progress: { fraction: values[reads++] } }), 100, 'INACTIVE',
    async () => { now += 60; }, () => { extensions++; }), { message: 'INACTIVE' });
    assert.equal(extensions, 1);
    assert.equal(reads, 2);
  });
}

test('strict completion bits extend once and terminal failure wins over progress and readiness', async t => {
  let now = 0, reads = 0;
  t.mock.method(Date, 'now', () => now);
  const masks = [1, 3, 7, 7];
  await waitForPublicReady(async () => ({ stage: 'state-observed', ready: reads === 3,
    progress: { completed: masks[reads++] } }), 100, 'INACTIVE', async () => { now += 60; }, () => {});
  assert.equal(now, 180);
  await assert.rejects(waitForPublicReady(async () => ({ stage: 'sync-failed', ready: true,
    progress: { fraction: 1, completed: 7 } }), 100, 'INACTIVE'), /synchronization failed/);
});

test('callers without a progress callback keep a fixed deadline across advancing stages', async t => {
  let now = 0, reads = 0;
  t.mock.method(Date, 'now', () => now);
  const stages = ['restore-started', 'waiting-for-engine', 'state-observed'];
  await assert.rejects(waitForPublicReady(async () => ({ stage: stages[reads++], ready: false }),
    100, 'INACTIVE', async () => { now += 60; }), { message: 'INACTIVE' });
  assert.equal(reads, 2);
  assert.equal(now, 120);
});

test('sync projection exposes only fixed stages, finite ratios and strict completion bits', () => {
  const secret = 'synthetic private sentinel';
  const input = { initialization: { stage: 'state-observed', error: secret },
    sync: { pendingSync: { startedAt: secret, operations: { [secret]: { progress: 0.4, startedAt: secret } } } },
    readiness: { strictlySynced: { unshielded: true, shielded: false, dust: true }, extra: secret } };
  const expected = { stage: 'state-observed', progress: { fraction: 0.4, completed: 5 } };
  assert.deepEqual(readPublicSync(input), expected);
  const document = { getElementById: id => ({ textContent: JSON.stringify(input[id]) }) };
  const actual = runInNewContext(`(${readPublicSync.toString()})()`, { document });
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
  assert.ok(!JSON.stringify(actual).includes(secret));
  assert.deepEqual(readPublicSync({ initialization: { stage: secret }, sync: null, readiness: null }),
    { stage: 'not-observed', progress: { completed: 0 } });
});
