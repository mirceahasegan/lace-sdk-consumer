import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationGate, SubmissionTracker, submitTracked, parseOutputs, parseHex } from '../src/midnight/operations.ts';
import { validateConfig, BASELINE_FLAGS } from '../src/midnight/config.ts';
import { parseTestWallet, canSpend } from './live/wallet-input.ts';
const context = { accountId: 'account-7', network: 'preview', prover: 'attested Temenos' };
test('an invalidated review cannot be confirmed and invokes zero SDK effects', async () => {
  const gate = new OperationGate(); let calls = 0;
  const review = gate.prepare('sign transfer', context, { amount: '1' }, async () => { calls++; });
  assert.equal(gate.invalidate(), true);
  await assert.rejects(gate.confirm(review), /confirmation/);
  assert.equal(calls, 0);
});
test('a current review invokes exactly once', async () => {
  const gate = new OperationGate(); let calls = 0;
  const review = gate.prepare('sign transfer', context, { amount: 1n }, async () => ++calls);
  assert.equal(await gate.confirm(review), 1);
  await assert.rejects(gate.confirm(review));
  assert.equal(calls, 1);
});
test('review binds immutable context and input summary; replaced review cannot authorize', async () => {
  const gate = new OperationGate(); const mutable = { ...context }; const inputs = { amount: '1' };
  let calls = 0;
  const old = gate.prepare('sign', mutable, inputs, async () => calls++);
  mutable.accountId = 'different'; inputs.amount = '999';
  assert.equal(old.context.accountId, context.accountId);
  assert.match(old.inputs, /"1"/);
  gate.prepare('sign', context, { amount: '2' }, async () => calls++);
  await assert.rejects(gate.confirm(old)); assert.equal(calls, 0);
});
test('cancel while awaiting provider prevents later sensitive entry and discards late result', async () => {
  const gate = new OperationGate(); let release; let calls = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const review = gate.prepare('circuit', context, {}, async assertCurrent => { await wait; assertCurrent(); calls++; });
  const pending = gate.confirm(review);
  assert.throws(() => gate.prepare('second', context, {}, async () => {}), /settle/);
  gate.invalidate(); release(); await assert.rejects(pending, /cancelled/); assert.equal(calls, 0);
});
test('late signing completion cannot be adopted for submission after input change', async () => {
  const gate = new OperationGate(); let release;
  const review = gate.prepare('sign', context, {}, () => new Promise(resolve => { release = resolve; }));
  const result = gate.confirm(review); gate.invalidate(); release('signed');
  await assert.rejects(result, /cancelled/);
});
test('failure consumes consent, requires a new review', async () => {
  const gate = new OperationGate();
  const review = gate.prepare('submit', context, {}, async () => { throw new Error('timeout: uncertain'); });
  await assert.rejects(gate.confirm(review), /uncertain/); await assert.rejects(gate.confirm(review), /confirmation/);
});
// Submission completion. The SDK call can outlive its own timeout or fail after broadcast;
// history keyed by the proved transaction's hash is the authority for confirmation.
const HASH = '02139e2c375c7089aa5c60a90193a1578f25c64d8edd85edbb7cdd271b2adace';
// A proved transaction is an opaque value; its activityHash field is the hash history lists.
const proved = { transaction: new Uint8Array(), activityHash: HASH };
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const timeoutError = () => Object.assign(new Error('Timeout has occurred'), { name: 'TimeoutError' });
function irrevocableSubmission(tracker, submit) {
  const gate = new OperationGate();
  const review = gate.prepare('submit', context, {}, () => submitTracked(tracker, context.accountId, proved, submit), { irrevocable: true });
  return { gate, settled: gate.confirm(review) };
}
test('submission-completion: submission delayed past its timeout: history with the hash shows confirmed with the identifier', async () => {
  const records = []; const tracker = new SubmissionTracker(record => records.push(record));
  const sdk = deferred();
  const { gate, settled } = irrevocableSubmission(tracker, () => sdk.promise);
  assert.equal(tracker.state.stage, 'submitting');
  assert.equal(tracker.state.activityHash, HASH);
  assert.match(tracker.state.summary, /may broadcast from now on\), hash 02139e2c/);
  tracker.observeHistory('another-account', [{ activityId: HASH, type: 'Self' }]);
  assert.equal(tracker.state.stage, 'submitting', 'another account\'s history cannot confirm');
  tracker.observeHistory(context.accountId, [{ activityId: HASH, type: 'Pending' }]);
  assert.equal(tracker.state.stage, 'submitting', 'a pending row is not confirmation');
  tracker.observeHistory(context.accountId, [{ activityId: 'other', type: 'Send' }, { activityId: HASH, type: 'Self' }]);
  assert.equal(tracker.state.stage, 'confirmed');
  assert.equal(tracker.state.sdk, 'pending');
  assert.match(tracker.state.summary, new RegExp(`Confirmed: history lists transaction ${HASH} as Self`));
  assert.equal(gate.irrevocable, true, 'the SDK call is still in flight');
  sdk.reject(timeoutError());
  const final = await settled;
  assert.equal(final.stage, 'confirmed', 'a late timeout cannot downgrade a confirmed transaction');
  assert.equal(final.sdk, 'error');
  assert.equal(gate.irrevocable, false);
  assert.ok(records.every(record => !/discard/i.test(record.summary)));
});
test('submission-completion: submission confirmed in history before the SDK returns keeps the later txId', async () => {
  const tracker = new SubmissionTracker(); const sdk = deferred();
  const { settled } = irrevocableSubmission(tracker, () => sdk.promise);
  tracker.observeHistory(context.accountId, [{ activityId: HASH, type: 'Self' }]);
  sdk.resolve({ txId: 'node-tx-1' });
  const final = await settled;
  assert.deepEqual([final.stage, final.txId, final.sdk], ['confirmed', 'node-tx-1', 'returned']);
  assert.match(final.summary, /txId node-tx-1/);
});
test('submission-completion: submission returning Ok reports the identifier, then history confirms it', async () => {
  const tracker = new SubmissionTracker();
  const { settled } = irrevocableSubmission(tracker, async () => ({ txId: 'node-tx-2' }));
  const returned = await settled;
  assert.deepEqual([returned.stage, returned.txId, returned.activityHash], ['submitted', 'node-tx-2', HASH]);
  tracker.observeHistory(context.accountId, [{ activityId: HASH, type: 'Self' }]);
  assert.equal(tracker.state.stage, 'confirmed');
});
test('submission-completion: submission rejected after broadcast shows uncertain with the hash, never discarded', async () => {
  for (const error of [timeoutError(), new Error('1010: Invalid Transaction'), 'non-error rejection']) {
    const tracker = new SubmissionTracker();
    const { settled } = irrevocableSubmission(tracker, async () => { throw error; });
    const final = await settled;
    assert.equal(final.stage, 'uncertain');
    assert.equal(final.activityHash, HASH);
    assert.match(final.summary, new RegExp(`check history/chain for hash ${HASH}`));
    assert.doesNotMatch(final.summary, /discard|failed/i);
    tracker.observeHistory(context.accountId, [{ activityId: HASH, type: 'Self' }]);
    assert.equal(tracker.state.stage, 'confirmed', 'history still resolves an uncertain submission');
  }
});
test('submission-completion: history reporting the submitted hash as Failed is not shown as confirmed', async () => {
  const tracker = new SubmissionTracker();
  const { settled } = irrevocableSubmission(tracker, async () => { throw timeoutError(); });
  await settled;
  tracker.observeHistory(context.accountId, [{ activityId: HASH, type: 'Failed' }]);
  assert.equal(tracker.state.stage, 'failed-on-chain');
});
test('submission-completion: cancel during an in-flight submission is refused and the result is still reported', async () => {
  const tracker = new SubmissionTracker(); const sdk = deferred();
  const { gate, settled } = irrevocableSubmission(tracker, () => sdk.promise);
  const version = gate.version;
  assert.equal(gate.irrevocable, true);
  assert.equal(gate.invalidate(), false);
  assert.equal(gate.version, version, 'refused invalidation changes nothing');
  assert.throws(() => gate.prepare('second', context, {}, async () => {}), /settle/);
  sdk.resolve({ txId: 'node-tx-3' });
  const final = await settled;
  assert.equal(final.stage, 'submitted');
  assert.equal(gate.invalidate(), true, 'cancellation works again once settled');
});
test('submission-completion: pre-broadcast failures still show failed', async () => {
  for (const code of ['midnight-account-not-found', 'midnight-network-not-configured', 'midnight-wallet-not-ready', 'midnight-stale-tx']) {
    const tracker = new SubmissionTracker();
    const { settled } = irrevocableSubmission(tracker, async () => { throw Object.assign(new Error('engine unavailable'), { code }); });
    const final = await settled;
    assert.equal(final.stage, 'failed', code);
    assert.match(final.summary, /failed before broadcast: engine unavailable/);
  }
  const tracker = new SubmissionTracker(); let calls = 0;
  const final = await submitTracked(tracker, context.accountId, { transaction: new Uint8Array() } /* a recipe: no activityHash */, async () => { calls++; return { txId: 'x' }; });
  assert.equal(final.stage, 'failed');
  assert.equal(final.activityHash, undefined);
  assert.equal(calls, 0, 'nothing is submitted without an activity hash');
});
test('submission-completion: history overrides a failure classified as pre-broadcast; an untyped row reads plainly', async () => {
  const tracker = new SubmissionTracker();
  const { settled } = irrevocableSubmission(tracker, async () => { throw Object.assign(new Error('engine unavailable'), { code: 'midnight-wallet-not-ready' }); });
  assert.equal((await settled).stage, 'failed');
  assert.deepEqual(tracker.watchedAccounts, [context.accountId], 'a failure with a hash stays watched');
  tracker.observeHistory(context.accountId, [{ activityId: HASH, type: 'Self' }]);
  assert.equal(tracker.state.stage, 'confirmed');
  assert.doesNotMatch(tracker.state.summary, /Nothing was sent/);
  const untyped = new SubmissionTracker();
  untyped.begin(context.accountId, HASH);
  untyped.observeHistory(context.accountId, [{ activityId: HASH }]);
  assert.equal(untyped.state.stage, 'confirmed');
  assert.equal(untyped.state.historyType, undefined);
  assert.equal(untyped.state.summary, `Confirmed: history lists transaction ${HASH}.`);
  untyped.settle(HASH, { txId: 'node-tx-4' });
  assert.equal(untyped.state.summary, `Confirmed: history lists transaction ${HASH} (txId node-tx-4).`);
  const noHash = new SubmissionTracker();
  await submitTracked(noHash, context.accountId, { transaction: new Uint8Array() }, async () => ({ txId: 'x' }));
  noHash.observeHistory(context.accountId, [{ activityId: undefined, type: 'Self' }]);
  assert.equal(noHash.state.stage, 'failed', 'a failure without a hash has nothing to match');
});
test('submission-completion: only the newest or in-flight record is announced; background resolutions are listed silently', async () => {
  const events = []; const tracker = new SubmissionTracker((changed, all, announce) => events.push({ hash: changed.activityHash, stage: changed.stage, announce, listed: all.map(r => r.activityHash) }));
  const H2 = 'c'.repeat(64);
  await submitTracked(tracker, 'account-7', proved, async () => { throw timeoutError(); });
  assert.ok(events.every(event => event.announce), 'the in-flight and newest record is announced');
  await submitTracked(tracker, 'account-7', { transaction: new Uint8Array(), activityHash: H2 }, async () => ({ txId: 'node-tx-5' }));
  events.length = 0;
  tracker.observeHistory('account-7', [{ activityId: HASH, type: 'Self' }]);
  assert.deepEqual(events, [{ hash: HASH, stage: 'confirmed', announce: false, listed: [H2, HASH] }]);
  tracker.observeHistory('account-7', [{ activityId: HASH, type: 'Self' }, { activityId: H2, type: 'Self' }]);
  assert.deepEqual(events.at(-1), { hash: H2, stage: 'confirmed', announce: true, listed: [H2, HASH] });
});
test('submission-completion: a late result settles its own submission, never the newest one', () => {
  const tracker = new SubmissionTracker();
  tracker.begin(context.accountId, 'first'); tracker.begin(context.accountId, 'second');
  tracker.settle('first', { txId: 'late' });
  assert.deepEqual([tracker.state.activityHash, tracker.state.stage, tracker.state.txId], ['second', 'submitting', undefined]);
  assert.deepEqual([tracker.find('first').stage, tracker.find('first').txId], ['submitted', 'late']);
});
test('submission-completion: uncertain H1, then H2: H1 stays listed and a later history row still resolves it', async () => {
  const changes = []; const tracker = new SubmissionTracker((changed, all) => changes.push({ changed, all }));
  const H1 = HASH, H2 = 'b'.repeat(64);
  await submitTracked(tracker, context.accountId, proved, async () => { throw timeoutError(); });
  assert.equal(tracker.find(H1).stage, 'uncertain');
  assert.deepEqual(tracker.unresolved.map(r => r.activityHash), [H1]);
  await submitTracked(tracker, context.accountId, { transaction: new Uint8Array(), activityHash: H2 }, async () => ({ txId: 'node-tx-h2' }));
  assert.deepEqual(tracker.records.map(r => [r.activityHash, r.stage]), [[H2, 'submitted'], [H1, 'uncertain']]);
  assert.deepEqual(changes.at(-1).all.map(r => r.activityHash), [H2, H1], 'the rendered list keeps H1');
  tracker.observeHistory(context.accountId, [{ activityId: H1, type: 'Failed' }]);
  assert.equal(tracker.find(H1).stage, 'failed-on-chain');
  assert.equal(changes.at(-1).changed.activityHash, H1, 'the resolution of H1 is reported');
  assert.equal(tracker.find(H2).stage, 'submitted', 'H1 history cannot resolve H2');
  tracker.observeHistory(context.accountId, [{ activityId: H1, type: 'Failed' }, { activityId: H2, type: 'Self' }]);
  assert.deepEqual(tracker.records.map(r => r.stage), ['confirmed', 'failed-on-chain']);
  assert.deepEqual(tracker.unresolved, []);
});
test('submission-completion: unresolved accounts stay watched after the selection moves to another account', async () => {
  const tracker = new SubmissionTracker();
  await submitTracked(tracker, 'account-7', proved, async () => { throw timeoutError(); });
  assert.deepEqual(tracker.watchedAccounts, ['account-7']);
  tracker.observeHistory('account-0', [{ activityId: HASH, type: 'Self' }]);
  assert.equal(tracker.state.stage, 'uncertain', 'another account cannot resolve it');
  tracker.observeHistory('account-7', [{ activityId: HASH, type: 'Self' }]);
  assert.equal(tracker.state.stage, 'confirmed');
  assert.deepEqual(tracker.watchedAccounts, []);
});
test('configuration is explicit and rejects incomplete or unsafe endpoints', () => {
  const config = { network: 'preview', index: 7, nodeAddress: '', indexerAddress: '', prover: 'local' };
  assert.equal(validateConfig(config).network, 'preview');
  for (const index of [-1, 2 ** 31, 1.2]) assert.throws(() => validateConfig({ ...config, index }));
  assert.throws(() => validateConfig({ ...config, network: 'devnet' }), /both/);
  assert.throws(() => validateConfig({ ...config, nodeAddress: 'https://node' }), /both/);
  for (const nodeAddress of ['http://remote', 'https://user:secret@host', 'javascript:alert(1)']) assert.throws(() => validateConfig({ ...config, nodeAddress, indexerAddress: 'https://indexer' }));
  assert.throws(() => validateConfig({ ...config, network: 'preprod', prover: 'temenos' }), /Preview/);
  assert.ok(BASELINE_FLAGS.includes('BLOCKCHAIN_MIDNIGHT_UNSHIELDED'));
  assert.ok(BASELINE_FLAGS.includes('BLOCKCHAIN_MIDNIGHT_TEE_TEMENOS_PROOF_SERVER'));
  assert.ok(!BASELINE_FLAGS.includes('FEATURES_POSTHOG'));
});
test('batch input preserves every recipient, token and integer without floating point conversion', () => {
  const rows = [{ to: 'a', tokenId: 't', amount: '9007199254740993' }, { to: 'b', tokenId: 'u', amount: '2' }];
  assert.deepEqual(parseOutputs(JSON.stringify(rows)).map(x => x.amount), [9007199254740993n, 2n]);
  for (const amount of ['0', '-1', '1.5', 1]) assert.throws(() => parseOutputs(JSON.stringify([{ ...rows[0], amount }])));
  assert.throws(() => parseOutputs('[]'));
  assert.throws(() => parseHex('abc')); assert.deepEqual(parseHex('00ff'), new Uint8Array([0, 255]));
});

