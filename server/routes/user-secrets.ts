import type { Express } from "express";
import { requireAuth, optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { bitwardenService, isBitwardenConfigured } from "../services/bitwarden-service";

/**
 * Check if provider credentials are available via environment variables
 */
function getEnvFallbackConfig() {
  const hasGithubEnv = !!(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER);
  const hasAzureDevOpsEnv = !!(process.env.AZURE_DEVOPS_ORG && process.env.AZURE_DEVOPS_PAT && process.env.AZURE_DEVOPS_PROJECT);
  const hasAzureCloudEnv = !!(process.env.AZURE_CLIENT_ID && process.env.AZURE_TENANT_ID && process.env.AZURE_SUBSCRIPTION_ID);

  return {
    hasGithub: hasGithubEnv,
    hasAzureDevOps: hasAzureDevOpsEnv,
    hasAzureCloud: hasAzureCloudEnv,
    hasAws: false,
    hasGcp: false,
    azureDevOps: hasAzureDevOpsEnv ? {
      org: process.env.AZURE_DEVOPS_ORG!,
      project: process.env.AZURE_DEVOPS_PROJECT!,
      userId: process.env.AZURE_DEVOPS_USER_ID || '',
    } : null,
    azureCloud: hasAzureCloudEnv ? {
      clientId: process.env.AZURE_CLIENT_ID!,
      tenantId: process.env.AZURE_TENANT_ID!,
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    } : null,
    github: hasGithubEnv ? {
      owner: process.env.GITHUB_OWNER!,
    } : null,
    aws: null,
    gcp: null,
  };
}

export function registerUserSecretsRoutes(app: Express) {
  /**
   * GET /api/user/secrets
   * Retrieve user's configured secrets (metadata only)
   * Uses optionalAuth so env var fallback works without login
   */
  app.get("/api/user/secrets", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.userId;
      const envConfig = getEnvFallbackConfig();

      // If user is authenticated and Bitwarden is configured, try Bitwarden first
      let secrets: any = null;
      if (userId && isBitwardenConfigured()) {
        try {
          secrets = await bitwardenService.getAllUserSecrets(userId);
        } catch (error: any) {
          console.warn("⚠️  Bitwarden lookup failed, falling back to env vars:", error?.message);
        }
      }

      // Merge: Bitwarden secrets take priority, env vars as fallback
      res.json({
        hasAzureDevOps: !!(secrets?.azureDevOps) || envConfig.hasAzureDevOps,
        hasAzureCloud: !!(secrets?.azureCloud) || envConfig.hasAzureCloud,
        hasGithub: !!(secrets?.github) || envConfig.hasGithub,
        hasAws: !!(secrets?.aws) || envConfig.hasAws,
        hasGcp: !!(secrets?.gcp) || envConfig.hasGcp,
        azureDevOps: secrets?.azureDevOps ? {
          org: secrets.azureDevOps.org,
          project: secrets.azureDevOps.project,
          userId: secrets.azureDevOps.userId,
        } : envConfig.azureDevOps,
        azureCloud: secrets?.azureCloud ? {
          clientId: secrets.azureCloud.clientId,
          tenantId: secrets.azureCloud.tenantId,
          subscriptionId: secrets.azureCloud.subscriptionId,
        } : envConfig.azureCloud,
        github: secrets?.github ? {
          owner: secrets.github.owner,
        } : envConfig.github,
        aws: secrets?.aws ? {
          accessKeyId: secrets.aws.accessKeyId,
          region: secrets.aws.region,
        } : envConfig.aws,
        gcp: secrets?.gcp ? {
          projectId: secrets.gcp.projectId,
          region: secrets.gcp.region,
        } : envConfig.gcp,
      });
    } catch (error: any) {
      console.error("Error getting user secrets:", error);
      res.status(500).json({ error: "Failed to retrieve secrets configuration" });
    }
  });

  /**
   * PUT /api/user/secrets/:type
   * Save user secrets to Bitwarden
   */
  app.put("/api/user/secrets/:type", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.userId!;
      const type = req.params.type as 'azure-devops' | 'azure-cloud' | 'github' | 'aws' | 'gcp';
      
      if (!['azure-devops', 'azure-cloud', 'github', 'aws', 'gcp'].includes(type)) {
        return res.status(400).json({ error: "Invalid secret type" });
      }

      const data = req.body;
      
      // Basic validation
      if (type === 'azure-devops') {
        if (!data.org || !data.project || !data.pat || !data.userId) {
          return res.status(400).json({ error: "Missing required Azure DevOps details" });
        }
      } else if (type === 'azure-cloud') {
        if (!data.clientId || !data.clientSecret || !data.tenantId || !data.subscriptionId) {
          return res.status(400).json({ error: "Missing required Azure Cloud details" });
        }
      } else if (type === 'github') {
        if (!data.token || !data.owner) {
          return res.status(400).json({ error: "Missing required GitHub details" });
        }
      } else if (type === 'aws') {
        if (!data.accessKeyId || !data.secretAccessKey || !data.region) {
          return res.status(400).json({ error: "Missing required AWS details" });
        }
      } else if (type === 'gcp') {
        if (!data.projectId || !data.clientEmail || !data.privateKey || !data.region) {
          return res.status(400).json({ error: "Missing required GCP details" });
        }
      }

      await bitwardenService.saveUserSecret(userId, type, data);
      
      res.json({ message: `${type} secrets saved successfully` });
    } catch (error: any) {
      console.error(`Error saving ${req.params.type} secrets:`, error);
      res.status(500).json({ error: `Failed to save ${req.params.type} secrets` });
    }
  });
}


