/**
 * routes-legacy.ts
 *
 * All endpoints previously living here have been migrated to modular route files:
 *
 *   POST /api/sessions/:id/generate-terraform  → routes/terraform-generation.ts
 *   POST /api/sessions/:id/scan                → routes/scan.ts
 *   POST /api/sessions/:id/fix-issues          → routes/fixes.ts
 *   POST /api/sessions/:id/analyze-cost        → routes/cost-analysis.ts
 *   POST /api/sessions/:id/chat                → routes/sessions.ts
 *   POST /api/sessions/:id/scan-repository     → routes/repositories.ts
 *   POST /api/sessions/:id/configure-backend   → routes/terraform.ts
 *   POST /api/sessions/:id/refactor            → routes/terraform.ts
 *   POST /api/sessions/:id/generate-diagram    → routes/terraform.ts
 *   POST /api/sessions/:id/generate-automation → routes/automation.ts
 *   POST /api/sessions/:id/commit              → routes/commit.ts
 *   POST /api/sessions/:id/scan-docker         → routes/docker.ts
 *   … (all other endpoints migrated to their respective route files)
 *
 * Registered in routes/index.ts. This file is kept as a pass-through stub only.
 */

import type { Express } from "express";
import { createServer, type Server } from "http";

export async function registerLegacyRoutes(app: Express): Promise<Server> {
  return createServer(app);
}
