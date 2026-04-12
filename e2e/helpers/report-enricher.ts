/**
 * report-enricher.ts
 *
 * Utilities for enriching Playwright HTML reports with structured test data:
 * - Annotations (shown as coloured metadata pills in the HTML report)
 * - Text/JSON attachments (shown as clickable links in the HTML report)
 *
 * Usage:
 *   import { annotateTest, attachPrompt, attachScanResult, ... } from '../helpers/report-enricher';
 */
import type { TestInfo, Page } from '@playwright/test';
import { test } from '@playwright/test';

// ─── Types mirroring the real API response shapes ────────────────────────────

export interface ScanResult {
  isExisting: boolean;
  cloudProvider: string | null;
  moduleType: string | null;
  terraformFiles: string[];
  existingResources?: Array<{ type: string; name: string }>;
  hasResources: boolean;
  hasModules: boolean;
  providerBlocks: string[];
  backend: { hasBackend: boolean; backendType?: string | null };
  filesStored?: number;
}

export interface GeneratedFile {
  id?: string;
  fileName: string;
  content?: string;
}

export interface CostSummary {
  monthlyGrandTotal: number;
  yearlyGrandTotal: number;
  currency: string;
  exactCount: number;
  estimatedCount: number;
  freeCount: number;
  needsInputCount?: number;
  resourceCount: number;
}

export interface CostResource {
  resourceType?: string;
  resourceName?: string;
  monthlyCost?: number;
  status?: string;
  pricingMatchType?: string;
}

export interface SecurityScanResult {
  // CheckovScanner API shape: summary object + arrays of check objects
  summary?: { passed?: number; failed?: number; skipped?: number; total?: number; passPercentage?: number };
  passedChecks?: number | Array<{ checkId?: string; checkName?: string; resource?: string }>;
  failedChecks?: number | Array<{ checkId?: string; checkName?: string; resource?: string; file?: string; reason?: string }>;
  fixedChecks?: Array<{ checkId?: string; checkName?: string; resource?: string; file?: string; verified?: boolean }>;
  skippedChecks?: number | unknown[];
  // Legacy / nested shape
  results?: Array<{ check_type?: string; summary?: Record<string, number> }>;
}

export interface BestApproachResult {
  // From POST /api/sessions/:id/refactor
  validation?: {
    isValid?: boolean;
    issues?: Array<{ file?: string; type?: string; severity?: string; message?: string; line?: number; suggestion?: string }>;
    suggestions?: Array<{ file?: string; action?: string; details?: string }>;
    summary?: { totalIssues?: number; errors?: number; warnings?: number; filesChecked?: number };
  };
  // From POST /api/sessions/:id/refactor-fix
  fix?: {
    success?: boolean;
    fixedIssues?: number;
    passes?: number;
    message?: string;
    fixes?: string[];
    fixesByPass?: Array<{ pass: number; fixes: string[] }>;
  };
  // Re-validation after fix (second call to /refactor)
  afterFix?: {
    isValid?: boolean;
    summary?: { totalIssues?: number; errors?: number; warnings?: number };
  };
}

// ─── Pipeline helpers ─────────────────────────────────────────────────────────

/**
 * Runs the Security Scan pipeline stage, handling the full fix → approve → complete flow.
 *
 * Three outcomes:
 *   1. Clean scan   — pipeline auto-advances to "All stages done" / "Build Complete"
 *   2. Issues found — select all → fix selected → approve changes → complete (no re-scan)
 *   3. No button    — stage was skipped (returns false)
 *
 * Returns true if the stage ran, false if it was skipped.
 */
