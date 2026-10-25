import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { waitForPublicReady } from './live/wallet-input.ts';
import { installStartupDiagnostics, summarizeStartupError } from './live/startup-diagnostics.ts';

for (const stage of ['restore-failed', 'sync-failed', 'balance-stream-failed']) {
  test(`${stage} stops immediately even with cached ready state`, async () => {
    let reads = 0, pauses = 0;
    await assert.rejects(waitForPublicReady(async () => { reads++; return { stage, ready: true }; }, 240_000, 'Timed out', async () => { pauses++; }), /failed/);
    assert.equal(reads, 1);
    assert.equal(pauses, 0);
  });
}
test('public readiness waits through startup and accepts only the caller condition', async () => {
  const observations = [{ stage: 'restore-started', ready: false }, { stage: 'waiting-for-engine', ready: false }, { stage: 'state-observed', ready: true }];
  let pauses = 0;
  await waitForPublicReady(async () => observations.shift(), 1000, 'Timed out', async () => { pauses++; });
  assert.equal(pauses, 2);
  assert.equal(observations.length, 0);
});
test('missing state is still a timeout failure, never success or an error dump', async () => {
  await assert.rejects(waitForPublicReady(async () => ({ stage: 'secret sentinel', ready: false }), 0, 'Public state was not observed'), /^Error: Public state was not observed$/);
});
test('diagnostic projection returns fixed classifications and known source positions only', () => {
  const url = 'http://localhost:5198/node_modules/.vite/deps/sdk-init-fixture.js?v=fixed';
  const error = new TypeError('private sentinel is not a function');
  error.stack = `TypeError: private sentinel\n    at privateFunction (${url}:123:45)\n    at unknown (https://private-sentinel.invalid/secret.js:4:5)`;
  error.cause = { mnemonic: 'private sentinel', password: 'private sentinel' };
  const result = summarizeStartupError(error, [url]);
  assert.deepEqual(result, { kind: 'TypeError', category: 'missing-callable', locations: [{ source: 0, line: 123, column: 45 }] });
  assert.ok(!JSON.stringify(result).includes('private'));
  const hostile = { get name() { throw new Error('private sentinel'); } };
  assert.deepEqual(summarizeStartupError(hostile, []), { kind: 'unknown', category: 'unclassified', locations: [] });
});
test('diagnostic classifies unknown and WASM failures without serializing them', () => {
  assert.equal(summarizeStartupError(new Error('expected instance of DustParameters; private sentinel'), []).category, 'wasm-instance-mismatch');
  assert.equal(summarizeStartupError({ name: 'private sentinel', message: 'private sentinel', stack: 'private sentinel' }, []).kind, 'other');
});

test('SDK account selection and registry failures remain fixed categories without account identifiers', () => {
  for (const [name, category] of [['MidnightAccountNotFoundError', 'account-not-found'], ['MidnightWalletNotReadyError', 'wallet-not-ready']]) {
    const error = { name, message: 'private account sentinel undefined', code: 'private sentinel', stack: 'private sentinel' };
    assert.deepEqual(summarizeStartupError(error, []), { kind: name, category, locations: [] });
  }
});

test('real packaged balance observable routes selection, missing registry and projection failures to the error observer', async () => {
  // Pure synthetic observables: no SDK instance startup, wallet derivation or IO.
  globalThis.self ??= globalThis;
  const require = createRequire(import.meta.url);
  const { observeMidnightBalances } = await import('@laceio/sdk/midnight');
  const { of } = require('rxjs');
  const accountId = 'private synthetic account';
  const account = { accountId, accountType: 'InMemory', blockchainName: 'Midnight', blockchainNetworkId: 'midnight-preview' };
  // The SDK reaches the engine registry through the loadMidnightEngine addon, which yields the
  // engine access: requestEngine, startFailures$ and the registry as engines$. A loadout without
  // the engine module yields no access.
  const makeWallet = (network, registry) => ({ stateObservables: {
    wallets: { selectAll$: of([{ accounts: [account] }]) },
    network: { selectAllActiveNetworkIds$: of([network]) },
    midnightContext: {},
  }, _loadModules: async () => (registry ? [{ requestEngine: () => {}, startFailures$: of({}), engines$: of(registry) }] : []) });
  const engine = { accountId, state: () => of({}), syncProgress$: of({}), address$: of({}) };
  for (const [wallet, kind, category] of [
    [makeWallet('midnight-preprod'), 'MidnightAccountNotFoundError', 'account-not-found'],
    [makeWallet('midnight-preview'), 'MidnightWalletNotReadyError', 'wallet-not-ready'],
    [makeWallet('midnight-preview', { [accountId]: engine }), 'TypeError', 'missing-value'],
  ]) {
    const result = await new Promise((resolve, reject) => {
      observeMidnightBalances(wallet, { accountId }).subscribe({
        next: () => reject(new Error('Fixture must fail before balances')),
        error: error => resolve(summarizeStartupError(error, [])),
        complete: () => reject(new Error('Fixture must deliver the error callback')),
      });
    });
    assert.deepEqual(result, { kind, category, locations: [] });
    assert.ok(!JSON.stringify(result).includes(accountId));
  }
});

for (const mode of ['missing', 'ambiguous', 'unresolved']) {
  test(`balance diagnostic preflight refuses a ${mode} callback anchor and detaches`, async () => {
    const handlers = new Map();
    let detached = 0;
    const cdp = {
      on(event, handler) { handlers.set(event, handler); },
      async detach() { detached++; },
      async send(method) {
        if (method === 'Debugger.enable') handlers.get('Debugger.scriptParsed')({ scriptId: 'app', url: 'http://localhost:5198/src/midnight/app.ts' });
        if (method === 'Debugger.getScriptSource') return { scriptSource: mode === 'missing' ? '' : Array(mode === 'ambiguous' ? 2 : 1).fill('observed.balanceStreamFailed = true;').join('\n') };
        return { breakpointId: 'synthetic', locations: [] };
      },
    };
    const diagnostic = await installStartupDiagnostics({ context: () => ({ newCDPSession: async () => cdp }) });
    await assert.rejects(diagnostic.armBalanceObserver(), { message: `Balance diagnostic ${mode === 'unresolved' ? 'observer-breakpoint-unresolved' : 'observer-anchor-unavailable'}; wallet input must not be loaded.` });
    assert.equal(diagnostic.snapshot().balanceObserverArmed, false);
    assert.equal(diagnostic.snapshot().diagnosticError, true);
    await diagnostic.stop();
    assert.equal(detached, 1);
  });
}
