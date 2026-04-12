/**
 * Kubernetes Resource Rightsizing
 * Uses GPT-4o-mini to analyze container resource specs and identify rightsizing opportunities.
 */
import { aiChatCompletion } from '../utils/ai-client.js';

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

// ─── AI-driven evaluation ───────────────────────────────────────────────────

async function evaluateWithAI(containers: ContainerRecord[]): Promise<K8sRightsizingRecommendation[]> {
  if (containers.length === 0) return [];

  const containerSpecs = containers.map(c => ({
    workload: c.workload,
    container: c.container,
    cpuRequestMillicores: c.cpuRequest,
    memRequestMiB: Math.round(c.memRequest * 100) / 100,
    cpuLimitMillicores: c.cpuLimit,
    memLimitMiB: Math.round(c.memLimit * 100) / 100,
    hasResourcesBlock: c.hasResources,
  }));

  try {
    const response = await aiChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system' as const,
          content: `You are a Kubernetes resource optimization expert. Analyze these container resource specifications and identify rightsizing opportunities. Consider over-provisioning, missing limits, burst ratios, QoS class implications, and bin-packing efficiency.

Return JSON with this exact shape:
{
  "recommendations": [
    {
      "workload": "<workload name from input>",
      "container": "<container name from input>",
      "severity": "<critical|high|medium|low>",
      "rule": "<short-kebab-case-rule-id>",
      "message": "<description of the issue>",
      "suggestion": "<actionable fix>"
    }
  ]
}

Only include recommendations where there is a genuine issue. If a container's resources look well-configured, do not generate a recommendation for it. Cap output to at most 30 recommendations, prioritizing higher severity items.`,
        },
        {
          role: 'user' as const,
          content: JSON.stringify({ containers: containerSpecs }),
        },
      ],
    });

    const parsed = JSON.parse(response.choices[0].message.content ?? '{}');
    if (!Array.isArray(parsed.recommendations)) return [];

    const validSeverities = new Set(['critical', 'high', 'medium', 'low']);
    return parsed.recommendations
      .filter((r: any) => r && typeof r.workload === 'string' && typeof r.container === 'string')
      .map((r: any) => ({
        workload: String(r.workload),
        container: String(r.container),
        severity: (validSeverities.has(r.severity) ? r.severity : 'medium') as RightsizingSeverity,
        rule: String(r.rule || 'ai-recommendation'),
        message: String(r.message || ''),
        suggestion: String(r.suggestion || ''),
      }));
  } catch (err) {
    console.warn('Resource rightsizing AI call failed, returning empty recommendations:', err);
    return [];
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function generateK8sRightsizingRecommendations(
  yamlFiles: Array<{ fileName: string; content: string }>
): Promise<K8sRightsizingResult> {
  const allContent = yamlFiles.map(f => f.content).join('\n---\n');
  const containers = extractContainerRecords(allContent);

  const seenWorkloads = new Set<string>();
  for (const c of containers) {
    seenWorkloads.add(c.workload);
  }

  const allRecs = await evaluateWithAI(containers);

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
