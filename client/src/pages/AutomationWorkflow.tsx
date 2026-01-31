import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useSecretsConfig } from "@/hooks/useSecretsConfig";
import Header from "@/components/Header";
import AIMessage from "@/components/AIMessage";
import UserMessage from "@/components/UserMessage";
import ChatInput from "@/components/ChatInput";
import RepositoryList from "@/components/RepositoryList";
import CodeEditor from "@/components/CodeEditor";
import StepIndicator from "@/components/StepIndicator";
import { FileCode, Terminal, Code2, Shell, Home, RefreshCw, CodeIcon, Cloud } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import type { Session, Message, GeneratedFile, Repository } from "@shared/schema";

type Step = 1 | 2 | 3 | 4;
type Language = 'python' | 'powershell' | 'shell' | 'bash' | null;
type Provider = 'github' | 'azure' | null;

export default function AutomationWorkflow() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [sessionId, setSessionId] = useState<string>('');
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [selectedLanguage, setSelectedLanguage] = useState<Language>(null);
  const [provider, setProvider] = useState<Provider>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [automationPrompt, setAutomationPrompt] = useState<string>('');
  const [existingRepoFiles, setExistingRepoFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [isPushed, setIsPushed] = useState<boolean>(false);

  const steps = [
    { number: 1, title: 'Language' },
    { number: 2, title: 'Repository' },
    { number: 3, title: 'Automation' },
    { number: 4, title: 'Review' },
  ];

  const languageOptions = [
    { id: 'python' as Language, name: 'Python', icon: <FileCode className="w-6 h-6" />, extension: '.py' },
    { id: 'powershell' as Language, name: 'PowerShell', icon: <Terminal className="w-6 h-6" />, extension: '.ps1' },
    { id: 'shell' as Language, name: 'Shell', icon: <Shell className="w-6 h-6" />, extension: '.sh' },
    { id: 'bash' as Language, name: 'Bash', icon: <Code2 className="w-6 h-6" />, extension: '.sh' },
  ];

  // Create or restore session on mount
  useEffect(() => {
    const initializeSession = async () => {
      const savedSessionId = localStorage.getItem('automation_workflow_session_id');
      
      if (savedSessionId) {
        try {
          const response = await apiRequest('GET', `/api/sessions/${savedSessionId}`);
          const session = await response.json() as Session;
          setSessionId(session.id);
          return;
        } catch (error) {
          localStorage.removeItem('automation_workflow_session_id');
        }
      }
      
      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      localStorage.setItem('automation_workflow_session_id', session.id);
      
      await apiRequest('POST', `/api/sessions/${session.id}/messages/system`, { 
        message: 'Welcome! Select a scripting language to get started with automation.' 
      });
    };

    initializeSession();
  }, []);

  // Fetch messages
  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: ['/api/sessions', sessionId, 'messages'],
    enabled: !!sessionId,
    refetchInterval: 2000,
  });

  const { data: config } = useSecretsConfig();

  // Fetch repositories
  const { data: repositories = [] } = useQuery<Repository[]>({
    queryKey: ['/api/repositories', provider],
    enabled: !!provider && currentStep === 2,
  });

  // Fetch generated files
  const { data: generatedFiles = [] } = useQuery<GeneratedFile[]>({
    queryKey: ['/api/sessions', sessionId, 'files'],
    enabled: !!sessionId && currentStep === 4,
    refetchOnMount: true,
  });

  // Scan repository for existing files
  const scanRepositoryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/scan-repository`);
      return res.json();
    },
    onSuccess: (data: any) => {
      // Store all files from repository (terraformFilesWithContent contains all files with content)
      if (data.terraformFilesWithContent && data.terraformFilesWithContent.length > 0) {
        setExistingRepoFiles(data.terraformFilesWithContent.map((f: any) => ({
          path: f.path || f.fileName,
          content: f.content || ''
        })));
      } else if (data.files && data.files.length > 0) {
        // Fallback: if files are in different format
        setExistingRepoFiles(data.files.map((f: any) => ({
          path: f.path || f.fileName,
          content: f.content || ''
        })));
      }
    },
    onError: (error: any) => {
      console.error('Error scanning repository:', error);
      // Don't show error toast - it's okay if scan fails for automation
    }
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

  // Generate automation script mutation
  const generateScriptMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/generate-automation`, {
        language: selectedLanguage,
        prompt: prompt,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      setCurrentStep(4);
      // Set default commit message
      if (!commitMessage) {
        setCommitMessage(`Add automation script: ${automationPrompt}`);
      }
      toast({
        title: "Script Generated",
        description: "Your automation script has been generated successfully!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Generation Failed",
        description: error.message || "Failed to generate automation script",
        variant: "destructive",
      });
    }
  });

  // Commit and push mutation
  const commitMutation = useMutation({
    mutationFn: async ({ message, branch }: { message: string; branch: string }) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/commit-automation`, {
        message,
        branch,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setIsPushed(true);
      toast({
        title: "Code Pushed",
        description: `Successfully pushed to ${provider} repository`,
      });
      chatMutation.mutate(`Files committed successfully with message: "${data.commitMessage}". Your automation script has been added to the repository!`);
    },
    onError: (error: any) => {
      toast({
        title: "Push Failed",
        description: error.message || "Failed to push code to repository",
        variant: "destructive",
      });
    }
  });

  const handleLanguageSelect = (language: Language) => {
    setSelectedLanguage(language);
    setCurrentStep(2);
    chatMutation.mutate(`Selected ${languageOptions.find(l => l.id === language)?.name} as the scripting language.`);
  };

  const handleProviderSelect = async (selectedProvider: Provider) => {
    setProvider(selectedProvider);
    // Update session with provider
    if (sessionId) {
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { provider: selectedProvider });
    }
    chatMutation.mutate(`Selected ${selectedProvider === 'github' ? 'GitHub' : 'Azure Repo'} as the repository provider.`);
  };

  const handleRepoSelect = async (repoId: string) => {
    setSelectedRepo(repoId);
    const repo = repositories.find(r => r.id === repoId);
    // Update session with repository name
    if (sessionId && repo) {
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { repositoryName: repo.name });
      // Scan repository for existing files
      try {
        await scanRepositoryMutation.mutateAsync();
      } catch (error) {
        console.error('Failed to scan repository:', error);
      }
    }
    setCurrentStep(3);
    chatMutation.mutate(`Selected repository. Now, what needs to be automated?`);
  };

  const handleAutomationSubmit = async (prompt: string) => {
    setAutomationPrompt(prompt);
    // Send AI system message that we're working on it
    try {
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
        message: `I'm working on creating the automation script for: "${prompt}". This may take a moment...`
      });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    } catch (error) {
      console.error('Failed to send working message:', error);
    }
    // Then generate the script
    generateScriptMutation.mutate(prompt);
  };

  const handleCommit = (message: string, branch: string = 'main') => {
    commitMutation.mutate({ message, branch });
  };

  const handleGoHome = () => {
    setLocation('/');
  };

  // Handle refresh - reset session and state
  const handleRefresh = async () => {
    try {
      localStorage.removeItem('automation_workflow_session_id');
      setSessionId('');
      setCurrentStep(1);
      setSelectedLanguage(null);
      setProvider(null);
      setSelectedRepo('');
      setAutomationPrompt('');
      setExistingRepoFiles([]);
      setCommitMessage('');
      setIsPushed(false);
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions'] });
      
      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      localStorage.setItem('automation_workflow_session_id', session.id);
      
      await apiRequest('POST', `/api/sessions/${session.id}/messages/system`, { 
        message: 'Welcome! Select a scripting language to get started with automation.' 
      });
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', session.id, 'messages'] });
      
      toast({
        title: "Refreshed",
        description: "Started a new session. You can now begin a new automation workflow.",
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
    <div className="h-screen flex flex-col bg-white">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <Header />
      
      <main id="main-content" className="flex-1 overflow-hidden flex flex-col" role="main" aria-label="Automation workflow">
        <div className="py-6 px-4 sm:px-6 lg:px-8">
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Terminal className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h1 className="text-3xl font-bold">Automation Scripts</h1>
                  <p className="text-muted-foreground">
                    Build automation scripts for CI/CD pipelines and DevOps workflows
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRefresh}
                  disabled={commitMutation.isPending}
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
        </div>

        <ScrollArea className="flex-1 px-4 sm:px-6 lg:px-8">
          <div className="max-w-6xl mx-auto pb-8 space-y-6">
            {/* Step 1: Language Selection */}
            {currentStep === 1 && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select a Scripting Language</h2>
                  <p className="text-muted-foreground">
                    Choose the language for your automation script
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {languageOptions.map((lang) => {
                    // Define colors for each language
                    let cardBgColor = '';
                    let cardBorderColor = '';
                    let iconBgColor = '';
                    let iconTextColor = '';
                    let titleColor = '';
                    let descriptionColor = '';
                    
                    if (lang.id === 'powershell') {
                      // Light Blue for PowerShell
                      cardBgColor = 'bg-sky-50 dark:bg-sky-950/50';
                      cardBorderColor = 'border-sky-200 dark:border-sky-800';
                      iconBgColor = 'bg-sky-100 dark:bg-sky-900/30';
                      iconTextColor = 'text-sky-600 dark:text-sky-400';
                      titleColor = 'text-sky-900 dark:text-sky-100';
                      descriptionColor = 'text-sky-700 dark:text-sky-300';
                    } else if (lang.id === 'python') {
                      // Blue and Yellow mixed for Python
                      cardBgColor = 'bg-gradient-to-br from-blue-50 to-yellow-50 dark:from-blue-950/50 dark:to-yellow-950/50';
                      cardBorderColor = 'border-blue-200 dark:border-blue-800';
                      iconBgColor = 'bg-gradient-to-br from-blue-100 to-yellow-100 dark:from-blue-900/30 dark:to-yellow-900/30';
                      iconTextColor = 'text-blue-600 dark:text-blue-400';
                      titleColor = 'text-blue-900 dark:text-blue-100';
                      descriptionColor = 'text-blue-700 dark:text-blue-300';
                    } else if (lang.id === 'bash') {
                      // Light grey for Bash
                      cardBgColor = 'bg-gray-100 dark:bg-gray-800';
                      cardBorderColor = 'border-gray-300 dark:border-gray-700';
                      iconBgColor = 'bg-gray-200 dark:bg-gray-700';
                      iconTextColor = 'text-gray-700 dark:text-gray-300';
                      titleColor = 'text-gray-900 dark:text-gray-100';
                      descriptionColor = 'text-gray-700 dark:text-gray-300';
                    } else if (lang.id === 'shell') {
                      // Peach color for Shell
                      cardBgColor = 'bg-orange-50 dark:bg-orange-950/50';
                      cardBorderColor = 'border-orange-200 dark:border-orange-800';
                      iconBgColor = 'bg-orange-100 dark:bg-orange-900/30';
                      iconTextColor = 'text-orange-600 dark:text-orange-400';
                      titleColor = 'text-orange-900 dark:text-orange-100';
                      descriptionColor = 'text-orange-700 dark:text-orange-300';
                    }
                    
                    return (
                      <Card
                        key={lang.id}
                        className={`cursor-pointer hover:shadow-lg transition-all duration-200 ease-in-out hover:-translate-y-1 ${cardBgColor} ${cardBorderColor}`}
                        onClick={() => handleLanguageSelect(lang.id)}
                      >
                        <CardHeader>
                          <div className="flex items-center gap-3">
                            <div className={`p-3 rounded-lg ${iconBgColor} ${iconTextColor}`}>
                              {lang.icon}
                            </div>
                            <CardTitle className={titleColor}>{lang.name}</CardTitle>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <CardDescription className={descriptionColor}>
                            {lang.extension} files
                          </CardDescription>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Step 2: Repository Selection */}
            {currentStep === 2 && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select Repository Provider</h2>
                  <p className="text-muted-foreground">
                    Choose where to push your automation script
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                  {config?.hasGithub && (
                    <Card
                      className="cursor-pointer hover:shadow-lg transition-all duration-200 ease-in-out hover:-translate-y-1 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/50"
                      onClick={() => handleProviderSelect('github')}
                    >
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-green-900 dark:text-green-100">
                          <div className="w-8 h-8 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center text-green-600 dark:text-green-400">
                            <CodeIcon className="w-4 h-4" />
                          </div>
                          GitHub
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <CardDescription className="text-green-700 dark:text-green-300">
                          Push to GitHub repository
                        </CardDescription>
                      </CardContent>
                    </Card>
                  )}
                  {config?.hasAzureDevOps && (
                    <Card
                      className="cursor-pointer hover:shadow-lg transition-all duration-200 ease-in-out hover:-translate-y-1 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/50"
                      onClick={() => handleProviderSelect('azure')}
                    >
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-blue-900 dark:text-blue-100">
                          <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400">
                            <Cloud className="w-4 h-4" />
                          </div>
                          Azure Repo
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <CardDescription className="text-blue-700 dark:text-blue-300">
                          Push to Azure DevOps repository
                        </CardDescription>
                      </CardContent>
                    </Card>
                  )}
                  {!config?.hasGithub && !config?.hasAzureDevOps && (
                    <div className="col-span-2 text-center py-12">
                      <p className="text-muted-foreground mb-4">No repository providers configured.</p>
                      <Button onClick={() => setLocation('/settings')}>Go to Settings</Button>
                    </div>
                  )}
                </div>

                {provider && (
                  <div className="mt-8">
                    {repositories.length > 0 ? (
                      <RepositoryList
                        repositories={repositories}
                        onSelect={handleRepoSelect}
                        selectedId={selectedRepo}
                        showSearch={true}
                      />
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <p>Loading repositories...</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Step 3: Automation Chat */}
            {currentStep === 3 && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">What needs to be automated?</h2>
                  <p className="text-muted-foreground">
                    Describe the automation task you want to create
                  </p>
                </div>

                <div className="mb-8">
                  {messages.map((msg) => (
                    msg.type === 'ai' ? (
                      <AIMessage key={msg.id} message={msg.content} />
                    ) : (
                      <UserMessage key={msg.id} message={msg.content} />
                    )
                  ))}
                </div>

                <ChatInput
                  onSend={handleAutomationSubmit}
                  disabled={generateScriptMutation.isPending}
                  placeholder="Describe what you want to automate..."
                />

                {generateScriptMutation.isPending && (
                  <div className="text-center text-muted-foreground">
                    Generating automation script...
                  </div>
                )}
              </div>
            )}

            {/* Step 4: Review and Push */}
            {currentStep === 4 && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">
                    {isPushed ? 'Script Successfully Pushed!' : 'Review Generated Script'}
                  </h2>
                  <p className="text-muted-foreground">
                    {isPushed 
                      ? 'Your automation script has been successfully added to the repository.'
                      : 'Review your automation script and push to repository'}
                  </p>
                </div>

                {generatedFiles.length > 0 ? (
                  <div className="space-y-4">
                    <CodeEditor
                      files={[
                        // Show existing repo files first
                        ...existingRepoFiles.map(f => ({ name: f.path, content: f.content })),
                        // Show generated files (these will be added to repo)
                        ...generatedFiles.map(f => ({ name: f.fileName, content: f.content }))
                      ]}
                      existingFiles={existingRepoFiles.map(f => f.path)}
                      onFileChange={(fileName, content) => {
                        // Only allow editing generated files, not existing repo files
                        const file = generatedFiles.find(f => f.fileName === fileName);
                        if (file) {
                          apiRequest('PATCH', `/api/files/${file.id}`, { content })
                            .then(() => {
                              queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                            })
                            .catch(console.error);
                        }
                      }}
                    />
                    {existingRepoFiles.length > 0 && (
                      <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
                        <p className="font-medium mb-1">Repository Files:</p>
                        <p>This repository contains {existingRepoFiles.length} existing file(s). Your automation script will be added as a new file alongside these existing files.</p>
                      </div>
                    )}
                    {!isPushed ? (
                      <Card className="p-4 space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="commit-message">Commit Message *</Label>
                          <Input
                            id="commit-message"
                            value={commitMessage}
                            onChange={(e) => setCommitMessage(e.target.value)}
                            placeholder={`Add automation script: ${automationPrompt}`}
                            className="w-full"
                          />
                          <p className="text-xs text-muted-foreground">
                            {existingRepoFiles.length > 0 
                              ? `Note: Your automation script will be added to this repository alongside ${existingRepoFiles.length} existing file(s).`
                              : 'Your automation script will be committed to the repository.'}
                          </p>
                        </div>
                        <div className="flex gap-4 justify-end">
                          <Button
                            onClick={() => {
                              const message = commitMessage.trim() || `Add automation script: ${automationPrompt}`;
                              handleCommit(message);
                            }}
                            disabled={commitMutation.isPending}
                          >
                            {commitMutation.isPending ? 'Pushing...' : 'Push to Repository'}
                          </Button>
                        </div>
                      </Card>
                    ) : (
                      <Card className="p-6">
                        <div className="text-center space-y-4">
                          <div className="text-green-600 dark:text-green-400">
                            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </div>
                          <div>
                            <h3 className="text-lg font-semibold mb-2">Success!</h3>
                            <p className="text-muted-foreground mb-4">
                              Your automation script has been successfully pushed to the repository.
                            </p>
                          </div>
                          <Button
                            onClick={() => setLocation('/')}
                            variant="default"
                            size="lg"
                          >
                            Go Back Home
                          </Button>
                        </div>
                      </Card>
                    )}
                  </div>
                ) : (
                  <div className="text-center text-muted-foreground">
                    No files generated yet. Please go back and generate a script.
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}

