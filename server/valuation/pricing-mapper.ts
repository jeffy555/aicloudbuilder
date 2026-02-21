/**
 * Azure Pricing Mapper for Valuation Module
 *
 * Maps live Azure ARM resource types to Terraform resource types for pricing lookup.
 * Reuses existing pricing configuration from azure-pricing-config.ts.
 */

import { getPricingConfig, buildPricingApiFilter, selectBestPricingItem, calculateMonthlyCost, isFreeResource } from '../azure-pricing-config';

// Azure ARM type → Terraform resource type mapping
export const AZURE_ARM_TO_TERRAFORM_TYPE: Record<string, string> = {
  'Microsoft.Storage/storageAccounts': 'azurerm_storage_account',
  'Microsoft.Compute/virtualMachines': 'azurerm_virtual_machine',
  'Microsoft.Sql/servers/databases': 'azurerm_mssql_database',
  'Microsoft.ContainerRegistry/registries': 'azurerm_container_registry',
  'Microsoft.KeyVault/vaults': 'azurerm_key_vault',
  'Microsoft.DBforPostgreSQL/flexibleServers': 'azurerm_postgresql_flexible_server',
  'Microsoft.DBforMySQL/flexibleServers': 'azurerm_mysql_flexible_server',
  'Microsoft.Network/publicIPAddresses': 'azurerm_public_ip',
  'Microsoft.Network/applicationGateways': 'azurerm_application_gateway',
  'Microsoft.ContainerService/managedClusters': 'azurerm_kubernetes_cluster',
  'Microsoft.Web/sites': 'azurerm_linux_web_app',
  'Microsoft.Web/serverFarms': 'azurerm_app_service_plan',
  'Microsoft.Cache/redis': 'azurerm_redis_cache',
  'Microsoft.Compute/disks': 'azurerm_managed_disk',
  'Microsoft.ContainerInstance/containerGroups': 'azurerm_container_group',
};

/**
 * Maps Azure ARM resource type to Terraform resource type
 */
export function mapAzureResourceToTerraformType(azureType: string): string | null {
  return AZURE_ARM_TO_TERRAFORM_TYPE[azureType] || null;
}

/**
 * Extracts pricing-relevant attributes from Azure resource
 * Different resource types have different attribute structures
 */
export function extractPricingAttributes(
  azureResource: any,
  terraformType: string
): Record<string, any> {
  const baseAttrs = { location: azureResource.location };

  switch (terraformType) {
    case 'azurerm_storage_account':
      // Azure SKU format: "Standard_LRS", "Standard_GRS", "Standard_RAGRS", "Premium_LRS"
      const skuName = azureResource.sku || 'Standard_LRS';
      const parts = skuName.split('_');
      const tier = parts[0] || 'Standard';
      const replication = parts[1] || 'LRS';

      return {
        ...baseAttrs,
        account_tier: tier,
        account_replication_type: replication,
        access_tier: azureResource.properties?.accessTier || 'Hot'
      };

    case 'azurerm_virtual_machine':
    case 'azurerm_linux_virtual_machine':
    case 'azurerm_windows_virtual_machine':
      return {
        ...baseAttrs,
        size: azureResource.properties?.hardwareProfile?.vmSize || 'Standard_B2s'
      };

    case 'azurerm_mssql_database':
      return {
        ...baseAttrs,
        sku_name: azureResource.sku?.name || 'Basic'
      };

    case 'azurerm_app_service_plan':
      return {
        ...baseAttrs,
        sku_name: azureResource.sku?.name || 'B1'
      };

    case 'azurerm_redis_cache':
      return {
        ...baseAttrs,
        family: azureResource.sku?.family || 'C',
        capacity: azureResource.sku?.capacity || 1
      };

    case 'azurerm_managed_disk':
      return {
        ...baseAttrs,
        storage_account_type: azureResource.sku?.name || 'Standard_LRS',
        disk_size_gb: azureResource.properties?.diskSizeGB || 128
      };

    case 'azurerm_container_registry':
      return {
        ...baseAttrs,
        sku: azureResource.sku?.name || 'Basic'
      };

    // Default case: just pass location
    default:
      return baseAttrs;
  }
}

/**
 * Calculates cost for an Azure resource using existing pricing config
 */
export async function calculateResourceCost(
  terraformType: string,
  attributes: Record<string, any>,
  location: string
): Promise<{ monthlyCost: number; yearlyCost: number; pricingDetails: any }> {
  // Check if resource is free
  const freeReason = isFreeResource(terraformType);
  if (freeReason) {
    return {
      monthlyCost: 0,
      yearlyCost: 0,
      pricingDetails: { freeReason }
    };
  }

  // Get pricing config
  const config = getPricingConfig(terraformType);
  if (!config) {
    throw new Error(`No pricing configuration found for resource type: ${terraformType}`);
  }

  // Build OData filter for Azure Pricing API
  const filter = buildPricingApiFilter(terraformType, attributes, location);

  // Fetch pricing data from Azure Retail Prices API (INR currency)
  // Add currency filter for INR prices
  const currencyFilter = "currencyCode eq 'INR'";
  const filterParam = filter ? `${filter} and ${currencyFilter}` : currencyFilter;

  const response = await fetch(
    `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filterParam)}`
  );

  if (!response.ok) {
    throw new Error(`Azure Pricing API request failed: ${response.statusText}`);
  }

  const data = await response.json();

  console.log(`   🔍 Pricing API returned ${data.Items?.length || 0} items for ${terraformType}`);

  if (!data.Items || data.Items.length === 0) {
    console.warn(`   ⚠️  No pricing data found. Filter used: ${filterParam.substring(0, 200)}`);
    return {
      monthlyCost: 0,
      yearlyCost: 0,
      pricingDetails: { error: 'No pricing data available for this resource configuration' }
    };
  }

  // Select best pricing item from results
  const pricingItem = selectBestPricingItem(terraformType, data.Items, attributes);

  if (!pricingItem) {
    console.warn(`   ⚠️  Could not select pricing item from ${data.Items.length} results`);
    return {
      monthlyCost: 0,
      yearlyCost: 0,
      pricingDetails: { error: 'Could not match pricing item' }
    };
  }

  // Calculate monthly cost
  const monthlyCost = calculateMonthlyCost(terraformType, pricingItem, attributes);
  const yearlyCost = monthlyCost * 12;

  return { monthlyCost, yearlyCost, pricingDetails: pricingItem };
}
