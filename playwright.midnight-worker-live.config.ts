import { defineConfig } from '@playwright/test';

process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

// Worker mode, live: the same scenarios against the Vite development server and against `vite build`
// served by `vite preview`. Opt-in like the live suite, and like it never captures secrets in artifacts.
const devPort = Number(process.env.WORKER_LIVE_DEV_PORT ?? 5196);
const previewPort = Number(process.env.WORKER_LIVE_PREVIEW_PORT ?? 5197);
// Its own build directory, so `npm run build` and the runtime check keep `dist`.
const outDir = 'dist-worker-live';
const env = {
  VITE_BLOCKFROST_PROJECT_ID_PREPROD: 'playwright-fixture',
  VITE_PASSKEY_SIGNER_URL: 'https://passkey-preview.lace.io',
  // Override any .env values: the sponsor relay holds no key and forwards nothing.
  SPONSOR_URL: 'http://127.0.0.1:9',
  SPONSOR_API_KEY: '',
};

export default defineConfig({
  testDir: './tests/live',
  testMatch: 'midnight-worker.live.spec.ts',
  // A fresh Preview sync took about ten minutes; one scenario run may take up to 45 minutes.
  timeout: 2_700_000,
  expect: { timeout: 20_000 },
  // Two transfer runs on Preview, sequentially, plus the builds: a runner-level deadline above both.
  globalTimeout: 6_600_000,
  retries: 0,
  // One wallet: scenarios run one at a time, never two transfers at once.
  workers: 1,
  fullyParallel: false,
  // Disable Playwright's automatic DOM snapshot on assertion failure as well.
  captureGitInfo: { commit: false, diff: false },
  reporter: [['line'], ['json', { outputFile: process.env.WORKER_LIVE_JSON ?? 'playwright-report/midnight-worker-live.json' }]],
  use: { browserName: 'chromium', trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'dev', use: { baseURL: `http://localhost:${devPort}` } },
    { name: 'preview', use: { baseURL: `http://localhost:${previewPort}` } },
  ],
  webServer: [
    {
      command: `npm run dev -- --host localhost --port ${devPort} --strictPort`,
      url: `http://localhost:${devPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env,
    },
    {
      command: `npm run build -- --outDir ${outDir} --emptyOutDir && npm run preview -- --outDir ${outDir} --host localhost --port ${previewPort} --strictPort`,
      url: `http://localhost:${previewPort}`,
      reuseExistingServer: false,
      timeout: 600_000,
      env,
    },
  ],
});
