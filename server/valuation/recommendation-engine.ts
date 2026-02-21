/**
 * Recommendation Engine for Valuation Module
 *
 * Generates cost optimization recommendations based on resource SKU/tier and usage metrics.
 * - With metrics: High-confidence usage-based recommendations
 * - Without metrics: Low/medium-confidence rule-based recommendations
 */

import type { ValuationResource, RemediationPlan, UsageMetrics } from '@shared/schema';

/**
 * Generates cost optimization recommendation for a resource
 * Returns null if resource is already optimized
 *
 * @param resource - Valuation resource to analyze
 * @param currentCost - Current monthly cost
 * @param usageMetrics - Optional Azure Monitor metrics for usage-based recommendations
 */
export function generateRecommendation(
  resource: ValuationResource,
  currentCost: number,
  usageMetrics?: UsageMetrics
): RemediationPlan | null {

  // If metrics available, use usage-based recommendations (high confidence)
  if (usageMetrics && usageMetrics.statistics) {
    const recommendation = generateUsageBasedRecommendation(resource, currentCost, usageMetrics);
    if (recommendation) return recommendation;
  }

  // Fallback to rule-based recommendations (low/medium confidence)
  return generateRuleBasedRecommendation(resource, currentCost);
}

/**
 * NEW: Usage-based recommendations with high confidence
 * Analyzes actual CPU/Memory/DTU usage over 7 days to provide accurate recommendations
 */
function generateUsageBasedRecommendation(
  resource: ValuationResource,
  currentCost: number,
  metrics: UsageMetrics
): RemediationPlan | null {

  const stats = metrics.statistics!;
  const terraformType = resource.terraformType;

  // Virtual Machines - CPU/Memory based downsizing
  if (terraformType?.includes('virtual_machine')) {
    const avgCpu = stats.avgCpuPercent || 100;
    const avgMem = stats.avgMemoryPercent || 100;
    const maxCpu = stats.maxCpuPercent || 100;

    // High confidence downsizing: Avg CPU < 20% AND Avg Memory < 30% for 7 days
    if (avgCpu < 20 && avgMem < 30 && stats.sampleCount >= 100) {
      const currentSize = resource.currentSku;
      const recommendedSize = suggestSmallerVmSize(currentSize);

      return {
        recommended_sku: recommendedSize,
        recommended_tier: resource.currentTier || 'Standard',
        savings_monthly: currentCost * 0.50, // 50% typical savings for downsizing
        savings_percent: 50,
        reason: `Usage analysis over 7 days shows consistently low resource utilization (Avg CPU: ${avgCpu.toFixed(1)}%, Avg Memory: ${avgMem.toFixed(1)}%). VM is significantly over-provisioned.`,
        confidence: 'high',
        action_required: `Resize from ${currentSize} to ${recommendedSize}. Schedule during maintenance window (requires reboot).`
      };
    }

    // Medium confidence for B-series: Baseline CPU low with occasional spikes
    if (avgCpu < 30 && maxCpu < 70 && !currentSize.startsWith('Standard_B')) {
      return {
        recommended_sku: 'Standard_B4ms',
        recommended_tier: 'Burstable',
        savings_monthly: currentCost * 0.60,
        savings_percent: 60,
        reason: `Low baseline CPU usage (${avgCpu.toFixed(1)}%) with moderate peaks (${maxCpu.toFixed(1)}%). Burstable B-series VMs are ideal for this workload pattern.`,
        confidence: 'high',
        action_required: 'Migrate to B-series during low-traffic period. Monitor burst credits for first week.'
      };
    }
  }

  // SQL Database - DTU/vCore optimization
  if (terraformType === 'azurerm_mssql_database') {
    const avgDtu = stats.avgDtuPercent || 100;

    if (avgDtu < 25 && stats.sampleCount >= 100) {
      const currentSku = resource.currentSku;
      const recommendedSku = suggestSmallerSqlTier(currentSku);

      return {
        recommended_sku: recommendedSku,
        recommended_tier: 'Standard',
        savings_monthly: currentCost * 0.40,
        savings_percent: 40,
        reason: `Database DTU usage is very low (${avgDtu.toFixed(1)}% average over 7 days). Current tier is over-provisioned for the workload.`,
        confidence: 'high',
        action_required: `Downgrade from ${currentSku} to ${recommendedSku}. Backup database before tier change.`
      };
    }
  }

  // App Service Plan - CPU/Memory based
  if (terraformType === 'azurerm_app_service_plan') {
    const avgCpu = stats.avgCpuPercent || 100;
    const avgMem = stats.avgMemoryPercent || 100;

    if (avgCpu < 30 && avgMem < 40 && stats.sampleCount >= 100) {
      const currentSku = resource.currentSku;
      const recommendedSku = suggestSmallerAppServicePlan(currentSku);

      return {
        recommended_sku: recommendedSku,
        recommended_tier: 'Standard',
        savings_monthly: currentCost * 0.35,
        savings_percent: 35,
        reason: `App Service Plan shows low utilization (CPU: ${avgCpu.toFixed(1)}%, Memory: ${avgMem.toFixed(1)}%). Can safely downsize.`,
        confidence: 'high',
        action_required: `Scale down from ${currentSku} to ${recommendedSku}. No downtime required.`
      };
    }
  }

  // Storage Account - Usage-based tier recommendation
  if (terraformType === 'azurerm_storage_account') {
    const usedGB = stats.avgStorageUsedGB || 0;

    // If very low usage, suggest Cool tier
    if (usedGB < 50 && resource.currentSku.includes('Hot')) {
      return {
        recommended_sku: resource.currentSku.replace('Hot', 'Cool'),
        recommended_tier: 'Cool',
        savings_monthly: currentCost * 0.30,
        savings_percent: 30,
        reason: `Storage usage is minimal (${usedGB.toFixed(1)} GB). Cool tier is more cost-effective for infrequently accessed data.`,
        confidence: 'medium',
        action_required: 'Change access tier to Cool. Higher access costs apply if frequently accessed.'
      };
    }
  }

  return null; // No usage-based recommendation available
}

