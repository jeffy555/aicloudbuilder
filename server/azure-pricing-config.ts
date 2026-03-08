/**
 * Azure Pricing Configuration
 *
 * Deterministic pricing lookup table for Azure resources.
 * Replaces AI-generated OData filters with pre-configured, accurate pricing queries.
 */

// Industry standard: 365 days / 12 months * 24 hours = 730 hours/month
export const HOURS_PER_MONTH = 730;

// ─── Cost Helpers ──────────────────────────────────────────────────────────────

/** Compute monthly cost for an hourly-billed resource (e.g., VMs, App Service) */
export const perHour = (item: any): number =>
  (item?.retailPrice || 0) * HOURS_PER_MONTH;

/** Compute monthly cost for a GB-per-month resource (e.g., Storage, Disks) */
export const perGbMonth = (item: any, gb: number): number =>
  (item?.retailPrice || 0) * gb;

// ─── Cost Units ────────────────────────────────────────────────────────────────

export type CostUnit =
  | 'per_hour'        // Compute resources (VMs, App Service Plans)
  | 'per_gb_month'    // Storage resources
  | 'per_month'       // Fixed monthly costs (DNS zones, Container Registry)
  | 'per_gb_ingested' // Log Analytics, monitoring
  | 'per_request'     // API-based services
  | 'per_10k_transactions' // Storage transactions
  | 'per_unit';       // Generic unit

// ─── Pricing Config Entry ──────────────────────────────────────────────────────

export interface AzurePricingEntry {
  serviceName: string;
  productName?: string;
  skuName?: string;
  meterName?: string;
  serviceFamily?: string;
  costUnit: CostUnit;
  /** Default attributes when Terraform doesn't specify them */
  defaults: Record<string, string>;
  /** Functions to extract the right attribute from Terraform resource body */
  attributeKeys: string[];
  /** Usage assumptions for cost calculation */
  usageAssumptions: {
    hoursPerMonth?: number;
    gbPerMonth?: number;
    requestsPerMonth?: number;
    units?: number;
  };
  /** Build OData filter dynamically based on extracted attributes */
  buildFilter: (attrs: Record<string, any>, location: string) => string;
  /** Select the best pricing item from API results */
  selectItem: (items: any[], attrs: Record<string, any>) => any;
  /** Calculate monthly cost from a pricing item */
  calculateCost: (item: any, attrs: Record<string, any>) => number;
}

// ─── Free Resources ────────────────────────────────────────────────────────────

export const FREE_AZURE_RESOURCES: Record<string, string> = {
  'azurerm_resource_group': 'Resource groups are free',
  'azurerm_virtual_network': 'Virtual networks are free (peering/gateways charged separately)',
  'azurerm_subnet': 'Subnets are free (part of virtual network)',
  'azurerm_storage_container': 'Storage containers are free (billed through storage account)',
  'azurerm_storage_blob': 'Blobs are billed through the storage account',
  'azurerm_storage_queue': 'Queues are billed through the storage account',
  'azurerm_storage_table': 'Tables are billed through the storage account',
  'azurerm_storage_share': 'File shares are billed through the storage account',
  'azurerm_network_security_group': 'NSGs are free',
  'azurerm_network_security_rule': 'NSG rules are free',
  'azurerm_network_interface': 'Network interfaces are free',
  'azurerm_role_assignment': 'Role assignments are free',
  'azurerm_role_definition': 'Role definitions are free',
  'azurerm_user_assigned_identity': 'Managed identities are free',
  'azurerm_management_lock': 'Management locks are free',
  'azurerm_resource_provider_registration': 'Provider registrations are free',
  'azurerm_subnet_network_security_group_association': 'NSG associations are free',
  'azurerm_subnet_route_table_association': 'Route table associations are free',
  'azurerm_route_table': 'Route tables are free',
  'azurerm_route': 'Routes are free',
  'azurerm_private_dns_zone_virtual_network_link': 'DNS zone links are free',
  'azurerm_monitor_diagnostic_setting': 'Diagnostic settings are free (data ingestion charged separately)',
  'azurerm_key_vault_secret': 'Secrets billed through Key Vault',
  'azurerm_key_vault_key': 'Keys billed through Key Vault',
  'azurerm_key_vault_certificate': 'Certificates billed through Key Vault',
  'azurerm_key_vault_access_policy': 'Access policies are free',
  'azurerm_monitor_action_group': 'Action groups are free',
  'azurerm_management_group': 'Management groups are free',
  'azurerm_policy_assignment': 'Policy assignments are free',
  'azurerm_policy_definition': 'Policy definitions are free',
  'azurerm_resource_group_policy_assignment': 'Policy assignments are free',
  'azurerm_network_interface_security_group_association': 'NIC-NSG associations are free',
  'azurerm_availability_set': 'Availability sets are free (VMs inside are charged)',
  'azurerm_proximity_placement_group': 'Proximity placement groups are free',
  'azurerm_private_link_service': 'Private Link Service is free (endpoints are charged)',
  'azurerm_local_network_gateway': 'Local network gateways are free (VPN connections charged)',
  'azurerm_virtual_network_peering': 'VNet peering is free (data transfer charged)',
  'azurerm_network_watcher': 'Network Watcher is free (flow logs charged)',
  'azurerm_resource_group_template_deployment': 'ARM template deployments are free',
  'azurerm_template_deployment': 'ARM template deployments are free',
  'azurerm_monitor_metric_alert': 'Metric alerts are free (first 10 free)',
  'azurerm_ssh_public_key': 'SSH public keys are free',
  'azurerm_disk_access': 'Disk access resources are free',
  'azurerm_storage_account_network_rules': 'Storage network rules are free',
  'azurerm_virtual_machine_extension': 'VM extensions are free (the extension software may have cost)',
  'azurerm_linux_virtual_machine_scale_set': 'Scale set definition is free (VMs inside are charged)',
  'azurerm_windows_virtual_machine_scale_set': 'Scale set definition is free (VMs inside are charged)',
  'azurerm_cosmosdb_sql_database': 'CosmosDB databases are free (throughput charged at account level)',
  'azurerm_cosmosdb_sql_container': 'CosmosDB containers are free (throughput charged at account/db level)',
  'azurerm_mssql_firewall_rule': 'SQL firewall rules are free',
  'azurerm_mssql_virtual_network_rule': 'SQL virtual network rules are free',
  'azurerm_mysql_flexible_server_firewall_rule': 'MySQL firewall rules are free',
  'azurerm_postgresql_flexible_server_firewall_rule': 'PostgreSQL firewall rules are free',
};

// ─── Location Map ──────────────────────────────────────────────────────────────

export const LOCATION_MAP: Record<string, string> = {
  'eastus': 'US East',
  'eastus2': 'US East 2',
  'westus': 'US West',
  'westus2': 'US West 2',
  'westus3': 'US West 3',
  'centralus': 'US Central',
  'northcentralus': 'US North Central',
  'southcentralus': 'US South Central',
  'westcentralus': 'US West Central',
  'canadacentral': 'CA Central',
  'canadaeast': 'CA East',
  'brazilsouth': 'BR South',
  'northeurope': 'EU North',
  'westeurope': 'EU West',
  'uksouth': 'UK South',
  'ukwest': 'UK West',
  'francecentral': 'FR Central',
  'francesouth': 'FR South',
  'germanywestcentral': 'DE West Central',
  'germanynorth': 'DE North',
  'switzerlandnorth': 'CH North',
  'switzerlandwest': 'CH West',
  'norwayeast': 'NO East',
  'norwaywest': 'NO West',
  'swedencentral': 'SE Central',
  'uaenorth': 'AE North',
  'uaecentral': 'AE Central',
  'southafricanorth': 'ZA North',
  'southafricawest': 'ZA West',
  'japaneast': 'JA East',
  'japanwest': 'JA West',
  'koreacentral': 'KR Central',
  'koreasouth': 'KR South',
  'southeastasia': 'AP Southeast',
  'eastasia': 'AP East',
  'australiaeast': 'AU East',
  'australiasoutheast': 'AU Southeast',
  'australiacentral': 'AU Central',
  'australiacentral2': 'AU Central 2',
  'centralindia': 'IN Central',
  'southindia': 'IN South',
  'westindia': 'IN West',
};

