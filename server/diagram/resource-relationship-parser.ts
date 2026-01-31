/**
 * Resource Relationship Parser
 * 
 * Parses Terraform files to extract resources and their relationships.
 * Detects dependencies like resource_group_name, app_service_plan_id, etc.
 */

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
}

/**
 * Parse Terraform files to extract all resources and modules
 */
export function parseResources(
  files: Array<{ fileName: string; content: string }>
): TerraformResource[] {
  const resources: TerraformResource[] = [];

  for (const file of files) {
    if (!file.fileName.endsWith('.tf')) continue;

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
        
        // Try to infer resource type from module name or source
        // Common patterns: storage_account -> azurerm_storage_account, etc.
        let inferredType = 'module';
        if (moduleName.includes('storage') || source.includes('storage')) {
          inferredType = 'azurerm_storage_account';
        } else if (moduleName.includes('app_service') || source.includes('app-service')) {
          inferredType = 'azurerm_app_service';
        } else if (moduleName.includes('container') || source.includes('container')) {
          inferredType = 'azurerm_container_group';
        } else if (moduleName.includes('function') || source.includes('function')) {
          inferredType = 'azurerm_function_app';
        } else if (moduleName.includes('key_vault') || source.includes('key-vault')) {
          inferredType = 'azurerm_key_vault';
        } else if (moduleName.includes('sql') || source.includes('sql')) {
          inferredType = 'azurerm_sql_server';
        } else if (moduleName.includes('cosmos') || source.includes('cosmos')) {
          inferredType = 'azurerm_cosmosdb_account';
        } else if (moduleName.includes('redis') || source.includes('redis')) {
          inferredType = 'azurerm_redis_cache';
        } else if (moduleName.includes('eventhub') || source.includes('eventhub')) {
          inferredType = 'azurerm_eventhub_namespace';
        } else if (moduleName.includes('servicebus') || source.includes('servicebus')) {
          inferredType = 'azurerm_servicebus_namespace';
        } else {
          // Use module name as type prefix
          inferredType = `module.${moduleName}`;
        }

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

  // Create a map of resource references for quick lookup
  const resourceMap = new Map<string, TerraformResource>();
  resources.forEach(r => {
    const key = `${r.type}.${r.name}`;
    resourceMap.set(key, r);
  });

  // Common relationship patterns
  const relationshipPatterns = [
    // Azure Resource Group relationships
    {
      attribute: 'resource_group_name',
      type: 'contains' as const,
      description: 'Resource is contained in Resource Group'
    },
    // App Service relationships
    {
      attribute: 'app_service_plan_id',
      type: 'depends_on' as const,
      description: 'App Service depends on App Service Plan'
    },
    // Storage relationships
    {
      attribute: 'storage_account_name',
      type: 'uses' as const,
      description: 'Resource uses Storage Account'
    },
    // Network relationships
    {
      attribute: 'subnet_id',
      type: 'uses' as const,
      description: 'Resource uses Subnet'
    },
    {
      attribute: 'virtual_network_id',
      type: 'uses' as const,
      description: 'Resource uses Virtual Network'
    },
    {
      attribute: 'network_security_group_id',
      type: 'uses' as const,
      description: 'Resource uses Network Security Group'
    },
    // Database relationships
    {
      attribute: 'server_name',
      type: 'depends_on' as const,
      description: 'Resource depends on Database Server'
    },
    // Container relationships
    {
      attribute: 'container_registry_name',
      type: 'uses' as const,
      description: 'Resource uses Container Registry'
    },
    // Key Vault relationships
    {
      attribute: 'key_vault_id',
      type: 'uses' as const,
      description: 'Resource uses Key Vault'
    }
  ];

  // Track relationships to avoid duplicates
  const relationshipSet = new Set<string>();

  // Detect relationships based on attributes
  for (const resource of resources) {
    // Skip Resource Group for now - handle it separately
    if (resource.type === 'azurerm_resource_group') continue;

    for (const pattern of relationshipPatterns) {
      const attributeValue = resource.attributes[pattern.attribute];
      
      if (attributeValue) {
        // Check if it's a reference to another resource
        const referencedResource = findReferencedResource(attributeValue, resourceMap, resources);
        
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

  // Special case: Resource Group contains all other resources (only one direction)
  for (const resource of resources) {
    if (resource.type === 'azurerm_resource_group') {
      // Find all resources that reference this resource group
      for (const otherResource of resources) {
        if (otherResource.type !== 'azurerm_resource_group' && 
            otherResource.attributes.resource_group_name) {
          const rgName = extractResourceName(otherResource.attributes.resource_group_name);
          if (rgName === resource.name || otherResource.attributes.resource_group_name.includes(resource.name)) {
            // Only add if not already added (avoid duplicates)
            const relKey = `${resource.type}.${resource.name}->${otherResource.type}.${otherResource.name}`;
            if (!relationshipSet.has(relKey)) {
              relationshipSet.add(relKey);
              relationships.push({
                from: `${resource.type}.${resource.name}`,
                to: `${otherResource.type}.${otherResource.name}`,
                type: 'contains',
                attribute: 'resource_group_name',
                description: undefined // No label for containment - it's implied by hierarchy
              });
            }
          }
        }
      }
    }
  }

  return relationships;
}

/**
 * Find referenced resource from attribute value
 */
function findReferencedResource(
  attributeValue: string,
  resourceMap: Map<string, TerraformResource>,
  allResources: TerraformResource[]
): TerraformResource | null {
  if (!attributeValue) return null;

  // Handle direct references: azurerm_resource_group.rg.name
  const directRefMatch = attributeValue.match(/(azurerm_\w+)\.(\w+)/);
  if (directRefMatch) {
    const [, resourceType, resourceName] = directRefMatch;
    const key = `${resourceType}.${resourceName}`;
    return resourceMap.get(key) || null;
  }

  // Handle variable references: var.resource_group_name
  // In this case, we need to check if any resource matches
  if (attributeValue.startsWith('var.')) {
    const varName = attributeValue.replace('var.', '');
    // Try to find resource by name pattern
    for (const resource of allResources) {
      if (resource.name.includes(varName) || varName.includes(resource.name)) {
        return resource;
      }
    }
  }

  // Handle string values that might match resource names
  const cleanValue = attributeValue.replace(/["']/g, '').trim();
  for (const resource of allResources) {
    if (resource.name === cleanValue || cleanValue.includes(resource.name)) {
      return resource;
    }
  }

  return null;
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
 * Build complete resource graph
 */
export function buildResourceGraph(
  files: Array<{ fileName: string; content: string }>
): ResourceGraph {
  const resources = parseResources(files);
  const relationships = detectRelationships(resources, files);
  
  // Extract resource groups
  const resourceGroups = resources
    .filter(r => r.type === 'azurerm_resource_group')
    .map(r => r.name);

  return {
    resources,
    relationships,
    resourceGroups
  };
}

