import { BASELINE, NETWORKS, PREVIEW_ENDPOINTS, proverDisclosure, validateConfig, type Network, type SessionConfig } from './config';
import { OperationGate, SubmissionTracker, display, parseOutputs, parseHex, positiveAmount, submitTracked, type PrepareOptions, type Review } from './operations';
import type { Session, Recipe, Transaction, Batch, CircuitKeys, Account } from './runtime';

document.title = 'Midnight · Lace SDK consumer';
document.body.innerHTML = `
<style>
body { overflow:auto; display:block; background:#f6f7fa; color:#192231; font:16px system-ui,sans-serif; }
main { max-width:1000px; margin:auto; padding:24px; } section { background:white; border:1px solid #d5dbe4; border-radius:8px; padding:18px; margin:18px 0; }
h1,h2 { margin-top:0; } h2 { font-size:1.2rem; } label { display:block; margin:10px 0; } input,select,textarea,button { font:inherit; padding:8px; box-sizing:border-box; } textarea { width:100%; font-family:monospace; } button { margin:4px; cursor:pointer; } button:disabled { cursor:default; } pre { white-space:pre-wrap; overflow-wrap:anywhere; background:#f3f5f8; padding:12px; max-height:350px; overflow:auto; } .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; } dialog { max-width:min(800px,90vw); border:1px solid #718097; border-radius:8px; } dialog::backdrop { background:#0008; } small { display:block; color:#45546a; } [role=status] { padding:12px; } a { color:#174fb0; }
</style>
<main><nav><a href="/">Cardano / passkey / custody</a></nav><h1>Midnight developer wallet</h1>
<p>Restore a disposable test wallet, inspect its state, then explicitly review each operation. Session secrets stay in memory. Reloading clears the session.</p>
<p id="status" role="status" aria-live="polite">No wallet loaded. Preview is selected.</p>
<section><h2>1. Restore and connect</h2><form id="restore-form" autocomplete="off" novalidate>
<label>Recovery phrase <textarea id="phrase" rows="2" spellcheck="false" autocomplete="off" required></textarea></label>
<label>Session password <input id="password" type="password" autocomplete="new-password" required></label>
<div class="grid"><label>Network <select id="network">${NETWORKS.map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
<label>Additional account index <input id="index" type="number" min="0" max="2147483647" value="0" required></label>
<label>Prover <select id="prover"><option value="local">Local · 127.0.0.1:6300</option><option value="temenos">Temenos · attestation required</option></select></label></div>
<details><summary>Custom endpoints</summary><p>Leave both empty for SDK public endpoints. Custom networks require both. Changing setup requires a fresh restore.</p>
<label>Node URL <input id="node" type="text"></label><label>Indexer URL <input id="indexer" type="text"></label></details>
<button id="restore" type="submit">Restore wallet</button><button id="disconnect" type="button">Clear session</button>
</form><small>Local proving requires a running proof server. Temenos requires successful attestation; neither option authorizes submission.</small>
<pre id="configuration">${display({ network: 'preview', ...PREVIEW_ENDPOINTS })}</pre></section>
<div id="wallet-controls" hidden>
<section><h2>2. Account state</h2><label>Account <select id="account"></select></label>
<button id="reset">Reset this account’s sync</button><small>Reset is a request. Watch sync state for completion or failure; other accounts remain active.</small>
<div class="grid"><div><h3>Receive addresses and public keys</h3><pre id="addresses">Not observed</pre><pre id="keys">Not observed</pre></div><div><h3>Token balances</h3><small>Available and pending amounts are separate; amounts use smallest units.</small><pre id="tokens">Not observed</pre></div></div>
<h3>DUST</h3><small>Generated balance can differ from spendable balance. Missing state is not zero.</small><pre id="dust">Not observed</pre>
<h3>Synchronization</h3><small>Rounded progress alone is not completion. Cached state does not establish connectivity.</small><pre id="initialization">{"stage":"idle"}</pre><pre id="sync">Not observed</pre><pre id="readiness">Strict sub-wallet completion not observed.</pre><pre id="balances">Not observed</pre>
<details><summary>History and token display names</summary><p>History omits shielded-only rows. Connector getTxHistory and hintUsage remain unsupported.</p><pre id="history">Not observed</pre>
<label>History row <select id="activity"></select></label><button id="details">Load activity details</button><pre id="activity-details">Not observed</pre>
<label>Token <select id="token"></select></label><label>Display name <input id="token-name"></label><label>Ticker <input id="ticker" maxlength="4"></label><button id="rename">Save display names</button></details></section>
<section id="transaction-form"><h2>3. Transfer or register DUST</h2><label>Operation <select id="kind"><option value="unshielded">Unshielded batch transfer</option><option value="shielded">Shielded batch transfer</option><option value="dust">DUST registration</option></select></label>
<label>Transfer outputs (JSON: to, tokenId, amount as an integer string)<textarea id="outputs" rows="5">[]</textarea></label>
<small>Use token IDs from account state. A batch has one kind; the connector controls below support mixed kinds.</small>
<label>DUST destination (empty = own address; external destination requires NIGHT and no existing generation capacity)<input id="dust-address" type="text"></label>
<button id="estimate">Estimate unsigned fee</button><button id="build">Build transfer / review registration</button><button id="sign" disabled>Review signing</button><button id="prove" disabled>Review proving</button><button id="submit" disabled>Review submission</button>
<button id="cancel-operation">Cancel / discard operation</button><pre id="operation">No operation prepared.</pre><pre id="progress">No prover events.</pre>
<h3>Submission</h3><small>Every submission of this session, newest first. Each records its activity hash before broadcast and cannot be cancelled. History confirms it by that hash, also after switching account; an SDK error after broadcast leaves it uncertain, not failed.</small><pre id="submission">[]</pre></section>
<section id="advanced"><h2>Advanced caller controls</h2><p>These public connector helpers may sign and prove while building. Every call requires review; submission remains separate. intentId is accepted but ignored.</p>
<label>Connector operation <select id="connector-kind"><option value="transfer">Mixed transfer</option><option value="intent">Intent</option><option value="sealed">Balance sealed transaction</option><option value="unsealed">Balance unsealed transaction</option></select></label>
<label>Connector request JSON <textarea id="connector" rows="6">{"desiredOutputs":[],"options":{"payFees":true}}</textarea></label>
<small>Transfer/intent outputs use kind, type (raw ledger token type), recipient, value (integer string). Balancing uses tx (hex) and options. Intent also requires desiredInputs and options.intentId.</small><button id="connector-run">Review connector operation</button>
<details><summary>Sign a message</summary><label>Encoding <select id="encoding"><option value="text">text</option><option value="hex">hex</option><option value="base64">base64</option></select></label><label>Message <textarea id="message" rows="3"></textarea></label><button id="message-run">Review message signing</button><pre id="message-result">No signature.</pre></details>
<details><summary>Prove / check a circuit</summary><p>Supply circuit material locally. Temenos does not support check; failures never fall back to HTTP.</p>
<label>Operation <select id="circuit-kind"><option value="prove">prove</option><option value="check">check</option></select></label><label>Key location <input id="key-location"></label><label>Preimage (hex) <textarea id="preimage" rows="2"></textarea></label>
<label>Prover key (hex) <textarea id="prover-key" rows="2"></textarea></label><label>Verifier key (hex) <textarea id="verifier-key" rows="2"></textarea></label><label>ZKIR (hex) <textarea id="zkir" rows="2"></textarea></label>
<label>Overwrite binding input (optional nonnegative integer, prove only)<input id="binding-input" inputmode="numeric"></label><button id="circuit-run">Review circuit disclosure</button><pre id="circuit-result">No circuit result.</pre></details></section></div>
<dialog id="confirmation" aria-labelledby="review-title"><h2 id="review-title">Review operation</h2><pre id="review-summary"></pre><p id="review-disclosure"></p><button id="approve">Approve this operation</button><button id="reject">Cancel</button></dialog></main>`;

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => element<HTMLInputElement>(id).value;
const put = (id: string, data: unknown) => { element(id).textContent = typeof data === 'string' ? data : display(data); };
const status = (message: string) => put('status', message);
const gate = new OperationGate();
// Newest first; earlier unresolved submissions stay listed until history resolves them.
const submission = new SubmissionTracker((changed, all, announce) => { put('submission', all); if (announce) status(changed.summary); });
const dialog = element<HTMLDialogElement>('confirmation');
let review: Review | undefined;
let session: Session | undefined;
let passwordBytes: Uint8Array | undefined;
let subscriptions: { unsubscribe(): void }[] = [];
let recipe: Recipe | undefined;
let transaction: Transaction | undefined;
let signed = false;
let operationInputs: unknown;
let setupRevision = 0;
let restoring = false;
let loadDetails: (() => void) | undefined;
let rename: (() => void) | undefined;
let watchedAccount: string | undefined;
const IN_FLIGHT = 'Submission in flight: it cannot be cancelled or discarded. Its outcome is reported under Submission.';
// Controls that could discard, replace or tear down a broadcast in flight.
const lockable = () => document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
  '#restore-form :is(input, select, textarea, button), #account, #reset, #transaction-form :is(input, select, textarea, button), #advanced :is(input, select, textarea, button)');

