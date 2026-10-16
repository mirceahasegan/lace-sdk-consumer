import { test, expect } from '@playwright/test';

test('actual packaged Midnight runtime executes address codecs and WASM; Node transports fail closed', async ({ page, baseURL }) => {
  const remote: string[] = [];
  const pageErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failedResponses.push(response.url()); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL!).origin) { remote.push(url.origin); return route.abort(); }
    return route.continue();
  });
  await page.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    // Vite's same-server HMR socket is infrastructure, not a wallet provider.
    if (url.host === new URL(baseURL!).host) { socket.connectToServer(); return; }
    remote.push(socket.url()); socket.close();
  });
  await page.goto('/tests/e2e/runtime-probe.html');
  await page.locator('#load').click();
  await expect(page.locator('#result')).not.toBeEmpty({ timeout: 60_000 });
  expect(JSON.parse(await page.locator('#result').innerText())).toEqual({
    runtime: 'function', lazyModules: ['function', 'function', 'function'],
    engines: [true, true, true, true, true, true],
    wasm: [true, true], insecureRefused: true, nodeRefused: true, forbiddenFetchCalls: 0,
    addresses: {
      dust: [true, true, true, true, true, true, true, true, true], dust64ScaleHex: '0101',
      shielded: true, unshielded: true, negativeDustRejected: true,
      shieldedTextLength: 132, shieldedStringRoundtrip: true,
      invalidShieldedChecksumRejected: true, invalidShieldedPayloadRejected: true,
      wrongShieldedNetworkRejected: true, wrongShieldedTypeRejected: true,
      oversizedDustRejected: true, invalidUnshieldedRejected: true,
      wrongNetworkRejected: true, invalidDustPayloadRejected: true,
    },
    zkir: ['function', 'function'],
    secureTransport: true, secureFetchCalls: 2, akxTransport: true, akxFetchCalls: 2,
    httpRefused: true, invalidNonceRejected: true, roots: 2,
  });
  expect(remote).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});
