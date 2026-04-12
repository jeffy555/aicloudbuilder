/**
 * Maps Azure ARM resource types to azurerm 4.x Terraform guidance.
 *
 * When MigrateOps discovers a resource, this module attaches a short
 * "migration cheat-sheet" per resource type so the AI model knows:
 *   1. The correct azurerm resource type name
 *   2. Which ARM properties map to which Terraform arguments
 *   3. Attributes that were renamed/removed in azurerm 4.x
 *   4. Required blocks or arguments the provider mandates
 *
 * This is the single source of truth for ARM → HCL mapping.
 * Adding a new entry here automatically feeds the AI prompt.
 *
 * Tags: MigrateOps injects standard Terraform tags during generation/repair (not copied from ARM).
 * Keep tags stable across files so imports/plans are easier to verify and filter.
 */

export interface SchemaGuidance {
  /** Correct azurerm 4.x resource type (e.g. "azurerm_storage_account") */
  terraformType: string;
  /** ARM property name → Terraform argument name (only non-obvious mappings) */
  propertyMap?: Record<string, string>;
  /** Attributes that existed in azurerm 2.x/3.x but are renamed in 4.x: old → new */
  renamedAttributes?: Record<string, string>;
  /** Attributes or blocks that no longer exist in 4.x */
  removedAttributes?: string[];
  /** Required arguments the provider mandates (AI often omits these) */
  requiredArguments?: string[];
  /** Free-form migration notes shown to AI */
  notes?: string;
}

/**
 * Keyed by lowercase Azure ARM type (e.g. "microsoft.storage/storageaccounts").
 * Partial match is used (ARM type "includes" the key).
 */
