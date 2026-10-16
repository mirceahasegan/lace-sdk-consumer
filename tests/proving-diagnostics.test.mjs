import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { observeProvingRelay, readPublicProvingState, waitForProving } from './live/proving-diagnostics.ts';
import { TEMENOS_RELAY_PATH, TEMENOS_ROUTES } from '../src/midnight/temenos-transport.ts';

const secret = 'SYNTHETIC_SECRET_mnemonic_password_sessionKey_plaintext_ciphertext';
const state = (phase = 'proving', status = 'failed', submitEnabled = false) => readPublicProvingState({
  status: `Operation failed: Wallet.Proving ClientError Failed to prove transaction ${secret}`,
  progress: JSON.stringify({ type: 'phase', phase, status, detail: secret }), submitEnabled,
});

test('terminal phases fail immediately before submission, including stale enabled state', async () => {
  for (const phase of ['obtain-evidence', 'fetch-expected-values', 'verify-locally', 'warden-verify', 'bind-channel', 'proving']) {
    let reads = 0, pauses = 0, submitted = false;
    await assert.rejects(async () => {
      await waitForProving(async () => { reads++; return state(phase, 'failed', true); }, 600_000, async () => { pauses++; });
      submitted = true;
    }, { message: 'Proving stopped at a failed public phase; no submission attempted.' });
    assert.deepEqual({ reads, pauses, submitted }, { reads: 1, pauses: 0, submitted: false });
  }
});

test('successful proving still waits for submit readiness; no automatic retry on timeout or read error', async () => {
  const sequence = [state('proving', 'started'), state('proving', 'completed'), state('proving', 'completed', true)];
  let pauses = 0;
  await waitForProving(async () => sequence.shift(), 1000, async () => { pauses++; });
  assert.equal(pauses, 2);
  await assert.rejects(waitForProving(async () => state('proving', 'started'), 0), { message: 'Proving readiness timed out; outcome uncertain, no submission attempted.' });
  await assert.rejects(waitForProving(async () => { throw new Error(secret); }, 600_000), { message: 'Public proving state unavailable; no submission attempted.' });
});

test('readiness arriving at or after the deadline never reaches Submit', async t => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  for (const elapsed of [1, 20]) {
    now = 10_000;
    let resolveRead, reads = 0, pauses = 0, submitted = false;
    const attempt = (async () => {
      await waitForProving(() => {
        reads++;
        return new Promise(resolve => { resolveRead = resolve; });
      }, 1, async () => { pauses++; });
      submitted = true;
    })();
    now += elapsed;
    resolveRead(state('proving', 'completed', true));
    await assert.rejects(attempt, { message: 'Proving readiness timed out; outcome uncertain, no submission attempted.' });
    assert.deepEqual({ reads, pauses, submitted }, { reads: 1, pauses: 0, submitted: false });
  }
  now = 10_000;
  await assert.rejects(waitForProving(async () => {
    now += 20;
    return state('proving', 'failed', true);
  }, 1), { message: 'Proving stopped at a failed public phase; no submission attempted.' });
});

test('secret-bearing status and nested error text project to exact fixed categories only', () => {
  const result = readPublicProvingState({
    status: `Wallet.Proving ClientError Failed to prove transaction ${secret}\n at https://${secret}.invalid/file?token=${secret}`,
    progress: JSON.stringify({ type: 'phase', phase: 'proving', status: 'failed', detail: `AttestationVerificationError ChannelBindingError returned HTTP 413 (${secret})\nproxy response failed authentication: ${secret}\nTimeoutError`, cause: { stack: secret, password: secret } }),
    submitEnabled: false,
  });
  assert.deepEqual(result, { phase: 'proving', phaseStatus: 'failed', categories: ['wallet-proving', 'client-error', 'generic-proving-failure', 'attestation-error', 'channel-binding-error', 'record-authentication-failure', 'timeout'], httpStatuses: [413], submitEnabled: false });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(state().categories, ['wallet-proving', 'client-error', 'generic-proving-failure']);
});

test('unknown, malformed, hostile and oversized category lists cannot copy input into output', () => {
  for (const progress of [secret, 'null', '[]', JSON.stringify({ type: 'phase', phase: secret, status: secret, detail: secret })]) {
    assert.deepEqual(readPublicProvingState({ status: secret, progress, submitEnabled: false }), { phase: 'not-observed', phaseStatus: 'not-observed', categories: [], httpStatuses: [], submitEnabled: false });
  }
  const hostile = { get status() { throw new Error(secret); } };
  assert.deepEqual(readPublicProvingState(hostile), { phase: 'not-observed', phaseStatus: 'not-observed', categories: [], httpStatuses: [], submitEnabled: false });
  const result = readPublicProvingState({ status: `${secret} HTTP 999 HTTP 413 ${Array.from({ length: 20 }, (_, i) => `returned HTTP ${400 + i}`).join(' ')}`, progress: '{}', submitEnabled: false });
  assert.deepEqual(result.httpStatuses, [400, 401, 402, 403, 404, 405, 406, 407]);
});

