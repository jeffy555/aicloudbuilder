/**
 * Architecture Diagram Generator
 * 
 * Converts ArchitectureAnalysis into Mermaid diagram syntax.
 * Supports multi-cloud architectures with subgraphs and color coding.
 */

import type { 
  ArchitectureAnalysis, 
  ArchitectureComponent, 
  ArchitectureRelationship,
  DataFlow,
  SecurityBoundary 
} from './architecture-analyzer';
import OpenAI from 'openai';
import { convertToDiagramType, DiagramType } from './diagram-type-generator';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface DiagramGenerationResult {
  mermaidSyntax: string;
  components: Array<{
    name: string;
    type: string;
    cloudProvider: string;
    category: string;
  }>;
  relationships: Array<{
    from: string;
    to: string;
    type: string;
    description?: string;
  }>;
  metadata: {
    totalComponents: number;
    totalRelationships: number;
    cloudProvider: string;
    categories: string[];
  };
}

/**
 * Generate Mermaid diagram from architecture analysis
 */
export async function generateArchitectureDiagram(
  analysis: ArchitectureAnalysis,
  diagramType: DiagramType = 'flowchart',
  useAI: boolean = true
): Promise<DiagramGenerationResult> {
  console.log('\n🎨 ========== ARCHITECTURE DIAGRAM GENERATION ==========');
  console.log(`📊 Components: ${analysis.components?.length || 0}`);
  console.log(`🔗 Relationships: ${analysis.relationships?.length || 0}`);
  console.log(`☁️  Cloud Provider: ${analysis.cloudProvider}`);
  console.log(`📊 Requested diagram type: ${diagramType}`);

  // Step 1: Generate base Mermaid syntax
  console.log('\n📐 Step 1: Generating base Mermaid syntax...');
  let baseSyntax = "";
  try {
    baseSyntax = generateBaseMermaidSyntax(analysis);
    console.log(`   ✅ Generated base diagram (${baseSyntax.split('\n').length} lines)`);
  } catch (baseError: any) {
    console.error(`   ❌ Failed to generate base syntax: ${baseError.message}`);
    throw new Error(`Base diagram generation failed: ${baseError.message}`);
  }

  // Step 2: Optionally convert to a different diagram type
  const diagramData = {
    resources: (analysis.components || []).map(component => ({
      type: component.type,
      name: component.name,
      category: component.category || 'Other'
    })),
    relationships: (analysis.relationships || []).map(rel => ({
      from: rel.from,
      to: rel.to,
      type: rel.type
    }))
  };

  let mermaidSyntax = baseSyntax;
  if (diagramType === 'flowchart') {
    mermaidSyntax = baseSyntax;
  } else {
    console.log(`\n📐 Step 2: Converting flowchart to ${diagramType}`);
    mermaidSyntax = convertToDiagramType(diagramData, diagramType);
    if (!mermaidSyntax || mermaidSyntax.trim() === '') {
      console.warn(`   ⚠️  Conversion to ${diagramType} returned empty, falling back to flowchart`);
      mermaidSyntax = baseSyntax;
    } else {
      console.log(`   ✅ ${diagramType} syntax generated (${diagramType === 'pie' ? 'pie chart' : diagramType})`);
    }
  }

  // Step 3: Enhance with AI if enabled (only for flowcharts)
  if (useAI && diagramType === 'flowchart') {
    console.log('\n🤖 Step 3: AI enhancement is temporarily disabled due to formatting glitches');
  } else if (useAI && diagramType !== 'flowchart') {
    console.log(`\n⏭️  Skipping AI enhancement for ${diagramType} diagram type`);
  }

  // Build result
  const result: DiagramGenerationResult = {
    mermaidSyntax,
    components: analysis.components.map(c => ({
      name: c.name,
      type: c.type,
      cloudProvider: c.cloudProvider,
      category: c.category
    })),
    relationships: analysis.relationships.map(r => ({
      from: r.from,
      to: r.to,
      type: r.type,
      description: r.description
    })),
    metadata: {
      totalComponents: analysis.metadata.totalComponents,
      totalRelationships: analysis.metadata.totalRelationships,
      cloudProvider: analysis.cloudProvider,
      categories: analysis.metadata.categories
    }
  };

  // Also add totalResources for compatibility with existing DiagramResult interface
  (result.metadata as any).totalResources = analysis.metadata.totalComponents;

  console.log('\n✅ Architecture diagram generation complete!');
  return result;
}

