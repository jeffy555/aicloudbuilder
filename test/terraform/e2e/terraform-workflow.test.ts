import { vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { validMainTf, validVariablesTf, validTfvars } from '../fixtures/terraform-samples.js';

const { mockMcpClient, mockOpenaiService, mockGenerateArchitectureDiagram, testStorageRef } = vi.hoisted(() => {
  const mockMcpClient = {
    validateAzureStorageAccount: vi.fn().mockResolvedValue({ exists: true, location: 'eastus' }),
    validateAzureContainer: vi.fn().mockResolvedValue({ exists: true }),
    validateAzureResourceGroup: vi.fn().mockResolvedValue({ exists: true, location: 'eastus' }),
    createAzureResourceGroup: vi.fn().mockResolvedValue({ success: true }),
    createAzureStorageAccount: vi.fn().mockResolvedValue({ success: true }),
    createAzureContainer: vi.fn().mockResolvedValue({ success: true }),
    ensureServicePrincipalRoles: vi.fn().mockResolvedValue({ success: true, skipped: false }),
    getLatestTerraformVersion: vi.fn().mockResolvedValue('1.9.0'),
  };

  const mockOpenaiService = {
    analyzeTerraformBestPractices: vi.fn().mockResolvedValue({ issues: [], suggestions: [] }),
    fixTerraformBestPractices: vi.fn().mockResolvedValue({ files: [], fixes: [] }),
    generateVariableDeclarations: vi.fn().mockResolvedValue(''),
    generateTfvarsValues: vi.fn().mockResolvedValue(''),
    generateBackendTf: vi.fn().mockReturnValue('terraform { backend "azurerm" {} }'),
    generateProviderTf: vi.fn().mockReturnValue('provider "azurerm" { features {} }'),
    chatWithContext: vi.fn().mockResolvedValue('Generating your infrastructure code...'),
    generateTerraform: vi.fn().mockResolvedValue({ files: [] }),
  };

  const mockGenerateArchitectureDiagram = vi.fn().mockResolvedValue({
    mermaidSyntax: 'graph TB\n    rg[Resource Group]\n    sa[Storage Account]\n    rg --> sa',
    resources: [
      { type: 'azurerm_resource_group', name: 'main' },
      { type: 'azurerm_storage_account', name: 'main' },
    ],
    relationships: [
      { from: 'azurerm_resource_group.main', to: 'azurerm_storage_account.main', type: 'contains' },
    ],
    metadata: { totalResources: 2, totalRelationships: 1, categories: ['Storage'] },
  });

  const testStorageRef = { current: null as any };
  return { mockMcpClient, mockOpenaiService, mockGenerateArchitectureDiagram, testStorageRef };
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

vi.mock('../../../server/mcp-client.js', () => ({
  mcpClient: mockMcpClient,
}));

vi.mock('../../../server/openai-service.js', () => ({
  openaiService: mockOpenaiService,
}));

vi.mock('../../../server/diagram/terraform-diagram-generator.js', () => ({
  generateArchitectureDiagram: mockGenerateArchitectureDiagram,
}));

import { MemStorage } from '../../../server/storage.js';
import { registerTerraformRoutes } from '../../../server/routes/terraform.js';
import { registerSessionRoutes } from '../../../server/routes/sessions.js';

function createApp() {
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app);
  registerTerraformRoutes(app);
  return app;
}

describe('Terraform Workflow E2E', () => {
  let app: express.Express;

  beforeEach(() => {
    testStorageRef.current = new MemStorage();
    app = createApp();
    vi.clearAllMocks();
    // Reset mock defaults
    mockMcpClient.ensureServicePrincipalRoles.mockResolvedValue({ success: true, skipped: false });
    mockMcpClient.getLatestTerraformVersion.mockResolvedValue('1.9.0');
    mockMcpClient.validateAzureResourceGroup.mockResolvedValue({ exists: true, location: 'eastus' });
    mockMcpClient.validateAzureStorageAccount.mockResolvedValue({ exists: true, location: 'eastus' });
    mockMcpClient.validateAzureContainer.mockResolvedValue({ exists: true });
    mockOpenaiService.analyzeTerraformBestPractices.mockResolvedValue({ issues: [], suggestions: [] });
    mockOpenaiService.generateBackendTf.mockReturnValue('terraform { backend "azurerm" {} }');
    mockOpenaiService.generateProviderTf.mockReturnValue('provider "azurerm" { features {} }');
    mockGenerateArchitectureDiagram.mockResolvedValue({
      mermaidSyntax: 'graph TB\n    rg[Resource Group]\n    sa[Storage Account]\n    rg --> sa',
      resources: [
        { type: 'azurerm_resource_group', name: 'main' },
        { type: 'azurerm_storage_account', name: 'main' },
      ],
      relationships: [
        { from: 'azurerm_resource_group.main', to: 'azurerm_storage_account.main', type: 'contains' },
      ],
      metadata: { totalResources: 2, totalRelationships: 1, categories: ['Storage'] },
    });
  });

  it('completes new repo workflow: create session -> configure backend -> refactor -> diagram', async () => {
    // Step 1: Create session
    const createRes = await request(app)
      .post('/api/sessions')
      .send({});

    expect(createRes.status).toBe(200);
    const sessionId = createRes.body.id;
    expect(sessionId).toBeDefined();

    // Step 2: Update session with provider and cloud settings
    const updateRes = await request(app)
      .patch(`/api/sessions/${sessionId}`)
      .send({
        provider: 'github',
        cloudProvider: 'azure',
        moduleApproach: 'aggregated-root',
        activeModule: 'terraform',
        currentStep: '5',
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.cloudProvider).toBe('azure');

    // Step 3: Configure backend (decline for simplicity)
    const backendRes = await request(app)
      .post(`/api/sessions/${sessionId}/configure-backend`)
      .send({ action: 'decline' });

    expect(backendRes.status).toBe(200);
    expect(backendRes.body.status).toBe('declined');

    // Step 4: Add terraform files (simulating generation)
    await testStorageRef.current.createFile({
      sessionId,
      fileName: 'main.tf',
      content: validMainTf,
    });
    await testStorageRef.current.createFile({
      sessionId,
      fileName: 'variables.tf',
      content: validVariablesTf,
    });
    await testStorageRef.current.createFile({
      sessionId,
      fileName: 'dev.terraform.tfvars',
      content: validTfvars,
    });

    // Step 5: Run refactor (best practices validation)
    const refactorRes = await request(app)
      .post(`/api/sessions/${sessionId}/refactor`);

    expect(refactorRes.status).toBe(200);
    expect(refactorRes.body).toHaveProperty('isValid');
    expect(refactorRes.body.summary.filesChecked).toBe(3);

    // Step 6: Generate diagram
    const diagramRes = await request(app)
      .post(`/api/sessions/${sessionId}/generate-diagram`)
      .send({});

    expect(diagramRes.status).toBe(200);
    expect(diagramRes.body.success).toBe(true);
    expect(diagramRes.body.mermaidSyntax).toBeDefined();

    // Verify session state
    const finalSession = await testStorageRef.current.getSession(sessionId);
    expect(finalSession!.cloudProvider).toBe('azure');
    expect(finalSession!.moduleApproach).toBe('aggregated-root');
    expect(finalSession!.backendDeclined).toBe('true');
  });

  it('completes existing repo workflow: create session -> upload files -> refactor -> diagram', async () => {
    // Step 1: Create session with existing repo flag
    const session = await testStorageRef.current.createSession({
      userId: null,
      provider: 'github',
      cloudProvider: 'azure',
      moduleApproach: 'aggregated-root',
      activeModule: 'terraform',
      currentStep: '5',
      isExistingRepo: 'true',
      detectedCloudProvider: 'azure',
      detectedModuleType: 'root',
    });

    // Step 2: Upload existing terraform files
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: validMainTf,
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'variables.tf',
      content: validVariablesTf,
    });

    // Step 3: Run refactor
    const refactorRes = await request(app)
      .post(`/api/sessions/${session.id}/refactor`);

    expect(refactorRes.status).toBe(200);
    expect(refactorRes.body.summary.filesChecked).toBe(2);

    // Step 4: Generate diagram
    const diagramRes = await request(app)
      .post(`/api/sessions/${session.id}/generate-diagram`)
      .send({});

    expect(diagramRes.status).toBe(200);
    expect(diagramRes.body.success).toBe(true);
  });

  it('preserves workflow state across multiple operations', async () => {
    // Create session with full state
    const session = await testStorageRef.current.createSession({
      userId: 'user-1',
      provider: 'github',
      cloudProvider: 'azure',
      moduleApproach: 'aggregated-root',
      activeModule: 'terraform',
      currentStep: '5',
      repositoryName: 'my-infra',
      repositoryId: 'repo-123',
    });

    // Update session step
    await request(app)
      .patch(`/api/sessions/${session.id}`)
      .send({ currentStep: '6' });

    // Add files
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: validMainTf,
    });

    // Add messages
    await testStorageRef.current.createMessage({
      sessionId: session.id,
      type: 'user',
      content: 'Create a storage account',
    });
    await testStorageRef.current.createMessage({
      sessionId: session.id,
      type: 'ai',
      content: 'Generating terraform code...',
    });

    // Verify all state preserved
    const finalSession = await testStorageRef.current.getSession(session.id);
    expect(finalSession!.userId).toBe('user-1');
    expect(finalSession!.provider).toBe('github');
    expect(finalSession!.cloudProvider).toBe('azure');
    expect(finalSession!.moduleApproach).toBe('aggregated-root');
    expect(finalSession!.activeModule).toBe('terraform');
    expect(finalSession!.currentStep).toBe('6');
    expect(finalSession!.repositoryName).toBe('my-infra');

    const messages = await testStorageRef.current.getMessagesBySession(session.id);
    expect(messages).toHaveLength(2);

    const files = await testStorageRef.current.getFilesBySession(session.id);
    expect(files).toHaveLength(1);

    // Verify user history
    const userSessions = await testStorageRef.current.getSessionsByUser('user-1');
    expect(userSessions).toHaveLength(1);
    expect(userSessions[0].id).toBe(session.id);
  });
});
