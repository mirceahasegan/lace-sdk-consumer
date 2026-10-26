import { test, expect, type Page } from '@playwright/test';

// Worker mode without a chain: the settings the page offers, what it refuses before any restore, the text
// field that stays usable, and a browser without SharedWorker. Nothing here reaches a node, an indexer or
// a proof server; the live suite (tests/live/midnight-worker.live.spec.ts) runs the engine.

/** Refuses and records every request and WebSocket that leaves the dev server's origin. */
async function refuseRemote(page: Page, baseURL: string) {
  const remote: string[] = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL).origin) { remote.push(`${route.request().method()} ${url.origin}${url.pathname}`); return route.abort(); }
    return route.continue();
  });
  await page.routeWebSocket('**/*', socket => {
    // Vite's own HMR socket is infrastructure, not a wallet provider.
    if (new URL(socket.url()).host === new URL(baseURL).host) { socket.connectToServer(); return; }
    remote.push(`WS ${socket.url().split('?')[0]}`); socket.close();
  });
  return () => [...remote];
}

test('Worker mode settings are offered, and Temenos with Worker mode is refused before any restore', async ({ page, baseURL }) => {
  const remote = await refuseRemote(page, baseURL!);
  await page.goto('/midnight');
  await expect(page.locator('#engine')).toHaveValue('page');
  await expect(page.locator('#engine option')).toHaveText(['This page', 'SharedWorker (Worker mode)']);
  await expect(page.locator('#worker-storage option')).toHaveText(['Memory, while the worker runs', 'IndexedDB, across sessions']);
  await expect(page.locator('#worker-adopt')).not.toBeChecked();
  await page.locator('#phrase').fill(Array(24).fill('synthetic').join(' '));
  await page.locator('#password').fill('synthetic-only');
  await page.locator('#prover').selectOption('temenos');
  await page.locator('#engine').selectOption('worker');
  await page.locator('#restore').click();
  await expect(page.locator('#status')).toHaveText('Restore refused: Worker mode proves only through a proof server URL. Select the local proof server, or run the engine on this page for Temenos.');
  await expect(page.locator('#wallet-controls')).toBeHidden();
  await expect(page.locator('#initialization')).toHaveText(/restore-failed/);
  await expect(page.locator('#phrase')).toHaveValue('');
  await expect(page.locator('#password')).toHaveValue('');
  expect(remote()).toEqual([]);
});

test('the scratch text field echoes what is typed and touches no form', async ({ page, baseURL }) => {
  await refuseRemote(page, baseURL!);
  await page.goto('/midnight');
  await page.locator('#network').selectOption('preprod');
  await page.locator('#scratch').pressSequentially('still usable');
  await expect(page.locator('#scratch-echo')).toHaveText('12 characters: still usable');
  // Outside the restore form, so typing neither clears nor changes the setup.
  await expect(page.locator('#network')).toHaveValue('preprod');
  await expect(page.locator('#status')).toContainText('No wallet loaded');
  await page.locator('#scratch').fill('');
  await expect(page.locator('#scratch-echo')).toHaveText('Nothing typed.');
});

test('without SharedWorker, Worker mode returns MidnightWorkerUnsupportedError and never runs the engine on the page', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  // A fresh throwaway phrase for this run: never funded, never stored.
  const { util } = await import('@laceio/cardano/key-management');
  const words: string[] = util.generateMnemonicWords();
  await page.addInitScript(() => { Object.defineProperty(window, 'SharedWorker', { value: undefined, configurable: true, writable: true }); });
  const remote = await refuseRemote(page, baseURL!);
  await page.goto('/midnight');
  // bootstrap imports the app asynchronously; navigation alone is not app readiness.
  await expect(page.locator('#restore-form')).toBeVisible();
  await page.evaluate(words => {
    const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    field<HTMLTextAreaElement>('phrase').value = words.join(' ');
    field<HTMLInputElement>('password').value = 'throwaway-session';
    field<HTMLSelectElement>('network').value = 'undeployed';
    field<HTMLInputElement>('node').value = 'http://localhost:9944';
    field<HTMLInputElement>('indexer').value = 'http://localhost:8088/api/v4/graphql';
    field<HTMLSelectElement>('engine').value = 'worker';
    field<HTMLFormElement>('restore-form').requestSubmit();
  }, words);
  words.fill('');
  await expect(page.locator('#wallet-controls')).toBeVisible({ timeout: 120_000 });
  expect(JSON.parse((await page.locator('#configuration').textContent())!)).toMatchObject({ network: 'undeployed', engine: 'worker', workerStorage: 'memory', adopt: false });
  await expect.poll(async () => { try { return JSON.parse((await page.locator('#readiness').textContent())!).error; } catch { return undefined; } }, { timeout: 60_000 })
    .toBe('MidnightWorkerUnsupportedError [midnight-worker-unsupported]');
  await expect(page.locator('#status')).toContainText('This browser cannot run Worker mode');
  // An operation that needs the engine returns the same error. A valid NIGHT output to a valid address (NIGHT's
  // raw token type is 64 zeros), so only the engine can refuse the call.
  const { MidnightBech32m, UnshieldedAddress } = await import('@midnightntwrk/wallet-sdk-address-format');
  const to = MidnightBech32m.encode('undeployed', new UnshieldedAddress(Buffer.alloc(32, 7))).asString();
  await page.locator('#outputs').fill(JSON.stringify([{ to, tokenId: `unshielded-undeployed${'0'.repeat(64)}`, amount: '1' }]));
  await page.locator('#estimate').click();
  await expect(page.locator('#status')).toContainText('Operation failed: MidnightWorkerUnsupportedError [midnight-worker-unsupported]');
  // No fallback: the page opened no connection to the chain or the proof server.
  expect(remote()).toEqual([]);
  await page.locator('#disconnect').click();
});
