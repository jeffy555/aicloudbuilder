/**
 * Terraform Policy Validation Engine
 *
 * Scans parsed Terraform resources against configurable governance rules.
 * Returns structured violations with severity levels so callers can surface
 * issues in the UI without hard-coding policy logic in routes.
 *
 * Rule categories:
 *   security    — misconfigurations that create attack surface
 *   cost        — spending patterns that increase bills unnecessarily
 *   naming      — naming convention violations
 *   tagging     — missing required resource tags
 *   reliability — single points of failure / missing HA config
 *   compliance  — regional or encryption requirements
 *
 * Last validated: 2026-03-05
 */

import type { TerraformResource } from './diagram/resource-relationship-parser.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface PolicyViolation {
  ruleId: string;
  ruleName: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: 'security' | 'cost' | 'naming' | 'tagging' | 'reliability' | 'compliance';
  resourceType: string;
  resourceName: string;
  file: string;
  message: string;
  suggestion: string;
}

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  severity: PolicyViolation['severity'];
  category: PolicyViolation['category'];
  check: (resource: TerraformResource, allResources: TerraformResource[], options: PolicyOptions) => PolicyViolation | null;
}

export interface PolicyOptions {
  /** Subset of rule IDs to enable. If empty, all rules run. */
  enabledRules?: string[];
  /** Tags every resource must have (for TF-TAG-* rules). */
  requiredTags?: string[];
  /** Approved Azure regions (for TF-COM-001). */
  approvedRegions?: string[];
}

export interface PolicyResult {
  violations: PolicyViolation[];
  passed: Array<{ ruleId: string; resourceType: string; resourceName: string }>;
  summary: {
    total: number;
    violations: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    passed: number;
  };
}

// ─── Helper builders ──────────────────────────────────────────────────────────

function violation(
  rule: PolicyRule,
  resource: TerraformResource,
  message: string,
  suggestion: string
): PolicyViolation {
  return {
    ruleId:       rule.id,
    ruleName:     rule.name,
    severity:     rule.severity,
    category:     rule.category,
    resourceType: resource.type,
    resourceName: resource.name,
    file:         resource.file,
    message,
    suggestion,
  };
}

function isFalsy(value: any): boolean {
  return value === false || value === 'false' || value === '0' || value === undefined || value === null;
}

function isTruthy(value: any): boolean {
  return value === true || value === 'true' || value === '1';
}

// ─── Default required tags ─────────────────────────────────────────────────────

const DEFAULT_REQUIRED_TAGS = ['environment', 'owner'];

// ─── Policy Rules ──────────────────────────────────────────────────────────────

