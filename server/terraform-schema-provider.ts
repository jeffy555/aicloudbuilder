/**
 * terraform-schema-provider.ts
 *
 * Extracts the REAL azurerm provider schema from the terraform binary at runtime
 * using `terraform providers schema -json`. This gives the AI ground-truth attribute
 * names, types, required/optional, and nested block structure — eliminating the need
 * for hardcoded prompt rules that go stale.
 *
 * Flow:
 *   1. On first call, init a temp dir with just the azurerm provider → terraform init → terraform providers schema -json
 *   2. Cache the parsed schema in memory (lives for the process lifetime)
 *   3. getResourceSchema("azurerm_container_app") → compact schema string suitable for an AI prompt
 *   4. getSchemaForResources(["azurerm_container_app", "azurerm_linux_web_app"]) → combined prompt section
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ──────────────────────────────────────────────────────────────
// ARM → azurerm resource type mapping
// This is a LOOKUP TABLE (two naming conventions), not behavioural rules.
// When a new resource type is added to azurerm, add one line here.
// ──────────────────────────────────────────────────────────────
export const ARM_TO_AZURERM: Record<string, string | ((resource: any) => string)> = {
  'microsoft.resources/resourcegroups': 'azurerm_resource_group',
  'microsoft.network/virtualnetworks': 'azurerm_virtual_network',
  'microsoft.network/virtualnetworks/subnets': 'azurerm_subnet',
  'microsoft.network/networksecuritygroups': 'azurerm_network_security_group',
  'microsoft.network/publicipaddresses': 'azurerm_public_ip',
  'microsoft.network/loadbalancers': 'azurerm_lb',
  'microsoft.network/applicationgateways': 'azurerm_application_gateway',
  'microsoft.network/networkinterfaces': 'azurerm_network_interface',
  'microsoft.network/privatednszones': 'azurerm_private_dns_zone',
  'microsoft.network/privateendpoints': 'azurerm_private_endpoint',
  'microsoft.network/frontdoors': 'azurerm_frontdoor',
  'microsoft.network/dnszones': 'azurerm_dns_zone',
  'microsoft.network/routetables': 'azurerm_route_table',
  'microsoft.network/natgateways': 'azurerm_nat_gateway',
  'microsoft.network/firewallpolicies': 'azurerm_firewall_policy',
  'microsoft.network/azurefirewalls': 'azurerm_firewall',
  'microsoft.network/trafficmanagerprofiles': 'azurerm_traffic_manager_profile',

  'microsoft.compute/virtualmachines': 'azurerm_linux_virtual_machine', // default; can override via os detection
  'microsoft.compute/virtualmachinescalesets': 'azurerm_linux_virtual_machine_scale_set',
  'microsoft.compute/disks': 'azurerm_managed_disk',
  'microsoft.compute/availabilitysets': 'azurerm_availability_set',
  'microsoft.compute/images': 'azurerm_image',

  'microsoft.storage/storageaccounts': 'azurerm_storage_account',
  'microsoft.storage/storageaccounts/blobservices/containers': 'azurerm_storage_container',

  'microsoft.web/sites': (r: any) => {
    const kind = (r.kind || r.properties?.kind || '').toLowerCase();
    if (kind.includes('functionapp')) return kind.includes('linux') ? 'azurerm_linux_function_app' : 'azurerm_windows_function_app';
    return kind.includes('linux') || kind.includes('container') ? 'azurerm_linux_web_app' : 'azurerm_windows_web_app';
  },
  'microsoft.web/serverfarms': 'azurerm_service_plan',
  'microsoft.web/staticSites': 'azurerm_static_web_app',
  'microsoft.web/certificates': 'azurerm_app_service_certificate',

  'microsoft.app/managedenvironments': 'azurerm_container_app_environment',
  'microsoft.app/containerapps': 'azurerm_container_app',
  'microsoft.app/managedenvironments/managedcertificates': 'azurerm_container_app_environment_managed_certificate',

  'microsoft.containerregistry/registries': 'azurerm_container_registry',
  'microsoft.containerservice/managedclusters': 'azurerm_kubernetes_cluster',

  'microsoft.sql/servers': 'azurerm_mssql_server',
  'microsoft.sql/servers/databases': 'azurerm_mssql_database',
  'microsoft.sql/servers/elasticpools': 'azurerm_mssql_elasticpool',
  'microsoft.sql/servers/firewallrules': 'azurerm_mssql_firewall_rule',
  'microsoft.dbformysql/flexibleservers': 'azurerm_mysql_flexible_server',
  'microsoft.dbforpostgresql/flexibleservers': 'azurerm_postgresql_flexible_server',
  'microsoft.dbforpostgresql/servers': 'azurerm_postgresql_server',
  'microsoft.documentdb/databaseaccounts': 'azurerm_cosmosdb_account',
  'microsoft.cache/redis': 'azurerm_redis_cache',

  'microsoft.keyvault/vaults': 'azurerm_key_vault',
  'microsoft.keyvault/vaults/secrets': 'azurerm_key_vault_secret',

  'microsoft.insights/components': 'azurerm_application_insights',
  'microsoft.insights/actiongroups': 'azurerm_monitor_action_group',
  'microsoft.insights/metricalerts': 'azurerm_monitor_metric_alert',
  'microsoft.insights/diagnosticsettings': 'azurerm_monitor_diagnostic_setting',
  'microsoft.operationalinsights/workspaces': 'azurerm_log_analytics_workspace',

  'microsoft.authorization/roleassignments': 'azurerm_role_assignment',
  'microsoft.managedidentity/userassignedidentities': 'azurerm_user_assigned_identity',

  'microsoft.servicebus/namespaces': 'azurerm_servicebus_namespace',
  'microsoft.servicebus/namespaces/queues': 'azurerm_servicebus_queue',
  'microsoft.servicebus/namespaces/topics': 'azurerm_servicebus_topic',
  'microsoft.eventhub/namespaces': 'azurerm_eventhub_namespace',

  'microsoft.cdn/profiles': 'azurerm_cdn_profile',
  'microsoft.cdn/profiles/endpoints': 'azurerm_cdn_endpoint',

  'microsoft.signalrservice/signalr': 'azurerm_signalr_service',
  'microsoft.cognitiveservices/accounts': 'azurerm_cognitive_account',
  'microsoft.search/searchservices': 'azurerm_search_service',
  'microsoft.apimanagement/service': 'azurerm_api_management',
  'microsoft.logic/workflows': 'azurerm_logic_app_workflow',

  'microsoft.recoveryservices/vaults': 'azurerm_recovery_services_vault',
  'microsoft.automation/automationaccounts': 'azurerm_automation_account',
};

/**
 * Resolve an Azure ARM resource type (from resource.type) to an azurerm Terraform type.
 */
