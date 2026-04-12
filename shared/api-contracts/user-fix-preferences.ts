import { z } from "zod";

const fixPreferenceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  checkId: z.string(),
  resourceType: z.string(),
  fixSnippet: z.string(),
  confidence: z.number(),
  timesUsed: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  source: z.string(),
  lastUsedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).openapi("FixPreference");

// GET /api/users/me/fix-preferences
export const listPreferencesResponse = z.array(fixPreferenceSchema).openapi("FixPreferencesList");

// GET /api/users/me/fix-preferences/stats
export const preferencesStatsResponse = z.any().openapi("FixPreferencesStats");

// GET /api/users/me/fix-preferences/top
export const topPreferencesResponse = z.array(fixPreferenceSchema).openapi("TopFixPreferences");

// GET /api/users/me/fix-preferences/search
export const searchPreferencesQuery = z.object({
  checkId: z.string().optional(),
  resourceType: z.string().optional(),
}).openapi("SearchPreferencesQuery");

export const searchPreferencesResponse = z.array(fixPreferenceSchema).openapi("SearchPreferencesResult");

// POST /api/users/me/fix-preferences
export const createPreferenceBody = z.object({
  checkId: z.string(),
  resourceType: z.string(),
  fixSnippet: z.string(),
  source: z.enum(["user_verified", "checkov", "ai_generated", "user_preference"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).openapi("CreateFixPreferenceBody");

export const createPreferenceResponse = fixPreferenceSchema;

// PUT /api/users/me/fix-preferences/:id
export const updatePreferenceBody = z.object({
  fixSnippet: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().optional(),
}).passthrough().openapi("UpdateFixPreferenceBody");

export const updatePreferenceResponse = fixPreferenceSchema;

// DELETE /api/users/me/fix-preferences/:id
export const deletePreferenceResponse = z.object({
  success: z.boolean(),
}).openapi("DeleteFixPreferenceResponse");

// DELETE /api/users/me/fix-preferences (bulk)
export const bulkDeleteResponse = z.object({
  success: z.boolean(),
  deleted: z.number(),
}).openapi("BulkDeletePreferencesResponse");
