import { type Page, type Locator } from '@playwright/test';

const ALL_PROVIDERS_RESPONSE = {
  hasGithub: true, hasAzureDevOps: true,
  hasAzureCloud: true, hasAws: true, hasGcp: true,
  azureDevOps: { org: 'e2e-org', project: 'e2e-project', userId: '' },
  azureCloud: { clientId: 'e2e-client', tenantId: 'e2e-tenant', subscriptionId: 'e2e-sub' },
  github: { owner: 'e2e-owner' },
  aws: { accessKeyId: 'e2e-key', region: 'us-east-1' },
  gcp: { projectId: 'e2e-project', region: 'us-central1' },
};

const FAKE_REPOS = [
  { id: 'repo-1', name: 'e2e-infrastructure',     fullName: 'e2e-owner/e2e-infrastructure',     defaultBranch: 'main', private: false },
  { id: 'repo-2', name: 'e2e-terraform-modules',  fullName: 'e2e-owner/e2e-terraform-modules',  defaultBranch: 'main', private: false },
];

const NEW_SCAN_RESULT = {
  isExisting: false, cloudProvider: null, moduleType: null,
  terraformFiles: [], hasResources: false, hasModules: false,
  providerBlocks: [], backend: { hasBackend: false, backendType: null },
};

/**
 * Page Object Model for /terraform
 *
 * Note: ProviderCard auto-generates data-testid from its `title` prop:
 *   `card-provider-${title.toLowerCase().replace(/\s+/g, '-')}`
 */
export class TerraformPage {
  readonly page: Page;

  // ── Header ─────────────────────────────────────────────────────────────────
  readonly refreshButton: Locator;
  readonly homeButton: Locator;

  // ── Step 1 — Repo provider cards ──────────────────────────────────────────
  // title="GitHub"       → card-provider-github
  // title="Azure DevOps" → card-provider-azure-devops
  readonly providerCardGitHub: Locator;
  readonly providerCardAzureDevOps: Locator;
  readonly noProvidersSettingsButton: Locator;

  // ── Step 2 ─────────────────────────────────────────────────────────────────
  readonly backStep2Button: Locator;

  // ── Cloud Provider (Step 3) ────────────────────────────────────────────────
  // title="Microsoft Azure"        → card-provider-microsoft-azure
  // title="Amazon Web Services"    → card-provider-amazon-web-services
  // title="Google Cloud Platform"  → card-provider-google-cloud-platform
  readonly cloudCardAzure: Locator;
  readonly cloudCardAWS: Locator;
  readonly cloudCardGCP: Locator;

  // ── Module approach (Step 4) ───────────────────────────────────────────────
  // title="Child Module"    → card-provider-child-module
  // title="Standalone Root" → card-provider-standalone-root
  // title="Aggregated Root" → card-provider-aggregated-root
  readonly moduleCardChild: Locator;
  readonly moduleCardStandalone: Locator;
  readonly moduleCardAggregated: Locator;

  // ── Backend config (Step 5/6) ─────────────────────────────────────────────
  readonly backStep5Button: Locator;
  readonly backStep3Button: Locator;
  readonly backStep6Button: Locator;
  readonly backendCreateButton: Locator;
  readonly backendDeclineButton: Locator;
  readonly backendValidateButton: Locator;
  readonly backendResourceGroup: Locator;
  readonly backendStorageAccount: Locator;
  readonly backendContainer: Locator;
  readonly backendBucket: Locator;
  readonly backendDynamoTable: Locator;
  readonly backendRegion: Locator;

  // ── Commit ────────────────────────────────────────────────────────────────
  readonly commitButton: Locator;
  readonly goHomeButton: Locator;

