/**
 * Checkov Fix Guidance System
 * 
 * Provides clear, actionable guidance for each Checkov check failure.
 * Helps users understand why checks fail and how to fix them.
 */

export interface FixGuidance {
  checkId: string;
  checkName: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  autoFixable: boolean;
  fixComplexity: 'simple' | 'moderate' | 'complex' | 'requires-resources';
  whyItFailed: string;
  howToFix: string;
  manualSteps?: string[];
  prerequisites?: string[];
  costImplication?: string;
  canIgnore?: boolean;
  ignoreReason?: string;
}

/**
 * Fix guidance database for common Azure Checkov checks
 */
export const FIX_GUIDANCE_DB: Record<string, FixGuidance> = {
  // Storage Account Checks
  'CKV_AZURE_59': {
    checkId: 'CKV_AZURE_59',
    checkName: 'Ensure that Storage accounts disallow public access',
    severity: 'high',
    autoFixable: true,
    fixComplexity: 'simple',
    whyItFailed: 'Storage account has public network access enabled, allowing public access to storage data.',
    howToFix: 'Add `public_network_access_enabled = false` to the storage account resource block.',
    manualSteps: [
      'Locate the `azurerm_storage_account` resource in your Terraform code',
      'Add or modify: `public_network_access_enabled = false`',
      'This disables public access to the storage account'
    ],
    canIgnore: false
  },

  'CKV_AZURE_33': {
    checkId: 'CKV_AZURE_33',
    checkName: 'Ensure Storage logging is enabled for Queue service',
    severity: 'medium',
    autoFixable: false,
    fixComplexity: 'moderate',
    whyItFailed: 'Storage account must be StorageV2 account kind and have queue logging enabled.',
    howToFix: 'Set `account_kind = "StorageV2"` and add `queue_properties` block with logging enabled.',
    manualSteps: [
      'Ensure `account_kind = "StorageV2"` (upgrade from Storage if needed)',
      'Add `queue_properties` block with logging configuration',
      'Example: `queue_properties { logging { delete = true, read = true, write = true } }`'
    ],
    prerequisites: ['Storage account must be StorageV2 (not Storage)'],
    canIgnore: false
  },

  'CKV_AZURE_206': {
    checkId: 'CKV_AZURE_206',
    checkName: 'Ensure that Storage Accounts use replication',
    severity: 'high',
    autoFixable: true,
    fixComplexity: 'simple',
    whyItFailed: 'Storage account replication type is not set or uses LRS (no redundancy).',
    howToFix: 'Set `account_replication_type` to a value with redundancy (e.g., "GRS", "RAGRS", "ZRS").',
    manualSteps: [
      'Add or modify: `account_replication_type = "GRS"` (or "RAGRS", "ZRS")',
      'GRS = Geo-Redundant Storage (recommended for production)',
      'ZRS = Zone-Redundant Storage (for better performance)'
    ],
    costImplication: 'GRS/ZRS costs more than LRS but provides redundancy',
    canIgnore: false
  },

  'CKV_AZURE_190': {
    checkId: 'CKV_AZURE_190',
    checkName: 'Ensure that Storage blobs restrict public access',
    severity: 'critical',
    autoFixable: true,
    fixComplexity: 'simple',
    whyItFailed: 'Storage account allows nested items (blobs/containers) to be publicly accessible.',
    howToFix: 'Add `allow_nested_items_to_be_public = false` to the storage account resource.',
    manualSteps: [
      'Add: `allow_nested_items_to_be_public = false`',
      'This prevents blobs and containers from being publicly accessible'
    ],
    canIgnore: false
  },

  'CKV2_AZURE_40': {
    checkId: 'CKV2_AZURE_40',
    checkName: 'Ensure storage account is not configured with Shared Key authorization',
    severity: 'high',
    autoFixable: true,
    fixComplexity: 'simple',
    whyItFailed: 'Storage account allows Shared Key authentication, which is less secure than Azure AD.',
    howToFix: 'Add `shared_access_key_enabled = false` to disable Shared Key authentication.',
    manualSteps: [
      'Add: `shared_access_key_enabled = false`',
      'This forces use of Azure AD authentication (more secure)',
      'Note: Existing applications using Shared Keys will need to migrate to Azure AD'
    ],
    canIgnore: true,
    ignoreReason: 'If you have legacy applications that require Shared Key authentication'
  },

  'CKV2_AZURE_47': {
    checkId: 'CKV2_AZURE_47',
    checkName: 'Ensure storage account is configured without blob anonymous access',
    severity: 'high',
    autoFixable: true,
    fixComplexity: 'simple',
    whyItFailed: 'Storage account allows anonymous blob access, which is a security risk.',
    howToFix: 'Add `allow_nested_items_to_be_public = false` (same as CKV_AZURE_190).',
    manualSteps: [
      'Add: `allow_nested_items_to_be_public = false`',
      'This prevents anonymous access to blobs'
    ],
    canIgnore: false
  },

  'CKV2_AZURE_38': {
    checkId: 'CKV2_AZURE_38',
    checkName: 'Ensure soft-delete is enabled on Azure storage account',
    severity: 'medium',
    autoFixable: true,
    fixComplexity: 'moderate',
    whyItFailed: 'Storage account does not have soft-delete enabled, making data recovery difficult.',
    howToFix: 'Add `blob_properties` block with `delete_retention_policy` enabled.',
    manualSteps: [
      'Ensure `account_kind = "StorageV2"`',
      'Add: `blob_properties { delete_retention_policy { days = 7 } }`',
      'This enables soft-delete for 7 days (adjust as needed)'
    ],
    prerequisites: ['Storage account must be StorageV2'],
    canIgnore: false
  },

  'CKV2_AZURE_41': {
    checkId: 'CKV2_AZURE_41',
    checkName: 'Ensure storage account is configured with SAS expiration policy',
    severity: 'medium',
    autoFixable: true,
    fixComplexity: 'moderate',
    whyItFailed: 'Storage account does not have SAS expiration policy configured.',
    howToFix: 'Add `sas_policy` block with expiration period.',
    manualSteps: [
      'Add: `sas_policy { expiration_period = "P365D" }` (1 year expiration)',
      'Adjust expiration period as needed (P30D = 30 days, P365D = 1 year)'
    ],
    canIgnore: false
  },

  'CKV2_AZURE_33': {
    checkId: 'CKV2_AZURE_33',
    checkName: 'Ensure storage account is configured with private endpoint',
    severity: 'high',
    autoFixable: false,
    fixComplexity: 'requires-resources',
    whyItFailed: 'Storage account is accessible over public internet instead of private endpoint.',
    howToFix: 'Create a private endpoint resource that connects the storage account to a VNet.',
    manualSteps: [
      'Create Virtual Network (if not exists)',
      'Create Subnet with service delegation for Microsoft.Storage',
      'Create Private Endpoint resource linking to storage account',
      'Create Private DNS Zone for storage account',
      'This requires multiple resources and is complex'
    ],
    prerequisites: [
      'Virtual Network',
      'Subnet with service delegation',
      'Private Endpoint resource',
      'Private DNS Zone (optional but recommended)'
    ],
    costImplication: 'Private endpoints have minimal cost but require VNet infrastructure',
    canIgnore: true,
    ignoreReason: 'If storage account needs to be publicly accessible for your use case'
  },

  'CKV2_AZURE_1': {
    checkId: 'CKV2_AZURE_1',
    checkName: 'Ensure storage for critical data are encrypted with Customer Managed Key',
    severity: 'high',
    autoFixable: false,
    fixComplexity: 'requires-resources',
    whyItFailed: 'Storage account uses Microsoft-managed keys instead of customer-managed keys (CMK).',
    howToFix: 'Create Key Vault, Key Vault Key, and configure storage account to use CMK.',
    manualSteps: [
      'Create Azure Key Vault resource',
      'Create Key Vault Key (encryption key)',
      'Grant storage account identity access to Key Vault',
      'Add `customer_managed_key` block to storage account with key reference',
      'This is a multi-step process requiring multiple resources'
    ],
    prerequisites: [
      'Azure Key Vault',
      'Key Vault Key',
      'Key Vault Access Policy for storage account',
      'Storage account with managed identity enabled'
    ],
    costImplication: 'Key Vault has minimal cost, but provides better security and compliance',
    canIgnore: true,
    ignoreReason: 'If Microsoft-managed keys are acceptable for your compliance requirements'
  },

  // Function App Checks
  'CKV_AZURE_67': {
    checkId: 'CKV_AZURE_67',
    checkName: 'Ensure that HTTP Version is the latest, if used to run the Function app',
    severity: 'medium',
    autoFixable: true,
    fixComplexity: 'simple',
    whyItFailed: 'Function app does not have HTTP/2 enabled in site_config.',
    howToFix: 'Add `http2_enabled = true` inside the `site_config` block.',
    manualSteps: [
      'Locate `site_config` block in `azurerm_function_app`',
      'Add or modify: `http2_enabled = true`',
      'This enables HTTP/2 for better performance'
    ],
    canIgnore: false
  },

  'CKV_AZURE_70': {
    checkId: 'CKV_AZURE_70',
    checkName: 'Ensure that Function apps is only accessible over HTTPS',
    severity: 'high',
    autoFixable: false,
    fixComplexity: 'moderate',
    whyItFailed: 'Function app allows HTTP access in addition to HTTPS.',
    howToFix: 'Add `https_only = true` inside the `site_config` block.',
    manualSteps: [
      'Locate or create `site_config` block in `azurerm_function_app`',
      'Add: `https_only = true`',
      'This forces all traffic to use HTTPS'
    ],
    canIgnore: false
  },

  'CKV_AZURE_56': {
    checkId: 'CKV_AZURE_56',
    checkName: 'Ensure that function apps enables Authentication',
    severity: 'high',
    autoFixable: false,
    fixComplexity: 'complex',
    whyItFailed: 'Function app does not have authentication/authorization enabled.',
    howToFix: 'Add `auth_settings` block with authentication provider configuration.',
    manualSteps: [
      'Add `auth_settings` block to `azurerm_function_app`',
      'Configure authentication provider (Azure AD, Google, Facebook, etc.)',
      'Example: `auth_settings { enabled = true, active_directory { ... } }`',
      'This requires setting up identity provider and credentials'
    ],
    prerequisites: [
      'Azure AD App Registration (for Azure AD auth)',
      'Client ID and Client Secret',
      'Identity provider configuration'
    ],
    canIgnore: true,
    ignoreReason: 'If function app is behind API Management or other authentication layer'
  },

  // Container Registry Checks
  'CKV_AZURE_163': {
    checkId: 'CKV_AZURE_163',
    checkName: 'Enable vulnerability scanning for container images',
    severity: 'high',
    autoFixable: false,
    fixComplexity: 'moderate',
    whyItFailed: 'Container Registry does not have vulnerability scanning enabled. This requires Premium SKU.',
    howToFix: 'Upgrade to Premium SKU and enable security policies.',
    manualSteps: [
      'Upgrade SKU: `sku = "Premium"` (from Basic or Standard)',
      'Add security policy: `security_policy { trust_policy { enabled = true } }`',
      'Note: Premium SKU is required for vulnerability scanning'
    ],
    prerequisites: ['Container Registry must be Premium SKU'],
    costImplication: 'Premium SKU costs significantly more than Basic/Standard',
    canIgnore: true,
    ignoreReason: 'If cost is a concern and vulnerability scanning is handled elsewhere'
  },

  'CKV_AZURE_237': {
    checkId: 'CKV_AZURE_237',
    checkName: 'Ensure dedicated data endpoints are enabled',
    severity: 'medium',
    autoFixable: false,
    fixComplexity: 'moderate',
    whyItFailed: 'Container Registry does not have dedicated data endpoints enabled. Requires Premium SKU.',
    howToFix: 'Upgrade to Premium SKU and enable data endpoints.',
    manualSteps: [
      'Upgrade SKU: `sku = "Premium"`',
      'Add: `data_endpoint_enabled = true`',
      'This enables dedicated data endpoints for better performance'
    ],
    prerequisites: ['Container Registry must be Premium SKU'],
    costImplication: 'Premium SKU required',
    canIgnore: true,
    ignoreReason: 'If Standard SKU is sufficient for your needs'
  },

  'CKV_AZURE_166': {
    checkId: 'CKV_AZURE_166',
    checkName: 'Ensure container image quarantine, scan, and mark images verified',
    severity: 'high',
    autoFixable: false,
    fixComplexity: 'moderate',
    whyItFailed: 'Container Registry does not have quarantine policy enabled. Requires Premium SKU.',
    howToFix: 'Upgrade to Premium SKU and enable quarantine policy.',
    manualSteps: [
      'Upgrade SKU: `sku = "Premium"`',
      'Add: `quarantine_policy_enabled = true`',
      'This quarantines images until they are scanned and verified'
    ],
    prerequisites: ['Container Registry must be Premium SKU'],
    costImplication: 'Premium SKU required',
    canIgnore: true,
    ignoreReason: 'If cost is a concern'
  },

  'CKV_AZURE_167': {
    checkId: 'CKV_AZURE_167',
    checkName: 'Ensure a retention policy is set to cleanup untagged manifests',
    severity: 'medium',
    autoFixable: false,
    fixComplexity: 'moderate',
    whyItFailed: 'Container Registry does not have retention policy configured. Requires Premium SKU.',
    howToFix: 'Upgrade to Premium SKU and configure retention policy.',
    manualSteps: [
      'Upgrade SKU: `sku = "Premium"`',
      'Add: `retention_policy { days = 7, enabled = true }`',
      'Adjust days as needed (7-365 days)'
    ],
    prerequisites: ['Container Registry must be Premium SKU'],
    costImplication: 'Premium SKU required',
    canIgnore: true,
    ignoreReason: 'If cost is a concern'
  },

  'CKV_AZURE_233': {
    checkId: 'CKV_AZURE_233',
    checkName: 'Ensure Azure Container Registry (ACR) is zone redundant',
    severity: 'high',
    autoFixable: false,
    fixComplexity: 'moderate',
    whyItFailed: 'Container Registry is not zone redundant. Requires Premium SKU.',
    howToFix: 'Upgrade to Premium SKU and enable zone redundancy.',
    manualSteps: [
      'Upgrade SKU: `sku = "Premium"`',
      'Add: `zone_redundancy_enabled = true`',
      'This provides high availability across availability zones'
    ],
    prerequisites: ['Container Registry must be Premium SKU', 'Region must support availability zones'],
    costImplication: 'Premium SKU required',
    canIgnore: true,
    ignoreReason: 'If single-zone deployment is acceptable for your use case'
  },

  'CKV_AZURE_165': {
    checkId: 'CKV_AZURE_165',
    checkName: 'Ensure geo-replicated container registries to match multi-region container deployments',
    severity: 'medium',
    autoFixable: false,
    fixComplexity: 'complex',
    whyItFailed: 'Container Registry does not have geo-replication enabled. Requires Premium SKU.',
    howToFix: 'Upgrade to Premium SKU and configure geo-replication.',
    manualSteps: [
      'Upgrade SKU: `sku = "Premium"`',
      'Add `georeplications` block with target regions',
      'Example: `georeplications { location = "eastus" }`',
      'This replicates registry to multiple regions'
    ],
    prerequisites: ['Container Registry must be Premium SKU'],
    costImplication: 'Premium SKU + additional costs for geo-replication',
    canIgnore: true,
    ignoreReason: 'If single-region deployment is sufficient'
  },

  'CKV_AZURE_139': {
    checkId: 'CKV_AZURE_139',
    checkName: 'Ensure ACR set to disable public networking',
    severity: 'high',
    autoFixable: true,
    fixComplexity: 'simple',
    whyItFailed: 'Container Registry allows public network access.',
    howToFix: 'Add `public_network_access_enabled = false` to the container registry resource.',
    manualSteps: [
      'Add: `public_network_access_enabled = false`',
      'This restricts access to private endpoints only'
    ],
    canIgnore: false
  },

  'CKV_AZURE_164': {
    checkId: 'CKV_AZURE_164',
    checkName: 'Ensures that ACR uses signed/trusted images',
    severity: 'high',
    autoFixable: false,
    fixComplexity: 'moderate',
    whyItFailed: 'Container Registry does not have content trust policy enabled. Requires Premium SKU.',
    howToFix: 'Upgrade to Premium SKU and enable trust policy.',
    manualSteps: [
      'Upgrade SKU: `sku = "Premium"`',
      'Add: `trust_policy { enabled = true }`',
      'This enables content trust for signed images'
    ],
    prerequisites: ['Container Registry must be Premium SKU'],
    costImplication: 'Premium SKU required',
    canIgnore: true,
    ignoreReason: 'If cost is a concern'
  },

  // Virtual Machine Checks
  'CKV_AZURE_1': {
    checkId: 'CKV_AZURE_1',
    checkName: 'Ensure Azure Instance does not use basic authentication (Use SSH Key Instead)',
    severity: 'high',
    autoFixable: true,
    fixComplexity: 'simple',
    whyItFailed: 'Virtual Machine allows password authentication instead of SSH key authentication.',
    howToFix: 'Add `disable_password_authentication = true` in `os_profile_linux_config` block.',
    manualSteps: [
      'Locate `os_profile_linux_config` block in `azurerm_virtual_machine`',
      'Add or modify: `disable_password_authentication = true`',
      'Ensure SSH keys are configured in the same block'
    ],
    canIgnore: false
  },

  'CKV_AZURE_10': {
    checkId: 'CKV_AZURE_10',
    checkName: 'Ensure that SSH access is restricted from the internet',
    severity: 'critical',
    autoFixable: true,
    fixComplexity: 'moderate',
    whyItFailed: 'Network Security Group allows SSH (port 22) from internet (0.0.0.0/0).',
    howToFix: 'Modify NSG security rules to restrict SSH access to specific IP ranges or remove internet access.',
    manualSteps: [
      'Locate `azurerm_network_security_group` resource',
      'Find security rule allowing SSH from internet',
      'Modify `source_address_prefix` to specific IP range or remove rule',
      'Example: `source_address_prefix = "203.0.113.0/24"` (your office IP)'
    ],
    canIgnore: false
  },

  'CKV2_AZURE_10': {
    checkId: 'CKV2_AZURE_10',
    checkName: 'Ensure that Microsoft Antimalware is configured to automatically updates for Virtual Machines',
    severity: 'medium',
    autoFixable: false,
    fixComplexity: 'complex',
    whyItFailed: 'Virtual Machine does not have Microsoft Antimalware extension configured with auto-updates.',
    howToFix: 'Add `azurerm_virtual_machine_extension` resource for Microsoft Antimalware.',
    manualSteps: [
      'Create `azurerm_virtual_machine_extension` resource',
      'Set `publisher = "Microsoft.Azure.Security"`',
      'Set `type = "IaaSAntimalware"`',
      'Configure settings with auto-update enabled',
      'This requires extension resource creation'
    ],
    prerequisites: ['Virtual Machine extension resource'],
    canIgnore: true,
    ignoreReason: 'If using third-party antimalware solution'
  },

  'CKV2_AZURE_9': {
    checkId: 'CKV2_AZURE_9',
    checkName: 'Ensure Virtual Machines are utilizing Managed Disks',
    severity: 'high',
    autoFixable: true,
    fixComplexity: 'simple',
    whyItFailed: 'Virtual Machine is using unmanaged disks (VHD URIs) instead of managed disks.',
    howToFix: 'Remove `vhd_uri` and use `managed_disk_type` in `storage_os_disk` block.',
    manualSteps: [
      'Locate `storage_os_disk` block',
      'Remove `vhd_uri` attribute',
      'Add `managed_disk_type = "Premium_LRS"` or "Standard_LRS"',
      'Managed disks provide better reliability and management'
    ],
    canIgnore: false
  },

  'CKV2_AZURE_12': {
    checkId: 'CKV2_AZURE_12',
    checkName: 'Ensure that virtual machines are backed up using Azure Backup',
    severity: 'medium',
    autoFixable: false,
    fixComplexity: 'requires-resources',
    whyItFailed: 'Virtual Machine is not configured with Azure Backup.',
    howToFix: 'Create Azure Backup resources (Recovery Services Vault, Backup Policy, Backup Item).',
    manualSteps: [
      'Create `azurerm_recovery_services_vault` resource',
      'Create `azurerm_backup_policy_vm` resource',
      'Create `azurerm_backup_protected_vm` resource linking VM to backup',
      'This requires multiple resources and backup service setup'
    ],
    prerequisites: [
      'Recovery Services Vault',
      'Backup Policy',
      'Backup Protected VM resource'
    ],
    costImplication: 'Azure Backup has storage costs based on backup size',
    canIgnore: true,
    ignoreReason: 'If using alternative backup solution'
  },

  // Networking Checks
  'CKV2_AZURE_31': {
    checkId: 'CKV2_AZURE_31',
    checkName: 'Ensure VNET subnet is configured with a Network Security Group (NSG)',
    severity: 'high',
    autoFixable: true,
    fixComplexity: 'simple',
    whyItFailed: 'Subnet does not have Network Security Group associated.',
    howToFix: 'Add `network_security_group_id` attribute to subnet resource.',
    manualSteps: [
      'Locate `azurerm_subnet` resource',
      'Add: `network_security_group_id = azurerm_network_security_group.example.id`',
      'Reference an existing NSG or create one first'
    ],
    prerequisites: ['Network Security Group resource must exist'],
    canIgnore: false
  },

  'CKV_AZURE_119': {
    checkId: 'CKV_AZURE_119',
    checkName: 'Ensure that Network Interfaces don\'t use public IPs',
    severity: 'medium',
    autoFixable: true,
    fixComplexity: 'simple',
    whyItFailed: 'Network Interface has a public IP associated, exposing it to the internet.',
    howToFix: 'Remove `public_ip_address_id` from network interface or set to null.',
    manualSteps: [
      'Locate `azurerm_network_interface` resource',
      'Remove `public_ip_address_id` attribute',
      'Use private IP only or access via load balancer'
    ],
    canIgnore: true,
    ignoreReason: 'If VM needs direct internet access (not recommended)'
  }
};

