import { Buffer } from "buffer";
import { ScoreMeReport } from "@shared/schema";
import { bitwardenService } from "./bitwarden-service";
import { runCheckovOnFiles, CheckovRunResult } from "./scoreme/checkov-runner";
import { fetch } from "undici";
import { mcpClient } from "../mcp-client";
import { aiChatCompletion } from '../utils/ai-client.js';
import { z } from 'zod';
import { sanitizeField, sanitizeContent } from '../utils/sanitize-prompt.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ScoreMe');

// ─── Zod schemas for AI response validation ─────────────────────────────────

const aiFileAnalysisSchema = z.object({
  description: z.string().catch('No description available'),
  resources: z.array(z.string()).catch([]),
});

const aiPillarSchema = z.object({
  name: z.string(),
  score: z.number().min(0).max(100),
  weight: z.number().min(0).max(1),
  details: z.array(z.string()).catch([]),
});
const aiScoringResponseSchema = z.object({
  pillars: z.array(aiPillarSchema).length(4).catch([]),
  confidence: z.string().catch('Not recommended'),
});

export interface ScoreMeRequest {
  provider: "github" | "azure";
  repositoryId: string;
  repositoryName: string;
  repositoryFullName?: string;
  branch?: string;
}

type InventoryCategory = "terraform" | "kubernetes" | "helm" | "automation" | "bicep" | "arm" | "dockerfile" | "docker-compose" | "cicd";

// Kubernetes-specific path/filename patterns to distinguish from generic YAML
const K8S_PATH_PATTERNS = [
  /k8s\//i, /kubernetes\//i, /manifests?\//i, /deploy(ments?)?\//i,
  /helm\//i, /charts?\//i, /kube\//i, /\.k8s\./i,
];
const K8S_FILENAME_PATTERNS = [
  /deployment\.ya?ml$/i, /service\.ya?ml$/i, /ingress\.ya?ml$/i,
  /configmap\.ya?ml$/i, /secret\.ya?ml$/i, /pod\.ya?ml$/i,
  /statefulset\.ya?ml$/i, /daemonset\.ya?ml$/i, /job\.ya?ml$/i,
  /cronjob\.ya?ml$/i, /namespace\.ya?ml$/i, /pvc?\.ya?ml$/i,
  /hpa\.ya?ml$/i, /networkpolicy\.ya?ml$/i, /role\.ya?ml$/i,
  /rolebinding\.ya?ml$/i, /serviceaccount\.ya?ml$/i,
];
// Paths to exclude from Kubernetes detection (CI/CD, configs, etc.)
const NON_K8S_YAML_PATHS = [
  /\.github\//i, /\.gitlab/i, /\.azure-pipelines/i, /\.circleci/i,
  /\.drone/i, /\.travis/i, /codecov/i, /\.pre-commit/i,
  /mkdocs/i, /\.readthedocs/i, /\.vscode/i, /\.idea/i,
];

const FILE_TYPES: Record<InventoryCategory, (path: string) => boolean> = {
  terraform: (path: string) => path.endsWith(".tf") || path.endsWith(".tf.json"),

  // Smarter Kubernetes detection: must be in k8s-related path OR have k8s-specific filename
  kubernetes: (path: string) => {
    if (!(path.endsWith(".yaml") || path.endsWith(".yml"))) return false;
    // Exclude CI/CD and config YAML
    if (NON_K8S_YAML_PATHS.some(p => p.test(path))) return false;
    // Match k8s paths or filenames
    return K8S_PATH_PATTERNS.some(p => p.test(path)) || K8S_FILENAME_PATTERNS.some(p => p.test(path));
  },

  helm: (path: string) => {
    const lower = path.toLowerCase();
    return lower.endsWith("chart.yaml") || lower.endsWith("values.yaml") ||
      (lower.includes("/templates/") && (lower.endsWith(".yaml") || lower.endsWith(".yml")));
  },

  dockerfile: (path: string) => {
    const filename = path.split("/").pop()?.toLowerCase() || "";
    return filename === "dockerfile" || filename.startsWith("dockerfile.");
  },

  "docker-compose": (path: string) => {
    const filename = path.split("/").pop()?.toLowerCase() || "";
    return filename.startsWith("docker-compose") || filename.startsWith("compose.");
  },

  automation: (path: string) => path.endsWith(".sh") || path.endsWith(".ps1") || path.endsWith(".py"),

  bicep: (path: string) => path.endsWith(".bicep"),

  // ARM templates: various naming conventions
  arm: (path: string) => {
    const lower = path.toLowerCase();
    const filename = lower.split("/").pop() || "";
    return lower.endsWith(".arm.json") ||
      filename === "azuredeploy.json" ||
      filename === "maintemplate.json" ||
      filename.startsWith("arm-") ||
      /deploy[^/]*\.json$/i.test(lower) ||
      /template\.json$/i.test(lower);
  },

  // CI/CD pipeline configuration files
  cicd: (path: string) => {
    const lower = path.toLowerCase();
    const filename = lower.split("/").pop() || "";
    return (
      // GitHub Actions
      lower.includes(".github/workflows/") && (lower.endsWith(".yml") || lower.endsWith(".yaml")) ||
      // Azure Pipelines
      filename === "azure-pipelines.yml" || filename === "azure-pipelines.yaml" ||
      lower.includes(".azure-pipelines/") ||
      // GitLab CI
      filename === ".gitlab-ci.yml" || lower.includes(".gitlab/ci/") ||
      // CircleCI
      lower.includes(".circleci/") && filename === "config.yml" ||
      // Jenkins
      filename === "jenkinsfile" || filename.startsWith("jenkinsfile.") ||
      // Drone CI
      filename === ".drone.yml" ||
      // Travis CI
      filename === ".travis.yml" ||
      // Bitbucket Pipelines
      filename === "bitbucket-pipelines.yml" ||
      // Argo CD / Flux CD
      lower.includes("argocd/") || lower.includes("fluxcd/") ||
      // Tekton
      lower.includes("tekton/") && (lower.endsWith(".yaml") || lower.endsWith(".yml"))
    );
  },
};

// Application code indicators (non-DevOps files)
const APP_CODE_PATTERNS: Array<(path: string) => boolean> = [
  // Node.js / JavaScript / TypeScript
  (p) => p === "package.json" || p.endsWith("/package.json"),
  (p) => p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".ts") || p.endsWith(".tsx"),
  (p) => p.includes("node_modules/"),
  // Python applications (not scripts)
  (p) => p === "requirements.txt" || p.endsWith("/requirements.txt"),
  (p) => p === "setup.py" || p.endsWith("/setup.py"),
  (p) => p === "pyproject.toml" || p.endsWith("/pyproject.toml"),
  // Java
  (p) => p === "pom.xml" || p.endsWith("/pom.xml"),
  (p) => p === "build.gradle" || p.endsWith("/build.gradle"),
  (p) => p.endsWith(".java"),
  // .NET / C#
  (p) => p.endsWith(".csproj") || p.endsWith(".sln") || p.endsWith(".cs"),
  // Go
  (p) => p === "go.mod" || p.endsWith("/go.mod"),
  (p) => p.endsWith(".go"),
  // Ruby
  (p) => p === "Gemfile" || p.endsWith("/Gemfile"),
  (p) => p.endsWith(".rb"),
  // PHP
  (p) => p === "composer.json" || p.endsWith("/composer.json"),
  (p) => p.endsWith(".php"),
  // Rust
  (p) => p === "Cargo.toml" || p.endsWith("/Cargo.toml"),
  (p) => p.endsWith(".rs"),
];

function hasApplicationCode(tree: Array<{ path: string }>): boolean {
  return tree.some((entry) => APP_CODE_PATTERNS.some((pattern) => pattern(entry.path)));
}