export const POLICY_RULES: PolicyRule[] = [

  // ── Security ──────────────────────────────────────────────────────────────────

  {
    id: 'TF-SEC-001',
    name: 'Storage Account Public Blob Access',
    description: 'Storage accounts should not allow public blob access',
    severity: 'high',
    category: 'security',
    check: (resource) => {
      if (resource.type !== 'azurerm_storage_account') return null;
      const publicAccess = resource.attributes.allow_blob_public_access;
      if (isTruthy(publicAccess)) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-SEC-001')!,
          resource,
          `Storage account "${resource.name}" has public blob access enabled`,
          'Set allow_blob_public_access = false'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-SEC-002',
    name: 'SQL Server No Firewall Rules',
    description: 'SQL Server should have at least one firewall rule to restrict access',
    severity: 'high',
    category: 'security',
    check: (resource, allResources) => {
      if (resource.type !== 'azurerm_mssql_server') return null;
      const hasFwRule = allResources.some(r =>
        r.type === 'azurerm_mssql_firewall_rule' &&
        (r.attributes.server_name === resource.name ||
         r.attributes.server_id?.includes(resource.name))
      );
      if (!hasFwRule) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-SEC-002')!,
          resource,
          `SQL Server "${resource.name}" has no firewall rules — may accept connections from all IPs`,
          'Add azurerm_mssql_firewall_rule to restrict access to known IP ranges'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-SEC-003',
    name: 'Key Vault Soft Delete Disabled',
    description: 'Key Vault soft delete protects secrets from accidental or malicious deletion',
    severity: 'high',
    category: 'security',
    check: (resource) => {
      if (resource.type !== 'azurerm_key_vault') return null;
      const softDelete = resource.attributes.soft_delete_enabled;
      const retentionDays = resource.attributes.soft_delete_retention_days;
      if (isFalsy(softDelete) || (retentionDays !== undefined && parseInt(retentionDays, 10) < 7)) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-SEC-003')!,
          resource,
          `Key Vault "${resource.name}" has soft delete disabled or retention < 7 days`,
          'Set soft_delete_enabled = true and soft_delete_retention_days >= 7'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-SEC-004',
    name: 'Storage Account HTTPS Not Enforced',
    description: 'Storage accounts should enforce HTTPS-only traffic',
    severity: 'medium',
    category: 'security',
    check: (resource) => {
      if (resource.type !== 'azurerm_storage_account') return null;
      const httpsOnly = resource.attributes.enable_https_traffic_only;
      if (httpsOnly !== undefined && isFalsy(httpsOnly)) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-SEC-004')!,
          resource,
          `Storage account "${resource.name}" does not enforce HTTPS-only traffic`,
          'Set enable_https_traffic_only = true'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-SEC-005',
    name: 'VM Without Managed Identity',
    description: 'Virtual Machines should use managed identity instead of embedded credentials',
    severity: 'low',
    category: 'security',
    check: (resource) => {
      if (!resource.type.includes('virtual_machine')) return null;
      if (resource.type.includes('scale_set')) return null;
      const hasIdentity = resource.attributes.identity !== undefined;
      if (!hasIdentity) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-SEC-005')!,
          resource,
          `VM "${resource.name}" has no managed identity block configured`,
          'Add an identity { type = "SystemAssigned" } block to avoid using embedded credentials'
        );
      }
      return null;
    },
  },

  // ── Cost ──────────────────────────────────────────────────────────────────────

  {
    id: 'TF-COST-001',
    name: 'Premium Resource Without Justification Tag',
    description: 'Premium-tier resources should carry a justification tag to prevent unplanned spending',
    severity: 'medium',
    category: 'cost',
    check: (resource) => {
      const isPremium =
        resource.attributes.account_tier === 'Premium' ||
        resource.attributes.sku_name?.startsWith('P') ||
        resource.attributes.sku?.startsWith('Premium') ||
        (typeof resource.currentSku === 'string' && resource.currentSku?.startsWith('P'));
      if (!isPremium) return null;
      const hasCostJustification =
        resource.attributes.tags?.cost_justification ||
        resource.attributes.tags?.size_justification;
      if (!hasCostJustification) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-COST-001')!,
          resource,
          `Resource "${resource.name}" uses a Premium SKU without a cost_justification or size_justification tag`,
          'Add tags = { cost_justification = "Reason for premium tier" } or downgrade to Standard'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-COST-002',
    name: 'Geo-Redundant Storage in Dev Environment',
    description: 'GRS/RA-GRS storage in dev environments costs 2× more than LRS with minimal benefit',
    severity: 'medium',
    category: 'cost',
    check: (resource) => {
      if (resource.type !== 'azurerm_storage_account') return null;
      const replication = resource.attributes.account_replication_type || '';
      const isGrs = replication.includes('GRS') || replication.includes('GZRS');
      if (!isGrs) return null;
      const env = resource.attributes.tags?.environment || '';
      if (['dev', 'test', 'staging', 'development'].includes(env.toLowerCase())) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-COST-002')!,
          resource,
          `Storage account "${resource.name}" uses ${replication} replication in a dev/test environment`,
          'Change account_replication_type to LRS for non-production workloads to save ~50%'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-COST-003',
    name: 'Large VM Without Size Justification',
    description: 'VMs larger than Standard_D8s should have a size justification tag',
    severity: 'low',
    category: 'cost',
    check: (resource) => {
      if (!resource.type.includes('virtual_machine')) return null;
      const size = resource.attributes.size || resource.attributes.vm_size || '';
      if (!/D(16|32|48|64)/.test(size)) return null;
      const hasTag = resource.attributes.tags?.size_justification;
      if (!hasTag) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-COST-003')!,
          resource,
          `VM "${resource.name}" uses a large size (${size}) without a size_justification tag`,
          'Add tags = { size_justification = "Reason for large VM" } or downsize if workload allows'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-COST-004',
    name: 'Resource Missing Environment Tag',
    description: 'Resources without an environment tag make cost allocation impossible',
    severity: 'medium',
    category: 'cost',
    check: (resource) => {
      // Only check billed resources (skip free infrastructure helpers)
      const skipTypes = [
        'azurerm_resource_group', 'azurerm_subnet',
        'azurerm_network_security_rule', 'azurerm_route',
      ];
      if (skipTypes.includes(resource.type)) return null;
      const env = resource.attributes.tags?.environment;
      if (!env) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-COST-004')!,
          resource,
          `Resource "${resource.name}" is missing the "environment" tag required for cost allocation`,
          'Add tags = { environment = "dev|test|prod" }'
        );
      }
      return null;
    },
  },

  // ── Naming ────────────────────────────────────────────────────────────────────

  {
    id: 'TF-NAME-001',
    name: 'Resource Group Missing -rg Suffix',
    description: 'Resource group names should end with -rg for easy identification',
    severity: 'info',
    category: 'naming',
    check: (resource) => {
      if (resource.type !== 'azurerm_resource_group') return null;
      const nameAttr = resource.attributes.name || '';
      if (nameAttr && !nameAttr.toLowerCase().endsWith('-rg') && !nameAttr.includes('rg')) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-NAME-001')!,
          resource,
          `Resource group "${resource.name}" attribute name "${nameAttr}" does not end with '-rg'`,
          `Rename to "${nameAttr}-rg" to follow the {prefix}-rg naming convention`
        );
      }
      return null;
    },
  },

  {
    id: 'TF-NAME-002',
    name: 'Storage Account Name Contains Uppercase',
    description: 'Azure storage account names must be lowercase alphanumeric only (3–24 chars)',
    severity: 'high',
    category: 'naming',
    check: (resource) => {
      if (resource.type !== 'azurerm_storage_account') return null;
      const nameAttr = resource.attributes.name || '';
      // Skip var references
      if (nameAttr.startsWith('var.') || nameAttr.startsWith('${')) return null;
      if (nameAttr && /[A-Z_-]/.test(nameAttr)) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-NAME-002')!,
          resource,
          `Storage account "${resource.name}" has an invalid name "${nameAttr}" containing uppercase or special characters`,
          'Storage account names must be 3–24 lowercase alphanumeric characters only'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-NAME-003',
    name: 'Terraform Resource Name Too Short',
    description: 'Terraform resource names shorter than 5 characters are not descriptive',
    severity: 'info',
    category: 'naming',
    check: (resource) => {
      if (resource.name.length < 5 && !resource.attributes.isModule) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-NAME-003')!,
          resource,
          `Terraform resource name "${resource.name}" is too short (< 5 chars) — not descriptive`,
          'Use a meaningful name like "main_storage_account" instead of "sa1"'
        );
      }
      return null;
    },
  },

  // ── Tagging ───────────────────────────────────────────────────────────────────

  {
    id: 'TF-TAG-001',
    name: 'Missing Required Tag: owner',
    description: 'All resources must have an "owner" tag for accountability',
    severity: 'medium',
    category: 'tagging',
    check: (resource, _all, options) => {
      const required = options.requiredTags ?? DEFAULT_REQUIRED_TAGS;
      if (!required.includes('owner')) return null;
      if (!resource.attributes.tags?.owner) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-TAG-001')!,
          resource,
          `Resource "${resource.name}" is missing the required "owner" tag`,
          'Add tags = { owner = "team-or-person@company.com" }'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-TAG-002',
    name: 'Missing Required Tag: environment',
    description: 'All resources must have an "environment" tag',
    severity: 'medium',
    category: 'tagging',
    check: (resource, _all, options) => {
      const required = options.requiredTags ?? DEFAULT_REQUIRED_TAGS;
      if (!required.includes('environment')) return null;
      if (!resource.attributes.tags?.environment) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-TAG-002')!,
          resource,
          `Resource "${resource.name}" is missing the required "environment" tag`,
          'Add tags = { environment = "dev|test|prod" }'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-TAG-003',
    name: 'Missing Required Tag: cost_center',
    description: 'Billed resources should carry a cost_center tag for FinOps chargebacks',
    severity: 'low',
    category: 'tagging',
    check: (resource, _all, options) => {
      const required = options.requiredTags ?? [];
      if (!required.includes('cost_center')) return null;
      if (!resource.attributes.tags?.cost_center) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-TAG-003')!,
          resource,
          `Resource "${resource.name}" is missing the required "cost_center" tag`,
          'Add tags = { cost_center = "DEPT-XXX" }'
        );
      }
      return null;
    },
  },

  // ── Reliability ───────────────────────────────────────────────────────────────

  {
    id: 'TF-REL-001',
    name: 'App Service Plan Single Instance',
    description: 'App Service Plans with only 1 instance have no redundancy — a crash = downtime',
    severity: 'medium',
    category: 'reliability',
    check: (resource) => {
      if (resource.type !== 'azurerm_service_plan' && resource.type !== 'azurerm_app_service_plan') return null;
      const capacity = parseInt(resource.attributes.capacity || '0', 10);
      if (capacity > 0 && capacity < 2) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-REL-001')!,
          resource,
          `App Service Plan "${resource.name}" has capacity = ${capacity} (single instance, no HA)`,
          'Set capacity >= 2 for production workloads to enable high availability'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-REL-002',
    name: 'Azure SQL Without Backup Retention',
    description: 'SQL databases should have explicit short-term backup retention configured',
    severity: 'low',
    category: 'reliability',
    check: (resource) => {
      if (resource.type !== 'azurerm_mssql_database') return null;
      const hasBackup = resource.attributes.short_term_retention_policy !== undefined;
      if (!hasBackup) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-REL-002')!,
          resource,
          `SQL Database "${resource.name}" has no explicit short_term_retention_policy configured`,
          'Add short_term_retention_policy { retention_days = 7 } to define backup retention explicitly'
        );
      }
      return null;
    },
  },

  {
    id: 'TF-REL-003',
    name: 'Storage Account Without Versioning or Soft Delete',
    description: 'Storage accounts should have blob versioning or soft delete to prevent data loss',
    severity: 'low',
    category: 'reliability',
    check: (resource) => {
      if (resource.type !== 'azurerm_storage_account') return null;
      const hasBlobProps = resource.attributes.blob_properties !== undefined;
      if (!hasBlobProps) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-REL-003')!,
          resource,
          `Storage account "${resource.name}" has no blob_properties block — versioning and soft delete are unconfigured`,
          'Add blob_properties { versioning_enabled = true delete_retention_policy { days = 7 } }'
        );
      }
      return null;
    },
  },

  // ── Compliance ────────────────────────────────────────────────────────────────

  {
    id: 'TF-COM-001',
    name: 'Resource Deployed in Non-Approved Region',
    description: 'Resources should be deployed only in approved Azure regions',
    severity: 'medium',
    category: 'compliance',
    check: (resource, _all, options) => {
      const approved = options.approvedRegions;
      if (!approved || approved.length === 0) return null; // rule disabled if no approved list

      const location = (resource.attributes.location || '').toLowerCase().replace(/\s+/g, '');
      const isApproved = approved.some(r => r.toLowerCase().replace(/\s+/g, '') === location);
      if (location && !location.startsWith('var.') && !isApproved) {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-COM-001')!,
          resource,
          `Resource "${resource.name}" is deployed in "${location}" which is not in the approved region list`,
          `Move to an approved region: ${approved.join(', ')}`
        );
      }
      return null;
    },
  },

  {
    id: 'TF-COM-002',
    name: 'Storage Account Without Minimum TLS Version',
    description: 'Storage accounts should enforce a minimum TLS version for compliance',
    severity: 'medium',
    category: 'compliance',
    check: (resource) => {
      if (resource.type !== 'azurerm_storage_account') return null;
      const tlsVersion = resource.attributes.min_tls_version;
      if (tlsVersion && tlsVersion < 'TLS1_2') {
        return violation(
          POLICY_RULES.find(r => r.id === 'TF-COM-002')!,
          resource,
          `Storage account "${resource.name}" minimum TLS version is "${tlsVersion}" — below TLS 1.2`,
          'Set min_tls_version = "TLS1_2" to meet compliance requirements'
        );
      }
      return null;
    },
  },
];