export async function runSecurityStage(
  page: Page,
  timeouts: { step: number; stage: number; pause: number },
  pipelineDoneLocator: () => ReturnType<Page['locator']>,
): Promise<boolean> {
  const nextSecBtn = page.getByRole('button', { name: /Next: Security/ });
  const secVisible = await nextSecBtn.isVisible({ timeout: 2_000 }).catch(() => false);
  if (!secVisible) return false;

  await nextSecBtn.click();

  // Wait for scan to finish: clean (Next: Cost when cost is last), pipeline done, or issues found
  const scanDone = () =>
    page.getByRole('button', { name: /Next: Cost/ })
      .or(pipelineDoneLocator())
      .or(page.getByTestId('btn-complete-build'))
      .or(page.getByTestId('btn-select-all-checks'));

  await scanDone().first().waitFor({ timeout: timeouts.stage });

  const hasIssues = await page.getByTestId('btn-select-all-checks').isVisible({ timeout: 2_000 }).catch(() => false);

  if (hasIssues) {
    await test.step('Security: select all checks and apply fix', async () => {
      // Select every failed check
      await page.getByTestId('btn-select-all-checks').click();
      await page.getByTestId('btn-fix-selected').waitFor({ timeout: timeouts.step });

      // Kick off the fix — terminal (black screen) will appear
      await page.getByTestId('btn-fix-selected').click();

      // Wait for fix terminal ("applying fixes") then for "Approve Changes" to appear
      // Fix involves sequential AI calls per batch — needs longer timeout than a normal stage
      await page.waitForSelector('text=applying fixes', { timeout: timeouts.step }).catch(() => {});
      await page.getByTestId('btn-approve-changes').waitFor({ timeout: timeouts.stage * 2 });
    });

    await test.step('Security: approve changes → complete build', async () => {
      await page.getByTestId('btn-approve-changes').click();

      // No re-scan after approve. Approving fires onScanComplete → pipeline advances.
      // After approve: onFixesApproved clears securityPendingCompletion, then
      // handleActivityComplete('security') sets buildFinishPending → shows
      // "All stages done" + button-view-build-summary in the sidebar footer.
      const completionLocator = () =>
        page.getByRole('button', { name: /Next: Cost/ })
          .or(pipelineDoneLocator())
          .or(page.getByTestId('btn-complete-build'))
          .or(page.getByTestId('button-view-build-summary'));

      await completionLocator().first().waitFor({ timeout: timeouts.stage });

      // If "Complete Build" sidebar button visible (security was last stage), click it
      const completeBuildBtn = page.getByTestId('btn-complete-build');
      if (await completeBuildBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await completeBuildBtn.click();
        await completeBuildBtn.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
        await pipelineDoneLocator().first().waitFor({ timeout: timeouts.stage });
      }
    });
  } else {
    // scan done check matched btn-complete-build (issues found but select-all not visible) —
    // click it now to advance the pipeline
    const completeBuildBtn = page.getByTestId('btn-complete-build');
    if (await completeBuildBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await completeBuildBtn.click();
      await completeBuildBtn.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
      await pipelineDoneLocator().first().waitFor({ timeout: timeouts.stage });
    }
  }

  await page.waitForTimeout(timeouts.pause);
  return true;
}

// ─── Annotation helpers ───────────────────────────────────────────────────────

/**
 * Add key metadata annotations visible at the top of every test in the HTML report.
 */
export function annotateTest(
  testInfo: TestInfo,
  opts: {
    approach: 'Child Module' | 'Standalone Root' | 'Aggregated Root';
    repo: string;
    cloudProvider: string;
    pipelineStages: string;
  }
) {
  testInfo.annotations.push(
    { type: 'Module Approach', description: opts.approach },
    { type: 'Repository',      description: opts.repo },
    { type: 'Cloud Provider',  description: opts.cloudProvider },
    { type: 'Pipeline Stages', description: opts.pipelineStages },
  );
}

// ─── Attachment helpers ───────────────────────────────────────────────────────

/** Attach the full AI description used to generate the Terraform. */
export async function attachPrompt(
  testInfo: TestInfo,
  approach: string,
  description: string
) {
  const body = [
    `Module Approach : ${approach}`,
    `Prompt Length   : ${description.length} characters`,
    ``,
    `── Full Prompt ────────────────────────────────────────────────────────────────`,
    description,
  ].join('\n');

  await testInfo.attach('AI Prompt', { body, contentType: 'text/plain' });
}

export interface ScanResultContext {
  repo: string;
  provider: string;
  cloudProvider: string;
  approach: string;
  generatedFileCount?: number;
}

