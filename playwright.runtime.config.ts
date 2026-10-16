import { defineConfig } from '@playwright/test';

const port = process.env.E2E_PORT ?? '5199';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'runtime.spec.ts',
  timeout: 90_000,
  workers: 1,
  use: { browserName: 'chromium', baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: `npm run build -- --mode browser-runtime && npm run preview -- --host localhost --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { SPONSOR_URL: 'http://127.0.0.1:9', SPONSOR_API_KEY: '' },
  },
});
