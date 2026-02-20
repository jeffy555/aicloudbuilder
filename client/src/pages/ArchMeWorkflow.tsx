import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useSecretsConfig } from "@/hooks/useSecretsConfig";
import Header from "@/components/Header";
import AIMessage from "@/components/AIMessage";
import UserMessage from "@/components/UserMessage";
import ChatInput from "@/components/ChatInput";
import ArchitectureDiagram, { ArchitectureDiagramRef } from "@/components/ArchitectureDiagram";
import ActivityPanel from "@/components/ActivityPanel";
import RepositoryList from "@/components/RepositoryList";
import CreateRepoForm from "@/components/CreateRepoForm";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Network, Home, RefreshCw, CheckCircle2, Code, GitBranch, Package, ChevronRight, ChevronDown, XCircle, CodeIcon, Cloud, FileCode } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Checkbox as UICheckbox } from "@/components/ui/checkbox";
import CodeEditor from "@/components/CodeEditor";
import type { Session, Message, GeneratedFile } from "@shared/schema";

type WorkflowStep = 'diagram' | 'approval' | 'repository' | 'components' | 'code' | 'review';
type Provider = 'github' | 'azure';

const ARCHITECTURE_KEYWORDS = [
  "architecture",
  "diagram",
  "service",
  "cloud",
  "component",
  "network",
  "load balancer",
  "api",
  "database",
  "storage",
  "queue",
  "kubernetes",
  "container",
  "serverless",
  "gateway",
  "region",
  "availability",
  "security",
  "data flow",
  "cache",
  "failover",
  "microservices",
  "frontend",
  "backend",
  "platform",
  "system",
  "module",
  "deployment",
  "statefulset",
  "daemonset",
  "ingress",
  "egress",
  "observability",
  "monitoring",
  "telemetry",
  "metrics",
  "dashboard",
  "alerts",
  "alerting",
  "logging",
  "tracing",
  "react",
  "angular",
  "vue",
  "svelte",
  "nextjs",
  "nuxt",
  "node",
  "express",
  "nestjs",
  "deno",
  "spring",
  "spring boot",
  "springboot",
  "django",
  "flask",
  "fastapi",
  "golang",
  "gin",
  "rust",
  "rocket",
  "asp.net",
  "dotnet",
  "python",
  "java",
  "postgresql",
  "postgres",
  "mysql",
  "mariadb",
  "sql server",
  "sqlserver",
  "oracle",
  "cosmosdb",
  "cosmos",
  "mongodb",
  "redis",
  "memcached",
  "cassandra",
  "dynamodb",
  "aurora",
  "sql",
  "nosql",
  "blob",
  "blob storage",
  "data lake",
  "synapse",
  "event hub",
  "event grid",
  "service bus",
  "kafka",
  "rabbitmq",
  "nats",
  "messaging",
  "pub/sub",
  "azure",
  "aws",
  "gcp",
  "google cloud",
  "cloudflare",
  "cloudfront",
  "cdn",
  "edge",
  "vnet",
  "subnet",
  "availability zone",
  "availability set",
  "firewall",
  "waf",
  "network security",
  "security group",
  "identity",
  "iam",
  "rbac",
  "oauth2",
  "jwt",
  "ssl",
  "tls",
  "certificate",
  "key vault",
  "vault",
  "secrets",
  "policy",
  "ci/cd",
  "pipeline",
  "workflow",
  "github actions",
  "azure pipelines",
  "gitlab",
  "jenkins",
  "circleci",
  "artifacts",
  "deploy",
  "release",
  "build",
  "test",
  "automation",
  "orchestrator",
  "terraform",
  "arm",
  "bicep",
  "api gateway",
  "application gateway",
  "app service",
  "function app",
  "lambda",
  "cloud functions",
  "app engine",
  "elastic beanstalk",
  "pods",
  "autoscaler",
  "autoscaling",
  "horizontal pod autoscaler",
  "node pool",
  "cluster",
  "control plane",
  "worker nodes",
  "cache",
  "containers",
  "session",
  "state",
  "stateful",
  "stateless",
  "event driven",
  "message bus",
  "event-driven",
  "service mesh",
  "istio",
  "linkerd",
  "intent",
  "observability stack",
  "monitoring stack",
  "security stack",
  "infrastructure",
  "foundation",
  "orchestration",
  "automation",
  "scalability",
  "resilience",
  "resiliency",
  "high availability",
  "fault tolerance",
  "disaster recovery",
  "backup",
  "restore",
  "replication",
  "caching",
  "content delivery network"
];

const ARCHME_BANNED_KEYWORDS = [
  "automation script",
  "scoreme",
  "deploy agent",
  "runbook",
  "weather",
  "trivia",
  "personal"
];

const MIN_REQUIREMENTS_LENGTH = 50;

const ARCHITECTURE_SIGNAL_PATTERNS = [
  /deploy/,
  /provision/,
  /design/,
  /architecture/,
  /diagram/,
  /stack/,
  /solution/,
  /orchestrate/,
  /scale/,
  /secure/,
  /monitor/
];

type ArtifactLayerId = 'terraform' | 'kubernetes' | 'monitoring' | 'helm' | 'cicd';

interface ArtifactLayerDefinition {
  id: ArtifactLayerId;
  title: string;
  summary: string;
  description: string;
  keywords: string[];
  defaultActive: boolean;
}

