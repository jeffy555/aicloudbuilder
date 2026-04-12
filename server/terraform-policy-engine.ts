/**
 * Terraform Policy Validation Engine (AI-driven)
 *
 * Scans parsed Terraform resources against governance best practices using
 * GPT-4o-mini. Returns structured violations with severity levels so callers
 * can surface issues in the UI without hard-coding policy logic in routes.
 *
 * Rule categories:
 *   security    — misconfigurations that create attack surface
 *   cost        — spending patterns that increase bills unnecessarily
 *   naming      — naming convention violations
 *   tagging     — missing required resource tags
 *   reliability — single points of failure / missing HA config
 *   compliance  — regional or encryption requirements
 */

import { aiChatCompletion } from './utils/ai-client.js';
import { z } from 'zod';
import type { TerraformResource } from './diagram/resource-relationship-parser.js';
import { sanitizeJsonForPrompt } from './utils/sanitize-prompt.js';

// ─── Zod schemas for AI response validation ─────────────────────────────────

const aiViolationSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string().optional().default(''),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).catch('medium'),
  category: z.string().optional().default('general'),
  resourceType: z.string(),
  resourceName: z.string(),
  file: z.string().optional().default(''),
  message: z.string(),
  suggestion: z.string().optional().default(''),
});
const aiPolicyResponseSchema = z.object({
  violations: z.array(aiViolationSchema).catch([]),
});


// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface PolicyViolation {
  ruleId: string;
  ruleName: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: 'security' | 'cost' | 'naming' | 'tagging' | 'reliability' | 'compliance';
  resourceType: string;
  resourceName: string;
  file: string;
  message: string;
  suggestion: string;
}

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  severity: PolicyViolation['severity'];
  category: PolicyViolation['category'];
  check: (resource: TerraformResource, allResources: TerraformResource[], options: PolicyOptions) => PolicyViolation | null;
}

export interface PolicyOptions {
  /** Subset of rule IDs to enable. If empty, all rules run. */
  enabledRules?: string[];
  /** Tags every resource must have (for TF-TAG-* rules). */
  requiredTags?: string[];
  /** Approved Azure regions (for TF-COM-001). */
  approvedRegions?: string[];
}

export interface PolicyResult {
  violations: PolicyViolation[];
  passed: Array<{ ruleId: string; resourceType: string; resourceName: string }>;
  summary: {
    total: number;
    violations: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    passed: number;
  };
}

// ─── AI-driven policy analysis ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Terraform governance expert analyzing HCL configurations against security, cost, reliability, naming, and tagging best practices for Azure resources.

Analyze the provided Terraform resources and return policy violations found. Each violation must have:
- ruleId: A short identifier like "TF-SEC-001", "TF-COST-001", "TF-NAME-001", "TF-TAG-001", "TF-REL-001", "TF-COM-001" etc. Use consistent IDs for the same type of issue.
- ruleName: Short descriptive name (e.g. "Storage Account Public Blob Access")
- severity: One of "critical", "high", "medium", "low", "info"
- category: One of "security", "cost", "naming", "tagging", "reliability", "compliance"
- resourceType: The Terraform resource type (e.g. "azurerm_storage_account")
- resourceName: The Terraform resource name (e.g. "main_storage")
- file: The file where the resource is defined
- message: Clear explanation of the violation
- suggestion: Actionable fix suggestion with specific HCL attribute changes

Check for these categories of issues:

SECURITY:
- Public blob access enabled on storage accounts
- SQL servers without firewall rules
- Key Vault soft delete disabled
- HTTPS not enforced on storage accounts
- VMs without managed identity
- Network security groups with overly permissive rules (0.0.0.0/0)
- Unencrypted resources where encryption is available

COST:
- Premium-tier resources without cost justification tags
- Geo-redundant storage in dev/test environments
- Large VMs without size justification
- Resources missing environment tags for cost allocation

NAMING:
- Resource groups not following naming conventions (missing -rg suffix)
- Storage account names with invalid characters (must be lowercase alphanumeric)
- Terraform resource names that are too short or not descriptive

TAGGING:
- Missing required tags (owner, environment, cost_center if specified)

RELIABILITY:
- App Service Plans with single instance (no HA)
- SQL databases without backup retention configured
- Storage accounts without versioning or soft delete

