import { vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockGenerateArchitectureDiagram, testStorageRef } = vi.hoisted(() => {
  const mockGenerateArchitectureDiagram = vi.fn().mockResolvedValue({
    mermaidSyntax: 'graph TB\n    rg[Resource Group]\n    sa[Storage Account]\n    rg --> sa',
    resources: [
      { type: 'azurerm_resource_group', name: 'main' },
      { type: 'azurerm_storage_account', name: 'main' },
    ],
    relationships: [
      { from: 'azurerm_resource_group.main', to: 'azurerm_storage_account.main', type: 'contains' },
    ],
    metadata: {
      totalResources: 2,
      totalRelationships: 1,
      categories: ['Storage'],
    },
  });
  const testStorageRef = { current: null as any };
  return { mockGenerateArchitectureDiagram, testStorageRef };
});

vi.mock('../../../server/storage.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../server/storage.js')>();
  return {
    ...original,
    get storage() {
      return testStorageRef.current;
    },
  };
});

vi.mock('../../../server/diagram/terraform-diagram-generator.js', () => ({
  generateArchitectureDiagram: mockGenerateArchitectureDiagram,
}));

vi.mock('../../../server/mcp-client.js', () => ({
  mcpClient: {},
}));

vi.mock('../../../server/openai-service.js', () => ({
  openaiService: {
    generateBackendTf: vi.fn().mockReturnValue(''),
    generateProviderTf: vi.fn().mockReturnValue(''),
  },
}));

import { MemStorage } from '../../../server/storage.js';
import { registerTerraformRoutes } from '../../../server/routes/terraform.js';
import { validMainTf } from '../fixtures/terraform-samples.js';

function createApp() {
  const app = express();
  app.use(express.json());
  registerTerraformRoutes(app);
  return app;
}

describe('POST /api/sessions/:id/generate-diagram', () => {
  let app: express.Express;

  beforeEach(() => {
    testStorageRef.current = new MemStorage();
    app = createApp();
    vi.clearAllMocks();
    mockGenerateArchitectureDiagram.mockResolvedValue({
      mermaidSyntax: 'graph TB\n    rg[Resource Group]\n    sa[Storage Account]\n    rg --> sa',
      resources: [
        { type: 'azurerm_resource_group', name: 'main' },
        { type: 'azurerm_storage_account', name: 'main' },
      ],
      relationships: [
        { from: 'azurerm_resource_group.main', to: 'azurerm_storage_account.main', type: 'contains' },
      ],
      metadata: {
        totalResources: 2,
        totalRelationships: 1,
        categories: ['Storage'],
      },
    });
  });

  it('returns 404 for non-existent session', async () => {
    const res = await request(app)
      .post('/api/sessions/non-existent/generate-diagram')
      .send({});

    expect(res.status).toBe(404);
  });

  it('returns 400 when no terraform files exist', async () => {
    const session = await testStorageRef.current.createSession({ userId: null });

    const res = await request(app)
      .post(`/api/sessions/${session.id}/generate-diagram`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No Terraform files');
  });

  it('generates diagram for valid terraform files', async () => {
    const session = await testStorageRef.current.createSession({
      userId: null,
      cloudProvider: 'azure',
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: validMainTf,
    });

    const res = await request(app)
      .post(`/api/sessions/${session.id}/generate-diagram`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.mermaidSyntax).toBeDefined();
    expect(res.body.resources).toBeDefined();
    expect(res.body.relationships).toBeDefined();
    expect(res.body.metadata).toBeDefined();
  });

  it('passes correct cloud provider to diagram generator', async () => {
    const session = await testStorageRef.current.createSession({
      userId: null,
      cloudProvider: 'azure',
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: validMainTf,
    });

    await request(app)
      .post(`/api/sessions/${session.id}/generate-diagram`)
      .send({});

    expect(mockGenerateArchitectureDiagram).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ fileName: 'main.tf' }),
      ]),
      'azure',
      true,
      'flowchart'
    );
  });

  it('excludes backend files for aggregated-root approach', async () => {
    const session = await testStorageRef.current.createSession({
      userId: null,
      cloudProvider: 'azure',
      moduleApproach: 'aggregated-root',
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: validMainTf,
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'backend.tf',
      content: 'terraform { backend "azurerm" {} }',
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'provider.tf',
      content: 'provider "azurerm" {}',
    });

    await request(app)
      .post(`/api/sessions/${session.id}/generate-diagram`)
      .send({});

    const calledFiles = mockGenerateArchitectureDiagram.mock.calls[0][0];
    const fileNames = calledFiles.map((f: any) => f.fileName);
    expect(fileNames).toContain('main.tf');
    expect(fileNames).not.toContain('backend.tf');
    expect(fileNames).not.toContain('provider.tf');
  });

  it('respects diagramType from request body', async () => {
    const session = await testStorageRef.current.createSession({
      userId: null,
      cloudProvider: 'azure',
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: validMainTf,
    });

    await request(app)
      .post(`/api/sessions/${session.id}/generate-diagram`)
      .send({ diagramType: 'graph' });

    expect(mockGenerateArchitectureDiagram).toHaveBeenCalledWith(
      expect.any(Array),
      'azure',
      true,
      'graph'
    );
  });

  it('respects useAI flag from request body', async () => {
    const session = await testStorageRef.current.createSession({
      userId: null,
      cloudProvider: 'azure',
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: validMainTf,
    });

    await request(app)
      .post(`/api/sessions/${session.id}/generate-diagram`)
      .send({ useAI: false });

    expect(mockGenerateArchitectureDiagram).toHaveBeenCalledWith(
      expect.any(Array),
      'azure',
      false,
      'flowchart'
    );
  });

  it('skips empty terraform files', async () => {
    const session = await testStorageRef.current.createSession({
      userId: null,
      cloudProvider: 'azure',
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: validMainTf,
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'empty.tf',
      content: '   ',
    });

    await request(app)
      .post(`/api/sessions/${session.id}/generate-diagram`)
      .send({});

    const calledFiles = mockGenerateArchitectureDiagram.mock.calls[0][0];
    expect(calledFiles).toHaveLength(1);
    expect(calledFiles[0].fileName).toBe('main.tf');
  });
});