/** Maximum files to analyze per IaC category.
 *  Override via SCOREME_MAX_FILES environment variable. */
const MAX_FILES = parseInt(process.env.SCOREME_MAX_FILES || '120', 10);

// ============ Content Analysis Functions ============

interface FileDetail {
  path: string;
  description: string;
  resources?: string[];
}

// ============ AI System Prompts ============

const AI_PROMPT_TERRAFORM = 'Analyze this Terraform file. Identify: resource types, providers, modules, variables, outputs, security concerns, and overall purpose. Return JSON: { "description": "1-2 sentence summary", "resources": ["list of resources/modules/providers found"], "quality": "brief quality assessment" }';

const AI_PROMPT_KUBERNETES = 'Analyze this Kubernetes manifest. Identify: resource kinds, names, namespaces, security posture (securityContext, runAsNonRoot, etc.), resource limits, probes, and overall purpose. Return JSON: { "description": "1-2 sentence summary", "resources": ["list of resource kind/name pairs"], "quality": "brief quality assessment" }';

const AI_PROMPT_HELM = 'Analyze this Helm chart file. Identify: chart metadata, dependencies, values structure, template patterns, and overall purpose. Return JSON: { "description": "1-2 sentence summary", "resources": ["list of chart components found"], "quality": "brief quality assessment" }';

const AI_PROMPT_SHELL = 'Analyze this shell script. Identify: purpose, tools used (docker/kubectl/terraform/etc), error handling quality, security concerns, and cloud provider interactions. Return JSON: { "description": "1-2 sentence summary", "resources": ["list of tools/commands used"], "quality": "brief quality assessment" }';

const AI_PROMPT_POWERSHELL = 'Analyze this PowerShell script. Identify: purpose, modules used, Azure/AWS cmdlets, parameter handling, error handling, and security concerns. Return JSON: { "description": "1-2 sentence summary", "resources": ["list of modules/cmdlets used"], "quality": "brief quality assessment" }';

const AI_PROMPT_PYTHON = 'Analyze this Python script. Identify: purpose, cloud SDKs used (boto3/azure/google), CLI patterns, infrastructure interactions, and security concerns. Return JSON: { "description": "1-2 sentence summary", "resources": ["list of SDKs/tools used"], "quality": "brief quality assessment" }';

const AI_PROMPT_BICEP = 'Analyze this Azure Bicep file. Identify: resource types, parameters, modules, outputs, and overall purpose. Return JSON: { "description": "1-2 sentence summary", "resources": ["list of Azure resource types found"], "quality": "brief quality assessment" }';

const AI_PROMPT_ARM = 'Analyze this ARM template JSON. Identify: resource types, parameters, variables, outputs, and overall purpose. Return JSON: { "description": "1-2 sentence summary", "resources": ["list of Azure resource types found"], "quality": "brief quality assessment" }';

/**
 * Helper: call OpenAI for file analysis with fallback
 */
async function aiAnalyzeFile(
  systemPrompt: string,
  path: string,
  content: string,
  fallbackLabel: string,
  fallbackFn: (path: string, content: string) => FileDetail
): Promise<FileDetail> {
  try {
    const completion = await aiChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: `File: ${sanitizeField(path)}\n\n${sanitizeContent(content.substring(0, 4000))}` },
      ],
    });
    const result = aiFileAnalysisSchema.safeParse(JSON.parse(completion.choices[0]?.message?.content || '{}'));
    if (!result.success) {
      log.warn('AI file analysis validation failed', { error: result.error.message });
      return fallbackFn(path, content);
    }
    return {
      path,
      description: result.data.description || fallbackLabel,
      resources: result.data.resources,
    };
  } catch {
    return fallbackFn(path, content);
  }
}

/**
 * Process files in batches of 5 using Promise.allSettled
 */
async function processInBatches<T>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<FileDetail>
): Promise<FileDetail[]> {
  const results: FileDetail[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(processor));
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      }
    }
  }
  return results;
}

/**
 * Helper to extract regex matches without using matchAll iterator
 */
function extractMatches(content: string, pattern: RegExp): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(pattern.source, pattern.flags);
  while ((match = regex.exec(content)) !== null) {
    results.push(match);
  }
  return results;
}

/**
 * Helper to get unique values from array
 */
function uniqueArray<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  return arr.filter(item => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

/**
 * Analyze Terraform file content to extract resources, providers, and modules (regex fallback)
 */
function analyzeTerraformFileFallback(path: string, content: string): FileDetail {
  const resources: string[] = [];

  // Extract resource blocks: resource "type" "name"
  const resourceMatches = extractMatches(content, /resource\s+"([^"]+)"\s+"([^"]+)"/g);
  resourceMatches.forEach(match => {
    resources.push(`resource: ${match[1]}.${match[2]}`);
  });

  // Extract data sources: data "type" "name"
  const dataMatches = extractMatches(content, /data\s+"([^"]+)"\s+"([^"]+)"/g);
  dataMatches.forEach(match => {
    resources.push(`data: ${match[1]}.${match[2]}`);
  });

  // Extract modules: module "name"
  const moduleMatches = extractMatches(content, /module\s+"([^"]+)"/g);
  moduleMatches.forEach(match => {
    resources.push(`module: ${match[1]}`);
  });

  // Extract providers: provider "name"
  const providerMatches = extractMatches(content, /provider\s+"([^"]+)"/g);
  providerMatches.forEach(match => {
    resources.push(`provider: ${match[1]}`);
  });

  // Extract variables
  const varCount = extractMatches(content, /variable\s+"[^"]+"/g).length;
  if (varCount > 0) {
    resources.push(`${varCount} variable(s)`);
  }

  // Extract outputs
  const outputCount = extractMatches(content, /output\s+"[^"]+"/g).length;
  if (outputCount > 0) {
    resources.push(`${outputCount} output(s)`);
  }

  // Build description
  let description = "";

  const resourceTypes = resources.filter(r => r.startsWith("resource:"));
  const modules = resources.filter(r => r.startsWith("module:"));
  const providers = resources.filter(r => r.startsWith("provider:"));

  if (providers.length > 0) {
    description = `Provider configuration for ${providers.map(p => p.replace("provider: ", "")).join(", ")}`;
  } else if (resourceTypes.length > 0) {
    const types = uniqueArray(resourceTypes.map(r => r.split(".")[0].replace("resource: ", "")));
    description = `Defines ${resourceTypes.length} resource(s): ${types.slice(0, 3).join(", ")}${types.length > 3 ? "..." : ""}`;
  } else if (modules.length > 0) {
    description = `Module references: ${modules.map(m => m.replace("module: ", "")).join(", ")}`;
  } else if (varCount > 0 || outputCount > 0) {
    description = `Variables/outputs file (${varCount} vars, ${outputCount} outputs)`;
  } else {
    description = `Terraform configuration file`;
  }

  return { path, description, resources };
}

/**
 * AI-powered Terraform file analysis
 */
async function analyzeTerraformFile(path: string, content: string): Promise<FileDetail> {
  return aiAnalyzeFile(AI_PROMPT_TERRAFORM, path, content, 'Terraform file', analyzeTerraformFileFallback);
}

/**
 * Analyze Kubernetes YAML file content to extract kind, name, namespace (regex fallback)
 */
