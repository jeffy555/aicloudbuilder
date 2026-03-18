/**
 * Kubernetes Resource Rightsizing
 * Static rules that flag over/under-provisioned containers without AI calls.
 */

export type RightsizingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface K8sRightsizingRecommendation {
  workload: string;
  container: string;
  severity: RightsizingSeverity;
  rule: string;
  message: string;
  suggestion: string;
}

export interface K8sRightsizingResult {
  recommendations: K8sRightsizingRecommendation[];
  totalContainersAnalysed: number;
  totalWorkloadsAnalysed: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

// ─── Parsers (same as cost-estimator) ─────────────────────────────────────────

function parseCPU(cpu: string | undefined): number {
  if (!cpu) return 0;
  cpu = cpu.trim();
  if (cpu.endsWith('m')) return parseInt(cpu.slice(0, -1), 10);
  return Math.round(parseFloat(cpu) * 1000);
}

function parseMem(mem: string | undefined): number {
  if (!mem) return 0;
  mem = mem.trim();
  const n = parseFloat(mem);
  if (mem.endsWith('Ki')) return n / 1024;
  if (mem.endsWith('Mi')) return n;
  if (mem.endsWith('Gi')) return n * 1024;
  if (mem.endsWith('Ti')) return n * 1024 * 1024;
  if (mem.endsWith('K'))  return n / 1024;
  if (mem.endsWith('M'))  return n;
  if (mem.endsWith('G'))  return n * 1024;
  return n / (1024 * 1024);
}

interface ContainerRecord {
  workload: string;
  container: string;
  cpuRequest: number;   // millicores
  memRequest: number;   // MiB
  cpuLimit: number;
  memLimit: number;
  hasResources: boolean;
}

function extractContainerRecords(yamlContent: string): ContainerRecord[] {
  const results: ContainerRecord[] = [];
  const workloadKinds = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet'];
  const docs = yamlContent.split(/^---/m);

  for (const doc of docs) {
    if (!doc.trim()) continue;

    const kindMatch = doc.match(/^kind:\s*(\w+)/m);
    if (!kindMatch) continue;
    const kind = kindMatch[1];
    if (!workloadKinds.includes(kind)) continue;

    const nameMatch = doc.match(/^  name:\s*(.+)/m);
    const workloadName = nameMatch ? `${kind}/${nameMatch[1].trim()}` : kind;

    // Find all container entries (with or without resources block)
    const containerNameRegex = /- name:\s*(.+)/g;
    let nameM;
    const containerNames: string[] = [];
    while ((nameM = containerNameRegex.exec(doc)) !== null) {
      const candidate = nameM[1].trim();
      // Filter out obvious non-container names (namespaces, labels, etc.)
      if (!candidate.includes('/') && !candidate.includes(':')) {
        containerNames.push(candidate);
      }
    }

    const containerRegex = /- name:\s*(.+)\n([\s\S]*?)(?=\n\s{0,6}- name:|\n\s{0,4}[a-z]|\Z)/gm;
    let containerMatch;
    while ((containerMatch = containerRegex.exec(doc)) !== null) {
      const containerName = containerMatch[1].trim();
      const block = containerMatch[2] ?? '';

      const hasResourcesBlock = /resources\s*:/.test(block);
      const cpuReqMatch = block.match(/requests:[\s\S]*?cpu:\s*["']?([^\s'"]+)/);
      const memReqMatch = block.match(/requests:[\s\S]*?memory:\s*["']?([^\s'"]+)/);
      const cpuLimMatch = block.match(/limits:[\s\S]*?cpu:\s*["']?([^\s'"]+)/);
      const memLimMatch = block.match(/limits:[\s\S]*?memory:\s*["']?([^\s'"]+)/);

      results.push({
        workload: workloadName,
        container: containerName,
        cpuRequest: parseCPU(cpuReqMatch?.[1]),
        memRequest: parseMem(memReqMatch?.[1]),
        cpuLimit:   parseCPU(cpuLimMatch?.[1]),
        memLimit:   parseMem(memLimMatch?.[1]),
        hasResources: hasResourcesBlock,
      });
    }
  }

  return results;
}

// ─── Rule evaluators ───────────────────────────────────────────────────────────

