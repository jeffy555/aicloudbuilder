/**
 * terraform-child-workflow.spec.ts
 *
 * Real end-to-end tests for the Child Module approach.
 * Uses the real GitHub repo "arch-repo" (no mocks except commit block).
 *
 * Child Module flow:
 *   GitHub → arch-repo (real scan) → Azure → Child Module →
 *   Step 6: Describe module directly (NO backend config step) →
 *   AI generates Terraform →
 *   Build Pipeline (Architecture → Best Approach → Security → Cost) →
 *   Assert Build Complete → STOP before commit
 *
 * Key differences vs Standalone Root:
 *   - Step 5 (backend config) is SKIPPED entirely — child modules don't need backends
 *   - Goes straight from module approach selection (Step 4) to description (Step 6)
 *   - Build Workspace renders at Step 8 (same as standalone)
 *   - Pipeline: diagram → refactor → security → cost (4 stages, same order as standalone/aggregated)
 *
 * Only mocked:
 *   - sessions/:id/commit → blocked (no accidental repo pushes)
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

// ─── AI-crafted child module description ──────────────────────────────────────
// Describes a single reusable Azure child module (not a root module).
// Kept focused so AI generation is fast and deterministic.
const INFRA_DESCRIPTION = `
Create a reusable Azure App Service child module for a Node.js web API.

The module should expose the following input variables:
1. resource_group_name (string) — the resource group to deploy into
2. location (string, default "eastus") — Azure region
3. app_service_plan_sku (string, default "B1") — pricing tier
4. node_version (string, default "18-lts") — Node.js runtime version
5. app_settings (map of string, default {}) — extra application settings

The module creates:
- An azurerm_app_service_plan (Linux, configurable SKU)
- An azurerm_linux_web_app bound to the plan, running Node.js

Outputs: app_service_id, app_service_default_hostname

Tag every resource with: managed-by = "terraform", module = "app-service-child"
`.trim();

// ─── Target repo ──────────────────────────────────────────────────────────────
const REPO = 'arch-repo';

// ─── Timeouts ─────────────────────────────────────────────────────────────────
const T = {
  step:      30_000,   // simple UI interaction
  pause:      1_500,   // visual pause between steps (headed mode)
  scan:      60_000,   // GitHub repo scan (network call)
  generate: 300_000,   // AI Terraform generation
  stage:    120_000,   // single pipeline stage
  pipeline: 360_000,   // full 4-stage pipeline
};

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Child Module Terraform Workflow (Azure)', () => {

  test.setTimeout(720_000); // 12 min ceiling (fix step needs up to 4 min for AI batches)

  // Block commit only — no other mocks
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/sessions/*/commit', route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ blocked: true, message: 'Commit disabled in E2E test' }),
      })
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  // CHILD-01: Smoke — app loads at Step 1
  // ────────────────────────────────────────────────────────────────────────────
  test('CHILD-01: App loads and shows GitHub provider card at Step 1', async ({ page, terraformPage }) => {
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await expect(page.locator('main h1')).toContainText('Terraform');
    await expect(terraformPage.providerCardGitHub).toBeVisible();
    await expect(page.getByText('Workflow Progress')).toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // CHILD-02: Step 2 shows arch-repo in the repository list
  // ────────────────────────────────────────────────────────────────────────────
  test('CHILD-02: Step 2 shows repository list with arch-repo after selecting GitHub', async ({ page, terraformPage }) => {
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
    await expect(page.locator('h2').filter({ hasText: 'Select Repository' }).first()).toBeVisible({ timeout: T.step });
    await expect(
      page.locator('[data-testid^="repo-item-"]').getByText(REPO, { exact: true }).first()
    ).toBeVisible({ timeout: T.step });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // CHILD-03: Child Module card is visible in Step 4 alongside the other approach cards
  // ────────────────────────────────────────────────────────────────────────────
  test('CHILD-03: All three module approach cards visible including Child Module', async ({ page, terraformPage }) => {
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
    // Select arch-repo → scan
    await page.locator('[data-testid^="repo-item-"]').getByText(REPO, { exact: true }).first().click();
    await page.waitForSelector(
      '[data-testid="card-provider-microsoft-azure"], button:has-text("Continue to"), [data-testid="card-provider-standalone-root"]',
      { timeout: T.scan }
    );
    // Handle existing-repo "Continue to" button if present
    const continueBtn = page.getByRole('button', { name: /Continue to/ });
    if (await continueBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForSelector(
        '[data-testid="card-provider-microsoft-azure"], [data-testid="card-provider-standalone-root"]',
        { timeout: T.step }
      );
    }
    // Select Azure if the cloud step is shown
    const azureCard = page.getByTestId('card-provider-microsoft-azure');
    if (await azureCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await azureCard.click();
    }
    // Module approach cards should now be visible
    await page.waitForSelector('[data-testid="card-provider-child-module"]', { timeout: T.step });
    await expect(page.getByTestId('card-provider-child-module')).toBeVisible();
    await expect(page.getByTestId('card-provider-standalone-root')).toBeVisible();
    await expect(page.getByTestId('card-provider-aggregated-root')).toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // CHILD-04: Full end-to-end workflow (no mocks except commit block)
  // ────────────────────────────────────────────────────────────────────────────
  test('CHILD-04: Complete workflow — arch-repo (real scan) → Child Module → AI generation → 4-stage pipeline', async ({ page, terraformPage }, testInfo) => {

    // ── Report enrichment setup ────────────────────────────────────────────
    annotateTest(testInfo, {
      approach:       'Child Module',
      repo:           REPO,
      cloudProvider:  'Azure',
      pipelineStages: 'Architecture → Best Approach → Security Scan → Cost Analysis',
    });
    await attachPrompt(testInfo, 'Child Module', INFRA_DESCRIPTION);

    // Collect live API responses for the report attachments
    let scanResult: ScanResult | null = null;
    let generatedFiles: GeneratedFile[] | null = null;
    let costData: Record<string, unknown> | null = null;
    const securityScans: Array<Record<string, unknown>> = []; // collect every scan response (initial + re-scan)
    const bestApproachData: BestApproachResult = {};

    page.on('response', async (response) => {
      const url = response.url();
      const ok = response.status() === 200;
      try {
        // Security scan: capture EVERY response (initial scan + re-scan after fix)
        if (/\/api\/sessions\/[^/]+\/scan$/.test(url) && response.request().method() === 'POST') {
          const body = await response.json();
          if (body && typeof body === 'object') securityScans.push(body as Record<string, unknown>);
          return;
        }
        if (!ok) return;
        if (url.includes('scan-repository')) {
          scanResult = await response.json() as ScanResult;
        } else if (url.includes('generate-terraform')) {
          const body = await response.json() as GeneratedFile[] | { files?: GeneratedFile[] };
          generatedFiles = Array.isArray(body) ? body : (body.files ?? null);
        } else if (url.includes('analyze-cost')) {
          costData = await response.json();
        } else if (/\/api\/sessions\/[^/]+\/refactor-fix$/.test(url)) {
          bestApproachData.fix = await response.json();
        } else if (/\/api\/sessions\/[^/]+\/refactor$/.test(url) && response.request().method() === 'POST') {
          const body = await response.json();
          // First call = initial validation; second call = post-fix re-validation
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

    // ── Step 1: Navigate fresh ────────────────────────────────────────────────
    await test.step('1 · Navigate to /terraform/app (fresh session)', async () => {
      await terraformPage.goto();
      await terraformPage.waitForStep1();
      await expect(page.locator('main h1')).toContainText('Terraform');
      await page.waitForTimeout(T.pause);
    });

    // ── Step 1: Select GitHub ─────────────────────────────────────────────────
    await test.step('1 · Select GitHub as repository provider', async () => {
      await terraformPage.providerCardGitHub.click();
      await terraformPage.waitForStep2();
      await expect(page.locator('h2').filter({ hasText: 'Select Repository' }).first()).toBeVisible();
      await page.waitForTimeout(T.pause);
    });

    // ── Step 2: Pick arch-repo ────────────────────────────────────────────────
    await test.step(`2 · Pick repository "${REPO}" from the list`, async () => {
      const repoItem = page.locator('[data-testid^="repo-item-"]').getByText(REPO, { exact: true }).first();
      await expect(repoItem).toBeVisible({ timeout: T.step });
      await repoItem.click();

      // Wait for scan — either cloud cards (new repo) or "Continue to" (existing repo)
      await page.waitForSelector(
        '[data-testid="card-provider-microsoft-azure"], button:has-text("Continue to")',
        { timeout: T.scan }
      );
      await page.waitForTimeout(T.pause);
    });

    // ── Step 2→3: Handle existing-repo scan result ────────────────────────────
    await test.step('2 · Advance past repo scan (handle existing or new repo)', async () => {
      const continueBtn = page.getByRole('button', { name: /Continue to/ });
      const hasBtn = await continueBtn.isVisible({ timeout: 3_000 }).catch(() => false);
      if (hasBtn) {
        await continueBtn.click();
        await page.waitForSelector(
          '[data-testid="card-provider-microsoft-azure"], [data-testid="card-provider-standalone-root"]',
          { timeout: T.step }
        );
      }
      await page.waitForTimeout(T.pause);
    });

    // ── Step 3: Cloud provider ────────────────────────────────────────────────
    await test.step('3 · Select Microsoft Azure cloud provider', async () => {
      const azureCard = page.getByTestId('card-provider-microsoft-azure');
      const onCloudStep = await azureCard.isVisible({ timeout: 3_000 }).catch(() => false);
      if (onCloudStep) {
        await azureCard.click();
      }
      // Module approach cards appear next
      await page.waitForSelector('[data-testid="card-provider-child-module"]', { timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Step 4: Select Child Module approach ──────────────────────────────────
    // Child Module skips backend config entirely — jumps straight to Step 6 (description)
    await test.step('4 · Select Child Module approach (no backend config step)', async () => {
      await expect(page.getByTestId('card-provider-child-module')).toBeVisible();
      await page.getByTestId('card-provider-child-module').click();

      // Child module skips Step 5 — wait directly for the description ChatInput
      await page.waitForSelector('[data-testid="input-chat"]', { timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Step 6: Enter child module description ────────────────────────────────
    await test.step('6 · Enter child module description (no backend fields to fill)', async () => {
      const chatInput = page.getByTestId('input-chat');
      await chatInput.click();
      await chatInput.fill(INFRA_DESCRIPTION);
      await page.waitForTimeout(300);
      await expect(chatInput).not.toBeEmpty();
      await page.waitForTimeout(T.pause);
    });

    // ── Step 6→8: Submit description → AI generates Terraform ─────────────────
    await test.step('6 · Submit description → wait for AI Terraform generation', async () => {
      // Start waiting for the API response BEFORE clicking so we don't miss a fast response
      const generateResponsePromise = page.waitForResponse(
        resp => resp.url().includes('generate-terraform') && resp.request().method() === 'POST',
        { timeout: T.generate }
      );

      await page.getByTestId('button-send').click();

      const generateResponse = await generateResponsePromise;
      const status = generateResponse.status();
      if (status !== 200) {
        const body = await generateResponse.text().catch(() => 'could not read body');
        throw new Error(`Generate Terraform API returned ${status}:\n${body}`);
      }

      // Generation succeeded — wait for Build Pipeline button (Step 8)
      await page.waitForSelector('button:has-text("Build Pipeline")', { timeout: 30_000 });
    });

    // ── Step 8: Verify Overview stats ────────────────────────────────────────
    await test.step('8 · Overview — verify generated file count and cloud label', async () => {
      await page.waitForTimeout(T.pause);
      await expect(page.getByRole('button', { name: 'Build Pipeline' }).first()).toBeVisible({ timeout: 10_000 });
      // KPI card: "Files generated" with a number > 0
      await expect(page.locator('text=Files generated')).toBeVisible({ timeout: 10_000 });
      // Cloud label
      await expect(page.locator('text=AZURE').first()).toBeVisible({ timeout: 5_000 });
    });

    // ── Step 8: Switch to Build Pipeline tab ─────────────────────────────────
    await test.step('8 · Switch to Build Pipeline tab', async () => {
      await page.getByRole('button', { name: 'Build Pipeline' }).first().click();
      await expect(page.getByRole('button', { name: 'Run Pipeline' })).toBeVisible({ timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Build Pipeline: run 4 stages ──────────────────────────────────────────
    await test.step('8 · Run Pipeline — Architecture → Best Approach → Security → Cost', async () => {
      await page.getByRole('button', { name: 'Run Pipeline' }).click();

      // Accept any of the completion signals
      const pipelineDoneLocator = () =>
        page.getByText('All stages done')
          .or(page.getByText('Build Complete', { exact: false }))
          .or(page.getByText('All pipeline stages complete'));

      // Stage 1: diagram (Architecture) — starts automatically, may not generate for child module
      t0 = Date.now();
      await test.step('Pipeline stage 1/4: Architecture (diagram)', async () => {
        const nextBest = page.getByRole('button', { name: /Next: Best Approach|Next: Refactor/ });
        await nextBest.or(pipelineDoneLocator()).first().waitFor({ timeout: T.stage });
        await page.waitForTimeout(T.pause);
      });
      pipelineStages.push({ name: 'Architecture', status: 'passed', durationMs: Date.now() - t0 });

      // Stage 2: refactor (Best Approach and Fix)
      const nextBestBtn = page.getByRole('button', { name: /Next: Best Approach|Next: Refactor/ });
      const bestVisible = await nextBestBtn.isVisible({ timeout: 2_000 }).catch(() => false);
      if (bestVisible) {
        t0 = Date.now();
        await test.step('Pipeline stage 2/4: Best Approach and Fix (refactor)', async () => {
          await nextBestBtn.click();
          // Wait for validation to finish — "Next: Security" appears OR Fix button shows
          const nextSec = page.getByRole('button', { name: /Next: Security/ });
          const fixBtn = page.getByRole('button', { name: /^Fix$/ });
          await nextSec.or(fixBtn).or(pipelineDoneLocator()).first().waitFor({ timeout: T.stage });

          // If issues found: click Fix → wait for Approve → click Approve
          if (await fixBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await fixBtn.click();
            const approveBtn = page.getByTestId('btn-approve-refactor');
            await approveBtn.waitFor({ timeout: T.stage });
            await approveBtn.click();
            // After approval, "Next: Security" should appear
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

    // ── Step 8: Confirm Build Complete ───────────────────────────────────────
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

    // ── Step 8: Verify "Continue to Commit" is present — do NOT click ─────────
    await test.step('8 · "Continue to Commit" button visible — test stops here (no commit)', async () => {
      await expect(page.getByTestId('terraform-btn-continue-to-commit')).toBeVisible({ timeout: T.step });
      await page.waitForTimeout(T.pause);
      // Test ends here — commit is intentionally not triggered
    });

    // ── Attach structured report data ─────────────────────────────────────
    // Allow async response listeners to settle (response.json() is async)
    await page.waitForTimeout(2_000);

    const scanCtx: ScanResultContext = {
      repo: REPO,
      provider: 'GitHub',
      cloudProvider: 'Azure',
      approach: 'Child Module',
      generatedFileCount: generatedFiles?.length,
    };
    await attachScanResult(testInfo, scanResult, scanCtx);
    await attachGeneratedFiles(testInfo, generatedFiles);
    await attachBestApproach(testInfo, Object.keys(bestApproachData).length > 0 ? bestApproachData : null);
    await attachCostAnalysis(testInfo, costData as Parameters<typeof attachCostAnalysis>[1]);
    // No re-scan — use first (and only) security scan result
    const securityData = securityScans.length > 0 ? securityScans[0] : null;
    await attachSecurityScan(testInfo, securityData as Parameters<typeof attachSecurityScan>[1]);
    await attachPipelineSummary(testInfo, pipelineStages);

  }); // end CHILD-04

}); // end describe
