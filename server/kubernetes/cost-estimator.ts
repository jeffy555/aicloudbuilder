/**
 * Kubernetes resource cost estimator
 * Parses container resource requests/limits from YAML manifests
 * and uses GPT-4o-mini to estimate monthly cloud costs.
 */
import { aiChatCompletion } from '../utils/ai-client.js';
import { z } from 'zod';
import { sanitizeJsonForPrompt } from '../utils/sanitize-prompt.js';

// ─── Zod schemas for AI response validation ─────────────────────────────────

const aiCostWorkloadSchema = z.object({
  workload: z.string().catch(''),
  container: z.string().catch(''),
  cpuRequestCores: z.number().catch(0),
  memRequestGiB: z.number().catch(0),
  monthlyCPUCost: z.number().catch(0),
  monthlyMemCost: z.number().catch(0),
  monthlyTotal: z.number().catch(0),
});
const aiCostResponseSchema = z.object({
  workloads: z.array(aiCostWorkloadSchema).catch([]),
  totalMonthly: z.number().catch(0),
  totalAnnual: z.number().catch(0),
  recommendations: z.array(z.string()).catch([]),
});

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

export async function estimateKubernetesCost(yamlFiles: Array<{ fileName: string; content: string }>): Promise<K8sCostResult> {
  const allContent = yamlFiles.map(f => f.content).join('\n---\n');
  const containers = extractWorkloads(allContent);

  const seenWorkloads = new Set<string>();
  const workloadSpecs = containers.map(c => {
    seenWorkloads.add(c.workload);
    return {
      workload: c.workload,
      container: c.container,
      cpuRequestMillicores: c.cpuRequest,
      cpuLimitMillicores: c.cpuLimit,
      memRequestMiB: Math.round(c.memRequest * 100) / 100,
      memLimitMiB: Math.round(c.memLimit * 100) / 100,
    };
  });

  try {
    const response = await aiChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system' as const,
          content: `You are a cloud cost estimation expert. Given these Kubernetes workload specifications (CPU requests/limits, memory requests/limits, replica counts), estimate the monthly cloud cost. Consider typical on-demand pricing across major cloud providers. Return itemized costs per workload.

Return JSON with this exact shape:
{
  "workloads": [
    {
      "workload": "<workload name from input>",
      "container": "<container name from input>",
      "cpuRequestCores": <number>,
      "memRequestGiB": <number>,
      "monthlyCPUCost": <number in USD>,
      "monthlyMemCost": <number in USD>,
      "monthlyTotal": <number in USD>
    }
  ],
  "totalMonthly": <number in USD>,
  "totalAnnual": <number in USD>,
  "recommendations": ["<string>", ...]
}

For containers with 0 CPU/memory requests, use the limit value if available, otherwise assume minimal resources (e.g. 100m CPU, 128Mi memory) for cost estimation. Base pricing on typical blended on-demand rates across AWS, Azure, and GCP. Round all costs to 2 decimal places.`,
        },
        {
          role: 'user' as const,
          content: JSON.stringify(sanitizeJsonForPrompt({ containers: workloadSpecs })),
        },
      ],
    });

    const result = aiCostResponseSchema.safeParse(JSON.parse(response.choices[0].message.content ?? '{}'));
    if (!result.success) {
      console.warn('[cost-estimator] AI response validation failed:', result.error.message);
      throw new Error('AI response validation failed');
    }

    const parsed = result.data;

    const breakdown: K8sCostBreakdown[] = parsed.workloads.map(w => ({
      workload: w.workload,
      container: w.container,
      cpuRequestCores: Math.round(w.cpuRequestCores * 1000) / 1000,
      memRequestGiB: Math.round(w.memRequestGiB * 100) / 100,
      monthlyCPUCost: Math.round(w.monthlyCPUCost * 100) / 100,
      monthlyMemCost: Math.round(w.monthlyMemCost * 100) / 100,
      monthlyTotal: Math.round(w.monthlyTotal * 100) / 100,
    }));

    const totalMonthly = parsed.totalMonthly || breakdown.reduce((s, b) => s + b.monthlyTotal, 0);
    const totalYearly = parsed.totalAnnual || totalMonthly * 12;
    const recommendations = parsed.recommendations;

    return {
      breakdown,
      totalMonthlyCost: Math.round(totalMonthly * 100) / 100,
      totalYearlyCost: Math.round(totalYearly * 100) / 100,
      currency: 'USD',
      totalContainers: containers.length,
      totalWorkloads: seenWorkloads.size,
      recommendations: recommendations.slice(0, 10),
    };
  } catch (err) {
    console.warn('Cost estimator AI call failed, returning zero costs:', err);

    // Return zero costs with warning
    const breakdown: K8sCostBreakdown[] = containers.map(c => ({
      workload: c.workload,
      container: c.container,
      cpuRequestCores: c.cpuRequest / 1000,
      memRequestGiB: c.memRequest / 1024,
      monthlyCPUCost: 0,
      monthlyMemCost: 0,
      monthlyTotal: 0,
    }));

    return {
      breakdown,
      totalMonthlyCost: 0,
      totalYearlyCost: 0,
      currency: 'USD',
      totalContainers: containers.length,
      totalWorkloads: seenWorkloads.size,
      recommendations: ['Cost estimation unavailable - AI service error'],
    };
  }
}
