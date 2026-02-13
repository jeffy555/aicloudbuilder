import { Buffer } from "buffer";
import { ScoreMeReport } from "@shared/schema";
import { bitwardenService } from "./bitwarden-service";
import { runCheckovOnFiles, CheckovRunResult } from "./scoreme/checkov-runner";
import { fetch } from "undici";
import { mcpClient } from "../mcp-client";

export interface ScoreMeRequest {
  provider: "github" | "azure";
  repositoryId: string;
  repositoryName: string;
  repositoryFullName?: string;
  branch?: string;
}

type InventoryCategory = "terraform" | "kubernetes" | "helm" | "automation" | "bicep" | "arm" | "dockerfile" | "docker-compose";

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

const MAX_FILES = 120;

// ============ Content Analysis Functions ============

interface FileDetail {
  path: string;
  description: string;
  resources?: string[];
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
 * Analyze Terraform file content to extract resources, providers, and modules
 */
function analyzeTerraformFile(path: string, content: string): FileDetail {
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
 * Analyze Kubernetes YAML file content to extract kind, name, namespace
 */
function analyzeKubernetesFile(path: string, content: string): FileDetail {
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
 * Analyze Helm chart files
 */
function analyzeHelmFile(path: string, content: string): FileDetail {
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
    const detail = analyzeKubernetesFile(path, content);
    detail.description = `Template: ${detail.description}`;
    return detail;
  }

  return { path, description: "Helm file", resources: [] };
}

/**
 * Analyze Shell script content (.sh files)
 */
function analyzeShellScript(path: string, content: string): FileDetail {
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
 * Analyze PowerShell script content (.ps1 files)
 */
function analyzePowerShellScript(path: string, content: string): FileDetail {
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
 * Analyze Python script content (.py files)
 */
function analyzePythonScript(path: string, content: string): FileDetail {
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

function computeConfidence(finalScore: number): ScoreMeReport["confidence"] {
  if (finalScore >= 90) return "Production-ready";
  if (finalScore >= 70) return "Needs minor fixes";
  if (finalScore >= 50) return "Risky";
  return "Not recommended";
}

function weightedScore(scores: Array<{ score: number; weight: number }>): number {
  return scores.reduce((acc, entry) => acc + entry.score * entry.weight, 0);
}

function summarizeInventoryWithContent(
  files: Array<{ path: string; content: string }>,
  type: InventoryCategory
): ScoreMeReport["inventory"][number] | null {
  if (files.length === 0) return null;

  let summary = `${files.length} file${files.length > 1 ? "s" : ""} detected`;
  const fileDetails: FileDetail[] = [];

  // Analyze file contents based on type
  if (type === "terraform") {
    // Collect all resources across files
    const allResources: string[] = [];
    for (const file of files) {
      const detail = analyzeTerraformFile(file.path, file.content);
      fileDetails.push(detail);
      if (detail.resources) {
        allResources.push(...detail.resources.filter(r => r.startsWith("resource:")));
      }
    }
    // Summarize resource types
    const resourceTypes = uniqueArray(allResources.map(r => r.split(".")[0].replace("resource: ", "")));
    if (resourceTypes.length > 0) {
      summary += ` - Resources: ${resourceTypes.slice(0, 5).join(", ")}${resourceTypes.length > 5 ? ` (+${resourceTypes.length - 5} more)` : ""}`;
    }
  } else if (type === "kubernetes") {
    // Collect all K8s kinds
    const allKinds: string[] = [];
    for (const file of files) {
      const detail = analyzeKubernetesFile(file.path, file.content);
      fileDetails.push(detail);
      if (detail.resources) {
        allKinds.push(...detail.resources.map(r => r.split("/")[0]));
      }
    }
    const uniqueKinds = uniqueArray(allKinds);
    if (uniqueKinds.length > 0) {
      summary += ` - Kinds: ${uniqueKinds.slice(0, 5).join(", ")}${uniqueKinds.length > 5 ? ` (+${uniqueKinds.length - 5} more)` : ""}`;
    }
  } else if (type === "helm") {
    for (const file of files) {
      const detail = analyzeHelmFile(file.path, file.content);
      fileDetails.push(detail);
    }
    // Find chart name from Chart.yaml
    const chartDetail = fileDetails.find(d => d.path.toLowerCase().endsWith("chart.yaml"));
    if (chartDetail && chartDetail.resources?.[0]) {
      summary += ` - ${chartDetail.resources[0]}`;
    }
  } else if (type === "automation") {
    // Analyze each script based on type using content analysis
    for (const file of files) {
      if (file.path.endsWith(".sh")) {
        fileDetails.push(analyzeShellScript(file.path, file.content));
      } else if (file.path.endsWith(".ps1")) {
        fileDetails.push(analyzePowerShellScript(file.path, file.content));
      } else if (file.path.endsWith(".py")) {
        fileDetails.push(analyzePythonScript(file.path, file.content));
      } else {
        const filename = file.path.split("/").pop() || file.path;
        fileDetails.push({ path: file.path, description: `Script: ${filename}` });
      }
    }

    // Collect all "uses:" resources for summary
    const allTools: string[] = [];
    fileDetails.forEach(d => {
      if (d.resources) {
        d.resources.filter(r => r.startsWith("uses:")).forEach(r => {
          allTools.push(r.replace("uses: ", ""));
        });
      }
    });
    const uniqueTools = uniqueArray(allTools);

    // Build summary with counts and tool usage
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
  } else {
    // For other types (dockerfile, docker-compose, bicep, arm)
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
    console.error(
      `[ScoreMe] Failed to fetch GitHub tree (${owner}/${repo}@${branch}): ${treeResponse.status} ${treeResponse.statusText} - ${body.substring(
        0,
        400
      )}`
    );
    if (treeResponse.status === 409 && body.includes("Git Repository is empty")) {
      console.warn(`[ScoreMe] Repository ${owner}/${repo} is empty; returning empty tree.`);
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
  };

  for (const entry of tree) {
    // Helm files (chart.yaml / values.yaml) are exclusive — don't also bucket as kubernetes .yaml
    if (FILE_TYPES.helm(entry.path)) {
      categories.helm.push(entry);
      continue;
    }

    // Check all other categories
    (["terraform", "kubernetes", "automation", "bicep", "arm", "dockerfile", "docker-compose"] as InventoryCategory[]).forEach((category) => {
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
    console.warn("⚠️ ScoreMe: Unable to resolve GitHub repository via MCP:", error?.message || error);
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
      console.warn(`Unable to fetch ${entry.path}:`, error);
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

    return this.buildReport(`${resolvedOwner}/${resolvedRepo}`, "github", {
      terraformFiles,
      kubernetesFiles,
      helmCharts,
      automationScripts,
      bicepFiles,
      armFiles,
      dockerfiles,
      dockerComposeFiles,
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

    return this.buildReport(`${org}/${project}/${repository}`, "azure", {
      terraformFiles,
      kubernetesFiles,
      helmCharts,
      automationScripts,
      bicepFiles,
      armFiles,
      dockerfiles,
      dockerComposeFiles,
      treeSize: tree.length,
      hasAppCode: hasApplicationCode(tree as Array<{ path: string }>),
    });
  }

  private async buildReport(
    repositoryLabel: string,
    provider: "github" | "azure",
    files: RepositoryFiles
  ): Promise<ScoreMeReport> {
    // Run Checkov on scannable infrastructure code (terraform, kubernetes, dockerfile, automation)
    const terraformResult = await runCheckovOnFiles("terraform", files.terraformFiles);
    const kubernetesResult = await runCheckovOnFiles("kubernetes", files.kubernetesFiles);
    const dockerResult = await runCheckovOnFiles("dockerfile", files.dockerfiles);
    const automationResult = await runCheckovOnFiles("automation", files.automationScripts);

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
      files.dockerComposeFiles.length;

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

    const pillarScores = [
      {
        name: "Security & Compliance",
        score: Math.max(0, 100 - totalFailed * 4),
        weight: 0.4,
        details: [
          `Checkov failed checks: ${totalFailed}`,
          `Terraform: ${terraformResult.failed} failed, ${terraformResult.passed} passed`,
          `Kubernetes: ${kubernetesResult.failed} failed, ${kubernetesResult.passed} passed`,
          ...(dockerResult.passed + dockerResult.failed > 0
            ? [`Dockerfile: ${dockerResult.failed} failed, ${dockerResult.passed} passed`]
            : []),
          ...(automationResult.passed + automationResult.failed > 0
            ? [`Automation: ${automationResult.failed} failed, ${automationResult.passed} passed`]
            : []),
        ],
      },
      {
        name: "Infrastructure Coverage",
        score: Math.min(100, 50 + Math.min(50, infraCount * 5)),
        weight: 0.25,
        details: [
          `Terraform files: ${files.terraformFiles.length}`,
          ...(files.bicepFiles.length ? [`Bicep files: ${files.bicepFiles.length}`] : []),
          ...(files.armFiles.length ? [`ARM templates: ${files.armFiles.length}`] : []),
          `Kubernetes manifests: ${files.kubernetesFiles.length}`,
          `Helm charts: ${files.helmCharts.length}`,
        ],
      },
      {
        name: "Automated Scanning",
        score: totalChecks > 0 ? Math.round((totalPassed / totalChecks) * 100) : 100,
        weight: 0.2,
        details: [
          `Total checks run: ${totalChecks}`,
          `Pass rate: ${totalChecks > 0 ? Math.round((totalPassed / totalChecks) * 100) : 100}%`,
        ],
      },
      {
        name: "Containerization & Automation",
        score: Math.min(100, 50 + containerCount * 10 + files.automationScripts.length * 5 + files.helmCharts.length * 5),
        weight: 0.15,
        details: [
          ...(files.dockerfiles.length ? [`Dockerfiles: ${files.dockerfiles.length}`] : []),
          ...(files.dockerComposeFiles.length ? [`Docker Compose files: ${files.dockerComposeFiles.length}`] : []),
          `Automation scripts: ${files.automationScripts.length}`,
          `Helm charts: ${files.helmCharts.length}`,
        ],
      },
    ];

    const finalScore = weightedScore(pillarScores);

    // Inventory: infra code first, then kubernetes/helm, then containers, then automation
    // Use content-aware analysis for Terraform, Kubernetes, and Helm
    const inventory = [
      summarizeInventoryWithContent(files.terraformFiles, "terraform"),
      summarizeInventoryWithContent(files.kubernetesFiles, "kubernetes"),
      summarizeInventoryWithContent(files.helmCharts, "helm"),
      summarizeInventoryWithContent(files.bicepFiles, "bicep"),
      summarizeInventoryWithContent(files.armFiles, "arm"),
      summarizeInventoryWithContent(files.dockerfiles, "dockerfile"),
      summarizeInventoryWithContent(files.dockerComposeFiles, "docker-compose"),
      summarizeInventoryWithContent(files.automationScripts, "automation"),
    ].filter(Boolean) as ScoreMeReport["inventory"];

    return {
      repository: repositoryLabel,
      provider,
      inventory,
      findings,
      pillarScores,
      finalScore: Number(finalScore.toFixed(1)),
      confidence: computeConfidence(finalScore),
      updatedAt: new Date().toISOString(),
    };
  }
}

export const scoreMeService = new ScoreMeService();

