import { z } from "zod";

// POST /api/sessions/:id/commit
export const commitBody = z.object({}).passthrough().openapi("CommitBody");

export const commitResponse = z.object({
  success: z.literal(true),
  commitMessage: z.string(),
  result: z.any(),
  commitSha: z.string().optional(),
  branch: z.string().optional(),
  filesCommitted: z.number(),
  sessionReset: z.boolean().optional(),
  message: z.string().optional(),
}).openapi("CommitResponse");
