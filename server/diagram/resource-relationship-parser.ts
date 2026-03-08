/**
 * Resource Relationship Parser
 *
 * Parses Terraform files to extract resources and their relationships.
 * Detects dependencies like resource_group_name, app_service_plan_id, etc.
 */

import { buildVariableMap } from '../terraform-variable-resolver';
import {
  AZURE_CORE_TYPES,
  MODULE_KEYWORD_RESOURCE_MAP,
  RELATIONSHIP_PATTERNS,
} from '../config/azure-catalog.js';
import {
  TERRAFORM_FILE_EXTENSIONS,
  LOCAL_MODULE_PATH,
  AZURE_RESOURCE_TYPE_PATTERN,
  DIRECT_RESOURCE_REF_PATTERN,
  REGISTRY_MODULE_PATTERN,
} from '../config/terraform-patterns.js';
import { lookupRegistryModule } from './registry-module-catalog.js';

export interface TerraformResource {
  type: string;           // e.g., "azurerm_resource_group"
  name: string;          // e.g., "rg_main"
  file: string;          // File where resource is defined
  attributes: Record<string, any>; // Resource attributes
  lineNumber?: number;   // Line number in file
}

export interface ResourceRelationship {
  from: string;           // e.g., "azurerm_resource_group.rg_main"
  to: string;            // e.g., "azurerm_storage_account.stg_main"
  type: 'contains' | 'uses' | 'depends_on' | 'references';
  attribute?: string;    // Attribute that creates the relationship
  description?: string;  // Human-readable description
}

export interface ResourceGraph {
  resources: TerraformResource[];
  relationships: ResourceRelationship[];
  resourceGroups: string[]; // List of resource group names
  warnings: string[];       // Non-fatal issues (e.g., circular dependencies)
}

/**
 * Parse Terraform files to extract all resources and modules
 */
export function parseResources(
  files: Array<{ fileName: string; content: string }>
): TerraformResource[] {
  const resources: TerraformResource[] = [];

  for (const file of files) {
    if (!file.fileName.endsWith(TERRAFORM_FILE_EXTENSIONS.HCL)) continue;

    const content = file.content;
    const lines = content.split('\n');

    // Match: resource "type" "name" { ... }
    const resourceRegex = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
    let match;

    while ((match = resourceRegex.exec(content)) !== null) {
      const resourceType = match[1];
      const resourceName = match[2];
      const startPos = match.index;
      
      // Calculate line number
      const lineNumber = content.substring(0, startPos).split('\n').length;

      // Extract resource block (handle nested braces)
      const openBracePos = match.index + match[0].length - 1;
      let braceCount = 1;
      let pos = openBracePos + 1;
      let inString = false;
      let stringChar = '';

      while (pos < content.length && braceCount > 0) {
        const char = content[pos];

        if (!inString) {
          if (char === '"' || char === "'") {
            inString = true;
            stringChar = char;
          } else if (char === '{') {
            braceCount++;
          } else if (char === '}') {
            braceCount--;
          }
        } else {
          if (char === stringChar && content[pos - 1] !== '\\') {
            inString = false;
          }
        }
        pos++;
      }

      if (braceCount === 0) {
        const resourceBody = content.substring(openBracePos + 1, pos - 1);
        const attributes = parseResourceAttributes(resourceBody);

        resources.push({
          type: resourceType,
          name: resourceName,
          file: file.fileName,
          attributes,
          lineNumber
        });
      }
    }

    // Also parse module calls: module "name" { ... }
    // For aggregated-root modules, these represent resources
    const moduleRegex = /module\s+"([^"]+)"\s*\{/g;
    let moduleMatch;

    while ((moduleMatch = moduleRegex.exec(content)) !== null) {
      const moduleName = moduleMatch[1];
      const startPos = moduleMatch.index;
      
      // Calculate line number
      const lineNumber = content.substring(0, startPos).split('\n').length;

      // Extract module block (handle nested braces)
      const openBracePos = moduleMatch.index + moduleMatch[0].length - 1;
      let braceCount = 1;
      let pos = openBracePos + 1;
      let inString = false;
      let stringChar = '';

      while (pos < content.length && braceCount > 0) {
        const char = content[pos];

        if (!inString) {
          if (char === '"' || char === "'") {
            inString = true;
            stringChar = char;
          } else if (char === '{') {
            braceCount++;
          } else if (char === '}') {
            braceCount--;
          }
        } else {
          if (char === stringChar && content[pos - 1] !== '\\') {
            inString = false;
          }
        }
        pos++;
      }

      if (braceCount === 0) {
        const moduleBody = content.substring(openBracePos + 1, pos - 1);
        const attributes = parseResourceAttributes(moduleBody);
        
        // Extract source to infer resource type
        const sourceMatch = moduleBody.match(/source\s*=\s*["']([^"']+)["']/);
        const source = sourceMatch ? sourceMatch[1] : '';

        // Fix #2: Try to infer type by inspecting the actual source module files first,
        // then fall back to keyword-guessing from the call-site module name/source path.
        const inferredType =
          inferTypeFromSourceFiles(source, files) ||
          inferTypeFromKeywords(moduleName, source);

        resources.push({
          type: inferredType,
          name: moduleName,
          file: file.fileName,
          attributes: {
            ...attributes,
            source: source,
            isModule: true
          },
          lineNumber
        });
      }
    }
  }

  return resources;
}