// ─── Policy Engine Entry Point ─────────────────────────────────────────────────

/**
 * Run all enabled policy rules against an array of parsed Terraform resources.
 * Returns structured violations plus a pass/fail summary.
 */
export function runPolicyChecks(
  resources: TerraformResource[],
  options: PolicyOptions = {}
): PolicyResult {
  const enabledIds = options.enabledRules && options.enabledRules.length > 0
    ? new Set(options.enabledRules)
    : null; // null = all rules enabled

  const violations: PolicyViolation[] = [];
  const passed: PolicyResult['passed'] = [];

  for (const resource of resources) {
    for (const rule of POLICY_RULES) {
      if (enabledIds && !enabledIds.has(rule.id)) continue;

      try {
        const result = rule.check(resource, resources, options);
        if (result) {
          violations.push(result);
        } else {
          passed.push({
            ruleId:       rule.id,
            resourceType: resource.type,
            resourceName: resource.name,
          });
        }
      } catch (err) {
        // Rule should never crash the engine — log and skip
        console.warn(`[policy-engine] Rule ${rule.id} threw for ${resource.type}.${resource.name}:`, err);
      }
    }
  }

  const summary = {
    total:      violations.length + passed.length,
    violations: violations.length,
    critical:   violations.filter(v => v.severity === 'critical').length,
    high:       violations.filter(v => v.severity === 'high').length,
    medium:     violations.filter(v => v.severity === 'medium').length,
    low:        violations.filter(v => v.severity === 'low').length,
    info:       violations.filter(v => v.severity === 'info').length,
    passed:     passed.length,
  };

  return { violations, passed, summary };
}