/**
 * Generate base Mermaid syntax from analysis
 */
function generateBaseMermaidSyntax(analysis: ArchitectureAnalysis): string {
  const isMultiCloud = analysis.cloudProvider === 'multi' || analysis.cloudProvider === 'hybrid';
  const hasMultipleProviders = analysis.detectedProviders.length > 1 || 
                               (analysis.detectedProviders.length === 1 && analysis.detectedProviders[0] !== 'third-party');

  let syntax = 'graph TB\n';
  
  // Helper to sanitize node IDs
  const getNodeId = (name: string): string => {
    return name
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 30);
  };

  // Helper to format node label
  const getNodeLabel = (component: ArchitectureComponent): string => {
    const label = component.name.length > 30 
      ? component.name.substring(0, 27) + '...' 
      : component.name;
    return `${label}<br/><span style="font-size:10px">${component.category}</span>`;
  };

  // Detect Kubernetes clusters (AKS, EKS, GKE)
  const kubernetesClusters = analysis.components.filter(c => {
    const nameLower = c.name.toLowerCase();
    const typeLower = c.type.toLowerCase();
    return nameLower.includes('aks') || nameLower.includes('eks') || nameLower.includes('gke') ||
           nameLower.includes('kubernetes') ||
           typeLower.includes('kubernetes') || typeLower.includes('aks') ||
           typeLower.includes('eks') || typeLower.includes('gke') ||
           c.metadata?.serviceType === 'Kubernetes';
  });

  // Detect nodes (cluster nodes)
  const clusterNodes = analysis.components.filter(c => {
    const nameLower = c.name.toLowerCase();
    const typeLower = c.type.toLowerCase();
    return nameLower.includes('node') || typeLower.includes('node') ||
           (nameLower.match(/\d+\s*node/i) !== null);
  });

  // Detect services that run inside clusters (based on relationships or metadata)
  const clusterNames = new Set(kubernetesClusters.map(c => c.name));
  const servicesInCluster = new Set<string>();
  analysis.relationships.forEach(rel => {
    // If a service is connected to/deployed on a cluster, it's inside
    kubernetesClusters.forEach(cluster => {
      if (rel.to === cluster.name || rel.from === cluster.name) {
        if (rel.type.includes('deploy') || rel.type.includes('run') ||
            rel.type.includes('inside') || rel.type.includes('within')) {
          // Add the non-cluster end of the relationship, but never add a cluster itself
          const candidate = rel.to === cluster.name ? rel.from : rel.to;
          if (!clusterNames.has(candidate)) {
            servicesInCluster.add(candidate);
          }
        }
      }
    });
  });

  // Place components inside clusters based on the AI-provided deploymentContext.
  // The analyzer classifies each component as in-cluster, external, or managed-service
  // from the user's requirements — no hardcoded tool lists needed here.
  if (kubernetesClusters.length > 0) {
    analysis.components.forEach(c => {
      if (c.metadata?.deploymentContext === 'in-cluster') {
        servicesInCluster.add(c.name);
      }
    });
  }

  // Group components by cloud provider
  const componentsByProvider: Record<string, ArchitectureComponent[]> = {
    azure: [],
    aws: [],
    gcp: [],
    'third-party': [],
    unknown: []
  };

  analysis.components.forEach(c => {
    const provider = c.cloudProvider === 'multi' ? 'unknown' : c.cloudProvider;
    if (componentsByProvider[provider]) {
      componentsByProvider[provider].push(c);
    } else {
      componentsByProvider.unknown.push(c);
    }
  });

  // Group components by category within each provider
  const groupByCategory = (components: ArchitectureComponent[]): Record<string, ArchitectureComponent[]> => {
    const grouped: Record<string, ArchitectureComponent[]> = {};
    components.forEach(c => {
      const category = c.category || 'Other';
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(c);
    });
    return grouped;
  };

  // Group components by provider
  const groupByProvider = (components: ArchitectureComponent[]): Record<string, ArchitectureComponent[]> => {
    const grouped: Record<string, ArchitectureComponent[]> = {
      azure: [],
      aws: [],
      gcp: [],
      'third-party': [],
      unknown: []
    };
    components.forEach(c => {
      const provider = c.cloudProvider === 'multi' ? 'unknown' : c.cloudProvider;
      if (grouped[provider]) {
        grouped[provider].push(c);
      } else {
        grouped.unknown.push(c);
      }
    });
    return grouped;
  };

  // Generate node definitions
  const nodeIds: Map<string, string> = new Map();
  analysis.components.forEach(c => {
    const nodeId = getNodeId(c.name);
    nodeIds.set(c.name, nodeId);
  });

  // Separate components into clusters, nodes, in-cluster services, and external
  const inClusterServices = analysis.components.filter(c => servicesInCluster.has(c.name));
  const externalComponents = analysis.components.filter(c => 
    !kubernetesClusters.includes(c) && 
    !clusterNodes.includes(c) && 
    !servicesInCluster.has(c.name)
  );

  // If we have Kubernetes clusters, create hierarchical structure (PRIORITY)
  if (kubernetesClusters.length > 0) {
    kubernetesClusters.forEach(cluster => {
      const clusterId = nodeIds.get(cluster.name) || getNodeId(cluster.name);
      const clusterLabel = getNodeLabel(cluster);
      
      syntax += `    subgraph ${clusterId}["${clusterLabel}"]\n`;
      syntax += `        direction TB\n`;
      
      // Add nodes inside cluster
      const nodesInThisCluster = clusterNodes.filter(node => {
        // Check if node is related to this cluster
        return analysis.relationships.some(rel => 
          (rel.from === node.name && rel.to === cluster.name) ||
          (rel.to === node.name && rel.from === cluster.name)
        ) || clusterNodes.length <= kubernetesClusters.length; // If few nodes, assume they belong
      });
      
      const nodesSubgraphId = `${clusterId}_Nodes`;
      if (nodesInThisCluster.length > 0) {
        syntax += `        subgraph ${nodesSubgraphId}["Nodes"]\n`;
        nodesInThisCluster.forEach(node => {
          const nodeId = nodeIds.get(node.name) || getNodeId(node.name);
          const nodeLabel = getNodeLabel(node);
          syntax += `            ${nodeId}["${nodeLabel}"]\n`;
        });
        syntax += `        end\n`;
      } else {
        // If no explicit nodes but cluster mentioned, add placeholder nodes based on description
        const clusterDesc = cluster.description.toLowerCase();
        const nodeMatch = clusterDesc.match(/(\d+)\s*node/i);
        if (nodeMatch) {
          const nodeCount = parseInt(nodeMatch[1]);
          syntax += `        subgraph ${nodesSubgraphId}["Nodes (${nodeCount})"]\n`;
          for (let i = 1; i <= Math.min(nodeCount, 3); i++) {
            syntax += `            ${clusterId}_Node${i}["Node ${i}"]\n`;
          }
          if (nodeCount > 3) {
            syntax += `            ${clusterId}_NodeMore["... ${nodeCount - 3} more"]\n`;
          }
          syntax += `        end\n`;
        }
      }
      
      // Add services inside cluster (exclude the cluster component itself to prevent cycles)
      const servicesInThisCluster = inClusterServices.filter(service => {
        if (service.name === cluster.name) return false;
        return analysis.relationships.some(rel =>
          (rel.from === service.name && rel.to === cluster.name) ||
          (rel.to === service.name && rel.from === cluster.name)
        ) || servicesInCluster.has(service.name);
      });

      if (servicesInThisCluster.length > 0) {
        const servicesSubgraphId = `${clusterId}_Services`;
        syntax += `        subgraph ${servicesSubgraphId}["Services"]\n`;
        servicesInThisCluster.forEach(service => {
          const serviceId = nodeIds.get(service.name) || getNodeId(service.name);
          const serviceLabel = getNodeLabel(service);
          syntax += `            ${serviceId}["${serviceLabel}"]\n`;
        });
        syntax += `        end\n`;
      }
      
      syntax += `    end\n\n`;
    });
    
    // Add external components (outside clusters)
    if (externalComponents.length > 0) {
      const externalByProvider = groupByProvider(externalComponents);
      Object.entries(externalByProvider).forEach(([provider, components]) => {
        if (components.length > 0) {
          const providerLabel = provider === 'third-party' ? 'Third-Party Tools' : provider.toUpperCase();
          syntax += `    subgraph ${provider}["${providerLabel}"]\n`;
          syntax += `        direction TB\n`;
          const byCategory = groupByCategory(components);
          Object.entries(byCategory).forEach(([category, comps]) => {
            comps.forEach(c => {
              const nodeId = nodeIds.get(c.name) || getNodeId(c.name);
              const label = getNodeLabel(c);
              syntax += `        ${nodeId}["${label}"]\n`;
            });
          });
          syntax += `    end\n\n`;
        }
      });
    }
  } else if (isMultiCloud && hasMultipleProviders) {
    // Azure subgraph
    if (componentsByProvider.azure.length > 0) {
      syntax += `    subgraph Azure["Azure"]\n`;
      syntax += `        direction TB\n`;
      const azureByCategory = groupByCategory(componentsByProvider.azure);
      Object.entries(azureByCategory).forEach(([category, components]) => {
        components.forEach(c => {
          const nodeId = nodeIds.get(c.name) || getNodeId(c.name);
          const label = getNodeLabel(c);
          syntax += `        ${nodeId}["${label}"]\n`;
        });
      });
      syntax += `    end\n\n`;
    }

    // AWS subgraph
    if (componentsByProvider.aws.length > 0) {
      syntax += `    subgraph AWS["AWS"]\n`;
      syntax += `        direction TB\n`;
      const awsByCategory = groupByCategory(componentsByProvider.aws);
      Object.entries(awsByCategory).forEach(([category, components]) => {
        components.forEach(c => {
          const nodeId = nodeIds.get(c.name) || getNodeId(c.name);
          const label = getNodeLabel(c);
          syntax += `        ${nodeId}["${label}"]\n`;
        });
      });
      syntax += `    end\n\n`;
    }

    // GCP subgraph
    if (componentsByProvider.gcp.length > 0) {
      syntax += `    subgraph GCP["GCP"]\n`;
      syntax += `        direction TB\n`;
      const gcpByCategory = groupByCategory(componentsByProvider.gcp);
      Object.entries(gcpByCategory).forEach(([category, components]) => {
        components.forEach(c => {
          const nodeId = nodeIds.get(c.name) || getNodeId(c.name);
          const label = getNodeLabel(c);
          syntax += `        ${nodeId}["${label}"]\n`;
        });
      });
      syntax += `    end\n\n`;
    }

    // Third-party tools subgraph
    if (componentsByProvider['third-party'].length > 0) {
      syntax += `    subgraph ThirdParty["Third-Party Tools"]\n`;
      syntax += `        direction TB\n`;
      const thirdPartyByCategory = groupByCategory(componentsByProvider['third-party']);
      Object.entries(thirdPartyByCategory).forEach(([category, components]) => {
        components.forEach(c => {
          const nodeId = nodeIds.get(c.name) || getNodeId(c.name);
          const label = getNodeLabel(c);
          syntax += `        ${nodeId}["${label}"]\n`;
        });
      });
      syntax += `    end\n\n`;
    }
  } else {
    // Single cloud or unknown - group by category only
    const allByCategory = groupByCategory(analysis.components);
    Object.entries(allByCategory).forEach(([category, components]) => {
      if (components.length > 0) {
        syntax += `    subgraph ${category.replace(/[^a-zA-Z0-9]/g, '_')}["${category}"]\n`;
        components.forEach(c => {
          const nodeId = nodeIds.get(c.name) || getNodeId(c.name);
          const label = getNodeLabel(c);
          syntax += `        ${nodeId}["${label}"]\n`;
        });
        syntax += `    end\n\n`;
      }
    });
  }

  // Add relationships (handle both internal and external)
  syntax += `    %% Relationships\n`;
  analysis.relationships.forEach(rel => {
    const fromId = nodeIds.get(rel.from);
    const toId = nodeIds.get(rel.to);
    
    if (fromId && toId) {
      const relType = getRelationshipArrow(rel.type);
      const label = rel.description && rel.description.length < 30 
        ? `|"${rel.description}"|` 
        : '';
      
      // For relationships from cluster to external, use cluster ID
      let actualFromId = fromId;
      let actualToId = toId;
      
      // If from is inside a cluster, find the cluster
      if (servicesInCluster.has(rel.from) || kubernetesClusters.some(c => c.name === rel.from)) {
        const cluster = kubernetesClusters.find(c => 
          c.name === rel.from || 
          analysis.relationships.some(r => r.from === rel.from && r.to === c.name) ||
          (servicesInCluster.has(rel.from) && analysis.relationships.some(r => r.from === rel.from && r.to === c.name))
        );
        // If to is external (not in cluster), use cluster ID for from
        if (cluster && !servicesInCluster.has(rel.to) && !kubernetesClusters.some(c => c.name === rel.to)) {
          actualFromId = nodeIds.get(cluster.name) || getNodeId(cluster.name);
        }
      }
      
      syntax += `    ${actualFromId} ${relType}${label} ${actualToId}\n`;
    }
  });

  // Add data flows (handle cluster boundaries)
  if (analysis.dataFlows.length > 0) {
    syntax += `\n    %% Data Flows\n`;
    analysis.dataFlows.forEach(df => {
      const sourceId = nodeIds.get(df.source);
      const targetId = nodeIds.get(df.target);
      
      if (sourceId && targetId) {
        const protocol = df.protocol ? ` (${df.protocol})` : '';
        const label = df.description && df.description.length < 30 
          ? `|"${df.description}${protocol}"|` 
          : protocol ? `|"${protocol}"|` : '';
        
        // If source is in cluster and target is external, use cluster ID
        let actualSourceId = sourceId;
        if (servicesInCluster.has(df.source) || kubernetesClusters.some(c => c.name === df.source)) {
          const cluster = kubernetesClusters.find(c => 
            c.name === df.source || 
            analysis.relationships.some(r => r.from === df.source && r.to === c.name)
          );
          if (cluster && !servicesInCluster.has(df.target) && !kubernetesClusters.some(c => c.name === df.target)) {
            actualSourceId = nodeIds.get(cluster.name) || getNodeId(cluster.name);
          }
        }
        
        syntax += `    ${actualSourceId} -->${label} ${targetId}\n`;
      }
    });
  }

  // Add styling
  syntax += `\n    %% Styling\n`;
  syntax += `    classDef azureStyle fill:#0078d4,stroke:#005a9e,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef awsStyle fill:#ff9900,stroke:#e68900,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef gcpStyle fill:#4285f4,stroke:#1967d2,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef thirdPartyStyle fill:#6c757d,stroke:#495057,stroke-width:2px,color:#fff\n`;
  
  // Apply styles
  analysis.components.forEach(c => {
    const nodeId = nodeIds.get(c.name);
    if (nodeId) {
      if (c.cloudProvider === 'azure') {
        syntax += `    class ${nodeId} azureStyle\n`;
      } else if (c.cloudProvider === 'aws') {
        syntax += `    class ${nodeId} awsStyle\n`;
      } else if (c.cloudProvider === 'gcp') {
        syntax += `    class ${nodeId} gcpStyle\n`;
      } else if (c.cloudProvider === 'third-party' || c.isThirdParty) {
        syntax += `    class ${nodeId} thirdPartyStyle\n`;
      }
    }
  });

  return syntax;
}

