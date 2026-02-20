/**
 * Test setup - mock modules that require external dependencies
 */
import { vi } from 'vitest';

// Mock db.ts to prevent DATABASE_URL requirement
vi.mock('../../../server/db.js', () => ({
  db: {},
}));
