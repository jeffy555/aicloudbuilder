
import { generateMermaidSyntax } from '../../../server/diagram/mermaid-generator.js';
import { buildResourceGraph } from '../../../server/diagram/resource-relationship-parser.js';
import {
  validMainTf,
  validMainTfMultiResource,
} from '../fixtures/terraform-samples.js';
import type { ResourceGraph } from '../../../server/diagram/resource-relationship-parser.js';

describe('generateMermaidSyntax', () => {
  it('generates valid mermaid from resource graph', () => {
    const files = [{ fileName: 'main.tf', content: validMainTf }];
    const graph = buildResourceGraph(files);
    const mermaid = generateMermaidSyntax(graph);

    expect(mermaid).toContain('graph TB');
    expect(mermaid).toContain('azurerm_resource_group_main');
    expect(mermaid).toContain('azurerm_storage_account_main');
  });

  it('handles resource dependencies with edges', () => {
    const files = [{ fileName: 'main.tf', content: validMainTfMultiResource }];
    const graph = buildResourceGraph(files);
    const mermaid = generateMermaidSyntax(graph);

    expect(mermaid).toContain('-->');
  });

  it('handles empty resource graph', () => {
    const emptyGraph: ResourceGraph = {
      resources: [],
      relationships: [],
      resourceGroups: [],
    };
    const mermaid = generateMermaidSyntax(emptyGraph);

    expect(mermaid).toContain('graph TB');
  });

  it('groups resources by category when enabled', () => {
    const files = [{ fileName: 'main.tf', content: validMainTfMultiResource }];
    const graph = buildResourceGraph(files);
    const mermaid = generateMermaidSyntax(graph, { groupByCategory: true });

    // Should have subgraph sections for categories
    expect(mermaid).toContain('subgraph');
  });

  it('does not group when groupByCategory is false', () => {
    const files = [{ fileName: 'main.tf', content: validMainTfMultiResource }];
    const graph = buildResourceGraph(files);
    const mermaid = generateMermaidSyntax(graph, { groupByCategory: false });

    expect(mermaid).not.toContain('subgraph');
  });

  it('applies Azure styling when theme is azure', () => {
    const files = [{ fileName: 'main.tf', content: validMainTfMultiResource }];
    const graph = buildResourceGraph(files);
    const mermaid = generateMermaidSyntax(graph, { theme: 'azure' });

    expect(mermaid).toContain('classDef');
    expect(mermaid).toContain('Azure Styling');
  });

  it('generates C4 diagram when diagramType is C4', () => {
    const files = [{ fileName: 'main.tf', content: validMainTf }];
    const graph = buildResourceGraph(files);
    const mermaid = generateMermaidSyntax(graph, { diagramType: 'C4' });

    expect(mermaid).toContain('C4Container');
    expect(mermaid).toContain('Container(');
  });

  it('shows labels when showLabels is true', () => {
    const files = [{ fileName: 'main.tf', content: validMainTf }];
    const graph = buildResourceGraph(files);
    const mermaid = generateMermaidSyntax(graph, { showLabels: true });

    // Labels contain resource type name formatted
    expect(mermaid).toContain('<br/>');
  });

  it('hides labels when showLabels is false', () => {
    const files = [{ fileName: 'main.tf', content: validMainTf }];
    const graph = buildResourceGraph(files);
    const mermaid = generateMermaidSyntax(graph, { showLabels: false });

    // Without labels, should not have the formatted type names
    expect(mermaid).not.toContain('<br/>');
  });
});