/**
 * Get relationship arrow based on type
 */
function getRelationshipArrow(type: string): string {
  const typeLower = type.toLowerCase();
  if (typeLower.includes('store') || typeLower.includes('save')) {
    return '-->|stores|';
  } else if (typeLower.includes('authenticate') || typeLower.includes('secure')) {
    return '-->|authenticates|';
  } else if (typeLower.includes('monitor') || typeLower.includes('observe')) {
    return '-->|monitors|';
  } else if (typeLower.includes('log')) {
    return '-->|logs|';
  } else if (typeLower.includes('process')) {
    return '-->|processes|';
  } else if (typeLower.includes('expose') || typeLower.includes('api')) {
    return '-->|exposes|';
  } else if (typeLower.includes('deploy') || typeLower.includes('run')) {
    return '-->|deploys|';
  } else if (typeLower.includes('orchestrate') || typeLower.includes('ci/cd')) {
    return '-->|orchestrates|';
  } else {
    return '-->|connects|';
  }
}

/**
 * Enhance Mermaid syntax using AI
 */
async function enhanceWithAI(
  analysis: ArchitectureAnalysis,
  baseSyntax: string
): Promise<string> {
  const componentsText = analysis.components.map(c => 
    `- ${c.name} (${c.cloudProvider}, ${c.category})`
  ).join('\n');

  const relationshipsText = analysis.relationships.map(r => 
    `- ${r.from} → ${r.to} (${r.type})`
  ).join('\n');

  const prompt = `You are an expert in cloud architecture diagrams. Improve this Mermaid diagram syntax for better clarity and visualization.

CLOUD PROVIDER: ${analysis.cloudProvider}
DETECTED PROVIDERS: ${analysis.detectedProviders.join(', ')}

COMPONENTS:
${componentsText}

RELATIONSHIPS:
${relationshipsText}

CURRENT MERMAID SYNTAX:
\`\`\`
${baseSyntax}
\`\`\`

Your task:
1. Improve the layout and organization
2. Ensure all relationships are properly represented
3. Optimize subgraph grouping for clarity
4. Add better labels where needed
5. Maintain all components and relationships
6. Keep the styling classes

Return ONLY the improved Mermaid syntax, nothing else.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { 
          role: 'system', 
          content: 'You are an expert in Mermaid diagram syntax. Return only valid Mermaid syntax, no explanations or markdown formatting.' 
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 3000,
    });

    const enhancedSyntax = completion.choices[0]?.message?.content?.trim() || baseSyntax;
    
    // Remove markdown code blocks if present
    let cleaned = enhancedSyntax
      .replace(/^```mermaid\n?/i, '')
      .replace(/^```\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

    cleaned = extractMermaidSyntax(cleaned, baseSyntax);
    return cleaned;
  } catch (error: any) {
    console.error('AI enhancement error:', error);
    return baseSyntax; // Fallback to base syntax
  }
}

function extractMermaidSyntax(candidate: string, fallback: string): string {
  if (!candidate || candidate.trim() === '') {
    return fallback;
  }

  // Reject HTML-heavy AI responses (e.g., spans) immediately
  if (/<\/[a-z][^>]*>/i.test(candidate)) {
    return fallback;
  }

  const lower = candidate.toLowerCase();
  const graphIndex = lower.indexOf('graph ');
  const flowchartIndex = lower.indexOf('flowchart ');
  const sequenceIndex = lower.indexOf('sequence ');
  const diagramKeywordIndex = Math.min(
    graphIndex === -1 ? Infinity : graphIndex,
    flowchartIndex === -1 ? Infinity : flowchartIndex,
    sequenceIndex === -1 ? Infinity : sequenceIndex
  );

  if (diagramKeywordIndex === Infinity) {
    return fallback;
  }

  if (diagramKeywordIndex > 0) {
    candidate = candidate.substring(diagramKeywordIndex);
  }

  const lines = candidate.split(/\r?\n/).map((line) => line.trim());
  const sanitizedLines: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    const normalized = normalizeMermaidLine(line);
    if (!normalized) continue;
    if (isMermaidLine(normalized)) {
      sanitizedLines.push(normalized);
      continue;
    }
    break;
  }

  if (sanitizedLines.length === 0) {
    return fallback;
  }

  const cleaned = sanitizedLines.join('\n').trim();
  if (!cleaned || /[\]")']\s*\d+/.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

function isMermaidLine(line: string): boolean {
  if (!line) return false;

  // Reject lines that end with stray numeric annotations (e.g., 'class foo 1')
  if (/\s+\d+$/.test(line)) {
    return false;
  }
  const keywords = [
    'graph', 'flowchart', 'sequence',
    'subgraph', 'classDef', 'class', 'style',
    'direction', 'stateDiagram', 'pie', 'erDiagram',
    'journey', 'gitGraph', 'mindmap', 'gantt',
    '%%', 'note', 'click', 'linkStyle', 'rect', 'operator'
  ];
  const lower = line.toLowerCase();
  if (keywords.some((keyword) => lower.startsWith(keyword + ' ') || lower === keyword)) {
    return true;
  }

  if (line.startsWith('%%')) {
    return true;
  }

  if (/\[".*"\]/.test(line) || /\(\(.*\)\)/.test(line)) {
    return true;
  }

  if (/-->|-\.-|==>|---|===|-.->|-.->/.test(line)) {
    return true;
  }

  if (/^class\s+[A-Za-z_][\w]*(\s+[A-Za-z_][\w]*)*$/.test(line)) {
    return true;
  }

  if (/^linkStyle\s+\d+\s*(,|\s+)?[A-Za-z0-9_]*$/.test(line)) {
    return true;
  }

  return false;
}

function normalizeMermaidLine(line: string): string {
  let normalized = line.replace(/<[^>]+>/g, "");

  while (/[\s]*[\d]+[.)]?$/.test(normalized)) {
    normalized = normalized.replace(/[\s]*[\d]+[.)]?$/, "");
  }

  normalized = normalized.replace(/([\]"')])\s*\d+(?=\s*-->|$)/g, "$1");
  normalized = normalized.replace(/([\]"')])\s*\d+(?=\s*$)/g, "$1");
  normalized = normalized.replace(/([\]"')])\s*\d+(?=\s)/g, "$1");
  normalized = normalized.replace(/([\]"')])\d+(?!\w)/g, "$1");

  if (/[\]"')]\s*\d+$/.test(normalized)) {
    return "";
  }

  return normalized.trim();
}

