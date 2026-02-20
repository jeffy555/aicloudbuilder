import type { Express } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { storage } from "../storage";
import type { Session } from "@shared/schema";

function inferModule(session: Session): string {
  if (session.activeModule) return session.activeModule;
  if (session.cloudProvider || session.moduleApproach || session.backendType) return 'terraform';
  if (session.archMeAnalysis) return 'archme';
  return 'unknown';
}

export function registerHistoryRoutes(app: Express) {
  app.get("/api/user/history", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const moduleParam = (req.query.module as string || '').trim();
      const filterModule = moduleParam && moduleParam !== 'all' ? moduleParam : undefined;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const offset = Number(req.query.offset) || 0;

      // Fetch sessions and activities in parallel; activities table may not exist yet
      const [sessionsList, totalSessions] = await Promise.all([
        storage.getSessionsByUser(userId, { module: filterModule, limit, offset }),
        storage.getSessionCountByUser(userId),
      ]);

      let activities: any[] = [];
      try {
        activities = await storage.getUserActivities(userId, { module: filterModule, limit, offset });
      } catch (e) {
        // user_activities table may not exist yet — gracefully degrade
        console.warn("[History] getUserActivities failed (table may not exist):", (e as Error).message);
      }

      // Enrich sessions with message/file counts and inferred module
      const enrichedSessions = await Promise.all(
        sessionsList.map(async (session) => {
          const [msgs, files] = await Promise.all([
            storage.getMessagesBySession(session.id),
            storage.getFilesBySession(session.id),
          ]);
          return {
            ...session,
            messageCount: msgs.length,
            fileCount: files.length,
            inferredModule: inferModule(session),
          };
        })
      );

      // When filtering by module, also include sessions inferred as that module
      let filteredSessions = enrichedSessions;
      if (filterModule) {
        filteredSessions = enrichedSessions.filter(
          (s) => s.inferredModule === filterModule
        );
      }

      res.json({
        sessions: filteredSessions,
        activities,
        totalSessions,
        totalActivities: activities.length,
      });
    } catch (error: any) {
      console.error("[History] failed:", error);
      res.status(500).json({ error: "Failed to fetch user history" });
    }
  });
}
