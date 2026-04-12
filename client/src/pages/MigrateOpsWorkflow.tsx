import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import Header from "@/components/Header";
import ProviderCard from "@/components/ProviderCard";
import RepositoryList from "@/components/RepositoryList";
import CreateRepoForm from "@/components/CreateRepoForm";
import StepIndicator from "@/components/StepIndicator";
import ActivityPanel from "@/components/ActivityPanel";
import CodeEditor from "@/components/CodeEditor";
import { Cloud, Package, CheckCircle2, ChevronRight, ChevronDown, Loader2, ArrowRight, FileCode, Hash, Box, Clock3, ExternalLink, PlayCircle, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import type { Session, Repository } from "@shared/schema";

import { GitHubLogoIcon } from "@radix-ui/react-icons";

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type Provider = 'github' | 'azure' | null;
type CloudProvider = 'azure' | null;

interface ExtendedSession extends Session {
  terraformFiles?: any[];
}

function buildMigrateCiFiles(provider: Provider): Array<{ path: string; content: string }> {
  if (provider === 'github') {
    return [
      {
        path: '.github/workflows/migrateops-validate.yml',
        content: `name: MigrateOps Validate Migration

on:
  push:
    branches: [main, master]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

jobs:
  validate-migration:
    name: Validate the Migration
    runs-on: ubuntu-latest
    env:
      TF_IN_AUTOMATION: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - name: Terraform Init
        run: terraform init -input=false
      - name: Terraform Plan
        run: terraform plan -input=false -out=tfplan -detailed-exitcode
`,
      },
      {
        path: '.github/workflows/migrateops-apply.yml',
        content: `name: MigrateOps Apply Migration

on:
  workflow_dispatch:

jobs:
  validate-migration:
    name: Validate the Migration
    runs-on: ubuntu-latest
    env:
      TF_IN_AUTOMATION: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - name: Terraform Init
        run: terraform init -input=false
      - name: Terraform Plan
        run: terraform plan -input=false -out=tfplan

  apply-migration:
    name: Apply Migration (Approval Required)
    needs: validate-migration
    runs-on: ubuntu-latest
    environment: migrateops-apply
    env:
      TF_IN_AUTOMATION: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - name: Terraform Init
        run: terraform init -input=false
      - name: Terraform Apply
        run: terraform apply -input=false -auto-approve tfplan
`,
      },
    ];
  }

  if (provider === 'azure') {
    return [
      {
        path: 'azure-pipelines.yml',
        content: `trigger:
  branches:
    include:
      - main

stages:
  - stage: ValidateMigration
    displayName: Validate the Migration
    jobs:
      - job: TerraformPlan
        pool:
          vmImage: ubuntu-latest
        steps:
          - checkout: self
          - script: terraform init -input=false
            displayName: Terraform Init
          - script: terraform plan -input=false -out=tfplan
            displayName: Terraform Plan

  - stage: AwaitApproval
    displayName: Approval Gate
    dependsOn: ValidateMigration
    jobs:
      - job: ManualApproval
        pool: server
        steps:
          - task: ManualValidation@0
            inputs:
              instructions: 'Review tfplan and approve apply.'
              onTimeout: 'reject'
`,
      },
    ];
  }

  return [];
}

/**
 * Merge Terraform file lists for pre-commit sync.
 * - **Server wins**: use after CI repair when React state may still be stale (`allowRepeatCommit`).
 * - **Client wins**: default for first commit / editor-driven changes so local edits are not overwritten.
 */
function mergeTerraformFilesPreferServer(
  server: Array<{ path?: string; fileName?: string; content?: string }>,
  client: Array<{ path: string; content: string }>
): Array<{ path: string; content: string }> {
  const serverMap = new Map<string, string>();
  for (const f of server) {
    const p = String(f.path || f.fileName || '').trim();
    if (p && typeof f.content === 'string') serverMap.set(p, f.content);
  }
  const clientMap = new Map(client.map((f) => [f.path, f.content]));
  const paths = new Set<string>([...serverMap.keys(), ...clientMap.keys()]);
  const out: Array<{ path: string; content: string }> = [];
  for (const path of paths) {
    const fromServer = serverMap.get(path);
    const fromClient = clientMap.get(path);
    const content = fromServer !== undefined ? fromServer : fromClient ?? '';
    out.push({ path, content });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function mergeTerraformFilesPreferClient(
  server: Array<{ path?: string; fileName?: string; content?: string }>,
  client: Array<{ path: string; content: string }>
): Array<{ path: string; content: string }> {
  const serverMap = new Map<string, string>();
  for (const f of server) {
    const p = String(f.path || f.fileName || '').trim();
    if (p && typeof f.content === 'string') serverMap.set(p, f.content);
  }
  const clientMap = new Map(client.map((f) => [f.path, f.content]));
  const paths = new Set<string>([...serverMap.keys(), ...clientMap.keys()]);
  const out: Array<{ path: string; content: string }> = [];
  for (const path of paths) {
    const fromClient = clientMap.get(path);
    const fromServer = serverMap.get(path);
    const content = fromClient !== undefined ? fromClient : fromServer ?? '';
    out.push({ path, content });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export default function MigrateOpsWorkflow() {
  const { toast } = useToast();
  const [sessionId, setSessionId] = useState<string>('');
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [hasInitialized, setHasInitialized] = useState(false);
  
  // State
  const [provider, setProvider] = useState<Provider>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>(null);
  const [resourceGroups, setResourceGroups] = useState<any[]>([]);
  const [selectedResourceGroup, setSelectedResourceGroup] = useState<string>('');
  
  const [isExtracting, setIsExtracting] = useState(false);
  const [isCommitted, setIsCommitted] = useState(false);
  /** After CI repair or manual edits, allow pushing another commit while isCommitted is true. */
  const [allowRepeatCommit, setAllowRepeatCommit] = useState(false);
  
  const [activityViewMode, setActivityViewMode] = useState<'overview' | 'build' | 'code'>('overview');
  const [buildAutoRun, setBuildAutoRun] = useState(false);
  const [pipelineCompleted, setPipelineCompleted] = useState(false);
  const [cicdInfo, setCicdInfo] = useState<any>(null);
  const [cicdRunStatus, setCicdRunStatus] = useState<any>(null);
  const [cicdPreflight, setCicdPreflight] = useState<any>(null);
  const [isCheckingPreflight, setIsCheckingPreflight] = useState(false);
  const [planLogs, setPlanLogs] = useState<string>('');
  const [isLoadingPlanLogs, setIsLoadingPlanLogs] = useState(false);
  const [autoFetchedPlanForRunId, setAutoFetchedPlanForRunId] = useState<number | null>(null);
  /** Git SHA from last push; ignore workflow poll results from older runs */
  const [expectedWorkflowHeadSha, setExpectedWorkflowHeadSha] = useState<string | null>(null);
  const [isTriggeringApply, setIsTriggeringApply] = useState(false);
  const [backendResourceGroup, setBackendResourceGroup] = useState<string>('');
  const [backendStorageAccount, setBackendStorageAccount] = useState<string>('');
  const [backendContainer, setBackendContainer] = useState<string>('tfstate');
  const [backendConfigured, setBackendConfigured] = useState<boolean>(false);

  // Workflow Notice
  const [workflowNotice, setWorkflowNotice] = useState<{ tone: 'info' | 'success'; text: string } | null>(null);

  const steps = [
    { number: 1, title: 'Provider' },
    { number: 2, title: 'Repository' },
    { number: 3, title: 'Cloud Provider' },
    { number: 4, title: 'Target' },
    { number: 5, title: 'Extract' },
    { number: 6, title: 'Backend' },
    { number: 7, title: 'Build' },
    { number: 8, title: 'Commit' },
  ];

  // Initialize Session
  useEffect(() => {
    const initializeSession = async () => {
      try {
        const response = await apiRequest('POST', '/api/sessions', {
          title: `MigrateOps Session ${new Date().toLocaleDateString()}`,
          moduleType: 'migrateops'
        });
        const session = await response.json() as Session;
        try {
          await apiRequest('PATCH', `/api/sessions/${session.id}`, {
            activeModule: 'migrateops',
          });
        } catch (e) {
          console.warn('Could not tag session as migrateops:', e);
        }
        setSessionId(session.id);
        setHasInitialized(true);
      } catch (error) {
        console.error('Failed to create session:', error);
        toast({
          title: "Session Error",
          description: "Could not create a new MigrateOps session.",
          variant: "destructive"
        });
      }
    };

    if (!hasInitialized) {
      initializeSession();
    }
  }, [hasInitialized, toast]);

  const [terraformFiles, setTerraformFiles] = useState<any[]>([]);

  // Fetch Session data
  const { data: session } = useQuery<ExtendedSession>({
    queryKey: ['/api/sessions', sessionId],
    enabled: !!sessionId,
  });

  // When session updates, sync files only when the server has content.
  // After commit, the server clears file storage []; empty [] is truthy and would wipe UI state needed for CI repair + re-commit.
  useEffect(() => {
    if (!session) return;
    const tf = (session as any).terraformFiles;
    if (Array.isArray(tf) && tf.length > 0) {
      setTerraformFiles(tf);
    }
    if (session.backendValidated === 'true') setBackendConfigured(true);
    if (session.backendResourceGroup) setBackendResourceGroup(session.backendResourceGroup);
    if (session.backendStorageAccount) setBackendStorageAccount(session.backendStorageAccount);
    if (session.backendContainer) setBackendContainer(session.backendContainer);
  }, [session]);

  const { data: repositories = [] } = useQuery<Repository[]>({
    queryKey: ['/api/repositories', provider],
    enabled: !!provider,
  });

  // Fetch Azure Resource Groups
  const { data: fetchedResourceGroups, isLoading: isLoadingResourceGroups } = useQuery({
    queryKey: ['/api/migrate/azure/resource-groups'],
    enabled: currentStep === 4 && cloudProvider === 'azure',
  });

  useEffect(() => {
    if (fetchedResourceGroups) {
      setResourceGroups(fetchedResourceGroups as any[]);
    }
  }, [fetchedResourceGroups]);

  // Handlers
  const handleProviderSelect = async (selected: Provider) => {
    setProvider(selected);
    setWorkflowNotice({ tone: 'success', text: `Provider ${selected === 'github' ? 'GitHub' : 'Azure DevOps'} selected.` });
    
    if (sessionId) {
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { provider: selected });
      setCurrentStep(2);
    }
  };

  const handleRepositorySelect = async (repoId: string, repoName?: string) => {
    const inferredName = repoName || repositories.find((r) => r.id === repoId)?.fullName || repositories.find((r) => r.id === repoId)?.name || repoId;
    setSelectedRepo(inferredName);
    setWorkflowNotice({ tone: 'success', text: `Repository selected.` });
    
    if (sessionId) {
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
        repositoryId: repoId,
        repositoryName: inferredName,
        isExistingRepo: 'true'
      });
      setCurrentStep(3);
    }
  };

  const handleCloudProviderSelect = async (selected: CloudProvider) => {
    setCloudProvider(selected);
    setWorkflowNotice({ tone: 'success', text: `Cloud Provider Microsoft Azure selected.` });
    
    if (sessionId) {
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { cloudProvider: selected });
      setCurrentStep(4);
    }
  };

  const handleResourceGroupSelect = async (rgId: string, rgName: string) => {
    setSelectedResourceGroup(rgId);
    setWorkflowNotice({ tone: 'success', text: `Target Resource Group ${rgName} selected.` });
  };

  const createRepoMutation = useMutation({
    mutationFn: async ({ name, description }: { name: string; description: string }) => {
      if (!provider) {
        throw new Error('Select GitHub or Azure DevOps before creating a repository.');
      }
      const res = await apiRequest('POST', `/api/repositories/${provider}`, { name, description });
      return await res.json();
    },
    onSuccess: (repo: { id: string; name: string; full_name?: string; fullName?: string }) => {
      const displayName = repo.full_name || repo.fullName || repo.name;
      void queryClient.invalidateQueries({ queryKey: ['/api/repositories', provider] });
      handleRepositorySelect(repo.id, displayName);
      toast({
        title: "Repository Created",
        description: `Successfully created ${displayName}`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Repository Creation Failed",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const extractMutation = useMutation({
    mutationFn: async () => {
      setIsExtracting(true);
      const res = await apiRequest('POST', '/api/migrate/extract', {
        sessionId,
        resourceGroupId: selectedResourceGroup,
        cloudProvider: 'azure'
      });
      const data = await res.json();
      return data;
    },
    onSuccess: () => {
      setIsExtracting(false);
      setWorkflowNotice({ tone: 'success', text: 'Extraction and generation completed successfully.' });
      setCurrentStep(6);
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
    },
    onError: (error: any) => {
      setIsExtracting(false);
      toast({
        title: "Extraction Failed",
        description: error.message || "Failed to extract and generate Terraform code.",
        variant: "destructive"
      });
    }
  });

  const configureBackendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/configure-backend`, {
        action: 'create',
        backendConfig: {
          resourceGroup: backendResourceGroup.trim(),
          storageAccount: backendStorageAccount.trim(),
          container: backendContainer.trim() || 'tfstate',
        }
      });
      return await res.json();
    },
    onSuccess: async () => {
      setBackendConfigured(true);
      // Generate provider-specific CI/CD workflow files during MigrateOps flow (before commit).
      // Merge CI/CD into the latest server-side file list (GET), not stale React state.
      const cicdFiles = buildMigrateCiFiles(provider);
      if (cicdFiles.length > 0) {
        try {
          const freshRes = await apiRequest('GET', `/api/sessions/${sessionId}`);
          const freshSession = await freshRes.json();
          const base = Array.isArray(freshSession.terraformFiles) ? [...freshSession.terraformFiles] : [];
          const merged = [...base];
          for (const wf of cicdFiles) {
            const idx = merged.findIndex((f: any) => (f.path || f.fileName) === wf.path);
            if (idx >= 0) merged[idx] = wf as any;
            else merged.push(wf as any);
          }
          const patchRes = await apiRequest('PATCH', `/api/sessions/${sessionId}`, { terraformFiles: merged });
          const patchData = await patchRes.json();
          if (Array.isArray(patchData.terraformFiles)) {
            setTerraformFiles(patchData.terraformFiles);
            queryClient.setQueryData(['/api/sessions', sessionId], patchData as any);
          } else {
            setTerraformFiles(merged as any[]);
            queryClient.setQueryData(['/api/sessions', sessionId], { ...freshSession, terraformFiles: merged } as any);
          }
          toast({ title: 'CI/CD Files Added', description: 'Provider pipeline YAML files were generated in workspace.' });
        } catch (syncErr: any) {
          console.warn('Failed to persist generated CI/CD files to session:', syncErr?.message || syncErr);
        }
      }
      setWorkflowNotice({ tone: 'success', text: 'Backend configured successfully. Build is now unlocked.' });
      toast({ title: 'Backend Configured', description: 'backend.tf/provider.tf/terraform.tf generated.' });
      setCurrentStep(7);
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
    },
    onError: (error: any) => {
      toast({
        title: "Backend Configuration Failed",
        description: error.message || "Could not configure Terraform backend.",
        variant: "destructive"
      });
    }
  });

  const commitMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('No session');

      // Load authoritative server file list, then merge with UI state (server wins on conflicts).
      // Fixes a race where "Review and Fix" / CI repair updated storage but React state was stale,
      // so a blind PATCH would overwrite repaired files with old content before push.
      const freshRes = await apiRequest('GET', `/api/sessions/${sessionId}`);
      const freshData = (await freshRes.json().catch(() => ({}))) as ExtendedSession;
      if (!freshRes.ok) {
        throw new Error(
          (freshData as { error?: string }).error || 'Could not load session before commit.'
        );
      }
      const serverTf = Array.isArray(freshData.terraformFiles) ? freshData.terraformFiles : [];

      const normalized = terraformFiles
        .filter((f: any) => f?.path && typeof f.content === 'string')
        .map((f: any) => ({ path: String(f.path), content: f.content }));

      const serverHasTerraform = serverTf.some(
        (f: any) =>
          String(f.path || f.fileName || '').trim() &&
          typeof f.content === 'string' &&
          f.content.length > 0
      );

      // Prefer server when CI repair may have updated storage but React still has old buffers, or
      // after a page refresh (normalized []) while the DB still holds the last committed/extracted tree.
      const preferServer =
        allowRepeatCommit ||
        (isCommitted && serverHasTerraform && normalized.length === 0);

      const merged = preferServer
        ? mergeTerraformFilesPreferServer(serverTf, normalized)
        : mergeTerraformFilesPreferClient(serverTf, normalized);
      if (merged.length === 0) {
        throw new Error(
          'No Terraform files to commit. Run Extract again or ensure .tf / .tfvars files are present in the workspace.'
        );
      }
      const syncRes = await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
        terraformFiles: merged,
      });
      const syncData = (await syncRes.json().catch(() => ({}))) as { error?: string };
      if (!syncRes.ok) {
        throw new Error(
          syncData.error || 'Could not save Terraform files to the session before commit.'
        );
      }
      // Do not setState or invalidateQueries here — it can race with POST /commit and confuse
      // React Query; refresh session after a successful push in onSuccess.

      // Do not invent a branch name — commits target the repo default branch unless the session
      // recorded a branch when the repository was selected.
      const payload: { commitMessage: string; branchName?: string } = {
        commitMessage: 'MigrateOps: Auto-generated reverse-engineered Terraform code',
      };
      const branch = session?.repositoryBranch?.trim();
      if (branch) payload.branchName = branch;
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/commit`, payload);
      const data = (await res.json()) as {
        error?: string;
        success?: boolean;
        cicd?: unknown;
        commitSha?: string;
        skippedWorkflowFiles?: string[];
        message?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || `Commit failed (${res.status})`);
      }
      if (data.success === false) {
        throw new Error(data.error || 'Commit was not accepted by the server.');
      }
      return { ...data, __mergedForUi: merged };
    },
    onSuccess: (data) => {
      const merged = (data as { __mergedForUi?: Array<{ path: string; content: string }> })
        .__mergedForUi;
      if (Array.isArray(merged)) {
        setTerraformFiles(merged);
      }
      void queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
      setIsCommitted(true);
      const c = data?.cicd;
      setCicdInfo(
        c
          ? {
              ...c,
              validateRunId: c.runId ?? c.validateRunId ?? null,
              validateRunUrl: c.runUrl ?? c.validateRunUrl ?? null,
            }
          : null
      );
      setCicdRunStatus(null);
      setCicdPreflight(null);
      setAutoFetchedPlanForRunId(null);
      setPlanLogs('');
      setAllowRepeatCommit(false);
      const sha = String(data?.commitSha || data?.cicd?.commitSha || '').trim();
      setExpectedWorkflowHeadSha(sha || null);
      toast({
        title: "Code Committed Successfully",
        description: data?.cicd?.validateWorkflowTriggered
          ? "Code committed and GitHub Validate Migration workflow triggered."
          : "The extracted code has been committed to the repository."
      });
      if (Array.isArray(data?.skippedWorkflowFiles) && data.skippedWorkflowFiles.length > 0) {
        toast({
          title: "Workflow Files Skipped",
          description: "Terraform files were committed, but GitHub workflow files need a token with workflow scope.",
          variant: "destructive"
        });
      }
      setCurrentStep(8);
      setActivityViewMode('overview');
    },
    onError: (error: Error) => {
      toast({
        title: "Commit Failed",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const totalLines = terraformFiles.reduce((sum, f) => sum + (f.content?.split('\n').length || 0), 0);
  const resourceMatches = terraformFiles.flatMap((f) => {
    const matches = f.content?.match(/resource\s+"[^"]+"\s+"[^"]+"/g);
    return matches || [];
  });
  const buildStatusSentence = buildAutoRun
    ? 'Build pipeline is running. Stay in Build Pipeline tab for live stage status.'
    : pipelineCompleted
      ? 'Build stage completed. Proceed to commit when ready.'
      : 'Run Build Pipeline to validate architecture and strict sync fidelity with Azure resources.';

  /** Terraform plan lives on the validate workflow; do not use apply workflow runId for polling or plan logs. */
  const validateWorkflowRunId = cicdInfo?.validateRunId ?? cicdInfo?.runId ?? null;

  const polledRunHeadSha =
    (cicdRunStatus?.run?.headSha ?? cicdRunStatus?.run?.head_sha ?? null) as string | null;
  const ciRunBelongsToLatestCommit =
    !expectedWorkflowHeadSha ||
    !polledRunHeadSha ||
    polledRunHeadSha === expectedWorkflowHeadSha;

  const validateRunFailed =
    ciRunBelongsToLatestCommit &&
    (cicdRunStatus?.run?.conclusion === 'failure' ||
      (Array.isArray(cicdRunStatus?.jobs) &&
        cicdRunStatus.jobs.some((j: { conclusion?: string }) => j.conclusion === 'failure')));

  /** After a failed validate workflow, always allow pushing a fix commit (without requiring an in-app edit first). */
  useEffect(() => {
    if (validateRunFailed) {
      setAllowRepeatCommit(true);
    }
  }, [validateRunFailed]);

  /** Failure must win over "in progress": a completed failed run still has status "completed". */
  const ciWorkflowInProgress =
    isCommitted &&
    cicdInfo?.provider === 'github' &&
    Boolean(validateWorkflowRunId) &&
    !validateRunFailed &&
    (!cicdRunStatus?.run || cicdRunStatus.run.status !== 'completed');

  const repairFromCiMutation = useMutation({
    mutationFn: async () => {
      if (!session?.id) throw new Error('No session');
      const payload: {
        sessionId: string;
        runId?: number;
        planLogs?: string;
        terraformFiles?: Array<{ path: string; content: string }>;
      } = {
        sessionId: session.id,
      };
      const rid = Number(validateWorkflowRunId || 0);
      if (Number.isFinite(rid) && rid > 0) payload.runId = rid;
      if (planLogs?.trim()) payload.planLogs = planLogs;
      if (Array.isArray(terraformFiles) && terraformFiles.length > 0) {
        payload.terraformFiles = terraformFiles.map((f: any) => ({
          path: String(f.path || f.fileName || ''),
          content: f.content ?? '',
        })).filter((f) => f.path && typeof f.content === 'string');
      }
      const res = await apiRequest('POST', '/api/migrate/cicd/repair-from-logs', payload);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'CI repair failed');
      if (data.success === false && data.retryable) {
        const err = new Error(
          data.error || 'CI logs are not ready yet. Wait a few seconds and try Review and Fix again.'
        ) as Error & { retryable?: boolean };
        err.retryable = true;
        throw err;
      }
      if (data.success === false) {
        throw new Error(data.error || 'CI repair failed');
      }
      return data as { terraformFiles?: Array<{ path: string; content: string }>; message?: string };
    },
    onSuccess: (data) => {
      const next = data.terraformFiles;
      if (Array.isArray(next)) {
        setTerraformFiles(next);
        queryClient.setQueryData(['/api/sessions', sessionId], (old: ExtendedSession | undefined) =>
          old ? { ...old, terraformFiles: next } : old
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
      setAllowRepeatCommit(true);
      toast({
        title: 'Terraform updated — review before commit',
        description: data.message || 'Review the Code tab, then commit to push fixes and re-run GitHub validation.',
      });
    },
    onError: (error: Error & { retryable?: boolean }) => {
      if (error.retryable) {
        toast({
          title: 'CI logs not ready yet',
          description: error.message,
        });
        return;
      }
      toast({
        title: 'CI repair failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  /** When the validate workflow fails, pull plan logs once so Review and Fix has Terraform error context. */
  useEffect(() => {
    const runId = Number(validateWorkflowRunId || 0);
    if (!session?.id || !runId) return;
    if (!ciRunBelongsToLatestCommit) return;
    if (cicdRunStatus?.run?.status !== 'completed') return;
    const failed =
      cicdRunStatus?.run?.conclusion === 'failure' ||
      (Array.isArray(cicdRunStatus?.jobs) &&
        cicdRunStatus.jobs.some((j: { conclusion?: string }) => j.conclusion === 'failure'));
    if (!failed) return;
    if (autoFetchedPlanForRunId === runId) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await apiRequest(
          'GET',
          `/api/migrate/cicd/plan-logs?sessionId=${session.id}&runId=${runId}`
        );
        const data = await res.json();
        if (cancelled || !data?.logs) return;
        setPlanLogs(data.logs);
        setAutoFetchedPlanForRunId(runId);
      } catch {
        // User can still use "View Plan Logs" manually
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    session?.id,
    validateWorkflowRunId,
    cicdRunStatus?.run?.status,
    cicdRunStatus?.run?.conclusion,
    cicdRunStatus?.jobs,
    cicdRunStatus?.run?.headSha,
    ciRunBelongsToLatestCommit,
    expectedWorkflowHeadSha,
    autoFetchedPlanForRunId,
  ]);

  useEffect(() => {
    const runId = Number(validateWorkflowRunId || 0);
    if (!session?.id || !runId) return;

    let active = true;
    const pull = async () => {
      try {
        const res = await apiRequest('GET', `/api/migrate/cicd/run-status?sessionId=${session.id}&runId=${runId}`);
        const data = await res.json();
        if (!active) return;
        // Always record the latest GitHub payload. `ciRunBelongsToLatestCommit` gates the UI so we
        // do not mis-attribute another SHA — skipping setCicdRunStatus here left status null and the
        // panel stuck on "Validation running" forever.
        setCicdRunStatus(data);
      } catch {
        // Keep UI resilient if polling intermittently fails.
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
  }, [validateWorkflowRunId, session?.id, expectedWorkflowHeadSha]);

  useEffect(() => {
    if (!isCommitted || provider !== 'github' || !session?.id) return;

    let active = true;
    const runPreflight = async () => {
      setIsCheckingPreflight(true);
      try {
        const res = await apiRequest('GET', `/api/migrate/cicd/preflight?sessionId=${session.id}`);
        const data = await res.json();
        if (!active) return;
        setCicdPreflight(data);
      } catch (err: any) {
        if (!active) return;
        setCicdPreflight(null);
        toast({
          title: 'Pre-flight Check Failed',
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
  }, [isCommitted, provider, session?.id, toast]);

  if (!hasInitialized) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col font-sans">
      <Header />
      
      {/* Workflow Progress Banner */}
      <div className="border-b bg-card text-card-foreground shadow-sm">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <StepIndicator currentStep={currentStep} steps={steps} />
          {workflowNotice && (
            <div className={`text-sm px-3 py-1.5 rounded-full flex items-center gap-2 ${
              workflowNotice.tone === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-blue-50 text-blue-700 border border-blue-200'
            }`}>
              {workflowNotice.tone === 'success' && <CheckCircle2 className="w-4 h-4" />}
              {workflowNotice.text}
            </div>
          )}
        </div>
      </div>

      <main className="flex-1 container mx-auto px-4 py-6 flex flex-col overflow-hidden">
        <div className="bg-card text-card-foreground rounded-lg border shadow-sm flex flex-col flex-1 overflow-hidden">
          <div className="p-6 flex flex-col h-full overflow-y-auto">
            
            {/* Step 1: Provider */}
            {currentStep === 1 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Select Repository Provider</h2>
                  <p className="text-muted-foreground">Choose where your generated Terraform code will be stored.</p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
                  <ProviderCard
                    provider="github"
                    icon={<GitHubLogoIcon className="w-8 h-8" />}
                    title="GitHub"
                    description="Store and version control your generated Terraform code in GitHub"
                    selected={provider === 'github'}
                    onClick={() => handleProviderSelect('github')}
                  />
                  <ProviderCard
                    provider="azure"
                    icon={<Cloud className="w-8 h-8" />}
                    title="Azure DevOps"
                    description="Store and version control your generated Terraform code in Azure Repos"
                    selected={provider === 'azure'}
                    onClick={() => handleProviderSelect('azure')}
                  />
                </div>
              </div>
            )}

            {/* Step 2: Repository */}
            {currentStep === 2 && provider && (
              <div className="space-y-6 h-full flex flex-col">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select Repository</h2>
                  <p className="text-muted-foreground">Choose an existing repository or create a new one.</p>
                </div>
                <div className="flex gap-4 mb-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setProvider(null);
                      setCurrentStep(1);
                    }}
                  >
                    ← Back
                  </Button>
                </div>
                <Tabs defaultValue="existing" className="w-full">
                  <TabsList>
                    <TabsTrigger value="existing">Existing Repositories</TabsTrigger>
                    <TabsTrigger value="new">Create New</TabsTrigger>
                  </TabsList>
                  <TabsContent value="existing" className="mt-4">
                    <RepositoryList
                      repositories={repositories}
                      selectedId={session?.repositoryId || undefined}
                      onSelect={handleRepositorySelect}
                      showSearch={provider === 'github'}
                    />
                  </TabsContent>
                  <TabsContent value="new" className="mt-4">
                    <CreateRepoForm
                      onSubmit={(name, description) => createRepoMutation.mutate({ name, description })}
                      loading={createRepoMutation.isPending}
                    />
                  </TabsContent>
                </Tabs>
              </div>
            )}

            {/* Step 3: Cloud Provider */}
            {currentStep === 3 && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select Cloud Provider</h2>
                  <p className="text-muted-foreground">Which cloud environment do you want to extract from?</p>
                </div>
                <div className="flex gap-4 mb-2">
                  <Button variant="outline" onClick={() => setCurrentStep(2)}>
                    ← Back
                  </Button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto">
                  <div
                    className={`border rounded-lg p-6 cursor-pointer transition-all ${
                      cloudProvider === 'azure' ? 'border-primary ring-2 ring-primary/20 bg-primary/5' : 'hover:border-primary/50'
                    }`}
                    onClick={() => handleCloudProviderSelect('azure')}
                  >
                    <div className="flex items-center gap-4">
                      <Cloud className="w-8 h-8 text-[#0089D6]" />
                      <div>
                        <h3 className="font-medium">Microsoft Azure</h3>
                        <p className="text-sm text-muted-foreground">Extract Azure Resources</p>
                      </div>
                    </div>
                  </div>
                  {/* AWS and GCP can be added later per post-MVP plan */}
                </div>
              </div>
            )}

            {/* Step 4: Target Selection (Resource Groups) */}
            {currentStep === 4 && cloudProvider === 'azure' && (
              <div className="space-y-6 flex flex-col h-full">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select Target Resource Group</h2>
                  <p className="text-muted-foreground">Choose the Azure Resource Group you want to reverse-engineer.</p>
                </div>
                <div className="flex gap-4 mb-2">
                  <Button variant="outline" onClick={() => setCurrentStep(3)}>
                    ← Back
                  </Button>
                </div>
                
                {isLoadingResourceGroups ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-primary mr-2" />
                    <span>Fetching Resource Groups from Azure...</span>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {resourceGroups.map(rg => (
                      <div
                        key={rg.id}
                        className={`border rounded-lg p-4 cursor-pointer transition-colors flex flex-col gap-2 ${
                          selectedResourceGroup === rg.id ? 'border-primary ring-2 ring-primary/20 bg-primary/5' : 'hover:border-primary'
                        }`}
                        onClick={() => handleResourceGroupSelect(rg.id, rg.name)}
                      >
                        <div className="flex items-center justify-between">
                          <h3 className="font-semibold text-foreground truncate" title={rg.name}>{rg.name}</h3>
                          <Package className="w-5 h-5 text-muted-foreground" />
                        </div>
                        <div className="text-sm text-muted-foreground flex justify-between">
                          <span>{rg.location}</span>
                          <span className="bg-secondary px-2 rounded-full">{rg.resourceCount} resources</span>
                        </div>
                      </div>
                    ))}
                    {resourceGroups.length === 0 && (
                      <div className="col-span-full text-center py-8 text-muted-foreground">
                        No resource groups found or Azure connection failed. Check your Azure credentials in Settings.
                      </div>
                    )}
                  </div>
                )}
                <div className="flex justify-end">
                  <Button
                    disabled={!selectedResourceGroup}
                    onClick={() => setCurrentStep(5)}
                  >
                    Continue to Extract →
                  </Button>
                </div>
              </div>
            )}

            {/* Step 5: Extract & Generate */}
            {currentStep === 5 && (
              <div className="flex flex-col items-center justify-center h-full py-12 space-y-6">
                {!isExtracting ? (
                  <div className="text-center space-y-4">
                    <div className="flex justify-start mb-2">
                      <Button variant="outline" onClick={() => setCurrentStep(4)}>
                        ← Back
                      </Button>
                    </div>
                    <h2 className="text-2xl font-bold">
                      {session?.terraformFiles && session.terraformFiles.length > 0 ? "Re-Extract Resources" : "Ready to Extract"}
                    </h2>
                    <p className="text-muted-foreground max-w-lg mx-auto">
                      SpiritOps will now connect to Azure, fetch all resources within the selected Resource Group, and use AI to translate them into clean, best-practice Terraform HCL.
                    </p>
                    <Button 
                      size="lg" 
                      onClick={() => extractMutation.mutate()} 
                      className="mt-4"
                    >
                      {session?.terraformFiles && session.terraformFiles.length > 0 ? "Start Re-Extraction" : "Start Extraction"}
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                    
                    {session?.terraformFiles && session.terraformFiles.length > 0 && (
                      <Button 
                        size="lg" 
                        variant="outline"
                        onClick={() => setCurrentStep(6)} 
                        className="mt-4 ml-4"
                      >
                        Skip & Continue to Backend
                        <ChevronRight className="w-4 h-4 ml-2" />
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="w-full max-w-md">
                    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-8 space-y-6 text-center">
                      <div className="relative h-2 w-full rounded-full bg-primary/15 overflow-hidden">
                        <div
                          className="absolute inset-y-0 rounded-full bg-gradient-to-r from-primary/60 via-primary to-primary/60"
                          style={{ width: '45%', animation: 'tfbar 1.6s ease-in-out infinite' }}
                        />
                      </div>
                      <div className="space-y-2">
                        <h3 className="font-semibold">Extracting and Reverse-Engineering...</h3>
                        <p className="text-sm text-muted-foreground">Fetching live JSON payload and translating to HCL code. This may take up to a minute.</p>
                      </div>
                      <style>{`
                        @keyframes tfbar {
                          0%   { left: -45%; }
                          100% { left: 100%; }
                        }
                      `}</style>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Step 6: Backend Configuration */}
            {currentStep === 6 && (
              <div className="space-y-6 max-w-2xl mx-auto">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Configure Terraform Backend</h2>
                  <p className="text-muted-foreground">
                    Enter backend details before Build. This generates `backend.tf`, `provider.tf`, and `terraform.tf`.
                  </p>
                </div>

                <div className="rounded-xl border p-5 space-y-4 bg-card">
                  <div className="space-y-2">
                    <Label htmlFor="backend-rg">Backend Resource Group</Label>
                    <Input
                      id="backend-rg"
                      value={backendResourceGroup}
                      onChange={(e) => setBackendResourceGroup(e.target.value)}
                      placeholder="terraform-state-rg"
                      disabled={configureBackendMutation.isPending}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="backend-storage">Storage Account</Label>
                    <Input
                      id="backend-storage"
                      value={backendStorageAccount}
                      onChange={(e) => setBackendStorageAccount(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24))}
                      placeholder="tfstateaccount"
                      disabled={configureBackendMutation.isPending}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="backend-container">Container</Label>
                    <Input
                      id="backend-container"
                      value={backendContainer}
                      onChange={(e) => setBackendContainer(e.target.value)}
                      placeholder="tfstate"
                      disabled={configureBackendMutation.isPending}
                    />
                  </div>
                </div>

                <div className="flex justify-center gap-3">
                  <Button variant="outline" onClick={() => setCurrentStep(5)} disabled={configureBackendMutation.isPending}>
                    ← Back
                  </Button>
                  <Button
                    onClick={() => configureBackendMutation.mutate()}
                    disabled={
                      configureBackendMutation.isPending ||
                      !backendResourceGroup.trim() ||
                      !backendStorageAccount.trim() ||
                      !backendContainer.trim()
                    }
                  >
                    {configureBackendMutation.isPending ? (
                      <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Configuring...</>
                    ) : (
                      <>Configure Backend & Continue →</>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* Step 7 & 8: Build Workspace & Commit */}
            {currentStep >= 7 && session && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">Build Workspace</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {terraformFiles.length > 0
                      ? `${terraformFiles.length} files generated · ${cloudProvider?.toUpperCase() ?? 'Cloud'} infrastructure ready`
                      : 'Your infrastructure is being prepared…'}
                  </p>
                </div>

                <div className="flex gap-2 p-1 rounded-xl bg-muted/60">
                  {(['overview', 'build', 'code'] as const).map(mode => (
                    <button
                      key={mode}
                      onClick={() => setActivityViewMode(mode)}
                      className={`px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-200 ${
                        activityViewMode === mode
                          ? 'bg-gradient-to-r from-emerald-500 to-green-500 text-white shadow-md shadow-emerald-200 dark:shadow-emerald-900/40'
                          : 'text-muted-foreground hover:bg-gradient-to-r hover:from-emerald-50 hover:to-green-50 hover:text-emerald-700 dark:hover:from-emerald-950/40 dark:hover:to-green-950/40 dark:hover:text-emerald-300'
                      }`}
                    >
                      {mode === 'build' ? 'Build Pipeline' : mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                </div>

                {activityViewMode === 'overview' && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      {[
                        { label: 'Files', value: terraformFiles.length, sub: 'generated', icon: FileCode, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' },
                        { label: 'Lines', value: totalLines.toLocaleString(), sub: 'of HCL', icon: Hash, color: 'text-violet-500', bg: 'bg-violet-50 dark:bg-violet-950/30' },
                        { label: 'Resources', value: resourceMatches.length, sub: 'declared', icon: Box, color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/30' },
                        { label: 'Cloud', value: cloudProvider?.toUpperCase() ?? '—', sub: 'provider', icon: Cloud, color: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/30' },
                      ].map(({ label, value, sub, icon: Icon, color, bg }) => (
                        <div key={label} className={`rounded-2xl border p-4 flex items-center gap-4 ${bg}`}>
                          <div className={`rounded-xl p-2.5 ${bg}`}>
                            <Icon className={`w-5 h-5 ${color}`} />
                          </div>
                          <div>
                            <p className="text-xl font-bold leading-tight">{value}</p>
                            <p className="text-xs text-muted-foreground">{label} <span className="opacity-60">{sub}</span></p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="rounded-lg border bg-white/70 px-3 py-2 text-xs text-muted-foreground">
                      Backend: {backendConfigured ? 'Configured' : 'Pending configuration'}
                    </div>
                    <div className="rounded-lg border bg-white/70 px-3 py-2 text-xs text-muted-foreground">
                      {buildStatusSentence}
                    </div>
                    <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                      Sync stage enforces migration fidelity checks and flags drift risks before commit.
                    </div>
                    {isCommitted && (
                      <Card className="border-border/80 shadow-sm">
                        <CardHeader className="pb-3">
                          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <CardTitle className="text-lg font-semibold tracking-tight">CI/CD validation</CardTitle>
                              <CardDescription className="text-sm mt-1 max-w-2xl">
                                Each push runs <code className="text-xs rounded bg-muted px-1 py-0.5">terraform plan</code> in
                                GitHub. If validation fails, use <strong>Review and Fix</strong>, review changes in Code, then commit again.
                              </CardDescription>
                            </div>
                            {(cicdInfo?.validateRunUrl || cicdInfo?.runUrl) ? (
                              <Button variant="secondary" size="sm" className="shrink-0 gap-1.5" asChild>
                                <a href={cicdInfo.validateRunUrl || cicdInfo.runUrl} target="_blank" rel="noreferrer">
                                  <GitHubLogoIcon className="h-4 w-4" />
                                  Open validate run
                                  <ExternalLink className="h-3.5 w-3.5 opacity-70" />
                                </a>
                              </Button>
                            ) : null}
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4 pt-0">
                          {cicdInfo?.provider === 'github' ? (
                            <>
                              {/* Primary status — single focal panel */}
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
                                {validateRunFailed && ciRunBelongsToLatestCommit ? (
                                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="flex gap-3">
                                      <Wrench className="h-5 w-5 shrink-0 text-destructive mt-0.5" />
                                      <div>
                                        <p className="text-sm font-medium text-foreground">Validate Migration failed</p>
                                        <p className="text-xs text-muted-foreground mt-0.5">
                                          {planLogs
                                            ? 'Plan logs are loaded below. '
                                            : 'Use View plan logs or wait for auto-fetch. '}
                                          Review and Fix applies patches to Terraform in this workspace; then review in Code and commit to re-run CI.
                                        </p>
                                      </div>
                                    </div>
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      className="shrink-0"
                                      disabled={
                                        repairFromCiMutation.isPending ||
                                        !session?.id ||
                                        (!validateWorkflowRunId && !planLogs?.trim())
                                      }
                                      onClick={() => {
                                        if (
                                          !window.confirm(
                                            'Apply AI-suggested fixes to Terraform in this workspace from the CI logs? Review the Code tab, then commit to push and re-run validation.'
                                          )
                                        ) {
                                          return;
                                        }
                                        repairFromCiMutation.mutate();
                                      }}
                                    >
                                      {repairFromCiMutation.isPending ? (
                                        <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                                      ) : (
                                        <Wrench className="w-4 h-4 mr-1.5" />
                                      )}
                                      Review and Fix
                                    </Button>
                                  </div>
                                ) : ciWorkflowInProgress && ciRunBelongsToLatestCommit ? (
                                  <div className="flex gap-3">
                                    <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary mt-0.5" />
                                    <div>
                                      <p className="text-sm font-medium text-foreground">Validation running in GitHub</p>
                                      <p className="text-xs text-muted-foreground mt-0.5">
                                        Terraform plan is executing for this commit. If it fails, use Review and Fix below.
                                      </p>
                                    </div>
                                  </div>
                                ) : ciRunBelongsToLatestCommit && cicdRunStatus?.run?.conclusion === 'success' ? (
                                  <div className="flex gap-3">
                                    <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-500 mt-0.5" />
                                    <div>
                                      <p className="text-sm font-medium text-foreground">Plan succeeded in CI</p>
                                      <p className="text-xs text-muted-foreground mt-0.5">
                                        You can start the apply workflow in GitHub when ready (environment approval may be required).
                                      </p>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex gap-3">
                                    <Clock3 className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
                                    <div>
                                      <p className="text-sm font-medium text-foreground">Waiting for validate run</p>
                                      <p className="text-xs text-muted-foreground mt-0.5">
                                        Status will update when GitHub reports the workflow for your latest commit.
                                      </p>
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* Pre-flight: compact when healthy, expandable for details */}
                              <div className="space-y-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    Pre-flight
                                  </span>
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
                                            {passed
                                              ? 'OK'
                                              : idx === 4
                                                ? 'Denied'
                                                : '—'}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  </CollapsibleContent>
                                </Collapsible>
                              </div>

                              <Separator />

                              {/* Run + jobs + artifacts — one list */}
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
                                  <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
                                    <a href={cicdInfo.applyRunUrl} target="_blank" rel="noreferrer">
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
                                    disabled={isCheckingPreflight || !session?.id}
                                    onClick={async () => {
                                      if (!session?.id) return;
                                      setIsCheckingPreflight(true);
                                      try {
                                        const res = await apiRequest('GET', `/api/migrate/cicd/preflight?sessionId=${session.id}`);
                                        const data = await res.json();
                                        setCicdPreflight(data);
                                        toast({
                                          title: data?.ready ? 'Pre-flight Ready' : 'Pre-flight Needs Attention',
                                          description: data?.ready
                                            ? 'All checks passed for CI/CD.'
                                            : (Array.isArray(data?.issues) ? data.issues.join(' ') : 'Please fix pre-flight issues.'),
                                          variant: data?.ready ? 'default' : 'destructive',
                                        });
                                      } catch (err: any) {
                                        toast({
                                          title: 'Pre-flight Check Failed',
                                          description: err?.message || 'Could not run pre-flight checks.',
                                          variant: 'destructive'
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
                                    disabled={isLoadingPlanLogs || !session?.id || !validateWorkflowRunId}
                                    onClick={async () => {
                                      if (!session?.id || !validateWorkflowRunId) return;
                                      setIsLoadingPlanLogs(true);
                                      try {
                                        const res = await apiRequest(
                                          'GET',
                                          `/api/migrate/cicd/plan-logs?sessionId=${session.id}&runId=${validateWorkflowRunId}`
                                        );
                                        const data = await res.json();
                                        if (data?.ready === false || !data?.logs) {
                                          toast({
                                            title: 'Plan Logs Pending',
                                            description:
                                              data?.error || 'Validate job is still starting. Retry in a few seconds.',
                                          });
                                        } else {
                                          setPlanLogs(data.logs || '');
                                          toast({
                                            title: 'Plan Logs Loaded',
                                            description: data?.truncated
                                              ? 'Showing latest part of Terraform plan logs.'
                                              : 'Terraform plan logs loaded.'
                                          });
                                        }
                                      } catch (err: any) {
                                        toast({
                                          title: 'Plan Logs Failed',
                                          description: err.message || 'Could not load Terraform plan logs yet.',
                                          variant: 'destructive'
                                        });
                                      } finally {
                                        setIsLoadingPlanLogs(false);
                                      }
                                    }}
                                  >
                                    {isLoadingPlanLogs ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
                                    View plan logs
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="default"
                                    className="gap-1.5"
                                    disabled={isTriggeringApply || !session?.id}
                                    onClick={async () => {
                                      if (!session?.id) return;
                                      setIsTriggeringApply(true);
                                      try {
                                        const res = await apiRequest('POST', '/api/migrate/cicd/start-apply', { sessionId: session.id });
                                        const data = await res.json();
                                        setCicdInfo((prev: any) => ({
                                          ...(prev || {}),
                                          applyRunId: data.runId ?? null,
                                          applyRunUrl: data.runUrl ?? null,
                                          applyWorkflow: data.workflow,
                                          applyStatus: data.status,
                                        }));
                                        toast({
                                          title: 'Workflow started',
                                          description:
                                            'Apply workflow dispatched. Approve in the GitHub environment when ready; terraform plan output is from the validate workflow.',
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
                            </>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              Pipeline file generated for the selected provider. Run it from your repository&apos;s CI/CD system.
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    )}
                  </div>
                )}

                {activityViewMode === 'build' && (
                  <div className="space-y-4">
                    <ActivityPanel
                      sessionId={session.id}
                      autoRun={buildAutoRun}
                      pipelineLayout="sidebar"
                      workflowType="migrateops"
                      onRequestRunPipeline={() => {
                        setBuildAutoRun(false);
                        setPipelineCompleted(false);
                        setWorkflowNotice({ tone: 'info', text: 'Build started: running Architecture and Sync.' });
                      }}
                      onPipelineStageComplete={(stage) => {
                        if (stage === 'sync') {
                          setWorkflowNotice({ tone: 'success', text: 'Sync successful. Terraform mapping is aligned with scanned Azure resources.' });
                          toast({ title: 'Sync Successful', description: 'Sync stage completed successfully.' });
                        }
                      }}
                      onPipelineComplete={() => {
                        setBuildAutoRun(false);
                        setPipelineCompleted(true);
                        setWorkflowNotice({ tone: 'success', text: 'Build completed. You can proceed to commit.' });
                        toast({ title: 'Build Complete', description: 'Architecture and Sync stages completed. Ready to commit.' });
                      }}
                      onUpdateFiles={(newFiles: any) => {
                        setTerraformFiles(newFiles);
                        queryClient.setQueryData(['/api/sessions', session.id], { ...session, terraformFiles: newFiles } as any);
                      }}
                      generatedFiles={terraformFiles}
                    />
                  </div>
                )}

                {activityViewMode === 'code' && (
                  <div className="space-y-3">
                    <div className="rounded-2xl border bg-card overflow-hidden">
                      {terraformFiles && terraformFiles.length > 0 ? (
                        <CodeEditor
                          files={terraformFiles.map((f: any) => ({ name: f.path, content: f.content }))}
                          onFileChange={async (fileName: string, content: string) => {
                            const updatedFiles = terraformFiles.map((f: any) =>
                              f.path === fileName ? { ...f, content } : f
                            );
                            const res = await apiRequest('PATCH', `/api/sessions/${session.id}`, { terraformFiles: updatedFiles });
                            const data = await res.json();
                            const next = Array.isArray(data.terraformFiles) ? data.terraformFiles : updatedFiles;
                            setTerraformFiles(next);
                            queryClient.setQueryData(['/api/sessions', session.id], { ...data, terraformFiles: next } as any);
                            if (isCommitted) setAllowRepeatCommit(true);
                          }}
                        />
                      ) : (
                        <div className="p-10 text-center text-muted-foreground space-y-2">
                          <FileCode className="w-8 h-8 mx-auto opacity-40" />
                          <p className="text-sm">No files generated yet</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-3 items-center pt-2 border-t">
                  <div className="flex gap-4 justify-center">
                    <Button variant="outline" onClick={() => setCurrentStep(6)}>
                      ← Back
                    </Button>
                    <Button
                      disabled={
                        commitMutation.isPending ||
                        !pipelineCompleted ||
                        (isCommitted &&
                          ciRunBelongsToLatestCommit &&
                          cicdRunStatus?.run?.conclusion === 'success' &&
                          !allowRepeatCommit)
                      }
                      onClick={() => commitMutation.mutate()}
                    >
                      {pipelineCompleted ? (
                        <>
                          <CheckCircle2 className="w-4 h-4 mr-1.5" />{' '}
                          {isCommitted &&
                          (allowRepeatCommit || cicdRunStatus?.run?.conclusion === 'failure')
                            ? 'Commit fixes →'
                            : 'Proceed to Commit →'}
                        </>
                      ) : (
                        <><Clock3 className="w-4 h-4 mr-1.5 opacity-50" /> Awaiting Build…</>
                      )}
                    </Button>
                  </div>
                  {!pipelineCompleted && (
                    <p className="text-center text-xs text-muted-foreground">
                      Switch to the <button className="underline underline-offset-2 hover:text-foreground" onClick={() => setActivityViewMode('build')}>Build Pipeline</button> tab and run the pipeline to unlock commit.
                    </p>
                  )}
                </div>
              </div>
            )}

          </div>
        </div>
      </main>
    </div>
  );
}