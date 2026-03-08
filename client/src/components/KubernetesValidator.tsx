import { useState, forwardRef, useImperativeHandle } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  RefreshCw, CheckCircle2, AlertCircle, XCircle, Wrench, Loader2
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface KubernetesValidatorProps {
  sessionId: string;
  onValidationStart?: () => void;
  onValidationComplete?: () => void;
}

export interface KubernetesValidatorRef {
  triggerValidate: () => void;
}

interface IssueItem {
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
}

interface ValidationResult {
  success: boolean;
  valid: boolean;
  schemaValid?: boolean;
  bestPracticesAnalyzed?: boolean;
  errors: IssueItem[];
  warnings: IssueItem[];
  summary?: {
    schemaErrors: number;
    schemaWarnings: number;
    bestPracticeIssues: number;
    highPriorityIssues: number;
    mediumPriorityIssues: number;
    lowPriorityIssues: number;
  };
}

interface FixSummary {
  totalFixed: number;
  updatedFiles: string[];
  errors?: string[];
}

/** Extract category tag from messages like "[Security] Add runAsNonRoot..." */
function extractCategory(message: string): string {
  const m = message.match(/^\[([^\]]+)\]/);
  return m ? m[1] : '';
}

/** Strip the leading [Category] tag from a message */
function stripCategory(message: string): string {
  return message.replace(/^\[[^\]]+\]\s*/, '');
}

