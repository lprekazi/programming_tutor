import { defineConfig, devices } from '@playwright/test'

const PORT = 3100
const BASE_URL = `http://localhost:${String(PORT)}`

export default defineConfig({
  testDir: './e2e',
  // Pyodide loads ~13 MB on the first run in a fresh browser profile.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: process.env['CI'] === 'true',
  retries: 0,
  workers: 1,
  reporter: process.env['CI'] === 'true' ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Tested against a production build rather than `next dev`: it is what a learner
    // actually runs, it has no HMR client that can interfere with hydration, and it means
    // a broken build fails the end-to-end gate too.
    command: `npm run build && npm run start -- --port ${String(PORT)}`,
    url: BASE_URL,
    // Always rebuild, so the suite can never pass against stale output.
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      // End-to-end runs never touch the real learner database or a real model.
      DATABASE_PATH: 'data/e2e.db',
      LLM_PROVIDER: 'mock',
    },
  },
})
