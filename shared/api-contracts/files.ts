import { z } from "zod";

const generatedFileSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  fileName: z.string(),
  content: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).openapi("GeneratedFile");

// GET /api/sessions/:id/files
export const getFilesResponse = z.array(generatedFileSchema).openapi("FilesResponse");

// POST /api/sessions/:id/files
export const createFileBody = z.object({
  fileName: z.string().min(1),
  content: z.string(),
}).openapi("CreateFileBody");

export const createFileResponse = generatedFileSchema;

// POST /api/sessions/:id/files/bulk
export const bulkFilesBody = z.object({
  files: z.array(z.object({ fileName: z.string(), content: z.string() })).min(1),
}).openapi("BulkFilesBody");

export const bulkFilesResponse = z.object({
  success: z.literal(true),
  files: z.array(generatedFileSchema),
  updated: z.number(),
  created: z.number(),
  total: z.number(),
}).openapi("BulkFilesResponse");

// PATCH /api/files/:id
export const updateFileBody = z.object({
  content: z.string(),
}).openapi("UpdateFileBody");

export const updateFileResponse = generatedFileSchema;