/**
 * Parse resource attributes from resource body
 */
function parseResourceAttributes(body: string): Record<string, any> {
  const attributes: Record<string, any> = {};

  // Match: attribute = "value" or attribute = value
  const attrRegex = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*([^\s\n]+)/g;
  let match;

  while ((match = attrRegex.exec(body)) !== null) {
    const key = match[1] || match[3];
    const value = match[2] || match[4];
    
    // Handle references like azurerm_resource_group.rg.name
    if (value && (value.includes('.') || value.startsWith('var.') || value.startsWith('data.'))) {
      attributes[key] = value;
    } else {
      attributes[key] = value;
    }
  }

  return attributes;
}

/**
 * Detect relationships between resources
 */
export function detectRelationships(
  resources: TerraformResource[],
  files: Array<{ fileName: string; content: string }>
): ResourceRelationship[] {
  const relationships: ResourceRelationship[] = [];

  // Build O(1) lookup maps — eliminates the O(n) linear scan inside findReferencedResource
  const resourceMap = new Map<string, TerraformResource>();
  const nameIndex = new Map<string, TerraformResource>();
  resources.forEach(r => {
    resourceMap.set(`${r.type}.${r.name}`, r);
    nameIndex.set(r.name, r);
  });

  // Relationship patterns loaded from central catalog (azure-catalog.ts)
  const relationshipPatterns = RELATIONSHIP_PATTERNS;

  // Track relationships to avoid duplicates
  const relationshipSet = new Set<string>();

  // Detect relationships based on attributes
  for (const resource of resources) {
    // Skip Resource Group for now - handle it separately
    if (resource.type === AZURE_CORE_TYPES.RESOURCE_GROUP) continue;

    for (const pattern of relationshipPatterns) {
      // resource_group_name containment is handled by the special RG loop below.
      // Processing it here too would create reversed (SA→RG) edges that conflict
      // with the correct (RG→SA) direction, producing false circular dependency warnings.
      if (pattern.attribute === 'resource_group_name') continue;

      const attributeValue = resource.attributes[pattern.attribute];
      
      if (attributeValue) {
        // Check if it's a reference to another resource (O(1) via pre-built indices)
        const referencedResource = findReferencedResource(attributeValue, resourceMap, nameIndex);
        
        if (referencedResource) {
          // Create relationship key to avoid duplicates
          const relKey = `${resource.type}.${resource.name}->${referencedResource.type}.${referencedResource.name}`;
          
          if (!relationshipSet.has(relKey)) {
            relationshipSet.add(relKey);
            relationships.push({
              from: `${resource.type}.${resource.name}`,
              to: `${referencedResource.type}.${referencedResource.name}`,
              type: pattern.type,
              attribute: pattern.attribute,
              description: pattern.description
            });
          }
        }
      }
    }
  }

  // Special case: Resource Group contains all other resources.
  // Build an inverted index: rg name → resources that reference it (O(n) total instead of O(rg×n))
  const rgMembership = new Map<string, TerraformResource[]>();
  for (const resource of resources) {
    if (resource.type === AZURE_CORE_TYPES.RESOURCE_GROUP) continue;
    const rawRgRef = resource.attributes.resource_group_name;
    if (!rawRgRef) continue;
    const rgName = extractResourceName(rawRgRef);
    if (!rgMembership.has(rgName)) rgMembership.set(rgName, []);
    rgMembership.get(rgName)!.push(resource);
  }

  for (const resource of resources) {
    if (resource.type !== AZURE_CORE_TYPES.RESOURCE_GROUP) continue;
    const members = rgMembership.get(resource.name) ?? [];
    for (const otherResource of members) {
      const relKey = `${resource.type}.${resource.name}->${otherResource.type}.${otherResource.name}`;
      if (!relationshipSet.has(relKey)) {
        relationshipSet.add(relKey);
        relationships.push({
          from: `${resource.type}.${resource.name}`,
          to: `${otherResource.type}.${otherResource.name}`,
          type: 'contains',
          attribute: 'resource_group_name',
          description: undefined
        });
      }
    }
  }

  return relationships;
}