export function resolveAzurermType(armType: string, resource?: any): string | null {
  const key = armType.toLowerCase();
  const entry = ARM_TO_AZURERM[key];
  if (!entry) return null;
  if (typeof entry === 'function') return entry(resource);
  return entry;
}

// ──────────────────────────────────────────────────────────────
// Provider schema extraction + caching
// ──────────────────────────────────────────────────────────────

interface TfAttribute {
  type: any;        // Terraform type expression (string, number, bool, list(...), set(...), object({...}))
  required?: boolean;
  optional?: boolean;
  computed?: boolean;
  description?: string;
  sensitive?: boolean;
}

interface TfBlockType {
  nesting_mode: string; // "single", "list", "set", "map"
  min_items?: number;
  max_items?: number;
  block: TfBlock;
}

interface TfBlock {
  attributes?: Record<string, TfAttribute>;
  block_types?: Record<string, TfBlockType>;
}

interface TfResourceSchema {
  version: number;
  block: TfBlock;
}

// In-memory cache
let providerSchemaCache: Record<string, TfResourceSchema> | null = null;
let schemaLoadError: string | null = null;
let schemaLoading: Promise<void> | null = null;

// Disk cache path — avoids running terraform init on every startup
const SCHEMA_DISK_CACHE = path.join(os.tmpdir(), 'migrateops-azurerm-schema.json');
const SCHEMA_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function findTerraformBinary(): string | null {
  try {
    execSync('terraform version', { stdio: 'pipe', timeout: 10_000 });
    return 'terraform';
  } catch { /* not on PATH */ }
  const knownPaths = [
    path.join(os.homedir(), 'AppData/Local/Microsoft/WinGet/Packages/Hashicorp.Terraform_Microsoft.Winget.Source_8wekyb3d8bbwe/terraform.exe'),
    'C:/ProgramData/chocolatey/bin/terraform.exe',
    path.join(os.homedir(), '.local/bin/terraform'),
    '/usr/local/bin/terraform',
  ];
  for (const p of knownPaths) {
    try { fs.accessSync(p); return p; } catch { /* skip */ }
  }
  return null;
}

