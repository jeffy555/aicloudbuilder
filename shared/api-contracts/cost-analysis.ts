import { z } from "zod";
import { costAnalysisRequestSchema, costAnalysisResultSchema } from "../schema";

// POST /api/sessions/:id/analyze-cost
// Re-export existing schemas from shared/schema.ts
export const analyzeCostBody = costAnalysisRequestSchema.openapi("AnalyzeCostBody");
export const analyzeCostResponse = costAnalysisResultSchema.openapi("AnalyzeCostResponse");