/**
 * Find referenced resource from attribute value.
 * Uses pre-built O(1) lookup maps to avoid O(n) linear scans.
 */
function findReferencedResource(
  attributeValue: string,
  resourceMap: Map<string, TerraformResource>,
  nameIndex: Map<string, TerraformResource>
): TerraformResource | null {
  if (!attributeValue) return null;

  // Handle direct references: azurerm_resource_group.rg.name → O(1)
  const directRefMatch = attributeValue.match(DIRECT_RESOURCE_REF_PATTERN);
  if (directRefMatch) {
    const [, resourceType, resourceName] = directRefMatch;
    return resourceMap.get(`${resourceType}.${resourceName}`) || null;
  }

  // Handle variable references: var.resource_group_name → O(1) via nameIndex
  if (attributeValue.startsWith('var.')) {
    const varName = attributeValue.replace('var.', '');
    return nameIndex.get(varName) || null;
  }

  // Handle plain string values that match a resource name exactly → O(1)
  const cleanValue = attributeValue.replace(/["']/g, '').trim();
  return nameIndex.get(cleanValue) || null;
}

/**
 * Extract resource name from reference
 */
function extractResourceName(reference: string): string {
  // Handle: azurerm_resource_group.rg.name
  const match = reference.match(/(?:azurerm_\w+\.)?(\w+)(?:\.\w+)?/);
  return match ? match[1] : reference.replace(/["']/g, '').trim();
}

/**
 * Infer module resource type by inspecting the actual source files.
 * Counts azurerm_* resource blocks across all files that share the module dir name.
 * Returns the most frequent type, or null if the source isn't a local path or no files match.
 */
/**
 * Inspect the module's source .tf files to infer the dominant resource type.
 * Returns null when source is not a local relative path or no matching files exist.
 */
function inferTypeFromSourceFiles(
  source: string,
  files: Array<{ fileName: string; content: string }>
): string | null {
  if (!LOCAL_MODULE_PATH.test(source)) return null;

  // Last path segment is the module directory name (e.g. "./modules/network" → "network")
  const segments = source.replace(/\\/g, '/').split('/').filter(Boolean);
  const moduleDirName = segments[segments.length - 1];
  if (!moduleDirName) return null;

  const moduleFiles = files.filter(
    f => f.fileName.includes(moduleDirName) && f.fileName.endsWith(TERRAFORM_FILE_EXTENSIONS.HCL)
  );
  if (moduleFiles.length === 0) return null;

  const typeCounts = new Map<string, number>();
  for (const file of moduleFiles) {
    // Reset lastIndex — AZURE_RESOURCE_TYPE_PATTERN is a global-flag regex
    AZURE_RESOURCE_TYPE_PATTERN.lastIndex = 0;
    let m;
    while ((m = AZURE_RESOURCE_TYPE_PATTERN.exec(file.content)) !== null) {
      typeCounts.set(m[1], (typeCounts.get(m[1]) ?? 0) + 1);
    }
  }
  if (typeCounts.size === 0) return null;

  let dominantType = '';
  let maxCount = 0;
  typeCounts.forEach((count, type) => {
    if (count > maxCount) { maxCount = count; dominantType = type; }
  });
  return dominantType || null;
}

/**
 * Module type inference for non-local sources.
 * Lookup order:
 *   1. Known registry module catalog (instant, no network)
 *   2. Keyword heuristics from MODULE_KEYWORD_RESOURCE_MAP
 *
 * The registry catalog is checked first so that well-known public modules
 * (e.g. "Azure/network/azurerm") resolve correctly without keyword guessing.
 */
function inferTypeFromKeywords(moduleName: string, source: string): string {
  // 1. Registry catalog hit — fast, no network required
  if (source && REGISTRY_MODULE_PATTERN.test(source)) {
    const catalogHit = lookupRegistryModule(source);
    if (catalogHit) return catalogHit;
  }

  // 2. Keyword heuristics
  const combined = `${moduleName} ${source}`.toLowerCase();
  for (const [keyword, resourceType] of MODULE_KEYWORD_RESOURCE_MAP) {
    if (combined.includes(keyword)) return resourceType;
  }
  return `module.${moduleName}`;
}

/**
 * Detect circular dependencies in the relationship graph using DFS.
 * Returns an array of human-readable cycle descriptions, e.g. ["A → B → A"].
 * An empty array means no cycles were found.
 */
function detectCircularDependencies(relationships: ResourceRelationship[]): string[] {
  // Build adjacency list (directed graph)
  const graph = new Map<string, string[]>();
  for (const rel of relationships) {
    if (!graph.has(rel.from)) graph.set(rel.from, []);
    graph.get(rel.from)!.push(rel.to);
  }

  const visited  = new Set<string>();
  const inStack  = new Set<string>();
  const cycles: string[] = [];

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      // node appears in the current DFS path — cycle found
      const cycleStart = path.indexOf(node);
      const cycle = [...path.slice(cycleStart), node].join(' → ');
      if (!cycles.includes(cycle)) cycles.push(cycle);
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);

    for (const neighbour of graph.get(node) || []) {
      dfs(neighbour, [...path, node]);
    }

    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) dfs(node, []);
  }

  return cycles;
}

/**
 * Build complete resource graph
 */
export function buildResourceGraph(
  files: Array<{ fileName: string; content: string }>
): ResourceGraph {
  // Fix #1: Build variable map first so var.* references in attributes can be resolved
  // before relationship detection runs. Without this, modular configs that pass
  // resource_group_name = var.rg_name show zero relationships.
  const variableMap = buildVariableMap(files);

  const resources = parseResources(files);

  // Resolve all var.* attribute values now that we have the variable map
  for (const resource of resources) {
    for (const [key, value] of Object.entries(resource.attributes)) {
      if (typeof value === 'string' && value.startsWith('var.')) {
        const varName = value.slice(4); // strip "var."
        if (varName in variableMap) {
          resource.attributes[key] = variableMap[varName];
        }
      }
    }
  }

  const relationships = detectRelationships(resources, files);

  // Detect circular dependencies before returning — callers can surface these as warnings
  const cycles = detectCircularDependencies(relationships);
  const warnings = cycles.map(c => `Circular dependency detected: ${c}`);

  // Extract resource groups
  const resourceGroups = resources
    .filter(r => r.type === AZURE_CORE_TYPES.RESOURCE_GROUP)
    .map(r => r.name);

  return {
    resources,
    relationships,
    resourceGroups,
    warnings,
  };
}

