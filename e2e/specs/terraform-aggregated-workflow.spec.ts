/**
 * terraform-aggregated-workflow.spec.ts
 *
 * Real end-to-end tests for the Aggregated Root module approach.
 * Uses the real GitHub repo "child-modules" (jeffy555/child-modules) which contains:
 *   - AppService/           → azurerm_app_service
 *   - AppServicePlan/       → azurerm_app_service_plan
 *   - ContainerRegistry/    → azurerm_container_registry
 *   - KubernetesCluster/    → azurerm_kubernetes_cluster
 *
 * Key differences vs Standalone Root:
 *   - Step 4 child repo: "child-modules" (real scan — NO mock)
 *   - validate-aggregated-resources: real AI call (NO mock)
 *   - Pipeline: Architecture → Best Approach → Security Scan → Cost Analysis (4 stages)
 *   - Security stage: fix → approve → complete (no re-scan)
 *   - Build Complete at Step 9
 *
 * Only mocked:
 *   - sessions/:id/commit → blocked (no accidental pushes)
 *
 * Test user: e2e_workflow_user (created by global.setup.full.ts)
 * Estimated run time: ~6–12 minutes (AI generation + 4-stage pipeline with security fix)
 */
import { test, expect } from '../fixtures';
import {
  annotateTest, attachPrompt, attachScanResult, attachGeneratedFiles,
  attachBestApproach, attachCostAnalysis, attachSecurityScan, attachPipelineSummary, runSecurityStage,
  type ScanResult, type GeneratedFile, type BestApproachResult, type ScanResultContext,
} from '../helpers/report-enricher';

// ─── Infrastructure description — references real child-modules resource types ─
// child-modules repo exports: azurerm_app_service, azurerm_app_service_plan,
//   azurerm_container_registry, azurerm_kubernetes_cluster
const INFRA_DESCRIPTION =
  'Create a root module for Azure using the child modules. ' +
  'Deploy an azurerm_app_service_plan and an azurerm_app_service for a web API. ' +
  'Add an azurerm_container_registry for Docker image storage. ' +
  'Tag all resources with project agg-e2e and stage staging.';

// ─── Backend values (filled but skipped — no real Azure provisioning) ─────────
const BACKEND = {
  resourceGroup:  'tfstate-agg-e2e-rg',
  storageAccount: 'tfstateagge2e99',
  container:      'tfstateaggcontainer',
};

// ─── Repos ────────────────────────────────────────────────────────────────────
const CHILD_REPO = 'child-modules';   // real repo with 4 Azure child modules
const ROOT_REPO  = 'arch-repo';       // root module target repo

