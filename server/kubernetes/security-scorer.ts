/**
 * Security Context Scorer
 * Analyses Kubernetes YAML manifests and produces a consolidated security score.
 * Uses GPT-4o-mini for scoring, grading, and recommendations.
 */
import yaml from 'js-yaml';
import { aiChatCompletion } from '../utils/ai-client.js';
import { z } from 'zod';
import { sanitizeJsonForPrompt } from '../utils/sanitize-prompt.js';

// ─── Zod schemas for AI response validation ─────────────────────────────────

const aiSecurityScoreSchema = z.object({
  score: z.number().min(0).max(100),
  grade: z.enum(['A', 'B', 'C', 'D', 'F']).catch('C'),
  recommendations: z.array(z.string()).catch([]),
  findings: z.array(z.object({
    category: z.string(),
    status: z.string(),
    details: z.string(),
  })).catch([]),
});

export interface SecurityScoreResult {
  overallScore: number;          // 0-100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  totalWorkloads: number;
  metrics: {
    runAsNonRoot:          { count: number; total: number; percent: number };
    readOnlyRootFilesystem:{ count: number; total: number; percent: number };
    resourceLimitsDefined: { count: number; total: number; percent: number };
    privilegedContainers:  { count: number; total: number; percent: number };
    hostNamespaces:        { count: number; total: number; percent: number };
    latestImageTag:        { count: number; total: number; percent: number };
  };
  recommendations: string[];
}

interface PodData {
  resourceName: string;
  kind: string;
  podSpec: any;
}

/**
 * Extract pod specs from a list of YAML manifest strings
 */
function extractPodSpecs(manifests: string[]): PodData[] {
  const pods: PodData[] = [];
  const workloadKinds = new Set([
    'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod'
  ]);

  for (const manifestYAML of manifests) {
    const docs = manifestYAML.split(/^---\s*$/m).filter(s => s.trim());
    for (const doc of docs) {
      try {
        const parsed = yaml.load(doc) as any;
        if (!parsed?.kind || !workloadKinds.has(parsed.kind)) continue;

        const name = parsed.metadata?.name ?? 'unknown';
        let podSpec: any;

        if (parsed.kind === 'Pod') {
          podSpec = parsed.spec;
        } else if (parsed.kind === 'CronJob') {
          podSpec = parsed.spec?.jobTemplate?.spec?.template?.spec;
        } else {
          podSpec = parsed.spec?.template?.spec;
        }

        if (podSpec) {
          pods.push({ resourceName: `${parsed.kind}/${name}`, kind: parsed.kind, podSpec });
        }
      } catch {
        // skip
      }
    }
  }

  return pods;
}

/**
 * Score Kubernetes manifests for security context compliance
 */
