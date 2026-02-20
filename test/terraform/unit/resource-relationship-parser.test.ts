
import {
  parseResources,
  detectRelationships,
  buildResourceGraph,
} from '../../../server/diagram/resource-relationship-parser.js';
import {
  validMainTf,
  validMainTfMultiResource,
  mainTfWithModules,
} from '../fixtures/terraform-samples.js';

describe('parseResources', () => {
  it('parses basic resource blocks', () => {
    const files = [{ fileName: 'main.tf', content: validMainTf }];
    const resources = parseResources(files);

    expect(resources.length).toBe(2);
    expect(resources[0].type).toBe('azurerm_resource_group');
    expect(resources[0].name).toBe('main');
    expect(resources[1].type).toBe('azurerm_storage_account');
    expect(resources[1].name).toBe('main');
  });

  it('parses multiple resource types', () => {
    const files = [{ fileName: 'main.tf', content: validMainTfMultiResource }];
    const resources = parseResources(files);

    expect(resources.length).toBe(6);
    const types = resources.map(r => r.type);
    expect(types).toContain('azurerm_resource_group');
    expect(types).toContain('azurerm_storage_account');
    expect(types).toContain('azurerm_virtual_network');
    expect(types).toContain('azurerm_subnet');
    expect(types).toContain('azurerm_key_vault');
    expect(types).toContain('azurerm_app_service_plan');
  });

  it('assigns correct file names', () => {
    const files = [{ fileName: 'networking.tf', content: validMainTf }];
    const resources = parseResources(files);

    resources.forEach(r => {
      expect(r.file).toBe('networking.tf');
    });
  });

  it('skips non-.tf files', () => {
    const files = [
      { fileName: 'main.tf', content: validMainTf },
      { fileName: 'readme.md', content: '# Readme' },
    ];
    const resources = parseResources(files);

    expect(resources.length).toBe(2); // Only from main.tf
  });

  it('parses module blocks', () => {
    const files = [{ fileName: 'main.tf', content: mainTfWithModules }];
    const resources = parseResources(files);

    expect(resources.length).toBe(2);
    const storageModule = resources.find(r => r.name === 'storage');
    expect(storageModule).toBeDefined();
    expect(storageModule!.type).toBe('azurerm_storage_account'); // inferred from name
    expect(storageModule!.attributes.isModule).toBe(true);
  });

  it('handles empty file list', () => {
    const resources = parseResources([]);
    expect(resources).toHaveLength(0);
  });

  it('handles file with no resources', () => {
    const files = [{ fileName: 'empty.tf', content: '# Just a comment' }];
    const resources = parseResources(files);
    expect(resources).toHaveLength(0);
  });

  it('extracts resource attributes', () => {
    const files = [{ fileName: 'main.tf', content: validMainTf }];
    const resources = parseResources(files);

    const storageAccount = resources.find(r => r.type === 'azurerm_storage_account');
    expect(storageAccount).toBeDefined();
    expect(storageAccount!.attributes).toBeDefined();
    expect(storageAccount!.attributes.name).toBeDefined();
  });

  it('tracks line numbers', () => {
    const files = [{ fileName: 'main.tf', content: validMainTf }];
    const resources = parseResources(files);

    resources.forEach(r => {
      expect(r.lineNumber).toBeGreaterThan(0);
    });
  });
});

describe('detectRelationships', () => {
  it('detects resource_group containment relationships', () => {
    const files = [{ fileName: 'main.tf', content: validMainTf }];
    const resources = parseResources(files);
    const relationships = detectRelationships(resources, files);

    const containsRel = relationships.find(
      r => r.type === 'contains' && r.from.includes('resource_group')
    );
    expect(containsRel).toBeDefined();
  });

  it('detects resource references', () => {
    const files = [{ fileName: 'main.tf', content: validMainTfMultiResource }];
    const resources = parseResources(files);
    const relationships = detectRelationships(resources, files);

    expect(relationships.length).toBeGreaterThan(0);
  });

  it('handles resources with no relationships', () => {
    const content = `
resource "azurerm_resource_group" "standalone" {
  name     = "standalone-rg"
  location = "eastus"
}
`;
    const files = [{ fileName: 'main.tf', content }];
    const resources = parseResources(files);
    const relationships = detectRelationships(resources, files);

    // Single resource group with no children = no relationships
    expect(relationships).toHaveLength(0);
  });

  it('avoids duplicate relationships', () => {
    const files = [{ fileName: 'main.tf', content: validMainTfMultiResource }];
    const resources = parseResources(files);
    const relationships = detectRelationships(resources, files);

    const relKeys = relationships.map(r => `${r.from}->${r.to}`);
    const uniqueKeys = new Set(relKeys);
    expect(relKeys.length).toBe(uniqueKeys.size);
  });
});

describe('buildResourceGraph', () => {
  it('returns complete resource graph', () => {
    const files = [{ fileName: 'main.tf', content: validMainTfMultiResource }];
    const graph = buildResourceGraph(files);

    expect(graph.resources.length).toBeGreaterThan(0);
    expect(graph.relationships).toBeDefined();
    expect(graph.resourceGroups).toBeDefined();
  });

  it('identifies resource groups', () => {
    const files = [{ fileName: 'main.tf', content: validMainTf }];
    const graph = buildResourceGraph(files);

    expect(graph.resourceGroups).toContain('main');
  });

  it('handles empty file list', () => {
    const graph = buildResourceGraph([]);
    expect(graph.resources).toHaveLength(0);
    expect(graph.relationships).toHaveLength(0);
    expect(graph.resourceGroups).toHaveLength(0);
  });
});
