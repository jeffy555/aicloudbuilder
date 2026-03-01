/**
 * Shared credential resolution utility.
 * Resolves per-user credentials from Bitwarden (primary) with env-var fallback.
 * Used by any endpoint that needs to call the MCP client with repo credentials.
 */
import { type RepositoryCredentials, type MCPProvider } from "../mcp-client";
import { bitwardenService, isBitwardenConfigured } from "../services/bitwarden-service";

export type CredentialResult = {
  credentials: RepositoryCredentials;
  reason?: string;
};

export async function resolveRepositoryCredentials(
  provider: MCPProvider,
  userId?: string
): Promise<CredentialResult> {
  if (!userId) {
    console.warn(
      `⚠️  [credentials] No userId — JWT validation failed. Skipping Bitwarden lookup for ${provider}. Will try env vars.`
    );
    return { credentials: {} };
  }

  if (!isBitwardenConfigured()) {
    const missing: string[] = [];
    if (!process.env.BITWARDEN_ACCESS_TOKEN) missing.push("BITWARDEN_ACCESS_TOKEN");
    if (!process.env.BITWARDEN_PROJECT_ID) missing.push("BITWARDEN_PROJECT_ID");
    console.warn(`⚠️  Bitwarden not configured — missing env vars: ${missing.join(", ")}`);
    return {
      credentials: {},
      reason: `Bitwarden is not configured on the server. Missing environment variables: ${missing.join(", ")}.`,
    };
  }

  try {
    if (provider === "github") {
      const secret = await bitwardenService.getUserSecret(userId, "github");
      if (secret?.token) {
        return {
          credentials: {
            github: { token: secret.token, owner: secret.owner },
          },
        };
      }
      return {
        credentials: {},
        reason: `GitHub credentials not found in Bitwarden. Please re-save them in Settings.`,
      };
    } else if (provider === "azure") {
      const secret = await bitwardenService.getUserSecret(userId, "azure-devops");
      if (secret?.org && secret?.pat && secret?.project) {
        return {
          credentials: {
            azure: { org: secret.org, pat: secret.pat, project: secret.project },
          },
        };
      }
      return {
        credentials: {},
        reason: `Azure DevOps credentials not found in Bitwarden. Please re-save them in Settings.`,
      };
    }
  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error(`❌ Bitwarden lookup failed for user ${userId} / ${provider}:`, msg);
    return {
      credentials: {},
      reason: `Bitwarden lookup failed: ${msg}`,
    };
  }

  return { credentials: {} };
}
