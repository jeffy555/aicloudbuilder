import { vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockOpenaiService, testStorageRef } = vi.hoisted(() => {
  const mockOpenaiService = {
    analyzeTerraformBestPractices: vi.fn().mockResolvedValue({
      issues: [],
      suggestions: [],
    }),
    generateBackendTf: vi.fn().mockReturnValue(''),
    generateProviderTf: vi.fn().mockReturnValue(''),
  };
  const testStorageRef = { current: null as any };
  return { mockOpenaiService, testStorageRef };
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

vi.mock('../../../server/openai-service.js', () => ({
  openaiService: mockOpenaiService,
}));

vi.mock('../../../server/mcp-client.js', () => ({
  mcpClient: {},
}));

import { MemStorage } from '../../../server/storage.js';
import { registerTerraformRoutes } from '../../../server/routes/terraform.js';
import {
  mainTfWithVariables,
  validVariablesTf,
  validMainTf,
  mainTfWithHardcodedValues,
  multipleResourcesSameType,
} from '../fixtures/terraform-samples.js';

function createApp() {
  const app = express();
  app.use(express.json());
  registerTerraformRoutes(app);
  return app;
}

describe('POST /api/sessions/:id/refactor', () => {
  let app: express.Express;

  beforeEach(() => {
    testStorageRef.current = new MemStorage();
    app = createApp();
    vi.clearAllMocks();
    mockOpenaiService.analyzeTerraformBestPractices.mockResolvedValue({
      issues: [],
      suggestions: [],
    });
  });

  it('returns 404 for non-existent session', async () => {
    const res = await request(app)
      .post('/api/sessions/non-existent/refactor');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Session not found');
  });

  it('returns validation result structure', async () => {
    const session = await testStorageRef.current.createSession({ userId: null });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: mainTfWithVariables,
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'variables.tf',
      content: validVariablesTf,
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'dev.terraform.tfvars',
      content: 'resource_group_name = "rg"\nlocation = "eastus"\nstorage_account_name = "sa"\n',
    });

    const res = await request(app)
      .post(`/api/sessions/${session.id}/refactor`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('isValid');
    expect(res.body).toHaveProperty('issues');
    expect(res.body).toHaveProperty('suggestions');
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('totalIssues');
    expect(res.body.summary).toHaveProperty('errors');
    expect(res.body.summary).toHaveProperty('warnings');
    expect(res.body.summary).toHaveProperty('filesChecked');
  });

  it('detects missing variable declarations', async () => {
    const session = await testStorageRef.current.createSession({ userId: null });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: mainTfWithVariables,
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'variables.tf',
      content: validVariablesTf,
    });

    const res = await request(app)
      .post(`/api/sessions/${session.id}/refactor`);

    expect(res.status).toBe(200);
    const missingDecl = res.body.issues.filter(
      (i: any) => i.type === 'missing_declaration'
    );
    expect(missingDecl.length).toBeGreaterThan(0);
  });

  it('detects variables declared but not in tfvars', async () => {
    const session = await testStorageRef.current.createSession({ userId: null });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: mainTfWithVariables,
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'variables.tf',
      content: validVariablesTf,
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'dev.terraform.tfvars',
      content: 'resource_group_name = "rg"\n',
    });

    const res = await request(app)
      .post(`/api/sessions/${session.id}/refactor`);

    expect(res.status).toBe(200);
    const missingTfvars = res.body.issues.filter(
      (i: any) => i.type === 'missing_tfvars'
    );
    expect(missingTfvars.length).toBeGreaterThan(0);
  });

  it('detects hardcoded values in main.tf', async () => {
    const session = await testStorageRef.current.createSession({ userId: null });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: mainTfWithHardcodedValues,
    });

    const res = await request(app)
      .post(`/api/sessions/${session.id}/refactor`);

    expect(res.status).toBe(200);
    const hardcoded = res.body.issues.filter(
      (i: any) => i.type === 'hardcoded_value'
    );
    expect(hardcoded.length).toBeGreaterThan(0);
  });

  it('reports file count in summary', async () => {
    const session = await testStorageRef.current.createSession({ userId: null });
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

    const res = await request(app)
      .post(`/api/sessions/${session.id}/refactor`);

    expect(res.status).toBe(200);
    expect(res.body.summary.filesChecked).toBe(2);
  });

  it('skips non-terraform files', async () => {
    const session = await testStorageRef.current.createSession({ userId: null });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: validMainTf,
    });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'README.md',
      content: '# Readme',
    });

    const res = await request(app)
      .post(`/api/sessions/${session.id}/refactor`);

    expect(res.status).toBe(200);
    expect(res.body.summary.filesChecked).toBe(1);
  });

  it('includes AI analysis results when available', async () => {
    mockOpenaiService.analyzeTerraformBestPractices.mockResolvedValueOnce({
      issues: [
        {
          file: 'main.tf',
          type: 'naming_issue',
          severity: 'warning',
          message: 'AI-detected naming issue',
          suggestion: 'Use consistent naming',
        },
      ],
      suggestions: [
        {
          file: 'main.tf',
          action: 'AI suggestion',
          details: 'Best practice recommendation',
        },
      ],
    });

    const session = await testStorageRef.current.createSession({ userId: null });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: validMainTf,
    });

    const res = await request(app)
      .post(`/api/sessions/${session.id}/refactor`);

    expect(res.status).toBe(200);
    const aiIssues = res.body.issues.filter((i: any) => i.message.includes('AI-detected'));
    expect(aiIssues.length).toBeGreaterThan(0);
  });

  it('continues when AI analysis fails', async () => {
    mockOpenaiService.analyzeTerraformBestPractices.mockRejectedValueOnce(
      new Error('AI service unavailable')
    );

    const session = await testStorageRef.current.createSession({ userId: null });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: mainTfWithHardcodedValues,
    });

    const res = await request(app)
      .post(`/api/sessions/${session.id}/refactor`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('issues');
  });

  it('detects multiple resources of same type', async () => {
    const session = await testStorageRef.current.createSession({ userId: null });
    await testStorageRef.current.createFile({
      sessionId: session.id,
      fileName: 'main.tf',
      content: multipleResourcesSameType,
    });

    const res = await request(app)
      .post(`/api/sessions/${session.id}/refactor`);

    expect(res.status).toBe(200);
    const multipleResIssues = res.body.issues.filter(
      (i: any) => i.type === 'multiple_resources_same_type'
    );
    expect(multipleResIssues.length).toBeGreaterThan(0);
  });
});
