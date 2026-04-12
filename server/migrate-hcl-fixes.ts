/**
 * Deterministic HCL fixes for MigrateOps. Prefer LIVE Azure ARM data when available
 * (see buildLiveContainerSpecsFromAzure); defaults only as last resort.
 */

import {
  resolveContainerAppIngressTargetPort,
  normalizeIngressTransportFromArm,
} from './migrate-resolve.js';

/**
 * Canonical ARM provider namespace + resource type casing as required by Terraform's azurerm
 * ID parser. Azure API often returns these in lowercase; the provider's strict parser rejects them.
 *
 * Format: "lowercase/provider/namespace" -> "Canonical.Provider/Namespace"
 * and "lowercase_resource_type" -> "camelCasedResourceType" where the type is part of the path.
 */
const ARM_PROVIDER_CANONICAL: Record<string, string> = {
  'microsoft.insights':              'Microsoft.Insights',
  'microsoft.storage':               'Microsoft.Storage',
  'microsoft.web':                   'Microsoft.Web',
  'microsoft.network':               'Microsoft.Network',
  'microsoft.compute':               'Microsoft.Compute',
  'microsoft.resources':             'Microsoft.Resources',
  'microsoft.app':                   'Microsoft.App',
  'microsoft.containerregistry':     'Microsoft.ContainerRegistry',
  'microsoft.operationalinsights':   'Microsoft.OperationalInsights',
  'microsoft.keyvault':              'Microsoft.KeyVault',
  'microsoft.sql':                   'Microsoft.Sql',
  'microsoft.dbforpostgresql':       'Microsoft.DBforPostgreSQL',
  'microsoft.dbformysql':            'Microsoft.DBforMySQL',
  'microsoft.servicebus':            'Microsoft.ServiceBus',
  'microsoft.eventhub':              'Microsoft.EventHub',
  'microsoft.cognitiveservices':     'Microsoft.CognitiveServices',
  'microsoft.documentdb':            'Microsoft.DocumentDB',
  'microsoft.cache':                 'Microsoft.Cache',
  'microsoft.authorization':         'Microsoft.Authorization',
  'microsoft.managedidentity':       'Microsoft.ManagedIdentity',
  'microsoft.containerservice':      'Microsoft.ContainerService',
  'microsoft.cdn':                   'Microsoft.Cdn',
  'microsoft.apimanagement':         'Microsoft.ApiManagement',
  'microsoft.logic':                 'Microsoft.Logic',
  'microsoft.datafactory':           'Microsoft.DataFactory',
  'microsoft.search':                'Microsoft.Search',
  'microsoft.signalrservice':        'Microsoft.SignalRService',
};

/**
 * Canonical casing for resource type segments within a provider path, e.g.
 * "actiongroups" -> "actionGroups", "storageaccounts" -> "storageAccounts"
 */
const ARM_RESOURCE_TYPE_CANONICAL: Record<string, string> = {
  // Microsoft.Insights
  'actiongroups':         'actionGroups',
  'components':           'components',
  'metricalerts':         'metricAlerts',
  'scheduledqueryrules':  'scheduledQueryRules',
  // Microsoft.Storage
  'storageaccounts':      'storageAccounts',
  // Microsoft.Web
  'serverfarms':          'serverFarms',
  'sites':                'sites',
  'staticsites':          'staticSites',
  // Microsoft.Network
  'virtualnetworks':            'virtualNetworks',
  'networksecuritygroups':      'networkSecurityGroups',
  'publicipaddresses':          'publicIPAddresses',
  'loadbalancers':              'loadBalancers',
  'applicationgateways':        'applicationGateways',
  'privatednszones':            'privateDnsZones',
  /** Public DNS zones — API often returns lowercase; Terraform ID parser requires dnsZones */
  'dnszones':                   'dnsZones',
  'routetables':                'routeTables',
  'networkinterfaces':          'networkInterfaces',
  'natgateways':                'natGateways',
  'virtualnetworkgateways':     'virtualNetworkGateways',
  'expressroutecircuits':       'expressRouteCircuits',
  'privateendpoints':             'privateEndpoints',
  // Microsoft.App
  'containerapps':        'containerApps',
  'managedenvironments':  'managedEnvironments',
  // Microsoft.ContainerRegistry
  'registries':           'registries',
  // Microsoft.OperationalInsights
  'workspaces':           'workspaces',
  // Microsoft.KeyVault
  'vaults':               'vaults',
  'secrets':              'secrets',
  // Microsoft.Sql
  'servers':              'servers',
  'databases':            'databases',
  // Microsoft.DBforPostgreSQL / DBforMySQL
  'flexibleservers':      'flexibleServers',
  // Microsoft.ServiceBus / Microsoft.EventHub
  'namespaces':           'namespaces',
  'queues':               'queues',
  'topics':               'topics',
  // Microsoft.ContainerService
  'managedclusters':      'managedClusters',
  // Microsoft.ApiManagement
  'service':              'service',
};

/**
 * Normalise the provider namespace and resource-type segments of an Azure ARM resource ID
 * to their canonical casing so Terraform's strict ID parser accepts them.
 *
 * ARM IDs returned by the Azure API are sometimes fully lowercase:
 *   .../providers/microsoft.insights/actiongroups/...
 * But the azurerm provider ID parser requires:
 *   .../providers/Microsoft.Insights/actionGroups/...
 */
export function normalizeArmIdCasing(id: string): string {
  if (!id) return id;

  // The ARM ID format is:
  // /subscriptions/{sub}/resourceGroups/{rg}/providers/{Provider.Namespace}/{resourceType}/{name}[/...]
  // We need to fix the "providers" segment and the type segments that follow it.
  return id.replace(
    /\/providers\/([^/]+)((?:\/[^/]+\/[^/]+)*)/gi,
    (_match: string, providerNs: string, rest: string) => {
      const canonical = ARM_PROVIDER_CANONICAL[providerNs.toLowerCase()] || providerNs;
      // Fix resource type segments: /resourceType/name pairs
      const fixedRest = rest.replace(/\/([^/]+)\/([^/]*)/g, (_seg: string, type: string, name: string) => {
        const fixedType = ARM_RESOURCE_TYPE_CANONICAL[type.toLowerCase()] || type;
        return `/${fixedType}/${name}`;
      });
      return `/providers/${canonical}${fixedRest}`;
    }
  );
}

