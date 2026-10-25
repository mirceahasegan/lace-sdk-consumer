import { test, expect } from '@playwright/test';

test('Midnight route starts separately, on Preview, without restoring or contacting providers', async ({ page }) => {
  const remote: string[] = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) { remote.push(url.origin); return route.abort(); }
    return route.continue();
  });
  await page.goto('/midnight');
  await expect(page.getByRole('heading', { name: 'Midnight developer wallet' })).toBeVisible();
  await expect(page.locator('#network')).toHaveValue('preview');
  await expect(page.locator('#wallet-controls')).toBeHidden();
  await expect(page.locator('#status')).toContainText('No wallet loaded');
  await expect(page.locator('#phrase')).toHaveValue('');
  await expect(page.locator('#password')).toHaveValue('');
  await expect(page.getByRole('link', { name: 'Cardano / passkey / custody' })).toHaveAttribute('href', '/');
  expect(remote).toEqual([]);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('browser cancellation and changed context do not enter sensitive operations', async ({ page }) => {
  await page.goto('/midnight');
  const calls = await page.evaluate(async () => {
    // Run the production gate in the browser, without mocking wallet success.
    const path = '/src/midnight/operations.ts';
    const { OperationGate } = await import(/* @vite-ignore */ path);
    let effects = 0;
    for (const action of ['sign', 'register', 'connector', 'message', 'circuit', 'submit']) {
      const gate = new OperationGate();
      const review = gate.prepare(action, { accountId: 'a', network: 'preview', prover: 'local' }, {}, async () => effects++);
      gate.invalidate();
      try { await gate.confirm(review); } catch { /* expected refusal */ }
    }
    return effects;
  });
  expect(calls).toBe(0);
});

// Explicitly mocked UI authorization regression. This establishes no live SDK behavior.
const HASH = 'mock-activity-hash-02139e2c';
const HASH2 = 'mock-activity-hash-second';
const fakeRuntime = `
const effects = window.__midnightEffects = [];
const observable = value => ({ subscribe(fn) { fn(value); return { unsubscribe() {} }; } });
const result = value => ({ isOk() { return true; }, isErr() { return false; }, value, unwrap() { return value; } });
const failure = error => ({ isOk() { return false; }, isErr() { return true; }, error, unwrap() { throw new Error('Tried to unwrap Error'); } });
const call = name => async (...args) => { effects.push(name); return result({ mock: name }); };
// History rows the test can publish. Like the real selector, select({ accountId }) returns only that account's rows.
const history = { rows: [], listeners: new Set() };
const selectHistory = () => ({ accountId }) => history.rows.filter(row => row.accountId === accountId);
window.__midnightHistory = rows => { history.rows = rows; history.listeners.forEach(listener => listener(selectHistory())); };
const historyRows$ = { subscribe(listener) { history.listeners.add(listener); listener(selectHistory()); return { unsubscribe() { history.listeners.delete(listener); } }; } };
// Submission outcome: ok, uncertain (Err after broadcast), pre-broadcast (Err before), or held until __settleSubmit.
const submit = async () => {
  effects.push('submit');
  const outcome = mode => mode === 'ok' ? result({ txId: 'mock-node-tx' })
    : mode === 'pre-broadcast' ? failure(Object.assign(new Error('Midnight wallet did not start'), { code: 'midnight-wallet-not-ready' }))
    : failure(Object.assign(new Error('Timeout has occurred'), { name: 'TimeoutError' }));
  const mode = window.__submitMode ?? 'ok';
  return mode === 'held' ? new Promise(resolve => { window.__settleSubmit = settled => resolve(outcome(settled)); }) : outcome(mode);
};
// Each proof gets its own activity hash, in the opaque value's activityHash field: the first ${HASH}, later ones ${HASH2}.
let proofs = 0;
const prove = async () => { effects.push('prove'); const hash = proofs++ ? '${HASH2}' : '${HASH}'; return result({ mock: 'prove', activityHash: hash }); };
export async function restore(words, password, config) {
  const accounts = ['account-0','account-7'].map(accountId => ({ accountId, blockchainName:'Midnight', blockchainNetworkId:'midnight-preview' }));
  const wallet = { dispatch(...args) { effects.push(args[0]); }, stateObservables: {
    addresses: { selectByAccountId$: observable(id => [{ address:'mn_addr_preview_mock', accountId:id }]) },
    midnightContext: { selectPublicKeysByAccountId$: observable(() => ({ coin:'public', encryption:'public' })), selectDustBalanceByAccount$:observable({}), selectDustAvailableByAccount$:observable({}), selectDustGenerationDetails$:observable(() => ({})) },
    sync:{selectSyncStatusByAccount$:observable({})},
    tokens:{ selectAggregatedTokensByAccountId$:observable(() => []), selectTokensMetadata$:observable({}) },
    activities:{ selectByAccountId$:historyRows$, selectActivityDetails$:observable(undefined) }
  } };
  const sdk = { observeMidnightBalances:()=>({subscribe(observer){observer.next({synced:{unshielded:false,shielded:false,dust:false}});return {unsubscribe(){}};}}), AccountId:x=>x, MidnightNetworkId:x=>'midnight-'+x, MIDNIGHT_PUBLIC_ENDPOINTS:{preview:{}}, NIGHT_TOKEN_ID:'night',
    buildMidnightTransfers:call('build'), estimateMidnightFee:call('estimate'), registerMidnightDust:call('register'), signMidnightTx:call('sign'), proveMidnightTx:prove, submitMidnightTx:submit, signMidnightData:call('message'),
    balanceMidnightSealedTransaction:call('sealed'), balanceMidnightUnsealedTransaction:call('unsealed'), makeMidnightTransfer:call('transfer'), makeMidnightIntent:call('intent'),
    getMidnightProvingProvider:async()=>result({check:async()=>{effects.push('check');return [];},prove:async()=>{effects.push('circuit');return new Uint8Array();}})
  };
  return { wallet, entity:{walletId:'mock-wallet',accounts}, sdk, config };
}
export function stopSession() {}
`;
async function mockSession(page: import('@playwright/test').Page) {
  await page.route('**/src/midnight/runtime.ts*', route => route.fulfill({ contentType: 'application/javascript', body: fakeRuntime }));
  await page.goto('/midnight');
  await page.locator('#phrase').fill(Array(12).fill('mock').join(' '));
  await page.locator('#password').fill('mock-only');
  await page.locator('#restore').click();
  await expect(page.locator('#wallet-controls')).toBeVisible();
  await page.locator('#outputs').fill('[{"to":"mock-recipient","tokenId":"mock-token","amount":"1"}]');
}
async function effects(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __midnightEffects: string[] }).__midnightEffects);
}

