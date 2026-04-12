/**
 * Azure Monitor Metrics Fetcher
 * Fetches actual resource usage metrics for cost optimization recommendations
 */

import type { UsageMetrics } from '@shared/schema';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Metrics');

// Known VM sizes and their memory in GB for accurate memory percentage calculation
const VM_SIZE_MEMORY_GB: Record<string, number> = {
  'Standard_B1s': 1, 'Standard_B1ms': 2, 'Standard_B2s': 4, 'Standard_B2ms': 8,
  'Standard_B4ms': 16, 'Standard_B8ms': 32, 'Standard_B12ms': 48, 'Standard_B16ms': 64,
  'Standard_D2s_v5': 8, 'Standard_D4s_v5': 16, 'Standard_D8s_v5': 32, 'Standard_D16s_v5': 64,
  'Standard_D32s_v5': 128, 'Standard_D2s_v4': 8, 'Standard_D4s_v4': 16, 'Standard_D8s_v4': 32,
  'Standard_D2s_v3': 8, 'Standard_D4s_v3': 16, 'Standard_D8s_v3': 32,
  'Standard_D2as_v5': 8, 'Standard_D4as_v5': 16, 'Standard_D8as_v5': 32,
  'Standard_E2s_v5': 16, 'Standard_E4s_v5': 32, 'Standard_E8s_v5': 64, 'Standard_E16s_v5': 128,
  'Standard_E2s_v4': 16, 'Standard_E4s_v4': 32, 'Standard_E2s_v3': 16, 'Standard_E4s_v3': 32,
  'Standard_F2s_v2': 4, 'Standard_F4s_v2': 8, 'Standard_F8s_v2': 16, 'Standard_F16s_v2': 32,
  'Standard_DS1_v2': 3.5, 'Standard_DS2_v2': 7, 'Standard_DS3_v2': 14, 'Standard_DS4_v2': 28,
  'Standard_A1_v2': 2, 'Standard_A2_v2': 4, 'Standard_A4_v2': 8,
};

import {
  METRICS_DEFAULT_TIMESPAN,
  METRICS_DEFAULT_INTERVAL,
  METRICS_ANALYSIS_PERIOD_MS,
  METRICS_BATCH_SIZE,
  METRICS_BATCH_DELAY_MS,
  VM_ASSUMED_MAX_MEMORY_GB,
  APP_SERVICE_ASSUMED_MAX_MEMORY_GB,
  BYTES_PER_GB,
} from '../config/constants.js';

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
  timespan: string = METRICS_DEFAULT_TIMESPAN,
  vmSize?: string
): Promise<UsageMetrics | null> {

  const metricNames = METRIC_DEFINITIONS[resourceType];
  if (!metricNames || metricNames.length === 0) {
    log.info('No metrics defined for resource type', { resourceType });
    return null;
  }

  const apiUrl = `https://management.azure.com${resourceId}/providers/Microsoft.Insights/metrics`;
  const params = new URLSearchParams({
    'api-version': '2023-10-01',
    'timespan': timespan,
    'interval': METRICS_DEFAULT_INTERVAL,
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
      log.warn('Metrics fetch failed', { resource: resourceId.split('/').pop(), status: String(statusText) });
      return null;
    }

    const data = await response.json();

    // Calculate statistics for recommendation engine
    const statistics = calculateMetricStatistics(data.value || [], resourceType, vmSize);

    // Calculate timespan from the configured analysis period
    const now = new Date();
    const startTime = new Date(now.getTime() - METRICS_ANALYSIS_PERIOD_MS);

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
    log.error('Failed to fetch metrics', { resourceId, error: error.message });
    return null;
  }
}

/**
 * Calculate statistical summary from raw metrics
 * @param metrics - Raw metrics from Azure Monitor API
 * @param resourceType - Resource type for context
 */
function calculateMetricStatistics(metrics: any[], resourceType: string, vmSize?: string): any {
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
      // Convert available bytes → used percentage using actual VM memory if known.
      // If available memory is high, usage is low.
      const avgAvailable = average(averages);
      const vmMemoryGB = vmSize ? (VM_SIZE_MEMORY_GB[vmSize] || VM_ASSUMED_MAX_MEMORY_GB) : VM_ASSUMED_MAX_MEMORY_GB;
      const maxBytes = vmMemoryGB * BYTES_PER_GB;
      stats.avgMemoryPercent = avgAvailable > 0
        ? Math.min(100, 100 - (avgAvailable / maxBytes) * 100)
        : 50;
      stats.maxMemoryGB = vmMemoryGB;  // Expose for frontend chart
    } else if (metricName === 'MemoryPercentage' || metricName === 'memory_percent') {
      stats.avgMemoryPercent = average(averages);
    } else if (metricName === 'MemoryWorkingSet') {
      // Convert working-set bytes → percentage using the assumed App Service max memory.
      const avgBytes = average(averages);
      stats.avgMemoryPercent = (avgBytes / (APP_SERVICE_ASSUMED_MAX_MEMORY_GB * BYTES_PER_GB)) * 100;
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
  resources: Array<{ id: string; type: string; vmSize?: string }>,
  accessToken: string
): Promise<Map<string, UsageMetrics>> {
  const metricsMap = new Map<string, UsageMetrics>();
  const batchSize = METRICS_BATCH_SIZE; // See config/constants.ts for rationale

  log.info(`Fetching usage metrics for ${resources.length} resource(s)`);

  for (let i = 0; i < resources.length; i += batchSize) {
    const batch = resources.slice(i, i + batchSize);

    const batchPromises = batch.map(async (resource) => {
      const metrics = await fetchResourceMetrics(resource.id, resource.type, accessToken, METRICS_DEFAULT_TIMESPAN, resource.vmSize);
      if (metrics) {
        metricsMap.set(resource.id, metrics);
        log.info('Fetched metrics', { resource: resource.id.split('/').pop(), samples: metrics.statistics?.sampleCount || 0 });
      }
    });

    await Promise.all(batchPromises);

    // Delay between batches to respect Azure Monitor rate limits
    if (i + batchSize < resources.length) {
      await new Promise(resolve => setTimeout(resolve, METRICS_BATCH_DELAY_MS));
    }
  }

  log.info('Metrics fetch complete', { fetched: metricsMap.size, total: resources.length });
  return metricsMap;
}
