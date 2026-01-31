import type { Express } from "express";

/**
 * Health check and basic routes
 */
export function registerHealthRoutes(app: Express): void {
  // Health check endpoint
  app.get("/api/health", async (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });
}