/**
 * Applies normalizeArmIdCasing to every `id = "..."` line inside an imports.tf file content.
 */
export function fixImportIdsCasing(content: string): string {
  return content.replace(
    /^(\s*id\s*=\s*)"([^"]+)"\s*$/gm,
    (_full: string, prefix: string, id: string) => `${prefix}"${normalizeArmIdCasing(id)}"`
  );
}

/**
 * Deterministically fix `location = var.location` (or any `location = var.*`) in every
 * resource block by substituting the actual ARM location for that resource.
 *
 * This is a safety-net pass that runs AFTER AI generation so that even if the AI ignores
 * per-resource location guidance, the HCL ends up with the correct hardcoded value.
 *
 * Strategy:
 * 1. Build a lookup from resource name (lowercased) → location from live ARM data.
 * 2. Walk each resource block in main.tf, find its `name = "..."` attribute, look up
 *    the correct location, and replace `location = var.*` with `location = "actual"`.
 * 3. If no name match is found, fall back to replacing via ARM id matching.
 */
export function fixResourceLocationsFromArmData(mainTf: string, azureResources: any[]): string {
  if (!azureResources || azureResources.length === 0) return mainTf;

  // Build lookup: resource name (lowercase) → location
  const nameToLocation = new Map<string, string>();
  for (const r of azureResources) {
    if (r?.name && r?.location) {
      nameToLocation.set(String(r.name).toLowerCase(), String(r.location));
    }
  }
  if (nameToLocation.size === 0) return mainTf;

  // Pattern that matches location = var.anything OR location = azurerm_resource_group.xxx.location
  const varLocationPattern = /^(\s*location\s*=\s*)(var\.\w+|azurerm_resource_group\.\w+\.location)\s*$/gm;

  // Walk each resource block
  const resourceRe = /\bresource\s+"[^"]+"\s+"[^"]+"\s*\{/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = resourceRe.exec(mainTf)) !== null) {
    const blockStart = m.index;
    // We need extractBalancedBlockFromOpenBrace but it's defined later; use a simple scan
    const openBrace = mainTf.indexOf('{', blockStart);
    if (openBrace === -1) continue;

    // Find block end via brace counting
    let depth = 0;
    let blockEnd = openBrace;
    for (let i = openBrace; i < mainTf.length; i++) {
      if (mainTf[i] === '{') depth++;
      else if (mainTf[i] === '}') { depth--; if (depth === 0) { blockEnd = i + 1; break; } }
    }
    if (depth !== 0) continue;

    let block = mainTf.slice(blockStart, blockEnd);

    // Check if this block has `location = var.*` or similar
    if (!varLocationPattern.test(block)) {
      out += mainTf.slice(last, blockEnd);
      last = blockEnd;
      resourceRe.lastIndex = last;
      varLocationPattern.lastIndex = 0;
      continue;
    }
    varLocationPattern.lastIndex = 0;

    // Try to find the resource's name attribute to look up its actual location
    const nameMatch = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const resourceName = nameMatch?.[1]?.toLowerCase();
    const actualLocation = resourceName ? nameToLocation.get(resourceName) : undefined;

    if (actualLocation) {
      block = block.replace(
        varLocationPattern,
        (_full: string, prefix: string) => `${prefix}"${actualLocation}"`
      );
    }
    varLocationPattern.lastIndex = 0;

    out += mainTf.slice(last, blockStart) + block;
    last = blockEnd;
    resourceRe.lastIndex = last;
  }

  out += mainTf.slice(last);
  return out;
}

/**
 * Terraform import blocks require `to = resource.address` (unquoted). Models often emit
 * `to = "azurerm_foo.bar"` which fails validation ("Invalid expression").
 */
export function fixImportBlocksQuotedToAddresses(content: string): string {
  return content.replace(
    /^(\s*)to\s*=\s*"([^"]+)"\s*$/gm,
    (full, indent: string, inner: string) => {
      const t = inner.trim();
      // Resource address is always unquoted: provider_type.local_name (optionally module... prefix)
      if (t.includes('.') && !/\s/.test(t)) {
        return `${indent}to = ${t}`;
      }
      return full;
    }
  );
}

const DEFAULT_CPU = '0.5';
const DEFAULT_MEMORY = '"1.0Gi"';

function formatCpuForHcl(v: unknown): string {
  if (v === undefined || v === null) return DEFAULT_CPU;
  if (typeof v === 'number' && !Number.isNaN(v)) return String(v);
  const s = String(v).trim();
  return s || DEFAULT_CPU;
}

function formatMemoryForHcl(v: unknown): string {
  if (v === undefined || v === null) return DEFAULT_MEMORY;
  const s = String(v).trim();
  if (!s) return DEFAULT_MEMORY;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** Per Container App name (Azure resource name), ordered container cpu/memory from ARM template. */
export function buildLiveContainerSpecsFromAzure(resources: any[]): Map<string, Array<{ cpu: string; memory: string }>> {
  const m = new Map<string, Array<{ cpu: string; memory: string }>>();
  for (const r of resources) {
    const t = String(r?.type || '').toLowerCase();
    if (!t.includes('microsoft.app/containerapps')) continue;
    const containers = r?.properties?.template?.containers || [];
    const specs = (containers as any[]).map((c) => ({
      cpu: formatCpuForHcl(c?.resources?.cpu ?? c?.cpu),
      memory: formatMemoryForHcl(c?.resources?.memory ?? c?.memory),
    }));
    if (specs.length > 0 && r.name) {
      m.set(String(r.name), specs);
    }
  }
  return m;
}

function extractBalancedBlockFromOpenBrace(s: string, openBraceIdx: number): { end: number } {
  let depth = 0;
  for (let i = openBraceIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { end: i + 1 };
    }
  }
  return { end: s.length };
}

