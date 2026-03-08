/**
 * Terraform Rightsizing Recommendations
 *
 * Analyses Terraform HCL files (from a session) to identify over-provisioned
 * resources and suggests cost-optimised alternatives based on static rules.
 *
 * Design decisions:
 *  - Uses a lightweight regex HCL extractor (not a full parser). Sufficient for
 *    the top-level and single-nested string attributes we care about.
 *  - Rules are purely static (no external API calls). This keeps latency <1 ms
 *    and avoids credential requirements.
 *  - If a monthly cost map is supplied (from an earlier cost-analysis pass),
 *    estimated dollar savings are attached to each recommendation.
 */

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface RightsizingRecommendation {
  /** Full Terraform address, e.g. "azurerm_linux_virtual_machine.app" */
  address: string;
  resourceType: string;
  resourceName: string;
  /** The HCL attribute that holds the SKU / size, e.g. "size" */
  attribute: string;
  /** Value currently in the .tf file, e.g. "Standard_D4s_v3" */
  currentValue: string;
  /** Recommended replacement value */
  suggestedValue: string;
  /** Human-friendly label for the current value */
  currentLabel: string;
  /** Human-friendly label for the suggested value */
  suggestedLabel: string;
  /** Percentage of monthly cost saved by switching */
  estimatedSavingPercent: number;
  /** Dollar saving per month (populated when costsByAddr is supplied) */
  estimatedMonthlySaving?: number;
  /** One-sentence explanation for the recommendation */
  rationale: string;
  /** Operational risk of applying this change */
  risk: 'low' | 'medium' | 'high';
}

export interface RightsizingResult {
  recommendations: RightsizingRecommendation[];
  totalRecommendations: number;
  totalEstimatedMonthlySaving: number;
  resourcesAnalysed: number;
}

// ─── Internal rule table ──────────────────────────────────────────────────────

interface RightsizingRule {
  resourceTypes: string[];
  /** Ordered list of attribute names to check — first match wins */
  attributes: string[];
  /** Regex matched against the attribute value */
  pattern: RegExp;
  currentLabel: string;
  /** Use $1 to reference the first capture group from pattern */
  suggestedValue: string;
  suggestedLabel: string;
  savingPercent: number;
  rationale: string;
  risk: 'low' | 'medium' | 'high';
}

const VM_TYPES = [
  'azurerm_linux_virtual_machine',
  'azurerm_windows_virtual_machine',
  'azurerm_virtual_machine',
];

