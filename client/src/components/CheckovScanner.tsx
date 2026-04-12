import { useState, useMemo, forwardRef, useImperativeHandle } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Shield, CheckCircle2, XCircle, AlertTriangle, Loader2, CheckCircle, ChevronDown, ChevronRight } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest } from "@/lib/queryClient";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import FileDiffView from "./FileDiffView";

interface ScanSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  passPercentage: number;
}

interface ComplianceStandard {
  framework: string;
  control: string;
}

interface FailedCheck {
  checkId: string;
  checkName: string;
  resource: string;
  file: string;
  guideline?: string;
  reason?: string;
  evaluatedKeys?: string[];
  checkResult?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low' | null;
  autoFixable?: boolean;
  fixComplexity?: string;
  complianceStandards?: ComplianceStandard[];
}

interface PassedCheck {
  checkId: string;
  checkName: string;
  resource: string;
  severity?: string | null;
}

interface FixedCheck {
  checkId: string;
  checkName: string;
  resource: string;
  file: string;
  fixedAt: Date;
  verified: boolean;
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
  onScanStart?: () => void;
  framework?: 'terraform' | 'kubernetes' | 'docker'; // Add framework prop
  moduleApproach?: 'child-module' | 'standalone-root' | 'aggregated-root' | null;
  onFixesApplied?: (diffs: Array<{ fileName: string; fixedContent: string }>) => void;
  onFixesApproved?: (diffs: Array<{ fileName: string; fixedContent: string }>) => void;
  onFixResult?: (payload: {
    fixed: number;
    failed: number;
    skipped: number;
    failureDetails: Array<{ checkId: string; checkName: string; resource: string; file: string; reason: string }>;
  }) => void;
  showDiffView?: boolean;
  /** Called when the fix operation starts (so parent can show a loading terminal) */
  onFixStart?: () => void;
  /** Called when the fix operation ends (so parent can restore the results view) */
  onFixComplete?: () => void;
}

export interface CheckovScannerRef {
  triggerScan: () => void;
  hasUnapprovedFixes: () => boolean;
  getFixesApproved: () => boolean;
  approveFixes: () => Promise<void>;
}