export async function scoreSecurityContexts(manifests: string[]): Promise<SecurityScoreResult> {
  const pods = extractPodSpecs(manifests);
  const total = pods.length;

  if (total === 0) {
    return {
      overallScore: 0,
      grade: 'F',
      totalWorkloads: 0,
      metrics: {
        runAsNonRoot:           { count: 0, total: 0, percent: 0 },
        readOnlyRootFilesystem: { count: 0, total: 0, percent: 0 },
        resourceLimitsDefined:  { count: 0, total: 0, percent: 0 },
        privilegedContainers:   { count: 0, total: 0, percent: 0 },
        hostNamespaces:         { count: 0, total: 0, percent: 0 },
        latestImageTag:         { count: 0, total: 0, percent: 0 },
      },
      recommendations: ['No workload resources found to analyse.'],
    };
  }

  let runAsNonRootCount = 0;
  let readOnlyRootFsCount = 0;
  let resourceLimitsCount = 0;
  let privilegedCount = 0;
  let hostNamespaceCount = 0;
  let latestTagCount = 0;
  let totalContainers = 0;

  for (const pod of pods) {
    const ps = pod.podSpec;

    // Host namespaces check (pod-level)
    if (ps.hostPID || ps.hostIPC || ps.hostNetwork) {
      hostNamespaceCount++;
    }

    const containers: any[] = [
      ...(ps.containers ?? []),
      ...(ps.initContainers ?? []),
    ];

    for (const c of containers) {
      totalContainers++;
      const sc = c.securityContext ?? {};
      const podSc = ps.securityContext ?? {};

      // runAsNonRoot: container-level or pod-level
      if (sc.runAsNonRoot === true || (podSc.runAsNonRoot === true && sc.runAsNonRoot !== false)) {
        runAsNonRootCount++;
      }

      // readOnlyRootFilesystem
      if (sc.readOnlyRootFilesystem === true) {
        readOnlyRootFsCount++;
      }

      // resource limits
      if (c.resources?.limits?.cpu && c.resources?.limits?.memory) {
        resourceLimitsCount++;
      }

      // privileged
      if (sc.privileged === true) {
        privilegedCount++;
      }

      // latest image tag
      const image: string = c.image ?? '';
      if (!image || image.endsWith(':latest') || !image.includes(':')) {
        latestTagCount++;
      }
    }
  }

  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));

  const metrics = {
    runAsNonRoot:           { count: runAsNonRootCount,    total: totalContainers, percent: pct(runAsNonRootCount, totalContainers) },
    readOnlyRootFilesystem: { count: readOnlyRootFsCount,  total: totalContainers, percent: pct(readOnlyRootFsCount, totalContainers) },
    resourceLimitsDefined:  { count: resourceLimitsCount,  total: totalContainers, percent: pct(resourceLimitsCount, totalContainers) },
    privilegedContainers:   { count: privilegedCount,      total: totalContainers, percent: pct(privilegedCount, totalContainers) },
    hostNamespaces:         { count: hostNamespaceCount,   total: total,           percent: pct(hostNamespaceCount, total) },
    latestImageTag:         { count: latestTagCount,       total: totalContainers, percent: pct(latestTagCount, totalContainers) },
  };

  // Use AI for scoring, grading, and recommendations
  try {
    const response = await aiChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system' as const,
          content: `You are a Kubernetes security expert. Analyze the security posture of these workloads and provide a score (0-100), grade (A/B/C/D/F), and specific recommendations.

Return JSON with this exact shape:
{
  "score": <number 0-100>,
  "grade": "<A|B|C|D|F>",
  "recommendations": ["<string>", ...],
  "findings": [{ "category": "<string>", "status": "<string>", "details": "<string>" }, ...]
}

Base your assessment on the metrics provided. Higher runAsNonRoot, readOnlyRootFilesystem, and resourceLimits percentages are good. Privileged containers, host namespaces, and latest image tags are bad. Provide actionable, specific recommendations referencing actual counts.`,
        },
        {
          role: 'user' as const,
          content: JSON.stringify(sanitizeJsonForPrompt({
            totalWorkloads: total,
            totalContainers,
            metrics: {
              runAsNonRoot: { count: runAsNonRootCount, total: totalContainers, percent: metrics.runAsNonRoot.percent },
              readOnlyRootFilesystem: { count: readOnlyRootFsCount, total: totalContainers, percent: metrics.readOnlyRootFilesystem.percent },
              resourceLimitsDefined: { count: resourceLimitsCount, total: totalContainers, percent: metrics.resourceLimitsDefined.percent },
              privilegedContainers: { count: privilegedCount, total: totalContainers, percent: metrics.privilegedContainers.percent },
              hostNamespaces: { count: hostNamespaceCount, total, percent: metrics.hostNamespaces.percent },
              latestImageTag: { count: latestTagCount, total: totalContainers, percent: metrics.latestImageTag.percent },
            },
          })),
        },
      ],
    });

    const result = aiSecurityScoreSchema.safeParse(JSON.parse(response.choices[0].message.content ?? '{}'));
    if (!result.success) {
      console.warn('[security-scorer] AI response validation failed:', result.error.message);
      return {
        overallScore: 0,
        grade: 'F' as const,
        totalWorkloads: total,
        metrics,
        recommendations: ['Security analysis unavailable - AI response validation failed'],
      };
    }

    const { score, grade, recommendations } = result.data;
    const overallScore = Math.max(0, Math.min(100, Math.round(score)));

    return { overallScore, grade, totalWorkloads: total, metrics, recommendations };
  } catch (err) {
    console.warn('Security scorer AI call failed, returning safe defaults:', err);
    return {
      overallScore: 0,
      grade: 'F' as const,
      totalWorkloads: total,
      metrics,
      recommendations: ['Security analysis unavailable - AI service error'],
    };
  }
}
