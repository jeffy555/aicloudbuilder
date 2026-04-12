/**
 * global.setup.full.ts
 *
 * Creates a dedicated Playwright test user (e2e_workflow_user) and
 * configures GitHub using the PAT you already have.
 *
 * Only ONE env var required:
 *   E2E_GITHUB_TOKEN   Your existing GitHub Personal Access Token (repo scope)
 *
 * The GitHub owner (username) is auto-detected from the token via GitHub API.
 * No other env vars needed.
 */
import { test as setup, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FULL_STORAGE_STATE = path.join(__dirname, '.auth/full-user.json');

// Dedicated playwright test user — created fresh, never your real account
const PLAYWRIGHT_USER = {
  username: 'e2e_workflow_user',
  email:    'e2e_workflow@test.local',
  password: 'WorkflowTest1!',
};

setup('create e2e_workflow_user and configure GitHub', async ({ page, request }) => {
  fs.mkdirSync(path.dirname(FULL_STORAGE_STATE), { recursive: true });

  // Read from .env (GITHUB_TOKEN / GITHUB_OWNER) or fall back to E2E_ prefixed vars
  const githubToken = process.env.GITHUB_TOKEN ?? process.env.E2E_GITHUB_TOKEN;
  const githubOwnerEnv = process.env.GITHUB_OWNER ?? process.env.E2E_GITHUB_OWNER;

  if (!githubToken) {
    throw new Error(
      '\n\nAdd GITHUB_TOKEN to your .env file:\n\n' +
      '  GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx\n' +
      '  GITHUB_OWNER=your-github-username\n'
    );
  }

  // ── 1. Resolve GitHub owner (from .env or auto-detect via API) ────────────
  let githubOwner = githubOwnerEnv;
  if (!githubOwner) {
    const ghRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'AICloudBuilder-E2E' },
    });
    if (!ghRes.ok) throw new Error(`GitHub token invalid (${ghRes.status}). Check GITHUB_TOKEN in .env`);
    const { login } = await ghRes.json() as { login: string };
    githubOwner = login;
  }
  console.log(`✓ GitHub token valid — owner: ${githubOwner}`);

  // ── 2. Create playwright test user (idempotent — 409 on repeat runs) ───────
  await request.post('/api/auth/signup', {
    data: {
      username: PLAYWRIGHT_USER.username,
      email:    PLAYWRIGHT_USER.email,
      password: PLAYWRIGHT_USER.password,
    },
  });

  // ── 3. Login to get JWT ───────────────────────────────────────────────────
  const loginRes = await request.post('/api/auth/login', {
    data: {
      usernameOrEmail: PLAYWRIGHT_USER.username,
      password:        PLAYWRIGHT_USER.password,
    },
  });
  expect(loginRes.status(), `Login failed for "${PLAYWRIGHT_USER.username}"`).toBe(200);
  const { token } = await loginRes.json();
  expect(token, 'No JWT returned from login').toBeTruthy();

  // ── 4. Configure GitHub credentials for the playwright user ───────────────
  const secretsRes = await request.put('/api/user/secrets/github', {
    headers: { Authorization: `Bearer ${token}` },
    data: { token: githubToken, owner: githubOwner },
  });
  expect(
    secretsRes.status(),
    `Failed to save GitHub credentials (${secretsRes.status()})`
  ).toBe(200);

  // ── 5. Inject JWT into browser localStorage and persist auth state ─────────
  await page.goto('/login');
  await page.evaluate((t) => localStorage.setItem('token', t), token);
  await page.context().storageState({ path: FULL_STORAGE_STATE });

  console.log(
    `✓ Playwright user "${PLAYWRIGHT_USER.username}" ready\n` +
    `  GitHub owner: ${githubOwner}\n` +
    `  Auth saved:   ${FULL_STORAGE_STATE}`
  );
});
