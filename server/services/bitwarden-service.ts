import { BitwardenClient } from "@bitwarden/sdk-napi";
import NodeCache from "node-cache";

// Initialize cache
const secretCache = new NodeCache({
  stdTTL: 300, // 5 minutes default TTL
  checkperiod: 60, // Check for expired keys every minute
  useClones: false, // Better performance
});

const ACCESS_TOKEN = process.env.BITWARDEN_ACCESS_TOKEN || "";
const PROJECT_ID = process.env.BITWARDEN_PROJECT_ID || "";

export class BitwardenService {
  private client: BitwardenClient;
  private initialized: boolean = false;
  private organizationId: string | null = null;

  constructor() {
    // For Secrets Manager, the identity and api urls are usually default
    // unless using self-hosted. We pass undefined to use defaults.
    this.client = new BitwardenClient();
  }

  private async ensureInitialized() {
    if (this.initialized && this.organizationId) {
      // Periodic sync might be good, but let's keep it simple for now
      return;
    }

    if (!ACCESS_TOKEN) {
      throw new Error("BITWARDEN_ACCESS_TOKEN is not set in environment variables");
    }

    try {
      console.log("📡 Authenticating with Bitwarden...");
      await this.client.auth().loginAccessToken(ACCESS_TOKEN);
      
      // Get the organization ID from the project
      if (PROJECT_ID) {
        console.log(`📡 Fetching project info for ${PROJECT_ID}...`);
        const project = await this.client.projects().get(PROJECT_ID);
        this.organizationId = project.organizationId;
        console.log(`✅ Organization ID retrieved: ${this.organizationId}`);
        
        try {
          const projects = await this.client.projects().list(this.organizationId);
          console.log(`✅ Token has access to ${projects.data.length} projects`);
          if (projects.data.find(p => p.id === PROJECT_ID)) {
            console.log(`✅ Verified: Token has access to project ${PROJECT_ID}`);
          } else {
            console.warn(`⚠️ Warning: Token does NOT see project ${PROJECT_ID} in the list!`);
          }
        } catch (e) {}
        
        // Sync is CRITICAL for Secrets Manager SDK to work correctly with local cache
        console.log("📡 Syncing Bitwarden vault...");
        await this.client.secrets().sync(this.organizationId);
        console.log("✅ Bitwarden vault synced");
      }
      
      this.initialized = true;
      console.log("✅ Bitwarden client fully initialized");
    } catch (error: any) {
      console.error("❌ Bitwarden initialization failed:", error.message);
      throw new Error(`Bitwarden initialization failed: ${error.message}`);
    }
  }

