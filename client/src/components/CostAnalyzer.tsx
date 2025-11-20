import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DollarSign, Loader2, TrendingUp, AlertCircle } from "lucide-react";
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
}

export default function CostAnalyzer({ sessionId, onCostComplete }: CostAnalyzerProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [costResult, setCostResult] = useState<CostResult | null>(null);
  const { toast } = useToast();

  const analyzeCost = async () => {
    setIsAnalyzing(true);
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
      const jsonMatch = errorMessage.match(/^\d+:\s*(\{.*\})/);
      if (jsonMatch) {
        try {
          const errorData = JSON.parse(jsonMatch[1]);
          errorMessage = errorData.error || errorMessage;
        } catch (e) {
          const textMatch = errorMessage.match(/^\d+:\s*(.+)/);
          if (textMatch) {
            errorMessage = textMatch[1];
          }
        }
      }
      
      toast({
        title: "Analysis failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const formatCurrency = (amount: number, currency: string = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="w-5 h-5" />
            <CardTitle>Cost Analysis</CardTitle>
          </div>
          {!costResult && (
            <Button
              onClick={analyzeCost}
              disabled={isAnalyzing}
              data-testid="button-analyze-cost"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                "Analyze Cost"
              )}
            </Button>
          )}
          {costResult && (
            <Button
              variant="outline"
              onClick={analyzeCost}
              disabled={isAnalyzing}
              data-testid="button-reanalyze-cost"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Re-analyzing...
                </>
              ) : (
                "Re-analyze"
              )}
            </Button>
          )}
        </div>
        <CardDescription>
          Estimate monthly and yearly costs for your Azure resources
        </CardDescription>
      </CardHeader>

      {costResult && (
        <CardContent className="space-y-4">
          {/* Summary Card */}
          <Alert>
            <div className="flex items-center gap-3">
              <TrendingUp className="w-6 h-6 text-blue-600" />
              <div className="flex-1">
                <AlertTitle className="mb-2">
                  Cost Summary
                </AlertTitle>
                <div className="grid grid-cols-2 gap-4 mt-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Monthly Cost</p>
                    <p className="text-2xl font-bold text-blue-600">
                      {formatCurrency(costResult.summary.totalMonthly, costResult.summary.currency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Yearly Cost</p>
                    <p className="text-2xl font-bold text-green-600">
                      {formatCurrency(costResult.summary.totalYearly, costResult.summary.currency)}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Based on {costResult.summary.resourceCount} resource(s)
                </p>
              </div>
            </div>
          </Alert>

          {/* Resource Breakdown */}
          {costResult.resources.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-blue-600" />
                Resource Breakdown ({costResult.resources.length})
              </h4>
              <ScrollArea className="h-[300px] rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Resource</TableHead>
                      <TableHead>Service</TableHead>
                      <TableHead className="text-right">Monthly</TableHead>
                      <TableHead className="text-right">Yearly</TableHead>
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
              </ScrollArea>
            </div>
          )}

          {costResult.resources.length === 0 && (
            <Alert>
              <AlertCircle className="w-4 h-4" />
              <AlertTitle>No Resources Found</AlertTitle>
              <AlertDescription>
                No Azure resources were detected in the Terraform files. Make sure your files contain valid Azure resource definitions.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      )}
    </Card>
  );
}