/** Attach a summary of the repository scan result. */
export async function attachScanResult(
  testInfo: TestInfo,
  data: ScanResult | null,
  ctx?: ScanResultContext
) {
  const resourceLines = (data?.existingResources ?? []).map(
    r => `    ${r.type}.${r.name}`
  );

  const lines: string[] = [
    `Repository Scan Report`,
    `═══════════════════════════════`,
  ];

  // Session context (always shown when provided)
  if (ctx) {
    lines.push(
      `Repository       : ${ctx.repo}`,
      `Git Provider     : ${ctx.provider}`,
      `Cloud Provider   : ${ctx.cloudProvider}`,
      `Module Approach  : ${ctx.approach}`,
    );
    if (ctx.generatedFileCount != null) {
      lines.push(`Generated Files  : ${ctx.generatedFileCount}`);
    }
    lines.push('');
  }

  if (!data) {
    lines.push('Scan result not captured.');
    await testInfo.attach('Repository Scan', { body: lines.join('\n'), contentType: 'text/plain' });
    return;
  }

  lines.push(
    `── Repo Scan ──────────────────────────────────────────────────────────`,
    `Is Existing Repo : ${data.isExisting ? 'yes — has existing Terraform files' : 'no — new repo (files will be generated)'}`,
    `Detected Type    : ${data.moduleType ?? 'not detected'}`,
    `Detected Cloud   : ${data.cloudProvider ?? 'not detected'}`,
    `Has Resources    : ${data.hasResources ? 'yes' : 'no'}`,
    `Has Modules      : ${data.hasModules ? 'yes' : 'no'}`,
    `Backend Config   : ${data.backend?.hasBackend ? `yes (${data.backend.backendType ?? 'unknown'})` : 'no'}`,
    `Files in Session : ${data.filesStored ?? 'n/a'}`,
  );

  if (data.terraformFiles.length > 0) {
    lines.push('', `Terraform Files (${data.terraformFiles.length}):`);
    data.terraformFiles.forEach(f => lines.push(`    ${f}`));
  } else {
    lines.push('', 'Terraform Files  : none found in repo (this is expected for new repos)');
  }

  if (resourceLines.length > 0) {
    lines.push('', `Existing Resources (${resourceLines.length}):`, ...resourceLines);
  }

  await testInfo.attach('Repository Scan', { body: lines.join('\n'), contentType: 'text/plain' });
}

/** Attach a summary of the generated Terraform files. */
export async function attachGeneratedFiles(
  testInfo: TestInfo,
  files: GeneratedFile[] | null
) {
  if (!files || files.length === 0) return;

  const tfFiles    = files.filter(f => f.fileName.endsWith('.tf'));
  const varFiles   = files.filter(f => f.fileName.endsWith('.tfvars'));
  const otherFiles = files.filter(f => !f.fileName.endsWith('.tf') && !f.fileName.endsWith('.tfvars'));

  const body = [
    `Generated Terraform Files`,
    `═══════════════════════════════`,
    `Total Files : ${files.length}`,
    `  .tf       : ${tfFiles.length}`,
    `  .tfvars   : ${varFiles.length}`,
    `  other     : ${otherFiles.length}`,
    ``,
    `File Listing:`,
    ...files.map(f => {
      const lines = (f.content ?? '').split('\n').length;
      return `    ${f.fileName.padEnd(40)} (${lines} lines)`;
    }),
  ].join('\n');

  await testInfo.attach('Generated Files', { body, contentType: 'text/plain' });
}

