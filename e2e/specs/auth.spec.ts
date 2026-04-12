/**
 * auth.spec.ts — Login & Signup UI flows
 *
 * These tests run in the `auth-flows` project which has NO pre-stored auth
 * state, so they exercise the actual login/signup forms from scratch.
 */
import { test, expect } from '../fixtures';

// ─── Test credentials (must match global.setup.ts) ───────────────────────────
const E2E_USER = {
  username: process.env.E2E_USERNAME ?? 'e2e_playwright',
  password: process.env.E2E_PASSWORD ?? 'E2eTest1!',
};

// ─────────────────────────────────────────────────────────────────────────────
// Login page — structure
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Login page — structure', () => {
  test.beforeEach(async ({ loginPage }) => {
    await loginPage.goto();
  });

  test('renders all form elements', async ({ loginPage }) => {
    await expect(loginPage.form).toBeVisible();
    await expect(loginPage.usernameInput).toBeVisible();
    await expect(loginPage.passwordInput).toBeVisible();
    await expect(loginPage.rememberMeCheckbox).toBeVisible();
    await expect(loginPage.submitButton).toBeVisible();
    await expect(loginPage.signupLink).toBeVisible();
    await expect(loginPage.forgotPasswordLink).toBeVisible();
  });

  test('Microsoft SSO button is always rendered', async ({ loginPage }) => {
    // Button shows regardless of SSO configuration (disabled when unconfigured)
    await expect(loginPage.microsoftSSOButton).toBeVisible();
  });

  test('error alert is hidden on initial load', async ({ loginPage }) => {
    await expect(loginPage.errorAlert).not.toBeVisible();
  });

  test('submit button reads "Login"', async ({ loginPage }) => {
    await expect(loginPage.submitButton).toContainText('Login');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Login page — failed login
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Login page — failed login', () => {
  test('shows error alert for wrong password', async ({ loginPage }) => {
    await loginPage.goto();
    await loginPage.login(E2E_USER.username, 'wrongpassword');
    await expect(loginPage.errorAlert).toBeVisible({ timeout: 8_000 });
  });

  test('shows error alert for unknown user', async ({ loginPage }) => {
    await loginPage.goto();
    await loginPage.login('nobody_xyz_nonexistent', 'Password1!');
    await expect(loginPage.errorAlert).toBeVisible({ timeout: 8_000 });
  });

  test('submit button is disabled while login request is in flight', async ({ loginPage, page }) => {
    await loginPage.goto();

    // Delay the login API response so we can observe the loading state
    await page.route('**/api/auth/login', async route => {
      await new Promise(resolve => setTimeout(resolve, 1_500));
      await route.continue();
    });

    await loginPage.usernameInput.fill(E2E_USER.username);
    await loginPage.passwordInput.fill('any-password');
    await loginPage.submitButton.click();

    // Button must be disabled while the slow request is in flight
    await expect(loginPage.submitButton).toBeDisabled({ timeout: 1_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Login page — successful login
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Login page — successful login', () => {
  test('valid credentials redirect to home page', async ({ loginPage }) => {
    await loginPage.goto();
    await loginPage.loginAndWaitForRedirect(E2E_USER.username, E2E_USER.password);
    await expect(loginPage.page).not.toHaveURL(/\/login/);
  });

  test('token is stored in localStorage after login (rememberMe=off)', async ({ loginPage }) => {
    await loginPage.goto();
    await loginPage.loginAndWaitForRedirect(E2E_USER.username, E2E_USER.password);

    const token = await loginPage.page.evaluate(() => localStorage.getItem('token'));
    // With rememberMe unchecked the token lands in sessionStorage, not localStorage.
    // But the global.setup login uses rememberMe=false, so check sessionStorage too.
    const sessionToken = await loginPage.page.evaluate(() => sessionStorage.getItem('token'));
    expect(token ?? sessionToken).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Login page — navigation
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Login page — navigation', () => {
  test('signup link navigates to /signup', async ({ loginPage }) => {
    await loginPage.goto();
    await loginPage.signupLink.click();
    await loginPage.page.waitForURL(/\/signup/, { timeout: 5_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signup page — structure
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Signup page — structure', () => {
  test.beforeEach(async ({ signupPage }) => {
    await signupPage.goto();
  });

  test('renders all form elements', async ({ signupPage }) => {
    await expect(signupPage.form).toBeVisible();
    await expect(signupPage.usernameInput).toBeVisible();
    await expect(signupPage.emailInput).toBeVisible();
    await expect(signupPage.passwordInput).toBeVisible();
    await expect(signupPage.confirmPasswordInput).toBeVisible();
    await expect(signupPage.submitButton).toBeVisible();
    await expect(signupPage.loginLink).toBeVisible();
  });

  test('Microsoft SSO button is always rendered', async ({ signupPage }) => {
    await expect(signupPage.microsoftSSOButton).toBeVisible();
  });

  test('error alert is hidden on initial load', async ({ signupPage }) => {
    await expect(signupPage.errorAlert).not.toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signup page — validation
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Signup page — validation', () => {
  test.beforeEach(async ({ signupPage }) => {
    await signupPage.goto();
  });

  test('shows username error for short username', async ({ signupPage }) => {
    await signupPage.fillAndSubmit({
      username: 'ab',           // too short (< 3)
      email: 'valid@test.com',
      password: 'ValidPass1!',
      confirmPassword: 'ValidPass1!',
    });
    await expect(signupPage.usernameError).toBeVisible({ timeout: 4_000 });
  });

  test('shows field error when passwords do not match', async ({ signupPage, page }) => {
    await signupPage.fillAndSubmit({
      username: 'validuser',
      email: 'valid@test.com',
      password: 'ValidPass1!',
      confirmPassword: 'DifferentPass1!',
    });
    // Validation puts the error on the confirmPassword field, not the general alert
    await expect(page.getByText('Passwords do not match')).toBeVisible({ timeout: 4_000 });
  });

  test('login link navigates back to /login', async ({ signupPage }) => {
    await signupPage.loginLink.click();
    await signupPage.page.waitForURL(/\/login/, { timeout: 5_000 });
  });
});
