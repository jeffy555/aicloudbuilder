import { useState } from "react";
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

type Step = 1 | 2 | 3 | 4;
type Provider = 'github' | 'azure' | null;

interface Message {
  id: string;
  type: 'ai' | 'user';
  content: string;
}

export default function Home() {
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [provider, setProvider] = useState<Provider>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      type: 'ai',
      content: "Hey! Before we dive into your Terraform setup, which repository provider would you like to use — GitHub or Azure DevOps? I'll route everything accordingly."
    }
  ]);
  
  // Mock data - will be replaced with real data
  const mockRepos = [
    { id: '1', name: 'infrastructure-prod', branch: 'main', lastUpdated: '2 hours ago' },
    { id: '2', name: 'terraform-modules', branch: 'develop', lastUpdated: '1 day ago' },
    { id: '3', name: 'devops-automation', branch: 'main', lastUpdated: '3 days ago' },
  ];

  const [files, setFiles] = useState([
    {
      name: 'main.tf',
      content: `resource "azurerm_resource_group" "example" {
  name     = "example-resources"
  location = "East US"
}

resource "azurerm_storage_account" "example" {
  name                     = "examplestorageacct"
  resource_group_name      = azurerm_resource_group.example.name
  location                 = azurerm_resource_group.example.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}`
    },
    {
      name: 'variables.tf',
      content: `variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
  default     = "example-resources"
}`
    },
    {
      name: 'terraform.tfvars',
      content: `resource_group_name = "example-resources"
location           = "East US"`
    }
  ]);

  const steps = [
    { number: 1, title: 'Provider' },
    { number: 2, title: 'Repository' },
    { number: 3, title: 'Generate' },
    { number: 4, title: 'Review' },
  ];

  const handleProviderSelect = (selectedProvider: Provider) => {
    setProvider(selectedProvider);
    const providerName = selectedProvider === 'github' ? 'GitHub' : 'Azure DevOps';
    
    setMessages(prev => [
      ...prev,
      { id: Date.now().toString(), type: 'user', content: `I'd like to use ${providerName}` },
      { 
        id: (Date.now() + 1).toString(), 
        type: 'ai', 
        content: `Great choice! I'll connect to ${providerName} for you. Would you like to select an existing repository or create a new one?`
      }
    ]);
    
    setCurrentStep(2);
  };

  const handleRepoSelect = (repoId: string) => {
    setSelectedRepo(repoId);
    const repo = mockRepos.find(r => r.id === repoId);
    
    setMessages(prev => [
      ...prev,
      { id: Date.now().toString(), type: 'user', content: `Use repository: ${repo?.name}` },
      { 
        id: (Date.now() + 1).toString(), 
        type: 'ai', 
        content: `Perfect! Now, let's build your Terraform setup. Just describe the resources you want — for example: 'Create Terraform for Azure Storage Account and Resource Group'. I'll generate the necessary files and let you review them before we commit.`
      }
    ]);
    
    setCurrentStep(3);
  };

  const handleCreateRepo = (name: string, description: string) => {
    toast({
      title: "Repository Created",
      description: `Successfully created repository: ${name}`,
    });
    
    setMessages(prev => [
      ...prev,
      { id: Date.now().toString(), type: 'user', content: `Create repo '${name}'` },
      { 
        id: (Date.now() + 1).toString(), 
        type: 'ai', 
        content: `Got it — creating a new repo called ${name} for you now... ✅ Done! You're all set. Now, describe the Terraform resources you'd like to generate.`
      }
    ]);
    
    setCurrentStep(3);
  };

  const handleGenerateRequest = (message: string) => {
    setMessages(prev => [
      ...prev,
      { id: Date.now().toString(), type: 'user', content: message },
      { 
        id: (Date.now() + 1).toString(), 
        type: 'ai', 
        content: `I've generated your Terraform files based on your description. Here are the files — feel free to tweak anything before we push them to your repo.`
      }
    ]);
    
    setCurrentStep(4);
  };

  const handleFileChange = (fileName: string, content: string) => {
    setFiles(files.map(f => f.name === fileName ? { ...f, content } : f));
  };

  const handleApprove = () => {
    const repo = mockRepos.find(r => r.id === selectedRepo);
    
    toast({
      title: "Committing Changes",
      description: "Pushing your Terraform configuration to the repository...",
    });

    setTimeout(() => {
      setMessages(prev => [
        ...prev,
        { 
          id: Date.now().toString(), 
          type: 'ai', 
          content: `Awesome — committing your Terraform setup to ${repo?.name || 'your repository'} with the message: 'Added Terraform for Azure Storage Account and Resource Group'\n\n✅ Done! Your code is now live.`
        }
      ]);

      toast({
        title: "Success!",
        description: "Your Terraform configuration has been committed successfully.",
      });
    }, 2000);
  };

  const handleCancel = () => {
    setCurrentStep(3);
    toast({
      title: "Cancelled",
      description: "You can continue editing your Terraform files.",
    });
  };

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
                  repositories={mockRepos}
                  selectedId={selectedRepo}
                  onSelect={handleRepoSelect}
                />
                <CreateRepoForm onSubmit={handleCreateRepo} />
              </div>
            )}

            {/* Step 4: Review & Edit */}
            {currentStep === 4 && (
              <div className="space-y-6">
                <CodeEditor files={files} onFileChange={handleFileChange} />
                <ActionButtons
                  onApprove={handleApprove}
                  onCancel={handleCancel}
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
          />
        )}
      </main>
    </div>
  );
}