/** Single `container { ... }` block (possibly multi-line). */
function injectCpuMemoryIntoSingleContainerBlock(
  subBlock: string,
  spec?: { cpu: string; memory: string }
): string {
  const lines = subBlock.split(/\r?\n/);
  const m = lines[0]?.match(/^(\s*)container\s*\{\s*$/);
  if (!m) return subBlock;
  const innerIndent = m[1] + '  ';
  if (lines.length < 2) return subBlock;
  const closingLine = lines[lines.length - 1]!;
  const bodyLines = lines.slice(1, -1);
  const bodyText = bodyLines.join('\n');
  const hasCpu = /\bcpu\s*=/.test(bodyText);
  const hasMemory = /\bmemory\s*=/.test(bodyText);
  const cpu = spec?.cpu ?? DEFAULT_CPU;
  const mem = spec?.memory ?? DEFAULT_MEMORY;
  const out: string[] = [lines[0]!];
  if (!hasCpu && !hasMemory) {
    out.push(`${innerIndent}cpu    = ${cpu}`);
    out.push(`${innerIndent}memory = ${mem}`);
  } else if (!hasCpu) {
    out.push(`${innerIndent}cpu    = ${cpu}`);
  } else if (!hasMemory) {
    out.push(`${innerIndent}memory = ${mem}`);
  }
  for (const bl of bodyLines) out.push(bl);
  out.push(closingLine);
  return out.join('\n');
}

/** Line-based fallback when no live Azure resources are available. */
function ensureContainerAppContainerCpuMemoryDefaults(mainTf: string): string {
  const specs = new Map<string, Array<{ cpu: string; memory: string }>>();
  return injectContainerCpuMemoryFromLiveMap(mainTf, specs, true);
}

/**
 * Inject cpu/memory into each `container { }` inside `azurerm_container_app` blocks using live ARM order.
 */
function injectContainerCpuMemoryFromLiveMap(
  mainTf: string,
  liveByAppName: Map<string, Array<{ cpu: string; memory: string }>>,
  useDefaultsOnly: boolean
): string {
  const resourceRe = /resource\s+"azurerm_container_app"\s+"([^"]+)"\s*\{/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = resourceRe.exec(mainTf)) !== null) {
    const blockStart = m.index;
    const openBrace = mainTf.indexOf('{', blockStart);
    if (openBrace === -1) continue;
    const { end: blockEnd } = extractBalancedBlockFromOpenBrace(mainTf, openBrace);
    const block = mainTf.slice(blockStart, blockEnd);

    const nameMatch = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const appArmName = nameMatch?.[1];
    const specs = appArmName && !useDefaultsOnly ? liveByAppName.get(appArmName) : undefined;

    let processedBlock = block;
    if (specs?.length) {
      let ci = 0;
      const containerRe = /\bcontainer\s*\{/g;
      let cm: RegExpExecArray | null;
      const pieces: string[] = [];
      let blockLast = 0;
      while ((cm = containerRe.exec(processedBlock)) !== null) {
        const o = processedBlock.indexOf('{', cm.index);
        const { end: subEnd } = extractBalancedBlockFromOpenBrace(processedBlock, o);
        const sub = processedBlock.slice(cm.index, subEnd);
        const spec = specs[ci++];
        const fixed = injectCpuMemoryIntoSingleContainerBlock(sub, spec);
        pieces.push(processedBlock.slice(blockLast, cm.index) + fixed);
        blockLast = subEnd;
        containerRe.lastIndex = subEnd;
      }
      pieces.push(processedBlock.slice(blockLast));
      processedBlock = pieces.join('');
    } else {
      processedBlock = injectAllContainersDefaults(processedBlock);
    }

    out += mainTf.slice(last, blockStart) + processedBlock;
    last = blockEnd;
    resourceRe.lastIndex = last;
  }

  out += mainTf.slice(last);
  return out;
}