  /**
   * Save user secret to Bitwarden SM
   */
  async saveUserSecret(
    userId: string,
    secretType: 'azure-devops' | 'azure-cloud' | 'github' | 'aws' | 'gcp',
    data: Record<string, string>
  ): Promise<void> {
    await this.ensureInitialized();
    if (!this.organizationId) throw new Error("Organization ID not found");
    
    const secretName = `user_${userId}_${secretType.replace('-', '_')}`;
    const secretValue = JSON.stringify(data);
    
    try {
      let existingSecret = null;
      try {
        console.log(`📡 Listing secrets for Org: ${this.organizationId}...`);
        const secretsResponse = await this.client.secrets().list(this.organizationId);
        console.log(`✅ List successful, found ${secretsResponse.data.length} secrets`);
        existingSecret = secretsResponse.data.find(s => s.key === secretName);
      } catch (listError: any) {
        console.warn(`⚠️ Bitwarden secrets list failed: ${listError.message}`);
        if (listError.message.includes("404") || listError.message.includes("Resource not found")) {
          console.warn("Assuming no existing secrets found due to 404/Permissions");
        } else {
          throw listError;
        }
      }
      
      if (existingSecret) {
        // Update existing secret
        console.log(`📡 Found existing secret: ${JSON.stringify(existingSecret)}`);
        console.log(`📡 Updating existing secret ID: ${existingSecret.id} (${secretName})`);
        try {
          // Verify we can access this secret specifically
          try {
            const secretCheck = await this.client.secrets().get(existingSecret.id);
            console.log(`✅ Verified secret access for ID: ${secretCheck.id}`);
          } catch (getError: any) {
            console.warn(`⚠️ Could not verify secret with get(): ${getError.message}`);
          }

          try {
            await this.client.secrets().update(
              this.organizationId,
              existingSecret.id,
              secretName,
              secretValue,
              "User Settings",
              [PROJECT_ID]
            );
            console.log(`✅ Secret updated successfully: ${secretName}`);
          } catch (updateError: any) {
            console.warn(`⚠️ Update failed: ${updateError.message}. Attempting delete and re-create...`);
            // Brute force: delete and recreate
            try {
              try {
                await this.client.secrets().delete([existingSecret.id]);
                console.log(`✅ Old secret deleted: ${existingSecret.id}`);
              } catch (delErr) {
                console.warn(`⚠️ Delete failed: ${delErr.message}`);
              }

              // Try create with the same fallback logic
              await this.saveUserSecret(userId, secretType, data);
            } catch (bruteError: any) {
              console.error(`❌ Brute-force re-creation failed: ${bruteError.message}`);
              throw bruteError;
            }
          }
        } catch (innerError: any) {
          console.error(`❌ Bitwarden save process failed: ${innerError.message}`);
          throw innerError;
        }
      } else {
        // Create new secret
        console.log(`📡 Creating new secret: ${secretName} in Org: ${this.organizationId} Project: ${PROJECT_ID}`);
        try {
          await this.client.secrets().create(
            this.organizationId,
            secretName,
            secretValue,
            "User Settings",
            [PROJECT_ID]
          );
          console.log(`✅ Secret created successfully: ${secretName}`);
        } catch (createError: any) {
          if (createError.message.includes("404")) {
            console.log("📡 404 on create, trying without organizationId...");
            try {
              // Try with empty string for organizationId as fallback for some token types
              await this.client.secrets().create(
                "",
                secretName,
                secretValue,
                "User Settings",
                [PROJECT_ID]
              );
              console.log(`✅ Secret created successfully (with empty Org ID): ${secretName}`);
              return;
            } catch (e) {
              console.log("📡 404 again, trying with Project ID as Org ID...");
              try {
                await this.client.secrets().create(
                  PROJECT_ID,
                  secretName,
                  secretValue,
                  "User Settings",
                  [PROJECT_ID]
                );
                console.log(`✅ Secret created successfully (with Project as Org ID): ${secretName}`);
                return;
              } catch (e2) {
                throw createError; // Throw original error if all fallbacks fail
              }
            }
          }
          console.error(`❌ Create failed: ${createError.message}`);
          throw createError;
        }
      }
      
      // Invalidate cache
      this.invalidateCache(userId, secretType);
    } catch (error: any) {
      console.error(`❌ Failed to save secret to Bitwarden: ${error.message}`);
      throw new Error(`Failed to save secret: ${error.message}`);
    }
  }

  /**
   * Get user secret from Bitwarden SM (with caching)
   */
  async getUserSecret(
    userId: string,
    secretType: 'azure-devops' | 'azure-cloud' | 'github' | 'aws' | 'gcp'
  ): Promise<Record<string, string> | null> {
    const cacheKey = `${userId}:${secretType}`;
    
    // Check cache
    const cached = secretCache.get<Record<string, string>>(cacheKey);
    if (cached) {
      return cached;
    }
    
    await this.ensureInitialized();
    if (!this.organizationId) return null;

    const secretName = `user_${userId}_${secretType.replace('-', '_')}`;
    
    try {
      let secret = null;
      try {
        const secretsResponse = await this.client.secrets().list(this.organizationId);
        secret = secretsResponse.data.find(s => s.key === secretName);
      } catch (listError: any) {
        if (listError.message.includes("404") || listError.message.includes("Resource not found")) {
          console.warn("⚠️ Bitwarden secrets list failed with 404 for getUserSecret");
        } else {
          throw listError;
        }
      }
      
      if (!secret) return null;
      
      // Get the full secret to get the value
      const fullSecret = await this.client.secrets().get(secret.id);
      const data = JSON.parse(fullSecret.value);
      
      // Cache the result
      secretCache.set(cacheKey, data);
      
      return data;
    } catch (error: any) {
      console.error(`❌ Failed to get secret from Bitwarden: ${error.message}`);
      return null;
    }
  }

  /**
   * Get all secrets for a user
   */
  async getAllUserSecrets(userId: string) {
    const [azureDevOps, azureCloud, github, aws, gcp] = await Promise.all([
      this.getUserSecret(userId, 'azure-devops'),
      this.getUserSecret(userId, 'azure-cloud'),
      this.getUserSecret(userId, 'github'),
      this.getUserSecret(userId, 'aws'),
      this.getUserSecret(userId, 'gcp'),
    ]);
    
    return { azureDevOps, azureCloud, github, aws, gcp };
  }

  private invalidateCache(userId: string, secretType: string) {
    secretCache.del(`${userId}:${secretType}`);
    console.log(`🗑️ Cache invalidated for ${userId}:${secretType}`);
  }
}

export const bitwardenService = new BitwardenService();

export function isBitwardenConfigured(): boolean {
  return !!ACCESS_TOKEN && !!PROJECT_ID;
}

