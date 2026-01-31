/**
 * Checkov Check ID to Terraform Attribute Mapping Database
 * 
 * This database maps Checkov security check IDs to exact Terraform attributes,
 * values, and examples needed to fix each check.
 * 
 * Phase 1: Foundation for accurate AI-driven Checkov fixes
 */

export interface CheckovFixMapping {
  /** Checkov check ID (e.g., 'CKV_AZURE_59') */
  checkId: string;
  
  /** Human-readable check name */
  checkName: string;
  
  /** Resource types this check applies to */
  resourceTypes: string[];
  
  /** Exact Terraform attribute name to add/modify */
  terraformAttribute: string;
  
  /** Type of attribute: simple value, block, or nested block */
  attributeType: 'simple' | 'block' | 'nested_block';
  
  /** Required value that satisfies the check */
  requiredValue: any;
  
  /** Complete working example showing the fix */
  example: string;
  
  /** Description of what this check does */
  description: string;
  
  /** Optional link to Terraform documentation */
  documentation?: string;
}

/**
 * Checkov Check ID to Terraform Fix Mapping Database
 * 
 * Contains mappings for common Azure Checkov checks.
 * Expand this database over time to cover more checks.
 */
export const CHECKOV_FIX_MAP: Record<string, CheckovFixMapping> = {
  // ============================================================================
  // STORAGE ACCOUNT CHECKS
  // ============================================================================
  
  'CKV_AZURE_59': {
    checkId: 'CKV_AZURE_59',
    checkName: 'Ensure that Storage accounts disallow public access',
    resourceTypes: ['azurerm_storage_account'],
    terraformAttribute: 'allow_nested_items_to_be_public',
    attributeType: 'simple',
    requiredValue: false,
    example: `resource "azurerm_storage_account" "example" {
  name                     = "examplestorage"
  resource_group_name      = azurerm_resource_group.example.name
  location                 = azurerm_resource_group.example.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  
  # Fix for CKV_AZURE_59
  allow_nested_items_to_be_public = false
}`,
    description: 'Disallows public access to nested items (blobs, containers) in storage account',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_account#allow_nested_items_to_be_public'
  },

  'CKV_AZURE_33': {
    checkId: 'CKV_AZURE_33',
    checkName: 'Ensure Storage logging is enabled for Queue service for read, write and delete requests',
    resourceTypes: ['azurerm_storage_account'],
    terraformAttribute: 'queue_properties.logging',
    attributeType: 'nested_block',
    requiredValue: {
      delete: true,
      read: true,
      write: true,
      version: '1.0',
      retention_policy_days: 10
    },
    example: `resource "azurerm_storage_account" "example" {
  name                     = "examplestorage"
  resource_group_name      = azurerm_resource_group.example.name
  location                 = azurerm_resource_group.example.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  
  # Fix for CKV_AZURE_33
  queue_properties {
    logging {
      delete                = true
      read                  = true
      write                 = true
      version               = "1.0"
      retention_policy_days = 10
    }
  }
}`,
    description: 'Enables logging for queue service operations (read, write, delete)',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_account#queue_properties'
  },

  'CKV_AZURE_206': {
    checkId: 'CKV_AZURE_206',
    checkName: 'Ensure that Storage Accounts use replication',
    resourceTypes: ['azurerm_storage_account'],
    terraformAttribute: 'account_replication_type',
    attributeType: 'simple',
    requiredValue: 'GRS', // Options: GRS, GZRS, RAGRS, ZRS (not LRS)
    example: `resource "azurerm_storage_account" "example" {
  name                     = "examplestorage"
  resource_group_name      = azurerm_resource_group.example.name
  location                 = azurerm_resource_group.example.location
  account_tier             = "Standard"
  
  # Fix for CKV_AZURE_206 - Use replication (not LRS)
  account_replication_type = "GRS"  # Options: GRS, GZRS, RAGRS, ZRS
}`,
    description: 'Ensures storage account uses replication for redundancy (GRS, GZRS, RAGRS, or ZRS, not LRS)',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_account#account_replication_type'
  },

  'CKV_AZURE_190': {
    checkId: 'CKV_AZURE_190',
    checkName: 'Ensure that Storage blobs restrict public access',
    resourceTypes: ['azurerm_storage_account'],
    terraformAttribute: 'allow_nested_items_to_be_public',
    attributeType: 'simple',
    requiredValue: false,
    example: `resource "azurerm_storage_account" "example" {
  name                     = "examplestorage"
  resource_group_name      = azurerm_resource_group.example.name
  location                 = azurerm_resource_group.example.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  
  # Fix for CKV_AZURE_190
  allow_nested_items_to_be_public = false
}`,
    description: 'Restricts public access to storage blobs',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_account#allow_nested_items_to_be_public'
  },

  'CKV2_AZURE_38': {
    checkId: 'CKV2_AZURE_38',
    checkName: 'Ensure soft-delete is enabled on Azure storage account',
    resourceTypes: ['azurerm_storage_account'],
    terraformAttribute: 'blob_properties.delete_retention_policy',
    attributeType: 'nested_block',
    requiredValue: {
      days: 7,
      enabled: true
    },
    example: `resource "azurerm_storage_account" "example" {
  name                     = "examplestorage"
  resource_group_name      = azurerm_resource_group.example.name
  location                 = azurerm_resource_group.example.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  
  # Fix for CKV2_AZURE_38
  blob_properties {
    delete_retention_policy {
      days    = 7
      enabled = true
    }
  }
}`,
    description: 'Enables soft-delete retention policy for blob storage',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_account#blob_properties'
  },

  // ============================================================================
  // FUNCTION APP CHECKS
  // ============================================================================

  'CKV_AZURE_70': {
    checkId: 'CKV_AZURE_70',
    checkName: 'Ensure that Function apps is only accessible over HTTPS',
    resourceTypes: ['azurerm_function_app', 'azurerm_linux_function_app', 'azurerm_windows_function_app'],
    terraformAttribute: 'https_only',
    attributeType: 'simple',
    requiredValue: true,
    example: `resource "azurerm_function_app" "example" {
  name                       = "example-function"
  location                   = azurerm_resource_group.example.location
  resource_group_name        = azurerm_resource_group.example.name
  app_service_plan_id        = azurerm_app_service_plan.example.id
  storage_account_name       = azurerm_storage_account.example.name
  storage_account_access_key = azurerm_storage_account.example.primary_access_key
  
  # Fix for CKV_AZURE_70
  https_only = true
}`,
    description: 'Ensures function app is only accessible over HTTPS',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/function_app#https_only'
  },

  'CKV_AZURE_67': {
    checkId: 'CKV_AZURE_67',
    checkName: "Ensure that 'HTTP Version' is the latest, if used to run the Function app",
    resourceTypes: ['azurerm_function_app', 'azurerm_linux_function_app', 'azurerm_windows_function_app'],
    terraformAttribute: 'site_config.http2_enabled',
    attributeType: 'nested_block',
    requiredValue: true,
    example: `resource "azurerm_function_app" "example" {
  name                       = "example-function"
  location                   = azurerm_resource_group.example.location
  resource_group_name        = azurerm_resource_group.example.name
  app_service_plan_id        = azurerm_app_service_plan.example.id
  storage_account_name       = azurerm_storage_account.example.name
  storage_account_access_key = azurerm_storage_account.example.primary_access_key
  
  # Fix for CKV_AZURE_67
  site_config {
    http2_enabled = true
  }
}`,
    description: 'Enables HTTP/2 for function app (latest HTTP version)',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/function_app#site_config'
  },

  'CKV_AZURE_56': {
    checkId: 'CKV_AZURE_56',
    checkName: 'Ensure that function apps enables Authentication',
    resourceTypes: ['azurerm_function_app', 'azurerm_linux_function_app', 'azurerm_windows_function_app'],
    terraformAttribute: 'auth_settings.enabled',
    attributeType: 'nested_block',
    requiredValue: true,
    example: `resource "azurerm_function_app" "example" {
  name                       = "example-function"
  location                   = azurerm_resource_group.example.location
  resource_group_name        = azurerm_resource_group.example.name
  app_service_plan_id        = azurerm_app_service_plan.example.id
  storage_account_name       = azurerm_storage_account.example.name
  storage_account_access_key   = azurerm_storage_account.example.primary_access_key
  
  # Fix for CKV_AZURE_56
  auth_settings {
    enabled = true
  }
}`,
    description: 'Enables authentication for function app',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/function_app#auth_settings'
  },

  // ============================================================================
  // CONTAINER REGISTRY CHECKS
  // ============================================================================

  'CKV_AZURE_139': {
    checkId: 'CKV_AZURE_139',
    checkName: 'Ensure ACR set to disable public networking',
    resourceTypes: ['azurerm_container_registry'],
    terraformAttribute: 'public_network_access_enabled',
    attributeType: 'simple',
    requiredValue: false,
    example: `resource "azurerm_container_registry" "example" {
  name                = "exampleacr"
  resource_group_name = azurerm_resource_group.example.name
  location            = azurerm_resource_group.example.location
  sku                 = "Basic"
  
  # Fix for CKV_AZURE_139
  public_network_access_enabled = false
}`,
    description: 'Disables public network access for container registry',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_registry#public_network_access_enabled'
  },

  'CKV_AZURE_163': {
    checkId: 'CKV_AZURE_163',
    checkName: 'Enable vulnerability scanning for container images',
    resourceTypes: ['azurerm_container_registry'],
    terraformAttribute: 'security_policy',
    attributeType: 'nested_block',
    requiredValue: {
      enabled: true
    },
    example: `resource "azurerm_container_registry" "example" {
  name                = "exampleacr"
  resource_group_name = azurerm_resource_group.example.name
  location            = azurerm_resource_group.example.location
  sku                 = "Premium"  # Required for security_policy
  
  # Fix for CKV_AZURE_163
  security_policy {
    enabled = true
  }
}`,
    description: 'Enables vulnerability scanning for container images (requires Premium SKU)',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_registry#security_policy'
  },

  // ============================================================================
  // ADDITIONAL STORAGE CHECKS
  // ============================================================================

  'CKV2_AZURE_40': {
    checkId: 'CKV2_AZURE_40',
    checkName: 'Ensure storage account is not configured with Shared Key authorization',
    resourceTypes: ['azurerm_storage_account'],
    terraformAttribute: 'shared_access_key_enabled',
    attributeType: 'simple',
    requiredValue: false,
    example: `resource "azurerm_storage_account" "example" {
  name                     = "examplestorage"
  resource_group_name      = azurerm_resource_group.example.name
  location                 = azurerm_resource_group.example.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  
  # Fix for CKV2_AZURE_40
  shared_access_key_enabled = false
}`,
    description: 'Disables shared key authorization (use Azure AD instead)',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_account#shared_access_key_enabled'
  },

  'CKV2_AZURE_47': {
    checkId: 'CKV2_AZURE_47',
    checkName: 'Ensure storage account is configured without blob anonymous access',
    resourceTypes: ['azurerm_storage_account'],
    terraformAttribute: 'allow_nested_items_to_be_public',
    attributeType: 'simple',
    requiredValue: false,
    example: `resource "azurerm_storage_account" "example" {
  name                     = "examplestorage"
  resource_group_name      = azurerm_resource_group.example.name
  location                 = azurerm_resource_group.example.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  
  # Fix for CKV2_AZURE_47
  allow_nested_items_to_be_public = false
}`,
    description: 'Disables anonymous blob access',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_account#allow_nested_items_to_be_public'
  },

  'CKV2_AZURE_1': {
    checkId: 'CKV2_AZURE_1',
    checkName: 'Ensure storage for critical data are encrypted with Customer Managed Key',
    resourceTypes: ['azurerm_storage_account'],
    terraformAttribute: 'customer_managed_key',
    attributeType: 'nested_block',
    requiredValue: {
      key_vault_key_id: 'var.key_vault_key_id',
      user_assigned_identity_id: 'var.user_assigned_identity_id'
    },
    example: `resource "azurerm_storage_account" "example" {
  name                     = "examplestorage"
  resource_group_name      = azurerm_resource_group.example.name
  location                 = azurerm_resource_group.example.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  
  # Fix for CKV2_AZURE_1
  customer_managed_key {
    key_vault_key_id          = azurerm_key_vault_key.example.id
    user_assigned_identity_id = azurerm_user_assigned_identity.example.id
  }
}`,
    description: 'Enables customer-managed key encryption for storage account',
    documentation: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_account#customer_managed_key'
  }
};

