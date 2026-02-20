import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useSecretsConfig } from "@/hooks/useSecretsConfig";
import Header from "@/components/Header";
import ProviderCard from "@/components/ProviderCard";
import RepositoryList from "@/components/RepositoryList";
import CreateRepoForm from "@/components/CreateRepoForm";
import StepIndicator from "@/components/StepIndicator";
import CodeEditor from "@/components/CodeEditor";
import ActivityPanel from "@/components/ActivityPanel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Package, Home, RefreshCw, Loader2, Shield, FileText, CheckCircle2, GitBranch, Search, FileCode, FolderTree } from "lucide-react";
import type { Session, Message, Repository, GeneratedFile } from "@shared/schema";

interface ExistingDockerfile {
  path: string;
  content: string;
}

interface DockerRepoScan {
  languages: string[];
  frameworks: string[];
  configFiles: string[];
  dependencies: Array<{ file: string; entries: string[] }>;
  entrypoint?: string;
  existingDockerfile?: ExistingDockerfile;
}

type Step = 1 | 2 | 3 | 4 | 5 | 6;
type Provider = 'github' | 'azure' | null;

interface DockerRequirements {
  baseImage?: string;
  runtime?: string;
  dependencies?: string[];
  buildCommands?: string[];
  envVars?: Record<string, string>;
  ports?: number[];
  workingDir?: string;
  healthCheck?: string;
  multiStage?: boolean;
}

