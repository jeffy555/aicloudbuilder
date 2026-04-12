import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GitHubLogoIcon } from '@radix-ui/react-icons';
import {
  CheckCircle2,
  ChevronDown,
  Clock3,
  ExternalLink,
  Loader2,
  PlayCircle,
  Wrench,
} from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';

export interface TerraformModuleCicdCardProps {
  sessionId: string;
  /** Payload from POST /api/sessions/:id/commit `cicd` field */
  cicdInfo: Record<string, unknown> | null;
  expectedHeadSha: string | null;
  onMergeCicdInfo: (patch: Record<string, unknown>) => void;
}

/**
 * Post-commit GitHub Actions validation for Terraform root modules (standalone-root / aggregated-root).
 * Reuses /api/migrate/cicd/* endpoints (same as MigrateOps) — server selects terraform-module-* workflows.
 */
export function TerraformModuleCicdCard({
  sessionId,
  cicdInfo,
  expectedHeadSha,
  onMergeCicdInfo,
}: TerraformModuleCicdCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [cicdRunStatus, setCicdRunStatus] = useState<any>(null);
  const [cicdPreflight, setCicdPreflight] = useState<any>(null);
  const [planLogs, setPlanLogs] = useState('');
  const [autoFetchedPlanForRunId, setAutoFetchedPlanForRunId] = useState<number | null>(null);
  const [isCheckingPreflight, setIsCheckingPreflight] = useState(false);
  const [isLoadingPlanLogs, setIsLoadingPlanLogs] = useState(false);
  const [isTriggeringApply, setIsTriggeringApply] = useState(false);
  const [isRepairingCi, setIsRepairingCi] = useState(false);

  const validateWorkflowRunId = (cicdInfo?.validateRunId ?? cicdInfo?.runId ?? null) as number | null;

  const polledRunHeadSha =
    (cicdRunStatus?.run?.headSha ?? cicdRunStatus?.run?.head_sha ?? null) as string | null;
  const ciRunBelongsToLatestCommit =
    !expectedHeadSha || !polledRunHeadSha || polledRunHeadSha === expectedHeadSha;

  const validateRunFailed =
    ciRunBelongsToLatestCommit &&
    (cicdRunStatus?.run?.conclusion === 'failure' ||
      (Array.isArray(cicdRunStatus?.jobs) &&
        cicdRunStatus.jobs.some((j: { conclusion?: string }) => j.conclusion === 'failure')));

  const ciWorkflowInProgress =
    Boolean(cicdInfo?.provider === 'github') &&
    Boolean(validateWorkflowRunId) &&
    (!cicdRunStatus?.run || cicdRunStatus.run.status !== 'completed');

  /** On validate failure, fetch plan logs once for context */
  useEffect(() => {
    const runId = Number(validateWorkflowRunId || 0);
    if (!sessionId || !runId) return;
    if (!ciRunBelongsToLatestCommit) return;
    if (cicdRunStatus?.run?.status !== 'completed') return;
    if (cicdRunStatus?.run?.conclusion !== 'failure') return;
    if (autoFetchedPlanForRunId === runId) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await apiRequest(
          'GET',
          `/api/migrate/cicd/plan-logs?sessionId=${sessionId}&runId=${runId}`
        );
        const data = await res.json();
        if (cancelled || !data?.logs) return;
        setPlanLogs(data.logs);
        setAutoFetchedPlanForRunId(runId);
      } catch {
        // User can still use "View plan logs" manually
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    sessionId,
    validateWorkflowRunId,
    cicdRunStatus?.run?.status,
    cicdRunStatus?.run?.conclusion,
    ciRunBelongsToLatestCommit,
    autoFetchedPlanForRunId,
  ]);

  /** Poll workflow run status */
  useEffect(() => {
    const runId = Number(validateWorkflowRunId || 0);
    if (!sessionId || !runId) return;

    let active = true;
    const pull = async () => {
      try {
        const res = await apiRequest(
          'GET',
          `/api/migrate/cicd/run-status?sessionId=${sessionId}&runId=${runId}`
        );
        const data = await res.json();
        if (!active) return;
        const rh = data?.run?.headSha ?? data?.run?.head_sha;
        if (expectedHeadSha && rh && String(rh) !== expectedHeadSha) {
          return;
        }
        setCicdRunStatus(data);
      } catch {
        // Keep UI resilient if polling intermittently fails
      }
    };

    void pull();
    const id = setInterval(() => {
      void pull();
    }, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [validateWorkflowRunId, sessionId, expectedHeadSha]);

  /** Auto pre-flight after commit */
  useEffect(() => {
    if (!sessionId) return;

    let active = true;
    const runPreflight = async () => {
      setIsCheckingPreflight(true);
      try {
        const res = await apiRequest('GET', `/api/migrate/cicd/preflight?sessionId=${sessionId}`);
        const data = await res.json();
        if (!active) return;
        setCicdPreflight(data);
      } catch (err: any) {
        if (!active) return;
        setCicdPreflight(null);
        toast({
          title: 'Pre-flight check failed',
          description: err?.message || 'Could not run CI/CD pre-flight checks.',
          variant: 'destructive',
        });
      } finally {
        if (active) setIsCheckingPreflight(false);
      }
    };

    void runPreflight();
    return () => {
      active = false;
    };
  }, [sessionId, toast]);

  if (!cicdInfo || cicdInfo.provider !== 'github') {
    return null;
  }

  const validateUrl = (cicdInfo.validateRunUrl || cicdInfo.runUrl) as string | undefined;

  return (
    <Card className="border-border/80 shadow-sm w-full max-w-3xl">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-lg font-semibold tracking-tight">CI/CD validation (Terraform)</CardTitle>
            <CardDescription className="text-sm mt-1 max-w-2xl">
              GitHub Actions runs <code className="text-xs rounded bg-muted px-1 py-0.5">terraform plan</code> on
              push. If validation fails, use <strong>Review and Fix</strong> with plan logs, commit again, then
              start apply when ready (approval may be required in GitHub).
            </CardDescription>
          </div>
          {validateUrl ? (
            <Button variant="secondary" size="sm" className="shrink-0 gap-1.5" asChild>
              <a href={validateUrl} target="_blank" rel="noreferrer">
                <GitHubLogoIcon className="h-4 w-4" />
                Open validate run
                <ExternalLink className="h-3.5 w-3.5 opacity-70" />
              </a>
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div
          className={`rounded-xl border px-4 py-3 ${
            validateRunFailed
              ? 'border-destructive/40 bg-destructive/5'
              : ciWorkflowInProgress && ciRunBelongsToLatestCommit
                ? 'border-primary/30 bg-primary/5'
                : ciRunBelongsToLatestCommit && cicdRunStatus?.run?.conclusion === 'success'
                  ? 'border-emerald-500/35 bg-emerald-500/5'
                  : 'border-border bg-muted/30'
          }`}
        >
          {ciWorkflowInProgress && ciRunBelongsToLatestCommit ? (
            <div className="flex gap-3">
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">Validation running in GitHub</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Terraform plan is executing for this commit. Use plan logs below if something fails.
                </p>
              </div>
            </div>
          ) : validateRunFailed ? (
            <div className="flex gap-3">
              <Clock3 className="h-5 w-5 shrink-0 text-destructive mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">Validate workflow failed</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {planLogs
                    ? 'Plan logs are below. Use Review and Fix for AI-assisted changes, or edit locally and commit again.'
                    : 'Use View plan logs or wait for auto-fetch, then Review and Fix.'}
                </p>
              </div>
            </div>
          ) : ciRunBelongsToLatestCommit && cicdRunStatus?.run?.conclusion === 'success' ? (
            <div className="flex gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-500 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">Plan succeeded in CI</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  You can start the apply workflow in GitHub when ready.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex gap-3">
              <Clock3 className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">Waiting for validate run</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Status updates every few seconds when GitHub reports the workflow for your commit.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pre-flight</span>
            {isCheckingPreflight ? (
              <Badge variant="outline" className="gap-1 font-normal">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking…
              </Badge>
            ) : cicdPreflight?.ready ? (
              <Badge className="bg-emerald-600/90 hover:bg-emerald-600 text-white border-0 gap-1 font-normal">
                <CheckCircle2 className="h-3 w-3" />
                All checks passed
              </Badge>
            ) : cicdPreflight ? (
              <Badge variant="destructive" className="font-normal">
                Action required
              </Badge>
            ) : (
              <Badge variant="secondary" className="font-normal text-muted-foreground">
                Not run yet
              </Badge>
            )}
          </div>
          {Array.isArray(cicdPreflight?.issues) && cicdPreflight.issues.length > 0 ? (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{cicdPreflight.issues.join(' ')}</AlertDescription>
            </Alert>
          ) : null}
          <Collapsible defaultOpen={Boolean(cicdPreflight && !cicdPreflight.ready)}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors [&[data-state=open]>svg]:rotate-180">
              <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform" />
              {cicdPreflight?.ready ? 'View checklist' : 'Connection checklist'}
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <ul className="rounded-lg border bg-muted/20 divide-y divide-border/60 text-xs">
                {(
                  [
                    ['GitHub credentials', cicdPreflight?.checks?.githubCredentials],
                    ['Repository resolved', cicdPreflight?.checks?.repositoryResolved],
                    ['Validate workflow file', cicdPreflight?.checks?.validateWorkflowPresent],
                    ['Azure credentials', cicdPreflight?.checks?.azureCredentialsAvailable],
                    ['GitHub secret write access', cicdPreflight?.checks?.githubSecretsWritable],
                  ] as const
                ).map(([label, passed], idx) => (
                  <li key={String(label)} className="flex items-center justify-between gap-4 px-3 py-2">
                    <span className="text-muted-foreground">{label}</span>
                    <span
                      className={
                        passed
                          ? 'text-emerald-600 dark:text-emerald-500 font-medium'
                          : 'text-amber-700 font-medium'
                      }
                    >
                      {passed ? 'OK' : idx === 4 ? 'Denied' : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <Separator />

        {(cicdRunStatus?.run ||
          (Array.isArray(cicdRunStatus?.jobs) && cicdRunStatus.jobs.length > 0) ||
          (Array.isArray(cicdRunStatus?.artifacts) && cicdRunStatus.artifacts.length > 0)) && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
              GitHub Actions
            </p>
            <div className="rounded-lg border bg-card divide-y divide-border/80 text-xs">
              {cicdRunStatus?.run ? (
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <span className="text-muted-foreground">Workflow run</span>
                  <span className="font-medium tabular-nums">
                    {cicdRunStatus.run.status}
                    {cicdRunStatus.run.conclusion ? (
                      <span className="text-muted-foreground font-normal">
                        {' '}
                        · {cicdRunStatus.run.conclusion}
                      </span>
                    ) : null}
                  </span>
                </div>
              ) : null}
              {Array.isArray(cicdRunStatus?.jobs) &&
                cicdRunStatus.jobs.map((job: any) => (
                  <div
                    key={job.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                  >
                    <span className="text-muted-foreground truncate max-w-[65%]">{job.name}</span>
                    <span className="font-medium shrink-0">
                      {job.status}
                      {job.conclusion ? (
                        <span className="text-muted-foreground font-normal"> · {job.conclusion}</span>
                      ) : null}
                    </span>
                  </div>
                ))}
              {Array.isArray(cicdRunStatus?.artifacts) && cicdRunStatus.artifacts.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <span className="text-muted-foreground">Artifacts</span>
                  <span className="font-medium text-right">
                    {cicdRunStatus.artifacts.map((a: any) => a.name).join(', ')}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {cicdInfo?.applyRunUrl ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" className="h-auto p-0 text-xs" asChild>
              <a href={String(cicdInfo.applyRunUrl)} target="_blank" rel="noreferrer">
                Open apply workflow run <ExternalLink className="inline h-3 w-3 ml-0.5" />
              </a>
            </Button>
          </div>
        ) : null}

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Actions</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={isCheckingPreflight || !sessionId}
              onClick={async () => {
                if (!sessionId) return;
                setIsCheckingPreflight(true);
                try {
                  const res = await apiRequest('GET', `/api/migrate/cicd/preflight?sessionId=${sessionId}`);
                  const data = await res.json();
                  setCicdPreflight(data);
                  toast({
                    title: data?.ready ? 'Pre-flight ready' : 'Pre-flight needs attention',
                    description: data?.ready
                      ? 'All checks passed for CI/CD.'
                      : Array.isArray(data?.issues)
                        ? data.issues.join(' ')
                        : 'Please fix pre-flight issues.',
                    variant: data?.ready ? 'default' : 'destructive',
                  });
                } catch (err: any) {
                  toast({
                    title: 'Pre-flight check failed',
                    description: err?.message || 'Could not run pre-flight checks.',
                    variant: 'destructive',
                  });
                } finally {
                  setIsCheckingPreflight(false);
                }
              }}
            >
              {isCheckingPreflight ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
              Run pre-flight
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isLoadingPlanLogs || !sessionId || !validateWorkflowRunId}
              onClick={async () => {
                if (!sessionId || !validateWorkflowRunId) return;
                setIsLoadingPlanLogs(true);
                try {
                  const res = await apiRequest(
                    'GET',
                    `/api/migrate/cicd/plan-logs?sessionId=${sessionId}&runId=${validateWorkflowRunId}`
                  );
                  const data = await res.json();
                  if (data?.ready === false || !data?.logs) {
                    toast({
                      title: 'Plan logs pending',
                      description:
                        data?.error || 'Validate job is still starting. Retry in a few seconds.',
                    });
                  } else {
                    setPlanLogs(data.logs || '');
                    toast({
                      title: 'Plan logs loaded',
                      description: data?.truncated
                        ? 'Showing latest part of Terraform plan logs.'
                        : 'Terraform plan logs loaded.',
                    });
                  }
                } catch (err: any) {
                  toast({
                    title: 'Plan logs failed',
                    description: err.message || 'Could not load Terraform plan logs yet.',
                    variant: 'destructive',
                  });
                } finally {
                  setIsLoadingPlanLogs(false);
                }
              }}
            >
              {isLoadingPlanLogs ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
              View plan logs
            </Button>
            {validateRunFailed && ciRunBelongsToLatestCommit ? (
              <Button
                size="sm"
                variant="secondary"
                className="gap-1.5"
                disabled={isRepairingCi || !sessionId}
                data-testid="terraform-cicd-review-and-fix"
                onClick={async () => {
                  if (!sessionId) return;
                  setIsRepairingCi(true);
                  try {
                    let logs = planLogs;
                    if (!logs.trim() && validateWorkflowRunId) {
                      const res = await apiRequest(
                        'GET',
                        `/api/migrate/cicd/plan-logs?sessionId=${sessionId}&runId=${validateWorkflowRunId}`
                      );
                      const data = await res.json();
                      if (data?.logs) {
                        logs = data.logs;
                        setPlanLogs(logs);
                      }
                    }
                    if (!logs.trim()) {
                      toast({
                        title: 'No plan logs yet',
                        description: 'Click “View plan logs” first, or wait a few seconds for GitHub to finish.',
                        variant: 'destructive',
                      });
                      return;
                    }
                    const res = await apiRequest('POST', `/api/sessions/${sessionId}/terraform-cicd-repair`, {
                      planLogs: logs,
                    });
                    const data = await res.json();
                    if (!res.ok) {
                      throw new Error(data.error || 'Repair failed');
                    }
                    await queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                    await queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
                    toast({
                      title: 'Terraform updated',
                      description:
                        data.message ||
                        'Commit your changes again to re-run GitHub validation.',
                    });
                  } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    toast({
                      title: 'Review and Fix failed',
                      description: message || 'Could not apply AI repair.',
                      variant: 'destructive',
                    });
                  } finally {
                    setIsRepairingCi(false);
                  }
                }}
              >
                {isRepairingCi ? (
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                ) : (
                  <Wrench className="w-4 h-4" />
                )}
                Review and Fix
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="default"
              className="gap-1.5"
              disabled={isTriggeringApply || !sessionId}
              onClick={async () => {
                if (!sessionId) return;
                setIsTriggeringApply(true);
                try {
                  const res = await apiRequest('POST', '/api/migrate/cicd/start-apply', { sessionId });
                  const data = await res.json();
                  onMergeCicdInfo({
                    applyRunId: data.runId ?? null,
                    applyRunUrl: data.runUrl ?? null,
                    applyWorkflow: data.workflow,
                    applyStatus: data.status,
                  });
                  toast({
                    title: 'Workflow started',
                    description:
                      'Apply workflow dispatched. Approve in the GitHub environment when ready; plan output is from the validate workflow.',
                  });
                } catch (err: any) {
                  toast({
                    title: 'Start workflow failed',
                    description: err.message || 'Could not start the apply workflow.',
                    variant: 'destructive',
                  });
                } finally {
                  setIsTriggeringApply(false);
                }
              }}
            >
              <PlayCircle className="w-4 h-4" />
              Start apply workflow
            </Button>
          </div>
        </div>

        {planLogs ? (
          <div className="rounded-xl border bg-muted/25 overflow-hidden">
            <div className="px-3 py-2 border-b bg-muted/40 text-xs font-medium">Terraform plan logs</div>
            <pre className="text-[11px] whitespace-pre-wrap break-words max-h-72 overflow-auto p-3 font-mono leading-relaxed">
              {planLogs}
            </pre>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