const RULES: RightsizingRule[] = [
  // ── Azure VMs (D-series v3) ───────────────────────────────────────────────
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_D16s?_v3$/i,
    currentLabel: 'Standard_D16s_v3 (16 vCPUs, 64 GB)',
    suggestedValue: 'Standard_D8s_v3',
    suggestedLabel: 'Standard_D8s_v3 (8 vCPUs, 32 GB)',
    savingPercent: 50,
    rationale: 'Halving vCPUs reduces cost ~50%. Apply only when average CPU utilisation stays below 40%.',
    risk: 'medium',
  },
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_D8s?_v3$/i,
    currentLabel: 'Standard_D8s_v3 (8 vCPUs, 32 GB)',
    suggestedValue: 'Standard_D4s_v3',
    suggestedLabel: 'Standard_D4s_v3 (4 vCPUs, 16 GB)',
    savingPercent: 50,
    rationale: 'Halving vCPUs reduces cost ~50%. Recommended when average CPU stays below 40%.',
    risk: 'medium',
  },
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_D4s?_v3$/i,
    currentLabel: 'Standard_D4s_v3 (4 vCPUs, 16 GB)',
    suggestedValue: 'Standard_D2s_v3',
    suggestedLabel: 'Standard_D2s_v3 (2 vCPUs, 8 GB)',
    savingPercent: 50,
    rationale: 'Suitable for light workloads. Verify peak CPU does not exceed 60% before downsizing.',
    risk: 'medium',
  },
  // ── Azure VMs (D-series v4 / v5) ─────────────────────────────────────────
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_D8_?v4$/i,
    currentLabel: 'Standard_D8_v4 (8 vCPUs, 32 GB)',
    suggestedValue: 'Standard_D4_v4',
    suggestedLabel: 'Standard_D4_v4 (4 vCPUs, 16 GB)',
    savingPercent: 50,
    rationale: 'Same generation step-down at ~50% cost reduction.',
    risk: 'medium',
  },
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_D4_?v4$/i,
    currentLabel: 'Standard_D4_v4 (4 vCPUs, 16 GB)',
    suggestedValue: 'Standard_D2_v4',
    suggestedLabel: 'Standard_D2_v4 (2 vCPUs, 8 GB)',
    savingPercent: 50,
    rationale: 'Same generation, half the compute at ~50% cost.',
    risk: 'medium',
  },
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_D8_?v5$/i,
    currentLabel: 'Standard_D8_v5 (8 vCPUs, 32 GB)',
    suggestedValue: 'Standard_D4_v5',
    suggestedLabel: 'Standard_D4_v5 (4 vCPUs, 16 GB)',
    savingPercent: 50,
    rationale: 'Same generation step-down at ~50% cost reduction.',
    risk: 'medium',
  },
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_D4_?v5$/i,
    currentLabel: 'Standard_D4_v5 (4 vCPUs, 16 GB)',
    suggestedValue: 'Standard_D2_v5',
    suggestedLabel: 'Standard_D2_v5 (2 vCPUs, 8 GB)',
    savingPercent: 50,
    rationale: 'Same generation, half the compute at ~50% cost.',
    risk: 'medium',
  },
  // ── Azure VMs (E-series → D-series) ──────────────────────────────────────
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_E4s?_v3$/i,
    currentLabel: 'Standard_E4s_v3 (memory-optimised, 4 vCPUs, 32 GB)',
    suggestedValue: 'Standard_D4s_v3',
    suggestedLabel: 'Standard_D4s_v3 (general purpose, 4 vCPUs, 16 GB)',
    savingPercent: 20,
    rationale: 'E-series costs ~20-25% more than D-series. Switch unless the workload genuinely needs >8 GB RAM per vCPU.',
    risk: 'medium',
  },
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_E8s?_v3$/i,
    currentLabel: 'Standard_E8s_v3 (memory-optimised, 8 vCPUs, 64 GB)',
    suggestedValue: 'Standard_D8s_v3',
    suggestedLabel: 'Standard_D8s_v3 (general purpose, 8 vCPUs, 32 GB)',
    savingPercent: 20,
    rationale: 'E-series costs ~20-25% more than D-series. Switch unless the workload genuinely needs >8 GB RAM per vCPU.',
    risk: 'medium',
  },
  // ── Azure VMs (F-series compute-optimised) ────────────────────────────────
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_F8s?_v2$/i,
    currentLabel: 'Standard_F8s_v2 (8 vCPUs, compute-opt)',
    suggestedValue: 'Standard_F4s_v2',
    suggestedLabel: 'Standard_F4s_v2 (4 vCPUs, compute-opt)',
    savingPercent: 50,
    rationale: 'Halving vCPUs on F-series saves ~50%. F-series is justified only for sustained CPU-bound workloads.',
    risk: 'medium',
  },
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_F4s?_v2$/i,
    currentLabel: 'Standard_F4s_v2 (4 vCPUs, compute-opt)',
    suggestedValue: 'Standard_F2s_v2',
    suggestedLabel: 'Standard_F2s_v2 (2 vCPUs, compute-opt)',
    savingPercent: 50,
    rationale: 'Halving vCPUs saves ~50%. Verify the workload is genuinely CPU-bound before choosing F-series.',
    risk: 'medium',
  },
  // ── Azure VMs (B-series burstable) ────────────────────────────────────────
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_B4ms$/i,
    currentLabel: 'Standard_B4ms (burstable, 4 vCPUs, 16 GB)',
    suggestedValue: 'Standard_B2ms',
    suggestedLabel: 'Standard_B2ms (burstable, 2 vCPUs, 8 GB)',
    savingPercent: 50,
    rationale: 'B-series is cost-effective for low-average-CPU workloads. The burstable model is preserved at B2ms.',
    risk: 'low',
  },
  {
    resourceTypes: VM_TYPES,
    attributes: ['size'],
    pattern: /^Standard_B8ms$/i,
    currentLabel: 'Standard_B8ms (burstable, 8 vCPUs, 32 GB)',
    suggestedValue: 'Standard_B4ms',
    suggestedLabel: 'Standard_B4ms (burstable, 4 vCPUs, 16 GB)',
    savingPercent: 50,
    rationale: 'B-series: halving size saves ~50% while keeping the burstable cost model.',
    risk: 'low',
  },

  // ── App Service Plans ─────────────────────────────────────────────────────
  {
    resourceTypes: ['azurerm_service_plan', 'azurerm_app_service_plan'],
    attributes: ['sku_name', 'sku'],
    pattern: /^P3v3$/i,
    currentLabel: 'Premium v3 P3 (4 vCPUs)',
    suggestedValue: 'P2v3',
    suggestedLabel: 'Premium v3 P2 (2 vCPUs)',
    savingPercent: 35,
    rationale: 'P2v3 retains all Premium v3 features (VNet, zone redundancy) at ~35% lower cost.',
    risk: 'low',
  },
  {
    resourceTypes: ['azurerm_service_plan', 'azurerm_app_service_plan'],
    attributes: ['sku_name', 'sku'],
    pattern: /^P2v3$/i,
    currentLabel: 'Premium v3 P2 (2 vCPUs)',
    suggestedValue: 'P1v3',
    suggestedLabel: 'Premium v3 P1 (1 vCPU)',
    savingPercent: 35,
    rationale: 'P1v3 retains all Premium v3 features. Sufficient for most apps under moderate load.',
    risk: 'low',
  },
  {
    resourceTypes: ['azurerm_service_plan', 'azurerm_app_service_plan'],
    attributes: ['sku_name', 'sku'],
    pattern: /^S3$/i,
    currentLabel: 'Standard S3 (4 vCPUs)',
    suggestedValue: 'S2',
    suggestedLabel: 'Standard S2 (2 vCPUs)',
    savingPercent: 33,
    rationale: 'S2 is a direct step-down in Standard tier with no feature loss.',
    risk: 'low',
  },
  {
    resourceTypes: ['azurerm_service_plan', 'azurerm_app_service_plan'],
    attributes: ['sku_name', 'sku'],
    pattern: /^S2$/i,
    currentLabel: 'Standard S2 (2 vCPUs)',
    suggestedValue: 'S1',
    suggestedLabel: 'Standard S1 (1 vCPU)',
    savingPercent: 33,
    rationale: 'S1 is adequate for single-instance apps with low to moderate traffic.',
    risk: 'low',
  },
  {
    resourceTypes: ['azurerm_service_plan', 'azurerm_app_service_plan'],
    attributes: ['sku_name', 'sku'],
    pattern: /^P2v2$/i,
    currentLabel: 'Premium v2 P2 (older generation)',
    suggestedValue: 'P1v3',
    suggestedLabel: 'Premium v3 P1 (newer generation, comparable perf)',
    savingPercent: 20,
    rationale: 'Premium v3 delivers better performance per dollar than Premium v2. P1v3 ≈ P2v2 in throughput.',
    risk: 'low',
  },

  // ── Azure SQL Database ────────────────────────────────────────────────────
  {
    resourceTypes: ['azurerm_mssql_database'],
    attributes: ['sku_name'],
    pattern: /^BC_Gen5_(\d+)$/i,
    currentLabel: 'Business Critical Gen5 (local SSD + HA replica)',
    suggestedValue: 'GP_Gen5_$1',
    suggestedLabel: 'General Purpose Gen5 (same vCores, no HA replica)',
    savingPercent: 45,
    rationale: 'Business Critical adds a local-SSD read replica. If zone-HA and in-memory OLTP are not required, General Purpose saves ~45%.',
    risk: 'high',
  },
  {
    resourceTypes: ['azurerm_mssql_database'],
    attributes: ['sku_name'],
    pattern: /^GP_Gen5_16$/i,
    currentLabel: 'General Purpose Gen5 16 vCores',
    suggestedValue: 'GP_Gen5_8',
    suggestedLabel: 'General Purpose Gen5 8 vCores',
    savingPercent: 50,
    rationale: 'Halving vCores saves ~50%. Review query parallelism and max concurrent connections first.',
    risk: 'medium',
  },
  {
    resourceTypes: ['azurerm_mssql_database'],
    attributes: ['sku_name'],
    pattern: /^GP_Gen5_8$/i,
    currentLabel: 'General Purpose Gen5 8 vCores',
    suggestedValue: 'GP_Gen5_4',
    suggestedLabel: 'General Purpose Gen5 4 vCores',
    savingPercent: 50,
    rationale: 'Halving vCores saves ~50%. Suitable when query parallelism is low.',
    risk: 'medium',
  },
  {
    resourceTypes: ['azurerm_mssql_database'],
    attributes: ['sku_name'],
    pattern: /^GP_Gen5_4$/i,
    currentLabel: 'General Purpose Gen5 4 vCores',
    suggestedValue: 'GP_Gen5_2',
    suggestedLabel: 'General Purpose Gen5 2 vCores',
    savingPercent: 50,
    rationale: 'Halving vCores saves ~50%. Review max_worker_threads and query plans before changing.',
    risk: 'medium',
  },

  // ── Azure Database for PostgreSQL flexible ────────────────────────────────
  {
    resourceTypes: ['azurerm_postgresql_flexible_server'],
    attributes: ['sku_name'],
    pattern: /^GP_Standard_D4ds_v4$/i,
    currentLabel: 'General Purpose D4ds_v4 (4 vCPUs)',
    suggestedValue: 'GP_Standard_D2ds_v4',
    suggestedLabel: 'General Purpose D2ds_v4 (2 vCPUs)',
    savingPercent: 50,
    rationale: 'Halving vCPUs saves ~50% on PostgreSQL Flexible Server compute.',
    risk: 'medium',
  },
  {
    resourceTypes: ['azurerm_postgresql_flexible_server'],
    attributes: ['sku_name'],
    pattern: /^GP_Standard_D8ds_v4$/i,
    currentLabel: 'General Purpose D8ds_v4 (8 vCPUs)',
    suggestedValue: 'GP_Standard_D4ds_v4',
    suggestedLabel: 'General Purpose D4ds_v4 (4 vCPUs)',
    savingPercent: 50,
    rationale: 'Halving vCPUs saves ~50% on PostgreSQL Flexible Server compute.',
    risk: 'medium',
  },

  // ── Redis Cache ───────────────────────────────────────────────────────────
  {
    resourceTypes: ['azurerm_redis_cache'],
    attributes: ['sku_name'],
    pattern: /^Premium$/i,
    currentLabel: 'Premium tier (geo-replication, clustering)',
    suggestedValue: 'Standard',
    suggestedLabel: 'Standard tier (HA replica, no clustering)',
    savingPercent: 60,
    rationale: 'Premium adds geo-replication and data persistence to disk. Switch to Standard if neither feature is required.',
    risk: 'high',
  },
  {
    resourceTypes: ['azurerm_redis_cache'],
    attributes: ['sku_name'],
    pattern: /^Standard$/i,
    currentLabel: 'Standard tier (HA replica)',
    suggestedValue: 'Basic',
    suggestedLabel: 'Basic tier (single node, no SLA replica)',
    savingPercent: 50,
    rationale: 'Basic removes the SLA-backed replica. Only suitable for dev/test environments.',
    risk: 'high',
  },

  // ── AKS default node pool ─────────────────────────────────────────────────
  {
    resourceTypes: ['azurerm_kubernetes_cluster'],
    attributes: ['vm_size'],
    pattern: /^Standard_D16s?_v3$/i,
    currentLabel: 'D16s_v3 node (16 vCPUs)',
    suggestedValue: 'Standard_D8s_v3',
    suggestedLabel: 'D8s_v3 node (8 vCPUs)',
    savingPercent: 50,
    rationale: 'Smaller nodes + cluster autoscaler scales more efficiently. Check no single pod requires >8 vCPU guaranteed.',
    risk: 'medium',
  },
  {
    resourceTypes: ['azurerm_kubernetes_cluster'],
    attributes: ['vm_size'],
    pattern: /^Standard_D8s?_v3$/i,
    currentLabel: 'D8s_v3 node (8 vCPUs)',
    suggestedValue: 'Standard_D4s_v3',
    suggestedLabel: 'D4s_v3 node (4 vCPUs)',
    savingPercent: 50,
    rationale: 'Smaller nodes allow the autoscaler to right-size more precisely. Verify no pod needs >4 vCPU guaranteed.',
    risk: 'medium',
  },
  {
    resourceTypes: ['azurerm_kubernetes_cluster'],
    attributes: ['vm_size'],
    pattern: /^Standard_D4s?_v3$/i,
    currentLabel: 'D4s_v3 node (4 vCPUs)',
    suggestedValue: 'Standard_D2s_v3',
    suggestedLabel: 'D2s_v3 node (2 vCPUs)',
    savingPercent: 50,
    rationale: 'Good for clusters where the heaviest pod needs ≤2 vCPU. Enable cluster autoscaler for maximum savings.',
    risk: 'medium',
  },
];

