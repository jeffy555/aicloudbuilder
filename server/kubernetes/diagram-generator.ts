import yaml from 'js-yaml';
import OpenAI from 'openai';
import { convertToDiagramType, DiagramType } from '../diagram/diagram-type-generator';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface KubernetesResource {
  kind: string;
  name: string;
  namespace?: string;
  file: string;
}

export interface KubernetesRelationship {
  from: string;
  to: string;
  type: string;
  description?: string;
}

export interface DiagramResult {
  success: boolean;
  mermaidSyntax: string;
  resources: KubernetesResource[];
  relationships: KubernetesRelationship[];
  metadata: {
    totalResources: number;
    totalRelationships: number;
    resourceTypes: string[];
  };
}

/**
 * Parse Kubernetes YAML to extract resources
 */
function parseKubernetesResources(manifests: string[]): KubernetesResource[] {
  const resources: KubernetesResource[] = [];

  manifests.forEach((manifest, index) => {
    try {
      const parsed = yaml.load(manifest) as any;
      if (parsed && parsed.kind && parsed.metadata) {
        resources.push({
          kind: parsed.kind,
          name: parsed.metadata.name || `${parsed.kind.toLowerCase()}-${index}`,
          namespace: parsed.metadata.namespace || 'default',
          file: `resource-${index}.yaml`,
        });
      }
    } catch (error) {
      console.warn(`⚠️  Failed to parse manifest ${index}:`, error);
    }
  });

  return resources;
}

/**
 * Extract relationships from Kubernetes resources
 */
function extractRelationships(
  manifests: string[],
  resources: KubernetesResource[]
): KubernetesRelationship[] {
  const relationships: KubernetesRelationship[] = [];
  const resourceMap = new Map<string, KubernetesResource>();
  resources.forEach(r => {
    resourceMap.set(`${r.kind}:${r.name}`, r);
  });

  manifests.forEach((manifest, index) => {
    try {
      const parsed = yaml.load(manifest) as any;
      if (!parsed || !parsed.kind || !parsed.metadata) return;

      const currentResource = resources[index];
      if (!currentResource) return;

      // Deployment -> Pods (via replicas)
      if (parsed.kind === 'Deployment' && parsed.spec?.replicas) {
        const replicaCount = parsed.spec.replicas;
        for (let i = 1; i <= Math.min(replicaCount, 3); i++) {
          relationships.push({
            from: `${currentResource.kind}:${currentResource.name}`,
            to: `Pod:${currentResource.name}-pod-${i}`,
            type: 'manages',
            description: `Manages ${replicaCount} pod(s)`,
          });
        }
      }

      // Service -> Pods (via selectors)
      if (parsed.kind === 'Service' && parsed.spec?.selector) {
        const selector = parsed.spec.selector;
        // Find matching deployments/pods
        resources.forEach(resource => {
          if (resource.kind === 'Deployment' || resource.kind === 'Pod') {
            // Simple matching - in real scenario, would check labels
            relationships.push({
              from: `${currentResource.kind}:${currentResource.name}`,
              to: `${resource.kind}:${resource.name}`,
              type: 'exposes',
              description: 'Exposes pods via selectors',
            });
          }
        });
      }

      // Pod -> ConfigMap/Secret (via volume mounts)
      if (parsed.kind === 'Pod' && parsed.spec?.volumes) {
        parsed.spec.volumes.forEach((volume: any) => {
          if (volume.configMap) {
            const configMapName = volume.configMap.name;
            const configMap = resources.find(r => r.kind === 'ConfigMap' && r.name === configMapName);
            if (configMap) {
              relationships.push({
                from: `${currentResource.kind}:${currentResource.name}`,
                to: `${configMap.kind}:${configMap.name}`,
                type: 'uses',
                description: 'Mounts ConfigMap',
              });
            }
          }
          if (volume.secret) {
            const secretName = volume.secret.secretName;
            const secret = resources.find(r => r.kind === 'Secret' && r.name === secretName);
            if (secret) {
              relationships.push({
                from: `${currentResource.kind}:${currentResource.name}`,
                to: `${secret.kind}:${secret.name}`,
                type: 'uses',
                description: 'Mounts Secret',
              });
            }
          }
        });
      }

      // Ingress -> Service
      if (parsed.kind === 'Ingress' && parsed.spec?.rules) {
        parsed.spec.rules.forEach((rule: any) => {
          if (rule.http?.paths) {
            rule.http.paths.forEach((path: any) => {
              const serviceName = path.backend?.service?.name;
              const service = resources.find(r => r.kind === 'Service' && r.name === serviceName);
              if (service) {
                relationships.push({
                  from: `${currentResource.kind}:${currentResource.name}`,
                  to: `${service.kind}:${service.name}`,
                  type: 'routes-to',
                  description: 'Routes traffic to service',
                });
              }
            });
          }
        });
      }
    } catch (error) {
      console.warn(`⚠️  Failed to extract relationships from manifest ${index}:`, error);
    }
  });

  return relationships;
}