function analyzeKubernetesFileFallback(path: string, content: string): FileDetail {
  const resources: string[] = [];

  // Parse YAML documents (handle multi-document YAML with ---)
  const docs = content.split(/^---$/m).filter(doc => doc.trim());

  for (const doc of docs) {
    // Extract kind
    const kindMatch = doc.match(/^kind:\s*(\S+)/m);
    const kind = kindMatch ? kindMatch[1] : null;

    // Extract metadata.name
    const nameMatch = doc.match(/name:\s*(\S+)/m);
    const name = nameMatch ? nameMatch[1] : "unnamed";

    // Extract metadata.namespace
    const nsMatch = doc.match(/namespace:\s*(\S+)/m);
    const namespace = nsMatch ? nsMatch[1] : null;

    if (kind) {
      const resourceId = namespace ? `${kind}/${name} (ns: ${namespace})` : `${kind}/${name}`;
      resources.push(resourceId);
    }
  }

  // Build description
  const filename = path.split("/").pop() || path;
  let description = "";

  if (resources.length === 0) {
    description = "Kubernetes configuration file";
  } else if (resources.length === 1) {
    description = resources[0];
  } else {
    const kinds = uniqueArray(resources.map(r => r.split("/")[0]));
    description = `${resources.length} resources: ${kinds.slice(0, 3).join(", ")}${kinds.length > 3 ? "..." : ""}`;
  }

  return { path, description, resources };
}

/**
 * AI-powered Kubernetes file analysis
 */
async function analyzeKubernetesFile(path: string, content: string): Promise<FileDetail> {
  return aiAnalyzeFile(AI_PROMPT_KUBERNETES, path, content, 'Kubernetes configuration file', analyzeKubernetesFileFallback);
}

/**
 * Analyze Helm chart files (regex fallback)
 */
function analyzeHelmFileFallback(path: string, content: string): FileDetail {
  const resources: string[] = [];
  const filename = path.split("/").pop()?.toLowerCase() || "";

  if (filename === "chart.yaml" || filename === "chart.yml") {
    // Parse Chart.yaml for chart metadata
    const nameMatch = content.match(/^name:\s*(\S+)/m);
    const versionMatch = content.match(/^version:\s*(\S+)/m);
    const descMatch = content.match(/^description:\s*(.+)$/m);

    const chartName = nameMatch ? nameMatch[1] : "unknown";
    const version = versionMatch ? versionMatch[1] : "unknown";

    resources.push(`Chart: ${chartName} v${version}`);

    // Check for dependencies
    if (content.includes("dependencies:")) {
      const depMatches = extractMatches(content, /- name:\s*(\S+)/g);
      depMatches.forEach(match => {
        resources.push(`dependency: ${match[1]}`);
      });
    }

    return {
      path,
      description: descMatch ? descMatch[1].trim() : `Helm chart: ${chartName}`,
      resources,
    };
  } else if (filename === "values.yaml" || filename === "values.yml") {
    // Count top-level keys as configuration sections
    const topKeys = content.match(/^[a-zA-Z_][a-zA-Z0-9_]*:/gm) || [];
    return {
      path,
      description: `Values file with ${topKeys.length} configuration section(s)`,
      resources: topKeys.map(k => k.replace(":", "")),
    };
  } else if (path.includes("/templates/")) {
    // Helm template - analyze like Kubernetes but note it's a template
    const detail = analyzeKubernetesFileFallback(path, content);
    detail.description = `Template: ${detail.description}`;
    return detail;
  }

  return { path, description: "Helm file", resources: [] };
}

/**
 * AI-powered Helm file analysis
 */
async function analyzeHelmFile(path: string, content: string): Promise<FileDetail> {
  return aiAnalyzeFile(AI_PROMPT_HELM, path, content, 'Helm file', analyzeHelmFileFallback);
}

/**
 * Analyze Shell script content (.sh files) (regex fallback)
 */