  constructor(page: Page) {
    this.page = page;

    this.refreshButton   = page.getByTestId('terraform-btn-refresh');
    this.homeButton      = page.getByTestId('terraform-btn-home');

    this.providerCardGitHub      = page.getByTestId('card-provider-github');
    this.providerCardAzureDevOps = page.getByTestId('card-provider-azure-devops');
    this.noProvidersSettingsButton = page.getByTestId('terraform-btn-settings');

    this.backStep2Button = page.getByTestId('terraform-btn-back-step2');

    this.cloudCardAzure = page.getByTestId('card-provider-microsoft-azure');
    this.cloudCardAWS   = page.getByTestId('card-provider-amazon-web-services');
    this.cloudCardGCP   = page.getByTestId('card-provider-google-cloud-platform');

    this.moduleCardChild      = page.getByTestId('card-provider-child-module');
    this.moduleCardStandalone = page.getByTestId('card-provider-standalone-root');
    this.moduleCardAggregated = page.getByTestId('card-provider-aggregated-root');

    this.backStep5Button  = page.getByTestId('terraform-btn-back-step5');
    this.backStep3Button  = page.getByTestId('terraform-btn-back-step3');
    this.backStep6Button  = page.getByTestId('terraform-btn-back-step6');
    this.backendCreateButton   = page.getByTestId('button-backend-create');
    this.backendDeclineButton  = page.getByTestId('button-backend-decline');
    this.backendValidateButton = page.getByTestId('button-backend-validate');
    this.backendResourceGroup  = page.getByTestId('terraform-input-backend-resource-group');
    this.backendStorageAccount = page.getByTestId('terraform-input-backend-storage-account');
    this.backendContainer      = page.getByTestId('terraform-input-backend-container');
    this.backendBucket         = page.getByTestId('terraform-input-backend-aws-bucket');
    this.backendDynamoTable    = page.getByTestId('terraform-input-backend-dynamodb-table');
    this.backendRegion         = page.getByTestId('terraform-input-backend-aws-region');

    this.commitButton = page.getByTestId('terraform-btn-commit');
    this.goHomeButton = page.getByTestId('button-go-home');
  }

  async goto() {
    await this.page.goto('/terraform/app');
    // Clear any saved session so the workflow always starts from Step 1
    await this.page.evaluate(() => localStorage.removeItem('terraform_workflow_session_id'));
    await this.page.reload();
  }

  /**
   * Mock only the secrets config and repo list.
   * Sessions are handled by the REAL server (avoids fake-ID cascading failures).
   */
  async mockProvidersAndRepos() {
    // Secrets: show all providers as configured
    await this.page.route('**/api/user/secrets', route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(ALL_PROVIDERS_RESPONSE),
      })
    );

    // Repositories: return fake list (avoids needing real GitHub/Azure credentials)
    // Use regex to match /api/repositories/<provider> (path segments after base)
    await this.page.route(/\/api\/repositories/, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(FAKE_REPOS),
      })
    );
  }

  /** Mock scan-repository to return a "new/empty repo" result → advances to Step 3. */
  async mockScanRepositoryAsNew() {
    await this.page.route('**/api/sessions/*/scan-repository', route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(NEW_SCAN_RESULT),
      })
    );
  }

  /** Wait for Step 1 to be ready (provider card or settings fallback). */
  async waitForStep1() {
    await this.page.waitForSelector(
      '[data-testid="card-provider-github"], [data-testid="card-provider-azure-devops"], [data-testid="terraform-btn-settings"]',
      { timeout: 15_000 }
    );
  }

  /** Wait for Step 2 repo selection (Back button appears). */
  async waitForStep2() {
    await this.backStep2Button.waitFor({ state: 'visible', timeout: 10_000 });
  }

  /** Wait for cloud provider cards (Step 3). */
  async waitForCloudProviderStep() {
    await this.page.waitForSelector(
      '[data-testid="card-provider-microsoft-azure"], [data-testid="card-provider-amazon-web-services"], [data-testid="card-provider-google-cloud-platform"], [data-testid="terraform-btn-settings"]',
      { timeout: 12_000 }
    );
  }

  /** Wait for module approach cards (Step 4). */
  async waitForModuleApproachStep() {
    await this.moduleCardChild.waitFor({ state: 'visible', timeout: 10_000 });
  }

  /** Navigate from Step 1 through to Step 3 (cloud provider selection). */
  async navigateToStep3() {
    await this.mockScanRepositoryAsNew();
    await this.providerCardGitHub.click();
    await this.waitForStep2();
    // Click the first mocked repo
    await this.page.getByText('e2e-infrastructure').first().click();
    await this.waitForCloudProviderStep();
  }

  /** Navigate from Step 1 through to Step 4 (module approach). */
  async navigateToStep4() {
    await this.navigateToStep3();
    await this.cloudCardAzure.click();
    await this.waitForModuleApproachStep();
  }

  /** Navigate from Step 1 through to the backend config step (Step 5/6). */
  async navigateToBackendStep() {
    await this.navigateToStep4();
    await this.moduleCardStandalone.click();
    // Wait for backend create/decline buttons
    await this.page.waitForSelector(
      '[data-testid="button-backend-create"], [data-testid="button-backend-decline"]',
      { timeout: 10_000 }
    );
  }
}
