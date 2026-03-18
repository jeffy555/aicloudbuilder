
/**
 * Terraform-specific API routes
 * Handles Terraform code generation, backend configuration, refactoring, and diagram generation
 */

import type { Express } from "express";
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { openaiService } from "../openai-service";
import type { GeneratedFile } from "@shared/schema";
import { validateTerraformRequest, formatValidationErrors } from "../terraform-validator";
import { generateArchitectureDiagram } from "../diagram/terraform-diagram-generator";
import { findMatchingBrace } from "../utils/route-helpers";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { bitwardenService, isBitwardenConfigured } from "../services/bitwarden-service";
import { AZURE_PRICING_CONFIG } from "../azure-pricing-config.js";
import {
  TERRAFORM_DEFAULT_VERSION,
  MIN_MEANINGFUL_VALUE_LENGTH,
  MIN_RESOURCE_NAME_LENGTH,
} from "../config/constants.js";
import {
  TERRAFORM_REFERENCE_PREFIXES,
  PURE_NUMBER_PATTERN,
  TERRAFORM_KEYWORD_PATTERN,
  PROVIDER_TIER_LITERAL_PATTERN,
} from "../config/terraform-patterns.js";

// Module-level regex constants — compiled once at startup
const TERRAFORM_VAR_USAGE_PATTERN = /var\.([a-zA-Z0-9_-]+)/g;
const TERRAFORM_VAR_DECLARATION_PATTERN = /variable\s+"([^"]+)"/g;

/**
 * Register Terraform-specific routes
 */
