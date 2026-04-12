import { useState, useEffect, useRef } from "react";
import mermaid from "mermaid";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { generateBuildId, saveBuildHistory } from "@/lib/build-history";
import { useSecretsConfig } from "@/hooks/useSecretsConfig";
import Header from "@/components/Header";
import AIMessage from "@/components/AIMessage";
import UserMessage from "@/components/UserMessage";
import ChatInput from "@/components/ChatInput";
import ProviderCard from "@/components/ProviderCard";
import RepositoryList from "@/components/RepositoryList";
import CreateRepoForm from "@/components/CreateRepoForm";
import StepIndicator from "@/components/StepIndicator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import CodeEditor from "@/components/CodeEditor";
import { FileCode, Package, Package2, Home, Cloud, Loader2, Upload, FileText, RefreshCw, CheckCircle2, AlertTriangle, AlertCircle, XCircle, FolderOpen, ShieldCheck, BarChart3, Hash, Box, Network, Shield, Lock, Activity, Database, PlayCircle, ChevronRight, Layers, Clock3, Globe, Download } from "lucide-react";
import ActivityPanel from "@/components/ActivityPanel";
import BuildHistoryPanel from "@/components/BuildHistoryPanel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Session, Message, Repository, GeneratedFile } from "@shared/schema";

type WorkflowType = 'manifest' | 'helm' | 'kustomize' | 'helm-generator' | null;
type Step = 1 | 2 | 3 | 4 | 5 | 6;
type Provider = 'github' | 'azure' | null;

const K8S_KIND_LABELS: Record<string, { label: string; icon: any }> = {
  Deployment:               { label: 'Deployment',         icon: Layers },
  StatefulSet:              { label: 'StatefulSet',         icon: Database },
  DaemonSet:                { label: 'DaemonSet',           icon: Layers },
  ReplicaSet:               { label: 'ReplicaSet',          icon: Layers },
  Job:                      { label: 'Job',                 icon: Activity },
  CronJob:                  { label: 'CronJob',             icon: Clock3 },
  Pod:                      { label: 'Pod',                 icon: Box },
  Service:                  { label: 'Service',             icon: Network },
  Ingress:                  { label: 'Ingress',             icon: Globe },
  IngressClass:             { label: 'IngressClass',        icon: Network },
  ConfigMap:                { label: 'ConfigMap',           icon: FileText },
  Secret:                   { label: 'Secret',              icon: Lock },
  PersistentVolumeClaim:    { label: 'PVC',                 icon: Database },
  PersistentVolume:         { label: 'PV',                  icon: Database },
  StorageClass:             { label: 'StorageClass',        icon: Database },
  ServiceAccount:           { label: 'ServiceAccount',      icon: Shield },
  ClusterRole:              { label: 'ClusterRole',         icon: Shield },
  ClusterRoleBinding:       { label: 'ClusterRoleBinding',  icon: Shield },
  Role:                     { label: 'Role',                icon: Shield },
  RoleBinding:              { label: 'RoleBinding',         icon: Shield },
  NetworkPolicy:            { label: 'NetworkPolicy',       icon: Shield },
  HorizontalPodAutoscaler:  { label: 'HPA',                 icon: Activity },
  VerticalPodAutoscaler:    { label: 'VPA',                 icon: Activity },
  Namespace:                { label: 'Namespace',           icon: FolderOpen },
  ResourceQuota:            { label: 'ResourceQuota',       icon: Activity },
  LimitRange:               { label: 'LimitRange',          icon: Activity },
};
function k8sKindLabel(kind: string): { label: string; icon: any } {
  return K8S_KIND_LABELS[kind] ?? { label: kind, icon: Box };
}

/** Renders a Mermaid diagram from stored syntax — used in the build report */
function ArchitectureDiagramPreview({ mermaidSyntax }: { mermaidSyntax: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || !mermaidSyntax) return;
    mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });
    const id = `report-diagram-${Math.random().toString(36).slice(2)}`;
    mermaid.render(id, mermaidSyntax)
      .then(({ svg }) => {
        if (containerRef.current) containerRef.current.innerHTML = svg;
      })
      .catch((err) => setError(err?.message ?? 'Diagram render error'));
  }, [mermaidSyntax]);

  if (error) return <p className="text-xs text-rose-600 p-4">{error}</p>;
  return <div ref={containerRef} className="overflow-auto max-h-[500px] flex justify-center" />;
}

