/**
 * Architecture Diagram Generator
 * 
 * Converts ArchitectureAnalysis into Mermaid diagram syntax.
 * Supports multi-cloud architectures with subgraphs and color coding.
 */

import type {
  ArchitectureAnalysis,
  ArchitectureComponent,
  ArchitectureRelationship
} from './architecture-analyzer';
import { convertToDiagramType, DiagramType } from './diagram-type-generator';

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
 * Generate base Mermaid syntax from analysis.
 *
 * Design principles (to avoid text overlap):
 *  1. Use `graph TB` — top-to-bottom gives the most horizontal room per rank.
 *  2. Flat subgraphs only — NO nested sub-subgraphs ("Nodes", "Services").
 *  3. One edge per pair of nodes — relationships and dataFlows are merged;
 *     the first edge wins so labels never stack on top of each other.
 *  4. Short labels — node names ≤ 22 chars, edge labels ≤ 18 chars.
 *  5. Edge labels come from the relationship type only (not the description),
 *     keeping them to a single short word.
 */
function generateBaseMermaidSyntax(analysis: ArchitectureAnalysis): string {

  // ── helpers ──────────────────────────────────────────────────────────
  const sanitizeId = (name: string): string =>
    name
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 30);

  const shortLabel = (name: string): string =>
    name.length > 22 ? name.substring(0, 19) + '...' : name;

  // ── node-id map (built once) ────────────────────────────────────────
  const nodeIds = new Map<string, string>();
  // Ensure unique IDs — append _2, _3 etc. on collision
  const usedIds = new Set<string>();
  for (const c of analysis.components) {
    let id = sanitizeId(c.name);
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}_${suffix}`)) suffix++;
      id = `${id}_${suffix}`;
    }
    usedIds.add(id);
    nodeIds.set(c.name, id);
  }

  // ── classify components ─────────────────────────────────────────────
  const clusterNames = new Set<string>();
  const inCluster = new Set<string>();

  // Identify Kubernetes clusters
  for (const c of analysis.components) {
    const n = c.name.toLowerCase();
    const t = c.type.toLowerCase();
    if (
      n.includes('aks') || n.includes('eks') || n.includes('gke') ||
      n.includes('kubernetes') ||
      t.includes('kubernetes') || t.includes('aks') || t.includes('eks') || t.includes('gke') ||
      c.metadata?.serviceType === 'Kubernetes' ||
      c.metadata?.codeType === 'kubernetes'
    ) {
      clusterNames.add(c.name);
    }
  }

  // Determine which components live inside a cluster
  for (const c of analysis.components) {
    if (clusterNames.has(c.name)) continue;
    if (c.metadata?.deploymentContext === 'in-cluster') {
      inCluster.add(c.name);
      continue;
    }
    // Check relationship hints ("deployed on", "runs inside")
    for (const rel of analysis.relationships) {
      if (
        (rel.from === c.name || rel.to === c.name) &&
        (rel.type.includes('deploy') || rel.type.includes('run') ||
         rel.type.includes('inside') || rel.type.includes('within'))
      ) {
        const other = rel.from === c.name ? rel.to : rel.from;
        if (clusterNames.has(other)) { inCluster.add(c.name); break; }
      }
    }
  }

  // External = everything not a cluster and not in-cluster
  const externalComponents = analysis.components.filter(
    c => !clusterNames.has(c.name) && !inCluster.has(c.name)
  );

  // ── start building syntax ───────────────────────────────────────────
  let syntax = 'graph TB\n';

  // Cluster subgraphs (flat — services listed directly, no nested sub-subgraphs)
  for (const c of analysis.components) {
    if (!clusterNames.has(c.name)) continue;
    const id = nodeIds.get(c.name)!;
    syntax += `    subgraph ${id}["${shortLabel(c.name)}"]\n`;

    // List in-cluster services as direct children
    const members = analysis.components.filter(m => inCluster.has(m.name));
    for (const m of members) {
      syntax += `        ${nodeIds.get(m.name)!}["${shortLabel(m.name)}"]\n`;
    }

    // If cluster has no members, add the cluster node itself so the box isn't empty
    if (members.length === 0) {
      syntax += `        ${id}_core["${shortLabel(c.name)}"]\n`;
    }
    syntax += `    end\n\n`;
  }

  // Group external components by provider for clean subgraphs
  const providerGroups: Record<string, ArchitectureComponent[]> = {};
  for (const c of externalComponents) {
    const key = c.cloudProvider === 'multi' ? 'unknown' : c.cloudProvider;
    (providerGroups[key] ??= []).push(c);
  }

  const providerLabels: Record<string, string> = {
    azure: 'Azure', aws: 'AWS', gcp: 'GCP',
    'third-party': 'Third-Party', unknown: 'Other',
  };

  for (const [provider, comps] of Object.entries(providerGroups)) {
    if (comps.length === 0) continue;
    const sgId = provider.replace(/[^a-zA-Z0-9]/g, '_');
    syntax += `    subgraph ${sgId}["${providerLabels[provider] || provider}"]\n`;
    for (const c of comps) {
      syntax += `        ${nodeIds.get(c.name)!}["${shortLabel(c.name)}"]\n`;
    }
    syntax += `    end\n\n`;
  }

  // ── edges (deduplicated: one edge per ordered pair) ─────────────────
  // Track emitted edges to avoid duplicates (key = "fromId->toId")
  const emittedEdges = new Set<string>();

  const addEdge = (fromName: string, toName: string, label: string) => {
    const fromId = nodeIds.get(fromName);
    const toId = nodeIds.get(toName);
    if (!fromId || !toId || fromId === toId) return;

    // Skip edges where both endpoints are cluster subgraph IDs (would be subgraph→subgraph)
    if (clusterNames.has(fromName) && clusterNames.has(toName)) return;

    // Skip edges where one end is a cluster (the component is inside the subgraph already)
    // unless the other end is external — in that case connect from an in-cluster member
    if (clusterNames.has(fromName) || clusterNames.has(toName)) return;

    const edgeKey = `${fromId}->${toId}`;
    const reverseKey = `${toId}->${fromId}`;
    if (emittedEdges.has(edgeKey) || emittedEdges.has(reverseKey)) return;
    emittedEdges.add(edgeKey);

    const edgeLabel = label ? `|${label}|` : '';
    syntax += `    ${fromId} -->${edgeLabel} ${toId}\n`;
  };

  // Short label for relationship type
  const shortRelLabel = (type: string): string => {
    const t = type.toLowerCase();
    if (t.includes('store') || t.includes('save')) return 'stores';
    if (t.includes('auth')) return 'auth';
    if (t.includes('monitor') || t.includes('observe')) return 'monitors';
    if (t.includes('log')) return 'logs';
    if (t.includes('deploy') || t.includes('run')) return 'deploys';
    if (t.includes('expose') || t.includes('api')) return 'exposes';
    if (t.includes('orchestrat')) return 'orchestrates';
    if (t.includes('process')) return 'processes';
    return '';
  };

  // Emit relationships
  for (const rel of analysis.relationships) {
    addEdge(rel.from, rel.to, shortRelLabel(rel.type));
  }

  // Emit data flows (only if not already covered by a relationship edge)
  for (const df of analysis.dataFlows) {
    const label = df.protocol || '';
    addEdge(df.source, df.target, label);
  }

  // ── styling ─────────────────────────────────────────────────────────
  syntax += `\n    classDef azure fill:#0078d4,stroke:#005a9e,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef aws fill:#ff9900,stroke:#e68900,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef gcp fill:#4285f4,stroke:#1967d2,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef thirdParty fill:#6c757d,stroke:#495057,stroke-width:2px,color:#fff\n`;

  for (const c of analysis.components) {
    const id = nodeIds.get(c.name);
    if (!id) continue;
    if (c.cloudProvider === 'azure') syntax += `    class ${id} azure\n`;
    else if (c.cloudProvider === 'aws') syntax += `    class ${id} aws\n`;
    else if (c.cloudProvider === 'gcp') syntax += `    class ${id} gcp\n`;
    else if (c.cloudProvider === 'third-party' || c.isThirdParty) syntax += `    class ${id} thirdParty\n`;
  }

  return syntax;
}


