import { test, expect } from '@playwright/test';

test('Temenos scoped fetch uses same-origin transport and refuses static fallback in a browser', async ({ page, baseURL }) => {
  const remote: string[] = [];
  const requests: { path: string; method: string; cookie?: string; body: string | null }[] = [];
  let backend = true;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL!).origin) { remote.push(url.origin); return route.abort(); }
    if (url.pathname.startsWith('/temenos-relay/')) {
      requests.push({ path: url.pathname, method: route.request().method(),
        cookie: route.request().headers().cookie, body: route.request().postData() });
      return route.fulfill(backend ? { status: 409, headers: { 'x-lace-temenos-relay': '1' }, body: '{"error":"fixture"}' }
        : { status: 200, contentType: 'text/html', body: '<html>static fallback</html>' });
    }
    return route.continue();
  });
  await page.goto('/tests/e2e/runtime-probe.html');
  await page.context().addCookies([{ name: 'synthetic-session', value: 'must-not-reach-relay', url: baseURL! }]);
  const result = await page.evaluate(async () => {
    const modulePath = '/src/midnight/temenos-fetch.ts';
    const { createTemenosFetch } = await import(/* @vite-ignore */ modulePath);
    const original = globalThis.fetch;
    const fetchImpl = createTemenosFetch();
    const upstream = 'https://attestation.proofserver.preview.wastedp.io';
    const statuses = [];
    for (const path of ['/attestation.json', '/tee_attestation/enclave-key']) statuses.push((await fetchImpl(upstream + path)).status);
    for (const path of ['/session', '/session/complete', '/proxy']) statuses.push((await fetchImpl(upstream + '/tee_attestation' + path,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"synthetic":"transport-only"}' })).status);
    for (const url of ['https://indexer.preprod.midnight.network/api/v4/graphql', 'https://warden.wastedp.io/dapps/verify_attestation']) {
      statuses.push((await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"synthetic":"transport-only"}' })).status);
    }
    return { statuses, globalUnchanged: globalThis.fetch === original };
  });
  expect(result).toEqual({ statuses: [409, 409, 409, 409, 409, 409, 409], globalUnchanged: true });
  expect(requests).toHaveLength(7);
  expect(requests.slice(5).map(request => request.path)).toEqual(['/temenos-relay/ledger/contract-state', '/temenos-relay/warden/verify-attestation']);
  expect(requests.every(request => request.cookie === undefined)).toBe(true);
  expect(requests.slice(2).every(request => request.method === 'POST' && request.body === '{"synthetic":"transport-only"}')).toBe(true);
  backend = false;
  const error = await page.evaluate(async () => {
    const modulePath = '/src/midnight/temenos-fetch.ts';
    const { createTemenosFetch } = await import(/* @vite-ignore */ modulePath);
    try { await createTemenosFetch()('https://attestation.proofserver.preview.wastedp.io/attestation.json'); return 'unexpected success'; }
    catch (error) { return String(error); }
  });
  expect(error).toContain('Temenos relay unavailable');
  expect(remote).toEqual([]);
});
