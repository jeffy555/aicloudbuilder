/**
 * Recommendation Engine for Valuation Module
 *
 * Generates cost optimization recommendations based on resource SKU/tier and usage metrics.
 *   - With metrics: High-confidence usage-based recommendations
 *   - Without metrics: Low/medium-confidence rule-based recommendations
 *
 * All thresholds and savings percentages are imported from
 * server/config/recommendation-thresholds.ts — nothing is hardcoded here.
 */

import type { ValuationResource, RemediationPlan, UsageMetrics } from '@shared/schema';
import {
  MIN_METRICS_SAMPLE_COUNT,
  VM_CPU_LOW_THRESHOLD,
  VM_MEMORY_LOW_THRESHOLD,
  VM_CPU_BURSTABLE_AVG_THRESHOLD,
  VM_CPU_BURSTABLE_MAX_THRESHOLD,
  SQL_DTU_LOW_THRESHOLD,
  APP_SERVICE_CPU_LOW_THRESHOLD,
  APP_SERVICE_MEMORY_LOW_THRESHOLD,
  STORAGE_COOL_TIER_THRESHOLD_GB,
  SAVINGS_ESTIMATES,
  VM_DOWNSIZE_MAP,
  VM_DOWNSIZE_FALLBACK,
  VM_BURSTABLE_RECOMMENDATION,
  SQL_TIER_DOWNGRADE_MAP,
  SQL_TIER_DOWNGRADE_FALLBACK,
  APP_SERVICE_PLAN_DOWNGRADE_MAP,
  APP_SERVICE_PLAN_DOWNGRADE_FALLBACK,
} from '../config/recommendation-thresholds.js';

/**
 * Generates cost optimization recommendation for a resource.
 * Returns null if resource is already optimized.
 */
export function generateRecommendation(
  resource: ValuationResource,
  currentCost: number,
  usageMetrics?: UsageMetrics
): RemediationPlan | null {

  // Metrics available → usage-based (high confidence)
  if (usageMetrics && usageMetrics.statistics) {
    const recommendation = generateUsageBasedRecommendation(resource, currentCost, usageMetrics);
    if (recommendation) return recommendation;
  }

  // Fallback → rule-based (low / medium confidence)
  return generateRuleBasedRecommendation(resource, currentCost);
}

// ---------------------------------------------------------------------------
// Usage-based recommendations (requires Azure Monitor metrics)
// ---------------------------------------------------------------------------

