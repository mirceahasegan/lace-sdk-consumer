import { test, expect } from '@playwright/test';
import { observeProvingRelay } from './proving-diagnostics';

test('wallet-free Temenos attestation and channel preflight', async ({ page, baseURL }, testInfo) => {
  test.skip(process.env.TEMENOS_LIVE_PREFLIGHT !== '1', 'Explicit wallet-free live preflight opt-in required');
  test.setTimeout(180_000);
  // The live config disables traces, video, screenshots and automatic snapshots.
  // The browser must use the real same-origin relay; no external browser fetch.
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL!).origin
    ? route.continue() : route.abort());
  let report: { result: string; phases: { phase: string; status: string }[]; failureStage: string } = { result: 'browser-failed', phases: [], failureStage: 'browser' };
  let relay: ReturnType<typeof observeProvingRelay> | undefined;
  try {
    await page.goto('/tests/e2e/runtime-probe.html');
    relay = observeProvingRelay(page);
    report = await page.evaluate(async () => {
      const phases: { phase: string; status: string }[] = [];
      const allowed = ['obtain-evidence', 'fetch-expected-values', 'verify-locally', 'warden-verify', 'bind-channel'];
      let session: { close(): Promise<void> } | undefined;
      let result = 'failed';
      let failureStage = 'setup';
      try {
        const factoryPath = '/src/midnight/temenos-provider.ts';
        const configPath = '/src/midnight/config.ts';
        const transportPath = '/src/midnight/temenos-transport.ts';
        const { createConsumerTemenosProver } = await import(/* @vite-ignore */ factoryPath);
        const { TEMENOS_URL } = await import(/* @vite-ignore */ configPath);
        const { TEMENOS_ROUTES } = await import(/* @vite-ignore */ transportPath);
        // Wallet-free equivalent of the SDK's Preprod network-config resolver.
        // The pin test checks this route against MIDNIGHT_PUBLIC_ENDPOINTS.
        const indexerUrl = TEMENOS_ROUTES.find((route: { kind: string }) => route.kind === 'ledger').source;
        const provider = createConsumerTemenosProver({ networkId: 'preview', proofServerApiUrl: TEMENOS_URL,
          getLedgerIndexerUrl: async () => indexerUrl });
        session = await provider.establishAttestedSession((event: { type: string; phase: string; status: string }) => {
          if (event.type === 'phase' && allowed.includes(event.phase) && ['started', 'completed', 'failed'].includes(event.status)) {
            phases.push({ phase: event.phase, status: event.status });
            failureStage = event.phase;
          }
        });
        result = allowed.every(phase => phases.some(event => event.phase === phase && event.status === 'completed')) &&
          !phases.some(event => event.status === 'failed') ? 'passed' : 'incomplete';
        if (result === 'passed') failureStage = 'none';
      } catch { result = 'failed'; }
      finally {
        try { await session?.close(); } catch { result = 'close-failed'; failureStage = 'close'; }
      }
      // Fixed classifications only: never raw reports, errors, URLs, or key material.
      return { result, phases, failureStage };
    });
  } catch { /* Do not serialize browser errors or page contents. */ }
  await testInfo.attach('temenos-preflight-public-result', { body: JSON.stringify(report), contentType: 'application/json' });
  if (relay) await testInfo.attach('temenos-preflight-relay', { body: JSON.stringify(await relay.stop()), contentType: 'application/json' });
  expect(report.result, 'Wallet-free attestation preflight failed; inspect fixed phase/status attachment').toBe('passed');
});