/**
 * Extract the full azurerm provider schema. Cached after first call.
 * Takes ~15-30s on first run (terraform init + providers schema).
 */
async function loadProviderSchema(): Promise<Record<string, TfResourceSchema>> {
  if (providerSchemaCache) return providerSchemaCache;

  // Try disk cache first (avoids 30s terraform init on startup)
  try {
    const stat = fs.statSync(SCHEMA_DISK_CACHE);
    if (Date.now() - stat.mtimeMs < SCHEMA_CACHE_MAX_AGE_MS) {
      const cached = JSON.parse(fs.readFileSync(SCHEMA_DISK_CACHE, 'utf-8'));
      const count = Object.keys(cached).length;
      if (count > 100) {
        providerSchemaCache = cached;
        console.log(`[Schema] ✅ Loaded ${count} azurerm schemas from disk cache`);
        return providerSchemaCache;
      }
    }
  } catch { /* no cache or expired */ }

  if (schemaLoadError) throw new Error(schemaLoadError);

  // Prevent concurrent loads
  if (schemaLoading) {
    await schemaLoading;
    if (providerSchemaCache) return providerSchemaCache;
    throw new Error(schemaLoadError || 'Schema load failed');
  }

  let resolve!: () => void;
  schemaLoading = new Promise<void>(r => { resolve = r; });

  const terraformBin = findTerraformBinary();
  if (!terraformBin) {
    schemaLoadError = 'terraform CLI not found — cannot extract provider schema';
    resolve();
    throw new Error(schemaLoadError);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurerm-schema-'));
  try {
    // Write minimal provider config
    fs.writeFileSync(path.join(tmpDir, 'provider.tf'), `
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
}
`, 'utf-8');

    console.log('[Schema] Running terraform init to download azurerm provider...');
    execSync(`"${terraformBin}" init -input=false -backend=false -no-color`, {
      cwd: tmpDir, stdio: 'pipe', timeout: 180_000,
    });

    console.log('[Schema] Extracting provider schema (terraform providers schema -json)...');
    const schemaJson = execSync(`"${terraformBin}" providers schema -json -no-color`, {
      cwd: tmpDir, stdio: 'pipe', timeout: 120_000, maxBuffer: 100 * 1024 * 1024, // 100MB — azurerm schema is large
    }).toString();

    const fullSchema = JSON.parse(schemaJson);
    const azurermKey = Object.keys(fullSchema.provider_schemas || {}).find(k => k.includes('azurerm'));
    if (!azurermKey) {
      throw new Error('azurerm provider not found in schema output');
    }

    const resourceSchemas = fullSchema.provider_schemas[azurermKey]?.resource_schemas || {};
    providerSchemaCache = resourceSchemas;
    const count = Object.keys(resourceSchemas).length;
    console.log(`[Schema] ✅ Loaded ${count} azurerm resource type schemas`);

    // Save to disk cache for fast startup next time
    try {
      fs.writeFileSync(SCHEMA_DISK_CACHE, JSON.stringify(resourceSchemas), 'utf-8');
      console.log(`[Schema] Saved disk cache: ${SCHEMA_DISK_CACHE}`);
    } catch { /* non-fatal */ }

    return resourceSchemas;

  } catch (err: any) {
    schemaLoadError = `Schema extraction failed: ${err.message?.slice(0, 200)}`;
    console.error(`[Schema] ❌ ${schemaLoadError}`);
    throw new Error(schemaLoadError);
  } finally {
    resolve();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ──────────────────────────────────────────────────────────────
// Compact schema formatter (token-efficient for AI prompts)
// ──────────────────────────────────────────────────────────────

function formatType(t: any): string {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    if (t[0] === 'list' || t[0] === 'set') return `${t[0]}(${formatType(t[1])})`;
    if (t[0] === 'map') return `map(${formatType(t[1])})`;
    if (t[0] === 'object') {
      const fields = Object.entries(t[1] || {}).map(([k, v]) => `${k}:${formatType(v)}`).join(', ');
      return `object({${fields}})`;
    }
  }
  return JSON.stringify(t);
}

function compactBlock(block: TfBlock, indent = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];

  // Attributes — skip computed-only (read-only) fields
  if (block.attributes) {
    const attrs = Object.entries(block.attributes)
      .filter(([, a]) => !a.computed || a.optional || a.required) // keep required, optional, writable
      .sort(([, a], [, b]) => (a.required ? 0 : 1) - (b.required ? 0 : 1)); // required first

    for (const [name, attr] of attrs) {
      const flags: string[] = [];
      if (attr.required) flags.push('REQUIRED');
      else if (attr.optional) flags.push('optional');
      if (attr.computed && attr.optional) flags.push('computed');
      if (attr.sensitive) flags.push('sensitive');
      lines.push(`${pad}${name}: ${formatType(attr.type)} [${flags.join(', ')}]`);
    }
  }

  // Nested block types
  if (block.block_types) {
    for (const [name, bt] of Object.entries(block.block_types)) {
      const minMax = bt.min_items ? ` min=${bt.min_items}` : '';
      lines.push(`${pad}${name} {  # ${bt.nesting_mode}${minMax}`);
      lines.push(compactBlock(bt.block, indent + 1));
      lines.push(`${pad}}`);
    }
  }

  return lines.join('\n');
}

/**
 * Get compact schema for a single resource type.
 * Returns null if not found.
 */
export async function getResourceSchema(resourceType: string): Promise<string | null> {
  try {
    const schemas = await loadProviderSchema();
    const schema = schemas[resourceType];
    if (!schema) return null;
    return `resource "${resourceType}" {\n${compactBlock(schema.block, 1)}\n}`;
  } catch {
    return null;
  }
}

/**
 * Get combined schema prompt section for multiple resource types.
 * This replaces the hardcoded azureRulesSection.
 */
export async function getSchemaForResources(resourceTypes: string[]): Promise<string> {
  const unique = Array.from(new Set(resourceTypes));
  const sections: string[] = [];
  let loadFailed = false;

  for (const rt of unique) {
    const schema = await getResourceSchema(rt).catch(() => { loadFailed = true; return null; });
    if (schema) {
      sections.push(schema);
    }
  }

  if (sections.length === 0) {
    if (loadFailed) {
      return '# [Schema unavailable — terraform CLI not found. Use azurerm ~> 4.x registry docs as reference.]';
    }
    return '';
  }

  return `AZURERM PROVIDER SCHEMA (source of truth — extracted from hashicorp/azurerm ~> 4.x):
Use ONLY the attributes and blocks listed below. If an attribute is not in this schema, it does NOT exist — do NOT use it.
Attributes marked [REQUIRED] MUST be present. Attributes marked [computed] are set by the provider and should only be included if you have the live value.

${sections.join('\n\n')}`;
}

/**
 * Determine which azurerm resource types are needed from a list of Azure ARM resources.
 * Returns deduplicated list.
 */
export function inferAzurermTypes(azureResources: any[]): string[] {
  const types = new Set<string>();
  for (const r of azureResources) {
    const armType = r.type || '';
    const resolved = resolveAzurermType(armType, r);
    if (resolved) types.add(resolved);
  }
  // Always include resource group
  types.add('azurerm_resource_group');
  return Array.from(types);
}

/**
 * Eagerly warm the schema cache (call at server startup).
 * Non-blocking — logs success/failure but doesn't throw.
 */
export function warmSchemaCache(): void {
  loadProviderSchema().catch(err => {
    console.warn(`[Schema] Warm cache failed (will retry on first MigrateOps extract): ${err.message}`);
  });
}

// ──────────────────────────────────────────────────────────────
// Schema-driven HCL post-processing
// ──────────────────────────────────────────────────────────────

/**
 * Collect all optional boolean attribute names for a resource type,
 * walking into nested blocks recursively.
 */
function collectOptionalBooleans(block: TfBlock): Set<string> {
  const out = new Set<string>();
  if (block.attributes) {
    for (const [name, attr] of Object.entries(block.attributes)) {
      if (attr.optional && !attr.required && attr.type === 'bool') {
        out.add(name);
      }
    }
  }
  if (block.block_types) {
    for (const bt of Object.values(block.block_types)) {
      for (const name of collectOptionalBooleans(bt.block)) {
        out.add(name);
      }
    }
  }
  return out;
}

/**
 * Schema-driven post-processor: strip `attribute = false` lines where
 * the schema says the attribute is an optional boolean.
 *
 * This is NOT a hardcoded per-attribute fix — it uses the REAL provider
 * schema to identify every optional boolean across all 1128 resource types.
 * Setting optional booleans to false is always redundant (false is always the
 * Terraform default) and can trigger cross-attribute dependency errors
 * (e.g. zone_redundancy_enabled = false requires infrastructure_subnet_id).
 *
 * Safe because: Terraform import reads the real state — omitted optional
 * attributes are filled in from the actual Azure resource.
 */
/**
 * Collect computed-only attribute names (computed=true, not optional, not required).
 * These are set by the provider — writing them causes "Value for unconfigurable attribute".
 */
function collectComputedOnlyAttrs(block: TfBlock): Set<string> {
  const out = new Set<string>();
  if (block.attributes) {
    for (const [name, attr] of Object.entries(block.attributes)) {
      if (attr.computed && !attr.optional && !attr.required) {
        out.add(name);
      }
    }
  }
  if (block.block_types) {
    for (const bt of Object.values(block.block_types)) {
      for (const name of collectComputedOnlyAttrs(bt.block)) {
        out.add(name);
      }
    }
  }
  return out;
}

/**
 * Schema-driven post-processor. Applies three generic fixes:
 *
 * 1. Strip computed-only attributes — these are set by the provider,
 *    writing them causes "Value for unconfigurable attribute" (e.g. location on container_app).
 *
 * 2. Strip optional booleans set to false — false is always the Terraform default,
 *    setting it is redundant and triggers cross-attribute constraints.
 *
 * 3. Normalize enum casing — Azure returns mixed case ("Auto", "tcp") but Terraform
 *    enums are case-sensitive. We normalize known transport/protocol patterns.
 *
 * All three use the REAL provider schema or consistent data patterns, not per-attribute rules.
 */
export async function schemaPostProcess(
  hcl: string,
  resourceTypes: string[]
): Promise<string> {
  let result = hcl;
  try {
    const schemas = await loadProviderSchema();

    // 1. Strip computed-only attributes
    const computedOnly = new Set<string>();
    for (const rt of resourceTypes) {
      const schema = schemas[rt];
      if (schema) {
        for (const name of collectComputedOnlyAttrs(schema.block)) {
          computedOnly.add(name);
        }
      }
    }
    if (computedOnly.size > 0) {
      const pattern = Array.from(computedOnly).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const re = new RegExp(`^\\s*(${pattern})\\s*=\\s*[^\\n]*\\n?`, 'gm');
      const before = result;
      result = result.replace(re, '');
      const removed = (before.match(re) || []).length;
      if (removed > 0) console.log(`[Schema] Stripped ${removed} computed-only attribute(s)`);
    }

    // 2. Strip optional boolean = false
    const optBools = new Set<string>();
    for (const rt of resourceTypes) {
      const schema = schemas[rt];
      if (schema) {
        for (const name of collectOptionalBooleans(schema.block)) {
          optBools.add(name);
        }
      }
    }
    if (optBools.size > 0) {
      const pattern = Array.from(optBools).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const re = new RegExp(`^\\s*(${pattern})\\s*=\\s*false\\s*$`, 'gm');
      const before = result;
      result = result.replace(re, '');
      const removed = (before.match(re) || []).length;
      if (removed > 0) console.log(`[Schema] Stripped ${removed} optional boolean = false line(s)`);
    }
  } catch {
    // Schema not available — skip schema-driven fixes
  }

  // 3. Normalize enum casing for transport/protocol fields
  // Azure REST API returns mixed case (e.g. "Tcp", "Auto", "Http") but Terraform
  // enums are case-sensitive. This is a DATA-layer mismatch (like ARM ID casing),
  // not an HCL rule — the provider uses inconsistent casing conventions.
  result = result.replace(
    /^(\s*transport\s*=\s*)"([^"]+)"(\s*)$/gm,
    (_m, pre: string, val: string, post: string) => {
      // ingress.transport: lowercase ("auto", "http", "http2", "tcp")
      // probe.transport: uppercase ("TCP", "HTTP", "HTTPS")
      // Detect context: if inside a probe block (liveness_probe/startup_probe/readiness_probe),
      // use uppercase. Otherwise lowercase.
      const upper = val.toUpperCase();
      const lower = val.toLowerCase();
      // Use uppercase for known probe values, lowercase otherwise
      if (['TCP', 'HTTP', 'HTTPS'].includes(upper)) {
        // Check if this line is indented deeply (probe context) vs shallow (ingress)
        const indent = (pre.match(/^\s*/) || [''])[0].length;
        if (indent >= 8) {
          // Deep indent = inside template.container.probe → uppercase
          return `${pre}"${upper}"${post}`;
        }
        // Shallow indent = ingress → lowercase
        return `${pre}"${lower}"${post}`;
      }
      // "auto" → always lowercase for ingress
      if (lower === 'auto') return `${pre}"auto"${post}`;
      return `${pre}"${val}"${post}`;
    }
  );

  return result;
}