const ARTIFACT_LAYER_DEFINITIONS: ArtifactLayerDefinition[] = [
  {
    id: 'terraform',
    title: 'Terraform infrastructure provisioning',
    summary: 'Terraform infra',
    description: 'Provision Azure resources such as AKS, ACR, Key Vault, Storage Accounts, Log Analytics, etc.',
    keywords: ['terraform', 'aks', 'acr', 'key vault', 'storage', 'log analytics', 'resource group', 'vnet', 'subscription', 'azure monitor'],
    defaultActive: true,
  },
  {
    id: 'kubernetes',
    title: 'Kubernetes/YAML manifests for workloads',
    summary: 'Kubernetes YAML',
    description: 'Deploy microservices, ingress, secrets, PVCs, CSI drivers, Prometheus exporters, and other in-cluster workloads.',
    keywords: ['kubernetes', 'microservice', 'deployment', 'statefulset', 'daemonset', 'container', 'ingress', 'helm', 'manifest', 'yaml', 'service mesh'],
    defaultActive: false,
  },
  {
    id: 'monitoring',
    title: 'Monitoring stack (Prometheus + Grafana)',
    summary: 'Monitoring',
    description: 'Include Prometheus/Grafana for observability, dashboards, scrapes, and alerting inside AKS.',
    keywords: ['prometheus', 'grafana', 'monitoring', 'observability', 'alert', 'metrics', 'scrape', 'dashboard'],
    defaultActive: false,
  },
  {
    id: 'helm',
    title: 'Helm chart packaging',
    summary: 'Helm charts',
    description: 'Package Kubernetes workloads or dependencies into reusable Helm charts.',
    keywords: ['helm', 'chart', 'helmfile'],
    defaultActive: false,
  },
  {
    id: 'cicd',
    title: 'CI/CD pipeline manifests',
    summary: 'CI/CD YAML',
    description: 'Generate pipeline definitions for GitHub Actions or Azure Pipelines to deploy the stacks.',
    keywords: ['pipeline', 'ci/cd', 'workflow', 'github actions', 'azure pipelines', 'release', 'deploy job'],
    defaultActive: false,
  },
];

interface ArtifactLayerSuggestion extends ArtifactLayerDefinition {
  matchedKeywords: string[];
  detected: boolean;
}

function detectArtifactLayers(input: string): ArtifactLayerSuggestion[] {
  const normalized = input.toLowerCase();
  return ARTIFACT_LAYER_DEFINITIONS.map((layer) => {
    const matchedKeywords = layer.keywords.filter((keyword) => normalized.includes(keyword));
    return {
      ...layer,
      matchedKeywords,
      detected: matchedKeywords.length > 0,
    };
  });
}

function getLayerSummaryLabel(id: ArtifactLayerId): string {
  return ARTIFACT_LAYER_DEFINITIONS.find((layer) => layer.id === id)?.summary ?? id;
}

function inferCodeType(fileName: string): GeneratedCode["codeType"] {
  const parts = fileName.split(".");
  const extension = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
  if (extension === "yaml" || extension === "yml" || extension === "json") return "yaml";
  if (extension === "k8s") return "kubernetes";
  if (extension === "tf" || extension === "tfvars" || extension === "hcl") return "terraform";
  return "terraform";
}

interface ArchitectureValidationResult {
  isValid: boolean;
  keywords: string[];
  banned: string[];
  length: number;
  reason?: string;
}

function evaluateArchitectureIntent(input: string): ArchitectureValidationResult {
  const cleaned = input.trim();
  const normalized = cleaned.toLowerCase();
  const keywords = ARCHITECTURE_KEYWORDS.filter((keyword) => normalized.includes(keyword));
  const banned = ARCHME_BANNED_KEYWORDS.filter((keyword) => normalized.includes(keyword));
  const length = cleaned.length;
  const hasRepeatingChars = /(.)\1{4,}/.test(normalized.replace(/\s+/g, ""));
  const signalDetected = ARCHITECTURE_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));

  let reason: string | undefined;
  if (banned.length > 0) {
    reason = `The input contained off-scope keywords (${banned.join(", ")}). Please describe architecture components instead.`;
  } else if (length < MIN_REQUIREMENTS_LENGTH) {
    reason = "Please provide slightly more context (at least 50 characters) describing the architecture.";
  } else if (hasRepeatingChars) {
    reason = "The input looks noisy or gibberish. Please describe actual architecture requirements.";
  } else {
    const uniqueConcepts = new Set(keywords);
    const strongNarrative = signalDetected && length >= 140;
    const detailedNarrative = signalDetected && length >= 200;
    const needsMoreConcepts =
      uniqueConcepts.size < 2 &&
      !(strongNarrative && uniqueConcepts.size >= 1) &&
      !(keywords.length === 0 && detailedNarrative);

    if (needsMoreConcepts) {
      reason = "Please mention at least two architecture concepts (cloud, service, component, etc.).";
    }
  }

  const isValid = !reason;
  return { isValid, keywords, banned, length, reason };
}

interface ExtractedComponent {
  name: string;
  type: string;
  provider: 'azure' | 'aws' | 'gcp' | 'third-party' | 'unknown';
  category: string;
  description: string;
  dependencies: string[];
  codeType: 'terraform' | 'arm' | 'helm' | 'yaml' | 'kubernetes';
}