function analyzeShellScriptFallback(path: string, content: string): FileDetail {
  const resources: string[] = [];

  // Extract shebang
  const shebangMatch = content.match(/^#!(.+)$/m);
  if (shebangMatch) {
    const shell = shebangMatch[1].split('/').pop()?.split(' ')[0] || 'sh';
    resources.push(`shell: ${shell}`);
  }

  // Check error handling
  if (/set\s+-[euo]|set\s+-o\s+(pipefail|errexit|nounset)/.test(content)) {
    resources.push("error-handling: enabled");
  }

  // Extract functions
  const funcMatches = extractMatches(content, /^(?:function\s+)?(\w+)\s*\(\)\s*\{/gm);
  if (funcMatches.length > 0) {
    resources.push(`${funcMatches.length} function(s)`);
  }

  // Detect DevOps commands
  const devopsCommands = ['docker', 'kubectl', 'terraform', 'helm', 'aws', 'az', 'gcloud', 'ansible', 'packer', 'vault'];
  const foundCommands = devopsCommands.filter(cmd =>
    new RegExp(`\\b${cmd}\\b`).test(content)
  );
  foundCommands.forEach(cmd => resources.push(`uses: ${cmd}`));

  // Check for sourced files
  const sourceMatches = extractMatches(content, /(?:source|\.)\s+([^\s;]+)/gm);
  if (sourceMatches.length > 0) {
    resources.push(`sources: ${sourceMatches.length} file(s)`);
  }

  // Build description
  let description = "Shell script";
  if (foundCommands.length > 0) {
    description = `Shell script using ${foundCommands.slice(0, 3).join(", ")}`;
  } else if (funcMatches.length > 0) {
    description = `Shell script with ${funcMatches.length} function(s)`;
  }

  return { path, description, resources };
}

/**
 * AI-powered Shell script analysis
 */
async function analyzeShellScript(path: string, content: string): Promise<FileDetail> {
  return aiAnalyzeFile(AI_PROMPT_SHELL, path, content, 'Shell script', analyzeShellScriptFallback);
}

/**
 * Analyze PowerShell script content (.ps1 files) (regex fallback)
 */
function analyzePowerShellScriptFallback(path: string, content: string): FileDetail {
  const resources: string[] = [];

  // Extract module imports
  const moduleMatches = extractMatches(content, /Import-Module\s+([^\s;]+)/gi);
  moduleMatches.forEach(m => resources.push(`module: ${m[1]}`));

  // Extract functions
  const funcMatches = extractMatches(content, /function\s+([A-Za-z][\w-]*)/gi);
  if (funcMatches.length > 0) {
    resources.push(`${funcMatches.length} function(s)`);
  }

  // Detect Azure cmdlets
  if (/\bAz\.\w+|\bGet-Az\w+|\bNew-Az\w+|\bSet-Az\w+|\bInvoke-Az\w+/i.test(content)) {
    resources.push("uses: Azure");
  }

  // Detect AWS cmdlets
  if (/\bAWS\.\w+|\bGet-AWS\w+|\bNew-AWS\w+/i.test(content)) {
    resources.push("uses: AWS");
  }

  // Check for parameters
  if (/\[CmdletBinding\(\)\]|\[Parameter\(/i.test(content)) {
    resources.push("has-parameters");
  }

  // Detect error handling
  if (/\$ErrorActionPreference|\btry\s*\{|trap\s*\{/i.test(content)) {
    resources.push("error-handling: enabled");
  }

  // Build description
  let description = "PowerShell script";
  const modules = moduleMatches.map(m => m[1]);
  if (modules.length > 0) {
    description = `PowerShell with ${modules.slice(0, 2).join(", ")}`;
  } else if (resources.some(r => r === "uses: Azure")) {
    description = "PowerShell script for Azure";
  } else if (resources.some(r => r === "uses: AWS")) {
    description = "PowerShell script for AWS";
  }

  return { path, description, resources };
}

/**
 * AI-powered PowerShell script analysis
 */
async function analyzePowerShellScript(path: string, content: string): Promise<FileDetail> {
  return aiAnalyzeFile(AI_PROMPT_POWERSHELL, path, content, 'PowerShell script', analyzePowerShellScriptFallback);
}

/**
 * Analyze Python script content (.py files) (regex fallback)
 */
function analyzePythonScriptFallback(path: string, content: string): FileDetail {
  const resources: string[] = [];

  // Extract imports
  const importMatches = extractMatches(content, /^(?:from\s+(\S+)\s+)?import\s+(\S+)/gm);
  const imports = importMatches.map(m => (m[1] || m[2]).split('.')[0]);
  const uniqueImports = uniqueArray(imports);

  // Detect cloud SDKs
  if (uniqueImports.some(i => i === "boto3" || i === "botocore")) {
    resources.push("uses: AWS");
  }
  if (uniqueImports.some(i => i === "azure" || i.startsWith("azure"))) {
    resources.push("uses: Azure");
  }
  if (uniqueImports.some(i => i === "google" || i.startsWith("google"))) {
    resources.push("uses: GCP");
  }

  // Detect CLI patterns
  if (uniqueImports.some(i => ["argparse", "click", "typer", "fire"].includes(i))) {
    resources.push("cli-tool");
  }

  // Detect infrastructure libraries
  if (uniqueImports.some(i => i === "kubernetes" || i === "k8s")) {
    resources.push("uses: kubernetes");
  }
  if (uniqueImports.some(i => i === "docker")) {
    resources.push("uses: docker");
  }
  if (uniqueImports.some(i => i === "ansible")) {
    resources.push("uses: ansible");
  }

  // Check for subprocess usage
  if (/subprocess\.|os\.system|os\.popen/.test(content)) {
    resources.push("runs-commands");
  }

  // Check for main entry point
  if (/__name__\s*==\s*["']__main__["']/.test(content)) {
    resources.push("has-main");
  }

  // Build description
  const cloudUsage = resources.filter(r => r.startsWith("uses:"));
  let description = "Python script";
  if (cloudUsage.length > 0) {
    description = `Python script for ${cloudUsage.map(r => r.replace("uses: ", "")).join("/")}`;
  } else if (resources.includes("cli-tool")) {
    description = "Python CLI tool";
  } else if (resources.includes("runs-commands")) {
    description = "Python automation script";
  }

  return { path, description, resources };
}

/**
 * AI-powered Python script analysis
 */
async function analyzePythonScript(path: string, content: string): Promise<FileDetail> {
  return aiAnalyzeFile(AI_PROMPT_PYTHON, path, content, 'Python script', analyzePythonScriptFallback);
}

/**
 * Analyze Bicep file (AI with regex fallback)
 */
async function analyzeBicepFile(path: string, content: string): Promise<FileDetail> {
  return aiAnalyzeFile(AI_PROMPT_BICEP, path, content, 'Bicep file', (p, c) => {
    const resources: string[] = [];
    const matches = extractMatches(c, /resource\s+\w+\s+'([^']+)'/g);
    matches.forEach(m => resources.push(m[1]));
    const types = uniqueArray(resources);
    const description = types.length > 0
      ? `Bicep: ${types.slice(0, 3).join(', ')}${types.length > 3 ? '...' : ''}`
      : 'Bicep configuration';
    return { path: p, description, resources };
  });
}

/**
 * Analyze ARM template (AI with JSON-parse fallback)
 */
async function analyzeArmFile(path: string, content: string): Promise<FileDetail> {
  return aiAnalyzeFile(AI_PROMPT_ARM, path, content, 'ARM template', (p, c) => {
    const resources: string[] = [];
    try {
      const parsed = JSON.parse(c);
      if (Array.isArray(parsed.resources)) {
        parsed.resources.forEach((r: any) => { if (r.type) resources.push(r.type); });
      }
    } catch { /* not valid JSON */ }
    const types = uniqueArray(resources);
    const description = types.length > 0
      ? `ARM template: ${types.slice(0, 3).join(', ')}${types.length > 3 ? '...' : ''}`
      : 'ARM template';
    return { path: p, description, resources };
  });
}

/**
 * Analyze CI/CD pipeline file
 */
async function analyzeCicdFile(path: string, content: string): Promise<FileDetail> {
  const lower = path.toLowerCase();
  let platform = 'CI/CD';
  if (lower.includes('.github/workflows/')) platform = 'GitHub Actions';
  else if (lower.includes('azure-pipelines') || lower.includes('.azure-pipelines')) platform = 'Azure Pipelines';
  else if (lower.includes('.gitlab-ci') || lower.includes('.gitlab/ci/')) platform = 'GitLab CI';
  else if (lower.includes('.circleci/')) platform = 'CircleCI';
  else if (lower.includes('jenkinsfile')) platform = 'Jenkins';
  else if (lower.includes('.drone.yml')) platform = 'Drone CI';
  else if (lower.includes('.travis.yml')) platform = 'Travis CI';
  else if (lower.includes('bitbucket-pipelines')) platform = 'Bitbucket Pipelines';
  else if (lower.includes('argocd/')) platform = 'Argo CD';
  else if (lower.includes('fluxcd/')) platform = 'Flux CD';
  else if (lower.includes('tekton/')) platform = 'Tekton';

  const fallbackFn = (_p: string, _c: string): FileDetail => {
    const resources = [`platform: ${platform}`];
    const patterns = [
      { regex: /deploy/i, label: 'deployment' },
      { regex: /build/i, label: 'build' },
      { regex: /test/i, label: 'testing' },
      { regex: /lint/i, label: 'linting' },
      { regex: /scan|security|sast|dast|trivy|snyk|checkov/i, label: 'security-scan' },
      { regex: /docker|container|image/i, label: 'container-build' },
      { regex: /terraform|infra/i, label: 'infrastructure' },
      { regex: /kubectl|helm|k8s/i, label: 'kubernetes-deploy' },
    ];
    for (const p of patterns) {
      if (p.regex.test(_c)) resources.push(`stage: ${p.label}`);
    }
    const stages = resources.filter(r => r.startsWith('stage:')).map(r => r.replace('stage: ', ''));
    const desc = stages.length > 0
      ? `${platform} pipeline: ${stages.slice(0, 4).join(', ')}`
      : `${platform} configuration`;
    return { path: _p, description: desc, resources };
  };

  const cicdPrompt = `Analyze this ${platform} CI/CD pipeline. Identify: stages/jobs, deployment targets, security scanning steps, build artifacts, environment handling, and overall purpose. Return JSON: { "description": "1-2 sentence summary", "resources": ["list of stages and tools used"], "quality": "brief quality assessment" }`;
  return aiAnalyzeFile(cicdPrompt, path, content, `${platform} configuration`, fallbackFn);
}

function limitArray<T>(items: T[], limit = MAX_FILES): T[] {
  return items.slice(0, limit);
}

function convertChecksToFindings(
  checks: CheckovRunResult["checks"],
  category: string
): Array<ScoreMeReport["findings"][number]> {
  return checks.map((check) => ({
    category,
    severity: check.severity,
    message: check.message,
    file: check.file,
    remediation: check.guideline || `Review ${check.checkName || check.checkId}`,
  }));
}

function weightedScore(scores: Array<{ score: number; weight: number }>): number {
  return scores.reduce((acc, entry) => acc + entry.score * entry.weight, 0);
}

/**
 * AI-driven pillar scoring, replacing hardcoded formulas (C2) and
 * hardcoded confidence thresholds (C3).
 *
 * Returns the 4 pillar scores with AI-determined weights, a final
 * weighted score, and a confidence label from the allowed enum.
 */
async function computePillarScoresWithAI(input: {
  scanResults: {
    terraform: { passed: number; failed: number; skipped: number };
    kubernetes: { passed: number; failed: number; skipped: number };
    docker: { passed: number; failed: number; skipped: number };
    automation: { passed: number; failed: number; skipped: number };
    totalPassed: number; totalFailed: number; totalSkipped: number; totalChecks: number;
  };
  fileCounts: {
    terraform: number; kubernetes: number; helm: number; bicep: number;
    arm: number; dockerfiles: number; dockerCompose: number; automation: number; cicd: number;
  };
  infraCount: number;
  containerCount: number;
}): Promise<{
  pillarScores: ScoreMeReport["pillarScores"];
  finalScore: number;
  confidence: ScoreMeReport["confidence"];
}> {
  const CONFIDENCE_VALUES: ScoreMeReport["confidence"][] = [
    "Production-ready", "Needs minor fixes", "Risky", "Not recommended",
  ];

  // Fallback scoring (same structure, simple heuristics) used if AI fails
  function fallbackScoring(): {
    pillarScores: ScoreMeReport["pillarScores"];
    finalScore: number;
    confidence: ScoreMeReport["confidence"];
  } {
    const { scanResults: s, fileCounts: fc, infraCount, containerCount } = input;
    const pillars: ScoreMeReport["pillarScores"] = [
      {
        name: "Security & Compliance", weight: 0.4,
        score: Math.max(0, 100 - s.totalFailed * 4),
        details: [`${s.totalFailed} failed checks, ${s.totalPassed} passed`],
      },
      {
        name: "Infrastructure Coverage", weight: 0.25,
        score: Math.min(100, 50 + Math.min(50, infraCount * 5)),
        details: [`${infraCount} IaC files (TF/Bicep/ARM), ${fc.kubernetes} K8s, ${fc.helm} Helm`],
      },
      {
        name: "Automated Scanning", weight: 0.2,
        score: s.totalChecks > 0 ? Math.round((s.totalPassed / s.totalChecks) * 100) : 100,
        details: [`${s.totalChecks} checks, ${s.totalChecks > 0 ? Math.round((s.totalPassed / s.totalChecks) * 100) : 100}% pass rate`],
      },
      {
        name: "Containerization & Automation", weight: 0.15,
        score: Math.min(100, 50 + containerCount * 10 + fc.automation * 5 + fc.helm * 5),
        details: [`${containerCount} container files, ${fc.automation} scripts, ${fc.helm} Helm, ${fc.cicd} CI/CD`],
      },
    ];
    const score = weightedScore(pillars);
    let conf: ScoreMeReport["confidence"] = "Not recommended";
    if (score >= 90) conf = "Production-ready";
    else if (score >= 70) conf = "Needs minor fixes";
    else if (score >= 50) conf = "Risky";
    return { pillarScores: pillars, finalScore: score, confidence: conf };
  }

  try {
    const systemPrompt = `You are a DevOps maturity assessor. Given repository scan metrics, score 4 pillars and determine deployment confidence.

Return JSON:
{
  "pillars": [
    {
      "name": "Security & Compliance",
      "score": <0-100>,
      "weight": <0.35-0.45>,
      "details": ["line 1", "line 2"]
    },
    {
      "name": "Infrastructure Coverage",
      "score": <0-100>,
      "weight": <0.20-0.30>,
      "details": ["line 1", "line 2"]
    },
    {
      "name": "Automated Scanning",
      "score": <0-100>,
      "weight": <0.15-0.25>,
      "details": ["line 1"]
    },
    {
      "name": "Containerization & Automation",
      "score": <0-100>,
      "weight": <0.10-0.20>,
      "details": ["line 1"]
    }
  ],
  "confidence": "Production-ready" | "Needs minor fixes" | "Risky" | "Not recommended"
}

Scoring guidelines:
- Security: Each failed check costs 3-5 points. Critical failures (>10) should drop below 50.
- Infrastructure Coverage: Base 50 for having any IaC. +3-5 per file, capped at 100. Bicep/ARM count equally with Terraform.
- Automated Scanning: Pass rate percentage, penalised if very few total checks (<5).
- Containerization: Base 50 if any Dockerfiles exist. +10 per Dockerfile, +5 per compose/helm/cicd/automation.
- Weights MUST sum to exactly 1.0. Adjust within allowed ranges based on repo profile.
- Confidence: "Production-ready" (≥85 final + no critical gaps), "Needs minor fixes" (65-85), "Risky" (45-65), "Not recommended" (<45 or critical failures).
- Details: 1-3 short lines per pillar citing actual numbers.`;

    const userPrompt = `Scan results:\n${JSON.stringify(input, null, 2)}`;

    const completion = await aiChatCompletion({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userPrompt },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return fallbackScoring();

    const zodResult = aiScoringResponseSchema.safeParse(JSON.parse(content));
    if (!zodResult.success) {
      log.warn('AI pillar scoring validation failed', { error: zodResult.error.message });
      return fallbackScoring();
    }

    const parsed = zodResult.data;

    if (parsed.pillars.length !== 4) {
      return fallbackScoring();
    }

    // Normalise weights to sum to 1.0
    const totalWeight = parsed.pillars.reduce((s, p) => s + (p.weight || 0), 0);
    const pillarScores: ScoreMeReport["pillarScores"] = parsed.pillars.map(p => ({
      name: p.name,
      score: Math.max(0, Math.min(100, Math.round(p.score))),
      weight: totalWeight > 0 ? p.weight / totalWeight : 0.25,
      details: p.details,
    }));

    const finalScore = weightedScore(pillarScores);

    const confidence: ScoreMeReport["confidence"] = CONFIDENCE_VALUES.includes(parsed.confidence as any)
      ? (parsed.confidence as ScoreMeReport["confidence"])
      : finalScore >= 85 ? "Production-ready"
      : finalScore >= 65 ? "Needs minor fixes"
      : finalScore >= 45 ? "Risky"
      : "Not recommended";

    return { pillarScores, finalScore, confidence };
  } catch (error) {
    log.warn('AI pillar scoring failed, using fallback', { error: error instanceof Error ? error.message : String(error) });
    return fallbackScoring();
  }
}

async function summarizeInventoryWithContent(
  files: Array<{ path: string; content: string }>,
  type: InventoryCategory
): Promise<ScoreMeReport["inventory"][number] | null> {
  if (files.length === 0) return null;

  let summary = `${files.length} file${files.length > 1 ? "s" : ""} detected`;
  let fileDetails: FileDetail[] = [];

  // Use batched AI analysis for all types
  if (type === "terraform") {
    fileDetails = await processInBatches(files, 5, f => analyzeTerraformFile(f.path, f.content));
    const allResources: string[] = [];
    fileDetails.forEach(d => { if (d.resources) allResources.push(...d.resources.filter(r => r.startsWith("resource:"))); });
    const resourceTypes = uniqueArray(allResources.map(r => r.split(".")[0].replace("resource: ", "")));
    if (resourceTypes.length > 0) {
      summary += ` - Resources: ${resourceTypes.slice(0, 5).join(", ")}${resourceTypes.length > 5 ? ` (+${resourceTypes.length - 5} more)` : ""}`;
    }
  } else if (type === "kubernetes") {
    fileDetails = await processInBatches(files, 5, f => analyzeKubernetesFile(f.path, f.content));
    const allKinds: string[] = [];
    fileDetails.forEach(d => { if (d.resources) allKinds.push(...d.resources.map(r => r.split("/")[0])); });
    const uniqueKinds = uniqueArray(allKinds);
    if (uniqueKinds.length > 0) {
      summary += ` - Kinds: ${uniqueKinds.slice(0, 5).join(", ")}${uniqueKinds.length > 5 ? ` (+${uniqueKinds.length - 5} more)` : ""}`;
    }
  } else if (type === "helm") {
    fileDetails = await processInBatches(files, 5, f => analyzeHelmFile(f.path, f.content));
    const chartDetail = fileDetails.find(d => d.path.toLowerCase().endsWith("chart.yaml"));
    if (chartDetail && chartDetail.resources?.[0]) {
      summary += ` - ${chartDetail.resources[0]}`;
    }
  } else if (type === "automation") {
    fileDetails = await processInBatches(files, 5, f => {
      if (f.path.endsWith(".sh")) return analyzeShellScript(f.path, f.content);
      if (f.path.endsWith(".ps1")) return analyzePowerShellScript(f.path, f.content);
      if (f.path.endsWith(".py")) return analyzePythonScript(f.path, f.content);
      return Promise.resolve({ path: f.path, description: `Script: ${f.path.split("/").pop() || f.path}` });
    });
    const allTools: string[] = [];
    fileDetails.forEach(d => {
      if (d.resources) d.resources.filter(r => r.startsWith("uses:")).forEach(r => allTools.push(r.replace("uses: ", "")));
    });
    const uniqueTools = uniqueArray(allTools);
    const sh = files.filter(f => f.path.endsWith(".sh")).length;
    const ps1 = files.filter(f => f.path.endsWith(".ps1")).length;
    const py = files.filter(f => f.path.endsWith(".py")).length;
    const parts: string[] = [];
    if (sh) parts.push(`${sh} shell`);
    if (ps1) parts.push(`${ps1} PowerShell`);
    if (py) parts.push(`${py} Python`);
    if (parts.length) summary += ` (${parts.join(", ")})`;
    if (uniqueTools.length > 0) {
      summary += ` - Tools: ${uniqueTools.slice(0, 4).join(", ")}${uniqueTools.length > 4 ? ` (+${uniqueTools.length - 4} more)` : ""}`;
    }
  } else if (type === "bicep") {
    fileDetails = await processInBatches(files, 5, f => analyzeBicepFile(f.path, f.content));
    const allTypes: string[] = [];
    fileDetails.forEach(d => { if (d.resources) allTypes.push(...d.resources); });
    const uniqueTypes = uniqueArray(allTypes);
    if (uniqueTypes.length > 0) {
      summary += ` - Types: ${uniqueTypes.slice(0, 4).join(", ")}${uniqueTypes.length > 4 ? '...' : ''}`;
    }
  } else if (type === "arm") {
    fileDetails = await processInBatches(files, 5, f => analyzeArmFile(f.path, f.content));
    const allTypes: string[] = [];
    fileDetails.forEach(d => { if (d.resources) allTypes.push(...d.resources); });
    const uniqueTypes = uniqueArray(allTypes);
    if (uniqueTypes.length > 0) {
      summary += ` - Types: ${uniqueTypes.slice(0, 4).join(", ")}${uniqueTypes.length > 4 ? '...' : ''}`;
    }
  } else if (type === "cicd") {
    fileDetails = await processInBatches(files, 5, f => analyzeCicdFile(f.path, f.content));
    const platforms: string[] = [];
    fileDetails.forEach(d => {
      if (d.resources) d.resources.filter(r => r.startsWith("platform:")).forEach(r => platforms.push(r.replace("platform: ", "")));
    });
    const uniquePlatforms = uniqueArray(platforms);
    if (uniquePlatforms.length > 0) {
      summary += ` - ${uniquePlatforms.join(", ")}`;
    }
  } else {
    // dockerfile, docker-compose — simple description
    for (const file of files) {
      const filename = file.path.split("/").pop() || file.path;
      fileDetails.push({ path: file.path, description: `${type}: ${filename}` });
    }
  }

  return {
    type,
    path: files[0].path,
    summary,
    files: files.map((entry) => entry.path),
    fileDetails: fileDetails.length > 0 ? fileDetails : undefined,
  };
}

async function fetchGitHubTree(
  owner: string,
  repo: string,
  token?: string,
  requestedBranch?: string
): Promise<{ branch: string; tree: Array<{ path: string; type: string }> }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }

  const infoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers,
  });
  if (!infoResponse.ok) {
    throw new Error("Failed to fetch repository metadata from GitHub");
  }
  const repoInfo = (await infoResponse.json()) as { default_branch?: string };
  const branch = requestedBranch || repoInfo.default_branch || "main";

  const treeResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers }
  );
  if (!treeResponse.ok) {
    const body = await treeResponse.text();
    log.error(`Failed to fetch GitHub tree`, { owner, repo, branch, status: treeResponse.status, statusText: treeResponse.statusText, body: body.substring(0, 400) });
    if (treeResponse.status === 409 && body.includes("Git Repository is empty")) {
      log.warn('Repository is empty; returning empty tree', { owner, repo });
      return { branch, tree: [] };
    }
    throw new Error(
      `Failed to fetch repository tree from GitHub (${treeResponse.status}): ${body.replace(/\n/g, " ")}`
    );
  }
  const treeJson = (await treeResponse.json()) as { tree?: Array<{ path: string; type: string }> };
  return {
    branch,
    tree: Array.isArray(treeJson.tree) ? treeJson.tree : [],
  };
}

async function fetchGitHubContent(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  token?: string
): Promise<string> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `token ${token}`;
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(
    branch
  )}/${path}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to download ${path} from GitHub`);
  }
  return response.text();
}

async function fetchAzureTree(
  org: string,
  project: string,
  repoName: string,
  pat: string
): Promise<{
  repoId: string;
  tree: Array<{ path: string; gitObjectType: string }>;
}> {
  const authHeader = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
  const repoResponse = await fetch(
    `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoName}?api-version=7.1`,
    {
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    }
  );
  if (!repoResponse.ok) {
    throw new Error("Failed to fetch Azure DevOps repository metadata");
  }
  const repo = (await repoResponse.json()) as { id: string };
  const repoId = repo.id;

  const itemsResponse = await fetch(
    `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}/items?recursionLevel=Full&api-version=7.1`,
    {
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    }
  );
  if (!itemsResponse.ok) {
    throw new Error("Failed to fetch Azure DevOps repository tree");
  }
  const itemsJson = (await itemsResponse.json()) as { value?: Array<{ path: string; gitObjectType: string }> };
  return {
    repoId,
    tree: itemsJson.value || [],
  };
}

async function fetchAzureContent(
  org: string,
  project: string,
  repoId: string,
  path: string,
  pat: string
): Promise<string> {
  const authHeader = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
  const response = await fetch(
    `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(
      path
    )}&api-version=7.1&download=true`,
    {
      headers: {
        Authorization: authHeader,
      },
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to download ${path} from Azure DevOps`);
  }
  return response.text();
}

