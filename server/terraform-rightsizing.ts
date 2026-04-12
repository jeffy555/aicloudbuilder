/**
 * Terraform Rightsizing Recommendations (AI-driven)
 *
 * Analyses Terraform HCL files (from a session) to identify over-provisioned
 * resources and suggests cost-optimised alternatives using GPT-4o-mini.
 *
 * Design decisions:
 *  - Uses a lightweight regex HCL extractor (not a full parser). Sufficient for
 *    the top-level and single-nested string attributes we care about.
 *  - All rightsizing intelligence comes from the AI model — no static rule tables.
 *  - If the AI call fails, returns safe empty defaults (no recommendations).
 */

import { aiChatCompletion } from './utils/ai-client.js';
import { z } from 'zod';
import { sanitizeJsonForPrompt } from './utils/sanitize-prompt.js';

// ─── Zod schemas for AI response validation ─────────────────────────────────

const aiRecSchema = z.object({
  address: z.string(),
  resourceType: z.string(),
  resourceName: z.string(),
  attribute: z.string(),
  currentValue: z.string(),
  suggestedValue: z.string(),
  currentLabel: z.string().optional().default(''),
  suggestedLabel: z.string().optional().default(''),
  estimatedSavingPercent: z.number().catch(0),
  rationale: z.string().optional().default(''),
  risk: z.enum(['low', 'medium', 'high']).catch('medium'),
});
const aiRightsizingResponseSchema = z.object({
  recommendations: z.array(aiRecSchema).catch([]),
});


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
  const blockRe = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
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

// ─── AI-driven rightsizing analysis ───────────────────────────────────────────

const SYSTEM_PROMPT = `You are an Azure FinOps expert specializing in Terraform cost optimization and rightsizing.

Analyze the provided Terraform resource configurations and identify over-provisioned resources that can be downsized to reduce cost.

For each recommendation, provide:
- address: Full Terraform address (e.g. "azurerm_linux_virtual_machine.app")
- resourceType: The Terraform resource type
- resourceName: The Terraform resource name
- attribute: The HCL attribute holding the SKU/size (e.g. "size", "sku_name", "vm_size")
- currentValue: The current value in the .tf file
- suggestedValue: The recommended replacement value (must be a valid Azure SKU/size)
- currentLabel: Human-friendly label for the current value (include vCPUs/memory where applicable)
- suggestedLabel: Human-friendly label for the suggested value
- estimatedSavingPercent: Percentage of monthly cost saved (integer 1-100)
- rationale: One-sentence explanation for the recommendation
- risk: "low", "medium", or "high" — the operational risk of applying this change

Guidelines:
- Only recommend downsizing when there is a clear next-smaller SKU available
- Consider VM series (D, E, F, B), App Service Plans, SQL databases, Redis, AKS node pools, PostgreSQL, and storage accounts
- For VMs: suggest halving vCPUs within the same series, or switching from memory-optimized (E-series) to general purpose (D-series)
- For App Service Plans: suggest stepping down within the same tier or to a lower tier
- For databases: suggest halving vCores or switching from Business Critical to General Purpose
- For Redis: suggest stepping down tiers (Premium→Standard, Standard→Basic for dev/test)
- For storage: suggest switching from GRS/RA-GRS to LRS, or from Premium to Standard
- Be conservative — flag high risk for tier changes that remove features
- Do NOT recommend changes for the smallest available SKU in a tier

Return a JSON object with this exact structure:
{
  "recommendations": [ ... array of recommendation objects ... ]
}

If no rightsizing opportunities are found, return { "recommendations": [] }.`;

