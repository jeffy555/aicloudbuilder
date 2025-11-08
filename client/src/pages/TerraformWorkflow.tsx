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
import { useToast } from "@/hooks/use-toast";
import type { Session, Message, GeneratedFile, Repository } from "@shared/schema";

type Step = 1 | 2 | 3 | 4 | 5 | 6;
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

  const steps = [
    { number: 1, title: 'Provider' },
    { number: 2, title: 'Repository' },
    { number: 3, title: 'Cloud' },
    { number: 4, title: 'Module' },
    { number: 5, title: 'Generate' },
    { number: 6, title: 'Review' },
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
    enabled: !!sessionId && currentStep === 6,
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

  // Generate Terraform mutation
  const generateTerraformMutation = useMutation({
    mutationFn: async (description: string) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/generate-terraform`, { description });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      setCurrentStep(6);
      setScanCompleted(false); // Reset scan state for new files
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
      currentStep: '3'
    });

    // User confirmation
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: `Selected repository: ${repo?.name}` 
    });
    
    // System guidance for next step
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: 'Perfect! Now choose your target cloud provider (Azure, AWS, or GCP).' 
    });
    
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    setCurrentStep(3);
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
    
    const cloudName = cloudProvider === 'azure' ? 'Microsoft Azure' : 
                      cloudProvider === 'aws' ? 'Amazon Web Services (AWS)' : 
                      'Google Cloud Platform (GCP)';
    
    // User confirmation
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: `Selected ${approachName}` 
    });
    
    // System guidance for next step
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
      message: `Now describe the infrastructure you want to create for ${cloudName}. Be specific about resources, configurations, and requirements.` 
    });
    
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    setCurrentStep(5);
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
    setCurrentStep(5);
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

            {/* Step 6: Review & Edit */}
            {currentStep === 6 && generatedFiles.length > 0 && (
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

        {/* Chat Input - Only show in step 5 (Generate) */}
        {currentStep === 5 && (
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
