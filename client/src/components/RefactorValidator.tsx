import { useState, forwardRef, useImperativeHandle } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { RefreshCw, CheckCircle2, AlertCircle, XCircle, Wrench, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface RefactorValidatorProps {
  sessionId: string;
  onValidationStart?: () => void;
  onValidationComplete?: () => void;
  onFixStart?: () => void;
  onFixComplete?: () => void;
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

const RefactorValidator = forwardRef<RefactorValidatorRef, RefactorValidatorProps>(
  ({ sessionId, onValidationStart, onValidationComplete, onFixStart, onFixComplete }, ref) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [refactorResult, setRefactorResult] = useState<RefactorResult | null>(null);
  const [appliedFixes, setAppliedFixes] = useState<Array<{ fix: string; timestamp: Date }>>([]);
  const [fixesByPass, setFixesByPass] = useState<Array<{ pass: number; fixes: string[] }>>([]);
  const [fixSummary, setFixSummary] = useState<{
    fixed: number;
    failed: number;
    skipped: number;
    total: number;
    passes: number;
    details: Array<{ fix: string; status: 'fixed' | 'failed' | 'skipped'; timestamp: Date }>;
  } | null>(null);

  // Separate mutations for validation and fixing
  const validateMutation = useMutation({
    mutationFn: async () => {
      // Only validate, don't fix
      const validateResponse = await apiRequest('POST', `/api/sessions/${sessionId}/refactor`);
      const validationResult = await validateResponse.json() as RefactorResult;
      return validationResult;
    },
    onSuccess: (validationResult) => {
      setRefactorResult(validationResult);
      
      if (validationResult.isValid) {
        toast({
          title: "✅ Best Approach Validated",
          description: "All Terraform files follow best practices! No fixes needed.",
          variant: "default",
        });
      } else {
        toast({
          title: "⚠️ Issues Found",
          description: `Found ${validationResult.summary.totalIssues} issue(s). Click "Fix" to apply automatic fixes.`,
          variant: "destructive",
        });
      }
      onValidationComplete?.();
    },
    onError: (error: any) => {
      toast({
        title: "Validation Error",
        description: error.message || "Failed to validate Terraform files",
        variant: "destructive",
      });
      onValidationComplete?.();
    },
  });

  const fixMutation = useMutation({
    mutationFn: async () => {
      // Apply fixes with timeout to prevent infinite loops
      const fixPromise = apiRequest('POST', `/api/sessions/${sessionId}/refactor-fix`);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Fix operation timed out after 2 minutes')), 120000)
      );
      
      const fixResponse = await Promise.race([fixPromise, timeoutPromise]) as Response;
      const fixResult = await fixResponse.json() as { success: boolean; fixedIssues: number; passes: number; message: string; fixes: string[]; fixesByPass: Array<{ pass: number; fixes: string[] }> };
      
      // Re-validate after fixing to get updated status
      const revalidatePromise = apiRequest('POST', `/api/sessions/${sessionId}/refactor`);
      const revalidateTimeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Re-validation timed out')), 30000)
      );
      
      const revalidateResponse = await Promise.race([revalidatePromise, revalidateTimeoutPromise]) as Response;
      const revalidationResult = await revalidateResponse.json() as RefactorResult;
      
      return {
        validationResult: revalidationResult,
        fixResult
      };
    },
    onSuccess: (data) => {
      const fixedCount = data.fixResult.fixedIssues || 0;
      const remainingIssues = data.validationResult.summary.totalIssues || 0;
      const fixesList = data.fixResult.fixes || [];
      const totalAttempted = fixedCount + remainingIssues;
      const passesRun = data.fixResult.passes || 1;
      const passBuckets = data.fixResult.fixesByPass || [];

      // Store applied fixes for display - always update to show fixes
      setAppliedFixes(fixesList.map(fix => ({
        fix,
        timestamp: new Date()
      })));
      setFixesByPass(passBuckets);

      // Store fix summary for display (like Checkov scan result)
      setFixSummary({
        fixed: fixedCount,
        failed: remainingIssues,
        skipped: 0,
        total: totalAttempted,
        passes: passesRun,
        details: fixesList.map((fix, idx) => ({
          fix: fix,
          status: idx < fixedCount ? 'fixed' : 'failed',
          timestamp: new Date()
        }))
      });
      
      // After fixes are applied, hide validation results and only show applied fixes
      // Clear validation results so old issues/warnings don't show
      setRefactorResult(null);
      
      if (fixedCount > 0) {
        if (remainingIssues === 0) {
          toast({
            title: "✅ All Issues Fixed!",
            description: `Successfully fixed ${fixedCount} issue(s)! All Terraform files now follow best practices.`,
            variant: "default",
          });
        } else {
          toast({
            title: "✅ Fixes Applied",
            description: `Successfully fixed ${fixedCount} issue(s)! ${remainingIssues} issue(s) remain and may require manual fixes.`,
            variant: "default",
          });
        }
      } else {
        toast({
          title: "⚠️ No Fixes Applied",
          description: "No automatic fixes were available. Some issues may require manual fixes.",
          variant: "destructive",
        });
      }
      
      // Refresh files to show updated content
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      }, 500);
      
      // Notify parent that fix is complete (to restore button visibility)
      onFixComplete?.();
    },
    onError: (error: any) => {
      toast({
        title: "Fix Error",
        description: error.message || "Failed to apply fixes",
        variant: "destructive",
      });
      // Still notify completion even on error to restore buttons
      onFixComplete?.();
    },
  });

  const handleValidate = () => {
    onValidationStart?.();
    // Reset any previous result
    setRefactorResult(null);
    validateMutation.mutate();
  };

  const handleFix = () => {
    onFixStart?.(); // Notify parent that fix is starting
    // Clear previous validation results and fix summary to show fresh state
    setRefactorResult(null);
    setFixSummary(null);
    setAppliedFixes([]);
    setFixesByPass([]);
    fixMutation.mutate();
  };

  useImperativeHandle(ref, () => ({
    triggerValidate: handleValidate
  }));

  const isValidating = validateMutation.isPending;
  const isFixing = fixMutation.isPending;

  return (
    <div className="w-full">
      {/* Loading indicator - Show when validating or fixing and no results yet */}
      {(isValidating && !refactorResult) || (isFixing && !fixSummary) ? (
        <div className="flex flex-col items-center justify-center p-12 space-y-4">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600 dark:text-blue-400" />
          <p className="text-lg text-gray-600 dark:text-gray-400">
            {isValidating ? "Analyzing Terraform files..." : "Applying fixes..."}
          </p>
        </div>
      ) : null}
      
      {/* Fix Summary - Show after fixes are applied (like Checkov scan result) */}
      {fixSummary && (
        <div className="space-y-3 mt-6">
          <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                Fix Summary
              </h4>
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
            {fixesByPass.length > 0 && (
              <div className="space-y-2 mt-2">
                <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Pass Breakdown</p>
                {fixesByPass.map(({ pass, fixes }) => (
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
          {appliedFixes.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                Applied Fixes ({appliedFixes.length})
              </h4>
              <div className="border rounded-lg bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800">
                <div className="p-4 space-y-2 max-h-96 overflow-y-auto">
                  {appliedFixes.map((appliedFix, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded bg-white dark:bg-gray-900 border border-green-200 dark:border-green-800"
                    >
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <p className="text-sm text-gray-900 dark:text-gray-100 font-medium">
                            {appliedFix.fix}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                            Applied at {appliedFix.timestamp.toLocaleTimeString()}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Validation Results - Only show if we have results AND no fixes have been applied yet */}
      {refactorResult && appliedFixes.length === 0 && (
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
                    {refactorResult.isValid ? 'All Checks Passed!' : 'Issues Found'}
                  </h4>
                </div>
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
                      <>
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                        Fixing...
                      </>
                    ) : (
                      <>
                        <Wrench className="w-4 h-4 mr-2" />
                        Fix
                      </>
                    )}
                  </Button>
                )}
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
                  <div
                    key={idx}
                    className={`p-3 rounded border-l-4 ${
                      issue.severity === 'error'
                        ? 'bg-red-50 dark:bg-red-950 border-red-500'
                        : 'bg-yellow-50 dark:bg-yellow-950 border-yellow-500'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {issue.severity === 'error' ? (
                        <XCircle className="w-5 h-5 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                      ) : (
                        <AlertCircle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-semibold text-gray-900 dark:text-gray-100">
                            {issue.file}
                          </span>
                          {issue.line && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              Line {issue.line}
                            </span>
                          )}
                          <span className={`text-xs px-2 py-0.5 rounded ${
                            issue.severity === 'error'
                              ? 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
                              : 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300'
                          }`}>
                            {issue.severity.toUpperCase()}
                          </span>
                        </div>
                        <p className="text-sm text-gray-700 dark:text-gray-300 mb-1">
                          {issue.message}
                        </p>
                        {issue.suggestion && (
                          <p className="text-xs text-gray-600 dark:text-gray-400 italic">
                            💡 {issue.suggestion}
                          </p>
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
                  <div
                    key={idx}
                    className="p-3 rounded bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800"
                  >
                    <div className="font-semibold text-gray-900 dark:text-gray-100 mb-1">
                      {suggestion.file}
                    </div>
                    <p className="text-sm text-gray-700 dark:text-gray-300 mb-1">
                      {suggestion.action}
                    </p>
                    <p className="text-xs text-gray-600 dark:text-gray-400">
                      {suggestion.details}
                    </p>
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

