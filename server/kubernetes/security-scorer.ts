/**
 * Security Context Scorer
 * Analyses Kubernetes YAML manifests and produces a consolidated security score.
 */
import yaml from 'js-yaml';

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
export function scoreSecurityContexts(manifests: string[]): SecurityScoreResult {
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

  // Weighted score: positive metrics (max 70pts) - penalties (max -30pts)
  const positiveScore =
    metrics.runAsNonRoot.percent * 0.25 +
    metrics.readOnlyRootFilesystem.percent * 0.20 +
    metrics.resourceLimitsDefined.percent * 0.25;

  const penaltyScore =
    (privilegedCount > 0 ? 20 : 0) +
    (hostNamespaceCount > 0 ? 10 : 0) +
    (metrics.latestImageTag.percent > 50 ? 5 : 0);

  const overallScore = Math.max(0, Math.min(100, Math.round(positiveScore) - penaltyScore + 30));

  const grade: SecurityScoreResult['grade'] =
    overallScore >= 90 ? 'A' :
    overallScore >= 75 ? 'B' :
    overallScore >= 60 ? 'C' :
    overallScore >= 45 ? 'D' : 'F';

  // Generate targeted recommendations
  const recommendations: string[] = [];
  if (metrics.runAsNonRoot.percent < 100) {
    recommendations.push(`Set securityContext.runAsNonRoot: true on ${totalContainers - runAsNonRootCount} container(s).`);
  }
  if (metrics.readOnlyRootFilesystem.percent < 100) {
    recommendations.push(`Set securityContext.readOnlyRootFilesystem: true on ${totalContainers - readOnlyRootFsCount} container(s).`);
  }
  if (metrics.resourceLimitsDefined.percent < 100) {
    recommendations.push(`Add CPU/memory limits to ${totalContainers - resourceLimitsCount} container(s).`);
  }
  if (privilegedCount > 0) {
    recommendations.push(`Remove privileged: true from ${privilegedCount} container(s) — this is a critical risk.`);
  }
  if (hostNamespaceCount > 0) {
    recommendations.push(`Disable hostPID/hostIPC/hostNetwork on ${hostNamespaceCount} workload(s).`);
  }
  if (latestTagCount > 0) {
    recommendations.push(`Pin image tags (avoid :latest) on ${latestTagCount} container(s).`);
  }

  return { overallScore, grade, totalWorkloads: total, metrics, recommendations };
}