/** Within a resource block string, inject defaults into every container { } (no live map). */
function injectAllContainersDefaults(block: string): string {
  const containerRe = /\bcontainer\s*\{/g;
  let result = '';
  let last = 0;
  let cm: RegExpExecArray | null;
  while ((cm = containerRe.exec(block)) !== null) {
    const o = block.indexOf('{', cm.index);
    const { end: subEnd } = extractBalancedBlockFromOpenBrace(block, o);
    const sub = block.slice(cm.index, subEnd);
    const fixed = injectCpuMemoryIntoSingleContainerBlock(sub, {
      cpu: DEFAULT_CPU,
      memory: DEFAULT_MEMORY,
    });
    result += block.slice(last, cm.index) + fixed;
    last = subEnd;
    containerRe.lastIndex = last;
  }
  result += block.slice(last);
  return result;
}

/**
 * Strip read-only / computed attributes from `ingress {}` blocks inside
 * `azurerm_container_app` resources. The azurerm provider exports these automatically
 * and rejects them if they appear in config:
 *   - custom_domain {} blocks
 *   - fqdn = "..."
 */
export function stripContainerAppIngressComputedAttrs(mainTf: string): string {
  const resourceRe = /resource\s+"azurerm_container_app"\s+"[^"]+"\s*\{/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = resourceRe.exec(mainTf)) !== null) {
    const blockStart = m.index;
    const openBrace = mainTf.indexOf('{', blockStart);
    if (openBrace === -1) continue;
    const { end: blockEnd } = extractBalancedBlockFromOpenBrace(mainTf, openBrace);
    let block = mainTf.slice(blockStart, blockEnd);

    // Find ingress {} blocks and strip computed children
    const ingressRe = /\bingress\s*\{/g;
    let ingressOut = '';
    let ingressLast = 0;
    let im: RegExpExecArray | null;

    while ((im = ingressRe.exec(block)) !== null) {
      const io = block.indexOf('{', im.index);
      const { end: ingressEnd } = extractBalancedBlockFromOpenBrace(block, io);
      let ingressBody = block.slice(im.index, ingressEnd);

      // Remove custom_domain { ... } blocks (computed attribute)
      for (let iter = 0; iter < 20; iter++) {
        const cdm = /\n(\s*)custom_domain\s*\{/m.exec(ingressBody);
        if (!cdm) break;
        const cdOpen = ingressBody.indexOf('{', cdm.index + cdm[0].indexOf('{'));
        const { end: cdEnd } = extractBalancedBlockFromOpenBrace(ingressBody, cdOpen);
        ingressBody = ingressBody.slice(0, cdm.index) + ingressBody.slice(cdEnd);
      }

      // Remove fqdn = "..." lines (computed attribute)
      ingressBody = ingressBody.replace(/\n\s*fqdn\s*=\s*"[^"]*"\s*/g, '\n');

      ingressOut += block.slice(ingressLast, im.index) + ingressBody;
      ingressLast = ingressEnd;
      ingressRe.lastIndex = ingressEnd;
    }
    ingressOut += block.slice(ingressLast);
    block = ingressOut;

    out += mainTf.slice(last, blockStart) + block;
    last = blockEnd;
    resourceRe.lastIndex = last;
  }

  out += mainTf.slice(last);
  return out;
}

/** @deprecated use resolveContainerAppIngressTargetPort from migrate-resolve — kept for external callers */
export function resolveContainerAppIngressTargetPortFromArm(r: any): number {
  const { target_port, source } = resolveContainerAppIngressTargetPort(r);
  if (source.includes('migrateops_fallback')) {
    console.warn(
      `[MigrateOps] Container App "${r?.name ?? '?'}": ingress target_port → ${target_port} (${source})`
    );
  }
  return target_port;
}

/**
 * Replace invalid ingress.target_port (0, out of range) using live ARM data per app name.
 */
export function fixContainerAppIngressTargetPortFromArmData(
  mainTf: string,
  azureResources?: any[]
): string {
  const fixZeroGlobal = (s: string) =>
    s.replace(/\b(target_port\s*=\s*)0\b/g, (_m, g1: string) => `${g1}8080 # migrateops: was 0 — verify`);

  if (!azureResources?.length) {
    return fixZeroGlobal(mainTf);
  }

  const byName = new Map<string, any>();
  for (const r of azureResources) {
    const t = String(r?.type || '').toLowerCase();
    if (t.includes('microsoft.app/containerapps') && r?.name) {
      byName.set(String(r.name).toLowerCase(), r);
    }
  }
  if (byName.size === 0) {
    return fixZeroGlobal(mainTf);
  }

  const resourceRe = /resource\s+"azurerm_container_app"\s+"[^"]+"\s*\{/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = resourceRe.exec(mainTf)) !== null) {
    const blockStart = m.index;
    const openBrace = mainTf.indexOf('{', blockStart);
    if (openBrace === -1) continue;
    const { end: blockEnd } = extractBalancedBlockFromOpenBrace(mainTf, openBrace);
    let block = mainTf.slice(blockStart, blockEnd);

    const nm = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const appName = nm?.[1]?.toLowerCase();
    const arm = appName ? byName.get(appName) : undefined;
    const resolved = arm
      ? resolveContainerAppIngressTargetPort(arm).target_port
      : 8080;

    // Fix every ingress { } block's target_port if invalid
    const ingressRe = /\bingress\s*\{/g;
    let ingressOut = '';
    let ingressLast = 0;
    let im: RegExpExecArray | null;
    while ((im = ingressRe.exec(block)) !== null) {
      const io = block.indexOf('{', im.index);
      const { end: ingressEnd } = extractBalancedBlockFromOpenBrace(block, io);
      let ingressBody = block.slice(im.index, ingressEnd);

      ingressBody = ingressBody.replace(/\btarget_port\s*=\s*(\d+)/g, (_full, num: string) => {
        const n = parseInt(num, 10);
        if (n >= 1 && n <= 65535) return `target_port = ${n}`;
        return `target_port = ${resolved}`;
      });

      // Inject target_port if ingress block exists but omits it (AI / ARM gap)
      if (!/\btarget_port\s*=/.test(ingressBody)) {
        ingressBody = ingressBody.replace(/^(\s*ingress\s*\{)/m, `$1\n  target_port = ${resolved}`);
      }

      ingressOut += block.slice(ingressLast, im.index) + ingressBody;
      ingressLast = ingressEnd;
      ingressRe.lastIndex = ingressEnd;
    }
    ingressOut += block.slice(ingressLast);
    block = ingressOut;

    out += mainTf.slice(last, blockStart) + block;
    last = blockEnd;
    resourceRe.lastIndex = last;
  }

  return out + mainTf.slice(last);
}

/**
 * Ensure each `template.container` has required cpu/memory.
 * When `resources` (live Azure fetch) is provided, values come from ARM `template.containers[].resources`.
 */
export function ensureContainerAppContainerCpuMemory(mainTf: string, resources?: any[]): string {
  if (resources && resources.length > 0) {
    const live = buildLiveContainerSpecsFromAzure(resources);
    if (live.size > 0) {
      return injectContainerCpuMemoryFromLiveMap(mainTf, live, false);
    }
  }
  return ensureContainerAppContainerCpuMemoryDefaults(mainTf);
}

/** Remove legacy `encryption { }` blocks (pre-4.x) from a storage account resource body. */
function stripLegacyStorageAccountEncryptionBlock(blockBody: string): string {
  let s = blockBody;
  for (let iter = 0; iter < 20; iter++) {
    const m = /\n\s*encryption\s*\{/m.exec(s);
    if (!m) break;
    const open = s.indexOf('{', m.index);
    if (open === -1) break;
    const { end } = extractBalancedBlockFromOpenBrace(s, open);
    s =
      s.slice(0, m.index) +
      '\n  # encryption { } removed — use infrastructure_encryption_enabled / identity per azurerm 4.x registry docs' +
      s.slice(end);
  }
  return s;
}

function ensureArmRoleReceiverNames(mainTf: string): string {
  const re = /arm_role_receiver\s*\{/g;
  let result = '';
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(mainTf)) !== null) {
    const open = mainTf.indexOf('{', m.index);
    const { end } = extractBalancedBlockFromOpenBrace(mainTf, open);
    const body = mainTf.slice(open + 1, end - 1);
    const hasName = /^\s*name\s*=/m.test(body);
    const inner = hasName ? body : `\n    name = "arm_role_receiver_${++n}"${body}`;
    result +=
      mainTf.slice(last, m.index) + mainTf.slice(m.index, open + 1) + inner + mainTf.slice(end - 1, end);
    last = end;
    re.lastIndex = last;
  }
  return result + mainTf.slice(last);
}

// ---------------------------------------------------------------------------
// GLOBAL attribute renames that apply to specific resource types.
// Keyed by the Terraform resource type prefix; value is a map of old→new arg name.
// Applied with simple string replacement — safe because attribute names are unique
// within a provider (the regex is anchored to word boundaries).
// ---------------------------------------------------------------------------
const GLOBAL_RENAMES: Record<string, string> = {
  // azurerm_storage_account
  allow_blob_public_access:    'allow_nested_items_to_be_public',
  allow_shared_key_access:     'shared_access_key_enabled',
  enable_https_traffic_only:   'https_traffic_only_enabled',
  // azurerm_subnet
  // address_prefix handled separately (string → list)
  // azurerm_key_vault
  soft_delete_enabled:         'soft_delete_retention_days', // bool→number; needs manual value
};

// Per-resource-type renames so we don't accidentally rename attributes that
// happen to share a name in unrelated resources.
const PER_RESOURCE_RENAMES: Array<{
  resourceTypePattern: RegExp;
  renames: Record<string, string>;
  removedArgs?: string[];    // argument names to drop entirely (computed / removed)
}> = [
  {
    // azurerm_container_app — all attribute renames (ARM camelCase + wrong snake_case → correct 4.x names)
    resourceTypePattern: /azurerm_container_app/,
    renames: {
      // Ingress block
      secretRef:                'secret_name',
      externalEnabled:          'external_enabled',
      external:                 'external_enabled',
      allowInsecure:            'allow_insecure_connections',
      targetPort:               'target_port',
      exposedPort:              'exposed_port',
      latestRevision:           'latest_revision',
      revisionName:             'revision_suffix',
      revisionSuffix:           'revision_suffix',
      workloadProfileName:      'workload_profile_name',
      managedEnvironmentId:     'container_app_environment_id',
      // registry {} block (top-level) — provider uses password_secret_name, not ARM-style *_ref
      password_secret_ref:    'password_secret_name',
      passwordSecretRef:      'password_secret_name',
      // Probe blocks — camelCase ARM variants
      timeoutSeconds:           'timeout',
      timeout_seconds:          'timeout',           // wrong snake_case the AI commonly emits
      // NOTE: success_count_threshold exists ONLY on readiness_probe — not liveness/startup (see strip fn)
      failureThreshold:         'failure_count_threshold',
      failure_threshold:        'failure_count_threshold',
      initialDelaySeconds:      'initial_delay',
      initial_delay_seconds:    'initial_delay',
      periodSeconds:            'interval_seconds',
      period_seconds:           'interval_seconds',
      failureCountThreshold:    'failure_count_threshold',
      failure_count:            'failure_count_threshold',
      terminationGracePeriodSeconds: 'termination_grace_period_seconds',
    },
    // Computed/read-only top-level args
    removedArgs: [
      'latest_revision_fqdn',
      'latest_revision_name',
      'outbound_ip_addresses',
    ],
  },
  {
    // azurerm_linux_web_app / azurerm_windows_web_app
    resourceTypePattern: /azurerm_(linux|windows)_web_app/,
    renames: {
      linuxFxVersion: 'linux_fx_version', // ARM camelCase — handled separately below
    },
    removedArgs: [
      // linux_fx_version is read-only in site_config in 4.x — handled with application_stack replacement
    ],
  },
  {
    // azurerm_service_plan (was azurerm_app_service_plan)
    resourceTypePattern: /azurerm_service_plan/,
    renames: {},
    removedArgs: [],
  },
  {
    // azurerm_network_security_group
    resourceTypePattern: /azurerm_network_security_group/,
    renames: {
      sourceAddressPrefix:      'source_address_prefix',
      destinationAddressPrefix: 'destination_address_prefix',
      sourcePortRange:          'source_port_range',
      destinationPortRange:     'destination_port_range',
    },
    removedArgs: [],
  },
];

/**
 * Apply per-resource-type renames by walking each resource block.
 * Renames are applied as whole-word replacements within the block body.
 */
function applyPerResourceRenames(mainTf: string): string {
  const resourceRe = /\bresource\s+"([^"]+)"\s+"[^"]+"\s*\{/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = resourceRe.exec(mainTf)) !== null) {
    const resourceType = m[1];
    const blockStart = m.index;
    const openBrace = mainTf.indexOf('{', blockStart);
    if (openBrace === -1) continue;

    let depth = 0, blockEnd = openBrace;
    for (let i = openBrace; i < mainTf.length; i++) {
      if (mainTf[i] === '{') depth++;
      else if (mainTf[i] === '}') { depth--; if (depth === 0) { blockEnd = i + 1; break; } }
    }
    if (depth !== 0) continue;

    let block = mainTf.slice(blockStart, blockEnd);

    for (const entry of PER_RESOURCE_RENAMES) {
      if (!entry.resourceTypePattern.test(resourceType)) continue;

      // Apply renames: only replace when used as an attribute key (= follows on same line)
      for (const [oldName, newName] of Object.entries(entry.renames)) {
        // Match "oldName =" or "oldName=" at start of an attribute line (possibly indented)
        const re = new RegExp(`\\b${oldName}(\\s*=)`, 'g');
        block = block.replace(re, `${newName}$1`);
      }

      // Remove computed/read-only top-level arguments
      for (const argName of (entry.removedArgs ?? [])) {
        block = block.replace(new RegExp(`^\\s*${argName}\\s*=\\s*[^\\n]*\\n`, 'gm'), '');
      }
    }

    out += mainTf.slice(last, blockStart) + block;
    last = blockEnd;
    resourceRe.lastIndex = last;
  }

  return out + mainTf.slice(last);
}