const KubernetesValidator = forwardRef<KubernetesValidatorRef, KubernetesValidatorProps>(
  ({ sessionId, onValidationStart, onValidationComplete }, ref) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [fixSummary, setFixSummary] = useState<FixSummary | null>(null);
  const [isFixing, setIsFixing] = useState(false);

  const fixMutation = useMutation({
    mutationFn: async (issues: IssueItem[]) => {
      const response = await apiRequest('POST', `/api/sessions/${sessionId}/fix-kubernetes-validation`, {
        issues
      });
      return response.json() as Promise<FixSummary>;
    },
    onSuccess: (result) => {
      setFixSummary(result);
      setValidationResult(null); // clear issues, show fix summary instead

      if (result.totalFixed > 0) {
        toast({
          title: "✅ Fixes Applied",
          description: `Fixed ${result.totalFixed} file(s) with best practices applied.`,
        });
      } else {
        toast({
          title: "⚠️ No Files Updated",
          description: "Some issues may require manual fixes.",
          variant: "destructive",
        });
      }
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      }, 500);
    },
    onError: (error: any) => {
      toast({
        title: "Fix Error",
        description: error.message || "Failed to apply fixes",
        variant: "destructive",
      });
    },
    onSettled: () => setIsFixing(false),
  });

  const validateMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/sessions/${sessionId}/validate-kubernetes`);
      return response.json() as Promise<ValidationResult>;
    },
    onSuccess: (result) => {
      setValidationResult(result);
      setFixSummary(null);

      if (result.valid && result.errors.length === 0 && result.warnings.length === 0) {
        toast({ title: "✅ Best Approach Validated", description: "All Kubernetes manifests follow best practices!" });
      } else {
        const total = result.errors.length + result.warnings.length;
        toast({
          title: "⚠️ Issues Found",
          description: `Found ${total} issue(s). Click "Fix" to apply automatic fixes.`,
          variant: "destructive",
        });
      }
      onValidationComplete?.();
    },
    onError: (error: any) => {
      toast({
        title: "Validation Error",
        description: error.message || "Failed to validate Kubernetes YAML",
        variant: "destructive",
      });
      onValidationComplete?.();
    },
  });

  const triggerValidate = (resetFixFlag = true) => {
    onValidationStart?.();
    setValidationResult(null);
    if (resetFixFlag) setFixSummary(null);
    validateMutation.mutate();
  };

  useImperativeHandle(ref, () => ({ triggerValidate }));

  const isValidating = validateMutation.isPending;

  const handleFix = () => {
    if (!validationResult) return;
    setIsFixing(true);
    const allIssues = [...validationResult.errors, ...validationResult.warnings];
    fixMutation.mutate(allIssues);
  };

  // ── Loading states ────────────────────────────────────────────────────────

  if ((isValidating && !validationResult) || (isFixing && !fixSummary)) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600 dark:text-blue-400" />
        <p className="text-lg text-gray-600 dark:text-gray-400">
          {isValidating ? "Analysing Kubernetes manifests..." : "Applying fixes..."}
        </p>
      </div>
    );
  }

  // ── Fix Summary (shown after applying fixes) ──────────────────────────────

  if (fixSummary) {
    return (
      <div className="space-y-4 mt-4">
        <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h4 className="font-semibold text-gray-900 dark:text-gray-100">Fix Summary</h4>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                {fixSummary.totalFixed}
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400">Files Fixed</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                {fixSummary.errors?.length ?? 0}
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400">Errors</div>
            </div>
          </div>

          {fixSummary.updatedFiles && fixSummary.updatedFiles.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
                Updated Files
              </p>
              {fixSummary.updatedFiles.map((f, i) => (
                <div key={i} className="rounded bg-white dark:bg-gray-900 border border-blue-200 dark:border-blue-800 px-3 py-2 flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                  <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{f}</span>
                </div>
              ))}
            </div>
          )}

          {fixSummary.errors && fixSummary.errors.length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-xs font-semibold text-red-600 uppercase tracking-wide">Remaining Issues</p>
              {fixSummary.errors.map((e, i) => (
                <div key={i} className="text-xs text-red-700 dark:text-red-300 flex items-start gap-1">
                  <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  {e}
                </div>
              ))}
            </div>
          )}
        </div>

        <Button variant="outline" size="sm" onClick={() => triggerValidate()}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Re-Run Analysis
        </Button>
      </div>
    );
  }

  // ── No result yet ─────────────────────────────────────────────────────────

  if (!validationResult) {
    return null;
  }

  const allIssues = [...validationResult.errors, ...validationResult.warnings];
  const totalIssues = allIssues.length;

  // ── Results ───────────────────────────────────────────────────────────────

  return (
    <div className="w-full mt-4 space-y-4">

      {/* Summary header — matches RefactorValidator style */}
      <div className={`p-4 rounded-lg ${
        validationResult.valid && totalIssues === 0
          ? 'bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800'
          : 'bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800'
      }`}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {validationResult.valid && totalIssues === 0 ? (
              <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
            ) : (
              <AlertCircle className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />
            )}
            <h4 className="font-semibold text-gray-900 dark:text-gray-100">
              {validationResult.valid && totalIssues === 0 ? 'All Checks Passed!' : 'Issues Found'}
            </h4>
          </div>

          {totalIssues > 0 && (
            <Button
              onClick={handleFix}
              disabled={isFixing}
              className={isFixing
                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                : 'bg-green-600 hover:bg-green-500 text-white font-semibold shadow-lg'}
            >
              {isFixing ? (
                <><RefreshCw className="w-4 h-4 mr-2 animate-spin" />Fixing...</>
              ) : (
                <><Wrench className="w-4 h-4 mr-2" />Fix</>
              )}
            </Button>
          )}
        </div>

        <div className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
          {validationResult.summary && (
            <p>Schema: {validationResult.schemaValid
              ? <span className="text-green-600 font-medium">Valid</span>
              : <span className="text-red-600 font-medium">{validationResult.summary.schemaErrors} error(s)</span>}
            </p>
          )}
          <p>Total issues: {totalIssues}</p>
          <p>Errors: {validationResult.errors.length}</p>
          <p>Warnings: {validationResult.warnings.length}</p>
          {validationResult.summary && validationResult.summary.highPriorityIssues > 0 && (
            <p>High priority: <span className="text-red-600 font-medium">{validationResult.summary.highPriorityIssues}</span></p>
          )}
        </div>
      </div>

      {/* Issues list — mirrors RefactorValidator's issue cards */}
      {allIssues.length > 0 && (
        <div className="space-y-3">
          <h4 className="font-semibold text-gray-900 dark:text-gray-100">Issues:</h4>
          {allIssues.map((issue, idx) => {
            const category = extractCategory(issue.message);
            const message = stripCategory(issue.message);
            const isError = issue.severity === 'error';
            return (
              <div
                key={idx}
                className={`p-3 rounded border-l-4 ${
                  isError
                    ? 'bg-red-50 dark:bg-red-950 border-red-500'
                    : 'bg-yellow-50 dark:bg-yellow-950 border-yellow-500'
                }`}
              >
                <div className="flex items-start gap-2">
                  {isError
                    ? <XCircle className="w-5 h-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
                    : <AlertCircle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />}
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {issue.file && (
                        <span className="font-semibold text-gray-900 dark:text-gray-100 text-sm font-mono">
                          {issue.file}
                        </span>
                      )}
                      {issue.line && (
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          Line {issue.line}
                        </span>
                      )}
                      {category && (
                        <span className="text-xs px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
                          {category}
                        </span>
                      )}
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        isError
                          ? 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
                          : 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300'
                      }`}>
                        {issue.severity.toUpperCase()}
                      </span>
                    </div>
                    <p className="text-sm text-gray-700 dark:text-gray-300">{message}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

KubernetesValidator.displayName = 'KubernetesValidator';
export default KubernetesValidator;
