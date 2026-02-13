import { useState, forwardRef, useImperativeHandle } from "react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  DollarSign,
  TrendingUp,
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  RefreshCw,
  Info,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { CostAnalysisResult, CostResource, UsageProfile } from "@shared/schema";

interface CostAnalyzerProps {
  sessionId: string;
  onCostComplete?: (result: CostAnalysisResult) => void;
  onAnalysisStart?: () => void;
  onAnalysisComplete?: () => void;
}

export interface CostAnalyzerRef {
  triggerAnalysis: () => void;
}

const STATUS_CONFIG = {
  exact: {
    label: 'Exact',
    color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    icon: CheckCircle2,
  },
  estimated: {
    label: 'Estimated',
    color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    icon: Info,
  },
  needs_input: {
    label: 'Needs Input',
    color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    icon: HelpCircle,
  },
} as const;

const CostAnalyzer = forwardRef<CostAnalyzerRef, CostAnalyzerProps>(
  ({ sessionId, onCostComplete, onAnalysisStart, onAnalysisComplete }, ref) => {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [costResult, setCostResult] = useState<CostAnalysisResult | null>(null);
  const [profile, setProfile] = useState<UsageProfile>('medium');
  const { toast } = useToast();

  const analyzeCost = async (selectedProfile?: UsageProfile) => {
    setIsAnalyzing(true);
    onAnalysisStart?.();
    try {
      const response = await apiRequest('POST', `/api/sessions/${sessionId}/analyze-cost`, {
        profile: selectedProfile || profile,
      });
      const result = await response.json() as CostAnalysisResult;
      setCostResult(result);
      onCostComplete?.(result);

      toast({
        title: "Cost analysis complete",
        description: `Total: $${result.summary.monthlyGrandTotal.toFixed(2)}/month (${result.summary.exactCount} exact, ${result.summary.estimatedCount} estimated)`,
      });
    } catch (error: any) {
      let errorMessage = error?.message || "Failed to analyze costs";
      let errorDetails = "";

      const jsonMatch = errorMessage.match(/^\d+:\s*(\{.*\})/);
      if (jsonMatch) {
        try {
          const errorData = JSON.parse(jsonMatch[1]);
          errorMessage = errorData.error || errorMessage;
          errorDetails = errorData.details || "";
        } catch {
          const textMatch = errorMessage.match(/^\d+:\s*(.+)/);
          if (textMatch) errorMessage = textMatch[1];
        }
      }

      console.error('Cost analysis error:', error);

      toast({
        title: "Analysis failed",
        description: errorDetails ? `${errorMessage}: ${errorDetails}` : errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
      onAnalysisComplete?.();
    }
  };

  useImperativeHandle(ref, () => ({
    triggerAnalysis: () => analyzeCost()
  }));

  const formatCurrency = (amount: number, currency: string = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  };

  const handleProfileChange = (newProfile: string) => {
    const p = newProfile as UsageProfile;
    setProfile(p);
    if (costResult) {
      analyzeCost(p);
    }
  };

  const renderStatusBadge = (resource: CostResource) => {
    const config = STATUS_CONFIG[resource.status];
    const Icon = config.icon;
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <Badge className={`${config.color} text-xs gap-1 cursor-help`}>
              <Icon className="w-3 h-3" />
              {config.label}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {resource.assumptionsUsed.length > 0 ? (
              <div className="space-y-1">
                <p className="font-semibold text-xs">Assumptions:</p>
                {resource.assumptionsUsed.map((a, i) => (
                  <p key={i} className="text-xs">- {a}</p>
                ))}
              </div>
            ) : (
              <p className="text-xs">SKU-based exact pricing from Azure Retail API</p>
            )}
            {resource.unresolvedVariables && resource.unresolvedVariables.length > 0 && (
              <p className="text-xs mt-1 text-red-400">
                Unresolved: {resource.unresolvedVariables.join(', ')}
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  const summary = costResult?.summary;

  return (
    <div className="w-full space-y-4">
      {costResult && (
        <div className="space-y-4">
          {/* Profile selector + recalc */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Usage profile:</span>
            <Select value={profile} onValueChange={handleProfileChange}>
              <SelectTrigger className="w-32 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
            {isAnalyzing && (
              <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
            )}
          </div>

          {/* Summary cards */}
          {summary && (
            <div className="grid grid-cols-3 gap-3">
              {/* Exact */}
              <div className="rounded-lg border bg-green-50 dark:bg-green-950 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  <span className="text-xs font-medium text-green-700 dark:text-green-300">Exact</span>
                </div>
                <p className="text-lg font-bold text-green-700 dark:text-green-200">
                  {formatCurrency(summary.monthlyTotalExact)}
                </p>
                <p className="text-xs text-muted-foreground">{summary.exactCount} resource(s)</p>
              </div>
              {/* Estimated */}
              <div className="rounded-lg border bg-yellow-50 dark:bg-yellow-950 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Info className="w-4 h-4 text-yellow-600" />
                  <span className="text-xs font-medium text-yellow-700 dark:text-yellow-300">Estimated</span>
                </div>
                <p className="text-lg font-bold text-yellow-700 dark:text-yellow-200">
                  {formatCurrency(summary.monthlyTotalEstimated)}
                </p>
                <p className="text-xs text-muted-foreground">{summary.estimatedCount} resource(s)</p>
              </div>
              {/* Needs Input */}
              <div className="rounded-lg border bg-red-50 dark:bg-red-950 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <HelpCircle className="w-4 h-4 text-red-600" />
                  <span className="text-xs font-medium text-red-700 dark:text-red-300">Needs Input</span>
                </div>
                <p className="text-lg font-bold text-red-700 dark:text-red-200">
                  {summary.needsInputCount}
                </p>
                <p className="text-xs text-muted-foreground">resource(s)</p>
              </div>
            </div>
          )}

          {/* Resource table */}
          {costResult.resources.length > 0 ? (
            <>
              <div>
                <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-blue-600" />
                  Resource Costs ({costResult.resources.length} resources)
                </h4>
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Resource</TableHead>
                        <TableHead>Service</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Monthly Cost</TableHead>
                        <TableHead className="text-right">Yearly Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {costResult.resources.map((resource, idx) => (
                        <TableRow key={idx} data-testid={`cost-resource-${idx}`}>
                          <TableCell>
                            <div>
                              <p className="font-medium text-sm">{resource.resourceName}</p>
                              <p className="text-xs text-muted-foreground font-mono">
                                {resource.resourceType}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {resource.serviceName}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {renderStatusBadge(resource)}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {resource.status === 'needs_input'
                              ? <span className="text-muted-foreground">--</span>
                              : formatCurrency(resource.monthlyCost, resource.currency)
                            }
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {resource.status === 'needs_input'
                              ? <span className="text-muted-foreground">--</span>
                              : formatCurrency(resource.yearlyCost, resource.currency)
                            }
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Grand total */}
              {summary && (
                <Alert className="bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
                  <div className="flex items-center gap-3 w-full">
                    <TrendingUp className="w-6 h-6 text-blue-600 flex-shrink-0" />
                    <div className="flex-1">
                      <AlertTitle className="mb-3 text-lg">
                        Total Estimated Cost
                      </AlertTitle>
                      <div className="grid grid-cols-2 gap-6">
                        <div>
                          <p className="text-sm text-muted-foreground mb-1">Monthly</p>
                          <p className="text-2xl font-bold text-blue-600">
                            {formatCurrency(summary.monthlyGrandTotal, summary.currency)}
                          </p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground mb-1">Yearly</p>
                          <p className="text-2xl font-bold text-green-600">
                            {formatCurrency(summary.yearlyGrandTotal, summary.currency)}
                          </p>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-3">
                        {summary.resourceCount} resource(s) | Profile: {summary.profile}
                        {summary.freeCount > 0 && ` | ${summary.freeCount} free`}
                      </p>
                    </div>
                  </div>
                </Alert>
              )}

              {/* Skipped resources warning */}
              {costResult.skippedResources && costResult.skippedResources.length > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="w-4 h-4" />
                  <AlertTitle>Skipped Resources ({costResult.skippedResources.length})</AlertTitle>
                  <AlertDescription>
                    <ul className="text-xs mt-1 space-y-1">
                      {costResult.skippedResources.map((r, i) => (
                        <li key={i}>
                          <span className="font-mono">{r.resourceType}.{r.resourceName}</span>: {r.reason}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </>
          ) : (
            <Alert>
              <AlertCircle className="w-4 h-4" />
              <AlertTitle>No Resources Found</AlertTitle>
              <AlertDescription>
                No Azure resources were detected in the Terraform files. Make sure your files contain valid Azure resource definitions.
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  );
});

CostAnalyzer.displayName = 'CostAnalyzer';

export default CostAnalyzer;