function evaluate(c: ContainerRecord): K8sRightsizingRecommendation[] {
  const recs: K8sRightsizingRecommendation[] = [];
  const id = `${c.workload} / ${c.container}`;

  // Rule 1: No resource block at all
  if (!c.hasResources) {
    recs.push({
      workload: c.workload, container: c.container,
      severity: 'high', rule: 'missing-resources-block',
      message: `${id}: No resources block defined`,
      suggestion: 'Add a resources block with both requests and limits for cpu and memory.',
    });
    return recs; // further rules redundant without data
  }

  // Rule 2: Missing CPU request
  if (c.cpuRequest === 0) {
    recs.push({
      workload: c.workload, container: c.container,
      severity: 'high', rule: 'missing-cpu-request',
      message: `${id}: CPU request not set`,
      suggestion: 'Set resources.requests.cpu to the typical utilisation (e.g. "100m").',
    });
  }

  // Rule 3: Missing memory request
  if (c.memRequest === 0) {
    recs.push({
      workload: c.workload, container: c.container,
      severity: 'high', rule: 'missing-mem-request',
      message: `${id}: Memory request not set`,
      suggestion: 'Set resources.requests.memory to avoid OOM-kill on node pressure.',
    });
  }

  // Rule 4: Missing CPU limit
  if (c.cpuLimit === 0) {
    recs.push({
      workload: c.workload, container: c.container,
      severity: 'medium', rule: 'missing-cpu-limit',
      message: `${id}: CPU limit not set`,
      suggestion: 'Set resources.limits.cpu to prevent CPU starvation of neighbours.',
    });
  }

  // Rule 5: Missing memory limit
  if (c.memLimit === 0) {
    recs.push({
      workload: c.workload, container: c.container,
      severity: 'high', rule: 'missing-mem-limit',
      message: `${id}: Memory limit not set`,
      suggestion: 'Set resources.limits.memory to prevent unbounded memory growth.',
    });
  }

  // Rule 6: CPU request very high (> 2 vCPU / 2000m)
  if (c.cpuRequest > 2000) {
    recs.push({
      workload: c.workload, container: c.container,
      severity: 'medium', rule: 'high-cpu-request',
      message: `${id}: CPU request is ${c.cpuRequest}m (> 2 vCPU)`,
      suggestion: 'Verify this is intentional; most apps need < 500m. Oversized requests reduce scheduling density.',
    });
  }

  // Rule 7: Memory request very high (> 4 GiB)
  if (c.memRequest > 4096) {
    recs.push({
      workload: c.workload, container: c.container,
      severity: 'medium', rule: 'high-mem-request',
      message: `${id}: Memory request is ${Math.round(c.memRequest / 1024 * 100) / 100} GiB (> 4 GiB)`,
      suggestion: 'Verify this is intentional; large requests reduce bin-packing efficiency.',
    });
  }

  // Rule 8: CPU limit > 4× request (burst ratio)
  if (c.cpuRequest > 0 && c.cpuLimit > 0 && c.cpuLimit > c.cpuRequest * 4) {
    recs.push({
      workload: c.workload, container: c.container,
      severity: 'low', rule: 'cpu-limit-burst-ratio',
      message: `${id}: CPU limit (${c.cpuLimit}m) is ${Math.round(c.cpuLimit / c.cpuRequest)}× the request`,
      suggestion: 'Keep limit/request ratio ≤ 4× to reduce noisy-neighbour risk.',
    });
  }

  // Rule 9: Memory limit > 4× request
  if (c.memRequest > 0 && c.memLimit > 0 && c.memLimit > c.memRequest * 4) {
    recs.push({
      workload: c.workload, container: c.container,
      severity: 'low', rule: 'mem-limit-burst-ratio',
      message: `${id}: Memory limit (${Math.round(c.memLimit)}Mi) is ${Math.round(c.memLimit / c.memRequest)}× the request`,
      suggestion: 'Keep memory limit/request ratio ≤ 4× for predictable QoS class.',
    });
  }

  // Rule 10: CPU limit equals request exactly (Guaranteed QoS — possibly over-provisioned)
  if (c.cpuRequest > 0 && c.cpuLimit > 0 && c.cpuRequest === c.cpuLimit && c.cpuRequest > 500) {
    recs.push({
      workload: c.workload, container: c.container,
      severity: 'low', rule: 'guaranteed-qos-high-cpu',
      message: `${id}: CPU request === limit (${c.cpuLimit}m) creates Guaranteed QoS — potential waste`,
      suggestion: 'Consider lowering the request if average utilisation is < 50% of the limit.',
    });
  }

  return recs;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function generateK8sRightsizingRecommendations(
  yamlFiles: Array<{ fileName: string; content: string }>
): K8sRightsizingResult {
  const allContent = yamlFiles.map(f => f.content).join('\n---\n');
  const containers = extractContainerRecords(allContent);

  const allRecs: K8sRightsizingRecommendation[] = [];
  const seenWorkloads = new Set<string>();

  for (const c of containers) {
    seenWorkloads.add(c.workload);
    allRecs.push(...evaluate(c));
  }

  const criticalCount = allRecs.filter(r => r.severity === 'critical').length;
  const highCount     = allRecs.filter(r => r.severity === 'high').length;
  const mediumCount   = allRecs.filter(r => r.severity === 'medium').length;
  const lowCount      = allRecs.filter(r => r.severity === 'low').length;

  return {
    recommendations: allRecs.slice(0, 30), // cap to keep response size sane
    totalContainersAnalysed: containers.length,
    totalWorkloadsAnalysed: seenWorkloads.size,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
  };
}
