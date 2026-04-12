/**
 * Common Zod schemas shared across all API contracts.
 * These define reusable parameter shapes (session ID params, pagination, error envelopes, etc.)
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

// Extend Zod globally (idempotent — safe to call multiple times)
extendZodWithOpenApi(z);

// ── Common param schemas ────────────────────────────────────────────────
export const sessionIdParams = z.object({
  id: z.string().openapi({ description: "Session ID (UUID)", example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
});

export const providerParams = z.object({
  provider: z.enum(["github", "azure"]).openapi({ description: "Repository provider" }),
});

export const fileIdParams = z.object({
  id: z.string().openapi({ description: "File ID (UUID)" }),
});

export const secretTypeParams = z.object({
  type: z.enum(["azure-devops", "azure-cloud", "github", "aws", "gcp"]).openapi({ description: "Secret provider type" }),
});

// ── Pagination query ────────────────────────────────────────────────────
export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
});

// ── Common response envelopes ───────────────────────────────────────────
export const errorResponse = z.object({
  error: z.string(),
  errors: z.record(z.any()).optional(),
  details: z.any().optional(),
  code: z.string().optional(),
}).openapi("ErrorResponse");

export const successResponse = z.object({
  success: z.literal(true),
  message: z.string().optional(),
}).openapi("SuccessResponse");

export const messageResponse = z.object({
  message: z.string(),
}).openapi("MessageResponse");
