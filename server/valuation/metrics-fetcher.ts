/**
 * Azure Monitor Metrics Fetcher
 * Fetches actual resource usage metrics for cost optimization recommendations
 */

import type { UsageMetrics } from '@shared/schema';

// Metric definitions by Azure resource type
const METRIC_DEFINITIONS: Record<string, string[]> = {
  'Microsoft.Compute/virtualMachines': [
    'Percentage CPU',
    'Available Memory Bytes',
    'Network In Total',
    'Network Out Total'
  ],
  'Microsoft.Storage/storageAccounts': [
    'UsedCapacity',
    'Transactions',
    'Ingress',
    'Egress'
  ],
  'Microsoft.Sql/servers/databases': [
    'dtu_consumption_percent',
    'cpu_percent',
    'storage_percent'
  ],
  'Microsoft.Web/sites': [
    'CpuTime',
    'MemoryWorkingSet',
    'AverageResponseTime',
    'Http5xx'
  ],
  'Microsoft.Web/serverFarms': [
    'CpuPercentage',
    'MemoryPercentage'
  ],
  'Microsoft.Cache/redis': [
    'usedmemorypercentage',
    'connectedclients',
    'cachehits',
    'cachemisses'
  ],
  'Microsoft.DBforPostgreSQL/flexibleServers': [
    'cpu_percent',
    'memory_percent',
    'storage_percent'
  ],
  'Microsoft.DBforMySQL/flexibleServers': [
    'cpu_percent',
    'memory_percent',
    'storage_percent'
  ]
};

/**
 * Fetch metrics for a single resource from Azure Monitor
 * @param resourceId - Full Azure resource ID
 * @param resourceType - Azure resource type (e.g., "Microsoft.Compute/virtualMachines")
 * @param accessToken - Azure access token
 * @param timespan - ISO8601 duration (default: PT168H = 7 days)
 */
export async function fetchResourceMetrics(
  resourceId: string,
  resourceType: string,
  accessToken: string,
  timespan: string = 'PT168H'
): Promise<UsageMetrics | null> {

  const metricNames = METRIC_DEFINITIONS[resourceType];
  if (!metricNames || metricNames.length === 0) {
    console.log(`   ⚠️  No metrics defined for ${resourceType}`);
    return null;
  }

  const apiUrl = `https://management.azure.com${resourceId}/providers/Microsoft.Insights/metrics`;
  const params = new URLSearchParams({
    'api-version': '2023-10-01',
    'timespan': timespan,
    'interval': 'PT1H', // 1-hour granularity
    'metricnames': metricNames.join(','),
    'aggregation': 'Average,Maximum'
  });

  try {
    const response = await fetch(`${apiUrl}?${params}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const statusText = response.statusText || response.status;
      console.warn(`   ⚠️  Metrics fetch failed for ${resourceId.split('/').pop()}: ${statusText}`);
      return null;
    }

    const data = await response.json();

    // Calculate statistics for recommendation engine
    const statistics = calculateMetricStatistics(data.value || [], resourceType);

    // Calculate timespan
    const now = new Date();
    const startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

    return {
      resourceId,
      resourceType,
      timespan: {
        start: startTime.toISOString(),
        end: now.toISOString()
      },
      metrics: data.value || [],
      statistics
    };

  } catch (error: any) {
    console.error(`   ❌ Failed to fetch metrics for ${resourceId}:`, error.message);
    return null;
  }
}

/**
 * Calculate statistical summary from raw metrics
 * @param metrics - Raw metrics from Azure Monitor API
 * @param resourceType - Resource type for context
 */
function calculateMetricStatistics(metrics: any[], resourceType: string): any {
  const stats: any = { sampleCount: 0 };

  for (const metric of metrics) {
    const metricName = metric.name?.value || '';
    const timeseries = metric.timeseries?.[0]?.data || [];

    if (timeseries.length === 0) continue;

    const averages = timeseries.map((d: any) => d.average).filter((v: any) => v !== undefined && v !== null);
    const maximums = timeseries.map((d: any) => d.maximum).filter((v: any) => v !== undefined && v !== null);

    stats.sampleCount = Math.max(stats.sampleCount, averages.length);

    // Map to standardized stat names for different resource types
    if (metricName === 'Percentage CPU' || metricName === 'cpu_percent') {
      stats.avgCpuPercent = average(averages);
      stats.maxCpuPercent = maximums.length > 0 ? Math.max(...maximums) : stats.avgCpuPercent;
    } else if (metricName === 'Available Memory Bytes') {
      // Convert to percentage (assume total memory based on available)
      // If available memory is high, usage is low
      const avgAvailable = average(averages);
      // Conservative estimate: if avg available > 50% of assumed max, usage < 50%
      stats.avgMemoryPercent = avgAvailable > 0 ? Math.min(100, 100 - (avgAvailable / (100 * 1024 * 1024 * 1024)) * 100) : 50;
    } else if (metricName === 'MemoryPercentage' || metricName === 'memory_percent') {
      stats.avgMemoryPercent = average(averages);
    } else if (metricName === 'MemoryWorkingSet') {
      // Convert bytes to percentage (assume 2GB max for web apps)
      const avgBytes = average(averages);
      stats.avgMemoryPercent = (avgBytes / (2 * 1024 * 1024 * 1024)) * 100;
    } else if (metricName === 'UsedCapacity') {
      stats.avgStorageUsedGB = average(averages) / (1024 * 1024 * 1024);
    } else if (metricName === 'dtu_consumption_percent') {
      stats.avgDtuPercent = average(averages);
    } else if (metricName === 'CpuPercentage' || metricName === 'CpuTime') {
      stats.avgCpuPercent = average(averages);
      stats.maxCpuPercent = maximums.length > 0 ? Math.max(...maximums) : stats.avgCpuPercent;
    } else if (metricName === 'usedmemorypercentage') {
      stats.avgMemoryPercent = average(averages);
    } else if (metricName === 'storage_percent') {
      stats.avgStorageUsedGB = average(averages); // Already in percent, treat as GB for now
    }
  }

  return stats;
}

/**
 * Calculate average of number array
 */
function average(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

/**
 * Batch fetch metrics for multiple resources with rate limiting
 * @param resources - Array of { id, type } objects
 * @param accessToken - Azure access token
 */
export async function fetchMetricsForResources(
  resources: Array<{ id: string; type: string }>,
  accessToken: string
): Promise<Map<string, UsageMetrics>> {
  const metricsMap = new Map<string, UsageMetrics>();
  const batchSize = 5; // Avoid rate limiting (Azure Monitor allows ~60 req/min)

  console.log(`\n📊 Fetching usage metrics for ${resources.length} resource(s)...`);

  for (let i = 0; i < resources.length; i += batchSize) {
    const batch = resources.slice(i, i + batchSize);

    const batchPromises = batch.map(async (resource) => {
      const metrics = await fetchResourceMetrics(resource.id, resource.type, accessToken);
      if (metrics) {
        metricsMap.set(resource.id, metrics);
        console.log(`   ✅ Fetched metrics for ${resource.id.split('/').pop()} (${metrics.statistics?.sampleCount || 0} samples)`);
      }
    });

    await Promise.all(batchPromises);

    // Small delay between batches to avoid rate limiting
    if (i + batchSize < resources.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log(`   ✅ Successfully fetched metrics for ${metricsMap.size}/${resources.length} resource(s)\n`);
  return metricsMap;
}
