import { z } from "zod";

// POST /api/sessions/:id/generate-automation
export const generateAutomationBody = z.object({
  description: z.string().optional(),
  language: z.string().optional(),
}).passthrough().openapi("GenerateAutomationBody");

export const generateAutomationResponse = z.object({
  success: z.boolean(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  message: z.string().optional(),
}).passthrough().openapi("GenerateAutomationResponse");

// POST /api/sessions/:id/commit-automation
export const commitAutomationBody = z.object({}).passthrough().openapi("CommitAutomationBody");
export const commitAutomationResponse = z.object({
  success: z.boolean(),
  commitMessage: z.string().optional(),
  result: z.any().optional(),
}).passthrough().openapi("CommitAutomationResponse");
