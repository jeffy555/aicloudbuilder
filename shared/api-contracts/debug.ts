import { z } from "zod";

// GET /api/debug/azure-mcp
export const debugAzureMcpResponse = z.any().openapi("DebugAzureMcpResponse");

// GET /api/debug/terraform-mcp
export const debugTerraformMcpResponse = z.any().openapi("DebugTerraformMcpResponse");

// GET /api/debug/credentials
export const debugCredentialsResponse = z.any().openapi("DebugCredentialsResponse");

// GET /api/debug/tools/:provider
export const debugToolsParams = z.object({
  provider: z.string(),
});
export const debugToolsResponse = z.any().openapi("DebugToolsResponse");
