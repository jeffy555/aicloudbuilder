/**
 * Terraform Diagram Generator
 * 
 * Main orchestrator for generating architecture diagrams from Terraform code.
 * Uses OpenAI to enhance diagram generation with intelligent analysis.
 */

import { buildResourceGraph, ResourceGraph } from './resource-relationship-parser';
import { generateMermaidSyntax, MermaidOptions } from './mermaid-generator';
import { openaiService } from '../openai-service';
import { convertToDiagramType, DiagramType } from './diagram-type-generator';

export interface DiagramGenerationResult {
  mermaidSyntax: string;
  resources: Array<{
    type: string;
    name: string;
    file: string;
  }>;
  relationships: Array<{
    from: string;
    to: string;
    type: string;
    description?: string;
  }>;
  metadata: {
    totalResources: number;
    totalRelationships: number;
    cloudProvider: string;
    categories: string[];
  };
  warnings: string[]; // Non-fatal issues such as circular dependencies
}

/**
 * Generate architecture diagram from Terraform files.
 * @param costAnnotations - Optional map "resourceType.resourceName" → monthly USD cost.
 *   When provided, flowchart node labels include a [$X/mo] annotation (Fix #5).
 */
export async function generateArchitectureDiagram(
  files: Array<{ fileName: string; content: string }>,
  cloudProvider: string = 'azure',
  useAI: boolean = true,
  diagramType: DiagramType = 'flowchart',
  costAnnotations?: Record<string, number>
): Promise<DiagramGenerationResult> {
  console.log('\n🎨 ========== ARCHITECTURE DIAGRAM GENERATION ==========');
  console.log(`📁 Files to analyze: ${files.length}`);
  console.log(`☁️  Cloud Provider: ${cloudProvider}`);

  // Step 1: Parse Terraform resources and relationships
  console.log('\n📊 Step 1: Parsing Terraform resources...');
  const graph = buildResourceGraph(files);
  
  console.log(`   ✅ Found ${graph.resources.length} resource(s)`);
  console.log(`   ✅ Found ${graph.relationships.length} relationship(s)`);
  console.log(`   ✅ Found ${graph.resourceGroups.length} resource group(s)`);

  if (graph.resources.length === 0) {
    // Log file contents for debugging
    console.error('❌ No Terraform resources found in the provided files');
    files.forEach((f, i) => {
      console.error(`   File ${i + 1}: ${f.fileName} (${f.content.length} bytes)`);
      if (f.content.length > 0) {
        const preview = f.content.substring(0, 200).replace(/\n/g, ' ');
        console.error(`      Preview: ${preview}...`);
      } else {
        console.error(`      ⚠️  File is empty!`);
      }
    });
    throw new Error('No Terraform resources or modules found in the provided files. Make sure your files contain resource blocks or module calls.');
  }

  // Step 2: Generate Mermaid syntax based on diagram type
  console.log('\n📐 Step 2: Generating Mermaid syntax...');
  console.log(`   📊 Diagram Type: ${diagramType}`);
  
  let mermaidSyntax: string;
  
  if (diagramType === 'flowchart') {
    // Generate base WITHOUT per-node Azure styling. Azure styling class directives
    // use node IDs that can become stale when the AI enhancement renames nodes,
    // causing Mermaid to throw in strict security mode. Styling is re-applied
    // after AI enhancement using actual node IDs from the final output.
    const baseOptions: MermaidOptions = {
      diagramType: 'graph',
      theme: 'default',
      groupByCategory: true,
      showLabels: true,
      costMap: costAnnotations,
    };
    mermaidSyntax = generateMermaidSyntax(graph, baseOptions);
  } else {
    // Convert to other diagram types
    const getResourceDisplayName = (resource: any): string => {
      const attrs = resource.attributes || {};
      const configuredName = ['name', 'account_name', 'server_name', 'workspace_name', 'cluster_name']
        .map((key) => attrs[key])
        .find((value) => typeof value === 'string' && value.trim().length > 0) as string | undefined;
      if (configuredName) return configuredName.trim();
      if (attrs.isModule && typeof attrs.source === 'string' && attrs.source.trim()) {
        const source = attrs.source.replace(/\\/g, '/');
        const sourceName = source.split('/').filter(Boolean).pop() || source;
        return `${resource.name} (${sourceName})`;
      }
      return resource.name;
    };
    const referenceToDisplay = new Map<string, string>();
    graph.resources.forEach((r) => {
      referenceToDisplay.set(`${r.type}.${r.name}`, getResourceDisplayName(r));
    });

    const diagramData = {
      resources: graph.resources.map(r => ({
        type: r.type,
        name: getResourceDisplayName(r),
        category: getResourceCategory(r.type),
      })),
      relationships: graph.relationships.map(r => ({
        from: referenceToDisplay.get(r.from) || r.from,
        to: referenceToDisplay.get(r.to) || r.to,
        type: r.type,
      })),
    };

    console.log(`   📊 Converting to ${diagramType}...`);
    console.log(`   📦 Resources: ${diagramData.resources.length}, Relationships: ${diagramData.relationships.length}`);

    mermaidSyntax = convertToDiagramType(diagramData, diagramType);

    // If conversion returns empty, fallback to flowchart
    if (!mermaidSyntax || mermaidSyntax.trim() === '') {
      console.warn(`   ⚠️  ${diagramType} conversion returned empty, using flowchart`);
      console.warn(`   📊 Diagram data:`, JSON.stringify(diagramData, null, 2));
      const baseOptions: MermaidOptions = {
        diagramType: 'graph',
        theme: 'default',
        groupByCategory: true,
        showLabels: true
      };
      mermaidSyntax = generateMermaidSyntax(graph, baseOptions);
    } else {
      console.log(`   ✅ Successfully converted to ${diagramType}`);
      console.log(`   📝 Generated syntax (${mermaidSyntax.length} chars, ${mermaidSyntax.split('\n').length} lines)`);
      console.log(`   📝 Syntax preview (first 200 chars): ${mermaidSyntax.substring(0, 200)}...`);
      console.log(`   📝 Syntax starts with: ${mermaidSyntax.split('\n')[0]}`);
    }
  }

  console.log(`   ✅ Generated ${diagramType} diagram (${mermaidSyntax.split('\n').length} lines)`);

  // Step 3: Enhance with AI only for flowchart (AI is unreliable for other Mermaid types)
  if (useAI && diagramType === 'flowchart') {
    console.log(`\n🤖 Step 3: Enhancing ${diagramType} diagram with AI...`);
    try {
      mermaidSyntax = await enhanceWithAI(graph, mermaidSyntax, cloudProvider, diagramType);
      console.log('   ✅ AI enhancement complete');
    } catch (error: any) {
      console.warn(`   ⚠️  AI enhancement failed: ${error.message}`);
      console.warn('   📝 Using base diagram without AI enhancement');
    }
  } else if (useAI && diagramType !== 'flowchart') {
    console.log(`   ⏭️  Skipping AI enhancement for ${diagramType} (base generator output used directly)`);
  }

  // Step 3b: Re-apply Azure styling AFTER AI enhancement, using node IDs actually
  // present in the final syntax. This avoids stale class directives.
  if (cloudProvider === 'azure' && diagramType === 'flowchart') {
    mermaidSyntax = applyAzureStylingToFinalSyntax(mermaidSyntax, graph.resources);
  }

  // Step 4: Extract categories
  const categories = new Set<string>();
  graph.resources.forEach(r => {
    const category = getResourceCategory(r.type);
    categories.add(category);
  });

  // Step 5: Build result
  if (graph.warnings.length > 0) {
    graph.warnings.forEach(w => console.warn(`   ⚠️  ${w}`));
  }

  const result: DiagramGenerationResult = {
    mermaidSyntax,
    resources: graph.resources.map(r => ({
      type: r.type,
      name: r.name,
      file: r.file
    })),
    relationships: graph.relationships.map(r => ({
      from: r.from,
      to: r.to,
      type: r.type,
      description: r.description
    })),
    metadata: {
      totalResources: graph.resources.length,
      totalRelationships: graph.relationships.length,
      cloudProvider,
      categories: Array.from(categories)
    },
    warnings: graph.warnings,
  };

  console.log('\n✅ Architecture diagram generation complete!');
  console.log(`   📊 Resources: ${result.metadata.totalResources}`);
  console.log(`   🔗 Relationships: ${result.metadata.totalRelationships}`);
  console.log(`   📁 Categories: ${result.metadata.categories.join(', ')}`);

  return result;
}