// Helper functions for size suggestions
function suggestSmallerVmSize(currentSize: string): string {
  const sizeMap: Record<string, string> = {
    'Standard_D16s_v3': 'Standard_D8s_v3',
    'Standard_D32s_v3': 'Standard_D16s_v3',
    'Standard_D8s_v3': 'Standard_D4s_v3',
    'Standard_D4s_v3': 'Standard_D2s_v3',
    'Standard_E16s_v3': 'Standard_E8s_v3',
    'Standard_E8s_v3': 'Standard_E4s_v3',
    'Standard_D16': 'Standard_D8s_v3',
    'Standard_D32': 'Standard_D16s_v3',
    'Standard_D8': 'Standard_D4s_v3',
    'Standard_D4': 'Standard_D2s_v3'
  };
  return sizeMap[currentSize] || 'Standard_D2s_v3';
}

function suggestSmallerSqlTier(currentSku: string): string {
  const tierMap: Record<string, string> = {
    'P3': 'S3',
    'P2': 'S2',
    'P1': 'S1',
    'S3': 'S2',
    'S2': 'S1'
  };
  return tierMap[currentSku] || 'S1';
}

function suggestSmallerAppServicePlan(currentSku: string): string {
  const planMap: Record<string, string> = {
    'P3v2': 'P1v2',
    'P2v2': 'P1v2',
    'P1v2': 'S1',
    'S3': 'S2',
    'S2': 'S1'
  };
  return planMap[currentSku] || 'S1';
}

/**
 * Rule-based recommendations (fallback when metrics unavailable)
 * Returns low/medium confidence recommendations based on SKU/tier only
 */