/**
 * Sanitize namespace name for Mermaid (avoid reserved keywords)
 */
function sanitizeNamespaceId(namespace: string): string {
  // Mermaid reserved keywords that cannot be used as subgraph IDs
  const reservedKeywords = new Set([
    'default', 'graph', 'TB', 'TD', 'BT', 'RL', 'LR', 'end', 'subgraph',
    'classDef', 'class', 'style', 'linkStyle', 'click'
  ]);
  
  // Replace non-alphanumeric with underscore
  let sanitized = namespace.replace(/[^a-zA-Z0-9]/g, '_');
  
  // If it's a reserved keyword, prefix with 'ns_'
  if (reservedKeywords.has(sanitized.toLowerCase())) {
    sanitized = 'ns_' + sanitized;
  }
  
  // Ensure it doesn't start with a number
  if (/^\d/.test(sanitized)) {
    sanitized = 'ns_' + sanitized;
  }
  
  return sanitized;
}

/**
 * Sanitize node ID for Mermaid (ensure valid identifier)
 */
function sanitizeNodeId(id: string): string {
  if (!id || typeof id !== 'string') {
    return 'node';
  }
  
  // Remove newlines, carriage returns, and other whitespace characters
  let sanitized = id.replace(/[\n\r\t\s]/g, '_');
  
  // Replace all non-alphanumeric with underscore
  sanitized = sanitized.replace(/[^a-zA-Z0-9_]/g, '_');
  
  // Remove leading/trailing underscores
  sanitized = sanitized.replace(/^_+|_+$/g, '');
  
  // Replace multiple consecutive underscores with single underscore
  sanitized = sanitized.replace(/_+/g, '_');
  
  // Ensure it doesn't start with a number
  if (/^\d/.test(sanitized)) {
    sanitized = 'node_' + sanitized;
  }
  
  // Ensure it's not empty
  if (!sanitized || sanitized.length === 0) {
    sanitized = 'node';
  }
  
  // Limit length to avoid issues
  if (sanitized.length > 50) {
    sanitized = sanitized.substring(0, 50);
  }
  
  return sanitized;
}

/**
 * Generate Mermaid diagram syntax from Kubernetes resources
 */
