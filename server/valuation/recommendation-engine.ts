/**
 * AI-Powered Recommendation Engine for Valuation Module
 *
 * Uses GPT-4o-mini to dynamically analyze each resource's usage metrics,
 * SKU/tier, and cost — replacing all hardcoded threshold maps and savings percentages.
 */

import { aiChatCompletion } from '../utils/ai-client.js';
import { z } from 'zod';
import type { ValuationResource, RemediationPlan, UsageMetrics } from '@shared/schema';
import { sanitizeJsonForPrompt } from '../utils/sanitize-prompt.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Valuation');

// ─── Zod schemas for AI response validation ─────────────────────────────────

const aiRecommendationSchema = z.object({
  resourceName: z.string(),
  recommended_sku: z.string(),
  recommended_tier: z.string().optional(),
  savings_monthly: z.number().catch(0),
  savings_percent: z.number().catch(0),
  reason: z.string().catch(''),
  confidence: z.enum(['high', 'medium', 'low']).catch('medium'),
  action_required: z.string().catch(''),
});
const aiRecommendationResponseSchema = z.object({
  recommendations: z.array(aiRecommendationSchema).catch([]),
});

const BATCH_SIZE = 20;

/**
 * Generates AI-powered cost optimization recommendations for a batch of resources.
 * Returns a Map keyed by resource name.
 */
export async function generateAIRecommendations(
  resources: Array<{
    resource: ValuationResource;
    monthlyCost: number;
    metrics?: UsageMetrics;
  }>,
  currency: string
): Promise<Map<string, RemediationPlan>> {
  const result = new Map<string, RemediationPlan>();

  if (resources.length === 0) return result;

  // Batch into groups of BATCH_SIZE to fit context window
  const batches: typeof resources[] = [];
  for (let i = 0; i < resources.length; i += BATCH_SIZE) {
    batches.push(resources.slice(i, i + BATCH_SIZE));
  }

  // Process batches in parallel
  const batchResults = await Promise.allSettled(
    batches.map(batch => processRecommendationBatch(batch, currency))
  );

  for (const batchResult of batchResults) {
    if (batchResult.status === 'fulfilled') {
      const entries = Array.from(batchResult.value.entries());
      for (const [name, plan] of entries) {
        result.set(name, plan);
      }
    } else {
      log.warn('AI recommendation batch failed', { reason: String(batchResult.reason) });
    }
  }

  return result;
}

async function processRecommendationBatch(
  resources: Array<{
    resource: ValuationResource;
    monthlyCost: number;
    metrics?: UsageMetrics;
  }>,
  currency: string
): Promise<Map<string, RemediationPlan>> {
  const result = new Map<string, RemediationPlan>();

  const resourceData = resources.map(r => ({
    name: r.resource.name,
    azureType: r.resource.azureType,
    currentSku: r.resource.currentSku,
    currentTier: r.resource.currentTier,
    location: r.resource.location,
    resourceGroup: r.resource.resourceGroup,
    monthlyCost: r.monthlyCost,
    metricsAvailable: !!r.metrics,
    metrics: r.metrics ? {
      avgCpuPercent: r.metrics.statistics?.avgCpuPercent,
      maxCpuPercent: r.metrics.statistics?.maxCpuPercent,
      avgMemoryPercent: r.metrics.statistics?.avgMemoryPercent,
      avgDtuPercent: r.metrics.statistics?.avgDtuPercent,
      avgStorageUsedGB: r.metrics.statistics?.avgStorageUsedGB,
      sampleCount: r.metrics.statistics?.sampleCount,
    } : null,
  }));

  const systemPrompt = `You are an Azure cloud cost optimization expert following Azure Well-Architected Framework and FinOps Foundation best practices.

Analyze each resource's actual usage metrics (CPU%, Memory%, DTU%, Storage GB, etc.) and current SKU/tier. For EACH resource, determine if it needs right-sizing, tier change, generation upgrade, or is already optimal.

Consider:
- Over-provisioning (low CPU/memory utilisation)
- Idle resources (near-zero usage)
- Outdated SKU generations (e.g. v3 when v5 exists)
- Burstable candidates (low baseline CPU with occasional spikes)
- Storage tier optimization (Hot→Cool, Premium→Standard, GRS→LRS)
- Orphaned resources (disks, IPs with no attachments)
- Dev/test auto-shutdown candidates
- Redis/SQL tier downgrades when premium features are unused

For each resource, provide:
- recommended_sku: exact Azure SKU name (not generic)
- recommended_tier: target tier
- savings_percent: estimated percentage savings (integer)
- savings_monthly: estimated monthly savings in the given currency
- reason: detailed explanation referencing actual metrics/SKU
- confidence: "high" (with metrics proving over-provisioning), "medium" (strong heuristic without full metrics), or "low" (speculative)
- action_required: step-by-step implementation guide including risk mitigation

If a resource is already optimally sized or you cannot confidently recommend a change, omit it from the array.

Return JSON:
{
  "recommendations": [
    {
      "resourceName": "exact resource name from input",
      "recommended_sku": "Standard_B2ms",
      "recommended_tier": "Burstable",
      "savings_monthly": 1500.00,
      "savings_percent": 45,
      "reason": "detailed explanation",
      "confidence": "high",
      "action_required": "step-by-step instructions"
    }
  ]
}`;

  const userPrompt = `Resources to analyze (currency: ${currency}):\n${resourceData.map(r => JSON.stringify(sanitizeJsonForPrompt(r))).join('\n')}`;

  try {
    const completion = await aiChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      log.warn('AI returned empty response for recommendations');
      return result;
    }

    const zodResult = aiRecommendationResponseSchema.safeParse(JSON.parse(content));
    if (!zodResult.success) {
      log.warn('AI response validation failed', { error: zodResult.error.message });
      return result;
    }

    // Map AI recommendations back to resources by name
    for (const rec of zodResult.data.recommendations) {
      // Find the matching resource (case-insensitive match as fallback)
      const matchingResource = resources.find(
        r => r.resource.name === rec.resourceName
      ) || resources.find(
        r => r.resource.name.toLowerCase() === rec.resourceName.toLowerCase()
      );

      if (!matchingResource) continue;

      const plan: RemediationPlan = {
        recommended_sku: rec.recommended_sku,
        recommended_tier: rec.recommended_tier,
        savings_monthly: rec.savings_monthly,
        savings_percent: rec.savings_percent,
        reason: rec.reason,
        confidence: rec.confidence,
        action_required: rec.action_required,
      };

      result.set(matchingResource.resource.name, plan);
    }

    return result;
  } catch (error: any) {
    log.error('AI recommendation call failed', { error: error.message });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Aggregate helpers
// ---------------------------------------------------------------------------

export function calculateTotalSavings(resources: ValuationResource[]): {
  totalMonthlySavings: number;
  totalYearlySavings: number;
  resourcesWithRecommendations: number;
} {
  const withRecs = resources.filter(r => r.remediation);
  const totalMonthlySavings = withRecs.reduce(
    (sum, r) => sum + (r.remediation?.savings_monthly ?? 0),
    0
  );
  return {
    totalMonthlySavings,
    totalYearlySavings: totalMonthlySavings * 12,
    resourcesWithRecommendations: withRecs.length,
  };
}