interface RepositoryFiles {
  terraformFiles: Array<{ path: string; content: string }>;
  kubernetesFiles: Array<{ path: string; content: string }>;
  helmCharts: Array<{ path: string; content: string }>;
  automationScripts: Array<{ path: string; content: string }>;
  bicepFiles: Array<{ path: string; content: string }>;
  armFiles: Array<{ path: string; content: string }>;
  dockerfiles: Array<{ path: string; content: string }>;
  dockerComposeFiles: Array<{ path: string; content: string }>;
  cicdFiles: Array<{ path: string; content: string }>;
  // Tree metadata for empty/app-code detection
  treeSize: number;
  hasAppCode: boolean;
}

function categorizePaths(tree: Array<{ path: string }>) {
  const categories: Record<InventoryCategory, Array<{ path: string }>> = {
    terraform: [],
    kubernetes: [],
    helm: [],
    automation: [],
    bicep: [],
    arm: [],
    dockerfile: [],
    "docker-compose": [],
    cicd: [],
  };

  for (const entry of tree) {
    // Helm files (chart.yaml / values.yaml) are exclusive — don't also bucket as kubernetes .yaml
    if (FILE_TYPES.helm(entry.path)) {
      categories.helm.push(entry);
      continue;
    }

    // Check all other categories
    (["terraform", "kubernetes", "automation", "bicep", "arm", "dockerfile", "docker-compose", "cicd"] as InventoryCategory[]).forEach((category) => {
      if (FILE_TYPES[category](entry.path)) {
        categories[category].push(entry);
      }
    });
  }

  return categories;
}

