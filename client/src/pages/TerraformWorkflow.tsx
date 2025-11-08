import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import Header from "@/components/Header";
import AIMessage from "@/components/AIMessage";
import UserMessage from "@/components/UserMessage";
import ChatInput from "@/components/ChatInput";
import ProviderCard from "@/components/ProviderCard";
import RepositoryList from "@/components/RepositoryList";
import CreateRepoForm from "@/components/CreateRepoForm";
import CodeEditor from "@/components/CodeEditor";
import StepIndicator from "@/components/StepIndicator";
import ActionButtons from "@/components/ActionButtons";
import CheckovScanner from "@/components/CheckovScanner";
import { CodeIcon } from "@radix-ui/react-icons";
import { Cloud, CloudCog, Package } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import type { Session, Message, GeneratedFile, Repository, RepositoryScanResult } from "@shared/schema";

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type Provider = 'github' | 'azure' | null;
type CloudProvider = 'azure' | 'aws' | 'gcp' | null;
type ModuleApproach = 'child-module' | 'standalone-root' | 'aggregated-root' | null;

export default function TerraformWorkflow() {
  const { toast } = useToast();
  const [sessionId, setSessionId] = useState<string>('');
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [provider, setProvider] = useState<Provider>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>(null);
  const [moduleApproach, setModuleApproach] = useState<ModuleApproach>(null);
  const [isCommitted, setIsCommitted] = useState<boolean>(false);
  const [scanCompleted, setScanCompleted] = useState<boolean>(false);
  const [repositoryScanResult, setRepositoryScanResult] = useState<RepositoryScanResult | null>(null);
  const [backendConfigured, setBackendConfigured] = useState<boolean>(false);

  const steps = [
    { number: 1, title: 'Provider' },
    { number: 2, title: 'Repository' },
    { number: 3, title: 'Cloud' },
    { number: 4, title: 'Module' },
    { number: 5, title: 'Backend' },
    { number: 6, title: 'Generate' },
    { number: 7, title: 'Review' },
  ];

  // Create session on mount
  useEffect(() => {
    const createSession = async () => {
      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      
      // Create initial welcome message without AI chat
      await apiRequest('POST', `/api/sessions/${session.id}/messages/system`, { 
        message: 'Welcome! Let\'s start by selecting your repository provider. Choose GitHub or Azure DevOps.' 
      });
    };
    createSession();
  }, []);

  // Fetch messages
  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: ['/api/sessions', sessionId, 'messages'],
    enabled: !!sessionId,
    refetchInterval: 2000, // Poll for new messages
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
    enabled: !!sessionId && currentStep === 7,
  });

  // Send chat message mutation
  const chatMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/chat`, { message });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    }
  });

  // Create repository mutation
  const createRepoMutation = useMutation({
    mutationFn: async ({ name, description }: { name: string; description: string }) => {
      const res = await apiRequest('POST', `/api/repositories/${provider}`, { name, description });
      return res.json();
    },
    onSuccess: (data: any, variables) => {
      queryClient.invalidateQueries({ queryKey: ['/api/repositories', provider] });
      toast({
        title: "Repository Created",
        description: `Successfully created repository: ${variables.name}`,
      });
    }
  });

  // Backend configuration mutation
  const configureBackendMutation = useMutation({
    mutationFn: async (params: { action: 'decline' | 'create' | 'validate'; backendConfig?: any }) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/configure-backend`, params);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
      setBackendConfigured(true);
    }
  });

  // Generate Terraform mutation
  const generateTerraformMutation = useMutation({
    mutationFn: async (description: string) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/generate-terraform`, { description });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      setCurrentStep(7);
      setScanCompleted(false); // Reset scan state for new files
    },
    onError: (error: any) => {
      if (error?.requiresBackendConfiguration) {
        toast({
          title: "Backend Configuration Required",
          description: "Please configure or decline backend setup before generating Terraform.",
          variant: "destructive"
        });
        setCurrentStep(5); // Go back to backend step
      }
    }
  });

  // Update file mutation
  const updateFileMutation = useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) => {
      const res = await apiRequest('PATCH', `/api/files/${id}`, { content });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      setScanCompleted(false); // Reset scan state when files are edited
    }
  });

  // Scan repository mutation
  const scanRepositoryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/scan-repository`);
      return res.json() as Promise<RepositoryScanResult>;
    },
    onSuccess: (data: RepositoryScanResult) => {
      setRepositoryScanResult(data);
      
      if (data.cloudProvider) {
        setCloudProvider(data.cloudProvider);
      }
    },
    onError: (error: any) => {
      console.error('Error scanning repository:', error);
      toast({
        title: "Scan Failed",
        description: "Failed to scan repository. Continuing with manual configuration.",
        variant: "destructive"
      });
    }
  });

  // Commit files mutation
  const commitMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/commit`);
      return res.json();
    },
    onSuccess: (data: any) => {
      setIsCommitted(true);
      toast({
        title: "Success!",
        description: `Your Terraform configuration has been committed: ${data.commitMessage}`,
      });
      
      chatMutation.mutate(`Files committed successfully with message: "${data.commitMessage}"`);
    },
    onError: (error: any) => {
      const errorMessage = error?.message || "Failed to commit files. Please try again.";
      toast({
        title: "Commit Failed",
        description: errorMessage,
        variant: "destructive"
      });
    }
  });

  const handleProviderSelect = async (selectedProvider: Provider) => {
    setProvider(selectedProvider);
    
    await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
      provider: selectedProvider, 
      currentStep: '2' 
    });

    const providerName = selectedProvider === 'github' ? 'GitHub' : 'Azure DevOps';
    
    // User confirmation
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: `Selected ${providerName}` 
    });
    
    // System guidance for next step
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: 'Great! Now select an existing repository or create a new one.' 
    });
    
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    setCurrentStep(2);
  };

  const handleRepoSelect = async (repoId: string) => {
    setSelectedRepo(repoId);
    const repo = repositories.find(r => r.id === repoId);
    
    await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
      repositoryId: repoId,
      repositoryName: repo?.name,
    });

    // User confirmation
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: `Selected repository: ${repo?.name}` 
    });

    // Scan the repository for existing configuration
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: 'Scanning repository for existing Terraform configuration...' 
    });
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });

    const scanResult = await scanRepositoryMutation.mutateAsync();

    // Handle Azure DevOps limitation (cannot scan files)
    if (provider === 'azure' && !scanResult.isExisting) {
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'Note: Azure DevOps repository scanning is limited. You\'ll need to manually configure the cloud provider and module type.' 
      });
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '3' });
      setCurrentStep(3);
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'Let\'s start by choosing your target cloud provider (Azure, AWS, or GCP).' 
      });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
      return;
    }

    if (scanResult.isExisting && scanResult.terraformFiles.length > 0) {
      // Existing repo with Terraform files
      const moduleTypeText = scanResult.moduleType === 'child' ? 'child module' :
                            scanResult.moduleType === 'root' ? 'root module' : 
                            'configuration';
      const providerText = scanResult.cloudProvider ? 
        ` for ${scanResult.cloudProvider.toUpperCase()}` : '';

      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: `Found existing ${moduleTypeText}${providerText} with ${scanResult.terraformFiles.length} Terraform files.`
      });

      if (scanResult.cloudProvider && !cloudProvider) {
        await apiRequest('PATCH', `/api/sessions/${sessionId}`, { cloudProvider: scanResult.cloudProvider });
        setCloudProvider(scanResult.cloudProvider);
      }

      // Skip to step 5 for existing repos - let AI validate and guide the user
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '5' });
      setCurrentStep(5);

      // AI message with context about detected config
      const contextMessage = scanResult.moduleType === 'child' 
        ? 'I see this is a child module. Would you like me to help you create additional child modules, or modify the existing ones?'
        : 'I see this is a root module. Would you like to add additional resources to this configuration?';

      await chatMutation.mutateAsync(contextMessage);
    } else {
      // New/empty repo
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'This appears to be a new repository. Let\'s configure it from scratch.' 
      });

      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '3' });
      setCurrentStep(3);

      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'Perfect! Now choose your target cloud provider (Azure, AWS, or GCP).' 
      });
    }

    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
  };

  const handleCreateRepo = async (name: string, description: string) => {
    await createRepoMutation.mutateAsync({ name, description });
    
    await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
      repositoryName: name,
      currentStep: '3'
    });

    // User confirmation  
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: `Created new repository: ${name}` 
    });
    
    // System guidance for next step
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: 'Excellent! Now choose your target cloud provider (Azure, AWS, or GCP).' 
    });
    
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    setCurrentStep(3);
  };

  const handleCloudProviderSelect = async (selectedCloudProvider: CloudProvider) => {
    setCloudProvider(selectedCloudProvider);
    
    await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
      cloudProvider: selectedCloudProvider,
      currentStep: '4' 
    });

    const cloudName = selectedCloudProvider === 'azure' ? 'Microsoft Azure' : 
                      selectedCloudProvider === 'aws' ? 'Amazon Web Services (AWS)' : 
                      'Google Cloud Platform (GCP)';
    
    // User confirmation
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: `Selected ${cloudName}` 
    });
    
    // System guidance for next step
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: 'Great! Now choose your module approach: child module, standalone root module, or aggregated root module.' 
    });
    
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    setCurrentStep(4);
  };

  const handleModuleApproachSelect = async (selectedApproach: ModuleApproach) => {
    setModuleApproach(selectedApproach);
    
    await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
      moduleApproach: selectedApproach,
      currentStep: '5' 
    });

    const approachName = selectedApproach === 'child-module' ? 'Child Module' : 
                         selectedApproach === 'standalone-root' ? 'Standalone Root Module' : 
                         'Aggregated Root Module';
    
    // User confirmation
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: `Selected ${approachName}` 
    });
    
    // System guidance for next step
    if (selectedApproach === 'child-module') {
      // Child modules don't need backend configuration
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'Child modules don\'t require backend configuration. Now describe the infrastructure components you want to create.' 
      });
      setBackendConfigured(true); // Mark as configured (skipped for child modules)
      setCurrentStep(6); // Skip to Generate step
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '6' });
    } else {
      // Root modules need backend configuration
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'Before generating Terraform, let\'s configure the backend for state management. You can use an existing backend, create a new one with sensible defaults, or skip this step to use local state.' 
      });
      setCurrentStep(5); // Move to Backend configuration step
    }
    
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
  };

  const handleBackendConfiguration = async (action: 'decline' | 'create' | 'validate', customConfig?: any) => {
    try {
      const result = await configureBackendMutation.mutateAsync({ action, backendConfig: customConfig });
      
      // Show result message
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: result.message || 'Backend configured successfully.' 
      });
      
      // System guidance for next step
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'Perfect! Now describe the infrastructure you want to create. Be specific about resources, configurations, and requirements.' 
      });
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
      setCurrentStep(6);
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '6' });
    } catch (error: any) {
      toast({
        title: "Backend Configuration Failed",
        description: error?.message || "Failed to configure backend. Please try again.",
        variant: "destructive"
      });
      // Stay on current step (5) to allow retry
    }
  };

  const handleGenerateRequest = async (message: string) => {
    await chatMutation.mutateAsync(message);
    await generateTerraformMutation.mutateAsync(message);
  };

  const handleFileChange = (fileName: string, content: string) => {
    const file = generatedFiles.find(f => f.fileName === fileName);
    if (file) {
      updateFileMutation.mutate({ id: file.id, content });
    }
  };

  const handleApprove = () => {
    commitMutation.mutate();
  };

  const handleCancel = () => {
    setCurrentStep(6);
    toast({
      title: "Cancelled",
      description: "You can continue editing your Terraform files.",
    });
  };

  if (!sessionId) {
    return (
      <div className="h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <Header />
      
      <main className="flex-1 overflow-hidden flex flex-col">
        <div className="py-6 px-6">
          <StepIndicator steps={steps} currentStep={currentStep} />
        </div>

        <ScrollArea className="flex-1 px-6">
          <div className="max-w-6xl mx-auto pb-6">
            {/* Messages */}
            <div className="mb-8">
              {messages.map((msg) => (
                msg.type === 'ai' ? (
                  <AIMessage key={msg.id} message={msg.content} />
                ) : (
                  <UserMessage key={msg.id} message={msg.content} />
                )
              ))}
            </div>

            {/* Step 1: Provider Selection */}
            {currentStep === 1 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                <ProviderCard
                  icon={<CodeIcon className="w-6 h-6" />}
                  title="GitHub"
                  description="Use GitHub repositories for your Terraform configurations"
                  onClick={() => handleProviderSelect('github')}
                  selected={provider === 'github'}
                  data-testid="card-provider-github"
                />
                <ProviderCard
                  icon={<Cloud className="w-6 h-6" />}
                  title="Azure DevOps"
                  description="Use Azure DevOps repositories for your infrastructure code"
                  onClick={() => handleProviderSelect('azure')}
                  selected={provider === 'azure'}
                  data-testid="card-provider-azure"
                />
              </div>
            )}

            {/* Step 2: Repository Selection */}
            {currentStep === 2 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <RepositoryList
                  repositories={repositories}
                  selectedId={selectedRepo}
                  onSelect={handleRepoSelect}
                />
                {provider === 'github' && (
                  <CreateRepoForm 
                    onSubmit={handleCreateRepo}
                    loading={createRepoMutation.isPending}
                  />
                )}
                {provider === 'azure' && (
                  <div className="rounded-lg border border-border bg-card p-6">
                    <h3 className="text-lg font-semibold mb-2">Azure DevOps Limitation</h3>
                    <p className="text-sm text-muted-foreground">
                      The Azure DevOps MCP server does not support creating repositories. 
                      Please create your repository manually in Azure DevOps, then select it from the list.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Step 3: Cloud Provider Selection */}
            {currentStep === 3 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto">
                <ProviderCard
                  icon={<Cloud className="w-6 h-6" />}
                  title="Microsoft Azure"
                  description="Generate Terraform for Azure cloud resources"
                  onClick={() => handleCloudProviderSelect('azure')}
                  selected={cloudProvider === 'azure'}
                  data-testid="card-cloud-azure"
                />
                <ProviderCard
                  icon={<CloudCog className="w-6 h-6" />}
                  title="Amazon Web Services"
                  description="Generate Terraform for AWS cloud resources"
                  onClick={() => handleCloudProviderSelect('aws')}
                  selected={cloudProvider === 'aws'}
                  data-testid="card-cloud-aws"
                />
                <ProviderCard
                  icon={<Package className="w-6 h-6" />}
                  title="Google Cloud"
                  description="Generate Terraform for GCP cloud resources"
                  onClick={() => handleCloudProviderSelect('gcp')}
                  selected={cloudProvider === 'gcp'}
                  data-testid="card-cloud-gcp"
                />
              </div>
            )}

            {/* Step 4: Module Approach Selection */}
            {currentStep === 4 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto">
                <ProviderCard
                  icon={<Package className="w-6 h-6" />}
                  title="Child Module"
                  description="Generate configuration specific to a child module"
                  onClick={() => handleModuleApproachSelect('child-module')}
                  selected={moduleApproach === 'child-module'}
                  data-testid="card-module-child"
                />
                <ProviderCard
                  icon={<CodeIcon className="w-6 h-6" />}
                  title="Standalone Root"
                  description="Create a standalone root module configuration"
                  onClick={() => handleModuleApproachSelect('standalone-root')}
                  selected={moduleApproach === 'standalone-root'}
                  data-testid="card-module-standalone"
                />
                <ProviderCard
                  icon={<CloudCog className="w-6 h-6" />}
                  title="Aggregated Root"
                  description="Build root module by aggregating child modules"
                  onClick={() => handleModuleApproachSelect('aggregated-root')}
                  selected={moduleApproach === 'aggregated-root'}
                  data-testid="card-module-aggregated"
                />
              </div>
            )}

            {/* Step 5: Backend Configuration */}
            {currentStep === 5 && (
              <div className="max-w-2xl mx-auto space-y-6">
                <div className="rounded-lg border border-border bg-card p-6">
                  <h3 className="text-lg font-semibold mb-4">Configure Terraform Backend</h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    Terraform uses a backend to store state files. Choose how you want to configure the backend for this project:
                  </p>
                  
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Button
                      onClick={() => handleBackendConfiguration('create')}
                      disabled={configureBackendMutation.isPending}
                      variant="outline"
                      className="h-auto p-4 text-left flex flex-col items-start justify-start"
                      data-testid="button-backend-create"
                    >
                      <div className="font-medium mb-1">Create with Defaults</div>
                      <div className="text-sm text-muted-foreground">
                        Auto-generate backend configuration with sensible defaults
                      </div>
                    </Button>
                    
                    <Button
                      onClick={() => handleBackendConfiguration('decline')}
                      disabled={configureBackendMutation.isPending}
                      variant="outline"
                      className="h-auto p-4 text-left flex flex-col items-start justify-start"
                      data-testid="button-backend-decline"
                    >
                      <div className="font-medium mb-1">Skip Backend</div>
                      <div className="text-sm text-muted-foreground">
                        Use local state management (not recommended for production)
                      </div>
                    </Button>
                    
                    <Button
                      onClick={() => handleBackendConfiguration('validate')}
                      disabled={configureBackendMutation.isPending || cloudProvider !== 'azure'}
                      variant="outline"
                      className="h-auto p-4 text-left flex flex-col items-start justify-start"
                      data-testid="button-backend-validate"
                    >
                      <div className="font-medium mb-1">Validate Existing</div>
                      <div className="text-sm text-muted-foreground">
                        Validate existing backend.tf configuration
                      </div>
                    </Button>
                  </div>
                  
                  {cloudProvider !== 'azure' && (
                    <p className="text-sm text-muted-foreground mt-4">
                      Note: Backend validation is currently only supported for Azure.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Step 7: Review & Edit */}
            {currentStep === 7 && generatedFiles.length > 0 && (
              <div className="space-y-6">
                <CodeEditor 
                  files={generatedFiles.map(f => ({ name: f.fileName, content: f.content }))} 
                  onFileChange={handleFileChange} 
                />
                <CheckovScanner 
                  sessionId={sessionId}
                  onScanComplete={() => setScanCompleted(true)}
                />
                <ActionButtons
                  onApprove={handleApprove}
                  onCancel={handleCancel}
                  loading={commitMutation.isPending}
                  disabled={isCommitted || !scanCompleted}
                />
                {!scanCompleted && !isCommitted && (
                  <p className="text-sm text-muted-foreground text-center">
                    Please run the security scan before committing
                  </p>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Chat Input - Only show in step 6 (Generate) */}
        {currentStep === 6 && (
          <ChatInput
            onSend={handleGenerateRequest}
            placeholder="Describe your Terraform setup... e.g., 'Create Terraform for Azure Storage Account and Resource Group'"
            disabled={chatMutation.isPending || generateTerraformMutation.isPending}
          />
        )}
      </main>
    </div>
  );
}
