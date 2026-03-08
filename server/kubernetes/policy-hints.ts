/**
 * OPA / Kyverno Policy Hints
 * Static library of common Kubernetes policy rules with remediation guidance.
 */
import yaml from 'js-yaml';

export interface PolicyHint {
  id: string;
  engine: 'kyverno' | 'opa';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  remediation: string;
  affectedKinds: string[];
  docsUrl?: string;
}

export interface PolicyCheckResult {
  hint: PolicyHint;
  violations: Array<{ resource: string; kind: string; reason: string }>;
}

// ─── Static Policy Library ───────────────────────────────────────────────────

export const POLICY_HINTS: PolicyHint[] = [
  {
    id: 'kyverno-require-labels',
    engine: 'kyverno',
    severity: 'medium',
    title: 'Workloads must have owner and env labels',
    description: 'All workload resources should declare owner and env labels for governance and cost attribution.',
    remediation: 'Add `labels: { owner: <team>, env: <environment> }` to spec.template.metadata.labels.',
    affectedKinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'],
  },
  {
    id: 'kyverno-disallow-latest-tag',
    engine: 'kyverno',
    severity: 'high',
    title: 'Container images must not use :latest tag',
    description: 'Using :latest prevents reproducible deployments and makes rollbacks unreliable.',
    remediation: 'Pin image tags to a specific version: e.g., `nginx:1.25.3` instead of `nginx:latest`.',
    affectedKinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'Job', 'CronJob'],
  },
  {
    id: 'kyverno-require-resource-limits',
    engine: 'kyverno',
    severity: 'high',
    title: 'All containers must specify CPU and memory limits',
    description: 'Missing resource limits can lead to resource contention and noisy-neighbour problems.',
    remediation: 'Set `resources.limits.cpu` and `resources.limits.memory` on every container spec.',
    affectedKinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'Job', 'CronJob'],
  },
  {
    id: 'opa-privileged-containers',
    engine: 'opa',
    severity: 'critical',
    title: 'Privileged containers are not allowed',
    description: 'Privileged containers bypass most container isolation and gain full access to the host.',
    remediation: 'Set `securityContext.privileged: false` or omit the field (defaults to false).',
    affectedKinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'Job', 'CronJob'],
  },
  {
    id: 'opa-host-namespaces',
    engine: 'opa',
    severity: 'critical',
    title: 'Host namespaces (hostPID/hostIPC/hostNetwork) must not be enabled',
    description: 'Sharing host namespaces breaks container isolation and is a major security risk.',
    remediation: 'Ensure `spec.hostPID`, `spec.hostIPC`, and `spec.hostNetwork` are all `false` or absent.',
    affectedKinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod'],
  },
  {
    id: 'kyverno-disallow-root-user',
    engine: 'kyverno',
    severity: 'high',
    title: 'Containers must not run as root (UID 0)',
    description: 'Running as root inside a container increases the blast radius of a container escape.',
    remediation: 'Set `securityContext.runAsNonRoot: true` and `securityContext.runAsUser: <uid>` (≥ 1000).',
    affectedKinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'Job', 'CronJob'],
  },
  {
    id: 'kyverno-readonly-root-fs',
    engine: 'kyverno',
    severity: 'medium',
    title: 'Containers should use a read-only root filesystem',
    description: 'A writable root filesystem allows attackers to persist changes after a container restart.',
    remediation: 'Set `securityContext.readOnlyRootFilesystem: true` on container specs.',
    affectedKinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'Job', 'CronJob'],
  },
  {
    id: 'opa-no-default-service-account',
    engine: 'opa',
    severity: 'medium',
    title: 'Pods should not use the default service account',
    description: 'The default service account often has overly broad permissions. Use dedicated service accounts.',
    remediation: 'Set `spec.serviceAccountName` to a dedicated account and set `automountServiceAccountToken: false` when possible.',
    affectedKinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod'],
  },
];

// ─── Policy Checker ───────────────────────────────────────────────────────────

/**
 * Run all policy hints against a list of YAML manifest strings.
 * Returns results only for policies that have at least one violation.
 */
export function checkPolicyHints(manifests: string[]): PolicyCheckResult[] {
  const results: PolicyCheckResult[] = [];

  for (const hint of POLICY_HINTS) {
    const violations: PolicyCheckResult['violations'] = [];

    for (const manifestYAML of manifests) {
      try {
        const docs = manifestYAML.split(/^---\s*$/m).filter(s => s.trim());
        for (const doc of docs) {
          const parsed = yaml.load(doc) as any;
          if (!parsed?.kind || !hint.affectedKinds.includes(parsed.kind)) continue;
          const resourceName = `${parsed.kind}/${parsed.metadata?.name ?? '?'}`;
          const violation = evaluatePolicy(hint.id, parsed, resourceName);
          if (violation) violations.push(violation);
        }
      } catch {
        // skip unparseable
      }
    }

    if (violations.length > 0) {
      results.push({ hint, violations });
    }
  }

  return results;
}

