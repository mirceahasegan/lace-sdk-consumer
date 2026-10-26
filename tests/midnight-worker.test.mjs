import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@laceio/sdk/midnight';
import { INTERRUPTED_ERROR_CODE, PRE_BROADCAST_ERROR_CODES, SubmissionTracker, WORKER_ERROR_HINTS, observeSubmitBoundary, sdkErrorLabel, submitTracked } from '../src/midnight/operations.ts';
import { ConfigError, engineDisclosure, validateConfig, workerOption } from '../src/midnight/config.ts';
import { LOCAL_CHAIN_ENDPOINTS, liveEndpoints, liveNetwork, parseTestWallet } from './live/wallet-input.ts';

// Worker mode in the reference consumer: how the page classifies the SDK's Worker-mode errors, and the
// settings it passes to createMidnightModule. The errors are the installed SDK's own classes.

const HASH = 'c95a9921e6502c8a9f5890cae4bba78cb76a335e9cebdfd3398c682c32b7ef19';
const ACCOUNT = 'account-0';
const proved = { transaction: new Uint8Array(), activityHash: HASH };
const local = { network: 'undeployed', index: 0, nodeAddress: 'http://localhost:9944', indexerAddress: 'http://localhost:8088/api/v4/graphql', prover: 'local' };

test('worker-submission: MidnightSubmitInterruptedError keeps the submission listed as interrupted, unresolved and not resubmitted', async () => {
  const tracker = new SubmissionTracker(); let calls = 0;
  const error = new sdk.MidnightSubmitInterruptedError(HASH);
  assert.equal(error.code, INTERRUPTED_ERROR_CODE);
  const final = await submitTracked(tracker, ACCOUNT, proved, async () => { calls++; throw error; });
  assert.equal(calls, 1, 'one submission, never retried');
  assert.deepEqual([final.stage, final.activityHash, final.sdk, final.errorCode], ['interrupted', HASH, 'error', 'midnight-submit-interrupted']);
  assert.match(final.summary, /Outcome unknown/);
  assert.match(final.summary, /may still reach the chain and is not submitted again/);
  assert.doesNotMatch(final.summary, /failed before broadcast|Nothing was sent/);
  assert.deepEqual(tracker.unresolved.map(entry => entry.activityHash), [HASH], 'a later submission review names it');
  assert.deepEqual(tracker.watchedAccounts, [ACCOUNT]);
});

test('worker-submission: history settles an interrupted submission; a Pending row does not', async () => {
  for (const [type, stage] of [['Self', 'confirmed'], ['Failed', 'failed-on-chain']]) {
    const tracker = new SubmissionTracker();
    await submitTracked(tracker, ACCOUNT, proved, async () => { throw new sdk.MidnightSubmitInterruptedError(HASH); });
    tracker.observeHistory(ACCOUNT, [{ activityId: HASH, type: 'Pending' }]);
    assert.equal(tracker.state.stage, 'interrupted', 'the SDK keeps a Pending row for it');
    tracker.observeHistory(ACCOUNT, [{ activityId: HASH, type }]);
    assert.equal(tracker.state.stage, stage);
    assert.equal(tracker.state.errorCode, 'midnight-submit-interrupted', 'the SDK error stays recorded');
  }
});

test('worker-submission: Worker-mode errors raised before anything was sent show failed', async () => {
  const errors = [
    new sdk.MidnightEngineResetError(ACCOUNT),
    new sdk.MidnightWorkerStoppedError(ACCOUNT),
    new sdk.MidnightWorkerStartupError(ACCOUNT),
    new sdk.MidnightWorkerUnsupportedError(),
    new sdk.MidnightWorkerSettingsConflictError(ACCOUNT),
  ];
  for (const error of errors) {
    assert.ok(PRE_BROADCAST_ERROR_CODES.includes(error.code), error.code);
    const tracker = new SubmissionTracker();
    const final = await submitTracked(tracker, ACCOUNT, proved, async () => { throw error; });
    assert.deepEqual([final.stage, final.activityHash, final.errorCode], ['failed', HASH, error.code], error.code);
    assert.match(final.summary, /failed before broadcast/);
    // History still overrides the classification.
    tracker.observeHistory(ACCOUNT, [{ activityId: HASH, type: 'Self' }]);
    assert.equal(tracker.state.stage, 'confirmed', error.code);
  }
  // A timeout may still land: uncertain, as before.
  const tracker = new SubmissionTracker();
  const final = await submitTracked(tracker, ACCOUNT, proved, async () => { throw new sdk.MidnightSubmitTimeoutError(HASH, 300_000); });
  assert.deepEqual([final.stage, final.errorCode], ['uncertain', 'midnight-submit-timeout']);
});