/** Attach cost analysis summary + per-resource breakdown. */
export async function attachCostAnalysis(
  testInfo: TestInfo,
  data: { summary?: CostSummary; resources?: CostResource[] } | null
) {
  if (!data?.summary) return;

  const s = data.summary;
  const resources = data.resources ?? [];

  const resourceLines = resources
    .filter(r => (r.monthlyCost ?? 0) > 0)
    .sort((a, b) => (b.monthlyCost ?? 0) - (a.monthlyCost ?? 0))
    .map(r =>
      `    ${(r.resourceType ?? 'unknown').padEnd(45)} ${r.resourceName?.padEnd(25) ?? ''}  $${(r.monthlyCost ?? 0).toFixed(2)}/mo  [${r.status ?? '?'}]`
    );

  const freeLines = resources
    .filter(r => (r.monthlyCost ?? 0) === 0 && r.pricingMatchType === 'free')
    .map(r => `    ${(r.resourceType ?? 'unknown').padEnd(45)} (free)`);

  const body = [
    `Cost Analysis Report`,
    `═══════════════════════════════`,
    `Monthly Total (Grand) : $${s.monthlyGrandTotal.toFixed(2)} ${s.currency}`,
    `Yearly  Total (Grand) : $${s.yearlyGrandTotal.toFixed(2)} ${s.currency}`,
    ``,
    `Resource Counts:`,
    `  Exact pricing    : ${s.exactCount}`,
    `  Estimated        : ${s.estimatedCount}`,
    `  Free resources   : ${s.freeCount}`,
    `  Needs input      : ${s.needsInputCount ?? 0}`,
    `  Total resources  : ${s.resourceCount}`,
    ``,
    ...(resourceLines.length > 0
      ? [`Paid Resources (sorted by cost):`, ...resourceLines, ``]
      : []),
    ...(freeLines.length > 0
      ? [`Free Resources:`, ...freeLines]
      : []),
  ].join('\n');

  await testInfo.attach('Cost Analysis', { body, contentType: 'text/plain' });
}

/** Attach Best Approach (refactor validator) results: what was fixed and what remains. */
export async function attachBestApproach(
  testInfo: TestInfo,
  data: BestApproachResult | null
) {
  if (!data) return;

  const v      = data.validation;
  const f      = data.fix;
  const after  = data.afterFix;

  const filesChecked  = v?.summary?.filesChecked ?? 0;
  const initialIssues = v?.summary?.totalIssues  ?? 0;
  const initialErrors = v?.summary?.errors       ?? 0;
  const initialWarns  = v?.summary?.warnings     ?? 0;

  const fixedCount    = f?.fixedIssues ?? 0;
  const passes        = f?.passes      ?? 0;
  const fixes         = f?.fixes       ?? [];

  const remaining     = after?.summary?.totalIssues ?? (initialIssues - fixedCount);
  const isClean       = after?.isValid ?? (remaining === 0);

  const statusIcon = isClean ? '✅ All Issues Fixed' : `⚠️  ${remaining} Issue(s) Remain`;

  const lines: string[] = [
    `Best Approach (Refactor Validator)`,
    `═══════════════════════════════════`,
    `Status          : ${statusIcon}`,
    `Files Checked   : ${filesChecked}`,
    `Initial Issues  : ${initialIssues}  (${initialErrors} errors, ${initialWarns} warnings)`,
    `Fix Passes Run  : ${passes}`,
    ``,
  ];

  // Fixed items
  if (fixes.length > 0) {
    lines.push(`── Fixed (${fixedCount}) ─────────────────────────────────────────`);
    fixes.slice(0, fixedCount).forEach(fix => lines.push(`  ✅ ${fix}`));
    lines.push('');
  }

  // Still failing (original issues that weren't fixed)
  const remainingIssues = (v?.issues ?? []).slice(fixedCount);
  if (remainingIssues.length > 0) {
    lines.push(`── Still In Progress / Not Fixed (${remainingIssues.length}) ──────────`);
    remainingIssues.forEach(issue => {
      const loc = issue.line ? `${issue.file}:${issue.line}` : issue.file ?? 'unknown';
      lines.push(`  ❌ [${issue.severity?.toUpperCase() ?? 'ISSUE'}] ${issue.type} — ${loc}`);
      lines.push(`     ${issue.message}`);
      if (issue.suggestion) lines.push(`     💡 ${issue.suggestion}`);
    });
    lines.push('');
  }

  // Suggestions
  if ((v?.suggestions ?? []).length > 0) {
    lines.push(`── Suggestions ──────────────────────────────────────────────`);
    (v!.suggestions!).forEach(s => {
      lines.push(`  • [${s.file ?? 'unknown'}] ${s.action}`);
      if (s.details) lines.push(`    ${s.details}`);
    });
  }

  await testInfo.attach('Best Approach', { body: lines.join('\n'), contentType: 'text/plain' });
}

