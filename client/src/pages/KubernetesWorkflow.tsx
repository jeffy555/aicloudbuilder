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
import { FileCode, Package, Home, Cloud, CodeIcon, Loader2, Upload, FileText, RefreshCw } from "lucide-react";
import ActivityPanel from "@/components/ActivityPanel";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Session, Message, Repository, GeneratedFile } from "@shared/schema";

type WorkflowType = 'manifest' | 'helm' | null;
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
  const [helmChartPath, setHelmChartPath] = useState<string>('');
  const [validationResults, setValidationResults] = useState<any>(null);
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const [isCommitted, setIsCommitted] = useState<boolean>(false);
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [scanCompleted, setScanCompleted] = useState<boolean>(false);

  const steps: Array<{ number: number; title: string }> = [
    { number: 1, title: 'Workflow' },
    { number: 2, title: 'Repository' },
    { number: 3, title: workflowType === 'manifest' ? 'Describe' : 'Upload' },
    { number: 4, title: workflowType === 'manifest' ? 'Generate' : 'Validate' },
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

  // Validate Helm chart mutation
  const validateHelmChartMutation = useMutation({
    mutationFn: async (chartPath: string) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/validate-helm-chart`, {
        chartPath,
        options: {
          runHelmLint: true,
          runKubeval: true,
          runCheckov: true,
          runBestPractices: true,
        }
      });
      return res.json();
    },
    onSuccess: (data) => {
      setValidationResults(data);
      setCurrentStep(5); // Move to review step
      toast({
        title: data.success ? "✅ Validation Complete" : "⚠️ Issues Found",
        description: `Found ${data.summary.totalIssues} issue(s): ${data.summary.errors} error(s), ${data.summary.warnings} warning(s)`,
        variant: data.success ? "default" : "destructive"
      });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    },
    onError: (error: any) => {
      toast({
        title: "Validation Failed",
        description: error.message || "Failed to validate Helm chart",
        variant: "destructive"
      });
    },
    onSettled: () => {
      setIsValidating(false);
    }
  });

  // Generate manifests mutation
  const generateManifestsMutation = useMutation({
    mutationFn: async (description: string) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/generate-kubernetes-manifests`, {
        description,
        options: {
          includeProbes: true,
          includeResourceLimits: true,
          includeSecurityContext: true
        }
      });
      return res.json();
    },
    onSuccess: async (data) => {
      toast({
        title: "✅ Manifests Generated",
        description: `Successfully generated ${data.metadata.totalResources} resource(s)`,
      });
      setCurrentStep(5); // Move to review step
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    },
    onError: (error: any) => {
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

  const handleWorkflowSelect = async (type: WorkflowType) => {
    setWorkflowType(type);
    setCurrentStep(2);
    // Save to localStorage for session restoration
    localStorage.setItem('kubernetes_workflow_type', type || '');

    // Update session via backend (session state will be updated when we proceed)
    // For now, we'll update it when moving to next step

    const workflowName = type === 'manifest' ? 'Manifest Generation' : 'Helm Chart Validation';
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
    // Save to localStorage for session restoration
    localStorage.setItem('kubernetes_workflow_repo', repoId);

    setCurrentStep(3);

    const nextStepMessage = workflowType === 'manifest'
      ? `Repository "${repoName}" selected! Now describe your Kubernetes workload in natural language.`
      : `Repository "${repoName}" selected! Now upload or select your Helm chart.`;

    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
      message: nextStepMessage
    });
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
      setHelmChartPath('');
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
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl mx-auto">
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
              <div className="text-center py-12">
                <Loader2 className="w-12 h-12 animate-spin mx-auto mb-4 text-primary" />
                <p className="text-muted-foreground">
                  Generating Kubernetes manifests...
                </p>
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
                  <p className="text-muted-foreground">
                    Upload a Helm chart or select one from the repository
                  </p>
                </div>

                <div className="max-w-3xl mx-auto space-y-6">
                  {/* Upload Option */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Upload className="w-5 h-5" />
                        Upload Helm Chart
                      </CardTitle>
                      <CardDescription>
                        Upload a Helm chart directory or archive
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <Input
                          type="text"
                          placeholder="Enter path to Helm chart directory (e.g., ./charts/my-app)"
                          value={helmChartPath}
                          onChange={(e) => setHelmChartPath(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Note: For now, enter the local path to your Helm chart. File upload will be available in a future update.
                        </p>
                        <Button
                          onClick={() => {
                            if (helmChartPath.trim()) {
                              setIsValidating(true);
                              validateHelmChartMutation.mutate(helmChartPath.trim());
                            } else {
                              toast({
                                title: "Path Required",
                                description: "Please enter a Helm chart path",
                                variant: "destructive"
                              });
                            }
                          }}
                          disabled={!helmChartPath.trim() || isValidating}
                          className="w-full"
                        >
                          {isValidating ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              Validating...
                            </>
                          ) : (
                            <>
                              <FileText className="w-4 h-4 mr-2" />
                              Validate Chart
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
                  <p className="text-muted-foreground">
                    Review the validation results for your Helm chart
                  </p>
                </div>

                <div className="max-w-4xl mx-auto space-y-6">
                  {/* Summary */}
                  <Card>
                    <CardHeader>
                      <CardTitle>Validation Summary</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="text-center">
                          <div className="text-2xl font-bold text-foreground">
                            {validationResults.summary.totalIssues}
                          </div>
                          <div className="text-sm text-muted-foreground">Total Issues</div>
                        </div>
                        <div className="text-center">
                          <div className="text-2xl font-bold text-destructive">
                            {validationResults.summary.errors}
                          </div>
                          <div className="text-sm text-muted-foreground">Errors</div>
                        </div>
                        <div className="text-center">
                          <div className="text-2xl font-bold text-yellow-600">
                            {validationResults.summary.warnings}
                          </div>
                          <div className="text-sm text-muted-foreground">Warnings</div>
                        </div>
                        <div className="text-center">
                          <div className="text-2xl font-bold text-blue-600">
                            {validationResults.summary.info}
                          </div>
                          <div className="text-sm text-muted-foreground">Info</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Lint Results */}
                  {validationResults.lintResults && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Tool Results</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {validationResults.lintResults.helmLint && (
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-medium">Helm Lint</span>
                              <span className={`text-sm ${validationResults.lintResults.helmLint.status === 'passed' ? 'text-green-600' : validationResults.lintResults.helmLint.status === 'warning' ? 'text-yellow-600' : 'text-red-600'}`}>
                                {validationResults.lintResults.helmLint.status}
                              </span>
                            </div>
                            <div className="text-sm text-muted-foreground">
                              Errors: {validationResults.lintResults.helmLint.errors}, Warnings: {validationResults.lintResults.helmLint.warnings}
                            </div>
                          </div>
                        )}
                        {validationResults.lintResults.kubeval && (
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-medium">Kubeval</span>
                              <span className={`text-sm ${validationResults.lintResults.kubeval.status === 'passed' ? 'text-green-600' : 'text-red-600'}`}>
                                {validationResults.lintResults.kubeval.status}
                              </span>
                            </div>
                            <div className="text-sm text-muted-foreground">
                              Errors: {validationResults.lintResults.kubeval.errors}
                            </div>
                          </div>
                        )}
                        {validationResults.lintResults.checkov && (
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-medium">Checkov</span>
                              <span className={`text-sm ${validationResults.lintResults.checkov.failed === 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {validationResults.lintResults.checkov.failed === 0 ? 'Passed' : 'Failed'}
                              </span>
                            </div>
                            <div className="text-sm text-muted-foreground">
                              Passed: {validationResults.lintResults.checkov.passed}, Failed: {validationResults.lintResults.checkov.failed}, Skipped: {validationResults.lintResults.checkov.skipped}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {/* Issues */}
                  {validationResults.issues && validationResults.issues.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Issues Found</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3 max-h-96 overflow-y-auto">
                          {validationResults.issues.map((issue: any, index: number) => (
                            <div
                              key={index}
                              className={`p-3 rounded border-l-4 ${
                                issue.severity === 'error'
                                  ? 'bg-red-50 dark:bg-red-950 border-red-500'
                                  : issue.severity === 'warning'
                                  ? 'bg-yellow-50 dark:bg-yellow-950 border-yellow-500'
                                  : 'bg-blue-50 dark:bg-blue-950 border-blue-500'
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="font-semibold text-sm">
                                      {issue.severity.toUpperCase()}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      ({issue.source})
                                    </span>
                                  </div>
                                  <p className="text-sm font-medium mb-1">{issue.message}</p>
                                  {issue.file && (
                                    <p className="text-xs text-muted-foreground">
                                      File: {issue.file}
                                      {issue.line && ` (Line ${issue.line})`}
                                    </p>
                                  )}
                                  {issue.suggestion && (
                                    <p className="text-xs text-muted-foreground mt-1">
                                      💡 {issue.suggestion}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Best Practices */}
                  {validationResults.bestPractices && validationResults.bestPractices.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Best Practice Recommendations</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          {validationResults.bestPractices.map((bp: any, index: number) => (
                            <div key={index} className="p-3 rounded bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800">
                              <div className="flex items-start justify-between mb-1">
                                <span className="font-semibold text-sm">{bp.category}</span>
                                <span className={`text-xs px-2 py-1 rounded ${
                                  bp.priority === 'high' ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' :
                                  bp.priority === 'medium' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' :
                                  'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                                }`}>
                                  {bp.priority.toUpperCase()}
                                </span>
                              </div>
                              <p className="text-sm font-medium mb-1">{bp.issue}</p>
                              <p className="text-xs text-muted-foreground">{bp.suggestion}</p>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>

                <div className="flex gap-4 justify-center">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setCurrentStep(3);
                      setHelmChartPath('');
                      setValidationResults(null);
                    }}
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

