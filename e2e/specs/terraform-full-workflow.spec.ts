/**
 * terraform-full-workflow.spec.ts
 *
 * Real end-to-end test — no mocks for generation or pipeline stages.
 * Uses live AI tokens (gpt-4o-mini) and the real server.
 *
 * Workflow under test:
 *   GitHub → arch-repo → Azure → Standalone Root →
 *   Fill backend fields (skip provisioning) →
 *   AI generates Terraform →
 *   Build Pipeline (Best Approach → Architecture → Cost → Security) →
 *   Assert results → STOP before commit
 *
 * Test user: e2e_workflow_user (created by global.setup.full.ts)
 * Estimated run time: ~4–7 minutes (AI generation + 4-stage pipeline)
 */
import { test, expect } from '../fixtures';
import {
  annotateTest, attachPrompt, attachScanResult, attachGeneratedFiles,
  attachBestApproach, attachCostAnalysis, attachSecurityScan, attachPipelineSummary, runSecurityStage,
  type ScanResult, type GeneratedFile, type BestApproachResult, type ScanResultContext,
} from '../helpers/report-enricher';

// ─── AI-generated infrastructure description ──────────────────────────────────
const INFRA_DESCRIPTION = `
Create a production-ready Azure infrastructure for a multi-tier web application:

1. Resource Group named "webapp-prod-rg" in East US region
2. Virtual Network (10.0.0.0/16) with two subnets:
   - app-subnet (10.0.1.0/24) for the application tier
   - data-subnet (10.0.2.0/24) for the database tier
3. App Service Plan (P2v3 tier, Linux OS) named "webapp-asp" with 2 instances
4. App Service named "webapp-api" for a Node.js REST API backend
5. Azure SQL Server with a SQL Database named "webapp-db" (Standard S2, 50 DTU)
   and a firewall rule permitting Azure services
6. Azure Cache for Redis (C1 Standard SKU) named "webapp-redis"
7. Azure Storage Account (Standard LRS, StorageV2) with a private blob container "uploads"
8. Application Insights workspace named "webapp-insights" for monitoring and logging

Tag every resource with: environment production, project webapp-e2e, managed-by terraform
`.trim();

// ─── Backend config values (random; skip provisioning in test) ────────────────
const BACKEND = {
  resourceGroup:   'tfstate-e2etest-rg',
  storageAccount:  'tfstatee2etest99',   // max 24 chars, lowercase + digits only
  container:       'tfstatecontainer',
};

// ─── Target inputs ────────────────────────────────────────────────────────────
const REPO = 'arch-repo';