const SCHEMA_GUIDANCE: Record<string, SchemaGuidance> = {

  'microsoft.storage/storageaccounts': {
    terraformType: 'azurerm_storage_account',
    propertyMap: {
      'properties.supportsHttpsTrafficOnly': 'https_traffic_only_enabled',
      'properties.allowBlobPublicAccess': 'allow_nested_items_to_be_public',
      'properties.allowSharedKeyAccess': 'shared_access_key_enabled',
      'properties.minimumTlsVersion': 'min_tls_version',
      'properties.accessTier': 'access_tier',
      'properties.isHnsEnabled': 'is_hns_enabled',
      'sku.name': 'account_replication_type (extract replication suffix: LRS, GRS, etc.)',
      'sku.tier': 'account_tier (Standard or Premium)',
    },
    renamedAttributes: {
      'enable_https_traffic_only': 'https_traffic_only_enabled',
      'allow_blob_public_access': 'allow_nested_items_to_be_public',
      'allow_shared_key_access': 'shared_access_key_enabled',
    },
    removedAttributes: ['encryption (top-level block)'],
    requiredArguments: ['name', 'resource_group_name', 'location', 'account_tier', 'account_replication_type'],
    notes: 'No top-level encryption {} block in 4.x. Use infrastructure_encryption_enabled (bool) and identity + customer_managed_key if needed. The sku.name from ARM (e.g. "Standard_LRS") must be split: account_tier = "Standard", account_replication_type = "LRS".',
  },

  'microsoft.web/serverfarms': {
    terraformType: 'azurerm_service_plan',
    propertyMap: {
      'sku.name': 'sku_name (e.g. P1v2, B1, S1, F1)',
      'kind': 'os_type (if kind contains "linux" → "Linux", else "Windows")',
      'properties.reserved': 'os_type (if true → "Linux")',
    },
    renamedAttributes: {},
    removedAttributes: ['sku { tier, size, capacity } block (use flat sku_name)'],
    requiredArguments: ['name', 'resource_group_name', 'location', 'os_type', 'sku_name'],
    notes: 'azurerm_app_service_plan is deprecated. Use azurerm_service_plan. The old sku { tier = "Standard", size = "S1" } block is replaced by flat sku_name = "S1". os_type is required: "Linux" or "Windows" (ARM kind="linux" or properties.reserved=true → Linux).',
  },

  'microsoft.web/sites': {
    terraformType: 'azurerm_linux_web_app or azurerm_windows_web_app',
    propertyMap: {
      'properties.siteConfig.linuxFxVersion': 'site_config.application_stack { ... }',
      'properties.siteConfig.appSettings': 'app_settings = { key = value }',
      'properties.httpsOnly': 'https_only',
      'properties.clientAffinityEnabled': 'client_affinity_enabled',
    },
    removedAttributes: ['linux_fx_version (inside site_config — it is computed/read-only in 4.x)'],
    requiredArguments: ['name', 'resource_group_name', 'location', 'service_plan_id', 'site_config {}'],
    notes: 'Choose azurerm_linux_web_app or azurerm_windows_web_app based on ARM kind (contains "linux" → linux). DO NOT set linux_fx_version in site_config — it is computed/read-only in 4.x. Use application_stack {} instead:\n  NODE|22-lts → application_stack { node_version = "22-lts" }\n  PYTHON|3.12 → application_stack { python_version = "3.12" }\n  DOTNETCORE|8.0 → application_stack { dotnet_version = "8.0" }\n  JAVA|17-java17 → application_stack { java_version = "17", java_server = "java" }\n  DOCKER|image:tag → application_stack { docker_image_name = "image:tag", docker_registry_url = "https://index.docker.io" }\nAlso: ftps_state valid values are "AllAllowed", "FtpsOnly", "Disabled" (not "disabled").',
  },

  'microsoft.network/virtualnetworks': {
    terraformType: 'azurerm_virtual_network',
    propertyMap: {
      'properties.addressSpace.addressPrefixes': 'address_space',
    },
    requiredArguments: ['name', 'resource_group_name', 'location', 'address_space'],
    notes: 'address_space is a list of CIDR strings. Subnets should be separate azurerm_subnet resources.',
  },

  'microsoft.network/virtualnetworks/subnets': {
    terraformType: 'azurerm_subnet',
    propertyMap: {
      'properties.addressPrefix': 'address_prefixes = ["..."]',
      'properties.addressPrefixes': 'address_prefixes',
    },
    renamedAttributes: {
      'address_prefix': 'address_prefixes (must be a list, not a string)',
    },
    requiredArguments: ['name', 'resource_group_name', 'virtual_network_name', 'address_prefixes'],
    notes: 'address_prefix (singular string) was removed in 4.x. Always use address_prefixes = ["10.0.0.0/24"] (list).',
  },

  'microsoft.insights/actiongroups': {
    terraformType: 'azurerm_monitor_action_group',
    requiredArguments: ['name', 'resource_group_name', 'short_name'],
    notes: 'Every receiver block (arm_role_receiver, email_receiver, sms_receiver, webhook_receiver, etc.) MUST include a required "name" argument. arm_role_receiver also requires role_id. Parse ARM properties.armRoleReceivers, emailReceivers, smsReceivers, webhookReceivers arrays into their respective blocks.',
  },

  'microsoft.insights/components': {
    terraformType: 'azurerm_application_insights',
    propertyMap: {
      'properties.Application_Type': 'application_type (web, ios, java, etc.)',
      'properties.RetentionInDays': 'retention_in_days',
      'properties.WorkspaceResourceId': 'workspace_id',
    },
    requiredArguments: ['name', 'resource_group_name', 'location', 'application_type'],
  },

  'microsoft.app/containerapps': {
    terraformType: 'azurerm_container_app',
    propertyMap: {
      'properties.managedEnvironmentId':                   'container_app_environment_id (NOT managed_environment_id)',
      'properties.configuration.ingress.external':          'ingress.external_enabled (bool) — NOT "external"',
      'properties.configuration.ingress.targetPort':        'ingress.target_port (number)',
      'properties.configuration.ingress.transport':         'ingress.transport — MUST be lowercase: "auto"|"http"|"http2"|"tcp" (ARM often sends "Auto" — invalid in Terraform)',
      'properties.configuration.ingress.allowInsecure':     'ingress.allow_insecure_connections (bool)',
      'properties.configuration.ingress.traffic[].weight':  'ingress.traffic_weight { percentage, latest_revision }',
      'properties.configuration.registries[].passwordSecretRef': 'registry { password_secret_name = "<same string>" } — NEVER password_secret_ref (invalid)',
      'properties.configuration.secrets':                   'secret {} blocks at TOP-LEVEL (NOT inside template)',
      'properties.configuration.ingress':                   'ingress {} at TOP-LEVEL (NOT inside template)',
      'properties.template.containers[].env[].secretRef':   'env { secret_name = "..." } (NOT secretRef)',
      'properties.template.containers[].probes[]':          'liveness_probe {}, readiness_probe {}, startup_probe {} — NOT probes {}',
      'properties.template.containers[].resources.cpu':     'container.cpu (number)',
      'properties.template.containers[].resources.memory':  'container.memory (string like "0.5Gi")',
      'properties.template.scale.minReplicas':              'template.min_replicas (flat arg — NO scale {} block)',
      'properties.template.scale.maxReplicas':              'template.max_replicas (flat arg — NO scale {} block)',
      'properties.workloadProfileName':                     'workload_profile_name (top-level)',
    },
    renamedAttributes: {
      'managed_environment_id':  'container_app_environment_id',
      'external':                'external_enabled (inside ingress {})',
      'secretRef':               'secret_name (inside env {})',
      'password_secret_ref':     'INVALID — use password_secret_name (ARM passwordSecretRef → Terraform password_secret_name)',
    },
    removedAttributes: [
      'scale {} block — does NOT exist; use min_replicas / max_replicas directly inside template {}',
      'probes {} block — does NOT exist; use liveness_probe {}, readiness_probe {}, startup_probe {}',
      'ingress.custom_domain {} — computed/read-only, provider sets it automatically',
      'ingress.fqdn — computed/read-only',
    ],
    requiredArguments: [
      'name',
      'resource_group_name',
      'container_app_environment_id',
      'revision_mode ("Single" or "Multiple")',
      'template { container { name, image, cpu, memory } }',
      'ingress { target_port, traffic_weight { percentage = 100, latest_revision = true } }',
    ],
    notes: `CRITICAL azurerm_container_app structure:

1. TOP-LEVEL blocks (siblings of template, NOT inside it): ingress {}, secret {}, dapr {}, identity {}, registry {}
   - ingress requires: target_port (integer 1–65535, NEVER 0). If ARM shows targetPort 0, use the container probe port or first container port from the JSON.
   - secret block: name + value (or key_vault_secret_id)
   - registry {} (container image pull auth): server, optional username + password_secret_name (the NAME of a top-level secret block) — NOT password_secret_ref (invalid).

2. template block contains:
   - container {} blocks (required): name, image, cpu (number), memory (string like "0.5Gi")
   - min_replicas, max_replicas (flat arguments, NO scale {} block)
   - NO scale {} block — it does not exist in the provider

3. Inside each container {} block:
   - env { name = "X", value = "Y" }  OR  env { name = "X", secret_name = "my-secret" }
   - secret_name references a top-level secret {} block's name
   - NO secretRef argument — use secret_name instead
   - Probes are separate named blocks: liveness_probe {}, readiness_probe {}, startup_probe {}
   - NO probes {} block — each probe type has its own block
   - EXACT probe attribute names (NO other variants accepted by provider):
       transport          = "HTTP" | "HTTPS" | "TCP"   (required)
       port               = 8080                        (required, number)
       path               = "/health"                   (optional, HTTP/HTTPS only)
       initial_delay      = 1                           (NOT initial_delay_seconds)
       interval_seconds   = 10                          (NOT period_seconds)
       timeout            = 1                           (NOT timeout_seconds)
       failure_count_threshold = 3                      (NOT failure_threshold)
       success_count_threshold = 3                      (readiness_probe ONLY — liveness_probe and startup_probe MUST NOT include this argument)
   - WRONG names that must NEVER be used: timeout_seconds, failure_threshold, success_threshold,
     initial_delay_seconds, period_seconds, failure_count, success_count

4. env variable referencing a secret: env { name = "DB_URL", secret_name = "database-url" }
   The secret value must also be declared in a top-level: secret { name = "database-url", value = "..." }

5. COMPUTED (read-only) attributes — DO NOT include in HCL config:
   - ingress.custom_domain — this is exported/computed, not configurable
   - ingress.fqdn — computed, do not set
   - latest_revision_fqdn — computed
   - latest_revision_name — computed
   - outbound_ip_addresses — computed
   Remove any custom_domain {} block from inside ingress {}.`,
  },

  'microsoft.app/managedenvironments': {
    terraformType: 'azurerm_container_app_environment',
    propertyMap: {
      'properties.appLogsConfiguration.logAnalyticsConfiguration.customerId': 'log_analytics_workspace_id (resolve full resource ID from workspace customer ID)',
    },
    requiredArguments: ['name', 'resource_group_name', 'location'],
  },

  'microsoft.containerregistry/registries': {
    terraformType: 'azurerm_container_registry',
    propertyMap: {
      'sku.name': 'sku (Basic, Standard, Premium)',
      'properties.adminUserEnabled': 'admin_enabled',
      'properties.publicNetworkAccess': 'public_network_access_enabled',
    },
    requiredArguments: ['name', 'resource_group_name', 'location', 'sku'],
  },

  'microsoft.operationalinsights/workspaces': {
    terraformType: 'azurerm_log_analytics_workspace',
    propertyMap: {
      'properties.sku.name': 'sku (PerGB2018, Free, etc.)',
      'properties.retentionInDays': 'retention_in_days',
    },
    requiredArguments: ['name', 'resource_group_name', 'location'],
  },

  'microsoft.network/dnszones': {
    terraformType: 'azurerm_dns_zone',
    requiredArguments: ['name', 'resource_group_name'],
  },

  'microsoft.keyvault/vaults': {
    terraformType: 'azurerm_key_vault',
    propertyMap: {
      'properties.tenantId': 'tenant_id',
      'properties.sku.name': 'sku_name (standard or premium)',
      'properties.enableSoftDelete': 'soft_delete_retention_days (if enabled, set days; soft delete is always on in 4.x)',
      'properties.enablePurgeProtection': 'purge_protection_enabled',
    },
    removedAttributes: ['soft_delete_enabled (always true in 4.x — only set soft_delete_retention_days)'],
    requiredArguments: ['name', 'resource_group_name', 'location', 'sku_name', 'tenant_id'],
  },

  'microsoft.dbforpostgresql/flexibleservers': {
    terraformType: 'azurerm_postgresql_flexible_server',
    propertyMap: {
      'sku.name': 'sku_name',
      'sku.tier': 'part of sku_name (e.g. B_Standard_B1ms)',
      'properties.version': 'version',
      'properties.storage.storageSizeGb': 'storage_mb (multiply by 1024)',
    },
    requiredArguments: ['name', 'resource_group_name', 'location'],
  },

  'microsoft.sql/servers': {
    terraformType: 'azurerm_mssql_server',
    propertyMap: {
      'properties.administratorLogin': 'administrator_login',
      'properties.version': 'version',
      'properties.minimalTlsVersion': 'minimum_tls_version',
    },
    requiredArguments: ['name', 'resource_group_name', 'location', 'version'],
  },

  'microsoft.network/networksecuritygroups': {
    terraformType: 'azurerm_network_security_group',
    requiredArguments: ['name', 'resource_group_name', 'location'],
    notes: 'Security rules from ARM properties.securityRules should become security_rule blocks. Each requires name, priority, direction, access, protocol, source/destination port/address ranges.',
  },

  'microsoft.network/publicipaddresses': {
    terraformType: 'azurerm_public_ip',
    propertyMap: {
      'sku.name': 'sku (Basic or Standard)',
      'properties.publicIPAllocationMethod': 'allocation_method (Static or Dynamic)',
    },
    requiredArguments: ['name', 'resource_group_name', 'location', 'allocation_method'],
  },

  'microsoft.network/loadbalancers': {
    terraformType: 'azurerm_lb',
    propertyMap: {
      'sku.name': 'sku (Basic or Standard)',
    },
    requiredArguments: ['name', 'resource_group_name', 'location'],
  },

  'microsoft.cosmosdb/databaseaccounts': {
    terraformType: 'azurerm_cosmosdb_account',
    propertyMap: {
      'properties.databaseAccountOfferType': 'offer_type (always "Standard")',
      'properties.consistencyPolicy': 'consistency_policy {} block',
      'kind': 'kind (GlobalDocumentDB, MongoDB, etc.)',
    },
    requiredArguments: ['name', 'resource_group_name', 'location', 'offer_type', 'consistency_policy {}', 'geo_location {}'],
  },

  'microsoft.cache/redis': {
    terraformType: 'azurerm_redis_cache',
    propertyMap: {
      'properties.sku.name': 'sku_name (Basic, Standard, Premium)',
      'properties.sku.family': 'family (C or P)',
      'properties.sku.capacity': 'capacity',
    },
    requiredArguments: ['name', 'resource_group_name', 'location', 'capacity', 'family', 'sku_name'],
  },
};

