/**
 * terraform.spec.ts — Comprehensive Terraform Workflow E2E Tests
 *
 * Strategy:
 *   - Sessions are created on the REAL server (avoids fake-ID cascade failures).
 *   - Only `/api/user/secrets` and `/api/repositories` are mocked so tests run
 *     without needing real GitHub/Azure credentials configured for the E2E user.
 *   - `/api/sessions/:id/scan-repository` is mocked when navigating past Step 2.
 *
 * Test Groups:
 *   T01 — Page load & structure
 *   T02 — Step 1: Repository Provider cards
 *   T03 — Step 1 → Step 2 navigation
 *   T04 — Step 2: Back navigation
 *   T05 — Step 3: Cloud provider cards
 *   T06 — Step 4: Module approach cards
 *   T07 — Step 6: Backend configuration form
 *   T08 — Auth guard
 *   T09 — Header actions
 */
import { test, expect } from '../fixtures';

// ─────────────────────────────────────────────────────────────────────────────
// T01 — Page load & structure
// ─────────────────────────────────────────────────────────────────────────────
test.describe('T01 — Page load & structure', () => {
  test.beforeEach(async ({ terraformPage }) => {
    await terraformPage.mockProvidersAndRepos();
    await terraformPage.goto();
    await terraformPage.waitForStep1();
  });

  test('T01-01: page title contains "Terraform"', async ({ page }) => {
    // Use main h1 to avoid matching the brand logo h1 in the nav
    await expect(page.locator('main h1')).toContainText('Terraform');
  });

  test('T01-02: Refresh button is visible', async ({ terraformPage }) => {
    await expect(terraformPage.refreshButton).toBeVisible();
  });

  test('T01-03: Home button is visible', async ({ terraformPage }) => {
    await expect(terraformPage.homeButton).toBeVisible();
  });

  test('T01-04: Step 1 heading "Select Repository Provider" is shown', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Select Repository Provider/i })).toBeVisible();
  });

  test('T01-05: Workflow Progress panel is visible', async ({ page }) => {
    await expect(page.getByText('Workflow Progress')).toBeVisible();
  });

  test('T01-06: page URL stays at /terraform/app (no redirect)', async ({ page }) => {
    expect(page.url()).toContain('/terraform/app');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T02 — Step 1: Repository provider selection cards
// ─────────────────────────────────────────────────────────────────────────────
test.describe('T02 — Step 1: Provider cards', () => {
  test.beforeEach(async ({ terraformPage }) => {
    await terraformPage.mockProvidersAndRepos();
    await terraformPage.goto();
    await terraformPage.waitForStep1();
  });

  test('T02-01: GitHub card is visible when GitHub is configured', async ({ terraformPage }) => {
    await expect(terraformPage.providerCardGitHub).toBeVisible();
  });

  test('T02-02: Azure DevOps card is visible when Azure DevOps is configured', async ({ terraformPage }) => {
    await expect(terraformPage.providerCardAzureDevOps).toBeVisible();
  });

  test('T02-03: GitHub card contains the text "GitHub"', async ({ terraformPage }) => {
    await expect(terraformPage.providerCardGitHub).toContainText('GitHub');
  });

  test('T02-04: Azure DevOps card contains "Azure DevOps"', async ({ terraformPage }) => {
    await expect(terraformPage.providerCardAzureDevOps).toContainText('Azure DevOps');
  });

  test('T02-05: "Go to Settings" shown when NO providers configured', async ({ page, terraformPage }) => {
    // Override the secrets mock (added after beforeEach mock — Playwright uses LIFO)
    await page.route('**/api/user/secrets', route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          hasGithub: false, hasAzureDevOps: false,
          hasAzureCloud: false, hasAws: false, hasGcp: false,
          azureDevOps: null, azureCloud: null, github: null, aws: null, gcp: null,
        }),
      })
    );
    // Reload so the new mock is consumed
    await page.reload();
    // Wait for the settings fallback
    await page.waitForSelector('[data-testid="terraform-btn-settings"]', { timeout: 10_000 });
    await expect(terraformPage.noProvidersSettingsButton).toBeVisible();
    await expect(terraformPage.providerCardGitHub).not.toBeVisible();
    await expect(terraformPage.providerCardAzureDevOps).not.toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T03 — Step 1 → Step 2: Provider card click navigates to repo selection
// ─────────────────────────────────────────────────────────────────────────────
test.describe('T03 — Step 1 → Step 2 navigation', () => {
  test.beforeEach(async ({ terraformPage }) => {
    await terraformPage.mockProvidersAndRepos();
    await terraformPage.goto();
    await terraformPage.waitForStep1();
  });

  test('T03-01: clicking GitHub card shows Step 2 Back button', async ({ terraformPage }) => {
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
    await expect(terraformPage.backStep2Button).toBeVisible();
  });

  test('T03-02: Step 2 heading reads "Select Repository"', async ({ page, terraformPage }) => {
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
    // Use h2 specifically to avoid matching the h3 inside the RepositoryList component
    await expect(page.locator('h2').filter({ hasText: 'Select Repository' }).first()).toBeVisible();
  });

  test('T03-03: clicking Azure DevOps card also advances to Step 2', async ({ terraformPage }) => {
    await terraformPage.providerCardAzureDevOps.click();
    await terraformPage.waitForStep2();
    await expect(terraformPage.backStep2Button).toBeVisible();
  });

  test('T03-04: mocked repositories appear in Step 2 list', async ({ page, terraformPage }) => {
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
    await expect(page.getByText('e2e-infrastructure')).toBeVisible({ timeout: 8_000 });
  });

  test('T03-05: second mocked repo also appears', async ({ page, terraformPage }) => {
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
    await expect(page.getByText('e2e-terraform-modules')).toBeVisible({ timeout: 8_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T04 — Step 2 Back navigation returns to Step 1
// ─────────────────────────────────────────────────────────────────────────────
test.describe('T04 — Step 2: Back navigation', () => {
  test.beforeEach(async ({ terraformPage }) => {
    await terraformPage.mockProvidersAndRepos();
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
  });

  test('T04-01: Back button returns to Step 1 heading', async ({ page, terraformPage }) => {
    await terraformPage.backStep2Button.click();
    await expect(page.getByRole('heading', { name: /Select Repository Provider/i })).toBeVisible({ timeout: 6_000 });
  });

  test('T04-02: After Back, GitHub provider card is visible again', async ({ terraformPage }) => {
    await terraformPage.backStep2Button.click();
    await expect(terraformPage.providerCardGitHub).toBeVisible({ timeout: 6_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T05 — Step 3: Cloud Provider selection cards
// ─────────────────────────────────────────────────────────────────────────────
test.describe('T05 — Step 3: Cloud provider cards', () => {
  test.beforeEach(async ({ terraformPage }) => {
    await terraformPage.mockProvidersAndRepos();
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await terraformPage.navigateToStep3();
  });

  test('T05-01: Step 3 heading reads "Select Cloud Provider"', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Select Cloud Provider/i })).toBeVisible();
  });

  test('T05-02: Microsoft Azure cloud card is visible', async ({ terraformPage }) => {
    await expect(terraformPage.cloudCardAzure).toBeVisible();
  });

  test('T05-03: Amazon Web Services card is visible', async ({ terraformPage }) => {
    await expect(terraformPage.cloudCardAWS).toBeVisible();
  });

  test('T05-04: Google Cloud Platform card is visible', async ({ terraformPage }) => {
    await expect(terraformPage.cloudCardGCP).toBeVisible();
  });

  test('T05-05: Azure cloud card contains "Azure"', async ({ terraformPage }) => {
    await expect(terraformPage.cloudCardAzure).toContainText('Azure');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T06 — Step 4: Module approach cards
// ─────────────────────────────────────────────────────────────────────────────
test.describe('T06 — Step 4: Module approach cards', () => {
  test.beforeEach(async ({ terraformPage }) => {
    await terraformPage.mockProvidersAndRepos();
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await terraformPage.navigateToStep4();
  });

  test('T06-01: Step 4 heading reads "Select Module Approach"', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Select Module Approach/i })).toBeVisible();
  });

  test('T06-02: "Child Module" card is visible', async ({ terraformPage }) => {
    await expect(terraformPage.moduleCardChild).toBeVisible();
  });

  test('T06-03: "Standalone Root" card is visible', async ({ terraformPage }) => {
    await expect(terraformPage.moduleCardStandalone).toBeVisible();
  });

  test('T06-04: "Aggregated Root" card is visible', async ({ terraformPage }) => {
    await expect(terraformPage.moduleCardAggregated).toBeVisible();
  });

  test('T06-05: all 3 module cards are clickable', async ({ terraformPage }) => {
    await expect(terraformPage.moduleCardChild).toBeEnabled();
    await expect(terraformPage.moduleCardStandalone).toBeEnabled();
    await expect(terraformPage.moduleCardAggregated).toBeEnabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T07 — Backend configuration form
// ─────────────────────────────────────────────────────────────────────────────
test.describe('T07 — Backend config form', () => {
  test.beforeEach(async ({ terraformPage }) => {
    await terraformPage.mockProvidersAndRepos();
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await terraformPage.navigateToBackendStep();
  });

  test('T07-01: Backend Create button is visible', async ({ terraformPage }) => {
    await expect(terraformPage.backendCreateButton).toBeVisible();
  });

  test('T07-02: Backend Decline button is visible', async ({ terraformPage }) => {
    await expect(terraformPage.backendDeclineButton).toBeVisible();
  });

  test('T07-03: Create button is disabled when form is empty', async ({ terraformPage }) => {
    // Form fields start empty → Create button must be disabled until filled
    await expect(terraformPage.backendCreateButton).toBeDisabled();
  });

  test('T07-04: Azure backend input fields are visible in the form', async ({ terraformPage }) => {
    // Fields are always rendered (not hidden behind a click)
    await expect(terraformPage.backendResourceGroup).toBeVisible({ timeout: 6_000 });
    await expect(terraformPage.backendStorageAccount).toBeVisible({ timeout: 6_000 });
    await expect(terraformPage.backendContainer).toBeVisible({ timeout: 6_000 });
  });

  test('T07-05: filling all Azure fields enables the Create button', async ({ terraformPage }) => {
    await terraformPage.backendResourceGroup.fill('my-resource-group');
    await terraformPage.backendStorageAccount.fill('mystorageacct');
    await terraformPage.backendContainer.fill('tfstate');
    // All required fields filled → Create button should be enabled
    await expect(terraformPage.backendCreateButton).toBeEnabled({ timeout: 3_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T08 — Auth guard
// ─────────────────────────────────────────────────────────────────────────────
test.describe('T08 — Auth guard', () => {
  test('T08-01: authenticated user reaches /terraform/app without redirect to /login', async ({ page }) => {
    await page.goto('/terraform/app');
    await page.waitForTimeout(2_000);
    expect(page.url()).not.toContain('/login');
  });

  test('T08-02: JWT token is present in localStorage', async ({ page }) => {
    await page.goto('/terraform/app');
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T09 — Header actions
// ─────────────────────────────────────────────────────────────────────────────
test.describe('T09 — Header actions', () => {
  test.beforeEach(async ({ terraformPage }) => {
    await terraformPage.mockProvidersAndRepos();
    await terraformPage.goto();
    await terraformPage.waitForStep1();
  });

  test('T09-01: Home button navigates away from /terraform/app', async ({ terraformPage }) => {
    await terraformPage.homeButton.click();
    await terraformPage.page.waitForURL(url => !url.pathname.startsWith('/terraform'), { timeout: 6_000 });
  });

  test('T09-02: Refresh while in Step 2 resets to Step 1 cards', async ({ page, terraformPage }) => {
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
    await terraformPage.refreshButton.click();
    await terraformPage.waitForStep1();
    await expect(terraformPage.providerCardGitHub).toBeVisible({ timeout: 8_000 });
  });

  test('T09-03: After Refresh, Step 1 heading is restored', async ({ page, terraformPage }) => {
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
    await terraformPage.refreshButton.click();
    await terraformPage.waitForStep1();
    await expect(page.getByRole('heading', { name: /Select Repository Provider/i })).toBeVisible();
  });
});