/**
 * Get the fix mapping for a specific Checkov check ID
 * 
 * @param checkId - The Checkov check ID (e.g., 'CKV_AZURE_59')
 * @returns The mapping if found, undefined otherwise
 */
export function getCheckovFixMapping(checkId: string): CheckovFixMapping | undefined {
  return CHECKOV_FIX_MAP[checkId];
}

/**
 * Get fix mappings for multiple check IDs
 * 
 * @param checkIds - Array of Checkov check IDs
 * @returns Array of mappings (only includes checks that have mappings)
 */
export function getCheckovFixMappings(checkIds: string[]): CheckovFixMapping[] {
  return checkIds
    .map(id => CHECKOV_FIX_MAP[id])
    .filter((mapping): mapping is CheckovFixMapping => mapping !== undefined);
}

/**
 * Check if a mapping exists for a check ID
 * 
 * @param checkId - The Checkov check ID
 * @returns True if mapping exists, false otherwise
 */
export function hasCheckovFixMapping(checkId: string): boolean {
  return checkId in CHECKOV_FIX_MAP;
}

/**
 * Get all available check IDs that have mappings
 * 
 * @returns Array of check IDs
 */
export function getAllMappedCheckIds(): string[] {
  return Object.keys(CHECKOV_FIX_MAP);
}

/**
 * Get mappings count
 * 
 * @returns Total number of mappings in the database
 */
export function getMappingsCount(): number {
  return Object.keys(CHECKOV_FIX_MAP).length;
}

