import { useState, useImperativeHandle, forwardRef } from "react";
import { DollarSign, TrendingDown, Loader2, AlertTriangle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

export interface KubernetesCostEstimatorRef {
  triggerAnalysis: () => void;
}

interface Props {
  sessionId: string;
  onComplete?: () => void;
}

interface CostBreakdown {
  workload: string;
  container: string;
  cpuRequestCores: number;
  memRequestGiB: number;
  monthlyCPUCost: number;
  monthlyMemCost: number;
  monthlyTotal: number;
}

interface CostResult {
  breakdown: CostBreakdown[];
  totalMonthlyCost: number;
  totalYearlyCost: number;
  currency: string;
  totalContainers: number;
  totalWorkloads: number;
  recommendations: string[];
}

const KubernetesCostEstimator = forwardRef<KubernetesCostEstimatorRef, Props>(
  ({ sessionId, onComplete }, ref) => {
    const [result, setResult] = useState<CostResult | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const triggerAnalysis = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await apiRequest('POST', `/api/sessions/${sessionId}/estimate-k8s-cost`);
        const data = await res.json();
        if (data.success) {
          setResult(data.result);
        } else {
          setError(data.error || 'Cost estimation failed');
        }
        onComplete?.();
      } catch (err: any) {
        setError(err.message);
        onComplete?.();
      } finally {
        setIsLoading(false);
      }
    };

    useImperativeHandle(ref, () => ({ triggerAnalysis }));

    if (isLoading) {
      return (
        <div className="flex items-center gap-3 p-4 rounded-lg border bg-muted/30">
          <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
          <span className="text-sm text-muted-foreground">Estimating resource costs…</span>
        </div>
      );
    }

    if (error) {
      return (
        <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
          Cost estimation failed: {error}
        </div>
      );
    }

    if (!result) return null;

    return (
      <div className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border bg-card p-3 text-center">
            <p className="text-xs text-muted-foreground">Monthly Est.</p>
            <p className="text-lg font-bold text-emerald-600">${result.totalMonthlyCost.toFixed(2)}</p>
          </div>
          <div className="rounded-xl border bg-card p-3 text-center">
            <p className="text-xs text-muted-foreground">Yearly Est.</p>
            <p className="text-lg font-bold">${result.totalYearlyCost.toFixed(2)}</p>
          </div>
          <div className="rounded-xl border bg-card p-3 text-center">
            <p className="text-xs text-muted-foreground">Containers</p>
            <p className="text-lg font-bold">{result.totalContainers}</p>
          </div>
        </div>

        {/* Breakdown table */}
        {result.breakdown.length > 0 && (
          <div className="rounded-xl border overflow-hidden">
            <div className="px-4 py-2 bg-muted/50 border-b">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5" /> Cost Breakdown by Container
              </p>
            </div>
            <div className="divide-y">
              {result.breakdown.map((b, i) => (
                <div key={i} className="px-4 py-3 flex items-center gap-4 text-sm">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-xs truncate">{b.workload}</p>
                    <p className="text-xs text-muted-foreground">{b.container}</p>
                  </div>
                  <div className="text-xs text-muted-foreground shrink-0">
                    {b.cpuRequestCores}cpu · {b.memRequestGiB}GiB
                  </div>
                  <div className="text-sm font-semibold shrink-0 text-emerald-600">
                    ${b.monthlyTotal}/mo
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {result.breakdown.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No workload containers found with resource definitions.
          </p>
        )}

        {/* Recommendations */}
        {result.recommendations.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-2">
            <p className="text-xs font-semibold flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
              <TrendingDown className="w-3.5 h-3.5" /> Rightsizing Recommendations
            </p>
            {result.recommendations.map((r, i) => (
              <p key={i} className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                {r}
              </p>
            ))}
          </div>
        )}
      </div>
    );
  }
);

KubernetesCostEstimator.displayName = 'KubernetesCostEstimator';
export default KubernetesCostEstimator;
