import type { Express, Request, Response } from "express";
import { scoreMeService, type ScoreMeRequest } from "../services/scoreme-service";
import { requireAuth } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { aiHeavyLimiter } from "../middleware/rate-limit";
import { scoremeRunBody } from "@shared/api-contracts/scoreme";
import { storage } from "../storage";
import { createLogger } from "../utils/logger";

const log = createLogger('ScoreMe');

export function registerScoreMeRoutes(app: Express) {
  app.post("/api/scoreme/run", requireAuth, aiHeavyLimiter, validateRequest({ body: scoremeRunBody }), async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const payload = req.body as ScoreMeRequest;
      if (
        !payload ||
        !payload.provider ||
        !payload.repositoryId ||
        !payload.repositoryName ||
        (payload.provider === "github" && !payload.repositoryFullName)
      ) {
        return res.status(400).json({ error: "provider, repositoryId, repositoryName and (for GitHub) repositoryFullName are required" });
      }

      // 3-minute timeout to prevent hanging on slow AI calls
      const TIMEOUT_MS = 180_000;
      const report = await Promise.race([
        scoreMeService.runScore(userId, payload),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("ScoreMe analysis timed out after 3 minutes")), TIMEOUT_MS)
        ),
      ]);

      // Log activity for user history
      if (userId) {
        try {
          await storage.createUserActivity({
            userId,
            sessionId: null,
            module: 'scoreme',
            actionType: 'score_run',
            actionLabel: `ScoreMe: ${payload.repositoryName} (${report.finalScore}/100)`,
            metadata: { repository: payload.repositoryName, provider: payload.provider, finalScore: report.finalScore, confidence: report.confidence },
          });
        } catch (e) {
          log.warn('Failed to log activity', { error: e instanceof Error ? e.message : String(e) });
        }
      }

      res.json(report);
    } catch (error: any) {
      log.error('Failed to run', { error: error?.message || String(error) });
      res.status(500).json({ error: "Failed to generate ScoreMe report" });
    }
  });
}

