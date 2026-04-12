import { type Page, type Locator } from '@playwright/test';

/**
 * Page Object Model for /signup
 */
export class SignupPage {
  readonly page: Page;

  // Form elements
  readonly form: Locator;
  readonly usernameInput: Locator;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly confirmPasswordInput: Locator;
  readonly submitButton: Locator;

  // Feedback / errors
  readonly errorAlert: Locator;
  readonly usernameError: Locator;
  readonly emailError: Locator;

  // Navigation
  readonly loginLink: Locator;

  // SSO
  readonly microsoftSSOButton: Locator;

  constructor(page: Page) {
    this.page = page;

    this.form                 = page.getByTestId('signup-form');
    this.usernameInput        = page.getByTestId('signup-username-input');
    this.emailInput           = page.getByTestId('signup-email-input');
    this.passwordInput        = page.getByTestId('signup-password-input');
    this.confirmPasswordInput = page.getByTestId('signup-confirm-password-input');
    this.submitButton         = page.getByTestId('signup-submit');
    this.errorAlert           = page.getByTestId('signup-error-alert');
    this.usernameError        = page.getByTestId('signup-username-error');
    this.emailError           = page.getByTestId('signup-email-error');
    this.loginLink            = page.getByTestId('signup-login-link');
    this.microsoftSSOButton   = page.getByTestId('signup-microsoft-sso');
  }

  async goto() {
    await this.page.goto('/signup');
    await this.form.waitFor({ state: 'visible' });
  }

  async fillAndSubmit(data: {
    username: string;
    email: string;
    password: string;
    confirmPassword: string;
  }) {
    await this.usernameInput.fill(data.username);
    await this.emailInput.fill(data.email);
    await this.passwordInput.fill(data.password);
    await this.confirmPasswordInput.fill(data.confirmPassword);
    await this.submitButton.click();
  }
}
