import { useState, forwardRef, useImperativeHandle } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { RefreshCw, CheckCircle2, AlertCircle, Loader2, Wrench } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

interface KubernetesBestPracticesProps {
  sessionId: string;
  onValidationStart?: () => void;
  onValidationComplete?: () => void;
  onFixStart?: () => void;
  onFixComplete?: () => void;
}

export interface KubernetesBestPracticesRef {
  triggerValidate: () => void;
}

interface BestPracticeIssue {
  category: string;
  issue: string;
  suggestion: string;
  priority: 'high' | 'medium' | 'low';
  file?: string;
  line?: number;
}

interface BestPracticeResult {
  success: boolean;
  issues: BestPracticeIssue[];
  summary: string;
}

const KubernetesBestPractices = forwardRef<KubernetesBestPracticesRef, KubernetesBestPracticesProps>(
  ({ sessionId, onValidationStart, onValidationComplete, onFixStart, onFixComplete }, ref) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [bestPracticeResult, setBestPracticeResult] = useState<BestPracticeResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [appliedFixes, setAppliedFixes] = useState<Array<{ fix: string; timestamp: Date }>>([]);

  const validateMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/sessions/${sessionId}/kubernetes-best-practices`);
      return response.json() as BestPracticeResult;
    },
    onSuccess: (result) => {
      setBestPracticeResult(result);
      
      if (result.issues.length === 0) {
        toast({
          title: "✅ Best Practices Validated",
          description: "All Kubernetes manifests follow best practices!",
          variant: "default",
        });
      } else {
        toast({
          title: "⚠️ Best Practice Issues Found",
          description: `Found ${result.issues.length} issue(s). Review recommendations below.`,
          variant: "destructive",
        });
      }
      onValidationComplete?.();
    },
    onError: (error: any) => {
      toast({
        title: "Validation Error",
        description: error.message || "Failed to analyze best practices",
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
    setBestPracticeResult(null);
    onValidationStart?.();
    validateMutation.mutate();
  };

  useImperativeHandle(ref, () => ({
    triggerValidate
  }));

  if (isValidating && !bestPracticeResult) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary mr-3" />
            <p className="text-muted-foreground">Analyzing best practices...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!bestPracticeResult) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="text-center py-8 text-muted-foreground">
            <p>Click "Best Approach" to analyze Kubernetes best practices</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const highPriorityIssues = bestPracticeResult.issues.filter(i => i.priority === 'high');
  const mediumPriorityIssues = bestPracticeResult.issues.filter(i => i.priority === 'medium');
  const lowPriorityIssues = bestPracticeResult.issues.filter(i => i.priority === 'low');

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Wrench className="w-5 h-5" />
            Best Practices Analysis
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={triggerValidate}
            disabled={isValidating}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Re-analyze
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {/* Summary */}
          <div className="flex items-center gap-4">
            <Badge variant={bestPracticeResult.issues.length === 0 ? "default" : "destructive"}>
              {bestPracticeResult.issues.length === 0 ? "All Good" : `${bestPracticeResult.issues.length} Issues`}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {highPriorityIssues.length} high, {mediumPriorityIssues.length} medium, {lowPriorityIssues.length} low priority
            </span>
          </div>

          {bestPracticeResult.issues.length === 0 ? (
            <div className="text-center py-8 text-green-600">
              <CheckCircle2 className="w-12 h-12 mx-auto mb-2" />
              <p className="font-medium">All Kubernetes manifests follow best practices!</p>
            </div>
          ) : (
            <ScrollArea className="h-[600px]">
              <div className="space-y-4">
                {/* High Priority Issues */}
                {highPriorityIssues.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="font-semibold text-red-600">High Priority Issues:</h4>
                    {highPriorityIssues.map((issue, idx) => (
                      <div
                        key={idx}
                        className="p-4 rounded border-l-4 bg-red-50 dark:bg-red-950 border-red-500"
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="destructive">{issue.category}</Badge>
                            <Badge variant="outline" className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
                              HIGH
                            </Badge>
                          </div>
                        </div>
                        <p className="font-medium mb-2">{issue.issue}</p>
                        <p className="text-sm text-muted-foreground">{issue.suggestion}</p>
                        {issue.file && (
                          <p className="text-xs text-muted-foreground mt-2">
                            {issue.file}
                            {issue.line && ` (Line ${issue.line})`}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Medium Priority Issues */}
                {mediumPriorityIssues.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="font-semibold text-yellow-600">Medium Priority Issues:</h4>
                    {mediumPriorityIssues.map((issue, idx) => (
                      <div
                        key={idx}
                        className="p-4 rounded border-l-4 bg-yellow-50 dark:bg-yellow-950 border-yellow-500"
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary">{issue.category}</Badge>
                            <Badge variant="outline" className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                              MEDIUM
                            </Badge>
                          </div>
                        </div>
                        <p className="font-medium mb-2">{issue.issue}</p>
                        <p className="text-sm text-muted-foreground">{issue.suggestion}</p>
                        {issue.file && (
                          <p className="text-xs text-muted-foreground mt-2">
                            {issue.file}
                            {issue.line && ` (Line ${issue.line})`}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Low Priority Issues */}
                {lowPriorityIssues.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="font-semibold text-blue-600">Low Priority Issues:</h4>
                    {lowPriorityIssues.map((issue, idx) => (
                      <div
                        key={idx}
                        className="p-4 rounded border-l-4 bg-blue-50 dark:bg-blue-950 border-blue-500"
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{issue.category}</Badge>
                            <Badge variant="outline" className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                              LOW
                            </Badge>
                          </div>
                        </div>
                        <p className="font-medium mb-2">{issue.issue}</p>
                        <p className="text-sm text-muted-foreground">{issue.suggestion}</p>
                        {issue.file && (
                          <p className="text-xs text-muted-foreground mt-2">
                            {issue.file}
                            {issue.line && ` (Line ${issue.line})`}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </ScrollArea>
          )}

          {/* Applied Fixes */}
          {appliedFixes.length > 0 && (
            <div className="mt-6 pt-6 border-t">
              <h4 className="font-semibold mb-3">Applied Fixes:</h4>
              <div className="space-y-2">
                {appliedFixes.map((fix, idx) => (
                  <div key={idx} className="p-3 rounded bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800">
                    <p className="text-sm font-medium">{fix.fix}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Applied at {fix.timestamp.toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
});

KubernetesBestPractices.displayName = 'KubernetesBestPractices';

export default KubernetesBestPractices;