/**
 * Replace linux_fx_version = "RUNTIME|version" with the correct application_stack {} block.
 * Covers: NODE, PYTHON, DOTNET, JAVA, RUBY, PHP, GO, DOCKER.
 */
function fixLinuxFxVersion(mainTf: string): string {
  return mainTf.replace(
    /(\s*)linux_fx_version\s*=\s*"([^"|]+)\|([^"]+)"(\s*\n?)/g,
    (_full, indent: string, runtime: string, version: string, trail: string) => {
      const r = runtime.toUpperCase();
      let innerBlock: string;
      if (r === 'NODE') {
        innerBlock = `node_version = "${version}"`;
      } else if (r === 'PYTHON') {
        innerBlock = `python_version = "${version}"`;
      } else if (r === 'DOTNETCORE' || r === 'DOTNET') {
        innerBlock = `dotnet_version = "${version}"`;
      } else if (r === 'JAVA') {
        const [jver, , jserver] = version.split('-');
        innerBlock = `java_version = "${jver ?? version}"\n${indent}  java_server = "${(jserver ?? 'JAVA').toLowerCase()}"`;
      } else if (r === 'RUBY') {
        innerBlock = `ruby_version = "${version}"`;
      } else if (r === 'PHP') {
        innerBlock = `php_version = "${version}"`;
      } else if (r === 'GO') {
        innerBlock = `go_version = "${version}"`;
      } else if (r === 'DOCKER') {
        const [imageUrl] = version.split('|');
        innerBlock = `docker_image_name = "${imageUrl}"\n${indent}  docker_registry_url = "https://index.docker.io"`;
      } else {
        // Unknown runtime — keep as comment
        return `${indent}# linux_fx_version = "${runtime}|${version}" — TODO: replace with application_stack {}${trail}`;
      }
      return `${indent}application_stack {\n${indent}  ${innerBlock}\n${indent}}${trail}`;
    }
  );
}

