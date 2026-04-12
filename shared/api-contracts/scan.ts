import { z } from "zod";

// POST /api/sessions/:id/scan
export const scanBody = z.object({
  scanType: z.string().optional(),
}).passthrough().openapi("ScanBody");

export const scanResponse = z.object({
  results: z.any(),
}).passthrough().openapi("ScanResponse");
