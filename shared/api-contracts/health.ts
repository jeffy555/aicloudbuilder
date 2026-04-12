import { z } from "zod";

// GET /api/health
export const healthResponse = z.object({
  status: z.literal("ok"),
  timestamp: z.string(),
}).openapi("HealthResponse");
