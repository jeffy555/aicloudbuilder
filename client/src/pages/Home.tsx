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
import { CodeIcon } from "@radix-ui/react-icons";
import { Cloud } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import type { Session, Message, GeneratedFile, Repository } from "@shared/schema";

type Step = 1 | 2 | 3 | 4;
type Provider = 'github' | 'azure' | null;

export default function Home() {
  const { toast } = useToast();
  const [sessionId, setSessionId] = useState<string>('');
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [provider, setProvider] = useState<Provider>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>('');

  const steps = [
    { number: 1, title: 'Provider' },
    { number: 2, title: 'Repository' },
    { number: 3, title: 'Generate' },
    { number: 4, title: 'Review' },
  ];

  // Create session on mount
  useEffect(() => {
    const createSession = async () => {
      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      
      // Send initial AI message
      const chatResponse = await apiRequest('POST', `/api/sessions/${session.id}/chat`, { 
        message: 'Hello' 
      });
      await chatResponse.json();
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
    enabled: !!sessionId && currentStep === 4,
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
      setCurrentStep(4);
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
    }
  });

  // Commit files mutation
  const commitMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/commit`);
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Success!",
        description: `Your Terraform configuration has been committed: ${data.commitMessage}`,
      });
      
      chatMutation.mutate(`Files committed successfully with message: "${data.commitMessage}"`);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: "Failed to commit files. Please try again.",
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
    chatMutation.mutate(`I'd like to use ${providerName}`);
    
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

    chatMutation.mutate(`Use repository: ${repo?.name}`);
    setCurrentStep(3);
  };

  const handleCreateRepo = async (name: string, description: string) => {
    await createRepoMutation.mutateAsync({ name, description });
    
    await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
      repositoryName: name,
      currentStep: '3'
    });

    chatMutation.mutate(`Create repo '${name}'`);
    setCurrentStep(3);
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
    setCurrentStep(3);
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
                />
                <ProviderCard
                  icon={<Cloud className="w-6 h-6" />}
                  title="Azure DevOps"
                  description="Use Azure DevOps repositories for your infrastructure code"
                  onClick={() => handleProviderSelect('azure')}
                  selected={provider === 'azure'}
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
                <CreateRepoForm 
                  onSubmit={handleCreateRepo}
                  loading={createRepoMutation.isPending}
                />
              </div>
            )}

            {/* Step 4: Review & Edit */}
            {currentStep === 4 && generatedFiles.length > 0 && (
              <div className="space-y-6">
                <CodeEditor 
                  files={generatedFiles.map(f => ({ name: f.fileName, content: f.content }))} 
                  onFileChange={handleFileChange} 
                />
                <ActionButtons
                  onApprove={handleApprove}
                  onCancel={handleCancel}
                  loading={commitMutation.isPending}
                />
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Chat Input - Only show in step 3 */}
        {currentStep === 3 && (
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