/**
 * Apply Azure colour styling AFTER AI enhancement.
 * Extracts real node IDs from the final Mermaid syntax so class directives
 * only reference nodes that actually exist — prevents strict-mode parse errors.
 */
function applyAzureStylingToFinalSyntax(
  syntax: string,
  resources: Array<{ type: string; name: string }>
): string {
  // Extract node IDs that actually appear in the syntax
  // Matches:  identifier["..."]  identifier[...]  identifier(...)  etc.
  const existingNodeIds = new Set<string>();
  const nodePattern = /^\s{0,8}(\w+)\s*[\[({]/gm;
  let m;
  while ((m = nodePattern.exec(syntax)) !== null) {
    // Skip subgraph keyword itself
    if (m[1] !== 'subgraph' && m[1] !== 'end') {
      existingNodeIds.add(m[1]);
    }
  }

  const categoryMap: Record<string, string> = {
    compute: 'fill:#0078d4,stroke:#005a9e,stroke-width:2px,color:#fff',
    storage: 'fill:#ff6b35,stroke:#d84315,stroke-width:2px,color:#fff',
    network: 'fill:#00bcf2,stroke:#0097a7,stroke-width:2px,color:#fff',
    database: 'fill:#6264a7,stroke:#484883,stroke-width:2px,color:#fff',
    security: 'fill:#107c10,stroke:#0e6b0e,stroke-width:2px,color:#fff',
    resourceGroup: 'fill:#243a5e,stroke:#1a2a46,stroke-width:2px,color:#fff',
  };

  const getCategory = (type: string): string => {
    if (type.includes('resource_group')) return 'resourceGroup';
    if (type.includes('app_service') || type.includes('function_app') || type.includes('container') || type.includes('kubernetes') || type.includes('virtual_machine') || type.includes('_vm')) return 'compute';
    if (type.includes('storage') || type.includes('blob') || type.includes('file_share')) return 'storage';
    if (type.includes('virtual_network') || type.includes('subnet') || type.includes('network') || type.includes('load_balancer') || type.includes('public_ip')) return 'network';
    if (type.includes('sql') || type.includes('database') || type.includes('cosmosdb') || type.includes('postgresql') || type.includes('mysql') || type.includes('redis')) return 'database';
    if (type.includes('key_vault') || type.includes('role_assignment') || type.includes('managed_identity')) return 'security';
    return '';
  };

  // Build classDef block
  const usedCategories = new Set<string>();
  for (const r of resources) {
    const cat = getCategory(r.type);
    if (cat) usedCategories.add(cat);
  }
  if (usedCategories.size === 0) return syntax;

  let styling = '\n';
  for (const cat of usedCategories) {
    styling += `    classDef ${cat} ${categoryMap[cat]}\n`;
  }

  // Build per-node class assignments, only for nodes present in the final syntax.
  // Node IDs in the final output may differ from the original resource.type_resource.name
  // pattern if the AI renamed them, so we match by prefix heuristic.
  for (const r of resources) {
    const cat = getCategory(r.type);
    if (!cat) continue;

    // Canonical ID from the original generator
    const canonicalId = `${r.type}_${r.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
    if (existingNodeIds.has(canonicalId)) {
      styling += `    class ${canonicalId} ${cat}\n`;
      continue;
    }

    // Fallback: look for a node whose ID contains the resource name
    const safeName = r.name.replace(/[^a-zA-Z0-9_]/g, '_');
    const match = [...existingNodeIds].find(id => id === safeName || id.endsWith(`_${safeName}`) || id.startsWith(`${safeName}_`));
    if (match) {
      styling += `    class ${match} ${cat}\n`;
    }
  }

  return syntax + styling;
}

// Per-type enhancement instructions and validation patterns
const DIAGRAM_TYPE_GUIDANCE: Record<string, { instructions: string; validTokens: string[] }> = {
  flowchart: {
    instructions: `1. Review the current Mermaid syntax
2. Improve the layout and organization
3. Ensure all resources and relationships are correctly represented
4. Add better labels and descriptions where helpful
5. Optimize the visual hierarchy (Resource Groups at top, dependencies flow downward)
6. Group related resources logically using subgraph blocks
7. Use clear, descriptive node labels`,
    validTokens: ['graph', 'flowchart'],
  },
  sequence: {
    instructions: `1. Model deployment order and runtime interactions between resources
2. Show initialization sequence (RG → Storage → App Service → etc.)
3. Represent key runtime flows (e.g., App → Key Vault secret fetch, App → DB connection)
4. Use clear participant labels (use friendly names, not resource IDs)
5. Add activation bars where appropriate
6. Keep interactions realistic for the infrastructure type`,
    validTokens: ['sequenceDiagram'],
  },
  classDiagram: {
    instructions: `1. Represent each resource as a class with its key Terraform attributes
2. Show inheritance / composition relationships between dependent resources
3. Add cardinality labels (1..* for resource groups containing multiple resources)
4. Use meaningful attribute names (location, sku, tier, etc.)
5. Group by category using namespace blocks where helpful`,
    validTokens: ['classDiagram'],
  },
  stateDiagram: {
    instructions: `1. Model the provisioning lifecycle of the main resource(s)
2. States: Planned → Creating → Running → Updating → Destroying
3. Show transitions triggered by terraform apply / destroy / import
4. Include error/failed states with recovery paths
5. Use stateDiagram-v2 syntax`,
    validTokens: ['stateDiagram'],
  },
  erDiagram: {
    instructions: `1. Treat each Terraform resource as an entity with its key attributes
2. Define relationships using Terraform dependency direction
3. Use correct cardinality (one resource group to many resources, etc.)
4. Show foreign-key-like linkages (resource_group_name, subnet_id, etc.)
5. Use standard ERD notation`,
    validTokens: ['erDiagram'],
  },
};

/**
 * Enhance Mermaid syntax using OpenAI — works for all diagram types
 */
async function enhanceWithAI(
  graph: ResourceGraph,
  baseSyntax: string,
  cloudProvider: string,
  diagramType: string = 'flowchart'
): Promise<string> {
  const resourcesText = graph.resources.map(r =>
    `- ${r.type} "${r.name}" (${r.file})`
  ).join('\n');

  const relationshipsText = graph.relationships.map(r =>
    `- ${r.from} → ${r.to} (${r.type}: ${r.description || 'N/A'})`
  ).join('\n');

  const guidance = DIAGRAM_TYPE_GUIDANCE[diagramType] ?? DIAGRAM_TYPE_GUIDANCE['flowchart'];

  const prompt = `You are an expert in cloud architecture diagrams and Mermaid syntax.
Analyze this ${cloudProvider} Terraform infrastructure and improve the provided ${diagramType} Mermaid diagram.

CLOUD PROVIDER: ${cloudProvider}

RESOURCES:
${resourcesText}

RELATIONSHIPS:
${relationshipsText}

CURRENT MERMAID SYNTAX:
\`\`\`
${baseSyntax}
\`\`\`

Your task:
${guidance.instructions}

STRICT RULES:
- Return ONLY the improved Mermaid syntax — no explanations, no markdown fences
- The output MUST start with the correct Mermaid diagram declaration (e.g., "${guidance.validTokens[0]}")
- Keep the syntax valid and parseable by Mermaid
- Maintain all existing resources and relationships
- Do not invent resources that are not in the list above
- PRESERVE all existing node identifiers exactly as they appear (the alphanumeric part before the bracket). You may change the display label inside the brackets but never rename the identifier.
- Every node label MUST be on a single line, wrapped in double-quotes: nodeId["label text"]
- Do NOT include classDef or class directives — styling is applied separately
- Do NOT use parentheses () in node labels without proper quoting

Return the improved Mermaid syntax:`;

  try {
    const response = await openaiService.chat([
      {
        role: 'system',
        content: `You are an expert in cloud architecture diagrams and Mermaid syntax. You produce clean, professional ${diagramType} diagrams for ${cloudProvider} infrastructure.`
      },
      {
        role: 'user',
        content: prompt
      }
    ]);

    // Strip markdown code fences if the model wrapped the output
    let enhancedSyntax = response.trim();
    if (enhancedSyntax.startsWith('```mermaid')) {
      enhancedSyntax = enhancedSyntax.replace(/^```mermaid\s*\n/, '').replace(/\n```\s*$/, '');
    } else if (enhancedSyntax.startsWith('```')) {
      enhancedSyntax = enhancedSyntax.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
    }
    enhancedSyntax = enhancedSyntax.trim();

    // Validate the output starts with the expected token for this diagram type
    const isValid = guidance.validTokens.some(token => enhancedSyntax.startsWith(token));
    if (!isValid) {
      console.warn(`⚠️  AI returned syntax that doesn't start with expected token for ${diagramType}, using base syntax`);
      return baseSyntax;
    }

    return enhancedSyntax;
  } catch (error: any) {
    console.error('❌ AI enhancement error:', error.message);
    throw error;
  }
}

/**
 * Get resource category (helper function)
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



