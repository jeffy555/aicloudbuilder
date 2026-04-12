import { type Page, type Locator } from '@playwright/test';

/**
 * Page Object Model for /login
 *
 * All selectors use data-testid attributes for stability.
 */
export class LoginPage {
  readonly page: Page;

  // Form elements
  readonly form: Locator;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly rememberMeCheckbox: Locator;
  readonly submitButton: Locator;

  // Feedback
  readonly errorAlert: Locator;

  // Navigation
  readonly signupLink: Locator;
  readonly forgotPasswordLink: Locator;

  // SSO
  readonly microsoftSSOButton: Locator;

  constructor(page: Page) {
    this.page = page;

    this.form               = page.getByTestId('login-form');
    this.usernameInput      = page.getByTestId('login-username-input');
    this.passwordInput      = page.getByTestId('login-password-input');
    this.rememberMeCheckbox = page.getByTestId('login-remember-me');
    this.submitButton       = page.getByTestId('login-submit');
    this.errorAlert         = page.getByTestId('login-error-alert');
    this.signupLink         = page.getByTestId('login-signup-link');
    this.forgotPasswordLink = page.getByTestId('login-forgot-password');
    this.microsoftSSOButton = page.getByTestId('login-microsoft-sso');
  }

  async goto() {
    await this.page.goto('/login');
    await this.form.waitFor({ state: 'visible' });
  }

  /**
   * Fill credentials and submit the form.
   * Resolves once the submit click is dispatched — callers should await the
   * expected post-login side-effect (navigation, error alert, etc.).
   */
  async login(usernameOrEmail: string, password: string, rememberMe = false) {
    await this.usernameInput.fill(usernameOrEmail);
    await this.passwordInput.fill(password);
    if (rememberMe) {
      await this.rememberMeCheckbox.check();
    }
    await this.submitButton.click();
  }

  /** Convenience: login and wait for redirect away from /login. */
  async loginAndWaitForRedirect(usernameOrEmail: string, password: string) {
    await this.login(usernameOrEmail, password);
    await this.page.waitForURL((url) => !url.pathname.includes('/login'), {
      timeout: 10_000,
    });
  }
}
