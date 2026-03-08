/**
 * Azure resource catalog — all Azure-specific string constants used across
 * the Terraform module.
 *
 * Why a dedicated file?
 *   - Azure resource type strings appear in 5+ files as inline literals.
 *   - When Azure renames or adds a resource type the change is made here once.
 *   - Cloud-provider detection logic reads CLOUD_PROVIDER_PREFIXES so adding
 *     AWS / GCP support is a one-line addition per provider.
 */

// ---------------------------------------------------------------------------
// Cloud provider resource-type prefixes
// ---------------------------------------------------------------------------

export const CLOUD_PROVIDER_PREFIXES = {
  AZURE: 'azurerm_',
  AZURE_AD: 'azuread_',
  AWS:   'aws_',
  GCP:   'google_',
} as const;

/**
 * Detect which cloud provider owns a Terraform resource type.
 */
export function detectProvider(
  resourceType: string
): 'azure' | 'aws' | 'gcp' | 'unknown' {
  if (resourceType.startsWith(CLOUD_PROVIDER_PREFIXES.AZURE) ||
      resourceType.startsWith(CLOUD_PROVIDER_PREFIXES.AZURE_AD)) return 'azure';
  if (resourceType.startsWith(CLOUD_PROVIDER_PREFIXES.AWS))   return 'aws';
  if (resourceType.startsWith(CLOUD_PROVIDER_PREFIXES.GCP))   return 'gcp';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Core Azure resource types used in special-case logic
// ---------------------------------------------------------------------------

/**
 * Resource types that receive special handling (e.g., resource-group
 * containment detection, diagram layout).
 * Using constants avoids scattered string literals across parser files.
 */
export const AZURE_CORE_TYPES = {
  RESOURCE_GROUP:       'azurerm_resource_group',
  VIRTUAL_NETWORK:      'azurerm_virtual_network',
  SUBNET:               'azurerm_subnet',
  NETWORK_SECURITY_GROUP: 'azurerm_network_security_group',
  KEY_VAULT:            'azurerm_key_vault',
  STORAGE_ACCOUNT:      'azurerm_storage_account',
  APP_SERVICE_PLAN:     'azurerm_service_plan',
  LINUX_VM:             'azurerm_linux_virtual_machine',
  WINDOWS_VM:           'azurerm_windows_virtual_machine',
  GENERIC_VM:           'azurerm_virtual_machine',
  SQL_SERVER:           'azurerm_mssql_server',
  SQL_DATABASE:         'azurerm_mssql_database',
  CONTAINER_REGISTRY:   'azurerm_container_registry',
  AKS_CLUSTER:          'azurerm_kubernetes_cluster',
  FUNCTION_APP:         'azurerm_linux_function_app',
  REDIS_CACHE:          'azurerm_redis_cache',
} as const;

/**
 * Azure resource types that support Reserved Instance pricing.
 * Used by the cost-analysis route to decide whether to fetch
 * Reservation price quotes in addition to Consumption prices.
 * Source: https://learn.microsoft.com/azure/cost-management-billing/reservations
 * Last validated: 2026-03-05
 */
export const COMPUTE_RESOURCE_TYPES_WITH_RESERVATIONS = new Set([
  AZURE_CORE_TYPES.LINUX_VM,
  AZURE_CORE_TYPES.WINDOWS_VM,
  AZURE_CORE_TYPES.GENERIC_VM,
  'azurerm_service_plan',
  'azurerm_app_service',
]);

// ---------------------------------------------------------------------------
// Module keyword → resource type mapping (fallback inference)
// ---------------------------------------------------------------------------

/**
 * When a Terraform module's source files cannot be read (remote module or
 * missing local path), we fall back to keyword-matching the module name and
 * source string against this table.
 *
 * Keys are lower-case substrings; values are the inferred primary resource type.
 * Order matters: more specific keywords should appear before generic ones.
 */
export const MODULE_KEYWORD_RESOURCE_MAP: Array<[keyword: string, resourceType: string]> = [
  ['key_vault',    AZURE_CORE_TYPES.KEY_VAULT],
  ['keyvault',     AZURE_CORE_TYPES.KEY_VAULT],
  ['key-vault',    AZURE_CORE_TYPES.KEY_VAULT],
  ['app_service',  'azurerm_app_service'],
  ['app-service',  'azurerm_app_service'],
  ['appservice',   'azurerm_app_service'],
  ['container',    'azurerm_container_group'],
  ['function',     AZURE_CORE_TYPES.FUNCTION_APP],
  ['storage',      AZURE_CORE_TYPES.STORAGE_ACCOUNT],
  ['sql',          AZURE_CORE_TYPES.SQL_SERVER],
  ['cosmos',       'azurerm_cosmosdb_account'],
  ['redis',        AZURE_CORE_TYPES.REDIS_CACHE],
  ['eventhub',     'azurerm_eventhub_namespace'],
  ['event-hub',    'azurerm_eventhub_namespace'],
  ['servicebus',   'azurerm_servicebus_namespace'],
  ['service-bus',  'azurerm_servicebus_namespace'],
  ['aks',          AZURE_CORE_TYPES.AKS_CLUSTER],
  ['kubernetes',   AZURE_CORE_TYPES.AKS_CLUSTER],
  ['network',      AZURE_CORE_TYPES.VIRTUAL_NETWORK],
  ['vnet',         AZURE_CORE_TYPES.VIRTUAL_NETWORK],
];

// ---------------------------------------------------------------------------
// Resource categorisation for diagram layout / cost grouping
// ---------------------------------------------------------------------------

/**
 * Maps Terraform resource type prefixes to human-readable diagram categories.
 * Ordered from most-specific to most-generic — first match wins.
 */
export const RESOURCE_CATEGORY_MAP: Array<[substring: string, category: string]> = [
  ['virtual_machine',        'Compute'],
  ['kubernetes',             'Compute'],
  ['container',              'Compute'],
  ['function_app',           'Compute'],
  ['app_service',            'Compute'],
  ['service_plan',           'Compute'],
  ['storage',                'Storage'],
  ['disk',                   'Storage'],
  ['backup',                 'Storage'],
  ['sql',                    'Database'],
  ['mysql',                  'Database'],
  ['postgresql',             'Database'],
  ['cosmosdb',               'Database'],
  ['redis',                  'Database'],
  ['mariadb',                'Database'],
  ['virtual_network',        'Networking'],
  ['subnet',                 'Networking'],
  ['network',                'Networking'],
  ['firewall',               'Networking'],
  ['dns',                    'Networking'],
  ['load_balancer',          'Networking'],
  ['application_gateway',    'Networking'],
  ['traffic_manager',        'Networking'],
  ['key_vault',              'Security'],
  ['security',               'Security'],
  ['identity',               'Security'],
  ['monitor',                'Observability'],
  ['log_analytics',          'Observability'],
  ['application_insights',   'Observability'],
  ['eventhub',               'Messaging'],
  ['servicebus',             'Messaging'],
  ['notification',           'Messaging'],
];

/**
 * Classify a Terraform resource type string into a diagram category.
 * Falls back to 'Other' when no prefix matches.
 */
export function classifyResourceCategory(resourceType: string): string {
  const lower = resourceType.toLowerCase();
  for (const [substring, category] of RESOURCE_CATEGORY_MAP) {
    if (lower.includes(substring)) return category;
  }
  return 'Other';
}

// ---------------------------------------------------------------------------
// Relationship patterns — attributes that imply a dependency edge
// ---------------------------------------------------------------------------

/**
 * Each entry declares which HCL attribute, when present on a resource,
 * implies an edge to the resource whose name/id is its value.
 *
 * Having this table in one place means adding a new relationship
 * (e.g., when Azure introduces a new resource type) is a single array push.
 */
export const RELATIONSHIP_PATTERNS: ReadonlyArray<{
  attribute: string;
  type: 'contains' | 'uses' | 'depends_on' | 'references';
  description: string;
}> = [
  { attribute: 'resource_group_name',      type: 'contains',   description: 'Resource is contained in Resource Group' },
  { attribute: 'app_service_plan_id',      type: 'depends_on', description: 'App Service depends on App Service Plan' },
  { attribute: 'service_plan_id',          type: 'depends_on', description: 'App Service depends on Service Plan' },
  { attribute: 'storage_account_name',     type: 'uses',       description: 'Resource uses Storage Account' },
  { attribute: 'storage_account_id',       type: 'uses',       description: 'Resource uses Storage Account' },
  { attribute: 'subnet_id',               type: 'uses',       description: 'Resource uses Subnet' },
  { attribute: 'virtual_network_id',       type: 'uses',       description: 'Resource uses Virtual Network' },
  { attribute: 'network_security_group_id',type: 'uses',       description: 'Resource uses Network Security Group' },
  { attribute: 'server_name',              type: 'depends_on', description: 'Resource depends on Database Server' },
  { attribute: 'server_id',               type: 'depends_on', description: 'Resource depends on Server' },
  { attribute: 'container_registry_name', type: 'uses',       description: 'Resource uses Container Registry' },
  { attribute: 'container_registry_id',   type: 'uses',       description: 'Resource uses Container Registry' },
  { attribute: 'key_vault_id',            type: 'uses',       description: 'Resource uses Key Vault' },
  { attribute: 'workspace_id',            type: 'uses',       description: 'Resource uses Log Analytics Workspace' },
  { attribute: 'eventhub_namespace_name', type: 'uses',       description: 'Resource uses Event Hub Namespace' },
  { attribute: 'servicebus_namespace_name',type: 'uses',      description: 'Resource uses Service Bus Namespace' },
] as const;

// ---------------------------------------------------------------------------
// Default fallback region
// ---------------------------------------------------------------------------

/**
 * Used when a Terraform file's location attribute cannot be resolved.
 * Changing this constant updates behaviour everywhere in one place.
 */
export const DEFAULT_AZURE_REGION = 'eastus';
