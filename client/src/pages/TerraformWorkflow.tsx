import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useSecretsConfig } from "@/hooks/useSecretsConfig";
import Header from "@/components/Header";
import ChatInput from "@/components/ChatInput";
import ProviderCard from "@/components/ProviderCard";
import RepositoryList from "@/components/RepositoryList";
import CreateRepoForm from "@/components/CreateRepoForm";
import CodeEditor from "@/components/CodeEditor";
import StepIndicator from "@/components/StepIndicator";
import ActionButtons from "@/components/ActionButtons";
import ActivityPanel from "@/components/ActivityPanel";
import { CodeIcon } from "@radix-ui/react-icons";
import { Cloud, CloudCog, Package, Home, FileText, X, RefreshCw, Loader2, Box, Layers, Network, FileCode, CheckCircle2, Clock3, PlayCircle, BarChart3, Hash, FolderOpen, ChevronRight, Cpu, Database, Globe, Shield, Lock, Activity } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import type { Session, GeneratedFile, Repository, RepositoryScanResult } from "@shared/schema";

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

// ── Terraform resource type → friendly label ─────────────────────────────────
const TF_RESOURCE_LABELS: Record<string, { label: string; icon: any }> = {
  azurerm_linux_virtual_machine:      { label: 'Linux VM',           icon: Cpu },
  azurerm_windows_virtual_machine:    { label: 'Windows VM',         icon: Cpu },
  azurerm_virtual_machine:            { label: 'Virtual Machine',    icon: Cpu },
  azurerm_app_service:                { label: 'App Service',        icon: Globe },
  azurerm_app_service_plan:           { label: 'App Service Plan',   icon: Globe },
  azurerm_linux_web_app:              { label: 'Linux Web App',      icon: Globe },
  azurerm_windows_web_app:            { label: 'Windows Web App',    icon: Globe },
  azurerm_sql_server:                 { label: 'SQL Server',         icon: Database },
  azurerm_sql_database:               { label: 'SQL Database',       icon: Database },
  azurerm_postgresql_server:          { label: 'PostgreSQL Server',  icon: Database },
  azurerm_postgresql_flexible_server: { label: 'PostgreSQL Flex',    icon: Database },
  azurerm_mysql_server:               { label: 'MySQL Server',       icon: Database },
  azurerm_cosmosdb_account:           { label: 'Cosmos DB',          icon: Database },
  azurerm_storage_account:            { label: 'Storage Account',    icon: FolderOpen },
  azurerm_resource_group:             { label: 'Resource Group',     icon: FolderOpen },
  azurerm_virtual_network:            { label: 'Virtual Network',    icon: Network },
  azurerm_subnet:                     { label: 'Subnet',             icon: Network },
  azurerm_network_security_group:     { label: 'NSG',                icon: Shield },
  azurerm_public_ip:                  { label: 'Public IP',          icon: Globe },
  azurerm_load_balancer:              { label: 'Load Balancer',      icon: Activity },
  azurerm_application_gateway:        { label: 'App Gateway',        icon: Activity },
  azurerm_redis_cache:                { label: 'Redis Cache',        icon: Database },
  azurerm_kubernetes_cluster:         { label: 'AKS Cluster',        icon: Box },
  azurerm_container_registry:         { label: 'Container Registry', icon: Box },
  azurerm_key_vault:                  { label: 'Key Vault',          icon: Lock },
  azurerm_log_analytics_workspace:    { label: 'Log Analytics',      icon: BarChart3 },
  azurerm_monitor_action_group:       { label: 'Monitor Action',     icon: Activity },
  azurerm_eventhub_namespace:         { label: 'Event Hub NS',       icon: Activity },
  azurerm_servicebus_namespace:       { label: 'Service Bus',        icon: Activity },
  azurerm_cdn_profile:                { label: 'CDN Profile',        icon: Globe },
  aws_instance:                       { label: 'EC2 Instance',       icon: Cpu },
  aws_db_instance:                    { label: 'RDS Instance',       icon: Database },
  aws_s3_bucket:                      { label: 'S3 Bucket',          icon: FolderOpen },
  aws_vpc:                            { label: 'VPC',                icon: Network },
  aws_subnet:                         { label: 'Subnet',             icon: Network },
  aws_security_group:                 { label: 'Security Group',     icon: Shield },
  aws_iam_role:                       { label: 'IAM Role',           icon: Lock },
  aws_lambda_function:                { label: 'Lambda',             icon: Activity },
  aws_eks_cluster:                    { label: 'EKS Cluster',        icon: Box },
  aws_elasticache_cluster:            { label: 'ElastiCache',        icon: Database },
  google_compute_instance:            { label: 'GCE Instance',       icon: Cpu },
  google_sql_database_instance:       { label: 'Cloud SQL',          icon: Database },
  google_storage_bucket:              { label: 'GCS Bucket',         icon: FolderOpen },
  google_container_cluster:           { label: 'GKE Cluster',        icon: Box },
  google_vpc_network:                 { label: 'VPC Network',        icon: Network },
};
function tfResourceLabel(type: string): { label: string; icon: any } {
  return TF_RESOURCE_LABELS[type] ?? { label: type.replace(/^(azurerm_|aws_|google_)/, '').replace(/_/g, ' '), icon: Box };
}
type Provider = 'github' | 'azure' | null;
type CloudProvider = 'azure' | 'aws' | 'gcp' | null;
type ModuleApproach = 'child-module' | 'standalone-root' | 'aggregated-root' | null;