test('browser projection is self-contained and never returns raw DOM or detail', () => {
  const elements = {
    status: { textContent: `Failed to prove transaction ${secret}` },
    progress: { textContent: JSON.stringify({ type: 'phase', phase: 'proving', status: 'failed', detail: secret }) },
    submit: { disabled: true },
  };
  const result = runInNewContext(`(${readPublicProvingState.toString()})()`, { document: { getElementById: id => elements[id] } });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { phase: 'proving', phaseStatus: 'failed', categories: ['generic-proving-failure'], httpStatuses: [], submitEnabled: false });
});

const origin = 'http://localhost:5198';
function fixture() {
  const page = new EventEmitter(); page.url = () => `${origin}/midnight`;
  return { page, observer: observeProvingRelay(page) };
}
function request(path = '/tee_attestation/proxy', overrides = {}) {
  return {
    url: () => `${origin}${TEMENOS_RELAY_PATH}${path}`, method: () => 'POST',
    timing: () => ({ startTime: secret, responseStart: 30_001.25, responseEnd: 30_002.5, other: secret }),
    sizes: async () => ({ requestBodySize: 16_777_217, responseBodySize: 38, requestHeadersSize: secret, responseHeadersSize: secret, body: secret }),
    headers() { throw new Error(secret); }, postData() { throw new Error(secret); }, failure() { throw new Error(secret); },
    ...overrides,
  };
}
function respond(page, req, status = 413, origin = null) {
  page.emit('response', { request: () => req, status: () => status,
    headerValue: async name => { assert.equal(name, 'x-lace-temenos-error-origin'); return origin; },
    body() { throw new Error(secret); }, headers() { throw new Error(secret); } });
}

test('proxy 400 origin uses only fixed relay/upstream values and never records other headers', async () => {
  const { page, observer } = fixture();
  for (const origin of ['relay', 'upstream', secret]) respond(page, request(), 400, origin);
  const result = await observer.stop();
  assert.deepEqual(result.responses.map(row => row.http400Origin), ['relay', 'upstream', null]);
  assert.deepEqual(result.responses.map(row => row.errorOrigin), ['relay', 'upstream', null]);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('relay responses preserve exact allowed route, status, timing and body counts only', async () => {
  const { page, observer } = fixture();
  const req = request(); respond(page, req); page.emit('requestfinished', req);
  const result = await observer.stop();
  assert.deepEqual(result, { responses: [{ route: '/temenos-relay/tee_attestation/proxy', status: 413, outcome: 'finished', responseStartMs: 30_001.25, responseEndMs: 30_002.5, requestBodyBytes: 16_777_217, responseBodyBytes: 38, errorOrigin: null }], truncated: false, metadataUnavailable: false });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(page.eventNames().length, 0);
});

test('every installed relay route is accepted only with exact origin, method and URL', async () => {
  const { page, observer } = fixture();
  for (const route of TEMENOS_ROUTES) {
    const url = `${origin}${TEMENOS_RELAY_PATH}${route.path}`;
    respond(page, request(route.path, { method: () => route.method }), 200);
    for (const bad of [`${url}?secret=${secret}`, `${url}#${secret}`, `${url}/${secret}`, url.replace('localhost', `${secret}.invalid`), url.replace('localhost', `${secret}@localhost`), url.replace('/temenos-relay/', '/temenos-relay/../temenos-relay/')]) {
      const req = request(route.path, { url: () => bad, method: () => route.method });
      respond(page, req); page.emit('requestfinished', req); page.emit('requestfailed', req);
    }
    respond(page, request(route.path, { method: () => route.method === 'POST' ? 'GET' : 'POST' }));
  }
  const result = await observer.stop();
  assert.deepEqual(result.responses.map(row => row.route), TEMENOS_ROUTES.map(route => `${TEMENOS_RELAY_PATH}${route.path}`));
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('transport failures and unavailable metrics remain fixed, with no inferred HTTP or cause', async () => {
  const { page, observer } = fixture();
  page.emit('requestfailed', request('/tee_attestation/proxy', { timing: () => ({ responseStart: -1, responseEnd: NaN }) }));
  const req = request('/tee_attestation/proxy', { sizes: async () => { throw new Error(secret); } });
  respond(page, req, 504); page.emit('requestfinished', req);
  respond(page, request('/tee_attestation/proxy', { timing: () => ({ responseStart: secret, responseEnd: Infinity }) }), secret);
  const result = await observer.stop();
  assert.equal(result.metadataUnavailable, true);
  assert.deepEqual(result.responses[0], { route: '/temenos-relay/tee_attestation/proxy', status: null, outcome: 'failed', responseStartMs: null, responseEndMs: null, requestBodyBytes: null, responseBodyBytes: null });
  assert.equal(result.responses[1].status, 504);
  assert.equal(result.responses[1].requestBodyBytes, null);
  assert.equal(result.responses[2].status, null);
  assert.equal(result.responses[2].responseEndMs, null);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('capture is bounded and stop detaches listeners', async () => {
  const { page, observer } = fixture();
  for (let i = 0; i < 70; i++) respond(page, request());
  const result = await observer.stop();
  assert.equal(result.responses.length, 64);
  assert.equal(result.truncated, true);
  respond(page, request(), 500);
  assert.deepEqual(await observer.stop(), result);
});