COMPLIANCE:
- Resources in non-approved regions (if approved regions list is provided)
- Storage accounts without minimum TLS 1.2
- Missing encryption at rest configurations

Return a JSON object with this exact structure:
{
  "violations": [ ... array of violation objects ... ]
}

If no violations are found, return { "violations": [] }.
Be thorough but avoid false positives. Only flag clear violations based on the resource attributes provided.`;

async function analyzeWithAI(
  resources: TerraformResource[],
  options: PolicyOptions,
): Promise<PolicyViolation[]> {
  if (resources.length === 0) return [];

  const resourceSummaries = resources.map(r => ({
    type: r.type,
    name: r.name,
    file: r.file,
    attributes: r.attributes,
  }));

  const optionsContext = [];
  if (options.requiredTags && options.requiredTags.length > 0) {
    optionsContext.push(`Required tags that every resource must have: ${options.requiredTags.join(', ')}`);
  }
  if (options.approvedRegions && options.approvedRegions.length > 0) {
    optionsContext.push(`Approved Azure regions: ${options.approvedRegions.join(', ')}. Flag resources deployed outside these regions.`);
  }
  if (options.enabledRules && options.enabledRules.length > 0) {
    optionsContext.push(`Only check these rule categories/IDs: ${options.enabledRules.join(', ')}`);
  }

  const userContent = `Analyze these ${resources.length} Terraform resources for policy violations:\n\n${JSON.stringify(sanitizeJsonForPrompt(resourceSummaries), null, 2)}${optionsContext.length > 0 ? '\n\nAdditional policy options:\n' + optionsContext.join('\n') : ''}`;

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

  const result = aiPolicyResponseSchema.safeParse(JSON.parse(content));
  if (!result.success) {
    console.warn('[policy-engine] AI response validation failed:', result.error.message);
    return [];
  }

  const validCategories = ['security', 'cost', 'naming', 'tagging', 'reliability', 'compliance'];

  const violations: PolicyViolation[] = [];
  for (const v of result.data.violations) {
    if (!v.ruleId || !v.resourceType || !v.resourceName || !v.message) continue;

    violations.push({
      ruleId: v.ruleId,
      ruleName: v.ruleName || v.ruleId,
      severity: v.severity,
      category: validCategories.includes(v.category) ? v.category as PolicyViolation['category'] : 'security',
      resourceType: v.resourceType,
      resourceName: v.resourceName,
      file: v.file,
      message: v.message,
      suggestion: v.suggestion,
    });
  }

  return violations;
}

// ─── Policy Engine Entry Point ─────────────────────────────────────────────────

/**
 * Run AI-driven policy analysis against an array of parsed Terraform resources.
 * Returns structured violations plus a pass/fail summary.
 */
export async function runPolicyChecks(
  resources: TerraformResource[],
  options: PolicyOptions = {}
): Promise<PolicyResult> {
  try {
    const violations = await analyzeWithAI(resources, options);

    // Build a set of resource addresses that have violations
    const violatedAddresses = new Set(
      violations.map(v => `${v.resourceType}.${v.resourceName}`)
    );

    // Resources without violations are considered "passed"
    const passed: PolicyResult['passed'] = [];
    for (const resource of resources) {
      const addr = `${resource.type}.${resource.name}`;
      if (!violatedAddresses.has(addr)) {
        passed.push({
          ruleId: 'ALL',
          resourceType: resource.type,
          resourceName: resource.name,
        });
      }
    }

    const summary = {
      total:      violations.length + passed.length,
      violations: violations.length,
      critical:   violations.filter(v => v.severity === 'critical').length,
      high:       violations.filter(v => v.severity === 'high').length,
      medium:     violations.filter(v => v.severity === 'medium').length,
      low:        violations.filter(v => v.severity === 'low').length,
      info:       violations.filter(v => v.severity === 'info').length,
      passed:     passed.length,
    };

    return { violations, passed, summary };
  } catch (error) {
    console.warn('[policy-engine] AI analysis failed, returning empty defaults:', error);

    return {
      violations: [],
      passed: [],
      summary: {
        total: 0,
        violations: 0,
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
        passed: 0,
      },
    };
  }
}
