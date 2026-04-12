import type { Express } from "express";
import { createServer, type Server } from "http";
import { registerHealthRoutes } from "./health";
import { registerAuthRoutes } from "./auth";
import { registerMicrosoftAuthRoutes } from "./auth-microsoft";
import { registerAwsAuthRoutes } from "./auth-aws";
import { registerUserSecretsRoutes } from "./user-secrets";
import { registerSessionRoutes } from "./sessions";
import { registerFileRoutes } from "./files";
import { registerRepositoryRoutes } from "./repositories";
import { registerDockerRoutes } from "./docker";
import { registerAutomationRoutes } from "./automation";
import { registerTerraformRoutes } from "./terraform";
import { registerKubernetesRoutes } from "./kubernetes";
import { registerArchMeRoutes } from "./archme";
import { registerValuationRoutes } from "./valuation";
import { registerActivityRoutes } from "./activities";
import { registerCommitRoutes } from "./commit";
import { registerDebugRoutes } from "./debug";
import { registerScoreMeRoutes } from "./scoreme";
import { registerMetricsRoutes } from "./metrics";
import { registerUserFixPreferencesRoutes } from "./user-fix-preferences";
import { registerHistoryRoutes } from "./history";
import { registerTerraformGenerationRoutes } from "./terraform-generation";
import { registerScanRoutes } from "./scan";
import { registerFixesRoutes } from "./fixes";
import { registerCostAnalysisRoutes } from "./cost-analysis";
import { registerMigrateRoutes } from "./migrate";
// Import legacy routes for routes not yet migrated
import { registerLegacyRoutes } from "../routes-legacy";

/**
 * Register all application routes
 * This function replaces the monolithic routes.ts file
 * 
 * Migration Strategy (Zero-Downtime):
 * 1. Routes are gradually moved from routes-legacy.ts to modular route files
 * 2. New modular routes are registered FIRST (they take precedence)
 * 3. Legacy routes are registered AFTER (handles unmigrated endpoints)
 * 4. Both can coexist during migration - no application flow disruption
 * 5. Once a route is fully migrated and tested, it's removed from legacy
 * 6. Each route module handles a specific domain (sessions, terraform, etc.)
 * 
 * Safety Guarantees:
 * - All existing endpoints continue to work during migration
 * - New modular routes override legacy routes (if same path exists)
 * - Legacy routes handle all unmigrated endpoints
 * - No breaking changes to API contracts
 */
export async function registerRoutes(app: Express): Promise<Server> {
  // Register new modular routes
  registerHealthRoutes(app);
  registerAuthRoutes(app); // Authentication routes (signup, login, logout)
  registerMicrosoftAuthRoutes(app); // Microsoft Azure AD SSO
  registerAwsAuthRoutes(app);       // AWS Cognito SSO
  registerUserSecretsRoutes(app); // Bitwarden secrets management
  registerSessionRoutes(app);
  registerFileRoutes(app);
  registerRepositoryRoutes(app);
  registerDockerRoutes(app);
  registerAutomationRoutes(app);
  registerTerraformRoutes(app);
  registerKubernetesRoutes(app);
  registerArchMeRoutes(app);
  registerValuationRoutes(app);
  registerActivityRoutes(app);
  registerCommitRoutes(app);
  registerDebugRoutes(app);
  registerScoreMeRoutes(app);
  registerMetricsRoutes(app); // Phase 0: Performance monitoring
  registerUserFixPreferencesRoutes(app); // Phase 2: User fix preferences
  registerHistoryRoutes(app); // User history
  registerTerraformGenerationRoutes(app); // POST /api/sessions/:id/generate-terraform
  registerScanRoutes(app);               // POST /api/sessions/:id/scan
  registerFixesRoutes(app);              // POST /api/sessions/:id/fix-issues
  registerCostAnalysisRoutes(app);       // POST /api/sessions/:id/analyze-cost
  registerMigrateRoutes(app);            // /api/migrate/*

  // Legacy routes stub — all endpoints have been migrated to modular route files above
  const server = await registerLegacyRoutes(app);
  
  return server;
}