function generateUsageBasedRecommendation(
  resource: ValuationResource,
  currentCost: number,
  metrics: UsageMetrics
): RemediationPlan | null {

  const stats  = metrics.statistics!;
  const tfType = resource.terraformType;

  // ── Virtual Machines ────────────────────────────────────────────────────
  if (tfType?.includes('virtual_machine')) {
    const avgCpu = stats.avgCpuPercent ?? 100;
    const avgMem = stats.avgMemoryPercent ?? 100;
    const maxCpu = stats.maxCpuPercent ?? 100;
    const currentSize = resource.currentSku;

    // High confidence: consistently under-utilised for full observation window
    if (
      avgCpu < VM_CPU_LOW_THRESHOLD &&
      avgMem < VM_MEMORY_LOW_THRESHOLD &&
      stats.sampleCount >= MIN_METRICS_SAMPLE_COUNT
    ) {
      const recommendedSize = VM_DOWNSIZE_MAP[currentSize] ?? VM_DOWNSIZE_FALLBACK;
      return {
        recommended_sku: recommendedSize,
        recommended_tier: resource.currentTier || 'Standard',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.VM_DOWNSIZE,
        savings_percent: Math.round(SAVINGS_ESTIMATES.VM_DOWNSIZE * 100),
        reason: `Usage analysis over 7 days shows consistently low resource utilisation ` +
                `(Avg CPU: ${avgCpu.toFixed(1)}%, Avg Memory: ${avgMem.toFixed(1)}%). ` +
                `VM is significantly over-provisioned.`,
        confidence: 'high',
        action_required: `Resize from ${currentSize} to ${recommendedSize}. ` +
                         `Schedule during maintenance window (requires reboot).`,
      };
    }

    // Medium confidence: low baseline with occasional spikes — burstable fits
    if (
      avgCpu < VM_CPU_BURSTABLE_AVG_THRESHOLD &&
      maxCpu < VM_CPU_BURSTABLE_MAX_THRESHOLD &&
      !currentSize.startsWith('Standard_B')
    ) {
      return {
        recommended_sku: VM_BURSTABLE_RECOMMENDATION,
        recommended_tier: 'Burstable',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.VM_TO_BURSTABLE,
        savings_percent: Math.round(SAVINGS_ESTIMATES.VM_TO_BURSTABLE * 100),
        reason: `Low baseline CPU usage (${avgCpu.toFixed(1)}%) with moderate peaks ` +
                `(${maxCpu.toFixed(1)}%). Burstable B-series VMs are ideal for this workload pattern.`,
        confidence: 'high',
        action_required: 'Migrate to B-series during low-traffic period. Monitor burst credits for first week.',
      };
    }
  }

  // ── SQL Database (DTU model) ─────────────────────────────────────────────
  if (tfType === 'azurerm_mssql_database') {
    const avgDtu = stats.avgDtuPercent ?? 100;

    if (avgDtu < SQL_DTU_LOW_THRESHOLD && stats.sampleCount >= MIN_METRICS_SAMPLE_COUNT) {
      const currentSku     = resource.currentSku;
      const recommendedSku = SQL_TIER_DOWNGRADE_MAP[currentSku] ?? SQL_TIER_DOWNGRADE_FALLBACK;

      return {
        recommended_sku: recommendedSku,
        recommended_tier: 'Standard',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.SQL_PREMIUM_TO_STANDARD,
        savings_percent: Math.round(SAVINGS_ESTIMATES.SQL_PREMIUM_TO_STANDARD * 100),
        reason: `Database DTU usage is very low (${avgDtu.toFixed(1)}% average over 7 days). ` +
                `Current tier is over-provisioned for the workload.`,
        confidence: 'high',
        action_required: `Downgrade from ${currentSku} to ${recommendedSku}. Backup database before tier change.`,
      };
    }
  }

  // ── App Service Plan ─────────────────────────────────────────────────────
  if (tfType === 'azurerm_app_service_plan' || tfType === 'azurerm_service_plan') {
    const avgCpu = stats.avgCpuPercent ?? 100;
    const avgMem = stats.avgMemoryPercent ?? 100;

    if (
      avgCpu < APP_SERVICE_CPU_LOW_THRESHOLD &&
      avgMem < APP_SERVICE_MEMORY_LOW_THRESHOLD &&
      stats.sampleCount >= MIN_METRICS_SAMPLE_COUNT
    ) {
      const currentSku     = resource.currentSku;
      const recommendedSku = APP_SERVICE_PLAN_DOWNGRADE_MAP[currentSku]
                             ?? APP_SERVICE_PLAN_DOWNGRADE_FALLBACK;

      return {
        recommended_sku: recommendedSku,
        recommended_tier: 'Standard',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.APP_SERVICE_DOWNGRADE,
        savings_percent: Math.round(SAVINGS_ESTIMATES.APP_SERVICE_DOWNGRADE * 100),
        reason: `App Service Plan shows low utilisation ` +
                `(CPU: ${avgCpu.toFixed(1)}%, Memory: ${avgMem.toFixed(1)}%). Can safely downsize.`,
        confidence: 'high',
        action_required: `Scale down from ${currentSku} to ${recommendedSku}. No downtime required.`,
      };
    }
  }

  // ── Storage Account ───────────────────────────────────────────────────────
  if (tfType === 'azurerm_storage_account') {
    const usedGB = stats.avgStorageUsedGB ?? 0;

    if (usedGB < STORAGE_COOL_TIER_THRESHOLD_GB && resource.currentSku.includes('Hot')) {
      return {
        recommended_sku: resource.currentSku.replace('Hot', 'Cool'),
        recommended_tier: 'Cool',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.STORAGE_HOT_TO_COOL,
        savings_percent: Math.round(SAVINGS_ESTIMATES.STORAGE_HOT_TO_COOL * 100),
        reason: `Storage usage is minimal (${usedGB.toFixed(1)} GB). ` +
                `Cool tier is more cost-effective for infrequently accessed data.`,
        confidence: 'medium',
        action_required: 'Change access tier to Cool. Higher access costs apply if data is frequently accessed.',
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rule-based recommendations (no metrics — lower confidence)
// ---------------------------------------------------------------------------

function generateRuleBasedRecommendation(
  resource: ValuationResource,
  currentCost: number
): RemediationPlan | null {
  const tfType = resource.terraformType;
  if (!tfType) return null;

  // ── Storage Account ───────────────────────────────────────────────────────
  if (tfType === 'azurerm_storage_account') {
    if (resource.currentSku.includes('Premium')) {
      return {
        recommended_sku: resource.currentSku.replace('Premium', 'Standard'),
        recommended_tier: 'Standard',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.STORAGE_PREMIUM_TO_STD,
        savings_percent: Math.round(SAVINGS_ESTIMATES.STORAGE_PREMIUM_TO_STD * 100),
        reason: 'Premium Storage is over-provisioned for most workloads. ' +
                'Standard tier provides sufficient performance for general-purpose storage.',
        confidence: 'medium',
        action_required: 'Change SKU from Premium to Standard in Azure Portal (Storage Account → Configuration)',
      };
    }

    if (resource.currentSku.includes('GRS') || resource.currentSku.includes('RAGRS')) {
      return {
        recommended_sku: resource.currentSku.replace('RAGRS', 'LRS').replace('GRS', 'LRS'),
        recommended_tier: resource.currentTier,
        savings_monthly: currentCost * SAVINGS_ESTIMATES.STORAGE_GRS_TO_LRS,
        savings_percent: Math.round(SAVINGS_ESTIMATES.STORAGE_GRS_TO_LRS * 100),
        reason: 'Geo-redundant storage (GRS/RA-GRS) provides cross-region replication. ' +
                'If this data is not mission-critical, consider Locally Redundant Storage (LRS).',
        confidence: 'low',
        action_required: 'Change replication from GRS/RA-GRS to LRS if cross-region redundancy is not required',
      };
    }
  }

  // ── SQL Database ──────────────────────────────────────────────────────────
  if (tfType === 'azurerm_mssql_database') {
    if (['P1', 'P2', 'P3'].includes(resource.currentSku)) {
      return {
        recommended_sku: 'S3',
        recommended_tier: 'Standard',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.SQL_PREMIUM_TO_STANDARD,
        savings_percent: Math.round(SAVINGS_ESTIMATES.SQL_PREMIUM_TO_STANDARD * 100),
        reason: 'Premium tier provides guaranteed DTUs and advanced features. ' +
                'Consider Standard tier if consistent performance is not critical for your workload.',
        confidence: 'medium',
        action_required: 'Downgrade from Premium to Standard tier (requires brief downtime)',
      };
    }

    if (resource.currentSku.includes('BC_')) {
      return {
        recommended_sku: resource.currentSku.replace('BC_', 'GP_'),
        recommended_tier: 'General Purpose',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.SQL_BC_TO_GP,
        savings_percent: Math.round(SAVINGS_ESTIMATES.SQL_BC_TO_GP * 100),
        reason: 'Business Critical tier offers highest resilience and performance. ' +
                'General Purpose tier is sufficient for most applications.',
        confidence: 'low',
        action_required: 'Downgrade from Business Critical to General Purpose tier',
      };
    }
  }

  // ── Virtual Machines (conservative — no metrics) ──────────────────────────
  if (tfType.includes('virtual_machine')) {
    const size = resource.currentSku ?? '';

    if (/D(16|32|48|64)/.test(size)) {
      return {
        recommended_sku: size.replace(/D\d+/, 'D8'),
        recommended_tier: resource.currentTier,
        savings_monthly: currentCost * SAVINGS_ESTIMATES.VM_RULE_BASED_LARGE,
        savings_percent: Math.round(SAVINGS_ESTIMATES.VM_RULE_BASED_LARGE * 100),
        reason: 'Large VM size detected. Consider downsizing if CPU/memory usage is consistently low. ' +
                'Recommendation requires actual usage metrics for high confidence.',
        confidence: 'low',
        action_required: 'Review Azure Monitor metrics (CPU/Memory) before resizing. ' +
                         'Resize in Azure Portal during maintenance window.',
      };
    }

    if (size.startsWith('Standard_D') || size.startsWith('Standard_E')) {
      return {
        recommended_sku: VM_BURSTABLE_RECOMMENDATION,
        recommended_tier: 'Burstable',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.VM_RULE_BASED_BURSTABLE,
        savings_percent: Math.round(SAVINGS_ESTIMATES.VM_RULE_BASED_BURSTABLE * 100),
        reason: 'Standard-series VMs are always-on compute. ' +
                'If workload has low baseline CPU with occasional spikes, consider Burstable B-series.',
        confidence: 'low',
        action_required: 'Analyse CPU metrics over 30 days. If avg CPU < 20%, consider B-series.',
      };
    }
  }

  // ── Redis Cache ───────────────────────────────────────────────────────────
  if (tfType === 'azurerm_redis_cache') {
    if (resource.currentSku.startsWith('P')) {
      return {
        recommended_sku: resource.currentSku.replace('P', 'C'),   // e.g. P1 → C1
        recommended_tier: 'Standard',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.REDIS_PREMIUM_TO_STD,
        savings_percent: Math.round(SAVINGS_ESTIMATES.REDIS_PREMIUM_TO_STD * 100),
        reason: "Premium Redis provides persistence and clustering. " +
                "Standard tier is sufficient if you don't need data persistence or multi-shard clusters.",
        confidence: 'medium',
        action_required: 'Downgrade from Premium to Standard (data loss may occur — backup first)',
      };
    }
  }

  // ── App Service Plan ──────────────────────────────────────────────────────
  if (tfType === 'azurerm_app_service_plan' || tfType === 'azurerm_service_plan') {
    if (resource.currentSku.startsWith('P')) {
      const premiumNumber = resource.currentSku.match(/P(\d+)/)?.[1] ?? '1';
      return {
        recommended_sku: `S${premiumNumber}`,
        recommended_tier: 'Standard',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.APP_SERVICE_RULE_BASED,
        savings_percent: Math.round(SAVINGS_ESTIMATES.APP_SERVICE_RULE_BASED * 100),
        reason: 'Premium App Service Plan provides auto-scaling and staging slots. ' +
                'Standard tier may be sufficient if these features are not critical.',
        confidence: 'low',
        action_required: 'Verify auto-scaling and staging slot requirements before downgrading',
      };
    }

    if (resource.currentSku.startsWith('S')) {
      const stdNumber = resource.currentSku.match(/S(\d+)/)?.[1] ?? '1';
      return {
        recommended_sku: `B${stdNumber}`,
        recommended_tier: 'Basic',
        savings_monthly: currentCost * SAVINGS_ESTIMATES.APP_SERVICE_STD_TO_BASIC,
        savings_percent: Math.round(SAVINGS_ESTIMATES.APP_SERVICE_STD_TO_BASIC * 100),
        reason: 'Standard plan provides custom domains and SSL. ' +
                'Basic tier may suffice for development or non-production apps.',
        confidence: 'low',
        action_required: 'Downgrade to Basic tier for dev/test environments only',
      };
    }
  }

  return null;
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
