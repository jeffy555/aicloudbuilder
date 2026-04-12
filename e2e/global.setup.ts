/**
 * global.setup.ts
 *
 * Runs once before any authenticated test project.
 * Creates (or reuses) a dedicated E2E test user, obtains a JWT via the login
 * API, injects it into localStorage, then persists the browser storage state
 * so every authenticated test starts already logged in.
 */
import { test as setup, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE = path.join(__dirname, '.auth/user.json');

const TEST_USER = {
  username: process.env.E2E_USERNAME ?? 'e2e_playwright',
  email:    process.env.E2E_EMAIL    ?? 'e2e_playwright@test.local',
  password: process.env.E2E_PASSWORD ?? 'E2eTest1!',
};

setup('create test user and save auth state', async ({ page, request }) => {
  // Ensure the .auth directory exists
  fs.mkdirSync(path.dirname(STORAGE_STATE), { recursive: true });

  // ── 1. Try to sign up (idempotent — ignore "already exists" errors) ────────
  await request.post('/api/auth/signup', {
    data: {
      username: TEST_USER.username,
      email:    TEST_USER.email,
      password: TEST_USER.password,
    },
  });
  // We intentionally ignore the response status here: a 409/400 "already
  // exists" error is fine — the account was created in a previous run.

  // ── 2. Login via API to obtain a fresh JWT ─────────────────────────────────
  const loginRes = await request.post('/api/auth/login', {
    data: {
      usernameOrEmail: TEST_USER.username,
      password:        TEST_USER.password,
    },
  });

  expect(loginRes.status(), 'Login must succeed for E2E test user').toBe(200);

  const body = await loginRes.json();
  const token: string = body.token;
  expect(token, 'Login response must include a JWT').toBeTruthy();

  // ── 3. Inject token into the browser's localStorage ───────────────────────
  // Navigate to any page on the origin so we can write to localStorage.
  await page.goto('/login');
  await page.evaluate((t) => localStorage.setItem('token', t), token);

  // ── 4. Persist the browser context (cookies + localStorage) ───────────────
  await page.context().storageState({ path: STORAGE_STATE });

  console.log(`✓ Auth state saved for user "${TEST_USER.username}"`);
});