// ─── Lightweight HCL attribute extractor ─────────────────────────────────────

interface ParsedResource {
  resourceType: string;
  resourceName: string;
  /** All quoted string attributes found anywhere in the block body */
  attributes: Record<string, string>;
}

/**
 * Extracts `resource "type" "name" { ... }` blocks from HCL and collects
 * every `key = "value"` assignment found inside the body (including inside
 * nested sub-blocks like `default_node_pool`, `sku`, etc.).
 *
 * This is intentionally not a full HCL parser — it only needs to find
 * sizing/SKU attributes which are always simple string assignments.
 */
function parseHclResources(hcl: string): ParsedResource[] {
  const results: ParsedResource[] = [];

  // Match top-level resource blocks. The body capture handles one level of
  // nesting by allowing `{ ... }` sub-blocks inside the outer braces.
  const blockRe = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gs;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRe.exec(hcl)) !== null) {
    const resourceType = blockMatch[1];
    const resourceName = blockMatch[2];
    const body         = blockMatch[3];

    const attributes: Record<string, string> = {};
    const attrRe = /^\s*(\w+)\s*=\s*"([^"]+)"/gm;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(body)) !== null) {
      // First occurrence wins — outer scope takes priority over nested blocks
      if (!(attrMatch[1] in attributes)) {
        attributes[attrMatch[1]] = attrMatch[2];
      }
    }

    results.push({ resourceType, resourceName, attributes });
  }

  return results;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Analyse the combined content of all `.tf` files in a session and return
 * rightsizing recommendations.
 *
 * @param hclContent   Concatenated content of all .tf files
 * @param costsByAddr  Optional map of Terraform address → monthly USD cost
 *                     (populated from a prior cost-analysis run so that dollar
 *                     savings can be shown alongside percent savings)
 */