function generateMermaidSyntax(
  resources: KubernetesResource[],
  relationships: KubernetesRelationship[]
): string {
  let syntax = 'graph TB\n';

  // Track all node IDs for consistency
  const allNodeIds = new Set<string>();
  
  // Group resources by namespace
  const resourcesByNamespace = new Map<string, KubernetesResource[]>();
  resources.forEach(r => {
    const ns = r.namespace || 'default';
    if (!resourcesByNamespace.has(ns)) {
      resourcesByNamespace.set(ns, []);
    }
    resourcesByNamespace.get(ns)!.push(r);
    // Track node ID
    const nodeId = sanitizeNodeId(`${r.kind}_${r.name}`);
    allNodeIds.add(nodeId);
  });

  // Create subgraphs for namespaces
  resourcesByNamespace.forEach((nsResources, namespace) => {
    const safeNamespaceId = sanitizeNamespaceId(namespace);
    syntax += `    subgraph ${safeNamespaceId}["Namespace: ${namespace}"]\n`;
    syntax += `        direction TB\n`;

    // Group by resource type
    const byKind = new Map<string, KubernetesResource[]>();
    nsResources.forEach(r => {
      if (!byKind.has(r.kind)) {
        byKind.set(r.kind, []);
      }
      byKind.get(r.kind)!.push(r);
    });

    // Add resources
    byKind.forEach((kindResources, kind) => {
      kindResources.forEach(resource => {
        const nodeId = sanitizeNodeId(`${resource.kind}_${resource.name}`);
        // Sanitize label to avoid issues with quotes and special characters
        const label = `${resource.kind}: ${resource.name}`.replace(/"/g, "'").replace(/\n/g, ' ');
        syntax += `        ${nodeId}["${label}"]\n`;
      });
    });

    syntax += `    end\n\n`;
  });

  // Add relationships (only for resources that exist)
  syntax += `    %% Relationships\n`;
  const existingNodeIds = new Set(allNodeIds);

  relationships.forEach(rel => {
    const fromParts = rel.from.split(':');
    const toParts = rel.to.split(':');
    const fromId = sanitizeNodeId(`${fromParts[0]}_${fromParts[1]}`);
    const toId = sanitizeNodeId(`${toParts[0]}_${toParts[1]}`);
    
    // Only add relationship if both nodes exist
    if (existingNodeIds.has(fromId) && existingNodeIds.has(toId)) {
      const label = (rel.description || rel.type).replace(/"/g, "'").replace(/\n/g, ' '); // Escape quotes and newlines in labels
      syntax += `    ${fromId} -->|"${label}"| ${toId}\n`;
    } else {
      // If target node doesn't exist, create it as a simple node first (outside subgraph)
      if (!existingNodeIds.has(toId) && toParts.length === 2) {
        const toLabel = `${toParts[0]}: ${toParts[1]}`.replace(/"/g, "'").replace(/\n/g, ' ');
        syntax += `    ${toId}["${toLabel}"]\n`;
        existingNodeIds.add(toId);
      }
      if (existingNodeIds.has(fromId) && existingNodeIds.has(toId)) {
        const label = (rel.description || rel.type).replace(/"/g, "'").replace(/\n/g, ' ');
        syntax += `    ${fromId} -->|"${label}"| ${toId}\n`;
      }
    }
  });

  // Add styling
  syntax += `\n    %% Styling\n`;
  syntax += `    classDef deployment fill:#4A90E2,stroke:#2E5C8A,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef service fill:#50C878,stroke:#2E7D4E,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef pod fill:#FFB84D,stroke:#CC8A3D,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef configmap fill:#9B59B6,stroke:#6C3483,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef secret fill:#E74C3C,stroke:#A93226,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef ingress fill:#3498DB,stroke:#21618C,stroke-width:2px,color:#fff\n`;

  // Apply styles (only to nodes that exist)
  const styledNodes = new Set<string>();
  resources.forEach(r => {
    const nodeId = sanitizeNodeId(`${r.kind}_${r.name}`);
    const kindLower = r.kind.toLowerCase();
    let styleClass = '';
    
    if (kindLower.includes('deployment')) {
      styleClass = 'deployment';
    } else if (kindLower.includes('service')) {
      styleClass = 'service';
    } else if (kindLower.includes('pod')) {
      styleClass = 'pod';
    } else if (kindLower.includes('configmap')) {
      styleClass = 'configmap';
    } else if (kindLower.includes('secret')) {
      styleClass = 'secret';
    } else if (kindLower.includes('ingress')) {
      styleClass = 'ingress';
    }
    
    if (styleClass && !styledNodes.has(nodeId) && existingNodeIds.has(nodeId)) {
      // Ensure nodeId is sanitized and doesn't contain newlines or special characters
      const safeNodeId = sanitizeNodeId(nodeId);
      syntax += `    class ${safeNodeId} ${styleClass}\n`;
      styledNodes.add(safeNodeId);
    }
  });
  
  // Also style any nodes created from relationships that weren't in resources
  relationships.forEach(rel => {
    const toParts = rel.to.split(':');
    const toId = sanitizeNodeId(`${toParts[0]}_${toParts[1]}`);
    const kindLower = toParts[0].toLowerCase();
    
    // Only style if not already styled and node exists
    if (!styledNodes.has(toId) && existingNodeIds.has(toId)) {
      let styleClass = '';
      if (kindLower.includes('pod')) {
        styleClass = 'pod';
      } else if (kindLower.includes('deployment')) {
        styleClass = 'deployment';
      } else if (kindLower.includes('service')) {
        styleClass = 'service';
      }
      
      if (styleClass) {
        // Ensure toId is sanitized and doesn't contain newlines or special characters
        const safeToId = sanitizeNodeId(toId);
        syntax += `    class ${safeToId} ${styleClass}\n`;
        styledNodes.add(safeToId);
      }
    }
  });

  return syntax;
}

/**
 * Generate Kubernetes architecture diagram from manifests
 */
export async function generateKubernetesDiagram(
  manifests: string[],
  useAI: boolean = true,
  diagramType: DiagramType = 'flowchart'
): Promise<DiagramResult> {
  console.log('\n📊 ========== KUBERNETES DIAGRAM GENERATION ==========');
  console.log(`Processing ${manifests.length} manifest(s)`);
  console.log(`Diagram Type: ${diagramType}`);

  // Parse resources
  const resources = parseKubernetesResources(manifests);
  console.log(`✅ Parsed ${resources.length} resource(s)`);

  // Extract relationships
  const relationships = extractRelationships(manifests, resources);
  console.log(`✅ Found ${relationships.length} relationship(s)`);

  // Generate Mermaid syntax based on diagram type
  let mermaidSyntax: string;
  
  if (diagramType === 'flowchart') {
    // Use existing flowchart generator
    mermaidSyntax = generateMermaidSyntax(resources, relationships);
  } else {
    // Convert to other diagram types
    const diagramData = {
      resources: resources.map(r => ({
        type: r.kind,
        name: r.name,
        category: r.kind, // Use kind as category for Kubernetes
      })),
      relationships: relationships.map(r => ({
        from: r.from,
        to: r.to,
        type: r.type,
      })),
    };
    
    console.log(`   📊 Converting to ${diagramType}...`);
    mermaidSyntax = convertToDiagramType(diagramData, diagramType);
    
    // If conversion returns empty, fallback to flowchart
    if (!mermaidSyntax || mermaidSyntax.trim() === '') {
      console.warn(`   ⚠️  ${diagramType} conversion returned empty, using flowchart`);
      mermaidSyntax = generateMermaidSyntax(resources, relationships);
    } else {
      console.log(`   ✅ Successfully converted to ${diagramType}`);
    }
  }

  // Optional AI enhancement (only for flowcharts)
  if (useAI && diagramType === 'flowchart') {
    try {
      console.log('\n🤖 Enhancing diagram with AI...');
      const enhanced = await enhanceWithAI(manifests, mermaidSyntax);
      mermaidSyntax = enhanced;
      console.log('✅ AI enhancement complete');
    } catch (error: any) {
      console.warn(`⚠️  AI enhancement failed: ${error.message}`);
      console.warn('📝 Using base diagram without AI enhancement');
    }
  } else if (useAI && diagramType !== 'flowchart') {
    console.log(`\n⏭️  Skipping AI enhancement for ${diagramType} diagram type`);
  }

  const resourceTypes = [...new Set(resources.map(r => r.kind))];

  const result: DiagramResult = {
    success: true,
    mermaidSyntax,
    resources,
    relationships,
    metadata: {
      totalResources: resources.length,
      totalRelationships: relationships.length,
      resourceTypes,
    },
  };

  console.log(`\n✅ Diagram generation complete!`);
  console.log(`   Resources: ${result.metadata.totalResources}`);
  console.log(`   Relationships: ${result.metadata.totalRelationships}`);
  console.log(`   Types: ${result.metadata.resourceTypes.join(', ')}`);
  console.log('==========================================\n');

  return result;
}

/**
 * Enhance Mermaid syntax with AI
 */
async function enhanceWithAI(manifests: string[], baseSyntax: string): Promise<string> {
  const systemPrompt = `You are an expert at creating clear, readable Mermaid diagrams for Kubernetes architectures.

Your task is to enhance the provided Mermaid syntax to make it more visually appealing and easier to understand.

Guidelines:
1. Keep the structure but improve layout
2. Ensure proper grouping and hierarchy
3. Add meaningful labels to relationships
4. Use appropriate colors and styling
5. Maintain all resources and relationships
6. Improve readability without changing the core structure

Return only the enhanced Mermaid syntax, no explanations.`;

  const userPrompt = `Enhance this Kubernetes Mermaid diagram:

\`\`\`mermaid
${baseSyntax}
\`\`\`

Make it clearer and more visually appealing while keeping all resources and relationships.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    const response = completion.choices[0]?.message?.content || '';
    
    // Extract Mermaid code block if present
    const mermaidMatch = response.match(/```(?:mermaid)?\n([\s\S]*?)```/);
    if (mermaidMatch) {
      return mermaidMatch[1].trim();
    }

    return response.trim();
  } catch (error: any) {
    console.warn(`⚠️  AI enhancement failed: ${error.message}`);
    return baseSyntax; // Return original if AI fails
  }
}

