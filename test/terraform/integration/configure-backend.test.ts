import { vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Use vi.hoisted to create mock objects before vi.mock hoisting
const { mockMcpClient, mockOpenaiService, testStorageRef } = vi.hoisted(() => {
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
    generateBackendTf: vi.fn().mockReturnValue('terraform { backend "azurerm" {} }'),
    generateProviderTf: vi.fn().mockReturnValue('provider "azurerm" { features {} }'),
  };

  const testStorageRef = { current: null as any };
  return { mockMcpClient, mockOpenaiService, testStorageRef };
});

// Mock modules using hoisted variables
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

import { MemStorage } from '../../../server/storage.js';
import { registerTerraformRoutes } from '../../../server/routes/terraform.js';

function createApp() {
  const app = express();
  app.use(express.json());
  registerTerraformRoutes(app);
  return app;
}

describe('POST /api/sessions/:id/configure-backend', () => {
  let app: express.Express;

  beforeEach(() => {
    testStorageRef.current = new MemStorage();
    app = createApp();
    vi.clearAllMocks();
    // Reset mock defaults
    mockMcpClient.validateAzureStorageAccount.mockResolvedValue({ exists: true, location: 'eastus' });
    mockMcpClient.validateAzureContainer.mockResolvedValue({ exists: true });
    mockMcpClient.validateAzureResourceGroup.mockResolvedValue({ exists: true, location: 'eastus' });
    mockMcpClient.createAzureResourceGroup.mockResolvedValue({ success: true });
    mockMcpClient.createAzureStorageAccount.mockResolvedValue({ success: true });
    mockMcpClient.createAzureContainer.mockResolvedValue({ success: true });
    mockMcpClient.ensureServicePrincipalRoles.mockResolvedValue({ success: true, skipped: false });
    mockMcpClient.getLatestTerraformVersion.mockResolvedValue('1.9.0');
    mockOpenaiService.generateBackendTf.mockReturnValue('terraform { backend "azurerm" {} }');
    mockOpenaiService.generateProviderTf.mockReturnValue('provider "azurerm" { features {} }');
  });

  it('returns 404 for non-existent session', async () => {
    const res = await request(app)
      .post('/api/sessions/non-existent/configure-backend')
      .send({ action: 'create' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Session not found');
  });

  describe('decline action', () => {
    it('marks session as backend declined', async () => {
      const session = await testStorageRef.current.createSession({ userId: null });

      const res = await request(app)
        .post(`/api/sessions/${session.id}/configure-backend`)
        .send({ action: 'decline' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('declined');

      const updated = await testStorageRef.current.getSession(session.id);
      expect(updated!.backendDeclined).toBe('true');
      expect(updated!.backendValidated).toBe('skipped');
    });
  });

  describe('validate action', () => {
    it('validates existing Azure backend successfully', async () => {
      const session = await testStorageRef.current.createSession({
        userId: null,
        hasBackend: 'true',
        backendStorageAccount: 'myacct',
        backendResourceGroup: 'my-rg',
        backendContainer: 'tfstate',
      });

      const res = await request(app)
        .post(`/api/sessions/${session.id}/configure-backend`)
        .send({ action: 'validate' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('validated');
      expect(res.body.details.storageAccount).toBe('myacct');
    });

    it('returns validation_failed when storage account not found', async () => {
      mockMcpClient.validateAzureStorageAccount.mockResolvedValueOnce({ exists: false });

      const session = await testStorageRef.current.createSession({
        userId: null,
        hasBackend: 'true',
        backendStorageAccount: 'nonexistent',
        backendResourceGroup: 'my-rg',
        backendContainer: 'tfstate',
      });

      const res = await request(app)
        .post(`/api/sessions/${session.id}/configure-backend`)
        .send({ action: 'validate' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('validation_failed');
    });

    it('returns validation_failed when container not found', async () => {
      mockMcpClient.validateAzureContainer.mockResolvedValueOnce({ exists: false });

      const session = await testStorageRef.current.createSession({
        userId: null,
        hasBackend: 'true',
        backendStorageAccount: 'myacct',
        backendResourceGroup: 'my-rg',
        backendContainer: 'nonexistent',
      });

      const res = await request(app)
        .post(`/api/sessions/${session.id}/configure-backend`)
        .send({ action: 'validate' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('validation_failed');
    });

    it('returns 400 when backend config is incomplete', async () => {
      const session = await testStorageRef.current.createSession({
        userId: null,
        hasBackend: 'true',
      });

      const res = await request(app)
        .post(`/api/sessions/${session.id}/configure-backend`)
        .send({ action: 'validate' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('incomplete');
    });

    it('validates AWS backend', async () => {
      const session = await testStorageRef.current.createSession({
        userId: null,
        hasBackend: 'true',
        cloudProvider: 'aws',
        backendType: 's3',
        backendContainer: 'my-s3-bucket',
      });

      const res = await request(app)
        .post(`/api/sessions/${session.id}/configure-backend`)
        .send({ action: 'validate' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('validated');
      expect(res.body.details.bucket).toBe('my-s3-bucket');
    });
  });

  describe('create action', () => {
    it('creates Azure backend resources', async () => {
      const session = await testStorageRef.current.createSession({
        userId: null,
        cloudProvider: 'azure',
      });

      const res = await request(app)
        .post(`/api/sessions/${session.id}/configure-backend`)
        .send({
          action: 'create',
          backendConfig: {
            storageAccount: 'tfstate123',
            resourceGroup: 'terraform-rg',
            container: 'tfstate',
            location: 'eastus',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('configured');
      expect(res.body.details.filesGenerated).toContain('backend.tf');
      expect(res.body.details.filesGenerated).toContain('provider.tf');
      expect(res.body.details.filesGenerated).toContain('terraform.tf');

      // Verify files were created in storage
      const files = await testStorageRef.current.getFilesBySession(session.id);
      const fileNames = files.map((f: any) => f.fileName);
      expect(fileNames).toContain('backend.tf');
      expect(fileNames).toContain('provider.tf');
      expect(fileNames).toContain('terraform.tf');
    });

    it('creates AWS backend configuration', async () => {
      const session = await testStorageRef.current.createSession({
        userId: null,
        cloudProvider: 'aws',
      });

      const res = await request(app)
        .post(`/api/sessions/${session.id}/configure-backend`)
        .send({
          action: 'create',
          backendConfig: {
            bucket: 'my-tf-state',
            region: 'us-east-1',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('configured');
      expect(res.body.details.filesGenerated).toContain('backend.tf');
    });

    it('stores backend config in session', async () => {
      const session = await testStorageRef.current.createSession({
        userId: null,
        cloudProvider: 'azure',
      });

      await request(app)
        .post(`/api/sessions/${session.id}/configure-backend`)
        .send({
          action: 'create',
          backendConfig: {
            storageAccount: 'tfstate123',
            resourceGroup: 'terraform-rg',
            container: 'tfstate',
          },
        });

      const updated = await testStorageRef.current.getSession(session.id);
      expect(updated!.hasBackend).toBe('true');
      expect(updated!.backendType).toBe('azurerm');
      expect(updated!.backendStorageAccount).toBe('tfstate123');
      expect(updated!.backendResourceGroup).toBe('terraform-rg');
      expect(updated!.backendContainer).toBe('tfstate');
      expect(updated!.backendValidated).toBe('true');
    });

    it('uses defaults when no config provided', async () => {
      const session = await testStorageRef.current.createSession({
        userId: null,
        cloudProvider: 'azure',
      });

      const res = await request(app)
        .post(`/api/sessions/${session.id}/configure-backend`)
        .send({ action: 'create' });

      expect(res.status).toBe(200);
      expect(res.body.details.resourceGroup).toBe('terraform-state-rg');
      expect(res.body.details.container).toBe('tfstate');
    });
  });

  describe('invalid actions', () => {
    it('returns 400 for invalid action', async () => {
      const session = await testStorageRef.current.createSession({ userId: null });

      const res = await request(app)
        .post(`/api/sessions/${session.id}/configure-backend`)
        .send({ action: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid action');
    });
  });
});