/**
 * Look up schema guidance for an Azure ARM resource type.
 * Uses partial matching (lowercase) so "Microsoft.Storage/storageAccounts" matches.
 */
export function getSchemaGuidanceForType(armType: string): SchemaGuidance | null {
  const lower = armType.toLowerCase();
  for (const [key, guidance] of Object.entries(SCHEMA_GUIDANCE)) {
    if (lower.includes(key)) return guidance;
  }
  return null;
}

/**
 * Build a compact per-resource migration guidance string for the AI prompt.
 * Only includes guidance for resource types actually present in the scan.
 */
export function buildSchemaGuidanceForResources(resources: Array<{ type?: string }>): string {
  const tagsPreamble = `
TAGS (required for generated Terraform):
- Do NOT copy tags from live Azure JSON.
- For every azurerm resource that supports tags, emit:
  tags = {
    ManagedBy       = "MigrateOps"
    MigrateOpsImport = "true"
  }
- Keep tag keys exactly as shown above so filtering is consistent across runs.

`;
  const seenTypes = new Set<string>();
  const sections: string[] = [];

  for (const r of resources) {
    const armType = String(r.type || '').toLowerCase();
    if (!armType || seenTypes.has(armType)) continue;
    seenTypes.add(armType);

    const g = getSchemaGuidanceForType(armType);
    if (!g) continue;

    const lines: string[] = [];
    lines.push(`### ${r.type} → \`${g.terraformType}\``);

    if (g.requiredArguments?.length) {
      lines.push(`Required: ${g.requiredArguments.join(', ')}`);
    }

    if (g.propertyMap && Object.keys(g.propertyMap).length > 0) {
      lines.push('ARM → Terraform mapping:');
      for (const [arm, tf] of Object.entries(g.propertyMap)) {
        lines.push(`  ${arm} → ${tf}`);
      }
    }

    if (g.renamedAttributes && Object.keys(g.renamedAttributes).length > 0) {
      lines.push('Renamed in 4.x (DO NOT use old name):');
      for (const [old, newName] of Object.entries(g.renamedAttributes)) {
        lines.push(`  ✗ ${old} → ✓ ${newName}`);
      }
    }

    if (g.removedAttributes?.length) {
      lines.push(`Removed in 4.x: ${g.removedAttributes.join(', ')}`);
    }

    if (g.notes) {
      lines.push(`Migration note: ${g.notes}`);
    }

    sections.push(lines.join('\n'));
  }

  const body =
    sections.length > 0
      ? `\nPER-RESOURCE AZURERM 4.x MIGRATION GUIDANCE (for the resource types found in this scan):\n\n${sections.join('\n\n')}\n`
      : '';

  if (!tagsPreamble && !body) return '';
  return `${tagsPreamble}${body}`;
}
