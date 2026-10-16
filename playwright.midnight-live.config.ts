import { defineConfig } from '@playwright/test';
import base from './playwright.config';

process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

// Separate opt-in execution: never capture secrets in artifacts.
export default defineConfig({
  ...base,
  testDir: './tests/live',
  timeout: 1_200_000,
  // Runner-level deadline also bounds a worker whose event loop stops servicing timers.
  globalTimeout: 2_100_000,
  retries: 0,
  // Disable Playwright's automatic DOM snapshot on assertion failure as well.
  captureGitInfo: { commit: false, diff: false },
  reporter: [['line']],
  use: { ...base.use, trace: 'off', screenshot: 'off', video: 'off' },
});
