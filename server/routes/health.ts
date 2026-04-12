import type { Express } from "express";
import { generateOpenAPIDocument } from "../openapi/registry";

// Cache the spec so it's not regenerated on every request
let cachedSpec: any = null;

/**
 * Health check and basic routes
 */
export function registerHealthRoutes(app: Express): void {
  // Health check endpoint
  app.get("/api/health", async (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // OpenAPI spec endpoint (SDD)
  app.get("/api/openapi.json", (req, res) => {
    if (!cachedSpec) {
      cachedSpec = generateOpenAPIDocument();
    }
    res.json(cachedSpec);
  });
}