/**
 * Comprehensive deterministic fixes so generated HCL matches hashicorp/azurerm 4.x.
 * This is the authoritative post-processing pass — the AI handles structure,
 * this layer guarantees every attribute name is correct.
 */
export function postProcessMigrateOpsAzurerm4MainTf(mainTf: string, azureResources?: any[]): string {
  let c = mainTf;

  // 1. Global simple renames (apply everywhere — names are unique across the provider)
  for (const [oldName, newName] of Object.entries(GLOBAL_RENAMES)) {
    c = c.replace(new RegExp(`\\b${oldName}(\\s*=)`, 'g'), `${newName}$1`);
  }

  // 2. azurerm_storage_account: strip obsolete encryption {} block
  {
    const saRe = /resource\s+"azurerm_storage_account"\s+"[^"]+"\s*\{/g;
    let rebuilt = '';
    let last = 0;
    let sm: RegExpExecArray | null;
    while ((sm = saRe.exec(c)) !== null) {
      const open = c.indexOf('{', sm.index);
      const { end } = extractBalancedBlockFromOpenBrace(c, open);
      const inner = c.slice(open + 1, end - 1);
      const fixedInner = stripLegacyStorageAccountEncryptionBlock(inner);
      rebuilt += c.slice(last, sm.index) + c.slice(sm.index, open + 1) + fixedInner + c.slice(end - 1, end);
      last = end;
      saRe.lastIndex = last;
    }
    c = rebuilt + c.slice(last);
  }

  // 3. azurerm_subnet: address_prefix "x" → address_prefixes = ["x"]
  c = c.replace(/^(\s*)address_prefix\s*=\s*"([^"]+)"(\s*)$/gm, '$1address_prefixes = ["$2"]$3');

  // 4. azurerm_linux_web_app: linux_fx_version → application_stack {}
  c = fixLinuxFxVersion(c);

  // 5. azurerm_monitor_action_group: ensure every *_receiver block has a name
  c = ensureArmRoleReceiverNames(c);

  // 6. Per-resource-type renames (container app ingress, web app, NSG, etc.)
  c = applyPerResourceRenames(c);

  // 7. azurerm_container_app: fix ingress block structure
  c = fixContainerAppIngress(c);

  // 7b. ingress.target_port must be 1–65535 — derive from live ARM when AI emits 0
  c = fixContainerAppIngressTargetPortFromArmData(c, azureResources);

  // 8. azurerm_container_app: strip computed ingress attributes (custom_domain, fqdn)
  c = stripContainerAppIngressComputedAttrs(c);

  return c;
}

/**
 * Inside each top-level `ingress {}` only: coerce transport to Terraform’s lowercase enum.
 * Probe blocks use HTTP/HTTPS/TCP and must not be changed here.
 */
function normalizeIngressBlockTransportCasing(containerAppBlock: string): string {
  const ingressRe = /\bingress\s*\{/g;
  let out = '';
  let last = 0;
  let im: RegExpExecArray | null;

  while ((im = ingressRe.exec(containerAppBlock)) !== null) {
    const io = containerAppBlock.indexOf('{', im.index);
    const { end: ingressEnd } = extractBalancedBlockFromOpenBrace(containerAppBlock, io);
    let ingressBody = containerAppBlock.slice(im.index, ingressEnd);

    ingressBody = ingressBody.replace(/\btransport\s*=\s*"([^"]*)"/gi, (_full, val: string) => {
      const n = normalizeIngressTransportFromArm(val);
      return `transport = "${n}"`;
    });

    out += containerAppBlock.slice(last, im.index) + ingressBody;
    last = ingressEnd;
    ingressRe.lastIndex = ingressEnd;
  }

  return out + containerAppBlock.slice(last);
}