// ─── Timeouts ─────────────────────────────────────────────────────────────────
const T = {
  step:      30_000,
  pause:      1_500,
  scan:      90_000,   // real GitHub scan — allow extra time
  generate: 300_000,
  stage:    120_000,   // single pipeline stage
  pipeline: 540_000,   // 4 stages including security with fix → approve
};

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Aggregated Root Terraform Workflow (Azure)', () => {

  test.setTimeout(720_000); // 12 min ceiling (security fix needs up to 4 min for AI batches)

  // Only block commit — no other mocks
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/sessions/*/commit', route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ blocked: true, message: 'Commit disabled in E2E test' }),
      })
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AGG-01: Smoke — app loads at Step 1
  // ────────────────────────────────────────────────────────────────────────────
  test('AGG-01: App loads and shows provider card at Step 1', async ({ page, terraformPage }) => {
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await expect(page.locator('main h1')).toContainText('Terraform');
    await expect(terraformPage.providerCardGitHub).toBeVisible();
    await expect(page.getByText('Workflow Progress')).toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AGG-02: After GitHub → Step 2 shows repo list (same start as standalone)
  // ────────────────────────────────────────────────────────────────────────────
  test('AGG-02: Step 2 shows repository list after selecting GitHub', async ({ page, terraformPage }) => {
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
    await expect(page.locator('h2').filter({ hasText: 'Select Repository' }).first()).toBeVisible({ timeout: T.step });
    // Both repos should appear in the list
    await expect(page.locator('[data-testid^="repo-item-"]').getByText(CHILD_REPO, { exact: true }).first()).toBeVisible({ timeout: T.step });
    await expect(page.locator('[data-testid^="repo-item-"]').getByText(ROOT_REPO, { exact: true }).first()).toBeVisible({ timeout: T.step });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AGG-03: All three module approach cards visible (Child / Standalone / Aggregated)
  // ────────────────────────────────────────────────────────────────────────────
  test('AGG-03: All three module approach cards visible including Aggregated Root', async ({ page, terraformPage }) => {
    await terraformPage.goto();
    await terraformPage.waitForStep1();
    await terraformPage.providerCardGitHub.click();
    await terraformPage.waitForStep2();
    // Pick arch-repo (any repo) → scan → cloud provider step
    await page.locator('[data-testid^="repo-item-"]').getByText(ROOT_REPO, { exact: true }).first().click();
    await page.waitForSelector(
      '[data-testid="card-provider-microsoft-azure"], button:has-text("Continue to"), [data-testid="card-provider-standalone-root"]',
      { timeout: T.scan }
    );
    const continueBtn = page.getByRole('button', { name: /Continue to/ });
    if (await continueBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForSelector(
        '[data-testid="card-provider-microsoft-azure"], [data-testid="card-provider-standalone-root"]',
        { timeout: T.step }
      );
    }
    const azureCard = page.getByTestId('card-provider-microsoft-azure');
    if (await azureCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await azureCard.click();
    }
    await page.waitForSelector('[data-testid="card-provider-standalone-root"]', { timeout: T.step });
    await expect(page.getByTestId('card-provider-child-module')).toBeVisible();
    await expect(page.getByTestId('card-provider-standalone-root')).toBeVisible();
    await expect(page.getByTestId('card-provider-aggregated-root')).toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AGG-04: Full workflow end-to-end (no mocks except commit block)
  // ────────────────────────────────────────────────────────────────────────────
  test('AGG-04: Complete workflow — child-modules (real scan) → AI generation → 4-stage pipeline with security fix', async ({ page, terraformPage }, testInfo) => {

    // ── Report enrichment setup ────────────────────────────────────────────
    annotateTest(testInfo, {
      approach:       'Aggregated Root',
      repo:           `child-modules → ${ROOT_REPO}`,
      cloudProvider:  'Azure',
      pipelineStages: 'Architecture → Best Approach → Security Scan → Cost Analysis',
    });
    await attachPrompt(testInfo, 'Aggregated Root', INFRA_DESCRIPTION);

    // Collect live API responses for the report attachments
    let scanResult: ScanResult | null = null;
    let generatedFiles: GeneratedFile[] | null = null;
    let costData: Record<string, unknown> | null = null;
    const securityScans: Array<Record<string, unknown>> = []; // collect every scan response (initial + re-scan)
    const bestApproachData: BestApproachResult = {};

    page.on('response', async (response) => {
      const url = response.url();
      const ok  = response.status() === 200;
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

    // ── Step 1: Navigate fresh ─────────────────────────────────────────────
    await test.step('1 · Navigate to /terraform/app (fresh session)', async () => {
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

    // ── Step 2: Pick arch-repo (root module target) for initial scan ───────
    await test.step(`2 · Pick root module repository "${ROOT_REPO}" for cloud detection`, async () => {
      const repoItem = page.locator('[data-testid^="repo-item-"]').getByText(ROOT_REPO, { exact: true }).first();
      await expect(repoItem).toBeVisible({ timeout: T.step });
      await repoItem.click();
      await page.waitForSelector(
        '[data-testid="card-provider-microsoft-azure"], button:has-text("Continue to")',
        { timeout: T.scan }
      );
      await page.waitForTimeout(T.pause);
    });

    // ── Step 2→3: Handle existing-repo scan result ─────────────────────────
    await test.step('2 · Advance past repo scan', async () => {
      const continueBtn = page.getByRole('button', { name: /Continue to/ });
      if (await continueBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await continueBtn.click();
        await page.waitForSelector(
          '[data-testid="card-provider-microsoft-azure"], [data-testid="card-provider-standalone-root"]',
          { timeout: T.step }
        );
      }
      await page.waitForTimeout(T.pause);
    });

    // ── Step 3: Cloud provider (Azure) ─────────────────────────────────────
    await test.step('3 · Select Microsoft Azure cloud provider', async () => {
      const azureCard = page.getByTestId('card-provider-microsoft-azure');
      if (await azureCard.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await azureCard.click();
      }
      await page.waitForSelector('[data-testid="card-provider-standalone-root"]', { timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Step 4a: Select "Aggregated Root" module approach ──────────────────
    await test.step('4 · Select Aggregated Root module approach', async () => {
      await expect(page.getByTestId('card-provider-aggregated-root')).toBeVisible();
      await page.getByTestId('card-provider-aggregated-root').click();
      await page.waitForSelector('h2:has-text("Select Child Module Repository")', { timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Step 4b: Select child-modules repo → REAL scan extracts 4 resources ─
    await test.step(`4 · Select child module repo "${CHILD_REPO}" — real scan extracts Terraform resources`, async () => {
      const childRepoItem = page.locator('[data-testid^="repo-item-"]').getByText(CHILD_REPO, { exact: true }).first();
      await expect(childRepoItem).toBeVisible({ timeout: T.step });
      await childRepoItem.click();

      // Real scan-child-module API runs against child-modules repo
      // Expects: AppService, AppServicePlan, ContainerRegistry, KubernetesCluster
      await page.waitForSelector('h3:has-text("Available Child Module Resources")', { timeout: T.scan });

      // Verify at least one real resource type from child-modules repo
      await expect(
        page.locator('text=azurerm_app_service').or(page.locator('text=azurerm_app_service_plan')).first()
      ).toBeVisible({ timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Step 4→6: Continue past child module review → backend ─────────────
    // The button now skips Step 5 (root repo re-selection) since arch-repo was
    // already selected in Step 2. It goes straight to Step 6 (backend config).
    await test.step('4 · Continue to Backend (root repo already selected — Step 5 skipped)', async () => {
      const continueBtn = page.getByRole('button', { name: /Continue to (Root Module Repository|Backend)/ });
      await expect(continueBtn).toBeVisible({ timeout: T.step });
      await continueBtn.click();

      // Backend config (Step 6) should appear — Step 5 is skipped
      await page.waitForSelector(
        '[data-testid="button-backend-decline"], [data-testid="input-chat"]',
        { timeout: T.step }
      );
      await page.waitForTimeout(T.pause);
    });

    // ── Step 6: Fill backend fields then skip ──────────────────────────────
    await test.step(`6 · Fill backend (RG=${BACKEND.resourceGroup}) then skip provisioning`, async () => {
      const declineVisible = await page.getByTestId('button-backend-decline').isVisible({ timeout: 3_000 }).catch(() => false);
      if (declineVisible) {
        await terraformPage.backendResourceGroup.fill(BACKEND.resourceGroup);
        await terraformPage.backendStorageAccount.fill(BACKEND.storageAccount);
        await terraformPage.backendContainer.fill(BACKEND.container);
        await expect(terraformPage.backendCreateButton).toBeEnabled({ timeout: 3_000 });
        await page.waitForTimeout(T.pause);
        await terraformPage.backendDeclineButton.click();
        await page.waitForSelector('[data-testid="input-chat"]', { timeout: T.step });
      }
      await page.waitForTimeout(T.pause);
    });

    // ── Step 7: Enter description referencing real child-modules resources ──
    await test.step('7 · Enter infrastructure description using real child module resources', async () => {
      // Confirm the real child-module resources panel is visible
      await expect(page.locator('h3:has-text("Available Child Module Resources")')).toBeVisible({ timeout: T.step });

      const chatInput = page.getByTestId('input-chat');
      await chatInput.click();
      await chatInput.fill(INFRA_DESCRIPTION);
      await page.waitForTimeout(300);
      await expect(chatInput).not.toBeEmpty();
      await page.waitForTimeout(T.pause);
    });

    // ── Step 7: Submit → real AI validation → "Continue to Generate" ───────
    await test.step('7 · Submit → real validate-aggregated-resources AI call → Validation Successful', async () => {
      await page.getByTestId('button-send').click();

      // Real AI validation against child-modules repo resources
      // description references azurerm_app_service_plan + azurerm_app_service
      // which exist in child-modules → should pass
      await page.waitForSelector('h3:has-text("Validation Successful")', { timeout: T.scan });
      await expect(page.getByRole('button', { name: /Continue to Generate/ })).toBeVisible({ timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Step 7→9: Generate Terraform via AI ───────────────────────────────
    await test.step('7 · Click "Continue to Generate" → AI generates Terraform → Build Workspace (Step 9)', async () => {
      const generateResponsePromise = page.waitForResponse(
        resp => resp.url().includes('generate-terraform') && resp.request().method() === 'POST',
        { timeout: T.generate }
      );

      await page.getByRole('button', { name: /Continue to Generate/ }).click();

      const generateResponse = await generateResponsePromise;
      if (generateResponse.status() !== 200) {
        const body = await generateResponse.text().catch(() => 'could not read body');
        throw new Error(`Generate Terraform API returned ${generateResponse.status()}:\n${body}`);
      }

      // Advances directly to Step 9 (Build Workspace)
      await page.waitForSelector('button:has-text("Build Pipeline")', { timeout: 30_000 });
    });

    // ── Step 9: Verify Overview ────────────────────────────────────────────
    await test.step('9 · Overview — verify generated files and AZURE label', async () => {
      await page.waitForTimeout(T.pause);
      await expect(page.getByRole('button', { name: 'Build Pipeline' }).first()).toBeVisible({ timeout: 10_000 });
      // KPI card: "Files generated" with a number > 0
      await expect(page.locator('text=Files generated')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('text=AZURE').first()).toBeVisible({ timeout: 5_000 });
    });

    // ── Step 9: Build Pipeline tab ────────────────────────────────────────
    await test.step('9 · Switch to Build Pipeline tab', async () => {
      await page.getByRole('button', { name: 'Build Pipeline' }).first().click();
      await expect(page.getByRole('button', { name: 'Run Pipeline' })).toBeVisible({ timeout: T.step });
      await page.waitForTimeout(T.pause);
    });

    // ── Build Pipeline: Architecture → Best Approach → Security → Cost (4 stages) ──
    await test.step('9 · Run Pipeline — Architecture → Best Approach → Security → Cost', async () => {
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

    // ── Step 9: Build Complete ─────────────────────────────────────────────
    await test.step('9 · Overview — confirm build completed and overview visible', async () => {
      // Click "View Build Summary" / "Complete Build" button to navigate to overview
      const viewSummaryBtn = page.getByTestId('button-view-build-summary');
      const summaryVisible = await viewSummaryBtn.isVisible({ timeout: 5_000 }).catch(() => false);
      if (summaryVisible) await viewSummaryBtn.click();

      // Fallback: if btn-complete-build is still visible (security pending), click it first
      const completeBuildBtn = page.getByTestId('btn-complete-build');
      if (await completeBuildBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await completeBuildBtn.click();
        await completeBuildBtn.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
        // After btn-complete-build, the view-build-summary button appears
        const viewBtn2 = page.getByTestId('button-view-build-summary');
        if (await viewBtn2.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await viewBtn2.click();
        }
      }

      // Overview shows "Build <id> completed successfully" in status sentence
      await expect(page.locator('text=completed successfully').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('text=Files generated')).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(T.pause);
    });

    // ── Final: verify commit button present — do NOT click ─────────────────
    await test.step('9 · "Continue to Commit" visible — test stops here (no commit)', async () => {
      await expect(page.getByTestId('terraform-btn-continue-to-commit')).toBeVisible({ timeout: T.step });
      await page.waitForTimeout(T.pause);
      // Test ends here — commit is intentionally not triggered
    });

    // ── Attach structured report data ─────────────────────────────────────
    // Allow async response listeners to settle (response.json() is async)
    await page.waitForTimeout(2_000);

    const scanCtx: ScanResultContext = {
      repo: `${CHILD_REPO} → ${ROOT_REPO}`,
      provider: 'GitHub',
      cloudProvider: 'Azure',
      approach: 'Aggregated Root',
      generatedFileCount: (generatedFiles as GeneratedFile[] | null)?.length,
    };
    await attachScanResult(testInfo, scanResult, scanCtx);
    await attachGeneratedFiles(testInfo, generatedFiles);
    await attachBestApproach(testInfo, Object.keys(bestApproachData).length > 0 ? bestApproachData : null);
    await attachCostAnalysis(testInfo, costData as Parameters<typeof attachCostAnalysis>[1]);

    // No re-scan — use first (and only) security scan result
    const securityData = securityScans.length > 0 ? securityScans[0] : null;
    await attachSecurityScan(testInfo, securityData as Parameters<typeof attachSecurityScan>[1]);
    await attachPipelineSummary(testInfo, pipelineStages);

  }); // end AGG-04

}); // end describe