async function analyzeWithAI(
  resources: ParsedResource[],
  costsByAddr: Map<string, number>,
): Promise<RightsizingRecommendation[]> {
  if (resources.length === 0) return [];

  const resourceSummaries = resources.map(r => ({
    address: `${r.resourceType}.${r.resourceName}`,
    type: r.resourceType,
    name: r.resourceName,
    attributes: r.attributes,
    currentMonthlyCost: costsByAddr.get(`${r.resourceType}.${r.resourceName}`) ?? null,
  }));

  const userContent = `Analyze these ${resources.length} Terraform resources for rightsizing opportunities:\n\n${JSON.stringify(sanitizeJsonForPrompt(resourceSummaries), null, 2)}`;

  const response = await aiChatCompletion({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: userContent },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return [];

  const result = aiRightsizingResponseSchema.safeParse(JSON.parse(content));
  if (!result.success) {
    console.warn('[terraform-rightsizing] AI response validation failed:', result.error.message);
    return [];
  }

  const recs: RightsizingRecommendation[] = [];

  for (const rec of result.data.recommendations) {
    if (!rec.address || !rec.resourceType || !rec.resourceName ||
        !rec.attribute || !rec.currentValue || !rec.suggestedValue) {
      continue;
    }

    const monthlyCost = costsByAddr.get(rec.address) ?? 0;
    const savingPercent = Math.max(0, Math.min(100, rec.estimatedSavingPercent));
    const estimatedMonthlySaving = monthlyCost > 0
      ? Math.round(monthlyCost * savingPercent / 100 * 100) / 100
      : undefined;

    recs.push({
      address: rec.address,
      resourceType: rec.resourceType,
      resourceName: rec.resourceName,
      attribute: rec.attribute,
      currentValue: rec.currentValue,
      suggestedValue: rec.suggestedValue,
      currentLabel: rec.currentLabel || rec.currentValue,
      suggestedLabel: rec.suggestedLabel || rec.suggestedValue,
      estimatedSavingPercent: savingPercent,
      estimatedMonthlySaving,
      rationale: rec.rationale || 'AI-identified rightsizing opportunity.',
      risk: rec.risk,
    });
  }

  return recs;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Analyse the combined content of all `.tf` files in a session and return
 * rightsizing recommendations using AI-driven analysis.
 *
 * @param hclContent   Concatenated content of all .tf files
 * @param costsByAddr  Optional map of Terraform address → monthly USD cost
 *                     (populated from a prior cost-analysis run so that dollar
 *                     savings can be shown alongside percent savings)
 */
export async function generateRightsizingRecommendations(
  hclContent: string,
  costsByAddr: Map<string, number> = new Map(),
): Promise<RightsizingResult> {
  const resources = parseHclResources(hclContent);

  try {
    const recommendations = await analyzeWithAI(resources, costsByAddr);

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
  } catch (error) {
    console.warn('[terraform-rightsizing] AI analysis failed, returning empty defaults:', error);
    return {
      recommendations: [],
      totalRecommendations: 0,
      totalEstimatedMonthlySaving: 0,
      resourcesAnalysed: resources.length,
    };
  }
}

// ─── Apply suggestion to HCL (single resource block) ─────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ApplyRightsizingInput {
  resourceType: string;
  resourceName: string;
  attribute: string;
  currentValue: string;
  suggestedValue: string;
}

export interface ApplyRightsizingFileResult {
  applied: boolean;
  fileName?: string;
  fileId?: string;
  reason?: string;
}

/**
 * Locate `resource "type" "name" { ... }` and replace the first matching
 * `attribute = "currentValue"` line inside that block with the suggested value.
 */
export function applyRightsizingToHcl(
  hcl: string,
  input: ApplyRightsizingInput,
): { hcl: string; applied: boolean; reason?: string } {
  const re = new RegExp(
    `resource\\s+"${escapeRegExp(input.resourceType)}"\\s+"${escapeRegExp(input.resourceName)}"\\s*\\{`,
    'm',
  );
  const m = hcl.match(re);
  if (!m || m.index === undefined) {
    return { hcl, applied: false, reason: 'Resource block not found in file' };
  }

  const blockStart = m.index;
  const openBrace = blockStart + m[0].length - 1;
  let depth = 0;
  let blockEnd = -1;
  for (let i = openBrace; i < hcl.length; i++) {
    const c = hcl[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        blockEnd = i + 1;
        break;
      }
    }
  }
  if (blockEnd === -1) {
    return { hcl, applied: false, reason: 'Unclosed resource block' };
  }

  const before = hcl.slice(0, blockStart);
  const block = hcl.slice(blockStart, blockEnd);
  const after = hcl.slice(blockEnd);

  const attrRe = new RegExp(
    `^(\\s*)${escapeRegExp(input.attribute)}\\s*=\\s*"${escapeRegExp(input.currentValue)}"`,
    'm',
  );
  if (!attrRe.test(block)) {
    return {
      hcl,
      applied: false,
      reason: `No line ${input.attribute} = "${input.currentValue}" in this resource block (file may have changed).`,
    };
  }

  const newBlock = block.replace(
    attrRe,
    `$1${input.attribute} = "${input.suggestedValue}"`,
  );

  if (newBlock === block) {
    return { hcl, applied: false, reason: 'Replacement did not change content' };
  }

  return { hcl: before + newBlock + after, applied: true };
}