/**
 * Get fix guidance for a Checkov check
 */
export function getFixGuidance(checkId: string, checkName?: string): FixGuidance | null {
  const guidance = FIX_GUIDANCE_DB[checkId];
  
  if (guidance) {
    return guidance;
  }
  
  // Return generic guidance if not found
  return {
    checkId,
    checkName: checkName || checkId,
    severity: 'medium',
    autoFixable: false,
    fixComplexity: 'moderate',
    whyItFailed: `Check ${checkId} failed. Review the Checkov guideline for specific requirements.`,
    howToFix: `Review the Checkov guideline URL and apply the recommended security configuration.`,
    canIgnore: false
  };
}

/**
 * Generate a clear error message with fix guidance
 */
export function generateFixMessage(check: {
  checkId: string;
  checkName: string;
  resource: string;
  evaluatedKeys?: string[];
}): string {
  const guidance = getFixGuidance(check.checkId, check.checkName);
  
  if (!guidance) {
    return `❌ ${check.checkId}: ${check.checkName}\n   Resource: ${check.resource}\n   Issue: Check failed. Review Checkov guideline for fix instructions.`;
  }
  
  let message = `❌ ${check.checkId}: ${check.checkName}\n`;
  message += `   Resource: ${check.resource}\n`;
  message += `   Severity: ${guidance.severity.toUpperCase()}\n`;
  message += `   Why it failed: ${guidance.whyItFailed}\n`;
  message += `   How to fix: ${guidance.howToFix}\n`;
  
  if (guidance.prerequisites && guidance.prerequisites.length > 0) {
    message += `   Prerequisites: ${guidance.prerequisites.join(', ')}\n`;
  }
  
  if (guidance.costImplication) {
    message += `   Cost: ${guidance.costImplication}\n`;
  }
  
  if (guidance.autoFixable) {
    message += `   ✅ Can be auto-fixed: Yes\n`;
  } else {
    message += `   ⚠️  Requires manual fix: ${guidance.fixComplexity}\n`;
  }
  
  if (guidance.canIgnore) {
    message += `   ⚠️  Can be ignored: ${guidance.ignoreReason || 'If acceptable for your use case'}\n`;
  } else {
    message += `   ❌ Should not be ignored: Security risk\n`;
  }
  
  return message;
}



