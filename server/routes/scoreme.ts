import type { Express, Request, Response } from "express";
import { scoreMeService, type ScoreMeRequest } from "../services/scoreme-service";
import { requireAuth } from "../middleware/auth";

export function registerScoreMeRoutes(app: Express) {
  app.post("/api/scoreme/run", requireAuth, async (req: Request, res: Response) => {
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

      const report = await scoreMeService.runScore(userId, payload);
      res.json(report);
    } catch (error: any) {
      console.error("[ScoreMe] failed to run:", error);
      res.status(500).json({ error: "Failed to generate ScoreMe report" });
    }
  });
}

