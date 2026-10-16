import test from 'node:test';
import assert from 'node:assert/strict';
import { liveProver, preflightLocalProver } from './live/prover-config.ts';

test('live prover selection preserves Temenos default and rejects every unlisted selection', () => {
  assert.equal(liveProver(undefined), 'temenos');
  for (const value of ['local', 'temenos']) assert.equal(liveProver(value), value);
  for (const value of ['', 'http://127.0.0.1:6300', 'LOCAL', 'remote']) assert.throws(() => liveProver(value), /no fallback/);
});

test('local preflight sends only fixed version GET and accepts the pinned version', async () => {
  for (const body of ['8.1.3\n', '"8.1.3"', '{"version":"8.1.3"}']) {
    let count = 0, signal;
    await preflightLocalProver(async (url, options) => {
      count++; signal = options.signal;
      assert.equal(url, 'http://127.0.0.1:6300/version');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.body, undefined);
      return new Response(body);
    });
    assert.equal(count, 1); assert.equal(signal.aborted, true);
  }
});

for (const [name, response] of [
  ['wrong version', () => new Response('8.1.2')],
  ['unrecognized body', () => new Response('private synthetic error')],
  ['oversized body', () => new Response('x'.repeat(257))],
  ['HTTP failure', () => new Response('private synthetic error', { status: 503 })],
  ['redirect refusal', () => { throw new Error('private synthetic error'); }],
]) test(`local preflight fails closed for ${name}`, async () => {
  let count = 0;
  await assert.rejects(preflightLocalProver(async () => { count++; return response(); }), {
    message: 'Local proof-server 8.1.3 version preflight failed; no wallet restore or fallback.',
  });
  assert.equal(count, 1);
});

for (const stalled of ['request', 'body']) test(`local version preflight bounds a stalled ${stalled}`, async () => {
  let signal, count = 0;
  const began = performance.now();
  await assert.rejects(preflightLocalProver(async (_, options) => {
    count++; signal = options.signal;
    if (stalled === 'request') return new Promise(() => {});
    return new Response(new ReadableStream({ start() {} }));
  }), { message: 'Local proof-server 8.1.3 version preflight failed; no wallet restore or fallback.' });
  assert.ok(performance.now() - began < 6_500);
  assert.equal(signal.aborted, true); assert.equal(count, 1);
});
