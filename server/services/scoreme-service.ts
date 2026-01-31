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

type InventoryCategory = "terraform" | "kubernetes" | "helm" | "dockerfile" | "automation";

const FILE_TYPES: Record<InventoryCategory, (path: string) => boolean> = {
  terraform: (path: string) => path.endsWith(".tf") || path.endsWith(".tf.json"),
  kubernetes: (path: string) => path.endsWith(".yaml") || path.endsWith(".yml"),
  helm: (path: string) =>
    path.toLowerCase().endsWith("chart.yaml") ||
    path.toLowerCase().endsWith("values.yaml"),
  dockerfile: (path: string) => path.toLowerCase().endsWith("dockerfile"),
  automation: (path: string) =>
    path.endsWith(".sh") || path.endsWith(".ps1") || path.endsWith(".py"),
};

const MAX_FILES = 120;

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

function summarizeInventory(
  files: Array<{ path: string }>,
  type: InventoryCategory
): ScoreMeReport["inventory"][number] | null {
  if (files.length === 0) return null;
    return {
      type,
      path: files[0].path,
      summary: `${files.length} files detected`,
      files: files.map((entry) => entry.path),
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
  dockerfiles: Array<{ path: string; content: string }>;
  automationScripts: Array<{ path: string; content: string }>;
  helmCharts: Array<{ path: string; content: string }>;
}

function categorizePaths(tree: Array<{ path: string }>) {
  const categories: Record<InventoryCategory, Array<{ path: string }>> = {
    terraform: [],
    kubernetes: [],
    helm: [],
    dockerfile: [],
    automation: [],
  };

  for (const entry of tree) {
    if (FILE_TYPES.helm(entry.path)) {
      categories.helm.push(entry);
      continue;
    }

    (["terraform", "kubernetes", "dockerfile", "automation"] as InventoryCategory[]).forEach((category) => {
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

    const terraformFiles = await ensureFiles(categorized.terraform, async (path) =>
      fetchGitHubContent(resolvedOwner, resolvedRepo, branch, path, token)
    );
    const kubernetesFiles = await ensureFiles(categorized.kubernetes, async (path) =>
      fetchGitHubContent(resolvedOwner, resolvedRepo, branch, path, token)
    );
    const dockerfiles = await ensureFiles(categorized.dockerfile, async (path) =>
      fetchGitHubContent(resolvedOwner, resolvedRepo, branch, path, token)
    );
    const automationScripts = await ensureFiles(categorized.automation, async (path) =>
      fetchGitHubContent(resolvedOwner, resolvedRepo, branch, path, token)
    );
    const helmCharts = await ensureFiles(categorized.helm, async (path) =>
      fetchGitHubContent(resolvedOwner, resolvedRepo, branch, path, token)
    );

    return this.buildReport(`${resolvedOwner}/${resolvedRepo}`, "github", {
      terraformFiles,
      kubernetesFiles,
      dockerfiles,
      automationScripts,
      helmCharts,
    });
  }

  private async scoreAzureRepo(
    secret: NonNullable<Awaited<ReturnType<typeof bitwardenService.getAllUserSecrets>>["azureDevOps"]>,
    repository: string
  ): Promise<ScoreMeReport> {
    const { org, project, pat } = secret;
    const { repoId, tree } = await fetchAzureTree(org, project, repository, pat);
    const categorized = categorizePaths(tree as any);
    const terraformFiles = await ensureFiles(categorized.terraform, async (path) =>
      fetchAzureContent(org, project, repoId, path, pat)
    );
    const kubernetesFiles = await ensureFiles(categorized.kubernetes, async (path) =>
      fetchAzureContent(org, project, repoId, path, pat)
    );
    const dockerfiles = await ensureFiles(categorized.dockerfile, async (path) =>
      fetchAzureContent(org, project, repoId, path, pat)
    );
    const automationScripts = await ensureFiles(categorized.automation, async (path) =>
      fetchAzureContent(org, project, repoId, path, pat)
    );
    const helmCharts = await ensureFiles(categorized.helm, async (path) =>
      fetchAzureContent(org, project, repoId, path, pat)
    );

    return this.buildReport(`${org}/${project}/${repository}`, "azure", {
      terraformFiles,
      kubernetesFiles,
      dockerfiles,
      automationScripts,
      helmCharts,
    });
  }

  private async buildReport(
    repositoryLabel: string,
    provider: "github" | "azure",
    files: RepositoryFiles
  ): Promise<ScoreMeReport> {
    const terraformResult = await runCheckovOnFiles("terraform", files.terraformFiles);
    const kubernetesResult = await runCheckovOnFiles("kubernetes", files.kubernetesFiles);
    const dockerResult = await runCheckovOnFiles("dockerfile", files.dockerfiles);

    const totalFailed = terraformResult.failed + kubernetesResult.failed + dockerResult.failed;
    const totalPassed = terraformResult.passed + kubernetesResult.passed + dockerResult.passed;
    const totalSkipped = terraformResult.skipped + kubernetesResult.skipped + dockerResult.skipped;
    const totalChecks = totalPassed + totalFailed + totalSkipped;

    const findings = [
      ...convertChecksToFindings(terraformResult.checks, "Terraform"),
      ...convertChecksToFindings(kubernetesResult.checks, "Kubernetes"),
      ...convertChecksToFindings(dockerResult.checks, "Dockerfile"),
    ];

    const pillarScores = [
      {
        name: "Security & Compliance",
        score: Math.max(0, 100 - totalFailed * 4),
        weight: 0.4,
        details: [`Checkov failed checks: ${totalFailed}`],
      },
      {
        name: "Code Structure & Quality",
        score: Math.min(100, 70 + Math.min(30, files.terraformFiles.length * 2)),
        weight: 0.25,
        details: [`Terraform files scanned: ${files.terraformFiles.length}`, `Kubernetes manifests: ${files.kubernetesFiles.length}`],
      },
      {
        name: "Automated Scanning",
        score: totalChecks > 0 ? Math.round((totalPassed / totalChecks) * 100) : 100,
        weight: 0.2,
        details: [`Total scans run: ${totalChecks}`],
      },
      {
        name: "Best Practices Suggestions",
        score: Math.min(100, 60 + files.dockerfiles.length * 5 + files.automationScripts.length * 3),
        weight: 0.15,
        details: [`Automation scripts: ${files.automationScripts.length}`, `Dockerfiles scanned: ${files.dockerfiles.length}`],
      },
    ];

    const finalScore = weightedScore(pillarScores);
    const inventory = [
      summarizeInventory(files.terraformFiles, "terraform"),
      summarizeInventory(files.kubernetesFiles, "kubernetes"),
      summarizeInventory(files.dockerfiles, "dockerfile"),
      summarizeInventory(files.automationScripts, "automation"),
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