export default function KubernetesWorkflow() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [sessionId, setSessionId] = useState<string>('');
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [workflowType, setWorkflowType] = useState<WorkflowType>(null);
  const [provider, setProvider] = useState<Provider>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [workloadDescription, setWorkloadDescription] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [validationResults, setValidationResults] = useState<any>(null);
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const [isCommitted, setIsCommitted] = useState<boolean>(false);
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [scanCompleted, setScanCompleted] = useState<boolean>(false);
  const [progressMessage, setProgressMessage] = useState<string>('');
  const [manifestValidationResult, setManifestValidationResult] = useState<{ valid: boolean; schemaErrors: number; warnings: number } | null>(null);
  const [helmFile, setHelmFile] = useState<File | null>(null);
  const [kustomizePath, setKustomizePath] = useState<string>('');
  const [securityScore, setSecurityScore] = useState<any>(null);
  const [activityViewMode, setActivityViewMode] = useState<'overview' | 'build' | 'code' | 'report'>('overview');
  const [buildId, setBuildId] = useState<string | null>(null);
  const [rightsizingResult, setRightsizingResult] = useState<any>(null);
  const [isRightsizing, setIsRightsizing] = useState(false);
  const [policyCheckResult, setPolicyCheckResult] = useState<any>(null);
  const [isPolicyChecking, setIsPolicyChecking] = useState(false);
  const [buildAutoRun, setBuildAutoRun] = useState(false);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [completedPipelineStages, setCompletedPipelineStages] = useState<string[]>([]);
  // Build report data
  const [buildDiagramResult, setBuildDiagramResult] = useState<any>(null);
  const [buildScanResult, setBuildScanResult] = useState<any>(null);

  const [expandedSnippets, setExpandedSnippets] = useState<Set<string>>(new Set());
  const toggleSnippet = (id: string) => setExpandedSnippets(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Helm Generator state
  const [helmGenOptions, setHelmGenOptions] = useState({
    framework: 'generic',
    includeHPA: true,
    includeIngress: true,
    generateEnvOverlays: true,
  });
  const [helmGenLintResult, setHelmGenLintResult] = useState<{ status: string; errors: string[]; warnings: string[] } | null>(null);
  const [helmChartName, setHelmChartName] = useState<string>('');

  // Helm Generator — auto-scan state
  type HelmScanState = 'idle' | 'scanning' | 'done' | 'empty' | 'error' | 'no-app-code';
  const [helmScanState, setHelmScanState] = useState<HelmScanState>('idle');
  const [repoAnalysis, setRepoAnalysis] = useState<{
    appType: string;
    language: string;
    framework: string;
    description: string;
    detectedServices: string[];
    suggestedPort: number;
    suggestedReplicas: number;
  } | null>(null);
  const [repoScannedFiles, setRepoScannedFiles] = useState<string[]>([]);
  const [helmAppContext, setHelmAppContext] = useState<string>('');

  const steps: Array<{ number: number; title: string }> = [
    { number: 1, title: 'Workflow' },
    { number: 2, title: 'Repository' },
    {
      number: 3,
      title: workflowType === 'kustomize'
        ? 'Directory'
        : workflowType === 'helm'
          ? 'Upload'
          : workflowType === 'helm-generator'
            ? 'Validate'
            : 'Describe'
    },
    {
      number: 4,
      title: workflowType === 'kustomize'
        ? 'Build'
        : workflowType === 'helm'
          ? 'Validate'
          : 'Generate'
    },
    { number: 5, title: 'Build' },
    { number: 6, title: 'Commit' },
  ];

  // Create or restore session on mount
  useEffect(() => {
    const initializeSession = async () => {
      const savedSessionId = localStorage.getItem('kubernetes_workflow_session_id');

      if (savedSessionId) {
        try {
          const response = await apiRequest('GET', `/api/sessions/${savedSessionId}`);
          const session = await response.json() as Session;
          setSessionId(session.id);

          // Restore workflow state from session
          const stepNum = session.currentStep ? parseInt(session.currentStep, 10) as Step : 1;

          // Also restore workflow metadata from localStorage (since session may not have it)
          const savedWorkflowType = localStorage.getItem('kubernetes_workflow_type') as WorkflowType;
          const savedProvider = localStorage.getItem('kubernetes_workflow_provider') as Provider;
          const savedRepo = localStorage.getItem('kubernetes_workflow_repo');

          if (stepNum > 1) {
            setCurrentStep(stepNum);
            // Restore workflow state if we're past step 1
            if (savedWorkflowType) setWorkflowType(savedWorkflowType);
            if (savedProvider) setProvider(savedProvider);
            if (savedRepo) setSelectedRepo(savedRepo);
          } else {
            // Step 1 - reset everything
            setWorkflowType(null);
            setProvider(null);
            setSelectedRepo('');
          }

          return;
        } catch (error) {
          localStorage.removeItem('kubernetes_workflow_session_id');
          localStorage.removeItem('kubernetes_workflow_type');
          localStorage.removeItem('kubernetes_workflow_provider');
          localStorage.removeItem('kubernetes_workflow_repo');
        }
      }

      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      localStorage.setItem('kubernetes_workflow_session_id', session.id);

      // Tag session with module type for history tracking
      await apiRequest('PATCH', `/api/sessions/${session.id}`, { activeModule: 'kubernetes' });

      await apiRequest('POST', `/api/sessions/${session.id}/messages/system`, {
        message: 'Welcome to Kubernetes Workflow! Choose a workflow type to get started: Manifest Generation or Helm Chart Validation.'
      });
    };
    initializeSession();
  }, []);

  // Persist current step to backend when it changes
  useEffect(() => {
    if (sessionId && currentStep > 1) {
      // Update session's currentStep on backend
      apiRequest('PATCH', `/api/sessions/${sessionId}`, {
        currentStep: String(currentStep)
      }).catch(err => {
        console.warn('Failed to persist step to backend:', err);
      });
    }
  }, [sessionId, currentStep]);

  // Reset Build Workspace state when entering step 5
  useEffect(() => {
    if (currentStep === 5) {
      setActivityViewMode('overview');
      setScanCompleted(false);
      setBuildId(null);
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
    }
  }, [currentStep]);

  // Fetch messages
  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: ['/api/sessions', sessionId, 'messages'],
    enabled: !!sessionId,
    refetchInterval: 2000,
  });

  // Fetch session
  const { data: session } = useQuery<Session>({
    queryKey: ['/api/sessions', sessionId],
    enabled: !!sessionId,
  });

  // Fetch repositories
  const { data: repositories = [] } = useQuery<Repository[]>({
    queryKey: ['/api/repositories', provider],
    enabled: !!provider && currentStep === 2,
  });

  // Fetch generated files
  const { data: generatedFiles = [] } = useQuery<GeneratedFile[]>({
    queryKey: ['/api/sessions', sessionId, 'files'],
    enabled: !!sessionId && currentStep >= 4,
    refetchOnMount: true,
  });

  const { data: config } = useSecretsConfig();

  // ── Workflow Progress panel ───────────────────────────────────────────────
  const workflowTypeLabel =
    workflowType === 'manifest' ? 'Manifest Generation' :
    workflowType === 'helm' ? 'Helm Validation' :
    workflowType === 'kustomize' ? 'Kustomize' :
    workflowType === 'helm-generator' ? 'Helm Generator' : 'Not selected';

  const workflowSummaryItems = [
    { label: 'Workflow Type',  value: workflowTypeLabel },
    { label: 'Repo Provider',  value: provider === 'github' ? 'GitHub' : provider === 'azure' ? 'Azure DevOps' : 'Not selected' },
    { label: 'Repository',     value: selectedRepo || 'Not selected' },
    { label: 'Files Generated', value: generatedFiles.length > 0 ? `${generatedFiles.length} file${generatedFiles.length !== 1 ? 's' : ''}` : 'None' },
    {
      label: 'Build Status',
      value: buildId
        ? `Build ${buildId}`
        : scanCompleted
          ? 'Complete'
          : pipelineRunning
            ? `Running (${completedPipelineStages.length}/3 stages)`
            : currentStep >= 5
              ? 'Ready to build'
              : 'Pending',
    },
  ];

  const getNextActionLabel = () => {
    if (currentStep === 1) return 'Select workflow type';
    if (currentStep === 2) return provider ? 'Select or create repository' : 'Select repository provider';
    if (currentStep === 3) {
      if (workflowType === 'helm') return 'Upload Helm chart';
      if (workflowType === 'kustomize') return 'Set Kustomize directory';
      if (workflowType === 'helm-generator') return 'Confirm application details';
      return 'Describe your workload';
    }
    if (currentStep === 4) return workflowType === 'helm-generator' ? 'Generate Helm chart' : 'Generate Kubernetes manifests';
    if (currentStep === 5) {
      if (pipelineRunning) return 'Pipeline running...';
      if (buildId) return 'Proceed to commit';
      if (scanCompleted) return 'View build report';
      return 'Run the Build pipeline';
    }
    if (currentStep === 6) return buildId ? 'Commit to repository' : 'Proceed to commit';
    return 'Proceed to commit';
  };

  // Generate Helm Chart mutation
  const generateHelmChartMutation = useMutation({
    mutationFn: async (description: string) => {
      let stepIdx = 0;
      const HELM_STEPS = [
        'Analysing application requirements...',
        'Designing Chart.yaml and metadata...',
        'Generating values.yaml schema...',
        'Building deployment templates...',
        'Adding service and ingress templates...',
        'Creating _helpers.tpl named templates...',
        'Generating environment overlays...',
        'Finalising Helm chart...',
      ];
      setProgressMessage(HELM_STEPS[0]);
      const interval = setInterval(() => {
        stepIdx = (stepIdx + 1) % HELM_STEPS.length;
        setProgressMessage(HELM_STEPS[stepIdx]);
      }, 3000);
      try {
        const res = await apiRequest('POST', `/api/sessions/${sessionId}/generate-helm-chart`, {
          description,
          options: helmGenOptions,
          ...(helmAppContext ? { appContext: helmAppContext } : {}),
        });
        return res.json();
      } finally {
        clearInterval(interval);
        setProgressMessage('');
      }
    },
    onSuccess: (data) => {
      setHelmChartName(data.chartName || 'my-chart');
      setHelmGenLintResult(data.lintResult || null);
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      setCurrentStep(5);
      toast({ title: '⛵ Helm Chart Generated', description: `Chart "${data.chartName}" with ${data.files?.length ?? 0} files` });
    },
    onError: (error: any) => {
      toast({ title: 'Helm Generation Failed', description: error.message || 'Please try again.', variant: 'destructive' });
    },
  });

  // Progress messages for manifest generation
  const GENERATION_PROGRESS_STEPS = [
    'Sending to AI...',
    'Analyzing workload requirements...',
    'Generating YAML manifests...',
    'Applying security contexts...',
    'Adding resource limits and probes...',
    'Validating resource structure...',
    'Finalizing manifests...',
  ];

  // Generate manifests mutation
  const generateManifestsMutation = useMutation({
    mutationFn: async (description: string) => {
      // Cycle through progress messages while request is in-flight
      let stepIndex = 0;
      setProgressMessage(GENERATION_PROGRESS_STEPS[0]);
      const interval = setInterval(() => {
        stepIndex = Math.min(stepIndex + 1, GENERATION_PROGRESS_STEPS.length - 1);
        setProgressMessage(GENERATION_PROGRESS_STEPS[stepIndex]);
      }, 3000);

      try {
        const res = await apiRequest('POST', `/api/sessions/${sessionId}/generate-kubernetes-manifests`, {
          description,
          options: {
            includeProbes: true,
            includeResourceLimits: true,
            includeSecurityContext: true
          }
        });
        clearInterval(interval);
        return res.json();
      } catch (err) {
        clearInterval(interval);
        throw err;
      }
    },
    onSuccess: async (data) => {
      setProgressMessage('');
      toast({
        title: "✅ Manifests Generated",
        description: `Successfully generated ${data.metadata.totalResources} resource(s)`,
      });
      setCurrentStep(5); // Move to review step
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
      // Auto-validate after generation (best-effort, non-blocking)
      validateManifestsMutation.mutate();
    },
    onError: (error: any) => {
      setProgressMessage('');
      toast({
        title: "Generation Failed",
        description: error.message || "Failed to generate Kubernetes manifests",
        variant: "destructive"
      });
    },
    onSettled: () => {
      setIsGenerating(false);
    }
  });

  // Validate generated manifests (run automatically when entering Step 5)
  const validateManifestsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/validate-kubernetes`, {});
      return res.json();
    },
    onSuccess: (data) => {
      const schemaErrors = data.summary?.schemaErrors ?? 0;
      const warnings = data.summary?.warnings ?? 0;
      setManifestValidationResult({ valid: data.valid ?? schemaErrors === 0, schemaErrors, warnings });
    },
    onError: () => {
      // Validation is best-effort — don't block the user
      setManifestValidationResult(null);
    },
  });

  // Create repository mutation
  const createRepoMutation = useMutation({
    mutationFn: async ({ name, description }: { name: string; description?: string }) => {
      if (!provider) throw new Error('Provider not selected');
      const res = await apiRequest('POST', `/api/repositories/${provider}`, { name, description });

      // Check content type before parsing
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
          throw new Error('Server returned HTML instead of JSON. Please check the server logs.');
        }
        throw new Error(`Unexpected content type: ${contentType}`);
      }

      return res.json();
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/repositories', provider] });
      const repoId = data.id || data.name;
      setSelectedRepo(repoId);
      // Save to localStorage for session restoration
      localStorage.setItem('kubernetes_workflow_repo', repoId);
      toast({
        title: "Repository Created",
        description: `Repository "${data.name}" created successfully!`,
      });
      // Move to next step
      setCurrentStep(3);
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
        message: `Repository "${data.name}" created and selected! ${workflowType === 'manifest'
          ? 'Now describe your Kubernetes workload in natural language.'
          : 'Now upload or select your Helm chart.'}`
      });
    },
    onError: (error: any) => {
      const errorMsg = error.message || "Failed to create repository";
      const cleanMsg = errorMsg
        .replace(/^\d+:\s*/, '')
        .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
        .substring(0, 200);
      toast({
        title: "Creation Failed",
        description: cleanMsg,
        variant: "destructive"
      });
    }
  });

  const commitMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/commit-kubernetes`, {
        commitMessage: commitMessage || undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setIsCommitted(true);
      toast({
        title: "Committed Successfully",
        description: data.message || "Kubernetes manifests pushed to repository.",
      });
      // Auto-redirect home after 3 seconds
      setTimeout(() => {
        localStorage.removeItem('kubernetes_workflow_session_id');
        localStorage.removeItem('kubernetes_workflow_type');
        localStorage.removeItem('kubernetes_workflow_provider');
        localStorage.removeItem('kubernetes_workflow_repo');
        setLocation('/');
      }, 3000);
    },
    onError: (error: any) => {
      toast({
        title: "Commit Failed",
        description: error.message || "Failed to commit files to repository.",
        variant: "destructive",
      });
    },
  });

  const handleWorkflowSelect = async (type: WorkflowType) => {
    setWorkflowType(type);
    setCurrentStep(2);
    // Reset helm-generator scan state when switching workflows
    setHelmScanState('idle');
    setRepoAnalysis(null);
    setRepoScannedFiles([]);
    setHelmAppContext('');
    // Save to localStorage for session restoration
    localStorage.setItem('kubernetes_workflow_type', type || '');

    // Update session via backend (session state will be updated when we proceed)
    // For now, we'll update it when moving to next step

    const workflowName =
      type === 'manifest'
        ? 'Manifest Generation'
        : type === 'helm-generator'
          ? 'Helm Chart Generation'
          : 'Helm Chart Validation';
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
      message: `You selected ${workflowName}. Next, select your repository provider (GitHub or Azure DevOps).`
    });
  };

  const handleProviderSelect = async (selectedProvider: Provider) => {
    setProvider(selectedProvider);
    // Save to localStorage for session restoration
    localStorage.setItem('kubernetes_workflow_provider', selectedProvider || '');

    const providerName = selectedProvider === 'github' ? 'GitHub' : 'Azure DevOps';
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
      message: `You selected ${providerName}. Please select or create a repository.`
    });
  };

  const handleRepoSelect = async (repoId: string) => {
    const repo = repositories.find(r => r.id === repoId);
    const repoName = repo?.name || repoId;
    setSelectedRepo(repoId);
    localStorage.setItem('kubernetes_workflow_repo', repoId);
    setCurrentStep(3);

    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
      message: workflowType === 'helm-generator'
        ? `Repository "${repoName}" selected. Next step: validate repository contents to detect app type and language.`
        : `Repository "${repoName}" selected.`
    });

    // For Helm Generator: wait for explicit validation step
    if (workflowType === 'helm-generator') {
      setHelmScanState('idle');
      setRepoAnalysis(null);
      setHelmAppContext('');
      setRepoScannedFiles([]);
    }
  };

  const validateSelectedRepositoryForHelm = async () => {
    if (!sessionId || !selectedRepo || !provider) return;

    const repo = repositories.find(r => r.id === selectedRepo);
    const repoName = repo?.fullName || repo?.name || selectedRepo;

    setHelmScanState('scanning');
    setRepoAnalysis(null);
    setHelmAppContext('');
    setRepoScannedFiles([]);

    try {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/scan-repo-for-helm`, {
        provider,
        repoName,
        branch: repo?.branch || 'main',
      });
      const data = await res.json();

      if (data.isEmpty) {
        setWorkloadDescription('');
        setHelmScanState('empty');
        return;
      }

      if (data.noAppCode) {
        setHelmScanState('no-app-code');
        return;
      }

      const normalizedAnalysis = {
        appType: data.analysis?.appType || 'generic',
        language: data.analysis?.language || 'unknown',
        framework: data.analysis?.framework || 'generic',
        description: data.analysis?.description || '',
        detectedServices: data.analysis?.detectedServices || [],
        suggestedPort: data.analysis?.suggestedPort || 8080,
        suggestedReplicas: data.analysis?.suggestedReplicas || 2,
      };

      setRepoAnalysis(normalizedAnalysis);
      setRepoScannedFiles(data.scannedFiles || []);
      setHelmAppContext(normalizedAnalysis.description);
      setWorkloadDescription(normalizedAnalysis.description);
      setHelmGenOptions((o: typeof helmGenOptions) => ({ ...o, framework: normalizedAnalysis.framework || o.framework }));
      setHelmScanState('done');
    } catch {
      setHelmScanState('error');
    }
  };

  const handleGoHome = () => {
    setLocation('/');
  };

  // Handle refresh - reset session and state
  const handleRefresh = async () => {
    try {
      localStorage.removeItem('kubernetes_workflow_session_id');
      localStorage.removeItem('kubernetes_workflow_type');
      localStorage.removeItem('kubernetes_workflow_provider');
      localStorage.removeItem('kubernetes_workflow_repo');
      setSessionId('');
      setCurrentStep(1);
      setWorkflowType(null);
      setProvider(null);
      setSelectedRepo('');
      setWorkloadDescription('');
      setIsGenerating(false);
      setValidationResults(null);
      setIsValidating(false);
      setIsCommitted(false);
      setCommitMessage('');
      setScanCompleted(false);
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions'] });
      
      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      localStorage.setItem('kubernetes_workflow_session_id', session.id);

      await apiRequest('PATCH', `/api/sessions/${session.id}`, { activeModule: 'kubernetes' });

      await apiRequest('POST', `/api/sessions/${session.id}/messages/system`, {
        message: 'Welcome to Kubernetes Workflow! Choose a workflow type to get started: Manifest Generation or Helm Chart Validation.'
      });

      queryClient.invalidateQueries({ queryKey: ['/api/sessions', session.id, 'messages'] });
      
      toast({
        title: "Refreshed",
        description: "Started a new session. You can now begin a new Kubernetes workflow.",
      });
    } catch (error: any) {
      console.error('Failed to refresh:', error);
      toast({
        title: "Refresh Failed",
        description: error.message || "Failed to refresh. Please try again.",
        variant: "destructive"
      });
    }
  };

  // Shared describe-form for Helm Generator (new repo or scan fallback)
  const renderHelmDescribeForm = (onBack: () => void, isNewRepo = false) => (
    <Card className="p-5 space-y-4">
      <div className="text-center">
        <h2 className="text-2xl font-bold mb-1">{isNewRepo ? 'New Repository' : 'Describe Your Application'}</h2>
        <p className="text-muted-foreground text-sm">
          {isNewRepo
            ? 'What needs to be generated? Describe your target application and the AI will generate a Helm chart.'
            : 'The AI will generate a complete Helm chart based on your requirements.'}
        </p>
      </div>
      <div>
        <Label className="text-sm font-medium mb-1.5 block">Application description</Label>
        <Textarea
          placeholder="e.g. Node.js REST API with PostgreSQL and Redis cache, 3 replicas in production, exposed via HTTPS ingress on /api..."
          value={workloadDescription}
          onChange={(e) => setWorkloadDescription(e.target.value)}
          className="h-32 font-mono text-sm"
          data-testid="k8s-input-description"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-sm font-medium mb-1.5 block">Framework</Label>
          <select
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={helmGenOptions.framework}
            onChange={(e) => setHelmGenOptions(o => ({ ...o, framework: e.target.value }))}
            data-testid="k8s-select-framework"
          >
            {['generic', 'node', 'python', 'java', 'go', 'dotnet', 'ruby', 'php'].map(f => (
              <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>
            ))}
          </select>
        </div>
        <div className="space-y-2 pt-1">
          <Label className="text-sm font-medium block">Options</Label>
          {([
            { key: 'includeHPA' as const, label: 'Include HPA (autoscaling)' },
            { key: 'includeIngress' as const, label: 'Include Ingress' },
            { key: 'generateEnvOverlays' as const, label: 'Generate dev/prod values' },
          ]).map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={helmGenOptions[key]}
                onChange={(e) => setHelmGenOptions(o => ({ ...o, [key]: e.target.checked }))}
                className="rounded" />
              {label}
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} data-testid="k8s-btn-back">← Back</Button>
        <Button
          onClick={() => { setCurrentStep(4); generateHelmChartMutation.mutate(workloadDescription); }}
          disabled={!workloadDescription.trim() || generateHelmChartMutation.isPending}
          data-testid="k8s-btn-generate"
        >
          <Package2 className="w-4 h-4 mr-2" />Generate Helm Chart
        </Button>
      </div>
    </Card>
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-emerald-50/30 to-white relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-24 -left-20 h-72 w-72 rounded-full bg-emerald-300/20 blur-3xl" />
        <div className="absolute top-24 -right-24 h-80 w-80 rounded-full bg-cyan-300/20 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-violet-300/15 blur-3xl" />
      </div>
      <Header />

      <main className="container mx-auto px-4 py-6 max-w-7xl relative z-10">
        <div className="mb-6 rounded-2xl border border-emerald-100/70 bg-white/80 backdrop-blur-sm px-4 py-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-gradient-to-br from-emerald-100 to-cyan-100 border border-emerald-200/60">
                <Package className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold">Kubernetes Workflow</h1>
                <p className="text-muted-foreground">
                  Generate manifests and validate Helm charts with AI assistance
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isGenerating || isValidating}
                data-testid="k8s-btn-refresh"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleGoHome}
                data-testid="k8s-btn-home"
              >
                <Home className="w-4 h-4 mr-2" />
                Home
              </Button>
            </div>
          </div>
        </div>

        <StepIndicator steps={steps} currentStep={currentStep} />

        {/* Workflow summary bar — visible once a type and repo are chosen */}
        {currentStep >= 3 && workflowType && (
          <div className="px-4 sm:px-6 lg:px-8 mt-2">
            <div className="max-w-6xl mx-auto flex flex-wrap items-center gap-2 py-2 px-3 rounded-xl bg-muted/40 border text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-primary/10 text-primary font-semibold">
                {workflowType === 'manifest' ? <FileCode className="w-3.5 h-3.5" /> : workflowType === 'helm' ? <Package className="w-3.5 h-3.5" /> : workflowType === 'kustomize' ? <FolderOpen className="w-3.5 h-3.5" /> : <Package2 className="w-3.5 h-3.5" />}
                {workflowType === 'manifest' ? 'Manifest Generation' : workflowType === 'helm' ? 'Helm Validation' : workflowType === 'kustomize' ? 'Kustomize' : 'Helm Generator'}
              </span>
              {provider && (
                <span className="inline-flex items-center gap-1.5">
                  <Cloud className="w-3.5 h-3.5" />
                  {provider === 'github' ? 'GitHub' : 'Azure DevOps'}
                </span>
              )}
              {selectedRepo && (
                <span className="inline-flex items-center gap-1.5">
                  <Hash className="w-3.5 h-3.5" />
                  {selectedRepo}
                </span>
              )}
              {generatedFiles.length > 0 && (
                <span className="inline-flex items-center gap-1.5 ml-auto">
                  <FileCode className="w-3.5 h-3.5" />
                  {generatedFiles.length} file{generatedFiles.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
        )}

        <ScrollArea className="flex-1 px-4 sm:px-6 lg:px-8 mt-6">
          <div className="max-w-6xl mx-auto pb-8 space-y-6">

            {/* ── Workflow Progress Card ── */}
            <div className="rounded-xl border bg-card p-5 sm:p-6">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Workflow Progress</h2>
                    <p className="text-sm text-muted-foreground">Structured setup summary for the current Kubernetes session</p>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs">
                    {(buildId || scanCompleted) ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    ) : pipelineRunning ? (
                      <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                    ) : (
                      <Clock3 className="w-4 h-4 text-amber-600" />
                    )}
                    <span className="font-medium">Next Action: {getNextActionLabel()}</span>
                  </div>
                </div>

                {/* Pipeline progress notice — shown during/after build */}
                {currentStep >= 5 && completedPipelineStages.length > 0 && (
                  <div className={`rounded-md border px-3 py-2 text-xs ${
                    buildId
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'
                      : 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300'
                  }`}>
                    {buildId
                      ? `Build ${buildId} completed successfully — ${completedPipelineStages.length} pipeline stages passed`
                      : `Pipeline: ${completedPipelineStages.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' → ')}${pipelineRunning ? ' → ...' : ''}`}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
                  {workflowSummaryItems.map((item) => (
                    <div key={item.label} className="rounded-lg border bg-muted/30 p-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.label}</p>
                      <p className="mt-1 text-sm font-medium break-words">{item.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Step 1: Workflow Selection */}
            {currentStep === 1 && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select Workflow Type</h2>
                  <p className="text-muted-foreground">
                    Choose how you want to work with Kubernetes
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto">
                  <ProviderCard
                    icon={<FileCode className="w-6 h-6" />}
                    title="Manifest Generation"
                    description="Generate Kubernetes manifests from natural language descriptions"
                    onClick={() => handleWorkflowSelect('manifest')}
                    selected={workflowType === 'manifest'}
                    data-testid="card-workflow-manifest"
                  />
                  <ProviderCard
                    icon={<Package className="w-6 h-6" />}
                    title="Helm Chart Validation"
                    description="Validate and lint Helm charts with best practice checks"
                    onClick={() => handleWorkflowSelect('helm')}
                    selected={workflowType === 'helm'}
                    data-testid="card-workflow-helm"
                  />
                  <ProviderCard
                    icon={<FolderOpen className="w-6 h-6" />}
                    title="Kustomize"
                    description="Build and validate Kustomize overlays from a directory"
                    onClick={() => handleWorkflowSelect('kustomize')}
                    selected={workflowType === 'kustomize'}
                    data-testid="card-workflow-kustomize"
                  />
                  <ProviderCard
                    icon={<Package2 className="w-6 h-6" />}
                    title="Generate Helm Chart"
                    description="AI generates Chart.yaml, templates/, values.yaml + dev/prod overlays from a description"
                    onClick={() => handleWorkflowSelect('helm-generator')}
                    selected={workflowType === 'helm-generator'}
                    data-testid="card-workflow-helm-generator"
                  />
                </div>
              </div>
            )}

            {/* Step 2: Repository Selection */}
            {currentStep === 2 && (
              <div className="space-y-6">
                {!provider ? (
                  <>
                    <div className="text-center">
                      <h2 className="text-2xl font-bold mb-2">Select Repository Provider</h2>
                      <p className="text-muted-foreground">
                        Choose where to store your Kubernetes manifests or Helm charts
                      </p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                      {config?.hasGithub && (
                        <ProviderCard
                          icon={<FileCode className="w-6 h-6" />}
                          title="GitHub"
                          description="Use GitHub repositories for your Kubernetes configurations"
                          onClick={() => handleProviderSelect('github')}
                          selected={provider === 'github'}
                          provider="github"
                          fillBackground={true}
                          data-testid="card-provider-github"
                        />
                      )}
                      {config?.hasAzureDevOps && (
                        <ProviderCard
                          icon={<Cloud className="w-6 h-6" />}
                          title="Azure DevOps"
                          description="Use Azure DevOps repositories for your Kubernetes configurations"
                          onClick={() => handleProviderSelect('azure')}
                          selected={provider === 'azure'}
                          provider="azure"
                          fillBackground={true}
                          data-testid="card-provider-azure"
                        />
                      )}
                      {!config?.hasGithub && !config?.hasAzureDevOps && (
                        <div className="col-span-2 text-center py-12">
                          <p className="text-muted-foreground mb-4">No repository providers configured.</p>
                          <Button onClick={() => setLocation('/settings')} data-testid="k8s-btn-settings">Go to Settings</Button>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="space-y-6">
                    <div className="text-center">
                      <h2 className="text-2xl font-bold mb-2">Select Repository</h2>
                      <p className="text-muted-foreground">
                        Choose an existing repository or create a new one
                      </p>
                    </div>
                    
                    <div className="flex gap-4 mb-4">
                      <Button
                        variant="outline"
                        onClick={() => setProvider(null)}
                        data-testid="k8s-btn-back-provider"
                      >
                        ← Back
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      <RepositoryList
                        repositories={repositories}
                        selectedId={selectedRepo}
                        onSelect={handleRepoSelect}
                        showSearch={provider === 'github'}
                      />
                      {provider && (
                        <CreateRepoForm
                          onSubmit={(name: string, description?: string) => {
                            createRepoMutation.mutate({ name, description });
                          }}
                          loading={createRepoMutation.isPending}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Step 3: Describe Workload (Manifest Generation) */}
            {currentStep === 3 && workflowType === 'manifest' && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Describe Your Kubernetes Workload</h2>
                  <p className="text-muted-foreground">
                    Describe what you want to deploy in natural language
                  </p>
                </div>

                <div className="max-w-3xl mx-auto">
                  <ChatInput
                    onSend={(message) => {
                      setWorkloadDescription(message);
                      setIsGenerating(true);
                      generateManifestsMutation.mutate(message);
                    }}
                    placeholder="e.g., Deploy a Node.js app with 3 replicas, exposed via LoadBalancer, with environment variables from ConfigMap"
                    disabled={isGenerating || generateManifestsMutation.isPending}
                  />

                  {isGenerating && (
                    <div className="mt-4 flex items-center gap-3 p-4 bg-muted rounded-lg">
                      <Loader2 className="w-5 h-5 animate-spin text-primary" />
                      <p className="text-sm text-muted-foreground">
                        Generating Kubernetes manifests... This may take a moment.
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex gap-4 justify-center">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setCurrentStep(2);
                      setSelectedRepo('');
                    }}
                    data-testid="k8s-btn-back-step3"
                  >
                    ← Back
                  </Button>
                </div>
              </div>
            )}

            {/* Step 4: Generate (Manifest Generation) - Shows during generation */}
            {currentStep === 4 && workflowType === 'manifest' && (
              <div className="text-center py-12 space-y-4">
                <Loader2 className="w-12 h-12 animate-spin mx-auto text-primary" />
                <p className="text-lg font-medium">
                  {progressMessage || 'Generating Kubernetes manifests...'}
                </p>
                <div className="flex justify-center gap-1.5 mt-2">
                  {['Sending', 'Analyzing', 'Generating', 'Security', 'Resources', 'Validating', 'Finalizing'].map((label, i) => {
                    const currentIdx = ['Sending to AI...', 'Analyzing workload requirements...', 'Generating YAML manifests...', 'Applying security contexts...', 'Adding resource limits and probes...', 'Validating resource structure...', 'Finalizing manifests...'].indexOf(progressMessage);
                    const done = currentIdx > i;
                    const active = currentIdx === i;
                    return (
                      <div
                        key={label}
                        title={label}
                        className={`h-1.5 w-8 rounded-full transition-colors duration-500 ${done ? 'bg-primary' : active ? 'bg-primary/60' : 'bg-muted'}`}
                      />
                    );
                  })}
                </div>
                <p className="text-sm text-muted-foreground">This may take 15–30 seconds</p>
              </div>
            )}

            {/* ════════════════════════════════════════════════════
                 Step 5: Build Workspace (ALL workflow types)
                 Overview / Build / Code 3-tab layout
            ════════════════════════════════════════════════════ */}
            {currentStep === 5 && (() => {
              const allContent = (generatedFiles ?? []).map(f => f.content ?? '').join('\n');
              const manifestCount = (allContent.match(/^kind:\s*\w+/gm) ?? []).length;
              const uniqueKinds = Array.from(new Set(
                (allContent.match(/^kind:\s*(\w+)/gm) ?? []).map(m => m.replace(/^kind:\s*/, ''))
              ));
              const totalLines = allContent ? allContent.split('\n').length : 0;
              const namespaceCount = (allContent.match(/^kind:\s*Namespace/gm) ?? []).length;
              const serviceCount = (allContent.match(/^kind:\s*Service/gm) ?? []).length;
              const containerCount = (allContent.match(/^\s{6,}-\s+name:/gm) ?? []).length;
              const workflowTypeLabel = workflowType === 'helm-generator' ? 'HELM' : workflowType === 'helm' ? 'HELM' : workflowType === 'compose-to-k8s' ? 'COMPOSE' : 'MANIFEST';

              return (
                <div className="space-y-6">
                  {/* Header */}
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight">Build Workspace</h2>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {(generatedFiles ?? []).length > 0
                        ? `${generatedFiles.length} file${generatedFiles.length !== 1 ? 's' : ''} generated · ${workflowTypeLabel} infrastructure ready`
                        : 'Your manifests are being prepared…'}
                    </p>
                  </div>

                  {/* ── Tab bar ── */}
                  <div className="flex gap-2 p-1 rounded-xl bg-muted/60">
                    {(['overview', 'build', 'code', 'report'] as const).map(mode => (
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

                  {/* ── OVERVIEW TAB ── */}
                  {activityViewMode === 'overview' && (
                    <div className="space-y-6">

                      {/* KPI cards */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {[
                          { label: 'Files',      value: (generatedFiles ?? []).length,  sub: 'generated',  icon: FileCode, color: 'text-blue-500',    bg: 'bg-blue-50 dark:bg-blue-950/30' },
                          { label: 'Lines',      value: totalLines.toLocaleString(),    sub: 'of YAML',    icon: Hash,     color: 'text-violet-500',  bg: 'bg-violet-50 dark:bg-violet-950/30' },
                          { label: 'Manifests',  value: manifestCount,                  sub: 'declared',   icon: Box,      color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/30' },
                          { label: 'Type',       value: workflowTypeLabel,              sub: 'workflow',   icon: Layers,   color: 'text-orange-500',  bg: 'bg-orange-50 dark:bg-orange-950/30' },
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

                      {/* Build status sentence — matches Terraform Overview pattern */}
                      <p className="text-xs text-muted-foreground">
                        {buildAutoRun || pipelineRunning
                          ? 'Build pipeline is running. Stay in Build Pipeline tab for live stage status.'
                          : buildId
                            ? `Build ${buildId} completed successfully. You can proceed to commit.`
                            : scanCompleted
                              ? 'Build stage completed. Proceed to commit when ready.'
                              : 'Run Build Pipeline to validate architecture, best-practice, and security gates.'}
                      </p>
                    </div>
                  )}

                  {/* ── BUILD TAB ── */}
                  {activityViewMode === 'build' && (
                    <div className="space-y-4">
                      <ActivityPanel
                        sessionId={sessionId}
                        workflowType="kubernetes"
                        pipelineLayout="sidebar"
                        autoRun={buildAutoRun}
                        onRequestRunPipeline={() => {
                          setBuildAutoRun(false);
                          setPipelineRunning(true);
                          setCompletedPipelineStages([]);
                        }}
                        onDiagramResult={(result) => { setBuildDiagramResult(result); }}
                        onViewBuildSummary={() => setActivityViewMode('overview')}
                        onScanResult={(result) => { setBuildScanResult(result); }}
                        onScanComplete={() => {
                          // Files may have been updated by security fixes; refresh but don't unlock commit yet
                          // (commit is unlocked only after full pipeline approval via onPipelineComplete)
                          queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                        }}
                        onFixesApproved={() => {
                          queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                          toast({
                            title: 'Changes approved',
                            description: 'Manifests were updated when you ran Fix. Refreshing files — continuing to Security scan.',
                          });
                        }}
                        onPipelineStageComplete={(stage) => {
                          setCompletedPipelineStages(prev => [...prev, stage]);
                        }}
                        onPipelineComplete={async () => {
                          setBuildAutoRun(false);
                          setPipelineRunning(false);
                          setScanCompleted(true);
                          setCompletedPipelineStages(['diagram', 'validate', 'security']);
                          const id = generateBuildId('kubernetes');
                          try {
                            const [ssRes, rsRes, pcRes] = await Promise.all([
                              fetch(`/api/sessions/${sessionId}/security-score`, { method: 'POST' }),
                              fetch(`/api/sessions/${sessionId}/rightsize-kubernetes`, { method: 'POST' }),
                              fetch(`/api/sessions/${sessionId}/policy-check`, { method: 'POST' }),
                            ]);
                            const [ss, rs, pc] = await Promise.all([ssRes.json(), rsRes.json(), pcRes.json()]);
                            if (ss.score) setSecurityScore(ss.score);
                            if (rs.result) setRightsizingResult(rs.result);
                            if (pc.success) setPolicyCheckResult(pc);
                          } catch (_) { /* non-fatal */ }
                          await saveBuildHistory({
                            sessionId: sessionId!,
                            module: workflowType === 'helm-generator' ? 'helm' : 'kubernetes',
                            buildId: id,
                            pipelineStages: ['diagram', 'validate', 'security'],
                            filesGenerated: generatedFiles?.length || 0,
                            repositoryName: selectedRepo || undefined,
                          });
                          setBuildId(id);
                          // Auto-navigate to overview so build complete status is visible
                          setActivityViewMode('overview');
                          toast({ title: 'Build Complete', description: `${id} — ready to commit.` });
                        }}
                      />
                    </div>
                  )}

                  {/* ── CODE TAB ── */}
                  {activityViewMode === 'code' && (
                    <div className="space-y-3">
                      <div className="rounded-2xl border bg-card overflow-hidden">
                        {(generatedFiles ?? []).length > 0 ? (
                          <CodeEditor
                            files={generatedFiles.map(f => ({ name: f.fileName, content: f.content }))}
                            onFileChange={async (fileName, content) => {
                              await apiRequest('POST', `/api/sessions/${sessionId}/files`, { fileName, content });
                              queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
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

                  {/* ── REPORT TAB ── */}
                  {activityViewMode === 'report' && (
                    <div className="space-y-6">
                      {/* Header */}
                      <div className="flex items-center justify-between">
                        <div>
                          <h2 className="text-xl font-bold flex items-center gap-2">
                            <FileText className="w-5 h-5 text-primary" />
                            Build Report
                          </h2>
                          {buildId && (
                            <p className="text-xs text-muted-foreground font-mono mt-0.5">{buildId} · {workflowType === 'helm-generator' ? 'Helm Generator' : workflowType === 'manifest' ? 'Kubernetes Manifests' : workflowType}</p>
                          )}
                        </div>
                        <Button variant="outline" size="sm" className="gap-2 print:hidden" onClick={() => window.print()}>
                          <Download className="w-3.5 h-3.5" /> Download PDF
                        </Button>
                      </div>

                      {/* ── Architecture Diagram ── */}
                      <div className="rounded-2xl border bg-card overflow-hidden">
                        <div className="px-5 py-3 border-b bg-muted/40 flex items-center gap-2">
                          <Network className="w-4 h-4 text-primary" />
                          <span className="font-semibold text-sm">Architecture Diagram</span>
                        </div>
                        {buildDiagramResult?.mermaidSyntax ? (
                          <div className="p-4">
                            <ArchitectureDiagramPreview mermaidSyntax={buildDiagramResult.mermaidSyntax} />
                          </div>
                        ) : (
                          <div className="p-8 text-center text-muted-foreground text-sm">
                            No diagram data — run the Build pipeline to generate the architecture diagram.
                          </div>
                        )}
                      </div>

                      {/* ── Security Scan Results ── */}
                      <div className="rounded-2xl border bg-card overflow-hidden">
                        <div className="px-5 py-3 border-b bg-muted/40 flex items-center gap-2">
                          <Shield className="w-4 h-4 text-primary" />
                          <span className="font-semibold text-sm">Security Scan Results</span>
                        </div>
                        {buildScanResult ? (
                          <div className="p-5 space-y-4">
                            {/* KPI row */}
                            <div className="grid grid-cols-3 gap-4">
                              {[
                                { label: 'Passed', value: buildScanResult.summary?.passed ?? 0, color: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-950/30' },
                                { label: 'Failed', value: buildScanResult.summary?.failed ?? 0, color: 'text-rose-600', bg: 'bg-rose-50 dark:bg-rose-950/30' },
                                { label: 'Pass Rate', value: `${buildScanResult.summary?.passPercentage ?? 0}%`, color: 'text-primary', bg: 'bg-primary/5' },
                              ].map(({ label, value, color, bg }) => (
                                <div key={label} className={`rounded-xl border p-3 text-center ${bg}`}>
                                  <p className={`text-2xl font-bold ${color}`}>{value}</p>
                                  <p className="text-xs text-muted-foreground">{label}</p>
                                </div>
                              ))}
                            </div>
                            {/* Failed checks */}
                            {(buildScanResult.failedChecks ?? []).length > 0 && (
                              <div className="space-y-2">
                                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Failed Checks ({buildScanResult.failedChecks.length})</p>
                                <div className="space-y-2">
                                  {buildScanResult.failedChecks.map((c: any, i: number) => (
                                    <div key={i} className="rounded-xl border border-rose-200 dark:border-rose-900 bg-rose-50/50 dark:bg-rose-950/20 p-3 space-y-1">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-mono text-xs font-semibold text-rose-700 dark:text-rose-400">{c.checkId}</span>
                                        <span className="text-xs font-medium">{c.checkName}</span>
                                      </div>
                                      <p className="text-xs text-muted-foreground">{c.reason || c.guideline}</p>
                                      {c.resource && <p className="text-xs text-muted-foreground font-mono">Resource: {c.resource}</p>}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {(buildScanResult.failedChecks ?? []).length === 0 && (
                              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl border border-emerald-200 dark:border-emerald-800 px-4 py-3">
                                <CheckCircle2 className="w-4 h-4 shrink-0" />
                                <span className="text-sm font-medium">All security checks passed!</span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="p-8 text-center text-muted-foreground text-sm">
                            No scan data — run the Build pipeline to generate security results.
                          </div>
                        )}
                      </div>

                      {/* Best Practices / Security Score summary */}
                      {securityScore && (
                        <div className="rounded-2xl border bg-card overflow-hidden">
                          <div className="px-5 py-3 border-b bg-muted/40 flex items-center gap-2">
                            <ShieldCheck className="w-4 h-4 text-primary" />
                            <span className="font-semibold text-sm">Security Context Score</span>
                          </div>
                          <div className="p-5 flex items-center gap-6">
                            <div className={`text-5xl font-bold ${securityScore.overallScore >= 75 ? 'text-emerald-600' : securityScore.overallScore >= 50 ? 'text-yellow-600' : 'text-rose-600'}`}>
                              {securityScore.grade}
                            </div>
                            <div>
                              <div className="text-2xl font-semibold">{securityScore.overallScore}/100</div>
                              <div className="text-xs text-muted-foreground">{securityScore.totalWorkloads} workload(s) analysed</div>
                            </div>
                            <div className="flex-1 grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                              {[
                                { label: 'runAsNonRoot', val: securityScore.metrics?.runAsNonRoot?.percent },
                                { label: 'readOnlyRootFS', val: securityScore.metrics?.readOnlyRootFilesystem?.percent },
                                { label: 'Resource Limits', val: securityScore.metrics?.resourceLimitsDefined?.percent },
                              ].map(m => (
                                <div key={m.label} className="bg-muted/50 rounded p-2">
                                  <div className="font-medium">{m.label}</div>
                                  <div className={m.val === 100 ? 'text-emerald-600' : 'text-yellow-600'}>{m.val ?? 0}%</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Navigation ── */}
                  <div className="space-y-3 pt-2">
                    {buildId && (
                      <div className="flex justify-center">
                        <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-mono font-semibold bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {buildId}
                        </span>
                      </div>
                    )}
                    <div className="flex gap-3 justify-center">
                      <Button variant="outline" onClick={() => setCurrentStep(3)} data-testid="k8s-btn-back">← Back</Button>
                      <Button
                        disabled={!scanCompleted}
                        title={!scanCompleted ? 'Run the Build pipeline first to continue' : undefined}
                        data-testid="k8s-btn-continue-to-commit"
                        onClick={() => {
                          setCurrentStep(6);
                          apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '6' });
                        }}
                      >
                        {!scanCompleted ? (
                          <><Clock3 className="w-4 h-4 mr-1.5 opacity-50" /> Awaiting Build…</>
                        ) : (
                          <><CheckCircle2 className="w-4 h-4 mr-1.5" /> Continue to Commit →</>
                        )}
                      </Button>
                    </div>
                    {!scanCompleted && (
                      <p className="text-center text-xs text-muted-foreground">
                        Switch to the <button className="underline underline-offset-2 hover:text-foreground" onClick={() => setActivityViewMode('build')}>Build tab</button> and run the pipeline to unlock commit.
                      </p>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Step 3: Upload/Select Helm Chart */}
            {currentStep === 3 && workflowType === 'helm' && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Upload or Select Helm Chart</h2>
                  <p className="text-muted-foreground">Upload a packaged Helm chart to validate</p>
                </div>

                <div className="max-w-3xl mx-auto space-y-6">
                  {/* Upload Option */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Upload className="w-5 h-5" />
                        Upload Helm Chart
                      </CardTitle>
                      <CardDescription>Upload a packaged Helm chart archive</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        {/* File Upload */}
                        <div className="space-y-2">
                          <Label>Upload Helm Chart (.tgz, .tar.gz)</Label>
                          <Input
                            type="file"
                            accept=".tgz,.tar.gz"
                            onChange={(e) => setHelmFile(e.target.files?.[0] || null)}
                            data-testid="k8s-input-helm-upload"
                          />
                          {helmFile && (
                            <p className="text-xs text-green-600">Selected: {helmFile.name}</p>
                          )}
                        </div>

                        <Button
                          onClick={async () => {
                            if (helmFile) {
                              setIsValidating(true);
                              setCurrentStep(4);
                              const formData = new FormData();
                              formData.append('chart', helmFile);
                              try {
                                const token = localStorage.getItem('token') || sessionStorage.getItem('token');
                                const res = await fetch(`/api/sessions/${sessionId}/upload-helm-chart`, {
                                  method: 'POST',
                                  body: formData,
                                  headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                                  credentials: 'include',
                                });
                                const data = await res.json();
                                if (!res.ok) {
                                  const errorMessage = [data?.error, data?.details].filter(Boolean).join(': ') || 'Upload failed';
                                  throw new Error(errorMessage);
                                }
                                setValidationResults(data.validation);
                                setCurrentStep(5);
                                toast({ title: '✅ Chart Uploaded & Validated', description: `${helmFile.name} processed successfully.` });
                              } catch (err: any) {
                                toast({ title: 'Upload Failed', description: err.message, variant: 'destructive' });
                                setCurrentStep(3);
                              } finally {
                                setIsValidating(false);
                              }
                            } else {
                              toast({ title: 'Input Required', description: 'Upload a Helm chart archive to continue.', variant: 'destructive' });
                            }
                          }}
                          disabled={!helmFile || isValidating}
                          className="w-full"
                          data-testid="k8s-btn-upload-validate"
                        >
                          {isValidating ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              Uploading & Validating...
                            </>
                          ) : (
                            <>
                              <Upload className="w-4 h-4 mr-2" />
                              Upload & Validate
                            </>
                          )}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Repository Option (Placeholder) */}
                  <Card className="opacity-60">
                    <CardHeader>
                      <CardTitle>Select from Repository</CardTitle>
                      <CardDescription>
                        Select a Helm chart from the repository
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        Repository chart selection will be available in a future update.
                      </p>
                    </CardContent>
                  </Card>
                </div>

                <div className="flex gap-4 justify-center">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setCurrentStep(2);
                      setSelectedRepo('');
                    }}
                    data-testid="k8s-btn-back"
                  >
                    ← Back
                  </Button>
                </div>
              </div>
            )}

            {/* Step 3: Kustomize — Enter directory path */}
            {currentStep === 3 && workflowType === 'kustomize' && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Kustomize Directory</h2>
                  <p className="text-muted-foreground">Enter the path to your Kustomize overlay directory</p>
                </div>
                <Card className="max-w-xl mx-auto">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <FolderOpen className="w-5 h-5" />
                      Kustomization Directory
                    </CardTitle>
                    <CardDescription>
                      The directory must contain a kustomization.yaml or kustomization.yml file.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Input
                      type="text"
                      placeholder="e.g., ./overlays/production"
                      value={kustomizePath}
                      onChange={(e) => setKustomizePath(e.target.value)}
                      data-testid="k8s-input-kustomize-path"
                    />
                    <Button
                      className="w-full"
                      disabled={!kustomizePath.trim() || isValidating}
                      onClick={async () => {
                        setIsValidating(true);
                        setCurrentStep(4);
                        try {
                          const res = await fetch(`/api/sessions/${sessionId}/build-kustomize`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ kustomizationDir: kustomizePath.trim() }),
                          });
                          const data = await res.json();
                          if (!res.ok) throw new Error(data.error || 'Kustomize build failed');
                          if (data.success) {
                            toast({ title: '✅ Kustomize Built', description: `${data.resourceCount} resource(s) rendered.` });
                            setCurrentStep(5);
                          } else {
                            toast({ title: '⚠️ Build Issues', description: data.errors?.join('; ') || 'Check directory path.', variant: 'destructive' });
                            setCurrentStep(3);
                          }
                        } catch (err: any) {
                          toast({ title: 'Build Failed', description: err.message, variant: 'destructive' });
                          setCurrentStep(3);
                        } finally {
                          setIsValidating(false);
                        }
                      }}
                    >
                      {isValidating ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Building...</>
                      ) : (
                        <><FolderOpen className="w-4 h-4 mr-2" /> Build Kustomize</>
                      )}
                    </Button>
                  </CardContent>
                </Card>
                <div className="flex gap-4 justify-center">
                  <Button variant="outline" onClick={() => setCurrentStep(2)} data-testid="k8s-btn-back">← Back</Button>
                </div>
              </div>
            )}

            {/* Step 3: Helm Generator — auto-scan result → describe → generate */}
            {currentStep === 3 && workflowType === 'helm-generator' && (
              <div className="max-w-2xl mx-auto space-y-5">

                {/* Validate action */}
                {helmScanState === 'idle' && (
                  <Card className="p-6 space-y-4">
                    <div className="text-center space-y-2">
                      <h2 className="text-2xl font-bold">Validate Repository</h2>
                      <p className="text-muted-foreground text-sm">
                        Validate repository contents to detect application type and language before Helm generation.
                      </p>
                    </div>
                    <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                      <span className="text-muted-foreground">Selected repository: </span>
                      <span className="font-medium">{selectedRepo || 'Not selected'}</span>
                    </div>
                    <div className="flex gap-3">
                      <Button variant="outline" onClick={() => setCurrentStep(2)} data-testid="k8s-btn-back-helm-repo">← Back</Button>
                      <Button onClick={validateSelectedRepositoryForHelm} disabled={!selectedRepo || !provider} data-testid="k8s-btn-validate-repo">
                        Validate Repository
                      </Button>
                    </div>
                  </Card>
                )}

                {/* Scanning spinner */}
                {helmScanState === 'scanning' && (
                  <Card className="p-10 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <Loader2 className="w-10 h-10 animate-spin text-primary" />
                      <p className="font-semibold text-lg">Validating Repository...</p>
                      <p className="text-sm text-muted-foreground">Reading application files and detecting framework, services, and port configuration.</p>
                    </div>
                  </Card>
                )}

                {/* Scan error */}
                {helmScanState === 'error' && (
                  <Card className="p-6 space-y-4">
                    <Alert variant="destructive">
                      <AlertCircle className="w-4 h-4" />
                      <AlertTitle>Repository validation failed</AlertTitle>
                      <AlertDescription>Retry validation, or describe the application manually and continue.</AlertDescription>
                    </Alert>
                    <div className="flex gap-3">
                      <Button variant="outline" onClick={() => setCurrentStep(2)}>← Back</Button>
                      <Button variant="secondary" onClick={validateSelectedRepositoryForHelm}>Retry Validation</Button>
                    </div>
                    {renderHelmDescribeForm(() => setCurrentStep(2))}
                  </Card>
                )}

                {/* Empty / new repo */}
                {helmScanState === 'empty' && renderHelmDescribeForm(() => setCurrentStep(2), true)}

                {/* Repo has files but no application code detected */}
                {helmScanState === 'no-app-code' && (
                  <Card className="p-6 space-y-4">
                    <Alert variant="destructive">
                      <XCircle className="w-4 h-4" />
                      <AlertTitle>No Application Detected</AlertTitle>
                      <AlertDescription>
                        The repository contains files but no recognisable application code was found
                        (e.g. package.json, Dockerfile, requirements.txt, go.mod, pom.xml).
                        Helm chart generation requires an application codebase to analyse.
                      </AlertDescription>
                    </Alert>
                    <div className="flex gap-3">
                      <Button variant="outline" onClick={() => setCurrentStep(2)}>← Select Another Repo</Button>
                      <Button variant="secondary" onClick={validateSelectedRepositoryForHelm}>Retry</Button>
                    </div>
                  </Card>
                )}

                {/* Existing repo: show analysis + editable description */}
                {helmScanState === 'done' && repoAnalysis && (
                  <Card className="p-5 space-y-4">
                    {/* Analysis summary banner */}
                    <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 p-4 space-y-2">
                      <div className="flex items-center gap-2 font-semibold text-emerald-800 dark:text-emerald-300">
                        <CheckCircle2 className="w-4 h-4" />Repository Validated
                      </div>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                        <span className="text-muted-foreground">Application type</span>
                        <span className="font-medium capitalize">{repoAnalysis.appType}</span>
                        <span className="text-muted-foreground">Language used</span>
                        <span className="font-medium capitalize">{repoAnalysis.language}</span>
                        <span className="text-muted-foreground">Framework</span>
                        <span className="font-medium capitalize">{repoAnalysis.framework}</span>
                        <span className="text-muted-foreground">Port</span>
                        <span className="font-medium">{repoAnalysis.suggestedPort}</span>
                        <span className="text-muted-foreground">Replicas</span>
                        <span className="font-medium">{repoAnalysis.suggestedReplicas}</span>
                        {repoAnalysis.detectedServices.length > 0 && (
                          <>
                            <span className="text-muted-foreground">Services</span>
                            <span className="font-medium">{repoAnalysis.detectedServices.join(', ')}</span>
                          </>
                        )}
                        {repoScannedFiles.length > 0 && (
                          <>
                            <span className="text-muted-foreground">Files scanned</span>
                            <span className="font-medium text-xs">{repoScannedFiles.join(', ')}</span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Editable description */}
                    <div>
                      <Label className="text-sm font-medium mb-1.5 block">Application description <span className="text-muted-foreground font-normal">(edit if needed)</span></Label>
                      <Textarea
                        value={workloadDescription}
                        onChange={(e) => { setWorkloadDescription(e.target.value); setHelmAppContext(e.target.value); }}
                        className="h-28 font-mono text-sm"
                        data-testid="k8s-input-description"
                      />
                    </div>

                    {/* Options */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label className="text-sm font-medium mb-1.5 block">Framework</Label>
                        <select
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          value={helmGenOptions.framework}
                          onChange={(e) => setHelmGenOptions(o => ({ ...o, framework: e.target.value }))}
                        >
                          {['generic', 'node', 'python', 'java', 'go', 'dotnet', 'ruby', 'php'].map(f => (
                            <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2 pt-1">
                        <Label className="text-sm font-medium block">Options</Label>
                        {([
                          { key: 'includeHPA' as const, label: 'Include HPA (autoscaling)' },
                          { key: 'includeIngress' as const, label: 'Include Ingress' },
                          { key: 'generateEnvOverlays' as const, label: 'Generate dev/prod values' },
                        ]).map(({ key, label }) => (
                          <label key={key} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input type="checkbox" checked={helmGenOptions[key]}
                              onChange={(e) => setHelmGenOptions(o => ({ ...o, [key]: e.target.checked }))}
                              className="rounded" />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="flex gap-3">
                      <Button variant="outline" onClick={() => setCurrentStep(2)} data-testid="k8s-btn-back">← Back</Button>
                      <Button
                        onClick={() => { setCurrentStep(4); generateHelmChartMutation.mutate(workloadDescription); }}
                        disabled={!workloadDescription.trim() || generateHelmChartMutation.isPending}
                        data-testid="k8s-btn-generate"
                      >
                        <Package2 className="w-4 h-4 mr-2" />Generate Helm Chart
                      </Button>
                    </div>
                  </Card>
                )}
              </div>
            )}

            {/* Step 4: Helm Generator — Generation spinner */}
            {currentStep === 4 && workflowType === 'helm-generator' && (
              <Card className="rounded-2xl border-dashed border-border/40 bg-white/80 p-10 text-center shadow-lg">
                <div className="flex flex-col items-center gap-4">
                  <Loader2 className="w-10 h-10 animate-spin text-primary" />
                  <p className="text-xl font-semibold text-slate-900">Generating Helm Chart...</p>
                  {progressMessage && (
                    <p className="text-sm text-primary font-medium transition-all duration-500">{progressMessage}</p>
                  )}
                  {/* 8-segment progress bar */}
                  <div className="flex gap-1.5 mt-1">
                    {[0,1,2,3,4,5,6,7].map((i) => {
                      const steps8 = [
                        'Analysing application requirements...',
                        'Designing Chart.yaml and metadata...',
                        'Generating values.yaml schema...',
                        'Building deployment templates...',
                        'Adding service and ingress templates...',
                        'Creating _helpers.tpl named templates...',
                        'Generating environment overlays...',
                        'Finalising Helm chart...',
                      ];
                      const idx = steps8.indexOf(progressMessage);
                      return (
                        <div key={i} className={`h-1.5 w-7 rounded-full transition-colors duration-300
                          ${idx > i ? 'bg-primary' : idx === i ? 'bg-primary/50' : 'bg-muted'}`} />
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Generating 8–12 files · typically 20–30 seconds</p>
                </div>
              </Card>
            )}


            {/* Step 4: Build (Kustomize) - shows during build */}
            {currentStep === 4 && workflowType === 'kustomize' && (
              <div className="text-center py-12">
                <Loader2 className="w-12 h-12 animate-spin mx-auto mb-4 text-primary" />
                <p className="text-muted-foreground">Building Kustomize overlay...</p>
              </div>
            )}

            {/* Step 4: Validate (Helm Chart) - Shows during validation */}
            {currentStep === 4 && workflowType === 'helm' && (
              <div className="text-center py-12">
                <Loader2 className="w-12 h-12 animate-spin mx-auto mb-4 text-primary" />
                <p className="text-muted-foreground">
                  Validating Helm chart...
                </p>
              </div>
            )}

            {/* Step 6: Commit & Push */}
            {currentStep === 6 && (
              <div className="space-y-6">
                {/* Build ID badge */}
                {buildId && (
                  <div className="flex justify-center">
                    <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-mono font-semibold bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {buildId}
                    </span>
                  </div>
                )}
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Commit & Push</h2>
                  <p className="text-muted-foreground">
                    Review your files and commit them to the repository
                  </p>
                </div>

                {isCommitted ? (
                  <div className="flex flex-col items-center gap-6 py-12">
                    <div className="w-20 h-20 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
                      <CheckCircle2 className="w-10 h-10 text-emerald-600" />
                    </div>
                    <div className="text-center space-y-1">
                      <h3 className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">Successfully Committed!</h3>
                      {buildId && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-semibold bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700">
                          <Hash className="w-3 h-3" />{buildId}
                        </span>
                      )}
                      <p className="text-sm text-muted-foreground mt-2">
                        Your Kubernetes manifests have been committed to the repository.
                        <br />Redirecting to home in a moment…
                      </p>
                    </div>
                    <Button onClick={handleGoHome} data-testid="button-go-home" className="gap-2">
                      <Home className="w-4 h-4" /> Go to Home
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-6 max-w-3xl mx-auto">
                    {/* File Review */}
                    {generatedFiles.length > 0 && (
                      <Card>
                        <CardHeader>
                          <CardTitle>Files to Commit</CardTitle>
                          <CardDescription>
                            {generatedFiles.length} file(s) will be committed
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-2 max-h-48 overflow-y-auto">
                            {generatedFiles.map((file, idx) => (
                              <div key={idx} className="flex items-center gap-2 p-2 rounded bg-muted">
                                <FileText className="w-4 h-4 text-muted-foreground" />
                                <span className="text-sm font-mono">{file.fileName}</span>
                                <span className="text-xs text-muted-foreground ml-auto">
                                  {file.content.length} chars
                                </span>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {/* Commit Message */}
                    <Card>
                      <CardHeader>
                        <CardTitle>Commit Message</CardTitle>
                        <CardDescription>
                          Enter a commit message or leave empty to auto-generate one
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          <Label htmlFor="commit-message">Commit Message</Label>
                          <Textarea
                            id="commit-message"
                            placeholder="e.g., Add Kubernetes manifests for production deployment"
                            value={commitMessage}
                            onChange={(e) => setCommitMessage(e.target.value)}
                            rows={3}
                            data-testid="k8s-input-commit-message"
                          />
                        </div>
                      </CardContent>
                    </Card>

                    {/* Commit Button */}
                    <div className="flex gap-4 justify-center">
                      <Button
                        variant="outline"
                        onClick={() => setCurrentStep(5)}
                        data-testid="k8s-btn-back"
                      >
                        ← Back
                      </Button>
                      <Button
                        onClick={() => commitMutation.mutate()}
                        disabled={commitMutation.isPending || generatedFiles.length === 0}
                        className="flex-1"
                        data-testid="k8s-btn-commit"
                      >
                        {commitMutation.isPending ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Committing...
                          </>
                        ) : (
                          <>
                            <FileCode className="w-4 h-4 mr-2" />
                            Commit & Push
                          </>
                        )}
                      </Button>
                    </div>

                    {generatedFiles.length === 0 && (
                      <p className="text-sm text-muted-foreground text-center">
                        No files to commit. Please generate manifests first.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Placeholder for unexpected steps */}
            {(currentStep > 6 && !(currentStep === 5 && workflowType === 'helm' && validationResults)) && (
              <div className="text-center py-12">
                <div className="space-y-4">
                  <div className="p-4 bg-muted rounded-lg">
                    <h3 className="text-lg font-semibold mb-2">
                      {workflowType === 'helm' ? 'Helm Chart Validation' : 'Next Steps'}
                    </h3>
                    <p className="text-muted-foreground mb-4">
                      {workflowType === 'helm' 
                        ? 'Upload or select your Helm chart to validate and check for best practices.'
                        : 'This step will be implemented in future phases.'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {workflowType === 'helm' 
                        ? 'Helm Chart Validation will be implemented in Phase 3.'
                        : 'Activities and Commit features will be available in Phase 4 and Phase 5.'}
                    </p>
                  </div>
                  
                  <div className="flex gap-4 justify-center">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setCurrentStep(2);
                        setSelectedRepo('');
                      }}
                    >
                      ← Back to Repository Selection
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleGoHome}
                    >
                      <Home className="w-4 h-4 mr-2" />
                      Home
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}

