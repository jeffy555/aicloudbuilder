/**
 * Azure Usage-Dimension Catalog
 *
 * Defines usage dimensions for each Azure resource type with low/medium/high
 * profile defaults. Resources with only SKU-driven pricing (e.g. VMs, App Service Plans)
 * are "exact" and don't need usage dimensions. Resources with consumption-based pricing
 * (e.g. Storage, Key Vault) need usage assumptions and are "estimated".
 */

import type { UsageProfile } from '../shared/schema';

export interface UsageDimension {
  key: string;
  label: string;
  unit: string;
  /** Defaults per profile */
  low: number;
  medium: number;
  high: number;
}

export interface ResourceUsageCatalog {
  /** Human-readable description of what drives cost */
  costDriver: string;
  /** Usage dimensions needed for cost calculation */
  dimensions: UsageDimension[];
}

// ─── Usage Catalog ──────────────────────────────────────────────────────────

export const AZURE_USAGE_CATALOG: Record<string, ResourceUsageCatalog> = {
  'azurerm_storage_account': {
    costDriver: 'Data stored + transactions + egress',
    dimensions: [
      { key: 'hot_gb', label: 'Hot storage', unit: 'GB', low: 10, medium: 50, high: 500 },
      { key: 'cool_gb', label: 'Cool storage', unit: 'GB', low: 0, medium: 20, high: 200 },
      { key: 'transactions_10k', label: 'Transactions', unit: '10K ops', low: 1, medium: 10, high: 100 },
      { key: 'egress_gb', label: 'Egress', unit: 'GB', low: 1, medium: 10, high: 100 },
    ],
  },

  'azurerm_key_vault': {
    costDriver: 'Operations (secrets, keys, certificates)',
    dimensions: [
      { key: 'operations_10k', label: 'Operations', unit: '10K ops', low: 0.5, medium: 1, high: 10 },
    ],
  },

  'azurerm_log_analytics_workspace': {
    costDriver: 'Data ingestion + retention',
    dimensions: [
      { key: 'ingestion_gb_day', label: 'Daily ingestion', unit: 'GB/day', low: 1, medium: 5, high: 50 },
      { key: 'retention_extra_days', label: 'Retention beyond 31d', unit: 'days', low: 0, medium: 30, high: 180 },
    ],
  },

  'azurerm_cosmosdb_account': {
    costDriver: 'Provisioned RU/s + stored data',
    dimensions: [
      { key: 'ru_per_sec', label: 'Request Units', unit: 'RU/s', low: 400, medium: 1000, high: 10000 },
      { key: 'storage_gb', label: 'Data stored', unit: 'GB', low: 5, medium: 50, high: 500 },
    ],
  },

  'azurerm_cdn_frontdoor_profile': {
    costDriver: 'Requests + data transfer',
    dimensions: [
      { key: 'requests_million', label: 'Requests', unit: 'M/month', low: 0.1, medium: 1, high: 10 },
      { key: 'egress_gb', label: 'Data transfer', unit: 'GB', low: 10, medium: 100, high: 1000 },
    ],
  },

  'azurerm_frontdoor': {
    costDriver: 'Routing rules + data transfer',
    dimensions: [
      { key: 'requests_million', label: 'Requests', unit: 'M/month', low: 0.1, medium: 1, high: 10 },
      { key: 'egress_gb', label: 'Data transfer', unit: 'GB', low: 10, medium: 100, high: 1000 },
    ],
  },

  'azurerm_application_insights': {
    costDriver: 'Data ingestion volume',
    dimensions: [
      { key: 'ingestion_gb_month', label: 'Monthly ingestion', unit: 'GB', low: 1, medium: 5, high: 50 },
    ],
  },

  'azurerm_function_app': {
    costDriver: 'Executions + execution time (GB-s)',
    dimensions: [
      { key: 'executions_million', label: 'Executions', unit: 'M/month', low: 0.5, medium: 2, high: 20 },
      { key: 'gb_seconds', label: 'Compute (GB-s)', unit: 'GB-s', low: 100_000, medium: 400_000, high: 2_000_000 },
    ],
  },

  'azurerm_linux_function_app': {
    costDriver: 'Executions + execution time (GB-s)',
    dimensions: [
      { key: 'executions_million', label: 'Executions', unit: 'M/month', low: 0.5, medium: 2, high: 20 },
      { key: 'gb_seconds', label: 'Compute (GB-s)', unit: 'GB-s', low: 100_000, medium: 400_000, high: 2_000_000 },
    ],
  },

  'azurerm_logic_app_workflow': {
    costDriver: 'Action executions',
    dimensions: [
      { key: 'actions_per_month', label: 'Actions', unit: 'actions/month', low: 1_000, medium: 10_000, high: 100_000 },
    ],
  },

  'azurerm_cdn_profile': {
    costDriver: 'Data transfer volume',
    dimensions: [
      { key: 'egress_gb', label: 'Data transfer', unit: 'GB', low: 10, medium: 100, high: 1000 },
    ],
  },

  'azurerm_container_group': {
    costDriver: 'vCPU-seconds + memory GB-seconds',
    dimensions: [
      { key: 'hours_per_month', label: 'Runtime', unit: 'hours/month', low: 100, medium: 500, high: 730 },
    ],
  },

  'azurerm_container_app': {
    costDriver: 'vCPU-seconds + memory GB-seconds',
    dimensions: [
      { key: 'hours_per_month', label: 'Runtime', unit: 'hours/month', low: 100, medium: 500, high: 730 },
    ],
  },

  'azurerm_data_factory': {
    costDriver: 'Pipeline activity runs + data movement',
    dimensions: [
      { key: 'activity_runs', label: 'Activity runs', unit: 'runs/month', low: 1_000, medium: 10_000, high: 100_000 },
    ],
  },

  'azurerm_traffic_manager_profile': {
    costDriver: 'DNS queries',
    dimensions: [
      { key: 'dns_queries_million', label: 'DNS queries', unit: 'M/month', low: 0.1, medium: 1, high: 10 },
    ],
  },

  'azurerm_automation_account': {
    costDriver: 'Job runtime minutes',
    dimensions: [
      { key: 'job_minutes', label: 'Job runtime', unit: 'min/month', low: 100, medium: 500, high: 5_000 },
    ],
  },

  'azurerm_recovery_services_vault': {
    costDriver: 'Protected instances + backup storage',
    dimensions: [
      { key: 'protected_instances', label: 'Protected VMs', unit: 'instances', low: 1, medium: 3, high: 10 },
      { key: 'backup_storage_gb', label: 'Backup storage', unit: 'GB', low: 20, medium: 100, high: 500 },
    ],
  },
};

