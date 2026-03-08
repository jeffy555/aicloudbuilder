/**
 * Helm Deep Analyzer
 * Multi-pass specialist AI analysis for Helm chart production-readiness scoring.
 * Runs 5 domain-expert passes in parallel; each returns issues with YAML fix snippets.
 */
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface DeepIssue {
  id: string;
  category: 'security' | 'reliability' | 'resources' | 'helm-structure' | 'operations';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  file?: string;
  fixSnippet?: string;
}

export interface DeepAnalysisResult {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  issues: DeepIssue[];
  categoryScores: {
    security: number;
    reliability: number;
    resources: number;
    helmStructure: number;
    operations: number;
  };
  passedChecks: number;
  totalChecks: number;
}

interface PassDefinition {
  key: keyof DeepAnalysisResult['categoryScores'];
  weight: number;
  name: string;
  useRendered: boolean; // true = rendered templates; false = raw helm files
  systemPrompt: string;
}

const PASSES: PassDefinition[] = [
  {
    key: 'security',
    weight: 25,
    name: 'Security Hardening',
    useRendered: true,
    systemPrompt: `You are a Kubernetes security expert performing a thorough security audit of Helm chart rendered manifests.

Evaluate EVERY container in EVERY resource for these specific checks (count each as one check):
1. securityContext.runAsNonRoot: true
2. securityContext.allowPrivilegeEscalation: false
3. securityContext.readOnlyRootFilesystem: true
4. securityContext.capabilities.drop includes ALL
5. securityContext.seccompProfile.type is RuntimeDefault or Localhost
6. Image tag is NOT "latest" and is NOT empty string
7. No sensitive values hardcoded in env (password, secret, key, token as plain env vars)
8. automountServiceAccountToken: false (unless explicitly needed)
9. No hostNetwork: true, hostPID: true, or hostIPC: true
10. Pod-level securityContext.runAsUser is not 0

For each FAILING check provide a concrete YAML snippet showing the exact fix (not pseudocode — real YAML).

Return ONLY this JSON (no markdown fencing):
{
  "passedChecks": <integer>,
  "totalChecks": <integer>,
  "issues": [
    {
      "id": "SEC-001",
      "severity": "critical|high|medium|low",
      "title": "<concise title>",
      "description": "<what is wrong, which container/resource, and why it is a security risk>",
      "file": "<template filename, e.g. deployment.yaml>",
      "fixSnippet": "<exact YAML showing the corrected securityContext or config>"
    }
  ]
}`,
  },
  {
    key: 'reliability',
    weight: 25,
    name: 'Reliability & HA',
    useRendered: true,
    systemPrompt: `You are a Kubernetes site-reliability expert auditing Helm chart rendered manifests for production reliability.

Evaluate these specific checks (count each as one check):
1. Deployment has replicaCount >= 2 (single replica = SPOF)
2. livenessProbe defined on every container
3. readinessProbe defined on every container
4. Probe path is not just "/" — should be a dedicated /health or /ready endpoint
5. livenessProbe.failureThreshold >= 3 with reasonable periodSeconds
6. readinessProbe.initialDelaySeconds > 0
7. terminationGracePeriodSeconds is explicitly set (not relying on 30s default)
8. rollingUpdate strategy is defined (maxSurge, maxUnavailable)
9. PodDisruptionBudget exists for deployments with replicas >= 2
10. Pod anti-affinity (preferred or required) is configured for multi-replica workloads
11. HPA minReplicas >= 2 if HPA is enabled
12. startupProbe or sufficient initialDelaySeconds for slow-starting apps

For each failing check, provide the exact corrective YAML snippet.

Return ONLY this JSON:
{
  "passedChecks": <integer>,
  "totalChecks": <integer>,
  "issues": [
    {
      "id": "REL-001",
      "severity": "critical|high|medium|low",
      "title": "<concise title>",
      "description": "<what is missing, which resource, and the reliability risk>",
      "file": "<template filename>",
      "fixSnippet": "<exact YAML fix>"
    }
  ]
}`,
  },
  {
    key: 'resources',
    weight: 20,
    name: 'Resource Management',
    useRendered: true,
    systemPrompt: `You are a Kubernetes resource management expert auditing rendered manifests for correct resource configuration.

Evaluate these specific checks (count each as one check):
1. Every container has resources.requests.cpu defined
2. Every container has resources.requests.memory defined
3. Every container has resources.limits.cpu defined
4. Every container has resources.limits.memory defined
5. CPU limit is not more than 4x the CPU request (throttling risk)
6. Memory limit is not more than 2x the memory request (OOMKill risk)
7. CPU request is realistic (>= 10m, not 1 or 2 full cores unless justified)
8. Memory request is realistic (>= 32Mi)
9. Init containers also have resource limits
10. ephemeralStorage limits set if app writes to tmp directories

For each failing check provide the corrective YAML snippet with realistic values for the detected framework.

Return ONLY this JSON:
{
  "passedChecks": <integer>,
  "totalChecks": <integer>,
  "issues": [
    {
      "id": "RES-001",
      "severity": "critical|high|medium|low",
      "title": "<concise title>",
      "description": "<what is wrong and the operational risk>",
      "file": "<template filename>",
      "fixSnippet": "<exact YAML fix showing resources block>"
    }
  ]
}`,
  },
  {
    key: 'helmStructure',
    weight: 15,
    name: 'Helm Structure',
    useRendered: false, // raw helm source files
    systemPrompt: `You are a Helm chart expert auditing raw chart source files for structural correctness and authoring best practices.

Evaluate these specific checks (count each as one check):
1. Chart.yaml has apiVersion: v2
2. Chart.yaml has name, description, version (valid semver), appVersion
3. Chart.yaml has maintainers list (recommended)
4. _helpers.tpl defines: <chart>.fullname, <chart>.name, <chart>.labels, <chart>.selectorLabels, <chart>.serviceAccountName
5. All templates use {{ include "<chart>.fullname" . }} — NOT hardcoded names
6. values.yaml has a default for every template value reference
7. values.yaml image.tag defaults to "" (not a hardcoded version string)
8. Conditional templates are guarded with {{- if .Values.<section>.enabled }}
9. NOTES.txt provides useful post-install instructions (not just boilerplate)
10. .helmignore excludes test files, *.md, .git
11. range loops use $ for root context (e.g. {{ include "chart.fullname" $ }})
12. values-dev.yaml and values-prod.yaml exist for environment overlays (if applicable)

For each failing check provide the corrective snippet (YAML or Go template).

Return ONLY this JSON:
{
  "passedChecks": <integer>,
  "totalChecks": <integer>,
  "issues": [
    {
      "id": "HLM-001",
      "severity": "critical|high|medium|low",
      "title": "<concise title>",
      "description": "<what is wrong or missing and why it matters>",
      "file": "<filename, e.g. Chart.yaml or templates/_helpers.tpl>",
      "fixSnippet": "<exact corrective YAML or template snippet>"
    }
  ]
}`,
  },
  {
    key: 'operations',
    weight: 15,
    name: 'Operational Readiness',
    useRendered: true,
    systemPrompt: `You are a Kubernetes platform engineer auditing rendered manifests for operational readiness and day-2 operations.

Evaluate these specific checks (count each as one check):
1. All resources have label app.kubernetes.io/name
2. All resources have label app.kubernetes.io/instance
3. All resources have label app.kubernetes.io/version
4. All resources have label app.kubernetes.io/managed-by: Helm
5. app.kubernetes.io/component is set (recommended)
6. Image tag is NOT "latest" (must be a specific version or digest)
7. Service has prometheus.io/scrape annotation (recommended for observability)
8. ServiceAccount has annotations section for cloud IAM integration (IRSA/Workload Identity)
9. Namespace is not hardcoded (should come from helm install --namespace)
10. Resource names use release-name prefix (not hardcoded app names)
11. topologySpreadConstraints or pod anti-affinity for multi-AZ HA
12. Pod annotations include checksum/config for config-driven rollout

For each failing check provide the corrective YAML snippet.

Return ONLY this JSON:
{
  "passedChecks": <integer>,
  "totalChecks": <integer>,
  "issues": [
    {
      "id": "OPS-001",
      "severity": "critical|high|medium|low",
      "title": "<concise title>",
      "description": "<what is missing and the operational impact>",
      "file": "<template filename>",
      "fixSnippet": "<exact YAML fix>"
    }
  ]
}`,
  },
];

function scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 45) return 'D';
  return 'F';
}

/**
 * Run all 5 specialist passes in parallel and aggregate into a scored result.
 *
 * @param helmFiles  Raw helm source files (Chart.yaml, values.yaml, templates/*, etc.)
 * @param renderedTemplates  Output of `helm template` split by ---
 */
export async function deepAnalyzeHelmChart(
  helmFiles: Array<{ path: string; content: string }>,
  renderedTemplates: string[]
): Promise<DeepAnalysisResult> {
  console.log('\n🔬 ========== HELM DEEP ANALYSIS ==========');
  console.log(`   ${helmFiles.length} source files, ${renderedTemplates.length} rendered templates`);

  // Build content snapshots
  const rawFilesContent = helmFiles
    .map(f => `### ${f.path}\n${f.content}`)
    .join('\n\n---\n\n')
    .substring(0, 14000);

  const renderedContent = renderedTemplates
    .join('\n---\n')
    .substring(0, 14000);

  // If rendered templates are empty, fall back to raw files for all passes
  const hasRendered = renderedContent.trim().length > 20;

  // Run all passes in parallel
  const passResults = await Promise.allSettled(
    PASSES.map(async (pass) => {
      const content = (!pass.useRendered || !hasRendered) ? rawFilesContent : renderedContent;

      if (!content.trim()) {
        return { key: pass.key, weight: pass.weight, passedChecks: 5, totalChecks: 10, issues: [] as DeepIssue[] };
      }

      console.log(`   🔍 Running ${pass.name} pass...`);

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: pass.systemPrompt },
          { role: 'user', content: `Analyse this Helm chart:\n\n${content}` },
        ],
        temperature: 0.1,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
      });

      const raw = completion.choices[0]?.message?.content?.trim() || '{}';
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { /* use defaults */ }

      const issues: DeepIssue[] = (parsed.issues || []).map((issue: any, i: number) => ({
        id: issue.id || `${pass.key.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
        category: pass.key,
        severity: (['critical', 'high', 'medium', 'low'].includes(issue.severity)
          ? issue.severity
          : 'medium') as DeepIssue['severity'],
        title: issue.title || 'Unknown issue',
        description: issue.description || '',
        file: issue.file,
        fixSnippet: issue.fixSnippet,
      }));

      const passedChecks = Number(parsed.passedChecks) || 0;
      const totalChecks = Number(parsed.totalChecks) || Math.max(issues.length + passedChecks, 8);

      console.log(`   ✅ ${pass.name}: ${passedChecks}/${totalChecks} passed, ${issues.length} issue(s)`);

      return { key: pass.key, weight: pass.weight, passedChecks, totalChecks, issues };
    })
  );

  // Aggregate
  const allIssues: DeepIssue[] = [];
  let totalPassedChecks = 0;
  let totalAllChecks = 0;
  let weightedScore = 0;
  let totalWeight = 0;

  const categoryScores: DeepAnalysisResult['categoryScores'] = {
    security: 0,
    reliability: 0,
    resources: 0,
    helmStructure: 0,
    operations: 0,
  };

  for (let i = 0; i < PASSES.length; i++) {
    const pass = PASSES[i];
    const result = passResults[i];

    if (result.status === 'fulfilled') {
      const { passedChecks, totalChecks, issues } = result.value;
      allIssues.push(...issues);
      totalPassedChecks += passedChecks;
      totalAllChecks += totalChecks;
      const catScore = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 50;
      categoryScores[pass.key] = catScore;
      weightedScore += catScore * pass.weight;
      totalWeight += pass.weight;
    } else {
      console.warn(`   ⚠️  ${pass.name} pass failed:`, (passResults[i] as PromiseRejectedResult).reason?.message);
      categoryScores[pass.key] = 50;
      weightedScore += 50 * pass.weight;
      totalWeight += pass.weight;
    }
  }

  const overallScore = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 50;
  const grade = scoreToGrade(overallScore);

  console.log(`\n   📊 Score: ${overallScore}/100 (${grade}) | ${allIssues.length} total issues`);
  console.log('==========================================\n');

  return {
    score: overallScore,
    grade,
    issues: allIssues,
    categoryScores,
    passedChecks: totalPassedChecks,
    totalChecks: totalAllChecks,
  };
}
