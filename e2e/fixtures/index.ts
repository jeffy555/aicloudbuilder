/**
 * e2e/fixtures/index.ts
 *
 * Extends the base Playwright `test` object with pre-constructed Page Object
 * Models so specs receive them as typed fixtures rather than calling `new`
 * themselves.
 *
 * Usage in specs:
 *   import { test, expect } from '../fixtures';
 */
import { test as base, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { SignupPage } from '../pages/SignupPage';
import { TerraformPage } from '../pages/TerraformPage';

type E2EFixtures = {
  loginPage: LoginPage;
  signupPage: SignupPage;
  terraformPage: TerraformPage;
};

export const test = base.extend<E2EFixtures>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  signupPage: async ({ page }, use) => {
    await use(new SignupPage(page));
  },
  terraformPage: async ({ page }, use) => {
    await use(new TerraformPage(page));
  },
});

export { expect };
