import { z } from "zod";

// GET /api/checkov/status
export const checkovStatusResponse = z.object({
  installed: z.boolean(),
  recommended: z.string().nullable(),
  version: z.string().nullable(),
  allResults: z.array(z.object({
    method: z.string(),
    status: z.string(),
    version: z.string().optional(),
    error: z.string().optional(),
  })),
}).openapi("CheckovStatusResponse");
