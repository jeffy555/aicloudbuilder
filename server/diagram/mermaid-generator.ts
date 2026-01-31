/**
 * Mermaid Syntax Generator
 * 
 * Converts resource graph to Mermaid diagram syntax.
 * Handles different diagram types and Azure-specific styling.
 */

import { TerraformResource, ResourceRelationship, ResourceGraph } from './resource-relationship-parser';

export interface MermaidOptions {
  diagramType?: 'graph' | 'flowchart' | 'C4';
  theme?: 'default' | 'dark' | 'azure';
  groupByCategory?: boolean;
  showLabels?: boolean;
}

/**
 * Generate Mermaid syntax from resource graph
 */
export function generateMermaidSyntax(
  graph: ResourceGraph,
  options: MermaidOptions = {}
): string {
  const {
    diagramType = 'graph',
    theme = 'default',
    groupByCategory = true,
    showLabels = true
  } = options;

  if (diagramType === 'C4') {
    return generateC4Diagram(graph);
  }

  // Separate Resource Groups from other resources
  const resourceGroups = graph.resources.filter(r => r.type === 'azurerm_resource_group');
  const otherResources = graph.resources.filter(r => r.type !== 'azurerm_resource_group');

  // Group resources by category if enabled
  const groupedResources = groupByCategory 
    ? groupResourcesByCategory(otherResources)
    : { all: otherResources };

  // Generate diagram syntax
  const direction = 'TB'; // Top to Bottom
  let syntax = `${diagramType} ${direction}\n`;

  // Add Resource Groups at the top (no subgraph)
  for (const resource of resourceGroups) {
    const nodeId = getNodeId(resource);
    const label = formatResourceLabel(resource, showLabels);
    syntax += `    ${nodeId}[${label}]\n`;
  }
  
  if (resourceGroups.length > 0 && otherResources.length > 0) {
    syntax += '\n';
  }

  // Add resource groups as subgraphs
  if (groupByCategory && Object.keys(groupedResources).length > 1) {
    for (const [category, resources] of Object.entries(groupedResources)) {
      if (resources.length === 0) continue;
      
      syntax += `    subgraph "${category}"\n`;
      for (const resource of resources) {
        const nodeId = getNodeId(resource);
        const label = formatResourceLabel(resource, showLabels);
        syntax += `        ${nodeId}[${label}]\n`;
      }
      syntax += `    end\n\n`;
    }
  } else {
    // Add all resources without grouping
    for (const resource of otherResources) {
      const nodeId = getNodeId(resource);
      const label = formatResourceLabel(resource, showLabels);
      syntax += `    ${nodeId}[${label}]\n`;
    }
    syntax += '\n';
  }

  // Filter relationships to only show meaningful ones
  // Remove redundant "contains" relationships going backwards
  const meaningfulRelationships = graph.relationships.filter(rel => {
    // Skip if it's a "contains" relationship going from child to parent
    if (rel.type === 'contains' && rel.from.includes('resource_group') === false) {
      return false;
    }
    // Only show dependencies and uses, not redundant containment
    return rel.type === 'depends_on' || rel.type === 'uses' || 
           (rel.type === 'contains' && rel.from.includes('resource_group'));
  });

  // Add relationships (only meaningful ones)
  for (const rel of meaningfulRelationships) {
    const fromId = getNodeIdFromReference(rel.from);
    const toId = getNodeIdFromReference(rel.to);
    
    if (fromId && toId) {
      // Only show labels for dependencies and uses, not for containment
      const edgeLabel = showLabels && rel.description && rel.type !== 'contains'
        ? `|${rel.description}|` 
        : '';
      syntax += `    ${fromId} -->${edgeLabel} ${toId}\n`;
    }
  }

  // Apply Azure styling if theme is Azure
  if (theme === 'azure') {
    syntax = applyAzureStyling(syntax, graph.resources);
  }

  return syntax;
}

/**
 * Generate C4-style diagram
 */
function generateC4Diagram(graph: ResourceGraph): string {
  let syntax = 'C4Container\n';
  syntax += '    title Architecture Diagram\n\n';

  // Add resources as containers
  for (const resource of graph.resources) {
    const nodeId = getNodeId(resource);
    const label = formatResourceLabel(resource, true);
    const tech = getResourceTechnology(resource.type);
    
    syntax += `    Container(${nodeId}, "${label}", "${tech}", "Terraform resource")\n`;
  }

  syntax += '\n';

  // Add relationships
  for (const rel of graph.relationships) {
    const fromId = getNodeIdFromReference(rel.from);
    const toId = getNodeIdFromReference(rel.to);
    
    if (fromId && toId) {
      const label = rel.description || 'Uses';
      syntax += `    Rel(${fromId}, ${toId}, "${label}")\n`;
    }
  }

  return syntax;
}

/**
 * Group resources by category
 */