/**
 * Remove success_count_threshold / success_threshold from liveness_probe and startup_probe only.
 * azurerm only allows success_count_threshold on readiness_probe (liveness/startup omit it).
 */
function stripSuccessCountThresholdFromNonReadinessProbes(containerAppBlock: string): string {
  const probeRes = [/\bliveness_probe\s*\{/g, /\bstartup_probe\s*\{/g];
  let s = containerAppBlock;
  for (const probeRe of probeRes) {
    probeRe.lastIndex = 0;
    let out = '';
    let last = 0;
    let pm: RegExpExecArray | null;
    while ((pm = probeRe.exec(s)) !== null) {
      const pOpen = s.indexOf('{', pm.index);
      const { end: pEnd } = extractBalancedBlockFromOpenBrace(s, pOpen);
      let body = s.slice(pOpen + 1, pEnd - 1);
      body = body.replace(/^\s*success_count_threshold\s*=\s*[^\n]+\n?/gm, '');
      body = body.replace(/^\s*success_threshold\s*=\s*[^\n]+\n?/gm, '');
      body = body.replace(/^\s*successThreshold\s*=\s*[^\n]+\n?/gm, '');
      body = body.replace(/^\s*successCountThreshold\s*=\s*[^\n]+\n?/gm, '');
      out += s.slice(last, pOpen + 1) + body + s.slice(pEnd - 1, pEnd);
      last = pEnd;
      probeRe.lastIndex = last;
    }
    s = out + s.slice(last);
  }
  return s;
}

/**
 * Fix azurerm_container_app ingress block:
 * - external / externalEnabled → external_enabled
 * - targetPort → target_port
 * - allowInsecure → allow_insecure_connections
 * - Remove scale {} block (move min/max_replicas to template level)
 * - secretRef in env → secret_name
 * - probes {} → individual probe blocks
 */
function fixContainerAppIngress(mainTf: string): string {
  const resourceRe = /resource\s+"azurerm_container_app"\s+"[^"]+"\s*\{/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = resourceRe.exec(mainTf)) !== null) {
    const blockStart = m.index;
    const openBrace = mainTf.indexOf('{', blockStart);
    if (openBrace === -1) continue;
    const { end: blockEnd } = extractBalancedBlockFromOpenBrace(mainTf, openBrace);
    let block = mainTf.slice(blockStart, blockEnd);

    // Fix ingress-specific attribute names
    // These are safe to apply globally within the container app block since they're ingress-specific
    block = block.replace(/\bexternal_enabled\s*=\s*(true|false)/g, 'external_enabled = $1'); // already correct
    block = block.replace(/\bexternal\s*=\s*(true|false)/g, 'external_enabled = $1');          // ARM name
    block = block.replace(/\bexternalEnabled\s*=\s*(true|false)/g, 'external_enabled = $1');   // camelCase
    block = block.replace(/\ballowInsecure\s*=/g, 'allow_insecure_connections =');
    block = block.replace(/\btargetPort\s*=/g, 'target_port =');
    block = block.replace(/\bexposedPort\s*=/g, 'exposed_port =');
    block = block.replace(/\blatestRevision\s*=/g, 'latest_revision =');
    block = block.replace(/\brevisionName\s*=/g, 'revision_suffix =');
    block = block.replace(/\bclientCertificateMode\s*=/g, 'client_certificate_mode =');

    // Fix env secretRef → secret_name
    block = block.replace(/\bsecretRef\s*=/g, 'secret_name =');

    // Fix managed_environment_id → container_app_environment_id
    block = block.replace(/\bmanaged_environment_id\s*=/g, 'container_app_environment_id =');

    // Remove scale {} block — extract min/max_replicas and move them to template level
    block = fixContainerAppScaleBlock(block);

    // Fix probes {} → individual typed probe blocks
    block = fixContainerAppProbesBlock(block);

    // Ingress-only: transport must be lowercase auto|http|http2|tcp (ARM sends "Auto", etc.).
    // Do NOT touch liveness_probe.transport — those use HTTP/HTTPS/TCP uppercase.
    block = normalizeIngressBlockTransportCasing(block);

    // success_count_threshold is ONLY valid on readiness_probe (Terraform provider schema)
    block = stripSuccessCountThresholdFromNonReadinessProbes(block);

    out += mainTf.slice(last, blockStart) + block;
    last = blockEnd;
    resourceRe.lastIndex = last;
  }

  return out + mainTf.slice(last);
}

/**
 * Remove scale {} blocks from azurerm_container_app template and inject
 * min_replicas / max_replicas as flat template arguments.
 */