function generateRuleBasedRecommendation(
  resource: ValuationResource,
  currentCost: number
): RemediationPlan | null {
  const terraformType = resource.terraformType;
  if (!terraformType) return null;

  // Storage Account recommendations
  if (terraformType === 'azurerm_storage_account') {
    // Premium → Standard recommendation
    if (resource.currentSku.includes('Premium')) {
      const newSku = resource.currentSku.replace('Premium', 'Standard');
      return {
        recommended_sku: newSku,
        recommended_tier: 'Standard',
        savings_monthly: currentCost * 0.60, // 60% savings typical for Premium → Standard
        savings_percent: 60,
        reason: 'Premium Storage is over-provisioned for most workloads. Standard tier provides sufficient performance for general-purpose storage.',
        confidence: 'medium',
        action_required: 'Change SKU from Premium to Standard in Azure Portal (Storage Account → Configuration)'
      };
    }

    // GRS → LRS recommendation for non-critical data
    if (resource.currentSku.includes('GRS') || resource.currentSku.includes('RAGRS')) {
      const newSku = resource.currentSku.replace('GRS', 'LRS').replace('RAGRS', 'LRS');
      return {
        recommended_sku: newSku,
        recommended_tier: resource.currentTier,
        savings_monthly: currentCost * 0.50, // 50% savings for geo-redundancy
        savings_percent: 50,
        reason: 'Geo-redundant storage (GRS/RA-GRS) provides cross-region replication. If this data is not mission-critical, consider Locally Redundant Storage (LRS).',
        confidence: 'low', // Low confidence - depends on business requirements
        action_required: 'Change replication from GRS/RA-GRS to LRS if cross-region redundancy is not required'
      };
    }
  }

  // SQL Database recommendations
  if (terraformType === 'azurerm_mssql_database') {
    // Premium → Standard recommendation
    if (resource.currentSku === 'P1' || resource.currentSku === 'P2' || resource.currentSku === 'P3') {
      return {
        recommended_sku: 'S3',
        recommended_tier: 'Standard',
        savings_monthly: currentCost * 0.45, // 45% typical savings
        savings_percent: 45,
        reason: 'Premium tier provides guaranteed DTUs and advanced features. Consider Standard tier if consistent performance is not critical for your workload.',
        confidence: 'medium',
        action_required: 'Downgrade from Premium to Standard tier (requires brief downtime)'
      };
    }

    // Business Critical → General Purpose recommendation
    if (resource.currentSku.includes('BC_')) {
      const newSku = resource.currentSku.replace('BC_', 'GP_');
      return {
        recommended_sku: newSku,
        recommended_tier: 'General Purpose',
        savings_monthly: currentCost * 0.50,
        savings_percent: 50,
        reason: 'Business Critical tier offers highest resilience and performance. General Purpose tier is sufficient for most applications.',
        confidence: 'low', // Low confidence - depends on RTO/RPO requirements
        action_required: 'Downgrade from Business Critical to General Purpose tier'
      };
    }
  }

  // Virtual Machine recommendations (conservative without metrics)
  if (terraformType.includes('virtual_machine')) {
    const size = resource.currentSku;

    // Large VMs (D16, D32, etc.)
    if (size?.includes('D16') || size?.includes('D32') || size?.includes('D48') || size?.includes('D64')) {
      const recommendedSize = size.replace(/D\d+/, 'D8'); // Suggest D8
      return {
        recommended_sku: recommendedSize,
        recommended_tier: resource.currentTier,
        savings_monthly: currentCost * 0.50,
        savings_percent: 50,
        reason: 'Large VM size detected. Consider downsizing if CPU/memory usage is consistently low. Recommendation requires actual usage metrics for high confidence.',
        confidence: 'low', // Low confidence without metrics
        action_required: 'Review Azure Monitor metrics (CPU/Memory) before resizing. Resize in Azure Portal during maintenance window.'
      };
    }

    // Standard → Burstable for low-usage VMs
    if (size?.startsWith('Standard_D') || size?.startsWith('Standard_E')) {
      return {
        recommended_sku: 'Standard_B4ms', // Burstable B-series
        recommended_tier: 'Burstable',
        savings_monthly: currentCost * 0.65,
        savings_percent: 65,
        reason: 'Standard-series VMs are always-on compute. If workload has low baseline CPU with occasional spikes, consider Burstable B-series.',
        confidence: 'low', // Very low confidence without usage data
        action_required: 'Analyze CPU metrics over 30 days. If avg CPU < 20%, consider B-series.'
      };
    }
  }

  // Redis Cache recommendations
  if (terraformType === 'azurerm_redis_cache') {
    // Premium → Standard recommendation
    if (resource.currentSku.startsWith('P')) {
      const newSku = resource.currentSku.replace('P', 'C'); // P1 → C1
      return {
        recommended_sku: newSku,
        recommended_tier: 'Standard',
        savings_monthly: currentCost * 0.40,
        savings_percent: 40,
        reason: 'Premium Redis provides persistence and clustering. Standard tier is sufficient if you don\'t need data persistence or multi-shard clusters.',
        confidence: 'medium',
        action_required: 'Downgrade from Premium to Standard (data loss may occur - backup first)'
      };
    }
  }

  // App Service Plan recommendations
  if (terraformType === 'azurerm_app_service_plan') {
    // Premium → Standard recommendation
    if (resource.currentSku.startsWith('P')) {
      const premiumNumber = resource.currentSku.match(/P(\d+)/)?.[1] || '1';
      const newSku = `S${premiumNumber}`; // P1 → S1, P2 → S2
      return {
        recommended_sku: newSku,
        recommended_tier: 'Standard',
        savings_monthly: currentCost * 0.30,
        savings_percent: 30,
        reason: 'Premium App Service Plan provides auto-scaling and staging slots. Standard tier may be sufficient if these features are not critical.',
        confidence: 'low',
        action_required: 'Verify auto-scaling and staging slot requirements before downgrading'
      };
    }

    // Standard → Basic for simple apps
    if (resource.currentSku.startsWith('S')) {
      const stdNumber = resource.currentSku.match(/S(\d+)/)?.[1] || '1';
      const newSku = `B${stdNumber}`; // S1 → B1, S2 → B2
      return {
        recommended_sku: newSku,
        recommended_tier: 'Basic',
        savings_monthly: currentCost * 0.20,
        savings_percent: 20,
        reason: 'Standard plan provides custom domains and SSL. Basic tier may suffice for development or non-production apps.',
        confidence: 'low',
        action_required: 'Downgrade to Basic tier for dev/test environments only'
      };
    }
  }

  // No recommendation - resource is optimized or unknown type
  return null;
}

/**
 * Calculates total potential savings across all resources
 */
export function calculateTotalSavings(resources: ValuationResource[]): {
  totalMonthlySavings: number;
  totalYearlySavings: number;
  resourcesWithRecommendations: number;
} {
  const resourcesWithRecs = resources.filter(r => r.remediation);
  const totalMonthlySavings = resourcesWithRecs.reduce(
    (sum, r) => sum + (r.remediation?.savings_monthly || 0),
    0
  );

  return {
    totalMonthlySavings,
    totalYearlySavings: totalMonthlySavings * 12,
    resourcesWithRecommendations: resourcesWithRecs.length
  };
}