interface GeneratedCode {
  componentName: string;
  codeType: string;
  fileName: string;
  content: string;
  description: string;
  dependencies: string[];
}

export default function ArchMeWorkflow() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [sessionId, setSessionId] = useState<string>('');
  const [requirements, setRequirements] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>('diagram');
  const [diagramApproved, setDiagramApproved] = useState<boolean>(false);
  const [diagramGenerated, setDiagramGenerated] = useState<boolean>(false);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [selectedRepoName, setSelectedRepoName] = useState<string>('');
  const [repoValidationStatus, setRepoValidationStatus] = useState<{ isEmpty: boolean; fileCount: number } | null>(null);
  const [extractedComponents, setExtractedComponents] = useState<ExtractedComponent[]>([]);
  const [generatedCode, setGeneratedCode] = useState<GeneratedCode[]>([]);
  const [expandedComponents, setExpandedComponents] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState<string>('Add infrastructure code from ArchMe diagram');
  const [readmeContent, setReadmeContent] = useState<string>('');
  const [showReadme, setShowReadme] = useState<boolean>(false);
  const [validationResult, setValidationResult] = useState<ArchitectureValidationResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pendingIntent, setPendingIntent] = useState<string>('');
  const [intentPreviewVisible, setIntentPreviewVisible] = useState<boolean>(false);
  const [intentLayerSuggestions, setIntentLayerSuggestions] = useState<ArtifactLayerSuggestion[]>([]);
  const [selectedIntentLayers, setSelectedIntentLayers] = useState<Set<ArtifactLayerId>>(new Set());
  const [confirmedLayers, setConfirmedLayers] = useState<ArtifactLayerId[]>([]);
  const diagramRef = useRef<ArchitectureDiagramRef>(null);

  // Create or restore session on mount
  useEffect(() => {
    const initializeSession = async () => {
      const savedSessionId = localStorage.getItem('archme_workflow_session_id');
      
      if (savedSessionId) {
        try {
          const response = await apiRequest('GET', `/api/sessions/${savedSessionId}`);
          const session = await response.json() as Session;
          setSessionId(session.id);

          // Restore workflow state from session
          if (session.provider) setProvider(session.provider as Provider);
          if (session.repositoryName) setSelectedRepoName(session.repositoryName);
          if (session.repositoryId) setSelectedRepo(session.repositoryId);

          // Infer workflow step from session data
          const hasAnalysis = !!(session as any).archMeAnalysis;
          if (hasAnalysis) {
            setDiagramGenerated(true);
            setDiagramApproved(true);
          }

          // Restore saved workflow step from localStorage
          const savedStep = localStorage.getItem('archme_workflow_step') as WorkflowStep | null;
          if (savedStep) setWorkflowStep(savedStep);

          return;
        } catch (error) {
          localStorage.removeItem('archme_workflow_session_id');
          localStorage.removeItem('archme_workflow_step');
        }
      }
      
      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      localStorage.setItem('archme_workflow_session_id', session.id);
      
      await apiRequest('PATCH', `/api/sessions/${session.id}`, {
        activeModule: 'archme'
      });
      
      await apiRequest('POST', `/api/sessions/${session.id}/messages/system`, { 
        message: 'Welcome to ArchMe! Describe your architecture requirements in natural language, and I\'ll generate a visual diagram for you. For example: "Deploy e-commerce microservices on Azure Kubernetes Service (AKS) with Azure Container Registry (ACR), Key Vault, Storage Accounts, and monitoring with Prometheus and Grafana."' 
      });
    };

    initializeSession();
  }, []);

  // Persist workflow step to localStorage for restore on refresh
  useEffect(() => {
    if (sessionId && workflowStep) {
      localStorage.setItem('archme_workflow_step', workflowStep);
    }
  }, [workflowStep, sessionId]);

  // Fetch messages
  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: ['/api/sessions', sessionId, 'messages'],
    enabled: !!sessionId,
    refetchInterval: 2000,
  });

  // Keep generated files in session storage synced for code preview updates
  const { data: sessionFiles = [] } = useQuery<GeneratedFile[]>({
    queryKey: ['/api/sessions', sessionId, 'files'],
    enabled: !!sessionId && workflowStep === 'code',
    refetchOnMount: true,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const { data: config } = useSecretsConfig();

  useEffect(() => {
    if (workflowStep !== "code" || sessionFiles.length === 0) {
      return;
    }

    setGeneratedCode((prev) => {
      if (prev.length === 0) {
        return sessionFiles.map((file) => ({
          componentName: file.fileName,
          codeType: inferCodeType(file.fileName),
          fileName: file.fileName,
          content: file.content,
          description: "",
          dependencies: [],
        }));
      }

      let hasChanges = false;
      const prevMap = new Map(prev.map((code) => [code.fileName, code]));
      const updatedCodes = prev.map((code) => {
        const storedFile = sessionFiles.find((file) => file.fileName === code.fileName);
        if (storedFile && storedFile.content !== code.content) {
          hasChanges = true;
          return { ...code, content: storedFile.content };
        }
        return code;
      });

      const newCodes: GeneratedCode[] = [];
      sessionFiles.forEach((file) => {
        if (!prevMap.has(file.fileName)) {
          hasChanges = true;
          newCodes.push({
            componentName: file.fileName,
            codeType: inferCodeType(file.fileName),
            fileName: file.fileName,
            content: file.content,
            description: "",
            dependencies: [],
          });
        }
      });

      if (!hasChanges) {
        return prev;
      }

      return newCodes.length > 0 ? [...updatedCodes, ...newCodes] : updatedCodes;
    });
  }, [sessionFiles, workflowStep]);

  // Fetch repositories
  const { data: repositories = [], error: reposError } = useQuery({
    queryKey: ['/api/repositories', provider],
    enabled: !!provider,
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/repositories/${provider}`);
      
      // Check content type before parsing
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        // If it's HTML, throw a meaningful error
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
          throw new Error('Server returned HTML instead of JSON. Please check the server logs.');
        }
        throw new Error(`Unexpected content type: ${contentType}`);
      }
      
      return res.json();
    }
  });

  // Handle repository fetch errors
  useEffect(() => {
    if (!provider || workflowStep !== 'repository' || !reposError) {
      return;
    }

    const errorMsg = (reposError as any).message || "Failed to fetch repositories";
    const cleanMsg = errorMsg
      .replace(/^\d+:\s*/, '')
      .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
      .substring(0, 200);
    toast({
      title: "Failed to Load Repositories",
      description: cleanMsg,
      variant: "destructive"
    });
  }, [reposError, provider, workflowStep, toast]);

  // Analyze architecture requirements mutation
  const analyzeMutation = useMutation({
    mutationFn: async (requirements: string) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/analyze-architecture`, {
        requirements: requirements,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Analysis Complete",
        description: "Architecture diagram is being generated...",
      });
      generateDiagramFromAnalysis();
    },
    onError: (error: any) => {
      setIsAnalyzing(false);
      console.error('Failed to analyze architecture:', error);
      toast({
        title: "Analysis Failed",
        description: error.message || "Failed to analyze architecture requirements. Please try again.",
        variant: "destructive"
      });
    }
  });

  // Generate diagram from analysis
  const generateDiagramFromAnalysis = async () => {
    setIsAnalyzing(true);
    setDiagramGenerated(false); // Reset diagram generated state
    
    // Trigger diagram display via the component's internal logic
    // This calls the same backend endpoint but handles the state correctly
    if (diagramRef.current) {
      setTimeout(() => {
        diagramRef.current?.triggerGenerate();
      }, 500);
    } else {
      console.warn("⚠️ diagramRef not ready yet, diagram might not start generating");
      setIsAnalyzing(false);
    }
  };

  // Approve diagram
  const handleApproveDiagram = () => {
    setDiagramApproved(true);
    setWorkflowStep('repository');
    toast({
      title: "Diagram Approved",
      description: "Diagram locked. Proceeding to repository selection.",
    });
    if (pendingIntent) {
      setIntentPreviewVisible(true);
      setConfirmedLayers([]);
    }
  };

  // Handle provider selection
  const handleProviderSelect = (selectedProvider: Provider) => {
    setProvider(selectedProvider);
    setRepoValidationStatus(null);
    toast({
      title: "Provider Selected",
      description: `Selected ${selectedProvider === 'github' ? 'GitHub' : 'Azure DevOps'}`,
    });
  };

  // Handle repository selection
  const handleRepoSelect = async (repoId: string) => {
    if (!sessionId || !provider) {
      toast({
        title: "Provider missing",
        description: "Please select GitHub or Azure DevOps first.",
        variant: "destructive",
      });
      return;
    }

    setRepoValidationStatus(null);

    const repo = repositories.find((item: any) => item.id === repoId);
    if (!repo) {
      toast({
        title: "Repository not found",
        description: "Unable to locate the selected repository.",
        variant: "destructive",
      });
      return;
    }

    const repoName = repo.fullName || repo.name;
    if (!repoName) {
      toast({
        title: "Repository name unavailable",
        description: "The selected repository lacks a valid name.",
        variant: "destructive",
      });
      return;
    }

    try {
      const response = await apiRequest("POST", `/api/sessions/${sessionId}/validate-empty-repo`, {
        provider,
        repositoryName: repoName,
        branch: repo.branch || "main",
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.details || result?.error || "Failed to validate repository");
      }

      setRepoValidationStatus({ isEmpty: result.isEmpty, fileCount: result.fileCount || 0 });

      if (!result.isEmpty) {
        toast({
          title: "Repository is not empty",
          description: "Please create a new empty repository or choose an empty repository before proceeding.",
          variant: "destructive",
        });
        return;
      }
    } catch (error: any) {
      toast({
        title: "Validation failed",
        description: error?.message || "Unable to verify repository status",
        variant: "destructive",
      });
      return;
    }

      setSelectedRepo(repoId);
      setSelectedRepoName(repoName);
    toast({
      title: "Repository Selected",
      description: "Repository is empty and ready. Extracting components from diagram...",
    });
    extractComponents();
  };

  // Create repository mutation
  const createRepoMutation = useMutation({
    mutationFn: async ({ name, description }: { name: string; description?: string }) => {
      if (!provider) throw new Error('Provider not selected');
      const res = await apiRequest('POST', `/api/repositories/${provider}`, { name, description });
      
      // Check content type before parsing
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        // If it's HTML, throw a meaningful error
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
          throw new Error('Server returned HTML instead of JSON. Please check the server logs.');
        }
        throw new Error(`Unexpected content type: ${contentType}`);
      }
      
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/repositories', provider] });
      setSelectedRepo(data.id || data.name);
      toast({
        title: "Repository Created",
        description: `Repository "${data.name}" created successfully!`,
      });
      extractComponents();
    },
    onError: (error: any) => {
      const errorMsg = error.message || "Failed to create repository";
      // Remove HTML/status code prefixes for cleaner error messages
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

  // Extract components mutation
  const extractComponentsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/extract-components`);
      
      // Check content type before parsing
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        // If it's HTML, throw a meaningful error
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
          throw new Error('Server returned HTML instead of JSON. Please check the server logs.');
        }
        throw new Error(`Unexpected content type: ${contentType}`);
      }
      
      return res.json();
    },
    onSuccess: (data) => {
      setExtractedComponents(data.components || []);
      setWorkflowStep('components');
      toast({
        title: "Components Extracted",
        description: `Found ${data.components?.length || 0} components`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Extraction Failed",
        description: error.message || "Failed to extract components",
        variant: "destructive"
      });
    }
  });

  const extractComponents = () => {
    extractComponentsMutation.mutate();
  };

  // Generate code mutation
  const generateCodeMutation = useMutation({
    mutationFn: async () => {
      if (!provider) throw new Error('Provider not selected');
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/generate-component-code`, {
        components: extractedComponents,
        repositoryType: provider
      });
      
      // Check content type before parsing
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        // If it's HTML, throw a meaningful error
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
          throw new Error('Server returned HTML instead of JSON. Please check the server logs.');
        }
        throw new Error(`Unexpected content type: ${contentType}`);
      }
      
      return res.json();
    },
    onSuccess: async (data) => {
      setGeneratedCode(data.code || []);
      setWorkflowStep('code');
      toast({
        title: "Code Generated",
        description: `Generated code for ${data.code?.length || 0} components`,
      });
      
      // Generate README automatically, but scan is now manual
      await generateReadmeForCode(data.code || []);
      // Clear previous scan results when new code is generated
      setScanResult(null);
      setSelectedChecks(new Set());
      setFixedChecks([]);
    },
    onError: (error: any) => {
      toast({
        title: "Generation Failed",
        description: error.message || "Failed to generate code",
        variant: "destructive"
      });
    }
  });

  const handleGenerateCode = () => {
    generateCodeMutation.mutate();
  };

  // Generate README mutation
  const generateReadmeMutation = useMutation({
    mutationFn: async (code: GeneratedCode[]) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/generate-archme-readme`, {
        code
      });
      
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
    onSuccess: (data) => {
      setReadmeContent(data.readme);
    },
    onError: (error: any) => {
      console.error('Failed to generate README:', error);
    }
  });

  const generateReadmeForCode = async (code: GeneratedCode[]) => {
    generateReadmeMutation.mutate(code);
  };

  // Commit code mutation
  const commitMutation = useMutation({
    mutationFn: async () => {
      if (!provider || !selectedRepo) throw new Error('Provider or repository not selected');
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/commit-archme-code`, {
        provider,
        repoId: selectedRepo,
        code: generatedCode,
        message: commitMessage
      });
      
      // Check content type before parsing
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        // If it's HTML, throw a meaningful error
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
          throw new Error('Server returned HTML instead of JSON. Please check the server logs.');
        }
        throw new Error(`Unexpected content type: ${contentType}`);
      }
      
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Code Committed",
        description: `Successfully committed ${generatedCode.length} file(s) to repository`,
      });
      setTimeout(() => {
        setLocation('/');
      }, 2000);
    },
    onError: (error: any) => {
      toast({
        title: "Commit Failed",
        description: error.message || "Failed to commit code",
        variant: "destructive"
      });
    }
  });

  // Chat mutation
  const chatMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await apiRequest('POST', `/api/sessions/${sessionId}/chat`, {
        message: message,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'messages'] });
    },
    onError: (error: any) => {
      console.error('Chat error:', error);
      toast({
        title: "Error",
        description: error.message || "Failed to send message. Please try again.",
        variant: "destructive"
      });
    }
  });

  const handleRequirementsSubmit = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;

    const validation = evaluateArchitectureIntent(trimmed);
    setValidationResult(validation);
    if (!validation.isValid) {
      setValidationError(validation.reason || "Please focus on architecture requirements.");
      return;
    }
    setValidationError(null);

    const suggestions = detectArtifactLayers(trimmed);
    const defaultSelections = new Set<ArtifactLayerId>();
    suggestions.forEach((layer) => {
      if (layer.detected || layer.defaultActive) {
        defaultSelections.add(layer.id);
      }
    });
    if (!defaultSelections.size) {
      defaultSelections.add('terraform');
    }

    setPendingIntent(trimmed);
    setIntentLayerSuggestions(suggestions);
    setSelectedIntentLayers(defaultSelections);

    setRequirements(trimmed);
    setIsAnalyzing(true);
    setWorkflowStep('diagram');
    setDiagramApproved(false);
    setDiagramGenerated(false);

    chatMutation.mutate(trimmed, {
      onSuccess: () => {
        analyzeMutation.mutate(trimmed);
      },
      onError: () => {
        // Still attempt analysis even if chat save fails
        analyzeMutation.mutate(trimmed);
      }
    });
  };

  const handleLayerToggle = (layerId: ArtifactLayerId, checked?: boolean) => {
    setSelectedIntentLayers((prev) => {
      const next = new Set(prev);
      const enable = typeof checked === "boolean" ? checked : !next.has(layerId);
      if (enable) {
        next.add(layerId);
        return next;
      }
      if (next.size === 1) {
        return prev;
      }
      next.delete(layerId);
      return next;
    });
  };

  const handleCancelIntentPreview = () => {
    setIntentPreviewVisible(false);
    setPendingIntent('');
    setIntentLayerSuggestions([]);
    setSelectedIntentLayers(new Set());
    setConfirmedLayers([]);
    setWorkflowStep('diagram');
    setDiagramApproved(false);
    setDiagramGenerated(false);
  };

  const handleConfirmIntentGeneration = () => {
    if (!pendingIntent) return;
    const confirmed = Array.from(selectedIntentLayers);
    setIntentPreviewVisible(false);
    setIntentLayerSuggestions([]);
    setSelectedIntentLayers(new Set());
    setPendingIntent('');
    setConfirmedLayers(confirmed);
  };

  const handleRefresh = async () => {
    try {
      localStorage.removeItem('archme_workflow_session_id');
      localStorage.removeItem('archme_workflow_step');
      setRequirements('');
      setIsAnalyzing(false);
      setSessionId('');
      setWorkflowStep('diagram');
      setDiagramApproved(false);
      setDiagramGenerated(false);
      setProvider(null);
      setSelectedRepo('');
      setSelectedRepoName('');
      setValidationResult(null);
      setValidationError(null);
      setExtractedComponents([]);
      setGeneratedCode([]);
      setValidationResult(null);
      setValidationError(null);
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions'] });
      
      setPendingIntent('');
      setIntentPreviewVisible(false);
      setIntentLayerSuggestions([]);
      setSelectedIntentLayers(new Set());
      setConfirmedLayers([]);

      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      localStorage.setItem('archme_workflow_session_id', session.id);

      await apiRequest('PATCH', `/api/sessions/${session.id}`, {
        activeModule: 'archme'
      });

      await apiRequest('POST', `/api/sessions/${session.id}/messages/system`, { 
        message: 'Welcome to ArchMe! Describe your architecture requirements in natural language, and I\'ll generate a visual diagram for you. For example: "Deploy e-commerce microservices on Azure Kubernetes Service (AKS) with Azure Container Registry (ACR), Key Vault, Storage Accounts, and monitoring with Prometheus and Grafana."' 
      });
      
      queryClient.invalidateQueries({ queryKey: ['/api/sessions', session.id, 'messages'] });
      
      toast({
        title: "Refreshed",
        description: "Started a new session. You can now enter new architecture requirements.",
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

  const handleGoHome = () => {
    setLocation('/');
  };

  const toggleComponent = (componentName: string) => {
    const newExpanded = new Set(expandedComponents);
    if (newExpanded.has(componentName)) {
      newExpanded.delete(componentName);
    } else {
      newExpanded.add(componentName);
    }
    setExpandedComponents(newExpanded);
  };

  const confirmedLayerSummary = confirmedLayers.length
    ? confirmedLayers.map((layerId) => getLayerSummaryLabel(layerId)).join(", ")
    : "";

  return (
    <div className="min-h-screen bg-white">
      <Header />
      
      <main className="container mx-auto px-4 py-6 max-w-7xl">
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Network className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold">ArchMe</h1>
                <p className="text-muted-foreground">
                  Generate architecture diagrams and infrastructure code
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isAnalyzing || analyzeMutation.isPending}
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

        <div className="mb-6">
          <Card className="border border-amber-200 bg-amber-50 text-muted-foreground">
            <CardContent className="space-y-2">
              <p className="text-sm font-semibold text-amber-700">Architecture-only workflow</p>
              <p className="text-xs">
                ArchMe always creates a brand-new repository from scratch, and it only produces architecture diagrams and high-level explanations—not Terraform, Docker, automation scripts, or ScoreMe reports.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Workflow Steps */}
        {workflowStep === 'diagram' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Chat Panel */}
            <Card className="flex flex-col">
              <CardHeader>
                <CardTitle>Describe Your Architecture</CardTitle>
                <CardDescription>
                  Enter your architecture requirements in natural language
                </CardDescription>
              </CardHeader>
            {validationError && (
              <div className="p-4">
                <Alert variant="destructive">
                  <AlertTitle>Input rejected</AlertTitle>
                  <AlertDescription>{validationError}</AlertDescription>
                </Alert>
              </div>
            )}
            {validationResult && !validationError && (
              <div className="border-b border-border/60 bg-slate-50 px-4 pb-4 pt-2">
                <p className="text-xs text-muted-foreground mb-1">Detected architecture keywords</p>
                <p className="text-sm text-slate-900">
                  {validationResult.keywords.length > 0
                    ? validationResult.keywords.join(", ")
                    : "Unable to detect architecture keywords yet."}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Length: {validationResult.length} characters
                </p>
              </div>
            )}
              <CardContent className="flex-1 flex flex-col">
                <ScrollArea className="flex-1 pr-4 mb-4">
                  <div className="space-y-4">
                    {messages.map((msg) => {
                      if (msg.type === 'system') {
                        return <AIMessage key={msg.id} message={msg.content} />;
                      } else if (msg.type === 'user') {
                        return <UserMessage key={msg.id} message={msg.content} />;
                      } else if (msg.type === 'ai') {
                        return <AIMessage key={msg.id} message={msg.content} />;
                      }
                      return null;
                    })}
                    
                    {isAnalyzing && (
                      <div className="flex gap-3 mb-4 max-w-2xl">
                        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                          <Loader2 className="w-4 h-4 text-primary-foreground animate-spin" />
                        </div>
                        <div className="bg-card border border-card-border rounded-2xl p-4 flex-1">
                          <p className="text-base text-card-foreground">
                            Analyzing your architecture requirements and generating diagram...
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </ScrollArea>
                
                
                <ChatInput
                  onSend={handleRequirementsSubmit}
                  placeholder="Describe your architecture requirements..."
                  disabled={isAnalyzing || analyzeMutation.isPending}
                />
              </CardContent>
            </Card>

            {/* Diagram Panel */}
            <Card className="flex flex-col">
              <CardHeader>
                <CardTitle>Architecture Diagram</CardTitle>
                <CardDescription>
                  Visual representation of your architecture
                  {confirmedLayerSummary && (
                    <span className="block text-xs text-muted-foreground mt-1">
                      Generating: {confirmedLayerSummary}
                    </span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                {sessionId ? (
                  <>
                    <ArchitectureDiagram
                      ref={diagramRef}
                      sessionId={sessionId}
                      useArchMeEndpoint={true}
                      onDiagramStart={() => {
                        setIsAnalyzing(true);
                        setDiagramGenerated(false);
                      }}
                      onDiagramComplete={() => {
                        setIsAnalyzing(false);
                        setDiagramGenerated(true);
                      }}
                    />
                    {!isAnalyzing && diagramGenerated && (
                      <div className="mt-4">
                        <Button
                          onClick={handleApproveDiagram}
                          className="w-full"
                          size="lg"
                        >
                          <CheckCircle2 className="w-4 h-4 mr-2" />
                          Approve Diagram & Continue
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex items-center justify-center h-full min-h-[400px] text-muted-foreground">
                    <div className="text-center">
                      <Network className="w-12 h-12 mx-auto mb-4 opacity-50" />
                      <p>Enter your architecture requirements to generate a diagram</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Repository Selection */}
        {workflowStep === 'repository' && (
          <Card>
            <CardHeader>
              <CardTitle>Select Repository</CardTitle>
              <CardDescription>
                Choose where to push the generated infrastructure code
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {!provider && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                  {config?.hasGithub && (
                    <Card
                      className="cursor-pointer hover:shadow-lg transition-all border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/50"
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
                        <CardDescription className="text-green-700 dark:text-green-300">Push to GitHub repository</CardDescription>
                      </CardContent>
                    </Card>
                  )}
                  {config?.hasAzureDevOps && (
                    <Card
                      className="cursor-pointer hover:shadow-lg transition-all border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/50"
                      onClick={() => handleProviderSelect('azure')}
                    >
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-blue-900 dark:text-blue-100">
                          <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400">
                            <Cloud className="w-4 h-4" />
                          </div>
                          Azure DevOps
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <CardDescription className="text-blue-700 dark:text-blue-300">Push to Azure DevOps repository</CardDescription>
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
              )}

              {provider && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <RepositoryList
                    showSearch={provider === 'github'}
                    repositories={repositories}
                    selectedId={selectedRepo}
                    onSelect={handleRepoSelect}
                  />
                  <CreateRepoForm
                    onSubmit={(name, description) => createRepoMutation.mutate({ name, description })}
                    loading={createRepoMutation.isPending}
                  />
                </div>
              )}
              {repoValidationStatus && (
                <Card className="mt-4 border-dashed border-primary/40 bg-primary/5">
                  <CardHeader>
                    <CardTitle className="text-sm uppercase tracking-[0.3em]">Repository verification</CardTitle>
                    <CardDescription className="text-xs">
                      ArchMe only allows new or empty repositories. This repo passed the emptiness check.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-1 text-sm">
                    <p className="font-semibold text-slate-900">
                      {repoValidationStatus.isEmpty ? "Empty repository" : "Repository contains files"}
                    </p>
                    <p className="text-muted-foreground">
                      File count: {repoValidationStatus.fileCount}
                    </p>
                    {!repoValidationStatus.isEmpty && (
                      <p className="text-xs text-rose-500">
                        Please select a new empty repository or delete existing files before continuing.
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}
            </CardContent>
          </Card>
        )}

        {/* Components List */}
        {workflowStep === 'components' && diagramApproved && intentPreviewVisible && pendingIntent && (
          <Card className="mb-4 border-blue-200 bg-blue-50/40">
            <CardHeader>
              <CardTitle>Intent preview</CardTitle>
              <CardDescription>
                Confirm what layers of code ArchMe will produce before generating component-level artifacts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Your request: <span className="text-slate-900 font-medium">{pendingIntent}</span>
              </p>
              <p className="text-sm text-slate-900 font-semibold">This request will generate:</p>
              <div className="space-y-3">
                {intentLayerSuggestions.map((layer) => (
                  <div key={layer.id} className="flex gap-3">
                    <UICheckbox
                      id={`intent-layer-${layer.id}`}
                      checked={selectedIntentLayers.has(layer.id)}
                      onCheckedChange={(checked) => handleLayerToggle(layer.id, checked === true)}
                    />
                    <div className="flex-1 text-sm">
                      <label htmlFor={`intent-layer-${layer.id}`} className="font-semibold">
                        {layer.title}
                      </label>
                      <p className="text-xs text-muted-foreground">{layer.description}</p>
                      <p className="text-xs text-muted-foreground">
                        {layer.detected
                          ? `Detected keywords: ${layer.matchedKeywords.join(", ")}`
                          : "Optional layer — enable it if you want this artifact."}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCancelIntentPreview}
                  disabled={isAnalyzing || analyzeMutation.isPending}
                >
                  Edit Intent
                </Button>
                <Button
                  size="sm"
                  onClick={handleConfirmIntentGeneration}
                  disabled={
                    isAnalyzing ||
                    analyzeMutation.isPending ||
                    selectedIntentLayers.size === 0
                  }
                >
                  Confirm & Continue
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
        {workflowStep === 'components' && (
          <Card>
            <CardHeader>
              <CardTitle>Extracted Components</CardTitle>
              <CardDescription>
                {extractedComponents.length} components found in your architecture
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 mb-6">
                {extractedComponents.map((component) => (
                  <Card key={component.name} className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <h3 className="font-semibold">{component.name}</h3>
                          <Badge variant="outline">{component.provider}</Badge>
                          <Badge variant="secondary">{component.category}</Badge>
                          <Badge>{component.codeType}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground mb-2">{component.description}</p>
                        {component.dependencies.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            Depends on: {component.dependencies.join(', ')}
                          </p>
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
              <Button
                onClick={handleGenerateCode}
                className="w-full"
                size="lg"
                disabled={generateCodeMutation.isPending}
              >
                {generateCodeMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Generating Code...
                  </>
                ) : (
                  <>
                    <Code className="w-4 h-4 mr-2" />
                    Generate Code for All Components
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Generated Code - Matches Terraform workflow layout */}
        {workflowStep === 'code' && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-bold mb-2">Review & Activities</h2>
              <p className="text-muted-foreground">
                Review generated code, run security scans, and analyze costs before committing
              </p>
            </div>

            {/* Code Editor - matching Terraform card style */}
            <div className="rounded-lg border bg-card">
              <div className="px-4 py-3 border-b bg-muted/50">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <FileCode className="w-4 h-4" />
                  Generated Code
                </h3>
              </div>
              {generatedCode.length > 0 ? (
                <CodeEditor
                  files={generatedCode.map(f => ({
                    name: f.fileName,
                    content: f.content
                  }))}
                  onFileChange={async (fileName, content) => {
                    setGeneratedCode(prev =>
                      prev.map(code =>
                        code.fileName === fileName
                          ? { ...code, content }
                          : code
                      )
                    );
                    try {
                      await apiRequest('POST', `/api/sessions/${sessionId}/files`, {
                        fileName,
                        content
                      });
                      queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                    } catch (error: any) {
                      console.error('Failed to save file:', error);
                      toast({
                        title: "Failed to save changes",
                        description: error.message || "Could not save file to session",
                        variant: "destructive"
                      });
                    }
                  }}
                />
              ) : (
                <div className="p-8 text-center text-muted-foreground">
                  <FileCode className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No files generated yet</p>
                </div>
              )}
            </div>

            {/* Activity Panel - Below code editor (same pattern as Terraform) */}
            <ActivityPanel
              sessionId={sessionId}
              workflowType="archme"
              checkovFramework={generatedCode.some(c => c.codeType === 'kubernetes' || c.codeType === 'yaml') ? 'kubernetes' : 'terraform'}
              onScanComplete={() => {
                queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                toast({
                  title: "Scan Complete",
                  description: "Security scan completed successfully.",
                });
              }}
              onFixesApproved={() => {
                queryClient.invalidateQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                queryClient.refetchQueries({ queryKey: ['/api/sessions', sessionId, 'files'] });
                toast({
                  title: "Fixes Applied",
                  description: "Security fixes have been applied. Code editor updated.",
                });
              }}
            />

            {/* README Preview */}
            {readmeContent && (
              <Card className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold">README.md</h3>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowReadme(!showReadme)}
                  >
                    {showReadme ? 'Hide' : 'Show'} README
                  </Button>
                </div>
                {showReadme && (
                  <div className="mt-3 bg-muted rounded-lg p-4 max-h-64 overflow-y-auto">
                    <pre className="text-xs whitespace-pre-wrap">{readmeContent}</pre>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-2">
                  README.md will be automatically included in the commit
                </p>
              </Card>
            )}

            {/* Commit Section */}
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Commit Message</label>
                <Textarea
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="Enter commit message..."
                  rows={3}
                />
              </div>
              <Button
                onClick={() => commitMutation.mutate()}
                className="w-full"
                size="lg"
                disabled={commitMutation.isPending || !commitMessage.trim()}
              >
                {commitMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Committing...
                  </>
                ) : (
                  <>
                    <GitBranch className="w-4 h-4 mr-2" />
                    Commit & Push to Repository
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