function refreshButtons() {
  for (const control of lockable()) control.disabled = gate.irrevocable;
  element<HTMLButtonElement>('restore').disabled = restoring || gate.irrevocable;
  element<HTMLButtonElement>('sign').disabled = !recipe || signed || gate.busy;
  element<HTMLButtonElement>('prove').disabled = !recipe || !signed || gate.busy;
  element<HTMLButtonElement>('submit').disabled = !transaction || gate.busy;
}
/** Discards staged material. Refused, returning false, while a submission is in flight. */
function invalidate(): boolean {
  if (!gate.invalidate()) { status(IN_FLIGHT); return false; }
  review = undefined; recipe = undefined; transaction = undefined; signed = false; operationInputs = undefined;
  if (dialog.open) dialog.close();
  put('operation', 'Operation discarded. Prepare again.'); put('progress', 'No prover events.'); refreshButtons();
  return true;
}
/** Clears secrets and the session. While a submission is in flight only leaving the page proceeds. */
function clearSession(leavingPage = false) {
  if (gate.irrevocable && !leavingPage) { status(IN_FLIGHT); return; }
  element<HTMLInputElement>('phrase').value = ''; element<HTMLInputElement>('password').value = '';
  passwordBytes?.fill(0); passwordBytes = undefined;
  setupRevision++; invalidate(); subscriptions.forEach(s => s.unsubscribe()); subscriptions = [];
  if (session) session.wallet.dispatch('wallets.removeWallet', session.entity.walletId, session.entity.accounts.map(a => a.accountId));
  session = undefined;
  put('initialization', { stage: 'idle' });
  element('wallet-controls').hidden = true; status('Session cleared. Restore to reconnect.');
}
function selected() {
  if (!session) throw new Error('Restore a wallet first.');
  const accountId = session.sdk.AccountId(value('account')) as Account;
  if (!session.entity.accounts.some(a => a.accountId === accountId && a.blockchainNetworkId === session!.sdk.MidnightNetworkId(session!.config.network))) throw new Error('Select an account on this network.');
  return { current: session, accountId };
}
function handle(id: string, action: () => unknown | Promise<unknown>) {
  element(id).addEventListener('click', async () => {
    try { await action(); } catch (error) { report(error); } finally { refreshButtons(); }
  });
}
function report(error: unknown) {
  // Setup errors can contain library inputs. Never print phrase/password or raw wallet state.
  const message = error instanceof Error ? error.message : 'Operation failed';
  status(session ? `Operation failed: ${message}. Submission/proving timeout may be uncertain; inspect state before retrying.` : 'Restore failed or was cancelled. Check phrase, password, network and prover setup.');
}
function prepare(action: string, inputs: unknown, invoke: (assertCurrent: () => void) => Promise<unknown>, options?: PrepareOptions) {
  const { current, accountId } = selected();
  review = gate.prepare(action, { accountId, network: current.config.network, prover: proverDisclosure(current.config) }, inputs, invoke, options);
  put('review-summary', { action: review.action, ...review.context, inputs }); put('review-disclosure', review.disclosure);
  dialog.showModal(); element<HTMLButtonElement>('reject').focus();
}
handle('reject', invalidate);
dialog.addEventListener('cancel', invalidate);
handle('cancel-operation', invalidate);
handle('approve', async () => {
  if (!review) throw new Error('Prepare a current review.');
  const approved = review; review = undefined; dialog.close(); status(`${approved.action} in progress…`);
  const version = gate.version;
  const pending = gate.confirm(approved);
  refreshButtons();
  const result = await pending;
  gate.assertVersion(version);
  if (result && typeof result === 'object' && 'stage' in result) {
    const completed = result as { stage: string; value: unknown };
    if (completed.stage === 'registered' || completed.stage === 'signed') { recipe = completed.value as Recipe; signed = true; put('operation', `${completed.stage}. Review proving next.`); }
    if (completed.stage === 'proved') { transaction = completed.value as Transaction; recipe = undefined; put('operation', 'Proved. Review submission next.'); }
    if (completed.stage === 'message') put('message-result', completed.value);
    if (completed.stage === 'circuit') put('circuit-result', completed.value);
    if (completed.stage === 'submission') { put('operation', 'Submission settled. Its outcome is under Submission.'); return; }
  }
  status(`${approved.action} returned. See the operation result and account state.`);
});
for (const id of ['transaction-form', 'advanced']) element(id).addEventListener('input', () => { invalidate(); });
element('account').addEventListener('change', () => {
  if (!invalidate()) { if (watchedAccount) element<HTMLSelectElement>('account').value = watchedAccount; return; }
  watchAccount();
});
element('restore-form').addEventListener('input', () => {
  if (gate.irrevocable) { status(IN_FLIGHT); return; }
  setupRevision++; invalidate();
  if (session) clearSession();
});
handle('disconnect', () => clearSession());
window.addEventListener('pagehide', () => clearSession(true));

