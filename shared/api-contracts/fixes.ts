import { z } from "zod";

// POST /api/sessions/:id/fix-issues
export const fixIssuesBody = z.object({
  selectedChecks: z.array(z.string()).optional(),
}).passthrough().openapi("FixIssuesBody");

export const fixIssuesResponse = z.object({
  success: z.boolean(),
  fixedFiles: z.array(z.any()).optional(),
  results: z.any().optional(),
}).passthrough().openapi("FixIssuesResponse");