test('live input accepts opaque passwordHex and password alternative, defaults to account zero and requires Preview/address', () => {
  // Deliberately invalid synthetic words; no fixture contains a usable seed.
  const input = { network: 'preview', address: 'mn_addr_preview_synthetic', mnemonicWords: Array(12).fill('synthetic'), passwordHex: String(123456) };
  const parsed = parseTestWallet(input);
  assert.equal(parsed.password, input.passwordHex);
  assert.equal(parsed.accountIndex, 0);
  assert.equal(parseTestWallet({ ...input, passwordHex: undefined, password: String(654321) }).password, String(654321));
  for (const change of [{ network: 'mainnet' }, { address: undefined }, { passwordHex: '' }, { accountIndex: -1 }, { accountIndex: 2 ** 31 }]) assert.throws(() => parseTestWallet({ ...input, ...change }));
  assert.throws(() => parseTestWallet(null));
});

test('live spend gate requires the expected address, strictly synced NIGHT, and matured DUST for transfers', () => {
  const address = 'mn_addr_preview_synthetic';
  const state = { address: { unshielded: address }, night: { available: '1' }, dust: { available: '0' }, synced: { unshielded: true, dust: true } };
  assert.equal(canSpend(state, address, false), true);
  assert.equal(canSpend(state, address, true), false);
  assert.equal(canSpend({ ...state, dust: { available: '1' } }, address, true), true);
  assert.equal(canSpend({ ...state, night: { available: '0' } }, address, false), false);
  assert.equal(canSpend({ ...state, synced: { unshielded: false, dust: true } }, address, false), false);
  assert.equal(canSpend(state, 'another-account', false), false);
  assert.equal(canSpend({}, address, false), false);
});