test('worker-submission: an engine error that crossed the worker shows its message, and never its serialized cause', async () => {
  // The shape the SDK gives the page in Worker mode since 3ce36fb837: a plain Error with the engine's name and
  // message, and the wallet SDK's serialized error as its cause, which can hold the transaction's bytes.
  const error = new Error('Wallet.SubmissionWalletError: Transaction submission error: Transaction is invalid and was rejected by the node\n    at the engine');
  error.name = 'FiberFailure';
  error.cause = { _id: 'FiberFailure', cause: { _tag: 'Fail', failure: { _tag: 'Wallet.SubmissionWalletError', txData: 'cause-only-marker' } } };
  const tracker = new SubmissionTracker();
  const final = await submitTracked(tracker, ACCOUNT, proved, async () => { throw error; });
  // Not one of the SDK's pre-broadcast errors: the outcome stays unknown until history says otherwise.
  assert.deepEqual([final.stage, final.sdk, final.errorCode], ['uncertain', 'error', undefined]);
  assert.equal(final.error, 'Wallet.SubmissionWalletError: Transaction submission error: Transaction is invalid and was rejected by the node');
  assert.match(final.summary, /The SDK reported: Wallet\.SubmissionWalletError: Transaction submission error: Transaction is invalid and was rejected by the node\.$/);
  assert.doesNotMatch(JSON.stringify(tracker.records), /cause-only-marker|at the engine/);
});

test('worker-submission: the test-only boundary observer tells a fulfilled Err from a rejection, and does nothing without a sink', async () => {
  const interrupted = new sdk.MidnightSubmitInterruptedError(HASH);
  const ok = Promise.resolve({ isErr: () => false, value: { txId: 'not-recorded' } });
  const err = Promise.resolve({ isErr: () => true, error: interrupted });
  const rejected = Promise.reject(interrupted); rejected.catch(() => {});
  const sink = [];
  for (const pending of [ok, err, rejected]) observeSubmitBoundary(sink, pending, sdk.MidnightSubmitInterruptedError);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(sink, [
    { settled: 'fulfilled', isErr: false },
    { settled: 'fulfilled', isErr: true, errorName: 'MidnightSubmitInterruptedError', errorCode: 'midnight-submit-interrupted', interruptedError: true },
    { settled: 'rejected', errorName: 'MidnightSubmitInterruptedError', errorCode: 'midnight-submit-interrupted', interruptedError: true },
  ]);
  // An Err with another error is told apart from the interrupted one.
  const other = [];
  observeSubmitBoundary(other, Promise.resolve({ isErr: () => true, error: new Error('engine message') }), sdk.MidnightSubmitInterruptedError);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(other, [{ settled: 'fulfilled', isErr: true, errorName: 'Error', interruptedError: false }]);
  // Without a sink (normal use) nothing is recorded and nothing throws.
  assert.doesNotThrow(() => observeSubmitBoundary(undefined, ok, sdk.MidnightSubmitInterruptedError));
});

test('worker-errors: the page names each SDK error by class and code, with a hint for every Worker-mode code', () => {
  const workerErrors = [
    new sdk.MidnightWorkerUnsupportedError(), new sdk.MidnightWorkerStartupError(ACCOUNT), new sdk.MidnightWorkerStoppedError(ACCOUNT),
    new sdk.MidnightWorkerSettingsConflictError(ACCOUNT), new sdk.MidnightEngineResetError(ACCOUNT), new sdk.MidnightSubmitInterruptedError(HASH),
    new sdk.MidnightStaleTxError(ACCOUNT),
  ];
  for (const error of workerErrors) {
    assert.equal(sdkErrorLabel(error), `${error.name} [${error.code}]`);
    assert.ok(WORKER_ERROR_HINTS[error.code], error.code);
  }
  assert.equal(sdkErrorLabel(new sdk.MidnightAttestedProverUnsupportedError()), 'MidnightAttestedProverUnsupportedError [midnight-attested-prover-unsupported]');
  assert.equal(sdkErrorLabel(new Error('plain')), undefined);
  assert.equal(sdkErrorLabel(Object.assign(new Error('x'), { name: 'Other', code: 'midnight-stale-tx' })), '[midnight-stale-tx]');
  assert.equal(sdkErrorLabel(Object.assign(new Error('x'), { code: 'not-an-sdk-code' })), undefined);
});

