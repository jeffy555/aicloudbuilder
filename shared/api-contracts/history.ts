import { z } from "zod";

// GET /api/user/history
export const historyQuery = z.object({
  module: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
}).openapi("HistoryQuery");

export const historyResponse = z.object({
  sessions: z.array(z.any()),
  activities: z.array(z.any()),
  totalSessions: z.number(),
  totalActivities: z.number(),
}).openapi("HistoryResponse");