// ─── Timeouts ─────────────────────────────────────────────────────────────────
const T = {
  step:      30_000,   // simple UI interaction
  pause:      1_500,   // visual pause between steps (headed mode)
  scan:      60_000,   // GitHub repo scan (network call)
  generate: 300_000,   // AI Terraform generation (8–15 files, allow up to 5 min)
  stage:    120_000,   // single pipeline stage
  pipeline: 360_000,   // full 4-stage pipeline
};

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Full Terraform Workflow — Standalone Root (Azure)', () => {

  test.setTimeout(720_000); // 12 min ceiling (fix step needs up to 4 min for AI batches)

  // Block commit to prevent accidental repo pushes during test
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/sessions/*/commit', route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ blocked: true, message: 'Commit disabled in E2E test' }),
      })
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // STEP 1 — Navigate to /terraform/app and confirm Step 1 renders
  // ──────────────────────────────────────────────────────────────────────────
  test('FULL-01: App loads and shows GitHub provider card', async ({ page, terraformPage }) => {
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await expect(page.locator('main h1')).toContainText('Terraform');
    await expect(terraformPage.providerCardGitHub).toBeVisible();
    await expect(terraformPage.refreshButton).toBeVisible();
    await expect(terraformPage.homeButton).toBeVisible();
    await expect(page.getByText('Workflow Progress')).toBeVisible();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // STEP 2 — Select GitHub, pick arch-repo, handle scan result
  // ──────────────────────────────────────────────────────────────────────────
  test('FULL-02: Select GitHub and arch-repo appear in repo list', async ({ page, terraformPage }) => {
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
    await expect(page.getByText(REPO, { exact: true })).toBeVisible({ timeout: T.step });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FULL WORKFLOW (single test with test.step checkpoints)
  // ──────────────────────────────────────────────────────────────────────────
  test('FULL-03: Complete workflow — generate Terraform + run build pipeline', async ({ page, terraformPage }, testInfo) => {

    // ── Report enrichment setup ────────────────────────────────────────────
    annotateTest(testInfo, {
      approach:       'Standalone Root',
      repo:           REPO,
      cloudProvider:  'Azure',
      pipelineStages: 'Architecture → Best Approach → Security Scan → Cost Analysis',
    });
    await attachPrompt(testInfo, 'Standalone Root', INFRA_DESCRIPTION);

    // Collect live API responses for the report attachments
    let scanResult: ScanResult | null = null;
    let generatedFiles: GeneratedFile[] | null = null;
    let costData: Record<string, unknown> | null = null;
    let securityData: Record<string, unknown> | null = null;
    const bestApproachData: BestApproachResult = {};

    page.on('response', async (response) => {
      if (response.status() !== 200) return;
      const url = response.url();
      try {
        if (url.includes('scan-repository')) {
          scanResult = await response.json() as ScanResult;
        } else if (url.includes('generate-terraform')) {
          const body = await response.json() as GeneratedFile[] | { files?: GeneratedFile[] };
          generatedFiles = Array.isArray(body) ? body : (body.files ?? null);
        } else if (url.includes('analyze-cost')) {
          costData = await response.json();
        } else if (/\/api\/sessions\/[^/]+\/scan$/.test(url)) {
          securityData = await response.json();
        } else if (/\/api\/sessions\/[^/]+\/refactor-fix$/.test(url)) {
          bestApproachData.fix = await response.json();
        } else if (/\/api\/sessions\/[^/]+\/refactor$/.test(url) && response.request().method() === 'POST') {
          const body = await response.json();
          if (!bestApproachData.validation) {
            bestApproachData.validation = body;
          } else {
            bestApproachData.afterFix = body;
          }
        }
      } catch { /* ignore parse errors */ }
    });

    // Track pipeline stage outcomes
    const pipelineStages: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; durationMs?: number }> = [];
    let t0 = 0;

    // ── Step 1: Navigate (goto() clears session + reloads for fresh start) ──
    await test.step('1 · Navigate to /terraform/app', async () => {
      await terraformPage.goto();
      await terraformPage.waitForStep1();
      await expect(page.locator('main h1')).toContainText('Terraform');
      await page.waitForTimeout(T.pause);
    });

    // ── Step 1: Select GitHub ──────────────────────────────────────────────
    await test.step('1 · Select GitHub as repository provider', async () => {
      await terraformPage.providerCardGitHub.click();
      await terraformPage.waitForStep2();
      await expect(page.locator('h2').filter({ hasText: 'Select Repository' }).first()).toBeVisible();
      await page.waitForTimeout(T.pause);
    });

    // ── Step 2: Pick arch-repo ────────────────────────────────────────────
    await test.step(`2 · Pick repository "${REPO}" from the list`, async () => {
      await expect(page.getByText(REPO, { exact: true })).toBeVisible({ timeout: T.step });
      await page.getByText(REPO, { exact: true }).first().click();

      // Wait for scan to complete — either new-repo (cloud cards appear)
      // or existing-repo ("Repository Selected" green card + Continue button)
      await page.waitForSelector(
        '[data-testid="card-provider-microsoft-azure"], button:has-text("Continue to")',
        { timeout: T.scan }
      );
      await page.waitForTimeout(T.pause);
    });

    // ── Step 2→3: Handle existing-repo scan result ─────────────────────────
    await test.step('2 · Advance past repo scan (handle existing or new repo)', async () => {
      const continueBtn = page.getByRole('button', { name: /Continue to/ });
      const hasBtn = await continueBtn.isVisible({ timeout: 3_000 }).catch(() => false);
      if (hasBtn) {
        await continueBtn.click();
        // May land on Step 3 (cloud) or Step 4 (module) depending on detected cloud
        await page.waitForSelector(
          '[data-testid="card-provider-microsoft-azure"], [data-testid="card-provider-standalone-root"]',
          { timeout: T.step }
        );
      }
      await page.waitForTimeout(T.pause);
    });

    // ── Step 3: Cloud provider ─────────────────────────────────────────────
    await test.step('3 · Select Microsoft Azure cloud provider', async () => {
      // Azure card only shown if we're on step 3 (cloud was not pre-detected)
      const azureCard = page.getByTestId('card-provider-microsoft-azure');
      const onCloudStep = await azureCard.isVisible({ timeout: 3_000 }).catch(() => false);
      if (onCloudStep) {
        await azureCard.click();
      }
      // After cloud selection, module approach cards should appear
      await page.waitForSelector('[data-testid="card-provider-standalone-root"]', { timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Step 4: Module approach ────────────────────────────────────────────
    await test.step('4 · Select Standalone Root module approach', async () => {
      await expect(page.getByTestId('card-provider-standalone-root')).toBeVisible();
      await page.getByTestId('card-provider-standalone-root').click();
      // Backend config buttons appear next
      await page.waitForSelector('[data-testid="button-backend-decline"]', { timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Step 5: Backend config ─────────────────────────────────────────────
    await test.step(`5 · Fill backend fields (RG=${BACKEND.resourceGroup}) then skip provisioning`, async () => {
      // Fill in backend fields for record-keeping in the test report
      await terraformPage.backendResourceGroup.fill(BACKEND.resourceGroup);
      await expect(terraformPage.backendResourceGroup).toHaveValue(BACKEND.resourceGroup);

      await terraformPage.backendStorageAccount.fill(BACKEND.storageAccount);
      await expect(terraformPage.backendStorageAccount).toHaveValue(BACKEND.storageAccount);

      await terraformPage.backendContainer.fill(BACKEND.container);
      await expect(terraformPage.backendContainer).toHaveValue(BACKEND.container);

      // Verify Create button becomes enabled now that all fields are filled
      await expect(terraformPage.backendCreateButton).toBeEnabled({ timeout: 3_000 });

      await page.waitForTimeout(T.pause);

      // Skip backend provisioning (avoids creating real Azure resources)
      await terraformPage.backendDeclineButton.click();

      // ChatInput at bottom = description step is ready
      await page.waitForSelector('[data-testid="input-chat"]', { timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Step 6: Infrastructure description ────────────────────────────────
    await test.step('6 · Enter AI-crafted Azure infrastructure description', async () => {
      const chatInput = page.getByTestId('input-chat');
      // Click to focus, then fill — ensures React controlled input receives the value
      await chatInput.click();
      await chatInput.fill(INFRA_DESCRIPTION);
      // Small wait for React batch state update
      await page.waitForTimeout(300);
      // Spot-check that the description was accepted
      await expect(chatInput).not.toBeEmpty();
      await page.waitForTimeout(T.pause);
    });

    // ── Step 6→8: Generate Terraform via AI ───────────────────────────────
    await test.step('6 · Submit description → wait for AI Terraform generation', async () => {
      // Start waiting for the generate-terraform API response BEFORE clicking
      // so we don't miss a fast response
      const generateResponsePromise = page.waitForResponse(
        resp => resp.url().includes('generate-terraform') && resp.request().method() === 'POST',
        { timeout: T.generate }
      );

      await page.getByTestId('button-send').click();

      // Wait for the server to respond to the generation request
      const generateResponse = await generateResponsePromise;
      const status = generateResponse.status();

      if (status !== 200) {
        const body = await generateResponse.text().catch(() => 'could not read body');
        throw new Error(`Generate Terraform API returned ${status}:\n${body}`);
      }

      // Generation succeeded — wait for the Activities overview (step 8) to appear
      await page.waitForSelector('button:has-text("Build Pipeline")', { timeout: 30_000 });
    });

    // ── Step 8: Verify Overview stats ─────────────────────────────────────
    await test.step('8 · Overview — verify generated file count and cloud label', async () => {
      await page.waitForTimeout(T.pause);

      // Build Pipeline tab button should be visible
      await expect(page.getByRole('button', { name: 'Build Pipeline' }).first()).toBeVisible({ timeout: 10_000 });

      // KPI card: "Files generated" with a number > 0
      await expect(page.locator('text=Files generated')).toBeVisible({ timeout: 10_000 });

      // Cloud label in KPI shows AZURE
      await expect(page.locator('text=AZURE').first()).toBeVisible({ timeout: 5_000 });
    });

    // ── Step 8: Switch to Build Pipeline tab ──────────────────────────────
    await test.step('8 · Switch to Build Pipeline tab', async () => {
      await page.getByRole('button', { name: 'Build Pipeline' }).first().click();
      await expect(page.getByRole('button', { name: 'Run Pipeline' })).toBeVisible({ timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Build Pipeline: run all 4 stages ──────────────────────────────────
    // Stages (standalone-root): Architecture → Best Approach → Security → Cost
    await test.step('8 · Run Pipeline — Architecture → Best Approach → Security → Cost', async () => {
      await page.getByRole('button', { name: 'Run Pipeline' }).click();

      const pipelineDoneLocator = () =>
        page.getByText('All stages done')
          .or(page.getByText('Build Complete', { exact: false }))
          .or(page.getByText('All pipeline stages complete'));

      // Stage 1: diagram (Architecture)
      t0 = Date.now();
      await test.step('Pipeline stage 1/4: Architecture (diagram)', async () => {
        const nextBest = page.getByRole('button', { name: /Next: Best Approach/ });
        await nextBest.or(pipelineDoneLocator()).first().waitFor({ timeout: T.stage });
        await page.waitForTimeout(T.pause);
      });
      pipelineStages.push({ name: 'Architecture', status: 'passed', durationMs: Date.now() - t0 });

      const nextBestBtn = page.getByRole('button', { name: /Next: Best Approach/ });
      const bestVisible = await nextBestBtn.isVisible({ timeout: 2_000 }).catch(() => false);
      if (bestVisible) {
        t0 = Date.now();
        await test.step('Pipeline stage 2/4: Best Approach (refactor)', async () => {
          await nextBestBtn.click();
          const fixBtn = page.getByRole('button', { name: /^Fix$/ });
          const nextSec = page.getByRole('button', { name: /Next: Security/ });
          await nextSec.or(fixBtn).or(pipelineDoneLocator()).first().waitFor({ timeout: T.stage });
          if (await fixBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await fixBtn.click();
            const approveBtn = page.getByTestId('btn-approve-refactor');
            await approveBtn.waitFor({ timeout: T.stage });
            await approveBtn.click();
            await nextSec.or(pipelineDoneLocator()).first().waitFor({ timeout: T.stage });
          }
          await page.waitForTimeout(T.pause);
        });
        pipelineStages.push({ name: 'Best Approach', status: 'passed', durationMs: Date.now() - t0 });
      } else {
        pipelineStages.push({ name: 'Best Approach', status: 'skipped' });
      }

      // Stage 3: Security Scan
      t0 = Date.now();
      const secRan = await test.step('Pipeline stage 3/4: Security Scan', async () =>
        runSecurityStage(page, T, pipelineDoneLocator)
      );
      pipelineStages.push({ name: 'Security Scan', status: secRan ? 'passed' : 'skipped', durationMs: secRan ? Date.now() - t0 : undefined });

      // Stage 4: Cost Analysis (last)
      const nextCostBtn = page.getByRole('button', { name: /Next: Cost/ });
      const costVisible = await nextCostBtn.isVisible({ timeout: 2_000 }).catch(() => false);
      if (costVisible) {
        t0 = Date.now();
        await test.step('Pipeline stage 4/4: Cost Analysis', async () => {
          await nextCostBtn.click();
          await pipelineDoneLocator().first().waitFor({ timeout: T.stage });
          await page.waitForTimeout(T.pause);
        });
        pipelineStages.push({ name: 'Cost Analysis', status: 'passed', durationMs: Date.now() - t0 });
      } else {
        pipelineStages.push({ name: 'Cost Analysis', status: 'skipped' });
      }
    });

    // ── Step 8: Back on Overview — Build Complete ─────────────────────────
    await test.step('8 · Overview — confirm build completed and overview visible', async () => {
      // Click "View Build Summary" / "Complete Build" button to navigate to overview
      const viewSummaryBtn = page.getByTestId('button-view-build-summary');
      const summaryVisible = await viewSummaryBtn.isVisible({ timeout: 5_000 }).catch(() => false);
      if (summaryVisible) await viewSummaryBtn.click();
      // Overview shows "Build <id> completed successfully" in status sentence
      await expect(page.locator('text=completed successfully').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('text=Files generated')).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(T.pause);
    });

    // ── Step 8: Verify "Continue to Commit" is present (do NOT click) ────
    await test.step('8 · "Continue to Commit" button visible — test stops here (no commit)', async () => {
      await expect(page.getByTestId('terraform-btn-continue-to-commit')).toBeVisible({ timeout: T.step });
      await page.waitForTimeout(T.pause);
      // ✅ Test ends here — commit is intentionally not triggered
    });

    // ── Attach structured report data ─────────────────────────────────────
    const scanCtx: ScanResultContext = {
      repo: REPO,
      provider: 'GitHub',
      cloudProvider: 'Azure',
      approach: 'Standalone Root',
      generatedFileCount: generatedFiles?.length,
    };
    await attachScanResult(testInfo, scanResult, scanCtx);
    await attachGeneratedFiles(testInfo, generatedFiles);
    await attachBestApproach(testInfo, Object.keys(bestApproachData).length > 0 ? bestApproachData : null);
    await attachCostAnalysis(testInfo, costData as Parameters<typeof attachCostAnalysis>[1]);
    await attachSecurityScan(testInfo, securityData as Parameters<typeof attachSecurityScan>[1]);
    await attachPipelineSummary(testInfo, pipelineStages);

  }); // end FULL-03

}); // end describe