test('mocked UI: cancel all signing entries and invalidate an open review on changed input/account', async ({ page }) => {
  await mockSession(page);
  await page.locator('#kind').selectOption('dust');
  for (const destination of ['', 'external-mock-dust']) {
    await page.locator('#dust-address').fill(destination);
    await page.locator('#build').click(); await expect(page.locator('#confirmation')).toBeVisible(); await page.locator('#reject').click();
  }
  await page.locator('#kind').selectOption('unshielded');
  await page.locator('#build').click(); await expect(page.locator('#sign')).toBeEnabled();
  await page.locator('#sign').click(); await page.locator('#reject').click();
  await page.locator('summary', { hasText: 'Sign a message' }).click();
  await page.locator('#message').fill('a mock message');
  await page.locator('#message-run').click(); await page.locator('#reject').click();
  for (const kind of ['sealed', 'unsealed', 'transfer', 'intent']) {
    await page.locator('#connector-kind').selectOption(kind);
    await page.locator('#connector-run').click(); await page.locator('#reject').click();
  }
  await page.locator('#build').click(); await expect(page.locator('#sign')).toBeEnabled();
  await page.locator('#sign').click();
  // Simulate a programmatic form edit while the modal holds focus.
  await page.evaluate(() => { const input = document.getElementById('outputs') as HTMLTextAreaElement; input.value = '[]'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#confirmation')).not.toBeVisible();
  await expect(page.locator('#sign')).toBeDisabled();
  await page.locator('#outputs').fill('[{"to":"mock-recipient","tokenId":"mock-token","amount":"1"}]');
  await page.locator('#build').click(); await expect(page.locator('#sign')).toBeEnabled(); await page.locator('#sign').click();
  await page.evaluate(() => { const select = document.getElementById('account') as HTMLSelectElement; select.value = 'account-0'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(page.locator('#confirmation')).not.toBeVisible();
  expect((await effects(page)).filter(name => name !== 'build')).toEqual([]);
});

test('mocked UI: submission requires its own approval; cancellation cannot reuse signed material', async ({ page }) => {
  await mockSession(page);
  await page.locator('#build').click(); await expect(page.locator('#sign')).toBeEnabled();
  await page.locator('#sign').click(); await page.locator('#approve').click();
  await expect(page.locator('#prove')).toBeEnabled(); await page.locator('#prove').click(); await page.locator('#approve').click();
  await expect(page.locator('#submit')).toBeEnabled();
  expect(await effects(page)).toEqual(['build', 'sign', 'prove']);
  await page.locator('#submit').click(); await expect(page.locator('#review-summary')).toContainText('mock-recipient'); await page.locator('#reject').click();
  expect(await effects(page)).toEqual(['build', 'sign', 'prove']);
  await expect(page.locator('#submit')).toBeDisabled();
  await page.locator('#network').selectOption('preprod');
  await expect(page.locator('#wallet-controls')).toBeHidden();
  expect((await effects(page)).filter(name => ['sign', 'submit', 'register'].includes(name))).toEqual(['sign']);
});

test('mocked UI: fee estimation stays unsigned and circuit disclosure can be cancelled', async ({ page }) => {
  await mockSession(page);
  await page.locator('#estimate').click();
  await expect(page.locator('#operation')).toContainText('unsignedEstimate');
  expect(await effects(page)).toEqual(['estimate']);
  await page.locator('summary', { hasText: 'Prove / check a circuit' }).click();
  await page.locator('#key-location').fill('caller-circuit');
  for (const id of ['preimage', 'prover-key', 'verifier-key', 'zkir']) await page.locator(`#${id}`).fill('00');
  for (const kind of ['check', 'prove']) {
    await page.locator('#circuit-kind').selectOption(kind);
    await page.locator('#circuit-run').click();
    await expect(page.locator('#review-summary')).toContainText('caller-circuit');
    await page.locator('#reject').click();
  }
  expect(await effects(page)).toEqual(['estimate']);
});

test('restore clears secret inputs on invalid setup and while another restore is pending', async ({ page }) => {
  await page.route('**/src/midnight/runtime.ts*', route => route.fulfill({ contentType: 'application/javascript', body: 'export const restore = () => new Promise(() => {});' }));
  await page.goto('/midnight');
  await expect(page.locator('#restore-form')).toBeVisible();
  for (const index of ['-1', '0', '0']) {
    const cleared = await page.evaluate(index => {
      const phrase = document.getElementById('phrase') as HTMLTextAreaElement;
      const password = document.getElementById('password') as HTMLInputElement;
      phrase.value = Array(12).fill('synthetic').join(' ');
      password.value = String(123456);
      (document.getElementById('index') as HTMLInputElement).value = index;
      (document.getElementById('restore-form') as HTMLFormElement).requestSubmit();
      return { phrase: phrase.value === '', password: password.value === '' };
    }, index);
    expect(cleared).toEqual({ phrase: true, password: true });
  }
});

async function proveForSubmission(page: import('@playwright/test').Page, mode: 'ok' | 'uncertain' | 'pre-broadcast' | 'held', { restore = true, approve = true } = {}) {
  if (restore) await mockSession(page);
  await page.evaluate(mode => { (window as unknown as { __submitMode: string }).__submitMode = mode; }, mode);
  await page.locator('#build').click(); await expect(page.locator('#sign')).toBeEnabled();
  await page.locator('#sign').click(); await page.locator('#approve').click();
  await expect(page.locator('#prove')).toBeEnabled(); await page.locator('#prove').click(); await page.locator('#approve').click();
  await expect(page.locator('#operation')).toContainText('Proved. Review submission next.');
  await page.locator('#submit').click();
  if (approve) await page.locator('#approve').click();
}
// Rows belong to the restored, selected account-7 unless they name another account.
const publishHistory = (page: import('@playwright/test').Page, rows: { activityId: string; type: string; accountId?: string }[]) =>
  page.evaluate(rows => (window as unknown as { __midnightHistory(rows: unknown[]): void }).__midnightHistory(rows), rows.map(row => ({ accountId: 'account-7', ...row })));
type Submission = { activityHash?: string; stage?: string; sdk?: string; txId?: string };
const submissionRecords = async (page: import('@playwright/test').Page): Promise<Submission[]> => JSON.parse((await page.locator('#submission').textContent())!);
// The newest submission.
const submissionRecord = async (page: import('@playwright/test').Page): Promise<Submission> => (await submissionRecords(page))[0] ?? {};

test('submission-completion, mocked UI: an approved submission reports its identifier and history confirms the hash', async ({ page }) => {
  await proveForSubmission(page, 'ok');
  await expect.poll(async () => (await submissionRecord(page)).stage).toBe('submitted');
  expect(await submissionRecord(page)).toMatchObject({ txId: 'mock-node-tx', activityHash: HASH, sdk: 'returned' });
  await expect(page.locator('#operation')).not.toContainText('Proved');
  await publishHistory(page, [{ activityId: HASH, type: 'Self' }]);
  await expect.poll(async () => (await submissionRecord(page)).stage).toBe('confirmed');
  await expect(page.locator('#status')).toContainText(`Confirmed: history lists transaction ${HASH} (txId mock-node-tx) as Self`);
});

test('submission-completion, mocked UI: submission held past its timeout is confirmed from history; cancel and edits cannot discard it', async ({ page }) => {
  await proveForSubmission(page, 'held');
  // The hash is recorded before the SDK settles.
  await expect.poll(async () => (await submissionRecord(page)).stage).toBe('submitting');
  await expect(page.locator('#submission')).toContainText(HASH);
  for (const id of ['cancel-operation', 'outputs', 'account', 'phrase', 'disconnect', 'build', 'reset']) await expect(page.locator(`#${id}`)).toBeDisabled();
  // Programmatic events bypass disabled controls; the app still refuses to discard.
  await page.evaluate(() => {
    const outputs = document.getElementById('outputs') as HTMLTextAreaElement; outputs.dispatchEvent(new Event('input', { bubbles: true }));
    const account = document.getElementById('account') as HTMLSelectElement; account.value = 'account-0'; account.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('restore-form')!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#account')).toHaveValue('account-7');
  await expect(page.locator('#wallet-controls')).toBeVisible();
  await expect(page.locator('#operation')).not.toContainText('discarded');
  await expect(page.locator('#status')).toContainText('Submission in flight');
  await publishHistory(page, [{ activityId: HASH, type: 'Self' }]);
  await expect.poll(async () => (await submissionRecord(page)).stage).toBe('confirmed');
  expect((await submissionRecord(page)).sdk).toBe('pending');
  await page.evaluate(() => (window as unknown as { __settleSubmit(mode: string): void }).__settleSubmit('uncertain'));
  await expect.poll(async () => (await submissionRecord(page)).sdk).toBe('error');
  expect((await submissionRecord(page)).stage).toBe('confirmed');
  await expect(page.locator('#cancel-operation')).toBeEnabled();
  await expect(page.locator('#operation')).toContainText('Submission settled');
});

test('submission-completion, mocked UI: an SDK error after broadcast shows uncertain with the hash, never discarded', async ({ page }) => {
  await proveForSubmission(page, 'uncertain');
  await expect.poll(async () => (await submissionRecord(page)).stage).toBe('uncertain');
  await expect(page.locator('#status')).toContainText(`Submission uncertain: check history/chain for hash ${HASH}`);
  for (const id of ['operation', 'submission', 'status']) await expect(page.locator(`#${id}`)).not.toContainText('discarded');
  // Cancelling afterwards discards nothing staged and keeps the submission record.
  await page.locator('#cancel-operation').click();
  expect((await submissionRecord(page)).stage).toBe('uncertain');
  await expect(page.locator('#submit')).toBeDisabled();
  expect((await effects(page)).filter(name => name === 'submit')).toEqual(['submit']);
});

test('submission-completion, mocked UI: a failure before broadcast still shows failed', async ({ page }) => {
  await proveForSubmission(page, 'pre-broadcast');
  await expect.poll(async () => (await submissionRecord(page)).stage).toBe('failed');
  await expect(page.locator('#status')).toContainText('Submission failed before broadcast: Midnight wallet did not start');
});

test('submission-completion, mocked UI: uncertain H1 stays listed and named in the H2 review; history still resolves H1', async ({ page }) => {
  await proveForSubmission(page, 'uncertain');
  await expect.poll(async () => (await submissionRecord(page)).stage).toBe('uncertain');
  // A second transfer: its review names the unresolved hash, so approval acknowledges it.
  await page.evaluate(() => { (window as unknown as { __submitMode: string }).__submitMode = 'ok'; });
  await proveForSubmission(page, 'ok', { restore: false, approve: false });
  await expect(page.locator('#review-summary')).toContainText('unresolvedEarlierSubmissions');
  await expect(page.locator('#review-summary')).toContainText(HASH);
  await page.locator('#approve').click();
  await expect.poll(async () => (await submissionRecords(page)).map(r => [r.activityHash, r.stage])).toEqual([[HASH2, 'submitted'], [HASH, 'uncertain']]);
  // Switching account keeps watching the submitting account's history.
  await page.locator('#account').selectOption('account-0');
  // The same hash under another account must not resolve it.
  await publishHistory(page, [{ activityId: HASH, type: 'Self', accountId: 'account-0' }]);
  await expect(page.locator('#history')).toContainText(HASH);
  expect((await submissionRecords(page)).map(r => r.stage)).toEqual(['submitted', 'uncertain']);
  await publishHistory(page, [{ activityId: HASH, type: 'Self' }]);
  await expect.poll(async () => (await submissionRecords(page)).map(r => [r.activityHash, r.stage])).toEqual([[HASH2, 'submitted'], [HASH, 'confirmed']]);
  // The record resolves; the status line keeps the newest submission (H2) and names H1 only in the list.
  await expect(page.locator('#submission')).toContainText(`Confirmed: history lists transaction ${HASH} as Self`);
  await expect(page.locator('#status')).toContainText(`Awaiting history confirmation of hash ${HASH2}`);
});