function groupResourcesByCategory(resources: TerraformResource[]): Record<string, TerraformResource[]> {
  const groups: Record<string, TerraformResource[]> = {
    'Compute': [],
    'Storage': [],
    'Networking': [],
    'Database': [],
    'Security': [],
    'Other': []
  };

  for (const resource of resources) {
    const category = getResourceCategory(resource.type);
    if (!groups[category]) {
      groups['Other'] = groups['Other'] || [];
      groups['Other'].push(resource);
    } else {
      groups[category].push(resource);
    }
  }

  // Remove empty categories
  Object.keys(groups).forEach(key => {
    if (groups[key].length === 0) {
      delete groups[key];
    }
  });

  return groups;
}

/**
 * Get resource category based on type
 */
function getResourceCategory(resourceType: string): string {
  if (resourceType.includes('app_service') || 
      resourceType.includes('function_app') ||
      resourceType.includes('container_instance') ||
      resourceType.includes('kubernetes') ||
      resourceType.includes('vm') ||
      resourceType.includes('virtual_machine')) {
    return 'Compute';
  }

  if (resourceType.includes('storage') ||
      resourceType.includes('blob') ||
      resourceType.includes('file_share')) {
    return 'Storage';
  }

  if (resourceType.includes('virtual_network') ||
      resourceType.includes('subnet') ||
      resourceType.includes('network_security_group') ||
      resourceType.includes('load_balancer') ||
      resourceType.includes('public_ip')) {
    return 'Networking';
  }

  if (resourceType.includes('sql') ||
      resourceType.includes('database') ||
      resourceType.includes('cosmosdb') ||
      resourceType.includes('postgresql') ||
      resourceType.includes('mysql')) {
    return 'Database';
  }

  if (resourceType.includes('key_vault') ||
      resourceType.includes('role_assignment') ||
      resourceType.includes('managed_identity')) {
    return 'Security';
  }

  return 'Other';
}

/**
 * Get resource technology name
 */
function getResourceTechnology(resourceType: string): string {
  // Extract technology from resource type
  // azurerm_storage_account -> Storage Account
  const parts = resourceType.replace('azurerm_', '').split('_');
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

/**
 * Format resource label for diagram
 */
function formatResourceLabel(resource: TerraformResource, showDetails: boolean): string {
  const typeName = getResourceTechnology(resource.type);
  
  if (showDetails) {
    return `${typeName}<br/>${resource.name}`;
  }
  
  return resource.name;
}

/**
 * Get node ID from resource
 */
function getNodeId(resource: TerraformResource): string {
  // Create safe node ID: azurerm_storage_account_stg_main
  return `${resource.type}_${resource.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Get node ID from resource reference
 */
function getNodeIdFromReference(reference: string): string | null {
  // reference format: azurerm_resource_group.rg_main
  const match = reference.match(/(azurerm_\w+)\.(\w+)/);
  if (match) {
    const [, type, name] = match;
    return `${type}_${name}`.replace(/[^a-zA-Z0-9_]/g, '_');
  }
  return null;
}

/**
 * Apply Azure-specific styling
 */
function applyAzureStyling(syntax: string, resources: TerraformResource[]): string {
  // Add styling directives (Mermaid supports classDef)
  let styledSyntax = syntax;
  
  // Add class definitions for different resource types
  styledSyntax += '\n    %% Azure Styling\n';
  
  const computeResources = resources.filter(r => 
    r.type.includes('app_service') || r.type.includes('function_app')
  );
  if (computeResources.length > 0) {
    styledSyntax += '    classDef compute fill:#0078d4,stroke:#005a9e,stroke-width:2px,color:#fff\n';
  }

  const storageResources = resources.filter(r => 
    r.type.includes('storage')
  );
  if (storageResources.length > 0) {
    styledSyntax += '    classDef storage fill:#ff6b35,stroke:#d84315,stroke-width:2px,color:#fff\n';
  }

  const networkResources = resources.filter(r => 
    r.type.includes('virtual_network') || r.type.includes('subnet')
  );
  if (networkResources.length > 0) {
    styledSyntax += '    classDef network fill:#00bcf2,stroke:#0097a7,stroke-width:2px,color:#fff\n';
  }

  const resourceGroupResources = resources.filter(r => 
    r.type.includes('resource_group')
  );
  if (resourceGroupResources.length > 0) {
    styledSyntax += '    classDef resourceGroup fill:#107c10,stroke:#0e6b0e,stroke-width:2px,color:#fff\n';
  }

  // Apply classes to nodes
  for (const resource of resources) {
    const nodeId = getNodeId(resource);
    const category = getResourceCategory(resource.type);
    
    if (resource.type.includes('resource_group')) {
      styledSyntax += `    class ${nodeId} resourceGroup\n`;
    } else if (category === 'Compute') {
      styledSyntax += `    class ${nodeId} compute\n`;
    } else if (category === 'Storage') {
      styledSyntax += `    class ${nodeId} storage\n`;
    } else if (category === 'Networking') {
      styledSyntax += `    class ${nodeId} network\n`;
    }
  }

  return styledSyntax;
}

