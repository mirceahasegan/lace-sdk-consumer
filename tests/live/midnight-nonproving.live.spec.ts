import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { verifySignature } from '@midnight-ntwrk/ledger-v8';
import { parseTestWallet, waitForPublicReady, withinPublicDeadline } from './wallet-input';
import { CHECKS, MESSAGE, REGISTRATION_HASH, nonprovingBlockedURLs, dustObservation, signatureChecks, type Check, type Outcome } from './nonproving-observations';

// One live browser session; never register/prove/submit/spend.
test.skip(process.env.MIDNIGHT_LIVE !== 'preview' || !process.env.MIDNIGHT_TEST_WALLET_FILE, 'Requires explicit Preview and disposable wallet file path.');
test('packaged Preview non-proving checks share one restore; bounded resync runs last', async ({ page }, testInfo) => {
  if (process.env.MIDNIGHT_LIVE_REGISTER || process.env.MIDNIGHT_LIVE_TRANSFER) throw new Error('Non-proving suite requires REGISTER and TRANSFER unset.');
  test.setTimeout(1_800_000);
  const outcomes = Object.fromEntries(CHECKS.map(key => [key, 'not-run'])) as Record<Check, Outcome>;
  let blockedRequests = 0;
  let restoredUnshieldedAddress: string;
  let dust: ReturnType<typeof dustObservation> | undefined;
  const read = (id: string) => page.evaluate(id => {
    try { return JSON.parse(document.getElementById(id)?.textContent ?? 'null'); } catch { return null; }
  }, id);
  const click = (id: string) => page.evaluate(id => { (document.getElementById(id) as HTMLButtonElement).click(); }, id);
  const check = async (name: Check, action: () => Promise<Outcome | void>) => {
    try { const result = await action(); outcomes[name] = result === undefined ? 'pass' : result as Outcome; }
    catch (error) { outcomes[name] = error instanceof Error && error.message === 'PUBLIC_WAIT_TIMEOUT' ? 'timeout' : 'failed'; }
  };
  const wait = async (ready: () => Promise<boolean>, timeout = 60_000) => waitForPublicReady(async () => ({ stage: (await read('initialization'))?.stage, ready: await ready() }), timeout, 'PUBLIC_WAIT_TIMEOUT');
  const synced = async () => { const s = (await read('balances'))?.synced; return s?.unshielded === true && s?.shielded === true && s?.dust === true; };
  const forbidden = nonprovingBlockedURLs(new URL(String(testInfo.project.use.baseURL)).origin);
  await page.route(forbidden, route => {
    blockedRequests++; return route.abort();
  });
  await page.routeWebSocket(forbidden, socket => {
    blockedRequests++; return socket.close();
  });
  try {
    await check('restore', async () => {
      let wallet;
      try { wallet = parseTestWallet(JSON.parse(await readFile(process.env.MIDNIGHT_TEST_WALLET_FILE!, 'utf8'))); }
      catch { throw new Error('Disposable Preview input unavailable.'); }
      try {
        await page.goto('/midnight');
        await page.waitForFunction(() => !!document.getElementById('restore-form'));
        const cleared = await page.evaluate(({ mnemonicWords, password, accountIndex }) => {
          const phrase = document.getElementById('phrase') as HTMLTextAreaElement;
          const secret = document.getElementById('password') as HTMLInputElement;
          try {
            phrase.value = mnemonicWords.join(' '); secret.value = password;
            (document.getElementById('index') as HTMLInputElement).value = String(accountIndex);
            (document.getElementById('network') as HTMLSelectElement).value = 'preview';
            // Same Preview state/config; a local prover is never contacted by these checks.
            (document.getElementById('prover') as HTMLSelectElement).value = 'local';
            (document.getElementById('restore-form') as HTMLFormElement).requestSubmit();
            return phrase.value === '' && secret.value === '';
          } catch { return false; }
          finally { phrase.value = ''; secret.value = ''; mnemonicWords.fill(''); }
        }, wallet);
        if (!cleared) throw new Error('Secret clearing failed.');
        await wait(async () => (await read('balances'))?.address?.unshielded === wallet.address, 240_000);
        await wait(synced, 600_000);
        // Capture the address already matched to the disposable wallet input; never trust a signing result's key alone.
        restoredUnshieldedAddress = wallet.address;
      } finally { wallet.mnemonicWords.fill(''); wallet.password = ''; }
    });
    if (outcomes.restore === 'pass') {
      await page.locator('summary', { hasText: 'Sign a message' }).click();
      await check('cancel-message', async () => {
        await page.locator('#message').fill(MESSAGE);
        await click('message-run');
        await wait(async () => page.locator('#confirmation').isVisible());
        await click('reject');
        if (!await page.evaluate(() => document.getElementById('message-result')?.textContent === 'No signature.' && !(document.getElementById('confirmation') as HTMLDialogElement).open)) throw new Error('Cancellation failed.');
      });
      const bytes = Buffer.from(MESSAGE, 'utf8');
      for (const encoding of ['text', 'hex', 'base64'] as const) await check(`sign-${encoding}`, async () => {
        const data = encoding === 'text' ? MESSAGE : bytes.toString(encoding);
        await page.locator('#encoding').selectOption(encoding); await page.locator('#message').fill(data);
        // Clear only the public display to avoid accepting a previous signature after failure.
        await page.evaluate(() => { document.getElementById('message-result')!.textContent = 'No signature.'; });
        await click('message-run'); await wait(async () => page.locator('#confirmation').isVisible());
        await click('approve'); await wait(async () => !!(await read('message-result'))?.signature);
        const result = await read('message-result');
        const verified = signatureChecks(result.signature, result.verifyingKey, verifySignature, restoredUnshieldedAddress);
        if (result.data !== data || !verified.valid || !verified.rawRejected || !verified.alteredRejected) throw new Error('Signature verification failed.');
        // Never attach payload/signature/key or persist them in evidence.
      });
      await check('dust', async () => {
        dust = dustObservation(await read('dust'));
        if (!dust.balancePresent || !dust.generationPresent || !dust.positive) return 'prerequisite-missing';
      });
      await page.locator('summary', { hasText: 'History and token display names' }).click();
      await check('registration-details', async () => {
        const rows = await read('history');
        const index = Array.isArray(rows) ? rows.findIndex(row => row.activityId === REGISTRATION_HASH && row.type === 'Self') : -1;
        if (index < 0) return 'prerequisite-missing';
        const account = await page.locator('#account').inputValue();
        await page.locator('#activity').selectOption(String(index)); await click('details');
        await wait(async () => (await read('activity-details'))?.activityId === REGISTRATION_HASH);
        const detail = await read('activity-details');
        if (detail.accountId !== account || detail.type !== 'Self' || !(detail.timestamp > 0) || !detail.address || !/^[0-9]+$/.test(detail.fee)) throw new Error('Confirmed details incomplete.');
      });
      await check('unsigned-estimate', async () => {
        const state = await read('balances');
        if (!state?.nightTokenId || !state?.address?.unshielded || BigInt(state.night.available) < 1n || BigInt(state.dust.available) <= 0n) return 'prerequisite-missing';
        await page.locator('#kind').selectOption('unshielded');
        await page.locator('#outputs').fill(JSON.stringify([{ to: state.address.unshielded, tokenId: state.nightTokenId, amount: '1' }]));
        await click('estimate'); await wait(async () => !!(await read('operation'))?.unsignedEstimate, 120_000);
        const fee = (await read('operation')).unsignedEstimate;
        if (!/^[0-9]+$/.test(fee.dustFee) || !/^[0-9]+$/.test(fee.availableDust) || BigInt(fee.dustFee) > BigInt(fee.availableDust)) throw new Error('Unsigned fee unavailable.');
        if (!await page.evaluate(() => !(document.getElementById('confirmation') as HTMLDialogElement).open && ['sign', 'prove', 'submit'].every(id => (document.getElementById(id) as HTMLButtonElement).disabled))) throw new Error('Estimate entered signing stages.');
      });
      await check('native-rename', async () => {
        const tokenId = (await read('balances'))?.nightTokenId;
        if (!await page.evaluate(id => Array.from((document.getElementById('token') as HTMLSelectElement).options).some(o => o.value === id), tokenId)) return 'prerequisite-missing';
        await page.locator('#token').selectOption(tokenId);
        const before = await page.evaluate(() => document.getElementById('token')!.textContent);
        await page.locator('#token-name').fill('Disposable rename check'); await page.locator('#ticker').fill('TEST'); await click('rename');
        if (!await page.evaluate(before => document.getElementById('status')?.textContent?.includes('Native/reserved tokens cannot be renamed.') === true && document.getElementById('token')!.textContent === before, before)) throw new Error('Native rename rejection failed.');
      });
      await check('resync', async () => {
        // A hung key/fee operation may still be running; do not reset underneath it.
        if (['sign-text', 'sign-hex', 'sign-base64', 'unsigned-estimate'].some(key => outcomes[key as Check] === 'timeout')) return 'prerequisite-missing';
        await resyncLast(page, wait, synced);
      });
    }
  } finally {
    await withinPublicDeadline(() => page.evaluate(() => { for (const id of ['phrase', 'password']) { const input = document.getElementById(id) as HTMLInputElement | null; if (input) input.value = ''; } (document.getElementById('disconnect') as HTMLButtonElement | null)?.click(); }), 5_000, 'PUBLIC_CLEANUP_TIMEOUT').catch(() => {});
    await testInfo.attach('preview-nonproving-results', { body: JSON.stringify({ outcomes, blockedRequests, dust }), contentType: 'application/json' });
  }
  expect(blockedRequests, 'No unexpected/proving network request may be attempted.').toBe(0);
  expect(CHECKS.every(key => outcomes[key] === 'pass'), 'Any failed, timed out, unrun or missing-prerequisite check keeps non-proving acceptance open; see fixed observation attachment.').toBe(true);
});