function fixContainerAppScaleBlock(block: string): string {
  const templateRe = /\btemplate\s*\{/g;
  let out = '';
  let last = 0;
  let tm: RegExpExecArray | null;

  while ((tm = templateRe.exec(block)) !== null) {
    const tOpen = block.indexOf('{', tm.index);
    const { end: tEnd } = extractBalancedBlockFromOpenBrace(block, tOpen);
    let templateBody = block.slice(tm.index, tEnd);

    // Find and extract scale {} block
    const scaleRe = /\n(\s*)scale\s*\{/g;
    let scaleMatch: RegExpExecArray | null;
    let minReplicas: string | undefined;
    let maxReplicas: string | undefined;
    let bodyWithoutScale = templateBody;

    while ((scaleMatch = scaleRe.exec(templateBody)) !== null) {
      const sOpen = templateBody.indexOf('{', scaleMatch.index + scaleMatch[0].indexOf('{'));
      const { end: sEnd } = extractBalancedBlockFromOpenBrace(templateBody, sOpen);
      const scaleContent = templateBody.slice(sOpen + 1, sEnd - 1);

      const minM = scaleContent.match(/\bmin_replicas\s*=\s*(\d+)/);
      const maxM = scaleContent.match(/\bmax_replicas\s*=\s*(\d+)/);
      if (minM) minReplicas = minM[1];
      if (maxM) maxReplicas = maxM[1];

      // Also handle minReplicas / maxReplicas (camelCase from ARM)
      const minCamel = scaleContent.match(/\bminReplicas\s*=\s*(\d+)/);
      const maxCamel = scaleContent.match(/\bmaxReplicas\s*=\s*(\d+)/);
      if (minCamel) minReplicas = minCamel[1];
      if (maxCamel) maxReplicas = maxCamel[1];

      bodyWithoutScale = bodyWithoutScale.slice(0, scaleMatch.index) + bodyWithoutScale.slice(sEnd);
      scaleRe.lastIndex = 0; // restart after removing
      break;
    }

    // Also handle minReplicas / maxReplicas as flat args (camelCase → rename)
    bodyWithoutScale = bodyWithoutScale.replace(/\bminReplicas\s*=/g, 'min_replicas =');
    bodyWithoutScale = bodyWithoutScale.replace(/\bmaxReplicas\s*=/g, 'max_replicas =');

    // Inject min/max_replicas into template body if extracted from scale block
    if (minReplicas !== undefined && !bodyWithoutScale.includes('min_replicas')) {
      const indent = scaleMatch?.[1] || '    ';
      bodyWithoutScale = bodyWithoutScale.replace(
        /(\btemplate\s*\{)/,
        `$1\n${indent}min_replicas = ${minReplicas}`
      );
    }
    if (maxReplicas !== undefined && !bodyWithoutScale.includes('max_replicas')) {
      const indent = scaleMatch?.[1] || '    ';
      bodyWithoutScale = bodyWithoutScale.replace(
        /(\btemplate\s*\{)/,
        `$1\n${indent}max_replicas = ${maxReplicas}`
      );
    }

    out += block.slice(last, tm.index) + bodyWithoutScale;
    last = tEnd;
    templateRe.lastIndex = last;
  }

  return out + block.slice(last);
}

/**
 * Convert generic probes {} blocks to typed probe blocks (liveness_probe, readiness_probe, startup_probe).
 * ARM containers have a probes array; we map each type to the correct Terraform block name.
 */
function fixContainerAppProbesBlock(block: string): string {
  // Replace `probes {` with the correct typed block based on any "type" argument inside
  const probesRe = /\bprobes\s*\{/g;
  let out = '';
  let last = 0;
  let pm: RegExpExecArray | null;

  while ((pm = probesRe.exec(block)) !== null) {
    const pOpen = block.indexOf('{', pm.index);
    const { end: pEnd } = extractBalancedBlockFromOpenBrace(block, pOpen);
    const probeContent = block.slice(pOpen + 1, pEnd - 1);

    // Detect probe type from a `type = "Liveness"` or similar line inside
    const typeMatch = probeContent.match(/\btype\s*=\s*"?(\w+)"?/i);
    const probeType = typeMatch?.[1]?.toLowerCase();

    let blockName: string;
    if (probeType === 'liveness') blockName = 'liveness_probe';
    else if (probeType === 'readiness') blockName = 'readiness_probe';
    else if (probeType === 'startup') blockName = 'startup_probe';
    else blockName = 'liveness_probe'; // safe default

    // Remove the type = "..." line from the body since it's encoded in the block name
    let cleanedContent = probeContent.replace(/^\s*type\s*=\s*"?\w+"?\s*\n?/gm, '');

    // Liveness/startup: ARM may still list success thresholds — provider has no such args; drop them.
    if (blockName !== 'readiness_probe') {
      cleanedContent = cleanedContent
        .replace(/^\s*successThreshold\s*=\s*[^\n]+\n?/gm, '')
        .replace(/^\s*success_threshold\s*=\s*[^\n]+\n?/gm, '')
        .replace(/^\s*successCountThreshold\s*=\s*[^\n]+\n?/gm, '')
        .replace(/^\s*success_count\b(?!_threshold)\s*=\s*[^\n]+\n?/gm, '');
    }

    // Normalize probe attribute names — success_count_threshold ONLY on readiness_probe (azurerm schema)
    let fixedContent = cleanedContent
      // timeout
      .replace(/\btimeoutSeconds\s*=/g,       'timeout =')
      .replace(/\btimeout_seconds\s*=/g,      'timeout =')
      // failure threshold
      .replace(/\bfailureThreshold\s*=/g,     'failure_count_threshold =')
      .replace(/\bfailure_threshold\s*=/g,    'failure_count_threshold =')
      .replace(/\bfailureCountThreshold\s*=/g,'failure_count_threshold =')
      .replace(/\bfailure_count\b(?!_threshold)\s*=/g, 'failure_count_threshold =')
      // initial delay
      .replace(/\binitialDelaySeconds\s*=/g,  'initial_delay =')
      .replace(/\binitial_delay_seconds\s*=/g,'initial_delay =')
      // interval
      .replace(/\bperiodSeconds\s*=/g,        'interval_seconds =')
      .replace(/\bperiod_seconds\s*=/g,       'interval_seconds =')
      // httpGet/tcpSocket ARM probe spec → comment (port/path/transport are set as flat args)
      .replace(/\bhttpGet\s*\{[^}]*\}/gs,    '')
      .replace(/\btcpSocket\s*\{[^}]*\}/gs,  '');

    if (blockName === 'readiness_probe') {
      fixedContent = fixedContent
        .replace(/\bsuccessThreshold\s*=/g,     'success_count_threshold =')
        .replace(/\bsuccess_threshold\s*=/g,    'success_count_threshold =')
        .replace(/\bsuccessCountThreshold\s*=/g,'success_count_threshold =')
        .replace(/\bsuccess_count\b(?!_threshold)\s*=/g, 'success_count_threshold =');
    }

    out += block.slice(last, pm.index) + `${blockName} {${fixedContent}`;
    last = pEnd - 1; // keep the closing brace
    probesRe.lastIndex = pm.index + blockName.length + 2;
  }

  return out + block.slice(last);
}