export function generateRightsizingRecommendations(
  hclContent: string,
  costsByAddr: Map<string, number> = new Map(),
): RightsizingResult {
  const resources = parseHclResources(hclContent);
  const recommendations: RightsizingRecommendation[] = [];

  for (const resource of resources) {
    for (const rule of RULES) {
      if (!rule.resourceTypes.includes(resource.resourceType)) continue;

      for (const attr of rule.attributes) {
        const value = resource.attributes[attr];
        if (!value) continue;

        const match = rule.pattern.exec(value);
        if (!match) continue;

        // Substitute capture groups into suggestedValue (e.g. BC_Gen5_$1 → GP_Gen5_4)
        const suggestedValue = match.length > 1
          ? rule.suggestedValue.replace(/\$(\d+)/g, (_, n) => match[Number(n)] ?? '')
          : rule.suggestedValue;

        const suggestedLabel = match.length > 1
          ? rule.suggestedLabel.replace(/\$(\d+)/g, (_, n) => match[Number(n)] ?? '')
          : rule.suggestedLabel;

        const address = `${resource.resourceType}.${resource.resourceName}`;
        const monthlyCost = costsByAddr.get(address) ?? 0;
        const estimatedMonthlySaving = monthlyCost > 0
          ? Math.round(monthlyCost * rule.savingPercent / 100 * 100) / 100
          : undefined;

        recommendations.push({
          address,
          resourceType: resource.resourceType,
          resourceName: resource.resourceName,
          attribute: attr,
          currentValue: value,
          suggestedValue,
          currentLabel: rule.currentLabel,
          suggestedLabel,
          estimatedSavingPercent: rule.savingPercent,
          estimatedMonthlySaving,
          rationale: rule.rationale,
          risk: rule.risk,
        });

        break; // One recommendation per resource — first matching rule wins
      }
    }
  }

  const totalSaving = recommendations.reduce(
    (sum, r) => sum + (r.estimatedMonthlySaving ?? 0),
    0,
  );

  return {
    recommendations,
    totalRecommendations: recommendations.length,
    totalEstimatedMonthlySaving: Math.round(totalSaving * 100) / 100,
    resourcesAnalysed: resources.length,
  };
}
