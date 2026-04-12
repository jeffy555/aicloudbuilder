import { useState, forwardRef, useImperativeHandle } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { RefreshCw, CheckCircle2, AlertCircle, XCircle, Wrench, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import FileDiffView from "./FileDiffView";

interface RefactorValidatorProps {
  sessionId: string;
  onValidationStart?: () => void;
  onValidationComplete?: () => void;
  /** Fires with hasIssues=true when validation finds problems, false when clean */
  onValidationResult?: (hasIssues: boolean) => void;
  onFixStart?: () => void;
  onFixComplete?: () => void;
  onFixesApproved?: () => void;
  /** Fires after user approves fixes and re-validation is done — signals pipeline can advance */
  onFixCycleComplete?: () => void;
}

export interface RefactorValidatorRef {
  triggerValidate: () => void;
}

interface RefactorResult {
  isValid: boolean;
  issues: Array<{
    file: string;
    type: 'hardcoded_value' | 'missing_variable' | 'missing_declaration' | 'missing_tfvars' | 'hardcoded_default';
    severity: 'error' | 'warning';
    message: string;
    line?: number;
    suggestion?: string;
  }>;
  suggestions: Array<{
    file: string;
    action: string;
    details: string;
  }>;
  summary: {
    totalIssues: number;
    errors: number;
    warnings: number;
    filesChecked: number;
  };
}

interface FixResult {
  success: boolean;
  fixedIssues: number;
  passes: number;
  message: string;
  fixes: string[];
  fixesByPass: Array<{ pass: number; fixes: string[] }>;
}

const RefactorValidator = forwardRef<RefactorValidatorRef, RefactorValidatorProps>(
  ({ sessionId, onValidationStart, onValidationComplete, onValidationResult, onFixStart, onFixComplete, onFixesApproved, onFixCycleComplete }, ref) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // State
  const [refactorResult, setRefactorResult] = useState<RefactorResult | null>(null);
  const [fixResult, setFixResult] = useState<FixResult | null>(null);
  const [fileDiffs, setFileDiffs] = useState<Array<{ fileName: string; originalContent: string; fixedContent: string }>>([]);
  const [hasUnapprovedFixes, setHasUnapprovedFixes] = useState(false);
  const [fixSummary, setFixSummary] = useState<{
    fixed: number;
    failed: number;
    skipped: number;
    total: number;
    passes: number;
    fixesByPass: Array<{ pass: number; fixes: string[] }>;
    fixes: string[];
  } | null>(null);

  // ── Validate mutation ──────────────────────────────────────────────────
  const validateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/refactor`);
      return await res.json() as RefactorResult;
    },
    onSuccess: (result) => {
      setRefactorResult(result);
      if (result.isValid) {
        toast({ title: "Best Approach Validated", description: "All Terraform files follow best practices!" });
      } else {
        toast({
          title: "Issues Found",
          description: `Found ${result.summary.totalIssues} issue(s). Click "Fix" to apply automatic fixes.`,
          variant: "destructive",
        });
      }
      onValidationComplete?.();
      onValidationResult?.(!result.isValid);
    },
    onError: (error: any) => {
      toast({ title: "Validation Error", description: error.message || "Failed to validate", variant: "destructive" });
      onValidationComplete?.();
      onValidationResult?.(false); // error = no issues to fix, just advance
    },
  });

  // ── Fix mutation (captures before/after diffs — does NOT re-validate) ──
  const fixMutation = useMutation({
    mutationFn: async () => {
      // Snapshot files BEFORE the fix
      const beforeRes = await apiRequest('GET', `/api/sessions/${sessionId}/files`);
      const beforeFiles = await beforeRes.json() as Array<{ fileName: string; content: string }>;
      const beforeByName = new Map(beforeFiles.map(f => [f.fileName, f.content]));

      // Apply fixes
      const fixPromise = apiRequest('POST', `/api/sessions/${sessionId}/refactor-fix`);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Fix operation timed out after 2 minutes')), 120000)
      );
      const fixRes = await Promise.race([fixPromise, timeout]);
      const result = await fixRes.json() as FixResult;

      // Snapshot files AFTER the fix
      const afterRes = await apiRequest('GET', `/api/sessions/${sessionId}/files`);
      const afterFiles = await afterRes.json() as Array<{ fileName: string; content: string }>;
      const afterByName = new Map(afterFiles.map(f => [f.fileName, f.content]));

      // Build diffs
      const diffs: Array<{ fileName: string; originalContent: string; fixedContent: string }> = [];
      for (const [name, afterContent] of afterByName) {
        const beforeContent = beforeByName.get(name);
        if (beforeContent != null && beforeContent !== afterContent) {
          diffs.push({ fileName: name, originalContent: beforeContent, fixedContent: afterContent });
        } else if (beforeContent == null) {
          // New file created by fix
          diffs.push({ fileName: name, originalContent: '', fixedContent: afterContent });
        }
      }

      return { result, diffs };
    },
    onSuccess: ({ result, diffs }) => {
      setFixResult(result);

      if (diffs.length > 0) {
        setFileDiffs(diffs);
        setHasUnapprovedFixes(true);
        toast({
          title: "Fixes Ready for Review",
          description: `${result.fixedIssues} fix(es) applied to ${diffs.length} file(s). Review the changes and approve.`,
        });
      } else {
        // No actual file changes — skip approval step, go straight to summary
        toast({ title: "No Changes", description: "Fix ran but no file changes were produced.", variant: "destructive" });
        finalizeFix(result);
        // No diffs to approve — signal pipeline can advance
        onFixCycleComplete?.();
      }

      onFixComplete?.();
    },
    onError: (error: any) => {
      toast({ title: "Fix Error", description: error.message || "Failed to apply fixes", variant: "destructive" });
      onFixComplete?.();
    },
  });

  // ── Approve: user reviews diffs and clicks Approve → re-validate → show summary ──
  const handleApprove = async () => {
    setHasUnapprovedFixes(false);

    // Refresh file cache so CodeEditor picks up the changes
    await queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
    await queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });

    // Re-validate to get updated issue count
    try {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/refactor`);
      const revalidation = await res.json() as RefactorResult;

      if (fixResult) {
        finalizeFix(fixResult, revalidation);
      }
    } catch {
      // Re-validate failed — still show summary with fix result only
      if (fixResult) finalizeFix(fixResult);
    }

    setFileDiffs([]);
    onFixesApproved?.();
    // Signal pipeline that the fix→approve→revalidate cycle is done — safe to advance
    onFixCycleComplete?.();
  };

  // Build the fix summary card from fix + optional re-validation results
  const finalizeFix = (fix: FixResult, revalidation?: RefactorResult) => {
    const fixedCount = fix.fixedIssues || 0;
    const remainingIssues = revalidation?.summary?.totalIssues ?? 0;

    setFixSummary({
      fixed: fixedCount,
      failed: remainingIssues,
      skipped: 0,
      total: fixedCount + remainingIssues,
      passes: fix.passes || 1,
      fixesByPass: fix.fixesByPass || [],
      fixes: fix.fixes || [],
    });

    // Clear old validation results so only summary shows
    setRefactorResult(null);
    setFixResult(null);

    if (fixedCount > 0 && remainingIssues === 0) {
      toast({ title: "All Issues Fixed!", description: `Successfully fixed ${fixedCount} issue(s).` });
    } else if (fixedCount > 0) {
      toast({ title: "Fixes Applied", description: `Fixed ${fixedCount} issue(s). ${remainingIssues} remain.` });
    } else {
      toast({ title: "No Fixes Applied", description: "No automatic fixes were available.", variant: "destructive" });
    }
  };

  const handleValidate = () => {
    onValidationStart?.();
    setRefactorResult(null);
    setFixSummary(null);
    setFileDiffs([]);
    setHasUnapprovedFixes(false);
    validateMutation.mutate();
  };

  const handleFix = () => {
    onFixStart?.();
    setRefactorResult(null);
    setFixSummary(null);
    setFileDiffs([]);
    setHasUnapprovedFixes(false);
    fixMutation.mutate();
  };

  useImperativeHandle(ref, () => ({
    triggerValidate: handleValidate
  }));

  const isValidating = validateMutation.isPending;
  const isFixing = fixMutation.isPending;
  const hasError = validateMutation.isError && !refactorResult;
  const isPristine = !isValidating && !isFixing && !refactorResult && !fixSummary && !hasError && !hasUnapprovedFixes;

  return (
    <div className="w-full">
      {/* Pristine / not-yet-run state */}
      {isPristine && (
        <div className="flex flex-col items-center justify-center p-12 space-y-3 text-center">
          <Wrench className="w-10 h-10 text-muted-foreground opacity-40" />
          <p className="text-sm text-muted-foreground">Best Approach analysis will run automatically</p>
        </div>
      )}

      {/* Loading indicator */}
      {((isValidating && !refactorResult) || (isFixing && !hasUnapprovedFixes && !fixSummary)) && (
        <div className="flex flex-col items-center justify-center p-12 space-y-4">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600 dark:text-blue-400" />
          <p className="text-lg text-gray-600 dark:text-gray-400">
            {isValidating ? "Analyzing Terraform files..." : "Applying fixes..."}
          </p>
        </div>
      )}

      {/* Error state */}
      {hasError && (
        <div className="mt-6 p-4 rounded-lg bg-rose-50 dark:bg-rose-950 border border-rose-200 dark:border-rose-800">
          <div className="flex items-center gap-2 mb-2">
            <XCircle className="w-5 h-5 text-rose-600 dark:text-rose-400" />
            <h4 className="font-semibold text-gray-900 dark:text-gray-100">Analysis Failed</h4>
          </div>
          <p className="text-sm text-rose-700 dark:text-rose-300">
            {String((validateMutation.error as any)?.message || 'Could not analyse Terraform files.')}
          </p>
          <Button size="sm" variant="outline" className="mt-3" onClick={handleValidate}>
            <RefreshCw className="w-4 h-4 mr-2" /> Retry
          </Button>
        </div>
      )}

      {/* ── Diff Review + Approve (shown after fix, before approval) ────── */}
      {hasUnapprovedFixes && fileDiffs.length > 0 && (
        <div className="space-y-4 mt-6">
          <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                  Review Changes ({fileDiffs.length} file{fileDiffs.length !== 1 ? 's' : ''} modified)
                </h4>
              </div>
              <Button
                data-testid="btn-approve-refactor"
                onClick={handleApprove}
                className="bg-green-600 hover:bg-green-500 text-white font-semibold"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Approve Changes
              </Button>
            </div>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {fixResult?.fixedIssues ?? 0} fix(es) applied. Review the changes below and approve to continue.
            </p>
          </div>

          <FileDiffView diffs={fileDiffs} />
        </div>
      )}

      {/* ── Fix Summary (shown after approval) ─────────────────────────── */}
      {fixSummary && !hasUnapprovedFixes && (
        <div className="space-y-3 mt-6">
          <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">Fix Summary</h4>
            </div>
            <div className="grid grid-cols-5 gap-4 mb-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{fixSummary.total}</div>
                <div className="text-xs text-gray-600 dark:text-gray-400">Total</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600 dark:text-green-400">{fixSummary.fixed}</div>
                <div className="text-xs text-gray-600 dark:text-gray-400">Fixed</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-red-600 dark:text-red-400">{fixSummary.failed}</div>
                <div className="text-xs text-gray-600 dark:text-gray-400">Remaining</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">{fixSummary.skipped}</div>
                <div className="text-xs text-gray-600 dark:text-gray-400">Skipped</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">{fixSummary.passes}</div>
                <div className="text-xs text-gray-600 dark:text-gray-400">Passes</div>
              </div>
            </div>

            {/* Per-pass breakdown */}
            {fixSummary.fixesByPass.length > 0 && (
              <div className="space-y-2 mt-2">
                <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Pass Breakdown</p>
                {fixSummary.fixesByPass.map(({ pass, fixes }) => (
                  <div key={pass} className="rounded bg-white dark:bg-gray-900 border border-blue-200 dark:border-blue-800 p-2">
                    <p className="text-xs font-bold text-blue-700 dark:text-blue-300 mb-1">Pass {pass} — {fixes.length} fix{fixes.length !== 1 ? 'es' : ''}</p>
                    <ul className="space-y-0.5">
                      {fixes.map((fix, i) => (
                        <li key={i} className="text-xs text-gray-700 dark:text-gray-300 flex items-start gap-1">
                          <CheckCircle2 className="w-3 h-3 text-green-500 mt-0.5 flex-shrink-0" />
                          {fix}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Applied Fixes Details */}
          {fixSummary.fixes.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                Applied Fixes ({fixSummary.fixes.length})
              </h4>
              <div className="border rounded-lg bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800">
                <div className="p-4 space-y-2 max-h-96 overflow-y-auto">
                  {fixSummary.fixes.map((fix, idx) => (
                    <div key={idx} className="p-3 rounded bg-white dark:bg-gray-900 border border-green-200 dark:border-green-800">
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 mt-0.5 flex-shrink-0" />
                        <p className="text-sm text-gray-900 dark:text-gray-100 font-medium">{fix}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Validation Results (initial scan — before fix) ─────────────── */}
      {refactorResult && !hasUnapprovedFixes && !fixSummary && (
        <div className="mt-6 space-y-4">
          {/* Summary */}
          <div className={`p-4 rounded-lg ${
            refactorResult.isValid
              ? 'bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800'
              : 'bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {refactorResult.isValid ? (
                  <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />
                )}
                <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                  {refactorResult.isValid ? 'All Checks Passed — No fixes needed' : 'Issues Found'}
                </h4>
              </div>
              <div className="flex items-center gap-2">
                {refactorResult.isValid && (
                  <Button size="sm" variant="ghost" onClick={handleValidate} disabled={isValidating}>
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Re-run
                  </Button>
                )}
                {!refactorResult.isValid && refactorResult.summary.totalIssues > 0 && (
                  <Button
                    onClick={handleFix}
                    disabled={isFixing}
                    className={`${
                      isFixing
                        ? 'bg-blue-600 hover:bg-blue-500 text-white'
                        : 'bg-green-600 hover:bg-green-500 text-white font-semibold shadow-lg'
                    }`}
                  >
                    {isFixing ? (
                      <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Fixing...</>
                    ) : (
                      <><Wrench className="w-4 h-4 mr-2" /> Fix</>
                    )}
                  </Button>
                )}
              </div>
            </div>
            <div className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
              <p>Files checked: {refactorResult.summary.filesChecked}</p>
              <p>Total issues: {refactorResult.summary.totalIssues}</p>
              <p>Errors: {refactorResult.summary.errors}</p>
              <p>Warnings: {refactorResult.summary.warnings}</p>
            </div>
          </div>

          {/* Issues */}
          {refactorResult.issues.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">Issues:</h4>
              {refactorResult.issues.map((issue, idx) => (
                <div key={idx} className={`p-3 rounded border-l-4 ${
                  issue.severity === 'error'
                    ? 'bg-red-50 dark:bg-red-950 border-red-500'
                    : 'bg-yellow-50 dark:bg-yellow-950 border-yellow-500'
                }`}>
                  <div className="flex items-start gap-2">
                    {issue.severity === 'error' ? (
                      <XCircle className="w-5 h-5 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                    ) : (
                      <AlertCircle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
                    )}
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-gray-900 dark:text-gray-100">{issue.file}</span>
                        {issue.line && <span className="text-xs text-gray-500 dark:text-gray-400">Line {issue.line}</span>}
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          issue.severity === 'error'
                            ? 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
                            : 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300'
                        }`}>{issue.severity.toUpperCase()}</span>
                      </div>
                      <p className="text-sm text-gray-700 dark:text-gray-300 mb-1">{issue.message}</p>
                      {issue.suggestion && (
                        <p className="text-xs text-gray-600 dark:text-gray-400 italic">{issue.suggestion}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Suggestions */}
          {refactorResult.suggestions.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">Suggestions:</h4>
              {refactorResult.suggestions.map((suggestion, idx) => (
                <div key={idx} className="p-3 rounded bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800">
                  <div className="font-semibold text-gray-900 dark:text-gray-100 mb-1">{suggestion.file}</div>
                  <p className="text-sm text-gray-700 dark:text-gray-300 mb-1">{suggestion.action}</p>
                  <p className="text-xs text-gray-600 dark:text-gray-400">{suggestion.details}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

RefactorValidator.displayName = 'RefactorValidator';

export default RefactorValidator;
