import type { Express } from "express";
import { requireAuth, optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { historyQuery } from "@shared/api-contracts/history";
import { storage } from "../storage";
import type { Session } from "@shared/schema";

function inferModule(session: Session): string {
  if (session.activeModule) return session.activeModule;
  if (session.cloudProvider || session.moduleApproach || session.backendType) return 'terraform';
  if (session.archMeAnalysis) return 'archme';
  if ((session as any).scannedResources || (session as any).scanTimestamp) return 'valuation';
  return 'unknown';
}

/** Total steps per module (used for progress calculation) */
const MODULE_TOTAL_STEPS: Record<string, number> = {
  terraform: 9,
  kubernetes: 7,
  docker: 6,
  archme: 5,
  automation: 5,
  helm: 7,
  valuation: 5,
};

/** Human-readable step labels per module */
const MODULE_STEP_LABELS: Record<string, Record<string, string>> = {
  terraform: { '1': 'Landing', '2': 'Provider', '3': 'Repository', '4': 'Cloud Provider', '5': 'Module Approach', '6': 'Backend Config', '7': 'Generation', '8': 'Review & Build', '9': 'Commit' },
  kubernetes: { '1': 'Workflow Type', '2': 'Repository', '3': 'Describe', '4': 'Generate', '5': 'Review', '6': 'Build & Report', '7': 'Commit' },
  docker: { '1': 'Repository', '2': 'Describe', '3': 'Generate', '4': 'Compose', '5': 'Review & Build', '6': 'Commit' },
  archme: { '1': 'Describe Architecture', '2': 'Repository', '3': 'Generate Code', '4': 'Review & Build', '5': 'Commit' },
  automation: { '1': 'Repository', '2': 'Template', '3': 'Configure', '4': 'Generate', '5': 'Commit' },
  valuation: { '1': 'Connect', '2': 'Select Resource Groups', '3': 'Scan Resources', '4': 'Analyze & Metrics', '5': 'Results' },
};

function getSessionStatus(session: Session, module: string, fileCount: number): 'not_started' | 'in_progress' | 'generated' | 'built' | 'committed' {
  const step = parseInt(session.currentStep || '1', 10);
  const totalSteps = MODULE_TOTAL_STEPS[module] || 7;

  // Valuation has no commit/build — step 5 (Results) is the final state
  if (module === 'valuation') {
    if (step >= 5) return 'committed'; // "completed" — analysis done
    if ((session as any).scannedResources) return 'generated'; // scan done
    if (step > 1) return 'in_progress';
    return 'not_started';
  }

  if (step >= totalSteps) return 'committed';
  if (step >= totalSteps - 1) return 'built';
  if (fileCount > 0) return 'generated';
  if (step > 1) return 'in_progress';
  return 'not_started';
}

export function registerHistoryRoutes(app: Express) {
  app.get("/api/user/history", requireAuth, validateRequest({ query: historyQuery }), async (req: AuthenticatedRequest, res) => {
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

      // Fetch build history for all sessions
      let allBuilds: any[] = [];
      try {
        allBuilds = await storage.getBuildHistory({ userId, limit: 200 });
      } catch (_) { /* graceful */ }
      const buildsBySession = new Map<string, any[]>();
      for (const b of allBuilds) {
        const arr = buildsBySession.get(b.sessionId) || [];
        arr.push(b);
        buildsBySession.set(b.sessionId, arr);
      }

      // Enrich sessions with message/file counts, first prompt, step info, build data
      const enrichedSessions = await Promise.all(
        sessionsList.map(async (session) => {
          const [msgs, files] = await Promise.all([
            storage.getMessagesBySession(session.id),
            storage.getFilesBySession(session.id),
          ]);

          const mod = inferModule(session);
          const step = parseInt(session.currentStep || '1', 10);
          const totalSteps = MODULE_TOTAL_STEPS[mod] || 7;
          const stepLabels = MODULE_STEP_LABELS[mod] || {};
          const status = getSessionStatus(session, mod, files.length);

          // Extract first user message as "prompt"
          const firstUserMsg = msgs.find(m => m.type === 'user');
          const prompt = firstUserMsg?.content?.substring(0, 200) || null;

          // Last message for context
          const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          const lastMessagePreview = lastMsg?.content?.substring(0, 120) || null;
          const lastMessageType = lastMsg?.type || null;

          // Build info
          const sessionBuilds = buildsBySession.get(session.id) || [];
          const lastBuild = sessionBuilds.length > 0 ? sessionBuilds[0] : null;

          return {
            ...session,
            messageCount: msgs.length,
            fileCount: files.length,
            inferredModule: mod,
            // New enrichment fields
            prompt,
            lastMessagePreview,
            lastMessageType,
            status,
            stepProgress: { current: step, total: totalSteps, label: stepLabels[String(step)] || `Step ${step}` },
            cloudProvider: session.cloudProvider || session.detectedCloudProvider || null,
            moduleApproach: session.moduleApproach || null,
            provider: session.provider || null,
            buildCount: sessionBuilds.length,
            lastBuildId: lastBuild?.buildId || null,
            lastBuildStatus: lastBuild?.status || null,
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

  // ── Build History Endpoints ────────────────────────────────────────────

  // POST /api/builds — Create a build history record
  app.post("/api/builds", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId, module, buildId, status, stages, pipelineStages, totalDurationMs, filesGenerated, repositoryName, repositoryBranch, metadata } = req.body;
      if (!sessionId || !module || !buildId) {
        return res.status(400).json({ error: "sessionId, module, and buildId are required" });
      }
      const build = await storage.createBuildHistory({
        userId: req.userId || null,
        sessionId,
        module,
        buildId,
        status: status || 'completed',
        stages: stages || null,
        pipelineStages: pipelineStages || null,
        totalDurationMs: totalDurationMs || null,
        filesGenerated: filesGenerated || null,
        repositoryName: repositoryName || null,
        repositoryBranch: repositoryBranch || null,
        metadata: metadata || null,
        completedAt: status === 'completed' ? new Date() : null,
      });
      res.status(201).json(build);
    } catch (error: any) {
      console.error("[BuildHistory] create failed:", error);
      res.status(500).json({ error: "Failed to create build record" });
    }
  });

  // GET /api/builds — List build history (filter by module, sessionId)
  // Uses optionalAuth: authenticated users see only their builds;
  // unauthenticated requests must provide sessionId (scoped access).
  app.get("/api/builds", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const module = (req.query.module as string || '').trim() || undefined;
      const sessionId = (req.query.sessionId as string || '').trim() || undefined;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const offset = Number(req.query.offset) || 0;

      // Security: if no userId and no sessionId, return empty — don't return all users' builds
      if (!req.userId && !sessionId) {
        return res.json({ builds: [], total: 0 });
      }

      const builds = await storage.getBuildHistory({
        userId: req.userId || undefined,
        sessionId,
        module: module && module !== 'all' ? module : undefined,
        limit,
        offset,
      });
      res.json({ builds, total: builds.length });
    } catch (error: any) {
      console.error("[BuildHistory] list failed:", error);
      res.status(500).json({ error: "Failed to fetch build history" });
    }
  });

  // GET /api/builds/:id — Get a single build record
  app.get("/api/builds/:id", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const build = await storage.getBuildById(req.params.id);
      if (!build) return res.status(404).json({ error: "Build not found" });
      // Ownership check: only allow access to own builds or builds with no userId
      if (!build.userId || !req.userId || build.userId !== req.userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      res.json(build);
    } catch (error: any) {
      console.error("[BuildHistory] get failed:", error);
      res.status(500).json({ error: "Failed to fetch build" });
    }
  });

  // GET /api/sessions/:id/builds — Get builds for a specific session
  app.get("/api/sessions/:id/builds", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const builds = await storage.getBuildHistory({
        userId: req.userId || undefined,
        sessionId: req.params.id,
        limit: Number(req.query.limit) || 50,
        offset: Number(req.query.offset) || 0,
      });
      res.json({ builds, total: builds.length });
    } catch (error: any) {
      console.error("[BuildHistory] session builds failed:", error);
      res.status(500).json({ error: "Failed to fetch session builds" });
    }
  });

  // PATCH /api/builds/:id — Update a build record (e.g., mark completed)
  app.patch("/api/builds/:id", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const existing = await storage.getBuildById(req.params.id);
      if (!existing) return res.status(404).json({ error: "Build not found" });
      // Ownership check
      if (!existing.userId || !req.userId || existing.userId !== req.userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      const build = await storage.updateBuildHistory(req.params.id, req.body);
      res.json(build);
    } catch (error: any) {
      console.error("[BuildHistory] update failed:", error);
      res.status(500).json({ error: "Failed to update build" });
    }
  });
}