element('restore-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (restoring || gate.busy) {
    element<HTMLInputElement>('phrase').value = ''; element<HTMLInputElement>('password').value = '';
    return;
  }
  let words = value('phrase').trim().split(/\s+/);
  const password = new TextEncoder().encode(value('password'));
  element<HTMLInputElement>('phrase').value = ''; element<HTMLInputElement>('password').value = '';
  let created: Session | undefined;
  try {
    const config: SessionConfig = validateConfig({ network: value('network') as Network, index: Number(value('index')), prover: value('prover') as SessionConfig['prover'], nodeAddress: value('node').trim(), indexerAddress: value('indexer').trim() });
    if (!password.length || words.length < 12) throw new Error('Recovery phrase and session password required.');
    clearSession(); const version = setupRevision; restoring = true; element<HTMLButtonElement>('restore').disabled = true;
    status('Restoring keys in browser WASM. This can take a minute; no transaction will be signed.');
    put('initialization', { stage: 'restore-started' });
    const runtime = await import('./runtime');
    if (version !== setupRevision) throw new Error('Restore cancelled');
    created = await runtime.restore(words, password, config);
    if (version !== setupRevision) { runtime.stopSession(created); throw new Error('Restore cancelled'); }
    session = created; passwordBytes = password;
    const accounts = created.entity.accounts.filter(a => a.blockchainName === 'Midnight' && a.blockchainNetworkId === created!.sdk.MidnightNetworkId(config.network));
    element<HTMLSelectElement>('account').replaceChildren(...accounts.map(a => new Option(a.accountId, a.accountId)));
    element<HTMLSelectElement>('account').selectedIndex = accounts.length - 1;
    element('wallet-controls').hidden = false;
    put('configuration', { baseline: BASELINE, network: config.network, endpoints: config.nodeAddress ? { nodeAddress: config.nodeAddress, indexerAddress: config.indexerAddress } : created.sdk.MIDNIGHT_PUBLIC_ENDPOINTS[config.network as keyof typeof created.sdk.MIDNIGHT_PUBLIC_ENDPOINTS], prover: proverDisclosure(config) });
    status('Restore returned. Waiting for engine state; no operation authorized.');
    watchAccount();
  } catch (error) { if (!session) { password.fill(0); put('initialization', { stage: 'restore-failed' }); } report(error); }
  finally { words.fill(''); words = []; restoring = false; element<HTMLButtonElement>('restore').disabled = false; }
});