function parseGitHubRepoInput(input: string, defaultOwner: string) {
  const trimmed = input.trim().replace(/\/+$/, "");
  const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
  const normalized = withoutProtocol.startsWith("github.com/")
    ? withoutProtocol.slice("github.com/".length)
    : withoutProtocol;
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length >= 2) {
    return {
      owner: parts[parts.length - 2],
      repo: parts[parts.length - 1],
    };
  }

  if (parts.length === 1) {
    return {
      owner: defaultOwner,
      repo: parts[0],
    };
  }

  throw new Error(`Unable to parse GitHub repository input: ${input}`);
}

async function resolveGitHubRepository(
  ownerFallback: string,
  repositoryId: string,
  repositoryName: string,
  repositoryFullName?: string
): Promise<{ owner: string; repo: string }> {
  const candidateFromFullName = repositoryFullName?.trim();
  if (candidateFromFullName && candidateFromFullName.includes("/")) {
    return parseGitHubRepoInput(candidateFromFullName, ownerFallback);
  }

  const candidate = repositoryName || repositoryId;
  const normalizedCandidate = candidate.trim().toLowerCase();

  try {
    const repos = await mcpClient.listRepositories("github");
    const match = repos.find((repo: any) => {
      const idMatch = String(repo.id || "").toLowerCase() === repositoryId.toLowerCase();
      const fullNameMatch = repo.full_name
        ? repo.full_name.toLowerCase() === normalizedCandidate
        : false;
      const nameMatch = repo.name ? repo.name.toLowerCase() === normalizedCandidate : false;
      return idMatch || fullNameMatch || nameMatch;
    });

    if (match) {
      const bestName = match.full_name || match.name || candidate;
      return parseGitHubRepoInput(bestName, ownerFallback);
    }
  } catch (error: any) {
    log.warn('Unable to resolve GitHub repository via MCP', { error: error?.message || String(error) });
  }

  return parseGitHubRepoInput(candidate, ownerFallback);
}

