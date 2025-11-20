import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { RefreshCw, CheckCircle2, AlertCircle, XCircle, Wrench } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface RefactorValidatorProps {
  sessionId: string;
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

export default function RefactorValidator({ sessionId }: RefactorValidatorProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [refactorResult, setRefactorResult] = useState<RefactorResult | null>(null);

  const validateAndFixMutation = useMutation({
    mutationFn: async () => {
      // First validate to get issues
      const validateResponse = await apiRequest('POST', `/api/sessions/${sessionId}/refactor`);
      const validationResult = await validateResponse.json() as RefactorResult;
      
      // If there are issues, fix them
      if (!validationResult.isValid && validationResult.summary.totalIssues > 0) {
        const fixResponse = await apiRequest('POST', `/api/sessions/${sessionId}/refactor-fix`);
        const fixResult = await fixResponse.json() as { success: boolean; fixedIssues: number; message: string; fixes: string[] };
        
        // Re-validate after fixing to get updated status
        const revalidateResponse = await apiRequest('POST', `/api/sessions/${sessionId}/refactor`);
        const revalidationResult = await revalidateResponse.json() as RefactorResult;
        
        return {
          validationResult: revalidationResult,
          fixResult,
          wasFixed: true
        };
      }
      
      return {
        validationResult,
        fixResult: null,
        wasFixed: false
      };
    },
    onSuccess: (data) => {
      setRefactorResult(data.validationResult);
      
      if (data.wasFixed && data.fixResult) {
        toast({
          title: "✅ Validation & Fix Complete",
          description: data.fixResult.message || `Successfully fixed ${data.fixResult.fixedIssues} issue(s)!`,
          variant: "default",
        });
        // Refresh files to show updated content
        queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
        // Force a refetch with a small delay to ensure files are updated
        setTimeout(() => {
          queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
        }, 500);
      } else if (data.validationResult.isValid) {
        toast({
          title: "✅ Validation Passed",
          description: "All Terraform files follow best practices!",
          variant: "default",
        });
      } else {
        toast({
          title: "⚠️ Issues Found",
          description: `Found ${data.validationResult.summary.totalIssues} issue(s), but some may require manual fixes.`,
          variant: "destructive",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to validate and fix Terraform files",
        variant: "destructive",
      });
    },
  });

  const handleValidateAndFix = () => {
    validateAndFixMutation.mutate();
  };

  return (
    <div className="w-full my-8">
      <div className="bg-white dark:bg-gray-800 rounded-lg border-2 border-gray-300 dark:border-gray-600 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              Refactor & Validate
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Validate Terraform best practices: ensure variables are used instead of hardcoded values
            </p>
          </div>
          <Button
            onClick={handleValidateAndFix}
            disabled={validateAndFixMutation.isPending}
            className="gap-2"
            variant="default"
          >
            {validateAndFixMutation.isPending ? (
              <>
                <Wrench className="w-4 h-4 animate-spin" />
                Validating & Fixing...
              </>
            ) : (
              <>
                <Wrench className="w-4 h-4" />
                Validate & Fix
              </>
            )}
          </Button>
        </div>

        {refactorResult && (
          <div className="mt-6 space-y-4">
            {/* Summary */}
            <div className={`p-4 rounded-lg ${
              refactorResult.isValid 
                ? 'bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800' 
                : 'bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800'
            }`}>
              <div className="flex items-center gap-2 mb-2">
                {refactorResult.isValid ? (
                  <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />
                )}
                <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                  {refactorResult.isValid ? 'All Checks Passed!' : 'Issues Found'}
                </h4>
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
    </div>
  );
}