export function registerTerraformRoutes(app: Express) {
  // Configure Terraform backend (Azure/AWS/GCP)
  app.post("/api/sessions/:id/configure-backend", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.id;
      const { action, backendConfig } = req.body; // action: 'validate' | 'create' | 'decline'
      
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Scenario 1: User declines backend
      if (action === 'decline') {
        await storage.updateSession(sessionId, {
          backendDeclined: 'true',
          backendValidated: 'skipped',
          workflowStep: 'terraform_generation'
        });
        return res.json({ 
          status: 'declined',
          message: 'Backend configuration skipped. Terraform will use local state management.'
        });
      }

      // Scenario 2: Existing backend - validate only
      if (session.hasBackend === 'true' && action === 'validate') {
        const cloudProvider = session.cloudProvider || 'azure';
        
        // AWS backend validation
        if (cloudProvider === 'aws' || session.backendType === 's3') {
          // For AWS, we can't validate S3/DynamoDB via MCP, so we'll just mark as validated
          // User should verify resources exist manually
          if (!session.backendContainer) {
            return res.status(400).json({ error: 'Backend configuration incomplete: S3 bucket name is required' });
          }

          await storage.updateSession(sessionId, {
            backendValidated: 'true',
            workflowStep: 'terraform_generation'
          });

          return res.json({
            status: 'validated',
            message: 'AWS backend configuration validated (please ensure S3 bucket and DynamoDB table exist)',
            details: {
              bucket: session.backendContainer,
              // Extract DynamoDB table from stateKey if stored in format "state-key|dynamodb-table"
              dynamodbTable: session.backendStateKey?.includes('|') ? session.backendStateKey.split('|')[1] : 'terraform-state-lock',
              region: session.backendLocation || 'us-east-1',
              stateKey: session.backendStateKey?.includes('|') ? session.backendStateKey.split('|')[0] : (session.backendStateKey || 'terraform.tfstate')
            }
          });
        }

        // Azure backend validation (existing logic)
        if (!session.backendStorageAccount || !session.backendResourceGroup || !session.backendContainer) {
          return res.status(400).json({ error: 'Backend configuration incomplete in session' });
        }

        try {
          // Validate storage account exists
          const storageValidation = await mcpClient.validateAzureStorageAccount(
            session.backendStorageAccount,
            session.backendResourceGroup
          );

          if (!storageValidation.exists) {
            return res.json({
              status: 'validation_failed',
              error: `Storage account "${session.backendStorageAccount}" not found in resource group "${session.backendResourceGroup}"`,
              suggestion: 'Create the storage account or update backend configuration'
            });
          }

          // Validate container exists
          const containerValidation = await mcpClient.validateAzureContainer(
            session.backendStorageAccount,
            session.backendResourceGroup,
            session.backendContainer
          );

          if (!containerValidation.exists) {
            return res.json({
              status: 'validation_failed',
              error: `Container "${session.backendContainer}" not found in storage account "${session.backendStorageAccount}"`,
              suggestion: 'Create the container or update backend configuration'
            });
          }

          // Validation passed
          await storage.updateSession(sessionId, {
            backendValidated: 'true',
            backendLocation: storageValidation.location,
            workflowStep: 'terraform_generation'
          });

          return res.json({
            status: 'validated',
            message: 'Backend configuration validated successfully',
            details: {
              storageAccount: session.backendStorageAccount,
              resourceGroup: session.backendResourceGroup,
              container: session.backendContainer,
              location: storageValidation.location
            }
          });

        } catch (error: any) {
          console.error('Backend validation error:', error);
          return res.json({
            status: 'validation_error',
            error: error.message || 'Failed to validate backend configuration',
            suggestion: 'Check Azure CLI authentication and permissions'
          });
        }
      }

      // Scenario 3: Missing backend - create with defaults or provided config
      if (action === 'create') {
        try {
          const cloudProvider = session.cloudProvider || 'azure';
          
          // AWS backend configuration
          if (cloudProvider === 'aws') {
            // Use provided config or generate sensible defaults for AWS
            const defaults = {
              bucket: backendConfig?.bucket || backendConfig?.container || `terraform-state-${Date.now().toString().slice(-8)}`,
              dynamodbTable: backendConfig?.dynamodbTable || 'terraform-state-lock',
              region: backendConfig?.region || backendConfig?.location || 'us-east-1',
              stateKey: backendConfig?.stateKey || 'terraform.tfstate',
              encrypt: true
            };

            console.log('Creating AWS backend configuration...');
            console.log('S3 Bucket:', defaults.bucket);
            console.log('DynamoDB Table:', defaults.dynamodbTable);
            console.log('Region:', defaults.region);
            console.log('State Key:', defaults.stateKey);

            // Note: AWS backend resources (S3 bucket, DynamoDB table) need to be created manually
            // or via AWS CLI/Console. We'll just generate the backend.tf configuration.
            // For now, we'll assume they exist or will be created by the user.

            // Update session with backend configuration
            // Note: Store DynamoDB table name in backendStateKey as "state-key|dynamodb-table" format
            await storage.updateSession(sessionId, {
              hasBackend: 'true',
              backendType: 's3',
              backendContainer: defaults.bucket, // Reuse container field for S3 bucket
              backendStateKey: `${defaults.stateKey}|${defaults.dynamodbTable}`, // Store both state key and DynamoDB table
              backendLocation: defaults.region, // Reuse location field for AWS region
              backendValidated: 'pending', // Mark as pending - user needs to create resources
              workflowStep: 'terraform_generation'
            });

            // Generate and store required Terraform files immediately
            const backendTfContent = openaiService.generateBackendTf({
              backendType: 's3',
              bucket: defaults.bucket,
              dynamodbTable: defaults.dynamodbTable,
              region: defaults.region,
              stateKey: defaults.stateKey,
              encrypt: defaults.encrypt
            });

            const providerTfContent = openaiService.generateProviderTf('aws');

            // Fetch latest Terraform version (tries MCP → Checkpoint API → Releases API → GitHub)
            const latestVersion = await mcpClient.getLatestTerraformVersion();
            console.log(`Using Terraform version: ${latestVersion}`);
            
            // Generate terraform.tf with specific version (exact version, not >=)
            const terraformTfContent = `terraform {
  required_version = "${latestVersion}"
}`;

            // Store the files
            await storage.createFile({
              sessionId,
              fileName: 'backend.tf',
              content: backendTfContent
            });

            await storage.createFile({
              sessionId,
              fileName: 'provider.tf',
              content: providerTfContent
            });

            await storage.createFile({
              sessionId,
              fileName: 'terraform.tf',
              content: terraformTfContent
            });

            return res.json({
              status: 'configured',
              message: 'AWS backend configuration generated. Please create the S3 bucket and DynamoDB table manually, then run terraform init.',
              details: {
                ...defaults,
                filesGenerated: ['backend.tf', 'provider.tf', 'terraform.tf'],
                instructions: [
                  `Create S3 bucket: aws s3 mb s3://${defaults.bucket} --region ${defaults.region}`,
                  `Create DynamoDB table: aws dynamodb create-table --table-name ${defaults.dynamodbTable} --attribute-definitions AttributeName=LockID,AttributeType=S --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST --region ${defaults.region}`,
                  'Then run: terraform init'
                ]
              }
            });
          }

          // Azure backend configuration (existing logic)
          // Step 0: Load Azure Cloud credentials from Bitwarden into process.env if not already set.
          // This allows users who stored credentials via Settings to use Terraform backend
          // without requiring AZURE_* env vars to be pre-configured in the container.
          if (!process.env.AZURE_CLIENT_ID && req.userId && isBitwardenConfigured()) {
            try {
              const azureSecret = await bitwardenService.getUserSecret(req.userId, 'azure-cloud');
              if (azureSecret?.clientId && azureSecret?.tenantId && azureSecret?.subscriptionId) {
                process.env.AZURE_CLIENT_ID = azureSecret.clientId;
                process.env.AZURE_TENANT_ID = azureSecret.tenantId;
                process.env.AZURE_SUBSCRIPTION_ID = azureSecret.subscriptionId;
                if (azureSecret.clientSecret) {
                  process.env.AZURE_CLIENT_SECRET = azureSecret.clientSecret;
                }
                console.log(`✅ Azure Cloud credentials loaded from Bitwarden for user ${req.userId}`);
              } else {
                console.warn(`⚠️ Azure Cloud credentials not found in Bitwarden for user ${req.userId}`);
              }
            } catch (bwErr: any) {
              console.warn(`⚠️ Failed to load Azure Cloud credentials from Bitwarden: ${bwErr.message}`);
            }
          }

          // Step 1: Verify Service Principal permissions before attempting resource creation
          // This prevents confusing errors later and provides clear instructions if permissions are missing
          const permissionCheck = await mcpClient.ensureServicePrincipalRoles();
          
          // Only block if it's a real permission error (not a skipped check)
          if (!permissionCheck.success && !permissionCheck.skipped) {
            return res.status(400).json({
              status: 'permission_error',
              error: permissionCheck.message,
              requiresRoleAssignment: true,
              instructions: permissionCheck.message
            });
          }
          
          // If check was skipped (MCP connection issue), log and proceed
          if (permissionCheck.skipped) {
            console.log('⚠️ Permission check skipped due to MCP connection issue. Proceeding with resource creation...');
          }

          // Use provided config or generate sensible defaults
          const defaults = {
            storageAccount: backendConfig?.storageAccount || `tfstate${Date.now().toString().slice(-8)}`,
            resourceGroup: backendConfig?.resourceGroup || 'terraform-state-rg',
            container: backendConfig?.container || 'tfstate',
            location: backendConfig?.location || 'eastus',
            stateKey: backendConfig?.stateKey || 'terraform.tfstate'
          };

          // CRITICAL: Create actual Azure resources using Azure MCP
          // These resources MUST exist before terraform init can run
          console.log('Creating Azure backend resources...');
          console.log('Storage Account:', defaults.storageAccount);
          console.log('Resource Group:', defaults.resourceGroup);
          console.log('Container:', defaults.container);
          console.log('Location:', defaults.location);

          let resourcesCreated = false;
          let mcpError: any = null;
          
          // Initialize validation objects with defaults to prevent undefined errors
          let rgValidation: { exists: boolean; location?: string } = { exists: false };
          let storageValidation: { exists: boolean; location?: string } = { exists: false };
          let containerValidation: { exists: boolean } = { exists: false };

          try {
            // Step 0: Validate or create resource group FIRST
            try {
              rgValidation = await mcpClient.validateAzureResourceGroup(
              defaults.resourceGroup
            );
            } catch (error: any) {
              console.error('Error validating resource group (will attempt to create):', error.message);
              // If validation fails, assume it doesn't exist and try to create
              rgValidation = { exists: false };
            }

            if (!rgValidation.exists) {
              console.log('Resource group does not exist. Creating...');
              const createRgResult = await mcpClient.createAzureResourceGroup(
                defaults.resourceGroup,
                defaults.location
              );

              if (!createRgResult.success) {
                const errorMsg = createRgResult.error || 'Unknown error';
                // Check if it's an MCP connection error
                if (errorMsg.includes('MCP server') || errorMsg.includes('connection') || errorMsg.includes('not available')) {
                  mcpError = new Error(errorMsg);
                  throw mcpError;
                }
                // Check if it's a permission error
                if (errorMsg.includes('Authorization') || errorMsg.includes('403') || errorMsg.includes('permission')) {
                  throw new Error(`Permission denied: ${errorMsg}. Service Principal needs 'Resource Group Contributor' role. Run: az role assignment create --assignee ${process.env.AZURE_CLIENT_ID} --role "Resource Group Contributor" --scope /subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}`);
                }
                throw new Error(`Failed to create resource group: ${errorMsg}`);
              }
              console.log('Resource group created successfully');
              resourcesCreated = true;
            } else {
              console.log('Resource group already exists at location:', rgValidation.location);
            }

            // Step 1: Validate or create storage account
            try {
              storageValidation = await mcpClient.validateAzureStorageAccount(
              defaults.storageAccount,
              defaults.resourceGroup
            );
            } catch (error: any) {
              console.error('Error validating storage account (will attempt to create):', error.message);
              // If validation fails, assume it doesn't exist and try to create
              storageValidation = { exists: false };
            }

            if (!storageValidation.exists) {
              console.log('Storage account does not exist. Creating...');
              const createResult = await mcpClient.createAzureStorageAccount(
                defaults.storageAccount,
                defaults.resourceGroup,
                defaults.location
              );

              if (!createResult.success) {
                const errorMsg = createResult.error || 'Unknown error';
                // Check if it's an MCP connection error
                if (errorMsg.includes('MCP server') || errorMsg.includes('connection') || errorMsg.includes('not available')) {
                  mcpError = new Error(errorMsg);
                  throw mcpError;
                }
                // Check if it's a permission error
                if (errorMsg.includes('Authorization') || errorMsg.includes('403') || errorMsg.includes('permission')) {
                  throw new Error(`Permission denied: ${errorMsg}. Service Principal needs 'Storage Account Contributor' role. Run: az role assignment create --assignee ${process.env.AZURE_CLIENT_ID} --role "Storage Account Contributor" --scope /subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}`);
                }
                throw new Error(`Failed to create storage account: ${errorMsg}`);
              }
              console.log('Storage account created successfully');
              resourcesCreated = true;
              // Get location from created storage account
              if (!storageValidation.location) {
                storageValidation.location = defaults.location;
              }
            } else {
              console.log('Storage account already exists');
            }

            // Step 2: Validate or create container
            try {
              containerValidation = await mcpClient.validateAzureContainer(
              defaults.storageAccount,
              defaults.resourceGroup,
              defaults.container
            );
            } catch (error: any) {
              console.error('Error validating container (will attempt to create):', error.message);
              // If validation fails, assume it doesn't exist and try to create
              containerValidation = { exists: false };
            }

            if (!containerValidation.exists) {
              console.log('Container does not exist. Creating...');
              const createResult = await mcpClient.createAzureContainer(
                defaults.storageAccount,
                defaults.container,
                defaults.resourceGroup
              );

              if (!createResult.success) {
                const errorMsg = createResult.error || 'Unknown error';
                // Check if it's an MCP connection error
                if (errorMsg.includes('MCP server') || errorMsg.includes('connection') || errorMsg.includes('not available')) {
                  mcpError = new Error(errorMsg);
                  throw mcpError;
                }
                // Check if it's a permission error
                if (errorMsg.includes('Authorization') || errorMsg.includes('403') || errorMsg.includes('permission')) {
                  throw new Error(`Permission denied: ${errorMsg}. Service Principal needs 'Storage Blob Data Contributor' role. Run: az role assignment create --assignee ${process.env.AZURE_CLIENT_ID} --role "Storage Blob Data Contributor" --scope /subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}`);
                }
                throw new Error(`Failed to create container: ${errorMsg}`);
              }
              console.log('Container created successfully');
              resourcesCreated = true;
            } else {
              console.log('Container already exists');
            }
          } catch (error: any) {
            // Check if it's an MCP connection error
            const isMCPError = error?.message?.includes('MCP server') || 
                              error?.message?.includes('connection') || 
                              error?.message?.includes('not available') ||
                              error?.message?.includes('connection closed');
            
            if (isMCPError && !resourcesCreated) {
              // MCP is not available - generate backend files without creating resources
              console.log('⚠️  Azure MCP server is not available. Generating backend configuration files without creating resources...');
              mcpError = error;
              // Continue to file generation below
            } else {
              // Real error - rethrow
              throw error;
            }
          }

          // Update session with backend configuration
          await storage.updateSession(sessionId, {
            hasBackend: 'true',
            backendType: 'azurerm',
            backendStorageAccount: defaults.storageAccount,
            backendResourceGroup: defaults.resourceGroup,
            backendContainer: defaults.container,
            backendLocation: storageValidation.location || defaults.location,
            backendStateKey: defaults.stateKey,
            backendValidated: 'true', // Mark as validated since we just created/verified resources
            workflowStep: 'terraform_generation'
          });

          // Generate and store required Terraform files immediately
          const backendTfContent = openaiService.generateBackendTf({
            backendType: 'azurerm',
            storageAccount: defaults.storageAccount,
            resourceGroup: defaults.resourceGroup,
            container: defaults.container,
            stateKey: defaults.stateKey
          });

          const providerTfContent = openaiService.generateProviderTf(session.cloudProvider || 'azure');

          // Fetch latest Terraform version from MCP server or API
          let latestVersion = TERRAFORM_DEFAULT_VERSION; // See config/constants.ts
          try {
            latestVersion = await mcpClient.getLatestTerraformVersion();
            console.log(`Using Terraform version: ${latestVersion}`);
          } catch (versionError) {
            console.error('Error fetching Terraform version, using default:', versionError);
            // Continue with default version
          }
          
          // Generate terraform.tf with specific version (exact version, not >=)
          const terraformTfContent = `terraform {
  required_version = "${latestVersion}"
}`;

          // Store the files
          await storage.createFile({
            sessionId,
            fileName: 'backend.tf',
            content: backendTfContent
          });

          await storage.createFile({
            sessionId,
            fileName: 'provider.tf',
            content: providerTfContent
          });

          await storage.createFile({
            sessionId,
            fileName: 'terraform.tf',
            content: terraformTfContent
          });

          return res.json({
            status: 'configured',
            message: 'Azure backend provisioning completed successfully. Generated backend.tf, provider.tf, and terraform.tf. Provide the infrastructure requirements to continue.',
            details: {
              ...defaults,
              actualLocation: storageValidation.location || defaults.location,
              filesGenerated: ['backend.tf', 'provider.tf', 'terraform.tf']
            }
          });
        } catch (error: any) {
          console.error('Error creating Azure backend resources:', error);
          return res.status(500).json({
            status: 'creation_error',
            error: error.message || 'Failed to create Azure backend resources',
            suggestion: 'Ensure you are authenticated with Azure CLI (run: az login) and have proper permissions to create storage accounts'
          });
        }
      }

      res.status(400).json({ error: 'Invalid action. Use: validate, create, or decline' });

    } catch (error: any) {
      console.error('Error configuring backend:', error);
      res.status(500).json({ error: 'Failed to configure backend' });
    }
  });

  // Generate Terraform files
  // NOTE: This is a very large endpoint (1700+ lines). The full implementation is in routes-legacy.ts
  // This endpoint is deferred and will be migrated incrementally in a future phase.
  // The actual handler is registered in routes-legacy.ts via registerLegacyRoutes()
  // We do NOT register it here to avoid conflicts - let the legacy route handle it

  // Refactor Terraform files (validate best practices)
  app.post("/api/sessions/:id/refactor", async (req, res) => {
    interface RefactorResult {
      isValid: boolean;
      issues: Array<{
        file: string;
        type: 'hardcoded_value' | 'missing_variable' | 'missing_declaration' | 'missing_tfvars' | 'hardcoded_default' | 'multiple_resources_same_type' | 'poor_structure' | 'naming_issue';
        severity: 'error' | 'warning';
        message: string;
        line?: number;
        suggestion?: string;
        codeSnippet?: string;
      }>;
      suggestions: Array<{
        file: string;
        action: string;
        details: string;
      }>;
      summary: {
        totalIssues: number;
        errors: number;
        warnings: number;
        filesChecked: number;
      };
    }
    const sessionId = req.params.id;
    
    try {
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Get all Terraform files from session storage
      const files = await storage.getFilesBySession(sessionId);
      const terraformFiles = files.filter(f => 
        f.fileName.endsWith('.tf') || f.fileName.endsWith('.tfvars')
      );

      console.log(`\n🔍 [REFACTOR] Validating Terraform best practices...`);
      console.log(`   Session ID: ${sessionId}`);
      console.log(`   Files to check: ${terraformFiles.length}`);

      const issues: Array<{
        file: string;
        type: 'hardcoded_value' | 'missing_variable' | 'missing_declaration' | 'missing_tfvars' | 'hardcoded_default' | 'multiple_resources_same_type' | 'poor_structure' | 'naming_issue';
        severity: 'error' | 'warning';
        message: string;
        line?: number;
        suggestion?: string;
        codeSnippet?: string;
      }> = [];

      const suggestions: Array<{
        file: string;
        action: string;
        details: string;
      }> = [];

      // Find main.tf, variables.tf, and tfvars files
      const mainTf = terraformFiles.find(f => f.fileName === 'main.tf');
      const variablesTf = terraformFiles.find(f => f.fileName === 'variables.tf');
      const tfvarsFiles = terraformFiles.filter(f => f.fileName.endsWith('.tfvars'));

      console.log(`   Found: main.tf=${!!mainTf}, variables.tf=${!!variablesTf}, tfvars=${tfvarsFiles.length}`);

      // Extract all declared variables from variables.tf
      const declaredVariables = new Set<string>();
      if (variablesTf) {
        TERRAFORM_VAR_DECLARATION_PATTERN.lastIndex = 0;
        let match;
        while ((match = TERRAFORM_VAR_DECLARATION_PATTERN.exec(variablesTf.content)) !== null) {
          declaredVariables.add(match[1]);
        }
        console.log(`   Declared variables: ${Array.from(declaredVariables).join(', ')}`);
      }

      // Extract all variables used in main.tf
      const usedVariables = new Set<string>();
      if (mainTf) {
        // Match var.variable_name or ${var.variable_name}
        TERRAFORM_VAR_USAGE_PATTERN.lastIndex = 0;
        let match;
        while ((match = TERRAFORM_VAR_USAGE_PATTERN.exec(mainTf.content)) !== null) {
          usedVariables.add(match[1]);
        }
        console.log(`   Used variables: ${Array.from(usedVariables).join(', ')}`);
      }

      // Extract all variables defined in tfvars files
      const tfvarsVariables = new Set<string>();
      tfvarsFiles.forEach(tfvarsFile => {
        const lines = tfvarsFile.content.split('\n');
        lines.forEach((line, lineNum) => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const match = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
            if (match) {
              tfvarsVariables.add(match[1].trim());
            }
          }
        });
      });
      console.log(`   Tfvars variables: ${Array.from(tfvarsVariables).join(', ')}`);

      // Check 1: Variables used in main.tf but not declared in variables.tf
      if (mainTf && variablesTf) {
        usedVariables.forEach(varName => {
          if (!declaredVariables.has(varName)) {
            issues.push({
              file: 'main.tf',
              type: 'missing_declaration',
              severity: 'error',
              message: `Variable "${varName}" is used in main.tf but not declared in variables.tf`,
              suggestion: `Add "variable "${varName}" { ... }" to variables.tf`
            });
          }
        });
      }

      // Check 2: Variables declared but not in tfvars
      if (variablesTf && tfvarsFiles.length > 0) {
        declaredVariables.forEach(varName => {
          if (!tfvarsVariables.has(varName)) {
            issues.push({
              file: variablesTf.fileName,
              type: 'missing_tfvars',
              severity: 'warning',
              message: `Variable "${varName}" is declared but not assigned in any .tfvars file`,
              suggestion: `Add "${varName} = <value>" to your .tfvars file`
            });
          }
        });
      }

      // Check 3: Hardcoded values in main.tf (should use variables)
      if (mainTf) {
        const lines = mainTf.content.split('\n');
        lines.forEach((line, lineNum) => {
          const trimmed = line.trim();
          
          // Skip comments and empty lines
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
            return;
          }

          // Skip lines that already use variables
          if (trimmed.includes('var.') || trimmed.includes('${var.')) {
            return;
          }

          // Check for hardcoded attribute values that should be variables
          // Pattern: attribute_name = "hardcoded-value" (not resource type, not function calls)
          // Use AI to detect which attributes should be variables (not hardcoded)
          // For performance, we'll use a simplified approach: detect common configurable attributes
          // In a production system, this could be enhanced with AI-based detection
          // Derive configurable attributes dynamically from all registered pricing configs.
          // This list automatically grows as new Azure (or AWS/GCP) resource types are added.
          const configurableAttributes = Array.from(new Set([
            // Baseline attributes always worth flagging
            'name', 'location', 'region', 'resource_group_name',
            // Dynamically sourced from every registered pricing config
            ...Object.values(AZURE_PRICING_CONFIG).flatMap(c => c.attributeKeys),
          ]));

          configurableAttributes.forEach(attr => {
            // Match: attribute = "value" or attribute = value
            const attrPattern = new RegExp(`${attr}\\s*=\\s*"([^"]+)"`, 'i');
            const attrMatch = trimmed.match(attrPattern);
            
            if (attrMatch) {
              const value = attrMatch[1];
              // Skip if it's a reference (data., resource., etc.)
              if (!TERRAFORM_REFERENCE_PREFIXES.test(value) &&
                  !PURE_NUMBER_PATTERN.test(value) &&
                  value.length > 1 &&
                  !TERRAFORM_KEYWORD_PATTERN.test(value)) {

                // Only flag values long enough to be meaningful non-tier literals
                if (!PROVIDER_TIER_LITERAL_PATTERN.test(value) &&
                    value.length > MIN_MEANINGFUL_VALUE_LENGTH) {
                  
                  issues.push({
                    file: 'main.tf',
                    type: 'hardcoded_value',
                    severity: 'warning',
                    message: `Hardcoded value for "${attr}": "${value}" (line ${lineNum + 1})`,
                    line: lineNum + 1,
                    suggestion: `Use a variable instead: ${attr} = var.${attr.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()}`
                  });
                }
              }
            }
          });

          // Check for hardcoded resource names (suggest using variables for naming)
          const resourceNamePattern = /resource\s+"([^"]+)"\s+"([^"]+)"/;
          const resourceMatch = trimmed.match(resourceNamePattern);
          if (resourceMatch) {
            const resourceName = resourceMatch[2];
            // If resource name is a hardcoded string and looks like a configurable name
            if (!resourceName.includes('var.') && 
                !resourceName.includes('${') &&
                resourceName.length > MIN_RESOURCE_NAME_LENGTH &&
                !resourceName.match(/^[a-z0-9-]+$/)) { // Not just a simple identifier
              // Suggest using variable for resource naming
              suggestions.push({
                file: 'main.tf',
                action: `Consider using a variable for resource name "${resourceName}"`,
                details: `Best practice: Use variables for resource names to make them configurable across environments`
              });
            }
          }
        });
      }

      // Check 4: Hardcoded defaults in variables.tf (should be in tfvars)
      if (variablesTf) {
        const lines = variablesTf.content.split('\n');
        let currentVariable = '';
        let inDefaultBlock = false;
        
        lines.forEach((line, lineNum) => {
          const trimmed = line.trim();
          
          // Detect variable declaration
          const varMatch = trimmed.match(/variable\s+"([^"]+)"/);
          if (varMatch) {
            currentVariable = varMatch[1];
            inDefaultBlock = false;
          }
          
          // Detect default block
          if (trimmed.includes('default') && trimmed.includes('=')) {
            inDefaultBlock = true;
            const defaultMatch = trimmed.match(/default\s*=\s*(.+)/);
            if (defaultMatch && currentVariable) {
              const defaultValue = defaultMatch[1].trim();
              // Check if this variable is also in tfvars (redundant default)
              if (tfvarsVariables.has(currentVariable)) {
                issues.push({
                  file: 'variables.tf',
                  type: 'hardcoded_default',
                  severity: 'warning',
                  message: `Variable "${currentVariable}" has a default value but is also defined in .tfvars`,
                  line: lineNum + 1,
                  suggestion: `Remove the default from variables.tf since it's defined in .tfvars`
                });
              } else {
                // Default is OK if not in tfvars, but suggest moving to tfvars
                suggestions.push({
                  file: 'variables.tf',
                  action: `Move default value for "${currentVariable}" to .tfvars file`,
                  details: `Best practice: Keep variables.tf for declarations only, put values in .tfvars`
                });
              }
            }
          }
        });
      }

      // Check 5: Variables in tfvars but not declared
      if (variablesTf && tfvarsFiles.length > 0) {
        tfvarsVariables.forEach(varName => {
          if (!declaredVariables.has(varName)) {
            issues.push({
              file: tfvarsFiles[0].fileName,
              type: 'missing_declaration',
              severity: 'error',
              message: `Variable "${varName}" is defined in .tfvars but not declared in variables.tf`,
              suggestion: `Add "variable "${varName}" { ... }" to variables.tf`
            });
          }
        });
      }

      // Check 6: AI-driven best practices validation
      console.log(`\n   🤖 Running AI-driven best practices analysis...`);
      try {
        const aiAnalysis = await openaiService.analyzeTerraformBestPractices(terraformFiles);
        
        // Add AI-detected issues
        if (aiAnalysis.issues && aiAnalysis.issues.length > 0) {
          console.log(`   ✅ AI found ${aiAnalysis.issues.length} best practices issue(s)`);
          aiAnalysis.issues.forEach(issue => {
            issues.push({
              file: issue.file,
              type: issue.type as any,
              severity: issue.severity,
              message: issue.message,
              line: issue.line,
              suggestion: issue.suggestion,
              codeSnippet: issue.codeSnippet
            });
          });
        }

        // Add AI suggestions
        if (aiAnalysis.suggestions && aiAnalysis.suggestions.length > 0) {
          console.log(`   💡 AI provided ${aiAnalysis.suggestions.length} suggestion(s)`);
          aiAnalysis.suggestions.forEach(suggestion => {
            suggestions.push(suggestion);
          });
        }
      } catch (aiError: any) {
        console.error(`   ⚠️  AI best practices analysis failed: ${aiError.message}`);
        // Continue without AI analysis - regex-based checks are still valid
      }

      // Check 7: Detect multiple resources of same type (regex-based fallback)
      if (mainTf) {
        const resourceTypeCounts = new Map<string, number>();
        const resourcePattern = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
        let match;
        const resourceBlocks: Array<{ type: string; name: string; hasCount: boolean; hasForEach: boolean }> = [];
        
        while ((match = resourcePattern.exec(mainTf.content)) !== null) {
          const resourceType = match[1];
          const resourceName = match[2];
          
          // Check if this resource uses count or for_each
          const resourceStart = match.index;
          const resourceEnd = findMatchingBrace(mainTf.content, resourceStart + match[0].length - 1);
          const resourceBody = mainTf.content.substring(resourceStart, resourceEnd);
          
          const hasCount = /count\s*=/.test(resourceBody);
          const hasForEach = /for_each\s*=/.test(resourceBody);
          
          resourceBlocks.push({ type: resourceType, name: resourceName, hasCount, hasForEach });
          resourceTypeCounts.set(resourceType, (resourceTypeCounts.get(resourceType) || 0) + 1);
        }

        // Check for multiple resources of same type without count/for_each
        resourceTypeCounts.forEach((count, resourceType) => {
          if (count >= 3) {
            const resourcesOfType = resourceBlocks.filter(r => r.type === resourceType);
            const withoutMetaArg = resourcesOfType.filter(r => !r.hasCount && !r.hasForEach);
            
            if (withoutMetaArg.length >= 3) {
              issues.push({
                file: 'main.tf',
                type: 'multiple_resources_same_type',
                severity: 'error',
                message: `Found ${count} resources of type "${resourceType}" without using count or for_each. This violates Terraform best practices.`,
                suggestion: `Refactor to use count or for_each meta-argument. Example: resource "${resourceType}" "example" { for_each = toset(["r1", "r2", "r3"]) ... }`,
                codeSnippet: `Multiple ${resourceType} resources found`
              });
            }
          }
        });
      }

      const errors = issues.filter(i => i.severity === 'error').length;
      const warnings = issues.filter(i => i.severity === 'warning').length;

      const result: RefactorResult = {
        isValid: issues.length === 0,
        issues,
        suggestions,
        summary: {
          totalIssues: issues.length,
          errors,
          warnings,
          filesChecked: terraformFiles.length
        }
      };

      console.log(`\n✅ [REFACTOR] Validation complete:`);
      console.log(`   Files checked: ${result.summary.filesChecked}`);
      console.log(`   Total issues: ${result.summary.totalIssues} (${errors} errors, ${warnings} warnings)`);
      console.log(`   Valid: ${result.isValid}`);

      res.json(result);
    } catch (error: any) {
      console.error('Error validating Terraform files:', error);
      res.status(500).json({ 
        error: 'Failed to validate Terraform files',
        details: error.message 
      });
    }
  });

  // Fix Terraform best practices issues automatically
  app.post("/api/sessions/:id/refactor-fix", async (req, res) => {
    const sessionId = req.params.id;
    
    try {
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🔧 [REFACTOR-FIX] Fixing Terraform best practices issues...`);
      console.log(`   Session ID: ${sessionId}`);
      
      let totalFixedIssues = 0;
      const allFixes: string[] = [];
      const fixesByPass: Array<{ pass: number; fixes: string[] }> = [];
      const maxPasses = 5; // Maximum number of fix passes to prevent infinite loops
      let pass = 0;

      // Run fix passes until no more issues are found or max passes reached
      while (pass < maxPasses) {
        pass++;
        console.log(`\n   🔄 Fix pass ${pass}/${maxPasses}...`);

        // Get all Terraform files from session storage (refresh on each pass)
        const files = await storage.getFilesBySession(sessionId);
        const terraformFiles = files.filter(f => 
          f.fileName.endsWith('.tf') || f.fileName.endsWith('.tfvars')
        );

        console.log(`   Files to fix: ${terraformFiles.length}`);

        // Find main.tf, variables.tf, and tfvars files
        let mainTf = terraformFiles.find(f => f.fileName === 'main.tf');
        let variablesTf = terraformFiles.find(f => f.fileName === 'variables.tf');
        const tfvarsFiles = terraformFiles.filter(f => f.fileName.endsWith('.tfvars'));
        const primaryTfvars = tfvarsFiles.find(f => f.fileName === 'dev.terraform.tfvars') || tfvarsFiles[0];

        let fixedIssues = 0;
        const fixes: string[] = [];

        // Extract current state
        const declaredVariables = new Set<string>();
        if (variablesTf) {
          const variablePattern = /variable\s+"([^"]+)"/g;
          let match;
          while ((match = variablePattern.exec(variablesTf.content)) !== null) {
            declaredVariables.add(match[1]);
          }
        }

        const usedVariables = new Set<string>();
        if (mainTf) {
          const varPattern = /var\.([a-zA-Z0-9_-]+)/g;
          let match;
          while ((match = varPattern.exec(mainTf.content)) !== null) {
            usedVariables.add(match[1]);
          }
        }

        const tfvarsVariables = new Set<string>();
        if (primaryTfvars) {
          const lines = primaryTfvars.content.split('\n');
          lines.forEach((line) => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
              const match = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
              if (match) {
                tfvarsVariables.add(match[1].trim());
              }
            }
          });
        }

        // Fix 1: Add missing variable declarations to variables.tf (create if doesn't exist)
        if (mainTf) {
          const missingDeclarations = Array.from(usedVariables).filter(v => !declaredVariables.has(v));
          if (missingDeclarations.length > 0) {
            console.log(`      🔧 Fix 1: Adding ${missingDeclarations.length} missing variable declaration(s) to variables.tf`);
            
            // Use AI to generate proper variable declarations
            let varDeclarations = '';
            try {
              varDeclarations = await openaiService.generateVariableDeclarations(
                missingDeclarations,
                mainTf.content
              );
              console.log(`      ✅ AI generated declarations for ${missingDeclarations.length} variable(s)`);
            } catch (aiError: any) {
              console.warn(`      ⚠️  AI declaration generation failed: ${aiError.message}, using fallback`);
              // Fallback: Generate simple declarations
              missingDeclarations.forEach(varName => {
                varDeclarations += `\n\nvariable "${varName}" {\n  description = "Value for ${varName}"\n  type        = string\n}`;
              });
            }
            
            if (variablesTf) {
              // Update existing variables.tf
              const newContent = variablesTf.content.trim() + varDeclarations;
              await storage.updateFile(variablesTf.id, newContent);
              console.log(`      ✅ Updated variables.tf (ID: ${variablesTf.id}, new size: ${newContent.length} chars)`);
              variablesTf = { ...variablesTf, content: newContent };
              missingDeclarations.forEach(varName => {
                fixes.push(`Added variable declaration for "${varName}" to variables.tf`);
                fixedIssues++;
              });
            } else {
              // Create new variables.tf
              const newContent = varDeclarations.trim();
              const created = await storage.createFile({
                sessionId,
                fileName: 'variables.tf',
                content: newContent,
              });
              console.log(`      ✅ Created variables.tf (ID: ${created.id}, size: ${newContent.length} chars)`);
              variablesTf = created;
              missingDeclarations.forEach(varName => {
                fixes.push(`Created variables.tf with declaration for "${varName}"`);
                fixedIssues++;
              });
            }
            
            declaredVariables.clear();
            // Re-extract declared variables
            const variablePattern = /variable\s+"([^"]+)"\s*\{/g;
            let match;
            while ((match = variablePattern.exec(variablesTf.content)) !== null) {
              declaredVariables.add(match[1]);
            }
          }
        }

        // Fix 2: Add missing variables to tfvars with sensible default values
        if (variablesTf && primaryTfvars) {
          const missingInTfvars = Array.from(declaredVariables).filter(v => !tfvarsVariables.has(v));
          if (missingInTfvars.length > 0) {
            console.log(`      🔧 Fix 2: Adding ${missingInTfvars.length} missing variable(s) to ${primaryTfvars.fileName} with sensible defaults...`);
            
            // Use AI to generate sensible default values based on variable names and context
            let tfvarsValues = '';
            try {
              if (mainTf) {
                tfvarsValues = await openaiService.generateTfvarsValues(
                  missingInTfvars,
                  mainTf.content,
                  'Terraform best practices fix - populate variable values'
                );
                console.log(`      ✅ AI generated values for ${missingInTfvars.length} variable(s)`);
              }
            } catch (aiError: any) {
              console.warn(`      ⚠️  AI value generation failed: ${aiError.message}, using fallback defaults`);
              // Fallback: Generate simple defaults based on variable name patterns
              missingInTfvars.forEach(varName => {
                let defaultValue = '"value"';
                if (varName.includes('count') || varName.includes('Count')) {
                  defaultValue = '1';
                } else if (varName.includes('location') || varName.includes('region')) {
                  defaultValue = session.cloudProvider === 'aws' ? '"us-east-1"' : '"eastus"';
                } else if (varName.includes('prefix') || varName.includes('name')) {
                  defaultValue = '"example"';
                } else if (varName.includes('tags')) {
                  defaultValue = '{}';
                } else if (varName.includes('enabled') || varName.includes('enable')) {
                  defaultValue = 'true';
                }
                tfvarsValues += `${varName} = ${defaultValue}\n`;
              });
            }
            
            let newContent = primaryTfvars.content.trim();
            if (!newContent.endsWith('\n')) {
              newContent += '\n';
            }
            
            // Parse AI-generated values and add them
            if (tfvarsValues) {
              const valueLines = tfvarsValues.split('\n').filter(line => {
                const trimmed = line.trim();
                return trimmed && !trimmed.startsWith('#') && trimmed.includes('=');
              });
              
              valueLines.forEach(line => {
                const match = line.match(/^([^=]+?)\s*=\s*(.+)$/);
                if (match) {
                  const varName = match[1].trim();
                  const varValue = match[2].trim();
                  if (missingInTfvars.includes(varName)) {
                    newContent += `\n${varName} = ${varValue}`;
                    fixes.push(`Added "${varName}" = ${varValue} to ${primaryTfvars.fileName}`);
                    fixedIssues++;
                  }
                }
              });
            } else {
              // Fallback if AI didn't generate values
              missingInTfvars.forEach(varName => {
                const varAssignment = `\n${varName} = "<value>"  # TODO: Set appropriate value`;
                newContent += varAssignment;
                fixes.push(`Added "${varName}" to ${primaryTfvars.fileName} (needs value)`);
                fixedIssues++;
              });
            }
            
            await storage.updateFile(primaryTfvars.id, newContent);
            console.log(`      ✅ Updated ${primaryTfvars.fileName} (ID: ${primaryTfvars.id}, new size: ${newContent.length} chars)`);
          }
        }

        // Fix 3: AI-driven best practices fixing (for complex issues like multiple resources, structure, etc.)
        console.log(`      🤖 Fix 3: Running AI-driven best practices fixing...`);
        try {
          // First, run validation to get current issues
          // Include ALL files (main.tf, variables.tf, .tfvars) so AI has full context
          const validationFiles = terraformFiles.map(f => ({ fileName: f.fileName, content: f.content }));
          console.log(`      📄 Files being analyzed: ${validationFiles.map(f => f.fileName).join(', ')}`);
          
          const aiAnalysis = await openaiService.analyzeTerraformBestPractices(validationFiles);
          
          // Filter for issues that need AI fixing (multiple resources, structure issues, etc.)
          const aiFixableIssues = aiAnalysis.issues.filter(issue => 
            issue.type === 'multiple_resources_same_type' || 
            issue.type === 'poor_structure' ||
            issue.type === 'naming_issue' ||
            (issue.type === 'hardcoded_value' && issue.severity === 'error')
          );

          if (aiFixableIssues.length > 0) {
            console.log(`      🔧 AI will fix ${aiFixableIssues.length} complex issue(s)`);
            
            const aiFixResult = await openaiService.fixTerraformBestPractices(
              validationFiles,
              aiFixableIssues
            );

            if (aiFixResult.files && aiFixResult.files.length > 0) {
              // Update files with AI fixes
              for (const fixedFile of aiFixResult.files) {
                const existingFile = terraformFiles.find(f => f.fileName === fixedFile.fileName);
                if (existingFile) {
                  // File exists, update it
                  await storage.updateFile(existingFile.id, fixedFile.content);
                  console.log(`      ✅ AI updated ${fixedFile.fileName} (ID: ${existingFile.id})`);
                  fixedIssues += aiFixableIssues.length;
                } else {
                  // File doesn't exist, create it
                  await storage.createFile({
                    sessionId,
                    fileName: fixedFile.fileName,
                    content: fixedFile.content
                  });
                  console.log(`      ✅ AI created ${fixedFile.fileName} (new file)`);
                  fixedIssues += aiFixableIssues.length;
                }
              }

              // Refresh local references after all updates
              const refreshedFiles = await storage.getFilesBySession(sessionId);
              const refreshedMainTf = refreshedFiles.find(f => f.fileName === 'main.tf');
              const refreshedVariablesTf = refreshedFiles.find(f => f.fileName === 'variables.tf');
              
              if (refreshedMainTf) {
                mainTf = refreshedMainTf;
              }
              if (refreshedVariablesTf) {
                variablesTf = refreshedVariablesTf;
              }

              // Add fix descriptions
              if (aiFixResult.fixes && aiFixResult.fixes.length > 0) {
                aiFixResult.fixes.forEach(fix => fixes.push(`AI Fix: ${fix}`));
              }
              
              console.log(`      📋 AI processed ${aiFixResult.files.length} file(s): ${aiFixResult.files.map(f => f.fileName).join(', ')}`);
            } else {
              console.log(`      ⚠️  AI returned no files to update`);
            }
          }
        } catch (aiFixError: any) {
          console.error(`      ⚠️  AI best practices fixing failed: ${aiFixError.message}`);
          // Continue with regex-based fixes
        }

        // Fix 4: Replace hardcoded values in main.tf with variables (regex-based for simple cases)
        if (mainTf) {
          console.log(`      🔧 Fix 4: Checking for hardcoded values in main.tf (regex-based)`);
          let newContent = mainTf.content;
          const lines = newContent.split('\n');
          let modified = false;
          
          // Derive configurable attributes dynamically from all registered pricing configs.
          // This list auto-grows as new resource types are added to AZURE_PRICING_CONFIG.
          const configurableAttributes = Array.from(new Set([
            'name', 'location', 'region', 'resource_group_name',
            ...Object.values(AZURE_PRICING_CONFIG).flatMap(c => c.attributeKeys),
          ]));

          const newLines: string[] = [];
          const variablesToAdd: Array<{ name: string; value: string; attr: string }> = [];

          for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            const trimmed = line.trim();
            
            // Skip comments and empty lines
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
              newLines.push(line);
              continue;
            }

            // Skip lines that already use variables
            if (trimmed.includes('var.') || trimmed.includes('${var.')) {
              newLines.push(line);
              continue;
            }

            let lineModified = false;
            // Check each configurable attribute
            for (const attr of configurableAttributes) {
              const attrPattern = new RegExp(`(${attr}\\s*=\\s*)"([^"]+)"`, 'i');
              const attrMatch = trimmed.match(attrPattern);
              
              if (attrMatch) {
                const value = attrMatch[2];
                // Skip if it's a reference or built-in
                // Use AI to determine if this value should be a variable
                // For now, use basic heuristics, but this could be enhanced with AI
                if (!value.match(/^(data\.|resource\.|module\.|local\.|path\.|self\.|count\.|each\.|var\.)/) &&
                    !value.match(/^[0-9]+$/) && // Skip pure numbers (might be counts)
                    value.length > 2 && // More lenient - fix values longer than 2 chars
                    !value.match(/^(true|false|null)$/i)) {
                  
                  // Create variable name from attribute
                  const varName = attr.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
                  
                  // Replace with variable reference
                  const newLine = line.replace(attrMatch[0], `${attrMatch[1]}var.${varName}`);
                  newLines.push(newLine);
                  lineModified = true;
                  modified = true;
                  
                  // Track variables that need to be added
                  if (!declaredVariables.has(varName)) {
                    variablesToAdd.push({ name: varName, value, attr });
                    declaredVariables.add(varName);
                  }
                  
                  fixes.push(`Replaced hardcoded "${attr}" value with var.${varName} in main.tf (line ${lineNum + 1})`);
                  fixedIssues++;
                  break;
                }
              }
            }
            
            if (!lineModified) {
              newLines.push(line);
            }
          }

          // Add variables that were created during replacement
          for (const { name: varName, value, attr } of variablesToAdd) {
            // Add to variables.tf if it exists
            if (variablesTf) {
              const varDeclaration = `\n\nvariable "${varName}" {\n  description = "Value for ${attr}"\n  type        = string\n}`;
              const updatedVariablesTf = variablesTf.content + varDeclaration;
              await storage.updateFile(variablesTf.id, updatedVariablesTf);
              variablesTf = { ...variablesTf, content: updatedVariablesTf };
              fixes.push(`Added variable declaration for "${varName}" to variables.tf`);
            }
            
            // Add to tfvars if it exists
            if (primaryTfvars) {
              const varAssignment = `\n${varName} = "${value}"`;
              const updatedTfvars = primaryTfvars.content.trim() + (primaryTfvars.content.trim().endsWith('\n') ? '' : '\n') + varAssignment;
              await storage.updateFile(primaryTfvars.id, updatedTfvars);
            }
          }

          if (modified) {
            newContent = newLines.join('\n');
            await storage.updateFile(mainTf.id, newContent);
            console.log(`      ✅ Updated main.tf (ID: ${mainTf.id}, new size: ${newContent.length} chars)`);
          }
        }

        // Fix 5: Remove redundant defaults from variables.tf
        if (variablesTf && primaryTfvars) {
          console.log(`      🔧 Fix 5: Checking for redundant defaults in variables.tf`);
          const lines = variablesTf.content.split('\n');
          const newLines: string[] = [];
          let currentVariable = '';
          let skipNextDefault = false;
        
          lines.forEach((line) => {
            const trimmed = line.trim();
            
            // Detect variable declaration
            const varMatch = trimmed.match(/variable\s+"([^"]+)"/);
            if (varMatch) {
              currentVariable = varMatch[1];
              skipNextDefault = tfvarsVariables.has(currentVariable);
              newLines.push(line);
              return;
            }
            
            // Skip default lines if variable is in tfvars
            if (skipNextDefault && trimmed.includes('default') && trimmed.includes('=')) {
              fixes.push(`Removed redundant default for "${currentVariable}" from variables.tf`);
              fixedIssues++;
              return; // Skip this line
            }
            
            // Reset skip flag when we leave the variable block
            if (trimmed === '}' && skipNextDefault) {
              skipNextDefault = false;
            }
            
            newLines.push(line);
          });

          if (newLines.length !== lines.length) {
            const newContent = newLines.join('\n');
            await storage.updateFile(variablesTf.id, newContent);
            console.log(`      ✅ Updated variables.tf (ID: ${variablesTf.id}, removed ${lines.length - newLines.length} line(s))`);
          }
        }

        // Fix 6: Add missing variable declarations for variables in tfvars
        if (variablesTf && primaryTfvars) {
          const missingDeclarations = Array.from(tfvarsVariables).filter(v => !declaredVariables.has(v));
          if (missingDeclarations.length > 0) {
            console.log(`      🔧 Fix 6: Adding ${missingDeclarations.length} missing variable declaration(s) for variables in .tfvars`);
            let newContent = variablesTf.content;
            missingDeclarations.forEach(varName => {
              const varDeclaration = `\n\nvariable "${varName}" {\n  description = "Value for ${varName}"\n  type        = string\n}`;
              newContent += varDeclaration;
              fixes.push(`Added variable declaration for "${varName}" to variables.tf (was in .tfvars)`);
              fixedIssues++;
            });
            await storage.updateFile(variablesTf.id, newContent);
            console.log(`      ✅ Updated variables.tf (ID: ${variablesTf.id}, new size: ${newContent.length} chars)`);
          }
        }

        totalFixedIssues += fixedIssues;
        allFixes.push(...fixes);
        if (fixes.length > 0) {
          fixesByPass.push({ pass, fixes: [...fixes] });
        }

        console.log(`   ✅ Pass ${pass} complete: Fixed ${fixedIssues} issue(s)`);
        if (fixes.length > 0) {
          console.log(`   📋 Fixes applied in this pass:`);
          fixes.forEach(fix => console.log(`      - ${fix}`));
        }

        // Verify files were actually updated by re-fetching
        if (fixedIssues > 0) {
          const verifyFiles = await storage.getFilesBySession(sessionId);
          const verifyMainTf = verifyFiles.find(f => f.fileName === 'main.tf');
          const verifyVariablesTf = verifyFiles.find(f => f.fileName === 'variables.tf');
          const verifyTfvars = verifyFiles.find(f => f.fileName.endsWith('.tfvars'));
          
          console.log(`   🔍 Verification after pass ${pass}:`);
          if (verifyMainTf) {
            console.log(`      - main.tf: ${verifyMainTf.content.length} chars (ID: ${verifyMainTf.id})`);
          }
          if (verifyVariablesTf) {
            console.log(`      - variables.tf: ${verifyVariablesTf.content.length} chars (ID: ${verifyVariablesTf.id})`);
          }
          if (verifyTfvars) {
            console.log(`      - ${verifyTfvars.fileName}: ${verifyTfvars.content.length} chars (ID: ${verifyTfvars.id})`);
          }
        }

        // If no issues were fixed in this pass, we're done
        if (fixedIssues === 0) {
          console.log(`   ✅ No more issues to fix!`);
          break;
        }

        // Re-fetch files for next pass to ensure we have latest state
        // (This happens automatically at the start of the next loop iteration)
      }

      console.log(`\n✅ [REFACTOR-FIX] All fix passes complete:`);
      console.log(`   Total passes: ${pass}`);
      console.log(`   Total issues fixed: ${totalFixedIssues}`);
      allFixes.forEach(fix => console.log(`   - ${fix}`));

      res.json({
        success: true,
        fixedIssues: totalFixedIssues,
        passes: pass,
        message: `Successfully fixed ${totalFixedIssues} issue(s) in ${pass} pass(es)`,
        fixes: allFixes,
        fixesByPass,
      });
    } catch (error: any) {
      console.error('Error fixing Terraform files:', error);
      res.status(500).json({ 
        error: 'Failed to fix Terraform files',
        details: error.message 
      });
    }
  });

  // Generate Terraform architecture diagram
  app.post("/api/sessions/:id/generate-diagram", async (req, res) => {
    const sessionId = req.params.id;
    
    try {
      console.log(`\n🎨 ========== DIAGRAM GENERATION REQUEST ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Timestamp: ${new Date().toISOString()}`);

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        console.error(`❌ Session not found: ${sessionId}`);
        return res.status(404).json({ 
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }

      console.log(`✅ Session found: step=${session.currentStep}, workflow=${session.workflowStep}`);

      // Get Terraform files from session storage
      console.log(`📁 Fetching Terraform files from session storage...`);
      const sessionFiles = await storage.getFilesBySession(sessionId);
      console.log(`📋 Total files in session: ${sessionFiles.length}`);
      sessionFiles.forEach(f => {
        console.log(`   - ${f.fileName} (${f.content.length} bytes)`);
      });
      
      const terraformFiles = sessionFiles
        .filter(f => {
          const fileName = f.fileName.toLowerCase();
          const isTerraform = fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
          // For aggregated-root, exclude backend files from diagram generation
          if (session.moduleApproach === 'aggregated-root') {
            const backendFiles = ['backend.tf', 'provider.tf', 'terraform.tf'];
            return isTerraform && !backendFiles.includes(fileName) && f.content && f.content.trim().length > 0;
          }
          return isTerraform && f.content && f.content.trim().length > 0;
        })
        .map(f => ({
          fileName: f.fileName,
          content: f.content
        }));

      console.log(`✅ Found ${terraformFiles.length} Terraform file(s) for diagram generation`);
      terraformFiles.forEach(f => {
        console.log(`   - ${f.fileName} (${f.content.length} bytes)`);
      });

      if (terraformFiles.length === 0) {
        console.error(`❌ No Terraform files found in session storage`);
        console.error(`   Total files: ${sessionFiles.length}`);
        console.error(`   Module approach: ${session.moduleApproach}`);
        return res.status(400).json({ 
          error: 'No Terraform files found',
          details: 'Please generate Terraform code first before creating a diagram',
          totalFiles: sessionFiles.length,
          moduleApproach: session.moduleApproach
        });
      }

      // Determine cloud provider from session or files
      const cloudProvider = session.cloudProvider || 'azure';
      const useAI = req.body.useAI !== false; // Default to true, allow override
      const diagramType = req.body.diagramType || 'flowchart'; // Default to flowchart

      console.log(`\n📊 ========== DIAGRAM GENERATION REQUEST ==========`);
      console.log(`☁️  Cloud Provider: ${cloudProvider}`);
      console.log(`🤖 AI Enhancement: ${useAI ? 'enabled' : 'disabled'}`);
      console.log(`📊 Diagram Type: ${diagramType}`);
      console.log(`📦 Request Body:`, JSON.stringify(req.body, null, 2));

      // Generate diagram
      const result = await generateArchitectureDiagram(
        terraformFiles,
        cloudProvider,
        useAI,
        diagramType
      );

      console.log(`\n✅ Diagram generation complete!`);
      console.log(`   📊 Resources: ${result.metadata.totalResources}`);
      console.log(`   🔗 Relationships: ${result.metadata.totalRelationships}`);
      console.log(`   📁 Categories: ${result.metadata.categories.join(', ')}`);

      // Return result
      res.json({
        success: true,
        mermaidSyntax: result.mermaidSyntax,
        resources: result.resources,
        relationships: result.relationships,
        metadata: result.metadata,
        warnings: result.warnings,
      });

    } catch (error: any) {
      console.error('❌ Error generating architecture diagram:', error);
      res.status(500).json({
        error: 'Failed to generate architecture diagram',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // ─── Policy Validation ─────────────────────────────────────────────────────

  app.post("/api/terraform/validate-policy", async (req, res) => {
    try {
      const { files, enabledRules, requiredTags, approvedRegions } = req.body;

      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'files array is required' });
      }

      const { parseResources } = await import('../diagram/resource-relationship-parser.js');
      const { runPolicyChecks } = await import('../terraform-policy-engine.js');

      const resources = parseResources(files);
      const result = runPolicyChecks(resources, { enabledRules, requiredTags, approvedRegions });

      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error('❌ Error running policy validation:', error);
      res.status(500).json({ error: 'Policy validation failed', details: error.message });
    }
  });

  // ─── Terraform Plan Diff ───────────────────────────────────────────────────

  // POST /api/sessions/:id/rightsizing-recommendations
  // Reads the session's .tf files, applies static rightsizing rules, and
  // returns per-resource recommendations with estimated savings.
  app.post("/api/sessions/:id/rightsizing-recommendations", async (req, res) => {
    try {
      const sessionId = req.params.id;
      // costsByAddress is optional: { "azurerm_linux_virtual_machine.app": 150.00 }
      // Populated by the frontend from a prior cost-analysis run so dollar
      // savings can be shown alongside percent savings.
      const { costsByAddress = {} } = req.body;

      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const sessionFiles = await storage.getFilesBySession(sessionId);
      const tfFiles = sessionFiles.filter(f =>
        f.fileName.endsWith('.tf') && !f.fileName.includes('backend')
      );

      if (tfFiles.length === 0) {
        return res.status(400).json({
          error: 'No Terraform files found in session',
          details: 'Generate or upload Terraform files before running rightsizing analysis.',
        });
      }

      const { generateRightsizingRecommendations } = await import('../terraform-rightsizing.js');
      const combinedHcl = tfFiles.map(f => f.content).join('\n\n');
      const costMap = new Map<string, number>(
        Object.entries(costsByAddress).map(([k, v]) => [k, Number(v)])
      );

      const result = generateRightsizingRecommendations(combinedHcl, costMap);

      console.log(
        `\n⚖️  RIGHTSIZING: session=${sessionId} files=${tfFiles.length}` +
        ` resources=${result.resourcesAnalysed} recs=${result.recommendations.length}`
      );

      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error('❌ Rightsizing analysis failed:', error);
      res.status(500).json({ error: 'Rightsizing analysis failed', details: error.message });
    }
  });

  app.post("/api/terraform/analyze-plan-diff", async (req, res) => {
    try {
      const { planJson } = req.body;

      if (!planJson || typeof planJson !== 'string') {
        return res.status(400).json({ error: 'planJson string is required (output of terraform show -json)' });
      }

      const { parseTerraformPlan, calculatePlanDiff } = await import('../terraform-plan-parser.js');
      const { AZURE_PRICING_CONFIG: azConfig, isFreeResource } = await import('../azure-pricing-config.js');
      const { getAwsPricingConfig, isFreeAwsResource } = await import('../aws-pricing-config.js');
      const { getGcpPricingConfig, isFreeGcpResource, calculateGcpMonthlyCost } = await import('../gcp-pricing-config.js');

      const changes = parseTerraformPlan(planJson);

      const result = await calculatePlanDiff(changes, async (resourceType, attrs) => {
        // Free resources → $0
        if (isFreeResource(resourceType) || isFreeAwsResource(resourceType) || isFreeGcpResource(resourceType)) {
          return 0;
        }
        const location = attrs.location || attrs.region || 'eastus';

        // Azure
        const azEntry = azConfig[resourceType];
        if (azEntry) {
          try {
            const { fetchAzurePricing } = await import('../routes-legacy.js').catch(() => ({ fetchAzurePricing: null }));
            if (fetchAzurePricing) {
              const filter  = azEntry.buildFilter({ ...azEntry.defaults, ...attrs }, location);
              const items   = await (fetchAzurePricing as any)(filter);
              const best    = azEntry.selectItem(items, attrs);
              return azEntry.calculateCost(best, { ...azEntry.defaults, ...attrs }) || 0;
            }
          } catch {/* fall through */}
          return 0;
        }

        // GCP
        const gcpEntry = getGcpPricingConfig(resourceType);
        if (gcpEntry) {
          return calculateGcpMonthlyCost(resourceType, attrs) ?? 0;
        }

        // AWS
        const awsEntry = getAwsPricingConfig(resourceType);
        if (awsEntry) {
          return awsEntry.calculateCost(null, { ...awsEntry.defaults, ...attrs });
        }

        return 0; // unknown resource type
      });

      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error('❌ Error analyzing plan diff:', error);
      res.status(500).json({ error: 'Plan diff analysis failed', details: error.message });
    }
  });
}