async function ensureFiles(
  entries: Array<{ path: string }>,
  fetcher: (path: string) => Promise<string>
): Promise<Array<{ path: string; content: string }>> {
  const limited = limitArray(entries);
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of limited) {
    try {
      const content = await fetcher(entry.path);
      files.push({ path: entry.path, content });
    } catch (error) {
      log.warn(`Unable to fetch file`, { path: entry.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return files;
}

export class ScoreMeService {
  async runScore(userId: string, request: ScoreMeRequest): Promise<ScoreMeReport> {
    const secrets = await bitwardenService.getAllUserSecrets(userId);
    if (request.provider === "github") {
      const githubSecret = secrets.github;
      if (!githubSecret || !githubSecret.token || !githubSecret.owner) {
        throw new Error("GitHub credentials are not configured for ScoreMe");
      }
      return this.scoreGitHubRepo(
        githubSecret.owner,
        request.repositoryId,
        request.repositoryName,
        request.repositoryFullName,
        githubSecret.token,
        request.branch
      );
    } else {
      const azureSecret = secrets.azureDevOps;
      if (!azureSecret || !azureSecret.pat || !azureSecret.org || !azureSecret.project) {
        throw new Error("Azure DevOps credentials are not configured for ScoreMe");
      }
      return this.scoreAzureRepo(azureSecret, request.repositoryName);
    }
  }

  private async scoreGitHubRepo(
    owner: string,
    repositoryId: string,
    repositoryName: string,
    repositoryFullName: string | undefined,
    token: string,
    branchOverride?: string
  ): Promise<ScoreMeReport> {
    const { owner: resolvedOwner, repo: resolvedRepo } = await resolveGitHubRepository(
      owner,
      repositoryId,
      repositoryName,
      repositoryFullName
    );
    const { branch, tree } = await fetchGitHubTree(resolvedOwner, resolvedRepo, token, branchOverride);
    const categorized = categorizePaths(tree);

    const fetcher = (path: string) => fetchGitHubContent(resolvedOwner, resolvedRepo, branch, path, token);
    const terraformFiles = await ensureFiles(categorized.terraform, fetcher);
    const kubernetesFiles = await ensureFiles(categorized.kubernetes, fetcher);
    const helmCharts = await ensureFiles(categorized.helm, fetcher);
    const automationScripts = await ensureFiles(categorized.automation, fetcher);
    const bicepFiles = await ensureFiles(categorized.bicep, fetcher);
    const armFiles = await ensureFiles(categorized.arm, fetcher);
    const dockerfiles = await ensureFiles(categorized.dockerfile, fetcher);
    const dockerComposeFiles = await ensureFiles(categorized["docker-compose"], fetcher);
    const cicdFiles = await ensureFiles(categorized.cicd, fetcher);

    return this.buildReport(`${resolvedOwner}/${resolvedRepo}`, "github", {
      terraformFiles,
      kubernetesFiles,
      helmCharts,
      automationScripts,
      bicepFiles,
      armFiles,
      dockerfiles,
      dockerComposeFiles,
      cicdFiles,
      treeSize: tree.length,
      hasAppCode: hasApplicationCode(tree),
    });
  }

  private async scoreAzureRepo(
    secret: NonNullable<Awaited<ReturnType<typeof bitwardenService.getAllUserSecrets>>["azureDevOps"]>,
    repository: string
  ): Promise<ScoreMeReport> {
    const { org, project, pat } = secret;
    const { repoId, tree } = await fetchAzureTree(org, project, repository, pat);
    const categorized = categorizePaths(tree as any);
    const fetcher = (path: string) => fetchAzureContent(org, project, repoId, path, pat);
    const terraformFiles = await ensureFiles(categorized.terraform, fetcher);
    const kubernetesFiles = await ensureFiles(categorized.kubernetes, fetcher);
    const helmCharts = await ensureFiles(categorized.helm, fetcher);
    const automationScripts = await ensureFiles(categorized.automation, fetcher);
    const bicepFiles = await ensureFiles(categorized.bicep, fetcher);
    const armFiles = await ensureFiles(categorized.arm, fetcher);
    const dockerfiles = await ensureFiles(categorized.dockerfile, fetcher);
    const dockerComposeFiles = await ensureFiles(categorized["docker-compose"], fetcher);
    const cicdFiles = await ensureFiles(categorized.cicd, fetcher);

    return this.buildReport(`${org}/${project}/${repository}`, "azure", {
      terraformFiles,
      kubernetesFiles,
      helmCharts,
      automationScripts,
      bicepFiles,
      armFiles,
      dockerfiles,
      dockerComposeFiles,
      cicdFiles,
      treeSize: tree.length,
      hasAppCode: hasApplicationCode(tree as Array<{ path: string }>),
    });
  }

  private async buildReport(
    repositoryLabel: string,
    provider: "github" | "azure",
    files: RepositoryFiles
  ): Promise<ScoreMeReport> {
    // Run Checkov on all scannable categories in parallel
    log.info(`Starting security scan for ${repositoryLabel}`, { terraform: files.terraformFiles.length, kubernetes: files.kubernetesFiles.length, docker: files.dockerfiles.length, scripts: files.automationScripts.length });
    const scanStart = Date.now();
    const [terraformResult, kubernetesResult, dockerResult, automationResult] = await Promise.all([
      runCheckovOnFiles("terraform", files.terraformFiles),
      runCheckovOnFiles("kubernetes", files.kubernetesFiles),
      runCheckovOnFiles("dockerfile", files.dockerfiles),
      runCheckovOnFiles("automation", files.automationScripts),
    ]);
    log.info('Security scan completed', { durationSec: ((Date.now() - scanStart) / 1000).toFixed(1) });

    const totalFailed = terraformResult.failed + kubernetesResult.failed + dockerResult.failed + automationResult.failed;
    const totalPassed = terraformResult.passed + kubernetesResult.passed + dockerResult.passed + automationResult.passed;
    const totalSkipped = terraformResult.skipped + kubernetesResult.skipped + dockerResult.skipped + automationResult.skipped;
    const totalChecks = totalPassed + totalFailed + totalSkipped;

    const findings = [
      ...convertChecksToFindings(terraformResult.checks, "Terraform"),
      ...convertChecksToFindings(kubernetesResult.checks, "Kubernetes"),
      ...convertChecksToFindings(dockerResult.checks, "Dockerfile"),
      ...convertChecksToFindings(automationResult.checks, "Automation"),
    ];

    // Infrastructure file count (terraform + bicep + arm)
    const infraCount = files.terraformFiles.length + files.bicepFiles.length + files.armFiles.length;
    // Container file count
    const containerCount = files.dockerfiles.length + files.dockerComposeFiles.length;

    // Total scannable files across all categories
    const totalFileCount =
      files.terraformFiles.length +
      files.kubernetesFiles.length +
      files.helmCharts.length +
      files.automationScripts.length +
      files.bicepFiles.length +
      files.armFiles.length +
      files.dockerfiles.length +
      files.dockerComposeFiles.length +
      files.cicdFiles.length;

    // Early exit for empty repositories
    if (files.treeSize === 0) {
      return {
        repository: repositoryLabel,
        provider,
        inventory: [],
        findings: [],
        pillarScores: [
          { name: "Security & Compliance", score: 0, weight: 0.4, details: ["Repository is empty"] },
          { name: "Infrastructure Coverage", score: 0, weight: 0.25, details: ["No files in repository"] },
          { name: "Automated Scanning", score: 0, weight: 0.2, details: ["Nothing to scan"] },
          { name: "Containerization & Automation", score: 0, weight: 0.15, details: ["No files found"] },
        ],
        finalScore: 0,
        confidence: "Empty Repository",
        updatedAt: new Date().toISOString(),
      };
    }

    // Early exit for application code only (no DevOps/IaC files)
    if (totalFileCount === 0 && files.hasAppCode) {
      return {
        repository: repositoryLabel,
        provider,
        inventory: [],
        findings: [{
          category: "Warning",
          severity: "info",
          message: "This repository contains application source code but no Infrastructure-as-Code files.",
          file: repositoryLabel,
          remediation: "ScoreMe analyzes DevOps files (Terraform, Kubernetes, Helm, Dockerfile, Bicep, ARM). Add IaC files to get a meaningful score.",
        }],
        pillarScores: [
          { name: "Security & Compliance", score: 0, weight: 0.4, details: ["No IaC files to scan"] },
          { name: "Infrastructure Coverage", score: 0, weight: 0.25, details: ["Application code detected, but no infrastructure files"] },
          { name: "Automated Scanning", score: 0, weight: 0.2, details: ["No DevOps files to analyze"] },
          { name: "Containerization & Automation", score: 0, weight: 0.15, details: ["No Dockerfiles or automation scripts"] },
        ],
        finalScore: 0,
        confidence: "Application Code Only",
        updatedAt: new Date().toISOString(),
      };
    }

    // Early exit for repos with no DevOps files (and no app code detected)
    if (totalFileCount === 0) {
      return {
        repository: repositoryLabel,
        provider,
        inventory: [],
        findings: [],
        pillarScores: [
          { name: "Security & Compliance", score: 0, weight: 0.4, details: ["No scannable files found"] },
          { name: "Infrastructure Coverage", score: 0, weight: 0.25, details: ["No infrastructure files detected"] },
          { name: "Automated Scanning", score: 0, weight: 0.2, details: ["No files to scan"] },
          { name: "Containerization & Automation", score: 0, weight: 0.15, details: ["No containerization or automation files"] },
        ],
        finalScore: 0,
        confidence: "Not recommended",
        updatedAt: new Date().toISOString(),
      };
    }

    /**
     * AI-driven pillar scoring and confidence assessment (C2+C3).
     *
     * **Pillar weight philosophy (L2):**
     * - **Security & Compliance (≈0.40)**: Highest weight because security failures
     *   can cause breaches, compliance fines, and data loss. Even a small number of
     *   critical vulnerabilities should heavily penalise the overall score.
     * - **Infrastructure Coverage (≈0.25)**: IaC coverage determines reproducibility
     *   and drift prevention. A repo with zero IaC is essentially unauditable.
     * - **Automated Scanning (≈0.20)**: Pass rate across all checks reflects ongoing
     *   code hygiene. Separate from Security because a repo can have many passing
     *   low-severity checks yet still fail on critical ones.
     * - **Containerization & Automation (≈0.15)**: Lowest weight — containers and
     *   CI/CD automation improve velocity but their absence is less dangerous than
     *   missing security or IaC coverage.
     *
     * The AI may adjust weights ±0.05 based on the specific repository profile
     * (e.g., a pure Helm repo may weight containerization higher). Weights must
     * always sum to 1.0.
     */
    // Run pillar scoring and inventory analysis in parallel (both depend on scan results but not each other)
    log.info('Starting pillar scoring + inventory analysis');
    const analysisStart = Date.now();
    const [pillarResult, inventoryResults] = await Promise.all([
      computePillarScoresWithAI({
        scanResults: {
          terraform: { passed: terraformResult.passed, failed: terraformResult.failed, skipped: terraformResult.skipped },
          kubernetes: { passed: kubernetesResult.passed, failed: kubernetesResult.failed, skipped: kubernetesResult.skipped },
          docker: { passed: dockerResult.passed, failed: dockerResult.failed, skipped: dockerResult.skipped },
          automation: { passed: automationResult.passed, failed: automationResult.failed, skipped: automationResult.skipped },
          totalPassed, totalFailed, totalSkipped, totalChecks,
        },
        fileCounts: {
          terraform: files.terraformFiles.length,
          kubernetes: files.kubernetesFiles.length,
          helm: files.helmCharts.length,
          bicep: files.bicepFiles.length,
          arm: files.armFiles.length,
          dockerfiles: files.dockerfiles.length,
          dockerCompose: files.dockerComposeFiles.length,
          automation: files.automationScripts.length,
          cicd: files.cicdFiles.length,
        },
        infraCount,
        containerCount,
      }),
      // Inventory: infra code first, then kubernetes/helm, then containers, then automation, then CI/CD
      Promise.all([
        summarizeInventoryWithContent(files.terraformFiles, "terraform"),
        summarizeInventoryWithContent(files.kubernetesFiles, "kubernetes"),
        summarizeInventoryWithContent(files.helmCharts, "helm"),
        summarizeInventoryWithContent(files.bicepFiles, "bicep"),
        summarizeInventoryWithContent(files.armFiles, "arm"),
        summarizeInventoryWithContent(files.dockerfiles, "dockerfile"),
        summarizeInventoryWithContent(files.dockerComposeFiles, "docker-compose"),
        summarizeInventoryWithContent(files.automationScripts, "automation"),
        summarizeInventoryWithContent(files.cicdFiles, "cicd"),
      ]),
    ]);
    const { pillarScores, finalScore, confidence } = pillarResult;
    const inventory = inventoryResults.filter(Boolean) as ScoreMeReport["inventory"];
    log.info('Analysis completed', { durationSec: ((Date.now() - analysisStart) / 1000).toFixed(1), score: finalScore.toFixed(1), confidence });

    return {
      repository: repositoryLabel,
      provider,
      inventory,
      findings,
      pillarScores,
      finalScore: Number(finalScore.toFixed(1)),
      confidence,
      updatedAt: new Date().toISOString(),
    };
  }
}

export const scoreMeService = new ScoreMeService();