/** Attach security / Checkov scan summary with fixed vs remaining breakdown. */
export async function attachSecurityScan(
  testInfo: TestInfo,
  data: SecurityScanResult | null
) {
  if (!data) return;

  const toCount = (v: number | unknown[] | undefined): number => {
    if (typeof v === 'number') return v;
    if (Array.isArray(v)) return v.length;
    return 0;
  };

  let passed  = data.summary?.passed  ?? toCount(data.passedChecks);
  let failed  = data.summary?.failed  ?? toCount(data.failedChecks);
  let skipped = data.summary?.skipped ?? toCount(data.skippedChecks);

  if (data.results) {
    for (const r of data.results) {
      if (r.summary) {
        passed  += r.summary.passed  ?? 0;
        failed  += r.summary.failed  ?? 0;
        skipped += r.summary.skipped ?? 0;
      }
    }
  }

  const total = data.summary?.total ?? (passed + failed + skipped);
  const score = data.summary?.passPercentage != null
    ? Math.round(data.summary.passPercentage)
    : total > 0 ? Math.round((passed / total) * 100) : 0;

  const fixedChecks  = Array.isArray(data.fixedChecks)  ? data.fixedChecks  : [];
  const failedChecks = Array.isArray(data.failedChecks) ? data.failedChecks : [];

  const lines: string[] = [
    `Security Scan (Checkov)`,
    `═══════════════════════════════`,
    `Score   : ${score}%`,
    `Passed  : ${passed}`,
    `Failed  : ${failed}`,
    `Fixed   : ${fixedChecks.length}`,
    `Skipped : ${skipped}`,
    `Total   : ${total}`,
    ``,
  ];

  // Fixed checks
  if (fixedChecks.length > 0) {
    lines.push(`── Fixed Checks (${fixedChecks.length}) ──────────────────────────────────`);
    fixedChecks.forEach(c => {
      const verified = c.verified ? ' ✓ verified' : '';
      lines.push(`  ✅ [${c.checkId ?? '?'}] ${c.checkName ?? 'Unknown'}`);
      lines.push(`     Resource: ${c.resource ?? 'unknown'}  File: ${c.file ?? 'unknown'}${verified}`);
    });
    lines.push('');
  }

  // Remaining failed checks
  if (failedChecks.length > 0) {
    lines.push(`── Still Failing (${failedChecks.length}) ────────────────────────────────`);
    failedChecks.forEach(c => {
      lines.push(`  ❌ [${c.checkId ?? '?'}] ${c.checkName ?? 'Unknown'}`);
      lines.push(`     Resource: ${c.resource ?? 'unknown'}  File: ${c.file ?? 'unknown'}`);
      if (c.reason) lines.push(`     Reason: ${c.reason}`);
    });
  }

  await testInfo.attach('Security Scan', { body: lines.join('\n'), contentType: 'text/plain' });
}

/** Attach a final pipeline summary (all stages + outcomes). */
export async function attachPipelineSummary(
  testInfo: TestInfo,
  stages: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; durationMs?: number }>
) {
  if (stages.length === 0) return;

  const rows = stages.map(s => {
    const icon   = s.status === 'passed' ? '✅' : s.status === 'failed' ? '❌' : '⏭️';
    const dur    = s.durationMs != null ? ` (${(s.durationMs / 1000).toFixed(1)}s)` : '';
    return `  ${icon}  ${s.name.padEnd(25)} ${s.status.toUpperCase()}${dur}`;
  });

  const allPassed = stages.every(s => s.status === 'passed');

  const body = [
    `Pipeline Summary`,
    `═══════════════════════════════`,
    `Overall Result : ${allPassed ? '✅ ALL PASSED' : '⚠️  SOME FAILED'}`,
    `Stages Run     : ${stages.length}`,
    ``,
    ...rows,
  ].join('\n');

  await testInfo.attach('Pipeline Summary', { body, contentType: 'text/plain' });
}
