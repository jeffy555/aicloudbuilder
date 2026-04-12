/**
 * API Contracts — Single source of truth for all request/response schemas.
 * Used by:
 *  - server/middleware/validate.ts (request validation)
 *  - server/openapi/registry.ts (OpenAPI spec generation)
 *  - client (type-safe API calls via generated types)
 *  - test/contracts/ (contract testing)
 */
export * from "./common";
export * as health from "./health";
export * as auth from "./auth";
export * as sessions from "./sessions";
export * as files from "./files";
export * as repositories from "./repositories";
export * as terraform from "./terraform";
export * as terraformGeneration from "./terraform-generation";
export * as docker from "./docker";
export * as kubernetes from "./kubernetes";
export * as archme from "./archme";
export * as automation from "./automation";
export * as valuation from "./valuation";
export * as commit from "./commit";
export * as scan from "./scan";
export * as fixes from "./fixes";
export * as costAnalysis from "./cost-analysis";
export * as scoreme from "./scoreme";
export * as activities from "./activities";
export * as metrics from "./metrics";
export * as debug from "./debug";
export * as history from "./history";
export * as userSecrets from "./user-secrets";
export * as userFixPreferences from "./user-fix-preferences";
