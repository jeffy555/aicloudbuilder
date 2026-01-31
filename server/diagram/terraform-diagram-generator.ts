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
}

/**
 * Generate architecture diagram from Terraform files
 */
export async function generateArchitectureDiagram(
  files: Array<{ fileName: string; content: string }>,
  cloudProvider: string = 'azure',
  useAI: boolean = true,
  diagramType: DiagramType = 'flowchart'
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
    // Use existing flowchart generator
    const baseOptions: MermaidOptions = {
      diagramType: 'graph',
      theme: cloudProvider === 'azure' ? 'azure' : 'default',
      groupByCategory: true,
      showLabels: true
    };
    mermaidSyntax = generateMermaidSyntax(graph, baseOptions);
  } else {
    // Convert to other diagram types
    const diagramData = {
      resources: graph.resources.map(r => ({
        type: r.type,
        name: r.name,
        category: getResourceCategory(r.type),
      })),
      relationships: graph.relationships.map(r => ({
        from: r.from,
        to: r.to,
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
        theme: cloudProvider === 'azure' ? 'azure' : 'default',
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

  // Step 3: Enhance with AI if enabled (only for flowcharts)
  if (useAI && diagramType === 'flowchart') {
    console.log('\n🤖 Step 3: Enhancing diagram with AI...');
    try {
      mermaidSyntax = await enhanceWithAI(graph, mermaidSyntax, cloudProvider);
      console.log('   ✅ AI enhancement complete');
    } catch (error: any) {
      console.warn(`   ⚠️  AI enhancement failed: ${error.message}`);
      console.warn('   📝 Using base diagram without AI enhancement');
    }
  } else if (useAI && diagramType !== 'flowchart') {
    console.log(`\n⏭️  Skipping AI enhancement for ${diagramType} diagram type`);
  }

  // Step 4: Extract categories
  const categories = new Set<string>();
  graph.resources.forEach(r => {
    const category = getResourceCategory(r.type);
    categories.add(category);
  });

  // Step 5: Build result
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
    }
  };

  console.log('\n✅ Architecture diagram generation complete!');
  console.log(`   📊 Resources: ${result.metadata.totalResources}`);
  console.log(`   🔗 Relationships: ${result.metadata.totalRelationships}`);
  console.log(`   📁 Categories: ${result.metadata.categories.join(', ')}`);

  return result;
}

/**
 * Enhance Mermaid syntax using OpenAI
 */
async function enhanceWithAI(
  graph: ResourceGraph,
  baseSyntax: string,
  cloudProvider: string
): Promise<string> {
  const resourcesText = graph.resources.map(r => 
    `- ${r.type} "${r.name}" (${r.file})`
  ).join('\n');

  const relationshipsText = graph.relationships.map(r => 
    `- ${r.from} → ${r.to} (${r.type}: ${r.description || 'N/A'})`
  ).join('\n');

  const prompt = `You are an expert in cloud architecture diagrams. Analyze this Terraform infrastructure and improve the Mermaid diagram syntax.

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
1. Review the current Mermaid syntax
2. Improve the layout and organization
3. Ensure all resources and relationships are correctly represented
4. Add better labels and descriptions where helpful
5. Optimize the visual hierarchy (Resource Groups at top, dependencies flow downward)
6. Group related resources logically
7. Use clear, descriptive node labels

IMPORTANT:
- Return ONLY the improved Mermaid syntax
- Do not include markdown code blocks
- Keep the syntax valid and functional
- Maintain all existing relationships
- Use Azure color scheme if cloud provider is Azure

Return the improved Mermaid syntax:`;

  try {
    const response = await openaiService.chat([
      {
        role: 'system',
        content: 'You are an expert in cloud architecture diagrams and Mermaid syntax. Generate clean, professional architecture diagrams from Terraform code.'
      },
      {
        role: 'user',
        content: prompt
      }
    ]);

    // Clean up response (remove markdown code blocks if present)
    let enhancedSyntax = response.trim();
    if (enhancedSyntax.startsWith('```mermaid')) {
      enhancedSyntax = enhancedSyntax.replace(/^```mermaid\s*\n/, '').replace(/\n```\s*$/, '');
    } else if (enhancedSyntax.startsWith('```')) {
      enhancedSyntax = enhancedSyntax.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
    }

    // Validate that it's still valid Mermaid syntax
    if (enhancedSyntax.includes('graph') || enhancedSyntax.includes('flowchart')) {
      return enhancedSyntax;
    } else {
      console.warn('⚠️  AI returned invalid syntax, using base syntax');
      return baseSyntax;
    }
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



