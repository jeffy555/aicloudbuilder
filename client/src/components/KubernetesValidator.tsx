import { useState, forwardRef, useImperativeHandle } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

interface KubernetesValidatorProps {
  sessionId: string;
  onValidationStart?: () => void;
  onValidationComplete?: () => void;
}

export interface KubernetesValidatorRef {
  triggerValidate: () => void;
}

interface ValidationResult {
  success: boolean;
  valid: boolean;
  schemaValid?: boolean;
  bestPracticesAnalyzed?: boolean;
  errors: Array<{
    severity: 'error' | 'warning';
    message: string;
    file?: string;
    line?: number;
  }>;
  warnings: Array<{
    severity: 'error' | 'warning';
    message: string;
    file?: string;
    line?: number;
  }>;
  summary?: {
    schemaErrors: number;
    schemaWarnings: number;
    bestPracticeIssues: number;
    highPriorityIssues: number;
    mediumPriorityIssues: number;
    lowPriorityIssues: number;
  };
}

const KubernetesValidator = forwardRef<KubernetesValidatorRef, KubernetesValidatorProps>(
  ({ sessionId, onValidationStart, onValidationComplete }, ref) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const validateMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/sessions/${sessionId}/validate-kubernetes`);
      return response.json() as ValidationResult;
    },
    onSuccess: (result) => {
      setValidationResult(result);
      
      if (result.valid) {
        toast({
          title: "✅ Validation Passed",
          description: "All Kubernetes YAML files are valid!",
          variant: "default",
        });
      } else {
        toast({
          title: "⚠️ Validation Issues Found",
          description: `Found ${result.errors.length} error(s) and ${result.warnings.length} warning(s)`,
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
    onSettled: () => {
      setIsValidating(false);
    }
  });

  const triggerValidate = () => {
    setIsValidating(true);
    setValidationResult(null);
    onValidationStart?.();
    validateMutation.mutate();
  };

  useImperativeHandle(ref, () => ({
    triggerValidate
  }));

  if (isValidating && !validationResult) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary mr-3" />
            <p className="text-muted-foreground">Validating Kubernetes YAML...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!validationResult) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="text-center py-8 text-muted-foreground">
            <p>Click "Validate" to check Kubernetes YAML syntax</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {validationResult.valid ? (
            <CheckCircle2 className="w-5 h-5 text-green-600" />
          ) : (
            <XCircle className="w-5 h-5 text-red-600" />
          )}
          Validation Results
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Summary */}
          <div className="space-y-2">
            <div className="flex items-center gap-4">
              <Badge variant={validationResult.valid ? "default" : "destructive"}>
                {validationResult.valid ? "Valid" : "Invalid"}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {validationResult.errors.length} error(s), {validationResult.warnings.length} warning(s)
              </span>
            </div>
            
            {/* Detailed Summary */}
            {validationResult.summary && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                <div className="p-2 rounded bg-muted">
                  <div className="font-medium">Schema Validation</div>
                  <div className="text-muted-foreground">
                    {validationResult.schemaValid ? (
                      <span className="text-green-600">✓ Valid</span>
                    ) : (
                      <span className="text-red-600">
                        ✗ {validationResult.summary.schemaErrors} error(s)
                      </span>
                    )}
                  </div>
                </div>
                <div className="p-2 rounded bg-muted">
                  <div className="font-medium">Best Practices</div>
                  <div className="text-muted-foreground">
                    {validationResult.summary.bestPracticeIssues === 0 ? (
                      <span className="text-green-600">✓ No issues</span>
                    ) : (
                      <span>{validationResult.summary.bestPracticeIssues} issue(s)</span>
                    )}
                  </div>
                </div>
                {validationResult.summary.highPriorityIssues > 0 && (
                  <div className="p-2 rounded bg-red-50 dark:bg-red-950">
                    <div className="font-medium text-red-600">High Priority</div>
                    <div className="text-red-600">{validationResult.summary.highPriorityIssues}</div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Errors */}
          {validationResult.errors.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-semibold text-red-600">Errors:</h4>
              <ScrollArea className="h-48">
                <div className="space-y-2">
                  {validationResult.errors.map((error, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded border-l-4 bg-red-50 dark:bg-red-950 border-red-500"
                    >
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <p className="text-sm font-medium">{error.message}</p>
                          {error.file && (
                            <p className="text-xs text-muted-foreground mt-1">
                              {error.file}
                              {error.line && ` (Line ${error.line})`}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Warnings */}
          {validationResult.warnings.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-semibold text-yellow-600">Warnings:</h4>
              <ScrollArea className="h-48">
                <div className="space-y-2">
                  {validationResult.warnings.map((warning, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded border-l-4 bg-yellow-50 dark:bg-yellow-950 border-yellow-500"
                    >
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-yellow-600 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <p className="text-sm font-medium">{warning.message}</p>
                          {warning.file && (
                            <p className="text-xs text-muted-foreground mt-1">
                              {warning.file}
                              {warning.line && ` (Line ${warning.line})`}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {validationResult.valid && validationResult.errors.length === 0 && validationResult.warnings.length === 0 && (
            <div className="text-center py-8 text-green-600">
              <CheckCircle2 className="w-12 h-12 mx-auto mb-2" />
              <p className="font-medium">All Kubernetes YAML files are valid!</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
});

KubernetesValidator.displayName = 'KubernetesValidator';

export default KubernetesValidator;



