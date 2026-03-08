/**
 * Known Terraform Registry Module Catalog
 *
 * Pre-cached resource type mappings for the most popular public Terraform modules.
 * This avoids live HTTP calls to registry.terraform.io for well-known modules,
 * keeping diagram generation fast and offline-capable.
 *
 * Lookup order in resource-relationship-parser.ts:
 *   1. Catalog hit (this file) — instant, no network
 *   2. Registry API call       — live lookup, cached for session
 *   3. Keyword inference       — heuristic fallback
 *
 * Format: "namespace/module-name/provider" → primary resource type
 *
 * Source: registry.terraform.io download counts
 * Last validated: 2026-03-05
 */

// ─── Catalog ──────────────────────────────────────────────────────────────────

export const KNOWN_REGISTRY_MODULES: Record<string, string> = {

  // ── Azure (azurerm) ───────────────────────────────────────────────────────────
  'Azure/network/azurerm':                 'azurerm_virtual_network',
  'Azure/compute/azurerm':                 'azurerm_linux_virtual_machine',
  'Azure/aks/azurerm':                     'azurerm_kubernetes_cluster',
  'Azure/storage/azurerm':                 'azurerm_storage_account',
  'Azure/key-vault/azurerm':               'azurerm_key_vault',
  'Azure/postgresql/azurerm':              'azurerm_postgresql_flexible_server',
  'Azure/mysql/azurerm':                   'azurerm_mysql_flexible_server',
  'Azure/sql-database/azurerm':            'azurerm_mssql_database',
  'Azure/app-service/azurerm':             'azurerm_linux_web_app',
  'Azure/container-registry/azurerm':      'azurerm_container_registry',
  'Azure/redis/azurerm':                   'azurerm_redis_cache',
  'Azure/cosmosdb/azurerm':                'azurerm_cosmosdb_account',
  'Azure/vnet/azurerm':                    'azurerm_virtual_network',
  'Azure/firewall/azurerm':                'azurerm_firewall',
  'Azure/kubernetes/azurerm':              'azurerm_kubernetes_cluster',
  'Azure/naming/azurerm':                  'azurerm_resource_group',      // naming utility
  'Azure/log-analytics/azurerm':           'azurerm_log_analytics_workspace',

  // ── AWS (terraform-aws-modules) ───────────────────────────────────────────────
  'terraform-aws-modules/vpc/aws':         'aws_vpc',
  'terraform-aws-modules/eks/aws':         'aws_eks_cluster',
  'terraform-aws-modules/rds/aws':         'aws_db_instance',
  'terraform-aws-modules/s3-bucket/aws':   'aws_s3_bucket',
  'terraform-aws-modules/alb/aws':         'aws_lb',
  'terraform-aws-modules/nlb/aws':         'aws_lb',
  'terraform-aws-modules/lambda/aws':      'aws_lambda_function',
  'terraform-aws-modules/iam/aws':         'aws_iam_role',
  'terraform-aws-modules/security-group/aws': 'aws_security_group',
  'terraform-aws-modules/ec2-instance/aws':'aws_instance',
  'terraform-aws-modules/autoscaling/aws': 'aws_autoscaling_group',
  'terraform-aws-modules/elasticache/aws': 'aws_elasticache_cluster',
  'terraform-aws-modules/sns/aws':         'aws_sns_topic',
  'terraform-aws-modules/sqs/aws':         'aws_sqs_queue',
  'terraform-aws-modules/cloudwatch/aws':  'aws_cloudwatch_log_group',
  'terraform-aws-modules/kms/aws':         'aws_kms_key',
  'terraform-aws-modules/acm/aws':         'aws_acm_certificate',
  'terraform-aws-modules/transit-gateway/aws': 'aws_ec2_transit_gateway',
  'terraform-aws-modules/route53/aws':     'aws_route53_zone',
  'terraform-aws-modules/waf/aws':         'aws_wafv2_web_acl',

  // ── GCP (GoogleCloudPlatform) ─────────────────────────────────────────────────
  'GoogleCloudPlatform/kubernetes-engine/google': 'google_container_cluster',
  'GoogleCloudPlatform/sql-db/google':            'google_sql_database_instance',
  'GoogleCloudPlatform/network/google':           'google_compute_network',
  'GoogleCloudPlatform/lb-http/google':           'google_compute_global_forwarding_rule',
  'GoogleCloudPlatform/cloud-nat/google':         'google_compute_router_nat',
  'GoogleCloudPlatform/cloud-storage-static-website/google': 'google_storage_bucket',
  'GoogleCloudPlatform/iam/google':               'google_project_iam_binding',
  'GoogleCloudPlatform/cloud-run/google':         'google_cloud_run_service',
  'GoogleCloudPlatform/memorystore/google':       'google_redis_instance',
  'GoogleCloudPlatform/pubsub/google':            'google_pubsub_topic',
  'GoogleCloudPlatform/bigquery/google':          'google_bigquery_dataset',

  // ── HashiCorp utility modules ─────────────────────────────────────────────────
  'hashicorp/consul/aws':                  'aws_instance',
  'hashicorp/vault/aws':                   'aws_instance',
  'hashicorp/nomad/aws':                   'aws_instance',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Look up the primary resource type for a known registry module.
 * Returns null when the module is not in the catalog.
 *
 * @param source - Raw Terraform source string, e.g. "Azure/network/azurerm"
 *                 or "Azure/network/azurerm//modules/subnet"
 */
export function lookupRegistryModule(source: string): string | null {
  // Strip submodule path suffix: "Azure/network/azurerm//modules/subnet" → "Azure/network/azurerm"
  const normalized = source.split('//')[0].trim();
  return KNOWN_REGISTRY_MODULES[normalized] ?? null;
}

/**
 * Parse a registry source string into its component parts.
 * Returns null if the source is not a registry address (e.g., local path or git URL).
 */
export function parseRegistrySource(source: string): {
  namespace: string;
  name: string;
  provider: string;
  submodule?: string;
} | null {
  // Registry format: namespace/name/provider or namespace/name/provider//submodule
  const [base, submodule] = source.split('//');
  const parts = base.split('/');
  if (parts.length < 3) return null;
  // Exclude local paths (./...) and git sources (git::, github.com, etc.)
  if (base.startsWith('.') || base.startsWith('git::') || base.includes('github.com') || base.includes('gitlab.com')) return null;

  return {
    namespace: parts[0],
    name:      parts[1],
    provider:  parts[2],
    submodule: submodule || undefined,
  };
}
