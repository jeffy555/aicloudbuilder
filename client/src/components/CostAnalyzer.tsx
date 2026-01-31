import { useState, forwardRef, useImperativeHandle } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DollarSign, TrendingUp, AlertCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface CostSummary {
  totalMonthly: number;
  totalYearly: number;
  currency: string;
  resourceCount: number;
}

interface CostResource {
  resourceName: string;
  resourceType: string;
  serviceName: string;
  monthlyCost: number;
  yearlyCost: number;
  currency: string;
  details?: any;
}

interface CostResult {
  success: boolean;
  summary: CostSummary;
  resources: CostResource[];
}

interface CostAnalyzerProps {
  sessionId: string;
  onCostComplete?: (result: CostResult) => void;
  onAnalysisStart?: () => void;
  onAnalysisComplete?: () => void;
}

export interface CostAnalyzerRef {
  triggerAnalysis: () => void;
}

const CostAnalyzer = forwardRef<CostAnalyzerRef, CostAnalyzerProps>(
  ({ sessionId, onCostComplete, onAnalysisStart, onAnalysisComplete }, ref) => {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [costResult, setCostResult] = useState<CostResult | null>(null);
  const { toast } = useToast();

  const analyzeCost = async () => {
    setIsAnalyzing(true);
    onAnalysisStart?.();
    try {
      const response = await apiRequest('POST', `/api/sessions/${sessionId}/analyze-cost`);
      const result = await response.json() as CostResult;
      setCostResult(result);
      onCostComplete?.(result);
      
      toast({
        title: "Cost analysis complete",
        description: `Total: ${result.summary.currency} ${result.summary.totalMonthly.toFixed(2)}/month`,
      });
    } catch (error: any) {
      let errorMessage = error?.message || "Failed to analyze costs";
      let errorDetails = "";
      
      // Try to parse error response
      const jsonMatch = errorMessage.match(/^\d+:\s*(\{.*\})/);
      if (jsonMatch) {
        try {
          const errorData = JSON.parse(jsonMatch[1]);
          errorMessage = errorData.error || errorMessage;
          errorDetails = errorData.details || "";
        } catch (e) {
          const textMatch = errorMessage.match(/^\d+:\s*(.+)/);
          if (textMatch) {
            errorMessage = textMatch[1];
          }
        }
      }
      
      // Log full error for debugging
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
    triggerAnalysis: analyzeCost
  }));

  const formatCurrency = (amount: number, currency: string = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  };

  return (
    <div className="w-full space-y-4">
      {/* No internal loading state - button shows loading instead (like CheckovScanner) */}
      {costResult && (
        <div className="space-y-4">
          {/* Resource Breakdown - Show individual resources first */}
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
                          <TableCell className="text-right font-medium">
                            {formatCurrency(resource.monthlyCost, resource.currency)}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(resource.yearlyCost, resource.currency)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Total Cost Summary - Show at the bottom */}
              <Alert className="bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
                <div className="flex items-center gap-3 w-full">
                  <TrendingUp className="w-6 h-6 text-blue-600 flex-shrink-0" />
                  <div className="flex-1">
                    <AlertTitle className="mb-3 text-lg">
                      Total Cost
                    </AlertTitle>
                    <div className="grid grid-cols-2 gap-6">
                      <div>
                        <p className="text-sm text-muted-foreground mb-1">Total Monthly Cost</p>
                        <p className="text-2xl font-bold text-blue-600">
                          {formatCurrency(costResult.summary.totalMonthly, costResult.summary.currency)}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground mb-1">Total Yearly Cost</p>
                        <p className="text-2xl font-bold text-green-600">
                          {formatCurrency(costResult.summary.totalYearly, costResult.summary.currency)}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-3">
                      Based on {costResult.summary.resourceCount} resource(s)
                    </p>
                  </div>
                </div>
              </Alert>
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