export default function TerraformWorkflow() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [sessionId, setSessionId] = useState<string>('');
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [provider, setProvider] = useState<Provider>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [childModuleRepoId, setChildModuleRepoId] = useState<string>('');
  const [childModuleResources, setChildModuleResources] = useState<Array<{ type: string; name: string; description?: string }>>([]);
  const [childModuleReviewed, setChildModuleReviewed] = useState<boolean>(false);
  const [resourceValidationResult, setResourceValidationResult] = useState<{ valid: boolean; message?: string; requestedResources?: string[]; availableResources?: string[]; unavailableResources?: string[] } | null>(null);
  const [resourceDescription, setResourceDescription] = useState<string>('');
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>(null);
  const [moduleApproach, setModuleApproach] = useState<ModuleApproach>(null);
  const [isCommitted, setIsCommitted] = useState<boolean>(false);
  const [scanCompleted, setScanCompleted] = useState<boolean>(false);
  const [buildId, setBuildId] = useState<string | null>(null);
  const [activityViewMode, setActivityViewMode] = useState<'overview' | 'build' | 'code'>('overview');
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
  const [backendGeneratedArtifacts, setBackendGeneratedArtifacts] = useState<string[]>([]);
  const isDedicatedBuildWorkspace =
    moduleApproach === 'aggregated-root'
      ? Number(currentStep) >= 9
      : Number(currentStep) >= 8;

  // Dynamic steps based on module approach
  // Corrected Flow: Provider → Repository → Cloud Provider → Module → (for Aggregated: Child Repo → Root Repo → Backend → Resources) → Generate → Review → Activities
  const steps = moduleApproach === 'aggregated-root' ? [
    { number: 1, title: 'Provider' },
    { number: 2, title: 'Cloud Provider' },
    { number: 3, title: 'Module' },
    { number: 4, title: 'Child Repo' },
    { number: 5, title: 'Root Repo' },
    { number: 6, title: 'Backend' },
    { number: 7, title: 'Resources' },
    { number: 8, title: 'Generate' },
    { number: 9, title: 'Activities' },
    { number: 10, title: 'Commit' },
  ] : [
    { number: 1, title: 'Provider' },
    { number: 2, title: 'Repository' },
    { number: 3, title: 'Cloud Provider' },
    { number: 4, title: 'Module' },
    { number: 5, title: 'Backend' },
    { number: 6, title: 'Generate' },
    { number: 8, title: 'Build' },
    { number: 9, title: 'Commit' },
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

          // Restore workflow state from session
          if (session.provider) setProvider(session.provider as Provider);
          if (session.cloudProvider) setCloudProvider(session.cloudProvider as CloudProvider);
          if (session.moduleApproach) setModuleApproach(session.moduleApproach as ModuleApproach);
          if (session.repositoryId) setSelectedRepo(session.repositoryId);
          if (session.backendValidated === 'true' || session.backendDeclined === 'true') setBackendConfigured(true);
          if (session.backendStorageAccount) setBackendStorageAccount(session.backendStorageAccount);
          if (session.backendResourceGroup) setBackendResourceGroup(session.backendResourceGroup);
          if (session.backendContainer) setBackendContainer(session.backendContainer);
          if (session.isExistingRepo === 'true') setScanCompleted(true);

          console.log('Restored existing session:', session.id, 'at step', session.currentStep);
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

      // Tag session with module type for history tracking
      await apiRequest('PATCH', `/api/sessions/${session.id}`, { activeModule: 'terraform' });

      // Create initial welcome message without AI chat
      await apiRequest('POST', `/api/sessions/${session.id}/messages/system`, {
        message: 'Welcome to Terraform Workflow. Select your repository provider: GitHub or Azure DevOps.'
      });
    };
    initializeSession();
  }, []);

  // Fetch secrets configuration status
  const { data: config } = useSecretsConfig();

  // Fetch session
  const { data: session } = useQuery<Session>({
    queryKey: ['/api/sessions', sessionId],
    enabled: !!sessionId,
  });

  // Sync currentStep with session.currentStep (only on initial load)
  // This ensures we start from the correct step if page is refreshed
  useEffect(() => {
    if (session?.currentStep && !hasInitialized && currentStep === 1) {
      // Only sync on initial load (when currentStep is still 1 and not yet initialized)
      // Handlers will manage step transitions after that
      const stepNum = parseInt(session.currentStep, 10) as Step;
      if (stepNum !== 1) {
        setCurrentStep(stepNum);
      }
      setHasInitialized(true);
    }
  }, [session?.currentStep, hasInitialized, currentStep]); // Only sync on initial load

  // Sync currentStep when session.currentStep changes (for backend-driven step updates)
  // This handles cases where the backend updates the step (e.g., after code generation)
  useEffect(() => {
    if (session?.currentStep && hasInitialized) {
      const sessionStep = parseInt(session.currentStep, 10) as Step;
      // Only update if session step is different and is a valid step
      // This allows backend to drive step transitions (e.g., after code generation sets step to 8)
      if (sessionStep !== currentStep && sessionStep >= 1 && sessionStep <= 10) {
        console.log(`🔄 Syncing currentStep: ${currentStep} → ${sessionStep} (from session)`);
        setCurrentStep(sessionStep);
      }
    }
  }, [session?.currentStep, hasInitialized]);

  // Re-fetch child module resources when entering Step 7 if they're empty
  useEffect(() => {
    if (currentStep === 7 && moduleApproach === 'aggregated-root' && childModuleResources.length === 0 && childModuleRepoId) {
      // Re-scan child module to get resources
      const reScanChildModule = async () => {
        try {
          const response = await apiRequest('POST', `/api/sessions/${sessionId}/scan-child-module`, {
            repositoryId: childModuleRepoId,
            provider: provider
          });
          const result = await response.json();
          
          if (result.resources && result.resources.length > 0) {
            setChildModuleResources(result.resources);
            console.log('✅ Re-fetched child module resources:', result.resources.length);
          }
        } catch (error: any) {
          console.error('Error re-scanning child module:', error);
          toast({
            title: "Warning",
            description: "Could not re-fetch child module resources. Please go back and re-select the child module repository.",
            variant: "destructive"
          });
        }
      };
      
      reScanChildModule();
    }
  }, [currentStep, moduleApproach, childModuleResources.length, childModuleRepoId, sessionId, provider]);

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
  // Enable for Step 2 (repository selection for non-aggregated-root), Step 4 (child module repo for aggregated-root), and Step 5 (root module repo for aggregated-root)
  const { data: repositories = [] } = useQuery<Repository[]>({
    queryKey: ['/api/repositories', provider],
    enabled: !!provider && (currentStep === 2 || (currentStep === 4 && moduleApproach === 'aggregated-root') || (currentStep === 5 && moduleApproach === 'aggregated-root')),
  });

  // Fetch generated files
  const { data: generatedFiles = [], refetch: refetchFiles } = useQuery<GeneratedFile[]>({
    queryKey: ['/api/sessions', sessionId, 'files'],
    enabled: !!sessionId && currentStep >= 6,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnReconnect: false,
  });

  // Step 7 was removed from the frontend (build workspace is now step 8).
  // If session was saved with currentStep=7, advance to 8 automatically.
  useEffect(() => {
    if (currentStep === 7 && moduleApproach !== 'aggregated-root' && sessionId) {
      setCurrentStep(8);
      apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '8' }).catch(() => {});
    }
  }, [currentStep, moduleApproach, sessionId]);

  // Reset to Overview tab whenever the user arrives at the Build Workspace step
  useEffect(() => {
    const isBuildStep = (currentStep === 8 && moduleApproach !== 'aggregated-root') ||
                        (currentStep === 9 && moduleApproach === 'aggregated-root');
    if (isBuildStep) {
      setActivityViewMode('overview');
      setScanCompleted(false);
      setBuildId(null);
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
    }
  }, [currentStep]);

  // Debug: Log files when they change
  useEffect(() => {
    if (generatedFiles && generatedFiles.length > 0) {
      console.log('📁 Files received from API:', generatedFiles.length);
      generatedFiles.forEach((f, i) => {
        console.log(`   ${i + 1}. ${f.fileName} (ID: ${f.id}, size: ${f.content.length} chars)`);
      });
    }
  }, [generatedFiles]);

  const selectedRepoName =
    repositories.find((repo) => repo.id === selectedRepo)?.name ||
    session?.repositoryName ||
    selectedRepo ||
    null;

  const workflowSummaryItems = [
    { label: 'Repository Provider', value: provider === 'github' ? 'GitHub' : provider === 'azure' ? 'Azure DevOps' : 'Not selected' },
    { label: 'Repository', value: selectedRepoName || 'Not selected' },
    { label: 'Cloud Provider', value: cloudProvider ? cloudProvider.toUpperCase() : 'Not selected' },
    {
      label: 'Module Approach',
      value:
        moduleApproach === 'child-module'
          ? 'Child Module'
          : moduleApproach === 'standalone-root'
            ? 'Standalone Root'
            : moduleApproach === 'aggregated-root'
              ? 'Aggregated Root'
              : 'Not selected',
    },
    { label: 'Backend Status', value: backendConfigured ? 'Configured' : 'Pending' },
  ];

  const workflowBackendArtifacts = Array.from(
    new Set([
      ...backendGeneratedArtifacts,
      ...generatedFiles
        .map((file) => file.fileName)
        .filter((fileName) => fileName === 'backend.tf' || fileName === 'provider.tf' || fileName === 'terraform.tf'),
    ]),
  );

  const getNextActionLabel = () => {
    if (currentStep === 1) return 'Select repository provider';
    if (currentStep === 2) return 'Select or create repository';
    if (currentStep === 3) return 'Select target cloud provider';
    if (currentStep === 4) return moduleApproach === 'aggregated-root' ? 'Select child module repository' : 'Select module approach';
    if (currentStep === 5) return moduleApproach === 'aggregated-root' ? 'Select root module repository' : 'Configure Terraform backend';
    if (currentStep === 6) return moduleApproach === 'aggregated-root' ? 'Configure Terraform backend' : 'Describe infrastructure requirements';
    if (currentStep === 7) return moduleApproach === 'aggregated-root' ? 'Describe infrastructure requirements' : 'Review generated code';
    if (currentStep === 8) return moduleApproach === 'aggregated-root' ? 'Review generated code' : 'Proceed to build stages';
    return 'Proceed to commit and finalize';
  };

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

  // Validate aggregated resources mutation
  const validateResourcesMutation = useMutation({
    mutationFn: async (description: string) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/validate-aggregated-resources`, {
        description,
        childModuleResources: childModuleResources
      });
      return res.json();
    },
    onSuccess: (data) => {
      setResourceValidationResult(data);
      if (data.valid) {
        toast({
          title: "Validation Successful",
          description: data.message || "All requested resources are available in the child module.",
        });
      }
    },
    onError: (error: any) => {
      console.error('Validation error:', error);
      let errorMessage = 'Failed to validate resources';
      let errorData: any = null;
      
      if (error?.message) {
        const match = error.message.match(/^(\d+):\s*(.+)$/);
        if (match) {
          const [, status, text] = match;
          try {
            errorData = JSON.parse(text);
            errorMessage = errorData.error || errorMessage;
          } catch {
            errorMessage = text;
          }
        } else {
          errorMessage = error.message;
        }
      }
      
      setResourceValidationResult({
        valid: false,
        message: errorMessage,
        unavailableResources: errorData?.unavailableResources,
        availableResources: errorData?.availableResources,
        requestedResources: errorData?.requestedResources
      });
      
      toast({
        title: "Validation Failed",
        description: errorMessage,
        variant: "destructive",
        duration: 10000
      });
    }
  });

  // Generate Terraform mutation
  const generateTerraformMutation = useMutation({
    mutationFn: async (description: string) => {
      console.log('\n🚀 ========== FRONTEND: Generate Terraform Called ==========');
      console.log('   Timestamp:', new Date().toISOString());
      console.log('   Session ID:', sessionId);
      console.log('   Module approach:', moduleApproach);
      console.log('   Description:', description);
      console.log('   Description length:', description?.length || 0);
      
      if (!description || description.trim().length === 0) {
        console.error('❌ CRITICAL: Description is empty!');
        throw new Error('Description is required');
      }
      
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
      
      // For aggregated-root modules, include child module resources for validation
      const requestBody: any = { description };
      if (moduleApproach === 'aggregated-root' && childModuleResources.length > 0) {
        requestBody.childModuleResources = childModuleResources.map(r => r.type);
        console.log('📋 Child module resources:', requestBody.childModuleResources);
      }
      
      console.log('📤 Sending request to backend...');
      console.log('   Request body:', JSON.stringify(requestBody, null, 2));
      
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/generate-terraform`, requestBody);
      const result = await res.json();
      console.log('✅ Backend response received:', result);
      return result;
    },
    onSuccess: async (data) => {
      console.log('✅ Generation successful, response:', data);
      
      // Refetch session to get updated currentStep from backend
      console.log('🔄 Refreshing session to sync step...');
      await queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId] });

      // Poll until main.tf is present and non-empty — avoids fixed time delays
      console.log('🔄 Polling for generated files...');
      await queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      const POLL_INTERVAL_MS = 400;
      const POLL_TIMEOUT_MS = 15_000;
      const pollStart = Date.now();
      let filesAfterRefresh: GeneratedFile[] = [];
      while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
        await queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
        filesAfterRefresh = await queryClient.fetchQuery<GeneratedFile[]>({
          queryKey: ['/api/sessions', sessionId, 'files'],
        });
        const mainTf = filesAfterRefresh.find(f => f.fileName === 'main.tf');
        if (mainTf && mainTf.content.trim().length > 0) {
          console.log(`✅ main.tf ready after ${Date.now() - pollStart}ms (${mainTf.content.length} chars)`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (!filesAfterRefresh.find(f => f.fileName === 'main.tf' && f.content.trim().length > 0)) {
        console.warn('⚠️ Poll timeout: main.tf not ready after 15s — proceeding anyway');
      }

      // Compare files before and after
      const filesAfter = filesAfterRefresh;
      
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
      
      // For aggregated-root: Don't advance step here - the button handler will advance after generation
      // For non-aggregated-root: Advance to Step 7 (Review)
      if (moduleApproach === 'aggregated-root') {
        // Don't change step - button handler will advance to Step 8 after generation completes
        // Force refetch files to ensure UI updates - use multiple strategies
        console.log('🔄 Refetching files after code generation...');
        await queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
        await queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
        
        // Also manually refetch using the refetch function
        const filesResult = await refetchFiles();
        console.log('📁 Files refetched:', filesResult.data?.length || 0);
        if (filesResult.data) {
          filesResult.data.forEach((f, i) => {
            console.log(`   ${i + 1}. ${f.fileName} (${f.content.length} chars)`);
          });
        }
        
        console.log('✅ Code generation complete for aggregated-root - button handler will advance to Step 8');
        // Don't send system message here - button handler will handle navigation
      } else {
        // Backend already sets step to 8, so just sync with it
        // Refetch session to get the updated step from backend
        await queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId] });
        // The useEffect will sync currentStep to 8 when session updates
      }
      setScanCompleted(false); // Reset scan state for new files
      toast({
        title: "Success",
        description: "Terraform files generated successfully",
      });
    },
    onError: async (error: any) => {
      console.error('\n❌ ========== FRONTEND: Generate Terraform Error ==========');
      console.error('   Error:', error);
      console.error('   Error message:', error?.message);
      console.error('   Error stack:', error?.stack);
      
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
      // Session is automatically reset on server side, so we can start fresh
      setTimeout(() => {
        setLocation('/');
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
    setLocation('/');
  };

  // Handle refresh - reset session and state
  const handleRefresh = async () => {
    try {
      localStorage.removeItem('terraform_workflow_session_id');
      setSessionId('');
      setCurrentStep(1);
      setProvider(null);
      setSelectedRepo('');
      setCloudProvider(null);
      setModuleApproach(null);
      setBackendConfigured(false);
      setBackendResourceGroup('');
      setBackendStorageAccount('');
      setBackendContainer('');
      setBackendBucket('');
      setBackendDynamodbTable('terraform-state-lock');
      setBackendRegion('us-east-1');
      setBackendGeneratedArtifacts([]);
      setExistingFilesReviewed(false);
      setExistingFiles([]);
      setSelectedFileToReview(null);
      setIsCommitted(false);
      setScanCompleted(false);
      setRepositoryScanResult(null);
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions'] });
      
      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      localStorage.setItem('terraform_workflow_session_id', session.id);

      await apiRequest('PATCH', `/api/sessions/${session.id}`, { activeModule: 'terraform' });

      await apiRequest('POST', `/api/sessions/${session.id}/messages/system`, {
        message: 'Welcome to Terraform Workflow. Select your repository provider: GitHub or Azure DevOps.'
      });

      queryClient.invalidateQueries({ queryKey: ['/api/sessions', session.id, 'messages'] });

      toast({
        title: "Refreshed",
        description: "Started a new session. You can now begin a new Terraform workflow.",
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
    apiRequest('POST', `/api/repositories/${selectedProvider}/prewarm`, {}).catch(() => {});

    const providerName = selectedProvider === 'github' ? 'GitHub' : 'Azure DevOps';

    await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
      provider: selectedProvider,
      currentStep: '2'
    });

    // Single consolidated message
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
      message: `Provider selected: ${providerName}. Select an existing repository or create a new one.`
    });

    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['/api/repositories', selectedProvider] });
    setCurrentStep(2);
  };

  const handleRepoSelect = async (repoId: string) => {
    // For Step 2: Repository selection for non-aggregated-root modules
    if (currentStep === 2 && !moduleApproach) {
      setSelectedRepo(repoId);
      const repo = repositories.find(r => r.id === repoId);
      
      // Scan repository to check for existing Terraform files
      // First, update session with repository info, then scan
      try {
        const repo = repositories.find(r => r.id === repoId);
        await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
          repositoryId: repoId,
          repositoryName: repo?.name || repoId,
        });

        // Use the session-based scan endpoint
        const scanResponse = await apiRequest('POST', `/api/sessions/${sessionId}/scan-repository`, {});

        // Check if response is JSON before parsing
        const contentType = scanResponse.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          // Response is not JSON, likely HTML error page
          const text = await scanResponse.text();
          if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
            throw new Error('Server returned HTML instead of JSON. The scan endpoint may not be available or there was a server error.');
          }
          throw new Error(`Unexpected response type: ${contentType}`);
        }

        const scanResult = await scanResponse.json();

        // The scan endpoint returns the result in the correct format already
        setRepositoryScanResult(scanResult);

        if (scanResult.terraformFiles && scanResult.terraformFiles.length > 0) {
          const moduleTypeText = scanResult.moduleType === 'child' ? 'child module' :
                                scanResult.moduleType === 'root' ? 'root module' :
                                'configuration';
          const providerText = scanResult.cloudProvider ?
            ` for ${scanResult.cloudProvider.toUpperCase()}` : '';

          // Store existing files for review
          if (scanResult.terraformFilesWithContent && scanResult.terraformFilesWithContent.length > 0) {
            setExistingFiles(scanResult.terraformFilesWithContent);
          } else {
            setExistingFiles(scanResult.terraformFiles.map(path => ({ path, content: '' })));
          }
          setExistingFilesReviewed(false);

          // Single consolidated message for existing repo
          await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
            message: `Repository selected: "${repo?.name}". Detected existing ${moduleTypeText}${providerText} with ${scanResult.terraformFiles.length} Terraform files.`
          });

          if (scanResult.cloudProvider && !cloudProvider) {
            await apiRequest('PATCH', `/api/sessions/${sessionId}`, { cloudProvider: scanResult.cloudProvider });
            setCloudProvider(scanResult.cloudProvider);
          }

          // Stay on Step 2 to show review - user will click "Continue" after reviewing
          queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
        } else {
          // New/empty repo - proceed to Cloud Provider selection with single consolidated message
          await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '3' });
          setCurrentStep(3);
          queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });

          await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
            message: `Repository selected: "${repo?.name}" (new/empty). Select the target cloud provider.`
          });
        }
      } catch (error: any) {
        console.error('Error scanning repository:', error);

        // Show user-friendly error message
        toast({
          title: "Scan Failed",
          description: error.message || "Failed to scan repository. Proceeding with new repository setup.",
          variant: "destructive"
        });

        // On error, proceed to Cloud Provider selection (treat as new repository)
        setRepositoryScanResult({
          isExisting: false,
          cloudProvider: null,
          moduleType: null,
          terraformFiles: [],
          hasResources: false,
          hasModules: false,
          providerBlocks: [],
          backend: { hasBackend: false }
        } as RepositoryScanResult);
        setExistingFiles([]);
        setExistingFilesReviewed(true);

        await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '3' });
        setCurrentStep(3);
        queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });

        await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
          message: `Repository selected: "${repo?.name}". Repository scan was not completed. Continue by selecting the target cloud provider.`
        });
      }

      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
      return;
    }
    
    // For aggregated-root modules in Step 4, this is child module repository selection
    if (moduleApproach === 'aggregated-root' && currentStep === 4 && !childModuleReviewed) {
      setChildModuleRepoId(repoId);
      const repo = repositories.find(r => r.id === repoId);
      
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: `Selected child module repository: ${repo?.name}` 
      });

      // Scan the child module repository to extract resources
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'Scanning child module repository to extract available resources...' 
      });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });

      try {
        // Call API to scan child module and extract resources
        const response = await apiRequest('POST', `/api/sessions/${sessionId}/scan-child-module`, {
          repositoryId: repoId,
          provider: provider
        });
        const result = await response.json();
        
        if (result.resources && result.resources.length > 0) {
          setChildModuleResources(result.resources);
          await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
            message: `Found ${result.resources.length} available resource type(s) in the child module. Please review them before proceeding.` 
          });
        } else {
          toast({
            title: "No Resources Found",
            description: "The child module repository does not contain any Terraform resources.",
            variant: "destructive"
          });
          setChildModuleResources([]);
        }
      } catch (error: any) {
        console.error('Error scanning child module:', error);
        toast({
          title: "Scan Failed",
          description: error.message || "Failed to scan child module repository.",
          variant: "destructive"
        });
      }
      
      return;
    }
    
    // For aggregated-root modules in Step 5, this is root module repository selection
    // Scan it to check if backend exists (but don't show file review)
    if (moduleApproach === 'aggregated-root' && currentStep === 5) {
      setSelectedRepo(repoId);
      const repo = repositories.find(r => r.id === repoId);
      
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
        repositoryId: repoId,
        repositoryName: repo?.name,
      });

      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: `Selected root module repository: ${repo?.name}` 
      });

      // Scan the repository to check if backend exists (for new vs existing repo logic)
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'Checking repository for existing backend configuration...' 
      });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });

      try {
        const scanResult = await scanRepositoryMutation.mutateAsync();
        setRepositoryScanResult(scanResult);
        
        // Check if backend exists in the scan result
        const hasBackend = scanResult.backend && scanResult.backend.hasBackend;
        
        if (hasBackend) {
          await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
            message: 'Found existing backend configuration in the repository.' 
          });
        } else {
          await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
            message: 'This is a new repository. Backend configuration will be required before code generation.' 
          });
        }
      } catch (error: any) {
        // If scan fails, assume it's a new repo (backend required)
        console.warn('Repository scan failed, assuming new repository:', error);
        // Set scan result with no backend to indicate new repository
        setRepositoryScanResult({
          isExisting: false,
          cloudProvider: null,
          moduleType: null,
          terraformFiles: [],
          hasResources: false,
          hasModules: false,
          providerBlocks: [],
          backend: { hasBackend: false }
        } as RepositoryScanResult);
        await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
          message: 'Unable to scan repository. Backend configuration will be required.' 
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
      
      return; // Show the continue button
    }
    
    // Normal repository selection (for non-aggregated-root)
    setSelectedRepo(repoId);
    const repo = repositories.find(r => r.id === repoId);

    await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
      repositoryId: repoId,
      repositoryName: repo?.name,
    });

    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });

    const scanResult = await scanRepositoryMutation.mutateAsync();

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
        setExistingFiles(scanResult.terraformFiles.map(path => ({ path, content: '' })));
      }
      setExistingFilesReviewed(false);

      // Single consolidated message
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
        message: `Selected "${repo?.name}" - Found existing ${moduleTypeText}${providerText} with ${scanResult.terraformFiles.length} Terraform files.`
      });

      if (scanResult.cloudProvider && !cloudProvider) {
        await apiRequest('PATCH', `/api/sessions/${sessionId}`, { cloudProvider: scanResult.cloudProvider });
        setCloudProvider(scanResult.cloudProvider);
      }

      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
    } else {
      // New/empty repo - single consolidated message
      setCurrentStep(3);
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '3' });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });

      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
        message: `Selected "${repo?.name}" - New repository. Choose your target cloud provider.`
      });
    }

    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
  };

  const handleCreateRepo = async (name: string, description: string) => {
    const newRepo = await createRepoMutation.mutateAsync({ name, description });

    // For Step 2: Repository creation for non-aggregated-root modules
    if (currentStep === 2 && !moduleApproach) {
      const repoId = (newRepo as any)?.id || name;
      setSelectedRepo(repoId);

      await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
        repositoryId: repoId,
        repositoryName: name,
      });

      // New repository - no existing files, proceed to Cloud Provider
      setRepositoryScanResult({
        isExisting: false,
        cloudProvider: null,
        moduleType: null,
        terraformFiles: [],
        hasResources: false,
        hasModules: false,
        providerBlocks: [],
        backend: { hasBackend: false }
      } as RepositoryScanResult);
      setExistingFiles([]);
      setExistingFilesReviewed(true);

      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '3' });
      setCurrentStep(3);
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['/api/repositories', provider] });

      // Single consolidated message
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
        message: `Created "${name}" - Choose your target cloud provider.`
      });
      return;
    }

    // For aggregated-root modules in Step 5, this is root module repository creation
    if (moduleApproach === 'aggregated-root' && currentStep === 5) {
      const repoId = (newRepo as any)?.id || name;
      setSelectedRepo(repoId);

      await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
        repositoryId: repoId,
        repositoryName: name,
      });

      // New repository - no backend exists, so mark it
      setRepositoryScanResult({
        isExisting: false,
        cloudProvider: null,
        moduleType: null,
        terraformFiles: [],
        hasResources: false,
        hasModules: false,
        providerBlocks: [],
        backend: { hasBackend: false }
      } as RepositoryScanResult);

      // Single consolidated message
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
        message: `Created root module "${name}" - Backend configuration required.`
      });
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
      queryClient.invalidateQueries({ queryKey: ['/api/repositories', provider] });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
      
      return; // Don't proceed with normal flow - just show the continue button
    }
    
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

    const cloudName = selectedCloudProvider === 'azure' ? 'Azure' :
                      selectedCloudProvider === 'aws' ? 'AWS' : 'GCP';

    // Pre-warm Azure MCP connection if Azure is selected (silently)
    let mcpStatus = '';
    if (selectedCloudProvider === 'azure') {
      try {
        await apiRequest('GET', '/api/debug/azure-mcp');
      } catch (mcpError: any) {
        console.warn('Azure MCP pre-warm failed:', mcpError);
        mcpStatus = ' (Azure connection pending)';
      }
    }

    // Update session and go to Module Approach selection
    await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
      cloudProvider: selectedCloudProvider,
      currentStep: '4'
    });

    // Single consolidated message
    await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
      message: `Cloud provider selected: ${cloudName}${mcpStatus}. Choose the module approach to continue.`
    });

    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
    setCurrentStep(4);
  };

  const handleModuleApproachSelect = async (selectedApproach: ModuleApproach) => {
    setModuleApproach(selectedApproach);

    const approachName = selectedApproach === 'child-module' ? 'Child Module' :
                         selectedApproach === 'standalone-root' ? 'Standalone Root' :
                         'Aggregated Root';

    if (selectedApproach === 'child-module') {
      // Child modules don't need backend configuration
      setBackendConfigured(true);
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
        moduleApproach: selectedApproach,
        currentStep: '6',
        backendDeclined: 'true',
        backendValidated: 'skipped'
      });
      setCurrentStep(6);

      // Single consolidated message
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
        message: `Module approach selected: ${approachName}. Describe the infrastructure components to generate.`
      });
    } else if (selectedApproach === 'aggregated-root') {
      // Reset repository selection state for child module selection
      setSelectedRepo('');
      setChildModuleRepoId('');
      setChildModuleResources([]);
      setChildModuleReviewed(false);

      await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
        moduleApproach: selectedApproach,
        currentStep: '4'
      });
      setCurrentStep(4);

      // Single consolidated message
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
        message: `Module approach selected: ${approachName}. Select the child-module repository.`
      });
    } else {
      // Standalone-root modules - check if backend already exists
      const sessionData = await apiRequest('GET', `/api/sessions/${sessionId}`).then(r => r.json());

      if (sessionData.hasBackend === 'true' || sessionData.hasBackend === true) {
        // Backend already exists - skip configuration
        setBackendConfigured(true);
        await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
          moduleApproach: selectedApproach,
          currentStep: '6',
          backendValidated: 'true'
        });
        setCurrentStep(6);

        await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
          message: `Module approach selected: ${approachName}. Existing backend configuration detected. Describe the infrastructure to generate.`
        });
      } else {
        // Backend doesn't exist - show backend configuration form
        await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
          moduleApproach: selectedApproach,
          currentStep: '5'
        });
        setCurrentStep(5);

        await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
          message: `Module approach selected: ${approachName}. Configure Terraform backend settings to proceed.`
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
        setBackendGeneratedArtifacts(result.details.filesGenerated);
        await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: `Artifacts generated: ${result.details.filesGenerated.join(', ')}` 
        });
      }
      
      // System guidance for next step
      await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
        message: 'Backend setup is complete. Provide the infrastructure requirements to generate Terraform code (for example: resource group, storage account, and app service).' 
      });
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
      
      // Only advance to step 6 if action was successful (not for errors)
      // Check for all possible success statuses
      const isSuccess = action === 'decline' || 
                       (action === 'create' && (result.status === 'success' || result.status === 'configured' || result.status === 'created')) ||
                       (action === 'validate' && (result.status === 'success' || result.status === 'validated'));
      
      if (isSuccess) {
        // Mark backend as configured ONLY after successful configuration
        setBackendConfigured(true);
        
        // Determine next step based on module approach
        const nextStep = moduleApproach === 'aggregated-root' ? '7' : '6';
        
        // Update session first, then update local state
        await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
          currentStep: nextStep,
          backendValidated: 'true',
          backendConfigured: 'true'
        });
        // Invalidate and wait for session to update
        await queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
        // Then update local state
        setCurrentStep(moduleApproach === 'aggregated-root' ? 7 : 6);
        console.log(`✅ Backend configured successfully. Advanced to step ${nextStep}.`);
      } else {
        // Log the actual status for debugging
        console.warn('Backend configuration did not advance. Status:', result.status, 'Action:', action);
        console.warn('Full result:', result);
        // Don't set backendConfigured to true if configuration failed
      }
      // Otherwise stay on current step to allow retry
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
                            errorMessage.includes('Connection closed') ||
                            errorMessage.includes('MCP server') ||
                            errorMessage.includes('Azure MCP server is not available');
      
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
    console.log('\n🎯 ========== handleGenerateRequest CALLED ==========');
    console.log('   Timestamp:', new Date().toISOString());
    console.log('   Message:', message);
    console.log('   Message length:', message?.length || 0);
    console.log('   Session ID:', sessionId);
    console.log('   Module approach:', moduleApproach);
    
    if (!message || message.trim().length === 0) {
      console.error('❌ CRITICAL: Message is empty in handleGenerateRequest!');
      toast({
        title: "Error",
        description: "Description is required to generate code",
        variant: "destructive"
      });
      return;
    }
    
    try {
      console.log('📤 Step 1: Calling chatMutation...');
      await chatMutation.mutateAsync(message);
      console.log('✅ Step 1: chatMutation completed');
      
      console.log('📤 Step 2: Calling generateTerraformMutation...');
      await generateTerraformMutation.mutateAsync(message);
      console.log('✅ Step 2: generateTerraformMutation completed');
      
      console.log('✅ ========== handleGenerateRequest COMPLETE ==========');
    } catch (error: any) {
      console.error('❌ Error in handleGenerateRequest:', error);
      console.error('   Error message:', error?.message);
      console.error('   Error stack:', error?.stack);
      throw error;
    }
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
    <div className="min-h-screen bg-white">
      <Header />

      <main className="container mx-auto px-4 py-6 max-w-7xl">
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Cloud className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold">Terraform Workflow</h1>
                <p className="text-muted-foreground">
                  Generate infrastructure as code for Azure, AWS, or GCP
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={generateTerraformMutation.isPending}
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
            <div className="rounded-xl border bg-card p-5 sm:p-6">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Workflow Progress</h2>
                    <p className="text-sm text-muted-foreground">Structured setup summary for the current Terraform session</p>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs">
                    {backendConfigured ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <Clock3 className="w-4 h-4 text-amber-600" />
                    )}
                    <span className="font-medium">Next Action: {getNextActionLabel()}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
                  {workflowSummaryItems.map((item) => (
                    <div key={item.label} className="rounded-lg border bg-muted/30 p-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.label}</p>
                      <p className="mt-1 text-sm font-medium break-words">{item.value}</p>
                    </div>
                  ))}
                </div>

                {workflowBackendArtifacts.length > 0 && (
                  <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/70 dark:bg-blue-950/30 p-3">
                    <p className="text-xs font-semibold text-blue-900 dark:text-blue-100 mb-2">Provisioned Artifacts</p>
                    <div className="flex flex-wrap gap-2">
                      {workflowBackendArtifacts.map((artifact) => (
                        <span key={artifact} className="inline-flex items-center rounded-md border border-blue-300 dark:border-blue-800 px-2 py-1 text-xs font-mono text-blue-800 dark:text-blue-200 bg-white/90 dark:bg-blue-950/50">
                          {artifact}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Step 1: Provider Selection */}
            {currentStep === 1 && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select Repository Provider</h2>
                  <p className="text-muted-foreground">
                    Choose where to store your Terraform configurations
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                  {config?.hasGithub && (
                    <ProviderCard
                      icon={<CodeIcon className="w-6 h-6" />}
                      title="GitHub"
                      description="Use GitHub repositories for your Terraform configurations"
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
                      description="Use Azure DevOps repositories for your infrastructure code"
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
              </div>
            )}

            {/* Step 2: Repository Selection (for all flows) */}
            {currentStep === 2 && provider && !moduleApproach && !selectedRepo && (
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
                    onClick={() => {
                      setProvider(null);
                      setCurrentStep(1);
                    }}
                  >
                    ← Back
                  </Button>
                </div>

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
              </div>
            )}

            {/* Step 2: Show selected repository and continue to Cloud Provider */}
            {currentStep === 2 && provider && !moduleApproach && selectedRepo && (
              <div className="space-y-6">
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
                        setCloudProvider(null);
                      }}
                      className="text-green-700 dark:text-green-300"
                    >
                      Change
                    </Button>
                  </div>
                </div>

                {/* Show detected cloud provider if found */}
                {cloudProvider && (
                  <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950 p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Cloud className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                        <div>
                          <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
                            Cloud Provider Detected
                          </p>
                          <p className="text-xs text-blue-700 dark:text-blue-300">
                            {cloudProvider === 'azure' ? 'Microsoft Azure' : cloudProvider === 'aws' ? 'Amazon Web Services' : 'Google Cloud Platform'}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setCloudProvider(null);
                          apiRequest('PATCH', `/api/sessions/${sessionId}`, { cloudProvider: null });
                        }}
                        className="text-blue-700 dark:text-blue-300"
                      >
                        Change
                      </Button>
                    </div>
                  </div>
                )}

                {/* Continue button - skip to Module selection if cloud provider already detected */}
                <div className="flex justify-end">
                  <Button
                    onClick={async () => {
                      if (cloudProvider) {
                        // Cloud provider already detected from scan - skip to Module selection
                        await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '4' });
                        setCurrentStep(4);
                        queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
                        await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
                          message: `Using detected cloud provider: ${cloudProvider.toUpperCase()}. Now select your module approach.`
                        });
                      } else {
                        // No cloud provider detected - go to Cloud Provider selection
                        await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '3' });
                        setCurrentStep(3);
                        queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
                        await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, {
                          message: 'Now choose your target cloud provider (Azure, AWS, or GCP).'
                        });
                      }
                    }}
                  >
                    {cloudProvider ? 'Continue to Module Selection →' : 'Continue to Cloud Provider →'}
                  </Button>
                </div>
              </div>
            )}

            {/* Step 2: Cloud Provider Selection (for aggregated-root flow) */}
            {currentStep === 2 && provider && moduleApproach === 'aggregated-root' && !cloudProvider && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select Cloud Provider</h2>
                  <p className="text-muted-foreground">
                    Choose your target cloud platform for infrastructure deployment
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto">
                  {config?.hasAzureCloud && (
                    <ProviderCard
                      icon={<Cloud className="w-6 h-6" />}
                      title="Microsoft Azure"
                      description="Generate Terraform for Azure cloud resources"
                      onClick={() => handleCloudProviderSelect('azure')}
                      selected={cloudProvider === 'azure'}
                      cloudProvider="azure"
                      fillBackground={true}
                      data-testid="card-cloud-azure"
                    />
                  )}
                  {config?.hasAws && (
                    <ProviderCard
                      icon={<CloudCog className="w-6 h-6" />}
                      title="Amazon Web Services"
                      description="Generate Terraform for AWS cloud resources"
                      onClick={() => handleCloudProviderSelect('aws')}
                      selected={cloudProvider === 'aws'}
                      cloudProvider="aws"
                      fillBackground={true}
                      data-testid="card-cloud-aws"
                    />
                  )}
                  {config?.hasGcp && (
                    <ProviderCard
                      icon={<Package className="w-6 h-6" />}
                      title="Google Cloud Platform"
                      description="Generate Terraform for GCP cloud resources"
                      onClick={() => handleCloudProviderSelect('gcp')}
                      selected={cloudProvider === 'gcp'}
                      cloudProvider="gcp"
                      fillBackground={true}
                      data-testid="card-cloud-gcp"
                    />
                  )}
                  {!config?.hasAzureCloud && !config?.hasAws && !config?.hasGcp && (
                    <div className="col-span-3 text-center py-12">
                      <p className="text-muted-foreground mb-4">No cloud providers configured.</p>
                      <Button onClick={() => setLocation('/settings')}>Go to Settings</Button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Step 3: Cloud Provider Selection (after Repository selection for non-aggregated-root) */}
            {currentStep === 3 && provider && selectedRepo && !cloudProvider && !moduleApproach && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select Cloud Provider</h2>
                  <p className="text-muted-foreground">
                    Choose your target cloud platform for infrastructure deployment
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto">
                  {config?.hasAzureCloud && (
                    <ProviderCard
                      icon={<Cloud className="w-6 h-6" />}
                      title="Microsoft Azure"
                      description="Generate Terraform for Azure cloud resources"
                      onClick={() => handleCloudProviderSelect('azure')}
                      selected={cloudProvider === 'azure'}
                      cloudProvider="azure"
                      fillBackground={true}
                      data-testid="card-cloud-azure"
                    />
                  )}
                  {config?.hasAws && (
                    <ProviderCard
                      icon={<CloudCog className="w-6 h-6" />}
                      title="Amazon Web Services"
                      description="Generate Terraform for AWS cloud resources"
                      onClick={() => handleCloudProviderSelect('aws')}
                      selected={cloudProvider === 'aws'}
                      cloudProvider="aws"
                      fillBackground={true}
                      data-testid="card-cloud-aws"
                    />
                  )}
                  {config?.hasGcp && (
                    <ProviderCard
                      icon={<Package className="w-6 h-6" />}
                      title="Google Cloud Platform"
                      description="Generate Terraform for GCP cloud resources"
                      onClick={() => handleCloudProviderSelect('gcp')}
                      selected={cloudProvider === 'gcp'}
                      cloudProvider="gcp"
                      fillBackground={true}
                      data-testid="card-cloud-gcp"
                    />
                  )}
                  {!config?.hasAzureCloud && !config?.hasAws && !config?.hasGcp && (
                    <div className="col-span-3 text-center py-12">
                      <p className="text-muted-foreground mb-4">No cloud providers configured.</p>
                      <Button onClick={() => setLocation('/settings')}>Go to Settings</Button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Step 4: Module Approach Selection (after Cloud Provider selection) */}
            {currentStep === 4 && cloudProvider && !moduleApproach && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select Module Approach</h2>
                  <p className="text-muted-foreground">
                    Choose how you want to structure your Terraform configuration
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto">
                  <ProviderCard
                    icon={<Box className="w-6 h-6" />}
                    title="Child Module"
                    description="Create a reusable child module"
                    onClick={() => handleModuleApproachSelect('child-module')}
                    selected={moduleApproach === 'child-module'}
                    data-testid="card-module-child"
                  />
                  <ProviderCard
                    icon={<Layers className="w-6 h-6" />}
                    title="Standalone Root"
                    description="Create a standalone root module configuration"
                    onClick={() => handleModuleApproachSelect('standalone-root')}
                    selected={moduleApproach === 'standalone-root'}
                    data-testid="card-module-standalone"
                  />
                  <ProviderCard
                    icon={<Network className="w-6 h-6" />}
                    title="Aggregated Root"
                    description="Create a root module that composes multiple child modules"
                    onClick={() => handleModuleApproachSelect('aggregated-root')}
                    selected={moduleApproach === 'aggregated-root'}
                    data-testid="card-module-aggregated"
                  />
                </div>
              </div>
            )}

            {/* Step 4: Child Module Repository Selection (for aggregated-root) */}
            {currentStep === 4 && moduleApproach === 'aggregated-root' && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select Child Module Repository</h2>
                  <p className="text-muted-foreground">
                    Choose the repository containing the child module resources
                  </p>
                </div>
                
                {!childModuleRepoId && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <RepositoryList
                      showSearch={provider === 'github'}
                      repositories={repositories}
                      selectedId={childModuleRepoId}
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

                {childModuleRepoId && childModuleResources.length > 0 && (
                  <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950 p-4 mb-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Package className="w-5 h-5 text-green-600 dark:text-green-400" />
                        <div>
                          <p className="text-sm font-medium text-green-900 dark:text-green-100">
                            Child Module Repository Selected
                          </p>
                          <p className="text-xs text-green-700 dark:text-green-300">
                            {repositories.find(r => r.id === childModuleRepoId)?.name || childModuleRepoId}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setChildModuleRepoId('');
                          setChildModuleResources([]);
                          setChildModuleReviewed(false);
                        }}
                        className="text-green-700 dark:text-green-300"
                      >
                        Change
                      </Button>
                    </div>
                  </div>
                )}

                {childModuleResources.length > 0 && (
                  <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950 p-4 mb-6">
                    <div className="flex items-center gap-2 mb-3">
                      <Package className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                      <h3 className="text-lg font-semibold text-blue-900 dark:text-blue-100">
                        Available Child Module Resources
                      </h3>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {childModuleResources.map((resource, idx) => (
                        <span 
                          key={idx}
                          className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-white dark:bg-gray-800 text-xs font-mono text-blue-800 dark:text-blue-200 border border-blue-300 dark:border-blue-700"
                        >
                          {resource.type}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {childModuleRepoId && childModuleResources.length > 0 && (
                  <div className="flex gap-4 justify-end">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setChildModuleReviewed(false);
                        setCurrentStep(4);
                      }}
                    >
                      ← Back
                    </Button>
                    <Button
                      onClick={async () => {
                        setChildModuleReviewed(true);
                        await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '5' });
                        setCurrentStep(5);
                        queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
                        await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
                          message: 'Child module reviewed. Now select or create the root module repository.' 
                        });
                      }}
                    >
                      Continue to Root Module Repository →
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Step 5: Root Module Repository Selection (for aggregated-root) */}
            {currentStep === 5 && moduleApproach === 'aggregated-root' && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Select Root Module Repository</h2>
                  <p className="text-muted-foreground">
                    Choose or create the repository for your root module configuration
                  </p>
                </div>
                
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

                {selectedRepo && (
                  <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950 p-4 mb-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Package className="w-5 h-5 text-green-600 dark:text-green-400" />
                        <div>
                          <p className="text-sm font-medium text-green-900 dark:text-green-100">
                            Root Module Repository Selected
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
                        }}
                        className="text-green-700 dark:text-green-300"
                      >
                        Change
                      </Button>
                    </div>
                  </div>
                )}

                {selectedRepo && (
                  <div className="flex gap-4 justify-end">
                    <Button
                      variant="outline"
                      onClick={() => setCurrentStep(2)}
                    >
                      ← Back
                    </Button>
                    <Button
                      onClick={async () => {
                        // For aggregated-root: Go to backend configuration step (Step 5) after root module repository selection
                        // Check if backend exists in repository
                        const sessionData = await apiRequest('GET', `/api/sessions/${sessionId}`).then(r => r.json());
                        const hasBackend = sessionData.hasBackend === 'true' || sessionData.hasBackend === true || 
                                         (repositoryScanResult && repositoryScanResult.backend && repositoryScanResult.backend.hasBackend);
                        
                        if (hasBackend) {
                          // Backend exists - skip to resource input step
                          setBackendConfigured(true);
                          await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
                            currentStep: '6',
                            backendValidated: 'true'
                          });
                          setCurrentStep(6);
                          await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
                            message: 'Backend configuration already exists. Now describe the resources you want to create in the root module. The system will validate them against the child module resources.' 
                          });
                        } else {
                          // New repository - backend must be configured
                          // For aggregated-root, backend is at Step 6
                          await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: '6' });
                          setCurrentStep(6);
                          queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId] });
                          await apiRequest('POST', `/api/sessions/${sessionId}/messages/system`, { 
                            message: 'This is a new repository. Backend configuration is required before you can describe resources for the root module.' 
                          });
                        }
                      }}
                    >
                      Continue to Backend →
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Step 5: Backend Configuration (for non-aggregated-root) or Step 6 (for aggregated-root) */}
            {((currentStep === 5 && moduleApproach !== 'aggregated-root') || (currentStep === 6 && moduleApproach === 'aggregated-root')) && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Configure Terraform Backend</h2>
                  <p className="text-muted-foreground">
                    {cloudProvider === 'aws'
                      ? 'Enter the AWS backend configuration details. The app will generate backend.tf with S3 and DynamoDB configuration.'
                      : 'Enter the Azure backend configuration details. The app will create these resources and generate backend.tf.'}
                  </p>
                </div>

                <div className="max-w-2xl mx-auto">
                  <div className="bg-card rounded-lg border p-8">
                    
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

            {/* Step 6: Describe Infrastructure (for non-aggregated-root only) */}
            {currentStep === 6 && moduleApproach !== 'aggregated-root' && backendConfigured && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Describe Your Infrastructure</h2>
                  <p className="text-muted-foreground">
                    Describe the Terraform resources you want to create
                  </p>
                </div>

                {generateTerraformMutation.isPending && (
                  <div className="text-center py-12">
                    <Loader2 className="w-12 h-12 animate-spin mx-auto mb-4 text-primary" />
                    <p className="text-muted-foreground">
                      Generating Terraform configuration...
                    </p>
                  </div>
                )}

                <div className="flex gap-4 justify-center">
                  <Button
                    variant="outline"
                    onClick={() => setCurrentStep(5)}
                  >
                    ← Back
                  </Button>
                </div>
              </div>
            )}

            {/* Step 7: Resource Input and Validation (for aggregated-root only) */}
            {currentStep === 7 && moduleApproach === 'aggregated-root' && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Describe Root Module Resources</h2>
                  <p className="text-muted-foreground">
                    Describe the resources you want to create in the root module. The system will validate them against the available child module resources.
                  </p>
                </div>

                {/* Show warning if child module resources not loaded */}
                {childModuleResources.length === 0 && (
                  <div className="rounded-lg border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950 p-4 mb-6">
                    <div className="flex items-center gap-2 mb-2">
                      <svg className="w-5 h-5 text-yellow-600 dark:text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <h3 className="text-lg font-semibold text-yellow-900 dark:text-yellow-100">
                        Child Module Resources Not Loaded
                      </h3>
                    </div>
                    <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-3">
                      Child module resources are being loaded. Please wait or go back to select the child module repository.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentStep(2)}
                    >
                      ← Go Back to Select Child Module
                    </Button>
                  </div>
                )}

                {/* Show available child module resources */}
                {childModuleResources.length > 0 && (
                  <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950 p-4 mb-6">
                    <div className="flex items-center gap-2 mb-3">
                      <Package className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                      <h3 className="text-lg font-semibold text-blue-900 dark:text-blue-100">
                        Available Child Module Resources
                      </h3>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {childModuleResources.map((resource, idx) => (
                        <span 
                          key={idx}
                          className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-white dark:bg-gray-800 text-xs font-mono text-blue-800 dark:text-blue-200 border border-blue-300 dark:border-blue-700"
                        >
                          {resource.type}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Resource Description - shown when user has submitted via ChatInput */}
                {resourceDescription && (
                  <div className="mb-6 p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950">
                    <p className="text-sm font-semibold mb-2">Your Resource Description:</p>
                    <p className="text-sm text-blue-900 dark:text-blue-100">{resourceDescription}</p>
                  </div>
                )}

                {/* Validation Result */}
                {resourceValidationResult && (
                  <div className={`rounded-lg border p-4 ${
                    resourceValidationResult.valid 
                      ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950' 
                      : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950'
                  }`}>
                    <div className="flex items-center gap-2 mb-2">
                      {resourceValidationResult.valid ? (
                        <>
                          <svg className="w-5 h-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          <h3 className="text-lg font-semibold text-green-900 dark:text-green-100">
                            Validation Successful
                          </h3>
                        </>
                      ) : (
                        <>
                          <svg className="w-5 h-5 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          <h3 className="text-lg font-semibold text-red-900 dark:text-red-100">
                            Validation Failed
                          </h3>
                        </>
                      )}
                    </div>
                    <p className={`text-sm mb-3 ${
                      resourceValidationResult.valid 
                        ? 'text-green-800 dark:text-green-200' 
                        : 'text-red-800 dark:text-red-200'
                    }`}>
                      {resourceValidationResult.message}
                    </p>
                    {resourceValidationResult.requestedResources && resourceValidationResult.requestedResources.length > 0 && (
                      <div className="mb-3">
                        <p className="text-xs font-semibold mb-1">Requested Resources:</p>
                        <div className="flex flex-wrap gap-2">
                          {resourceValidationResult.requestedResources.map((resource, idx) => (
                            <span key={idx} className="px-2 py-1 rounded bg-white dark:bg-gray-800 text-xs font-mono">
                              {resource}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {resourceValidationResult.unavailableResources && resourceValidationResult.unavailableResources.length > 0 && (
                      <div className="mb-3">
                        <p className="text-xs font-semibold mb-1 text-red-800 dark:text-red-200">Unavailable Resources:</p>
                        <div className="flex flex-wrap gap-2">
                          {resourceValidationResult.unavailableResources.map((resource, idx) => (
                            <span key={idx} className="px-2 py-1 rounded bg-red-100 dark:bg-red-900 text-xs font-mono text-red-800 dark:text-red-200">
                              {resource}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Action Buttons - Only show Continue if validation passed */}
                {resourceValidationResult?.valid && (
                  <div className="flex gap-4 justify-end">
                    <Button
                      variant="outline"
                      onClick={() => setCurrentStep(6)}
                    >
                      ← Back
                    </Button>
                    <Button
                      onClick={async () => {
                        console.log('\n🚀 ========== Continue to Generate Button Clicked ==========');
                        console.log('   resourceDescription:', resourceDescription);
                        
                        if (!resourceDescription || resourceDescription.trim().length === 0) {
                          toast({
                            title: "Error",
                            description: "Resource description is required",
                            variant: "destructive"
                          });
                          return;
                        }
                        
                        try {
                          // Generate code first (while staying on Step 7, showing loading state)
                          console.log('   Triggering code generation...');
                          await handleGenerateRequest(resourceDescription);
                          
                          // After generation completes successfully, refetch files and advance to Step 8
                          console.log('   Code generation complete, refetching files...');
                          
                          // Force refetch files before advancing
                          await queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                          const filesResult = await refetchFiles();
                          console.log('   Files refetched:', filesResult.data?.length || 0);
                          
                          // Advance to Step 8
                          console.log('   Advancing to Step 8...');
                          await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
                            currentStep: '8'
                          });
                          setCurrentStep(8);
                          
                          toast({
                            title: "Success",
                            description: "Code generated successfully. Review the files below.",
                          });
                        } catch (error: any) {
                          console.error('   Code generation failed:', error);
                          toast({
                            title: "Generation Failed",
                            description: error?.message || "Failed to generate code. Please try again.",
                            variant: "destructive"
                          });
                        }
                      }}
                      disabled={chatMutation.isPending || generateTerraformMutation.isPending}
                    >
                      {chatMutation.isPending || generateTerraformMutation.isPending ? (
                        <>
                          <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                          Generating Code...
                        </>
                      ) : (
                        <>
                          Continue to Generate →
                        </>
                      )}
                    </Button>
                  </div>
                )}
                {resourceValidationResult && !resourceValidationResult.valid && (
                  <div className="mt-4 p-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950">
                    <p className="text-sm text-red-800 dark:text-red-200 font-semibold mb-2">
                      ❌ Validation Failed: Resources do not match available child module resources.
                    </p>
                    <p className="text-xs text-red-700 dark:text-red-300">
                      Please review the unavailable resources above and adjust your description. You can submit a new description using the input below.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Step 8: Build workspace (non-aggregated-root) or Step 9: Build workspace (aggregated-root) */}
            {((currentStep === 8 && moduleApproach !== 'aggregated-root') || (currentStep === 9 && moduleApproach === 'aggregated-root')) && (() => {
              // Derived stats for Overview tab
              const allContent = (generatedFiles ?? []).map(f => f.content ?? '').join('\n');
              const totalLines = allContent ? allContent.split('\n').length : 0;
              const resourceMatches = allContent.match(/^resource\s+"[^"]+"/gm) ?? [];
              const uniqueResourceTypes = Array.from(new Set(
                (allContent.match(/^resource\s+"([^"]+)"/gm) ?? []).map(m => m.replace(/^resource\s+"/, '').replace(/"$/, ''))
              ));
              const varCount = (allContent.match(/^variable\s+"/gm) ?? []).length;
              const outputCount = (allContent.match(/^output\s+"/gm) ?? []).length;

              return (
                <div className="space-y-6">
                  {/* ── Header ── */}
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight">Build Workspace</h2>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {(generatedFiles ?? []).length > 0
                        ? `${generatedFiles.length} files generated · ${cloudProvider?.toUpperCase() ?? 'Cloud'} infrastructure ready`
                        : 'Your infrastructure is being prepared…'}
                    </p>
                  </div>


                  {/* ── Tab bar ── */}
                  <div className="flex gap-1 border-b">
                    {(['overview', 'build', 'code'] as const).map(mode => (
                      <button
                        key={mode}
                        onClick={() => setActivityViewMode(mode)}
                        className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors -mb-px ${
                          activityViewMode === mode
                            ? 'border-primary text-primary'
                            : 'border-transparent text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {mode === 'build' ? 'Build Pipeline' : mode.charAt(0).toUpperCase() + mode.slice(1)}
                      </button>
                    ))}
                  </div>

                  {/* ══════════════════════════════════════════════
                       OVERVIEW TAB
                  ══════════════════════════════════════════════ */}
                  {activityViewMode === 'overview' && (
                    <div className="space-y-6">

                      {/* KPI cards */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {[
                          { label: 'Files',       value: (generatedFiles ?? []).length, sub: 'generated', icon: FileCode,  color: 'text-blue-500',   bg: 'bg-blue-50 dark:bg-blue-950/30' },
                          { label: 'Lines',        value: totalLines.toLocaleString(),   sub: 'of HCL',   icon: Hash,      color: 'text-violet-500', bg: 'bg-violet-50 dark:bg-violet-950/30' },
                          { label: 'Resources',   value: resourceMatches.length,         sub: 'declared', icon: Box,       color: 'text-emerald-500',bg: 'bg-emerald-50 dark:bg-emerald-950/30' },
                          { label: 'Cloud',       value: cloudProvider?.toUpperCase() ?? '—', sub: 'provider', icon: Cloud, color: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/30' },
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

                      {/* Variables / Outputs badge row */}
                      {(varCount > 0 || outputCount > 0) && (
                        <div className="flex flex-wrap gap-2">
                          {varCount > 0 && (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-muted border">
                              <Hash className="w-3 h-3" /> {varCount} variable{varCount !== 1 ? 's' : ''}
                            </span>
                          )}
                          {outputCount > 0 && (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-muted border">
                              <ChevronRight className="w-3 h-3" /> {outputCount} output{outputCount !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Resource type chips */}
                      {uniqueResourceTypes.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
                            Infrastructure Components
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {uniqueResourceTypes.map(rt => {
                              const { label, icon: Icon } = tfResourceLabel(rt);
                              return (
                                <span
                                  key={rt}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border bg-card hover:bg-muted/60 transition-colors"
                                >
                                  <Icon className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                                  {label}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* File cards grid */}
                      {(generatedFiles ?? []).length > 0 && (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
                            Generated Files
                          </p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {generatedFiles.map(f => {
                              const lines = (f.content ?? '').split('\n').length;
                              const resCount = ((f.content ?? '').match(/^resource\s+"/gm) ?? []).length;
                              const isMain = f.fileName.includes('main');
                              const isVars = f.fileName.includes('variable');
                              const isOut  = f.fileName.includes('output');
                              const isBknd = f.fileName.includes('backend') || f.fileName.includes('provider');
                              return (
                                <button
                                  key={f.fileName}
                                  onClick={() => setActivityViewMode('code')}
                                  className="group text-left rounded-2xl border bg-card p-4 hover:border-primary/40 hover:shadow-sm transition-all space-y-2"
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <FileCode className={`w-4 h-4 shrink-0 ${isMain ? 'text-blue-500' : isVars ? 'text-violet-500' : isOut ? 'text-emerald-500' : isBknd ? 'text-orange-500' : 'text-muted-foreground'}`} />
                                      <span className="text-xs font-mono font-semibold truncate">{f.fileName}</span>
                                    </div>
                                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5" />
                                  </div>
                                  <div className="flex gap-3 text-xs text-muted-foreground">
                                    <span>{lines} lines</span>
                                    {resCount > 0 && <span className="text-emerald-600 dark:text-emerald-400">{resCount} resource{resCount !== 1 ? 's' : ''}</span>}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                    </div>
                  )}

                  {/* ══════════════════════════════════════════════
                       BUILD TAB
                  ══════════════════════════════════════════════ */}
                  {activityViewMode === 'build' && (
                    <ActivityPanel
                      sessionId={sessionId}
                      workflowType="terraform"
                      moduleApproach={moduleApproach}
                      onScanComplete={() => {
                        setScanCompleted(true);
                        refetchFiles();
                        // Generate unique build ID: BUILD-YYYYMMDD-HHmmss
                        const now = new Date();
                        const pad = (n: number) => String(n).padStart(2, '0');
                        const id = `BUILD-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
                        setBuildId(id);
                        toast({ title: "Build Complete", description: `${id} — ready to commit.` });
                      }}
                      onFixesApproved={() => {
                        refetchFiles();
                        toast({ title: "Fixes Applied", description: "Security fixes applied. Files updated." });
                      }}
                    />
                  )}

                  {/* ══════════════════════════════════════════════
                       CODE TAB
                  ══════════════════════════════════════════════ */}
                  {activityViewMode === 'code' && (
                    <div className="space-y-3">
                      <div className="rounded-2xl border bg-card overflow-hidden">
                        {(generatedFiles ?? []).length > 0 ? (
                          <CodeEditor
                            files={generatedFiles.map(f => ({ name: f.fileName, content: f.content }))}
                            onFileChange={handleFileChange}
                          />
                        ) : (
                          <div className="p-10 text-center text-muted-foreground space-y-2">
                            <FileCode className="w-8 h-8 mx-auto opacity-40" />
                            <p className="text-sm">No files generated yet</p>
                            {generateTerraformMutation.isPending && (
                              <p className="text-xs flex items-center justify-center gap-1.5">
                                <Loader2 className="w-3 h-3 animate-spin" /> Generating…
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── Navigation ── */}
                  <div className="space-y-3 pt-2">
                    {/* Build ID badge — shown once build completes */}
                    {buildId && (
                      <div className="flex justify-center">
                        <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-mono font-semibold bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {buildId}
                        </span>
                      </div>
                    )}
                    <div className="flex gap-3 justify-center">
                      <Button
                        variant="outline"
                        onClick={() => setCurrentStep(moduleApproach === 'aggregated-root' ? 8 : 6)}
                      >
                        ← Back
                      </Button>
                      <Button
                        disabled={!scanCompleted}
                        title={!scanCompleted ? 'Run the Build pipeline first to continue' : undefined}
                        onClick={async () => {
                          const nextStep = moduleApproach === 'aggregated-root' ? 10 : 9;
                          setCurrentStep(nextStep as Step);
                          await apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: nextStep.toString() });
                        }}
                      >
                        {!scanCompleted ? (
                          <>
                            <Clock3 className="w-4 h-4 mr-1.5 opacity-50" />
                            Awaiting Build…
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="w-4 h-4 mr-1.5" />
                            Continue to Commit →
                          </>
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

            {/* Step 9: Commit (non-aggregated-root) or Step 10: Commit (aggregated-root) */}
            {((currentStep === 9 && moduleApproach !== 'aggregated-root') || (currentStep === 10 && moduleApproach === 'aggregated-root')) && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Commit & Push</h2>
                  <p className="text-muted-foreground">
                    Commit your Terraform configuration to the repository
                  </p>
                </div>
                <div className="flex gap-4 justify-center">
                  <Button
                    variant="outline"
                    onClick={() => setCurrentStep(moduleApproach === 'aggregated-root' ? 9 : 8)}
                  >
                    ← Back
                  </Button>
                  <Button
                    onClick={handleApprove}
                    disabled={commitMutation.isPending}
                  >
                    {commitMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Committing...
                      </>
                    ) : (
                      'Commit & Push →'
                    )}
                  </Button>
                </div>
                {!scanCompleted && moduleApproach !== 'aggregated-root' && (
                  <p className="text-sm text-muted-foreground text-center">
                    Please run the security scan before committing
                  </p>
                )}
                {isCommitted && (
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
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Resource input for non-aggregated-root (Step 6) - only show after backend is configured */}
        {currentStep === 6 && moduleApproach !== 'aggregated-root' && backendConfigured && (
          <ChatInput
            onSend={handleGenerateRequest}
            placeholder="Describe your Terraform setup... e.g., 'Create Terraform for Azure Storage Account and Resource Group'"
            disabled={chatMutation.isPending || generateTerraformMutation.isPending}
          />
        )}
        
        {/* Resource input for aggregated-root (Step 7) - shown when validation is not yet done or failed, and backend is configured */}
        {currentStep === 7 && moduleApproach === 'aggregated-root' && backendConfigured && !resourceValidationResult?.valid && (
          <ChatInput
            onSend={(input) => {
              // For aggregated-root, validate resources first before generating
              if (!input.trim()) {
                toast({
                  title: "Description Required",
                  description: "Please describe the resources you want to create.",
                  variant: "destructive"
                });
                return;
              }
              if (childModuleResources.length === 0) {
                toast({
                  title: "Child Module Not Reviewed",
                  description: "Please go back and select the child module repository first.",
                  variant: "destructive"
                });
                return;
              }
              setResourceDescription(input);
              validateResourcesMutation.mutate(input);
            }}
            placeholder="Describe the resources you want to create in the root module... e.g., 'Create a resource group, storage account, and app service using the child modules'"
            disabled={validateResourcesMutation.isPending}
          />
        )}
        
        {/* Code generation loading state for aggregated-root (Step 8) - shown while generating */}
        {currentStep === 8 && moduleApproach === 'aggregated-root' && backendConfigured && resourceValidationResult?.valid && generateTerraformMutation.isPending && (
          <div className="space-y-4 p-6 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950">
            <div className="flex items-center gap-3">
              <RefreshCw className="w-5 h-5 animate-spin text-blue-600 dark:text-blue-400" />
              <div>
                <p className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                  Generating Code...
                </p>
                <p className="text-xs text-blue-700 dark:text-blue-300">
                  Creating backend and resource files. This may take a moment.
                </p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
