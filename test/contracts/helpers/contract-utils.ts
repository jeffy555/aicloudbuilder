/**
 * Contract Test Utilities
 *
 * Provides helpers for validating API responses against Zod schemas.
 * Tests run against the live server at http://localhost:9005.
 */
import supertest from "supertest";
import { ZodSchema } from "zod";

export const BASE_URL = process.env.API_BASE_URL || "http://localhost:9005";

export function getAgent() {
  return supertest(BASE_URL);
}

/**
 * Validate a response body against a Zod schema.
 * Returns { success, issues } for assertion in test.
 */
export function validateSchema(schema: ZodSchema, data: unknown) {
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { success: true, issues: [] };
}
