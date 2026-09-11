import { defineConfig, devices } from '@playwright/test'

const PORT = 3100
const BASE_URL = `http://localhost:${String(PORT)}`

/*
 * A second instance of the same build, running with no tutor at all.
 *
 * The degraded path has to be exercised against a server that genuinely cannot reach a model,
 * and it cannot be exercised by unsetting an API key: `next start` reads .env.local, so what is
 * configured on the machine running the suite would decide whether the test means anything.
 * `LLM_PROVIDER=none` says it explicitly instead.
 */
const OFFLINE_PORT = 3101
export const OFFLINE_BASE_URL = `http://localhost:${String(OFFLINE_PORT)}`

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
  webServer: [
    {
      // Tested against a production build rather than `next dev`: it is what a learner
      // actually runs, it has no HMR client that can interfere with hydration, and it means
      // a broken build fails the end-to-end gate too. The build itself happens in the
      // `test:e2e` script, before Playwright starts — both servers below serve the same
      // output, and two Turbopack builds racing into one `.next` directory would not.
      command: `npm run start -- --port ${String(PORT)}`,
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        // End-to-end runs never touch the real learner database or a real model.
        DATABASE_PATH: 'data/e2e.db',
        LLM_PROVIDER: 'mock',
      },
    },
    {
      command: `npm run start -- --port ${String(OFFLINE_PORT)}`,
      url: OFFLINE_BASE_URL,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        DATABASE_PATH: 'data/e2e-offline.db',
        LLM_PROVIDER: 'none',
      },
    },
  ],
})