export default function DockerWorkflow() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [sessionId, setSessionId] = useState<string>('');
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [provider, setProvider] = useState<Provider>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [selectedRepoId, setSelectedRepoId] = useState<string>('');
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState<boolean>(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [defaultBranchName, setDefaultBranchName] = useState<string | null>(null);
  const [analysisFeedback, setAnalysisFeedback] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [scanCompleted, setScanCompleted] = useState<boolean>(false);
  const [scanHasResults, setScanHasResults] = useState<boolean>(false); // Track if scan has actual results (not 0 total)
  const [repoScanData, setRepoScanData] = useState<DockerRepoScan | null>(null);
  const [isRepoScanning, setIsRepoScanning] = useState<boolean>(false);
  const [scanPhase, setScanPhase] = useState<string>('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [isCommitted, setIsCommitted] = useState<boolean>(false);
  const [existingDockerfile, setExistingDockerfile] = useState<ExistingDockerfile | null>(null);

  // Fetch secrets configuration status
  const { data: config } = useSecretsConfig();

  const steps: Array<{ number: number; title: string }> = [
    { number: 1, title: 'Repository' },
    { number: 2, title: 'Requirements' },
    { number: 3, title: 'Generate' },
    { number: 4, title: 'Review' },
    { number: 5, title: 'Activities' },
    { number: 6, title: 'Commit' },
  ];

  // Create or restore session on mount
  useEffect(() => {
    const initializeSession = async () => {
      const savedSessionId = localStorage.getItem('docker_workflow_session_id');
      
      if (savedSessionId) {
        try {
          const response = await apiRequest('GET', `/api/sessions/${savedSessionId}`);
          const session = await response.json() as Session;
          setSessionId(session.id);
          
          // Restore state from session
          if (session.provider) setProvider(session.provider as Provider);
          if (session.repositoryName) setSelectedRepo(session.repositoryName);
          if (session.repositoryId) setSelectedRepoId(session.repositoryId);
          if (session.repositoryBranch) {
            setSelectedBranch(session.repositoryBranch);
            setDefaultBranchName(session.repositoryBranch);
          }

          if (session.currentStep) {
            const stepNum = parseInt(session.currentStep, 10) as Step;
            // Step 2 requires scan data which is in-memory only — fall back to step 1
            // so the user can re-trigger the scan
            if (stepNum === 2) {
              setCurrentStep(1);
            } else if (stepNum > 2 && stepNum <= 6) {
              setCurrentStep(stepNum);
              setScanCompleted(true);
            }
          }

          return;
        } catch (error) {
          localStorage.removeItem('docker_workflow_session_id');
        }
      }
      
      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      localStorage.setItem('docker_workflow_session_id', session.id);
      
      await apiRequest('PATCH', `/api/sessions/${session.id}`, {
        activeModule: 'docker'
      });
      
      await apiRequest('POST', `/api/sessions/${session.id}/messages/system`, { 
        message: 'Welcome to Docker Workflow! Select a repository to get started.' 
      });
    };
    initializeSession();
  }, []);

  // Persist currentStep to session on change
  useEffect(() => {
    if (sessionId && currentStep > 1) {
      apiRequest('PATCH', `/api/sessions/${sessionId}`, { currentStep: String(currentStep) }).catch(() => {});
    }
  }, [currentStep, sessionId]);

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
    enabled: !!provider && currentStep === 1,
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
    },
    onError: (error: any) => {
      toast({
        title: "Failed to Create Repository",
        description: error?.message || "Failed to create repository. Please try again.",
        variant: "destructive"
      });
    }
  });

  // Fetch generated files
  const { data: generatedFiles = [] } = useQuery<GeneratedFile[]>({
    queryKey: ['/api/sessions', sessionId, 'files'],
    enabled: !!sessionId && currentStep >= 4,
    refetchOnMount: true,
  });

  // Generate Dockerfile mutation
  const generateDockerfileMutation = useMutation({
    mutationFn: async (payload: { description: string; existingDockerfile?: ExistingDockerfile | null }) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/generate-dockerfile`, {
        requirements: payload.description,
        existingDockerfile: payload.existingDockerfile,
      });
      return res.json();
    },
    onSuccess: async (data) => {
      setIsGenerating(false);
      setCurrentStep(4); // Move to review step
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
        currentStep: '4'
      });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
      toast({
        title: "Success",
        description: "Dockerfile generated successfully!",
      });
    },
    onError: (error: any) => {
      setIsGenerating(false);
      toast({
        title: "Generation Failed",
        description: error?.message || "Failed to generate Dockerfile. Please try again.",
        variant: "destructive"
      });
    }
  });

  // Commit mutation
  const commitMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/commit-docker`, {
        message: `Add Dockerfile and related files`
      });
      return res.json();
    },
    onSuccess: () => {
      setIsCommitted(true);
      toast({
        title: "Success",
        description: "Dockerfile committed successfully!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Commit Failed",
        description: error?.message || "Failed to commit Dockerfile.",
        variant: "destructive"
      });
    }
  });

  const handleProviderSelect = async (selectedProvider: Provider) => {
    setProvider(selectedProvider);
    setSelectedRepo('');
    setSelectedRepoId('');
    setBranches([]);
    setSelectedBranch(null);
    setBranchesError(null);
    setDefaultBranchName(null);
    await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
      provider: selectedProvider 
    });
    setCurrentStep(1);
  };

  const fetchBranches = async (repoName: string): Promise<string> => {
    if (!sessionId) {
      return selectedBranch || "main";
    }

    setBranchesLoading(true);
    setBranchesError(null);

    try {
      const response = await apiRequest("GET", `/api/sessions/${sessionId}/branches`);
      const payload = await response.json();
      const availableBranches = Array.isArray(payload.branches) ? payload.branches : [];
      setBranches(availableBranches);
      const defaultBranch =
        typeof payload.defaultBranch === "string" && payload.defaultBranch.length > 0
          ? payload.defaultBranch
          : availableBranches[0] || "main";

      setDefaultBranchName(defaultBranch);
      setSelectedBranch(null);

      try {
        await apiRequest("PATCH", `/api/sessions/${sessionId}`, {
          repositoryBranch: defaultBranch,
        });
      } catch (patchError) {
        console.warn("Failed to persist selected branch:", patchError);
      }

      return defaultBranch;
    } catch (error: any) {
      const message = error?.message || "Failed to load branches";
      setBranchesError(message);
      return selectedBranch || "main";
    } finally {
      setBranchesLoading(false);
    }
  };

  const fetchRepoScan = async (repoName?: string, branchOverride?: string) => {
    const targetRepo = repoName || selectedRepo;
    if (!sessionId || !targetRepo || !provider) return;
    setRepoScanData(null);
    setExistingDockerfile(null);
    setIsRepoScanning(true);
    setScanError(null);
    setScanPhase('connecting');
    try {
      const branchToUse = branchOverride || selectedBranch || "main";
      setSelectedBranch(branchToUse);

      // Simulate phased progress for the user while API processes
      const phaseTimer1 = setTimeout(() => setScanPhase('listing'), 1500);
      const phaseTimer2 = setTimeout(() => setScanPhase('inspecting'), 4000);
      const phaseTimer3 = setTimeout(() => setScanPhase('dependencies'), 7000);

      // Timeout after 60 seconds to prevent indefinite hang
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      const response = await fetch(`/api/sessions/${sessionId}/docker-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(localStorage.getItem('token') ? { Authorization: `Bearer ${localStorage.getItem('token')}` } : {}),
        },
        body: JSON.stringify({ provider, repository: targetRepo, branch: branchToUse }),
        signal: controller.signal,
        credentials: 'include',
      });

      clearTimeout(timeoutId);
      clearTimeout(phaseTimer1);
      clearTimeout(phaseTimer2);
      clearTimeout(phaseTimer3);

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.details || errData.error || `Scan failed (${response.status})`);
      }
      setScanPhase('finalizing');

      const data = await response.json();
      setRepoScanData(data);
      setExistingDockerfile(data.existingDockerfile || null);
      const languagesCount = Array.isArray(data.languages) ? data.languages.length : 0;
      const frameworksCount = Array.isArray(data.frameworks) ? data.frameworks.length : 0;
      const dependenciesCount = Array.isArray(data.dependencies) ? data.dependencies.length : 0;
      const hasResults =
        languagesCount > 0 ||
        frameworksCount > 0 ||
        !!data.entrypoint ||
        dependenciesCount > 0 ||
        !!data.existingDockerfile;
      setScanHasResults(hasResults);
      if (!hasResults) {
        const missing: string[] = [];
        if (languagesCount === 0) missing.push("languages");
        if (frameworksCount === 0) missing.push("frameworks");
        if (!data.entrypoint) missing.push("entrypoint");
        if (dependenciesCount === 0) missing.push("dependencies");
        throw new Error(`Issue with the repo scanned – missing ${missing.join(", ")}`);
      }
      setAnalysisFeedback(null);
      if (currentStep === 1) {
        setCurrentStep(2);
      }
      setScanCompleted(true);
    } catch (error: any) {
      const isTimeout = error?.name === 'AbortError';
      const message = isTimeout
        ? "Analysis timed out. The repository may be too large or contain vendored files (node_modules). Try a smaller repo or ensure node_modules is in .gitignore."
        : error?.message ||
          error?.details ||
          error?.response?.data?.message ||
          "Failed to scan repository";
      setAnalysisFeedback(message.includes("Issue with the repo scanned") ? message : null);
      setScanError(message);
      toast({
        title: isTimeout ? "Analysis timed out" : "Scan failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsRepoScanning(false);
      setScanPhase('');
    }
  };

  const handleRepoSelect = async (repo: Repository) => {
    if (!sessionId) {
      toast({
        title: "Session missing",
        description: "Unable to select repository because session is not ready.",
        variant: "destructive",
      });
      return;
    }

    setExistingDockerfile(null);
    setSelectedRepo(repo.name);
    setSelectedRepoId(repo.id);
    setBranchesError(null);
    setAnalysisFeedback(null);
    setSelectedBranch(null);

    try {
      const patchPayload: Record<string, string | null> = {
        repositoryName: repo.name,
        repositoryId: repo.id,
      };
      if (repo.branch) {
        patchPayload.repositoryBranch = repo.branch;
      }

      await apiRequest('PATCH', `/api/sessions/${sessionId}`, patchPayload);
    } catch (error: any) {
      toast({
        title: "Update failed",
        description: error?.message || "Unable to save repository selection",
        variant: "destructive",
      });
      return;
    }

    const defaultBranch = await fetchBranches(repo.name);
    await handleBranchChange(defaultBranch);

    toast({
      title: "Repository Selected",
      description: `Selected repository: ${repo.name}. Default branch suggestion: ${defaultBranch}. Choose a branch to begin the analysis.`,
    });
  };

  const clearRepositorySelection = async () => {
    if (!sessionId) return;

    setSelectedRepo('');
    setSelectedRepoId('');
    setBranches([]);
    setSelectedBranch(null);
    setDefaultBranchName(null);
    setRepoScanData(null);
    setExistingDockerfile(null);
    setScanCompleted(false);
    setScanHasResults(false);
    setScanError(null);
    setAnalysisFeedback(null);
    setCurrentStep(1);

    try {
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
        repositoryName: null,
        repositoryId: null,
        repositoryBranch: null,
        currentStep: '1'
      });
    } catch (error) {
      console.warn("Failed to clear repository selection:", error);
    }
  };

  const handleBranchChange = async (branch: string) => {
    if (!sessionId || !selectedRepo) return;
    setSelectedBranch(branch);
    try {
      await apiRequest("PATCH", `/api/sessions/${sessionId}`, {
        repositoryBranch: branch,
      });
      await fetchRepoScan(undefined, branch);
    } catch (error: any) {
      toast({
        title: "Branch update failed",
        description: error?.message || "Unable to switch branches",
        variant: "destructive",
      });
    }
  };

  const buildAutoRequirementText = (
    repoName: string,
    branch: string,
    scanData?: DockerRepoScan | null,
    existingDockerfile?: ExistingDockerfile | null
  ): string => {
    const languages = scanData?.languages?.join(", ") || "multiple languages";
    const frameworks = scanData?.frameworks?.join(", ") || "multiple frameworks";
    const base = `Auto-generate Dockerfile for ${repoName} on branch ${branch}. Detected languages: ${languages}. Detected frameworks: ${frameworks}.`;
    if (existingDockerfile) {
      return `${base} Validate and improve the existing Dockerfile at ${existingDockerfile.path}, keeping all security and optimization best practices.`;
    }
    return `${base} Create a new Dockerfile based on the repository scan.`;
  };

  const handleCreateRepo = async ({ name, description }: { name: string; description: string }) => {
    try {
      await createRepoMutation.mutateAsync({ name, description });
      setSelectedRepo(name);
      await apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
        repositoryName: name,
        currentStep: '2'
      });
      queryClient.invalidateQueries({ queryKey: ['/api/repositories', provider] });
    } catch (error) {
      // Error is handled by mutation's onError
    }
  };

  const resetRepositorySelection = () => {
    setExistingDockerfile(null);
    setSelectedRepo('');
    setSelectedRepoId('');
    setSelectedBranch(null);
    setBranches([]);
    setDefaultBranchName(null);
    setBranchesError(null);
    setRepoScanData(null);
    setScanCompleted(false);
    setScanHasResults(false);
    setScanError(null);
  };

  const handleGenerate = async (description: string, existingDockerfile?: ExistingDockerfile | null) => {
    setIsGenerating(true);
    setCurrentStep(3);
    await generateDockerfileMutation.mutateAsync({ description, existingDockerfile });
  };

  const handleProceedToGenerate = async () => {
    if (!selectedRepo || !scanCompleted || !scanHasResults || isGenerating) {
      return;
    }
    const branchToUse = selectedBranch || defaultBranchName || "main";
    const requirement = buildAutoRequirementText(
      selectedRepo,
      branchToUse,
      repoScanData,
      existingDockerfile
    );
    await handleGenerate(requirement, existingDockerfile);
  };

  const handleFileChange = async (fileName: string, content: string) => {
    try {
      // Find existing file or create new one
      const existingFile = generatedFiles.find(f => f.fileName === fileName);
      
      if (existingFile) {
        await apiRequest('PUT', `/api/sessions/${sessionId}/files/${existingFile.id}`, {
          content
        });
      } else {
        await apiRequest('POST', `/api/sessions/${sessionId}/files`, {
          fileName,
          content
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error?.message || "Failed to save file",
        variant: "destructive"
      });
    }
  };

  const handleGoHome = () => {
    setLocation('/');
  };

  const resetWorkflowState = () => {
    setCurrentStep(1);
    setProvider(null);
    setSelectedRepo('');
    setSelectedRepoId('');
    setRepoScanData(null);
    setScanCompleted(false);
    setScanHasResults(false);
    setScanError(null);
    setIsRepoScanning(false);
    setIsGenerating(false);
    setIsCommitted(false);
    setBranches([]);
    setSelectedBranch(null);
    setBranchesLoading(false);
    setBranchesError(null);
    setDefaultBranchName(null);
    setAnalysisFeedback(null);
    setExistingDockerfile(null);
  };

  const handleRefresh = async () => {
    const repoQueryKey = provider ? ['/api/repositories', provider] : null;
    queryClient.invalidateQueries();
    if (repoQueryKey) {
      queryClient.invalidateQueries({ queryKey: repoQueryKey });
    }

    if (sessionId) {
      try {
        await apiRequest('PATCH', `/api/sessions/${sessionId}`, {
          provider: null,
          repositoryName: null,
          currentStep: '1',
        });
      } catch (error: any) {
        toast({
          title: "Unable to reset session",
          description: error?.message || "Session reset failed.",
          variant: "destructive",
        });
      }
    }

    resetWorkflowState();
    toast({
      title: "Refreshed",
      description: "Docker workflow reset successfully",
    });
  };

  const getDependencyHighlights = (): string[] => {
    if (!repoScanData?.dependencies?.length) {
      return ["Dependencies will be listed here after analysis completes."];
    }
    return repoScanData.dependencies.map((dep, index) => {
      const entries = dep.entries.filter(Boolean).slice(0, 3);
      const summary = entries.length > 0 ? entries.join(", ") : "Pending";
      return `${index + 1}. ${dep.file}: ${summary}`;
    });
  };

  const formatDetectedList = (items: string[] | undefined, fallback: string): string => {
    if (items && items.length > 0) {
      return items.join(", ");
    }
    return fallback;
  };

  const getApplicationTypeDescription = (): string => {
    if (!repoScanData) {
      return "Determining application type from the repository...";
    }
    const frameworks = repoScanData.frameworks.map((fw) => fw.toLowerCase());
    if (frameworks.some((fw) => fw.includes("react") || fw.includes("vue") || fw.includes("angular"))) {
      return "Frontend SPA or UI-focused application";
    }
    if (frameworks.some((fw) => fw.includes("express") || fw.includes("node"))) {
      return "Node.js backend or microservice";
    }
    if (frameworks.some((fw) => fw.includes("python"))) {
      return "Python backend/service or automation app";
    }
    if (frameworks.some((fw) => fw.includes("java") || fw.includes("spring"))) {
      return "Java backend or enterprise service";
    }
    if (repoScanData.frameworks.length > 1) {
      return "Polyglot application (monorepo or multi-service)";
    }
    return "General backend service or utility";
  };

  const getRecommendedBaseImage = (): string => {
    if (!repoScanData) {
      return "Base image will be selected after the scan completes.";
    }
    const languages = repoScanData.languages.map((lang) => lang.toLowerCase());
    if (languages.some((lang) => lang.includes("node"))) {
      return "node:20-alpine";
    }
    if (languages.some((lang) => lang.includes("python"))) {
      return "python:3.12-slim";
    }
    if (languages.some((lang) => lang.includes("go"))) {
      return "golang:1.22-alpine";
    }
    if (languages.some((lang) => lang.includes("java"))) {
      return "eclipse-temurin:21-jdk";
    }
    return "debian:bookworm-slim";
  };

  const getBuildSteps = (): string[] => {
    const steps: string[] = [];
    if (!repoScanData) {
      return ["Awaiting repository scan to determine build steps."];
    }
    if (repoScanData.frameworks.some((fw) => fw.toLowerCase().includes("node"))) {
      steps.push("Install Node dependencies (npm/yarn) and run any build scripts.");
    }
    if (repoScanData.frameworks.some((fw) => fw.toLowerCase().includes("python"))) {
      steps.push("Install Python packages from requirements or pyproject.");
    }
    steps.push("Copy source files and lock dependencies into the container.");
    if (repoScanData.entrypoint) {
      steps.push(`Set ENTRYPOINT/CMD to ${repoScanData.entrypoint}.`);
    } else {
      steps.push("Determine runnable entrypoint (e.g. npm start or python app.py).");
    }
    return steps;
  };

  const getChallenges = (): string[] => {
    if (!repoScanData) {
      return ["Waiting to identify potential challenges."];
    }
    const challenges: string[] = [];
    const languages = repoScanData.languages.map((lang) => lang.toLowerCase());
    if (languages.some((lang) => lang.includes("go") || lang.includes("c#") || lang.includes("rust"))) {
      challenges.push("Multi-stage builds are recommended for compiled languages to keep image size small.");
    }
    if (!repoScanData.entrypoint) {
      challenges.push("Entry point could not be automatically detected; may need manual confirmation.");
    }
    if (repoScanData.dependencies.some((dep) => dep.entries.length > 5)) {
      challenges.push("Large dependency tree detected; cache dependencies where possible.");
    }
    if (challenges.length === 0) {
      challenges.push("No major challenges detected. Review the generated Dockerfile for customization.");
    }
    return challenges;
  };

  const dependencyHighlights = getDependencyHighlights();

  return (
    <div className="min-h-screen bg-white">
      <Header>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Package className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">Docker Workflow</h1>
          </div>
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleGoHome}>
              <Home className="w-4 h-4 mr-2" />
              Home
            </Button>
          </div>
        </div>
      </Header>

      <main className="container mx-auto px-6 py-8 max-w-7xl">
        <StepIndicator steps={steps} currentStep={currentStep} />
        <Card className="mb-6 border border-dashed border-border/60 bg-slate-50/80 p-4 shadow-sm text-sm text-muted-foreground">
          <p className="font-semibold text-slate-900">Docker module scope</p>
          <p>
            This workflow only generates Dockerfiles (and related Docker artifacts). Repository selection,
            branch analysis, and automated Dockerfile creation are the only supported steps—no Terraform, AutomationScripts,
            ScoreMe, or unrelated content (e.g., weather) is accepted here.
          </p>
        </Card>

        <div className="mt-8">
          {/* Step 1: Repository Selection */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-2xl font-bold mb-2">Select Repository Provider</h2>
                <p className="text-muted-foreground">
                  Choose where to store your Dockerfile
                </p>
              </div>

              {!provider ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                  {config?.hasGithub && (
                    <ProviderCard
                      icon={<FileText className="w-6 h-6" />}
                      title="GitHub"
                      description="Store Dockerfile in GitHub repository"
                      onClick={() => handleProviderSelect('github')}
                      provider="github"
                      fillBackground={true}
                    />
                  )}
                  {config?.hasAzureDevOps && (
                    <ProviderCard
                      icon={<FileText className="w-6 h-6" />}
                      title="Azure DevOps"
                      description="Store Dockerfile in Azure DevOps repository"
                      onClick={() => handleProviderSelect('azure')}
                      provider="azure"
                      fillBackground={true}
                    />
                  )}
                  {!config?.hasGithub && !config?.hasAzureDevOps && (
                    <div className="col-span-2 text-center py-12">
                      <p className="text-muted-foreground mb-4">No repository providers configured.</p>
                      <Button onClick={() => setLocation('/settings')}>Go to Settings</Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="mb-4">
                    <h2 className="text-2xl font-bold mb-2">Select Repository</h2>
                    <p className="text-muted-foreground">
                      Select an existing repository or create a new one from {provider === 'github' ? 'GitHub' : 'Azure DevOps'}. Once the branch is selected, the repository scan runs automatically.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)] gap-6">
                    <div className="space-y-4">
                      {!selectedRepo ? (
                        <>
                          <RepositoryList
                            showSearch={provider === 'github'}
                            repositories={repositories}
                            selectedId={selectedRepoId || undefined}
                            onSelect={(id) => setSelectedRepoId(id)}
                            onRepoSelect={handleRepoSelect}
                          />
                          <Card className="border-dashed border border-border/40 p-4">
                            <p className="text-sm text-muted-foreground mb-2">Need another repository?</p>
                            <Button variant="outline" size="sm" onClick={() => clearRepositorySelection()}>
                              Refresh repository list
                            </Button>
                          </Card>
                        </>
                      ) : (
                        <Card className="space-y-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm text-muted-foreground">Repository selected</p>
                              <p className="text-lg font-semibold text-slate-900">{selectedRepo}</p>
                            </div>
                            <Button variant="ghost" size="sm" onClick={clearRepositorySelection}>
                              Change
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            The branch dropdown below lets you pick exactly which branch the AI should analyze.
                          </p>
                        </Card>
                      )}
                      {selectedRepo && !isRepoScanning && (
                        <Card className="space-y-3">
                          <div className="p-4 space-y-2">
                            <div className="flex items-center justify-between">
                              <p className="text-sm font-semibold">Branch</p>
                              {branchesLoading && <span className="text-xs text-muted-foreground">Loading...</span>}
                            </div>
                            <Select
                              value={selectedBranch || defaultBranchName || ""}
                              onValueChange={handleBranchChange}
                              disabled={branchesLoading && branches.length === 0}
                            >
                              <SelectTrigger className="w-full">
                                <SelectValue
                                  placeholder={
                                    branchesLoading
                                      ? "Loading branches..."
                                      : defaultBranchName
                                        ? `Select branch (default: ${defaultBranchName})`
                                        : "Select branch"
                                  }
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {branches.length > 0 ? (
                                  branches.map((branch) => (
                                    <SelectItem key={branch} value={branch}>
                                      {branch}
                                    </SelectItem>
                                  ))
                                ) : (
                                  <SelectItem value={defaultBranchName || "main"}>
                                    {defaultBranchName || "main"}
                                  </SelectItem>
                                )}
                              </SelectContent>
                            </Select>
                            {branchesError && <p className="text-xs text-rose-600">{branchesError}</p>}
                            <p className="text-xs text-muted-foreground">
                              Branch selection is required to start the AI analysis.
                            </p>
                            <Button
                              size="sm"
                              variant="default"
                              className="w-full mt-2"
                              onClick={() => fetchRepoScan(selectedRepo, selectedBranch || defaultBranchName || undefined)}
                              disabled={!selectedBranch && !defaultBranchName}
                            >
                              Run Analysis
                            </Button>
                          </div>
                        </Card>
                      )}
                      {selectedRepo && isRepoScanning && (
                        <Card className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 to-blue-50 p-6 shadow-lg">
                          <div className="space-y-5">
                            <div className="flex items-center gap-3">
                              <div className="relative">
                                <Loader2 className="w-8 h-8 animate-spin text-primary" />
                              </div>
                              <div>
                                <p className="text-lg font-semibold text-slate-900">Analyzing Repository</p>
                                <p className="text-sm text-muted-foreground">
                                  {selectedRepo} &middot; {selectedBranch || defaultBranchName || 'main'}
                                </p>
                              </div>
                            </div>

                            {/* Progress bar */}
                            <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                              <div
                                className="h-full bg-primary rounded-full transition-all duration-1000 ease-out"
                                style={{
                                  width: scanPhase === 'connecting' ? '15%'
                                    : scanPhase === 'listing' ? '35%'
                                    : scanPhase === 'inspecting' ? '60%'
                                    : scanPhase === 'dependencies' ? '80%'
                                    : scanPhase === 'finalizing' ? '95%'
                                    : '5%'
                                }}
                              />
                            </div>

                            {/* Phase steps */}
                            <div className="space-y-2.5">
                              {[
                                { id: 'connecting', icon: GitBranch, label: 'Connecting to repository' },
                                { id: 'listing', icon: FolderTree, label: 'Listing repository file tree' },
                                { id: 'inspecting', icon: Search, label: 'Detecting languages & frameworks' },
                                { id: 'dependencies', icon: FileCode, label: 'Reading dependency files' },
                                { id: 'finalizing', icon: CheckCircle2, label: 'Finalizing analysis' },
                              ].map((phase) => {
                                const phases = ['connecting', 'listing', 'inspecting', 'dependencies', 'finalizing'];
                                const currentIdx = phases.indexOf(scanPhase);
                                const phaseIdx = phases.indexOf(phase.id);
                                const isActive = phase.id === scanPhase;
                                const isDone = phaseIdx < currentIdx;
                                return (
                                  <div key={phase.id} className={`flex items-center gap-3 text-sm transition-all duration-300 ${isActive ? 'text-primary font-medium' : isDone ? 'text-emerald-600' : 'text-muted-foreground/50'}`}>
                                    {isDone ? (
                                      <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                                    ) : isActive ? (
                                      <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                                    ) : (
                                      <phase.icon className="w-4 h-4 shrink-0" />
                                    )}
                                    <span>{phase.label}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </Card>
                      )}
                    </div>
                    {!selectedRepo && (provider === 'github' || provider === 'azure') && (
                      <CreateRepoForm
                        onSubmit={handleCreateRepo}
                        loading={createRepoMutation.isPending}
                      />
                    )}
                    {/* Scan error with retry */}
                    {scanError && !isRepoScanning && selectedRepo && (
                      <Card className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
                        <div className="flex items-start gap-3">
                          <Shield className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                          <div className="flex-1 space-y-2">
                            <p className="font-semibold text-rose-900">Analysis failed</p>
                            <p className="text-sm text-rose-700">{scanError}</p>
                            <Button
                              size="sm"
                              variant="outline"
                              className="mt-2"
                              onClick={() => fetchRepoScan(selectedRepo, selectedBranch || defaultBranchName || undefined)}
                            >
                              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                              Retry Analysis
                            </Button>
                          </div>
                        </div>
                      </Card>
                    )}
                  </div>

                </div>
              )}
            </div>
          )}

          {/* Step 2: Automated Repository Analysis */}
          {currentStep === 2 && (
            <div className="space-y-6">
              {analysisFeedback && (
                <Card className="border border-amber-200 bg-amber-50 text-amber-900">
                  <div className="flex items-start gap-3">
                    <Shield className="w-5 h-5 text-amber-600" />
                    <div>
                      <p className="font-semibold">Analysis blocked</p>
                      <p className="text-xs">{analysisFeedback}</p>
                    </div>
                  </div>
                </Card>
              )}
              {repoScanData ? (
                <div className="space-y-6">
                  <Card className="rounded-3xl border border-border/60 bg-white/90 p-6 shadow-xl">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.5em] text-muted-foreground">Analysis Summary</p>
                        <p className="text-xl font-semibold text-slate-900 mt-2">
                          {selectedRepo || "Selected repository"}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {provider?.toUpperCase() || "Provider"} · Branch: {selectedBranch || defaultBranchName || "main"}
                        </p>
                      </div>
                      <div className="text-sm text-muted-foreground text-right space-y-1">
                        <p>
                          Files inspected: <span className="font-semibold text-slate-900">{repoScanData.configFiles.length || "n/a"}</span>
                        </p>
                        <p>
                          Analysis status: <span className="font-semibold text-slate-900">{scanCompleted ? "Complete" : "Running"}</span>
                        </p>
                      </div>
                    </div>
                    <div className="mt-6 grid gap-4 md:grid-cols-3">
                      <div className="rounded-2xl border border-border/40 bg-slate-50 p-3">
                        <p className="text-[11px] uppercase tracking-[0.4em] text-muted-foreground">Languages</p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          {repoScanData.languages.length > 0 ? repoScanData.languages.join(", ") : "Not detected"}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-border/40 bg-slate-50 p-3">
                        <p className="text-[11px] uppercase tracking-[0.4em] text-muted-foreground">Frameworks</p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          {repoScanData.frameworks.length > 0 ? repoScanData.frameworks.join(", ") : "Not detected"}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-border/40 bg-slate-50 p-3">
                        <p className="text-[11px] uppercase tracking-[0.4em] text-muted-foreground">Entrypoint</p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          {repoScanData.entrypoint || "Not detected"}
                        </p>
                      </div>
                    </div>
                  </Card>
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                    <Card className="space-y-3 border border-border/50 bg-white p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] uppercase tracking-[0.4em] text-muted-foreground">Dependencies</p>
                        <span className="text-xs text-muted-foreground">
                          {dependencyHighlights.length} detected
                        </span>
                      </div>
                      {dependencyHighlights.length > 0 ? (
                        <ul className="space-y-1 text-xs text-slate-700">
                          {dependencyHighlights.map((dep) => (
                            <li key={dep}>{dep}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Dependencies will appear once package manifests are parsed.
                        </p>
                      )}
                    </Card>
                    <div className="space-y-4">
                      <Card className="space-y-3 border border-border/50 bg-white p-4 shadow-sm">
                        <p className="text-[11px] uppercase tracking-[0.4em] text-muted-foreground">Recommended base image</p>
                        <p className="text-sm font-semibold text-slate-900">{getRecommendedBaseImage()}</p>
                        <div className="text-xs text-muted-foreground">
                          <p className="mt-2 font-semibold text-slate-900">Build & runtime guide</p>
                          <ul className="mt-1 space-y-1">
                            {getBuildSteps().map((step) => (
                              <li key={step} className="leading-relaxed">
                                {step}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </Card>
                      <Card className="space-y-3 border border-border/50 bg-white p-4 shadow-sm">
                        <p className="text-[11px] uppercase tracking-[0.4em] text-muted-foreground">Challenges</p>
                        <ul className="space-y-1 text-xs text-slate-700">
                          {getChallenges().map((challenge) => (
                            <li key={challenge}>{challenge}</li>
                          ))}
                        </ul>
                      </Card>
                    </div>
                  </div>
              <Card className="space-y-3 border border-border/50 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.4em] text-muted-foreground">Dockerfile status</p>
                    <p className="text-sm font-semibold text-slate-900 mt-1">
                      {existingDockerfile ? "Existing Dockerfile found" : "No Dockerfile detected"}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {existingDockerfile ? "AI can validate & update this file" : "AI will generate a Dockerfile from scratch"}
                  </p>
                </div>
                {existingDockerfile ? (
                  <Textarea
                    value={existingDockerfile.content}
                    readOnly
                    className="h-[220px] font-mono text-xs resize-none"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No Dockerfile was discovered during the scan. Proceeding will create a new one based on the repository analysis.
                  </p>
                )}
              </Card>
              <div className="flex justify-end">
                <Button
                  onClick={handleProceedToGenerate}
                  disabled={!scanCompleted || !scanHasResults || isGenerating}
                >
                  {isGenerating ? "Generating..." : "Next → Generate"}
                </Button>
              </div>
                </div>
              ) : (
                <Card className="space-y-3 border-dashed border-border/40">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-900">Analysis in progress</p>
                    {isRepoScanning && (
                      <div className="flex items-center gap-2 text-xs text-primary">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Scanning...
                      </div>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Select a repository and branch to allow the AI engine to inspect the code, determine dependencies, and orchestrate Dockerfile creation without extra prompts.
                  </p>
                </Card>
              )}
            </div>
          )}

          {/* Step 3: Generate (shows loading) */}
          {currentStep === 3 && (
            <Card className="rounded-3xl border-dashed border-border/40 bg-white/80 p-6 text-center shadow-lg">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
                <p className="text-lg font-semibold text-slate-900">Generating Dockerfile...</p>
                <p className="text-sm text-muted-foreground">
                  The AI is building the optimized Dockerfile, .dockerignore, and supporting recommendations. This usually completes in a few seconds.
                </p>
              </div>
            </Card>
          )}

          {/* Step 4: Review & Edit */}
          {currentStep === 4 && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-2xl font-bold mb-2">Generated Dockerfile</h2>
                <p className="text-muted-foreground">
                  Review and edit the AI-generated artifacts before scanning or committing.
                </p>
              </div>

              <div className="rounded-3xl border border-border/60 bg-white/90 p-6 shadow-xl space-y-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.5em] text-muted-foreground">Files generated</p>
                    <p className="text-4xl font-semibold text-primary">{generatedFiles.length}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Auto-generated directly from the repository scan. Edit as needed before scanning or committing.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {generatedFiles.length > 0 ? (
                    generatedFiles.map((file) => (
                      <div key={file.id} className="rounded-2xl border border-border/30 bg-slate-50 p-3">
                        <p className="text-sm font-semibold text-slate-900">{file.fileName}</p>
                        <p className="text-[11px] uppercase tracking-[0.5em] text-muted-foreground mt-1">Artifacts</p>
                        <p className="text-xs text-muted-foreground mt-2">
                          {file.content.split("\n").length} lines · {file.content.length} chars
                        </p>
                      </div>
                    ))
                  ) : (
                    <div className="col-span-full rounded-2xl border border-dashed border-border/40 bg-slate-50 p-4">
                      <p className="text-xs text-muted-foreground">
                        Dockerfile generation may still be in progress. Please wait a few seconds and refresh the view.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <Card className="rounded-3xl border border-border/60 bg-slate-50 p-0 overflow-hidden shadow-xl">
                {generatedFiles && generatedFiles.length > 0 ? (
                  <CodeEditor 
                    files={generatedFiles.map(f => ({ name: f.fileName, content: f.content }))} 
                    onFileChange={handleFileChange} 
                  />
                ) : (
                  <div className="text-center p-8">
                    <p className="text-lg font-semibold text-slate-900">No files found</p>
                    <p className="text-sm text-muted-foreground">
                      Dockerfile generation may have failed. Please try again.
                    </p>
                  </div>
                )}
              </Card>

              <div className="flex flex-wrap gap-4 justify-center">
                <Button
                  variant="outline"
                  onClick={() => setCurrentStep(2)}
                >
                  ← Back
                </Button>
                <Button
                  onClick={() => {
                    setCurrentStep(5);
                    apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
                      currentStep: '5'
                    });
                  }}
                >
                  Continue to Scan →
                </Button>
              </div>
            </div>
          )}

          {/* Step 5: Activities */}
          {currentStep === 5 && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-2xl font-bold mb-2">Activities</h2>
                <p className="text-muted-foreground">
                  Run security scans and other activities on your Dockerfile
                </p>
              </div>

              <ActivityPanel 
                sessionId={sessionId}
                workflowType="docker"
                onScanComplete={(result) => {
                  setScanCompleted(true);
                  // Only mark as having results if scan was successful and has resources
                  if (result && result.success && result.summary && result.summary.total > 0) {
                    setScanHasResults(true);
                  } else {
                    setScanHasResults(false);
                  }
                }}
              />

              <div className="flex flex-col gap-4 items-center">
                <div className="flex gap-4 justify-center">
                  <Button
                    variant="outline"
                    onClick={() => setCurrentStep(4)}
                  >
                    ← Back
                  </Button>
                  <Button
                    onClick={() => {
                      setCurrentStep(6);
                      apiRequest('PATCH', `/api/sessions/${sessionId}`, { 
                        currentStep: '6'
                      });
                    }}
                    disabled={!scanHasResults}
                  >
                    Continue to Commit →
                  </Button>
                </div>
                {!scanHasResults && scanCompleted && (
                  <p className="text-sm text-muted-foreground text-center">
                    Please run a successful security scan (with results) before committing
                  </p>
                )}
                {!scanCompleted && (
                  <p className="text-sm text-muted-foreground text-center">
                    Please run a security scan before committing
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Step 6: Commit */}
          {currentStep === 6 && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-2xl font-bold mb-2">Commit to Repository</h2>
                <p className="text-muted-foreground">
                  Commit your Dockerfile to {selectedRepo}
                </p>
              </div>

              <div className="max-w-2xl mx-auto">
                <div className="bg-muted/50 p-6 rounded-lg space-y-4">
                  <div>
                    <p className="text-sm font-semibold mb-2">Repository:</p>
                    <p className="text-sm text-muted-foreground">{selectedRepo}</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold mb-2">Files to commit:</p>
                    <ul className="list-disc list-inside text-sm text-muted-foreground">
                      {generatedFiles.map(f => (
                        <li key={f.id}>{f.fileName}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="flex gap-4 justify-center mt-6">
                  <Button
                    variant="outline"
                    onClick={() => setCurrentStep(5)}
                  >
                    ← Back
                  </Button>
                  <Button
                    onClick={() => commitMutation.mutate()}
                    disabled={commitMutation.isPending || isCommitted}
                  >
                    {commitMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Committing...
                      </>
                    ) : isCommitted ? (
                      <>
                        <FileText className="w-4 h-4 mr-2" />
                        Committed
                      </>
                    ) : (
                      <>
                        <FileText className="w-4 h-4 mr-2" />
                        Commit to Repository
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