test('worker-config: the engine runs on the page by default; Worker mode maps to createMidnightModule\'s worker option', () => {
  const page = validateConfig(local);
  assert.deepEqual([page.engine, page.workerStorage, page.adopt], ['page', 'memory', false]);
  assert.equal(workerOption(page), undefined);
  assert.equal(engineDisclosure(page), 'This page runs the engine');
  assert.deepEqual(workerOption(validateConfig({ ...local, engine: 'worker' })), { storage: 'memory', adopt: false });
  const adopting = validateConfig({ ...local, engine: 'worker', workerStorage: 'indexeddb', adopt: true });
  assert.deepEqual(workerOption(adopting), { storage: 'indexeddb', adopt: true });
  assert.match(engineDisclosure(adopting), /SharedWorker.*indexeddb storage; adopts/);
  for (const change of [{ engine: 'thread' }, { engine: 'worker', workerStorage: 'disk' }, { engine: 'worker', adopt: 'yes' }]) assert.throws(() => validateConfig({ ...local, ...change }), ConfigError);
});

test('worker-config: Temenos is refused in Worker mode before restore, as the SDK refuses it', () => {
  const temenos = { ...local, network: 'preview', nodeAddress: '', indexerAddress: '', prover: 'temenos' };
  assert.equal(validateConfig(temenos).engine, 'page', 'Temenos stays available on the page');
  assert.throws(() => validateConfig({ ...temenos, engine: 'worker' }), error => error instanceof ConfigError && /proof server URL/.test(error.message));
  const password = new Uint8Array(32);
  const createAttestedProver = () => { throw new Error('not called'); };
  assert.throws(() => sdk.createMidnightModule({ password, worker: { storage: 'memory', adopt: false }, createAttestedProver }), sdk.MidnightAttestedProverUnsupportedError);
  // The options the page passes are ones the SDK accepts.
  for (const config of [{ ...local, engine: 'worker' }, { ...local, engine: 'worker', workerStorage: 'indexeddb', adopt: true }]) {
    assert.doesNotThrow(() => sdk.createMidnightModule({ password, worker: workerOption(validateConfig(config)) }));
  }
});

test('live setup: MIDNIGHT_LIVE takes preview or undeployed, the local chain with its own endpoints and wallet', () => {
  assert.equal(liveNetwork('preview'), 'preview');
  assert.equal(liveNetwork('undeployed'), 'undeployed');
  for (const value of [undefined, '', 'mainnet', 'local', 'PREVIEW']) assert.equal(liveNetwork(value), undefined);
  assert.equal(liveEndpoints('preview'), undefined, 'Preview uses the SDK public endpoints');
  assert.deepEqual(liveEndpoints('undeployed'), { nodeAddress: 'http://localhost:9944', indexerAddress: 'http://localhost:8088/api/v4/graphql' });
  assert.deepEqual(liveEndpoints('undeployed'), LOCAL_CHAIN_ENDPOINTS);
  // Deliberately invalid synthetic words; no fixture contains a usable seed.
  const input = { network: 'undeployed', address: 'mn_addr_undeployed_synthetic', mnemonicWords: Array(12).fill('synthetic'), passwordHex: String(123456) };
  assert.equal(parseTestWallet(input, 'undeployed').network, 'undeployed');
  assert.throws(() => parseTestWallet(input), /preview wallet/, 'the default stays Preview');
  assert.throws(() => parseTestWallet({ ...input, address: 'mn_addr_preview_synthetic' }, 'undeployed'));
  assert.throws(() => parseTestWallet({ ...input, network: 'preview' }, 'undeployed'));
});
