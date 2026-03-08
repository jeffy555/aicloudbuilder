/**
 * Terraform Plan JSON Parser
 *
 * Parses the output of `terraform show -json` to extract resource changes
 * for cost delta analysis. Each resource change records the action type
 * (create/update/delete/no-op/replace) and the before/after attribute state.
 *
 * Terraform plan JSON format reference:
 *   https://developer.hashicorp.com/terraform/internals/json-output-format
 *
 * Last validated: 2026-03-05
 */

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface PlanChange {
  /** Full resource address, e.g. "azurerm_linux_virtual_machine.app" */
  address:      string;
  /** Terraform resource type, e.g. "azurerm_linux_virtual_machine" */
  resourceType: string;
  /** Terraform resource name (label), e.g. "app" */
  resourceName: string;
  /** Change action */
  action: 'create' | 'update' | 'delete' | 'no-op' | 'replace';
  /** Attribute values before the change (null for creates) */
  before: Record<string, any> | null;
  /** Attribute values after the change (null for deletes) */
  after: Record<string, any> | null;
}

export interface PlanCostChange {
  address:            string;
  resourceType:       string;
  resourceName:       string;
  action:             PlanChange['action'];
  beforeMonthlyCost:  number;
  afterMonthlyCost:   number;
  deltaMonthlyCost:   number;
  deltaYearlyCost:    number;
  /** Percentage change, null when beforeCost = 0 (new resource) */
  deltaPercent:       number | null;
}

export interface PlanDiffSummary {
  totalBeforeCost:  number;
  totalAfterCost:   number;
  totalDeltaMonthly: number;
  totalDeltaYearly: number;
  resourcesAdded:   number;
  resourcesRemoved: number;
  resourcesChanged: number;
  resourcesUnchanged: number;
  resourcesReplaced: number;
}

export interface PlanDiffResult {
  summary: PlanDiffSummary;
  changes: PlanCostChange[];
}

// ─── Plan JSON Parser ──────────────────────────────────────────────────────────

/**
 * Parse a Terraform plan JSON string (output of `terraform show -json`)
 * and return an array of PlanChange records.
 *
 * Tolerates both `terraform show -json <planfile>` output (which has
 * `resource_changes`) and the older `terraform plan -json` output.
 */
export function parseTerraformPlan(planJson: string): PlanChange[] {
  let plan: any;
  try {
    plan = JSON.parse(planJson);
  } catch (err: any) {
    throw new Error(`Invalid Terraform plan JSON: ${err.message}`);
  }

  const resourceChanges: any[] = plan.resource_changes ?? plan.planned_values?.root_module?.resources ?? [];

  return resourceChanges
    .filter((rc: any) => rc.type && rc.change)
    .map((rc: any): PlanChange => {
      const actions: string[] = rc.change.actions ?? ['no-op'];
      const action = deriveAction(actions);

      return {
        address:      rc.address || `${rc.type}.${rc.name}`,
        resourceType: rc.type,
        resourceName: rc.name || rc.address?.split('.').pop() || '',
        action,
        before:       rc.change.before ?? null,
        after:        rc.change.after  ?? null,
      };
    });
}

/**
 * Convert Terraform's multi-action array into a single PlanChange action.
 * Terraform can emit ["delete","create"] for in-place replacements.
 */
function deriveAction(actions: string[]): PlanChange['action'] {
  if (actions.includes('delete') && actions.includes('create')) return 'replace';
  if (actions.includes('create')) return 'create';
  if (actions.includes('delete')) return 'delete';
  if (actions.includes('update')) return 'update';
  return 'no-op';
}

// ─── Cost Delta Calculator ─────────────────────────────────────────────────────

/**
 * Given parsed plan changes and a cost calculator function, return the
 * full cost diff result including per-resource deltas and a totals summary.
 *
 * @param changes   - Output of parseTerraformPlan()
 * @param getCost   - Async function: (resourceType, attrs) → monthly USD cost
 */
export async function calculatePlanDiff(
  changes: PlanChange[],
  getCost: (resourceType: string, attrs: Record<string, any>) => Promise<number>
): Promise<PlanDiffResult> {
  const costChanges = await Promise.all(
    changes.map(async (change): Promise<PlanCostChange> => {
      const [beforeCost, afterCost] = await Promise.all([
        change.before ? getCost(change.resourceType, change.before) : Promise.resolve(0),
        change.after  ? getCost(change.resourceType, change.after)  : Promise.resolve(0),
      ]);

      const delta  = afterCost - beforeCost;
      const pct    = beforeCost > 0 ? (delta / beforeCost) * 100 : null;

      return {
        address:           change.address,
        resourceType:      change.resourceType,
        resourceName:      change.resourceName,
        action:            change.action,
        beforeMonthlyCost: beforeCost,
        afterMonthlyCost:  afterCost,
        deltaMonthlyCost:  delta,
        deltaYearlyCost:   delta * 12,
        deltaPercent:      pct !== null ? Math.round(pct * 10) / 10 : null,
      };
    })
  );

  const summary: PlanDiffSummary = {
    totalBeforeCost:    costChanges.reduce((s, c) => s + c.beforeMonthlyCost, 0),
    totalAfterCost:     costChanges.reduce((s, c) => s + c.afterMonthlyCost,  0),
    totalDeltaMonthly:  costChanges.reduce((s, c) => s + c.deltaMonthlyCost,  0),
    totalDeltaYearly:   costChanges.reduce((s, c) => s + c.deltaYearlyCost,   0),
    resourcesAdded:     costChanges.filter(c => c.action === 'create').length,
    resourcesRemoved:   costChanges.filter(c => c.action === 'delete').length,
    resourcesChanged:   costChanges.filter(c => c.action === 'update').length,
    resourcesUnchanged: costChanges.filter(c => c.action === 'no-op').length,
    resourcesReplaced:  costChanges.filter(c => c.action === 'replace').length,
  };

  return { summary, changes: costChanges };
}