const CheckovScanner = forwardRef<CheckovScannerRef, CheckovScannerProps>(
  ({
    sessionId,
    onScanComplete,
    onScanStart,
    framework = 'terraform',
    moduleApproach,
    onFixesApplied,
    onFixesApproved,
    onFixResult,
    showDiffView = true,
    onFixStart,
    onFixComplete,
  }, ref) => {
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [preScanResult, setPreScanResult] = useState<ScanResult | null>(null); // baseline before fixes
  const [isFixing, setIsFixing] = useState(false);
  const [selectedChecks, setSelectedChecks] = useState<Set<string>>(new Set());
  const [fixedChecks, setFixedChecks] = useState<FixedCheck[]>([]);
  const [activeTab, setActiveTab] = useState<'failed' | 'fixed'>('failed');
  const [fileDiffs, setFileDiffs] = useState<Array<{ fileName: string; originalContent: string; fixedContent: string }>>([]);
  const [fixesApproved, setFixesApproved] = useState(false);
  const [hasUnapprovedFixes, setHasUnapprovedFixes] = useState(false);
  // After the fix→approve→re-scan cycle completes, lock the UI to read-only (no more fixes)
  const [scanCycleComplete, setScanCycleComplete] = useState(false);
  const [latestFixFailures, setLatestFixFailures] = useState<Array<{ checkId: string; checkName: string; resource: string; file: string; reason: string }>>([]);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());

  const selectionKey = (check: FailedCheck) => `${check.checkId}:${check.resource}`;

  const groupedChecks = useMemo((): [string, FailedCheck[]][] => {
    if (!scanResult) return [];
    const groups = new Map<string, FailedCheck[]>();
    scanResult.failedChecks.forEach(check => {
      const file = check.file || 'Unknown File';
      if (!groups.has(file)) groups.set(file, []);
      groups.get(file)!.push(check);
    });
    const entries: [string, FailedCheck[]][] = [];
    groups.forEach((value, key) => entries.push([key, value]));
    return entries.sort((a, b) => b[1].length - a[1].length);
  }, [scanResult]);

  const groupedFixedChecks = useMemo((): [string, FixedCheck[]][] => {
    const groups = new Map<string, FixedCheck[]>();
    fixedChecks.forEach(check => {
      const file = check.file || 'Unknown File';
      if (!groups.has(file)) groups.set(file, []);
      groups.get(file)!.push(check);
    });
    const entries: [string, FixedCheck[]][] = [];
    groups.forEach((value, key) => entries.push([key, value]));
    return entries.sort((a, b) => b[1].length - a[1].length);
  }, [fixedChecks]);

  const runScan = async () => {
    setIsScanning(true);
    onScanStart?.();
    // Clear selected checks and collapsed modules when starting a new scan
    setSelectedChecks(new Set());
    setExpandedModules(new Set());
    try {
      let endpoint: string;
      if (framework === 'kubernetes') {
        endpoint = `/api/sessions/${sessionId}/scan-kubernetes`;
      } else if (framework === 'docker') {
        endpoint = `/api/sessions/${sessionId}/scan-docker`;
      } else {
        endpoint = `/api/sessions/${sessionId}/scan`;
      }
      const response = await apiRequest('POST', endpoint);
      
      // apiRequest already throws if response is not ok, so we can directly parse JSON
      const rawResult = await response.json();
      console.log('🔍 Raw scan result from API:', JSON.stringify(rawResult, null, 2));
      
      // Normalize the result structure - handle different possible response formats
      const result: ScanResult = {
        success: rawResult.success ?? true,
        summary: {
          passed: Number(rawResult.summary?.passed) || 0,
          failed: Number(rawResult.summary?.failed) || 0,
          skipped: Number(rawResult.summary?.skipped) || 0,
          total: Number(rawResult.summary?.total) || 
            (Number(rawResult.summary?.passed) || 0) + 
            (Number(rawResult.summary?.failed) || 0) + 
            (Number(rawResult.summary?.skipped) || 0),
          passPercentage: 0 // Will calculate below
        },
        failedChecks: rawResult.failedChecks || rawResult.checks || [],
        passedChecks: rawResult.passedChecks || []
      };
      
      // Calculate passPercentage if not provided or if it's 0/null
      if (rawResult.summary?.passPercentage != null && !isNaN(Number(rawResult.summary.passPercentage))) {
        result.summary.passPercentage = Number(rawResult.summary.passPercentage);
      } else {
        // Calculate from passed/total
        result.summary.passPercentage = result.summary.total > 0 
          ? Math.round((result.summary.passed / result.summary.total) * 100) 
          : 0;
      }
      
      console.log('✅ Normalized scan result:', {
        passed: result.summary.passed,
        failed: result.summary.failed,
        total: result.summary.total,
        passPercentage: result.summary.passPercentage
      });
      
      setScanResult(result);
      // Store the very first scan as the pre-fix baseline for before/after comparison
      setPreScanResult(prev => prev ?? result);
      onScanComplete?.(result);
      
      // Handle different result scenarios
      if (result.summary.total === 0) {
        toast({
          title: "Scan complete - No resources found",
          description: framework === 'kubernetes' 
            ? "Checkov did not find any Kubernetes resources to scan. Make sure your files contain valid Kubernetes YAML."
            : "Checkov did not find any Terraform resources to scan. Make sure your files contain valid Terraform resources.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Security scan complete",
          description: result.summary.passPercentage + "% of checks passed (" + result.summary.passed + "/" + result.summary.total + " total)",
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
        ? errorMessage + "\n\n" + errorDetails
        : errorMessage;
      
      toast({
        title: "Scan failed",
        description: fullErrorMessage,
        variant: "destructive",
      });
      
      // IMPORTANT: Call onScanComplete even on error to clear loading state
      onScanComplete?.(null as any);
    } finally {
      setIsScanning(false);
    }
  };

  const approveFixes = async () => {
    if (!hasUnapprovedFixes) return;
    setFixesApproved(true);
    setHasUnapprovedFixes(false);
    const diffsToReport = fileDiffs;
    setFileDiffs([]);
    await queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
    await queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
    // Notify parent for file refresh
    onFixesApproved?.(diffsToReport);
    // No re-scan — fixes are approved, mark cycle complete and let pipeline advance
    setScanCycleComplete(true);
    toast({
      title: "Fixes Approved",
      description: "Security fixes applied to your code. Complete the build when ready.",
    });
    // Signal pipeline that security is done (onScanComplete drives pipeline advancement)
    onScanComplete?.(scanResult);
  };

  useImperativeHandle(ref, () => ({
    triggerScan: runScan,
    hasUnapprovedFixes: () => hasUnapprovedFixes,
    getFixesApproved: () => fixesApproved,
    approveFixes
  }));

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

  const severityConfig: Record<string, { label: string; color: string; bg: string; border: string }> = {
    critical: { label: 'CRITICAL', color: 'text-rose-700 dark:text-rose-300', bg: 'bg-rose-100 dark:bg-rose-950', border: 'border-rose-300 dark:border-rose-700' },
    high:     { label: 'HIGH',     color: 'text-red-700 dark:text-red-300',   bg: 'bg-red-100 dark:bg-red-950',   border: 'border-red-300 dark:border-red-700' },
    medium:   { label: 'MEDIUM',   color: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-100 dark:bg-amber-950', border: 'border-amber-300 dark:border-amber-700' },
    low:      { label: 'LOW',      color: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-100 dark:bg-blue-950', border: 'border-blue-300 dark:border-blue-700' },
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
      selectedChecks.has(selectionKey(check))
    );

    setIsFixing(true);
    onFixStart?.();
    try {
      // Capture pre-fix snapshot so we can build fallback diffs
      // when backend does not return fileDiffs for some frameworks.
      const beforeFilesRes = await apiRequest('GET', `/api/sessions/${sessionId}/files`);
      const beforeFiles = await beforeFilesRes.json() as Array<{ fileName: string; content: string }>;
      const beforeByName = new Map(beforeFiles.map((f) => [f.fileName, f.content]));

      const response = await apiRequest('POST', '/api/sessions/' + sessionId + '/fix-issues', {
        failedChecks: checksToFix,
        framework: framework // Pass framework to backend
      });
      
      const result = await response.json();

      // Prefer backend-provided diffs; fallback to local snapshot comparison.
      let resolvedDiffs: Array<{ fileName: string; originalContent: string; fixedContent: string }> =
        Array.isArray(result.fileDiffs) ? result.fileDiffs : [];

      if (resolvedDiffs.length === 0 && Array.isArray(result.fixedFiles) && result.fixedFiles.length > 0) {
        try {
          const afterFilesRes = await apiRequest('GET', `/api/sessions/${sessionId}/files`);
          const afterFiles = await afterFilesRes.json() as Array<{ fileName: string; content: string }>;
          const afterByName = new Map(afterFiles.map((f) => [f.fileName, f.content]));

          resolvedDiffs = result.fixedFiles
            .map((fileName: string) => {
              const originalContent = beforeByName.get(fileName);
              const fixedContent = afterByName.get(fileName);
              if (originalContent == null || fixedContent == null || originalContent === fixedContent) {
                return null;
              }
              return { fileName, originalContent, fixedContent };
            })
            .filter((d: any) => d !== null);
        } catch (fallbackError) {
          console.warn('Could not build fallback diffs after fix:', fallbackError);
        }
      }

      if (resolvedDiffs.length > 0) {
        setFileDiffs(resolvedDiffs);
        setHasUnapprovedFixes(true);
        setFixesApproved(false);
        onFixesApplied?.(resolvedDiffs);
      } else if (Array.isArray(result.fixedFiles) && result.fixedFiles.length > 0) {
        // Even without visual diffs, still require approval so the user
        // controls when the pipeline-driving re-scan fires.
        setHasUnapprovedFixes(true);
        setFixesApproved(false);
        toast({
          title: "Fixes applied",
          description: "Changes were applied. Click 'Approve Changes' to trigger a verification re-scan.",
        });
      }
      
      // Show detailed results
      if (result.fixResults) {
        const { fixed, failed, skipped, details } = result.fixResults;
        let message = "Fixed " + fixed + " check(s)";
        if (failed > 0) {
          message += ", " + failed + " failed";
        }
        if (skipped > 0) {
          message += ", " + skipped + " skipped";
        }
        
        if (failed > 0 || skipped > 0) {
          // Show detailed error for failed/skipped checks
          const failedChecks = details.filter((d: any) => d.status === 'failed' || d.status === 'skipped');
          const failureDetails = failedChecks.map((d: any) => ({
            checkId: d.checkId || 'unknown',
            checkName: d.checkName || d.checkId || 'Unknown check',
            resource: d.resource || 'unknown',
            file: d.file || 'unknown',
            reason: d.reason || 'No reason provided',
          }));
          setLatestFixFailures(failureDetails);
          onFixResult?.({
            fixed,
            failed,
            skipped,
            failureDetails,
          });
          const failedDetails = failedChecks.map((d: any) => 
            d.checkId + ": " + d.reason
          ).join('\n');
          
          toast({
            title: "Fix completed with issues",
            description: message,
            variant: failed > 0 ? "destructive" : "default",
          });
          
          // Also log to console for debugging
          console.warn('Some checks were not fixed:', failedDetails);
        } else {
          setLatestFixFailures([]);
          onFixResult?.({
            fixed,
            failed,
            skipped,
            failureDetails: [],
          });
          toast({
            title: "Issues fixed",
            description: message,
          });
        }
      } else {
        setLatestFixFailures([]);
        toast({
          title: "Issues fixed",
          description: "Successfully fixed " + (result.fixedFiles?.length || 0) + " file(s)",
        });
      }

      // Invalidate files query to refresh the UI with updated files
      // Use a delayed, non-blocking refetch to prevent full page re-render
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      
      // Schedule refetch after a delay to avoid blocking UI update
      // This prevents the "reload" appearance while still updating files
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      }, 500); // Small delay to let UI update first

      // Track which checks were attempted to be fixed (by checkId:resource for uniqueness)
      const attemptedCheckKeys = new Set<string>();
      const keysByCheck = new Map<FailedCheck, string[]>();

      const registerCheckKeys = (check: FailedCheck) => {
        const values = Array.from(new Set(
          [
            check.resource?.trim(),
            check.file?.trim(),
          ].filter(Boolean)
        ));

        if (values.length === 0) {
          values.push('unknown');
        }

        const keys = values.map((value) => `${check.checkId}:${value}`);
        keys.forEach((key) => {
          attemptedCheckKeys.add(key);
        });

        keysByCheck.set(check, keys);
        return keys;
      };

      checksToFix.forEach(registerCheckKeys);

      const fixStatusMap = new Map<string, 'fixed' | 'failed' | 'skipped'>();
      const fixDetails = result.fixResults?.details || [];
      const createFixedCheckFromDetail = (detail: any): FixedCheck => ({
        checkId: detail.checkId || detail.checkName || "unknown",
        checkName: detail.checkName || detail.checkId || "Checkov fix",
        resource: detail.resource || detail.file || "unknown",
        file: detail.file || detail.resource || "unknown",
        fixedAt: new Date(),
        verified: detail.verified ?? detail.status === "fixed",
      });
      const createFixedCheckFromCheck = (check: FailedCheck): FixedCheck => ({
        checkId: check.checkId,
        checkName: check.checkName,
        resource: check.resource || check.file || "unknown",
        file: check.file || check.resource || "unknown",
        fixedAt: new Date(),
        verified: false,
      });
      const dedupeFixedEntries = (entries: FixedCheck[]) => {
        const seen = new Set<string>();
        return entries.filter((entry) => {
          const dedupeKey = `${entry.checkId}:${entry.resource || entry.file || 'unknown'}`;
          if (seen.has(dedupeKey)) {
            return false;
          }
          seen.add(dedupeKey);
          return true;
        });
      };
      const detailFixedEntries = dedupeFixedEntries(
        fixDetails
          .filter((detail: any) => 
            detail.status === 'fixed' ||
            detail.status === 'passed' ||
            detail.status === 'ok'
          )
          .map(createFixedCheckFromDetail)
      );

      const buildDetailKeys = (detail: any) => {
        const values = Array.from(new Set(
          [
            detail.resource?.trim(),
            detail.file?.trim(),
          ].filter(Boolean)
        ));

        if (values.length === 0) {
          values.push('unknown');
        }

        return values.map((value) => `${detail.checkId}:${value}`);
      };

      if (fixDetails.length > 0) {
        fixDetails.forEach((detail: any) => {
          const detailKeys = buildDetailKeys(detail);
          const matchedKey = detailKeys.find((key) => attemptedCheckKeys.has(key));
          const detailKey = matchedKey || detailKeys[0];
          if (detailKey) {
            fixStatusMap.set(detailKey, detail.status);
          }
        });
      } else {
        // No detailed fix results provided – assume selected checks were fixed
        checksToFix.forEach((check) => {
          const keys = keysByCheck.get(check) || [];
          if (keys.length > 0) {
            const primaryKey = keys[0];
            if (!fixStatusMap.has(primaryKey)) {
              fixStatusMap.set(primaryKey, 'fixed');
            }
          }
          if (!fixStatusMap.has(check.checkId)) {
            fixStatusMap.set(check.checkId, 'fixed');
          }
        });
      }

      // Clear selected checks after fixing
      setSelectedChecks(new Set());

      // Identify checks that were fixed based on fix result status
      const successfullyFixed: string[] = [];
      const stillFailing: string[] = [];

      const getStatusForCheck = (check: FailedCheck) => {
        const keys = keysByCheck.get(check) || [];
        for (const key of keys) {
          const status = fixStatusMap.get(key);
          if (status) {
            return { status, key };
          }
        }
        const fallbackStatus = fixStatusMap.get(check.checkId);
        if (fallbackStatus) {
          return { status: fallbackStatus, key: check.checkId };
        }
        return undefined;
      };

      checksToFix.forEach((check) => {
        const statusEntry = getStatusForCheck(check);
        if (!statusEntry) {
          return;
        }
        const { status, key } = statusEntry;
        if (status === 'fixed') {
          if (key) {
            successfullyFixed.push(key);
          }
        } else if (status === 'failed') {
          if (key) {
            stillFailing.push(key);
          }
        }
      });
      
      const successKeySet = new Set(successfullyFixed);
      const fallbackFixedEntries = dedupeFixedEntries(
        checksToFix
          .filter((check) => {
            const keys = keysByCheck.get(check) || [];
            return keys.some((key) => successKeySet.has(key))
              || successKeySet.has(check.checkId)
              || fixStatusMap.get(check.checkId) === 'fixed';
          })
          .map(createFixedCheckFromCheck)
      );
      let newlyFixedChecks = dedupeFixedEntries([...detailFixedEntries, ...fallbackFixedEntries]);

      console.log('🟢 Fixed tab entries calculated:', {
        detailCount: detailFixedEntries.length,
        fallbackCount: fallbackFixedEntries.length,
        combined: newlyFixedChecks.length,
      });

      if (newlyFixedChecks.length === 0 && checksToFix.length > 0) {
        newlyFixedChecks = dedupeFixedEntries(
          checksToFix.map(createFixedCheckFromCheck)
        );
      }

      // Add newly fixed checks to the fixed list (unverified — will be verified on re-scan after approve)
      if (newlyFixedChecks.length > 0) {
        setFixedChecks(prev => {
          const existingKeys = new Set(prev.map(f => f.checkId + ':' + f.resource));
          const uniqueNew = newlyFixedChecks.filter(f => !existingKeys.has(f.checkId + ':' + f.resource));
          console.log('🟢 Adding to Fixed tab (unverified):', uniqueNew.map((check) => `${check.checkId}:${check.resource}`));
          return [...prev, ...uniqueNew];
        });
        setActiveTab('fixed');
      }

      // Update the local failed list to remove checks that were fixed (optimistic)
      if (scanResult && successfullyFixed.length > 0) {
        const remainingFailed = scanResult.failedChecks.filter(check => {
          const checkKey = check.checkId + ':' + check.resource;
          return !successfullyFixed.includes(checkKey);
        });
        const fixedCount = successfullyFixed.length;
        const originalTotal = scanResult.summary.total || 0;
        const originalPassed = Number(scanResult.summary.passed) || 0;
        const originalSkipped = Number(scanResult.summary.skipped) || 0;
        const newPassed = originalPassed + fixedCount;
        const newFailed = remainingFailed.length;
        const newTotal = originalTotal > 0 ? originalTotal : (newPassed + newFailed + originalSkipped);
        const newPassPercentage = newTotal > 0 ? Math.round((newPassed / newTotal) * 100) : 0;

        console.log('🔄 Updated local scan result after fix (no re-scan yet):', {
          originalTotal, fixedCount, newPassed, newFailed, newTotal, passPercentage: newPassPercentage
        });

        setScanResult({
          ...scanResult,
          summary: { ...scanResult.summary, passed: newPassed, failed: newFailed, total: newTotal, passPercentage: newPassPercentage },
          failedChecks: remainingFailed
        });
      }

      // NOTE: Do NOT call onScanComplete here — that drives the pipeline.
      // The user must approve the diffs first, then approveFixes() triggers a proper re-scan
      // which calls onScanComplete and advances the pipeline.

      if (successfullyFixed.length > 0) {
        toast({
          title: "Fixes Applied",
          description: successfullyFixed.length + " check(s) fixed. Review the changes below and approve to trigger a verification re-scan.",
          variant: "default",
        });
      }

      if (stillFailing.length > 0) {
        const stillFailingMsg = stillFailing.length + " check(s) were updated but may still fail. Review and approve the changes.";
        toast({
          title: "Some Fixes Need Review",
          description: stillFailingMsg,
          variant: "destructive",
        });
        console.warn('Checks that still fail after fix:', stillFailing);
      }
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
      onFixComplete?.();
    }
  };

  return (
    <div className="w-full space-y-4">
      {/* Empty state — shown before first scan and after a failed scan */}
      {!isScanning && !scanResult && (
        <Card className="p-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <Shield className="w-10 h-10 text-muted-foreground" />
            <div>
              <h3 className="font-semibold">Security Scan</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Click the <strong>Security Scan</strong> button above to run Checkov
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => runScan()}>
              <Shield className="w-4 h-4 mr-2" />
              Run Scan
            </Button>
          </div>
        </Card>
      )}

      {/* Loading State */}
      {isScanning && !scanResult && (
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
            <div className="flex-1">
              <h3 className="font-semibold">Running Security Scan</h3>
              <p className="text-sm text-muted-foreground">Scanning generated code with Checkov...</p>
              <Progress value={undefined} className="h-2 mt-2" />
            </div>
          </div>
        </Card>
      )}
      
      {scanResult && (
        <div className="space-y-4">
          {/* Handle case when no resources were scanned */}
          {scanResult.summary.total === 0 ? (
            moduleApproach === 'aggregated-root' ? (
              <Alert className="border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <AlertTitle className="text-emerald-900 dark:text-emerald-100">Security Scan Complete — No Direct Resources</AlertTitle>
                <AlertDescription className="text-emerald-800 dark:text-emerald-200">
                  Aggregated root modules contain <code className="bg-emerald-100 dark:bg-emerald-900 px-1 rounded">module</code> calls
                  that reference child modules. Security checks are applied when each child module is built individually.
                  The root orchestration layer has no direct resources to scan.
                </AlertDescription>
              </Alert>
            ) : (
            <Alert variant="destructive">
              <AlertTriangle className="w-4 h-4" />
              <AlertTitle>No Resources Scanned</AlertTitle>
              <AlertDescription>
                {framework === 'docker' ? (
                  <>
                    Checkov did not find any Docker resources to scan. This usually means:
                    <ul className="list-disc list-inside mt-2 space-y-1">
                      <li>No Dockerfile was found</li>
                      <li>Dockerfile is empty or contains invalid syntax</li>
                      <li>Dockerfile was not generated or saved correctly</li>
                      <li>Checkov is not recognizing the Dockerfile (check server logs)</li>
                    </ul>
                    <p className="mt-2 text-sm">
                      Please ensure you have generated a Dockerfile before running the scan.
                    </p>
                  </>
                ) : framework === 'kubernetes' ? (
                  <>
                    Checkov did not find any Kubernetes resources to scan. This usually means:
                    <ul className="list-disc list-inside mt-2 space-y-1">
                      <li>No Kubernetes YAML files (.yaml, .yml) were found</li>
                      <li>Files are empty or contain invalid Kubernetes syntax</li>
                      <li>Files were not generated or saved correctly</li>
                      <li>Session contains Helm chart templates (use Kubernetes Manifests workflow for scanning)</li>
                    </ul>
                    <p className="mt-2 text-sm">
                      Please ensure you have generated Kubernetes YAML files before running the scan.
                    </p>
                  </>
                ) : (
                  <>
                    Checkov did not find any Terraform resources to scan. This usually means:
                    <ul className="list-disc list-inside mt-2 space-y-1">
                      <li>No Terraform files (.tf, .tfvars, .hcl) were found</li>
                      <li>Files are empty or contain invalid Terraform syntax</li>
                      <li>Files were not generated or saved correctly</li>
                    </ul>
                  </>
                )}
              </AlertDescription>
            </Alert>
            )
          ) : (
            <>
              {/* Before / After improvement card — shown after a re-scan following fixes */}
              {preScanResult && scanResult && preScanResult !== scanResult && (
                <div className="rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                    <h3 className="font-semibold text-emerald-900 dark:text-emerald-100">Security Scan Improvement</h3>
                  </div>
                  <div className="grid grid-cols-3 gap-4 text-center text-sm">
                    <div className="rounded-md bg-white dark:bg-zinc-800 border border-red-200 dark:border-red-800 p-3">
                      <p className="text-xs text-muted-foreground mb-1">Before Fix</p>
                      <p className="text-2xl font-bold text-red-600">{Number(preScanResult.summary?.passPercentage) || 0}%</p>
                      <p className="text-xs text-red-500">{Number(preScanResult.summary?.failed) || 0} issues</p>
                    </div>
                    <div className="flex items-center justify-center">
                      <div className="text-center">
                        <p className="text-2xl text-emerald-600">→</p>
                        <p className="text-[10px] text-muted-foreground mt-1">
                          {(() => {
                            const gain = (Number(scanResult.summary?.passPercentage) || 0) - (Number(preScanResult.summary?.passPercentage) || 0);
                            const fixed = (Number(preScanResult.summary?.failed) || 0) - (Number(scanResult.summary?.failed) || 0);
                            return `+${gain}%  ·  ${fixed} fixed`;
                          })()}
                        </p>
                      </div>
                    </div>
                    <div className="rounded-md bg-white dark:bg-zinc-800 border border-emerald-200 dark:border-emerald-800 p-3">
                      <p className="text-xs text-muted-foreground mb-1">After Fix</p>
                      <p className="text-2xl font-bold text-emerald-600">{Number(scanResult.summary?.passPercentage) || 0}%</p>
                      <p className="text-xs text-emerald-500">{Number(scanResult.summary?.failed) || 0} remaining</p>
                    </div>
                  </div>
                  {Number(scanResult.summary?.failed) > 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 text-center">
                      {Number(scanResult.summary?.failed)} issue(s) still require manual remediation
                    </p>
                  )}
                </div>
              )}

              {/* Summary Card */}
              <Alert>
                <div className="flex items-center gap-3">
                  {getStatusIcon(Number(scanResult.summary?.passPercentage) || 0)}
                  <div className="flex-1">
                    <AlertTitle className="mb-2">
                      Scan Results: {Number(scanResult.summary?.passPercentage) || 0}% Pass Rate
                    </AlertTitle>
                    <Progress 
                      value={Number(scanResult.summary?.passPercentage) || 0} 
                      className="h-2"
                      data-testid="progress-scan-percentage"
                    />
                    <div className="flex gap-4 mt-2 text-sm">
                      <span className="text-green-600">
                        ✓ {Number(scanResult.summary?.passed) || 0} passed
                      </span>
                      <span className="text-red-600">
                        ✗ {Number(scanResult.summary?.failed) || 0} failed
                      </span>
                      {(Number(scanResult.summary?.skipped) || 0) > 0 && (
                        <span className="text-muted-foreground">
                          ⊘ {Number(scanResult.summary?.skipped) || 0} skipped
                        </span>
                      )}
                      <span className="text-muted-foreground">
                        Total: {Number(scanResult.summary?.total) || 0} checks
                      </span>
                    </div>
                  </div>
                </div>
              </Alert>

              {/* Severity + Auto-fix breakdown */}
              {scanResult.failedChecks.length > 0 && (() => {
                const autoFixCount = scanResult.failedChecks.filter(c => c.autoFixable).length;
                const manualCount = scanResult.failedChecks.length - autoFixCount;
                const sevCounts: Record<string, number> = {};
                scanResult.failedChecks.forEach(c => {
                  const s = c.severity || 'medium';
                  sevCounts[s] = (sevCounts[s] || 0) + 1;
                });
                const allStandards = new Set<string>();
                scanResult.failedChecks.forEach(c => c.complianceStandards?.forEach(s => allStandards.add(s.framework)));
                return (
                  <div className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-center gap-3 flex-wrap text-xs">
                      <span className="font-semibold text-sm">Breakdown:</span>
                      {(['critical', 'high', 'medium', 'low'] as const).map(sev => {
                        const count = sevCounts[sev] || 0;
                        if (count === 0) return null;
                        const cfg = severityConfig[sev];
                        return (
                          <span key={sev} className={`px-1.5 py-0.5 rounded border font-bold ${cfg.color} ${cfg.bg} ${cfg.border}`}>
                            {count} {cfg.label}
                          </span>
                        );
                      })}
                      <span className="text-muted-foreground">|</span>
                      <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700 font-medium">
                        {autoFixCount} auto-fixable
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300 border border-orange-300 dark:border-orange-700 font-medium">
                        {manualCount} manual
                      </span>
                    </div>
                    {allStandards.size > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-muted-foreground font-medium">Standards:</span>
                        {Array.from(allStandards).sort().map(fw => (
                          <span key={fw} className="text-[10px] px-1 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 font-mono">
                            {fw}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Failed and Fixed Checks with Tabs */}
              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'failed' | 'fixed')} className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="failed" className="flex items-center gap-2">
                    <XCircle className="w-4 h-4" />
                    Failed ({scanResult.failedChecks.length})
                  </TabsTrigger>
                  <TabsTrigger value="fixed" className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" />
                    Fixed ({fixedChecks.length})
                  </TabsTrigger>
                </TabsList>
                
                <TabsContent value="failed" className="mt-4">
                  {scanResult.failedChecks.length > 0 ? (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-sm font-semibold flex items-center gap-2">
                          <XCircle className="w-4 h-4 text-red-600" />
                          {scanCycleComplete ? 'Remaining Issues (manual remediation)' : `Failed Checks (${scanResult.failedChecks.length})`}
                        </h4>
                        {!scanCycleComplete && (
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid="btn-select-all-checks"
                            onClick={() => {
                              const autoFixable = scanResult.failedChecks.filter(c => c.autoFixable);
                              if (autoFixable.length > 0) {
                                setSelectedChecks(new Set(autoFixable.map(c => selectionKey(c))));
                              } else {
                                setSelectedChecks(new Set(scanResult.failedChecks.map(c => selectionKey(c))));
                              }
                            }}
                            className="text-xs h-7"
                          >
                            {scanResult.failedChecks.some(c => c.autoFixable) ? 'Select Auto-fixable' : 'Select All'}
                          </Button>
                          {scanResult.failedChecks.some(c => c.autoFixable) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setSelectedChecks(new Set(scanResult.failedChecks.map(c => selectionKey(c))));
                              }}
                              className="text-xs h-7"
                            >
                              Select All
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelectedChecks(new Set())}
                            className="text-xs h-7"
                          >
                            Deselect All
                          </Button>
                          {selectedChecks.size > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              data-testid="btn-fix-selected"
                              onClick={fixIssues}
                              disabled={isFixing || isScanning}
                              className="text-xs h-7"
                            >
                              {isFixing ? (
                                <>
                                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                  Fixing...
                                </>
                              ) : (
                                `Fix Selected (${selectedChecks.size})`
                              )}
                            </Button>
                          )}
                        </div>
                        )}
                      </div>
                      <ScrollArea className="h-[400px] rounded-md border">
                        <div className="p-4 space-y-3">
                          {groupedChecks.map(([file, checks]) => {
                            const isExpanded = expandedModules.has(file);
                            const moduleSelected = checks.every(c => selectedChecks.has(selectionKey(c)));
                            const modulePartial = !moduleSelected && checks.some(c => selectedChecks.has(selectionKey(c)));
                            return (
                              <Card key={file} className="overflow-hidden">
                                {/* Module Header */}
                                <div
                                  className="flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                                  onClick={() => {
                                    setExpandedModules(prev => {
                                      const next = new Set(prev);
                                      if (next.has(file)) next.delete(file);
                                      else next.add(file);
                                      return next;
                                    });
                                  }}
                                >
                                  {!scanCycleComplete && (
                                  <Checkbox
                                    checked={moduleSelected ? true : modulePartial ? "indeterminate" : false}
                                    onCheckedChange={(checked) => {
                                      const newSelected = new Set(selectedChecks);
                                      checks.forEach(c => {
                                        if (checked) newSelected.add(selectionKey(c));
                                        else newSelected.delete(selectionKey(c));
                                      });
                                      setSelectedChecks(newSelected);
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                  )}
                                  {isExpanded ? (
                                    <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                  ) : (
                                    <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                  )}
                                  <span className="text-sm font-medium font-mono flex-1 truncate">{file}</span>
                                  <Badge variant="destructive" className="text-xs flex-shrink-0">
                                    {checks.length} failed
                                  </Badge>
                                </div>
                                {/* Expanded Check List */}
                                {isExpanded && (
                                  <div className="border-t">
                                    <div className="divide-y">
                                      {checks.map((check, idx) => {
                                        const isSelected = selectedChecks.has(selectionKey(check));
                                        const sev = check.severity ? severityConfig[check.severity] : null;
                                        return (
                                          <div
                                            key={idx}
                                            className={"p-3 " + (isSelected ? 'bg-blue-50 dark:bg-blue-950' : '')}
                                          >
                                            <div className="flex items-start gap-3">
                                              {!scanCycleComplete && (
                                              <Checkbox
                                                checked={isSelected}
                                                onCheckedChange={(checked) => {
                                                  const newSelected = new Set(selectedChecks);
                                                  if (checked) newSelected.add(selectionKey(check));
                                                  else newSelected.delete(selectionKey(check));
                                                  setSelectedChecks(newSelected);
                                                }}
                                                className="mt-0.5"
                                              />
                                              )}
                                              <div className="flex-1 min-w-0">
                                                <div className="flex items-start justify-between gap-2">
                                                  <p className="font-medium text-sm">{check.checkName}</p>
                                                  <div className="flex items-center gap-1.5 flex-shrink-0">
                                                    {sev && (
                                                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${sev.color} ${sev.bg} ${sev.border}`}>
                                                        {sev.label}
                                                      </span>
                                                    )}
                                                    <Badge variant="destructive" className="text-xs">
                                                      {check.checkId}
                                                    </Badge>
                                                  </div>
                                                </div>
                                                <p className="text-xs text-muted-foreground font-mono mt-0.5">
                                                  {check.resource}
                                                </p>
                                                {/* Auto-fix vs Manual label */}
                                                <div className="flex items-center gap-1.5 mt-1">
                                                  {check.autoFixable ? (
                                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700">
                                                      Auto-fixable
                                                    </span>
                                                  ) : (
                                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300 border border-orange-300 dark:border-orange-700">
                                                      Manual fix {check.fixComplexity ? `(${check.fixComplexity})` : ''}
                                                    </span>
                                                  )}
                                                </div>
                                                {/* Compliance standards */}
                                                {check.complianceStandards && check.complianceStandards.length > 0 && (
                                                  <div className="flex flex-wrap gap-1 mt-1.5">
                                                    {check.complianceStandards.map((std, si) => (
                                                      <span key={si} className="text-[9px] px-1 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 font-mono">
                                                        {std.framework} {std.control}
                                                      </span>
                                                    ))}
                                                  </div>
                                                )}
                                                {check.reason && (
                                                  <div className="text-xs mt-2 p-2 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded">
                                                    <p className="font-semibold text-red-700 dark:text-red-400 mb-1">
                                                      Why this failed:
                                                    </p>
                                                    <p className="text-red-600 dark:text-red-300">
                                                      {check.reason}
                                                    </p>
                                                    {check.evaluatedKeys && check.evaluatedKeys.length > 0 && (
                                                      <p className="text-red-500 dark:text-red-400 mt-1 text-xs">
                                                        Missing attributes: {check.evaluatedKeys.join(', ')}
                                                      </p>
                                                    )}
                                                  </div>
                                                )}
                                                {check.guideline && !check.reason && (
                                                  <p className="text-xs text-muted-foreground border-l-2 border-muted pl-2 mt-2">
                                                    {check.guideline}
                                                  </p>
                                                )}
                                              </div>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
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
                        No security issues were found. Your {framework === 'kubernetes' ? 'Kubernetes' : 'Terraform'} code passed all {scanResult.summary.total} security checks.
                      </AlertDescription>
                    </Alert>
                  )}
                </TabsContent>
                
                <TabsContent value="fixed" className="mt-4">
                  {fixedChecks.length > 0 ? (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-sm font-semibold flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 text-green-600" />
                          Fixed Checks ({fixedChecks.length})
                        </h4>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setFixedChecks([]);
                            toast({
                              title: "Fixed checks cleared",
                              description: "The fixed checks list has been cleared.",
                            });
                          }}
                          className="text-xs h-7"
                        >
                          Clear All
                        </Button>
                      </div>
                      <ScrollArea className="h-[400px] rounded-md border">
                        <div className="p-4 space-y-3">
                          {groupedFixedChecks.map(([file, checks]) => {
                            const isExpanded = expandedModules.has('fixed:' + file);
                            const verifiedCount = checks.filter(c => c.verified).length;
                            return (
                              <Card key={file} className="border-green-200 dark:border-green-800 overflow-hidden">
                                {/* Module Header */}
                                <div
                                  className="flex items-center gap-3 p-3 cursor-pointer hover:bg-green-50 dark:hover:bg-green-950/50 transition-colors"
                                  onClick={() => {
                                    setExpandedModules(prev => {
                                      const next = new Set(prev);
                                      const key = 'fixed:' + file;
                                      if (next.has(key)) next.delete(key);
                                      else next.add(key);
                                      return next;
                                    });
                                  }}
                                >
                                  <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                                  {isExpanded ? (
                                    <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                  ) : (
                                    <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                  )}
                                  <span className="text-sm font-medium font-mono flex-1 truncate">{file}</span>
                                  <div className="flex items-center gap-2 flex-shrink-0">
                                    <Badge variant="outline" className="text-xs border-green-600 text-green-700 dark:text-green-400">
                                      {checks.length} fixed
                                    </Badge>
                                    {verifiedCount > 0 && (
                                      <Badge variant="outline" className="text-xs border-green-600 text-green-700 dark:text-green-400">
                                        {verifiedCount} verified
                                      </Badge>
                                    )}
                                  </div>
                                </div>
                                {/* Expanded Check List */}
                                {isExpanded && (
                                  <div className="border-t border-green-200 dark:border-green-800">
                                    <div className="divide-y divide-green-100 dark:divide-green-900">
                                      {checks.map((check, idx) => (
                                        <div
                                          key={idx}
                                          className="p-3 bg-green-50 dark:bg-green-950"
                                        >
                                          <div className="flex items-start gap-3">
                                            <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                                            <div className="flex-1 min-w-0">
                                              <div className="flex items-start justify-between gap-2">
                                                <p className="font-medium text-sm">{check.checkName}</p>
                                                <Badge variant="outline" className="text-xs border-green-600 text-green-700 dark:text-green-400 flex-shrink-0">
                                                  {check.checkId}
                                                </Badge>
                                              </div>
                                              <p className="text-xs text-muted-foreground font-mono mt-0.5">
                                                {check.resource}
                                              </p>
                                              <div className="flex items-center gap-2 mt-1.5">
                                                {check.verified && (
                                                  <Badge variant="outline" className="text-xs border-green-600 text-green-700 dark:text-green-400">
                                                    Verified
                                                  </Badge>
                                                )}
                                                <span className="text-xs text-muted-foreground">
                                                  Fixed: {check.fixedAt.toLocaleTimeString()}
                                                </span>
                                              </div>
                                            </div>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </Card>
                            );
                          })}
                        </div>
                      </ScrollArea>
                    </div>
                  ) : (
                    <Alert>
                      <AlertTriangle className="w-4 h-4" />
                      <AlertTitle>No Fixed Checks Yet</AlertTitle>
                      <AlertDescription>
                        Fixed checks will appear here after you successfully fix and verify them. Select failed checks and click "Fix Selected" to get started.
                      </AlertDescription>
                    </Alert>
                  )}
                </TabsContent>
              </Tabs>

              {/* File Diffs and Approval Section */}
      {showDiffView && hasUnapprovedFixes && fileDiffs.length > 0 && (
                <div className="border-2 border-yellow-500 rounded-lg p-4 bg-yellow-50 dark:bg-yellow-950">
                  <Card className="p-4 bg-background">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="font-semibold text-lg mb-1">Code Changes Require Approval</h3>
                        <p className="text-sm text-muted-foreground">
                          Review the changes made to fix security issues before approving
                        </p>
                      </div>
                      {fixesApproved && (
                        <Badge className="bg-green-600">
                          <CheckCircle className="w-3 h-3 mr-1" />
                          Approved
                        </Badge>
                      )}
                    </div>
                    
                    <FileDiffView diffs={fileDiffs} />
                    
                        {!fixesApproved && (
                          <div className="mt-4 flex gap-2">
                            <Button
                              data-testid="btn-approve-changes"
                              onClick={() => {
                                void approveFixes();
                              }}
                              className="flex-1"
                              variant="default"
                            >
                              <CheckCircle className="w-4 h-4 mr-2" />
                              Approve Changes
                            </Button>
                            <Button
                              onClick={() => {
                                // Revert changes - reload original files
                                setFileDiffs([]);
                                setHasUnapprovedFixes(false);
                                setFixesApproved(false);
                                queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                                toast({
                                  title: "Changes Reverted",
                                  description: "Original files restored. You can fix issues again if needed.",
                                });
                              }}
                              variant="outline"
                            >
                              Revert Changes
                            </Button>
                          </div>
                        )}
                  </Card>
                </div>
              )}

              {/* Explicit reasons for failed/skipped fixes */}
              {latestFixFailures.length > 0 && (
                <Card className="p-4 border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30">
                  <h3 className="font-semibold text-sm mb-2">Fixes Requiring Manual Review</h3>
                  <p className="text-xs text-muted-foreground mb-3">
                    Some checks were not auto-fixed. Reasons are listed below.
                  </p>
                  <div className="space-y-2">
                    {latestFixFailures.map((item, idx) => (
                      <div key={`${item.checkId}-${idx}`} className="rounded border border-red-200 dark:border-red-800 p-2 bg-background">
                        <div className="text-xs font-medium">
                          {item.checkId} - {item.checkName}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {item.file} • {item.resource}
                        </div>
                        <div className="text-xs mt-1 text-red-700 dark:text-red-300">
                          {item.reason}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
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
                          data-testid={"passed-check-" + idx}
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
        </div>
      )}
    </div>
  );
});

CheckovScanner.displayName = 'CheckovScanner';

export default CheckovScanner;