/**
 * Get usage defaults for a resource type and profile.
 * Returns a map of dimension key -> value.
 */
export function getUsageDefaults(
  resourceType: string,
  profile: UsageProfile
): Record<string, number> {
  const catalog = AZURE_USAGE_CATALOG[resourceType];
  if (!catalog || profile === 'custom') return {};

  const result: Record<string, number> = {};
  for (const dim of catalog.dimensions) {
    result[dim.key] = dim[profile];
  }
  return result;
}

/**
 * Check if a resource type has usage dimensions (consumption-based).
 */
export function hasUsageDimensions(resourceType: string): boolean {
  return resourceType in AZURE_USAGE_CATALOG;
}

/**
 * Get the usage catalog entry for a resource type.
 */
export function getUsageCatalog(resourceType: string): ResourceUsageCatalog | null {
  return AZURE_USAGE_CATALOG[resourceType] || null;
}

/**
 * Maps usage dimension values into the attrs format that azure-pricing-config's
 * calculateCost functions understand. This bridges the usage catalog with the
 * existing pricing engine.
 */
const USAGE_TO_ATTR_MAP: Record<string, (usage: Record<string, number>) => Record<string, any>> = {
  'azurerm_storage_account': (u) => ({
    size_gb: (u.hot_gb || 0) + (u.cool_gb || 0),
  }),
  'azurerm_log_analytics_workspace': (u) => ({
    __usage_gb: (u.ingestion_gb_day || 0) * 30,
  }),
  'azurerm_key_vault': (u) => ({
    __usage_ops_10k: u.operations_10k || 1,
  }),
  'azurerm_cosmosdb_account': (u) => ({
    __usage_ru: u.ru_per_sec || 400,
  }),
  'azurerm_application_insights': (u) => ({
    daily_data_cap_in_gb: (u.ingestion_gb_month || 5) / 30,
  }),
  'azurerm_cdn_profile': (u) => ({
    __usage_egress_gb: u.egress_gb || 100,
  }),
};

/**
 * Apply usage-catalog values to resource attributes so that calculateCost
 * picks them up. Returns a merged copy of attrs.
 */
export function applyUsageToAttrs(
  resourceType: string,
  attrs: Record<string, any>,
  usage: Record<string, number>
): Record<string, any> {
  const mapper = USAGE_TO_ATTR_MAP[resourceType];
  if (!mapper || Object.keys(usage).length === 0) return attrs;
  return { ...attrs, ...mapper(usage) };
}
