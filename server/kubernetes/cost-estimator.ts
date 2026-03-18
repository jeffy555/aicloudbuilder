/**
 * Kubernetes resource cost estimator
 * Parses container resource requests/limits from YAML manifests
 * and estimates monthly cloud costs using generic per-resource rates.
 */

export interface ContainerResources {
  workload: string;
  namespace: string;
  container: string;
  cpuRequest: number;   // in millicores (m)
  memRequest: number;   // in MiB
  cpuLimit: number;
  memLimit: number;
}

export interface K8sCostBreakdown {
  workload: string;
  container: string;
  cpuRequestCores: number;
  memRequestGiB: number;
  monthlyCPUCost: number;
  monthlyMemCost: number;
  monthlyTotal: number;
}

export interface K8sCostResult {
  breakdown: K8sCostBreakdown[];
  totalMonthlyCost: number;
  totalYearlyCost: number;
  currency: string;
  totalContainers: number;
  totalWorkloads: number;
  recommendations: string[];
}

// Generic public cloud rates (blended average AWS/Azure/GCP on-demand)
const CPU_COST_PER_CORE_PER_HOUR = 0.048;   // $/vCPU/hr
const MEM_COST_PER_GIB_PER_HOUR  = 0.006;   // $/GiB/hr
const HOURS_PER_MONTH = 730;

/** Parse a Kubernetes CPU string to millicores */
function parseCPU(cpu: string | undefined): number {
  if (!cpu) return 0;
  cpu = cpu.trim();
  if (cpu.endsWith('m')) return parseInt(cpu.slice(0, -1), 10);
  return Math.round(parseFloat(cpu) * 1000);
}

/** Parse a Kubernetes memory string to MiB */
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
  return n / (1024 * 1024); // bytes → MiB
}

/** Extract workloads from YAML content using regex */
function extractWorkloads(yamlContent: string): ContainerResources[] {
  const results: ContainerResources[] = [];

  // Match resource blocks: kind + name + containers
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

    // Find all container resource blocks
    const containerRegex = /- name:\s*(.+)\n(?:[\s\S]*?resources:\s*\n([\s\S]*?)(?=\n\s{0,6}- name:|\n\s{0,4}[a-z]|\Z))/gm;
    let containerMatch;
    while ((containerMatch = containerRegex.exec(doc)) !== null) {
      const containerName = containerMatch[1].trim();
      const resourceBlock = containerMatch[2] ?? '';

      const cpuReqMatch = resourceBlock.match(/requests:[\s\S]*?cpu:\s*["']?([^\s'"]+)/);
      const memReqMatch = resourceBlock.match(/requests:[\s\S]*?memory:\s*["']?([^\s'"]+)/);
      const cpuLimMatch = resourceBlock.match(/limits:[\s\S]*?cpu:\s*["']?([^\s'"]+)/);
      const memLimMatch = resourceBlock.match(/limits:[\s\S]*?memory:\s*["']?([^\s'"]+)/);

      results.push({
        workload: workloadName,
        namespace: 'default',
        container: containerName,
        cpuRequest: parseCPU(cpuReqMatch?.[1]),
        memRequest: parseMem(memReqMatch?.[1]),
        cpuLimit: parseCPU(cpuLimMatch?.[1]),
        memLimit: parseMem(memLimMatch?.[1]),
      });
    }
  }

  return results;
}

export function estimateKubernetesCost(yamlFiles: Array<{ fileName: string; content: string }>): K8sCostResult {
  const allContent = yamlFiles.map(f => f.content).join('\n---\n');
  const containers = extractWorkloads(allContent);

  const breakdown: K8sCostBreakdown[] = [];
  const recommendations: string[] = [];
  const seenWorkloads = new Set<string>();

  for (const c of containers) {
    seenWorkloads.add(c.workload);
    const cpuCores = (c.cpuRequest || c.cpuLimit || 100) / 1000;
    const memGiB   = ((c.memRequest || c.memLimit || 128) / 1024);

    const monthlyCPU = cpuCores * CPU_COST_PER_CORE_PER_HOUR * HOURS_PER_MONTH;
    const monthlyMem = memGiB  * MEM_COST_PER_GIB_PER_HOUR  * HOURS_PER_MONTH;

    breakdown.push({
      workload: c.workload,
      container: c.container,
      cpuRequestCores: Math.round(cpuCores * 1000) / 1000,
      memRequestGiB:   Math.round(memGiB  * 100)  / 100,
      monthlyCPUCost:  Math.round(monthlyCPU * 100) / 100,
      monthlyMemCost:  Math.round(monthlyMem * 100) / 100,
      monthlyTotal:    Math.round((monthlyCPU + monthlyMem) * 100) / 100,
    });

    // Rightsizing hints
    if (c.cpuRequest === 0) recommendations.push(`${c.workload}/${c.container}: No CPU request set — pod can be scheduled on overcommitted nodes.`);
    if (c.memRequest === 0) recommendations.push(`${c.workload}/${c.container}: No memory request set — pod may be OOM-killed.`);
    if (c.cpuLimit > 0 && c.cpuRequest > 0 && c.cpuLimit > c.cpuRequest * 4) {
      recommendations.push(`${c.workload}/${c.container}: CPU limit is >4× request — consider tightening limits.`);
    }
    if (c.memLimit > 0 && c.memRequest > 0 && c.memLimit > c.memRequest * 4) {
      recommendations.push(`${c.workload}/${c.container}: Memory limit is >4× request — consider tightening limits.`);
    }
  }

  const totalMonthly = breakdown.reduce((s, b) => s + b.monthlyTotal, 0);

  return {
    breakdown,
    totalMonthlyCost: Math.round(totalMonthly * 100) / 100,
    totalYearlyCost:  Math.round(totalMonthly * 12 * 100) / 100,
    currency: 'USD',
    totalContainers: containers.length,
    totalWorkloads:  seenWorkloads.size,
    recommendations: recommendations.slice(0, 10),
  };
}
