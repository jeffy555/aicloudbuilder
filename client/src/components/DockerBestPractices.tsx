import { useState, forwardRef, useImperativeHandle } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, XCircle, Loader2, Wrench } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface DockerBestPracticesProps {
  sessionId: string;
  onValidationStart?: () => void;
  onValidationComplete?: () => void;
}

export interface DockerBestPracticesRef {
  triggerValidate: () => void;
}

interface Finding {
  id: string;
  severity: "PASSED" | "WARNING" | "FAILED";
  title: string;
  description: string;
  line?: number;
  fix?: string;
}

interface BestPracticesResult {
  success: boolean;
  summary: { passed: number; warnings: number; failed: number; total: number };
  findings: Finding[];
}

const DockerBestPractices = forwardRef<DockerBestPracticesRef, DockerBestPracticesProps>(
  ({ sessionId, onValidationStart, onValidationComplete }, ref) => {
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [result, setResult] = useState<BestPracticesResult | null>(null);
    const [fixApplied, setFixApplied] = useState(false);

    const validateMutation = useMutation({
      mutationFn: async () => {
        const response = await apiRequest(
          "POST",
          `/api/sessions/${sessionId}/docker-best-practices`
        );
        return (await response.json()) as BestPracticesResult;
      },
      onSuccess: (data) => {
        setResult(data);
        setFixApplied(false);
        onValidationComplete?.();
        const { passed, warnings, failed } = data.summary;
        toast({
          title: "Best practices validation complete",
          description: `${passed} passed, ${warnings} warnings, ${failed} failed`,
        });
      },
      onError: (error: any) => {
        onValidationComplete?.();
        toast({
          title: "Validation failed",
          description: error.message || "Could not validate Dockerfile",
          variant: "destructive",
        });
      },
    });

    const fixMutation = useMutation({
      mutationFn: async (findings: Finding[]) => {
        const response = await apiRequest(
          "POST",
          `/api/sessions/${sessionId}/docker-fix-best-practices`,
          { findings }
        );
        return await response.json();
      },
      onSuccess: (data) => {
        setFixApplied(true);
        // Invalidate file queries so CodeEditor picks up the updated Dockerfile
        queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId, "files"] });
        toast({
          title: "Dockerfile fixed",
          description: `${data.fixedCount} issue(s) addressed. Re-validate to confirm.`,
        });
      },
      onError: (error: any) => {
        toast({
          title: "Fix failed",
          description: error.message || "Could not fix Dockerfile",
          variant: "destructive",
        });
      },
    });

    useImperativeHandle(ref, () => ({
      triggerValidate: () => {
        onValidationStart?.();
        validateMutation.mutate();
      },
    }));

    if (validateMutation.isPending) {
      return (
        <div className="border rounded-lg p-8 text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" />
          <p className="text-sm font-medium">Validating Docker best practices...</p>
          <p className="text-xs text-muted-foreground">
            Checking base images, version pinning, security, and more
          </p>
        </div>
      );
    }

    if (!result) {
      return (
        <div className="border rounded-lg p-8 text-center text-muted-foreground">
          <p>Click "Best Approach" to validate your Dockerfile against Docker best practices.</p>
        </div>
      );
    }

    const { summary, findings } = result;
    const allPassed = summary.failed === 0 && summary.warnings === 0;
    const hasFixableIssues = findings.some((f) => f.severity !== "PASSED");

    return (
      <div className="space-y-4">
        {/* Summary card */}
        <div
          className={`rounded-xl border-2 p-4 flex items-center gap-4 ${
            allPassed
              ? "border-green-300 bg-green-50"
              : summary.failed > 0
              ? "border-rose-300 bg-rose-50"
              : "border-amber-300 bg-amber-50"
          }`}
        >
          {allPassed ? (
            <CheckCircle2 className="w-8 h-8 text-green-600 shrink-0" />
          ) : summary.failed > 0 ? (
            <XCircle className="w-8 h-8 text-rose-600 shrink-0" />
          ) : (
            <AlertTriangle className="w-8 h-8 text-amber-600 shrink-0" />
          )}
          <div className="flex-1">
            <p className="font-semibold text-slate-900">
              {allPassed
                ? "All best practices passed"
                : summary.failed > 0
                ? `${summary.failed} issue(s) need attention`
                : `${summary.warnings} warning(s) found`}
            </p>
            <p className="text-sm text-muted-foreground">
              {summary.passed} passed &middot; {summary.warnings} warnings &middot;{" "}
              {summary.failed} failed &middot; {summary.total} checks
            </p>
          </div>
        </div>

        {/* Fix + Re-validate buttons */}
        {hasFixableIssues && (
          <div className="flex gap-3">
            <Button
              onClick={() => fixMutation.mutate(findings)}
              disabled={fixMutation.isPending || fixApplied}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {fixMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Fixing...
                </>
              ) : fixApplied ? (
                <>
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Fixed
                </>
              ) : (
                <>
                  <Wrench className="w-4 h-4 mr-2" />
                  Fix Issues
                </>
              )}
            </Button>
            {fixApplied && (
              <Button
                variant="outline"
                onClick={() => {
                  setFixApplied(false);
                  onValidationStart?.();
                  validateMutation.mutate();
                }}
              >
                Re-validate
              </Button>
            )}
          </div>
        )}

        {/* Fix applied success banner */}
        {fixApplied && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-blue-600 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-blue-900">Dockerfile updated</p>
              <p className="text-xs text-blue-700">
                The AI has fixed the identified issues. Click "Re-validate" to confirm all checks pass.
              </p>
            </div>
          </div>
        )}

        {/* Findings list */}
        <div className="space-y-2">
          {["FAILED", "WARNING", "PASSED"].map((severity) => {
            const items = findings.filter((f) => f.severity === severity);
            if (items.length === 0) return null;
            return items.map((finding, i) => (
              <div
                key={`${finding.id}-${i}`}
                className={`rounded-lg border p-3 ${
                  finding.severity === "FAILED"
                    ? "border-rose-200 bg-rose-50 border-l-4 border-l-rose-500"
                    : finding.severity === "WARNING"
                    ? "border-amber-200 bg-amber-50 border-l-4 border-l-amber-400"
                    : "border-green-200 bg-green-50 border-l-4 border-l-green-400"
                }`}
              >
                <div className="flex items-start gap-2">
                  {finding.severity === "PASSED" ? (
                    <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                  ) : finding.severity === "WARNING" ? (
                    <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                          finding.severity === "PASSED"
                            ? "bg-green-100 text-green-700"
                            : finding.severity === "WARNING"
                            ? "bg-amber-100 text-amber-700"
                            : "bg-rose-100 text-rose-700"
                        }`}
                      >
                        {finding.severity}
                      </span>
                      <span className="text-xs font-mono text-muted-foreground">
                        {finding.id}
                      </span>
                      {finding.line && (
                        <span className="text-[10px] text-muted-foreground">
                          Line {finding.line}
                        </span>
                      )}
                    </div>
                    <p className="text-sm font-semibold text-slate-900 mt-1">
                      {finding.title}
                    </p>
                    <p className="text-xs text-slate-600 mt-0.5">
                      {finding.description}
                    </p>
                    {finding.fix && (
                      <div className="mt-2 rounded bg-white/60 border border-slate-200 p-2">
                        <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-0.5">
                          Suggested fix
                        </p>
                        <p className="text-xs text-slate-700 font-mono">
                          {finding.fix}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ));
          })}
        </div>
      </div>
    );
  }
);

DockerBestPractices.displayName = "DockerBestPractices";

export default DockerBestPractices;
