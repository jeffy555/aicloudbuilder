import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Shield, CheckCircle2, XCircle, AlertTriangle, Loader2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest } from "@/lib/queryClient";
import { useQueryClient } from "@tanstack/react-query";
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
  const [isFixing, setIsFixing] = useState(false);
  const [selectedChecks, setSelectedChecks] = useState<Set<string>>(new Set());
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const runScan = async () => {
    setIsScanning(true);
    // Clear selected checks when starting a new scan
    setSelectedChecks(new Set());
    try {
      const response = await apiRequest('POST', `/api/sessions/${sessionId}/scan`);
      
      // apiRequest already throws if response is not ok, so we can directly parse JSON
      const result = await response.json() as ScanResult;
      setScanResult(result);
      onScanComplete?.(result);
      
      // Handle different result scenarios
      if (result.summary.total === 0) {
        toast({
          title: "Scan complete - No resources found",
          description: "Checkov did not find any Terraform resources to scan. Make sure your files contain valid Terraform resources.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Security scan complete",
          description: `${result.summary.passPercentage}% of checks passed (${result.summary.passed}/${result.summary.total} total)`,
        });
      }
    } catch (error: any) {
      // Parse error message which is in format "500: {...json...}" or "500: error text"
      let errorMessage = error?.message || "Failed to run security scan";
      let errorDetails = '';
      
      // Try to extract JSON from error message (format: "500: {...json...}")
      const jsonMatch = errorMessage.match(/^\d+:\s*(\{.*\})/);
      if (jsonMatch) {
        try {
          const errorData = JSON.parse(jsonMatch[1]);
          errorMessage = errorData.error || errorMessage;
          errorDetails = errorData.details || '';
        } catch (e) {
          // If parsing fails, extract the text after the status code
          const textMatch = errorMessage.match(/^\d+:\s*(.+)/);
          if (textMatch) {
            errorMessage = textMatch[1];
          }
        }
      }
      
      // Combine error message and details
      const fullErrorMessage = errorDetails 
        ? `${errorMessage}\n\n${errorDetails}`
        : errorMessage;
      
      toast({
        title: "Scan failed",
        description: fullErrorMessage,
        variant: "destructive",
      });
    } finally {
      setIsScanning(false);
    }
  };

  const getStatusColor = (percentage: number) => {
    // Handle NaN or invalid percentages
    if (isNaN(percentage) || !isFinite(percentage)) {
      return "text-yellow-600 dark:text-yellow-400";
    }
    if (percentage >= 80) return "text-green-600 dark:text-green-400";
    if (percentage >= 60) return "text-yellow-600 dark:text-yellow-400";
    return "text-red-600 dark:text-red-400";
  };

  const getStatusIcon = (percentage: number) => {
    // Handle NaN or invalid percentages
    if (isNaN(percentage) || !isFinite(percentage)) {
      return <AlertTriangle className="w-6 h-6 text-yellow-600" />;
    }
    if (percentage >= 80) return <CheckCircle2 className="w-6 h-6 text-green-600" />;
    if (percentage >= 60) return <AlertTriangle className="w-6 h-6 text-yellow-600" />;
    return <XCircle className="w-6 h-6 text-red-600" />;
  };

  const fixIssues = async () => {
    if (!scanResult || scanResult.failedChecks.length === 0) {
      toast({
        title: "No issues to fix",
        description: "There are no failed checks to fix",
        variant: "destructive",
      });
      return;
    }

    if (selectedChecks.size === 0) {
      toast({
        title: "No issues selected",
        description: "Please select at least one issue to fix",
        variant: "destructive",
      });
      return;
    }

    // Filter to only selected checks
    const checksToFix = scanResult.failedChecks.filter(check => 
      selectedChecks.has(check.checkId)
    );

    setIsFixing(true);
    try {
      const response = await apiRequest('POST', `/api/sessions/${sessionId}/fix-issues`, {
        failedChecks: checksToFix
      });
      
      const result = await response.json();
      
      // Show detailed results
      if (result.fixResults) {
        const { fixed, failed, skipped, details } = result.fixResults;
        let message = `Fixed ${fixed} check(s)`;
        if (failed > 0) {
          message += `, ${failed} failed`;
        }
        if (skipped > 0) {
          message += `, ${skipped} skipped`;
        }
        
        if (failed > 0 || skipped > 0) {
          // Show detailed error for failed/skipped checks
          const failedChecks = details.filter((d: any) => d.status === 'failed' || d.status === 'skipped');
          const failedDetails = failedChecks.map((d: any) => 
            `${d.checkId}: ${d.reason}`
          ).join('\n');
          
          toast({
            title: "Fix completed with issues",
            description: message,
            variant: failed > 0 ? "destructive" : "default",
          });
          
          // Also log to console for debugging
          console.warn('Some checks were not fixed:', failedDetails);
        } else {
          toast({
            title: "Issues fixed",
            description: message,
          });
        }
      } else {
        toast({
          title: "Issues fixed",
          description: `Successfully fixed ${result.fixedFiles?.length || 0} file(s)`,
        });
      }

      // Invalidate files query to refresh the UI with updated files
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      
      // Force a refetch to ensure we have the latest files
      await queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });

      // Clear selected checks after fixing
      setSelectedChecks(new Set());

      // Wait a moment for files to be fully updated, then re-run scan to verify fixes
      await new Promise(resolve => setTimeout(resolve, 1000));
      await runScan();
    } catch (error: any) {
      let errorMessage = error?.message || "Failed to fix issues";
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
        title: "Fix failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsFixing(false);
    }
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
            <div className="flex gap-2">
              {scanResult.failedChecks.length > 0 && (
                <Button
                  variant="default"
                  onClick={fixIssues}
                  disabled={isFixing || isScanning || selectedChecks.size === 0}
                  data-testid="button-fix-issues"
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  {isFixing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Fixing...
                    </>
                  ) : (
                    <>
                      <Shield className="w-4 h-4 mr-2" />
                      Fix Selected ({selectedChecks.size})
                    </>
                  )}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={runScan}
                disabled={isScanning || isFixing}
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
            </div>
          )}
        </div>
        <CardDescription>
          Validate your Terraform code for security best practices using Checkov
        </CardDescription>
      </CardHeader>

      {scanResult && (
        <CardContent className="space-y-4">
          {/* Handle case when no resources were scanned */}
          {scanResult.summary.total === 0 ? (
            <Alert variant="destructive">
              <AlertTriangle className="w-4 h-4" />
              <AlertTitle>No Resources Scanned</AlertTitle>
              <AlertDescription>
                Checkov did not find any Terraform resources to scan. This usually means:
                <ul className="list-disc list-inside mt-2 space-y-1">
                  <li>No Terraform files (.tf, .tfvars, .hcl) were found</li>
                  <li>Files are empty or contain invalid Terraform syntax</li>
                  <li>Files were not generated or saved correctly</li>
                </ul>
                <p className="mt-2 text-sm">
                  Please ensure you have generated Terraform files before running the scan.
                </p>
              </AlertDescription>
            </Alert>
          ) : (
            <>
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
                      {scanResult.summary.skipped > 0 && (
                        <span className="text-muted-foreground">
                          ⊘ {scanResult.summary.skipped} skipped
                        </span>
                      )}
                      <span className="text-muted-foreground">
                        Total: {scanResult.summary.total} checks
                      </span>
                    </div>
                  </div>
                </div>
              </Alert>

              {/* Failed Checks */}
              {scanResult.failedChecks.length > 0 ? (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold flex items-center gap-2">
                      <XCircle className="w-4 h-4 text-red-600" />
                      Failed Checks ({scanResult.failedChecks.length})
                    </h4>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          // Select all
                          setSelectedChecks(new Set(scanResult.failedChecks.map(c => c.checkId)));
                        }}
                        className="text-xs h-7"
                      >
                        Select All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          // Deselect all
                          setSelectedChecks(new Set());
                        }}
                        className="text-xs h-7"
                      >
                        Deselect All
                      </Button>
                    </div>
                  </div>
                  <ScrollArea className="h-[250px] rounded-md border">
                    <div className="p-4 space-y-3">
                      {scanResult.failedChecks.map((check, idx) => {
                        const isSelected = selectedChecks.has(check.checkId);
                        return (
                          <Card 
                            key={idx} 
                            className={`p-3 ${isSelected ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : ''}`}
                            data-testid={`failed-check-${idx}`}
                          >
                            <div className="space-y-2">
                              <div className="flex items-start gap-3">
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={(checked) => {
                                    const newSelected = new Set(selectedChecks);
                                    if (checked) {
                                      newSelected.add(check.checkId);
                                    } else {
                                      newSelected.delete(check.checkId);
                                    }
                                    setSelectedChecks(newSelected);
                                  }}
                                  className="mt-1"
                                />
                                <div className="flex-1">
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
                                  <p className="text-xs text-muted-foreground mt-2">
                                    File: {check.file}
                                  </p>
                                  {check.guideline && (
                                    <p className="text-xs text-muted-foreground border-l-2 border-muted pl-2 mt-2">
                                      {check.guideline}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          </Card>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
              ) : (
                <Alert>
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  <AlertTitle>All Checks Passed!</AlertTitle>
                  <AlertDescription>
                    No security issues were found. Your Terraform code passed all {scanResult.summary.total} security checks.
                  </AlertDescription>
                </Alert>
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
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
