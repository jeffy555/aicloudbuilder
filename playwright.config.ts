import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

// Load .env so E2E tests can access GITHUB_TOKEN, GITHUB_OWNER etc.
loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Shared path for saved authentication state (localStorage token). */
export const STORAGE_STATE = path.join(__dirname, 'e2e/.auth/user.json');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:9005',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    // ── Step 1: create test user & persist auth state ─────────────────────────
    {
      name: 'setup',
      testMatch: /global\.setup\.ts/,
    },

    // ── Step 2a: authenticated workflow tests (fast, no AI calls) ────────────
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: STORAGE_STATE,
      },
      dependencies: ['setup'],
      // auth.spec.ts uses its own project; full-workflow is run separately
      testIgnore: [/auth\.spec\.ts/, /terraform-full-workflow\.spec\.ts/, /terraform-aggregated-workflow\.spec\.ts/, /terraform-child-workflow\.spec\.ts/],
      testMatch: /specs\/.*\.spec\.ts/,
    },

    // ── Step 2c: real E2E full workflow (uses AI tokens, ~5–10 min) ───────────
    {
      name: 'setup-full',
      testMatch: /global\.setup\.full\.ts/,
      // Always headless — auth setup should never pop a visible browser window,
      // even when the parent command is run with --headed.
      use: { headless: true },
    },
    {
      name: 'full-workflow',
      use: {
        ...devices['Desktop Chrome'],
        storageState: path.join(__dirname, 'e2e/.auth/full-user.json'),
        // Capture video + screenshot for every run (used in the HTML report)
        video: 'on',
        screenshot: 'on',
      },
      dependencies: ['setup-full'],
      testMatch: /specs\/terraform-(full|aggregated|child)-workflow\.spec\.ts/,
    },

    // ── Step 2b: auth-flow tests (no stored state) ────────────────────────────
    {
      name: 'auth-flows',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /specs\/auth\.spec\.ts/,
    },
  ],

  // Reuse a running dev server locally; start fresh on CI.
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:9005',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