// ─── Helper: resolve Azure location for API ────────────────────────────────────

/**
 * Azure Pricing API uses `armRegionName` which matches Terraform location format
 * (e.g., 'eastus', 'westus2', 'northeurope').
 * No mapping needed - just normalize to lowercase and strip spaces.
 */
export function resolveAzureLocation(terraformLocation: string): string {
  return (terraformLocation || 'eastus').toLowerCase().replace(/\s+/g, '');
}

// ─── Helper: select best pricing item ──────────────────────────────────────────

function selectByMeterName(items: any[], keywords: string[], excludeKeywords: string[] = []): any {
  const filtered = items.filter((item: any) => {
    const meter = (item.meterName || '').toLowerCase();
    const matchesKeyword = keywords.length === 0 || keywords.some(kw => meter.includes(kw.toLowerCase()));
    const matchesExclude = excludeKeywords.some(kw => meter.includes(kw.toLowerCase()));
    return matchesKeyword && !matchesExclude;
  });
  return filtered[0] || null;
}

function selectByUnit(items: any[], unit: string): any {
  return items.find((item: any) =>
    item.unitOfMeasure && item.unitOfMeasure.toLowerCase().includes(unit.toLowerCase())
  ) || null;
}

function selectNonZeroItem(items: any[]): any {
  return items.find((item: any) => item.retailPrice > 0) || items[0] || null;
}

// ─── VM Pricing Factory ─────────────────────────────────────────────────────────

/**
 * Factory function for VM pricing entries.
 * All three VM resource types share identical filter/cost logic — only the OS
 * filter in selectItem differs. Using a factory eliminates the triplicated blocks
 * so that a pricing logic change (e.g., SKU filter) is made in exactly one place.
 *
 * @param os - 'linux' filters to Linux products, 'windows' to Windows,
 *             'any' prefers Linux but accepts any non-Windows as fallback.
 */