function watchAccount() {
  subscriptions.forEach(s => s.unsubscribe()); subscriptions = [];
  const { current, accountId } = selected(); const { wallet, sdk } = current;
  watchedAccount = accountId;
  for (const id of ['addresses', 'keys', 'tokens', 'dust', 'sync', 'readiness', 'balances', 'history', 'activity-details']) put(id, 'Not observed');
  const state = wallet.stateObservables;
  const dust: Record<string, unknown> = {};
  // Only fixed stages and booleans cross this diagnostic boundary. Restore
  // returning establishes an entity, not a running or synchronized engine.
  const observed = { restoreReturned: true, balances: false, addresses: false, publicKeys: false, synchronized: false, syncFailed: false, balanceStreamFailed: false };
  const updateInitialization = () => {
    const stage = observed.syncFailed ? 'sync-failed' : observed.balanceStreamFailed ? 'balance-stream-failed'
      : observed.synchronized ? 'synchronized' : observed.balances ? 'state-observed' : 'waiting-for-engine';
    put('initialization', { stage, ...observed });
    if (observed.syncFailed) status('Account synchronization failed. Engine readiness is not established. Clear the session before retrying.');
    else if (observed.balanceStreamFailed) status('Engine state observation failed. Inspect synchronization status; restore alone does not establish readiness.');
  };
  updateInitialization();
  subscriptions.push(
    sdk.observeMidnightBalances(wallet, { accountId }).subscribe({
      next: balances => { observed.balances = true; observed.synchronized = balances.synced.unshielded && balances.synced.shielded && balances.synced.dust; updateInitialization(); put('readiness', { strictlySynced: balances.synced }); put('balances', { ...balances, nightTokenId: `unshielded-${current.config.network}${sdk.NIGHT_TOKEN_ID}` }); },
      error: (error: unknown) => {
        // Keep the argument bound for the opt-in debugger probe; never publish it.
        observed.balanceStreamFailed = true;
        updateInitialization(); put('readiness', 'Engine state unavailable. Inspect sync failures or reset this account.');
      },
    }),
    state.addresses.selectByAccountId$.subscribe(select => { const addresses = select(accountId); observed.addresses = !!addresses?.length; updateInitialization(); put('addresses', addresses); }),
    state.midnightContext.selectPublicKeysByAccountId$.subscribe(select => { const keys = select(accountId); observed.publicKeys = !!keys; updateInitialization(); put('keys', keys); }),
    state.midnightContext.selectDustBalanceByAccount$.subscribe(values => { dust.generated = values[accountId]; put('dust', dust); }),
    state.midnightContext.selectDustAvailableByAccount$.subscribe(values => { dust.spendable = values[accountId]; put('dust', dust); }),
    state.midnightContext.selectDustGenerationDetails$.subscribe(select => { dust.generation = select([accountId])[accountId]; put('dust', dust); }),
    state.sync.selectSyncStatusByAccount$.subscribe(values => {
      const sync = values[accountId];
      observed.syncFailed = sync?.pendingSync?.operations[`${accountId}-midnight-sync`]?.status === 'Failed';
      updateInitialization(); put('sync', sync);
    }),
    state.tokens.selectAggregatedTokensByAccountId$.subscribe(select => put('tokens', select(accountId))),
    state.activities.selectByAccountId$.subscribe(select => {
      const rows = select({ accountId }); put('history', rows); submission.observeHistory(accountId, rows);
      // Unresolved submissions of other accounts in this session still resolve from their history.
      for (const other of submission.watchedAccounts) if (other !== accountId) submission.observeHistory(other, select({ accountId: sdk.AccountId(other) as Account }));
      element<HTMLSelectElement>('activity').replaceChildren(...rows.map((row, i) => new Option(`${i + 1}: ${row.activityId}`, String(i))));
      loadDetails = () => { const activity = rows[Number(value('activity'))]; if (!activity) throw new Error('Select an available history row.'); wallet.dispatch('activities.loadActivityDetails', { blockchainName: 'Midnight', activity }); };
    }),
    state.activities.selectActivityDetails$.subscribe(detail => put('activity-details', detail?.accountId === accountId ? detail : undefined)),
    state.tokens.selectTokensMetadata$.subscribe(metadata => {
      const entries = Object.values(metadata).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      const previous = value('token'); element<HTMLSelectElement>('token').replaceChildren(...entries.map(t => new Option(`${t.name ?? t.tokenId}`, t.tokenId))); if (entries.some(t => t.tokenId === previous)) element<HTMLSelectElement>('token').value = previous;
      rename = () => {
        const token = entries.find(t => t.tokenId === value('token')); if (!token) throw new Error('Select a token.');
        const name = value('token-name').trim(), ticker = value('ticker').trim();
        const others = entries.filter(t => t.tokenId !== token.tokenId).flatMap(t => [t.name ?? '', t.ticker ?? '']);
        if (sdk.isForbiddenTokenName(token.name ?? '') || sdk.isForbiddenTokenName(token.ticker ?? '') || token.tokenId.endsWith(sdk.NIGHT_TOKEN_ID)) throw new Error('Native/reserved tokens cannot be renamed.');
        if (!sdk.isTokenFullNameValid(name) || !sdk.isTokenShortNameValid(ticker) || sdk.isTakenTokenName(name, others) || sdk.isTakenTokenName(ticker, others)) throw new Error('Invalid, reserved or duplicate token name/ticker.');
        wallet.dispatch('tokens.upsertTokenMetadata', { ...token, name, ticker }); status('Display names updated in this in-memory session.');
      };
    }),
  );
}
handle('reset', () => { const { current, accountId } = selected(); if (!invalidate()) return; current.wallet.dispatch('midnightContext.resetSyncState', { accountId }); status('Reset requested. Observe sync; dispatch is not completion.'); });
handle('details', () => loadDetails?.()); handle('rename', () => rename?.());
function batch(): Batch {
  const { accountId } = selected(); const outputs = parseOutputs(value('outputs'));
  const kind = value('kind'); if (kind !== 'shielded' && kind !== 'unshielded') throw new Error('Select a transfer kind.');
  return { accountId, kind, outputs };
}
function registration() { const { accountId } = selected(); const dustAddress = value('dust-address').trim(); return { accountId, ...(dustAddress ? { dustAddress } : {}) }; }
handle('estimate', async () => {
  const { current } = selected(); const version = gate.version;
  const request = value('kind') === 'dust' ? { kind: 'dust-registration' as const, registration: registration() } : { kind: 'transfer' as const, transfer: batch() };
  const fee = (await current.sdk.estimateMidnightFee(current.wallet, request)).unwrap(); gate.assertVersion(version);
  put('operation', { unsignedEstimate: fee, note: 'State/time dependent; not a guaranteed final fee.' });
});
handle('build', async () => {
  if (gate.busy) throw new Error('Wait for the current operation.');
  invalidate(); const { current } = selected();
  if (value('kind') === 'dust') {
    const request = registration(); operationInputs = request;
    prepare('Register NIGHT for DUST (signs internally)', request, async () => ({ stage: 'registered', value: (await current.sdk.registerMidnightDust(current.wallet, request)).unwrap() }));
  } else {
    const request = batch(); const version = gate.version;
    const built = (await current.sdk.buildMidnightTransfers(current.wallet, request)).unwrap(); gate.assertVersion(version);
    recipe = built; operationInputs = request; put('operation', 'Unsigned transfer built. Review signing next.');
  }
});
handle('sign', () => {
  const { current, accountId } = selected(); if (!recipe || signed) throw new Error('Build an unsigned transfer first.'); const prepared = recipe;
  prepare('Sign transfer', operationInputs, async () => ({ stage: 'signed', value: (await current.sdk.signMidnightTx(current.wallet, { accountId, recipe: prepared })).unwrap() }));
});
handle('prove', () => {
  const { current, accountId } = selected(); if (!recipe || !signed) throw new Error('Sign or register first.'); const prepared = recipe;
  prepare('Prove transaction and disclose material', operationInputs, async assertCurrent => ({ stage: 'proved', value: (await current.sdk.proveMidnightTx(current.wallet, { accountId, recipe: prepared, onProgress: event => { try { assertCurrent(); put('progress', event); } catch { /* ignore late progress */ } } })).unwrap() }));
});
handle('submit', () => {
  const { current, accountId } = selected(); if (!transaction) throw new Error('Prove a transaction first.'); const finalized = transaction;
  // An earlier unresolved hash may already be on chain; the review names it so approval acknowledges it.
  const unresolved = submission.unresolved.map(({ activityHash, stage }) => ({ activityHash, stage }));
  const inputs = unresolved.length ? { transaction: operationInputs, unresolvedEarlierSubmissions: unresolved, acknowledgement: 'Approving submits another transaction while these may already be on chain.' } : operationInputs;
  // Irrevocable: once approved, the outcome is always reported and never discarded.
  prepare('Submit transaction', inputs, async () => {
    transaction = undefined; // an uncertain submission cannot be blindly retried
    put('operation', 'Submission approved. Its outcome is under Submission; it cannot be cancelled.');
    const value = await submitTracked(submission, accountId, finalized, async () => {
      const result = await current.sdk.submitMidnightTx(current.wallet, { accountId, transaction: finalized });
      if (result.isErr()) throw result.error;
      return result.value;
    });
    return { stage: 'submission', value };
  }, { irrevocable: true });
});
handle('message-run', () => {
  if (gate.busy) throw new Error('Wait for the current operation.');
  invalidate();
  const { current, accountId } = selected(); const request = { accountId, data: value('message'), options: { keyType: 'unshielded' as const, encoding: value('encoding') as 'text' | 'hex' | 'base64' } };
  prepare('Sign domain-separated message', request, async () => ({ stage: 'message', value: (await current.sdk.signMidnightData(current.wallet, request)).unwrap() }));
});
handle('connector-run', () => {
  if (gate.busy) throw new Error('Wait for the current operation.');
  invalidate();
  const { current, accountId } = selected(); const kind = value('connector-kind');
  const request = JSON.parse(value('connector'), (key, item) => key === 'value' ? positiveAmount(item) : item);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Enter a connector request object.');
  if ('accountId' in request) throw new Error('Choose the account using the account selector.');
  const props = { ...request, accountId }; operationInputs = { kind, ...props };
  prepare(`Connector ${kind} (may sign and prove)`, operationInputs, async () => {
    const result = kind === 'sealed' ? await current.sdk.balanceMidnightSealedTransaction(current.wallet, props)
      : kind === 'unsealed' ? await current.sdk.balanceMidnightUnsealedTransaction(current.wallet, props)
      : kind === 'intent' ? await current.sdk.makeMidnightIntent(current.wallet, props)
      : await current.sdk.makeMidnightTransfer(current.wallet, props);
    return { stage: 'proved', value: result.unwrap() };
  });
});
handle('circuit-run', () => {
  if (gate.busy) throw new Error('Wait for the current operation.');
  invalidate();
  const { current, accountId } = selected(); const kind = value('circuit-kind'); const keyLocation = value('key-location');
  const preimage = parseHex(value('preimage')), prover = parseHex(value('prover-key')), verifier = parseHex(value('verifier-key')), zkir = parseHex(value('zkir'));
  if (!preimage.length || !keyLocation || !prover.length || !verifier.length || !zkir.length) throw new Error('Preimage, key location and all circuit material are required.');
  const binding = value('binding-input').trim();
  if (binding && !/^[0-9]+$/.test(binding)) throw new Error('Binding input must be a nonnegative integer.');
  const overwriteBindingInput = binding ? BigInt(binding) : undefined;
  const keyMaterialProvider: CircuitKeys = { getProverKey: async () => prover, getVerifierKey: async () => verifier, getZKIR: async () => zkir };
  prepare(`Circuit ${kind}: disclose preimage and keys`, { kind, keyLocation, preimage: value('preimage'), proverKey: value('prover-key'), verifierKey: value('verifier-key'), zkir: value('zkir'), overwriteBindingInput }, async assertCurrent => {
    const provider = (await current.sdk.getMidnightProvingProvider(current.wallet, { accountId, keyMaterialProvider })).unwrap();
    assertCurrent(); const result = kind === 'check' ? await provider.check(preimage, keyLocation) : await provider.prove(preimage, keyLocation, overwriteBindingInput);
    return { stage: 'circuit', value: result instanceof Uint8Array ? Array.from(result, b => b.toString(16).padStart(2, '0')).join('') : result };
  });
});
