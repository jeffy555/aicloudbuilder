import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Shield, CheckCircle2, XCircle, AlertTriangle, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ScanSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  passPercentage: number;
}

interface FailedCheck {
  checkId: string;
  checkName: string;
  resource: string;
  file: string;
  guideline?: string;
}

interface PassedCheck {
  checkId: string;
  checkName: string;
  resource: string;
}

interface ScanResult {
  success: boolean;
  summary: ScanSummary;
  failedChecks: FailedCheck[];
  passedChecks: PassedCheck[];
}

interface CheckovScannerProps {
  sessionId: string;
  onScanComplete?: (result: ScanResult) => void;
}

export default function CheckovScanner({ sessionId, onScanComplete }: CheckovScannerProps) {
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const { toast } = useToast();

  const runScan = async () => {
    setIsScanning(true);
    try {
      const response = await apiRequest('POST', `/api/sessions/${sessionId}/scan`);
      
      // Check if response is successful
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to run security scan');
      }
      
      const result = await response.json() as ScanResult;
      setScanResult(result);
      onScanComplete?.(result);
      
      toast({
        title: "Security scan complete",
        description: `${result.summary.passPercentage}% of checks passed`,
      });
    } catch (error: any) {
      toast({
        title: "Scan failed",
        description: error.message || "Failed to run security scan",
        variant: "destructive",
      });
    } finally {
      setIsScanning(false);
    }
  };

  const getStatusColor = (percentage: number) => {
    if (percentage >= 80) return "text-green-600 dark:text-green-400";
    if (percentage >= 60) return "text-yellow-600 dark:text-yellow-400";
    return "text-red-600 dark:text-red-400";
  };

  const getStatusIcon = (percentage: number) => {
    if (percentage >= 80) return <CheckCircle2 className="w-6 h-6 text-green-600" />;
    if (percentage >= 60) return <AlertTriangle className="w-6 h-6 text-yellow-600" />;
    return <XCircle className="w-6 h-6 text-red-600" />;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5" />
            <CardTitle>Security Scan</CardTitle>
          </div>
          {!scanResult && (
            <Button
              onClick={runScan}
              disabled={isScanning}
              data-testid="button-run-scan"
            >
              {isScanning ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Scanning...
                </>
              ) : (
                "Run Checkov Scan"
              )}
            </Button>
          )}
          {scanResult && (
            <Button
              variant="outline"
              onClick={runScan}
              disabled={isScanning}
              data-testid="button-rescan"
            >
              {isScanning ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Rescanning...
                </>
              ) : (
                "Re-scan"
              )}
            </Button>
          )}
        </div>
        <CardDescription>
          Validate your Terraform code for security best practices using Checkov
        </CardDescription>
      </CardHeader>

      {scanResult && (
        <CardContent className="space-y-4">
          {/* Summary Card */}
          <Alert>
            <div className="flex items-center gap-3">
              {getStatusIcon(scanResult.summary.passPercentage)}
              <div className="flex-1">
                <AlertTitle className="mb-2">
                  Scan Results: {scanResult.summary.passPercentage}% Pass Rate
                </AlertTitle>
                <Progress 
                  value={scanResult.summary.passPercentage} 
                  className="h-2"
                  data-testid="progress-scan-percentage"
                />
                <div className="flex gap-4 mt-2 text-sm">
                  <span className="text-green-600">
                    ✓ {scanResult.summary.passed} passed
                  </span>
                  <span className="text-red-600">
                    ✗ {scanResult.summary.failed} failed
                  </span>
                  <span className="text-muted-foreground">
                    ⊘ {scanResult.summary.skipped} skipped
                  </span>
                </div>
              </div>
            </div>
          </Alert>

          {/* Failed Checks */}
          {scanResult.failedChecks.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <XCircle className="w-4 h-4 text-red-600" />
                Failed Checks ({scanResult.failedChecks.length})
              </h4>
              <ScrollArea className="h-[250px] rounded-md border">
                <div className="p-4 space-y-3">
                  {scanResult.failedChecks.map((check, idx) => (
                    <Card key={idx} className="p-3" data-testid={`failed-check-${idx}`}>
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <p className="font-medium text-sm">{check.checkName}</p>
                            <p className="text-xs text-muted-foreground font-mono mt-1">
                              {check.resource}
                            </p>
                          </div>
                          <Badge variant="destructive" className="text-xs">
                            {check.checkId}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          File: {check.file}
                        </p>
                        {check.guideline && (
                          <p className="text-xs text-muted-foreground border-l-2 border-muted pl-2">
                            {check.guideline}
                          </p>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Passed Checks Sample */}
          {scanResult.passedChecks.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                Sample Passed Checks ({scanResult.passedChecks.length} shown)
              </h4>
              <ScrollArea className="h-[150px] rounded-md border">
                <div className="p-4 space-y-2">
                  {scanResult.passedChecks.map((check, idx) => (
                    <div 
                      key={idx} 
                      className="flex items-center justify-between p-2 rounded-md hover-elevate"
                      data-testid={`passed-check-${idx}`}
                    >
                      <div className="flex-1">
                        <p className="text-sm">{check.checkName}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {check.resource}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-xs">
                        {check.checkId}
                      </Badge>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