// ─── Per-Policy Evaluators ────────────────────────────────────────────────────

function evaluatePolicy(
  policyId: string,
  resource: any,
  resourceName: string
): { resource: string; kind: string; reason: string } | null {
  const kind: string = resource.kind;
  const spec = resource.spec ?? {};
  const podSpec: any =
    spec.template?.spec ??     // Deployment / StatefulSet / DaemonSet / Job / CronJob
    spec.jobTemplate?.spec?.template?.spec ??  // CronJob
    (kind === 'Pod' ? spec : null);

  if (!podSpec && policyId !== 'opa-host-namespaces' && policyId !== 'kyverno-require-labels') {
    return null; // no pod spec to check
  }

  switch (policyId) {
    case 'kyverno-require-labels': {
      const labels: Record<string, string> = spec.template?.metadata?.labels ?? resource.metadata?.labels ?? {};
      if (!labels.owner || !labels.env) {
        const missing = [!labels.owner && 'owner', !labels.env && 'env'].filter(Boolean).join(', ');
        return { resource: resourceName, kind, reason: `Missing labels: ${missing}` };
      }
      break;
    }

    case 'kyverno-disallow-latest-tag': {
      const containers: any[] = [
        ...(podSpec?.containers ?? []),
        ...(podSpec?.initContainers ?? []),
      ];
      for (const c of containers) {
        const image: string = c.image ?? '';
        if (!image || image.endsWith(':latest') || !image.includes(':')) {
          return { resource: resourceName, kind, reason: `Container "${c.name}" uses latest/untagged image: ${image}` };
        }
      }
      break;
    }

    case 'kyverno-require-resource-limits': {
      const containers: any[] = podSpec?.containers ?? [];
      for (const c of containers) {
        if (!c.resources?.limits?.cpu || !c.resources?.limits?.memory) {
          return { resource: resourceName, kind, reason: `Container "${c.name}" missing CPU/memory limits` };
        }
      }
      break;
    }

    case 'opa-privileged-containers': {
      const containers: any[] = [
        ...(podSpec?.containers ?? []),
        ...(podSpec?.initContainers ?? []),
      ];
      for (const c of containers) {
        if (c.securityContext?.privileged === true) {
          return { resource: resourceName, kind, reason: `Container "${c.name}" runs as privileged` };
        }
      }
      break;
    }

    case 'opa-host-namespaces': {
      const s = kind === 'Pod' ? spec : spec.template?.spec ?? {};
      if (s.hostPID || s.hostIPC || s.hostNetwork) {
        const enabled = [s.hostPID && 'hostPID', s.hostIPC && 'hostIPC', s.hostNetwork && 'hostNetwork'].filter(Boolean).join(', ');
        return { resource: resourceName, kind, reason: `Host namespaces enabled: ${enabled}` };
      }
      break;
    }

    case 'kyverno-disallow-root-user': {
      const containers: any[] = podSpec?.containers ?? [];
      for (const c of containers) {
        const runAsNonRoot = c.securityContext?.runAsNonRoot ?? podSpec?.securityContext?.runAsNonRoot;
        const runAsUser = c.securityContext?.runAsUser ?? podSpec?.securityContext?.runAsUser;
        if (runAsNonRoot === false || runAsUser === 0) {
          return { resource: resourceName, kind, reason: `Container "${c.name}" explicitly runs as root` };
        }
        if (runAsNonRoot === undefined && runAsUser === undefined) {
          return { resource: resourceName, kind, reason: `Container "${c.name}" does not set runAsNonRoot or runAsUser` };
        }
      }
      break;
    }

    case 'kyverno-readonly-root-fs': {
      const containers: any[] = podSpec?.containers ?? [];
      for (const c of containers) {
        if (c.securityContext?.readOnlyRootFilesystem !== true) {
          return { resource: resourceName, kind, reason: `Container "${c.name}" does not set readOnlyRootFilesystem: true` };
        }
      }
      break;
    }

    case 'opa-no-default-service-account': {
      const sa: string = podSpec?.serviceAccountName ?? 'default';
      if (sa === 'default') {
        return { resource: resourceName, kind, reason: 'Using default service account' };
      }
      break;
    }
  }

  return null;
}
