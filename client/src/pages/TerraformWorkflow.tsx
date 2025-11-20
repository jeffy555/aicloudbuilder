import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
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
import CostAnalyzer from "@/components/CostAnalyzer";
import RefactorValidator from "@/components/RefactorValidator";
import { CodeIcon } from "@radix-ui/react-icons";
import { Cloud, CloudCog, Package, Home, FileText, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import type { Session, Message, GeneratedFile, Repository, RepositoryScanResult } from "@shared/schema";

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type Provider = 'github' | 'azure' | null;
type CloudProvider = 'azure' | 'aws' | 'gcp' | null;
type ModuleApproach = 'child-module' | 'standalone-root' | 'aggregated-root' | null;

export default function TerraformWorkflow() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
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
  // Azure backend fields
  const [backendResourceGroup, setBackendResourceGroup] = useState<string>('');
  const [backendStorageAccount, setBackendStorageAccount] = useState<string>('');
  const [backendContainer, setBackendContainer] = useState<string>('');
  // AWS backend fields
  const [backendBucket, setBackendBucket] = useState<string>('');
  const [backendDynamodbTable, setBackendDynamodbTable] = useState<string>('terraform-state-lock');
  const [backendRegion, setBackendRegion] = useState<string>('us-east-1');
  const [existingFilesReviewed, setExistingFilesReviewed] = useState<boolean>(false);
  const [existingFiles, setExistingFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [selectedFileToReview, setSelectedFileToReview] = useState<string | null>(null);
  const [filesBeforeGeneration, setFilesBeforeGeneration] = useState<Map<string, string>>(new Map()); // fileName -> fileId


  const steps = [
    { number: 1, title: 'Provider' },
    { number: 2, title: 'Repository' },
    { number: 3, title: 'Cloud' },
    { number: 4, title: 'Module' },
    { number: 5, title: 'Backend' },
    { number: 6, title: 'Generate' },
    { number: 7, title: 'Review' },
  ];

  // Create or restore session on mount
  useEffect(() => {
    const initializeSession = async () => {
      // Try to restore session from localStorage first
      const savedSessionId = localStorage.getItem('terraform_workflow_session_id');
      
      if (savedSessionId) {
        // Verify session still exists on server
        try {
          const response = await apiRequest('GET', `/api/sessions/${savedSessionId}`);
          const session = await response.json() as Session;
          setSessionId(session.id);
          console.log('Restored existing session:', session.id);
          return; // Session exists, no need to create new one
        } catch (error) {
          // Session doesn't exist anymore, create new one
          console.log('Previous session not found, creating new session');
          localStorage.removeItem('terraform_workflow_session_id');
        }
      }
      
      // Create new session
      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      
      // Save session ID to localStorage for persistence
      localStorage.setItem('terraform_workflow_session_id', session.id);
      console.log('Created new session:', session.id);
      
      // Create initial welcome message without AI chat
      await apiRequest('POST', `/api/sessions/${session.id}/messages/system`, { 
        message: 'Welcome! Let\'s start by selecting your repository provider. Choose GitHub or Azure DevOps.' 
      });
    };
    initializeSession();
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

  // Sync currentStep with session.currentStep (only on initial load)
  // This ensures we start from the correct step if page is refreshed
  useEffect(() => {
    if (session?.currentStep && currentStep === 1) {
      // Only sync on initial load (when currentStep is still 1)
      // Handlers will manage step transitions after that
      const stepNum = parseInt(session.currentStep, 10) as Step;
      if (stepNum !== 1) {
        setCurrentStep(stepNum);
      }
    }
  }, [session?.currentStep]); // Only sync when session changes, not when currentStep changes

  // Load backend values from session when entering step 5 (only once, don't overwrite user edits)
  useEffect(() => {
    if (currentStep === 5) {
      // Only load from session if all fields are empty (first time entering step 5)
      if (session && !backendResourceGroup && !backendStorageAccount && !backendContainer) {
        if (session.backendResourceGroup) {
          setBackendResourceGroup(session.backendResourceGroup);
        }
        if (session.backendStorageAccount) {
          setBackendStorageAccount(session.backendStorageAccount);
        }
        if (session.backendContainer) {
          setBackendContainer(session.backendContainer);
        }
      }
    }
  }, [currentStep]); // Only run when step changes, not when session changes

  // Fetch repositories
  const { data: repositories = [] } = useQuery<Repository[]>({
    queryKey: ['/api/repositories', provider],
    enabled: !!provider && currentStep === 2,
  });

  // Fetch generated files
  const { data: generatedFiles = [] } = useQuery<GeneratedFile[]>({
    queryKey: ['/api/sessions', sessionId, 'files'],
    enabled: !!sessionId && currentStep === 7,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    staleTime: 0, // Always consider data stale to ensure fresh fetch
  });

  // Debug: Log files when they change
  useEffect(() => {
    if (generatedFiles && generatedFiles.length > 0) {
      console.log('📁 Files received from API:', generatedFiles.length);
      generatedFiles.forEach((f, i) => {
        console.log(`   ${i + 1}. ${f.fileName} (ID: ${f.id}, size: ${f.content.length} chars)`);
      });
    }
  }, [generatedFiles]);

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
    },
    onError: (error) => {
      // Error is handled in handleBackendConfiguration
      // Mutation state will be reset automatically by React Query
      console.error('Backend configuration error:', error);
    }
  });

  // Generate Terraform mutation
  const generateTerraformMutation = useMutation({
    mutationFn: async (description: string) => {
      // Store current files before generation to compare later
      const currentFiles = await queryClient.fetchQuery<GeneratedFile[]>({
        queryKey: ['/api/sessions', sessionId, 'files'],
      });
      const filesMap = new Map<string, string>();
      currentFiles.forEach(f => {
        filesMap.set(f.fileName, f.id);
      });
      setFilesBeforeGeneration(filesMap);
      console.log('📋 Files before generation:', Array.from(filesMap.entries()).map(([name, id]) => `${name}: ${id}`));
      
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/generate-terraform`, { description });
      return res.json();
    },
    onSuccess: async (data) => {
      console.log('✅ Generation successful, response:', data);
      
      // CRITICAL: Aggressively invalidate and refetch files to ensure UI shows updated content
      console.log('🔄 Refreshing files in UI...');
      await queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      // Longer delay to ensure backend has finished updating files
      await new Promise(resolve => setTimeout(resolve, 1000)); // Increased delay
      // Refetch files multiple times to ensure we get the latest
      await queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      await new Promise(resolve => setTimeout(resolve, 500));
      const result = await queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      console.log('🔄 Refetched files:', result);
      
      // Force UI to update by checking file content
      const filesAfterRefresh = await queryClient.fetchQuery<GeneratedFile[]>({
        queryKey: ['/api/sessions', sessionId, 'files'],
      });
      const mainTfAfter = filesAfterRefresh.find(f => f.fileName === 'main.tf');
      if (mainTfAfter) {
        const hasContainerEnv = mainTfAfter.content.includes('azurerm_container_app_environment');
        const hasContainerRegistry = mainTfAfter.content.includes('azurerm_container_registry');
        console.log('🔍 [UI] Final main.tf check after refresh:');
        console.log(`   - Container App Environment: ${hasContainerEnv ? '✅ FOUND' : '❌ NOT FOUND'}`);
        console.log(`   - Container Registry: ${hasContainerRegistry ? '✅ FOUND' : '❌ NOT FOUND'}`);
        console.log(`   - File size: ${mainTfAfter.content.length} chars`);
      }
      
      // Compare files before and after
      const filesAfter = await queryClient.fetchQuery<GeneratedFile[]>({
        queryKey: ['/api/sessions', sessionId, 'files'],
      });
      
      console.log('🔍 COMPARING FILES (BEFORE vs AFTER):');
      let updatedCount = 0;
      let createdCount = 0;
      filesAfter.forEach(f => {
        const beforeId = filesBeforeGeneration.get(f.fileName);
        if (beforeId) {
          if (beforeId === f.id) {
            console.log(`   ✅ UPDATED: ${f.fileName} (same ID: ${f.id})`);
            updatedCount++;
          } else {
            console.log(`   ❌ NEW FILE CREATED: ${f.fileName} (old ID: ${beforeId}, new ID: ${f.id})`);
            createdCount++;
          }
        } else {
          console.log(`   ➕ NEW FILE: ${f.fileName} (ID: ${f.id})`);
          createdCount++;
        }
      });
      console.log(`📊 Summary: ${updatedCount} updated, ${createdCount} created`);
      
      if (updatedCount === 0 && filesBeforeGeneration.size > 0) {
        console.error('❌ CRITICAL: No files were updated! All files were created as new!');
        toast({
          title: "Warning",
          description: "Files were created as new instead of being updated. Check server logs.",
          variant: "destructive",
        });
      }
      
      setCurrentStep(7);
      setScanCompleted(false); // Reset scan state for new files
      toast({
        title: "Success",
        description: "Terraform files generated successfully",
      });
    },
    onError: async (error: any) => {
      console.error('Generate Terraform error:', error);
      
      // Parse error message from apiRequest format: "500: {...json...}" or "500: error text"
      let errorMessage = 'Failed to generate Terraform files';
      let errorData: any = null;
      
      if (error?.message) {
        const match = error.message.match(/^(\d+):\s*(.+)$/);
        if (match) {
          const [, status, text] = match;
          try {
            errorData = JSON.parse(text);
            errorMessage = errorData.error || errorMessage;
            
            // Check for validation errors (400 status)
            if (status === '400' && errorData.details && Array.isArray(errorData.details)) {
              // Phase 1 validation failed
              const validationErrors = errorData.details.join('. ');
              const warnings = errorData.warnings && errorData.warnings.length > 0 
                ? `\n\nWarnings: ${errorData.warnings.join('. ')}`
                : '';
              
              toast({
                title: "Validation Failed",
                description: `${validationErrors}${warnings}`,
                variant: "destructive",
                duration: 10000 // Show longer for validation errors
              });
              return;
            }
            
            // Check for backend configuration requirement
            if (errorData.requiresBackendConfiguration) {
        toast({
          title: "Backend Configuration Required",
          description: "Please configure or decline backend setup before generating Terraform.",
          variant: "destructive"
        });
        setCurrentStep(5); // Go back to backend step
              return;
            }
          } catch {
            // Not JSON, use as-is
            errorMessage = text;
          }
        } else {
          errorMessage = error.message;
        }
      }
      
      toast({
        title: "Generation Failed",
        description: errorMessage,
        variant: "destructive"
      });
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
      
      // Navigate to home after a short delay to show the success message
      setTimeout(() => {
        window.location.href = '/';
      }, 2000);
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

  // Handle home navigation
  const handleGoHome = () => {
    window.location.href = '/';
  };

  // Handle continue after reviewing existing files
  const handleContinueAfterReview = async () => {
    setExistingFilesReviewed(true);
    
    // Check if backend already exists before proceeding
    const sessionData = await apiRequest('GET', `/api/sessions/${sessionId}`).then(r => r.json());
    
    if (sessionData.hasBackend === 'true' || sessionData.hasBackend === true) {
      // Backend already exists - skip to step 6 (Terraform generation)
      console.log('✅ Backend already configured in repository, skipping to Terraform generation');
      setBackendConfigured(true);
      setCurrentStep(6);
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
        currentStep: '6',
        backendValidated: 'true'
      });
      
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'Found existing backend configuration in the repository. You can now describe the infrastructure components you want to create or modify.' 
      });
    } else {
      // No backend exists - go to step 5 for backend configuration
      setCurrentStep(5);
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '5' });
    }
    
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
    
    // AI message with context about detected config
    if (repositoryScanResult) {
      const contextMessage = repositoryScanResult.moduleType === 'child' 
        ? 'I see this is a child module. Would you like me to help you create additional child modules, or modify the existing ones?'
        : 'I see this is a root module. Would you like to add additional resources to this configuration?';
      await chatMutation.mutateAsync(contextMessage);
    }
  };

  const handleProviderSelect = async (selectedProvider: Provider) => {
    setProvider(selectedProvider);
    
    // Pre-warm MCP connection in background (don't wait)
    apiRequest('POST', `/api/repositories/${selectedProvider}/prewarm`, {}).catch(() => {
      // Ignore errors - pre-warming is optional
    });
    
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

    // Azure DevOps now uses REST API for scanning, so it works the same as GitHub
    // No special limitation handling needed

    if (scanResult.isExisting && scanResult.terraformFiles.length > 0) {
      // Existing repo with Terraform files - show review step first
      const moduleTypeText = scanResult.moduleType === 'child' ? 'child module' :
                            scanResult.moduleType === 'root' ? 'root module' : 
                            'configuration';
      const providerText = scanResult.cloudProvider ? 
        ` for ${scanResult.cloudProvider.toUpperCase()}` : '';

      // Store existing files for review
      if (scanResult.terraformFilesWithContent && scanResult.terraformFilesWithContent.length > 0) {
        setExistingFiles(scanResult.terraformFilesWithContent);
      } else {
        // Fallback: create file objects with just paths (content will be fetched if needed)
        setExistingFiles(scanResult.terraformFiles.map(path => ({ path, content: '' })));
      }
      setExistingFilesReviewed(false);

      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: `Found existing ${moduleTypeText}${providerText} with ${scanResult.terraformFiles.length} Terraform files. Please review the existing configuration before proceeding with new resource creation.`
      });

      if (scanResult.cloudProvider && !cloudProvider) {
        await apiRequest('PATCH', `/api/sessions/${sessionId}`, { cloudProvider: scanResult.cloudProvider });
        setCloudProvider(scanResult.cloudProvider);
      }

      // Stay on current step (2) to show review - don't advance yet
      // User will click "Continue" after reviewing files
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
    } else {
      // New/empty repo
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'This appears to be a new repository. Let\'s configure it from scratch.' 
      });

      setCurrentStep(3); // Update local state first
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '3' });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] }); // Invalidate session

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
      // Update session and move to step 6
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
        moduleApproach: selectedApproach,
        currentStep: '6',
        backendDeclined: 'true',
        backendValidated: 'skipped'
      });
      setCurrentStep(6);
    } else {
      // Both standalone-root and aggregated-root modules need backend configuration
      // BUT: Check if backend already exists in the repository
      const sessionData = await apiRequest('GET', `/api/sessions/${sessionId}`).then(r => r.json());
      
      if (sessionData.hasBackend === 'true' || sessionData.hasBackend === true) {
        // Backend already exists - skip backend configuration step
        console.log('✅ Backend already configured in repository, skipping backend configuration step');
        setBackendConfigured(true);
        await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
          moduleApproach: selectedApproach,
          currentStep: '6',
          backendValidated: 'true' // Mark as validated since it already exists
        });
        setCurrentStep(6);
        
          await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
          message: 'Backend configuration already exists in the repository. You can now describe the infrastructure components you want to create.' 
        });
      } else {
        // Backend doesn't exist - show backend configuration form
        await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
          moduleApproach: selectedApproach,
          currentStep: '5'
        });
        setCurrentStep(5);
        
        // Show the form for new setups (standalone-root and aggregated-root)
          await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
          message: 'Please configure the Terraform backend for state management. Enter the Azure resource group, storage account, and container names in the form below, then click "Create Backend" to create the resources and generate backend.tf, provider.tf, and terraform.tf files.' 
        });
      }
    }
    
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
  };

  const handleBackendConfiguration = async (action: 'decline' | 'create' | 'validate', customConfig?: any) => {
    try {
      const result = await configureBackendMutation.mutateAsync({ action, backendConfig: customConfig });
      
      // Invalidate files query to refresh the file list
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      
      // Show result message
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: result.message || 'Backend configured successfully.' 
      });
      
      // If files were generated, show them
      if (result.details?.filesGenerated && result.details.filesGenerated.length > 0) {
        await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
          message: `Generated files: ${result.details.filesGenerated.join(', ')}` 
        });
      }
      
      // System guidance for next step
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'Perfect! Now describe the infrastructure resources you want to create. Be specific about resources, configurations, and requirements (e.g., "Create a resource group, storage account, and app service").' 
      });
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
      
      // Only advance to step 6 if action was successful (not for errors)
      if (action === 'decline' || (action === 'create' && (result.status === 'success' || result.status === 'configured')) || (action === 'validate' && (result.status === 'success' || result.status === 'validated'))) {
      setCurrentStep(6);
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '6' });
      }
      // Otherwise stay on step 5 to allow retry
    } catch (error: any) {
      // Parse error message which is in format "400: {...json...}"
      let errorResponse: any = {};
      let errorMessage = error?.message || "Failed to configure backend. Please try again.";
      
      // Try to parse JSON from error message (format: "400: {...json...}")
      const jsonMatch = errorMessage.match(/^\d+:\s*(\{.*\})/);
      if (jsonMatch) {
        try {
          errorResponse = JSON.parse(jsonMatch[1]);
          errorMessage = errorResponse.error || errorMessage;
        } catch (e) {
          // If parsing fails, use the original message
        }
      }
      
      const requiresRoleAssignment = errorResponse?.requiresRoleAssignment || 
                                    errorMessage.includes('role') || 
                                    errorMessage.includes('Permission') ||
                                    errorMessage.includes('permission');
      
      // Don't show error if it's just a skipped permission check (MCP connection issue)
      const isSkippedCheck = errorMessage.includes('Could not verify permissions') || 
                            errorMessage.includes('MCP connection issue') ||
                            errorMessage.includes('skipped') ||
                            errorMessage.includes('Connection closed');
      
      if (!isSkippedCheck && !errorResponse?.skipped) {
        // Show detailed error message only if it's a real error
        await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
          message: `Backend configuration failed: ${errorMessage}` 
        });
        
        // If it's a permission error, show instructions
        if (requiresRoleAssignment && errorResponse?.instructions) {
          await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
            message: `\`\`\`\n${errorResponse.instructions}\n\`\`\`` 
          });
        }
        
      toast({
        title: "Backend Configuration Failed",
          description: requiresRoleAssignment 
            ? "Service Principal needs role assignments. Check the chat for instructions."
            : errorMessage,
        variant: "destructive"
      });
      } else {
        // For skipped checks, proceed silently or show a minor warning
        // The backend will attempt resource creation anyway
      }
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
      
      // Reset mutation state on error so form remains usable
      configureBackendMutation.reset();
      
      // Stay on current step (5) to allow retry - don't advance
      // Ensure we're still on step 5
      if (currentStep !== 5) {
        setCurrentStep(5);
      }
    }
  };

  const handleGenerateRequest = async (message: string) => {
    await chatMutation.mutateAsync(message);
    await generateTerraformMutation.mutateAsync(message);
  };

  const handleFileChange = (fileName: string, content: string) => {
    if (generatedFiles && Array.isArray(generatedFiles)) {
    const file = generatedFiles.find(f => f.fileName === fileName);
    if (file) {
      updateFileMutation.mutate({ id: file.id, content });
      }
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
            {/* Debug: Current Step */}
            {process.env.NODE_ENV === 'development' && (
              <div className="mb-2 text-xs text-muted-foreground">
                Debug: Current Step = {currentStep}
              </div>
            )}
            
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
              <div className="space-y-6">
                {/* Repository Selection - Hide after repo is selected */}
                {!selectedRepo && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <RepositoryList
                      showSearch={provider === 'github'}
                  repositories={repositories}
                  selectedId={selectedRepo}
                  onSelect={handleRepoSelect}
                />
                    {(provider === 'github' || provider === 'azure') && (
                  <CreateRepoForm 
                    onSubmit={handleCreateRepo}
                    loading={createRepoMutation.isPending}
                  />
                )}
                  </div>
                )}

                {/* Show selected repository info */}
                {selectedRepo && (
                  <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950 p-4 mb-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Package className="w-5 h-5 text-green-600 dark:text-green-400" />
                        <div>
                          <p className="text-sm font-medium text-green-900 dark:text-green-100">
                            Repository Selected
                          </p>
                          <p className="text-xs text-green-700 dark:text-green-300">
                            {repositories.find(r => r.id === selectedRepo)?.name || selectedRepo}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelectedRepo('');
                          setRepositoryScanResult(null);
                          setExistingFiles([]);
                          setExistingFilesReviewed(false);
                        }}
                        className="text-green-700 dark:text-green-300"
                      >
                        Change
                      </Button>
                    </div>
                  </div>
                )}

                {/* Existing Files Review Section - Show when repo is selected */}
                {selectedRepo && repositoryScanResult && !existingFilesReviewed && (
                  <div className="mt-8 rounded-lg border-2 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950 p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <FileText className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                        <h3 className="text-lg font-semibold text-blue-900 dark:text-blue-100">
                          Review Existing Terraform Files
                        </h3>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleContinueAfterReview}
                        className="text-blue-700 dark:text-blue-300"
                      >
                        Skip Review
                      </Button>
                    </div>
                    <p className="text-sm text-blue-800 dark:text-blue-200 mb-4">
                      {existingFiles.length > 0 
                        ? `Found ${existingFiles.length} existing Terraform file(s). Please review them before proceeding with new resource creation.`
                        : 'No existing Terraform files found. You can proceed with creating new resources.'}
                    </p>
                    
                    {/* Existing Resources Summary */}
                    {repositoryScanResult?.existingResources && repositoryScanResult.existingResources.length > 0 && (
                      <div className="mb-4 p-3 rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                        <h4 className="text-sm font-semibold mb-2 text-gray-900 dark:text-gray-100">
                          Existing Resources ({repositoryScanResult.existingResources.length})
                        </h4>
                        <div className="flex flex-wrap gap-2">
                          {repositoryScanResult.existingResources.map((resource, idx) => (
                            <span 
                              key={idx}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-700 text-xs font-mono"
                              title={`File: ${resource.file}`}
                            >
                              <span className="text-gray-600 dark:text-gray-400">{resource.type}</span>
                              <span className="text-gray-400 dark:text-gray-500">:</span>
                              <span className="text-gray-900 dark:text-gray-100">{resource.name}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Files Viewer with Tabs - Only show if files exist */}
                    {existingFiles.length > 0 && (
                      <div className="mb-4 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
                        <Tabs defaultValue={existingFiles[0]?.path || ''} className="w-full">
                        <div className="border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
                          <TabsList className="w-full justify-start h-auto p-0 bg-transparent min-w-max">
                            <div className="flex">
                              {existingFiles.map((file) => (
                                <TabsTrigger
                                  key={file.path}
                                  value={file.path}
                                  className="px-4 py-2 data-[state=active]:border-b-2 data-[state=active]:border-blue-500 rounded-none whitespace-nowrap"
                                >
                                  <div className="flex items-center gap-2">
                                    <CodeIcon className="w-4 h-4" />
                                    <span className="font-mono text-xs max-w-[150px] truncate" title={file.path}>
                                      {file.path.split('/').pop() || file.path}
                                    </span>
                                    {file.content.length > 0 && (
                                      <span className="text-xs text-muted-foreground">
                                        ({(file.content.length / 1024).toFixed(1)} KB)
                                      </span>
                                    )}
                                  </div>
                                </TabsTrigger>
                              ))}
                            </div>
                          </TabsList>
                        </div>
                        
                        {existingFiles.map((file) => (
                          <TabsContent
                            key={file.path}
                            value={file.path}
                            className="mt-0 p-0"
                          >
                            <div className="border-t border-gray-200 dark:border-gray-700">
                              <div className="p-3 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <FileText className="w-4 h-4 text-gray-500" />
                                    <span className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
                                      {file.path}
                                    </span>
                                  </div>
                                  <span className="text-xs text-muted-foreground">
                                    {file.content.length} characters
                                  </span>
                                </div>
                              </div>
                              <ScrollArea className="h-[500px] w-full">
                                <div className="p-4 bg-gray-50 dark:bg-gray-900">
                                  {file.content.length > 0 ? (
                                    <pre className="text-xs font-mono whitespace-pre-wrap text-gray-900 dark:text-gray-100 leading-relaxed">
                                      <code>{file.content}</code>
                                    </pre>
                                  ) : (
                                    <div className="text-center text-muted-foreground py-8">
                                      <p>No content available for this file</p>
                                    </div>
                                  )}
                                </div>
                              </ScrollArea>
                            </div>
                          </TabsContent>
                        ))}
                      </Tabs>
                      </div>
                    )}

                    {/* Continue Button */}
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setExistingFilesReviewed(true);
                          setExistingFiles([]);
                        }}
                      >
                        Clear Review
                      </Button>
                      <Button
                        onClick={handleContinueAfterReview}
                        className="bg-blue-600 hover:bg-blue-700"
                        data-testid="button-continue-after-review"
                      >
                        Continue to Next Step
                      </Button>
                    </div>
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
              <div className="w-full my-8">
                <div className="max-w-2xl mx-auto">
                  <div className="bg-white dark:bg-gray-800 rounded-lg border-2 border-gray-300 dark:border-gray-600 p-8 shadow-xl">
                    <h3 className="text-2xl font-bold mb-4 text-gray-900 dark:text-gray-100">Configure Terraform Backend</h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
                      {cloudProvider === 'aws' 
                        ? 'Enter the AWS backend configuration details. The app will generate backend.tf with S3 and DynamoDB configuration.'
                        : 'Enter the Azure backend configuration details. The app will create these resources and generate backend.tf.'}
                    </p>
                    
                    <div className="space-y-6">
                      {/* AWS Backend Fields */}
                      {cloudProvider === 'aws' && (
                        <>
                          <div>
                            <label htmlFor="s3-bucket" className="block text-sm font-semibold mb-2 text-gray-700 dark:text-gray-300">
                              S3 Bucket Name <span className="text-red-500">*</span>
                            </label>
                            <input
                              id="s3-bucket"
                              type="text"
                              placeholder="Enter S3 bucket name (e.g., terraform-state-12345678)"
                              value={backendBucket}
                              onChange={(e) => {
                                const value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
                                setBackendBucket(value);
                              }}
                      disabled={configureBackendMutation.isPending}
                              readOnly={false}
                              className="w-full h-11 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                              autoComplete="off"
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              Name of the S3 bucket for storing Terraform state files
                            </p>
                          </div>

                          <div>
                            <label htmlFor="dynamodb-table" className="block text-sm font-semibold mb-2 text-gray-700 dark:text-gray-300">
                              DynamoDB Table Name <span className="text-red-500">*</span>
                            </label>
                            <input
                              id="dynamodb-table"
                              type="text"
                              placeholder="Enter DynamoDB table name (e.g., terraform-state-lock)"
                              value={backendDynamodbTable}
                              onChange={(e) => {
                                const value = e.target.value.replace(/[^a-zA-Z0-9-_]/g, '');
                                setBackendDynamodbTable(value);
                              }}
                              disabled={configureBackendMutation.isPending}
                              readOnly={false}
                              className="w-full h-11 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                              autoComplete="off"
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              Name of the DynamoDB table for Terraform state locking
                            </p>
                          </div>

                          <div>
                            <label htmlFor="aws-region" className="block text-sm font-semibold mb-2 text-gray-700 dark:text-gray-300">
                              AWS Region <span className="text-red-500">*</span>
                            </label>
                            <input
                              id="aws-region"
                              type="text"
                              placeholder="Enter AWS region (e.g., us-east-1)"
                              value={backendRegion}
                              onChange={(e) => setBackendRegion(e.target.value)}
                              disabled={configureBackendMutation.isPending}
                              readOnly={false}
                              className="w-full h-11 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                              autoComplete="off"
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              AWS region where the S3 bucket and DynamoDB table are located
                            </p>
                          </div>

                          {/* AWS Preview */}
                          {(backendBucket.trim() || backendDynamodbTable.trim() || backendRegion.trim()) && (
                            <div className="rounded-md border border-border bg-muted/30 p-4 space-y-2">
                              <p className="text-xs font-semibold text-foreground">Configuration Preview:</p>
                              <div className="text-xs font-mono space-y-1.5 text-muted-foreground">
                                <div className="flex items-baseline gap-2">
                                  <span className="text-muted-foreground">S3 Bucket:</span>
                                  <span className="text-foreground font-semibold">{backendBucket.trim() || `terraform-state-${Date.now().toString().slice(-8)}`}</span>
                                </div>
                                <div className="flex items-baseline gap-2">
                                  <span className="text-muted-foreground">DynamoDB Table:</span>
                                  <span className="text-foreground font-semibold">{backendDynamodbTable.trim() || 'terraform-state-lock'}</span>
                                </div>
                                <div className="flex items-baseline gap-2">
                                  <span className="text-muted-foreground">Region:</span>
                                  <span className="text-foreground font-semibold">{backendRegion.trim() || 'us-east-1'}</span>
                                </div>
                              </div>
                            </div>
                          )}
                        </>
                      )}

                      {/* Azure Backend Fields */}
                      {cloudProvider === 'azure' && (
                        <>
                          <div>
                            <label htmlFor="resource-group" className="block text-sm font-semibold mb-2 text-gray-700 dark:text-gray-300">
                              Resource Group Name <span className="text-red-500">*</span>
                            </label>
                            <input
                              id="resource-group"
                              type="text"
                              placeholder="Enter resource group name (e.g., terraform-state-rg)"
                              value={backendResourceGroup}
                              onChange={(e) => setBackendResourceGroup(e.target.value)}
                              disabled={configureBackendMutation.isPending}
                              readOnly={false}
                              className="w-full h-11 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                              autoComplete="off"
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              Name of the Azure resource group for storing Terraform state
                            </p>
                          </div>

                          <div>
                            <label htmlFor="storage-account" className="block text-sm font-semibold mb-2 text-gray-700 dark:text-gray-300">
                              Storage Account Name <span className="text-red-500">*</span>
                            </label>
                            <input
                              id="storage-account"
                              type="text"
                              placeholder="Enter storage account name (e.g., tfstate12345678)"
                              value={backendStorageAccount}
                              onChange={(e) => {
                                const value = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '');
                                setBackendStorageAccount(value);
                              }}
                              disabled={configureBackendMutation.isPending}
                              readOnly={false}
                              className="w-full h-11 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                              maxLength={24}
                              autoComplete="off"
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              3-24 characters, lowercase letters and numbers only
                            </p>
                          </div>

                          <div>
                            <label htmlFor="container" className="block text-sm font-semibold mb-2 text-gray-700 dark:text-gray-300">
                              Container Name <span className="text-red-500">*</span>
                            </label>
                            <input
                              id="container"
                              type="text"
                              placeholder="Enter container name (e.g., tfstate)"
                              value={backendContainer}
                              onChange={(e) => {
                                const value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
                                setBackendContainer(value);
                              }}
                              disabled={configureBackendMutation.isPending}
                              readOnly={false}
                              className="w-full h-11 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                              autoComplete="off"
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              Name of the blob container for storing Terraform state files
                            </p>
                          </div>

                          {/* Azure Preview */}
                          {(backendResourceGroup.trim() || backendStorageAccount.trim() || backendContainer.trim()) && (
                            <div className="rounded-md border border-border bg-muted/30 p-4 space-y-2">
                              <p className="text-xs font-semibold text-foreground">Configuration Preview:</p>
                              <div className="text-xs font-mono space-y-1.5 text-muted-foreground">
                                <div className="flex items-baseline gap-2">
                                  <span className="text-muted-foreground">Resource Group:</span>
                                  <span className="text-foreground font-semibold">{backendResourceGroup.trim() || 'terraform-state-rg'}</span>
                                </div>
                                <div className="flex items-baseline gap-2">
                                  <span className="text-muted-foreground">Storage Account:</span>
                                  <span className="text-foreground font-semibold">{backendStorageAccount.trim() || `tfstate${Date.now().toString().slice(-8)}`}</span>
                                </div>
                                <div className="flex items-baseline gap-2">
                                  <span className="text-muted-foreground">Container:</span>
                                  <span className="text-foreground font-semibold">{backendContainer.trim() || 'tfstate'}</span>
                                </div>
                              </div>
                            </div>
                          )}
                        </>
                      )}

                      <div className="flex flex-col sm:flex-row gap-3 pt-2">
                        <Button
                          type="button"
                          onClick={() => {
                            // Reset mutation if it's stuck
                            if (configureBackendMutation.isPending) {
                              configureBackendMutation.reset();
                            }
                            
                            const config = cloudProvider === 'aws' ? {
                              bucket: backendBucket.trim() || `terraform-state-${Date.now().toString().slice(-8)}`,
                              dynamodbTable: backendDynamodbTable.trim() || 'terraform-state-lock',
                              region: backendRegion.trim() || 'us-east-1',
                            } : {
                              resourceGroup: backendResourceGroup.trim() || 'terraform-state-rg',
                              storageAccount: backendStorageAccount.trim() || `tfstate${Date.now().toString().slice(-8)}`,
                              container: backendContainer.trim() || 'tfstate',
                              location: 'eastus'
                            };
                            handleBackendConfiguration('create', config);
                          }}
                          disabled={configureBackendMutation.isPending || 
                            (cloudProvider === 'aws' ? (!backendBucket.trim() || !backendDynamodbTable.trim() || !backendRegion.trim()) : 
                             (!backendResourceGroup.trim() || !backendStorageAccount.trim() || !backendContainer.trim()))}
                          className="flex-1"
                      data-testid="button-backend-create"
                    >
                          {configureBackendMutation.isPending ? 'Creating...' : cloudProvider === 'aws' ? 'Configure Backend' : 'Create Backend'}
                    </Button>
                    
                    <Button
                          type="button"
                      onClick={() => handleBackendConfiguration('decline')}
                      disabled={configureBackendMutation.isPending}
                      variant="outline"
                          className="flex-1"
                      data-testid="button-backend-decline"
                    >
                          Skip Backend
                    </Button>
                      </div>
                    
                      {session?.isExistingRepo && cloudProvider === 'azure' && (
                    <Button
                          type="button"
                      onClick={() => handleBackendConfiguration('validate')}
                          disabled={configureBackendMutation.isPending}
                      variant="outline"
                          className="w-full"
                      data-testid="button-backend-validate"
                    >
                          Validate Existing Backend
                    </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Step 7: Review & Edit */}
            {currentStep === 7 && generatedFiles && Array.isArray(generatedFiles) && generatedFiles.length > 0 && (
              <div className="space-y-6">
                <CodeEditor 
                  files={generatedFiles.map(f => ({ name: f.fileName, content: f.content }))} 
                  onFileChange={handleFileChange} 
                />
                <CheckovScanner 
                  sessionId={sessionId}
                  onScanComplete={() => setScanCompleted(true)}
                />
                <CostAnalyzer 
                  sessionId={sessionId}
                />
                <RefactorValidator 
                  sessionId={sessionId}
                />
                {isCommitted ? (
                  <div className="flex flex-col items-center gap-4 p-6 border rounded-lg bg-green-50 dark:bg-green-950">
                    <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <h3 className="text-lg font-semibold">Successfully Committed!</h3>
                    </div>
                    <p className="text-sm text-muted-foreground text-center">
                      Your Terraform configuration has been committed to the repository.
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
                  <>
                <ActionButtons
                  onApprove={handleApprove}
                  onCancel={handleCancel}
                  loading={commitMutation.isPending}
                      disabled={!scanCompleted}
                />
                    {!scanCompleted && (
                  <p className="text-sm text-muted-foreground text-center">
                    Please run the security scan before committing
                  </p>
                    )}
                  </>
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
