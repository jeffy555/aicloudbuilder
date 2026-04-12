import { z } from "zod";
import { scoreMeReportSchema } from "../schema";

// POST /api/scoreme/run
export const scoremeRunBody = z.object({
  provider: z.enum(["github", "azure"]),
  repositoryId: z.string().min(1),
  repositoryName: z.string().min(1),
  repositoryFullName: z.string().optional(),
  branch: z.string().optional(),
}).openapi("ScoreMeRunBody");

export const scoremeRunResponse = scoreMeReportSchema.openapi("ScoreMeRunResponse");
