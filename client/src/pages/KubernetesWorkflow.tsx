import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
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
import { FileCode, Package, Package2, Home, Cloud, CodeIcon, Loader2, Upload, FileText, RefreshCw, CheckCircle2, AlertTriangle, AlertCircle, FolderOpen, ShieldCheck } from "lucide-react";
import ActivityPanel from "@/components/ActivityPanel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Session, Message, Repository, GeneratedFile } from "@shared/schema";

type WorkflowType = 'manifest' | 'helm' | 'kustomize' | 'helm-generator' | null;
type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type Provider = 'github' | 'azure' | null;

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
  type HelmScanState = 'idle' | 'scanning' | 'done' | 'empty' | 'error';
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
    { number: 5, title: 'Review' },
    { number: 6, title: 'Activities' },
    { number: 7, title: 'Commit' },
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
    enabled: !!sessionId && currentStep >= 5,
    refetchOnMount: true,
  });

  const { data: config } = useSecretsConfig();

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
    const repoName = repo?.name || selectedRepo;

    setHelmScanState('scanning');
    setRepoAnalysis(null);
    setHelmAppContext('');
    setRepoScannedFiles([]);

    try {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/scan-repo-for-helm`, {
        provider,
        repoName,
        branch: 'main',
      });
      const data = await res.json();

      if (data.isEmpty) {
        setWorkloadDescription('');
        setHelmScanState('empty');
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
        />
      </div>
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
        <Button variant="outline" onClick={onBack}>← Back</Button>
        <Button
          onClick={() => { setCurrentStep(4); generateHelmChartMutation.mutate(workloadDescription); }}
          disabled={!workloadDescription.trim() || generateHelmChartMutation.isPending}
        >
          <Package2 className="w-4 h-4 mr-2" />Generate Helm Chart
        </Button>
      </div>
    </Card>
  );

  return (
    <div className="min-h-screen bg-white">
      <Header />

      <main className="container mx-auto px-4 py-6 max-w-7xl">
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
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
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleGoHome}
              >
                <Home className="w-4 h-4 mr-2" />
                Home
              </Button>
            </div>
          </div>
        </div>

        <StepIndicator steps={steps} currentStep={currentStep} />

        <ScrollArea className="flex-1 px-4 sm:px-6 lg:px-8 mt-6">
          <div className="max-w-6xl mx-auto pb-8 space-y-6">
            {/* Messages */}
            <div className="mb-8">
              {messages.map((msg) => (
                msg.type === 'ai' || msg.type === 'system' ? (
                  <AIMessage key={msg.id} message={msg.content} />
                ) : (
                  <UserMessage key={msg.id} message={msg.content} />
                )
              ))}
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
                          icon={<CodeIcon className="w-6 h-6" />}
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
                          <Button onClick={() => setLocation('/settings')}>Go to Settings</Button>
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

            {/* Step 5: Review (Manifest Generation) */}
            {currentStep === 5 && workflowType === 'manifest' && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Review Generated Manifests</h2>
                  <p className="text-muted-foreground">
                    Review and edit the generated Kubernetes manifests
                  </p>
                </div>

                {/* Inline validation result alert */}
                {manifestValidationResult && !manifestValidationResult.valid && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>
                      {manifestValidationResult.schemaErrors} schema error{manifestValidationResult.schemaErrors !== 1 ? 's' : ''} found
                      {manifestValidationResult.warnings > 0 && `, ${manifestValidationResult.warnings} warning${manifestValidationResult.warnings !== 1 ? 's' : ''}`}
                    </AlertTitle>
                    <AlertDescription>
                      Review and fix issues before committing. Use the <strong>Activities</strong> panel to auto-fix with AI.
                    </AlertDescription>
                  </Alert>
                )}
                {manifestValidationResult && manifestValidationResult.valid && (
                  <Alert className="border-green-200 bg-green-50 text-green-800">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <AlertTitle className="text-green-800">Manifests validated successfully</AlertTitle>
                    <AlertDescription className="text-green-700">
                      No schema errors found.{manifestValidationResult.warnings > 0 && ` ${manifestValidationResult.warnings} warning(s) — review in Activities.`}
                    </AlertDescription>
                  </Alert>
                )}

                {generatedFiles.length > 0 ? (
                  <CodeEditor
                    files={generatedFiles.map(f => ({
                      name: f.fileName,
                      content: f.content
                    }))}
                    onFileChange={async (fileName, content) => {
                      // Update file in session using POST endpoint
                      await apiRequest('POST', `/api/sessions/${sessionId}/files`, {
                        fileName,
                        content
                      });
                      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                    }}
                  />
                ) : (
                  <div className="text-center py-12">
                    <p className="text-muted-foreground">No manifests generated yet.</p>
                  </div>
                )}

                <div className="flex gap-4 justify-center">
                  <Button
                    variant="outline"
                    onClick={() => setCurrentStep(3)}
                  >
                    ← Back
                  </Button>
                  <Button
                    onClick={() => setCurrentStep(6)}
                  >
                    Continue to Activities →
                  </Button>
                </div>
              </div>
            )}

            {/* Step 6: Activities */}
            {currentStep === 6 && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Activities</h2>
                  <p className="text-muted-foreground">
                    Run security scans, validate best practices, and generate architecture diagrams
                  </p>
                </div>

                {/* Code Editor - On top */}
                <div className="rounded-lg border bg-card">
                  <div className="px-4 py-3 border-b bg-muted/50">
                    <h3 className="text-sm font-medium flex items-center gap-2">
                      <FileCode className="w-4 h-4" />
                      Generated Manifests
                    </h3>
                  </div>
                  {generatedFiles.length > 0 ? (
                    <CodeEditor
                      files={generatedFiles.map(f => ({
                        name: f.fileName,
                        content: f.content
                      }))}
                      onFileChange={async (fileName, content) => {
                        await apiRequest('POST', `/api/sessions/${sessionId}/files`, {
                          fileName,
                          content
                        });
                        queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                      }}
                    />
                  ) : (
                    <div className="p-8 text-center text-muted-foreground">
                      <FileCode className="w-8 h-8 mx-auto mb-2 opacity-50" />
                      <p>No manifests generated yet</p>
                    </div>
                  )}
                </div>

                {/* Security Score Card (E1) */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <ShieldCheck className="w-5 h-5 text-primary" />
                        Security Context Score
                      </CardTitle>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            const res = await fetch(`/api/sessions/${sessionId}/security-score`, { method: 'POST' });
                            const data = await res.json();
                            if (res.ok) setSecurityScore(data.score);
                            else toast({ title: 'Scoring failed', description: data.error, variant: 'destructive' });
                          } catch (err: any) {
                            toast({ title: 'Scoring failed', description: err.message, variant: 'destructive' });
                          }
                        }}
                      >
                        Run Score
                      </Button>
                    </div>
                  </CardHeader>
                  {securityScore && (
                    <CardContent>
                      <div className="flex items-center gap-4 mb-4">
                        <div className={`text-4xl font-bold ${securityScore.overallScore >= 75 ? 'text-green-600' : securityScore.overallScore >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
                          {securityScore.grade}
                        </div>
                        <div>
                          <div className="text-2xl font-semibold">{securityScore.overallScore}/100</div>
                          <div className="text-xs text-muted-foreground">{securityScore.totalWorkloads} workload(s) analysed</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs mb-3">
                        <div className="bg-muted/50 rounded p-2">
                          <div className="font-medium">runAsNonRoot</div>
                          <div className={securityScore.metrics.runAsNonRoot.percent === 100 ? 'text-green-600' : 'text-yellow-600'}>
                            {securityScore.metrics.runAsNonRoot.percent}% ({securityScore.metrics.runAsNonRoot.count}/{securityScore.metrics.runAsNonRoot.total})
                          </div>
                        </div>
                        <div className="bg-muted/50 rounded p-2">
                          <div className="font-medium">readOnlyRootFS</div>
                          <div className={securityScore.metrics.readOnlyRootFilesystem.percent === 100 ? 'text-green-600' : 'text-yellow-600'}>
                            {securityScore.metrics.readOnlyRootFilesystem.percent}% ({securityScore.metrics.readOnlyRootFilesystem.count}/{securityScore.metrics.readOnlyRootFilesystem.total})
                          </div>
                        </div>
                        <div className="bg-muted/50 rounded p-2">
                          <div className="font-medium">Resource Limits</div>
                          <div className={securityScore.metrics.resourceLimitsDefined.percent === 100 ? 'text-green-600' : 'text-yellow-600'}>
                            {securityScore.metrics.resourceLimitsDefined.percent}% ({securityScore.metrics.resourceLimitsDefined.count}/{securityScore.metrics.resourceLimitsDefined.total})
                          </div>
                        </div>
                        <div className="bg-muted/50 rounded p-2">
                          <div className="font-medium">Privileged</div>
                          <div className={securityScore.metrics.privilegedContainers.count === 0 ? 'text-green-600' : 'text-red-600'}>
                            {securityScore.metrics.privilegedContainers.count} container(s)
                          </div>
                        </div>
                        <div className="bg-muted/50 rounded p-2">
                          <div className="font-medium">Host Namespaces</div>
                          <div className={securityScore.metrics.hostNamespaces.count === 0 ? 'text-green-600' : 'text-red-600'}>
                            {securityScore.metrics.hostNamespaces.count} workload(s)
                          </div>
                        </div>
                        <div className="bg-muted/50 rounded p-2">
                          <div className="font-medium">:latest Images</div>
                          <div className={securityScore.metrics.latestImageTag.count === 0 ? 'text-green-600' : 'text-yellow-600'}>
                            {securityScore.metrics.latestImageTag.count} container(s)
                          </div>
                        </div>
                      </div>
                      {securityScore.recommendations.length > 0 && (
                        <ul className="text-xs space-y-1 text-muted-foreground">
                          {securityScore.recommendations.map((r: string, i: number) => (
                            <li key={i} className="flex items-start gap-1">
                              <AlertTriangle className="w-3 h-3 mt-0.5 text-yellow-500 shrink-0" />
                              {r}
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  )}
                </Card>

                {/* Activity Panel - Below code editor */}
                <ActivityPanel
                  sessionId={sessionId}
                  workflowType="kubernetes"
                  onScanComplete={() => {
                    setScanCompleted(true);
                    // Refresh files after scan/fix
                    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                    toast({
                      title: "Activity Complete",
                      description: "Activity completed successfully.",
                    });
                  }}
                  onFixesApproved={() => {
                    // Refresh files after security fixes are approved
                    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                    toast({
                      title: "Fixes Applied",
                      description: "Security fixes have been applied. Code editor updated.",
                    });
                  }}
                />

                <div className="flex gap-4 justify-center">
                  <Button
                    variant="outline"
                    onClick={() => setCurrentStep(5)}
                  >
                    ← Back
                  </Button>
                  <Button
                    onClick={() => setCurrentStep(7)}
                    disabled={!scanCompleted}
                  >
                    Continue to Commit →
                  </Button>
                </div>
                {!scanCompleted && (
                  <p className="text-sm text-muted-foreground text-center">
                    Please run at least one activity (Security Scan, Validate, etc.) before committing
                  </p>
                )}
              </div>
            )}

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
                  <Button variant="outline" onClick={() => setCurrentStep(2)}>← Back</Button>
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
                      <Button variant="outline" onClick={() => setCurrentStep(2)}>← Back</Button>
                      <Button onClick={validateSelectedRepositoryForHelm} disabled={!selectedRepo || !provider}>
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
                      <Button variant="outline" onClick={() => setCurrentStep(2)}>← Back</Button>
                      <Button
                        onClick={() => { setCurrentStep(4); generateHelmChartMutation.mutate(workloadDescription); }}
                        disabled={!workloadDescription.trim() || generateHelmChartMutation.isPending}
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
              <Card className="rounded-3xl border-dashed border-border/40 bg-white/80 p-10 text-center shadow-lg">
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

            {/* Step 5: Helm Generator — Review generated chart */}
            {currentStep === 5 && workflowType === 'helm-generator' && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Generated Helm Chart</h2>
                  <p className="text-muted-foreground">Review and edit all chart files before committing</p>
                </div>

                {/* Chart name + file count */}
                <div className="rounded-2xl border border-border/50 p-4 flex items-center justify-between bg-white shadow-sm">
                  <div>
                    <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Chart name</p>
                    <p className="text-lg font-semibold font-mono mt-1">{helmChartName || 'my-chart'}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-4xl font-bold text-primary">{generatedFiles.length}</p>
                    <p className="text-xs text-muted-foreground">files generated</p>
                  </div>
                </div>

                {/* Helm lint result */}
                {helmGenLintResult && (
                  <div className={`rounded-2xl border p-4 ${
                    helmGenLintResult.status === 'passed' ? 'border-emerald-200 bg-emerald-50'
                    : helmGenLintResult.status === 'warning' ? 'border-amber-200 bg-amber-50'
                    : 'border-rose-200 bg-rose-50'
                  }`}>
                    <p className="text-sm font-semibold flex items-center gap-2">
                      {helmGenLintResult.status === 'passed' ? <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        : <AlertTriangle className="w-4 h-4 text-amber-600" />}
                      Helm Lint:
                      {helmGenLintResult.status === 'passed' ? ' Passed' :
                        helmGenLintResult.status === 'warning' ? ' Passed with warnings' : ' Failed'}
                    </p>
                    {helmGenLintResult.errors.map((e, i) => (
                      <p key={i} className="text-xs text-rose-700 mt-1 ml-6">{e}</p>
                    ))}
                    {helmGenLintResult.warnings.map((w, i) => (
                      <p key={i} className="text-xs text-amber-700 mt-1 ml-6">{w}</p>
                    ))}
                  </div>
                )}

                {/* Code editor with all chart files */}
                <Card className="rounded-3xl border border-border/60 overflow-hidden shadow-xl">
                  {generatedFiles.length > 0 ? (
                    <CodeEditor
                      files={generatedFiles.map(f => ({ name: f.fileName, content: f.content }))}
                      onFileChange={async (fileName, content) => {
                        await apiRequest('POST', `/api/sessions/${sessionId}/files`, { fileName, content });
                        queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                      }}
                    />
                  ) : (
                    <div className="p-8 text-center text-muted-foreground">
                      No files generated. Try going back and regenerating.
                    </div>
                  )}
                </Card>

                <div className="flex gap-4 justify-center">
                  <Button variant="outline" onClick={() => setCurrentStep(3)}>← Back</Button>
                  <Button onClick={() => {
                    setCurrentStep(6);
                    apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '6' });
                  }}>
                    Continue to Activities →
                  </Button>
                </div>
              </div>
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

            {/* Step 5: Review (Helm Chart Validation Results) */}
            {currentStep === 5 && workflowType === 'helm' && validationResults && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Validation Results</h2>
                  <p className="text-muted-foreground">Deep multi-pass analysis of your Helm chart</p>
                </div>

                <div className="max-w-4xl mx-auto space-y-6">

                  {/* Production Readiness Score */}
                  {validationResults.deepAnalysis && (() => {
                    const da = validationResults.deepAnalysis;
                    const gradeColor: Record<string, string> = {
                      A: 'text-emerald-600 border-emerald-400 bg-emerald-50 dark:bg-emerald-950',
                      B: 'text-teal-600 border-teal-400 bg-teal-50 dark:bg-teal-950',
                      C: 'text-yellow-600 border-yellow-400 bg-yellow-50 dark:bg-yellow-950',
                      D: 'text-orange-600 border-orange-400 bg-orange-50 dark:bg-orange-950',
                      F: 'text-red-600 border-red-400 bg-red-50 dark:bg-red-950',
                    };
                    const barColor = (score: number) =>
                      score >= 80 ? 'bg-emerald-500' : score >= 60 ? 'bg-yellow-500' : 'bg-red-500';
                    const categories = [
                      { key: 'security',      label: 'Security',      score: da.categoryScores.security },
                      { key: 'reliability',   label: 'Reliability',   score: da.categoryScores.reliability },
                      { key: 'resources',     label: 'Resources',     score: da.categoryScores.resources },
                      { key: 'helmStructure', label: 'Helm Structure',score: da.categoryScores.helmStructure },
                      { key: 'operations',    label: 'Operations',    score: da.categoryScores.operations },
                    ];
                    return (
                      <Card>
                        <CardHeader>
                          <CardTitle>Production Readiness Score</CardTitle>
                          <CardDescription>{da.passedChecks} of {da.totalChecks} checks passed across 5 specialist passes</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="flex items-center gap-8">
                            {/* Grade circle */}
                            <div className={`w-24 h-24 rounded-full border-4 flex flex-col items-center justify-center flex-shrink-0 ${gradeColor[da.grade]}`}>
                              <span className="text-3xl font-bold leading-none">{da.grade}</span>
                              <span className="text-sm font-medium">{da.score}/100</span>
                            </div>
                            {/* Category bars */}
                            <div className="flex-1 space-y-2">
                              {categories.map(cat => (
                                <div key={cat.key} className="flex items-center gap-3">
                                  <span className="text-xs text-muted-foreground w-28 flex-shrink-0">{cat.label}</span>
                                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full transition-all ${barColor(cat.score)}`}
                                      style={{ width: `${cat.score}%` }}
                                    />
                                  </div>
                                  <span className="text-xs font-mono w-8 text-right">{cat.score}%</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })()}

                  {/* Validation Summary */}
                  <Card>
                    <CardHeader><CardTitle>Validation Summary</CardTitle></CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="text-center">
                          <div className="text-2xl font-bold">{validationResults.summary.totalIssues}</div>
                          <div className="text-sm text-muted-foreground">Total Issues</div>
                        </div>
                        <div className="text-center">
                          <div className="text-2xl font-bold text-destructive">{validationResults.summary.errors}</div>
                          <div className="text-sm text-muted-foreground">Errors</div>
                        </div>
                        <div className="text-center">
                          <div className="text-2xl font-bold text-yellow-600">{validationResults.summary.warnings}</div>
                          <div className="text-sm text-muted-foreground">Warnings</div>
                        </div>
                        <div className="text-center">
                          <div className="text-2xl font-bold text-blue-600">{validationResults.summary.info}</div>
                          <div className="text-sm text-muted-foreground">Info</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Tool Results */}
                  {validationResults.lintResults && (
                    <Card>
                      <CardHeader><CardTitle>Tool Results</CardTitle></CardHeader>
                      <CardContent className="space-y-4">
                        {validationResults.lintResults.helmLint && (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-medium">Helm Lint</span>
                              <span className={`text-sm font-semibold ${validationResults.lintResults.helmLint.status === 'passed' ? 'text-green-600' : validationResults.lintResults.helmLint.status === 'warning' ? 'text-yellow-600' : 'text-red-600'}`}>
                                {validationResults.lintResults.helmLint.status.toUpperCase()}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {validationResults.lintResults.helmLint.errors} error(s) · {validationResults.lintResults.helmLint.warnings} warning(s)
                            </div>
                          </div>
                        )}
                        {validationResults.lintResults.kubeval && (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-medium">Kubeval Schema</span>
                              <span className={`text-sm font-semibold ${validationResults.lintResults.kubeval.status === 'passed' ? 'text-green-600' : 'text-red-600'}`}>
                                {validationResults.lintResults.kubeval.status.toUpperCase()}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground">{validationResults.lintResults.kubeval.errors} error(s)</div>
                          </div>
                        )}
                        {validationResults.lintResults.checkov && (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-medium">Checkov Security</span>
                              <span className={`text-sm font-semibold ${validationResults.lintResults.checkov.failed === 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {validationResults.lintResults.checkov.failed === 0 ? 'PASSED' : 'FAILED'}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {validationResults.lintResults.checkov.passed} passed · {validationResults.lintResults.checkov.failed} failed · {validationResults.lintResults.checkov.skipped} skipped
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {/* Deep Analysis Issues — grouped by category with fix snippets */}
                  {validationResults.deepAnalysis?.issues?.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Deep Analysis Findings</CardTitle>
                        <CardDescription>
                          {validationResults.deepAnalysis.issues.length} finding(s) across 5 specialist passes · click any issue to see the fix
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {(['security', 'reliability', 'resources', 'helm-structure', 'operations'] as const).map(cat => {
                          const catIssues = validationResults.deepAnalysis.issues.filter((i: any) => i.category === cat);
                          if (catIssues.length === 0) return null;
                          const catLabel: Record<string, string> = {
                            security: 'Security', reliability: 'Reliability', resources: 'Resource Management',
                            'helm-structure': 'Helm Structure', operations: 'Operations',
                          };
                          return (
                            <div key={cat} className="mb-6">
                              <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">{catLabel[cat]}</h4>
                              <div className="space-y-2">
                                {catIssues.map((issue: any) => {
                                  const snippetId = issue.id;
                                  const sev = issue.severity;
                                  const severityStyle = sev === 'critical' ? 'border-red-600 bg-red-50 dark:bg-red-950'
                                    : sev === 'high' ? 'border-orange-500 bg-orange-50 dark:bg-orange-950'
                                    : sev === 'medium' ? 'border-yellow-500 bg-yellow-50 dark:bg-yellow-950'
                                    : 'border-blue-400 bg-blue-50 dark:bg-blue-950';
                                  const sevBadge = sev === 'critical' ? 'bg-red-600 text-white'
                                    : sev === 'high' ? 'bg-orange-500 text-white'
                                    : sev === 'medium' ? 'bg-yellow-500 text-white'
                                    : 'bg-blue-400 text-white';
                                  return (
                                    <div key={snippetId} className={`rounded border-l-4 ${severityStyle} overflow-hidden`}>
                                      <button
                                        className="w-full text-left p-3 flex items-start gap-3"
                                        onClick={() => toggleSnippet(snippetId)}
                                      >
                                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 ${sevBadge}`}>
                                          {sev.toUpperCase()}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center justify-between gap-2">
                                            <span className="text-sm font-semibold">[{issue.id}] {issue.title}</span>
                                            {issue.fixSnippet && (
                                              <span className="text-xs text-muted-foreground flex-shrink-0">
                                                {expandedSnippets.has(snippetId) ? '▲ hide fix' : '▼ show fix'}
                                              </span>
                                            )}
                                          </div>
                                          <p className="text-xs text-muted-foreground mt-0.5">{issue.description}</p>
                                          {issue.file && <p className="text-xs text-muted-foreground/70 mt-0.5">File: {issue.file}</p>}
                                        </div>
                                      </button>
                                      {expandedSnippets.has(snippetId) && issue.fixSnippet && (
                                        <div className="px-3 pb-3">
                                          <pre className="text-xs bg-muted rounded p-3 overflow-x-auto whitespace-pre-wrap font-mono border">
                                            {issue.fixSnippet}
                                          </pre>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </CardContent>
                    </Card>
                  )}

                  {/* Lint / Checkov issues (non-deep-analysis) */}
                  {validationResults.issues?.filter((i: any) => i.source !== 'best-practices').length > 0 && (
                    <Card>
                      <CardHeader><CardTitle>Tool Issues</CardTitle></CardHeader>
                      <CardContent>
                        <div className="space-y-2 max-h-72 overflow-y-auto">
                          {validationResults.issues
                            .filter((i: any) => i.source !== 'best-practices')
                            .map((issue: any, index: number) => (
                            <div key={index} className={`p-3 rounded border-l-4 text-sm ${
                              issue.severity === 'error' ? 'bg-red-50 dark:bg-red-950 border-red-500'
                              : issue.severity === 'warning' ? 'bg-yellow-50 dark:bg-yellow-950 border-yellow-500'
                              : 'bg-blue-50 dark:bg-blue-950 border-blue-500'
                            }`}>
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="font-semibold text-xs">{issue.severity.toUpperCase()}</span>
                                <span className="text-xs text-muted-foreground">({issue.source})</span>
                              </div>
                              <p className="font-medium">{issue.message}</p>
                              {issue.file && <p className="text-xs text-muted-foreground mt-0.5">File: {issue.file}{issue.line ? ` (Line ${issue.line})` : ''}</p>}
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                </div>

                <div className="flex gap-4 justify-center">
                  <Button variant="outline" onClick={() => { setCurrentStep(3); setValidationResults(null); }}>
                    ← Back
                  </Button>
                  <Button onClick={() => setCurrentStep(6)}>Continue to Activities →</Button>
                </div>
              </div>
            )}

            {/* Step 7: Commit & Push */}
            {currentStep === 7 && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Commit & Push</h2>
                  <p className="text-muted-foreground">
                    Review your files and commit them to the repository
                  </p>
                </div>

                {isCommitted ? (
                  <div className="flex flex-col items-center gap-4 p-6 border rounded-lg bg-green-50 dark:bg-green-950">
                    <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                      <CheckCircle2 className="w-6 h-6" />
                      <h3 className="text-lg font-semibold">Successfully Committed!</h3>
                    </div>
                    <p className="text-sm text-muted-foreground text-center">
                      Your Kubernetes manifests have been committed to the repository.
                    </p>
                    <Button
                      onClick={handleGoHome}
                      className="w-full sm:w-auto"
                      data-testid="button-go-home"
                    >
                      <Home className="w-4 h-4 mr-2" />
                      Go to Home
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
                          />
                        </div>
                      </CardContent>
                    </Card>

                    {/* Commit Button */}
                    <div className="flex gap-4 justify-center">
                      <Button
                        variant="outline"
                        onClick={() => setCurrentStep(6)}
                      >
                        ← Back
                      </Button>
                      <Button
                        onClick={() => commitMutation.mutate()}
                        disabled={commitMutation.isPending || generatedFiles.length === 0}
                        className="flex-1"
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

            {/* Step 3+: Placeholder for other steps (only if not in Helm validation flow) */}
            {(currentStep > 7 && !(currentStep === 5 && workflowType === 'helm' && validationResults)) && (
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

