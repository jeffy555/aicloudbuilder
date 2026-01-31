import type { Express } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { bitwardenService } from "../services/bitwarden-service";

export function registerUserSecretsRoutes(app: Express) {
  /**
   * GET /api/user/secrets
   * Retrieve user's configured secrets (metadata only)
   */
  app.get("/api/user/secrets", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.userId!;
      const secrets = await bitwardenService.getAllUserSecrets(userId);
      
      res.json({
        hasAzureDevOps: !!secrets.azureDevOps,
        hasAzureCloud: !!secrets.azureCloud,
        hasGithub: !!secrets.github,
        hasAws: !!secrets.aws,
        hasGcp: !!secrets.gcp,
        // Don't return sensitive values, maybe return partial info if needed
        azureDevOps: secrets.azureDevOps ? {
          org: secrets.azureDevOps.org,
          project: secrets.azureDevOps.project,
          userId: secrets.azureDevOps.userId,
        } : null,
        azureCloud: secrets.azureCloud ? {
          clientId: secrets.azureCloud.clientId,
          tenantId: secrets.azureCloud.tenantId,
          subscriptionId: secrets.azureCloud.subscriptionId,
        } : null,
        github: secrets.github ? {
          owner: secrets.github.owner,
        } : null,
        aws: secrets.aws ? {
          accessKeyId: secrets.aws.accessKeyId,
          region: secrets.aws.region,
        } : null,
        gcp: secrets.gcp ? {
          projectId: secrets.gcp.projectId,
          region: secrets.gcp.region,
        } : null,
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