function createVMPricingConfig(os: 'linux' | 'windows' | 'any'): AzurePricingEntry {
  return {
    serviceName: 'Virtual Machines',
    serviceFamily: 'Compute',
    costUnit: 'per_hour',
    defaults: { size: 'Standard_B2s', vm_size: 'Standard_B2s' },
    attributeKeys: ['size', 'vm_size'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      const size = attrs.size || attrs.vm_size || 'Standard_B2s';
      return `serviceName eq 'Virtual Machines' and armRegionName eq '${location}' and armSkuName eq '${size}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      // Exclude spot / low-priority pricing for all VM types
      const nonSpot = items.filter((i: any) =>
        !i.skuName?.toLowerCase().includes('spot') &&
        !i.skuName?.toLowerCase().includes('low priority') &&
        !i.meterName?.toLowerCase().includes('spot')
      );
      const pool = nonSpot.length > 0 ? nonSpot : items;

      if (os === 'linux') {
        const linux = pool.filter((i: any) =>
          i.productName?.toLowerCase().includes('linux') ||
          !i.productName?.toLowerCase().includes('windows')
        );
        const filtered = linux.length > 0 ? linux : pool;
        return selectByUnit(filtered, 'hour') || filtered[0] || null;
      }
      if (os === 'windows') {
        const windows = pool.filter((i: any) =>
          i.productName?.toLowerCase().includes('windows')
        );
        const filtered = windows.length > 0 ? windows : pool;
        return selectByUnit(filtered, 'hour') || filtered[0] || null;
      }
      // 'any': prefer Linux but fall through to any non-spot item
      const linux = pool.filter((i: any) =>
        i.productName?.toLowerCase().includes('linux') ||
        !i.productName?.toLowerCase().includes('windows')
      );
      const filtered = linux.length > 0 ? linux : pool;
      return selectByUnit(filtered, 'hour') || filtered[0] || null;
    },
    calculateCost: (item) => perHour(item),
  };
}

// ─── Pricing Config ────────────────────────────────────────────────────────────

export const AZURE_PRICING_CONFIG: Record<string, AzurePricingEntry> = {
  // ═══ COMPUTE ═══
  'azurerm_virtual_machine':         createVMPricingConfig('any'),
  'azurerm_linux_virtual_machine':   createVMPricingConfig('linux'),
  'azurerm_windows_virtual_machine': createVMPricingConfig('windows'),

  // ═══ APP SERVICE ═══
  'azurerm_service_plan': {
    serviceName: 'Azure App Service',
    serviceFamily: 'Compute',
    costUnit: 'per_hour',
    defaults: { sku_name: 'B1' },
    attributeKeys: ['sku_name', 'sku'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      const sku = attrs.sku_name || attrs.sku || 'B1';
      return `serviceName eq 'Azure App Service' and armRegionName eq '${location}' and skuName eq '${sku}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const compute = items.filter((i: any) =>
        (i.unitOfMeasure?.includes('Hour') || i.unitOfMeasure === '1 Hour') &&
        !i.meterName?.toLowerCase().includes('request') &&
        !i.meterName?.toLowerCase().includes('bandwidth') &&
        !i.meterName?.toLowerCase().includes('ssl') &&
        !i.meterName?.toLowerCase().includes('data transfer')
      );
      return compute[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  'azurerm_app_service_plan': {
    serviceName: 'Azure App Service',
    serviceFamily: 'Compute',
    costUnit: 'per_hour',
    defaults: { sku_name: 'S1' },
    attributeKeys: ['sku_name', 'sku', 'sku_size'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      let sku = attrs.sku_name || attrs.sku_size || attrs.sku || 'S1';
      // Handle nested sku block: tier + size
      if (attrs.sku && attrs.sku_size) {
        sku = attrs.sku_size;
      }
      return `serviceName eq 'Azure App Service' and armRegionName eq '${location}' and skuName eq '${sku}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const compute = items.filter((i: any) =>
        (i.unitOfMeasure?.includes('Hour') || i.unitOfMeasure === '1 Hour') &&
        !i.meterName?.toLowerCase().includes('request') &&
        !i.meterName?.toLowerCase().includes('bandwidth') &&
        !i.meterName?.toLowerCase().includes('storage') &&
        !i.meterName?.toLowerCase().includes('data transfer')
      );
      return compute[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  'azurerm_linux_web_app': {
    serviceName: 'Azure App Service',
    costUnit: 'per_month',
    defaults: {},
    attributeKeys: ['service_plan_id'],
    usageAssumptions: {},
    buildFilter: () => '',
    selectItem: () => null,
    calculateCost: () => 0 // Cost is in the service_plan
  },

  'azurerm_windows_web_app': {
    serviceName: 'Azure App Service',
    costUnit: 'per_month',
    defaults: {},
    attributeKeys: ['service_plan_id'],
    usageAssumptions: {},
    buildFilter: () => '',
    selectItem: () => null,
    calculateCost: () => 0 // Cost is in the service_plan
  },

  'azurerm_app_service': {
    serviceName: 'Azure App Service',
    costUnit: 'per_month',
    defaults: {},
    attributeKeys: ['app_service_plan_id'],
    usageAssumptions: {},
    buildFilter: () => '',
    selectItem: () => null,
    calculateCost: () => 0 // Cost is in the app_service_plan
  },

  // ═══ FUNCTIONS ═══
  'azurerm_function_app': {
    serviceName: 'Functions',
    serviceFamily: 'Compute',
    costUnit: 'per_request',
    defaults: {},
    attributeKeys: ['app_service_plan_id'],
    usageAssumptions: { requestsPerMonth: 1_000_000 },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Functions' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      // Prefer execution-based pricing
      const execItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('execution') ||
        i.meterName?.toLowerCase().includes('total')
      );
      return execItems[0] || items[0];
    },
    calculateCost: (item) => {
      // Consumption plan: first 1M executions free, then $0.20 per million
      // GB-s pricing: first 400,000 GB-s free, then $0.000016/GB-s
      // Estimate: ~$0 for light usage, ~$5-20 for moderate
      return (item.retailPrice || 0) * 1_000_000;
    }
  },

  'azurerm_linux_function_app': {
    serviceName: 'Functions',
    serviceFamily: 'Compute',
    costUnit: 'per_request',
    defaults: {},
    attributeKeys: ['service_plan_id'],
    usageAssumptions: { requestsPerMonth: 1_000_000 },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Functions' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const execItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('execution')
      );
      return execItems[0] || items[0];
    },
    calculateCost: (item) => (item.retailPrice || 0) * 1_000_000
  },

  // ═══ STORAGE ═══
  'azurerm_storage_account': {
    serviceName: 'Storage',
    serviceFamily: 'Storage',
    costUnit: 'per_gb_month',
    defaults: { account_tier: 'Standard', account_replication_type: 'LRS' },
    attributeKeys: ['account_tier', 'account_replication_type', 'account_kind'],
    usageAssumptions: { gbPerMonth: 50 },
    buildFilter: (attrs, location) => {
      const replication = attrs.account_replication_type || 'LRS';
      // Azure Pricing API skuName for storage uses "Hot LRS", "Cool GRS", etc.
      const accessTier = (attrs.access_tier || 'Hot');
      const skuName = `${accessTier} ${replication}`;
      return `serviceName eq 'Storage' and armRegionName eq '${location}' and skuName eq '${skuName}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      // Prefer "Data Stored" or "Hot LRS Data Stored" meters
      const dataStored = items.filter((i: any) => {
        const meter = (i.meterName || '').toLowerCase();
        return (meter.includes('data stored') || meter.includes('storage')) &&
          !meter.includes('retrieval') &&
          !meter.includes('write') &&
          !meter.includes('read') &&
          !meter.includes('operation') &&
          !meter.includes('geo-replication');
      });
      // Prefer GB/Month unit
      const monthly = dataStored.filter((i: any) => i.unitOfMeasure?.includes('GB'));
      return monthly[0] || dataStored[0] || selectByUnit(items, 'gb') || items[0];
    },
    calculateCost: (item, attrs) => {
      const sizeGB = parseFloat(attrs.size_gb || attrs.disk_size_gb || '') || 50;
      return (item.retailPrice || 0) * sizeGB;
    }
  },

  'azurerm_managed_disk': {
    serviceName: 'Storage',
    serviceFamily: 'Storage',
    costUnit: 'per_month',
    defaults: { storage_account_type: 'Standard_LRS', disk_size_gb: '128' },
    attributeKeys: ['storage_account_type', 'disk_size_gb'],
    usageAssumptions: { gbPerMonth: 128 },
    buildFilter: (attrs, location) => {
      const storageType = attrs.storage_account_type || 'Standard_LRS';
      // Map to managed disk product name
      let productFilter = '';
      if (storageType.includes('Premium')) {
        productFilter = "productName eq 'Premium SSD Managed Disks'";
      } else if (storageType.includes('StandardSSD') || storageType === 'StandardSSD_LRS') {
        productFilter = "productName eq 'Standard SSD Managed Disks'";
      } else {
        productFilter = "productName eq 'Standard HDD Managed Disks'";
      }
      return `serviceName eq 'Storage' and ${productFilter} and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const diskSize = parseInt(attrs.disk_size_gb || '128', 10);
      // Find the disk tier that fits (P10=128GB, P15=256GB, P20=512GB, etc.)
      const monthlyItems = items.filter((i: any) =>
        i.unitOfMeasure?.includes('Month') && i.retailPrice > 0
      );
      // Sort by price ascending and find the first that fits
      monthlyItems.sort((a: any, b: any) => a.retailPrice - b.retailPrice);
      // P10 = 128GB, P15 = 256GB, etc. Try to match by meter name
      if (diskSize <= 32) return monthlyItems.find((i: any) => i.meterName?.includes('E4') || i.meterName?.includes('S4') || i.meterName?.includes('P4')) ?? monthlyItems[0] ?? null;
      if (diskSize <= 64) return monthlyItems.find((i: any) => i.meterName?.includes('E6') || i.meterName?.includes('S6') || i.meterName?.includes('P6')) ?? monthlyItems[0] ?? null;
      if (diskSize <= 128) return monthlyItems.find((i: any) => i.meterName?.includes('E10') || i.meterName?.includes('S10') || i.meterName?.includes('P10')) ?? monthlyItems[0] ?? null;
      if (diskSize <= 256) return monthlyItems.find((i: any) => i.meterName?.includes('E15') || i.meterName?.includes('S15') || i.meterName?.includes('P15')) ?? monthlyItems[1] ?? monthlyItems[0] ?? null;
      if (diskSize <= 512) return monthlyItems.find((i: any) => i.meterName?.includes('E20') || i.meterName?.includes('S20') || i.meterName?.includes('P20')) ?? monthlyItems[2] ?? monthlyItems[0] ?? null;
      return monthlyItems.find((i: any) => i.meterName?.includes('E30') || i.meterName?.includes('S30') || i.meterName?.includes('P30')) ?? monthlyItems[3] ?? monthlyItems[0] ?? null;
    },
    calculateCost: (item) => item.retailPrice || 0 // Already monthly for managed disks
  },

  // ═══ DATABASE ═══
  'azurerm_mssql_server': {
    serviceName: 'SQL Database',
    costUnit: 'per_month',
    defaults: {},
    attributeKeys: [],
    usageAssumptions: {},
    buildFilter: () => '',
    selectItem: () => null,
    calculateCost: () => 0 // Cost is in azurerm_mssql_database
  },

  'azurerm_mssql_database': {
    serviceName: 'SQL Database',
    serviceFamily: 'Databases',
    costUnit: 'per_hour',
    defaults: { sku_name: 'S0' },
    attributeKeys: ['sku_name'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      const sku = attrs.sku_name || 'S0';
      // DTU-based: S0, S1, S2, etc. vCore-based: GP_Gen5_2, BC_Gen5_2, etc.
      if (sku.startsWith('GP_') || sku.startsWith('BC_') || sku.startsWith('HS_')) {
        // vCore model - broader filter
        return `serviceName eq 'SQL Database' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
      }
      // DTU model - use skuName (not armSkuName)
      return `serviceName eq 'SQL Database' and armRegionName eq '${location}' and skuName eq '${sku}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = attrs.sku_name || 'S0';
      // For DTU models, look for "DTUs" or "Day" unit pricing
      const dtuItems = items.filter((i: any) =>
        i.meterName?.includes('DTU') || i.unitOfMeasure?.includes('Day')
      );
      if (dtuItems.length > 0) {
        const skuMatch = dtuItems.find((i: any) => i.meterName?.includes(sku));
        return skuMatch || dtuItems[0];
      }
      // vCore: prefer hourly compute
      const compute = items.filter((i: any) =>
        i.unitOfMeasure?.includes('Hour') &&
        !i.meterName?.toLowerCase().includes('storage') &&
        !i.meterName?.toLowerCase().includes('backup')
      );
      return compute[0] || items[0];
    },
    calculateCost: (item) => {
      if (item.unitOfMeasure?.includes('Day')) {
        return (item.retailPrice || 0) * 30; // Per-day pricing * 30 days
      }
      if (item.unitOfMeasure?.includes('Hour')) {
        return perHour(item);
      }
      return item.retailPrice || 0;
    }
  },

  'azurerm_cosmosdb_account': {
    serviceName: 'Azure Cosmos DB',
    serviceFamily: 'Databases',
    costUnit: 'per_hour',
    defaults: {},
    attributeKeys: ['offer_type', 'kind'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Cosmos DB' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      // Prefer RU-based pricing (most common)
      const ruItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('ru') ||
        i.meterName?.toLowerCase().includes('request unit')
      );
      return ruItems[0] || selectNonZeroItem(items);
    },
    calculateCost: (item, attrs) => {
      // Pricing: ~$0.008/hr per 100 RU/s
      const ruPerSec = attrs.__usage_ru || 400; // from usage catalog or default 400 RU/s
      const units = ruPerSec / 100; // each unit = 100 RU/s
      const pricePerHour = item.retailPrice || 0;
      return pricePerHour * units * HOURS_PER_MONTH;
    }
  },

  'azurerm_mysql_flexible_server': {
    serviceName: 'Azure Database for MySQL',
    serviceFamily: 'Databases',
    costUnit: 'per_hour',
    defaults: { sku_name: 'B_Standard_B1ms' },
    attributeKeys: ['sku_name'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      const sku = attrs.sku_name || 'B_Standard_B1ms';
      // Extract the VM size from the sku (e.g., B_Standard_B1ms -> Standard_B1ms)
      const parts = sku.split('_');
      const vmSize = parts.length > 1 ? parts.slice(1).join('_') : sku;
      return `serviceName eq 'Azure Database for MySQL' and armRegionName eq '${location}' and armSkuName eq '${vmSize}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const compute = items.filter((i: any) =>
        i.unitOfMeasure?.includes('Hour') &&
        !i.meterName?.toLowerCase().includes('storage') &&
        !i.meterName?.toLowerCase().includes('backup')
      );
      return compute[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  'azurerm_postgresql_flexible_server': {
    serviceName: 'Azure Database for PostgreSQL',
    serviceFamily: 'Databases',
    costUnit: 'per_hour',
    defaults: { sku_name: 'B_Standard_B1ms' },
    attributeKeys: ['sku_name'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      const sku = attrs.sku_name || 'B_Standard_B1ms';
      const parts = sku.split('_');
      const vmSize = parts.length > 1 ? parts.slice(1).join('_') : sku;
      return `serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '${location}' and armSkuName eq '${vmSize}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const compute = items.filter((i: any) =>
        i.unitOfMeasure?.includes('Hour') &&
        !i.meterName?.toLowerCase().includes('storage') &&
        !i.meterName?.toLowerCase().includes('backup')
      );
      return compute[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  // ═══ NETWORKING ═══
  'azurerm_public_ip': {
    serviceName: 'Virtual Network',
    serviceFamily: 'Networking',
    costUnit: 'per_hour',
    defaults: { sku: 'Standard', allocation_method: 'Static' },
    attributeKeys: ['sku', 'allocation_method'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      // Public IP is under "Virtual Network" service; meter is "Standard Static IP Addresses"
      return `serviceName eq 'Virtual Network' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku || 'Standard').toLowerCase();
      const alloc = (attrs.allocation_method || 'Static').toLowerCase();
      const matched = items.filter((i: any) => {
        const meter = (i.meterName || '').toLowerCase();
        return meter.includes('ip') && meter.includes(alloc === 'static' ? 'static' : 'dynamic') &&
          (sku === 'basic' ? meter.includes('basic') : !meter.includes('basic'));
      });
      return matched[0] || items.find((i: any) =>
        (i.meterName || '').toLowerCase().includes('static ip')
      ) || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  'azurerm_application_gateway': {
    serviceName: 'Application Gateway',
    serviceFamily: 'Networking',
    costUnit: 'per_hour',
    defaults: { sku_name: 'Standard_v2' },
    attributeKeys: ['sku_name', 'sku'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Application Gateway' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku_name || attrs.sku || 'Standard_v2').toLowerCase();
      const matched = items.filter((i: any) => {
        const meter = (i.meterName || '').toLowerCase();
        const product = (i.productName || '').toLowerCase();
        return (meter.includes('fixed') || meter.includes('gateway')) &&
          (product.includes(sku.replace('_', ' ')) || product.includes('v2'));
      });
      return matched[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  'azurerm_firewall': {
    serviceName: 'Azure Firewall',
    serviceFamily: 'Networking',
    costUnit: 'per_hour',
    defaults: { sku_name: 'AZFW_VNet', sku_tier: 'Standard' },
    attributeKeys: ['sku_name', 'sku_tier'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Firewall' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const tier = (attrs.sku_tier || 'Standard').toLowerCase();
      const matched = items.filter((i: any) => {
        const meter = (i.meterName || '').toLowerCase();
        return meter.includes('deployment') && meter.includes(tier);
      });
      return matched[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  'azurerm_nat_gateway': {
    serviceName: 'Virtual Network',
    serviceFamily: 'Networking',
    costUnit: 'per_hour',
    defaults: {},
    attributeKeys: [],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Virtual Network' and armRegionName eq '${location}' and meterName eq 'NAT Gateway' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const natItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('nat gateway') &&
        i.unitOfMeasure?.includes('Hour')
      );
      return natItems[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  'azurerm_lb': {
    serviceName: 'Load Balancer',
    serviceFamily: 'Networking',
    costUnit: 'per_hour',
    defaults: { sku: 'Standard' },
    attributeKeys: ['sku'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      // Load Balancer pricing has no standard Azure regions - omit armRegionName
      return `serviceName eq 'Load Balancer' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku || 'Standard').toLowerCase();
      if (sku === 'basic') return null; // Basic LB is free
      const matched = items.filter((i: any) =>
        i.unitOfMeasure?.includes('Hour') &&
        !i.meterName?.toLowerCase().includes('data processed') &&
        !i.meterName?.toLowerCase().includes('rule')
      );
      return matched[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => {
      if (!item) return 0; // Basic LB is free
      return perHour(item);
    }
  },

  'azurerm_vpn_gateway': {
    serviceName: 'VPN Gateway',
    serviceFamily: 'Networking',
    costUnit: 'per_hour',
    defaults: {},
    attributeKeys: ['sku'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'VPN Gateway' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku || '').toLowerCase();
      const matched = items.filter((i: any) =>
        i.unitOfMeasure?.includes('Hour') &&
        (sku ? i.meterName?.toLowerCase().includes(sku) : true)
      );
      return matched[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  'azurerm_virtual_network_gateway': {
    serviceName: 'VPN Gateway',
    serviceFamily: 'Networking',
    costUnit: 'per_hour',
    defaults: { sku: 'VpnGw1' },
    attributeKeys: ['sku'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'VPN Gateway' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku || 'VpnGw1').toLowerCase();
      const matched = items.filter((i: any) =>
        i.unitOfMeasure?.includes('Hour') && i.meterName?.toLowerCase().includes(sku)
      );
      return matched[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  // ═══ CONTAINERS ═══
  'azurerm_container_registry': {
    serviceName: 'Container Registry',
    serviceFamily: 'Containers',
    costUnit: 'per_month',
    defaults: { sku: 'Basic' },
    attributeKeys: ['sku'],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Container Registry' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku || 'Basic').toLowerCase();
      // Find unit pricing (per day or per month) matching SKU
      const matched = items.filter((i: any) => {
        const product = (i.productName || '').toLowerCase();
        const meter = (i.meterName || '').toLowerCase();
        return (product.includes(sku) || meter.includes(sku)) &&
          (i.unitOfMeasure?.includes('Day') || i.unitOfMeasure?.includes('Month'));
      });
      return matched[0] || items.find((i: any) =>
        (i.productName || '').toLowerCase().includes(sku)
      ) || items[0];
    },
    calculateCost: (item) => {
      if (!item) return 0;
      if (item.unitOfMeasure?.includes('Day')) {
        return (item.retailPrice || 0) * 30;
      }
      return item.retailPrice || 0; // Already monthly
    }
  },

  'azurerm_kubernetes_cluster': {
    serviceName: 'Azure Kubernetes Service',
    serviceFamily: 'Compute',
    costUnit: 'per_hour',
    defaults: { default_node_pool_vm_size: 'Standard_DS2_v2' },
    attributeKeys: ['default_node_pool_vm_size', 'sku_tier'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      // AKS control plane is free for standard tier; cost is in node VMs
      const vmSize = attrs.default_node_pool_vm_size || 'Standard_DS2_v2';
      return `serviceName eq 'Virtual Machines' and armRegionName eq '${location}' and armSkuName eq '${vmSize}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const linux = items.filter((i: any) =>
        i.productName?.toLowerCase().includes('linux') &&
        !i.skuName?.toLowerCase().includes('spot') &&
        !i.skuName?.toLowerCase().includes('low priority') &&
        i.unitOfMeasure?.includes('Hour')
      );
      return linux[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item, attrs) => {
      const nodeCount = parseInt(attrs.default_node_pool_node_count || attrs.node_count || '3', 10);
      return perHour(item) * nodeCount;
    }
  },

  'azurerm_container_group': {
    serviceName: 'Container Instances',
    serviceFamily: 'Containers',
    costUnit: 'per_hour',
    defaults: {},
    attributeKeys: ['cpu', 'memory'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Container Instances' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      // Prefer vCPU duration pricing
      const cpuItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('vcpu') ||
        i.meterName?.toLowerCase().includes('cpu')
      );
      return cpuItems[0] || selectByUnit(items, 'second') || items[0];
    },
    calculateCost: (item, attrs) => {
      const cpu = parseFloat(attrs.cpu || '1');
      const memory = parseFloat(attrs.memory || '1.5');
      // ACI pricing: ~$0.0000125/vCPU-second + ~$0.0000015/GB-second
      // Simplified: use the vCPU per second rate
      const secondsPerMonth = HOURS_PER_MONTH * 3600;
      return (item.retailPrice || 0) * cpu * secondsPerMonth;
    }
  },

  'azurerm_container_app': {
    serviceName: 'Azure Container Apps',
    serviceFamily: 'Containers',
    costUnit: 'per_hour',
    defaults: {},
    attributeKeys: ['cpu', 'memory'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Container Apps' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const vcpuItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('vcpu') &&
        !i.meterName?.toLowerCase().includes('spot')
      );
      return vcpuItems[0] || selectNonZeroItem(items);
    },
    calculateCost: (item, attrs) => {
      const cpu = parseFloat(attrs.cpu || '0.5');
      return (item.retailPrice || 0) * cpu * HOURS_PER_MONTH * 3600;
    }
  },

  'azurerm_container_app_environment': {
    serviceName: 'Azure Container Apps',
    serviceFamily: 'Containers',
    costUnit: 'per_hour',
    defaults: {},
    attributeKeys: [],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Container Apps' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const envItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('memory') ||
        i.meterName?.toLowerCase().includes('vcpu')
      );
      return envItems[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => perHour(item)
  },

  // ═══ SECURITY ═══
  'azurerm_key_vault': {
    serviceName: 'Key Vault',
    serviceFamily: 'Security',
    costUnit: 'per_10k_transactions',
    defaults: { sku_name: 'standard' },
    attributeKeys: ['sku_name'],
    usageAssumptions: { requestsPerMonth: 10000 },
    buildFilter: (attrs, location) => {
      const sku = (attrs.sku_name || 'standard').toLowerCase();
      const skuFilter = sku === 'premium' ? 'Premium' : 'Standard';
      return `serviceName eq 'Key Vault' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku_name || 'standard').toLowerCase();
      const matched = items.filter((i: any) => {
        const product = (i.productName || '').toLowerCase();
        return product.includes(sku) &&
          i.meterName?.toLowerCase().includes('operations') &&
          i.retailPrice > 0;
      });
      return matched[0] || selectNonZeroItem(items);
    },
    calculateCost: (item, attrs) => {
      // ~$0.03 per 10,000 operations
      const ops10k = attrs.__usage_ops_10k || 1; // from usage catalog or default 1 unit
      return (item.retailPrice || 0) * ops10k;
    }
  },

  // ═══ MONITORING ═══
  'azurerm_log_analytics_workspace': {
    serviceName: 'Log Analytics',
    serviceFamily: 'Management and Governance',
    costUnit: 'per_gb_ingested',
    defaults: { sku: 'PerGB2018' },
    attributeKeys: ['sku'],
    usageAssumptions: { gbPerMonth: 50 },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Log Analytics' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const dataIngestion = items.filter((i: any) =>
        (i.meterName?.toLowerCase().includes('data ingestion') ||
         i.meterName?.toLowerCase().includes('data')) &&
        i.retailPrice > 0
      );
      return dataIngestion[0] || selectNonZeroItem(items);
    },
    calculateCost: (item, attrs) => {
      // ~$2.76/GB ingested. First 5GB free.
      const monthlyGB = attrs.__usage_gb || 50; // from usage catalog or default 50GB
      const billableGB = Math.max(0, monthlyGB - 5); // 5GB free tier
      return (item.retailPrice || 0) * billableGB;
    }
  },

  'azurerm_application_insights': {
    serviceName: 'Azure Monitor',
    serviceFamily: 'Management and Governance',
    costUnit: 'per_gb_ingested',
    defaults: {},
    attributeKeys: ['daily_data_cap_in_gb'],
    usageAssumptions: { gbPerMonth: 5 },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Monitor' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const dataItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('data') &&
        i.retailPrice > 0 &&
        i.unitOfMeasure?.includes('GB')
      );
      return dataItems[0] || selectNonZeroItem(items);
    },
    calculateCost: (item, attrs) => {
      const dailyCap = parseFloat(attrs.daily_data_cap_in_gb || '5');
      const monthlyGB = dailyCap * 30;
      // First 5GB free
      const billableGB = Math.max(0, monthlyGB - 5);
      return (item.retailPrice || 0) * billableGB;
    }
  },

  // ═══ DNS ═══
  'azurerm_dns_zone': {
    serviceName: 'Azure DNS',
    serviceFamily: 'Networking',
    costUnit: 'per_month',
    defaults: {},
    attributeKeys: [],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure DNS' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const zoneItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('zone') &&
        i.unitOfMeasure?.includes('Month')
      );
      return zoneItems[0] || items[0];
    },
    calculateCost: (item) => item.retailPrice || 0.50 // ~$0.50/zone/month
  },

  'azurerm_private_dns_zone': {
    serviceName: 'Azure DNS',
    serviceFamily: 'Networking',
    costUnit: 'per_month',
    defaults: {},
    attributeKeys: [],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure DNS' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const privateItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('private') &&
        i.unitOfMeasure?.includes('Month')
      );
      return privateItems[0] || items[0];
    },
    calculateCost: (item) => item.retailPrice || 0.25 // ~$0.25/zone/month for private DNS
  },

  // ═══ CACHING ═══
  'azurerm_redis_cache': {
    serviceName: 'Redis Cache',
    serviceFamily: 'Databases',
    costUnit: 'per_hour',
    defaults: { capacity: '1', family: 'C', sku_name: 'Basic' },
    attributeKeys: ['capacity', 'family', 'sku_name'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Redis Cache' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const family = (attrs.family || 'C').toUpperCase();
      const capacity = attrs.capacity || '1';
      const cacheSize = `${family}${capacity}`;
      // Match by cache size in meter name (e.g., "C1 Cache")
      const matched = items.filter((i: any) => {
        const meter = (i.meterName || '');
        return meter.includes(`${cacheSize} Cache`) &&
          i.unitOfMeasure?.includes('Hour') &&
          i.retailPrice > 0;
      });
      if (matched.length > 0) return matched[0];
      // Fallback: match skuName
      const skuMatch = items.filter((i: any) =>
        i.skuName === cacheSize &&
        i.unitOfMeasure?.includes('Hour') &&
        i.retailPrice > 0
      );
      return skuMatch[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  // ═══ AI / COGNITIVE ═══
  'azurerm_cognitive_account': {
    serviceName: 'Cognitive Services',
    serviceFamily: 'AI + Machine Learning',
    costUnit: 'per_unit',
    defaults: { kind: 'CognitiveServices', sku_name: 'S0' },
    attributeKeys: ['kind', 'sku_name'],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      const kind = attrs.kind || 'CognitiveServices';
      return `serviceName eq 'Cognitive Services' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku_name || 'S0');
      const matched = items.filter((i: any) =>
        (i.armSkuName === sku || i.meterName?.includes(sku)) &&
        i.retailPrice > 0
      );
      return matched[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => {
      // Highly variable by service type. Use the unit price as monthly estimate
      return item.retailPrice || 0;
    }
  },

  // ═══ SEARCH ═══
  'azurerm_search_service': {
    serviceName: 'Azure Cognitive Search',
    serviceFamily: 'AI + Machine Learning',
    costUnit: 'per_hour',
    defaults: { sku: 'basic' },
    attributeKeys: ['sku'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      const sku = (attrs.sku || 'basic').toLowerCase();
      // Map Terraform SKU names to Azure API skuName values
      const skuMap: Record<string, string> = {
        'free': 'Free',
        'basic': 'Basic',
        'standard': 'Standard S1',
        'standard2': 'Standard S2',
        'standard3': 'Standard S3',
        'storage_optimized_l1': 'Storage Optimized L1',
        'storage_optimized_l2': 'Storage Optimized L2',
      };
      const apiSku = skuMap[sku] || 'Basic';
      return `serviceName eq 'Azure Cognitive Search' and armRegionName eq '${location}' and skuName eq '${apiSku}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      // Pick the hourly unit item
      const hourly = items.filter((i: any) => i.unitOfMeasure?.includes('Hour'));
      return hourly[0] || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  // ═══ MESSAGING ═══
  'azurerm_eventhub_namespace': {
    serviceName: 'Event Hubs',
    serviceFamily: 'Analytics',
    costUnit: 'per_hour',
    defaults: { sku: 'Standard' },
    attributeKeys: ['sku', 'capacity'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Event Hubs' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku || 'Standard').toLowerCase();
      const matched = items.filter((i: any) =>
        (i.productName || '').toLowerCase().includes(sku) &&
        i.meterName?.toLowerCase().includes('throughput unit') &&
        i.unitOfMeasure?.includes('Hour')
      );
      return matched[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item, attrs) => {
      const capacity = parseInt(attrs.capacity || '1', 10);
      return perHour(item) * capacity;
    }
  },

  'azurerm_servicebus_namespace': {
    serviceName: 'Service Bus',
    serviceFamily: 'Integration',
    costUnit: 'per_hour',
    defaults: { sku: 'Standard' },
    attributeKeys: ['sku'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Service Bus' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku || 'Standard').toLowerCase();
      const matched = items.filter((i: any) =>
        (i.productName || '').toLowerCase().includes(sku) &&
        i.unitOfMeasure?.includes('Hour') &&
        i.retailPrice > 0
      );
      return matched[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => perHour(item)
  },

  // ═══ MISC ═══
  'azurerm_logic_app_workflow': {
    serviceName: 'Logic Apps',
    serviceFamily: 'Integration',
    costUnit: 'per_request',
    defaults: {},
    attributeKeys: [],
    usageAssumptions: { requestsPerMonth: 10000 },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Logic Apps' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const actionItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('action') &&
        !i.meterName?.toLowerCase().includes('enterprise') &&
        i.retailPrice > 0
      );
      return actionItems[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => {
      // ~$0.000025 per action execution, estimate 10,000 executions/month
      return (item.retailPrice || 0) * 10000;
    }
  },

  'azurerm_static_site': {
    serviceName: 'Static Web Apps',
    serviceFamily: 'Compute',
    costUnit: 'per_month',
    defaults: { sku_size: 'Free' },
    attributeKeys: ['sku_size', 'sku_tier'],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Static Web Apps' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku_size || attrs.sku_tier || 'Free').toLowerCase();
      if (sku === 'free') return null;
      const matched = items.filter((i: any) =>
        (i.productName || '').toLowerCase().includes(sku) &&
        i.retailPrice > 0
      );
      return matched[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => {
      if (!item) return 0; // Free tier
      return item.retailPrice || 0;
    }
  },

  'azurerm_frontdoor': {
    serviceName: 'Azure Front Door Service',
    serviceFamily: 'Networking',
    costUnit: 'per_month',
    defaults: {},
    attributeKeys: ['sku_name'],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Front Door Service' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const baseItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('base') ||
        i.meterName?.toLowerCase().includes('day')
      );
      return baseItems[0] || items[0];
    },
    calculateCost: (item) => {
      if (item.unitOfMeasure?.includes('Day')) {
        return (item.retailPrice || 0) * 30;
      }
      return item.retailPrice || 0;
    }
  },

  'azurerm_cdn_frontdoor_profile': {
    serviceName: 'Azure Front Door Service',
    serviceFamily: 'Networking',
    costUnit: 'per_month',
    defaults: { sku_name: 'Standard_AzureFrontDoor' },
    attributeKeys: ['sku_name'],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Front Door Service' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku_name || '').toLowerCase();
      const matched = items.filter((i: any) =>
        (i.productName || '').toLowerCase().includes(sku.includes('premium') ? 'premium' : 'standard') &&
        (i.meterName?.toLowerCase().includes('base') || i.unitOfMeasure?.includes('Day'))
      );
      return matched[0] || items[0];
    },
    calculateCost: (item) => {
      if (item.unitOfMeasure?.includes('Day')) {
        return (item.retailPrice || 0) * 30;
      }
      return item.retailPrice || 0;
    }
  },

  // ═══ API MANAGEMENT ═══
  'azurerm_api_management': {
    serviceName: 'API Management',
    serviceFamily: 'Integration',
    costUnit: 'per_hour',
    defaults: { sku_name: 'Developer_1' },
    attributeKeys: ['sku_name'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      const skuRaw = attrs.sku_name || 'Developer_1';
      const tier = skuRaw.split('_')[0]; // Developer, Basic, Standard, Premium, Consumption
      return `serviceName eq 'API Management' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const skuRaw = attrs.sku_name || 'Developer_1';
      const tier = skuRaw.split('_')[0].toLowerCase();
      const matched = items.filter((i: any) => {
        const product = (i.productName || '').toLowerCase();
        return product.includes(tier) && i.unitOfMeasure?.includes('Hour') && i.retailPrice > 0;
      });
      return matched[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item, attrs) => {
      const skuRaw = attrs.sku_name || 'Developer_1';
      const units = parseInt(skuRaw.split('_')[1] || '1', 10);
      return perHour(item) * units;
    }
  },

  // ═══ BASTION ═══
  'azurerm_bastion_host': {
    serviceName: 'Azure Bastion',
    serviceFamily: 'Networking',
    costUnit: 'per_hour',
    defaults: { sku: 'Basic' },
    attributeKeys: ['sku'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Bastion' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku || 'Basic').toLowerCase();
      const matched = items.filter((i: any) =>
        (i.productName || '').toLowerCase().includes(sku) &&
        i.unitOfMeasure?.includes('Hour') &&
        i.retailPrice > 0
      );
      return matched[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  // ═══ PRIVATE ENDPOINT ═══
  'azurerm_private_endpoint': {
    serviceName: 'Azure Private Link',
    serviceFamily: 'Networking',
    costUnit: 'per_hour',
    defaults: {},
    attributeKeys: [],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Private Link' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const endpoint = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('private endpoint') &&
        i.unitOfMeasure?.includes('Hour') &&
        i.retailPrice > 0
      );
      return endpoint[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  // ═══ CDN ═══
  'azurerm_cdn_profile': {
    serviceName: 'Content Delivery Network',
    serviceFamily: 'Networking',
    costUnit: 'per_gb_month',
    defaults: { sku: 'Standard_Microsoft' },
    attributeKeys: ['sku'],
    usageAssumptions: { gbPerMonth: 100 },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Content Delivery Network' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku || 'Standard_Microsoft').toLowerCase();
      const provider = sku.includes('akamai') ? 'akamai' : sku.includes('verizon') ? 'verizon' : 'microsoft';
      const matched = items.filter((i: any) =>
        (i.productName || '').toLowerCase().includes(provider) &&
        i.meterName?.toLowerCase().includes('data transfer') &&
        i.retailPrice > 0
      );
      return matched[0] || selectNonZeroItem(items);
    },
    calculateCost: (item, attrs) => {
      const egressGB = attrs.__usage_egress_gb || 100; // from usage catalog or default 100GB
      return (item.retailPrice || 0) * egressGB;
    }
  },

  // ═══ DATABRICKS ═══
  'azurerm_databricks_workspace': {
    serviceName: 'Azure Databricks',
    serviceFamily: 'Analytics',
    costUnit: 'per_hour',
    defaults: { sku: 'standard' },
    attributeKeys: ['sku'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Databricks' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku || 'standard').toLowerCase();
      const matched = items.filter((i: any) =>
        (i.productName || '').toLowerCase().includes(sku) &&
        i.meterName?.toLowerCase().includes('dbu') &&
        i.retailPrice > 0
      );
      return matched[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => {
      // DBU pricing ~$0.07-0.40/DBU-hour. Estimate 2 DBUs * 160 work hours
      return (item.retailPrice || 0) * 2 * 160;
    }
  },

  // ═══ DATA FACTORY ═══
  'azurerm_data_factory': {
    serviceName: 'Azure Data Factory v2',
    serviceFamily: 'Analytics',
    costUnit: 'per_hour',
    defaults: {},
    attributeKeys: [],
    usageAssumptions: { hoursPerMonth: 160 },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Data Factory v2' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const orchestration = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('orchestration') &&
        i.retailPrice > 0
      );
      return orchestration[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => {
      // ~$1/1000 activity runs. Estimate 10,000 runs/month
      return (item.retailPrice || 0) * 10000;
    }
  },

  // ═══ IOT HUB ═══
  'azurerm_iothub': {
    serviceName: 'IoT Hub',
    serviceFamily: 'Internet of Things',
    costUnit: 'per_month',
    defaults: { sku_name: 'S1', sku_capacity: '1' },
    attributeKeys: ['sku_name', 'sku_capacity', 'sku'],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'IoT Hub' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku_name || attrs.sku || 'S1').toUpperCase();
      const matched = items.filter((i: any) =>
        i.meterName?.includes(sku) &&
        (i.unitOfMeasure?.includes('Month') || i.unitOfMeasure?.includes('Day')) &&
        i.retailPrice > 0
      );
      return matched[0] || selectNonZeroItem(items);
    },
    calculateCost: (item, attrs) => {
      const capacity = parseInt(attrs.sku_capacity || '1', 10);
      if (item.unitOfMeasure?.includes('Day')) {
        return (item.retailPrice || 0) * 30 * capacity;
      }
      return (item.retailPrice || 0) * capacity;
    }
  },

  // ═══ SIGNALR ═══
  'azurerm_signalr_service': {
    serviceName: 'SignalR Service',
    serviceFamily: 'Web',
    costUnit: 'per_unit',
    defaults: { sku_name: 'Free_F1', sku_capacity: '1' },
    attributeKeys: ['sku_name', 'sku_capacity', 'sku'],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'SignalR Service' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku_name || attrs.sku || 'Free_F1').toLowerCase();
      if (sku.includes('free')) return null;
      const matched = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('unit') &&
        (i.unitOfMeasure?.includes('Day') || i.unitOfMeasure?.includes('Hour')) &&
        i.retailPrice > 0
      );
      return matched[0] || selectNonZeroItem(items);
    },
    calculateCost: (item, attrs) => {
      if (!item) return 0; // Free tier
      const capacity = parseInt(attrs.sku_capacity || '1', 10);
      if (item.unitOfMeasure?.includes('Day')) {
        return (item.retailPrice || 0) * 30 * capacity;
      }
      return perHour(item) * capacity;
    }
  },

  // ═══ TRAFFIC MANAGER ═══
  'azurerm_traffic_manager_profile': {
    serviceName: 'Traffic Manager',
    serviceFamily: 'Networking',
    costUnit: 'per_month',
    defaults: {},
    attributeKeys: ['traffic_routing_method'],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Traffic Manager' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const dnsItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('dns quer') &&
        i.retailPrice > 0
      );
      return dnsItems[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => {
      // ~$0.54 per million DNS queries. Estimate 1M queries/month
      return (item.retailPrice || 0) * 1;
    }
  },

  // ═══ RECOVERY SERVICES ═══
  'azurerm_recovery_services_vault': {
    serviceName: 'Backup',
    serviceFamily: 'Management and Governance',
    costUnit: 'per_month',
    defaults: { sku: 'Standard' },
    attributeKeys: ['sku'],
    usageAssumptions: { gbPerMonth: 50 },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Backup' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const vmItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('vm') &&
        i.meterName?.toLowerCase().includes('protected') &&
        i.retailPrice > 0
      );
      return vmItems[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => {
      // Estimate: 1 VM protected instance (~$5/month) + 50GB storage
      return (item.retailPrice || 0);
    }
  },

  // ═══ STREAM ANALYTICS ═══
  'azurerm_stream_analytics_job': {
    serviceName: 'Stream Analytics',
    serviceFamily: 'Analytics',
    costUnit: 'per_hour',
    defaults: { streaming_units: '3' },
    attributeKeys: ['streaming_units'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Stream Analytics' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const suItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('streaming unit') &&
        i.unitOfMeasure?.includes('Hour') &&
        i.retailPrice > 0
      );
      return suItems[0] || selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item, attrs) => {
      const su = parseInt(attrs.streaming_units || '3', 10);
      return (item.retailPrice || 0) * su * HOURS_PER_MONTH;
    }
  },

  // ═══ AUTOMATION ═══
  'azurerm_automation_account': {
    serviceName: 'Automation',
    serviceFamily: 'Management and Governance',
    costUnit: 'per_unit',
    defaults: {},
    attributeKeys: [],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Automation' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      const jobItems = items.filter((i: any) =>
        i.meterName?.toLowerCase().includes('job run') &&
        i.retailPrice > 0
      );
      return jobItems[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => {
      // ~$0.002/minute. Estimate 500 minutes/month = ~$1
      return (item.retailPrice || 0) * 500;
    }
  },

  // ═══ NOTIFICATION HUB ═══
  'azurerm_notification_hub_namespace': {
    serviceName: 'Notification Hubs',
    serviceFamily: 'Mobile',
    costUnit: 'per_month',
    defaults: { sku_name: 'Free' },
    attributeKeys: ['sku_name'],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Notification Hubs' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku_name || 'Free').toLowerCase();
      if (sku === 'free') return null;
      const matched = items.filter((i: any) =>
        (i.productName || '').toLowerCase().includes(sku) &&
        i.retailPrice > 0
      );
      return matched[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => {
      if (!item) return 0;
      return item.retailPrice || 0;
    }
  },

  // ═══ EXPRESS ROUTE ═══
  'azurerm_express_route_circuit': {
    serviceName: 'ExpressRoute',
    serviceFamily: 'Networking',
    costUnit: 'per_month',
    defaults: { bandwidth_in_mbps: '50', sku_tier: 'Standard', sku_family: 'MeteredData' },
    attributeKeys: ['bandwidth_in_mbps', 'sku_tier', 'sku_family'],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'ExpressRoute' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const tier = (attrs.sku_tier || 'Standard').toLowerCase();
      const bandwidth = attrs.bandwidth_in_mbps || '50';
      const matched = items.filter((i: any) => {
        const meter = (i.meterName || '').toLowerCase();
        return meter.includes(tier) && meter.includes(bandwidth + ' mbps') &&
          (i.unitOfMeasure?.includes('Month') || i.unitOfMeasure?.includes('Day'));
      });
      return matched[0] || items.find((i: any) =>
        (i.meterName || '').toLowerCase().includes(tier)
      ) || items[0];
    },
    calculateCost: (item) => {
      if (item.unitOfMeasure?.includes('Day')) {
        return (item.retailPrice || 0) * 30;
      }
      return item.retailPrice || 0;
    }
  },

  // ═══ VIRTUAL WAN ═══
  'azurerm_virtual_wan': {
    serviceName: 'Virtual WAN',
    serviceFamily: 'Networking',
    costUnit: 'per_hour',
    defaults: { type: 'Basic' },
    attributeKeys: ['type'],
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Virtual WAN' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items) => {
      return selectByUnit(items, 'hour') || items[0];
    },
    calculateCost: (item) => perHour(item)
  },

  // ═══ BATCH ═══
  'azurerm_batch_account': {
    serviceName: 'Batch',
    serviceFamily: 'Compute',
    costUnit: 'per_month',
    defaults: {},
    attributeKeys: [],
    usageAssumptions: {},
    buildFilter: () => '',
    selectItem: () => null,
    calculateCost: () => 0 // Batch itself is free, cost is in the VMs used
  },

  // ═══ MACHINE LEARNING ═══
  'azurerm_machine_learning_workspace': {
    serviceName: 'Azure Machine Learning',
    serviceFamily: 'AI + Machine Learning',
    costUnit: 'per_month',
    defaults: { sku_name: 'Basic' },
    attributeKeys: ['sku_name'],
    usageAssumptions: {},
    buildFilter: (attrs, location) => {
      return `serviceName eq 'Azure Machine Learning' and armRegionName eq '${location}' and priceType eq 'Consumption'`;
    },
    selectItem: (items, attrs) => {
      const sku = (attrs.sku_name || 'Basic').toLowerCase();
      if (sku === 'basic') return null; // Basic workspace is free
      const matched = items.filter((i: any) =>
        (i.productName || '').toLowerCase().includes(sku) &&
        i.retailPrice > 0
      );
      return matched[0] || selectNonZeroItem(items);
    },
    calculateCost: (item) => {
      if (!item) return 0; // Basic is free
      return item.retailPrice || 0;
    }
  },
};

// ─── Resource Type to Service Name (fallback for unmapped types) ────────────

export const RESOURCE_TYPE_TO_SERVICE_NAME: Record<string, string> = {
  'azurerm_virtual_machine': 'Virtual Machines',
  'azurerm_linux_virtual_machine': 'Virtual Machines',
  'azurerm_windows_virtual_machine': 'Virtual Machines',
  'azurerm_virtual_machine_scale_set': 'Virtual Machine Scale Sets',
  'azurerm_service_plan': 'Azure App Service',
  'azurerm_app_service_plan': 'Azure App Service',
  'azurerm_app_service': 'Azure App Service',
  'azurerm_linux_web_app': 'Azure App Service',
  'azurerm_windows_web_app': 'Azure App Service',
  'azurerm_function_app': 'Functions',
  'azurerm_linux_function_app': 'Functions',
  'azurerm_windows_function_app': 'Functions',
  'azurerm_storage_account': 'Storage',
  'azurerm_managed_disk': 'Storage',
  'azurerm_mssql_server': 'SQL Database',
  'azurerm_mssql_database': 'SQL Database',
  'azurerm_cosmosdb_account': 'Azure Cosmos DB',
  'azurerm_mysql_flexible_server': 'Azure Database for MySQL',
  'azurerm_postgresql_flexible_server': 'Azure Database for PostgreSQL',
  'azurerm_public_ip': 'Virtual Network',
  'azurerm_application_gateway': 'Application Gateway',
  'azurerm_firewall': 'Azure Firewall',
  'azurerm_nat_gateway': 'Virtual Network',
  'azurerm_lb': 'Load Balancer',
  'azurerm_vpn_gateway': 'VPN Gateway',
  'azurerm_virtual_network_gateway': 'VPN Gateway',
  'azurerm_container_registry': 'Container Registry',
  'azurerm_kubernetes_cluster': 'Azure Kubernetes Service',
  'azurerm_container_group': 'Container Instances',
  'azurerm_container_app': 'Azure Container Apps',
  'azurerm_container_app_environment': 'Azure Container Apps',
  'azurerm_key_vault': 'Key Vault',
  'azurerm_log_analytics_workspace': 'Log Analytics',
  'azurerm_application_insights': 'Azure Monitor',
  'azurerm_dns_zone': 'Azure DNS',
  'azurerm_private_dns_zone': 'Azure DNS',
  'azurerm_redis_cache': 'Redis Cache',
  'azurerm_cognitive_account': 'Cognitive Services',
  'azurerm_search_service': 'Azure Cognitive Search',
  'azurerm_eventhub_namespace': 'Event Hubs',
  'azurerm_servicebus_namespace': 'Service Bus',
  'azurerm_logic_app_workflow': 'Logic Apps',
  'azurerm_static_site': 'Static Web Apps',
  'azurerm_frontdoor': 'Azure Front Door Service',
  'azurerm_cdn_frontdoor_profile': 'Azure Front Door Service',
  'azurerm_api_management': 'API Management',
  'azurerm_bastion_host': 'Azure Bastion',
  'azurerm_private_endpoint': 'Azure Private Link',
  'azurerm_cdn_profile': 'Content Delivery Network',
  'azurerm_databricks_workspace': 'Azure Databricks',
  'azurerm_data_factory': 'Azure Data Factory v2',
  'azurerm_iothub': 'IoT Hub',
  'azurerm_signalr_service': 'SignalR Service',
  'azurerm_traffic_manager_profile': 'Traffic Manager',
  'azurerm_recovery_services_vault': 'Backup',
  'azurerm_stream_analytics_job': 'Stream Analytics',
  'azurerm_automation_account': 'Automation',
  'azurerm_notification_hub_namespace': 'Notification Hubs',
  'azurerm_express_route_circuit': 'ExpressRoute',
  'azurerm_virtual_wan': 'Virtual WAN',
  'azurerm_batch_account': 'Batch',
  'azurerm_machine_learning_workspace': 'Azure Machine Learning',
};

// ─── Main API Functions ────────────────────────────────────────────────────────

/**
 * Get the pricing configuration for a resource type
 */
export function getPricingConfig(resourceType: string): AzurePricingEntry | null {
  return AZURE_PRICING_CONFIG[resourceType] || null;
}

/**
 * Check if a resource type is free (no cost)
 */
export function isFreeResource(resourceType: string): string | null {
  return FREE_AZURE_RESOURCES[resourceType] || null;
}

/**
 * Get the Azure service name for a Terraform resource type
 */
export function getServiceName(resourceType: string): string {
  return RESOURCE_TYPE_TO_SERVICE_NAME[resourceType] || resourceType;
}

/**
 * Build the Azure Pricing API filter for a resource
 */
export function buildPricingApiFilter(
  resourceType: string,
  attrs: Record<string, any>,
  terraformLocation: string
): string | null {
  const config = AZURE_PRICING_CONFIG[resourceType];
  if (!config) return null;

  const azureLocation = resolveAzureLocation(terraformLocation);
  const mergedAttrs = { ...config.defaults, ...attrs };

  return config.buildFilter(mergedAttrs, azureLocation);
}

/**
 * Select the best pricing item from API results
 */
export function selectBestPricingItem(
  resourceType: string,
  items: any[],
  attrs: Record<string, any>
): any {
  const config = AZURE_PRICING_CONFIG[resourceType];
  if (!config) return items[0] || null;

  const mergedAttrs = { ...config.defaults, ...attrs };
  return config.selectItem(items, mergedAttrs);
}

/**
 * Calculate monthly cost from a pricing item.
 * Returns null when the pricing item exists but has no retail price
 * (preview/region-limited resources) so callers can surface 'price_unavailable'.
 */
export function calculateMonthlyCost(
  resourceType: string,
  item: any,
  attrs: Record<string, any>
): number | null {
  const config = AZURE_PRICING_CONFIG[resourceType];
  if (!config || !item) return 0;

  // Null retailPrice = price data unavailable for this resource in this region
  if (item.retailPrice === null || item.retailPrice === undefined) return null;

  const mergedAttrs = { ...config.defaults, ...attrs };
  return config.calculateCost(item, mergedAttrs);
}

