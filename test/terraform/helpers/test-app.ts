/**
 * Test Express application helper
 * Creates a minimal Express app with Terraform routes and MemStorage for isolated tests
 */

import express from 'express';
import session from 'express-session';
import { MemStorage, type IStorage } from '../../../server/storage.js';
import { registerTerraformRoutes } from '../../../server/routes/terraform.js';
import { registerSessionRoutes } from '../../../server/routes/sessions.js';

export interface TestApp {
  app: express.Express;
  storage: IStorage;
}

/**
 * Create a test Express app with MemStorage and Terraform routes
 */
export function createTestApp(): TestApp {
  const storage = new MemStorage();
  const app = express();

  app.use(express.json({ limit: '50mb' }));
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
  }));

  // Register routes
  registerSessionRoutes(app);
  registerTerraformRoutes(app);

  return { app, storage };
}

/**
 * Create a test session directly in storage
 */
export async function createTestSession(
  storage: IStorage,
  overrides: Record<string, any> = {}
): Promise<any> {
  return storage.createSession({
    userId: overrides.userId ?? null,
    provider: overrides.provider ?? null,
    cloudProvider: overrides.cloudProvider ?? null,
    moduleApproach: overrides.moduleApproach ?? null,
    activeModule: overrides.activeModule ?? null,
    currentStep: overrides.currentStep ?? '1',
    ...overrides,
  });
}

/**
 * Create a test user directly in storage
 */
export async function createTestUser(
  storage: IStorage,
  overrides: Record<string, any> = {}
): Promise<any> {
  return storage.createUser({
    username: overrides.username ?? 'testuser',
    email: overrides.email ?? 'test@example.com',
    password: overrides.password ?? 'hashedpassword123',
    ...overrides,
  });
}