async function resyncLast(page: Page, wait: (ready: () => Promise<boolean>, timeout?: number) => Promise<void>, synced: () => Promise<boolean>) {
  const before = await page.evaluate(() => {
    const read = (id: string) => { try { return JSON.parse(document.getElementById(id)?.textContent ?? 'null'); } catch { return null; } };
    return { lastSuccessfulSync: read('sync')?.lastSuccessfulSync ?? 0, address: read('balances')?.address?.unshielded, keys: document.getElementById('keys')?.textContent };
  });
  // Observe reset and a fresh Pending operation, rather than accepting cached completion.
  await page.evaluate(() => {
    const read = (id: string) => { try { return JSON.parse(document.getElementById(id)?.textContent ?? 'null'); } catch { return null; } };
    const account = (document.getElementById('account') as HTMLSelectElement).value;
    const operationId = `${account}-midnight-sync`;
    const previous = read('sync')?.pendingSync?.operations?.[operationId]?.startedAt;
    const observation = { freshPending: false, cleared: false };
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const removed of record.removedNodes) {
          try {
            const state = JSON.parse(removed.textContent ?? 'null');
            if ((record.target as HTMLElement).id === 'addresses' && Array.isArray(state) && state.length === 0) observation.cleared = true;
            const op = state?.pendingSync?.operations?.[operationId];
            if (op?.status === 'Pending' && op.startedAt !== previous) observation.freshPending = true;
          } catch { /* fixed booleans only */ }
        }
      }
      const addresses = read('addresses'); if (Array.isArray(addresses) && addresses.length === 0) observation.cleared = true;
      const op = read('sync')?.pendingSync?.operations?.[operationId];
      if (op?.status === 'Pending' && op.startedAt !== previous) observation.freshPending = true;
    });
    observer.observe(document.getElementById('addresses')!, { childList: true });
    observer.observe(document.getElementById('sync')!, { childList: true });
    (window as unknown as { nonprovingReset: { observation: typeof observation; stop(): void } }).nonprovingReset = { observation, stop: () => observer.disconnect() };
    (document.getElementById('reset') as HTMLButtonElement).click();
  });
  try {
    await wait(() => page.evaluate(() => { const o = (window as unknown as { nonprovingReset: { observation: { freshPending: boolean; cleared: boolean } } }).nonprovingReset.observation; return o.freshPending && o.cleared; }), 60_000);
    await wait(async () => await synced() && await page.evaluate(before => {
      try {
        const sync = JSON.parse(document.getElementById('sync')?.textContent ?? 'null');
        const balances = JSON.parse(document.getElementById('balances')?.textContent ?? 'null');
        return sync?.lastSuccessfulSync > before.lastSuccessfulSync && !sync.pendingSync && balances?.address?.unshielded === before.address && document.getElementById('keys')?.textContent === before.keys;
      } catch { return false; }
    }, before), 360_000);
  } finally {
    await withinPublicDeadline(() => page.evaluate(() => { (window as unknown as { nonprovingReset?: { stop(): void } }).nonprovingReset?.stop(); }), 5_000, 'PUBLIC_CLEANUP_TIMEOUT').catch(() => {});
  }
}
