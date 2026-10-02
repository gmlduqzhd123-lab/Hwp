import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const basePath = process.env.E2E_BASE_PATH ?? process.env.PAGES_BASE_PATH ?? '/Hwp/';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 2,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:4173${basePath}`,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    },
  },
  webServer: {
    command: 'npm run preview',
    url: `http://127.0.0.1:4173${basePath}`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
